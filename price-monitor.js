// ============================================================================
// Amazon.in Price Error Detector (Powered by Amazon Search API)
// ============================================================================
// Reverse-engineered Amazon.in internal Search API (`/s/query` Rush streaming
// endpoint) via Playwright to batch-query product SKUs (ASINs), track price
// history and average prices in `price-data.json`, detect pricing errors, and
// send instant alerts to a Telegram group.
//
// Rule: No minimum price rule; ONLY discount rule > 50% off.
//
// Reverse-Engineered Amazon Search API Details:
//   Endpoint : POST https://www.amazon.in/s/query
//   Query    : ?rh=p_78:ASIN1|ASIN2|... (batch exact-ASIN refinement, 0 ads)
//              or ?k=ASIN (single-SKU search query fallback)
//   Headers  : Accept: text/html,*/*
//              Content-Type: application/json
//              X-Requested-With: XMLHttpRequest
//   Payload  : {"customer-action":"query"}
//   Response : application/json-amazonui-streaming;charset=UTF-8
//              (&&&-delimited JSON dispatch chunks containing `data-search-metadata`
//               and `data-main-slot:search-result-N` payloads)
//
// Usage:
//   node price-monitor.js                     # Run once
//   node price-monitor.js --loop --interval 5 # Run every 5 minutes
//   node price-monitor.js --add B0XXXXX       # Add ASIN(s) to skus.json
//   node price-monitor.js --remove B0XXXXX    # Remove an ASIN
//   node price-monitor.js --list              # List monitored ASINs & averages
// ============================================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { Worker } = require("worker_threads");
const { fetchBatchDirectHttp } = require("./fetch-worker");

// Lazy-load Playwright only if direct HTTP is blocked or --playwright is passed
function loadPlaywrightChromium() {
  try {
    return require("playwright").chromium;
  } catch {
    return null;
  }
}

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Telegram Bot credentials (supergroup IDs in Telegram API use -100 prefix)
  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN ||
    "5420527489:AAE1F1DDhqaiUHCu-kHauFfqhgEhOlG0aMI",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "-1002197097024",
  // Dedicated tiered Telegram groups by discount level:
  //   >= 70% -> midDiscountTelegramChatId (-5530445395)
  //   >  90% -> highDiscountTelegramChatId (-5284268372)
  midDiscountTelegramChatId:
    process.env.MID_DISCOUNT_TELEGRAM_CHAT_ID || "-5530445395",
  midDiscountMinPercent: parseFloat(
    process.env.MID_DISCOUNT_MIN_PERCENT || "70"
  ),
  highDiscountTelegramChatId:
    process.env.HIGH_DISCOUNT_TELEGRAM_CHAT_ID || "-5284268372",
  highDiscountMinPercent: parseFloat(
    process.env.HIGH_DISCOUNT_MIN_PERCENT || "90"
  ),

  // Discount rule ONLY (all price thresholds/rules removed):
  // Alert ONLY when discount is strictly > 50%
  minDiscountPercent: parseFloat(process.env.MIN_DISCOUNT_PERCENT || "50"),

  // Max repeat alerts per product if price has not changed by >= 15% of avg price
  maxAlertsPerSamePrice: parseInt(process.env.MAX_ALERTS_PER_SAME_PRICE || "3", 10),
  minPriceChangePercentForNewAlert: parseFloat(
    process.env.MIN_PRICE_CHANGE_PERCENT || "15"
  ),

  // Data and SKU files
  dataFile: path.join(__dirname, "price-data.json"),
  skuFile: path.join(__dirname, "skus.json"),

  // Browser settings (fallback only — persistent context preserves Amazon.in login session)
  headless: process.env.HEADLESS === "true" ? true : false,
  userDataDir: path.join(__dirname, "browser-data"),

  // Amazon Search API batch size (p_78 supports up to 32 ASINs per call with 100% recall)
  searchBatchSize: parseInt(process.env.SEARCH_BATCH_SIZE || "32", 10),
  // Multithreaded Worker Pool settings (used by fast direct-HTTP engine)
  workerThreads: parseInt(
    process.env.WORKERS || String(Math.min(Math.max(os.cpus().length, 2), 6)),
    10
  ),
  concurrencyPerWorker: parseInt(process.env.CONCURRENCY_PER_WORKER || "8", 10),
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "15000", 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || "3", 10),

  // Playwright fallback concurrency settings
  searchConcurrency: 12,
  betweenBatchDelay: 100,

  // Max history entries retained per product (keep only last 10 prices)
  maxHistoryEntries: 10,

  // Minimum historical data points before average-based alert triggers
  minDataPointsForAlert: 2,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse an Indian-format price string like "₹76,999.00" or "76999.0" into a number.
 */
function parsePrice(priceVal) {
  if (priceVal == null) return null;
  if (typeof priceVal === "number") return isNaN(priceVal) ? null : priceVal;
  const cleaned = String(priceVal).replace(/[^\d.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Format a number as Indian Rupee currency (e.g. ₹76,999).
 */
function formatPrice(num) {
  if (num == null || isNaN(num)) return "N/A";
  return "₹" + Number(num).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}

/**
 * Load persistent price data from JSON file.
 */
function loadData() {
  try {
    if (fs.existsSync(CONFIG.dataFile)) {
      const raw = fs.readFileSync(CONFIG.dataFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.products === "object") {
        return parsed;
      }
    }
  } catch (err) {
    console.error("⚠️  Error reading price-data.json, starting fresh:", err.message);
  }
  return { products: {}, lastRun: null, runCount: 0 };
}

/**
 * Compact a product record before persisting to price-data.json so 100k+ SKUs
 * stay well under GitHub's file-size limits while preserving all pricing/alert state.
 */
function compactProductRecord(product) {
  if (!product || typeof product !== "object") return product;
  const prices = extractHistoryPrices(product.history).slice(-CONFIG.maxHistoryEntries);
  const compact = {
    asin: product.asin,
    title: product.title,
    mrp: product.mrp ?? null,
    currentPrice: product.currentPrice ?? null,
    averagePrice: product.averagePrice ?? null,
    medianPrice: product.medianPrice ?? null,
    minPrice: product.minPrice ?? null,
    maxPrice: product.maxPrice ?? null,
    history: prices,
    lastChecked: product.lastChecked ?? null,
  };
  if (product.category) compact.category = product.category;
  if (product.alertCount) compact.alertCount = product.alertCount;
  if (product.lastAlertPrice != null) compact.lastAlertPrice = product.lastAlertPrice;
  if (product.lastAlertAvgPrice != null) compact.lastAlertAvgPrice = product.lastAlertAvgPrice;
  if (product.lastAlertAt) compact.lastAlertAt = product.lastAlertAt;
  if (product.samePriceAlertCount) compact.samePriceAlertCount = product.samePriceAlertCount;
  return compact;
}

/**
 * Save updated price data to JSON file.
 */
function saveData(data) {
  if (data && data.products) {
    for (const [asin, product] of Object.entries(data.products)) {
      data.products[asin] = compactProductRecord(product);
    }
  }
  data.lastRun = new Date().toISOString();
  data.runCount = (data.runCount || 0) + 1;
  fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data), "utf-8");
}

/**
 * Load SKU list from skus.json.
 */
function loadSkus() {
  try {
    if (fs.existsSync(CONFIG.skuFile)) {
      const raw = fs.readFileSync(CONFIG.skuFile, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { skus: parsed };
      }
      if (parsed && Array.isArray(parsed.skus)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("⚠️  Error reading skus.json:", err.message);
  }
  return { skus: [] };
}

/**
 * Save SKU list to skus.json.
 */
function saveSkus(skuData) {
  fs.writeFileSync(CONFIG.skuFile, JSON.stringify(skuData, null, 2), "utf-8");
}

/**
 * Extract numeric prices from history entries (supports both compact number[]
 * and legacy { price, timestamp }[] formats).
 */
function extractHistoryPrices(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const prices = [];
  for (const h of history) {
    const p = typeof h === "number" ? h : h?.price;
    if (p != null && p > 0 && !isNaN(p)) {
      prices.push(p);
    }
  }
  return prices;
}

/**
 * Calculate arithmetic mean price from history entries.
 */
function calculateAverage(history) {
  const prices = extractHistoryPrices(history);
  if (prices.length === 0) return null;
  const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  return Math.round(avg * 100) / 100;
}

/**
 * Calculate median price from history entries.
 */
function calculateMedian(history) {
  const prices = extractHistoryPrices(history).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const mid = Math.floor(prices.length / 2);
  const med =
    prices.length % 2 !== 0
      ? prices[mid]
      : (prices[mid - 1] + prices[mid]) / 2;
  return Math.round(med * 100) / 100;
}

/**
 * Calculate min and max prices from history entries.
 */
function calculateMinMax(history) {
  const prices = extractHistoryPrices(history);
  if (prices.length === 0) return { min: null, max: null };
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
  };
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Normalize a product title for cross-ASIN duplicate detection
 * (strips Amazon "Sponsored Ad -" prefix, extra spaces, and case).
 */
function normalizeProductTitle(title) {
  if (!title) return "";
  return String(title)
    .replace(/^sponsored\s+ad\s*[-–—:]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Evaluate whether a repeat notification is allowed for a product/title tracker.
 *
 * Rules:
 *   - Allow at most `maxAlerts` (default 3) notifications while the current price
 *     has NOT changed by at least `minChangePct`% (default 15%) of the average price.
 *   - Once the price changes by >= 15% of the reference average price, start a new
 *     alert cycle (count resets to 1 at the new price level).
 *   - Does NOT mutate the tracker; caller applies `nextState` only when actually sending.
 */
function evaluateRepeatAlertThrottle(
  tracker,
  currentPrice,
  comparisonAvg,
  maxAlerts = CONFIG.maxAlertsPerSamePrice,
  minChangePct = CONFIG.minPriceChangePercentForNewAlert
) {
  const prevPrice = tracker?.lastAlertPrice ?? null;
  const prevAvg = tracker?.lastAlertAvgPrice ?? null;
  const prevCount = tracker?.samePriceAlertCount || 0;

  if (prevPrice == null || prevCount === 0) {
    return {
      allow: true,
      isNewCycle: true,
      priceChangePctOfAvg: null,
      alertNumber: 1,
      nextState: {
        lastAlertPrice: currentPrice,
        lastAlertAvgPrice: comparisonAvg,
        samePriceAlertCount: 1,
      },
    };
  }

  const refAvg = prevAvg && prevAvg > 0 ? prevAvg : comparisonAvg;
  const priceChangePctOfAvg =
    refAvg && refAvg > 0
      ? (Math.abs(currentPrice - prevPrice) / refAvg) * 100
      : Infinity;

  if (priceChangePctOfAvg >= minChangePct) {
    return {
      allow: true,
      isNewCycle: true,
      priceChangePctOfAvg,
      alertNumber: 1,
      nextState: {
        lastAlertPrice: currentPrice,
        lastAlertAvgPrice: comparisonAvg,
        samePriceAlertCount: 1,
      },
    };
  }

  if (prevCount >= maxAlerts) {
    return {
      allow: false,
      isNewCycle: false,
      priceChangePctOfAvg,
      alertNumber: prevCount,
      nextState: {
        lastAlertPrice: prevPrice,
        lastAlertAvgPrice: refAvg,
        samePriceAlertCount: prevCount,
      },
    };
  }

  const nextCount = prevCount + 1;
  return {
    allow: true,
    isNewCycle: false,
    priceChangePctOfAvg,
    alertNumber: nextCount,
    nextState: {
      lastAlertPrice: prevPrice,
      lastAlertAvgPrice: refAvg,
      samePriceAlertCount: nextCount,
    },
  };
}

// ─── Telegram Notification ──────────────────────────────────────────────────

/**
 * Send an HTML message to a configured Telegram chat/group.
 */
function sendTelegram(message, targetChatId = CONFIG.telegramChatId) {
  return new Promise((resolve, reject) => {
    const chatId = targetChatId || CONFIG.telegramChatId;
    if (
      !CONFIG.telegramBotToken ||
      CONFIG.telegramBotToken === "YOUR_BOT_TOKEN_HERE" ||
      !chatId ||
      chatId === "YOUR_CHAT_ID_HERE"
    ) {
      console.log("\n📱 [Telegram Alert Preview — set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID to send live]:");
      console.log(message.replace(/<[^>]+>/g, ""));
      return resolve({ skipped: true });
    }

    const payload = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });

    const urlObj = new URL(
      `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`
    );

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          console.log(`✅ Telegram alert sent successfully (chat: ${chatId}).`);
          resolve({ sent: true, chatId });
        } else if (res.statusCode === 429) {
          let retryAfter = 35;
          try {
            const parsed = JSON.parse(body);
            retryAfter = (parsed?.parameters?.retry_after || 30) + 2;
          } catch {}
          console.log(`⏳ Telegram rate limit (429) — waiting ${retryAfter}s and retrying...`);
          setTimeout(() => {
            sendTelegram(message, chatId).then(resolve).catch(reject);
          }, retryAfter * 1000);
        } else {
          let migratedId = null;
          try {
            const parsed = JSON.parse(body);
            migratedId = parsed?.parameters?.migrate_to_chat_id || null;
          } catch {}
          if (migratedId && String(migratedId) !== String(chatId)) {
            console.log(`🔄 Telegram group migrated to supergroup ${migratedId} — retrying...`);
            return sendTelegram(message, String(migratedId)).then(resolve).catch(reject);
          }
          console.error("❌ Telegram API error:", res.statusCode, body);
          reject(new Error(`Telegram ${res.statusCode}: ${body}`));
        }
      });
    });

    req.on("error", (err) => {
      console.error("❌ Telegram request error:", err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Resolve target Telegram chat IDs for a given discount percentage:
 *   - >  90% -> highDiscountTelegramChatId (-5284268372)
 *   - >= 70% -> midDiscountTelegramChatId  (-5530445395)
 *   - >= 50% -> telegramChatId             (-1002197097024)
 */
function resolveAlertChatIds(dropPct) {
  const chats = [];
  const addChat = (id) => {
    if (!id) return;
    const s = String(id).trim();
    if (s && s !== "YOUR_CHAT_ID_HERE" && !chats.includes(s)) {
      chats.push(s);
    }
  };
  if (dropPct > CONFIG.highDiscountMinPercent) {
    addChat(CONFIG.highDiscountTelegramChatId);
  }
  if (dropPct >= CONFIG.midDiscountMinPercent) {
    addChat(CONFIG.midDiscountTelegramChatId);
  }
  addChat(CONFIG.telegramChatId);
  return chats;
}

/**
 * Format Telegram alert message for a detected pricing error.
 */
function buildAlertMessage(alert) {
  const { product, currentPrice, avgPrice, medianPrice, minMax, reason, alertNumber } = alert;
  const dropFromAvg =
    avgPrice && avgPrice > 0
      ? (((avgPrice - currentPrice) / avgPrice) * 100).toFixed(1)
      : "0.0";
  const productUrl = `https://www.amazon.in/dp/${product.asin}`;
  const alertTag = alertNumber
    ? `🔔 Notification: <b>${alertNumber}/${CONFIG.maxAlertsPerSamePrice}</b> (muted until ≥${CONFIG.minPriceChangePercentForNewAlert}% price change vs avg)\n`
    : "";

  return (
    `🚨 <b>AMAZON PRICE ERROR DETECTED!</b>\n\n` +
    `📦 <b>${escapeHtml(product.title)}</b>\n` +
    `🔖 SKU / ASIN: <code>${product.asin}</code>\n` +
    `⚡ Trigger: ${escapeHtml(reason)}\n` +
    alertTag +
    `\n` +
    `🏷️ Current Price: <b>${formatPrice(currentPrice)}</b>\n` +
    `📊 Historical Avg Price (JSON): <b>${formatPrice(avgPrice)}</b>\n` +
    `📈 Median Price: ${formatPrice(medianPrice)}\n` +
    `📉 Historical Range: ${formatPrice(minMax.min)} – ${formatPrice(minMax.max)}\n` +
    `⬇️ Discount vs Historical Price: <b>${dropFromAvg}% off</b>\n\n` +
    `📊 Data Points: ${product.history.length}\n` +
    `🔗 <a href="${productUrl}">Buy Now on Amazon.in</a>\n` +
    `⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
}

// ─── Reverse-Engineered Amazon Search API Client ────────────────────────────

async function queryAmazonSearchApi(page, queryParams) {
  return await page.evaluate(async (qs) => {
    const response = await fetch(`/s/query?${qs}`, {
      method: "POST",
      headers: {
        Accept: "text/html,*/*",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ "customer-action": "query" }),
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`Amazon Search API HTTP ${response.status}`);
    }

    const rawStream = await response.text();
    const rawChunks = rawStream
      .split("&&&")
      .map((c) => c.trim())
      .filter(Boolean);

    let metadata = null;
    const items = [];
    const parser = new DOMParser();

    for (const chunkStr of rawChunks) {
      let arr;
      try {
        arr = JSON.parse(chunkStr);
      } catch {
        continue;
      }

      if (!Array.isArray(arr) || arr[0] !== "dispatch") continue;
      const target = arr[1] || "";
      const payload = arr[2] || {};

      if (target === "data-search-metadata" && payload.metadata) {
        metadata = payload.metadata;
        continue;
      }

      if (payload.asin && payload.html) {
        const doc = parser.parseFromString(payload.html, "text/html");
        const root = doc.querySelector('[data-component-type="s-search-result"]') || doc.body;
        const isAd =
          root.classList?.contains("AdHolder") ||
          doc.querySelector(".AdHolder") !== null ||
          doc.querySelector('[data-component-type="sp-sponsored-result"]') !== null;

        const h2List = [...doc.querySelectorAll('[data-cy="title-recipe"] h2, h2')];
        const titleParts = h2List
          .map((el) =>
            (el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "")
              .replace(/^sponsored\s+ad\s*[-–—:]\s*/i, "")
              .trim()
          )
          .filter(Boolean);
        const uniqueParts = [...new Set(titleParts)];
        const title = uniqueParts.length > 0 ? uniqueParts.join(" — ") : null;

        const csaPriceEl = doc.querySelector("[data-csa-c-price-to-pay]");
        const csaPrice = csaPriceEl?.getAttribute("data-csa-c-price-to-pay") || null;

        const priceOffscreenEl = doc.querySelector(
          '.a-price:not([data-a-strike="true"]) .a-offscreen'
        );
        const priceWholeEl = doc.querySelector(
          '.a-price:not([data-a-strike="true"]) .a-price-whole'
        );
        const priceText =
          priceOffscreenEl?.textContent?.trim() ||
          priceWholeEl?.textContent?.trim() ||
          csaPrice ||
          null;

        const mrpEl = doc.querySelector(
          '.a-price[data-a-strike="true"] .a-offscreen'
        );
        const mrpText = mrpEl?.textContent?.trim() || null;

        const priceRecipe = doc.querySelector('[data-cy="price-recipe"]');
        let discountText = null;
        if (priceRecipe) {
          const match = priceRecipe.textContent.match(/\(\d+%\s*off\)/i);
          if (match) discountText = match[0];
        }

        const badgeEl = doc.querySelector(".a-badge-text");
        const dealBadge = badgeEl?.textContent?.trim() || null;

        const merchantEl =
          doc.querySelector("[data-csa-c-merchant-id]") ||
          doc.querySelector('input[name="merchantId"]');
        const merchantId =
          merchantEl?.getAttribute("data-csa-c-merchant-id") ||
          merchantEl?.getAttribute("value") ||
          null;

        const ratingEl = doc.querySelector(".a-icon-alt");
        const rating = ratingEl?.textContent?.trim() || null;

        const imgEl = doc.querySelector("img.s-image");
        const imageUrl = imgEl?.getAttribute("src") || null;

        const deliveryEl = doc.querySelector('[data-cy="delivery-recipe"]');
        const delivery = deliveryEl?.textContent?.replace(/\s+/g, " ")?.trim() || null;

        items.push({
          asin: payload.asin,
          index: payload.index,
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
          delivery,
        });
      }
    }

    return { metadata, items, totalChunks: rawChunks.length };
  }, queryParams);
}

/**
 * Fetch product pricing for a list of SKUs (ASINs) using the Amazon Search API.
 */
async function fetchSkusViaSearchApi(page, skus) {
  const resultsByAsin = new Map();

  const batches = [];
  for (let i = 0; i < skus.length; i += CONFIG.searchBatchSize) {
    batches.push(skus.slice(i, i + CONFIG.searchBatchSize));
  }

  const concurrency = CONFIG.searchConcurrency || 12;
  const totalBatches = batches.length;

  for (let w = 0; w < totalBatches; w += concurrency) {
    const wave = batches.slice(w, w + concurrency);
    const waveStart = w + 1;
    const waveEnd = Math.min(w + concurrency, totalBatches);

    console.log(
      `\n📡 [Search API Batches ${waveStart}–${waveEnd}/${totalBatches}] Querying ${wave.reduce((s, b) => s + b.length, 0)} SKUs via POST /s/query?rh=p_78:...`
    );

    const wavePromises = wave.map(async (batch) => {
      const qs = `rh=${encodeURIComponent("p_78:" + batch.join("|"))}&s=relevanceblender`;
      try {
        return await queryAmazonSearchApi(page, qs);
      } catch (err) {
        return { items: [], error: err.message };
      }
    });

    const waveResponses = await Promise.all(wavePromises);
    let waveFound = 0;

    for (let idx = 0; idx < waveResponses.length; idx++) {
      const apiRes = waveResponses[idx];
      const batch = wave[idx];
      for (const item of apiRes.items || []) {
        if (batch.includes(item.asin) && !resultsByAsin.has(item.asin)) {
          resultsByAsin.set(item.asin, normalizeSearchItem(item));
          waveFound++;
        }
      }
    }

    console.log(
      `   ✅ Wave returned prices for ${waveFound} SKU(s) (total collected: ${resultsByAsin.size}/${skus.length})`
    );

    if (w + concurrency < totalBatches) {
      await page.waitForTimeout(CONFIG.betweenBatchDelay);
    }
  }

  return resultsByAsin;
}

/**
 * Normalize a raw item from `queryAmazonSearchApi` or `fetch-worker.js` into our product record format.
 */
function normalizeSearchItem(item) {
  const currentPrice = parsePrice(item.csaPrice) ?? parsePrice(item.priceText);
  const mrp = parsePrice(item.mrpText);
  return {
    asin: item.asin,
    title: item.title,
    currentPrice,
    mrp,
    isDeal: item.isDeal,
    dealBadge: item.dealBadge,
    discountText: item.discountText,
    merchantId: item.merchantId,
    rating: item.rating,
    imageUrl: item.imageUrl,
    delivery: item.delivery,
    scrapedAt: new Date().toISOString(),
    unavailable: currentPrice == null,
  };
}

/**
 * Grab lightweight Amazon.in session cookies via pure HTTP (~200-300ms, no browser).
 */
async function bootstrapHttpCookies() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch("https://www.amazon.in/s?k=phone", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const setCookies = res.headers.getSetCookie
      ? res.headers.getSetCookie()
      : [];
    return setCookies.map((c) => c.split(";")[0]).join("; ");
  } catch {
    return "";
  }
}

/**
 * High-speed multithreaded SKU fetcher using Node.js `worker_threads` + direct
 * HTTP/keep-alive calls to Amazon's `/s/query` Rush API (zero browser overhead).
 */
async function fetchSkusViaWorkerPool(skus, options = {}) {
  const { cookieHeader = "" } = options;
  const batchSize = CONFIG.searchBatchSize || 32;
  const batches = [];
  for (let i = 0; i < skus.length; i += batchSize) {
    batches.push(skus.slice(i, i + batchSize));
  }

  const numWorkers = Math.min(
    Math.max(1, CONFIG.workerThreads || 4),
    Math.max(1, batches.length)
  );
  const concurrencyPerWorker = CONFIG.concurrencyPerWorker || 10;

  // Distribute batches round-robin across worker threads for balanced load
  const workerBatches = Array.from({ length: numWorkers }, () => []);
  for (let i = 0; i < batches.length; i++) {
    workerBatches[i % numWorkers].push(batches[i]);
  }

  console.log(
    `\n⚡ [Multithreaded HTTP Pool] Launching ${numWorkers} worker thread(s) × ${concurrencyPerWorker} concurrency (${batches.length} batches of ${batchSize} SKUs)...`
  );

  const workerPath = path.join(__dirname, "fetch-worker.js");
  const resultsByAsin = new Map();
  const progressByWorker = new Array(numWorkers).fill(0);
  const startMs = Date.now();
  let lastLogMs = 0;
  let totalRetries = 0;
  let totalErrors = 0;
  let totalThrottled = 0;

  await Promise.all(
    workerBatches.map(
      (wb, workerId) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(workerPath, {
            workerData: {
              workerId,
              batches: wb,
              concurrency: concurrencyPerWorker,
              cookieHeader,
              timeoutMs: CONFIG.requestTimeoutMs,
              maxRetries: CONFIG.maxRetries,
            },
          });

          worker.on("message", (msg) => {
            if (msg.type === "progress") {
              progressByWorker[msg.workerId] = msg.batchesDone;
              const now = Date.now();
              if (now - lastLogMs > 2000) {
                lastLogMs = now;
                const doneBatches = progressByWorker.reduce((a, b) => a + b, 0);
                const pct = ((doneBatches / batches.length) * 100).toFixed(0);
                const elapsedSec = ((now - startMs) / 1000).toFixed(1);
                const rate = Math.round(
                  (doneBatches * batchSize) / Math.max(0.1, (now - startMs) / 1000)
                );
                console.log(
                  `   ⚡ Progress: ${doneBatches}/${batches.length} batches (${pct}%) | ${elapsedSec}s elapsed | ~${rate} SKUs/s`
                );
              }
            } else if (msg.type === "done") {
              for (const item of msg.items || []) {
                if (!resultsByAsin.has(item.asin)) {
                  resultsByAsin.set(item.asin, normalizeSearchItem(item));
                }
              }
              totalRetries += msg.stats?.retries || 0;
              totalErrors += msg.stats?.errors || 0;
              totalThrottled += msg.stats?.throttled || 0;
              resolve();
            } else if (msg.type === "error") {
              reject(new Error(`Worker ${msg.workerId}: ${msg.error}`));
            }
          });

          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`Worker ${workerId} exited with code ${code}`));
            }
          });
        })
    )
  );

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(2);
  const rate = Math.round(skus.length / Math.max(0.1, (Date.now() - startMs) / 1000));
  console.log(
    `   ✅ Worker pool finished in ${elapsedSec}s (${rate} SKUs/s) | Priced: ${resultsByAsin.size}/${skus.length} | Retries: ${totalRetries} | 503/429: ${totalThrottled} | Errors: ${totalErrors}`
  );

  return resultsByAsin;
}

/**
 * Fallback SKU fetcher using Playwright browser session.
 */
async function fetchSkusViaPlaywright(skus) {
  const chromium = loadPlaywrightChromium();
  if (!chromium) {
    console.error(
      "❌ Playwright is not installed in this environment (cannot run browser fallback)."
    );
    process.exit(42);
  }

  console.log("\n🚀 Launching Playwright browser context (fallback mode)...");
  const context = await chromium.launchPersistentContext(CONFIG.userDataDir, {
    headless: CONFIG.headless,
    viewport: { width: 1366, height: 768 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  try {
    console.log("🌐 Establishing Amazon.in browser session...");
    await page.goto("https://www.amazon.in/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const accountText = await page
      .locator("#nav-link-accountList-nav-line-1")
      .textContent()
      .catch(() => null);
    if (accountText) {
      console.log(`   👤 Session status: ${accountText.trim()}`);
    }

    // Grab browser cookies and try running the fast worker pool with them first!
    const cookies = await context.cookies("https://www.amazon.in");
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const probeBatch = skus.slice(0, Math.min(15, skus.length));
    const probe = await fetchBatchDirectHttp(probeBatch, {
      cookieHeader,
      timeoutMs: 12000,
      maxRetries: 1,
    });
    if (probe.status === 200 && probe.items.length > 0) {
      console.log(
        `   ✅ Browser cookies unlocked direct Worker Pool (${probe.items.length}/${probeBatch.length} probe items)!`
      );
      await context.close();
      return await fetchSkusViaWorkerPool(skus, { cookieHeader });
    }

    return await fetchSkusViaSearchApi(page, skus);
  } finally {
    await context.close().catch(() => {});
  }
}

// ─── Core: Main Monitoring Logic ────────────────────────────────────────────

async function runMonitor(options = {}) {
  const {
    forceTestAlert = false,
    shardIndex = null,
    shardTotal = null,
    shardOut = null,
    forcePlaywright = false,
  } = options;
  const runStartMs = Date.now();
  const skuData = loadSkus();
  const allSkus = [
    ...new Set(
      (skuData.skus || []).map((s) => s.trim().toUpperCase()).filter(Boolean)
    ),
  ];

  if (allSkus.length === 0) {
    console.error(
      "❌ No SKUs configured in skus.json! Add ASINs using:\n" +
        "   node price-monitor.js --add B0DGJHBX5Y B0CNM4V6Q5\n" +
        "   Or edit skus.json directly."
    );
    process.exit(1);
  }

  let skus = allSkus;
  let shardLabel = "";
  if (shardIndex != null && shardTotal != null && shardTotal > 1) {
    const chunkSize = Math.ceil(allSkus.length / shardTotal);
    const start = (shardIndex - 1) * chunkSize;
    const end = Math.min(start + chunkSize, allSkus.length);
    skus = allSkus.slice(start, end);
    shardLabel = ` [Shard ${shardIndex}/${shardTotal}: SKUs ${start + 1}–${end}]`;
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🛒 Amazon.in Price Error Detector (Multithreaded Search API)");
  console.log(`  📦 Monitoring ${skus.length.toLocaleString("en-IN")} SKU(s)${shardLabel}`);
  console.log(
    `  ⚡ Engine: ${forcePlaywright ? "Playwright Browser" : `${CONFIG.workerThreads} Worker Threads × ${CONFIG.concurrencyPerWorker} Concurrency (Batch ${CONFIG.searchBatchSize})`}`
  );
  console.log(
    `  🎯 Discount Rule: >= ${CONFIG.minDiscountPercent}% off (No minimum price rule)`
  );
  if (CONFIG.midDiscountTelegramChatId) {
    console.log(
      `  🔥 Mid-Discount Group:  >= ${CONFIG.midDiscountMinPercent}% off -> chat ${CONFIG.midDiscountTelegramChatId}`
    );
  }
  if (CONFIG.highDiscountTelegramChatId) {
    console.log(
      `  🚨 High-Discount Group: > ${CONFIG.highDiscountMinPercent}% off -> chat ${CONFIG.highDiscountTelegramChatId}`
    );
  }
  console.log(
    `  🔕 Repeat Limit: Max ${CONFIG.maxAlertsPerSamePrice} alerts/product until price changes by ≥${CONFIG.minPriceChangePercentForNewAlert}% of avg price`
  );
  console.log(
    `  ⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
  console.log("═══════════════════════════════════════════════════════════");

  const data = loadData();
  if (!data.titleAlertTracker || typeof data.titleAlertTracker !== "object") {
    data.titleAlertTracker = {};
  }
  const alerts = [];
  const alertedTitlesThisRun = new Set();
  const updatedProducts = {};
  const titleAlertUpdates = {};

  let checkedCount = 0;
  let errorCount = 0;
  let suppressedCount = 0;
  let skippedCount = 0;

  let searchResults;
  if (forcePlaywright) {
    searchResults = await fetchSkusViaPlaywright(skus);
  } else {
    const probeBatch = skus.slice(0, Math.min(15, skus.length));
    // Prefer stateless direct HTTP (avoids Akamai per-session ak_bmsc throttling)
    let cookieHeader = "";
    let probe = await fetchBatchDirectHttp(probeBatch, {
      cookieHeader: "",
      timeoutMs: 12000,
      maxRetries: 1,
    });

    if (!(probe.status === 200 && probe.items.length > 0)) {
      cookieHeader = await bootstrapHttpCookies();
      if (cookieHeader) {
        probe = await fetchBatchDirectHttp(probeBatch, {
          cookieHeader,
          timeoutMs: 12000,
          maxRetries: 1,
        });
      }
    }

    if (probe.status === 200 && probe.items.length > 0) {
      console.log(
        `🌐 Direct HTTP Search API probe OK (${probe.items.length}/${probeBatch.length} items) — skipping browser launch!`
      );
      searchResults = await fetchSkusViaWorkerPool(skus, { cookieHeader });
    } else {
      console.warn(
        `⚠️  Direct HTTP probe returned status=${probe.status}, items=${probe.items.length} — switching to Playwright fallback...`
      );
      searchResults = await fetchSkusViaPlaywright(skus);
    }
  }

  for (let i = 0; i < skus.length; i++) {
    const asin = skus[i];
    const result = searchResults.get(asin);
    if (!result) {
      skippedCount++;
      continue;
    }

    if (!data.products[asin]) {
      data.products[asin] = {
        asin,
        title: result.title,
        mrp: result.mrp,
        currentPrice: result.currentPrice,
        averagePrice: null,
        medianPrice: null,
        minPrice: null,
        maxPrice: null,
        discountText: result.discountText,
        dealBadge: result.dealBadge,
        merchantId: result.merchantId,
        imageUrl: result.imageUrl,
        history: [],
        lastChecked: null,
        alertCount: 0,
        lastAlertPrice: null,
        lastAlertAvgPrice: null,
        lastAlertAt: null,
        samePriceAlertCount: 0,
        firstSeen: new Date().toISOString(),
      };
    }

    const product = data.products[asin];

    const priorAvg = calculateAverage(product.history);
    const priorCount = product.history.length;

    if (result.title) product.title = result.title;
    if (result.mrp) product.mrp = result.mrp;
    product.currentPrice = result.currentPrice;
    product.discountText = result.discountText;
    product.dealBadge = result.dealBadge;
    product.merchantId = result.merchantId;
    product.imageUrl = result.imageUrl;
    product.lastChecked = result.scrapedAt;

    if (result.unavailable || result.currentPrice == null) {
      skippedCount++;
      continue;
    }

    checkedCount++;

    product.history.push(result.currentPrice);

    if (product.history.length > CONFIG.maxHistoryEntries) {
      product.history = product.history.slice(-CONFIG.maxHistoryEntries);
    }

    product.averagePrice = calculateAverage(product.history);
    product.medianPrice = calculateMedian(product.history);
    const minMax = calculateMinMax(product.history);
    product.minPrice = minMax.min;
    product.maxPrice = minMax.max;

    const cur = result.currentPrice;
    const avg = product.averagePrice;
    const comparisonAvg = priorAvg ?? avg;

    // ── Detect Price Error (Only Discount Rule >= 50%; No Price Rule) ──
    let isError = false;
    let errorReason = "";
    let dropPctNum = 0;

    if (
      comparisonAvg != null &&
      comparisonAvg > 0 &&
      priorCount + 1 >= CONFIG.minDataPointsForAlert
    ) {
      dropPctNum = ((comparisonAvg - cur) / comparisonAvg) * 100;
      if (dropPctNum >= CONFIG.minDiscountPercent) {
        const dropPct = dropPctNum.toFixed(1);
        isError = true;
        errorReason = `Discount ${dropPct}% (>= ${CONFIG.minDiscountPercent}%) below historical JSON price (${formatPrice(comparisonAvg)})`;
      }
    }

    if (isError) {
      const normTitle = normalizeProductTitle(product.title);
      const asinDecision = evaluateRepeatAlertThrottle(
        product,
        cur,
        comparisonAvg
      );
      const titleTracker = normTitle ? data.titleAlertTracker[normTitle] : null;
      const titleDecision = normTitle
        ? evaluateRepeatAlertThrottle(titleTracker, cur, comparisonAvg)
        : { allow: true };

      if (!asinDecision.allow) {
        suppressedCount++;
        console.log(
          `⏭️  [${asin}] Skipping repeat alert: price (${formatPrice(cur)}) changed only ${asinDecision.priceChangePctOfAvg.toFixed(1)}% (< ${CONFIG.minPriceChangePercentForNewAlert}% of avg ${formatPrice(asinDecision.nextState.lastAlertAvgPrice)}) and already sent ${asinDecision.alertNumber}/${CONFIG.maxAlertsPerSamePrice} times.`
        );
      } else if (normTitle && alertedTitlesThisRun.has(normTitle)) {
        suppressedCount++;
        console.log(
          `⏭️  [${asin}] Skipping duplicate product variant in same run: "${product.title?.substring(0, 60)}" already alerted this run.`
        );
      } else if (normTitle && !titleDecision.allow) {
        suppressedCount++;
        console.log(
          `⏭️  [${asin}] Skipping repeat alert for same product title: price (${formatPrice(cur)}) changed only ${titleDecision.priceChangePctOfAvg.toFixed(1)}% (< ${CONFIG.minPriceChangePercentForNewAlert}% of avg ${formatPrice(titleDecision.nextState.lastAlertAvgPrice)}) and already sent ${titleDecision.alertNumber}/${CONFIG.maxAlertsPerSamePrice} times.`
        );
      } else {
        const nowIso = new Date().toISOString();
        product.lastAlertPrice = asinDecision.nextState.lastAlertPrice;
        product.lastAlertAvgPrice = asinDecision.nextState.lastAlertAvgPrice;
        product.samePriceAlertCount = asinDecision.nextState.samePriceAlertCount;
        product.lastAlertAt = nowIso;
        product.alertCount = (product.alertCount || 0) + 1;

        const effectiveAlertNum = normTitle
          ? Math.max(asinDecision.alertNumber, titleDecision.alertNumber)
          : asinDecision.alertNumber;

        if (normTitle) {
          alertedTitlesThisRun.add(normTitle);
          const titleState = {
            lastAlertPrice: titleDecision.nextState.lastAlertPrice,
            lastAlertAvgPrice: titleDecision.nextState.lastAlertAvgPrice,
            samePriceAlertCount: titleDecision.nextState.samePriceAlertCount,
            lastAlertAt: nowIso,
            lastAsin: asin,
          };
          data.titleAlertTracker[normTitle] = titleState;
          titleAlertUpdates[normTitle] = titleState;
        }

        console.log(
          `\n🚨 [${asin}] PRICE ERROR DETECTED: ${errorReason} (Alert ${effectiveAlertNum}/${CONFIG.maxAlertsPerSamePrice} at this price level)`
        );
        console.log(`   📦 ${product.title?.substring(0, 72) || asin}`);
        console.log(
          `   💰 Current: ${formatPrice(cur)} | Avg: ${formatPrice(avg)} | MRP: ${formatPrice(product.mrp)}`
        );
        errorCount++;

        alerts.push({
          product,
          currentPrice: cur,
          avgPrice: comparisonAvg,
          medianPrice: product.medianPrice,
          mrp: product.mrp,
          minMax,
          reason: errorReason,
          alertNumber: effectiveAlertNum,
          dropPct: dropPctNum,
        });
      }
    }
    // Note: Do NOT reset lastAlertPrice / samePriceAlertCount when isError is false,
    // so flickering Buy Box sellers cannot reset the max-3 repeat notification cap.

    if (shardOut) {
      updatedProducts[asin] = compactProductRecord(product);
    }
  }

  if (shardOut) {
    fs.mkdirSync(path.dirname(path.resolve(shardOut)), { recursive: true });
    fs.writeFileSync(
      shardOut,
      JSON.stringify({
        shardIndex,
        shardTotal,
        completedAt: new Date().toISOString(),
        checkedCount,
        skippedCount,
        errorCount,
        suppressedCount,
        updatedProducts,
        titleAlertUpdates,
      }),
      "utf-8"
    );
    console.log(
      `\n💾 Shard delta (${Object.keys(updatedProducts).length} products) saved to ${shardOut}`
    );
  } else {
    saveData(data);
    console.log(`\n💾 Updated prices & averages saved to ${CONFIG.dataFile}`);
  }

  if (forceTestAlert && alerts.length === 0) {
    const firstAsin = skus.find((a) => data.products[a]?.currentPrice != null);
    if (firstAsin) {
      const p = data.products[firstAsin];
      alerts.push({
        product: p,
        currentPrice: p.currentPrice,
        avgPrice: p.averagePrice,
        medianPrice: p.medianPrice,
        mrp: p.mrp,
        minMax: { min: p.minPrice, max: p.maxPrice },
        reason: "Test Run Verification (Live Amazon Search API Data)",
      });
    }
  }

  if (alerts.length > 0) {
    console.log(`\n📱 Sending ${alerts.length} price error alert(s) to Telegram...`);
    for (const alert of alerts) {
      const msg = buildAlertMessage(alert);
      const dropPct =
        typeof alert.dropPct === "number"
          ? alert.dropPct
          : alert.avgPrice && alert.avgPrice > 0
            ? ((alert.avgPrice - alert.currentPrice) / alert.avgPrice) * 100
            : 0;
      const targetChats = resolveAlertChatIds(dropPct);
      if (dropPct > CONFIG.highDiscountMinPercent && CONFIG.highDiscountTelegramChatId) {
        console.log(
          `   🚨 Ultra-high discount (${dropPct.toFixed(1)}% > ${CONFIG.highDiscountMinPercent}%) — routing to chats: ${targetChats.join(", ")}`
        );
      } else if (dropPct >= CONFIG.midDiscountMinPercent && CONFIG.midDiscountTelegramChatId) {
        console.log(
          `   🔥 High discount (${dropPct.toFixed(1)}% >= ${CONFIG.midDiscountMinPercent}%) — routing to chats: ${targetChats.join(", ")}`
        );
      }

      for (const chatId of targetChats) {
        try {
          await sendTelegram(msg, chatId);
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          console.error(
            `   ❌ Failed to send Telegram alert to ${chatId}:`,
            err.message
          );
        }
      }
    }
  } else {
    console.log("\n✅ No pricing errors detected in this run.");
  }

  const totalSec = ((Date.now() - runStartMs) / 1000).toFixed(1);
  console.log("\n══════════════ Run Summary ══════════════════════════════");
  console.log(`  SKUs configured:     ${skus.length}${shardLabel}`);
  console.log(`  Products priced:     ${checkedCount}`);
  console.log(`  Products skipped:    ${skippedCount}`);
  console.log(`  Price errors sent:   ${errorCount}`);
  console.log(`  Repeats suppressed:  ${suppressedCount}`);
  console.log(`  Total duration:      ${totalSec}s`);
  if (!shardOut) {
    console.log(`  Total runs logged:   ${data.runCount}`);
  }
  console.log("═══════════════════════════════════════════════════════════\n");

  return { data, alerts };
}

/**
 * Merge shard delta files generated by parallel `--shard i/N --shard-out ...`
 * runners back into `price-data.json`.
 */
function mergeShardFiles(shardDir) {
  const data = loadData();
  if (!data.titleAlertTracker || typeof data.titleAlertTracker !== "object") {
    data.titleAlertTracker = {};
  }

  if (!fs.existsSync(shardDir)) {
    console.error(`❌ Shard directory not found: ${shardDir}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(shardDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("ℹ️  No shard JSON files found to merge.");
    return;
  }

  let totalUpdated = 0;
  let totalErrors = 0;
  let totalSuppressed = 0;

  for (const file of files) {
    const fullPath = path.join(shardDir, file);
    const shard = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const products = shard.updatedProducts || {};
    for (const [asin, prod] of Object.entries(products)) {
      data.products[asin] = prod;
      totalUpdated++;
    }
    const titleUpdates = shard.titleAlertUpdates || {};
    for (const [normTitle, state] of Object.entries(titleUpdates)) {
      const existing = data.titleAlertTracker[normTitle];
      if (
        !existing ||
        (state.lastAlertAt && (!existing.lastAlertAt || state.lastAlertAt >= existing.lastAlertAt))
      ) {
        data.titleAlertTracker[normTitle] = state;
      }
    }
    totalErrors += shard.errorCount || 0;
    totalSuppressed += shard.suppressedCount || 0;
    console.log(
      `   🧩 Merged ${file}: ${Object.keys(products).length} products (alerts: ${shard.errorCount || 0}, suppressed: ${shard.suppressedCount || 0})`
    );
  }

  saveData(data);
  console.log(
    `\n✅ Merged ${files.length} shard(s): ${totalUpdated.toLocaleString("en-IN")} products updated | Alerts: ${totalErrors} | Suppressed: ${totalSuppressed} | Total runs: ${data.runCount}`
  );
}

// ─── CLI: SKU Management ────────────────────────────────────────────────────

function handleBulkAdd(asins) {
  const skuData = loadSkus();
  let addedCount = 0;
  for (const raw of asins) {
    const cleaned = raw.trim().toUpperCase();
    if (cleaned && !skuData.skus.includes(cleaned)) {
      skuData.skus.push(cleaned);
      addedCount++;
      console.log(`  ✅ Added SKU: ${cleaned}`);
    } else if (skuData.skus.includes(cleaned)) {
      console.log(`  ⏭️  Already monitored: ${cleaned}`);
    }
  }
  saveSkus(skuData);
  console.log(`\n✅ Added ${addedCount} new SKU(s). Total monitored: ${skuData.skus.length}`);
}

function handleRemoveSku(asin) {
  const skuData = loadSkus();
  const idx = skuData.skus.indexOf(asin);
  if (idx === -1) {
    console.log(`ℹ️  SKU ${asin} is not in skus.json.`);
    return;
  }
  skuData.skus.splice(idx, 1);
  saveSkus(skuData);
  console.log(`✅ Removed SKU: ${asin} (remaining: ${skuData.skus.length})`);
}

function handleListSkus() {
  const skuData = loadSkus();
  const data = loadData();
  console.log("\n📋 Monitored SKUs & Historical Averages:");
  console.log("──────────────────────────────────────────────────────────────────────");
  if (skuData.skus.length === 0) {
    console.log("  (empty — add SKUs with: node price-monitor.js --add B0XXXXX)");
  } else {
    for (const asin of skuData.skus) {
      const p = data.products[asin];
      if (p) {
        console.log(
          `  • ${asin} | Current: ${formatPrice(p.currentPrice)} | Avg: ${formatPrice(p.averagePrice)} | MRP: ${formatPrice(p.mrp)} | Runs: ${p.history?.length || 0}\n    ${p.title?.substring(0, 75) || ""}`
        );
      } else {
        console.log(`  • ${asin} | (not checked yet)`);
      }
    }
  }
  console.log(`\nTotal: ${skuData.skus.length} SKU(s)\n`);
}

// ─── CLI Entrypoint ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  const addIdx = args.indexOf("--add");
  if (addIdx >= 0) {
    const asins = args.slice(addIdx + 1).filter((a) => !a.startsWith("--"));
    if (asins.length === 0) {
      console.error("Usage: node price-monitor.js --add B0XXXXX [B0YYYYY ...]");
      process.exit(1);
    }
    handleBulkAdd(asins);
    return;
  }

  const removeIdx = args.indexOf("--remove");
  if (removeIdx >= 0) {
    const asin = args[removeIdx + 1];
    if (!asin) {
      console.error("Usage: node price-monitor.js --remove B0XXXXX");
      process.exit(1);
    }
    handleRemoveSku(asin.trim().toUpperCase());
    return;
  }

  if (args.includes("--list")) {
    handleListSkus();
    return;
  }

  if (args.includes("--test-telegram")) {
    console.log("📱 Sending test message to Telegram...");
    await sendTelegram(
      `✅ <b>Amazon.in Price Error Detector Connected!</b>\n\n` +
        `🔬 Engine: Reverse-Engineered Amazon Search API (<code>POST /s/query</code>)\n` +
        `🎯 Rule: Alert when discount &gt; ${CONFIG.minDiscountPercent}% (No price rule)\n` +
        `⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
    return;
  }

  const mergeIdx = args.indexOf("--merge-shards");
  if (mergeIdx >= 0) {
    const shardDir = args[mergeIdx + 1];
    if (!shardDir) {
      console.error("Usage: node price-monitor.js --merge-shards <dir>");
      process.exit(1);
    }
    mergeShardFiles(shardDir);
    return;
  }

  const workersIdx = args.indexOf("--workers");
  if (workersIdx >= 0 && args[workersIdx + 1]) {
    CONFIG.workerThreads = Math.max(1, parseInt(args[workersIdx + 1], 10) || CONFIG.workerThreads);
  }

  const batchIdx = args.indexOf("--batch-size");
  if (batchIdx >= 0 && args[batchIdx + 1]) {
    CONFIG.searchBatchSize = Math.max(1, parseInt(args[batchIdx + 1], 10) || CONFIG.searchBatchSize);
  }

  let shardIndex = null;
  let shardTotal = null;
  const shardIdx = args.indexOf("--shard");
  if (shardIdx >= 0 && args[shardIdx + 1]) {
    const parts = args[shardIdx + 1].split("/");
    shardIndex = parseInt(parts[0], 10);
    shardTotal = parseInt(parts[1], 10);
    if (!shardIndex || !shardTotal || shardIndex < 1 || shardIndex > shardTotal) {
      console.error("Usage: --shard <1..N>/<N> (e.g. --shard 1/4)");
      process.exit(1);
    }
  }

  const shardOutIdx = args.indexOf("--shard-out");
  const shardOut = shardOutIdx >= 0 ? args[shardOutIdx + 1] : null;
  const forcePlaywright = args.includes("--playwright");
  const forceTestAlert = args.includes("--send-test-alert");
  const isLoop = args.includes("--loop");
  const intervalIdx = args.indexOf("--interval");
  const intervalMin =
    intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) || 5 : 5;

  const runOpts = {
    forceTestAlert,
    shardIndex,
    shardTotal,
    shardOut,
    forcePlaywright,
  };

  if (isLoop) {
    console.log(
      `🔄 Continuous mode: checking via Amazon Search API every ${intervalMin} minute(s). Ctrl+C to stop.\n`
    );
    while (true) {
      try {
        await runMonitor(runOpts);
      } catch (err) {
        console.error("❌ Run failed:", err.message);
      }
      console.log(`⏳ Next check in ${intervalMin} minute(s)...`);
      await new Promise((r) => setTimeout(r, intervalMin * 60 * 1000));
    }
  } else {
    await runMonitor(runOpts);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

module.exports = {
  runMonitor,
  mergeShardFiles,
  sendTelegram,
  resolveAlertChatIds,
  loadData,
  loadSkus,
  evaluateRepeatAlertThrottle,
  normalizeProductTitle,
  CONFIG,
};
