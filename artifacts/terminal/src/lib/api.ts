import { useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { EDStatus, EDToken, EDPosition, EDConfig, EDAnalytics } from "./types";

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
          const data = JSON.parse(event.data as string) as { type: string };
          if (data.type === "ed_update") {
            void queryClient.invalidateQueries({ queryKey: ["ed-status"] });
            void queryClient.invalidateQueries({ queryKey: ["ed-tokens"] });
            void queryClient.invalidateQueries({ queryKey: ["ed-positions"] });
            void queryClient.invalidateQueries({ queryKey: ["ed-analytics"] });
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
    refetchInterval: 8_000,
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
