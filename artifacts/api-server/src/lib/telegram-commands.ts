import axios from 'axios';
import { logger } from './logger.js';
import { getOpenPositions, getAnalytics } from '../services/position.service.js';
import { getSettings, getBalance } from '../services/settings.service.js';
import { getScanStats } from '../services/scanner.service.js';
import type { Position } from '../types/index.js';

// ── Live price fetch for Telegram (mirrors price-monitor logic) ──────────────
function pairAddrFromDexUrl(dexUrl?: string): string | undefined {
  if (!dexUrl) return undefined;
  const m = dexUrl.match(/dexscreener\.com\/solana\/([A-Za-z0-9]{32,44})/);
  return m?.[1];
}

interface LivePrice { price: number; mc: number }

async function fetchLivePrices(positions: Position[]): Promise<Map<string, LivePrice>> {
  const result = new Map<string, LivePrice>();
  if (positions.length === 0) return result;

  // Prefer pair-address lookup (fastest, single-pool, real-time)
  const withPair: { id: string; addr: string }[] = [];
  const mintOnly: { id: string; mint: string }[] = [];
  for (const p of positions) {
    const addr = pairAddrFromDexUrl(p.dexUrl);
    if (addr) withPair.push({ id: p.id, addr });
    else mintOnly.push({ id: p.id, mint: p.mint });
  }

  try {
    if (withPair.length > 0) {
      const addrs = withPair.map((w) => w.addr).join(',');
      const res = await axios.get<{ pairs?: Array<{ pairAddress?: string; priceUsd?: string; marketCap?: number; fdv?: number }> }>(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${addrs}`,
        { timeout: 6000 }
      );
      const pairMap = new Map((res.data?.pairs ?? []).map((p) => [p.pairAddress, p]));
      for (const { id, addr } of withPair) {
        const pair = pairMap.get(addr);
        if (!pair) continue;
        const price = parseFloat(pair.priceUsd ?? '0');
        if (price > 0) result.set(id, { price, mc: pair.marketCap ?? pair.fdv ?? 0 });
      }
    }

    if (mintOnly.length > 0) {
      const mints = mintOnly.map((m) => m.mint).join(',');
      const res = await axios.get<{ pairs?: Array<{ baseToken?: { address: string }; priceUsd?: string; marketCap?: number; fdv?: number; txns?: { h1?: { buys: number; sells: number } } }> }>(
        `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
        { timeout: 6000 }
      );
      const mintMap = new Map<string, { price: number; mc: number; activity: number }>();
      for (const pair of res.data?.pairs ?? []) {
        const mint = pair.baseToken?.address;
        if (!mint) continue;
        const price = parseFloat(pair.priceUsd ?? '0');
        if (price <= 0) continue;
        const h1 = pair.txns?.h1 ?? { buys: 0, sells: 0 };
        const activity = h1.buys + h1.sells;
        const prev = mintMap.get(mint);
        if (!prev || activity > prev.activity) {
          mintMap.set(mint, { price, mc: pair.marketCap ?? pair.fdv ?? 0, activity });
        }
      }
      for (const { id, mint } of mintOnly) {
        const data = mintMap.get(mint);
        if (data) result.set(id, { price: data.price, mc: data.mc });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Telegram: live price fetch failed');
  }

  return result;
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_URL = () => `https://api.telegram.org/bot${BOT_TOKEN}`;

let updateOffset = 0;
let pollTimeout: ReturnType<typeof setTimeout> | null = null;
const startedAt = Date.now();

function toIST(date: Date): string {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
}

async function sendReply(chatId: number | string, text: string): Promise<void> {
  try {
    await axios.post(`${BASE_URL()}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    logger.warn({ err }, 'Telegram command reply failed');
  }
}

// ── /command1 — Check your positions ────────────────────────────────────────
async function handlePositions(chatId: number | string): Promise<void> {
  const [positions, balance] = await Promise.all([getOpenPositions(), getBalance()]);

  if (positions.length === 0) {
    await sendReply(chatId,
      `📭 <b>No Open Positions</b>\n` +
      `Balance: ${balance.toFixed(3)} SOL\n` +
      `Time: ${toIST(new Date())}`
    );
    return;
  }

  // Fetch live prices from DexScreener — DB pnl_sol/pnl_pct are null for open positions
  const livePrices = await fetchLivePrices(positions);

  const lines: string[] = [
    `📊 <b>Open Positions (${positions.length})</b>`,
    `Balance: ${balance.toFixed(3)} SOL\n`,
  ];

  for (const pos of positions) {
    const live = livePrices.get(pos.id);
    const currentPrice = live?.price ?? pos.entryPrice;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const pnlSol = pos.sizeSol * (pnlPct / 100);
    const currentMc = live?.mc ?? pos.entryMc;
    const pnlEmoji = pnlPct >= 0 ? '🟢' : '🔴';
    const priceTag = live ? '' : ' ⚠️no live price';
    const tpHits = [pos.tp1Hit && 'TP1', pos.tp2Hit && 'TP2', pos.tp3Hit && 'TP3']
      .filter(Boolean).join(' ') || '—';
    lines.push(
      `${pnlEmoji} <b>${pos.symbol}</b> (${pos.name})${priceTag}\n` +
      `  Entry: $${pos.entryPrice.toFixed(8)}\n` +
      `  Now:   $${currentPrice.toFixed(8)}  (MC: $${(currentMc / 1000).toFixed(0)}K)\n` +
      `  Size: ${pos.sizeSol.toFixed(3)} SOL\n` +
      `  PNL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% / ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL\n` +
      `  TPs hit: ${tpHits}  |  Mode: ${pos.mode.toUpperCase()}`
    );
  }

  lines.push(`\n🕐 ${toIST(new Date())}`);
  await sendReply(chatId, lines.join('\n'));
}

// ── /command2 — Analyse Auto Trader ─────────────────────────────────────────
async function handleAnalyse(chatId: number | string): Promise<void> {
  const [analytics, settings, stats] = await Promise.all([
    getAnalytics(),
    getSettings(),
    Promise.resolve(getScanStats()),
  ]);

  const profitFactorStr = isFinite(analytics.profitFactor)
    ? analytics.profitFactor.toFixed(2)
    : '∞';

  const text =
    `🤖 <b>Auto Trader Analysis</b>\n\n` +

    `<b>📈 Performance</b>\n` +
    `Trades: ${analytics.totalTrades}\n` +
    `Win Rate: ${analytics.winRate.toFixed(1)}%\n` +
    `Profit Factor: ${profitFactorStr}\n` +
    `Total PNL: ${analytics.totalPnlSol >= 0 ? '+' : ''}${analytics.totalPnlSol.toFixed(4)} SOL\n` +
    `Today PNL: ${analytics.dailyPnl >= 0 ? '+' : ''}${analytics.dailyPnl.toFixed(4)} SOL\n` +
    `Best Trade: +${analytics.bestTrade.toFixed(4)} SOL\n` +
    `Worst Trade: ${analytics.worstTrade.toFixed(4)} SOL\n` +
    `Avg Hold: ${analytics.avgHoldTimeMinutes.toFixed(0)} min\n` +
    `Max Drawdown: ${analytics.maxDrawdown.toFixed(1)}%\n\n` +

    `<b>🔍 Scanner</b>\n` +
    `Scanning: ${stats.scanning} tokens\n` +
    `Passed filters: ${stats.passed}\n` +
    `Eligible: ${stats.eligible}\n` +
    `Open positions: ${analytics.openPositionsCount} / ${settings.maxOpenPositions}\n\n` +

    `<b>⚙️ Key Settings</b>\n` +
    `MC range: $${(settings.minMc / 1000).toFixed(0)}K – $${(settings.maxMc / 1_000_000).toFixed(1)}M\n` +
    `Min score: ${settings.minEntryScore}/100\n` +
    `SL: ${settings.slPct}%  TP1/2/3: ${settings.tp1Pct}/${settings.tp2Pct}/${settings.tp3Pct}%\n` +
    `Daily loss limit: ${settings.maxDailyLossPct}%\n` +
    `Mode: ${settings.walletPublicKey ? 'LIVE' : 'PAPER'}\n\n` +

    `🕐 ${toIST(new Date())}`;

  await sendReply(chatId, text);
}

// ── /command3 — Check the bot working or not ────────────────────────────────
async function handleStatus(chatId: number | string): Promise<void> {
  const [positions, balance] = await Promise.all([
    getOpenPositions(),
    getBalance(),
  ]);
  const stats = getScanStats();

  const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
  const uptimeStr = uptimeSec < 60
    ? `${uptimeSec}s`
    : uptimeSec < 3600
    ? `${Math.floor(uptimeSec / 60)}m ${uptimeSec % 60}s`
    : `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  const text =
    `✅ <b>Bot Status — ONLINE</b>\n\n` +
    `Uptime: ${uptimeStr}\n` +
    `Scanner: 🟢 Active (${stats.scanning} tokens)\n` +
    `Price monitor: 🟢 Running (3s interval)\n` +
    `Open positions: ${positions.length}\n` +
    `Balance: ${balance.toFixed(3)} SOL\n` +
    `Daily loss limit: ${stats.dailyLossLimitHit ? '🔴 HIT' : '🟢 OK'}\n\n` +
    `🕐 ${toIST(new Date())}`;

  await sendReply(chatId, text);
}

// ── Update dispatcher ────────────────────────────────────────────────────────
interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
}

async function processUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const cmd = text.split(' ')[0].toLowerCase();

  // Security: only respond to the configured chat
  if (CHAT_ID && String(chatId) !== String(CHAT_ID)) {
    logger.warn({ chatId }, 'Telegram command from unknown chat — ignored');
    return;
  }

  logger.info({ cmd, chatId }, 'Telegram command received');

  try {
    if (cmd === '/command1' || cmd === '/positions') {
      await handlePositions(chatId);
    } else if (cmd === '/command2' || cmd === '/analyse' || cmd === '/analyze') {
      await handleAnalyse(chatId);
    } else if (cmd === '/command3' || cmd === '/status') {
      await handleStatus(chatId);
    } else if (cmd === '/start' || cmd === '/help') {
      await sendReply(chatId,
        `👋 <b>Apex Meme Trader Bot</b>\n\n` +
        `/command1 — Check your positions\n` +
        `/command2 — Analyse Auto Trader\n` +
        `/command3 — Check the bot working or not`
      );
    }
  } catch (err) {
    logger.warn({ err, cmd }, 'Telegram command handler error');
    await sendReply(chatId, '⚠️ Error processing command. The bot is still running.');
  }
}

// ── Long-poll loop ───────────────────────────────────────────────────────────
async function pollOnce(): Promise<void> {
  try {
    const res = await axios.get<{ ok: boolean; result: TelegramUpdate[] }>(
      `${BASE_URL()}/getUpdates`,
      {
        params: { offset: updateOffset, timeout: 25, allowed_updates: ['message'] },
        timeout: 30_000,
      }
    );

    if (res.data.ok) {
      for (const update of res.data.result) {
        await processUpdate(update);
        updateOffset = update.update_id + 1;
      }
    }
  } catch (err) {
    const axErr = err as { code?: string; response?: { status?: number } };
    if (axErr.code !== 'ECONNABORTED' && axErr.response?.status !== 409) {
      logger.warn({ err }, 'Telegram poll error');
    }
  }
}

async function pollLoop(): Promise<void> {
  await pollOnce();
  pollTimeout = setTimeout(() => { void pollLoop(); }, 100);
}

export function startTelegramCommands(): void {
  if (!BOT_TOKEN) {
    logger.info('TELEGRAM_BOT_TOKEN not set — command polling disabled');
    return;
  }

  // Drop any pending updates that accumulated while the bot was offline
  // by fetching with offset=-1 and a zero timeout on startup.
  axios.get(`${BASE_URL()}/getUpdates`, {
    params: { offset: -1, timeout: 0 },
    timeout: 5_000,
  }).then((res: { data: { result?: TelegramUpdate[] } }) => {
    const updates = res.data?.result ?? [];
    if (updates.length > 0) {
      updateOffset = updates[updates.length - 1].update_id + 1;
    }
    void pollLoop();
  }).catch(() => { void pollLoop(); });

  logger.info('Telegram command polling started (/command1 /command2 /command3)');
}

export function stopTelegramCommands(): void {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
}
