/**
 * Session Manager — master on/off switch for all background services.
 *
 * When botEnabled = false: trenches scanner, whale sniper, Telegram polling,
 * and the shared Helius WebSocket connection are all stopped completely.
 * No Helius API credits are consumed and the Render dyno goes idle.
 *
 * When botEnabled = true: all services are restarted cleanly.
 */

import { getSettings } from '../services/settings.service.js';
import { startTrenchesScanner, stopTrenchesScanner } from '../services/trenches.service.js';
import { resumeWhaleSniper, stopWhaleSniper } from '../services/whale-sniper.service.js';
import { startTelegramCommands, stopTelegramCommands } from './telegram-commands.js';
import { stopHeliusWs } from './helius-ws-shared.js';
import { logger } from './logger.js';

// Track the last known state so we only act on real transitions.
let _lastBotEnabled: boolean | null = null;

/**
 * Read the current `botEnabled` setting and apply any start/stop transition.
 * Safe to call at any time — it's a no-op if the flag hasn't changed.
 */
export async function applyBotEnabledChange(): Promise<void> {
  const settings = await getSettings();
  const desired = settings.botEnabled;

  if (_lastBotEnabled === desired) return; // no transition needed
  _lastBotEnabled = desired;

  if (desired) {
    logger.info('Session Manager: bot ENABLED — starting all services');
    startTrenchesScanner();
    resumeWhaleSniper();
    startTelegramCommands();
  } else {
    logger.info('Session Manager: bot DISABLED — stopping all services to save credits');
    stopTrenchesScanner();
    stopWhaleSniper();
    stopTelegramCommands();
    // Disconnect the shared Helius WebSocket entirely — no reconnect attempts.
    stopHeliusWs();
  }
}

/**
 * Initialise the session manager after all services have been started by
 * index.ts. Records the initial state so the first settings PATCH that
 * changes botEnabled triggers the correct transition.
 */
export async function initSessionManager(): Promise<void> {
  const settings = await getSettings();
  _lastBotEnabled = settings.botEnabled;

  if (!settings.botEnabled) {
    // If the persisted setting is already "off", stop everything immediately.
    logger.info('Session Manager: initialising in DISABLED state — stopping all services');
    stopTrenchesScanner();
    stopWhaleSniper();
    stopTelegramCommands();
    stopHeliusWs();
  } else {
    logger.info('Session Manager: initialising in ENABLED state');
  }
}
