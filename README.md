# 🛒 Amazon.in Price Error Detector (Amazon Search API)

Monitors Amazon.in product SKUs (ASINs) using the reverse-engineered **Amazon Search API (`POST /s/query`)** via Playwright, calculates running average prices in `price-data.json`, detects pricing errors, and sends instant alerts to your Telegram group.

---

## 🔬 Reverse-Engineered Amazon Search API

Instead of slowly loading full `/dp/{ASIN}` product pages one by one, this tool uses Amazon's internal Rush Search API endpoint:

- **Endpoint**: `POST https://www.amazon.in/s/query`
- **Query Parameters**:
  - **Batch SKU Refinement (Primary)**: `?rh=p_78:ASIN1|ASIN2|ASIN3...&s=relevanceblender`
    - Uses Amazon's internal `p_78` ASIN filter refinement to fetch up to **12–16 SKUs in a single API call** with **zero sponsored ads**.
  - **Single SKU Search (Fallback)**: `?k=ASIN`
- **Headers**:
  ```http
  Accept: text/html,*/*
  Content-Type: application/json
  X-Requested-With: XMLHttpRequest
  ```
- **Request Body**:
  ```json
  {"customer-action": "query"}
  ```
- **Response Format**: `application/json-amazonui-streaming;charset=UTF-8`
  - Streams `&&&`-delimited JSON dispatch arrays:
    - `["dispatch", "data-search-metadata", { "metadata": { "totalResultCount": 2, "qid": "...", "rid": "..." } }]`
    - `["dispatch", "data-main-slot:search-result-N", { "asin": "B0DGJHBX5Y", "index": 2, "html": "..." }]`
  - Each search result chunk contains:
    - Exact checkout price (`data-csa-c-price-to-pay` & `.a-price:not([data-a-strike="true"]) .a-offscreen`)
    - Strike-through MRP (`.a-price[data-a-strike="true"] .a-offscreen`)
    - Deal badge (`.a-badge-text`, `data-a-badge-type="deal"`)
    - Merchant ID (`data-csa-c-merchant-id` / `input[name="merchantId"]`)
    - Product title, rating, delivery estimate, and thumbnail URL

---

## 🚀 Usage

### 1. Add SKUs (ASINs) to Monitor
```bash
# Add one or multiple ASINs via CLI
node price-monitor.js --add B0DGJHBX5Y B0DSFQZTVW

# List monitored SKUs and their average prices
node price-monitor.js --list

# Remove an ASIN
node price-monitor.js --remove B0DSFQZTVW
```
Or edit [`skus.json`](./skus.json) directly:
```json
{
  "skus": [
    "B0DGJHBX5Y",
    "B0DSFQZTVW"
  ]
}
```

### 2. Configure Telegram Alerts
Set your Telegram Bot Token and Group Chat ID via environment variables (or directly in `CONFIG` inside [`price-monitor.js`](./price-monitor.js)):
```powershell
$env:TELEGRAM_BOT_TOKEN="your_bot_token_here"
$env:TELEGRAM_CHAT_ID="your_group_chat_id_here"
```

### 3. Run the Price Error Monitor
```powershell
# Run once (updates price-data.json and sends Telegram alerts on price errors)
node price-monitor.js

# Run continuously every 5 minutes
node price-monitor.js --loop --interval 5
```

---

## 📁 Data Format (`price-data.json`)

After each run, [`price-data.json`](./price-data.json) is updated and saved with each SKU's current price, **average price** (`averagePrice`), median price, historical min/max, MRP, and timestamped price history:

```json
{
  "products": {
    "B0DGJHBX5Y": {
      "asin": "B0DGJHBX5Y",
      "title": "Apple iPhone 16 128 GB: 5G Mobile Phone with Camera Control...",
      "mrp": 89900,
      "currentPrice": 76999,
      "averagePrice": 76999,
      "medianPrice": 76999,
      "minPrice": 76999,
      "maxPrice": 76999,
      "discountText": "(14% off)",
      "dealBadge": "Mega Festival Deal",
      "merchantId": "AJ6SIZC8YQDZX",
      "history": [
        {
          "price": 76999,
          "mrp": 89900,
          "isDeal": true,
          "dealBadge": "Mega Festival Deal",
          "merchantId": "AJ6SIZC8YQDZX",
          "timestamp": "2026-11-02T13:27:17.497Z"
        }
      ],
      "lastChecked": "2026-11-02T13:27:17.497Z",
      "alertCount": 0,
      "firstSeen": "2026-11-02T13:27:17.497Z"
    }
  },
  "lastRun": "2026-11-02T13:27:17.564Z",
  "runCount": 1
}
```
