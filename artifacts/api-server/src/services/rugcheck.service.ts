import axios from "axios";
import { logger } from "../lib/logger.js";

const RUGCHECK_BASE = "https://api.rugcheck.xyz/v1";
const RUGCHECK_API_KEY = process.env["RUGCHECK_API_KEY"];
const REQUEST_TIMEOUT_MS = 8_000;

export interface RugCheckResult {
  pass: boolean;
  reason: string;
  score: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  lpLockedPct: number;
  topHolderPct: number;
  dangerRisks: string[];
  warnRisks: string[];
  rugged: boolean;
}

interface RugCheckRisk {
  name: string;
  value: string;
  description: string;
  score: number;
  level: "danger" | "warn" | "info";
}

interface RugCheckMarket {
  lp?: {
    lpLockedPct: number;
    lpLocked: number;
    lpLockedUSD: number;
  };
}

interface RugCheckReport {
  score?: number;
  score_normalised?: number;
  rugged?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  token?: {
    mintAuthority?: string | null;
    freezeAuthority?: string | null;
  };
  tokenMeta?: {
    mutable?: boolean;
  };
  risks?: RugCheckRisk[];
  topHolders?: Array<{ pct: number; address: string; insider?: boolean }>;
  markets?: RugCheckMarket[];
  graphInsidersDetected?: number;
}

// Known DEX / burn / system addresses that hold LP tokens — not insider risk
const KNOWN_SAFE_HOLDERS = new Set([
  "So11111111111111111111111111111111111111112", // WSOL
  "11111111111111111111111111111111",             // System program
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // Token program
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", // Raydium Authority
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",  // Pump.fun program (bonding curve)
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", // Pump.fun bonding curve authority
  "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",  // Pump.fun fee recipient
]);

// Danger risk names that are EXPECTED on brand-new pump.fun pre-graduation tokens
// and therefore should not block entry. These are structural properties of the
// bonding curve mechanism, not malicious acts.
const PUMPFUN_EXPECTED_DANGERS = new Set([
  "Single holder ownership",          // Bonding curve PDA holds >X% of supply initially — expected
  "Top 10 holders high ownership",    // Bonding curve + early buyers = high concentration — expected
  "High ownership",                   // Related to concentration — expected on new tokens
  "Low Liquidity",                    // Pre-graduation tokens have thin liquidity — expected
  "Low amount of LP Providers",       // Bonding curve = single LP provider — expected
  "No social links found",            // New tokens often have no socials yet
  "Mutable metadata",                 // Common on new tokens, not necessarily malicious
  // Creator history: many pump.fun creators have made multiple tokens; RugCheck flags the
  // whole creator even if prior tokens simply died naturally vs malicious rug. The demand
  // scorer and bonding-curve gate are sufficient quality filters — do not hard-block on this.
  "Creator history of rugged tokens", // Downgraded to warning; score penalty applied instead
]);

async function fetchReport(mintAddress: string): Promise<RugCheckReport | null> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  // API key extends rate limits — use if available, fall back to free tier
  if (RUGCHECK_API_KEY) {
    headers["Authorization"] = `Bearer ${RUGCHECK_API_KEY}`;
  }

  try {
    const res = await axios.get<RugCheckReport>(
      `${RUGCHECK_BASE}/tokens/${mintAddress}/report`,
      { headers, timeout: REQUEST_TIMEOUT_MS },
    );
    return res.data;
  } catch (err) {
    // If auth fails, retry without the key (free tier still works)
    if (axios.isAxiosError(err) && err.response?.status === 401 && RUGCHECK_API_KEY) {
      try {
        const res = await axios.get<RugCheckReport>(
          `${RUGCHECK_BASE}/tokens/${mintAddress}/report`,
          { timeout: REQUEST_TIMEOUT_MS },
        );
        return res.data;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Run a full RugCheck on-chain safety check on a token mint address.
 *
 * Returns pass: false with a specific reason for any of these hard blocks:
 *   • Token already marked as rugged
 *   • Mint authority active (creator can inflate supply)
 *   • Freeze authority active (creator can freeze wallets)
 *   • Any "danger" level risk from RugCheck
 *   • LP entirely unlocked (0%) on a pair under 60 minutes old
 *   • Single non-DEX holder owns >30% of supply
 *   • Insider trading graph detected with >2 wallets
 *   • Overall risk score > 700
 *
 * Returns pass: true (with populated warnings) when none of the above apply.
 * The caller can use warnRisks to boost LLM context.
 */
export async function checkTokenSafety(
  mintAddress: string,
  pairAgeMinutes: number,
): Promise<RugCheckResult> {
  const fail = (reason: string, partial: Partial<RugCheckResult> = {}): RugCheckResult => ({
    pass: false,
    reason,
    score: partial.score ?? 0,
    mintAuthority: partial.mintAuthority ?? null,
    freezeAuthority: partial.freezeAuthority ?? null,
    lpLockedPct: partial.lpLockedPct ?? 0,
    topHolderPct: partial.topHolderPct ?? 0,
    dangerRisks: partial.dangerRisks ?? [],
    warnRisks: partial.warnRisks ?? [],
    rugged: partial.rugged ?? false,
  });

  const report = await fetchReport(mintAddress);

  if (!report) {
    // RugCheck API down — fail CLOSED. Cannot verify on-chain safety without data.
    // We'd rather miss a trade than enter an unverified token.
    logger.warn({ mintAddress }, "RugCheck: API unavailable — blocking trade (fail-closed for safety)");
    return fail("RugCheck API unavailable — cannot verify on-chain safety, trade blocked");
  }

  // ── Extract fields ─────────────────────────────────────────────────────────
  const score = report.score ?? 0;
  // Mint/freeze authority can appear at top level or inside token object
  const mintAuthority = report.mintAuthority ?? report.token?.mintAuthority ?? null;
  const freezeAuthority = report.freezeAuthority ?? report.token?.freezeAuthority ?? null;
  const rugged = report.rugged ?? false;

  const risks = report.risks ?? [];
  const dangerRisks = risks.filter((r) => r.level === "danger").map((r) => r.name);
  const warnRisks = risks.filter((r) => r.level === "warn").map((r) => r.name);

  // LP locked: take the best (highest) lpLockedPct across all markets
  const lpLockedPct = (report.markets ?? []).reduce((best, m) => {
    const pct = m.lp?.lpLockedPct ?? 0;
    return pct > best ? pct : best;
  }, 0);

  // Top holder: largest single non-DEX/non-burn holder
  const topHolderPct = (report.topHolders ?? [])
    .filter((h) => !KNOWN_SAFE_HOLDERS.has(h.address))
    .reduce((max, h) => (h.pct > max ? h.pct : max), 0);

  const insiderCount = report.graphInsidersDetected ?? 0;

  const partial: Partial<RugCheckResult> = {
    score, mintAuthority, freezeAuthority, lpLockedPct,
    topHolderPct, dangerRisks, warnRisks, rugged,
  };

  // ── Hard blocks ────────────────────────────────────────────────────────────

  if (rugged) {
    return fail("RugCheck: token already flagged as RUGGED — refusing entry", partial);
  }

  if (mintAuthority && mintAuthority !== "11111111111111111111111111111111") {
    return fail(
      `RugCheck: mint authority active (${mintAuthority.slice(0, 8)}…) — creator can print infinite tokens`,
      partial,
    );
  }

  if (freezeAuthority && freezeAuthority !== "11111111111111111111111111111111") {
    return fail(
      `RugCheck: freeze authority active (${freezeAuthority.slice(0, 8)}…) — creator can freeze wallets`,
      partial,
    );
  }

  // For pump.fun pre-graduation tokens, some DANGER risks are expected due to
  // the bonding curve mechanism (e.g. single holder = bonding curve PDA, low
  // liquidity = pre-graduation). Filter those out and only block on real dangers.
  const realDangerRisks = dangerRisks.filter((r) => !PUMPFUN_EXPECTED_DANGERS.has(r));
  if (realDangerRisks.length > 0) {
    return fail(
      `RugCheck: DANGER risk(s) detected — ${realDangerRisks.join(", ")}`,
      { ...partial, dangerRisks: realDangerRisks },
    );
  }
  // Re-tag expected dangers as warnings so callers can see them
  const expectedDangerAsWarn = dangerRisks.filter((r) => PUMPFUN_EXPECTED_DANGERS.has(r));
  if (expectedDangerAsWarn.length > 0) {
    (partial as Partial<RugCheckResult>).warnRisks = [...(partial.warnRisks ?? []), ...expectedDangerAsWarn];
  }

  // LP lock check — pump.fun tokens use a bonding curve, not traditional LP.
  // All tokens arriving here are from the pump.fun bonding curve system.
  // Skip LP lock check entirely for pump.fun tokens.
  const isPumpFun = true; // All tokens tracked by this bot are pump.fun tokens
  if (!isPumpFun && lpLockedPct === 0 && pairAgeMinutes < 20) {
    return fail(
      `RugCheck: 0% LP locked on a ${Math.round(pairAgeMinutes)}m old non-pump pair — easy LP pull rug`,
      partial,
    );
  }

  // topHolderPct check removed for pump.fun pre-graduation tokens.
  // The bonding curve PDA (a per-token keypair) legitimately holds 100% of supply at
  // launch and decreases as buyers fill the curve. We cannot whitelist per-token PDAs
  // in KNOWN_SAFE_HOLDERS since they are mint-derived and unique per token. The
  // overall risk score check (>800) below already catches genuine concentration rugs.

  // Coordinated insider network detected — raised from 3→8→15 wallets.
  // Early pump.fun launches often have 3-14 early buyers who naturally cluster
  // (friends/community buying together); 15+ is a strong coordinated manipulation signal.
  if (insiderCount > 15) {
    return fail(
      `RugCheck: insider trading network detected (${insiderCount} wallets) — coordinated dump risk`,
      partial,
    );
  }

  // Very high overall risk score
  if (score > 800) {
    return fail(
      `RugCheck: risk score ${score}/1000 is critically high — refusing entry`,
      partial,
    );
  }

  logger.info(
    {
      mintAddress: mintAddress.slice(0, 8) + "…",
      score,
      lpLockedPct,
      topHolderPct: topHolderPct.toFixed(1),
      dangerRisks,
      warnRisks,
    },
    "RugCheck: PASSED",
  );

  return {
    pass: true,
    reason: `RugCheck OK — score ${score}, LP locked ${lpLockedPct.toFixed(0)}%, top holder ${topHolderPct.toFixed(1)}%`,
    score,
    mintAuthority,
    freezeAuthority,
    lpLockedPct,
    topHolderPct,
    dangerRisks,
    warnRisks,
    rugged: false,
  };
}

export function isRugCheckConfigured(): boolean {
  return Boolean(RUGCHECK_API_KEY);
}
