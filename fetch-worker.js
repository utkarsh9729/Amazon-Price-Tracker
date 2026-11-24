// ============================================================================
// Multithreaded Amazon.in Search API Worker (`fetch-worker.js`)
// ============================================================================
// Runs inside Node.js `worker_threads` to concurrently query Amazon's internal
// `/s/query` Rush streaming endpoint and parse HTML result chunks in parallel
// across CPU cores — zero Playwright/Chromium overhead.
// ============================================================================

const { isMainThread, parentPort, workerData } = require("worker_threads");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCharCode(parseInt(dec, 10))
    );
}

function stripTags(html) {
  return decodeHtmlEntities(
    html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  );
}

/**
 * Lightweight pure-JS extractor for an Amazon `/s/query` search-result HTML card.
 * Matches the DOMParser fields extracted by the Playwright engine while running
 * ~20x faster with zero browser overhead.
 */
function parseSearchResultHtml(asin, html, index) {
  const isAd =
    /class="[^"]*\bAdHolder\b/i.test(html) ||
    /data-component-type="sp-sponsored-result"/i.test(html);

  // Extract product title from <h2> elements (prefer aria-label, fallback to inner text)
  const titleParts = [];
  const h2Regex = /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi;
  let h2Match;
  while ((h2Match = h2Regex.exec(html)) !== null) {
    const attrs = h2Match[1];
    const ariaMatch = attrs.match(/aria-label="([^"]+)"/i);
    const raw = ariaMatch
      ? decodeHtmlEntities(ariaMatch[1])
      : stripTags(h2Match[2]);
    const cleaned = raw.replace(/^sponsored\s+ad\s*[-–—:]\s*/i, "").trim();
    if (cleaned) titleParts.push(cleaned);
  }
  const title = [...new Set(titleParts)].join(" — ") || null;

  // Exact checkout price from CSA attribute
  const csaMatch = html.match(/data-csa-c-price-to-pay="([^"]+)"/i);
  const csaPrice = csaMatch ? csaMatch[1] : null;

  // Extract current price & strike-through MRP from `.a-price` spans
  let priceText = null;
  let mrpText = null;
  const priceTagRegex = /<span\b[^>]*class="[^"]*\ba-price\b[^"]*"[^>]*>/gi;
  let pm;
  while ((pm = priceTagRegex.exec(html)) !== null) {
    const tag = pm[0];
    const isStrike = /data-a-strike="true"|a-text-price/i.test(tag);
    const slice = html.slice(pm.index, pm.index + 650);
    const offMatch = slice.match(/class="a-offscreen"[^>]*>([^<]+)<\/span>/i);
    const wholeMatch = slice.match(
      /class="a-price-whole"[^>]*>([^<]+)<\/span>/i
    );
    const val = offMatch
      ? decodeHtmlEntities(offMatch[1]).trim()
      : wholeMatch
        ? decodeHtmlEntities(wholeMatch[1]).trim()
        : null;
    if (!val) continue;
    if (isStrike) {
      if (!mrpText) mrpText = val;
    } else {
      if (!priceText) priceText = val;
    }
  }
  if (!priceText) priceText = csaPrice;

  const discMatch = html.match(/\(\d+%\s*off\)/i);
  const discountText = discMatch ? discMatch[0] : null;

  const badgeMatch = html.match(
    /class="[^"]*\ba-badge-text\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i
  );
  const dealBadge = badgeMatch ? stripTags(badgeMatch[1]) || null : null;

  const merchMatch =
    html.match(/data-csa-c-merchant-id="([^"]+)"/i) ||
    html.match(/name="merchantId"[^>]*value="([^"]+)"/i);
  const merchantId = merchMatch ? merchMatch[1] : null;

  const imgMatch =
    html.match(/<img\b[^>]*class="[^"]*\bs-image\b[^"]*"[^>]*src="([^"]+)"/i) ||
    html.match(/<img\b[^>]*src="([^"]+)"[^>]*class="[^"]*\bs-image\b[^"]*"/i);
  const imageUrl = imgMatch ? decodeHtmlEntities(imgMatch[1]) : null;

  const ratingMatch = html.match(
    /class="[^"]*\ba-icon-alt\b[^"]*"[^>]*>([^<]+)<\/span>/i
  );
  const rating = ratingMatch ? decodeHtmlEntities(ratingMatch[1]).trim() : null;

  return {
    asin,
    index,
    isAd,
    title,
    priceText,
    csaPrice,
    mrpText,
    discountText,
    dealBadge,
    isDeal: Boolean(dealBadge),
    merchantId,
    rating,
    imageUrl,
    delivery: null,
  };
}

/**
 * Query Amazon `/s/query` directly via Node's native fetch (HTTP keep-alive)
 * and parse the `&&&`-delimited Rush dispatch chunks.
 */
async function fetchBatchDirectHttp(batch, options = {}) {
  const {
    cookieHeader = "",
    timeoutMs = 15000,
    maxRetries = 2,
    uaIndex = 0,
  } = options;

  const qs = `rh=${encodeURIComponent("p_78:" + batch.join("|"))}&s=relevanceblender`;
  const url = `https://www.amazon.in/s/query?${qs}`;
  const batchSet = new Set(batch);
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];

  let lastStatus = 0;
  let retries = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = {
        "User-Agent": ua,
        Accept: "text/html,*/*",
        "Accept-Language": "en-IN,en;q=0.9",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        Origin: "https://www.amazon.in",
        Referer: "https://www.amazon.in/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      };
      if (cookieHeader) headers.Cookie = cookieHeader;

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: '{"customer-action":"query"}',
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastStatus = res.status;

      if (res.status === 503 || res.status === 429 || res.status === 502) {
        if (attempt < maxRetries) {
          retries++;
          const backoffMs = 700 * (attempt + 1) + Math.floor(Math.random() * 600);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        return { items: [], status: res.status, retries, throttled: true };
      }

      if (!res.ok) {
        return { items: [], status: res.status, retries, error: `HTTP ${res.status}` };
      }

      const rawStream = await res.text();
      const chunks = rawStream.split("&&&");
      const items = [];
      const seen = new Set();

      for (let i = 0; i < chunks.length; i++) {
        const chunkStr = chunks[i].trim();
        if (!chunkStr || !chunkStr.includes('"dispatch"')) continue;

        let arr;
        try {
          arr = JSON.parse(chunkStr);
        } catch {
          continue;
        }
        if (!Array.isArray(arr) || arr[0] !== "dispatch") continue;
        const payload = arr[2];
        if (!payload || !payload.asin || !payload.html) continue;

        if (batchSet.has(payload.asin) && !seen.has(payload.asin)) {
          seen.add(payload.asin);
          items.push(parseSearchResultHtml(payload.asin, payload.html, payload.index));
        }
      }

      return { items, status: 200, retries, throttled: false };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries) {
        retries++;
        const backoffMs = 300 * (attempt + 1) + Math.floor(Math.random() * 300);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      return {
        items: [],
        status: lastStatus,
        retries,
        error: err.name === "AbortError" ? "Timeout" : err.message,
      };
    }
  }

  return { items: [], status: lastStatus, retries };
}

if (!isMainThread && parentPort) {
  (async () => {
    const {
      workerId = 0,
      batches = [],
      concurrency = 10,
      cookieHeader = "",
      timeoutMs = 15000,
      maxRetries = 2,
    } = workerData || {};

    let nextIdx = 0;
    let batchesDone = 0;
    let totalRetries = 0;
    let totalErrors = 0;
    let totalThrottled = 0;
    const collectedItems = [];

    const reportInterval = Math.max(10, Math.floor(batches.length / 8));

    async function workerLoop(slotId) {
      while (nextIdx < batches.length) {
        const myIdx = nextIdx++;
        const batch = batches[myIdx];
        const res = await fetchBatchDirectHttp(batch, {
          cookieHeader,
          timeoutMs,
          maxRetries,
          uaIndex: workerId + slotId + myIdx,
        });

        totalRetries += res.retries || 0;
        if (res.throttled) totalThrottled++;
        if (res.error) totalErrors++;
        if (res.items && res.items.length > 0) {
          for (const item of res.items) {
            collectedItems.push(item);
          }
        }

        batchesDone++;
        if (batchesDone % reportInterval === 0 || batchesDone === batches.length) {
          parentPort.postMessage({
            type: "progress",
            workerId,
            batchesDone,
            totalBatches: batches.length,
            itemsFound: collectedItems.length,
          });
        }
      }
    }

    const poolSize = Math.min(concurrency, Math.max(1, batches.length));
    await Promise.all(
      Array.from({ length: poolSize }, (_, slotId) => workerLoop(slotId))
    );

    parentPort.postMessage({
      type: "done",
      workerId,
      items: collectedItems,
      stats: {
        batchesDone,
        itemsFound: collectedItems.length,
        retries: totalRetries,
        errors: totalErrors,
        throttled: totalThrottled,
      },
    });
  })().catch((err) => {
    parentPort.postMessage({
      type: "error",
      workerId: workerData?.workerId ?? 0,
      error: err.message,
    });
  });
}

module.exports = {
  parseSearchResultHtml,
  fetchBatchDirectHttp,
};
