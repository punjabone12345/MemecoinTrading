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
  name: string; symbol: string; level: number; gainPct: number; profitSol: number; newSLPct: number;
  entryPrice: number; currentPrice: number; soldSol: number; remainingSol: number; initialSol: number;
  peakPrice: number;
}): Promise<void> {
  const { name, symbol, level, gainPct, profitSol, newSLPct, entryPrice, currentPrice, soldSol, remainingSol, initialSol, peakPrice } = params;
  // newSLPct == 0 → breakeven; newSLPct < 0 → trailing (|newSLPct|% below peak)
  let slLine: string;
  if (newSLPct === 0) {
    slLine = `New SL: $${entryPrice.toFixed(8)} (breakeven)`;
  } else {
    const trailPct = Math.abs(newSLPct);
    const trailPrice = peakPrice * (1 - trailPct / 100);
    slLine = `New SL: $${trailPrice.toFixed(8)} (${trailPct}% below peak $${peakPrice.toFixed(8)})`;
  }
  await sendMessage(
    `🎯 <b>TP${level} HIT — ${symbol}</b> (${name})\n` +
    `Gain: +${gainPct.toFixed(1)}%\n` +
    `Entry: $${entryPrice.toFixed(8)}  →  Now: $${currentPrice.toFixed(8)}\n` +
    `Sold: ${soldSol.toFixed(4)} SOL  (+${profitSol.toFixed(4)} SOL profit)\n` +
    `Remaining: ${remainingSol.toFixed(4)} SOL (of ${initialSol.toFixed(4)} SOL)\n` +
    `${slLine}\n` +
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

export async function notifyWhaleTrade(params: {
  name: string; symbol: string; mint: string;
  whaleAmountUsd: number; sizePct: number; sizeSol: number;
  entryPrice: number; whalePriceAtDetection: number; slippagePct: number;
  whaleWallet?: string;
}): Promise<void> {
  const { name, symbol, mint, whaleAmountUsd, sizePct, sizeSol, entryPrice, whalePriceAtDetection, slippagePct, whaleWallet } = params;
  const actualSlip = whalePriceAtDetection > 0
    ? ((entryPrice - whalePriceAtDetection) / whalePriceAtDetection * 100).toFixed(1)
    : '0.0';
  const walletLine = whaleWallet && whaleWallet !== 'unknown'
    ? `Whale Wallet: <code>${whaleWallet}</code>\n`
    : '';
  await sendMessage(
    `🐋 <b>WHALE ENTRY — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    walletLine +
    `Whale Buy: $${whaleAmountUsd.toFixed(0)}\n` +
    `Size: ${sizeSol.toFixed(3)} SOL (${sizePct.toFixed(2)}%)\n` +
    `Entry Price: $${entryPrice.toFixed(8)}\n` +
    `Whale Price: $${whalePriceAtDetection.toFixed(8)} (slip ${actualSlip}% of ${slippagePct}% max)\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyWhaleClose(params: {
  name: string; symbol: string; mint: string;
  pnlPct: number; pnlSol: number; reason: string;
  entryPrice: number; exitPrice: number; sizeSol: number;
}): Promise<void> {
  const { name, symbol, mint, pnlPct, pnlSol, reason, entryPrice, exitPrice, sizeSol } = params;
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  await sendMessage(
    `${emoji} <b>WHALE CLOSE — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `PNL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%  (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n` +
    `Entry: ${entryPrice.toFixed(8)}  →  Exit: ${exitPrice.toFixed(8)}\n` +
    `Size: ${sizeSol.toFixed(3)} SOL\n` +
    `Reason: ${reason}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifyWhaleSkip(params: {
  name: string; symbol: string; mint: string;
  whaleAmountUsd: number; reason: string;
  entryPrice?: number; whalePriceAtDetection?: number; maxSlippagePct?: number;
}): Promise<void> {
  const { name, symbol, mint, whaleAmountUsd, reason, entryPrice, whalePriceAtDetection, maxSlippagePct } = params;
  let extra = '';
  if (entryPrice && whalePriceAtDetection && maxSlippagePct) {
    const slip = ((entryPrice - whalePriceAtDetection) / whalePriceAtDetection * 100).toFixed(1);
    extra = `\nPrice Slip: ${slip}% (max ${maxSlippagePct}%)\nWhale Price: $${whalePriceAtDetection.toFixed(8)}\nCurrent: $${entryPrice.toFixed(8)}`;
  }
  await sendMessage(
    `⏭️ <b>WHALE SKIP — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `Whale Buy: $${whaleAmountUsd.toFixed(0)}\n` +
    `Skip Reason: ${reason}${extra}\n` +
    `Time: ${toIST(new Date())}`
  );
}
