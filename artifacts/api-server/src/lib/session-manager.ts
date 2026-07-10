/**
 * Session Manager — governs whether all background services are running.
 *
 * Two signals are combined into one "should run" decision:
 *   1. botEnabled (manual toggle, persisted in DB) — false = hard stop, no auto-resume.
 *   2. tradingWindow (IST schedule) — when enabled, services pause outside the window
 *      and auto-resume when the window opens, as long as botEnabled is true.
 *
 * A 60-second ticker re-evaluates the window every minute so transitions happen
 * within 1 minute of the configured start/end time.
 */

import { getSettings } from '../services/settings.service.js';
import { startTrenchesScanner, stopTrenchesScanner } from '../services/trenches.service.js';
import { resumeWhaleSniper, stopWhaleSniper } from '../services/whale-sniper.service.js';
import { startTelegramCommands, stopTelegramCommands } from './telegram-commands.js';
import { stopHeliusWs } from './helius-ws-shared.js';
import { logger } from './logger.js';

// Current observed state of services. null = not yet initialised.
let _servicesRunning: boolean | null = null;
let _scheduleTimer: ReturnType<typeof setTimeout> | null = null;

// ── IST window helpers ────────────────────────────────────────────────────────

function getISTMinutes(): number {
  // Intl.DateTimeFormat is the only correct way to get IST regardless of host timezone.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour')?.value  ?? '0', 10);
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  return (h % 24) * 60 + m; // normalise hour=24 (midnight) to 0
}

function isInsideWindow(start: string, end: string): boolean {
  const cur = getISTMinutes();
  const [sh, sm] = (start || '00:00').split(':').map(Number);
  const [eh, em] = (end   || '00:00').split(':').map(Number);
  const startMin = sh * 60 + (sm || 0);
  // "00:00" end → treat as 1440 (just before midnight)
  const endMin = (eh === 0 && (em || 0) === 0) ? 1440 : eh * 60 + (em || 0);
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin; // cross-midnight window
}

// ── Decision logic ────────────────────────────────────────────────────────────

/**
 * Compute whether services SHOULD be running right now.
 *  - botEnabled=false  → always stopped (manual override, never auto-resumed)
 *  - tradingWindowEnabled=false → always running (no time restriction)
 *  - tradingWindowEnabled=true  → running only inside the IST window
 */
async function shouldServicesRun(): Promise<{ run: boolean; reason: string }> {
  const s = await getSettings();
  if (!s.botEnabled) return { run: false, reason: 'botEnabled=false (manual pause)' };
  if (!s.tradingWindowEnabled) return { run: true, reason: 'botEnabled=true, no time restriction' };
  const inWindow = isInsideWindow(s.tradingWindowStart, s.tradingWindowEnd);
  return {
    run: inWindow,
    reason: inWindow
      ? `inside trading window ${s.tradingWindowStart}–${s.tradingWindowEnd} IST`
      : `outside trading window ${s.tradingWindowStart}–${s.tradingWindowEnd} IST`,
  };
}

// ── Start / stop helpers ──────────────────────────────────────────────────────

function startServices(): void {
  startTrenchesScanner();
  resumeWhaleSniper();
  startTelegramCommands();
}

function stopServices(): void {
  stopTrenchesScanner();
  stopWhaleSniper();
  stopTelegramCommands();
  stopHeliusWs();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Re-evaluate the desired state and apply any start/stop transition.
 * No-op when the state hasn't changed. Safe to call from the settings route
 * whenever botEnabled or tradingWindow settings are updated.
 */
export async function applyBotEnabledChange(): Promise<void> {
  const { run, reason } = await shouldServicesRun();
  if (_servicesRunning === run) return; // no transition needed
  _servicesRunning = run;
  if (run) {
    logger.info({ reason }, 'Session Manager: STARTING all services');
    startServices();
  } else {
    logger.info({ reason }, 'Session Manager: STOPPING all services');
    stopServices();
  }
}

/** Recurring check — fires every 60 s to catch trading window open/close. */
function scheduleWindowCheck(): void {
  if (_scheduleTimer) { clearTimeout(_scheduleTimer); _scheduleTimer = null; }
  _scheduleTimer = setTimeout(async () => {
    try { await applyBotEnabledChange(); } catch { /* non-fatal */ }
    scheduleWindowCheck();
  }, 60_000);
}

/**
 * Call once from index.ts after all services have been started.
 * Applies the initial state (stops services if needed), then starts the
 * 60-second window-check loop.
 */
export async function initSessionManager(): Promise<void> {
  const { run, reason } = await shouldServicesRun();
  _servicesRunning = run;

  if (!run) {
    logger.info({ reason }, 'Session Manager: initialising in STOPPED state — stopping all services');
    stopServices();
  } else {
    logger.info({ reason }, 'Session Manager: initialising in RUNNING state');
  }

  // Start the recurring window check regardless of initial state, so the bot
  // auto-resumes when the trading window opens.
  scheduleWindowCheck();
}
