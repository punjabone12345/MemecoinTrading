import { useLocation } from "wouter";
import { Telescope, BarChart3, Settings2 } from "lucide-react";

const tabs = [
  { path: "/", label: "FEED", icon: Telescope, accent: "#818cf8" },
  { path: "/analytics", label: "ANALYTICS", icon: BarChart3, accent: "#34d399" },
  { path: "/settings", label: "SETTINGS", icon: Settings2, accent: "#94a3b8" },
] as const;

export function BottomNav() {
  const [location, navigate] = useLocation();

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50"
      style={{
        background: "rgba(5, 5, 15, 0.95)",
        backdropFilter: "blur(24px)",
        borderTop: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div className="flex items-stretch h-[60px] max-w-2xl mx-auto">
        {tabs.map(({ path, label, icon: Icon, accent }, i) => {
          const active = path === "/" ? location === "/" : location.startsWith(path);
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className="flex-1 flex flex-col items-center justify-center gap-1 transition-all duration-200 relative"
              style={{ color: active ? accent : "rgba(255,255,255,0.3)" }}
            >
              {i > 0 && (
                <div
                  className="absolute left-0 top-3 bottom-3 w-px"
                  style={{ background: "rgba(255,255,255,0.07)" }}
                />
              )}
              {active && (
                <div
                  className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-[2px] rounded-full"
                  style={{ background: accent }}
                />
              )}
              <div
                className="flex items-center justify-center w-8 h-5 rounded-lg transition-colors"
                style={{ background: active ? `${accent}20` : "transparent" }}
              >
                <Icon size={16} />
              </div>
              <span
                className="text-[9px] font-bold tracking-widest"
                style={{ color: active ? accent : "rgba(255,255,255,0.3)" }}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
