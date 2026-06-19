---
name: PumpSwap on-chain liquidity fix
description: PumpSwap pool accounts are keypair-based (not PDAs) — PDA derivation fails; use DexScreener pairAddress directly.
---

## Rule
When fetching on-chain liquidity for PumpSwap tokens, do NOT attempt PDA derivation from the mint.
Use the `pairAddress` field from the DexScreener API response as the pool account address directly.

## Why
PumpSwap pool accounts are keypair-generated (not program-derived addresses).
Deriving `findProgramAddressSync(['pool', idx, mint, wsolMint], pumpswapProgramId)` produces
the wrong address for every index tried (0–4 all return 404). Only the DexScreener `pairAddress`
field reliably identifies the actual on-chain pool account.

Proof-tested on token SOLY (DqBjJEh6nppACX8fvuXvyWx8AQddPd5na7k2LCFWpump):
- PDA derivation at index 0: `29qtadaj5C8e9jd8WMVVBEqjLD53S7R11rmqr6bqqHS3` → 404 from RPC
- DexScreener pairAddress: `CjXkWvUta3RGYsMBw74EhXU419HTKBD6Cgd7xVZnJ65p` → pool account found (203+ bytes)
- WSOL vault at offset 171: `Sr7XBqwZH1KRCmMoBPs9BasJgBcid3xZkJkVbhK3FPQ` → 176.63 SOL = $12,136 ✅

## Pool account layout (confirmed)
Byte offset 171 = pool_quote_token_account = WSOL vault:
  [0-7]   discriminator (8)
  [8]     pool_bump     (1)
  [9-10]  index         (2)
  [11-42] creator       (32)
  [43-74] base_mint     (32)
  [75-106] quote_mint   (32)
  [107-138] lp_mint     (32)
  [139-170] pool_base_token_account (32)
  [171-202] pool_quote_token_account = WSOL vault ← target

Account must be ≥203 bytes.

## How to apply
In `fetchBatchedPrices`: add `pairAddress?: string` to DexPair type, cache it as
`pumpswapVaultCache.set('pair:' + mint, pairAddress)`, then use it when `liquidityUsd === 0`.

In `fetchPrice`: add `pairAddress?: string` to DexPair type, pass `best.pairAddress` to
`fetchPumpSwapLiquidityUsd(poolAddress, solUsd)`.

`fetchPumpSwapLiquidityUsd(poolAddress, solUsd)` — first param is the POOL address (not mint).
Cache is keyed by poolAddress, NOT mint.

## On-chain vs DexScreener difference
On-chain reads only the WSOL (SOL) vault side = ~50% of DexScreener's `liquidity.usd`
(which counts both base token + quote token sides). This is correct and expected —
the SOL vault reserve is the authoritative metric for rug detection.
