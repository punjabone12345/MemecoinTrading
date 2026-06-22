import { useLocation } from "wouter";
import { Search, BarChart2, Settings } from "lucide-react";

const tabs = [
  { path: "/",          label: "DISCOVER", icon: Search,    color: "violet" },
  { path: "/analytics", label: "STATS",    icon: BarChart2, color: "cyan"   },
  { path: "/settings",  label: "SETTINGS", icon: Settings,  color: "amber"  },
];

const colorMap: Record<string, { active: string; bg: string }> = {
  violet: { active: "text-violet-400", bg: "bg-violet-500/20" },
  cyan:   { active: "text-cyan-400",   bg: "bg-cyan-500/20"   },
  amber:  { active: "text-amber-400",  bg: "bg-amber-500/20"  },
};

export function BottomNav() {
  const [location, navigate] = useLocation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-[#0d0d15]/95 backdrop-blur-xl border-t border-white/8">
      <div className="flex items-stretch h-16 max-w-screen-xl mx-auto">
        {tabs.map((tab, i) => {
          const isActive = tab.path === "/" ? location === "/" : location.startsWith(tab.path);
          const colors = colorMap[tab.color]!;
          const Icon = tab.icon;
          return (
            <div key={tab.path} className="flex items-stretch flex-1">
              {i > 0 && <div className="w-px bg-white/8 my-3" />}
              <button
                onClick={() => navigate(tab.path)}
                className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
                  isActive ? colors.active : "text-white/30 hover:text-white/60"
                }`}
              >
                <div className={`flex items-center justify-center w-10 h-6 rounded-full transition-colors ${
                  isActive ? colors.bg : ""
                }`}>
                  <Icon size={18} />
                </div>
                <span className={`text-[10px] font-bold tracking-wider ${isActive ? colors.active : "text-white/30"}`}>
                  {tab.label}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
