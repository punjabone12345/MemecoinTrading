import { useState } from "react";
import { useScanner } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUsd, formatPercent, getScoreColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export default function Scanner() {
  const { data: tokens = [] } = useScanner();
  const [minScore, setMinScore] = useState(0);

  const filteredTokens = tokens.filter(t => t.aiScore >= minScore);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight">Live Scanner</h2>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">Pool Size: <Badge variant="secondary">{tokens.length}</Badge></span>
          <select 
            className="bg-input border border-border rounded px-2 py-1 text-sm"
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            data-testid="select-min-score"
          >
            <option value={0}>All Scores</option>
            <option value={60}>Score &gt;= 60</option>
            <option value={80}>Score &gt;= 80</option>
          </select>
        </div>
      </div>

      <Card className="border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Symbol</TableHead>
              <TableHead>AI Score</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Mcap</TableHead>
              <TableHead className="text-right">Vol 1h</TableHead>
              <TableHead className="text-right">1h Change</TableHead>
              <TableHead className="text-right">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTokens.map(token => (
              <TableRow key={token.pairAddress}>
                <TableCell className="font-bold">{token.symbol}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={getScoreColor(token.aiScore)}>
                    {token.aiScore.toFixed(0)}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">{formatUsd(token.priceUsd)}</TableCell>
                <TableCell className="text-right">{formatUsd(token.marketCap)}</TableCell>
                <TableCell className="text-right">{formatUsd(token.volume1h)}</TableCell>
                <TableCell className={`text-right ${token.priceChange1h >= 0 ? 'text-primary' : 'text-destructive'}`}>
                  {formatPercent(token.priceChange1h)}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{token.pairAgeLabel}</TableCell>
              </TableRow>
            ))}
            {filteredTokens.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No tokens matching criteria
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
