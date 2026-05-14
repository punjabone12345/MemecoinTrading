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

  return `You are an expert Solana memecoin trader. Analyse this token and decide whether to open a paper trade.

TOKEN DATA
───────────────────────────────
Name / Symbol   : ${t.name} / $${t.symbol}
DEX             : ${t.dexId}
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
Analyse ENTRY TIMING — is this an early-stage pump or already distributed/topped?

Required JSON format:
{
  "verdict": "TRADE" | "SKIP" | "RISKY",
  "confidence": <0-100>,
  "reasoning": "<1-2 sentences max>",
  "risks": ["<concise risk 1>", "<concise risk 2>"],
  "strengths": ["<concise strength 1>", "<concise strength 2>"]
}

Verdict guide:
  TRADE  — strong early signal, good risk/reward, proceed
  RISKY  — some red flags but potential; tighter SL will be applied automatically
  SKIP   — likely late entry, distribution, rug signal, or poor risk/reward`;
}

// ─── Safe JSON parser — never throws, strips markdown fences ──────────────────

function parseJsonVerdict(raw: string): Omit<LlmAnalysis, "provider" | "durationMs"> | null {
  try {
    // Strip markdown code fences if the model wraps the response
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    // Some models emit extra text before/after the JSON object — extract the first {...}
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

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
  } catch {
    return null;
  }
}

// ─── Retry helper with exponential backoff + AbortController timeout ───────────

const AI_TIMEOUT_MS = 10_000; // hard 10 s cap per attempt

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs = AI_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
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

async function callGemini(prompt: string): Promise<string> {
  const hasIntegration = Boolean(process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"]);
  const hasDirectKey   = Boolean(process.env["GEMINI_API_KEY"]);
  if (!hasIntegration && !hasDirectKey) throw new Error("No Gemini credentials configured");

  return withRetry(async () => {
    return withTimeout(async (_signal) => {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          temperature: 0.1,
          maxOutputTokens: 512,
          // Force JSON-only output — eliminates markdown wrapping
          responseMimeType: "application/json",
        },
      });
      const text = response.text ?? "";
      if (!text) throw new Error("Gemini returned empty response");
      return text;
    });
  }, 2, "gemini");
}

// ─── Groq (fallback) ──────────────────────────────────────────────────────────

async function callGroq(prompt: string): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  return withRetry(async () => {
    return withTimeout(async (signal) => {
      const res = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: "You are an expert Solana memecoin trader. Always respond with ONLY valid JSON — no markdown, no extra text, no code fences.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          max_tokens: 300,
          response_format: { type: "json_object" }, // Forces strict JSON from Groq
        },
        {
          timeout: AI_TIMEOUT_MS,
          signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        },
      );
      const text: string = res.data?.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("Groq returned empty response");
      return text;
    });
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

// ─── Main export ──────────────────────────────────────────────────────────────

export async function analyseTokenWithAi(input: TokenAnalysisInput): Promise<LlmAnalysis> {
  const start = Date.now();
  const prompt = buildPrompt(input);

  // ── Try Gemini (up to 2 retries, 10 s timeout per attempt) ──────────────────
  try {
    const raw = await callGemini(prompt);
    const parsed = parseJsonVerdict(raw);
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "gemini", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, durationMs: result.durationMs },
        "AI analysis: Gemini verdict",
      );
      return result;
    }
    throw new Error("Gemini JSON parse failed even after retries");
  } catch (geminiErr) {
    logger.warn({ err: (geminiErr as Error).message, symbol: input.symbol }, "AI analysis: Gemini failed — trying Groq");
  }

  // ── Fallback: Groq (up to 2 retries, 10 s timeout per attempt) ──────────────
  try {
    const raw = await callGroq(prompt);
    const parsed = parseJsonVerdict(raw);
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "groq", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, durationMs: result.durationMs },
        "AI analysis: Groq verdict",
      );
      return result;
    }
    throw new Error("Groq JSON parse failed even after retries");
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
