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

// Public Solana RPC endpoints used as fallback when Helius key is absent.
// getTokenAccountBalance is a read-only call well within free-tier rate limits.
const PUBLIC_RPC_ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-mainnet.g.alchemy.com/v2/demo",
];

class TokenQualityService {
  async collectQualityData(
    mint:               string,
    symbol:             string,
    poolPda:            string | null,
    initialSolReserves: number,
    heliusApiKey:       string | null,
    wsolVaultPubkey:    string | null = null,
    fastMode:           boolean = false,
  ): Promise<QualityMetrics> {
    const t0     = Date.now();
    const rpcUrl = heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
      : null;

    logger.info(
      { mint, symbol, initialSolReserves: initialSolReserves.toFixed(2), wsolVault: wsolVaultPubkey?.slice(0, 8) ?? "none", fastMode },
      fastMode ? "Quality: fast re-check (no delays — pool fully indexed) ⚡" : "Quality: starting 60s parallel data collection ⏱",
    );

    // Fire all four collection paths simultaneously.
    // fastMode=true: all delays skipped — used for T+180s/T+600s staged re-checks
    //   when pool is fully indexed and all data sources are immediately available.
    // fastMode=false (default): delays are applied so T0 reads don't get stale data.
    const [dexResult, holderResult, buyerResult, onChainSolRaw] = await Promise.all([
      this.pollDexScreener(mint),
      rpcUrl ? this.fetchHolderData(mint, rpcUrl, fastMode) : Promise.resolve(null),
      // Use wsolVaultPubkey as the primary address for signature lookup.
      // PumpSwap pools are keypair-based (not PDAs), so the derived poolPda is
      // WRONG — getSignaturesForAddress(wrongPDA) always returns 0 signatures.
      // The WSOL vault is touched by every buy/sell swap, making it the correct
      // and reliable address. Fall back to poolPda only if vault is unavailable.
      (heliusApiKey && (wsolVaultPubkey || poolPda))
        ? this.fetchBuyerData(mint, wsolVaultPubkey ?? poolPda!, heliusApiKey, fastMode)
        : Promise.resolve(null),
      (wsolVaultPubkey && initialSolReserves === 0)
        ? (async () => {
            if (!fastMode) {
              // Pool accounts need ~30–40s to be populated/indexed after graduation.
              // Reading immediately (T0) always returns 0 — delay before re-fetching.
              await new Promise<void>((r) => setTimeout(r, 40_000));
            }
            return this.fetchOnChainSolBalance(wsolVaultPubkey, heliusApiKey);
          })()
        : Promise.resolve(null),
    ]);

    // ── Aggregate raw metrics ────────────────────────────────────────────────
    // Priority: initialSolReserves > on-chain vault read > pairAddress pool read > DexScreener.
    // DexScreener reports liquidity=0 for 3–5 min after graduation — unreliable.
    let liquiditySol =
      initialSolReserves > 0                         ? initialSolReserves
      : (onChainSolRaw != null && onChainSolRaw > 0) ? onChainSolRaw
      : 0;

    // Fallback: read WSOL vault via DexScreener pairAddress (pool account offset 171)
    // This is the most reliable source when wsolVaultPubkey was null or RPC failed.
    // PumpSwap pools are keypair-based so PDA derivation fails — but pairAddress is exact.
    if (liquiditySol === 0 && dexResult?.pairAddress) {
      const pairSol = await this.fetchSolFromPairAddress(dexResult.pairAddress, heliusApiKey);
      if (pairSol != null && pairSol > 0) {
        liquiditySol = pairSol;
        logger.info({ mint, symbol, pairSol: pairSol.toFixed(2), pairAddress: dexResult.pairAddress.slice(0, 8) },
          "Quality: pairAddress on-chain WSOL vault balance used for liquiditySol ✅");
      }
    }

    // Last resort: DexScreener USD estimate (often 0 for fresh tokens)
    if (liquiditySol === 0 && dexResult?.liquidityUsd) {
      liquiditySol = dexResult.liquidityUsd / 150;
    }

    if (onChainSolRaw != null && onChainSolRaw > 0 && initialSolReserves === 0) {
      logger.info({ mint, symbol, onChainSolRaw: onChainSolRaw.toFixed(2) },
        "Quality: on-chain WSOL vault balance used for liquiditySol ✅");
    }

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
    else if (buyPressureScore === 0) autoSkipReason = `Buy pressure ${buyPressureRatio.toFixed(2)}x < 1.3x minimum`;
    else if (topHolderPct > 0 && holderScore === 0)
      autoSkipReason = `Top holder ${topHolderPct.toFixed(1)}% > 25% maximum`;

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
    if (ratio >= 1.3) return 15;
    return 0;
  }

  private scoreHolder(topPct: number): number {
    if (topPct <  10) return 25;
    if (topPct <  15) return 20;
    if (topPct <  25) return 15;
    return 0;
  }

  // ── On-chain WSOL vault balance (instant, no indexer needed) ────────────────
  // Reads the Raydium CPMM pool's WSOL vault token account balance directly via
  // Solana RPC.  This is available within milliseconds of pool creation and is
  // the single source of truth for SOL liquidity — DexScreener takes 3–5 min.
  // Falls back through Helius → public mainnet RPC endpoints.
  private async fetchOnChainSolBalance(
    wsolVaultPubkey: string,
    heliusApiKey:    string | null,
  ): Promise<number | null> {
    const endpoints: string[] = [
      ...(heliusApiKey ? [`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`] : []),
      ...PUBLIC_RPC_ENDPOINTS,
    ];

    for (const endpoint of endpoints) {
      try {
        type TokenAmountResp = {
          result?: { value?: { uiAmount?: number | null } };
          error?:  unknown;
        };
        const res = await axios.post<TokenAmountResp>(
          endpoint,
          { jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: [wsolVaultPubkey] },
          { timeout: 5_000 },
        );
        if (res.data?.error) continue;
        const uiAmount = res.data?.result?.value?.uiAmount;
        if (uiAmount != null && uiAmount > 0) {
          logger.debug({ wsolVault: wsolVaultPubkey.slice(0, 8), uiAmount: uiAmount.toFixed(2), endpoint },
            "Quality: on-chain WSOL vault balance fetched ✅");
          return uiAmount;
        }
      } catch {
        // try next endpoint
      }
    }

    logger.debug({ wsolVault: wsolVaultPubkey.slice(0, 8) },
      "Quality: on-chain WSOL vault balance unavailable — all RPC endpoints failed");
    return null;
  }

  // ── On-chain SOL balance via DexScreener pairAddress (PumpSwap) ─────────────
  // PumpSwap pool accounts are keypair-based (not PDAs), so we cannot derive the
  // pool address ourselves.  But DexScreener returns pairAddress in its response.
  // Approach: read pool account data → extract bytes [171..203] = WSOL vault pubkey
  // → getTokenAccountBalance on that vault.  Proven correct (see test script).
  private async fetchSolFromPairAddress(
    pairAddress:  string,
    heliusApiKey: string | null,
  ): Promise<number | null> {
    const endpoints: string[] = [
      ...(heliusApiKey ? [`https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`] : []),
      ...PUBLIC_RPC_ENDPOINTS,
    ];

    for (const endpoint of endpoints) {
      try {
        // Step 1: getAccountInfo on the pool account
        type AccountInfoResp = {
          result?: { value?: { data?: [string, string] | null } | null };
          error?:  unknown;
        };
        const infoRes = await axios.post<AccountInfoResp>(
          endpoint,
          { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [pairAddress, { encoding: "base64" }] },
          { timeout: 5_000 },
        );
        if (infoRes.data?.error) continue;
        const dataArr = infoRes.data?.result?.value?.data;
        if (!Array.isArray(dataArr) || dataArr[1] !== "base64") continue;
        const buf = Buffer.from(dataArr[0], "base64");
        if (buf.length < 203) continue;

        // Step 2: extract WSOL vault pubkey at bytes 171–203
        const wsolVaultKey = new (await import("@solana/web3.js")).PublicKey(buf.slice(171, 203)).toBase58();

        // Step 3: getTokenAccountBalance on the WSOL vault
        type TokenAmountResp = {
          result?: { value?: { uiAmount?: number | null } };
          error?:  unknown;
        };
        const balRes = await axios.post<TokenAmountResp>(
          endpoint,
          { jsonrpc: "2.0", id: 2, method: "getTokenAccountBalance", params: [wsolVaultKey] },
          { timeout: 5_000 },
        );
        if (balRes.data?.error) continue;
        const uiAmount = balRes.data?.result?.value?.uiAmount;
        if (uiAmount != null && uiAmount > 0) {
          logger.debug({ pairAddress: pairAddress.slice(0, 8), wsolVault: wsolVaultKey.slice(0, 8), uiAmount: uiAmount.toFixed(2) },
            "Quality: fetchSolFromPairAddress ✅");
          return uiAmount;
        }
      } catch {
        // try next endpoint
      }
    }

    logger.debug({ pairAddress: pairAddress.slice(0, 8) }, "Quality: fetchSolFromPairAddress — all endpoints failed");
    return null;
  }

  // ── DexScreener polling (4 polls over ~45s) ───────────────────────────────
  // Fires at T=0, T=15s, T=30s, T=45s — captures the evolution of buy/sell
  // volume as the token gets indexed. Stops early once meaningful data arrives.
  private async pollDexScreener(mint: string): Promise<{
    liquidityUsd:    number;
    fdv:             number;
    buyPressureRatio: number;
    m5Buys:          number;
    pairAddress:     string | null;
  } | null> {
    let best: { liquidityUsd: number; fdv: number; buyPressureRatio: number; m5Buys: number; pairAddress: string | null } | null = null;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 15_000));

      try {
        type DexPair = {
          priceUsd?:    string;
          pairAddress?: string;
          liquidity?:   { usd?: number };
          fdv?:         number;
          txns?:        { m5?: { buys?: number; sells?: number } };
          dexId?:       string;
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

        best = {
          liquidityUsd:    pair.liquidity?.usd ?? 0,
          fdv:             pair.fdv ?? 0,
          buyPressureRatio,
          m5Buys,
          pairAddress:     pair.pairAddress ?? null,
        };

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
  // fastMode=true: skip the 20s delay (used for T+180s/T+600s re-checks).
  private async fetchHolderData(
    mint:     string,
    rpcUrl:   string,
    fastMode: boolean = false,
  ): Promise<{ topHolderPct: number; creatorHoldingsPct: number } | null> {
    if (!fastMode) await new Promise<void>((r) => setTimeout(r, 20_000));

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
  // Wait 45s before querying — Enhanced Transactions index new pool TXes within
  // 30-60s of confirmation. Waiting 45s (near the end of the 60s window) gives
  // the indexer time to accumulate real buyer transactions. 25s was too early
  // and returned 0 buyers even for tokens with 100+ SOL of liquidity.
  // fastMode=true: skip the 45s delay (used for T+180s/T+600s re-checks).
  private async fetchBuyerData(
    mint:     string,
    poolPda:  string,
    apiKey:   string,
    fastMode: boolean = false,
  ): Promise<{ uniqueBuyers: number; whaleDetected: boolean } | null> {
    if (!fastMode) await new Promise<void>((r) => setTimeout(r, 45_000));

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
