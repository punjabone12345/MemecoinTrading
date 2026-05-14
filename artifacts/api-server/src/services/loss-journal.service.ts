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
  | "rug_speed"        // closed in < 5 min — instant rug
  | "fast_rug"         // closed in 5–15 min
  | "slow_dump"        // held 15–60 min before dying
  | "borderline_score" // AI score was 72–77 (barely passed)
  | "borderline_conf"  // confidence 65–72 (barely passed)
  | "thin_liquidity"   // entry liquidity $20K–$35K (close to min)
  | "micro_cap"        // entry mcap < $100K (tiny, high-risk)
  | "large_cap"        // entry mcap > $5M (likely already pumped)
  | "high_fdv_risk"    // tpPercent ≥ 50 but still lost (distribution)
  | "no_ai_recovery"   // held too long with no price recovery
  | "fake_price"       // manually marked as loss (note present)
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
  warnings: string[];   // human-readable borderline signals
  recordedAt: number;   // unix ms when journal entry was created
  note?: string;
}

export interface LossInsights {
  totalLosses: number;
  totalLossSol: number;
  avgLossSol: number;
  avgHoldMinutes: number;

  // Tag frequency analysis
  tagFrequency: Record<string, number>;    // tag → count
  tagPercentage: Record<string, number>;   // tag → % of total losses

  // Score/confidence distribution
  avgAiScore: number;
  avgConfidence: number;
  borderlineScoreCount: number;  // score 72–77
  borderlineConfCount: number;   // confidence 65–72

  // Hold time buckets
  instantRugs: number;    // < 5m
  fastRugs: number;       // 5–15m
  slowDumps: number;      // 15–60m
  longLosses: number;     // > 60m

  // Suggestions generated from pattern analysis
  suggestions: FilterSuggestion[];

  // Recent losses (last 20)
  recentLosses: LossJournalEntry[];
}

export interface FilterSuggestion {
  filter: string;
  currentValue: string | number;
  suggestedValue: string | number;
  reason: string;
  priority: "high" | "medium" | "low";
  confidence: number;  // 0–100 — how confident the suggestion is
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
    logger.error({ err }, "Loss journal: failed to write");
  }
}

// ─── Tag derivation (learned from real losses) ─────────────────────────────────

function deriveTags(pos: Position, holdMs: number): { tags: LossTag[]; warnings: string[] } {
  const tags: LossTag[] = [];
  const warnings: string[] = [];

  // Hold-time buckets
  const holdMin = holdMs / 60_000;
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

  // Borderline AI score (72–77 = barely passed the 72 minimum)
  if (pos.aiScore >= 72 && pos.aiScore <= 77) {
    tags.push("borderline_score");
    warnings.push(`AI score was ${pos.aiScore} — only ${pos.aiScore - 72}pts above the 72 minimum. Low-conviction entry.`);
  }

  // Borderline confidence (65–72)
  if (pos.confidence >= 65 && pos.confidence <= 72) {
    tags.push("borderline_conf");
    warnings.push(`Confidence was ${pos.confidence}% — barely above the 65% floor. Unreliable data signal.`);
  }

  // Thin liquidity at entry ($20K–$35K = close to the $20K minimum)
  if (pos.entryLiquidityUsd > 0 && pos.entryLiquidityUsd <= 35_000) {
    tags.push("thin_liquidity");
    warnings.push(`Entry liquidity was $${Math.round(pos.entryLiquidityUsd / 1000)}K — thin pool makes exit expensive and rug risk higher`);
  }

  // Micro cap (< $100K entry mcap — very early = very risky)
  if (pos.entryMarketCap > 0 && pos.entryMarketCap < 100_000) {
    tags.push("micro_cap");
    warnings.push(`Entry mcap was $${Math.round(pos.entryMarketCap / 1000)}K — micro-cap is higher risk for rug`);
  }

  // Large cap (> $5M entry mcap — likely already pumped)
  if (pos.entryMarketCap > 5_000_000) {
    tags.push("large_cap");
    warnings.push(`Entry mcap was $${(pos.entryMarketCap / 1_000_000).toFixed(1)}M — may have been already distributed`);
  }

  // High FDV ratio risk flag (TP was wide but still lost — suggests distribution)
  if (pos.tpPercent >= 50) {
    tags.push("high_fdv_risk");
    warnings.push(`TP was +${pos.tpPercent}% but trade still lost — wide TP on a risky token is a bad combo`);
  }

  // Fake price (manually corrected note)
  if (pos.note) {
    tags.push("fake_price");
    warnings.push(`Manually marked: "${pos.note}"`);
  }

  return { tags, warnings };
}

// ─── Suggestions engine (patterns → filter recommendations) ─────────────────

function buildSuggestions(entries: LossJournalEntry[]): FilterSuggestion[] {
  if (entries.length < 3) return [];  // need at least 3 data points

  const n = entries.length;
  const suggestions: FilterSuggestion[] = [];

  const pct = (tag: LossTag) => (entries.filter(e => e.tags.includes(tag)).length / n) * 100;

  // Borderline score in >35% of losses → raise minAiScore
  const borderlineScorePct = pct("borderline_score");
  if (borderlineScorePct >= 35) {
    suggestions.push({
      filter: "minAiScore",
      currentValue: 72,
      suggestedValue: 76,
      reason: `${borderlineScorePct.toFixed(0)}% of losses had AI score 72–77 (barely above the minimum). Raising to 76 cuts these borderline entries.`,
      priority: borderlineScorePct >= 50 ? "high" : "medium",
      confidence: Math.min(95, 50 + borderlineScorePct),
    });
  }

  // Borderline confidence in >35% of losses → raise minConfidence
  const borderlineConfPct = pct("borderline_conf");
  if (borderlineConfPct >= 35) {
    suggestions.push({
      filter: "minConfidence",
      currentValue: 65,
      suggestedValue: 72,
      reason: `${borderlineConfPct.toFixed(0)}% of losses had confidence 65–72 (barely above the minimum). Raising to 72 rejects low-quality data entries.`,
      priority: borderlineConfPct >= 50 ? "high" : "medium",
      confidence: Math.min(95, 50 + borderlineConfPct),
    });
  }

  // Thin liquidity in >40% of losses → raise minLiquidity
  const thinLiqPct = pct("thin_liquidity");
  if (thinLiqPct >= 40) {
    suggestions.push({
      filter: "minLiquidityUsd",
      currentValue: 20_000,
      suggestedValue: 35_000,
      reason: `${thinLiqPct.toFixed(0)}% of losses had entry liquidity $20K–$35K. Thin pools drain fast. Raising to $35K cuts these entries.`,
      priority: thinLiqPct >= 55 ? "high" : "medium",
      confidence: Math.min(95, 45 + thinLiqPct),
    });
  }

  // Instant rugs (< 5m hold) in >30% of losses → raise minPairAge
  const rugSpeedPct = pct("rug_speed");
  if (rugSpeedPct >= 30) {
    suggestions.push({
      filter: "minPairAgeMinutes",
      currentValue: 15,
      suggestedValue: 25,
      reason: `${rugSpeedPct.toFixed(0)}% of losses closed in <5m (instant rug). Raising the minimum pair age to 25m gives more time for rugs to expose themselves first.`,
      priority: "high",
      confidence: Math.min(90, 40 + rugSpeedPct),
    });
  }

  // Fast rugs (5–15m) also common → increase pair age
  const fastRugPct = pct("fast_rug");
  if (fastRugPct >= 40 && !suggestions.find(s => s.filter === "minPairAgeMinutes")) {
    suggestions.push({
      filter: "minPairAgeMinutes",
      currentValue: 15,
      suggestedValue: 20,
      reason: `${fastRugPct.toFixed(0)}% of losses happened within the first 15 minutes. Waiting for 20m survival before entry reduces early rug exposure.`,
      priority: "medium",
      confidence: Math.min(85, 35 + fastRugPct),
    });
  }

  // Large-cap losses → lower maxMcap
  const largeCapPct = pct("large_cap");
  if (largeCapPct >= 35) {
    suggestions.push({
      filter: "maxMcapUsd",
      currentValue: 10_000_000,
      suggestedValue: 5_000_000,
      reason: `${largeCapPct.toFixed(0)}% of losses had entry mcap >$5M — tokens at this size often have already distributed to retail. Cap at $5M.`,
      priority: "medium",
      confidence: Math.min(85, 40 + largeCapPct),
    });
  }

  // Micro-cap losses → raise minMcap
  const microCapPct = pct("micro_cap");
  if (microCapPct >= 35) {
    suggestions.push({
      filter: "minMcapUsd",
      currentValue: 50_000,
      suggestedValue: 100_000,
      reason: `${microCapPct.toFixed(0)}% of losses had entry mcap <$100K. Micro-cap tokens are the most rug-prone. Raising floor to $100K adds safety.`,
      priority: "medium",
      confidence: Math.min(85, 40 + microCapPct),
    });
  }

  // Fake prices in >20% of losses → raise TP liquidity floor
  const fakePricePct = pct("fake_price");
  if (fakePricePct >= 20) {
    suggestions.push({
      filter: "TP Liquidity Guard",
      currentValue: "$5K",
      suggestedValue: "$10K",
      reason: `${fakePricePct.toFixed(0)}% of losses involved fake DexScreener prices. The TP liquidity floor should be raised to $10K for extra protection.`,
      priority: "high",
      confidence: Math.min(90, 50 + fakePricePct),
    });
  }

  // Sort: high priority first, then by confidence
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
    logger.info({ count: this.entries.length }, "Loss journal loaded");
  }

  record(pos: Position): void {
    // Only journal actual losses (stop_loss closes or manual-marked losses with negative PnL)
    if ((pos.pnlSol ?? 0) >= 0) return;
    if (!pos.closedAt) return;

    // Avoid duplicates
    if (this.entries.some(e => e.positionId === pos.positionId)) return;

    const holdMs = pos.holdTimeMs ?? (new Date(pos.closedAt).getTime() - new Date(pos.openedAt).getTime());
    const { tags, warnings } = deriveTags(pos, holdMs);

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
    };

    this.entries.unshift(entry);
    writeJournal(this.entries);

    logger.info(
      { symbol: pos.symbol, pnlSol: pos.pnlSol, tags },
      "Loss journal: entry recorded",
    );
  }

  // Manually re-record when a trade is edited (e.g. fake profit → real loss)
  reRecord(pos: Position): void {
    // Remove old entry if exists then re-record
    this.entries = this.entries.filter(e => e.positionId !== pos.positionId);
    writeJournal(this.entries);
    this.record(pos);
  }

  getEntries(): LossJournalEntry[] {
    return [...this.entries];
  }

  getInsights(): LossInsights {
    const entries = this.entries;
    const n = entries.length;

    if (n === 0) {
      return {
        totalLosses: 0,
        totalLossSol: 0,
        avgLossSol: 0,
        avgHoldMinutes: 0,
        tagFrequency: {},
        tagPercentage: {},
        avgAiScore: 0,
        avgConfidence: 0,
        borderlineScoreCount: 0,
        borderlineConfCount: 0,
        instantRugs: 0,
        fastRugs: 0,
        slowDumps: 0,
        longLosses: 0,
        suggestions: [],
        recentLosses: [],
      };
    }

    const totalLossSol = entries.reduce((s, e) => s + e.pnlSol, 0);
    const avgHoldMinutes = entries.reduce((s, e) => s + e.holdTimeMs, 0) / n / 60_000;

    // Tag frequency
    const tagFrequency: Record<string, number> = {};
    const tagPercentage: Record<string, number> = {};
    for (const entry of entries) {
      for (const tag of entry.tags) {
        tagFrequency[tag] = (tagFrequency[tag] ?? 0) + 1;
      }
    }
    for (const [tag, count] of Object.entries(tagFrequency)) {
      tagPercentage[tag] = Math.round((count / n) * 100);
    }

    const avgAiScore = entries.reduce((s, e) => s + e.aiScore, 0) / n;
    const avgConfidence = entries.reduce((s, e) => s + e.confidence, 0) / n;
    const borderlineScoreCount = entries.filter(e => e.tags.includes("borderline_score")).length;
    const borderlineConfCount = entries.filter(e => e.tags.includes("borderline_conf")).length;

    const instantRugs = entries.filter(e => e.holdTimeMs < 5 * 60_000).length;
    const fastRugs = entries.filter(e => e.holdTimeMs >= 5 * 60_000 && e.holdTimeMs < 15 * 60_000).length;
    const slowDumps = entries.filter(e => e.holdTimeMs >= 15 * 60_000 && e.holdTimeMs < 60 * 60_000).length;
    const longLosses = entries.filter(e => e.holdTimeMs >= 60 * 60_000).length;

    const suggestions = buildSuggestions(entries);

    return {
      totalLosses: n,
      totalLossSol,
      avgLossSol: totalLossSol / n,
      avgHoldMinutes,
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
      recentLosses: entries.slice(0, 20),
    };
  }
}

export const lossJournalService = new LossJournalService();
