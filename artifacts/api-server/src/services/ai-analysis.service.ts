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

  const fmt = (usd: number) =>
    usd >= 1_000_000 ? `$${(usd / 1_000_000).toFixed(2)}M` : `$${Math.round(usd / 1_000)}K`;

  return `You are an experienced Solana memecoin trader with 3 years of experience. This token has already passed all basic filters. Your job is NOT to recheck numbers — your job is to think like a trader and judge if this has real moonshot potential right now.

Token: ${t.name} ($${t.symbol})
MCap: ${fmt(t.marketCapUsd)}
Liquidity: ${fmt(t.liquidityUsd)}
Vol 1h: ${fmt(t.volume1hUsd)}
Vol 24h: ${fmt(t.volume24hUsd)}
Buy Ratio 1h: ${buyRatio1h}
1h Price Change: ${t.priceChange1h >= 0 ? "+" : ""}${t.priceChange1h.toFixed(1)}%
6h Price Change: ${t.priceChange6h >= 0 ? "+" : ""}${t.priceChange6h.toFixed(1)}%
Pair Age: ${ageLabel}
Txns 24h: ${t.txns24h}
Top 10 Holders: N/A
LP Status: Unverified

Think about these questions in your head:

1. MOMENTUM QUALITY
Is the volume accelerating or just a one-time spike?
Is buy ratio genuinely dominant or barely above 50%?
Is the 1h move organic or does it look like a pump?

2. ENTRY TIMING
Is this early stage (still room to grow) or has it already peaked?
MCap vs liquidity — is there realistic 3x–10x left?

3. RISK PATTERN
Does the holder % suggest one whale controlling price?
Does the age vs volume pattern look organic or manipulated?

4. CONVICTION
If you were trading your own money right now, would you enter this trade with confidence?

Based on your trader instinct and the above thinking, return EXACTLY this format, nothing else:

RESULT: PASS or FAIL
CONFIDENCE: 1-10
STAGE: Early or Mid or Late
POTENTIAL: 2x or 5x or 10x+ or Dump incoming
CONCERN: one line if any red flag
VERDICT: one line trader opinion`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

interface ParsedTraderVerdict {
  passFailResult: "PASS" | "FAIL";
  confidence: number;
  stage: string;
  potential: string;
  concern: string;
  verdictLine: string;
}

function parseTraderVerdict(raw: string, label: string): ParsedTraderVerdict | null {
  try {
    const lines = raw.trim().split("\n").map(l => l.trim()).filter(Boolean);

    const get = (key: string): string => {
      const line = lines.find(l => new RegExp(`^${key}\\s*:`, "i").test(l));
      return line ? line.replace(new RegExp(`^${key}\\s*:\\s*`, "i"), "").trim() : "";
    };

    const resultRaw = get("RESULT");
    if (!resultRaw) {
      logger.warn({ label, rawPreview: raw.slice(0, 200) }, "AI: no RESULT line found in response");
      return null;
    }

    const passFailResult: "PASS" | "FAIL" = resultRaw.toUpperCase().includes("PASS") ? "PASS" : "FAIL";

    const confMatch = get("CONFIDENCE").match(/(\d+)/);
    const confidence = confMatch ? Math.min(10, Math.max(1, parseInt(confMatch[1], 10))) : 5;

    const stageRaw = get("STAGE");
    const stage = ["Early", "Mid", "Late"].find(s =>
      stageRaw.toLowerCase().includes(s.toLowerCase()),
    ) ?? (stageRaw || "Unknown");

    const potential = get("POTENTIAL") || "Unknown";
    const concern   = get("CONCERN")   || "None";
    const verdictLine = get("VERDICT") || resultRaw;

    return { passFailResult, confidence, stage, potential, concern, verdictLine };
  } catch (e) {
    logger.warn({ label, rawPreview: raw.slice(0, 300), err: (e as Error).message }, "AI: parseTraderVerdict failed");
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
          max_tokens: 300,
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
// Runs when ALL LLM providers fail. Never blocks a trade just because AI is down.

function heuristicFallback(input: TokenAnalysisInput): Omit<LlmAnalysis, "provider" | "durationMs"> {
  let score = 0;
  const strengths: string[] = [];
  const risks: string[] = [];

  // Liquidity — thresholds aligned with Stage 1 filter minimum ($20K)
  if (input.liquidityUsd > 60_000)      { score += 25; strengths.push(`Strong liq $${Math.round(input.liquidityUsd / 1_000)}K`); }
  else if (input.liquidityUsd > 25_000) { score += 18; strengths.push(`Liq $${Math.round(input.liquidityUsd / 1_000)}K`); }
  else                                   { score += 10; strengths.push(`Liq $${Math.round(input.liquidityUsd / 1_000)}K`); }

  // Volume — thresholds aligned with Stage 1 filter minimum ($18K)
  if (input.volume24hUsd > 300_000)     { score += 25; strengths.push(`High vol $${Math.round(input.volume24hUsd / 1_000)}K`); }
  else if (input.volume24hUsd > 50_000) { score += 18; strengths.push(`24h vol $${Math.round(input.volume24hUsd / 1_000)}K`); }
  else if (input.volume24hUsd > 18_000) { score += 10; strengths.push(`Vol $${Math.round(input.volume24hUsd / 1_000)}K`); }
  else                                   { risks.push(`Low 24h vol $${Math.round(input.volume24hUsd / 1_000)}K`); }

  // Age — fresh is good for meme coins
  if (input.pairAgeMinutes < 30)        { score += 20; strengths.push(`Very fresh ${Math.round(input.pairAgeMinutes)}m`); }
  else if (input.pairAgeMinutes < 120)  { score += 15; strengths.push(`Fresh ${Math.round(input.pairAgeMinutes)}m`); }
  else if (input.pairAgeMinutes < 480)  { score += 8; }
  else                                   { risks.push("Pair >8h old"); }

  // Buy pressure — aligned with Stage 1 filter minimum (55%)
  const total1h  = input.buys1h + input.sells1h;
  const buyRatio = total1h > 0 ? input.buys1h / total1h : 0;
  if (buyRatio >= 0.70)      { score += 18; strengths.push(`Strong buys ${(buyRatio * 100).toFixed(0)}%`); }
  else if (buyRatio >= 0.55) { score += 10; strengths.push(`Buy pressure ${(buyRatio * 100).toFixed(0)}%`); }
  else                        { risks.push(`Weak buy ratio ${(buyRatio * 100).toFixed(0)}%`); }

  // Activity
  if (input.txns24h >= 500)  { score += 12; strengths.push(`Active ${input.txns24h} txns`); }
  else if (input.txns24h >= 80) { score += 7; strengths.push(`${input.txns24h} txns 24h`); }
  else                           { risks.push(`Low activity ${input.txns24h} txns`); }

  score = Math.min(100, score);
  // Tokens here already passed Stage 1+2 quality filters and rug check — TRADE at 50+, RISKY at 30+
  const verdict: LlmVerdict = score >= 50 ? "TRADE" : score >= 30 ? "RISKY" : "SKIP";

  return {
    verdict,
    confidence: score,
    reasoning: `Heuristic (AI unavailable): score ${score}/100.`,
    risks: risks.slice(0, 3),
    strengths: strengths.slice(0, 3),
    recommendedSizeSol: score >= 50 ? 0.5 : 0.25,
    llmScore: Math.round(score / 10),
    llmRiskLevel: score >= 75 ? "Low" : score >= 50 ? "Medium" : "High",
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
//   Both PASS          → TRADE at 0.5 SOL
//   One PASS one FAIL  → RISKY at 0.25 SOL (split decision)
//   Both FAIL          → SKIP
//   Both unavailable   → heuristic fallback

export async function analyseTokenWithAi(input: TokenAnalysisInput): Promise<LlmAnalysis> {
  const start     = Date.now();
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

  const llamaParsed   = llamaSettled.status   === "fulfilled" ? parseTraderVerdict(llamaSettled.value,   "llama")   : null;
  const mixtralParsed = mixtralSettled.status === "fulfilled" ? parseTraderVerdict(mixtralSettled.value, "mixtral") : null;

  const durationMs = Date.now() - start;

  const llamaLog   = llamaParsed
    ? `${llamaParsed.passFailResult} ${llamaParsed.confidence}/10`
    : `ERR: ${((llamaSettled as PromiseRejectedResult).reason as Error)?.message?.slice(0, 60) ?? "parse_fail"}`;
  const mixtralLog = mixtralParsed
    ? `${mixtralParsed.passFailResult} ${mixtralParsed.confidence}/10`
    : `ERR: ${((mixtralSettled as PromiseRejectedResult).reason as Error)?.message?.slice(0, 60) ?? "parse_fail"}`;

  logger.info({ symbol: input.symbol, llama: llamaLog, mixtral: mixtralLog, durationMs }, "AI analysis: dual verdict");

  // ── Both failed → heuristic ────────────────────────────────────────────────
  if (!llamaParsed && !mixtralParsed) {
    logger.warn({ symbol: input.symbol }, "AI analysis: both Groq models failed — heuristic fallback");
    const h = heuristicFallback(input);
    return { ...h, provider: "heuristic", durationMs };
  }

  // ── Pick primary (llama preferred), secondary whichever else responded ─────
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
    verdict            = primaryPass ? "TRADE" : "SKIP";
    recommendedSizeSol = primaryPass ? 0.5 : 0;
    llmRiskLevel       = primary.confidence >= 8 ? "Low" : primary.confidence >= 6 ? "Medium" : "High";
  } else if (primaryPass && secondaryPass) {
    verdict            = "TRADE";
    recommendedSizeSol = 0.5;
    llmRiskLevel       = primary.confidence >= 8 ? "Low" : "Medium";
  } else if (primaryPass !== secondaryPass) {
    verdict            = "RISKY";
    recommendedSizeSol = 0.25;
    llmRiskLevel       = "High";
  } else {
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
      recommendedSizeSol,
      durationMs,
    },
    "AI analysis: verdict resolved",
  );

  return {
    verdict,
    confidence: primary.confidence * 10,
    reasoning:  primary.verdictLine,
    risks:      primary.concern && primary.concern !== "None" ? [primary.concern] : [],
    strengths:  [],
    provider:   "groq",
    durationMs,
    recommendedSizeSol,
    llmScore:         primary.confidence,
    llmRiskLevel,
    secondaryVerdict: secondary ? secondary.passFailResult : "N/A",
    secondaryProvider: secondaryLabel,
    stage:     primary.stage,
    potential: primary.potential,
    concern:   primary.concern,
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
