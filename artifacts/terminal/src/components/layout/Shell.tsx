import { ReactNode } from "react";
import { useWebSocket } from "@/lib/api";

export function Shell({ children }: { children: ReactNode }) {
  useWebSocket();
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white" style={{ fontFamily: "'Inter', sans-serif" }}>
      {children}
    </div>
  );
}
