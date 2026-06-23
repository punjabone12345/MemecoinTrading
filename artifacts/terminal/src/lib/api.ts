import { Position, Analytics, Settings, Token, ScanStats } from './types.js';

const API_BASE = '/api';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  getPositions: () => apiFetch<{ open: Position[]; closed: Position[] }>('/positions'),
  getOpenPositions: () => apiFetch<Position[]>('/positions/open'),
  getClosedPositions: () => apiFetch<Position[]>('/positions/closed'),
  getAnalytics: () => apiFetch<Analytics>('/positions/analytics'),
  closePosition: (id: string, currentPrice: number) =>
    apiFetch<Position>(`/positions/${id}/close`, { method: 'POST', body: JSON.stringify({ currentPrice }) }),
  editPosition: (id: string, updates: Partial<Position>) =>
    apiFetch<Position>(`/positions/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deletePosition: (id: string) =>
    apiFetch<{ success: boolean }>(`/positions/${id}`, { method: 'DELETE' }),
  getScanner: () => apiFetch<{ tokens: Token[]; stats: ScanStats }>('/scanner'),
  getSettings: () => apiFetch<Settings>('/settings'),
  updateSettings: (updates: Partial<Settings>) =>
    apiFetch<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(updates) }),
  resetAll: () => apiFetch<{ success: boolean; balance: number }>('/settings/reset', { method: 'POST' }),
  getConfig: () => apiFetch<{ wsUrl: string | null }>('/config'),
};

// WebSocket with auto-reconnect
type WSHandler = (msg: { type: string; data: unknown }) => void;

// Cache the resolved WS URL so we only fetch /api/config once
let cachedWsUrl: string | null = null;

async function resolveWsUrl(): Promise<string> {
  if (cachedWsUrl) return cachedWsUrl;

  try {
    const cfg = await api.getConfig();
    if (cfg?.wsUrl) {
      cachedWsUrl = cfg.wsUrl;
      return cachedWsUrl;
    }
  } catch {
    // Fall through to default
  }

  // Fallback: derive from current page host (works when served directly from Render)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  cachedWsUrl = `${protocol}//${window.location.host}/ws`;
  return cachedWsUrl;
}

export async function createWS(onMessage: WSHandler): Promise<WebSocket> {
  const wsUrl = await resolveWsUrl();
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data as string);
      onMessage(msg);
    } catch {}
  };

  ws.onerror = () => {
    // Silent — reconnect logic is in App.tsx onclose handler
  };

  return ws;
}
