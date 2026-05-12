import { usePortfolio, usePositions } from "@/lib/api";
import { Card } from "@/components/ui/card";

export default function Dashboard() {
  const { data: portfolioData } = usePortfolio();
  const { data: positionsData } = usePositions();

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
      
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Total Balance</p>
          <p className="text-2xl font-bold text-foreground">
            {portfolioData ? portfolioData.solBalance.toFixed(4) : "0.0000"} SOL
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Total PNL</p>
          <p className={`text-2xl font-bold ${
            portfolioData && portfolioData.totalPnlSol >= 0 ? "text-primary" : "text-destructive"
          }`}>
            {portfolioData ? (portfolioData.totalPnlSol > 0 ? "+" : "") + portfolioData.totalPnlSol.toFixed(4) : "0.0000"} SOL
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Open Positions</p>
          <p className="text-2xl font-bold text-foreground">
            {portfolioData ? portfolioData.openPositionsCount : "0"}
          </p>
        </Card>
        <Card className="p-4 bg-card border-border">
          <p className="text-sm text-muted-foreground mb-1">Open Value</p>
          <p className="text-2xl font-bold text-foreground">
            {portfolioData ? portfolioData.openPositionsValueSol.toFixed(4) : "0.0000"} SOL
          </p>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6 bg-card border-border h-[400px]">
          <h3 className="text-lg font-bold mb-4">Live Positions</h3>
          <div className="overflow-auto h-[300px]">
            {positionsData?.positions.map(p => (
              <div key={p.positionId} className="flex justify-between items-center py-2 border-b border-border">
                <span className="font-bold">{p.symbol}</span>
                <span className={p.pnlSol && p.pnlSol >= 0 ? "text-primary" : "text-destructive"}>
                  {p.pnlSol && p.pnlSol >= 0 ? "+" : ""}{p.pnlSol?.toFixed(4)} SOL
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
