import { Position, Analytics, Settings, Token, ScanStats } from './types.js';

// In local dev VITE_API_URL is empty — Vite proxy forwards /api → :8080.
// On Vercel set VITE_API_URL=https://your-app.onrender.com so the static
// build can reach the Render backend directly.
const BACKEND = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '';
const API_BASE = BACKEND ? `${BACKEND}/api` : '/api';

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
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

function buildWsUrl(): string {
  if (BACKEND) {
    // Absolute backend URL provided — derive wss:// from it directly.
    return BACKEND.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/ws';
  }
  // Local dev: derive from the current page host (Vite proxy handles it).
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

export async function createWS(onMessage: WSHandler): Promise<WebSocket> {
  const wsUrl = buildWsUrl();
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
