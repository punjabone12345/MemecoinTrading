import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SniperStatus, SniperPosition, SniperEvent, SniperConfig, StuckToken, SniperHealthMetrics, PaperSniperStatus, PaperPosition, PaperSniperEvent, PaperConfig } from "./types";
import { useToast } from "@/hooks/use-toast";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function useWebSocket() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;
    let isMounted = true;

    function connect() {
      let wsUrl: string;
      if (API_BASE) {
        const wsProto = API_BASE.startsWith("https://") ? "wss://" : "ws://";
        wsUrl = `${wsProto}${API_BASE.replace(/^https?:\/\//, "")}/ws`;
      } else {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${protocol}//${window.location.host}/ws`;
      }
      const ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          if (data.type === "sniper_update") {
            queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
            queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
            queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
            queryClient.invalidateQueries({ queryKey: ["sniper-wallet"] });
            queryClient.invalidateQueries({ queryKey: ["sniper-stuck-tokens"] });
          }
          if (data.type === "paper_sniper_update") {
            queryClient.invalidateQueries({ queryKey: ["paper-sniper-status"] });
            queryClient.invalidateQueries({ queryKey: ["paper-sniper-positions"] });
            queryClient.invalidateQueries({ queryKey: ["paper-sniper-history"] });
            queryClient.invalidateQueries({ queryKey: ["paper-sniper-events"] });
          }
        } catch (_) {}
      };

      ws.onclose = () => {
        if (isMounted) timeoutId = setTimeout(connect, 3000);
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      if (wsRef.current) wsRef.current.close();
    };
  }, [queryClient]);
}

// ── Sniper queries ─────────────────────────────────────────────────────────────

export interface WalletInfo {
  address: string;
  balance: number;
  ready: boolean;
  solscan: string | null;
}

export function useWalletBalance() {
  return useQuery<WalletInfo>({
    queryKey: ["sniper-wallet"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/wallet"));
      const json = await res.json() as { data: WalletInfo };
      return json.data;
    },
    refetchInterval: 5000,
  });
}

export function useSniperStatus() {
  return useQuery<SniperStatus>({
    queryKey: ["sniper-status"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/status"));
      const json = await res.json() as { data: SniperStatus };
      return json.data;
    },
    refetchInterval: 5000,
  });
}

export function useSniperPositions() {
  return useQuery<SniperPosition[]>({
    queryKey: ["sniper-positions"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/positions"));
      const json = await res.json() as { data: SniperPosition[] };
      return json.data;
    },
    refetchInterval: 10000,
  });
}

export function useSniperHistory() {
  return useQuery<SniperPosition[]>({
    queryKey: ["sniper-history"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/history"));
      const json = await res.json() as { data: SniperPosition[] };
      return json.data;
    },
    refetchInterval: 30000,
  });
}

export function useSniperEvents() {
  return useQuery<SniperEvent[]>({
    queryKey: ["sniper-events"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/events"));
      const json = await res.json() as { data: SniperEvent[] };
      return json.data;
    },
    refetchInterval: 5000,
  });
}

export function useSniperConfig() {
  return useQuery<SniperConfig>({
    queryKey: ["sniper-config"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/config"));
      const json = await res.json() as { data: SniperConfig };
      return json.data;
    },
  });
}

// ── Stuck tokens — tokens in wallet but not tracked as open positions ──────────
export function useStuckTokens() {
  return useQuery<StuckToken[]>({
    queryKey: ["sniper-stuck-tokens"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/stuck-tokens"));
      if (!res.ok) return [];
      const json = await res.json() as { data: StuckToken[] };
      return json.data ?? [];
    },
    refetchInterval: 30_000,
  });
}

// ── Sniper health metrics — rate counters + connection status ─────────────────
export function useSniperHealthMetrics() {
  return useQuery<SniperHealthMetrics>({
    queryKey: ["sniper-health-metrics"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/health-metrics"));
      const json = await res.json() as { data: SniperHealthMetrics };
      return json.data;
    },
    refetchInterval: 15_000,
  });
}

// ── Sniper mutations ───────────────────────────────────────────────────────────

export function useUpdateSniperConfig() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (config: Partial<SniperConfig>) => {
      const res = await fetch(apiUrl("/api/sniper/config"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const json = await res.json() as { data: SniperConfig };
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-config"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Settings saved", description: "Sniper config updated successfully." });
    },
    onError: () => {
      toast({ title: "Save failed", description: "Could not update sniper config.", variant: "destructive" });
    },
  });
}

// Track per-position close status for live UI feedback
export type CloseStatus = "idle" | "pending" | "success" | "failed";

export function useCloseSniperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [closeStatuses, setCloseStatuses] = useState<Record<string, CloseStatus>>({});
  const [closeErrors, setCloseErrors]     = useState<Record<string, string>>({});

  const mutation = useMutation({
    mutationFn: async (id: string) => {
      setCloseStatuses(prev => ({ ...prev, [id]: "pending" }));
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/close`), { method: "POST" });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? "Close failed");
      }
      return { id, ...(await res.json() as object) };
    },
    onSuccess: (data: { id: string }) => {
      setCloseStatuses(prev => ({ ...prev, [data.id]: "success" }));
      setCloseErrors(prev => { const n = { ...prev }; delete n[data.id]; return n; });
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Position closed", description: "Sell confirmed on-chain ✅" });
      // Clear success status after 3s
      setTimeout(() => setCloseStatuses(prev => {
        if (prev[data.id] === "success") { const n = { ...prev }; delete n[data.id]; return n; }
        return prev;
      }), 3000);
    },
    onError: (e: Error, id: string) => {
      setCloseStatuses(prev => ({ ...prev, [id]: "failed" }));
      setCloseErrors(prev => ({ ...prev, [id]: e.message }));
      toast({ title: "Close failed", description: e.message, variant: "destructive" });
    },
  });

  return { ...mutation, closeStatuses, closeErrors };
}

// ── Emergency sell — max slippage (50%), for stuck/unsellable positions ────────
export function useEmergencySell() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/emergency-sell`), { method: "POST" });
      if (!res.ok) {
        const j = await res.json() as { error?: string };
        throw new Error(j.error ?? "Emergency sell failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-stuck-tokens"] });
      toast({ title: "Emergency sell executed ✅", description: "Sold with 50% max slippage" });
    },
    onError: (e: Error) => toast({ title: "Emergency sell failed", description: e.message, variant: "destructive" }),
  });
}

export function useDeleteSniperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}`), { method: "DELETE" });
      if (!res.ok) { const j = await res.json() as { error?: string }; throw new Error(j.error ?? "Delete failed"); }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Position deleted" });
    },
    onError: (e: Error) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });
}

export function useEditSniperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (payload: {
      id: string;
      entryPrice?: number;
      exitPrice?: number;
      currentPrice?: number;
      closeReason?: string;
      realizedPnlSol?: number;
    }) => {
      const { id, ...body } = payload;
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const j = await res.json() as { error?: string }; throw new Error(j.error ?? "Edit failed"); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Position updated" });
    },
    onError: (e: Error) => toast({ title: "Edit failed", description: e.message, variant: "destructive" }),
  });
}

export function useRecalculateSniperPnl() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/recalculate`), { method: "POST" });
      if (!res.ok) { const j = await res.json() as { error?: string }; throw new Error(j.error ?? "Recalculate failed"); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "P&L corrected", description: "Recalculated from entry/exit prices and config TP levels." });
    },
    onError: (e: Error) => toast({ title: "Recalculate failed", description: e.message, variant: "destructive" }),
  });
}

export function useInjectSniperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (payload: {
      mint: string;
      symbol: string;
      entryPrice: number;
      sizeSol: number;
      entryAtMs?: number;
    }) => {
      const res = await fetch(apiUrl("/api/sniper/positions/inject"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { const j = await res.json() as { error?: string }; throw new Error(j.error ?? "Inject failed"); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Position re-entered", description: "Price will sync via Jupiter within 10 seconds." });
    },
    onError: (e: Error) => toast({ title: "Inject failed", description: e.message, variant: "destructive" }),
  });
}

export function usePurgeUnverifiedHistory() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/history/purge-unverified"), { method: "POST" });
      if (!res.ok) throw new Error("Purge failed");
      const j = await res.json() as { data: { removed: number } };
      return j.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({
        title: data.removed > 0 ? `Purged ${data.removed} unverified record${data.removed > 1 ? "s" : ""}` : "Nothing to purge",
        description: data.removed > 0 ? "Only on-chain confirmed trades remain in history." : "All history is already verified.",
      });
    },
    onError: () => toast({ title: "Purge failed", variant: "destructive" }),
  });
}

export function useDeleteSniperEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/sniper/events/${id}`), { method: "DELETE" });
      if (!res.ok) { const j = await res.json() as { error?: string }; throw new Error(j.error ?? "Delete failed"); }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-events"] });
    },
  });
}

// ── Paper Sniper queries ──────────────────────────────────────────────────────

export function usePaperSniperStatus() {
  return useQuery<PaperSniperStatus>({
    queryKey: ["paper-sniper-status"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/paper-sniper/status"));
      return res.json() as Promise<PaperSniperStatus>;
    },
    refetchInterval: 5000,
  });
}

export function usePaperSniperPositions() {
  return useQuery<PaperPosition[]>({
    queryKey: ["paper-sniper-positions"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/paper-sniper/positions"));
      return res.json() as Promise<PaperPosition[]>;
    },
    refetchInterval: 10000,
  });
}

export function usePaperSniperHistory() {
  return useQuery<PaperPosition[]>({
    queryKey: ["paper-sniper-history"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/paper-sniper/history"));
      return res.json() as Promise<PaperPosition[]>;
    },
    refetchInterval: 30000,
  });
}

export function usePaperSniperEvents() {
  return useQuery<PaperSniperEvent[]>({
    queryKey: ["paper-sniper-events"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/paper-sniper/events"));
      return res.json() as Promise<PaperSniperEvent[]>;
    },
    refetchInterval: 5000,
  });
}

export function usePaperSniperConfig() {
  return useQuery<PaperConfig>({
    queryKey: ["paper-sniper-config"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/paper-sniper/config"));
      return res.json() as Promise<PaperConfig>;
    },
    staleTime: 30_000,
  });
}

export function useUpdatePaperSniperConfig() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (patch: Partial<PaperConfig>) => {
      const res = await fetch(apiUrl("/api/paper-sniper/config"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Config update failed");
      return res.json() as Promise<PaperConfig>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-config"] });
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-status"] });
      toast({ title: "Paper settings saved", description: "New config is active immediately." });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });
}

export function useClosePaperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/paper-sniper/positions/${id}/close`), { method: "POST" });
      if (!res.ok) throw new Error("Close failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-status"] });
      toast({ title: "Position closed", description: "Manually closed at current price." });
    },
    onError: () => toast({ title: "Close failed", variant: "destructive" }),
  });
}

export function useResetPaperAccount() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/paper-sniper/reset"), { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-status"] });
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["paper-sniper-events"] });
      toast({ title: "Paper account reset", description: "Virtual balance restored to 0.1 SOL." });
    },
    onError: () => toast({ title: "Reset failed", variant: "destructive" }),
  });
}

export function useResetSniperAccount() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/reset"), { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-events"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Account reset", description: "All positions cleared, balance restored." });
    },
    onError: () => toast({ title: "Reset failed", variant: "destructive" }),
  });
}
