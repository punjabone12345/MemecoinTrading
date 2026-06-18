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
      : (dexResult ? dexResult.liquidityUsd / 150 : 0);

    const marketCapUsd    = dexResult?.fdv           ?? 0;
    const buyPressureRatio = dexResult?.buyPressureRatio ?? 1.0;
    const uniqueBuyers    = buyerResult?.uniqueBuyers ?? (dexResult?.m5Buys ?? 0);
    // Conservative fallback: if holder data unavailable assume 100% (auto-skip)
    const topHolderPct      = holderResult?.topHolderPct      ?? 0; // 0 = unknown = don't auto-skip on unknown
    const creatorHoldingsPct = holderResult?.creatorHoldingsPct ?? 0;
    const whaleDetected     = buyerResult?.whaleDetected ?? false;

    // ── Score each dimension (25 pts each, 100 pts total) ───────────────────
    const liquidityScore   = this.scoreLiquidity(liquiditySol);
    const buyerScore       = this.scoreBuyers(uniqueBuyers);
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
    else if (buyerScore  === 0) autoSkipReason = `Unique buyers ${uniqueBuyers} < 20 minimum`;
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
    let best: { liquidityUsd: number; fdv: number; buyPressureRatio: number; m5Buys: number } | null = null;

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

        const m5      = pair.txns?.m5;
        const m5Buys  = m5?.buys  ?? 0;
        const m5Sells = m5?.sells ?? 0;
        const buyPressureRatio = m5Sells > 0
          ? m5Buys / m5Sells
          : (m5Buys > 0 ? 5.0 : 1.0);

        best = { liquidityUsd: pair.liquidity?.usd ?? 0, fdv: pair.fdv ?? 0, buyPressureRatio, m5Buys };

        // Stop early once we have real volume data
        if (m5Buys >= 5 || m5Sells >= 5) {
          logger.debug({ mint, attempt, m5Buys, m5Sells }, "Quality: DexScreener early stop — data ready");
          break;
        }
      } catch (err) {
        logger.debug({ mint, attempt, err: (err as Error).message }, "Quality: DexScreener poll failed");
      }
    }

    return best;
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
  ): Promise<{ uniqueBuyers: number; whaleDetected: boolean } | null> {
    await new Promise<void>((r) => setTimeout(r, 25_000));

    try {
      const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

      // Get recent signatures involving the pool PDA
      type SigResult = { signature: string; err: unknown };
      const sigRes = await axios.post<{ result?: SigResult[] }>(rpcUrl, {
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [poolPda, { limit: 100, commitment: "confirmed" }],
      }, { timeout: 8_000 });

      const sigs = (sigRes.data?.result ?? [])
        .filter((s) => !s.err)
        .map((s) => s.signature)
        .slice(0, 50);

      if (sigs.length === 0) {
        logger.debug({ mint, poolPda }, "Quality: no pool signatures yet");
        return { uniqueBuyers: 0, whaleDetected: false };
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
        { mint, poolPda, uniqueBuyers: uniqueBuyerSet.size, whaleDetected },
        "Quality: buyer data collected ✅",
      );
      return { uniqueBuyers: uniqueBuyerSet.size, whaleDetected };
    } catch (err) {
      logger.debug({ mint, err: (err as Error).message }, "Quality: buyer data fetch failed");
      return null;
    }
  }
}

export const tokenQualityService = new TokenQualityService();
