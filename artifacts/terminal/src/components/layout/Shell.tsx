import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { LayoutDashboard, ListOrdered, BarChart3, Cpu, Rocket, Target } from "lucide-react";
import { useWebSocket, useUnreadAlerts, useAutoTraderStatus } from "@/lib/api";
import { Badge } from "@/components/ui/badge";

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/positions", label: "Positions", icon: ListOrdered },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/scanner", label: "Pump.fun", icon: Rocket },
  { href: "/auto-trader", label: "Bot", icon: Cpu },
  { href: "/sniper", label: "Sniper", icon: Target },
];

export function Shell({ children }: { children: ReactNode }) {
  useWebSocket();
  const [location] = useLocation();
  const { data: unreadAlerts = [] } = useUnreadAlerts();
  const { data: status } = useAutoTraderStatus();

  const isRunning = status && !status.paused;

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0f] text-white overflow-hidden" style={{ fontFamily: "'Inter', sans-serif" }}>
      {/* Top Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#0d0d15] flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center">
            <span className="text-white text-xs font-black">A</span>
          </div>
          <div>
            <h1 className="text-sm font-black tracking-widest text-white leading-none">APEX<span className="text-violet-400">TRADER</span></h1>
            <p className="text-[9px] text-white/30 leading-none tracking-widest uppercase">AI Memecoin Bot</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unreadAlerts.length > 0 && (
            <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-[10px] px-1.5 py-0.5 h-auto">
              {unreadAlerts.length}
            </Badge>
          )}
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold ${
            isRunning ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
          }`}>
            <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-red-400"}`} />
            {isRunning ? "LIVE" : "PAUSED"}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="pb-20">
          {children}
        </div>
      </main>

      {/* Bottom Tab Bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-[#0d0d15] border-t border-white/10 flex items-stretch px-1 py-1" style={{ paddingBottom: "env(safe-area-inset-bottom, 4px)" }}>
        {NAV_ITEMS.map((item) => {
          const isActive = item.href === "/" ? location === "/" : location.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className="flex-1">
              <div className={`flex flex-col items-center justify-center gap-1 py-2 px-1 rounded-xl transition-all relative ${
                isActive
                  ? "bg-violet-500/15"
                  : "hover:bg-white/5"
              }`}>
                {item.href === "/auto-trader" && isRunning && (
                  <div className="absolute top-1 right-3 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                )}
                <item.icon className={`w-5 h-5 ${isActive ? "text-violet-400" : "text-white/40"}`} />
                <span className={`text-[10px] font-semibold leading-none ${isActive ? "text-violet-400" : "text-white/40"}`}>
                  {item.label}
                </span>
              </div>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
