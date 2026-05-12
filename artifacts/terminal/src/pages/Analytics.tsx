import { useAnalytics } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { formatSol, formatPercent } from "@/lib/utils";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

export default function Analytics() {
  const { data: analytics } = useAnalytics();

  if (!analytics) return <div>Loading...</div>;

  const pnlData = Object.entries(analytics.calendarPnl || {}).map(([date, pnl]) => ({
    date,
    pnl
  }));

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Analytics</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Win Rate</p>
          <p className="text-2xl font-bold text-primary">
            {(analytics.winRate * 100).toFixed(1)}%
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {analytics.winCount}W / {analytics.lossCount}L ({analytics.totalTrades} Total)
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Total PNL</p>
          <p className={`text-2xl font-bold ${analytics.totalPnlSol >= 0 ? "text-primary" : "text-destructive"}`}>
            {analytics.totalPnlSol > 0 ? "+" : ""}{formatSol(analytics.totalPnlSol)} SOL
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Avg R:R</p>
          <p className="text-2xl font-bold text-foreground">
            {analytics.avgRR.toFixed(2)}
          </p>
        </Card>
        
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Best Trade</p>
          <p className="text-2xl font-bold text-primary">
            +{formatSol(analytics.bestTradePnl)} SOL
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Worst Trade</p>
          <p className="text-2xl font-bold text-destructive">
            {formatSol(analytics.worstTradePnl)} SOL
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Avg Hold Time</p>
          <p className="text-2xl font-bold text-foreground">
            {analytics.avgHoldTimeMinutes.toFixed(1)}m
          </p>
        </Card>
      </div>

      <Card className="p-6 border-border">
        <h3 className="text-lg font-bold mb-4">Daily PNL</h3>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={pnlData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
              <XAxis dataKey="date" stroke="#888" fontSize={12} tickLine={false} axisLine={false} />
              <YAxis stroke="#888" fontSize={12} tickLine={false} axisLine={false} tickFormatter={(val) => `${val > 0 ? '+' : ''}${val}`} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', color: '#f8fafc' }}
                formatter={(value: number) => [`${value > 0 ? '+' : ''}${value.toFixed(4)} SOL`, 'PNL']}
              />
              <Bar 
                dataKey="pnl" 
                radius={[4, 4, 0, 0]}
              >
                {
                  pnlData.map((entry, index) => (
                    <cell key={`cell-${index}`} fill={entry.pnl >= 0 ? "hsl(var(--primary))" : "hsl(var(--destructive))"} />
                  ))
                }
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}
