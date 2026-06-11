import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SniperStatus, SniperPosition, SniperEvent, SniperConfig } from "./types";
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
    refetchInterval: 15000,
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

export function useCloseSniperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/close`), { method: "POST" });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Close failed"); }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      toast({ title: "Position closed at market price" });
    },
    onError: (e: Error) => toast({ title: "Close failed", description: e.message, variant: "destructive" }),
  });
}

export function useDeleteSniperPosition() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}`), { method: "DELETE" });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Delete failed"); }
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
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Edit failed"); }
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
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Recalculate failed"); }
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
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Inject failed"); }
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
      if (!res.ok) { const j = await res.json(); throw new Error(j.error ?? "Delete failed"); }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sniper-events"] });
    },
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
