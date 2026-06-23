import { useMemo, useState } from 'react';
import { Token } from '../lib/types.js';
import { formatMC, formatAge, formatPrice } from '../lib/utils.js';

interface Props {
  tokens: Token[];
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="h-1 rounded-full overflow-hidden" style={{ background: 'var(--navy-border)' }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function TokenRow({ token }: { token: Token }) {
  const [expanded, setExpanded] = useState(false);
  const scoreColor = token.score >= 70 ? 'var(--green)' : token.score >= 50 ? 'var(--gold)' : 'var(--text-mid)';
  const change = token.priceChange5m;
  const changeColor = change >= 0 ? 'var(--green)' : 'var(--red)';

  return (
    <div
      className="rounded-2xl border overflow-hidden transition-all duration-200"
      style={{
        background: 'var(--navy-card)',
        borderColor: token.score >= 70 ? 'rgba(0,255,136,0.25)' : 'var(--navy-border)',
        boxShadow: token.score >= 70 ? '0 0 20px rgba(0,255,136,0.06)' : 'none',
      }}
    >
      <button
        className="w-full p-4 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          {/* Score circle */}
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 font-black text-sm border-2"
            style={{ borderColor: scoreColor, color: scoreColor, background: `${scoreColor}15` }}
          >
            {token.score}
          </div>

          {/* Token info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-bold text-sm" style={{ color: 'var(--text)' }}>{token.symbol}</span>
              <span
                className="px-1.5 py-0.5 rounded-md text-xs font-bold"
                style={{ background: 'rgba(0,212,255,0.12)', color: 'var(--cyan)' }}
              >
                {token.dexId}
              </span>
            </div>
            <div className="text-xs truncate" style={{ color: 'var(--text-dim)' }}>
              MC: <b style={{ color: 'var(--text-mid)' }}>{formatMC(token.marketCap)}</b>
              {' · '}Vol: <b style={{ color: 'var(--text-mid)' }}>{formatMC(token.volume24h)}</b>
              {' · '}{formatAge(token.age)}
            </div>
          </div>

          {/* Right side */}
          <div className="text-right flex-shrink-0">
            <div className="font-bold text-sm" style={{ color: changeColor }}>
              {change >= 0 ? '+' : ''}{change.toFixed(2)}%
            </div>
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>5m</div>
          </div>
        </div>

        {/* Score bar */}
        <div className="mt-3">
          <MiniBar value={token.score} max={100} color={scoreColor} />
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t" style={{ borderColor: 'var(--navy-border)' }}>
          <div className="pt-3 grid grid-cols-2 gap-3 text-xs">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-dim)' }}>Price</span>
                <span style={{ color: 'var(--text)' }}>${formatPrice(token.price)}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-dim)' }}>B/S Ratio</span>
                <span style={{ color: token.buySellRatio >= 1.5 ? 'var(--green)' : 'var(--text)' }}>
                  {token.buySellRatio.toFixed(2)}x
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-dim)' }}>Liquidity</span>
                <span style={{ color: 'var(--text)' }}>{formatMC(token.liquidity)}</span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-dim)' }}>1h change</span>
                <span style={{ color: token.priceChange1h >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {token.priceChange1h >= 0 ? '+' : ''}{token.priceChange1h.toFixed(2)}%
                </span>
              </div>
            </div>
            <div className="space-y-2">
              <div>
                <div className="flex justify-between mb-1">
                  <span style={{ color: 'var(--text-dim)' }}>Price Mom.</span>
                  <span style={{ color: 'var(--cyan)' }}>{token.scoreBreakdown?.priceMomentum ?? 0}/25</span>
                </div>
                <MiniBar value={token.scoreBreakdown?.priceMomentum ?? 0} max={25} color="var(--cyan)" />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span style={{ color: 'var(--text-dim)' }}>Vol. Mom.</span>
                  <span style={{ color: 'var(--cyan)' }}>{token.scoreBreakdown?.volumeMomentum ?? 0}/25</span>
                </div>
                <MiniBar value={token.scoreBreakdown?.volumeMomentum ?? 0} max={25} color="var(--purple)" />
              </div>
              <div>
                <div className="flex justify-between mb-1">
                  <span style={{ color: 'var(--text-dim)' }}>Buy Press.</span>
                  <span style={{ color: 'var(--cyan)' }}>{token.scoreBreakdown?.buyPressure ?? 0}/25</span>
                </div>
                <MiniBar value={token.scoreBreakdown?.buyPressure ?? 0} max={25} color="var(--green)" />
              </div>
            </div>
          </div>

          <div className="mt-3 flex gap-2">
            <a
              href={`https://dexscreener.com/solana/${token.mint}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 py-2 rounded-xl text-xs font-semibold text-center transition-opacity hover:opacity-80"
              style={{ background: 'var(--cyan-dim)', color: 'var(--cyan)', border: '1px solid rgba(0,212,255,0.2)' }}
              onClick={(e) => e.stopPropagation()}
            >
              View on DexScreener ↗
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default function WatchlistPage({ tokens }: Props) {
  const eligible = useMemo(
    () => tokens.filter((t) => t.status === 'ELIGIBLE' || t.status === 'SCANNING').sort((a, b) => b.score - a.score),
    [tokens]
  );

  const topTokens = useMemo(
    () => tokens.filter((t) => t.score >= 50).sort((a, b) => b.score - a.score).slice(0, 30),
    [tokens]
  );

  const display = eligible.length > 0 ? eligible : topTokens;

  return (
    <div className="space-y-3">
      {/* Header stats */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Watchlist', value: display.length, color: 'var(--cyan)' },
          { label: 'Eligible', value: tokens.filter((t) => t.status === 'ELIGIBLE').length, color: 'var(--green)' },
          { label: 'Avg Score', value: display.length > 0 ? Math.round(display.reduce((s, t) => s + t.score, 0) / display.length) : 0, color: 'var(--gold)' },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-2xl p-3 text-center border"
            style={{ background: 'var(--navy-card)', borderColor: 'var(--navy-border)' }}
          >
            <div className="text-xl font-black" style={{ color: s.color }}>{s.value}</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-dim)' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {display.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20" style={{ color: 'var(--text-dim)' }}>
          <div className="text-5xl mb-4">⭐</div>
          <div className="font-semibold mb-1" style={{ color: 'var(--text-mid)' }}>No tokens found yet</div>
          <div className="text-sm text-center">Scanner is working — tokens will appear here as they pass filters</div>
        </div>
      ) : (
        <>
          <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            {eligible.length > 0 ? `${eligible.length} Eligible Tokens` : `Top Scoring Tokens`}
          </div>
          {display.map((token) => (
            <TokenRow key={token.mint} token={token} />
          ))}
        </>
      )}
    </div>
  );
}
