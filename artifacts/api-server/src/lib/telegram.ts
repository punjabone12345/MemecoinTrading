import axios from 'axios';
import { logger } from './logger.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function toIST(date: Date): string {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function sendMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.warn({ err }, 'Telegram send failed');
  }
}

export async function notifyBought(params: {
  name: string; symbol: string; price: number; mc: number; score: number; sizeSol: number;
}): Promise<void> {
  const { name, symbol, price, mc, score, sizeSol } = params;
  await sendMessage(
    `🟢 <b>BOUGHT ${symbol}</b> (${name})\n` +
    `Price: $${price.toFixed(8)}\n` +
    `MC: $${(mc / 1000).toFixed(0)}K\n` +
    `Score: ${score}/100\n` +
    `Size: ${sizeSol.toFixed(3)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyTPHit(params: {
  name: string; symbol: string; level: number; gainPct: number; profitSol: number; newSL: number;
}): Promise<void> {
  const { name, symbol, level, gainPct, profitSol, newSL } = params;
  await sendMessage(
    `🎯 <b>TP${level} HIT — ${symbol}</b> (${name})\n` +
    `Gain: +${gainPct.toFixed(1)}%\n` +
    `Profit: +${profitSol.toFixed(4)} SOL\n` +
    `New SL: ${newSL.toFixed(1)}% from entry\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyClosed(params: {
  name: string; symbol: string; pnlSol: number; pnlPct: number; reason: string;
}): Promise<void> {
  const { name, symbol, pnlSol, pnlPct, reason } = params;
  const emoji = pnlSol >= 0 ? '🟢' : '🔴';
  await sendMessage(
    `${emoji} <b>CLOSED ${symbol}</b> (${name})\n` +
    `PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n` +
    `Reason: ${reason}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyEmergencyExit(params: {
  name: string; symbol: string; reason: string; pnlSol: number;
}): Promise<void> {
  const { name, symbol, reason, pnlSol } = params;
  await sendMessage(
    `⚠️ <b>EMERGENCY EXIT — ${symbol}</b> (${name})\n` +
    `Reason: ${reason}\n` +
    `PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyDailySummary(params: {
  trades: number; winRate: number; pnlSol: number;
}): Promise<void> {
  const { trades, winRate, pnlSol } = params;
  await sendMessage(
    `📊 <b>Daily Summary</b>\n` +
    `Trades: ${trades}\n` +
    `Win Rate: ${winRate.toFixed(1)}%\n` +
    `PNL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyHeartbeat(params: {
  openPositions: number; balance: number;
}): Promise<void> {
  const { openPositions, balance } = params;
  await sendMessage(
    `💓 <b>Heartbeat</b>\n` +
    `Open Positions: ${openPositions}\n` +
    `Balance: ${balance.toFixed(3)} SOL\n` +
    `Time: ${toIST(new Date())}`
  );
}
