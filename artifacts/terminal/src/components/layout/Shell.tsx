import { ReactNode } from "react";
import { useWebSocket } from "@/lib/api";
import { BottomNav } from "./BottomNav";

export function Shell({ children }: { children: ReactNode }) {
  useWebSocket();
  return (
    <div
      className="min-h-screen pb-20 text-slate-100"
      style={{
        background: "radial-gradient(ellipse at top, #0d0d1f 0%, #05050d 60%)",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      {children}
      <BottomNav />
    </div>
  );
}
