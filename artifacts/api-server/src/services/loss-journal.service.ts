import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import type { Position } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "data");
const JOURNAL_FILE = path.join(DATA_DIR, "loss_journal.json");

// ─── Types ────────────────────────────────────────────────────────────────────

export type LossTag =
  | "rug_speed"          // closed in < 5 min — instant rug
  | "fast_rug"           // closed in 5–15 min
  | "slow_dump"          // held 15–60 min before dying
  | "borderline_score"   // AI score was 72–77 (barely passed)
  | "borderline_conf"    // confidence 65–72 (barely passed)
  | "thin_liquidity"     // entry liquidity $20K–$35K (close to min)
  | "micro_cap"          // entry mcap < $100K (tiny, high-risk)
  | "large_cap"          // entry mcap > $5M (likely already pumped)
  | "high_fdv_risk"      // tpPercent ≥ 50 but still lost (distribution)
  | "no_ai_recovery"     // held too long with no price recovery
  | "fake_price"         // manually marked as loss (note present)
  | "quick_tp"           // TP hit in < 30 min — fast win
  | "strong_win"         // win > 15% gain
  | "high_score_win"     // AI score ≥ 80 and won — good signal
  | "good_liquidity_win" // liquidity > $50K and won
  | "momentum_win"       // buy ratio high and won
  ;

export interface LossJournalEntry {
  positionId: string;
  symbol: string;
  contractAddress: string;
  openedAt: string;
  closedAt: string;
  holdTimeMs: number;
  pnlSol: number;
  pnlPercent: number;
  aiScore: number;
  confidence: number;
  entryMcapUsd: number;
  entryLiquidityUsd: number;
  slPercent: number;
  tpPercent: number;
  tags: LossTag[];
  warnings: string[];   // human-readable signals
  recordedAt: number;   // unix ms when journal entry was created
  note?: string;
  isWin: boolean;
}

export interface FilterSuggestion {
  filter: string;
  currentValue: string | number;
  suggestedValue: string | number;
  reason: string;
  priority: "high" | "medium" | "low";
  confidence: number;
}

export interface LossInsights {
  totalLosses: number;
  totalWins: number;
  totalTrades: number;
  totalLossSol: number;
  totalWinSol: number;
  avgLossSol: number;
  avgWinSol: number;
  avgHoldMinutes: number;
  avgWinHoldMinutes: number;
  avgLossHoldMinutes: number;

  tagFrequency: Record<string, number>;
  tagPercentage: Record<string, number>;

  avgAiScore: number;
  avgConfidence: number;
  borderlineScoreCount: number;
  borderlineConfCount: number;

  instantRugs: number;
  fastRugs: number;
  slowDumps: number;
  longLosses: number;

  suggestions: FilterSuggestion[];
  recentLosses: LossJournalEntry[];
  recentWins: LossJournalEntry[];
  allEntries: LossJournalEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJournal(): LossJournalEntry[] {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return [];
    return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")) as LossJournalEntry[];
  } catch {
    return [];
  }
}

function writeJournal(entries: LossJournalEntry[]) {
  try {
    ensureDataDir();
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    logger.error({ err }, "Trade journal: failed to write");
  }
}

// ─── Tag derivation ─────────────────────────────────────────────────────────

function deriveTags(pos: Position, holdMs: number, isWin: boolean): { tags: LossTag[]; warnings: string[] } {
  const tags: LossTag[] = [];
  const warnings: string[] = [];
  const holdMin = holdMs / 60_000;

  if (isWin) {
    // Win-specific tags
    if (holdMin < 30) {
      tags.push("quick_tp");
      warnings.push(`Fast TP hit in ${holdMin.toFixed(1)}m — strong early momentum`);
    }
    if ((pos.pnlPercent ?? 0) >= 15) {
      tags.push("strong_win");
      warnings.push(`Strong gain of +${(pos.pnlPercent ?? 0).toFixed(1)}% — excellent risk/reward`);
    }
    if (pos.aiScore >= 80) {
      tags.push("high_score_win");
      warnings.push(`AI score was ${pos.aiScore} — high-conviction entry paid off`);
    }
    if (pos.entryLiquidityUsd > 50_000) {
      tags.push("good_liquidity_win");
      warnings.push(`Entry liquidity was $${Math.round(pos.entryLiquidityUsd / 1000)}K — deep pool allowed clean exit`);
    }
  } else {
    // Loss-specific hold-time buckets
    if (holdMin < 5) {
      tags.push("rug_speed");
      warnings.push(`Closed in only ${holdMin.toFixed(1)}m — instant rug despite all filters passing`);
    } else if (holdMin < 15) {
      tags.push("fast_rug");
      warnings.push(`Closed in ${holdMin.toFixed(1)}m — fast dump, likely late entry`);
    } else if (holdMin < 60) {
      tags.push("slow_dump");
      warnings.push(`Held ${holdMin.toFixed(1)}m — slow distribution by insiders`);
    } else {
      tags.push("no_ai_recovery");
      warnings.push(`Held ${holdMin.toFixed(1)}m — token stalled and drained slowly`);
    }

    // Borderline AI score (72–77)
    if (pos.aiScore >= 72 && pos.aiScore <= 77) {
      tags.push("borderline_score");
      warnings.push(`AI score was ${pos.aiScore} — only ${pos.aiScore - 72}pts above the 72 minimum. Low-conviction entry.`);
    }

    // Borderline confidence (65–72)
    if (pos.confidence >= 65 && pos.confidence <= 72) {
      tags.push("borderline_conf");
      warnings.push(`Confidence was ${pos.confidence}% — barely above the 65% floor. Unreliable data signal.`);
    }

    // Thin liquidity at entry
    if (pos.entryLiquidityUsd > 0 && pos.entryLiquidityUsd <= 35_000) {
      tags.push("thin_liquidity");
      warnings.push(`Entry liquidity was $${Math.round(pos.entryLiquidityUsd / 1000)}K — thin pool makes exit expensive and rug risk higher`);
    }

    // Micro cap (< $100K entry mcap)
    if (pos.entryMarketCap > 0 && pos.entryMarketCap < 100_000) {
      tags.push("micro_cap");
      warnings.push(`Entry mcap was $${Math.round(pos.entryMarketCap / 1000)}K — micro-cap is higher risk for rug`);
    }

    // Large cap (> $5M entry mcap)
    if (pos.entryMarketCap > 5_000_000) {
      tags.push("large_cap");
      warnings.push(`Entry mcap was $${(pos.entryMarketCap / 1_000_000).toFixed(1)}M — may have been already distributed`);
    }

    // High FDV ratio risk
    if (pos.tpPercent >= 50) {
      tags.push("high_fdv_risk");
      warnings.push(`TP was +${pos.tpPercent}% but trade still lost — wide TP on a risky token is a bad combo`);
    }

    // Manually corrected note
    if (pos.note) {
      tags.push("fake_price");
      warnings.push(`Manually marked: "${pos.note}"`);
    }
  }

  return { tags, warnings };
}

// ─── Suggestions engine ──────────────────────────────────────────────────────

function buildSuggestions(losses: LossJournalEntry[], wins: LossJournalEntry[]): FilterSuggestion[] {
  if (losses.length < 3) return [];

  const n = losses.length;
  const suggestions: FilterSuggestion[] = [];

  const lossPct = (tag: LossTag) => (losses.filter(e => e.tags.includes(tag)).length / n) * 100;

  // Win patterns — what works
  const winHighScore = wins.length > 0
    ? wins.filter(e => e.tags.includes("high_score_win")).length / wins.length * 100
    : 0;
  const winGoodLiq = wins.length > 0
    ? wins.filter(e => e.tags.includes("good_liquidity_win")).length / wins.length * 100
    : 0;

  // Borderline score in >35% of losses & wins lean toward high scores → raise minAiScore
  const borderlineScorePct = lossPct("borderline_score");
  if (borderlineScorePct >= 35) {
    const suggestedVal = winHighScore >= 50 ? 80 : 76;
    suggestions.push({
      filter: "minAiScore",
      currentValue: 72,
      suggestedValue: suggestedVal,
      reason: `${borderlineScorePct.toFixed(0)}% of losses had AI score 72–77${winHighScore >= 50 ? ` while ${winHighScore.toFixed(0)}% of wins had score ≥80` : ""}. Raise to ${suggestedVal} to cut borderline entries.`,
      priority: borderlineScorePct >= 50 ? "high" : "medium",
      confidence: Math.min(95, 50 + borderlineScorePct),
    });
  }

  // Borderline confidence in >35% of losses → raise minConfidence
  const borderlineConfPct = lossPct("borderline_conf");
  if (borderlineConfPct >= 35) {
    suggestions.push({
      filter: "minConfidence",
      currentValue: 65,
      suggestedValue: 72,
      reason: `${borderlineConfPct.toFixed(0)}% of losses had confidence 65–72. Raising to 72 rejects low-quality data entries.`,
      priority: borderlineConfPct >= 50 ? "high" : "medium",
      confidence: Math.min(95, 50 + borderlineConfPct),
    });
  }

  // Thin liquidity in >40% of losses → raise minLiquidity
  const thinLiqPct = lossPct("thin_liquidity");
  if (thinLiqPct >= 40) {
    const suggestedVal = winGoodLiq >= 50 ? 50_000 : 35_000;
    suggestions.push({
      filter: "minLiquidityUsd",
      currentValue: 20_000,
      suggestedValue: suggestedVal,
      reason: `${thinLiqPct.toFixed(0)}% of losses had entry liquidity $20K–$35K${winGoodLiq >= 50 ? ` while ${winGoodLiq.toFixed(0)}% of wins had liquidity >$50K` : ""}. Thin pools drain fast.`,
      priority: thinLiqPct >= 55 ? "high" : "medium",
      confidence: Math.min(95, 45 + thinLiqPct),
    });
  }

  // Instant rugs in >30% of losses → raise minPairAge
  const rugSpeedPct = lossPct("rug_speed");
  if (rugSpeedPct >= 30) {
    suggestions.push({
      filter: "minPairAgeMinutes",
      currentValue: 15,
      suggestedValue: 25,
      reason: `${rugSpeedPct.toFixed(0)}% of losses closed in <5m (instant rug). Raising to 25m gives more time for rugs to expose themselves first.`,
      priority: "high",
      confidence: Math.min(90, 40 + rugSpeedPct),
    });
  }

  // Fast rugs (5–15m) also common
  const fastRugPct = lossPct("fast_rug");
  if (fastRugPct >= 40 && !suggestions.find(s => s.filter === "minPairAgeMinutes")) {
    suggestions.push({
      filter: "minPairAgeMinutes",
      currentValue: 15,
      suggestedValue: 20,
      reason: `${fastRugPct.toFixed(0)}% of losses happened within 15 minutes. Waiting for 20m survival reduces early rug exposure.`,
      priority: "medium",
      confidence: Math.min(85, 35 + fastRugPct),
    });
  }

  // Large-cap losses
  const largeCapPct = lossPct("large_cap");
  if (largeCapPct >= 35) {
    suggestions.push({
      filter: "maxMcapUsd",
      currentValue: 10_000_000,
      suggestedValue: 5_000_000,
      reason: `${largeCapPct.toFixed(0)}% of losses had entry mcap >$5M — likely already distributed to retail. Cap at $5M.`,
      priority: "medium",
      confidence: Math.min(85, 40 + largeCapPct),
    });
  }

  // Micro-cap losses
  const microCapPct = lossPct("micro_cap");
  if (microCapPct >= 35) {
    suggestions.push({
      filter: "minMcapUsd",
      currentValue: 50_000,
      suggestedValue: 100_000,
      reason: `${microCapPct.toFixed(0)}% of losses had entry mcap <$100K. Micro-cap tokens are most rug-prone. Raise floor to $100K.`,
      priority: "medium",
      confidence: Math.min(85, 40 + microCapPct),
    });
  }

  // Fake prices
  const fakePricePct = lossPct("fake_price");
  if (fakePricePct >= 20) {
    suggestions.push({
      filter: "TP Liquidity Guard",
      currentValue: "$5K",
      suggestedValue: "$10K",
      reason: `${fakePricePct.toFixed(0)}% of losses involved fake DexScreener prices. Raise TP liquidity floor to $10K for extra protection.`,
      priority: "high",
      confidence: Math.min(90, 50 + fakePricePct),
    });
  }

  suggestions.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    if (order[a.priority] !== order[b.priority]) return order[a.priority] - order[b.priority];
    return b.confidence - a.confidence;
  });

  return suggestions;
}

// ─── Service ──────────────────────────────────────────────────────────────────

class LossJournalService {
  private entries: LossJournalEntry[] = [];

  constructor() {
    this.entries = readJournal();
    // Backfill isWin for old entries that may not have it
    for (const e of this.entries) {
      if (e.isWin === undefined) {
        (e as any).isWin = (e.pnlSol ?? 0) >= 0;
      }
    }
    logger.info({ count: this.entries.length }, "Loss journal loaded");
  }

  record(pos: Position): void {
    if (!pos.closedAt) return;
    // Avoid duplicates
    if (this.entries.some(e => e.positionId === pos.positionId)) return;

    const isWin = (pos.pnlSol ?? 0) >= 0;
    const holdMs = pos.holdTimeMs ?? (new Date(pos.closedAt).getTime() - new Date(pos.openedAt).getTime());
    const { tags, warnings } = deriveTags(pos, holdMs, isWin);

    const entry: LossJournalEntry = {
      positionId: pos.positionId,
      symbol: pos.symbol,
      contractAddress: pos.contractAddress,
      openedAt: pos.openedAt,
      closedAt: pos.closedAt,
      holdTimeMs: holdMs,
      pnlSol: pos.pnlSol ?? 0,
      pnlPercent: pos.pnlPercent ?? 0,
      aiScore: pos.aiScore,
      confidence: pos.confidence,
      entryMcapUsd: pos.entryMarketCap,
      entryLiquidityUsd: pos.entryLiquidityUsd,
      slPercent: pos.slPercent,
      tpPercent: pos.tpPercent,
      tags,
      warnings,
      recordedAt: Date.now(),
      note: pos.note,
      isWin,
    };

    this.entries.unshift(entry);
    writeJournal(this.entries);

    logger.info(
      { symbol: pos.symbol, pnlSol: pos.pnlSol, isWin, tags },
      "Trade journal: entry recorded",
    );
  }

  reRecord(pos: Position): void {
    this.entries = this.entries.filter(e => e.positionId !== pos.positionId);
    writeJournal(this.entries);
    this.record(pos);
  }

  deleteEntry(positionId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.positionId !== positionId);
    if (this.entries.length < before) {
      writeJournal(this.entries);
      return true;
    }
    return false;
  }

  clear(): void {
    this.entries = [];
    writeJournal([]);
    logger.info("Trade journal cleared");
  }

  getEntries(): LossJournalEntry[] {
    return [...this.entries];
  }

  getInsights(): LossInsights {
    const all = this.entries;
    const losses = all.filter(e => !e.isWin);
    const wins = all.filter(e => e.isWin);

    const nAll = all.length;
    const nLoss = losses.length;
    const nWin = wins.length;

    if (nAll === 0) {
      return {
        totalLosses: 0, totalWins: 0, totalTrades: 0,
        totalLossSol: 0, totalWinSol: 0,
        avgLossSol: 0, avgWinSol: 0,
        avgHoldMinutes: 0, avgWinHoldMinutes: 0, avgLossHoldMinutes: 0,
        tagFrequency: {}, tagPercentage: {},
        avgAiScore: 0, avgConfidence: 0,
        borderlineScoreCount: 0, borderlineConfCount: 0,
        instantRugs: 0, fastRugs: 0, slowDumps: 0, longLosses: 0,
        suggestions: [],
        recentLosses: [], recentWins: [], allEntries: [],
      };
    }

    const totalLossSol = losses.reduce((s, e) => s + e.pnlSol, 0);
    const totalWinSol = wins.reduce((s, e) => s + e.pnlSol, 0);

    const avgHoldMinutes = all.reduce((s, e) => s + e.holdTimeMs, 0) / nAll / 60_000;
    const avgWinHoldMinutes = nWin > 0 ? wins.reduce((s, e) => s + e.holdTimeMs, 0) / nWin / 60_000 : 0;
    const avgLossHoldMinutes = nLoss > 0 ? losses.reduce((s, e) => s + e.holdTimeMs, 0) / nLoss / 60_000 : 0;

    // Tag frequency across ALL entries
    const tagFrequency: Record<string, number> = {};
    for (const entry of all) {
      for (const tag of entry.tags) {
        tagFrequency[tag] = (tagFrequency[tag] ?? 0) + 1;
      }
    }
    const tagPercentage: Record<string, number> = {};
    for (const [tag, count] of Object.entries(tagFrequency)) {
      tagPercentage[tag] = Math.round((count / nAll) * 100);
    }

    const avgAiScore = all.reduce((s, e) => s + e.aiScore, 0) / nAll;
    const avgConfidence = all.reduce((s, e) => s + e.confidence, 0) / nAll;
    const borderlineScoreCount = losses.filter(e => e.tags.includes("borderline_score")).length;
    const borderlineConfCount = losses.filter(e => e.tags.includes("borderline_conf")).length;

    const instantRugs = losses.filter(e => e.holdTimeMs < 5 * 60_000).length;
    const fastRugs = losses.filter(e => e.holdTimeMs >= 5 * 60_000 && e.holdTimeMs < 15 * 60_000).length;
    const slowDumps = losses.filter(e => e.holdTimeMs >= 15 * 60_000 && e.holdTimeMs < 60 * 60_000).length;
    const longLosses = losses.filter(e => e.holdTimeMs >= 60 * 60_000).length;

    const suggestions = buildSuggestions(losses, wins);

    return {
      totalLosses: nLoss,
      totalWins: nWin,
      totalTrades: nAll,
      totalLossSol,
      totalWinSol,
      avgLossSol: nLoss > 0 ? totalLossSol / nLoss : 0,
      avgWinSol: nWin > 0 ? totalWinSol / nWin : 0,
      avgHoldMinutes,
      avgWinHoldMinutes,
      avgLossHoldMinutes,
      tagFrequency,
      tagPercentage,
      avgAiScore,
      avgConfidence,
      borderlineScoreCount,
      borderlineConfCount,
      instantRugs,
      fastRugs,
      slowDumps,
      longLosses,
      suggestions,
      recentLosses: losses.slice(0, 20),
      recentWins: wins.slice(0, 20),
      allEntries: all.slice(0, 40),
    };
  }
}

export const lossJournalService = new LossJournalService();
