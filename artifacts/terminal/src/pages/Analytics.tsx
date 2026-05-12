import { useAnalytics } from "@/lib/api";
import { TrendingUp, TrendingDown, Award, Target, Clock, BarChart2 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from "recharts";

function fmt(v: number | undefined, d = 4) {
  if (v === undefined || v === null) return "—";
  return (v >= 0 ? "+" : "") + Math.abs(v).toFixed(d);
}

export default function Analytics() {
  const { data: analytics } = useAnalytics();

  if (!analytics) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 rounded-full border-2 border-violet-500 border-t-transparent animate-spin" />
      </div>
    );
  }

  const pnlData = Object.entries(analytics.calendarPnl || {})
    .slice(-14)
    .map(([date, pnl]) => ({ date: date.slice(5), pnl }));

  const winRate = (analytics.winRate * 100).toFixed(1);

  return (
    <div className="px-4 py-4 space-y-4">
      {/* Win Rate Hero */}
      <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-violet-900/40 to-[#0d0d18] border border-violet-500/20 p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-white/40 text-xs uppercase tracking-widest font-semibold">Win Rate</p>
            <p className="text-5xl font-black text-white mt-1">{winRate}<span className="text-2xl text-violet-400">%</span></p>
            <p className="text-white/40 text-xs mt-1">{analytics.winCount}W / {analytics.lossCount}L — {analytics.totalTrades} total</p>
          </div>
          <div className="w-14 h-14 rounded-2xl bg-violet-500/20 flex items-center justify-center">
            <Award className="w-7 h-7 text-violet-400" />
          </div>
        </div>
      </div>

      {/* PNL Stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={<TrendingUp className="w-4 h-4 text-emerald-400" />}
          bg="bg-emerald-500/10"
          label="Total P&L"
          value={`${fmt(analytics.totalPnlSol)} SOL`}
          valueClass={analytics.totalPnlSol >= 0 ? "text-emerald-400" : "text-red-400"}
        />
        <StatCard
          icon={<BarChart2 className="w-4 h-4 text-blue-400" />}
          bg="bg-blue-500/10"
          label="Today's P&L"
          value={`${fmt(analytics.dailyPnl)} SOL`}
          valueClass={analytics.dailyPnl >= 0 ? "text-emerald-400" : "text-red-400"}
        />
        <StatCard
          icon={<Award className="w-4 h-4 text-amber-400" />}
          bg="bg-amber-500/10"
          label="Best Trade"
          value={`+${analytics.bestTradePnl.toFixed(4)} SOL`}
          valueClass="text-emerald-400"
        />
        <StatCard
          icon={<TrendingDown className="w-4 h-4 text-red-400" />}
          bg="bg-red-500/10"
          label="Worst Trade"
          value={`${analytics.worstTradePnl.toFixed(4)} SOL`}
          valueClass="text-red-400"
        />
        <StatCard
          icon={<Target className="w-4 h-4 text-violet-400" />}
          bg="bg-violet-500/10"
          label="Avg Win"
          value={`+${analytics.avgWinSol.toFixed(4)} SOL`}
          valueClass="text-emerald-400"
        />
        <StatCard
          icon={<Clock className="w-4 h-4 text-white/40" />}
          bg="bg-white/5"
          label="Avg Hold"
          value={`${analytics.avgHoldTimeMinutes.toFixed(0)}m`}
          valueClass="text-white"
        />
      </div>

      {/* Period PNL */}
      <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
        <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-3">Period Breakdown</p>
        <div className="space-y-2">
          {[
            { label: "Today", val: analytics.dailyPnl },
            { label: "This Week", val: analytics.weeklyPnl },
            { label: "This Month", val: analytics.monthlyPnl },
          ].map(({ label, val }) => (
            <div key={label} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
              <span className="text-white/50 text-sm">{label}</span>
              <span className={`font-bold text-sm ${val >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {val >= 0 ? "+" : ""}{val.toFixed(4)} SOL
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Daily PNL Chart */}
      {pnlData.length > 0 && (
        <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
          <p className="text-xs font-bold text-white/40 uppercase tracking-wider mb-4">Daily P&L (Last 14 Days)</p>
          <div className="h-44 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={pnlData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
                <XAxis dataKey="date" stroke="#ffffff20" fontSize={9} tickLine={false} axisLine={false} />
                <YAxis stroke="#ffffff20" fontSize={9} tickLine={false} axisLine={false} tickFormatter={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#0d0d18", borderColor: "#ffffff15", color: "#fff", fontSize: 11, borderRadius: 8 }}
                  formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(4)} SOL`, "P&L"]}
                />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                  {pnlData.map((entry, i) => (
                    <Cell key={i} fill={entry.pnl >= 0 ? "rgba(52,211,153,0.8)" : "rgba(248,113,113,0.8)"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon, bg, label, value, valueClass }: {
  icon: React.ReactNode;
  bg: string;
  label: string;
  value: string;
  valueClass: string;
}) {
  return (
    <div className="bg-[#0d0d18] border border-white/8 rounded-xl p-4">
      <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center mb-2`}>
        {icon}
      </div>
      <p className="text-white/40 text-xs mb-0.5">{label}</p>
      <p className={`font-black text-sm ${valueClass}`}>{value}</p>
    </div>
  );
}
