import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Activity, LayoutDashboard, LineChart, List, Settings, Bell, BookOpen } from "lucide-react";
import { useWebSocket, useUnreadAlerts } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/scanner", label: "Scanner", icon: Activity },
  { href: "/positions", label: "Positions", icon: List },
  { href: "/analytics", label: "Analytics", icon: LineChart },
  { href: "/watchlist", label: "Watchlist", icon: BookOpen },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/auto-trader", label: "Auto-Trader", icon: Settings },
];

export function Shell({ children }: { children: ReactNode }) {
  useWebSocket();
  const [location] = useLocation();
  const { data: unreadAlerts = [] } = useUnreadAlerts();

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden font-mono">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-xl font-bold tracking-tighter text-primary">APEX<span className="text-foreground">TRADER</span></h1>
          <p className="text-xs text-muted-foreground mt-1">v1.0.0-beta</p>
        </div>
        <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer ${
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                >
                  <item.icon className="w-4 h-4" />
                  <span className="text-sm font-medium flex-1">{item.label}</span>
                  {item.href === "/alerts" && unreadAlerts.length > 0 && (
                    <Badge variant="default" className="h-5 px-1.5">{unreadAlerts.length}</Badge>
                  )}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden">
        <div className="flex-1 overflow-y-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
