import { useAlerts, useMarkAllAlertsRead, useClearAlerts, useMarkAlertRead } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";

export default function Alerts() {
  const { data: alerts = [] } = useAlerts();
  const markAllRead = useMarkAllAlertsRead();
  const clearAlerts = useClearAlerts();
  const markRead = useMarkAlertRead();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight">Alerts</h2>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending || alerts.every(a => a.read)}
            data-testid="btn-mark-all-read"
          >
            Mark All Read
          </Button>
          <Button 
            variant="destructive" 
            onClick={() => clearAlerts.mutate()}
            disabled={clearAlerts.isPending || alerts.length === 0}
            data-testid="btn-clear-alerts"
          >
            Clear All
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {alerts.map(alert => (
          <Card 
            key={alert.id} 
            className={`p-4 border-border transition-colors ${alert.read ? 'bg-card/50' : 'bg-card border-l-4 border-l-primary'}`}
            onClick={() => !alert.read && markRead.mutate(alert.id)}
          >
            <div className="flex justify-between items-start">
              <div>
                <h4 className="font-bold flex items-center gap-2">
                  {alert.title}
                  {!alert.read && <span className="w-2 h-2 rounded-full bg-primary inline-block"></span>}
                </h4>
                <p className="text-sm text-muted-foreground mt-1">{alert.message}</p>
                {(alert.tokenSymbol || alert.pairAddress) && (
                  <div className="mt-2 text-xs font-mono bg-muted px-2 py-1 rounded inline-block">
                    {alert.tokenSymbol || "Token"} • {alert.pairAddress || "N/A"}
                  </div>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(alert.createdAt), { addSuffix: true })}
              </span>
            </div>
          </Card>
        ))}
        {alerts.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No alerts yet
          </div>
        )}
      </div>
    </div>
  );
}
