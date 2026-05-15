import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { logger } from "../lib/logger.js";
import type { DexScreenerPair } from "../types/index.js";

// ─── Gemini client ─────────────────────────────────────────────────────────────
function getGeminiClient(): GoogleGenAI {
  const baseUrl = process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];
  const apiKey  = process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "no-key";
  if (baseUrl) {
    return new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "", baseUrl } });
  }
  return new GoogleGenAI({ apiKey });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type LlmVerdict = "TRADE" | "SKIP" | "RISKY";

export interface LlmAnalysis {
  verdict: LlmVerdict;
  confidence: number;
  reasoning: string;
  risks: string[];
  strengths: string[];
  provider: "gemini" | "groq" | "heuristic" | "none";
  durationMs: number;
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

  const total1h = t.buys1h + t.sells1h;
  const buyRatio1h = total1h > 0 ? ((t.buys1h / total1h) * 100).toFixed(0) : "?";
  const total5m = t.buys5m + t.sells5m;
  const buyRatio5m = total5m > 0 ? ((t.buys5m / total5m) * 100).toFixed(0) : "?";
  const liqMcapPct = t.marketCapUsd > 0 ? ((t.liquidityUsd / t.marketCapUsd) * 100).toFixed(1) : "?";
  const fdvRatio = t.marketCapUsd > 0 && t.fdv > 0 ? (t.fdv / t.marketCapUsd).toFixed(1) : "?";
  const vol1hMcapPct = t.marketCapUsd > 0 ? ((t.volume1hUsd / t.marketCapUsd) * 100).toFixed(0) : "?";

  return `You are an expert Solana memecoin trader with deep experience avoiding rug pulls and catching early-stage pumps. Analyse this token and decide whether to open a paper trade.

TOKEN IDENTITY
───────────────────────────────
Name / Symbol   : ${t.name} / $${t.symbol}
Contract (CA)   : ${t.contractAddress}
DEX             : ${t.dexId}
DexScreener     : https://dexscreener.com/solana/${t.contractAddress}

TOKEN METRICS
───────────────────────────────
Pair Age        : ${ageLabel}
Price           : $${t.priceUsd}
Market Cap      : $${t.marketCapUsd.toLocaleString()}
FDV             : $${t.fdv.toLocaleString()} (${fdvRatio}× mcap)
Liquidity       : $${t.liquidityUsd.toLocaleString()} (${liqMcapPct}% of mcap)

PRICE ACTION
───────────────────────────────
5m change       : ${t.priceChange5m >= 0 ? "+" : ""}${t.priceChange5m.toFixed(1)}%
1h change       : ${t.priceChange1h >= 0 ? "+" : ""}${t.priceChange1h.toFixed(1)}%
6h change       : ${t.priceChange6h >= 0 ? "+" : ""}${t.priceChange6h.toFixed(1)}%
24h change      : ${t.priceChange24h >= 0 ? "+" : ""}${t.priceChange24h.toFixed(1)}%

TRADING ACTIVITY
───────────────────────────────
Volume 1h       : $${t.volume1hUsd.toLocaleString()} (${vol1hMcapPct}% of mcap)
Volume 24h      : $${t.volume24hUsd.toLocaleString()}
Buy ratio 1h    : ${buyRatio1h}% (${t.buys1h} buys / ${t.sells1h} sells)
Buy ratio 5m    : ${buyRatio5m}% (${t.buys5m} buys / ${t.sells5m} sells)
Txns 24h        : ${t.txns24h}

QUANT MODEL
───────────────────────────────
AI score        : ${t.aiScore}/100 (already passed ≥72 quant filter)
Data confidence : ${t.confidence}%

TASK
───────────────────────────────
Output ONLY valid JSON. No markdown, no explanation outside the JSON.

CRITICAL — be a SCEPTICAL trader. Default to SKIP unless the signal is genuinely strong.
Ask yourself:
1. Is the 1h pump still ongoing (confirmed by 5m momentum) or already peaked?
2. Is liquidity real and deep enough to exit without extreme slippage?
3. Does the buy ratio indicate genuine organic demand vs bot accumulation?
4. Is this token less than 2h old with unproven longevity? (Higher rug risk)
5. Could the CA be a known scam, clone, or honeypot?

Required JSON format:
{
  "verdict": "TRADE" | "SKIP" | "RISKY",
  "confidence": <0-100>,
  "reasoning": "<2-3 sentences explaining the key decision factor>",
  "risks": ["<concise risk 1>", "<concise risk 2>", "<concise risk 3>"],
  "strengths": ["<concise strength 1>", "<concise strength 2>"]
}

Verdict guide:
  TRADE  — strong early signal, momentum confirmed by 5m, healthy liquidity, good risk/reward
  RISKY  — borderline signal with real concerns; tighter SL will be applied automatically
  SKIP   — late entry, peaked pump, thin liquidity, suspicious buy ratio, likely rug, or insufficient conviction`;
}

// ─── Safe JSON parser — never throws, logs raw on failure ─────────────────────

function parseJsonVerdict(raw: string, provider: string): Omit<LlmAnalysis, "provider" | "durationMs"> | null {
  try {
    // Strip markdown code fences if the model wraps the response
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    // Extract the first {...} block — handles stray text before/after
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn({ provider, rawPreview: raw.slice(0, 200) }, "AI: no JSON object found in response");
      return null;
    }

    const obj = JSON.parse(jsonMatch[0]) as {
      verdict: string;
      confidence: unknown;
      reasoning: string;
      risks: unknown;
      strengths: unknown;
    };

    const verdict = (["TRADE", "SKIP", "RISKY"].includes(obj.verdict) ? obj.verdict : "SKIP") as LlmVerdict;
    const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(100, obj.confidence)) : 50;
    const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 300) : "No reasoning provided.";
    const risks = Array.isArray(obj.risks)
      ? (obj.risks as unknown[]).filter((r): r is string => typeof r === "string").slice(0, 4)
      : [];
    const strengths = Array.isArray(obj.strengths)
      ? (obj.strengths as unknown[]).filter((s): s is string => typeof s === "string").slice(0, 4)
      : [];

    return { verdict, confidence, reasoning, risks, strengths };
  } catch (e) {
    logger.warn({ provider, rawPreview: raw.slice(0, 300), err: (e as Error).message }, "AI: JSON parse failed");
    return null;
  }
}

// ─── Timeout via Promise.race — works with any async call including Gemini SDK ──
// AbortController signals are NOT honoured by @google/genai SDK internally,
// so we use Promise.race to enforce a hard wall-clock limit.

const AI_TIMEOUT_MS = 40_000; // gemini-2.5-flash (thinking model) takes 8-15 s with longer prompts

function withTimeout<T>(promise: Promise<T>, timeoutMs = AI_TIMEOUT_MS): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`AI request timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  return Promise.race([promise, timeout]);
}

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number,
  label: string,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const delay = 500 * 2 ** attempt; // 500 ms, 1 s, 2 s …
        logger.warn({ label, attempt, delay, err: (err as Error).message }, "AI: attempt failed — retrying");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─── Gemini (primary) ─────────────────────────────────────────────────────────
// Key findings from live testing:
// - gemini-2.5-flash is a thinking model: it spends tokens on internal reasoning
//   BEFORE writing the JSON output. With maxOutputTokens: 512 the output was
//   always truncated mid-string. 2048 gives it room to think + respond fully.
// - Typical response time: 8-9 s → timeout must be > 10 s (25 s used).
// - Only gemini-2.5-flash is available via the Replit integration proxy.
// - AbortController signals are NOT honoured by @google/genai SDK, so we use
//   Promise.race() in withTimeout() instead.

async function callGemini(prompt: string): Promise<string> {
  const hasIntegration = Boolean(process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]);
  const hasDirectKey   = Boolean(process.env["GEMINI_API_KEY"]);
  if (!hasIntegration && !hasDirectKey) throw new Error("No Gemini credentials configured");

  return withRetry(async () => {
    const ai = getGeminiClient();
    const geminiCall = ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.1,
        // 8192 tokens: thinking models consume tokens on internal reasoning before
        // writing the JSON output. 2048 was too small for the longer CA-enriched prompt.
        // 8192 gives ample room for think + respond without truncation.
        maxOutputTokens: 8192,
      },
    });
    const response = await withTimeout(geminiCall);
    const text = response.text ?? "";
    if (!text) throw new Error("Gemini returned empty response");
    return text;
  }, 2, "gemini");
}

// ─── Groq (fallback) ──────────────────────────────────────────────────────────

async function callGroq(prompt: string): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY not set — set the secret to enable Groq fallback");

  return withRetry(async () => {
    const groqCall = axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: "You are an expert Solana memecoin trader. Respond ONLY with a valid JSON object — no markdown, no explanation outside the JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: "json_object" },
      },
      {
        timeout: AI_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      },
    );
    const res = await withTimeout(groqCall);
    const text: string = res.data?.choices?.[0]?.message?.content ?? "";
    if (!text) throw new Error("Groq returned empty response");
    return text;
  }, 2, "groq");
}

// ─── Heuristic fallback scorer — runs when ALL LLM providers fail ──────────────
// Never skips a token just because AI is down. Scores based on raw metrics.
// Returns a verdict equivalent to the AI format so the rest of the pipeline
// can proceed unchanged.

function heuristicFallback(input: TokenAnalysisInput): Omit<LlmAnalysis, "provider" | "durationMs"> {
  let score = 0;
  const strengths: string[] = [];
  const risks: string[] = [];

  // Liquidity check (+25)
  if (input.liquidityUsd > 30_000) {
    score += 25;
    strengths.push(`Strong liquidity $${Math.round(input.liquidityUsd / 1000)}K`);
  } else {
    risks.push(`Low liquidity $${Math.round(input.liquidityUsd / 1000)}K`);
  }

  // Volume 24h check (+25)
  if (input.volume24hUsd > 500_000) {
    score += 25;
    strengths.push(`High 24h volume $${Math.round(input.volume24hUsd / 1000)}K`);
  } else if (input.volume24hUsd > 100_000) {
    score += 12;
    strengths.push(`Moderate 24h volume $${Math.round(input.volume24hUsd / 1000)}K`);
  } else {
    risks.push(`Low 24h volume $${Math.round(input.volume24hUsd / 1000)}K`);
  }

  // Pair age check — early entries are better (+20)
  if (input.pairAgeMinutes < 120) {
    score += 20;
    strengths.push(`Fresh pair — ${Math.round(input.pairAgeMinutes)}m old`);
  } else if (input.pairAgeMinutes > 1440) {
    risks.push("Pair is >24h old — may be past peak");
  }

  // Buy/sell ratio 1h (+15)
  const total1h = input.buys1h + input.sells1h;
  const buyRatio = total1h > 0 ? input.buys1h / total1h : 0;
  if (buyRatio > 1.2 / (1 + 1.2)) { // buys > 1.2× sells
    score += 15;
    strengths.push(`Buy pressure ${(buyRatio * 100).toFixed(0)}% buys`);
  } else if (buyRatio < 0.4) {
    risks.push(`Selling pressure ${((1 - buyRatio) * 100).toFixed(0)}% sells`);
  }

  // Txn count as proxy for holders (+15)
  if (input.txns24h > 200) {
    score += 15;
    strengths.push(`Active ${input.txns24h} txns 24h`);
  } else if (input.txns24h < 50) {
    risks.push(`Low activity ${input.txns24h} txns 24h`);
  }

  // Normalise to 0-100
  score = Math.min(100, Math.max(0, score));

  // Map score to verdict
  let verdict: LlmVerdict;
  let confidence: number;
  if (score >= 65) {
    verdict = "TRADE";
    confidence = score;
  } else if (score >= 40) {
    verdict = "RISKY";
    confidence = score;
  } else {
    verdict = "SKIP";
    confidence = 100 - score;
  }

  return {
    verdict,
    confidence,
    reasoning: `Heuristic scoring (AI unavailable): score ${score}/100. ${strengths.slice(0, 1).join(". ")}`,
    risks: risks.slice(0, 3),
    strengths: strengths.slice(0, 3),
  };
}

// ─── Startup env check — logged once when the module is first imported ────────
// This will appear in server logs immediately on startup, making it easy to
// confirm whether the Replit Gemini integration env vars are present.
logger.info(
  {
    geminiIntegration: Boolean(process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]),
    geminiDirectKey:   Boolean(process.env["GEMINI_API_KEY"]),
    groqKey:           Boolean(process.env["GROQ_API_KEY"]),
    geminiBaseUrl:     process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]?.slice(0, 50) ?? "NOT SET",
  },
  "AI service loaded — provider env check",
);

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyseTokenWithAi(input: TokenAnalysisInput): Promise<LlmAnalysis> {
  const start = Date.now();

  // Log env state on EVERY call so we can see exactly what the process has
  // at the moment a real token is evaluated (not just at startup).
  const hasGeminiIntegration = Boolean(process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]);
  const hasGeminiDirectKey   = Boolean(process.env["GEMINI_API_KEY"]);
  const hasGroqKey           = Boolean(process.env["GROQ_API_KEY"]);

  logger.info(
    { symbol: input.symbol, hasGeminiIntegration, hasGeminiDirectKey, hasGroqKey },
    "AI analysis: starting evaluation",
  );

  let prompt: string;
  try {
    prompt = buildPrompt(input);
  } catch (promptErr) {
    logger.error({ symbol: input.symbol, err: (promptErr as Error).message, input }, "AI analysis: buildPrompt crashed — using heuristic");
    const heuristic = heuristicFallback(input);
    return { ...heuristic, provider: "heuristic", durationMs: Date.now() - start };
  }

  // ── Try Gemini (up to 2 retries, 25 s timeout — thinking model takes 8-9 s) ──
  try {
    const raw = await callGemini(prompt);
    const parsed = parseJsonVerdict(raw, "gemini");
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "gemini", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, durationMs: result.durationMs },
        "AI analysis: Gemini verdict",
      );
      return result;
    }
    throw new Error("Gemini JSON parse failed — raw response was logged above");
  } catch (geminiErr) {
    logger.warn(
      { err: (geminiErr as Error).message, stack: (geminiErr as Error).stack?.split("\n")[1]?.trim(), symbol: input.symbol },
      "AI analysis: Gemini failed — trying Groq",
    );
  }

  // ── Fallback: Groq (up to 2 retries, 25 s timeout) ───────────────────────────
  try {
    const raw = await callGroq(prompt);
    const parsed = parseJsonVerdict(raw, "groq");
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "groq", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, durationMs: result.durationMs },
        "AI analysis: Groq verdict",
      );
      return result;
    }
    throw new Error("Groq JSON parse failed — raw response was logged above");
  } catch (groqErr) {
    logger.warn({ err: (groqErr as Error).message, symbol: input.symbol }, "AI analysis: Groq also failed — using heuristic fallback");
  }

  // ── Both LLMs failed — use heuristic scorer, NEVER skip just because AI is down ──
  const heuristic = heuristicFallback(input);
  const result: LlmAnalysis = { ...heuristic, provider: "heuristic", durationMs: Date.now() - start };
  logger.warn(
    { symbol: input.symbol, verdict: result.verdict, score: result.confidence, durationMs: result.durationMs },
    "AI analysis: heuristic fallback used (Gemini + Groq both unavailable)",
  );
  return result;
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
    priceUsd: parseFloat(pair.priceUsd) || 0,
    marketCapUsd: pair.marketCap || pair.fdv || 0,
    fdv: pair.fdv || 0,
    liquidityUsd: pair.liquidity?.usd || 0,
    volume1hUsd: pair.volume?.h1 || 0,
    volume24hUsd: pair.volume?.h24 || 0,
    priceChange5m: pair.priceChange?.m5 || 0,
    priceChange1h: pair.priceChange?.h1 || 0,
    priceChange6h: pair.priceChange?.h6 || 0,
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
