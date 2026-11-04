// ============================================================================
// Amazon.in Price Error Detector (Powered by Amazon Search API)
// ============================================================================
// Reverse-engineered Amazon.in internal Search API (`/s/query` Rush streaming
// endpoint) via Playwright to batch-query product SKUs (ASINs), track price
// history and average prices in `price-data.json`, detect pricing errors, and
// send instant alerts to a Telegram group.
//
// Rule: No minimum price rule; ONLY discount rule > 30% off.
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

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");

// ─── Configuration ──────────────────────────────────────────────────────────

const CONFIG = {
  // Telegram Bot credentials (supergroup IDs in Telegram API use -100 prefix)
  telegramBotToken:
    process.env.TELEGRAM_BOT_TOKEN ||
    "5420527489:AAE1F1DDhqaiUHCu-kHauFfqhgEhOlG0aMI",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "-1002197097024",

  // Discount rule ONLY (all price thresholds/rules removed):
  // Alert ONLY when discount is strictly > 30%
  minDiscountPercent: parseFloat(process.env.MIN_DISCOUNT_PERCENT || "30"),

  // Data and SKU files
  dataFile: path.join(__dirname, "price-data.json"),
  skuFile: path.join(__dirname, "skus.json"),

  // Browser settings (persistent context preserves Amazon.in login session)
  headless: process.env.HEADLESS === "true" ? true : false,
  userDataDir: path.join(__dirname, "browser-data"),

  // Amazon Search API batch size (rh=p_78:ASIN1|ASIN2|... supports up to 16 ASINs per page)
  searchBatchSize: 15,
  searchConcurrency: 12,

  // Delays (ms) between Search API waves
  betweenBatchDelay: 150,

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
 * Save updated price data to JSON file.
 */
function saveData(data) {
  if (data && data.products) {
    for (const product of Object.values(data.products)) {
      if (Array.isArray(product.history) && product.history.length > CONFIG.maxHistoryEntries) {
        product.history = product.history.slice(-CONFIG.maxHistoryEntries);
      }
    }
  }
  data.lastRun = new Date().toISOString();
  data.runCount = (data.runCount || 0) + 1;
  fs.writeFileSync(CONFIG.dataFile, JSON.stringify(data, null, 2), "utf-8");
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
 * Calculate arithmetic mean price from history entries.
 */
function calculateAverage(history) {
  if (!history || history.length === 0) return null;
  const prices = history.map((h) => h.price).filter((p) => p != null && p > 0);
  if (prices.length === 0) return null;
  const avg = prices.reduce((sum, p) => sum + p, 0) / prices.length;
  return Math.round(avg * 100) / 100;
}

/**
 * Calculate median price from history entries.
 */
function calculateMedian(history) {
  if (!history || history.length === 0) return null;
  const prices = history
    .map((h) => h.price)
    .filter((p) => p != null && p > 0)
    .sort((a, b) => a - b);
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
  if (!history || history.length === 0) return { min: null, max: null };
  const prices = history.map((h) => h.price).filter((p) => p != null && p > 0);
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

// ─── Telegram Notification ──────────────────────────────────────────────────

/**
 * Send an HTML message to the configured Telegram chat/group.
 */
function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    if (
      !CONFIG.telegramBotToken ||
      CONFIG.telegramBotToken === "YOUR_BOT_TOKEN_HERE" ||
      !CONFIG.telegramChatId ||
      CONFIG.telegramChatId === "YOUR_CHAT_ID_HERE"
    ) {
      console.log("\n📱 [Telegram Alert Preview — set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID to send live]:");
      console.log(message.replace(/<[^>]+>/g, ""));
      return resolve({ skipped: true });
    }

    const payload = JSON.stringify({
      chat_id: CONFIG.telegramChatId,
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
          console.log("✅ Telegram alert sent successfully.");
          resolve({ sent: true });
        } else if (res.statusCode === 429) {
          let retryAfter = 35;
          try {
            const parsed = JSON.parse(body);
            retryAfter = (parsed?.parameters?.retry_after || 30) + 2;
          } catch {}
          console.log(`⏳ Telegram rate limit (429) — waiting ${retryAfter}s and retrying...`);
          setTimeout(() => {
            sendTelegram(message).then(resolve).catch(reject);
          }, retryAfter * 1000);
        } else {
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
 * Format Telegram alert message for a detected pricing error.
 */
function buildAlertMessage(alert) {
  const { product, currentPrice, avgPrice, medianPrice, minMax, reason } = alert;
  const dropFromAvg =
    avgPrice && avgPrice > 0
      ? (((avgPrice - currentPrice) / avgPrice) * 100).toFixed(1)
      : "0.0";
  const productUrl = `https://www.amazon.in/dp/${product.asin}`;

  return (
    `🚨 <b>AMAZON PRICE ERROR DETECTED!</b>\n\n` +
    `📦 <b>${escapeHtml(product.title)}</b>\n` +
    `🔖 SKU / ASIN: <code>${product.asin}</code>\n` +
    `⚡ Trigger: ${escapeHtml(reason)}\n\n` +
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
          .map(
            (el) =>
              el.getAttribute("aria-label")?.trim() || el.textContent?.trim()
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
 * Normalize a raw item from `queryAmazonSearchApi` into our product record format.
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

// ─── Core: Main Monitoring Logic ────────────────────────────────────────────

async function runMonitor(options = {}) {
  const { forceTestAlert = false } = options;
  const skuData = loadSkus();
  const skus = (skuData.skus || []).map((s) => s.trim().toUpperCase()).filter(Boolean);

  if (skus.length === 0) {
    console.error(
      "❌ No SKUs configured in skus.json! Add ASINs using:\n" +
        "   node price-monitor.js --add B0DGJHBX5Y B0CNM4V6Q5\n" +
        "   Or edit skus.json directly."
    );
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🛒 Amazon.in Price Error Detector (Search API Engine)");
  console.log(`  📦 Monitoring ${skus.length} SKU(s)`);
  console.log(
    `  🎯 Discount Rule: > ${CONFIG.minDiscountPercent}% off (No minimum price rule)`
  );
  console.log(
    `  ⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
  );
  console.log("═══════════════════════════════════════════════════════════");

  const data = loadData();
  const alerts = [];

  console.log("\n🚀 Launching Playwright browser context...");
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

  let checkedCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  try {
    console.log("🌐 Establishing Amazon.in session...");
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

    const searchResults = await fetchSkusViaSearchApi(page, skus);

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

      product.history.push({
        price: result.currentPrice,
        mrp: result.mrp,
        isDeal: result.isDeal,
        dealBadge: result.dealBadge,
        merchantId: result.merchantId,
        timestamp: result.scrapedAt,
      });

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

      // ── Detect Price Error (Only Discount Rule > 30%; No Price Rule) ──
      let isError = false;
      let errorReason = "";

      if (
        comparisonAvg != null &&
        comparisonAvg > 0 &&
        priorCount + 1 >= CONFIG.minDataPointsForAlert
      ) {
        const dropPctNum = ((comparisonAvg - cur) / comparisonAvg) * 100;
        if (dropPctNum > CONFIG.minDiscountPercent) {
          const dropPct = dropPctNum.toFixed(1);
          isError = true;
          errorReason = `Discount ${dropPct}% (> ${CONFIG.minDiscountPercent}%) below historical JSON price (${formatPrice(comparisonAvg)})`;
        }
      }

      if (isError) {
        console.log(`\n🚨 [${asin}] PRICE ERROR DETECTED: ${errorReason}`);
        console.log(`   📦 ${product.title?.substring(0, 72) || asin}`);
        console.log(`   💰 Current: ${formatPrice(cur)} | Avg: ${formatPrice(avg)} | MRP: ${formatPrice(product.mrp)}`);
        product.alertCount = (product.alertCount || 0) + 1;
        errorCount++;

        alerts.push({
          product,
          currentPrice: cur,
          avgPrice: comparisonAvg,
          medianPrice: product.medianPrice,
          mrp: product.mrp,
          minMax,
          reason: errorReason,
        });
      }
    }
  } finally {
    await context.close();
  }

  saveData(data);
  console.log(`\n💾 Updated prices & averages saved to ${CONFIG.dataFile}`);

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
      try {
        await sendTelegram(msg);
        await new Promise((r) => setTimeout(r, 400));
      } catch (err) {
        console.error("   ❌ Failed to send Telegram alert:", err.message);
      }
    }
  } else {
    console.log("\n✅ No pricing errors detected in this run.");
  }

  console.log("\n══════════════ Run Summary ══════════════════════════════");
  console.log(`  SKUs configured:     ${skus.length}`);
  console.log(`  Products priced:     ${checkedCount}`);
  console.log(`  Products skipped:    ${skippedCount}`);
  console.log(`  Price errors found:  ${errorCount}`);
  console.log(`  Total runs logged:   ${data.runCount}`);
  console.log("═══════════════════════════════════════════════════════════\n");

  return { data, alerts };
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

  const forceTestAlert = args.includes("--send-test-alert");
  const isLoop = args.includes("--loop");
  const intervalIdx = args.indexOf("--interval");
  const intervalMin =
    intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) || 5 : 5;

  if (isLoop) {
    console.log(
      `🔄 Continuous mode: checking via Amazon Search API every ${intervalMin} minute(s). Ctrl+C to stop.\n`
    );
    while (true) {
      try {
        await runMonitor({ forceTestAlert });
      } catch (err) {
        console.error("❌ Run failed:", err.message);
      }
      console.log(`⏳ Next check in ${intervalMin} minute(s)...`);
      await new Promise((r) => setTimeout(r, intervalMin * 60 * 1000));
    }
  } else {
    await runMonitor({ forceTestAlert });
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
  sendTelegram,
  loadData,
  loadSkus,
  CONFIG,
};
