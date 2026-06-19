import axios from "axios";
import { logger } from "../lib/logger.js";

const DEXSCREENER_BASE   = "https://api.dexscreener.com";
const LAMPORTS_PER_SOL   = 1_000_000_000;

// ── Public interface ─────────────────────────────────────────────────────────

export interface QualityMetrics {
  // Raw collected data
  liquiditySol:      number;
  marketCapUsd:      number;
  uniqueBuyers:      number;
  buyPressureRatio:  number;
  topHolderPct:      number;
  creatorHoldingsPct: number;
  whaleDetected:     boolean;

  // Dimension scores (0 | 15 | 20 | 25)
  liquidityScore:    number;
  buyerScore:        number;
  buyPressureScore:  number;
  holderScore:       number;
  totalScore:        number;

  // Entry decision
  positionMultiplier: number;   // 0=skip  0.5=low  0.75=mid  1.0=high
  autoSkipReason:     string | null;

  // Timing
  dataCollectionMs: number;
}

// ── Service ──────────────────────────────────────────────────────────────────

class TokenQualityService {
  async collectQualityData(
    mint:             string,
    symbol:           string,
    poolPda:          string | null,
    initialSolReserves: number,
    heliusApiKey:     string | null,
  ): Promise<QualityMetrics> {
    const t0     = Date.now();
    const rpcUrl = heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : null;

    logger.info(
      { mint, symbol, initialSolReserves: initialSolReserves.toFixed(2) },
      "Quality: starting 60s parallel data collection ⏱",
    );

    // Fire all three collection paths simultaneously — each has its own
    // internal timing and waits so they finish at different points within 60s.
    const [dexResult, holderResult, buyerResult] = await Promise.all([
      this.pollDexScreener(mint),
      rpcUrl ? this.fetchHolderData(mint, rpcUrl) : Promise.resolve(null),
      (heliusApiKey && poolPda)
        ? this.fetchBuyerData(mint, poolPda, heliusApiKey)
        : Promise.resolve(null),
    ]);

    // ── Aggregate raw metrics ────────────────────────────────────────────────
    // On-chain liquidity (exact) beats DexScreener estimate; DexScreener is
    // only used when wsolVaultPubkey was unavailable during processGraduation.
    const liquiditySol = initialSolReserves > 0
      ? initialSolReserves
      : (dexResult && dexResult.liquidityUsd > 0 ? dexResult.liquidityUsd / 150 : 0);

    const marketCapUsd     = dexResult?.fdv            ?? 0;
    const buyPressureRatio = dexResult?.buyPressureRatio ?? 1.0;
    const whaleDetected    = buyerResult?.whaleDetected ?? false;

    // ── Unique buyer count — track data availability ─────────────────────────
    // buyerResult === null  → Helius unavailable (API key missing or pool not indexed)
    // buyerResult.uniqueBuyers === 0 with confident=false → no sigs found (not indexed yet)
    // In both "no data" cases we fall back to DexScreener m5Buys; if that is also
    // 0 at this early stage, we treat unique buyers as UNKNOWN (neutral, not a hard fail).
    const buyerDataAvailable = buyerResult !== null && buyerResult.confident;
    const dexM5Buys = dexResult?.m5Buys ?? 0;
    const uniqueBuyers = buyerDataAvailable
      ? (buyerResult?.uniqueBuyers ?? 0)
      : (dexM5Buys > 0 ? dexM5Buys : -1); // -1 = unknown

    // Conservative fallback: if holder data unavailable assume 100% (auto-skip)
    const topHolderPct      = holderResult?.topHolderPct      ?? 0; // 0 = unknown = don't auto-skip on unknown
    const creatorHoldingsPct = holderResult?.creatorHoldingsPct ?? 0;

    // Cross-validation log: both sources for debugging
    logger.info({
      mint, symbol,
      onChainSolReserves: initialSolReserves.toFixed(2),
      dexLiquidityUsd:    dexResult?.liquidityUsd?.toFixed(0) ?? "n/a",
      dexLiquiditySol:    dexResult ? (dexResult.liquidityUsd / 150).toFixed(1) : "n/a",
      resolvedLiqSol:     liquiditySol.toFixed(1),
      heliusBuyers:       buyerResult?.uniqueBuyers ?? "n/a",
      dexM5Buys,
      resolvedBuyers:     uniqueBuyers === -1 ? "unknown" : uniqueBuyers,
    }, "Quality: cross-validation snapshot 🔍");

    // ── Score each dimension (25 pts each, 100 pts total) ───────────────────
    const liquidityScore   = this.scoreLiquidity(liquiditySol);
    const buyerScore       = uniqueBuyers === -1
      ? 15   // neutral (15) when buyer data unavailable — don't penalise unknown
      : this.scoreBuyers(uniqueBuyers);
    const buyPressureScore = this.scoreBuyPressure(buyPressureRatio);
    const holderScore      = topHolderPct > 0
      ? this.scoreHolder(topHolderPct)
      : 15; // neutral (15) when holder data unavailable — don't penalise or reward

    const totalScore = liquidityScore + buyerScore + buyPressureScore + holderScore;

    // Auto-skip on any hard-fail dimension (score = 0)
    // Spec: creator holdings >5% → skip (rug risk: creator holding reserves to dump)
    let autoSkipReason: string | null = null;
    if (creatorHoldingsPct > 5)
      autoSkipReason = `Creator holds ${creatorHoldingsPct.toFixed(1)}% — dump risk (>5% threshold)`;
    else if (liquidityScore   === 0) autoSkipReason = `Liquidity ${liquiditySol.toFixed(1)} SOL < 25 SOL minimum`;
    else if (uniqueBuyers !== -1 && buyerScore === 0) autoSkipReason = `Unique buyers ${uniqueBuyers} < 20 minimum`;
    else if (buyPressureScore === 0) autoSkipReason = `Buy pressure ${buyPressureRatio.toFixed(2)}x < 1.5x minimum`;
    else if (topHolderPct > 0 && holderScore === 0)
      autoSkipReason = `Top holder ${topHolderPct.toFixed(1)}% > 20% maximum`;

    // Position multiplier from total score
    let positionMultiplier = 0;
    if (!autoSkipReason) {
      if      (totalScore >= 90) positionMultiplier = 1.00;
      else if (totalScore >= 80) positionMultiplier = 0.75;
      else if (totalScore >= 70) positionMultiplier = 0.50;
    }

    const dataCollectionMs = Date.now() - t0;

    const result: QualityMetrics = {
      liquiditySol, marketCapUsd, uniqueBuyers, buyPressureRatio,
      topHolderPct, creatorHoldingsPct, whaleDetected,
      liquidityScore, buyerScore, buyPressureScore, holderScore, totalScore,
      positionMultiplier, autoSkipReason, dataCollectionMs,
    };

    logger.info({
      mint, symbol,
      score: `${totalScore}/100`,
      breakdown: `L:${liquidityScore} B:${buyerScore} P:${buyPressureScore} H:${holderScore}`,
      liquiditySol:     liquiditySol.toFixed(1),
      uniqueBuyers,
      buyPressureRatio: buyPressureRatio.toFixed(2),
      topHolderPct:     topHolderPct.toFixed(1),
      whaleDetected,
      multiplier:       positionMultiplier,
      skip:             autoSkipReason ?? "none",
      collectionMs:     dataCollectionMs,
    }, autoSkipReason
      ? `Quality: SKIP — ${autoSkipReason} ❌`
      : `Quality: ${totalScore}/100 → ENTER at ${(positionMultiplier * 100).toFixed(0)}% size ✅`);

    return result;
  }

  // ── Scoring rubrics (per spec) ────────────────────────────────────────────

  private scoreLiquidity(sol: number): number {
    if (sol >= 50) return 25;
    if (sol >= 35) return 20;
    if (sol >= 25) return 15;
    return 0;
  }

  private scoreBuyers(count: number): number {
    if (count >= 50) return 25;
    if (count >= 35) return 20;
    if (count >= 20) return 15;
    return 0;
  }

  private scoreBuyPressure(ratio: number): number {
    if (ratio >= 3.0) return 25;
    if (ratio >= 2.0) return 20;
    if (ratio >= 1.5) return 15;
    return 0;
  }

  private scoreHolder(topPct: number): number {
    if (topPct <  10) return 25;
    if (topPct <  15) return 20;
    if (topPct <  20) return 15;
    return 0;
  }

  // ── DexScreener polling (4 polls over ~45s) ───────────────────────────────
  // Fires at T=0, T=15s, T=30s, T=45s — captures the evolution of buy/sell
  // volume as the token gets indexed. Stops early once meaningful data arrives.
  private async pollDexScreener(mint: string): Promise<{
    liquidityUsd:    number;
    fdv:             number;
    buyPressureRatio: number;
    m5Buys:          number;
  } | null> {
    // best: only updated when we have a result with REAL liquidity (> $100)
    // This prevents a "token indexed but liquidity not yet calculated" ghost-0 from
    // locking in as a valid 0-liquidity result on all subsequent polls.
    let best: { liquidityUsd: number; fdv: number; buyPressureRatio: number; m5Buys: number } | null = null;
    let lastPairSeen: typeof best | null = null; // any result, even 0-liq

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 15_000));

      try {
        type DexPair = {
          priceUsd?:  string;
          liquidity?: { usd?: number };
          fdv?:       number;
          txns?:      { m5?: { buys?: number; sells?: number } };
          dexId?:     string;
        };
        const res = await axios.get<DexPair[]>(
          `${DEXSCREENER_BASE}/tokens/v1/solana/${mint}`,
          { timeout: 5_000 },
        );
        const pairs = Array.isArray(res.data) ? res.data : [];
        const pair  =
          pairs.find((p) => ["raydium", "pumpswap", "pump-amm", "pump_amm"].includes(p.dexId ?? ""))
          ?? pairs.find((p) => (parseFloat(p.priceUsd ?? "0") || 0) > 0);

        if (!pair) continue;

        const liqUsd  = pair.liquidity?.usd ?? 0;
        const m5      = pair.txns?.m5;
        const m5Buys  = m5?.buys  ?? 0;
        const m5Sells = m5?.sells ?? 0;
        const buyPressureRatio = m5Sells > 0
          ? m5Buys / m5Sells
          : (m5Buys > 0 ? 5.0 : 1.0);

        const candidate = { liquidityUsd: liqUsd, fdv: pair.fdv ?? 0, buyPressureRatio, m5Buys };
        lastPairSeen = candidate;

        // Only lock in as "best" when DexScreener has calculated real liquidity (> $100)
        // Avoids ghost-0 when the pool is indexed but AMM hasn't populated reserves yet.
        if (liqUsd > 100) {
          best = candidate;
          logger.debug({ mint, attempt, liqUsd: liqUsd.toFixed(0), m5Buys, m5Sells }, "Quality: DexScreener real-liq data ready");
          // Stop early once we also have real volume data
          if (m5Buys >= 5 || m5Sells >= 5) break;
        } else {
          logger.debug({ mint, attempt, liqUsd, m5Buys }, "Quality: DexScreener found pair but liq=0 — will retry");
        }
      } catch (err) {
        logger.debug({ mint, attempt, err: (err as Error).message }, "Quality: DexScreener poll failed");
      }
    }

    // Last resort: use whatever we saw even if liq=0 — better than null (still
    // gives us m5Buys as fallback for buyer count)
    return best ?? lastPairSeen;
  }

  // ── pump.fun creator wallet lookup ────────────────────────────────────────
  private async fetchCreatorWallet(mint: string): Promise<string | null> {
    try {
      type PumpCoin = { creator?: string; [k: string]: unknown };
      const res = await axios.get<PumpCoin>(
        `https://client-api-2-74b1891ee9f9.herokuapp.com/coins/${mint}`,
        { timeout: 5_000 },
      );
      return res.data?.creator ?? null;
    } catch {
      return null;
    }
  }

  // ── Helius RPC: top token holder % + creator holdings % ──────────────────
  // Wait 20s before querying — new tokens take 15-30s to appear in RPC indices.
  // Also fetches creator wallet from pump.fun API and checks their holdings %.
  private async fetchHolderData(
    mint:   string,
    rpcUrl: string,
  ): Promise<{ topHolderPct: number; creatorHoldingsPct: number } | null> {
    await new Promise<void>((r) => setTimeout(r, 20_000));

    try {
      type LargestAccount = { address?: string; uiAmount: number | null };
      type SupplyValue    = { uiAmount: number | null };

      // Fetch creator wallet + token largest accounts + supply in parallel
      const [creatorWallet, largestRes, supplyRes] = await Promise.all([
        this.fetchCreatorWallet(mint),
        axios.post<{ result?: { value?: LargestAccount[] } }>(rpcUrl, {
          jsonrpc: "2.0", id: 1,
          method: "getTokenLargestAccounts",
          params: [mint, { commitment: "confirmed" }],
        }, { timeout: 8_000 }),
        axios.post<{ result?: { value?: SupplyValue } }>(rpcUrl, {
          jsonrpc: "2.0", id: 2,
          method: "getTokenSupply",
          params: [mint, { commitment: "confirmed" }],
        }, { timeout: 8_000 }),
      ]);

      const accounts      = largestRes.data?.result?.value ?? [];
      const totalSupplyUi = supplyRes.data?.result?.value?.uiAmount ?? 0;

      if (accounts.length === 0 || totalSupplyUi <= 0) {
        logger.debug({ mint }, "Quality: holder RPC returned no data");
        return null;
      }

      const topUiAmount  = accounts[0]?.uiAmount ?? 0;
      const topHolderPct = (topUiAmount / totalSupplyUi) * 100;

      // Try to find creator's token account balance in the largest accounts list
      // The largest accounts API returns token accounts (ATAs), not wallet addresses.
      // We need to fetch the creator's ATA separately to get their balance.
      let creatorHoldingsPct = 0;
      if (creatorWallet) {
        try {
          // Derive creator's ATA and fetch balance
          type TokenAccountsResult = { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> };
          const ataRes = await axios.post<{ result?: TokenAccountsResult }>(rpcUrl, {
            jsonrpc: "2.0", id: 3,
            method: "getTokenAccountsByOwner",
            params: [
              creatorWallet,
              { mint },
              { encoding: "jsonParsed", commitment: "confirmed" },
            ],
          }, { timeout: 6_000 });
          const tokenAccounts = ataRes.data?.result?.value ?? [];
          const creatorBalance = tokenAccounts.reduce((sum, acc) => {
            const ui = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
            return sum + ui;
          }, 0);
          if (creatorBalance > 0 && totalSupplyUi > 0) {
            creatorHoldingsPct = (creatorBalance / totalSupplyUi) * 100;
          }
        } catch { /* non-fatal — leave creatorHoldingsPct = 0 */ }
      }

      logger.info(
        { mint, topHolderPct: topHolderPct.toFixed(1), creatorWallet: creatorWallet?.slice(0, 8), creatorHoldingsPct: creatorHoldingsPct.toFixed(1) },
        "Quality: holder data collected ✅",
      );
      return { topHolderPct, creatorHoldingsPct };
    } catch (err) {
      logger.debug({ mint, err: (err as Error).message }, "Quality: holder data fetch failed");
      return null;
    }
  }

  // ── Helius Enhanced Transactions: unique buyers + whale detection ──────────
  // Wait 25s before querying — Enhanced Transactions index new pool TXes within
  // 20-40s of confirmation.  poolPda is the PumpSwap pool address so we get
  // all swap transactions for this specific pool.
  private async fetchBuyerData(
    mint:     string,
    poolPda:  string,
    apiKey:   string,
  ): Promise<{ uniqueBuyers: number; whaleDetected: boolean; confident: boolean } | null> {
    await new Promise<void>((r) => setTimeout(r, 25_000));

    try {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

      const fetchSigs = async () => {
        type SigResult = { signature: string; err: unknown };
        const sigRes = await axios.post<{ result?: SigResult[] }>(rpcUrl, {
          jsonrpc: "2.0", id: 1,
          method: "getSignaturesForAddress",
          params: [poolPda, { limit: 100, commitment: "confirmed" }],
        }, { timeout: 8_000 });
        return (sigRes.data?.result ?? [])
          .filter((s) => !s.err)
          .map((s) => s.signature)
          .slice(0, 50);
      };

      // First attempt
      let sigs = await fetchSigs();

      // Retry once after 10s — brand-new pool may not be indexed yet at T+25s
      if (sigs.length === 0) {
        logger.debug({ mint, poolPda }, "Quality: no pool sigs at T+25s — retrying at T+35s");
        await new Promise<void>((r) => setTimeout(r, 10_000));
        sigs = await fetchSigs();
      }

      if (sigs.length === 0) {
        logger.warn({ mint, poolPda }, "Quality: no pool signatures after retry — buyer count unavailable (not indexed yet)");
        // Return null (not 0) so caller treats this as DATA UNAVAILABLE, not "0 buyers"
        return null;
      }

      // Parse via Helius Enhanced Transactions API
      type ParsedTx = {
        feePayer?:       string;
        tokenTransfers?: Array<{ mint?: string; toUserAccount?: string }>;
        nativeTransfers?: Array<{ fromUserAccount?: string; amount?: number }>;
      };

      const parseRes = await axios.post<ParsedTx[]>(
        `https://api.helius.xyz/v0/transactions?api-key=${apiKey}`,
        { transactions: sigs },
        { timeout: 15_000 },
      );

      const txs              = parseRes.data ?? [];
      const WHALE_LAMPORTS   = 2 * LAMPORTS_PER_SOL;
      const uniqueBuyerSet   = new Set<string>();
      let whaleDetected      = false;

      for (const tx of txs) {
        if (!tx.feePayer) continue;

        // A "buy" tx: this mint was transferred INTO the fee payer's account
        const isBuy = tx.tokenTransfers?.some(
          (t) => t.mint === mint && t.toUserAccount === tx.feePayer,
        );
        if (!isBuy) continue;

        uniqueBuyerSet.add(tx.feePayer);

        // Whale: fee payer sent > 2 SOL worth of native SOL
        const solOut = tx.nativeTransfers
          ?.filter((n) => n.fromUserAccount === tx.feePayer)
          .reduce((sum, n) => sum + (n.amount ?? 0), 0) ?? 0;
        if (solOut >= WHALE_LAMPORTS) whaleDetected = true;
      }

      logger.info(
        { mint, poolPda, uniqueBuyers: uniqueBuyerSet.size, whaleDetected, sigsProcessed: txs.length },
        "Quality: buyer data collected ✅",
      );
      return { uniqueBuyers: uniqueBuyerSet.size, whaleDetected, confident: true };
    } catch (err) {
      logger.debug({ mint, err: (err as Error).message }, "Quality: buyer data fetch failed");
      return null;
    }
  }
}

export const tokenQualityService = new TokenQualityService();
