// ============================================================================
// Telegram Bot Cron Runner & Controller (`telegram-cron.js`)
// ============================================================================
// Runs the Amazon Search API Price Error Monitor on a recurring cron schedule
// AND listens for Telegram Bot commands in your group (`Flipkart- 2024`):
//
//   /status          - View cron status, next run time, and SKU stats
//   /run             - Trigger an immediate price check run from Telegram
//   /interval <min>  - Change cron interval (e.g. /interval 15)
//   /pause           - Pause automatic scheduled runs
//   /resume          - Resume automatic scheduled runs
// ============================================================================

const https = require("https");
const {
  runMonitor,
  sendTelegram,
  loadData,
  loadSkus,
  CONFIG,
} = require("./price-monitor");

let intervalMinutes = parseInt(process.env.CRON_INTERVAL_MIN || "5", 10);
let isPaused = false;
let isRunningJob = false;
let nextRunTime = new Date(Date.now() + intervalMinutes * 60 * 1000);
let timerHandle = null;
let lastUpdateId = 0;

function pollTelegramUpdates() {
  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
  https
    .get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.ok && Array.isArray(parsed.result)) {
            for (const update of parsed.result) {
              lastUpdateId = Math.max(lastUpdateId, update.update_id);
              const msg = update.message || update.channel_post;
              if (msg && msg.text) {
                await handleTelegramCommand(msg.text.trim());
              }
            }
          }
        } catch {}
        setTimeout(pollTelegramUpdates, 2000);
      });
    })
    .on("error", () => {
      setTimeout(pollTelegramUpdates, 5000);
    });
}

async function handleTelegramCommand(text) {
  const cmd = text.split("@")[0].split(/\s+/)[0].toLowerCase();
  const arg = text.split(/\s+/)[1];

  if (cmd === "/status") {
    const skuData = loadSkus();
    const data = loadData();
    const categoriesCount = Object.keys(skuData.categories || {}).length;
    await sendTelegram(
      `📊 <b>Price Error Cron Status</b>\n\n` +
        `🟢 State: <b>${isPaused ? "PAUSED" : isRunningJob ? "RUNNING NOW" : "ACTIVE"}</b>\n` +
        `⏱️ Cron Interval: Every <b>${intervalMinutes} min</b>\n` +
        `📦 Monitored SKUs: <b>${(skuData.skus || []).length}</b> (${categoriesCount} categories)\n` +
        `🔄 Total Runs Logged: <b>${data.runCount || 0}</b>\n` +
        `🕒 Last Run: ${data.lastRun ? new Date(data.lastRun).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "N/A"}\n` +
        `⏭️ Next Scheduled Run: ${isPaused ? "Paused" : nextRunTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
  } else if (cmd === "/run") {
    if (isRunningJob) {
      await sendTelegram(`⏳ A price check run is already in progress!`);
      return;
    }
    await executeScheduledRun("Manual /run command from Telegram");
  } else if (cmd === "/pause") {
    isPaused = true;
    await sendTelegram(`⏸️ <b>Cron Job Paused.</b> Send /resume to restart scheduled checks.`);
  } else if (cmd === "/resume") {
    isPaused = false;
    scheduleNext();
    await sendTelegram(
      `▶️ <b>Cron Job Resumed!</b> Next run at ${nextRunTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}.`
    );
  } else if (cmd === "/interval") {
    const mins = parseInt(arg, 10);
    if (!mins || mins < 1) {
      await sendTelegram(`⚠️ Usage: <code>/interval 15</code> (minutes)`);
      return;
    }
    intervalMinutes = mins;
    scheduleNext();
    await sendTelegram(
      `✅ Cron interval updated to every <b>${intervalMinutes} minute(s)</b>.\nNext run: ${nextRunTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
  }
}

async function executeScheduledRun(triggerSource = "Scheduled Cron") {
  if (isRunningJob) return;
  isRunningJob = true;
  CONFIG.headless = true;

  console.log(`\n⏰ [${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}] Starting run (${triggerSource})...`);
  await sendTelegram(
    `🔄 <b>Cron Run Started</b> (${triggerSource})\n` +
      `Checking 5,500 SKUs via Amazon Search API...`
  );

  const startMs = Date.now();
  try {
    const { data, alerts } = await runMonitor();
    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    await sendTelegram(
      `✅ <b>Cron Run Completed in ${elapsedSec}s</b>\n` +
        `📦 SKUs Checked: <b>${Object.keys(data.products).length}</b>\n` +
        `🚨 Price Errors (&ge;50% below historical JSON price): <b>${alerts.length}</b>\n` +
        `⏭️ Next Run: ${new Date(Date.now() + intervalMinutes * 60 * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`
    );
  } catch (err) {
    console.error("❌ Cron run error:", err.message);
    await sendTelegram(`❌ <b>Cron Run Error:</b> ${err.message}`);
  } finally {
    isRunningJob = false;
    scheduleNext();
  }
}

function scheduleNext() {
  if (timerHandle) clearTimeout(timerHandle);
  if (isPaused) return;
  nextRunTime = new Date(Date.now() + intervalMinutes * 60 * 1000);
  timerHandle = setTimeout(() => {
    if (!isPaused) {
      executeScheduledRun("Scheduled Cron");
    }
  }, intervalMinutes * 60 * 1000);
}

async function startCronDaemon() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🤖 Telegram Cron Daemon Started (@Uk_discountbot)");
  console.log(`  ⏱️  Interval: Every ${intervalMinutes} minute(s)`);
  console.log("  💬 Telegram Commands: /status, /run, /interval <m>, /pause, /resume");
  console.log("═══════════════════════════════════════════════════════════\n");

  await sendTelegram(
    `🤖 <b>Amazon Price Error Cron Daemon Online!</b>\n\n` +
      `📦 Tracking: <b>5,500 SKUs</b> (11 categories, &gt; ₹5,000)\n` +
      `⏱️ Schedule: Every <b>${intervalMinutes} minutes</b>\n\n` +
      `<b>Telegram Commands:</b>\n` +
      `• /status — Check cron &amp; SKU status\n` +
      `• /run — Trigger an immediate check now\n` +
      `• /interval 15 — Change schedule interval (mins)\n` +
      `• /pause — Pause cron schedule\n` +
      `• /resume — Resume cron schedule`
  );

  pollTelegramUpdates();
  scheduleNext();

  if (process.argv.includes("--run-now")) {
    await executeScheduledRun("Initial Startup Run");
  }
}

startCronDaemon().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
