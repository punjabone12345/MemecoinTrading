import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScannedToken, Position, Portfolio, AnalyticsSnapshot, Alert, AutoTraderStatus, AutoTraderConfig, CycleRecord, LossInsights } from "./types";
import { useToast } from "@/hooks/use-toast";

// When the frontend is deployed separately from the backend (e.g. Vercel + Render),
// set VITE_API_BASE_URL to the backend's origin (e.g. https://your-app.onrender.com).
// Leave it empty (default) when both run on the same host (dev / single-host deploy).
const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** Prefix a path with the backend origin when deployed separately */
function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function useWebSocket() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let timeoutId: any;
    let isMounted = true;

    function connect() {
      let wsUrl: string;
      if (API_BASE) {
        // Cross-host deployment: derive WS URL from the backend origin
        const wsProto = API_BASE.startsWith("https://") ? "wss://" : "ws://";
        wsUrl = `${wsProto}${API_BASE.replace(/^https?:\/\//, "")}/ws`;
      } else {
        // Same-host (dev Vite proxy or single-host prod): use window.location
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${protocol}//${window.location.host}/ws`;
      }
      const ws = new WebSocket(wsUrl);

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "scanner_update") {
            queryClient.setQueryData(["scanner"], data.data);
          } else if (data.type === "position_update") {
            queryClient.setQueryData(["positions"], data.data);
          } else if (data.type === "portfolio_update") {
            queryClient.setQueryData(["portfolio"], data.data);
          } else if (data.type === "alert") {
            queryClient.setQueryData<Alert[]>(["alerts"], (old = []) => [data.data, ...old]);
            toast({
              title: data.data.title,
              description: data.data.message,
            });
          }
        } catch (e) {
          // parse error
        }
      };

      ws.onclose = () => {
        if (isMounted) {
          timeoutId = setTimeout(connect, 3000);
        }
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      if (wsRef.current) wsRef.current.close();
    };
  }, [queryClient, toast]);
}

// Queries
export function useScanner() {
  return useQuery({
    queryKey: ["scanner"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/scanner"));
      const json = await res.json();
      return (json.data ?? json) as ScannedToken[];
    },
    refetchInterval: 5000,
  });
}

export function usePositions() {
  return useQuery({
    queryKey: ["positions"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/positions"));
      const json = await res.json();
      return (json.data ?? json) as { positions: Position[]; portfolio: Portfolio };
    },
    refetchInterval: 1000,
  });
}

export function useClosedPositions() {
  return useQuery({
    queryKey: ["closed-positions"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/positions/closed"));
      const json = await res.json();
      return (json.data ?? json) as Position[];
    },
  });
}

export function usePortfolio() {
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/positions/portfolio"));
      const json = await res.json();
      return (json.data ?? json) as Portfolio;
    },
    refetchInterval: 1000,
  });
}

export function useAnalytics() {
  return useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/analytics"));
      const json = await res.json();
      return (json.data ?? json) as AnalyticsSnapshot;
    },
  });
}

export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/alerts"));
      const json = await res.json();
      return (json.data ?? json) as Alert[];
    },
  });
}

export function useUnreadAlerts() {
  return useQuery({
    queryKey: ["alerts-unread"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/alerts/unread"));
      const json = await res.json();
      return (json.data ?? json) as Alert[];
    },
    refetchInterval: 5000,
  });
}

export function useAutoTraderStatus() {
  return useQuery({
    queryKey: ["auto-trader-status"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/auto-trader/status"));
      const json = await res.json();
      return (json.data ?? json) as AutoTraderStatus;
    },
    refetchInterval: 5000,
  });
}

export function useAutoTraderConfig() {
  return useQuery({
    queryKey: ["auto-trader-config"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/auto-trader/config"));
      const json = await res.json();
      return (json.data ?? json) as AutoTraderConfig;
    },
  });
}

export function useAutoTraderHistory() {
  return useQuery({
    queryKey: ["auto-trader-history"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/auto-trader/history"));
      const json = await res.json();
      return (json.data ?? json) as CycleRecord[];
    },
    refetchInterval: 10_000,
  });
}

export function useWatchlist() {
  return useQuery({
    queryKey: ["watchlist"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/watchlist"));
      const json = await res.json();
      return (json.data ?? json) as any[];
    },
  });
}

// Mutations
export function useClosePosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (positionId: string) => {
      await fetch(apiUrl("/api/paper-sell"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positionId }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["closed-positions"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useResetAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/reset"), { method: "POST" });
      if (!res.ok) throw new Error("Reset failed");
    },
    onSuccess: () => {
      queryClient.setQueryData(["closed-positions"], []);
      queryClient.setQueryData(["positions"], { positions: [], portfolio: null });
      queryClient.setQueryData(["portfolio"], null);
      queryClient.setQueryData(["analytics"], null);
      queryClient.setQueryData(["loss-journal"], null);
      queryClient.invalidateQueries();
    },
  });
}

export function useDeleteClosedTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (positionId: string) => {
      const res = await fetch(apiUrl(`/api/positions/history/${positionId}`), { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "Delete failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["closed-positions"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
}

export function useEditClosedTrade() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      positionId: string;
      pnlSol?: number;
      pnlPercent?: number;
      entryPrice?: number;
      exitPrice?: number;
      closeReason?: "manual" | "stop_loss" | "take_profit";
      note?: string;
    }) => {
      const { positionId, ...body } = payload;
      const res = await fetch(apiUrl(`/api/positions/history/${positionId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "Edit failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["closed-positions"] });
      queryClient.invalidateQueries({ queryKey: ["portfolio"] });
      queryClient.invalidateQueries({ queryKey: ["positions"] });
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
}

export function useAddWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { pairAddress: string; note?: string }) => {
      await fetch(apiUrl("/api/watchlist"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
    },
  });
}

export function useRemoveWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pairAddress: string) => {
      await fetch(apiUrl(`/api/watchlist/${pairAddress}`), { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
    },
  });
}

export function useUpdateWatchlistNote() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { pairAddress: string; note: string }) => {
      await fetch(apiUrl(`/api/watchlist/${data.pairAddress}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: data.note }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["watchlist"] });
    },
  });
}

export function useMarkAlertRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await fetch(apiUrl(`/api/alerts/${id}/read`), { method: "PATCH" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["alerts-unread"] });
    },
  });
}

export function useMarkAllAlertsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch(apiUrl("/api/alerts/read-all"), { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["alerts-unread"] });
    },
  });
}

export function useClearAlerts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch(apiUrl("/api/alerts"), { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["alerts-unread"] });
    },
  });
}

export function usePauseAutoTrader() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch(apiUrl("/api/auto-trader/pause"), { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto-trader-status"] });
    },
  });
}

export function useResumeAutoTrader() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch(apiUrl("/api/auto-trader/resume"), { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto-trader-status"] });
    },
  });
}

export function useResetCircuitBreaker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await fetch(apiUrl("/api/auto-trader/reset-circuit-breaker"), { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto-trader-status"] });
    },
  });
}

export function useLossJournal() {
  return useQuery<LossInsights>({
    queryKey: ["loss-journal"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/loss-journal"));
      const json = await res.json();
      return json.data as LossInsights;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export function useDeleteJournalEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (positionId: string) => {
      const res = await fetch(apiUrl(`/api/loss-journal/entries/${positionId}`), { method: "DELETE" });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error ?? "Delete failed");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loss-journal"] });
    },
  });
}

export function useClearJournal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/loss-journal/entries"), { method: "DELETE" });
      if (!res.ok) throw new Error("Clear failed");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loss-journal"] });
    },
  });
}

export function useUpdateAutoTraderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: Partial<AutoTraderConfig>) => {
      await fetch(apiUrl("/api/auto-trader/config"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto-trader-config"] });
      queryClient.invalidateQueries({ queryKey: ["auto-trader-status"] });
    },
  });
}
