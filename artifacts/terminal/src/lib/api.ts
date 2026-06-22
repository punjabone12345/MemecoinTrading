import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  EDStatus, EDToken, EDPosition, EDConfig, EDAnalytics,
  SniperStatus, SniperPosition, SniperEvent, SniperConfig,
  WatchedGrad, StuckToken, WalletBalance,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
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
          const msg = JSON.parse(event.data as string) as { type: string; data: unknown; timestamp: number };

          if (msg.type === "ed_update" && msg.data) {
            const d = msg.data as {
              status: EDStatus;
              positions: { open: EDPosition[]; closed: EDPosition[] };
            };
            queryClient.setQueryData(["ed-status"], d.status);
            queryClient.setQueryData(["ed-positions"], d.positions);
          } else if (msg.type === "ed_update") {
            void queryClient.invalidateQueries({ queryKey: ["ed-status"] });
            void queryClient.invalidateQueries({ queryKey: ["ed-tokens"] });
            void queryClient.invalidateQueries({ queryKey: ["ed-positions"] });
            void queryClient.invalidateQueries({ queryKey: ["ed-analytics"] });
          } else if (msg.type === "sniper_update" && msg.data) {
            const d = msg.data as {
              status: SniperStatus;
              positions: SniperPosition[];
              history: SniperPosition[];
            };
            queryClient.setQueryData(["sniper-status"], d.status);
            queryClient.setQueryData(["sniper-positions"], d.positions);
            queryClient.setQueryData(["sniper-history"], d.history);
          } else if (msg.type === "paper_update" && msg.data) {
            const d = msg.data as {
              status: unknown;
              openPositions: unknown[];
              history: unknown[];
            };
            queryClient.setQueryData(["paper-status"], d.status);
            queryClient.setQueryData(["paper-positions"], d.openPositions);
          }
        } catch { /* ignore */ }
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

// ── ED Hooks ──────────────────────────────────────────────────────────────────

export function useEDStatus() {
  return useQuery<EDStatus>({
    queryKey: ["ed-status"],
    queryFn: () => apiFetch<EDStatus>("/api/ed/status"),
    refetchInterval: 8_000,
  });
}

export function useEDTokens() {
  return useQuery<EDToken[]>({
    queryKey: ["ed-tokens"],
    queryFn: () => apiFetch<EDToken[]>("/api/ed/tokens"),
    refetchInterval: 10_000,
  });
}

export function useEDPositions() {
  return useQuery<{ open: EDPosition[]; closed: EDPosition[] }>({
    queryKey: ["ed-positions"],
    queryFn: () => apiFetch<{ open: EDPosition[]; closed: EDPosition[] }>("/api/ed/positions"),
    refetchInterval: 3_000,
  });
}

export function useEDConfig() {
  return useQuery<EDConfig>({
    queryKey: ["ed-config"],
    queryFn: () => apiFetch<EDConfig>("/api/ed/config"),
    staleTime: 30_000,
  });
}

export function useUpdateEDConfig() {
  const queryClient = useQueryClient();
  return useMutation<EDConfig, Error, Partial<EDConfig>>({
    mutationFn: async (patch) => {
      const res = await fetch(apiUrl("/api/ed/config"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<EDConfig>;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["ed-config"], data);
    },
  });
}

export function useEDClosePosition() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/ed/positions/${id}/close`), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ed-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["ed-status"] });
      void queryClient.invalidateQueries({ queryKey: ["ed-analytics"] });
    },
  });
}

export function useEDDeletePosition() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean }, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/ed/positions/${id}`), { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ed-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["ed-status"] });
      void queryClient.invalidateQueries({ queryKey: ["ed-analytics"] });
    },
  });
}

export interface EDPositionPatch {
  entryPrice?: number;
  entryScore?: number;
  sizeSol?: number;
  effectiveSlPrice?: number;
  trailingHigh?: number;
  tp1Hit?: boolean;
  tp2Hit?: boolean;
  closeReason?: string;
  closingScore?: number;
  exitPrice?: number;
  realizedPnlSol?: number;
  tp1RealizedSol?: number;
  tp2RealizedSol?: number;
  runnerRealizedSol?: number;
}

export function useEDEditPosition() {
  const queryClient = useQueryClient();
  return useMutation<EDPosition, Error, { id: string; patch: EDPositionPatch }>({
    mutationFn: async ({ id, patch }) => {
      const res = await fetch(apiUrl(`/api/ed/positions/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<EDPosition>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ed-positions"] });
    },
  });
}

export function useEDAnalytics() {
  return useQuery<EDAnalytics>({
    queryKey: ["ed-analytics"],
    queryFn: () => apiFetch<EDAnalytics>("/api/ed/analytics"),
    refetchInterval: 30_000,
  });
}

export function useResetPaperBalance() {
  const queryClient = useQueryClient();
  return useMutation<{ ok: boolean; balance: number }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/ed/reset-paper"), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ ok: boolean; balance: number }>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ed-status"] });
      void queryClient.invalidateQueries({ queryKey: ["ed-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["ed-analytics"] });
    },
  });
}

export function useInjectTestToken() {
  return useMutation<{ ok: boolean; mint: string }, Error, string>({
    mutationFn: async (mint) => {
      const res = await fetch(apiUrl("/api/ed/inject-test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mint }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json() as Promise<{ ok: boolean; mint: string }>;
    },
  });
}

// ── Graduation Sniper Hooks ───────────────────────────────────────────────────

export function useSniperStatus() {
  return useQuery<SniperStatus>({
    queryKey: ["sniper-status"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: SniperStatus }>("/api/sniper/status");
      return res.data;
    },
    refetchInterval: 5_000,
  });
}

export function useSniperPositions() {
  return useQuery<SniperPosition[]>({
    queryKey: ["sniper-positions"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: SniperPosition[] }>("/api/sniper/positions");
      return res.data;
    },
    refetchInterval: 5_000,
  });
}

export function useSniperHistory() {
  return useQuery<SniperPosition[]>({
    queryKey: ["sniper-history"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: SniperPosition[] }>("/api/sniper/history");
      return res.data;
    },
    refetchInterval: 30_000,
  });
}

export function useSniperEvents() {
  return useQuery<SniperEvent[]>({
    queryKey: ["sniper-events"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: SniperEvent[] }>("/api/sniper/events");
      return res.data;
    },
    refetchInterval: 10_000,
  });
}

export function useUpdateSniperConfig() {
  const queryClient = useQueryClient();
  return useMutation<SniperConfig, Error, Partial<SniperConfig>>({
    mutationFn: async (patch) => {
      const res = await fetch(apiUrl("/api/sniper/config"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as { success: boolean; data: SniperConfig };
      return json.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
    },
  });
}

export function useDeleteSniperPosition() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}`), { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
    },
  });
}

export function useEditSniperPosition() {
  const queryClient = useQueryClient();
  return useMutation<SniperPosition, Error, { id: string; patch: Partial<Pick<SniperPosition, "entryPrice" | "exitPrice" | "currentPrice" | "closeReason" | "realizedPnlSol">> }>({
    mutationFn: async ({ id, patch }) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as { success: boolean; data: SniperPosition };
      return json.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
    },
  });
}

export function useDeleteSniperEvent() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/sniper/events/${id}`), { method: "DELETE" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-events"] });
    },
  });
}

export function useResetSniperAccount() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/reset"), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
    },
  });
}

export function useRecalculateSniperPnl() {
  const queryClient = useQueryClient();
  return useMutation<SniperPosition, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/recalculate`), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as { success: boolean; data: SniperPosition };
      return json.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
    },
  });
}

export function useCloseSniperPosition() {
  const queryClient = useQueryClient();
  return useMutation<SniperPosition, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/close`), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as { success: boolean; data: SniperPosition };
      return json.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
    },
  });
}

export function useWalletBalance() {
  return useQuery<WalletBalance>({
    queryKey: ["sniper-wallet"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: WalletBalance }>("/api/sniper/wallet");
      return res.data;
    },
    refetchInterval: 30_000,
  });
}

export function usePurgeUnverifiedHistory() {
  const queryClient = useQueryClient();
  return useMutation<{ removed: number }, Error, void>({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/sniper/history/purge-unverified"), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as { success: boolean; data: { removed: number } };
      return json.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
    },
  });
}

export function useStuckTokens() {
  return useQuery<StuckToken[]>({
    queryKey: ["sniper-stuck"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: StuckToken[] }>("/api/sniper/stuck-tokens");
      return res.data;
    },
    refetchInterval: 60_000,
  });
}

export function useEmergencySell() {
  const queryClient = useQueryClient();
  return useMutation<SniperPosition, Error, string>({
    mutationFn: async (id) => {
      const res = await fetch(apiUrl(`/api/sniper/positions/${id}/emergency-sell`), { method: "POST" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json() as { success: boolean; data: SniperPosition };
      return json.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["sniper-positions"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-history"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-status"] });
      void queryClient.invalidateQueries({ queryKey: ["sniper-wallet"] });
    },
  });
}

export function useWatchedGrads() {
  return useQuery<WatchedGrad[]>({
    queryKey: ["sniper-watched"],
    queryFn: async () => {
      const res = await apiFetch<{ success: boolean; data: WatchedGrad[] }>("/api/sniper/watched");
      return res.data;
    },
    refetchInterval: 2_000,
  });
}
