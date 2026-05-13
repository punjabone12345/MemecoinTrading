import { useState } from "react";
import { useScanner } from "@/lib/api";
import { Activity, ExternalLink } from "lucide-react";

function formatUsd(v: number): string {
  if (!v) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

function formatPrice(price: number): string {
  if (!price) return "—";
  if (price < 0.0001) return price.toFixed(10);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

function ScoreBadge({ score }: { score: number }) {
  const color = score >= 80 ? "text-emerald-400 bg-emerald-500/15" : score >= 60 ? "text-amber-400 bg-amber-500/15" : "text-white/40 bg-white/8";
  return <span className={`px-2 py-0.5 rounded-lg text-xs font-black ${color}`}>{score}</span>;
}

const SCORE_FILTERS = [
  { label: "All", value: 0 },
  { label: "60+", value: 60 },
  { label: "80+", value: 80 },
];

export default function Scanner() {
  const { data: tokens = [] } = useScanner();
  const [minScore, setMinScore] = useState(0);

  const filteredTokens = tokens.filter((t) => t.aiScore >= minScore);

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-black text-white">Live Scanner</h2>
          <p className="text-white/30 text-xs">{tokens.length} tokens in pool</p>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
          <span className="text-violet-400 text-xs font-semibold">LIVE</span>
        </div>
      </div>

      {/* Score Filter */}
      <div className="flex gap-2">
        {SCORE_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setMinScore(f.value)}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
              minScore === f.value
                ? "bg-violet-500/20 text-violet-400 border border-violet-500/30"
                : "bg-white/5 text-white/40 border border-transparent"
            }`}
          >
            Score {f.label}
          </button>
        ))}
        <span className="ml-auto text-white/30 text-xs self-center">{filteredTokens.length} shown</span>
      </div>

      {/* Token Cards */}
      {filteredTokens.length === 0 ? (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-10 text-center">
          <Activity className="w-8 h-8 text-white/20 mx-auto mb-2" />
          <p className="text-white/30 text-sm">No tokens matching criteria</p>
          <p className="text-white/20 text-xs mt-1">Scanner is building its pool...</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredTokens.map((token) => {
            const changeColor = token.priceChange1h >= 0 ? "text-emerald-400" : "text-red-400";
            return (
              <div key={token.pairAddress} className="bg-[#0d0d18] border border-white/8 rounded-xl p-3 flex items-center gap-3">
                {/* Score */}
                <ScoreBadge score={token.aiScore} />

                {/* Token Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-black text-white text-sm">${token.symbol}</span>
                    <span className="text-white/30 text-[10px] truncate">{token.name}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-[10px]">
                    <span className="text-white/40">MCap: <span className="text-white/60">{formatUsd(token.marketCap)}</span></span>
                    <span className="text-white/40">Liq: <span className="text-white/60">{formatUsd(token.liquidity)}</span></span>
                    <span className="text-white/40">{token.pairAgeLabel}</span>
                  </div>
                </div>

                {/* Price & Change */}
                <div className="text-right">
                  <p className="text-white font-mono text-xs">${formatPrice(token.priceUsd)}</p>
                  <p className={`text-xs font-bold ${changeColor}`}>
                    {token.priceChange1h >= 0 ? "+" : ""}{token.priceChange1h.toFixed(1)}%
                  </p>
                </div>

                {/* DEX Link */}
                <a
                  href={`https://dexscreener.com/solana/${token.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-violet-400/60 hover:text-violet-400 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
