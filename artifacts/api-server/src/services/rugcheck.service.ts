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
]);

async function fetchReport(mintAddress: string): Promise<RugCheckReport | null> {
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
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
 * Hard blocks:
 *   • Token already marked as rugged
 *   • Mint authority active (creator can inflate supply)
 *   • Freeze authority active (creator can freeze wallets)
 *   • Any "danger" level risk from RugCheck
 *   • LP entirely unlocked (0%) on a pair under 60 minutes old
 *   • Single non-DEX holder owns >30% of supply
 *   • Insider trading graph detected with >3 wallets
 *   • Overall risk score > 700
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
    logger.warn({ mintAddress }, "RugCheck: API unavailable — skipping safety check");
    return {
      pass: true,
      reason: "RugCheck unavailable — check skipped",
      score: 0,
      mintAuthority: null,
      freezeAuthority: null,
      lpLockedPct: 0,
      topHolderPct: 0,
      dangerRisks: [],
      warnRisks: [],
      rugged: false,
    };
  }

  const score = report.score ?? 0;
  const mintAuthority = report.mintAuthority ?? report.token?.mintAuthority ?? null;
  const freezeAuthority = report.freezeAuthority ?? report.token?.freezeAuthority ?? null;
  const rugged = report.rugged ?? false;

  const risks = report.risks ?? [];
  const dangerRisks = risks.filter((r) => r.level === "danger").map((r) => r.name);
  const warnRisks = risks.filter((r) => r.level === "warn").map((r) => r.name);

  const lpLockedPct = (report.markets ?? []).reduce((best, m) => {
    const pct = m.lp?.lpLockedPct ?? 0;
    return pct > best ? pct : best;
  }, 0);

  const topHolderPct = (report.topHolders ?? [])
    .filter((h) => !KNOWN_SAFE_HOLDERS.has(h.address))
    .reduce((max, h) => (h.pct > max ? h.pct : max), 0);

  const insiderCount = report.graphInsidersDetected ?? 0;

  const partial: Partial<RugCheckResult> = {
    score, mintAuthority, freezeAuthority, lpLockedPct,
    topHolderPct, dangerRisks, warnRisks, rugged,
  };

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

  if (dangerRisks.length > 0) {
    return fail(
      `RugCheck: DANGER risk(s) detected — ${dangerRisks.join(", ")}`,
      partial,
    );
  }

  if (lpLockedPct === 0 && pairAgeMinutes < 60) {
    return fail(
      `RugCheck: 0% LP locked on a ${Math.round(pairAgeMinutes)}m old pair — easy LP pull rug`,
      partial,
    );
  }

  if (topHolderPct > 30) {
    return fail(
      `RugCheck: single holder owns ${topHolderPct.toFixed(1)}% of supply — extreme concentration risk`,
      partial,
    );
  }

  if (insiderCount > 3) {
    return fail(
      `RugCheck: insider trading network detected (${insiderCount} wallets) — coordinated dump risk`,
      partial,
    );
  }

  if (score > 700) {
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
