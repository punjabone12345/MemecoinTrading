import {
  Settings,
  AltcoinStatusResponse,
  AltcoinAsset,
  AltcoinSignal,
  PaperPortfolio,
  PaperPosition,
  ClosedPaperPosition,
  LearningMetrics,
  SystemHealth,
  SniperStatus,
  SniperPosition,
  ClosedSniperPosition,
  DiagToken,
  DiagError,
  DiagFunnelStats,
  DiagDailySummary,
  DiagTransaction
} from './types.js';

// Active Render production backend URL
const DEFAULT_RENDER_URL = 'https://memecointradingbot2-pk0b.onrender.com';

function resolveBackend(): string {
  if (import.meta.env.DEV) return '';
  // If hosted directly on Render, use same-origin relative requests
  if (typeof window !== 'undefined' && window.location.hostname.includes('onrender.com')) {
    return '';
  }
  const envUrl = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');
  // Ignore suspended / old render domains
  if (envUrl && !envUrl.includes('memecointrading-thpe')) {
    return envUrl;
  }
  return DEFAULT_RENDER_URL;
}

const BACKEND = resolveBackend();
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

  // ── Altcoin Trading Engine ──────────────────────────────────────────────────
  getAltcoinStatus: () => apiFetch<AltcoinStatusResponse>('/altcoin/status'),
  getAltcoinAssets: () => apiFetch<{ assets: AltcoinAsset[] }>('/altcoin/assets'),
  getAltcoinSignals: () => apiFetch<{ signals: AltcoinSignal[] }>('/altcoin/signals'),
  getPaperPortfolio: () => apiFetch<PaperPortfolio>('/altcoin/portfolio'),
  closeAltcoinPosition: (id: string, reason?: string) =>
    apiFetch<{ success: boolean; portfolio?: PaperPortfolio }>(`/altcoin/close/${id}`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  resetAltcoinPortfolio: (initialBalanceUsd?: number) =>
    apiFetch<{ success: boolean; portfolio: PaperPortfolio }>('/altcoin/reset', {
      method: 'POST',
      body: JSON.stringify({ initialBalanceUsd }),
    }),
  getAltcoinLearning: () => apiFetch<LearningMetrics>('/altcoin/learning'),
  getAltcoinHealth: () => apiFetch<SystemHealth>('/altcoin/health'),
  editPaperPosition: (id: string, updates: Partial<PaperPosition & ClosedPaperPosition>) =>
    apiFetch<{ success: boolean; position: PaperPosition | ClosedPaperPosition; portfolio?: PaperPortfolio }>(`/altcoin/positions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    }),
  deletePaperPosition: (id: string) =>
    apiFetch<{ success: boolean; portfolio: PaperPortfolio }>(`/altcoin/positions/${id}`, {
      method: 'DELETE',
    }),
  testTelegram: () =>
    apiFetch<{ success: boolean; error?: string }>('/altcoin/telegram/test', {
      method: 'POST',
    }),

  // ── Legacy Sniper compatibility ──────────────────────────────────────────────
  getSniperStatus: () => apiFetch<AltcoinStatusResponse>('/sniper/status'),
  closeSniperPosition: (id: string, reason?: string) =>
    apiFetch<{ success: boolean }>(`/sniper/${id}/close`, { method: 'POST', body: JSON.stringify({ reason }) }),

  // ── Diagnostics ────────────────────────────────────────────────────────────
  getDiagTokens: (opts?: { status?: string; limit?: number; offset?: number; since?: number }) => {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit  != null) params.set('limit',  String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.since  != null) params.set('since',  String(opts.since));
    const qs = params.toString();
    return apiFetch<{ rows: DiagToken[]; total: number }>(`/diagnostics/tokens${qs ? '?' + qs : ''}`);
  },
  getDiagTopRejected: (opts?: { since?: number }) => {
    const params = new URLSearchParams();
    if (opts?.since != null) params.set('since', String(opts.since));
    const qs = params.toString();
    return apiFetch<{ rows: DiagToken[] }>(`/diagnostics/top-rejected${qs ? '?' + qs : ''}`);
  },
  getDiagSummary: (date?: string) =>
    apiFetch<DiagDailySummary>(`/diagnostics/summary${date ? '?date=' + date : ''}`),
  getDiagErrors: (opts?: { limit?: number; errorType?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit     != null) params.set('limit',     String(opts.limit));
    if (opts?.errorType)         params.set('errorType', opts.errorType);
    const qs = params.toString();
    return apiFetch<{ rows: DiagError[] }>(`/diagnostics/errors${qs ? '?' + qs : ''}`);
  },
  getDiagTransactions: (opts?: { limit?: number; offset?: number; mint?: string; txType?: string; since?: number }) => {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set('limit', String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.mint) params.set('mint', opts.mint);
    if (opts?.txType) params.set('txType', opts.txType);
    if (opts?.since != null) params.set('since', String(opts.since));
    const qs = params.toString();
    return apiFetch<{ rows: DiagTransaction[]; total: number }>(`/diagnostics/transactions${qs ? '?' + qs : ''}`);
  },
  getDiagFunnel: (opts?: { since?: number }) => {
    const params = new URLSearchParams();
    if (opts?.since != null) params.set('since', String(opts.since));
    const qs = params.toString();
    return apiFetch<DiagFunnelStats>(`/diagnostics/funnel${qs ? '?' + qs : ''}`);
  },
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

export function createWS(
  onMessage: WSHandler,
  onOpen?: () => void,
  onClose?: () => void,
  onError?: (err: Event) => void
): WebSocket {
  const wsUrl = buildWsUrl();
  const ws = new WebSocket(wsUrl);

  if (onOpen) ws.addEventListener('open', onOpen);
  if (onClose) ws.addEventListener('close', onClose);
  if (onError) ws.addEventListener('error', onError);

  ws.addEventListener('message', (evt) => {
    try {
      const msg = JSON.parse(evt.data as string);
      onMessage(msg);
    } catch {}
  });

  return ws;
}
