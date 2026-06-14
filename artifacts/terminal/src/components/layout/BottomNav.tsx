import { useLocation } from "wouter";
import { Target, FileText } from "lucide-react";

export function BottomNav() {
  const [location, navigate] = useLocation();
  const isLive  = location === "/" || location === "/sniper";
  const isPaper = location === "/paper";

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-[#0d0d15]/95 backdrop-blur-xl border-t border-white/8">
      <div className="flex items-stretch h-16 max-w-screen-xl mx-auto">
        {/* Live Sniper tab */}
        <button
          onClick={() => navigate("/sniper")}
          className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
            isLive
              ? "text-violet-400"
              : "text-white/30 hover:text-white/60"
          }`}
        >
          <div className={`relative flex items-center justify-center w-10 h-6 rounded-full transition-colors ${
            isLive ? "bg-violet-500/20" : ""
          }`}>
            <Target size={18} />
            {isLive && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            )}
          </div>
          <span className={`text-[10px] font-bold tracking-wider ${isLive ? "text-violet-400" : "text-white/30"}`}>
            LIVE
          </span>
        </button>

        {/* Divider */}
        <div className="w-px bg-white/8 my-3" />

        {/* Paper Mode tab */}
        <button
          onClick={() => navigate("/paper")}
          className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
            isPaper
              ? "text-amber-400"
              : "text-white/30 hover:text-white/60"
          }`}
        >
          <div className={`flex items-center justify-center w-10 h-6 rounded-full transition-colors ${
            isPaper ? "bg-amber-500/20" : ""
          }`}>
            <FileText size={18} />
          </div>
          <span className={`text-[10px] font-bold tracking-wider ${isPaper ? "text-amber-400" : "text-white/30"}`}>
            PAPER
          </span>
        </button>
      </div>
    </nav>
  );
}
