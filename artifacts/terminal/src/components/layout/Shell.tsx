import { ReactNode } from "react";
import { useWebSocket } from "@/lib/api";
import { BottomNav } from "./BottomNav";

export function Shell({ children }: { children: ReactNode }) {
  useWebSocket();
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white pb-16" style={{ fontFamily: "'Inter', sans-serif" }}>
      {children}
      <BottomNav />
    </div>
  );
}
