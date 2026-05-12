import axios from "axios";
import { logger } from "./logger.js";

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const CHAT_ID = process.env["TELEGRAM_CHAT_ID"];

export function isTelegramConfigured(): boolean {
  return Boolean(BOT_TOKEN && CHAT_ID);
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

export function startCommandPolling(): void {
  if (!isTelegramConfigured()) {
    logger.info("Telegram command polling skipped — not configured");
    return;
  }

  logger.info("Telegram command polling started");

  const poll = async () => {
    await pollUpdates();
    setTimeout(poll, 2_000);
  };

  setTimeout(poll, 3_000);
}
