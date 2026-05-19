import axios from "axios";
import { logger } from "../lib/logger.js";
import type { DexScreenerPair } from "../types/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LlmVerdict = "TRADE" | "SKIP" | "RISKY";

export interface LlmAnalysis {
  verdict: LlmVerdict;
  confidence: number;       // 0–100
  reasoning: string;        // 1–2 sentence summary
  risks: string[];
  strengths: string[];
  provider: "gemini" | "groq" | "none";
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
  aiScore: number;          // our quantitative score (context for the LLM)
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

// ─── JSON parser (robust — strips markdown code fences if present) ─────────────

function parseJsonVerdict(raw: string): Omit<LlmAnalysis, "provider" | "durationMs"> | null {
  try {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    const obj = JSON.parse(cleaned) as {
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

// ─── Gemini (primary) ─────────────────────────────────────────────────────────

async function callGemini(prompt: string, timeoutMs: number): Promise<string> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 300,
        responseMimeType: "application/json",
      },
    },
    { timeout: timeoutMs },
  );

  const text: string = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

// ─── Groq (fallback) ──────────────────────────────────────────────────────────

async function callGroqModel(prompt: string, model: string, timeoutMs: number): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model,
      messages: [
        {
          role: "system",
          content: "You are an expert Solana memecoin trader. Always respond with valid JSON only — no markdown, no extra text.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: "json_object" },
    },
    {
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    },
  );

  const text: string = res.data?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Groq returned empty response");
  return text;
}

// ─── Main export: analyse a token with LLM before trading ────────────────────

const GEMINI_TIMEOUT_MS      = 3_000;   // fail fast — quota errors respond quickly
const GROQ_FAST_TIMEOUT_MS   = 8_000;   // llama-3.1-8b-instant — very fast model
const GROQ_FALLBACK_TIMEOUT_MS = 12_000; // llama-3.3-70b-versatile — slower but smarter

export async function analyseTokenWithAi(input: TokenAnalysisInput): Promise<LlmAnalysis> {
  const start = Date.now();
  const prompt = buildPrompt(input);

  // ── Try Gemini first (fast fail — quota errors come back in <1s) ────────────
  try {
    const raw = await callGemini(prompt, GEMINI_TIMEOUT_MS);
    const parsed = parseJsonVerdict(raw);
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "gemini", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, durationMs: result.durationMs },
        "AI analysis: Gemini verdict",
      );
      return result;
    }
    throw new Error("Gemini JSON parse failed");
  } catch (geminiErr) {
    logger.warn({ err: (geminiErr as Error).message, symbol: input.symbol }, "AI analysis: Gemini failed — trying Groq fast");
  }

  // ── Groq primary: llama-3.1-8b-instant (very fast, ~1-2s) ───────────────────
  try {
    const raw = await callGroqModel(prompt, "llama-3.1-8b-instant", GROQ_FAST_TIMEOUT_MS);
    const parsed = parseJsonVerdict(raw);
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "groq", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, model: "8b-instant", durationMs: result.durationMs },
        "AI analysis: Groq (8b-instant) verdict",
      );
      return result;
    }
    throw new Error("Groq 8b JSON parse failed");
  } catch (groqFastErr) {
    logger.warn({ err: (groqFastErr as Error).message, symbol: input.symbol }, "AI analysis: Groq 8b-instant failed — trying 70b fallback");
  }

  // ── Groq fallback: llama-3.3-70b-versatile (smarter, slower) ────────────────
  try {
    const raw = await callGroqModel(prompt, "llama-3.3-70b-versatile", GROQ_FALLBACK_TIMEOUT_MS);
    const parsed = parseJsonVerdict(raw);
    if (parsed) {
      const result: LlmAnalysis = { ...parsed, provider: "groq", durationMs: Date.now() - start };
      logger.info(
        { symbol: input.symbol, verdict: result.verdict, confidence: result.confidence, model: "70b-versatile", durationMs: result.durationMs },
        "AI analysis: Groq (70b-versatile) verdict",
      );
      return result;
    }
    throw new Error("Groq 70b JSON parse failed");
  } catch (groqErr) {
    logger.warn({ err: (groqErr as Error).message, symbol: input.symbol }, "AI analysis: all LLM providers failed — failing closed");
  }

  // ── Both failed — fail CLOSED (never trade without LLM confirmation) ─────────
  // Failing open caused real losses: bad AI = bad trades. Require LLM verdict.
  return {
    verdict: "SKIP",
    confidence: 0,
    reasoning: "AI analysis unavailable (Gemini + Groq both failed). Skipping to protect capital.",
    risks: ["No LLM confirmation available"],
    strengths: [],
    provider: "none",
    durationMs: Date.now() - start,
  };
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
