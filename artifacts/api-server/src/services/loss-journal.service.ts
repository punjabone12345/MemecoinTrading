import { logger } from "../lib/logger.js";
import { query, execute } from "../lib/db.js";
import type { Position } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LossTag =
  | "rug_speed"
  | "fast_rug"
  | "slow_dump"
  | "borderline_score"
  | "borderline_conf"
  | "thin_liquidity"
  | "micro_cap"
  | "large_cap"
  | "high_fdv_risk"
  | "no_ai_recovery"
  | "fake_price"
  | "quick_tp"
  | "strong_win"
  | "high_score_win"
  | "good_liquidity_win"
  | "momentum_win"
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
  warnings: string[];
  recordedAt: number;
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

// ─── Tag derivation ──────────────────────────────────────────────────────────

function deriveTags(pos: Position, holdMs: number, isWin: boolean): { tags: LossTag[]; warnings: string[] } {
  const tags: LossTag[] = [];
  const warnings: string[] = [];
  const holdMin = holdMs / 60_000;

  if (isWin) {
    if (holdMin < 30) { tags.push("quick_tp"); warnings.push(`Fast TP hit in ${holdMin.toFixed(1)}m — strong early momentum`); }
    if ((pos.pnlPercent ?? 0) >= 15) { tags.push("strong_win"); warnings.push(`Strong gain of +${(pos.pnlPercent ?? 0).toFixed(1)}% — excellent risk/reward`); }
    if (pos.aiScore >= 80) { tags.push("high_score_win"); warnings.push(`AI score was ${pos.aiScore} — high-conviction entry paid off`); }
    if (pos.entryLiquidityUsd > 50_000) { tags.push("good_liquidity_win"); warnings.push(`Entry liquidity was $${Math.round(pos.entryLiquidityUsd / 1000)}K — deep pool allowed clean exit`); }
  } else {
    if (holdMin < 5) { tags.push("rug_speed"); warnings.push(`Closed in only ${holdMin.toFixed(1)}m — instant rug`); }
    else if (holdMin < 15) { tags.push("fast_rug"); warnings.push(`Closed in ${holdMin.toFixed(1)}m — fast dump`); }
    else if (holdMin < 60) { tags.push("slow_dump"); warnings.push(`Held ${holdMin.toFixed(1)}m — slow distribution`); }
    else { tags.push("no_ai_recovery"); warnings.push(`Held ${holdMin.toFixed(1)}m — token stalled and drained slowly`); }

    if (pos.aiScore >= 72 && pos.aiScore <= 77) { tags.push("borderline_score"); warnings.push(`AI score was ${pos.aiScore} — low-conviction entry`); }
    if (pos.confidence >= 65 && pos.confidence <= 72) { tags.push("borderline_conf"); warnings.push(`Confidence was ${pos.confidence}% — barely above the 65% floor`); }
    if (pos.entryLiquidityUsd > 0 && pos.entryLiquidityUsd <= 35_000) { tags.push("thin_liquidity"); warnings.push(`Entry liquidity was $${Math.round(pos.entryLiquidityUsd / 1000)}K — thin pool`); }
    if (pos.entryMarketCap > 0 && pos.entryMarketCap < 100_000) { tags.push("micro_cap"); warnings.push(`Entry mcap was $${Math.round(pos.entryMarketCap / 1000)}K — micro-cap`); }
    if (pos.entryMarketCap > 5_000_000) { tags.push("large_cap"); warnings.push(`Entry mcap was $${(pos.entryMarketCap / 1_000_000).toFixed(1)}M — may have been distributed`); }
    if (pos.tpPercent >= 50) { tags.push("high_fdv_risk"); warnings.push(`TP was +${pos.tpPercent}% but trade still lost`); }
    if (pos.note) { tags.push("fake_price"); warnings.push(`Manually marked: "${pos.note}"`); }
  }

  return { tags, warnings };
}

// ─── Suggestions engine ─────────────────────────────────────────────────────

function buildSuggestions(losses: LossJournalEntry[], wins: LossJournalEntry[]): FilterSuggestion[] {
  if (losses.length < 3) return [];
  const n = losses.length;
  const suggestions: FilterSuggestion[] = [];
  const lossPct = (tag: LossTag) => (losses.filter(e => e.tags.includes(tag)).length / n) * 100;
  const winHighScore = wins.length > 0 ? wins.filter(e => e.tags.includes("high_score_win")).length / wins.length * 100 : 0;
  const winGoodLiq = wins.length > 0 ? wins.filter(e => e.tags.includes("good_liquidity_win")).length / wins.length * 100 : 0;

  const borderlineScorePct = lossPct("borderline_score");
  if (borderlineScorePct >= 35) {
    const suggestedVal = winHighScore >= 50 ? 80 : 76;
    suggestions.push({ filter: "minAiScore", currentValue: 72, suggestedValue: suggestedVal, reason: `${borderlineScorePct.toFixed(0)}% of losses had AI score 72–77. Raise to ${suggestedVal}.`, priority: borderlineScorePct >= 50 ? "high" : "medium", confidence: Math.min(95, 50 + borderlineScorePct) });
  }

  const borderlineConfPct = lossPct("borderline_conf");
  if (borderlineConfPct >= 35) {
    suggestions.push({ filter: "minConfidence", currentValue: 65, suggestedValue: 72, reason: `${borderlineConfPct.toFixed(0)}% of losses had confidence 65–72. Raise to 72.`, priority: borderlineConfPct >= 50 ? "high" : "medium", confidence: Math.min(95, 50 + borderlineConfPct) });
  }

  const thinLiqPct = lossPct("thin_liquidity");
  if (thinLiqPct >= 40) {
    const suggestedVal = winGoodLiq >= 50 ? 50_000 : 35_000;
    suggestions.push({ filter: "minLiquidityUsd", currentValue: 20_000, suggestedValue: suggestedVal, reason: `${thinLiqPct.toFixed(0)}% of losses had entry liquidity $20K–$35K. Thin pools drain fast.`, priority: thinLiqPct >= 55 ? "high" : "medium", confidence: Math.min(95, 45 + thinLiqPct) });
  }

  const rugSpeedPct = lossPct("rug_speed");
  if (rugSpeedPct >= 30) {
    suggestions.push({ filter: "minPairAgeMinutes", currentValue: 15, suggestedValue: 25, reason: `${rugSpeedPct.toFixed(0)}% of losses closed in <5m (instant rug). Raise to 25m.`, priority: "high", confidence: Math.min(90, 40 + rugSpeedPct) });
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

  async init(): Promise<void> {
    try {
      const rows = await query<Record<string, unknown>>(
        "SELECT * FROM loss_journal ORDER BY recorded_at DESC"
      );
      this.entries = rows.map((r) => ({
        positionId: r.position_id as string,
        symbol: r.symbol as string,
        contractAddress: r.contract_address as string ?? "",
        openedAt: r.opened_at instanceof Date ? r.opened_at.toISOString() : r.opened_at as string ?? "",
        closedAt: r.closed_at instanceof Date ? r.closed_at.toISOString() : r.closed_at as string ?? "",
        holdTimeMs: Number(r.hold_time_ms ?? 0),
        pnlSol: Number(r.pnl_sol ?? 0),
        pnlPercent: Number(r.pnl_percent ?? 0),
        aiScore: Number(r.ai_score ?? 0),
        confidence: Number(r.confidence ?? 0),
        entryMcapUsd: Number(r.entry_mcap_usd ?? 0),
        entryLiquidityUsd: Number(r.entry_liquidity_usd ?? 0),
        slPercent: Number(r.sl_percent ?? 0),
        tpPercent: Number(r.tp_percent ?? 0),
        tags: (r.tags as LossTag[]) ?? [],
        warnings: (r.warnings as string[]) ?? [],
        recordedAt: Number(r.recorded_at ?? 0),
        note: r.note as string | undefined,
        isWin: Boolean(r.is_win),
      }));
      logger.info({ count: this.entries.length }, "Loss journal loaded from database");
    } catch (err) {
      logger.error({ err }, "Loss journal: failed to load from DB — starting empty");
    }
  }

  private async upsertEntry(entry: LossJournalEntry): Promise<void> {
    try {
      await execute(
        `INSERT INTO loss_journal (
          position_id, symbol, contract_address, opened_at, closed_at,
          hold_time_ms, pnl_sol, pnl_percent, ai_score, confidence,
          entry_mcap_usd, entry_liquidity_usd, sl_percent, tp_percent,
          tags, warnings, recorded_at, note, is_win
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (position_id) DO UPDATE SET
          pnl_sol = EXCLUDED.pnl_sol,
          pnl_percent = EXCLUDED.pnl_percent,
          tags = EXCLUDED.tags,
          warnings = EXCLUDED.warnings,
          note = EXCLUDED.note,
          is_win = EXCLUDED.is_win,
          recorded_at = EXCLUDED.recorded_at`,
        [
          entry.positionId, entry.symbol, entry.contractAddress,
          entry.openedAt || null, entry.closedAt || null,
          entry.holdTimeMs, entry.pnlSol, entry.pnlPercent,
          entry.aiScore, entry.confidence, entry.entryMcapUsd,
          entry.entryLiquidityUsd, entry.slPercent, entry.tpPercent,
          JSON.stringify(entry.tags), JSON.stringify(entry.warnings),
          entry.recordedAt, entry.note ?? null, entry.isWin,
        ]
      );
    } catch (err) {
      logger.error({ err, positionId: entry.positionId }, "Loss journal: failed to upsert to DB");
    }
  }

  private async deleteEntry_db(positionId: string): Promise<void> {
    try {
      await execute("DELETE FROM loss_journal WHERE position_id = $1", [positionId]);
    } catch (err) {
      logger.error({ err, positionId }, "Loss journal: failed to delete from DB");
    }
  }

  record(pos: Position): void {
    if (!pos.closedAt) return;
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
      tags, warnings,
      recordedAt: Date.now(),
      note: pos.note,
      isWin,
    };

    this.entries.unshift(entry);
    void this.upsertEntry(entry);
    logger.info({ symbol: pos.symbol, pnlSol: pos.pnlSol, isWin, tags }, "Trade journal: entry recorded");
  }

  reRecord(pos: Position): void {
    this.entries = this.entries.filter(e => e.positionId !== pos.positionId);
    void this.deleteEntry_db(pos.positionId);
    this.record(pos);
  }

  deleteEntry(positionId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.positionId !== positionId);
    if (this.entries.length < before) {
      void this.deleteEntry_db(positionId);
      return true;
    }
    return false;
  }

  clear(): void {
    this.entries = [];
    void execute("DELETE FROM loss_journal");
    logger.info("Trade journal cleared");
  }

  getEntries(): LossJournalEntry[] { return [...this.entries]; }

  getInsights(): LossInsights {
    const all = this.entries;
    const losses = all.filter(e => !e.isWin);
    const wins = all.filter(e => e.isWin);
    const nAll = all.length, nLoss = losses.length, nWin = wins.length;

    if (nAll === 0) {
      return {
        totalLosses: 0, totalWins: 0, totalTrades: 0,
        totalLossSol: 0, totalWinSol: 0, avgLossSol: 0, avgWinSol: 0,
        avgHoldMinutes: 0, avgWinHoldMinutes: 0, avgLossHoldMinutes: 0,
        tagFrequency: {}, tagPercentage: {},
        avgAiScore: 0, avgConfidence: 0, borderlineScoreCount: 0, borderlineConfCount: 0,
        instantRugs: 0, fastRugs: 0, slowDumps: 0, longLosses: 0,
        suggestions: [], recentLosses: [], recentWins: [], allEntries: [],
      };
    }

    const totalLossSol = losses.reduce((s, e) => s + e.pnlSol, 0);
    const totalWinSol = wins.reduce((s, e) => s + e.pnlSol, 0);
    const avgHoldMinutes = all.reduce((s, e) => s + e.holdTimeMs, 0) / nAll / 60_000;
    const avgWinHoldMinutes = nWin > 0 ? wins.reduce((s, e) => s + e.holdTimeMs, 0) / nWin / 60_000 : 0;
    const avgLossHoldMinutes = nLoss > 0 ? losses.reduce((s, e) => s + e.holdTimeMs, 0) / nLoss / 60_000 : 0;

    const tagFrequency: Record<string, number> = {};
    for (const entry of all) for (const tag of entry.tags) tagFrequency[tag] = (tagFrequency[tag] ?? 0) + 1;
    const tagPercentage: Record<string, number> = {};
    for (const [tag, count] of Object.entries(tagFrequency)) tagPercentage[tag] = Math.round((count / nAll) * 100);

    return {
      totalLosses: nLoss, totalWins: nWin, totalTrades: nAll,
      totalLossSol, totalWinSol,
      avgLossSol: nLoss > 0 ? totalLossSol / nLoss : 0,
      avgWinSol: nWin > 0 ? totalWinSol / nWin : 0,
      avgHoldMinutes, avgWinHoldMinutes, avgLossHoldMinutes,
      tagFrequency, tagPercentage,
      avgAiScore: all.reduce((s, e) => s + e.aiScore, 0) / nAll,
      avgConfidence: all.reduce((s, e) => s + e.confidence, 0) / nAll,
      borderlineScoreCount: losses.filter(e => e.tags.includes("borderline_score")).length,
      borderlineConfCount: losses.filter(e => e.tags.includes("borderline_conf")).length,
      instantRugs: losses.filter(e => e.holdTimeMs < 5 * 60_000).length,
      fastRugs: losses.filter(e => e.holdTimeMs >= 5 * 60_000 && e.holdTimeMs < 15 * 60_000).length,
      slowDumps: losses.filter(e => e.holdTimeMs >= 15 * 60_000 && e.holdTimeMs < 60 * 60_000).length,
      longLosses: losses.filter(e => e.holdTimeMs >= 60 * 60_000).length,
      suggestions: buildSuggestions(losses, wins),
      recentLosses: losses.slice(0, 20),
      recentWins: wins.slice(0, 20),
      allEntries: all.slice(0, 40),
    };
  }
}

export const lossJournalService = new LossJournalService();
