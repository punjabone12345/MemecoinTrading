import axios from "axios";
import { logger } from "../lib/logger.js";
import type { DexScreenerPair } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LlmVerdict = "TRADE" | "SKIP" | "RISKY";

export interface LlmAnalysis {
  verdict: LlmVerdict;
  confidence: number;
  reasoning: string;
  risks: string[];
  strengths: string[];
  provider: "groq" | "heuristic" | "none";
  durationMs: number;
  recommendedSizeSol?: number;
  llmScore?: number;
  llmRiskLevel?: string;
  secondaryVerdict?: string;
  secondaryProvider?: string;
  stage?: string;
  potential?: string;
  concern?: string;
}

export interface TokenAnalysisInput {
  symbol: string;
  name: string;
  contractAddress: string;
  pairAddress: string;
  pairAgeMinutes: number;
  priceUsd: number;
  marketCapUsd: number;
  fdv: number;
  liquidityUsd: number;
  volume1hUsd: number;
  volume24hUsd: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  buys1h: number;
  sells1h: number;
  buys5m: number;
  sells5m: number;
  txns24h: number;
  aiScore: number;
  confidence: number;
  dexId: string;
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompt(t: TokenAnalysisInput): string {
  const ageLabel = t.pairAgeMinutes < 60
    ? `${Math.round(t.pairAgeMinutes)}m`
    : `${(t.pairAgeMinutes / 60).toFixed(1)}h`;

  const total1h    = t.buys1h + t.sells1h;
  const buyRatio1h = total1h > 0 ? `${(t.buys1h / total1h * 100).toFixed(0)}%` : "N/A";

  const total5m    = t.buys5m + t.sells5m;
  const buyRatio5m = total5m > 0 ? `${(t.buys5m / total5m * 100).toFixed(0)}%` : "N/A";

  const fmt = (usd: number) =>
    usd >= 1_000_000 ? `$${(usd / 1_000_000).toFixed(2)}M` : `$${Math.round(usd / 1_000)}K`;

  return `You are an experienced Solana memecoin trader. This token passed all filters AND market health check is ACTIVE. Judge if this is genuine early momentum or a fading pump.

Token: ${t.name} ($${t.symbol})
MCap: ${fmt(t.marketCapUsd)}
Liquidity: ${fmt(t.liquidityUsd)}
Vol 1h: ${fmt(t.volume1hUsd)}
Vol 24h: ${fmt(t.volume24hUsd)}
Buy Ratio 1h: ${buyRatio1h}
Buy Ratio 5m: ${buyRatio5m}
1h Price Change: ${t.priceChange1h >= 0 ? "+" : ""}${t.priceChange1h.toFixed(1)}%
5m Price Change: ${t.priceChange5m >= 0 ? "+" : ""}${t.priceChange5m.toFixed(1)}%
Pair Age: ${ageLabel}
Txns 24h: ${t.txns24h}

Answer these internally:

1. Is 5m change smaller than 1h change?
   Yes = still building = GOOD
   No = already peaked = BAD

2. Is buy ratio 5m higher than 1h?
   Yes = accelerating = GOOD
   No = decelerating = BAD

3. Is Vol 1h annualized (x24) more than 2x of Vol 24h?
   Yes = momentum fresh = GOOD
   No = momentum fading = BAD

4. Is MCap under $500K?
   Yes = room to grow = GOOD
   No = already pumped = BAD

5. Is pair age under 2 hours?
   Yes = early entry = GOOD
   No = late entry = BAD

Score 1 point per GOOD.

5/5 = PASS Low Risk
4/5 = PASS Medium Risk
3/5 = PASS High Risk
Below 3 = FAIL

Output EXACTLY this format, nothing else:

RESULT: PASS or FAIL
SCORE: X/5
RISK: Low or Medium or High
SIZE: 0.5 SOL or 0.25 SOL
ENTRY: Early or Mid or Late
REASON: one line`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

interface ParsedInstinctVerdict {
  passFailResult: "PASS" | "FAIL";
  score: number;
  riskLevel: string;
  sizeSol: number;
  entry: string;
  reason: string;
}

function parseInstinctVerdict(raw: string, label: string): ParsedInstinctVerdict | null {
  try {
    const lines = raw.trim().split("\n").map(l => l.trim()).filter(Boolean);

    const get = (key: string): string => {
      const line = lines.find(l => new RegExp(`^${key}\\s*:`, "i").test(l));
      return line ? line.replace(new RegExp(`^${key}\\s*:\\s*`, "i"), "").trim() : "";
    };

    const resultRaw = get("RESULT");
    if (!resultRaw) {
      logger.warn({ label, rawPreview: raw.slice(0, 200) }, "AI: no RESULT line found");
      return null;
    }

    const passFailResult: "PASS" | "FAIL" = resultRaw.toUpperCase().includes("PASS") ? "PASS" : "FAIL";

    const scoreRaw = get("SCORE");
    const scoreMatch = scoreRaw.match(/(\d+)/);
    const score = scoreMatch ? Math.min(5, Math.max(0, parseInt(scoreMatch[1], 10))) : 0;

    const riskRaw = get("RISK").toLowerCase();
    const riskLevel = riskRaw.includes("low") ? "Low" : riskRaw.includes("medium") ? "Medium" : "High";

    const sizeRaw = get("SIZE");
    const sizeSol = sizeRaw.includes("0.5") ? 0.5 : 0.25;

    const entryRaw = get("ENTRY");
    const entry = ["Early", "Mid", "Late"].find(e =>
      entryRaw.toLowerCase().includes(e.toLowerCase()),
    ) ?? "Unknown";

    const reason = get("REASON") || resultRaw;

    return { passFailResult, score, riskLevel, sizeSol, entry, reason };
  } catch (e) {
    logger.warn({ label, rawPreview: raw.slice(0, 300), err: (e as Error).message }, "AI: parseInstinctVerdict failed");
    return null;
  }
}

// ─── Timeout / retry helpers ──────────────────────────────────────────────────

const AI_TIMEOUT_MS = 40_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs = AI_TIMEOUT_MS): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  return Promise.race([promise, timeout]);
}

async function withRetry<T>(fn: () => Promise<T>, retries: number, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = 500 * 2 ** attempt;
        logger.warn({ label, attempt, delay, err: (err as Error).message }, "AI: attempt failed — retrying");
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Groq caller (shared, model-agnostic) ─────────────────────────────────────

async function callGroqModel(prompt: string, model: string, label: string): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  return withRetry(async () => {
    const res = await withTimeout(
      axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model,
          messages: [
            {
              role: "system",
              content: "You are an experienced Solana memecoin trader. Output ONLY the result block in the exact format specified. No extra text, no markdown, no explanation.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 200,
        },
        {
          timeout: AI_TIMEOUT_MS,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        },
      ),
    );
    const text: string = res.data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error(`${label} returned empty response`);
    return text;
  }, 2, label);
}

// ─── Heuristic fallback ───────────────────────────────────────────────────────
// Implements the same 5-question scoring as the Groq prompt.
// Runs when GROQ_API_KEY is not set or both models fail.

function heuristicFallback(input: TokenAnalysisInput): Omit<LlmAnalysis, "provider" | "durationMs"> {
  let score = 0;
  const goods: string[] = [];
  const bads: string[] = [];

  // Q1: 5m change smaller than 1h change → still building
  if (Math.abs(input.priceChange5m) < Math.abs(input.priceChange1h) && input.priceChange1h > 0) {
    score++; goods.push("Still building (5m < 1h)");
  } else {
    bads.push("May have peaked (5m ≥ 1h)");
  }

  // Q2: buy ratio 5m > buy ratio 1h → accelerating
  const total1h    = input.buys1h + input.sells1h;
  const buyRatio1h = total1h > 0 ? input.buys1h / total1h : 0;
  const total5m    = input.buys5m + input.sells5m;
  const buyRatio5m = total5m > 0 ? input.buys5m / total5m : 0;
  if (buyRatio5m > buyRatio1h) {
    score++; goods.push(`Accelerating buy ratio (5m ${(buyRatio5m * 100).toFixed(0)}% > 1h ${(buyRatio1h * 100).toFixed(0)}%)`);
  } else {
    bads.push(`Decelerating buys (5m ${(buyRatio5m * 100).toFixed(0)}% ≤ 1h ${(buyRatio1h * 100).toFixed(0)}%)`);
  }

  // Q3: vol1h × 24 > 2 × vol24h → fresh momentum
  if (input.volume1hUsd * 24 > 2 * input.volume24hUsd) {
    score++; goods.push("Fresh momentum (annualized 1h vol > 2× 24h)");
  } else {
    bads.push("Momentum fading (1h pace < 24h avg)");
  }

  // Q4: mcap < 500K
  if (input.marketCapUsd < 500_000) {
    score++; goods.push(`Room to grow (MCap $${Math.round(input.marketCapUsd / 1_000)}K)`);
  } else {
    bads.push(`Already pumped (MCap $${(input.marketCapUsd / 1_000_000).toFixed(1)}M)`);
  }

  // Q5: pair age < 2h
  if (input.pairAgeMinutes < 120) {
    score++; goods.push(`Early entry (${Math.round(input.pairAgeMinutes)}m old)`);
  } else {
    bads.push(`Late entry (${(input.pairAgeMinutes / 60).toFixed(1)}h old)`);
  }

  const passFailResult = score >= 3 ? "PASS" : "FAIL";
  const riskLevel = score === 5 ? "Low" : score === 4 ? "Medium" : "High";
  const sizeSol   = score >= 4 ? 0.5 : score === 3 ? 0.25 : 0;
  const entry     = input.pairAgeMinutes < 60 ? "Early" : input.pairAgeMinutes < 120 ? "Mid" : "Late";

  const verdict: LlmVerdict = passFailResult === "PASS"
    ? (score <= 3 ? "RISKY" : "TRADE")
    : "SKIP";

  return {
    verdict,
    confidence: score * 20,
    reasoning: `Heuristic ${score}/5: ${goods[0] ?? bads[0] ?? "no signal"}`,
    risks:     bads.slice(0, 2),
    strengths: goods.slice(0, 2),
    recommendedSizeSol: sizeSol,
    llmScore:     score,
    llmRiskLevel: riskLevel,
    stage:  entry,
    potential: score >= 4 ? "5x–10x" : score === 3 ? "2x–5x" : "Dump incoming",
    concern: bads[0] ?? "None",
  };
}

// ─── Startup log ──────────────────────────────────────────────────────────────

logger.info(
  { groqKey: Boolean(process.env["GROQ_API_KEY"]) },
  "AI service loaded — Groq dual-model (llama-3.3-70b-versatile + mixtral-8x7b-32768)",
);

// ─── Main export ──────────────────────────────────────────────────────────────
// Dual-Groq validation: llama-3.3-70b-versatile + mixtral-8x7b-32768 in PARALLEL.
//
// Combined verdict:
//   Both PASS          → TRADE at recommended size
//   One PASS one FAIL  → RISKY at 0.25 SOL (split decision)
//   Both FAIL          → SKIP (hard skip)
//   Both unavailable   → heuristic fallback

export async function analyseTokenWithAi(input: TokenAnalysisInput): Promise<LlmAnalysis> {
  const start      = Date.now();
  const hasGroqKey = Boolean(process.env["GROQ_API_KEY"]);

  logger.info({ symbol: input.symbol, hasGroqKey }, "AI analysis: starting evaluation");

  let prompt: string;
  try {
    prompt = buildPrompt(input);
  } catch (promptErr) {
    logger.error({ symbol: input.symbol, err: (promptErr as Error).message }, "AI analysis: buildPrompt crashed — using heuristic");
    const h = heuristicFallback(input);
    return { ...h, provider: "heuristic", durationMs: Date.now() - start };
  }

  if (!hasGroqKey) {
    logger.warn({ symbol: input.symbol }, "AI analysis: Groq not configured — heuristic fallback");
    const h = heuristicFallback(input);
    return { ...h, provider: "heuristic", durationMs: Date.now() - start };
  }

  // ── Fire both Groq models in parallel ─────────────────────────────────────
  const [llamaSettled, mixtralSettled] = await Promise.allSettled([
    callGroqModel(prompt, "llama-3.3-70b-versatile", "llama"),
    callGroqModel(prompt, "mixtral-8x7b-32768",       "mixtral"),
  ]);

  const llamaParsed   = llamaSettled.status   === "fulfilled" ? parseInstinctVerdict(llamaSettled.value,   "llama")   : null;
  const mixtralParsed = mixtralSettled.status === "fulfilled" ? parseInstinctVerdict(mixtralSettled.value, "mixtral") : null;

  const durationMs = Date.now() - start;

  const llamaLog   = llamaParsed
    ? `${llamaParsed.passFailResult} ${llamaParsed.score}/5 risk:${llamaParsed.riskLevel}`
    : `ERR: ${((llamaSettled as PromiseRejectedResult).reason as Error)?.message?.slice(0, 60) ?? "parse_fail"}`;
  const mixtralLog = mixtralParsed
    ? `${mixtralParsed.passFailResult} ${mixtralParsed.score}/5 risk:${mixtralParsed.riskLevel}`
    : `ERR: ${((mixtralSettled as PromiseRejectedResult).reason as Error)?.message?.slice(0, 60) ?? "parse_fail"}`;

  logger.info({ symbol: input.symbol, llama: llamaLog, mixtral: mixtralLog, durationMs }, "AI analysis: dual verdict");

  // ── Both failed → heuristic ────────────────────────────────────────────────
  if (!llamaParsed && !mixtralParsed) {
    logger.warn({ symbol: input.symbol }, "AI analysis: both Groq models failed — heuristic fallback");
    const h = heuristicFallback(input);
    return { ...h, provider: "heuristic", durationMs };
  }

  // ── Combine verdicts ───────────────────────────────────────────────────────
  const primary       = llamaParsed ?? mixtralParsed!;
  const secondary     = llamaParsed && mixtralParsed ? mixtralParsed : null;
  const primaryLabel  = llamaParsed ? "llama-3.3-70b" : "mixtral-8x7b";
  const secondaryLabel = secondary ? "mixtral-8x7b" : "N/A";

  const primaryPass   = primary.passFailResult   === "PASS";
  const secondaryPass = secondary?.passFailResult === "PASS";

  let verdict: LlmVerdict;
  let recommendedSizeSol: number;
  let llmRiskLevel: string;

  if (!secondary) {
    // Only one model responded
    verdict            = primaryPass ? (primary.score <= 3 ? "RISKY" : "TRADE") : "SKIP";
    recommendedSizeSol = primaryPass ? primary.sizeSol : 0;
    llmRiskLevel       = primary.riskLevel;
  } else if (primaryPass && secondaryPass) {
    // Both PASS — use higher-confidence size (primary = llama preferred)
    verdict            = "TRADE";
    recommendedSizeSol = primary.sizeSol;
    llmRiskLevel       = primary.riskLevel;
  } else if (primaryPass !== secondaryPass) {
    // Split decision → RISKY at 0.25 SOL regardless of model recommendation
    verdict            = "RISKY";
    recommendedSizeSol = 0.25;
    llmRiskLevel       = "High";
  } else {
    // Both FAIL → hard skip
    verdict            = "SKIP";
    recommendedSizeSol = 0;
    llmRiskLevel       = "High";
  }

  logger.info(
    {
      symbol: input.symbol,
      verdict,
      llama:   llamaParsed?.passFailResult   ?? "N/A",
      mixtral: mixtralParsed?.passFailResult ?? "N/A",
      llamaScore:   llamaParsed?.score   ?? "N/A",
      mixtralScore: mixtralParsed?.score ?? "N/A",
      recommendedSizeSol,
      durationMs,
    },
    "AI analysis: verdict resolved",
  );

  return {
    verdict,
    confidence: primary.score * 20,
    reasoning:  primary.reason,
    risks:      [],
    strengths:  [],
    provider:   "groq",
    durationMs,
    recommendedSizeSol,
    llmScore:         primary.score,
    llmRiskLevel,
    secondaryVerdict: secondary ? secondary.passFailResult : "N/A",
    secondaryProvider: secondaryLabel,
    stage:     primary.entry,
    potential: primary.score >= 4 ? "5x–10x" : "2x–5x",
    concern:   primary.reason,
  };
}

// ─── Helper: build TokenAnalysisInput from DexScreenerPair ───────────────────

export function buildAnalysisInput(
  pair: DexScreenerPair,
  symbol: string,
  name: string,
  aiScore: number,
  confidence: number,
  contractAddress?: string,
): TokenAnalysisInput {
  const pairAgeMinutes = pair.pairCreatedAt
    ? (Date.now() - pair.pairCreatedAt) / 60_000
    : 0;
  const buys1h  = pair.txns?.h1?.buys  || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const buys5m  = pair.txns?.m5?.buys  || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const txns24h = (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0);

  return {
    symbol,
    name,
    contractAddress: contractAddress ?? pair.baseToken?.address ?? pair.pairAddress,
    pairAddress: pair.pairAddress,
    pairAgeMinutes,
    priceUsd:      parseFloat(pair.priceUsd) || 0,
    marketCapUsd:  pair.marketCap || pair.fdv || 0,
    fdv:           pair.fdv || 0,
    liquidityUsd:  pair.liquidity?.usd || 0,
    volume1hUsd:   pair.volume?.h1 || 0,
    volume24hUsd:  pair.volume?.h24 || 0,
    priceChange5m:  pair.priceChange?.m5 || 0,
    priceChange1h:  pair.priceChange?.h1 || 0,
    priceChange6h:  pair.priceChange?.h6 || 0,
    priceChange24h: pair.priceChange?.h24 || 0,
    buys1h,
    sells1h,
    buys5m,
    sells5m,
    txns24h,
    aiScore,
    confidence,
    dexId: pair.dexId,
  };
}
