import { useState, useEffect } from "react";
import { useAutoTraderStatus, useAutoTraderConfig, useUpdateAutoTraderConfig, usePauseAutoTrader, useResumeAutoTrader } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";

export default function AutoTrader() {
  const { data: status } = useAutoTraderStatus();
  const { data: config } = useAutoTraderConfig();
  const updateConfig = useUpdateAutoTraderConfig();
  const pause = usePauseAutoTrader();
  const resume = useResumeAutoTrader();

  const [localConfig, setLocalConfig] = useState<any>(null);

  useEffect(() => {
    if (config && !localConfig) {
      setLocalConfig(config);
    }
  }, [config, localConfig]);

  if (!status || !localConfig) return <div>Loading...</div>;

  const handleChange = (key: string, value: string) => {
    setLocalConfig({ ...localConfig, [key]: Number(value) });
  };

  const handleSave = () => {
    updateConfig.mutate(localConfig);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Auto-Trader</h2>
          <p className="text-sm text-muted-foreground mt-1">Autonomous AI scanning and execution.</p>
        </div>
        <div className="flex items-center gap-4">
          <Badge variant={status.running ? "default" : "destructive"} className="px-3 py-1">
            {status.running ? "RUNNING" : "PAUSED"}
          </Badge>
          {status.running ? (
            <Button variant="destructive" onClick={() => pause.mutate()} disabled={pause.isPending}>
              Pause Trading
            </Button>
          ) : (
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground" onClick={() => resume.mutate()} disabled={resume.isPending}>
              Resume Trading
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4 border-border">
          <p className="text-sm text-muted-foreground mb-1">Scanner Pool</p>
          <p className="text-2xl font-bold">{status.scannerPoolSize}</p>
        </Card>
        <Card className="p-4 border-border">
          <p className="text-sm text-muted-foreground mb-1">Last Run</p>
          <p className="text-lg font-bold">
            {status.lastRunAt ? formatDistanceToNow(new Date(status.lastRunAt), { addSuffix: true }) : "Never"}
          </p>
        </Card>
        <Card className="p-4 border-border">
          <p className="text-sm text-muted-foreground mb-1">Tokens Evaluated</p>
          <p className="text-2xl font-bold">{status.lastRunTokensEvaluated}</p>
        </Card>
        <Card className="p-4 border-border">
          <p className="text-sm text-muted-foreground mb-1">Total Trades</p>
          <p className="text-2xl font-bold">{status.totalTradesOpened}</p>
        </Card>
      </div>

      <Card className="p-6 border-border">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-bold">Trading Configuration</h3>
          <Button onClick={handleSave} disabled={updateConfig.isPending} data-testid="btn-save-config">
            Save Changes
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div className="space-y-2">
            <Label>Trade Size (SOL)</Label>
            <Input type="number" step="0.01" value={localConfig.solPerTrade} onChange={e => handleChange('solPerTrade', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Max Concurrent Trades</Label>
            <Input type="number" value={localConfig.maxConcurrentTrades} onChange={e => handleChange('maxConcurrentTrades', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Min AI Score</Label>
            <Input type="number" value={localConfig.minAiScore} onChange={e => handleChange('minAiScore', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Min Confidence</Label>
            <Input type="number" value={localConfig.minConfidence} onChange={e => handleChange('minConfidence', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Min Liquidity (USD)</Label>
            <Input type="number" value={localConfig.minLiquidityUsd} onChange={e => handleChange('minLiquidityUsd', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Min 1h Volume (USD)</Label>
            <Input type="number" value={localConfig.minVolume1hUsd} onChange={e => handleChange('minVolume1hUsd', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Min 1h Buy Ratio</Label>
            <Input type="number" step="0.01" value={localConfig.minBuyRatio1h} onChange={e => handleChange('minBuyRatio1h', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Min Pair Age (Minutes)</Label>
            <Input type="number" value={localConfig.minPairAgeMinutes} onChange={e => handleChange('minPairAgeMinutes', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Max Pair Age (Hours)</Label>
            <Input type="number" value={localConfig.maxPairAgeHours} onChange={e => handleChange('maxPairAgeHours', e.target.value)} />
          </div>
        </div>
      </Card>
    </div>
  );
}
