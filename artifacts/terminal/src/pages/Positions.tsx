import { usePositions, useClosedPositions, useClosePosition } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatSol, formatPercent, getScoreColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function Positions() {
  const { data: positionsData } = usePositions();
  const { data: closedPositions = [] } = useClosedPositions();
  const closePosition = useClosePosition();

  const openPositions = positionsData?.positions || [];

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Positions</h2>
      
      <Tabs defaultValue="open">
        <TabsList className="mb-4">
          <TabsTrigger value="open" data-testid="tab-open-positions">Open ({openPositions.length})</TabsTrigger>
          <TabsTrigger value="closed" data-testid="tab-closed-positions">Closed</TabsTrigger>
        </TabsList>
        
        <TabsContent value="open">
          <Card className="border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>AI Score</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead className="text-right">Size (SOL)</TableHead>
                  <TableHead className="text-right">PNL (SOL)</TableHead>
                  <TableHead className="text-right">PNL (%)</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {openPositions.map(p => (
                  <TableRow key={p.positionId}>
                    <TableCell className="font-bold">{p.symbol}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={getScoreColor(p.aiScore)}>
                        {p.aiScore.toFixed(0)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">{p.entryPrice.toFixed(8)}</TableCell>
                    <TableCell className="text-right">{formatSol(p.sizeSol)}</TableCell>
                    <TableCell className={`text-right font-medium ${p.pnlSol && p.pnlSol >= 0 ? 'text-primary' : 'text-destructive'}`}>
                      {p.pnlSol && p.pnlSol >= 0 ? '+' : ''}{formatSol(p.pnlSol)}
                    </TableCell>
                    <TableCell className={`text-right ${p.pnlPercent && p.pnlPercent >= 0 ? 'text-primary' : 'text-destructive'}`}>
                      {formatPercent(p.pnlPercent)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button 
                        variant="destructive" 
                        size="sm"
                        onClick={() => closePosition.mutate(p.pairAddress)}
                        disabled={closePosition.isPending}
                        data-testid={`btn-close-${p.symbol}`}
                      >
                        Close
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {openPositions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No open positions
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
        
        <TabsContent value="closed">
          <Card className="border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Symbol</TableHead>
                  <TableHead>Entry / Exit</TableHead>
                  <TableHead className="text-right">Size (SOL)</TableHead>
                  <TableHead className="text-right">PNL (SOL)</TableHead>
                  <TableHead className="text-right">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {closedPositions.map(p => (
                  <TableRow key={p.positionId}>
                    <TableCell className="font-bold">{p.symbol}</TableCell>
                    <TableCell>
                      <div className="text-xs text-muted-foreground">IN: {p.entryPrice.toFixed(8)}</div>
                      <div className="text-xs text-muted-foreground">OUT: {p.exitPrice?.toFixed(8)}</div>
                    </TableCell>
                    <TableCell className="text-right">{formatSol(p.sizeSol)}</TableCell>
                    <TableCell className={`text-right font-medium ${p.pnlSol && p.pnlSol >= 0 ? 'text-primary' : 'text-destructive'}`}>
                      {p.pnlSol && p.pnlSol >= 0 ? '+' : ''}{formatSol(p.pnlSol)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant={p.closeReason === 'take_profit' ? 'default' : p.closeReason === 'stop_loss' ? 'destructive' : 'secondary'}>
                        {p.closeReason?.replace('_', ' ').toUpperCase() || 'UNKNOWN'}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {closedPositions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No closed positions
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
