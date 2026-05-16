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
  recommendedSizeSol?: number;
  llmScore?: number;
  llmRiskLevel?: string;
  secondaryVerdict?: string;
  secondaryProvider?: string;
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
// Pre-computes all 10 filter results from raw data and embeds ✓/✗ in the prompt.
// The AI only needs to count the marks and apply the scoring rule — no subjective
// judgment on data-driven checks. This makes verdicts fast, consistent, and
// resistant to model hallucination about numbers.

function buildPrompt(t: TokenAnalysisInput): string {
  const ageLabel = t.pairAgeMinutes < 60
    ? `${Math.round(t.pairAgeMinutes)}m`
    : `${(t.pairAgeMinutes / 60).toFixed(1)}h`;

  const total1h        = t.buys1h + t.sells1h;
  const buyRatio1h     = total1h > 0 ? t.buys1h / total1h : 0;
  const liqMcapRatio   = t.marketCapUsd > 0 ? t.liquidityUsd / t.marketCapUsd : 0;
  const fdvMcapRatio   = t.marketCapUsd > 0 && t.fdv > 0 ? t.fdv / t.marketCapUsd : 99;
  const vol1hAnnualized = t.volume1hUsd * 24;
  const tick = (v: boolean) => v ? "✓" : "✗";

  const f1  = vol1hAnnualized >= t.volume24hUsd * 2;
  const f2  = liqMcapRatio >= 0.12;
  const f3  = fdvMcapRatio <= 3;
  const f4  = buyRatio1h >= 0.62;
  const f5  = t.priceChange1h >= 18 && t.priceChange1h <= 90;
  const f6  = t.pairAgeMinutes >= 15 && t.pairAgeMinutes <= 1440;
  const f7  = t.volume24hUsd >= 35_000;
  const f8  = t.volume1hUsd >= 15_000;
  const f9  = t.marketCapUsd >= 50_000 && t.marketCapUsd <= 5_000_000;
  const f10 = t.txns24h >= 250;

  return `You are a Solana memecoin trade validator. Evaluate this token and output ONLY the result block.

TOKEN: ${t.name} ($${t.symbol}) | Age: ${ageLabel} | MCap: $${t.marketCapUsd.toLocaleString()} | AI Score: ${t.aiScore}/100
LIQUIDITY: $${t.liquidityUsd.toLocaleString()} | Liq/MCap: ${(liqMcapRatio * 100).toFixed(1)}%
VOLUME: 1h $${t.volume1hUsd.toLocaleString()} (×24=$${Math.round(vol1hAnnualized).toLocaleString()}) | 24h $${t.volume24hUsd.toLocaleString()}
MOMENTUM: 1h ${t.priceChange1h >= 0 ? "+" : ""}${t.priceChange1h.toFixed(1)}% | Buy ratio 1h: ${(buyRatio1h * 100).toFixed(0)}% | Txns 24h: ${t.txns24h}
STRUCTURE: FDV/MCap ${fdvMcapRatio.toFixed(2)}

10 FILTERS — count the ✓ marks:
1. Vol 1h ×24 ≥ 2× Vol 24h? (momentum accelerating)        ${tick(f1)}
2. Liq/MCap ≥ 0.12? (exit depth sufficient)                ${tick(f2)}
3. FDV/MCap ≤ 3? (no supply overhang)                      ${tick(f3)}
4. Buy ratio 1h ≥ 62%? (buyer majority)                    ${tick(f4)}
5. 1h change between 18% and 90%? (real pump, not stale)   ${tick(f5)}
6. Pair age 15m–24h? (survived rug window, not too old)    ${tick(f6)}
7. Vol 24h ≥ $35K? (proven trading activity)               ${tick(f7)}
8. Vol 1h ≥ $15K? (active right now)                       ${tick(f8)}
9. MCap $50K–$5M? (viable range)                           ${tick(f9)}
10. Txns 24h ≥ 250? (organic, not bot-only)                ${tick(f10)}

Scoring (count ONLY the ✓ marks shown above):
10/10 = PASS — Low Risk (0.5 SOL)
8–9/10 = PASS — Medium Risk (0.5 SOL)
7/10 = PASS — High Risk (0.25 SOL)
Below 7 = FAIL

Output EXACTLY this format, nothing else:
RESULT: PASS or FAIL
SCORE: X/10
RISK: Low or Medium or High
SIZE: 0.5 SOL or 0.25 SOL
REASON: one line`;
}

// ─── PASS/FAIL response parser ─────────────────────────────────────────────────

interface ParsedPassFail {
  passFailResult: "PASS" | "FAIL";
  llmScore: number;
  llmRiskLevel: string;
  recommendedSizeSol: number;
  reasoning: string;
}

function parsePassFailVerdict(raw: string, provider: string): ParsedPassFail | null {
  try {
    const lines = raw.trim().split("\n").map(l => l.trim()).filter(Boolean);

    const resultLine = lines.find(l => /^RESULT:/i.test(l));
    const scoreLine  = lines.find(l => /^SCORE:/i.test(l));
    const riskLine   = lines.find(l => /^RISK:/i.test(l));
    const sizeLine   = lines.find(l => /^SIZE:/i.test(l));
    const reasonLine = lines.find(l => /^REASON:/i.test(l));

    if (!resultLine) {
      logger.warn({ provider, rawPreview: raw.slice(0, 200) }, "AI: no RESULT line found in response");
      return null;
    }

    const passFailResult: "PASS" | "FAIL" = resultLine.toUpperCase().includes("PASS") ? "PASS" : "FAIL";

    const scoreMatch  = scoreLine?.match(/(\d+)/);
    const llmScore    = scoreMatch ? Math.min(10, Math.max(0, parseInt(scoreMatch[1], 10))) : 0;

    const riskRaw     = riskLine?.replace(/^RISK:/i, "").trim() ?? "High";
    const llmRiskLevel = ["Low", "Medium", "High"].find(
      r => riskRaw.toLowerCase().includes(r.toLowerCase()),
    ) ?? "High";

    const recommendedSizeSol = sizeLine?.includes("0.25") ? 0.25 : 0.5;

    const reasoning = reasonLine
      ? reasonLine.replace(/^REASON:/i, "").trim().slice(0, 200)
      : "No reason provided.";

    return { passFailResult, llmScore, llmRiskLevel, recommendedSizeSol, reasoning };
  } catch (e) {
    logger.warn({ provider, rawPreview: raw.slice(0, 300), err: (e as Error).message }, "AI: parsePassFailVerdict failed");
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

// ─── Gemini ───────────────────────────────────────────────────────────────────

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
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const response = await withTimeout(geminiCall);
    const text = response.text ?? "";
    if (!text) throw new Error("Gemini returned empty response");
    return text;
  }, 2, "gemini");
}

// ─── Groq ─────────────────────────────────────────────────────────────────────

async function callGroq(prompt: string): Promise<string> {
  const apiKey = process.env["GROQ_API_KEY"];
  if (!apiKey) throw new Error("GROQ_API_KEY not set");

  return withRetry(async () => {
    const res = await withTimeout(
      axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "llama-3.3-70b-versatile",
          messages: [
            {
              role: "system",
              content: "You are a Solana memecoin trade validator. Output ONLY the result block in the exact format specified. No extra text.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
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
    if (!text) throw new Error("Groq returned empty response");
    return text;
  }, 2, "groq");
}

// ─── Heuristic fallback ──────────────────────────────────────────────────────
// Runs when ALL LLM providers fail. Never blocks a trade just because AI is down.

function heuristicFallback(input: TokenAnalysisInput): Omit<LlmAnalysis, "provider" | "durationMs"> {
  let score = 0;
  const strengths: string[] = [];
  const risks: string[] = [];

  if (input.liquidityUsd > 30_000) { score += 25; strengths.push(`Liq $${Math.round(input.liquidityUsd / 1_000)}K`); }
  else risks.push(`Low liq $${Math.round(input.liquidityUsd / 1_000)}K`);

  if (input.volume24hUsd > 500_000) { score += 25; strengths.push(`24h vol $${Math.round(input.volume24hUsd / 1_000)}K`); }
  else if (input.volume24hUsd > 35_000) { score += 12; strengths.push(`24h vol $${Math.round(input.volume24hUsd / 1_000)}K`); }
  else risks.push(`Low 24h vol $${Math.round(input.volume24hUsd / 1_000)}K`);

  if (input.pairAgeMinutes < 120) { score += 20; strengths.push(`Fresh ${Math.round(input.pairAgeMinutes)}m`); }
  else if (input.pairAgeMinutes > 1440) risks.push("Pair >24h old");

  const total1h = input.buys1h + input.sells1h;
  const buyRatio = total1h > 0 ? input.buys1h / total1h : 0;
  if (buyRatio >= 0.62) { score += 15; strengths.push(`Buy pressure ${(buyRatio * 100).toFixed(0)}%`); }
  else risks.push(`Weak buy ratio ${(buyRatio * 100).toFixed(0)}%`);

  if (input.txns24h >= 250) { score += 15; strengths.push(`${input.txns24h} txns 24h`); }
  else risks.push(`Low activity ${input.txns24h} txns`);

  score = Math.min(100, score);
  const verdict: LlmVerdict = score >= 65 ? "TRADE" : score >= 40 ? "RISKY" : "SKIP";

  return {
    verdict,
    confidence: score,
    reasoning: `Heuristic (AI unavailable): score ${score}/100.`,
    risks: risks.slice(0, 3),
    strengths: strengths.slice(0, 3),
    recommendedSizeSol: score >= 65 ? 0.5 : 0.25,
    llmScore: Math.round(score / 10),
    llmRiskLevel: score >= 80 ? "Low" : score >= 65 ? "Medium" : "High",
  };
}

// ─── Startup env check ────────────────────────────────────────────────────────
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
// Dual-AI validation: Gemini + Groq called in PARALLEL.
//
// Combined verdict:
//   Gemini PASS + Groq PASS (or N/A)  →  TRADE at AI-recommended size
//   Gemini PASS + Groq FAIL            →  RISKY at 0.25 SOL (reduced conviction)
//   Gemini FAIL (regardless of Groq)   →  SKIP
//   Gemini unavailable                 →  Groq alone or heuristic fallback

export async function analyseTokenWithAi(input: TokenAnalysisInput): Promise<LlmAnalysis> {
  const start = Date.now();

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
    logger.error({ symbol: input.symbol, err: (promptErr as Error).message }, "AI analysis: buildPrompt crashed — using heuristic");
    const h = heuristicFallback(input);
    return { ...h, provider: "heuristic", durationMs: Date.now() - start };
  }

  // ── Fire both AI calls in parallel ────────────────────────────────────────
  const [geminiSettled, groqSettled] = await Promise.allSettled([
    (hasGeminiIntegration || hasGeminiDirectKey)
      ? callGemini(prompt)
      : Promise.reject(new Error("Gemini not configured")),
    hasGroqKey
      ? callGroq(prompt)
      : Promise.reject(new Error("Groq not configured")),
  ]);

  const geminiParsed = geminiSettled.status === "fulfilled"
    ? parsePassFailVerdict(geminiSettled.value, "gemini")
    : null;

  const groqParsed = groqSettled.status === "fulfilled"
    ? parsePassFailVerdict(groqSettled.value, "groq")
    : null;

  // groqAvailable = key is set (even if request failed — key present means it's a validator)
  const groqAvailable = hasGroqKey;

  logger.info(
    {
      symbol: input.symbol,
      gemini: geminiParsed
        ? `${geminiParsed.passFailResult} ${geminiParsed.llmScore}/10`
        : geminiSettled.status === "rejected"
          ? `ERR: ${(geminiSettled.reason as Error).message?.slice(0, 60)}`
          : "parse_fail",
      groq: groqParsed
        ? `${groqParsed.passFailResult} ${groqParsed.llmScore}/10`
        : groqAvailable ? "fail/parse_fail" : "N/A",
      durationMs: Date.now() - start,
    },
    "AI analysis: dual verdict",
  );

  // ── No Gemini result → try Groq alone, then heuristic ─────────────────────
  if (!geminiParsed) {
    if (groqParsed) {
      const verdict: LlmVerdict = groqParsed.passFailResult === "PASS" ? "TRADE" : "SKIP";
      logger.info({ symbol: input.symbol, verdict, groqScore: groqParsed.llmScore }, "AI analysis: Groq-only verdict (Gemini failed)");
      return {
        verdict,
        confidence: groqParsed.llmScore * 10,
        reasoning: groqParsed.reasoning,
        risks: [], strengths: [],
        provider: "groq",
        durationMs: Date.now() - start,
        recommendedSizeSol: groqParsed.recommendedSizeSol,
        llmScore: groqParsed.llmScore,
        llmRiskLevel: groqParsed.llmRiskLevel,
        secondaryVerdict: "N/A",
        secondaryProvider: "N/A",
      };
    }
    const h = heuristicFallback(input);
    logger.warn({ symbol: input.symbol }, "AI analysis: both Gemini and Groq failed — heuristic fallback");
    return { ...h, provider: "heuristic", durationMs: Date.now() - start };
  }

  // ── Combined verdict logic ─────────────────────────────────────────────────
  const geminiPass = geminiParsed.passFailResult === "PASS";
  const groqPass   = groqParsed?.passFailResult === "PASS";

  let verdict: LlmVerdict;
  let recommendedSizeSol: number;

  if (geminiPass && (!groqAvailable || groqPass)) {
    verdict = "TRADE";
    recommendedSizeSol = geminiParsed.recommendedSizeSol ?? 0.5;
  } else if (geminiPass && groqAvailable && groqParsed && !groqPass) {
    // Gemini PASS but Groq FAIL → lower conviction, half size
    verdict = "RISKY";
    recommendedSizeSol = 0.25;
  } else {
    // Gemini FAIL → skip regardless
    verdict = "SKIP";
    recommendedSizeSol = 0;
  }

  const durationMs = Date.now() - start;
  logger.info(
    {
      symbol: input.symbol,
      verdict,
      geminiScore: geminiParsed.llmScore,
      groqScore: groqParsed?.llmScore ?? "N/A",
      recommendedSizeSol,
      durationMs,
    },
    "AI analysis: verdict resolved",
  );

  return {
    verdict,
    confidence: geminiParsed.llmScore * 10,
    reasoning: geminiParsed.reasoning,
    risks: [],
    strengths: [],
    provider: "gemini",
    durationMs,
    recommendedSizeSol,
    llmScore: geminiParsed.llmScore,
    llmRiskLevel: geminiParsed.llmRiskLevel,
    secondaryVerdict: groqAvailable && groqParsed ? groqParsed.passFailResult : "unavailable",
    secondaryProvider: groqAvailable ? "groq" : "unavailable",
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
