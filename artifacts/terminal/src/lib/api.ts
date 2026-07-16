import { Settings, SniperStatus, SniperPosition, ClosedSniperPosition } from './types.js';

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
  // ── Settings ───────────────────────────────────────────────────────────────
  getSettings:      () => apiFetch<Settings>('/settings'),
  updateSettings:   (updates: Partial<Settings>) =>
    apiFetch<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(updates) }),
  resetAll:         () => apiFetch<{ success: boolean; balance: number }>('/settings/reset', { method: 'POST' }),
  getConfig:        () => apiFetch<{ wsUrl: string | null }>('/config'),

  // ── Discovery ──────────────────────────────────────────────────────────────
  getScannerSources: () => apiFetch<{
    dexscreener: {
      total: number;
      recent: { mint: string; ts: number; description?: string; icon?: string; isMigration: boolean }[];
    };
  }>('/scanner/sources'),

  // ── Sniper engine — read ───────────────────────────────────────────────────
  getSniperStatus: () => apiFetch<SniperStatus>('/sniper/status'),

  // ── Sniper engine — open position management ───────────────────────────────
  closeSniperPosition: (id: string, reason?: string) =>
    apiFetch<{ success: boolean }>(`/sniper/${id}/close`, { method: 'POST', body: JSON.stringify({ reason }) }),
  editSniperPosition:  (id: string, updates: { entryPrice?: number; currentSLPrice?: number; triggerAmountUsd?: number }) =>
    apiFetch<SniperPosition>(`/sniper/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteSniperPosition: (id: string) =>
    apiFetch<{ success: boolean }>(`/sniper/${id}`, { method: 'DELETE' }),

  // ── Sniper engine — closed position management ─────────────────────────────
  editClosedSniperPosition:   (id: string, updates: { closeReason?: string; closePnlPct?: number }) =>
    apiFetch<ClosedSniperPosition>(`/sniper/closed/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }),
  deleteClosedSniperPosition: (id: string) =>
    apiFetch<{ success: boolean }>(`/sniper/closed/${id}`, { method: 'DELETE' }),
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
