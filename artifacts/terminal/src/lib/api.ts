import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ScannedToken, Position, Portfolio, AnalyticsSnapshot, Alert, AutoTraderStatus, AutoTraderConfig } from "./types";
import { useToast } from "@/hooks/use-toast";

export function useWebSocket() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    let timeoutId: any;
    let isMounted = true;

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
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
      const res = await fetch("/api/scanner");
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
      const res = await fetch("/api/positions");
      const json = await res.json();
      return (json.data ?? json) as { positions: Position[]; portfolio: Portfolio };
    },
    refetchInterval: 5000,
  });
}

export function useClosedPositions() {
  return useQuery({
    queryKey: ["closed-positions"],
    queryFn: async () => {
      const res = await fetch("/api/positions/closed");
      const json = await res.json();
      return (json.data ?? json) as Position[];
    },
  });
}

export function usePortfolio() {
  return useQuery({
    queryKey: ["portfolio"],
    queryFn: async () => {
      const res = await fetch("/api/positions/portfolio");
      const json = await res.json();
      return (json.data ?? json) as Portfolio;
    },
    refetchInterval: 5000,
  });
}

export function useAnalytics() {
  return useQuery({
    queryKey: ["analytics"],
    queryFn: async () => {
      const res = await fetch("/api/analytics");
      const json = await res.json();
      return (json.data ?? json) as AnalyticsSnapshot;
    },
  });
}

export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: async () => {
      const res = await fetch("/api/alerts");
      const json = await res.json();
      return (json.data ?? json) as Alert[];
    },
  });
}

export function useUnreadAlerts() {
  return useQuery({
    queryKey: ["alerts-unread"],
    queryFn: async () => {
      const res = await fetch("/api/alerts/unread");
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
      const res = await fetch("/api/auto-trader/status");
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
      const res = await fetch("/api/auto-trader/config");
      const json = await res.json();
      return (json.data ?? json) as AutoTraderConfig;
    },
  });
}

export function useWatchlist() {
  return useQuery({
    queryKey: ["watchlist"],
    queryFn: async () => {
      const res = await fetch("/api/watchlist");
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
      await fetch("/api/paper-sell", {
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
      await fetch("/api/reset", { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  });
}

export function useAddWatchlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { pairAddress: string; note?: string }) => {
      await fetch("/api/watchlist", {
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
      await fetch(`/api/watchlist/${pairAddress}`, { method: "DELETE" });
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
      await fetch(`/api/watchlist/${data.pairAddress}`, {
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
      await fetch(`/api/alerts/${id}/read`, { method: "PATCH" });
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
      await fetch("/api/alerts/read-all", { method: "POST" });
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
      await fetch("/api/alerts", { method: "DELETE" });
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
      await fetch("/api/auto-trader/pause", { method: "POST" });
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
      await fetch("/api/auto-trader/resume", { method: "POST" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auto-trader-status"] });
    },
  });
}

export function useUpdateAutoTraderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: Partial<AutoTraderConfig>) => {
      await fetch("/api/auto-trader/config", {
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
