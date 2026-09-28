import axios from 'axios';
import { logger } from './logger.js';
import { getSettings } from '../services/settings.service.js';

function toIST(date: Date): string {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function getTelegramCredentials(): Promise<{ token: string; chatId: string } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.CHAT_ID;
  if (token && chatId) return { token, chatId };

  try {
    const s = await getSettings();
    const dbToken = (s as any).telegramBotToken || (s as any).botToken;
    const dbChatId = (s as any).telegramChatId || (s as any).chatId;
    if (dbToken && dbChatId) return { token: dbToken, chatId: dbChatId };
  } catch {}
  return null;
}

async function sendMessage(text: string): Promise<void> {
  const creds = await getTelegramCredentials();
  if (!creds) {
    logger.debug('Telegram notification skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      chat_id: creds.chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (err: any) {
    logger.warn({ err: err?.response?.data || err?.message }, 'Telegram send failed');
  }
}

export function formatPrice(price: number): string {
  if (!price || isNaN(price) || price <= 0) return '0.00';
  if (price >= 1) return price.toFixed(4);
  if (price >= 0.01) return price.toFixed(6);
  if (price >= 0.0001) return price.toFixed(7);
  const str = price.toFixed(10);
  const trimmed = str.replace(/0+$/, '');
  return trimmed.length < 8 ? price.toFixed(8) : trimmed;
}

export async function notifyBought(params: {
  name: string; symbol: string; price: number; mc: number; score: number; sizeSol: number;
}): Promise<void> {
  const { name, symbol, price, mc, score, sizeSol } = params;
  const mcStr = mc > 0 ? `$${(mc / 1000).toFixed(0)}K` : '$0';
  await sendMessage(
    `🟢 <b>BOUGHT ${symbol}</b> (${name})\n` +
    `Price: $${formatPrice(price)}\n` +
    `MC: ${mcStr}\n` +
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
  let slLine: string;
  if (newSLPct === 0) {
    slLine = `New SL: $${formatPrice(entryPrice)} (breakeven)`;
  } else {
    const trailPct = Math.abs(newSLPct);
    const trailPrice = peakPrice * (1 - trailPct / 100);
    slLine = `New SL: $${formatPrice(trailPrice)} (${trailPct}% below peak $${formatPrice(peakPrice)})`;
  }
  await sendMessage(
    `🎯 <b>TP${level} HIT — ${symbol}</b> (${name})\n` +
    `Gain: +${gainPct.toFixed(1)}%\n` +
    `Entry: $${formatPrice(entryPrice)}  →  Now: $${formatPrice(currentPrice)}\n` +
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

export async function notifyDiscovered(params: {
  symbol: string; name?: string; mint: string; rugcheckOk: boolean;
}): Promise<void> {
  const { symbol, mint, rugcheckOk } = params;
  await sendMessage(
    `🔎 <b>NEW MIGRATED TOKEN</b>\n` +
    `Token: $${symbol}\n` +
    `CA: <code>${mint}</code>\n` +
    `RugCheck: ${rugcheckOk ? 'PASSED' : 'FAILED'}\n` +
    `Status: ${rugcheckOk ? 'TRACKING' : 'REJECTED'}`
  );
}

export async function notifyThresholdsReached(params: {
  symbol: string; mc: number; liquidity: number; elapsedMs: number; maxTrackingMs: number;
}): Promise<void> {
  const { symbol, mc, liquidity, elapsedMs, maxTrackingMs } = params;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const elapsedMin = Math.floor(elapsedSec / 60);
  const elapsedSecRem = elapsedSec % 60;
  const maxHours = Math.floor(maxTrackingMs / (3600 * 1000));
  const timeStr = `${String(elapsedMin).padStart(2, '0')}:${String(elapsedSecRem).padStart(2, '0')} / ${maxHours}:00:00`;

  await sendMessage(
    `🎯 <b>THRESHOLDS REACHED</b>\n` +
    `$${symbol}\n` +
    `MC: $${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `Liquidity: $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `10-minute sustain started\n` +
    `Tracking: ${timeStr}`
  );
}

export async function notifySustainReset(params: {
  symbol: string; reason: string; mc: number; liquidity: number;
}): Promise<void> {
  const { symbol, reason, mc, liquidity } = params;
  await sendMessage(
    `🔄 <b>SUSTAIN RESET</b>\n` +
    `$${symbol}\n` +
    `Reason: ${reason}\n` +
    `MC: $${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `Liquidity: $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  );
}

export async function notifySustainCompleted(params: {
  symbol: string; mc: number; liquidity: number;
}): Promise<void> {
  const { symbol, mc, liquidity } = params;
  await sendMessage(
    `✅ <b>SUSTAIN COMPLETED</b>\n` +
    `$${symbol}\n` +
    `MC: $${mc.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `Liquidity: $${liquidity.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `10-minute requirement satisfied\n` +
    `Trade eligibility: PASSED`
  );
}

export async function notifyTrackingExpired(params: {
  symbol: string;
}): Promise<void> {
  const { symbol } = params;
  await sendMessage(
    `⏰ <b>TRACKING EXPIRED</b>\n` +
    `$${symbol}\n` +
    `Reason: 2-hour tracking window exceeded\n` +
    `No trade executed.`
  );
}

export async function notifySniperTrade(params: {
  name: string; symbol: string; mint: string;
  sizeSol: number; entryPrice: number; entryMcap?: number; liquidity?: number;
  ema20Mcap?: number; slMcap?: number; slPrice?: number;
}): Promise<void> {
  const { name, symbol, mint, sizeSol, entryPrice, entryMcap = 0, liquidity = 0, ema20Mcap = 0, slMcap = 0, slPrice = 0 } = params;
  const mcStr = entryMcap > 0 ? `$${(entryMcap / 1000).toFixed(1)}k` : 'N/A';
  const liqStr = liquidity > 0 ? `$${(liquidity / 1000).toFixed(1)}k` : 'N/A';
  const emaStr = ema20Mcap > 0 ? `$${(ema20Mcap / 1000).toFixed(1)}k` : 'N/A';
  const slStr = slMcap > 0 ? `$${(slMcap / 1000).toFixed(1)}k` : slPrice > 0 ? `$${formatPrice(slPrice)}` : 'Recent 20m Low';

  await sendMessage(
    `🎯 <b>20 EMA RETRACE BUY — ${symbol}</b> (${name})\n` +
    `Strategy: 20 EMA Retrace (Pump Target +50% Hit)\n` +
    `CA: <code>${mint}</code>\n` +
    `Entry MC: ${mcStr}\n` +
    `20 EMA Level: ${emaStr}\n` +
    `Initial SL: ${slStr} (Recent 20m Low)\n` +
    `Liquidity: ${liqStr}\n` +
    `Position Size: ${sizeSol.toFixed(2)} SOL\n` +
    `Entry Price: $${formatPrice(entryPrice)}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperClose(params: {
  name: string; symbol: string; mint: string;
  pnlPct: number; pnlSol: number; reason: string;
  entryPrice: number; exitPrice: number; sizeSol: number;
}): Promise<void> {
  const { name, symbol, mint, pnlPct, pnlSol, reason, entryPrice, exitPrice, sizeSol } = params;
  const emoji = pnlPct >= 0 ? '🟢' : '🔴';
  await sendMessage(
    `${emoji} <b>POSITION CLOSED — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `PNL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n` +
    `Entry: $${formatPrice(entryPrice)} → Exit: $${formatPrice(exitPrice)}\n` +
    `Size: ${sizeSol.toFixed(3)} SOL\n` +
    `Reason: ${reason}\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperTP(params: {
  name: string; symbol: string; mint: string;
  tpNum: 1 | 2 | 3; gainPct: number;
  chunkSol: number; returnedSol: number;
  remainingSizeSol: number; initialSizeSol: number;
  newSLPrice: number; newSLDesc: string;
  entryPrice: number; currentPrice: number;
  totalBanked: number;
}): Promise<void> {
  const { name, symbol, mint, tpNum, gainPct, chunkSol, returnedSol,
          remainingSizeSol, initialSizeSol, newSLPrice, newSLDesc,
          entryPrice, currentPrice, totalBanked } = params;
  const profitSol = returnedSol - chunkSol;
  const pctRemaining = initialSizeSol > 0 ? ((remainingSizeSol / initialSizeSol) * 100).toFixed(0) : '?';
  const targetLabel = tpNum === 1 ? 'TP1 (+100%)' : tpNum === 2 ? 'TP2 (+250%)' : 'TP3 (+400%)';

  await sendMessage(
    `🚀 <b>20 EMA ${targetLabel} HIT — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `Gain: +${gainPct.toFixed(1)}% (Entry $${formatPrice(entryPrice)} → Current $${formatPrice(currentPrice)})\n` +
    `Sold Chunk: ${chunkSol.toFixed(4)} SOL → ${returnedSol.toFixed(4)} SOL (+${profitSol.toFixed(4)} profit)\n` +
    `Remaining: ${pctRemaining}% of position (${remainingSizeSol.toFixed(4)} SOL)\n` +
    `Total Banked: ${totalBanked.toFixed(4)} SOL\n` +
    `New SL: $${formatPrice(newSLPrice)} (${newSLDesc})\n` +
    `Time: ${toIST(new Date())}`
  );
}

export async function notifySniperSkip(params: {
  name: string; symbol: string; mint: string;
  buyAmountUsd: number; reason: string;
  entryPrice?: number; priceAtBuyDetection?: number; maxSlippagePct?: number;
}): Promise<void> {
  const { name, symbol, mint, buyAmountUsd, reason, entryPrice, priceAtBuyDetection, maxSlippagePct } = params;
  let extra = '';
  if (entryPrice && priceAtBuyDetection && maxSlippagePct) {
    const slip = ((entryPrice - priceAtBuyDetection) / priceAtBuyDetection * 100).toFixed(1);
    extra = `\nPrice Slip: ${slip}% (max ${maxSlippagePct}%)\nDetected Price: $${formatPrice(priceAtBuyDetection)}\nCurrent: $${formatPrice(entryPrice)}`;
  }
  await sendMessage(
    `⏭️ <b>WHALE SKIP — ${symbol}</b> (${name})\n` +
    `Mint: <code>${mint.slice(0, 16)}…</code>\n` +
    `Buyer Activity: $${buyAmountUsd.toFixed(0)}\n` +
    `Skip Reason: ${reason}${extra}\n` +
    `Time: ${toIST(new Date())}`
  );
}

// ── Altcoin Trading Bot Notifications ─────────────────────────────────────────

export async function notifyAltcoinTradeEntered(params: {
  symbol: string;
  name: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizeUsd: number;
  riskAmountUsd: number;
  aiScore: number;
  setupType: string;
  rrRatio: number;
  thesis: string[];
}): Promise<void> {
  const { symbol, name, side, entryPrice, stopLoss, takeProfit, positionSizeUsd, riskAmountUsd, aiScore, setupType, rrRatio, thesis } = params;
  const sideEmoji = side === 'LONG' ? '🟢 <b>LONG BUY</b>' : '🔴 <b>SHORT SELL</b>';
  const riskPct = ((Math.abs(entryPrice - stopLoss) / entryPrice) * 100).toFixed(1);
  const rewardPct = ((Math.abs(takeProfit - entryPrice) / entryPrice) * 100).toFixed(1);

  const thesisText = thesis.length > 0 ? `\n\n<b>Trade Thesis:</b>\n• ${thesis.slice(0, 3).join('\n• ')}` : '';

  await sendMessage(
    `${sideEmoji} — <b>$${symbol}</b> (${name})\n` +
    `<b>Setup:</b> ${setupType} | <b>AI Score:</b> ${aiScore}/100\n` +
    `<b>Entry:</b> $${formatPrice(entryPrice)}\n` +
    `<b>Stop Loss:</b> $${formatPrice(stopLoss)} (${riskPct}% risk)\n` +
    `<b>Take Profit:</b> $${formatPrice(takeProfit)} (+${rewardPct}% target)\n` +
    `<b>Risk:Reward:</b> 1:${rrRatio.toFixed(2)}\n` +
    `<b>Position Size:</b> $${positionSizeUsd.toFixed(2)} USD (1.0% Risk: $${riskAmountUsd.toFixed(2)})\n` +
    `<b>Time:</b> ${toIST(new Date())}${thesisText}`
  );
}

export async function notifyAltcoinTPHit(params: {
  symbol: string;
  name: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  closePrice: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  finalR: number;
  currentEquityUsd: number;
}): Promise<void> {
  const { symbol, name, side, entryPrice, closePrice, realizedPnlUsd, realizedPnlPct, finalR, currentEquityUsd } = params;
  await sendMessage(
    `🎯 <b>TAKE PROFIT HIT — $${symbol}</b> (${name})\n` +
    `<b>Side:</b> ${side}\n` +
    `<b>Entry:</b> $${formatPrice(entryPrice)} → <b>Exit:</b> $${formatPrice(closePrice)}\n` +
    `<b>Profit:</b> +$${realizedPnlUsd.toFixed(2)} USD (+${realizedPnlPct.toFixed(1)}% | +${finalR.toFixed(2)}R)\n` +
    `<b>Total Equity:</b> $${currentEquityUsd.toFixed(2)} USD\n` +
    `<b>Time:</b> ${toIST(new Date())}`
  );
}

export async function notifyAltcoinSLHit(params: {
  symbol: string;
  name: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  closePrice: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  currentEquityUsd: number;
}): Promise<void> {
  const { symbol, name, side, entryPrice, closePrice, realizedPnlUsd, realizedPnlPct, currentEquityUsd } = params;
  await sendMessage(
    `🛑 <b>STOP LOSS HIT — $${symbol}</b> (${name})\n` +
    `<b>Side:</b> ${side}\n` +
    `<b>Entry:</b> $${formatPrice(entryPrice)} → <b>Stopped:</b> $${formatPrice(closePrice)}\n` +
    `<b>Loss:</b> -$${Math.abs(realizedPnlUsd).toFixed(2)} USD (${realizedPnlPct.toFixed(1)}% | 1.0% Risk Protected)\n` +
    `<b>Total Equity:</b> $${currentEquityUsd.toFixed(2)} USD\n` +
    `<b>Time:</b> ${toIST(new Date())}`
  );
}

export async function notifyAltcoinTradeClosed(params: {
  symbol: string;
  name: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  closePrice: number;
  realizedPnlUsd: number;
  realizedPnlPct: number;
  reason: string;
  currentEquityUsd: number;
}): Promise<void> {
  const { symbol, name, side, entryPrice, closePrice, realizedPnlUsd, realizedPnlPct, reason, currentEquityUsd } = params;
  const emoji = realizedPnlUsd >= 0 ? '🟢' : '🔴';
  await sendMessage(
    `${emoji} <b>TRADE CLOSED — $${symbol}</b> (${name})\n` +
    `<b>Side:</b> ${side} | <b>Reason:</b> ${reason}\n` +
    `<b>Entry:</b> $${formatPrice(entryPrice)} → <b>Exit:</b> $${formatPrice(closePrice)}\n` +
    `<b>P&L:</b> ${realizedPnlUsd >= 0 ? '+' : ''}$${realizedPnlUsd.toFixed(2)} USD (${realizedPnlPct >= 0 ? '+' : ''}${realizedPnlPct.toFixed(1)}%)\n` +
    `<b>Total Equity:</b> $${currentEquityUsd.toFixed(2)} USD\n` +
    `<b>Time:</b> ${toIST(new Date())}`
  );
}

export async function testTelegramNotification(): Promise<{ success: boolean; error?: string }> {
  const creds = await getTelegramCredentials();
  if (!creds?.token || !creds?.chatId) {
    return { success: false, error: 'Telegram bot token or chat ID is missing. Set them in settings or environment variables.' };
  }
  try {
    const text = `🤖 <b>Altcoin Trading Bot: Telegram Alerts Activated!</b>\n` +
      `Platform: AI-Assisted Intraday Paper Trading & Scanner\n` +
      `Time: ${toIST(new Date())}\n` +
      `Real-time trade entries, take profits, stop losses, and exits will be broadcast here.`;
    await axios.post(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      chat_id: creds.chatId,
      text,
      parse_mode: 'HTML',
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.response?.data?.description || err?.message || 'Telegram API request failed' };
  }
}

