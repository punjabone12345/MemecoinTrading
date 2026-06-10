import axios from "axios";
import { logger } from "./logger.js";

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];

// Set TELEGRAM_POLLING_DISABLED=true on whichever instance should NOT poll
// (e.g. set it on the Replit dev server when Render is your production instance,
//  or set it on Render if you want Replit to be the active bot)
const POLLING_DISABLED = process.env["TELEGRAM_POLLING_DISABLED"] === "true";

export function isTelegramConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

/**
 * Returns true when the bot scanner is allowed to open new entries (IST).
 * Window 1: 12:00 AM – 09:59 AM IST
 * Window 2: 02:00 PM – 04:59 PM IST
 * Pause:    10:00 AM – 01:59 PM IST  and  05:00 PM – 11:59 PM IST
 *
 * RSS / Telegram signals are NOT subject to this check — they run 24 h.
 * Open-position exits are always allowed regardless of this flag.
 */
export function isBotScannerTradingHours(): boolean {
  const istHour = new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(istHour, 10);
  return (hour >= 0 && hour < 10) || (hour >= 14 && hour < 17);
}

/** Format a Date as IST string (UTC+5:30) */
export function toIST(date: Date | number | string): string {
  const d = new Date(date);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " IST";
}

export async function sendTelegram(message: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: message,
        parse_mode: "HTML",
      },
      { timeout: 8000 },
    );
  } catch (err) {
    logger.warn({ err }, "Telegram notification failed");
  }
}

// ─── Command polling ──────────────────────────────────────────────────────────

type CommandHandler = (command: string) => Promise<string>;

let lastUpdateId = 0;
let commandHandler: CommandHandler | null = null;

// Singleton guards — prevent double-start if called twice in the same process
let pollingStarted = false;
let heartbeatStarted = false;

export function registerCommandHandler(fn: CommandHandler): void {
  commandHandler = fn;
}

async function pollUpdates(): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`,
      {
        params: { offset: lastUpdateId + 1, timeout: 20, limit: 10 },
        timeout: 30_000,
      },
    );

    const updates = res.data?.result ?? [];
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const text: string = update.message?.text ?? "";
      const fromChatId: string = String(update.message?.chat?.id ?? "");

      if (!text || !commandHandler) continue;

      // Only respond to configured chat
      if (CHAT_ID && fromChatId !== CHAT_ID) {
        logger.warn({ fromChatId }, "Telegram: command from unknown chat ignored");
        continue;
      }

      const command = text.trim().split(" ")[0]?.toLowerCase() ?? "";
      if (!command.startsWith("/")) continue;

      logger.info({ command, fromChatId }, "Telegram: command received");

      try {
        const reply = await commandHandler(command);
        await sendTelegram(reply);
      } catch (err) {
        logger.warn({ err, command }, "Telegram: command handler error");
        await sendTelegram(`❌ Error processing command: ${command}`);
      }
    }
  } catch (err) {
    logger.debug({ err }, "Telegram: poll error (will retry)");
  }
}

/**
 * Drain any updates that were queued before this process started.
 * Sets lastUpdateId to the latest update_id WITHOUT processing those messages,
 * so only new commands sent AFTER this restart are handled.
 */
async function drainPendingUpdates(): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    // offset: -1 fetches only the single most-recent update (non-blocking)
    const res = await axios.get(
      `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`,
      { params: { offset: -1, timeout: 0, limit: 1 }, timeout: 10_000 },
    );
    const updates: Array<{ update_id: number }> = res.data?.result ?? [];
    if (updates.length > 0) {
      lastUpdateId = updates[updates.length - 1]!.update_id;
      logger.info({ lastUpdateId }, "Telegram: drained pending updates — skipping stale commands");
    }
  } catch (err) {
    logger.debug({ err }, "Telegram: drain skipped (will process from offset 0)");
  }
}

export function startCommandPolling(): void {
  if (!isTelegramConfigured()) {
    logger.info("Telegram command polling skipped — not configured");
    return;
  }

  if (POLLING_DISABLED) {
    logger.info("Telegram command polling skipped — TELEGRAM_POLLING_DISABLED=true");
    return;
  }

  // Singleton guard: only one polling loop per process
  if (pollingStarted) {
    logger.warn("Telegram command polling already running — skipping duplicate start");
    return;
  }
  pollingStarted = true;

  logger.info("Telegram command polling started");

  const poll = async () => {
    await pollUpdates();
    setTimeout(poll, 2_000);
  };

  // Drain stale messages first, then start polling for new ones
  drainPendingUpdates().then(() => {
    setTimeout(poll, 3_000);
  }).catch(() => {
    setTimeout(poll, 3_000);
  });
}

export function startHeartbeat(sendFn: () => void, intervalMs = 60 * 60 * 1_000): void {
  if (!isTelegramConfigured()) {
    logger.info("Heartbeat skipped — Telegram not configured");
    return;
  }

  // Singleton guard: only one heartbeat per process
  if (heartbeatStarted) {
    logger.warn("Telegram heartbeat already running — skipping duplicate start");
    return;
  }
  heartbeatStarted = true;

  logger.info({ intervalMs }, "Telegram heartbeat started");
  sendFn();
  setInterval(sendFn, intervalMs);
}
