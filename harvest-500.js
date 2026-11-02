// ============================================================================
// Amazon.in Search API Bulk Category Harvester (500 Products per Category)
// ============================================================================
// Uses the reverse-engineered Amazon Search API (`POST /s/query`) inside
// Playwright with concurrent fetch workers to harvest 500 unique products
// (with actual selling price > ₹5,000) for each of the 11 target categories
// (5,500 products total), and saves them to `skus.json` and `price-data.json`.
// ============================================================================

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const TARGET_PER_CATEGORY = 500;
const MIN_PRICE = 5000;
const CONCURRENCY = 10;

const CATEGORIES = [
  {
    name: "sofa",
    queries: [
      "sofa set for living room",
      "3 seater sofa",
      "l shape sofa set",
      "wooden sofa set",
      "2 seater sofa",
      "leatherette sofa",
      "fabric sofa set",
      "sectional sofa",
      "5 seater sofa set",
      "chesterfield sofa",
      "modern sofa living room",
      "velvet sofa",
    ],
  },
  {
    name: "almirah",
    queries: [
      "almirah for clothes",
      "wooden wardrobe",
      "3 door wardrobe",
      "2 door wardrobe",
      "4 door wardrobe",
      "steel almirah",
      "sliding door wardrobe",
      "engineered wood wardrobe",
      "wardrobe with mirror",
      "bedroom almirah",
      "sheesham wood wardrobe",
      "metal almirah godrej",
    ],
  },
  {
    name: "recliner",
    queries: [
      "recliner chair",
      "single seater recliner",
      "motorized recliner",
      "2 seater recliner sofa",
      "3 seater recliner",
      "rocking recliner chair",
      "leather recliner sofa",
      "fabric recliner chair",
      "home theater recliner",
      "living room recliner",
      "massage recliner chair",
      "swivel recliner",
    ],
  },
  {
    name: "sofa cum bed",
    queries: [
      "sofa cum bed",
      "wooden sofa cum bed",
      "3 seater sofa cum bed",
      "folding sofa bed",
      "metal sofa cum bed",
      "convertible sofa bed",
      "futon sofa bed",
      "sofa cum bed with storage",
      "2 seater sofa cum bed",
      "pull out sofa bed",
      "fabric sofa cum bed",
      "sheesham wood sofa cum bed",
    ],
  },
  {
    name: "laptop",
    queries: [
      "laptop",
      "gaming laptop",
      "intel core i5 laptop",
      "intel core i7 laptop",
      "amd ryzen 5 laptop",
      "amd ryzen 7 laptop",
      "thin and light laptop",
      "business laptop",
      "student laptop",
      "macbook air pro",
      "16gb ram laptop",
      "touchscreen laptop",
    ],
  },
  {
    name: "dining table",
    queries: [
      "dining table 4 seater",
      "dining table 6 seater",
      "solid wood dining table set",
      "sheesham wood dining table",
      "marble top dining table",
      "glass top dining table set",
      "folding dining table",
      "2 seater dining table set",
      "8 seater dining table set",
      "round dining table set",
      "modern dining table with bench",
      "teak wood dining table",
    ],
  },
  {
    name: "office chair",
    queries: [
      "ergonomic office chair",
      "high back mesh office chair",
      "executive office chair",
      "leatherette boss chair",
      "gaming chair office",
      "study desk chair ergonomic",
      "reclining office chair",
      "lumbar support office chair",
      "heavy duty office chair",
      "white ergonomic chair",
      "work from home chair",
      "adjustable headrest office chair",
    ],
  },
  {
    name: "speaker",
    queries: [
      "party speaker",
      "dolby atmos soundbar",
      "home theater speaker 5.1",
      "portable bluetooth speaker",
      "bookshelf speakers",
      "tower speaker",
      "karaoke trolley speaker",
      "jbl bluetooth speaker",
      "sony speaker soundbar",
      "marshall speaker",
      "bose speaker",
      "subwoofer speaker system",
    ],
  },
  {
    name: "monitor",
    queries: [
      "27 inch monitor",
      "gaming monitor",
      "4k uhd monitor",
      "32 inch monitor",
      "curved monitor",
      "24 inch ips monitor",
      "ultrawide monitor",
      "144hz gaming monitor",
      "type c monitor",
      "lg samsung dell benq monitor",
      "qhd 2k monitor",
      "portable monitor",
    ],
  },
  {
    name: "lux purse",
    queries: [
      "luxury handbag women",
      "genuine leather handbag women",
      "designer tote bag women",
      "branded satchel bag women",
      "leather shoulder bag women",
      "aldo guess fossil handbag",
      "da milano hidesign leather bag",
      "luxury sling bag women",
      "premium women purse handbag",
      "michael kors coach handbag",
      "leather crossbody bag women",
      "luxury structured handbag",
    ],
  },
  {
    name: "watches",
    queries: [
      "luxury watches for men",
      "automatic watch men",
      "chronograph watch men",
      "luxury watches for women",
      "fossil titan casio edifice watch",
      "seiko citizen tissot watch",
      "skeleton mechanical watch men",
      "smartwatch",
      "analog stainless steel watch men",
      "swiss watch men",
      "leather strap chronograph watch",
      "diving watch men",
    ],
  },
];

const SORT_ORDERS = [
  "relevanceblender",
  "price-asc-rank",
  "price-desc-rank",
  "review-rank",
  "date-desc-rank",
];

// Price filter buckets on Amazon.in (in paise: 500100 = ₹5,001)
const PRICE_BUCKETS = [
  "p_36:500100-",
  "p_36:500100-1000000",
  "p_36:1000000-2000000",
  "p_36:2000000-4000000",
  "p_36:4000000-",
];

function loadData(dataFile) {
  try {
    if (fs.existsSync(dataFile)) {
      return JSON.parse(fs.readFileSync(dataFile, "utf-8"));
    }
  } catch {}
  return { products: {}, lastRun: null, runCount: 0 };
}

function loadSkus(skuFile) {
  try {
    if (fs.existsSync(skuFile)) {
      return JSON.parse(fs.readFileSync(skuFile, "utf-8"));
    }
  } catch {}
  return { categories: {}, skus: [] };
}

async function harvestCategory(page, cat, existingCategoryMap, globalProducts, usedGlobalAsins) {
  const collected = new Map();

  // Seed with any already-valid items for this category > 5000 that aren't used by an earlier category
  const existingList = existingCategoryMap[cat.name] || [];
  for (const asin of existingList) {
    const p = globalProducts[asin];
    if (p && p.currentPrice > MIN_PRICE && !usedGlobalAsins.has(asin)) {
      p.category = cat.name;
      collected.set(asin, p);
      usedGlobalAsins.add(asin);
    }
  }

  // Build candidate Search API task queue
  const tasks = [];
  for (const q of cat.queries) {
    for (const sort of SORT_ORDERS.slice(0, 3)) {
      for (let pageNum = 1; pageNum <= 5; pageNum++) {
        tasks.push({
          qs: `k=${encodeURIComponent(q)}&rh=${encodeURIComponent("p_36:500100-")}&s=${sort}&page=${pageNum}`,
        });
      }
    }
  }
  // Additional price-bucketed tasks if needed
  for (const q of cat.queries.slice(0, 6)) {
    for (const bucket of PRICE_BUCKETS.slice(1)) {
      for (let pageNum = 1; pageNum <= 4; pageNum++) {
        tasks.push({
          qs: `k=${encodeURIComponent(q)}&rh=${encodeURIComponent(bucket)}&page=${pageNum}`,
        });
      }
    }
  }

  let taskIdx = 0;

  while (collected.size < TARGET_PER_CATEGORY && taskIdx < tasks.length) {
    const batch = tasks.slice(taskIdx, taskIdx + CONCURRENCY);
    taskIdx += CONCURRENCY;

    const batchItems = await page.evaluate(
      async ({ batchTasks, minPrice }) => {
        const parseNum = (s) => {
          if (!s) return null;
          const cleaned = String(s).replace(/[^\d.]/g, "");
          const n = parseFloat(cleaned);
          return isNaN(n) ? null : n;
        };

        const parser = new DOMParser();

        const fetchOne = async (qs) => {
          try {
            const res = await fetch(`/s/query?${qs}`, {
              method: "POST",
              headers: {
                Accept: "text/html,*/*",
                "Content-Type": "application/json",
                "X-Requested-With": "XMLHttpRequest",
              },
              body: JSON.stringify({ "customer-action": "query" }),
              credentials: "include",
            });
            if (!res.ok) return [];
            const text = await res.text();
            const chunks = text.split("&&&");
            const found = [];

            for (let i = 0; i < chunks.length; i++) {
              const c = chunks[i].trim();
              if (!c) continue;
              let arr;
              try {
                arr = JSON.parse(c);
              } catch {
                continue;
              }
              if (!Array.isArray(arr) || arr[0] !== "dispatch") continue;
              const payload = arr[2];
              if (!payload || !payload.asin || !payload.html) continue;

              const doc = parser.parseFromString(payload.html, "text/html");
              const csaPrice = doc
                .querySelector("[data-csa-c-price-to-pay]")
                ?.getAttribute("data-csa-c-price-to-pay");
              const offscreenPrice = doc
                .querySelector('.a-price:not([data-a-strike="true"]) .a-offscreen')
                ?.textContent?.trim();
              const wholePrice = doc
                .querySelector('.a-price:not([data-a-strike="true"]) .a-price-whole')
                ?.textContent?.trim();

              const currentPrice =
                parseNum(csaPrice) ?? parseNum(offscreenPrice) ?? parseNum(wholePrice);
              if (!currentPrice || currentPrice <= minPrice) continue;

              const mrp = parseNum(
                doc
                  .querySelector('.a-price[data-a-strike="true"] .a-offscreen')
                  ?.textContent?.trim()
              );

              const h2List = [
                ...doc.querySelectorAll('[data-cy="title-recipe"] h2, h2'),
              ];
              const titleParts = h2List
                .map(
                  (el) =>
                    el.getAttribute("aria-label")?.trim() ||
                    el.textContent?.trim()
                )
                .filter(Boolean);
              const title = [...new Set(titleParts)].join(" — ") || payload.asin;

              const dealBadge =
                doc.querySelector(".a-badge-text")?.textContent?.trim() || null;
              const merchantEl =
                doc.querySelector("[data-csa-c-merchant-id]") ||
                doc.querySelector('input[name="merchantId"]');
              const merchantId =
                merchantEl?.getAttribute("data-csa-c-merchant-id") ||
                merchantEl?.getAttribute("value") ||
                null;
              const imageUrl =
                doc.querySelector("img.s-image")?.getAttribute("src") || null;

              const priceRecipe = doc.querySelector('[data-cy="price-recipe"]');
              let discountText = null;
              if (priceRecipe) {
                const m = priceRecipe.textContent.match(/\(\d+%\s*off\)/i);
                if (m) discountText = m[0];
              }

              found.push({
                asin: payload.asin,
                title,
                currentPrice,
                mrp,
                dealBadge,
                discountText,
                merchantId,
                imageUrl,
              });
            }
            return found;
          } catch {
            return [];
          }
        };

        const all = await Promise.all(batchTasks.map((t) => fetchOne(t.qs)));
        return all.flat();
      },
      { batchTasks: batch, minPrice: MIN_PRICE }
    );

    const nowIso = new Date().toISOString();
    for (const item of batchItems) {
      if (collected.size >= TARGET_PER_CATEGORY) break;
      if (!collected.has(item.asin) && !usedGlobalAsins.has(item.asin)) {
        const record = {
          asin: item.asin,
          category: cat.name,
          title: item.title,
          mrp: item.mrp,
          currentPrice: item.currentPrice,
          averagePrice: item.currentPrice,
          medianPrice: item.currentPrice,
          minPrice: item.currentPrice,
          maxPrice: item.currentPrice,
          discountText: item.discountText,
          dealBadge: item.dealBadge,
          merchantId: item.merchantId,
          imageUrl: item.imageUrl,
          history: [
            {
              price: item.currentPrice,
              mrp: item.mrp,
              isDeal: Boolean(item.dealBadge),
              dealBadge: item.dealBadge,
              merchantId: item.merchantId,
              timestamp: nowIso,
            },
          ],
          lastChecked: nowIso,
          alertCount: 0,
          firstSeen: nowIso,
        };
        collected.set(item.asin, record);
        globalProducts[item.asin] = record;
        usedGlobalAsins.add(item.asin);
      }
    }

    process.stdout.write(
      `\r   📦 [${cat.name.padEnd(13)}] Harvested: ${collected.size}/${TARGET_PER_CATEGORY} (queries: ${taskIdx}/${tasks.length})`
    );
  }

  console.log(
    `\n   ✅ Completed [${cat.name}]: ${collected.size} products (> ₹${MIN_PRICE})`
  );
  return [...collected.keys()].slice(0, TARGET_PER_CATEGORY);
}

async function main() {
  const dataFile = path.join(__dirname, "price-data.json");
  const skuFile = path.join(__dirname, "skus.json");

  const data = loadData(dataFile);
  const skuData = loadSkus(skuFile);
  if (!skuData.categories) skuData.categories = {};

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  🛒 Amazon.in Bulk Search API Harvester (500 SKUs × 11 Categories)");
  console.log(`  🎯 Target: ${TARGET_PER_CATEGORY} products/category = ${TARGET_PER_CATEGORY * CATEGORIES.length} total`);
  console.log(`  💰 Filter: Selling Price > ₹${MIN_PRICE.toLocaleString("en-IN")}`);
  console.log("═══════════════════════════════════════════════════════════════════\n");

  const context = await chromium.launchPersistentContext(
    path.join(__dirname, "browser-data"),
    {
      headless: true,
      viewport: { width: 1366, height: 768 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    }
  );

  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log("🌐 Connecting to Amazon.in Search API...");
    await page.goto("https://www.amazon.in/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const allSkus = [];
    const usedGlobalAsins = new Set();

    for (const cat of CATEGORIES) {
      const catSkus = await harvestCategory(
        page,
        cat,
        skuData.categories,
        data.products,
        usedGlobalAsins
      );
      skuData.categories[cat.name] = catSkus;
      allSkus.push(...catSkus);

      // Save checkpoint after each category
      skuData.skus = [...new Set(allSkus)];
      fs.writeFileSync(skuFile, JSON.stringify(skuData, null, 2), "utf-8");
      data.lastRun = new Date().toISOString();
      data.runCount = (data.runCount || 0) + 1;
      fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), "utf-8");
    }

    console.log("\n═══════════════════════════════════════════════════════════════════");
    console.log(`  🎉 Harvest Complete! Total Unique SKUs: ${skuData.skus.length}`);
    for (const cat of CATEGORIES) {
      console.log(
        `     • ${cat.name.padEnd(14)}: ${(skuData.categories[cat.name] || []).length} SKUs`
      );
    }
    console.log("═══════════════════════════════════════════════════════════════════\n");
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
