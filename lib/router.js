/**
 * lib/router.js — Multi-Key API Router
 * Round-robin API key rotation with per-key cooldowns on 429/503.
 * Supports multiple Gemini and Groq keys from different accounts.
 * Automatically migrates old single-key storage format.
 */

import { callGemini, GeminiError } from './gemini.js';
import { callGroq, GroqError } from './groq.js';
import { callCerebras, CerebrasError } from './cerebras.js';
import { callTogether, TogetherError } from './together.js';

// ─── Per-Key Runtime Stats ────────────────────────────────────────────
// Tracks cooldowns and request counts in memory (resets when service worker restarts)
const keyStats = new Map(); // key -> { requests, lastReset, cooldownUntil }

function getKeyStats(key) {
  if (!keyStats.has(key)) {
    keyStats.set(key, { requests: 0, lastReset: Date.now(), cooldownUntil: 0 });
  }
  const stats = keyStats.get(key);
  // Reset per-minute counter if window has passed
  if (Date.now() - stats.lastReset > 60000) {
    stats.requests = 0;
    stats.lastReset = Date.now();
  }
  return stats;
}

// ─── Storage Helpers ─────────────────────────────────────────────────
/**
 * Load all API key configs from chrome.storage.
 * Handles both new format (apiKeys array) and old format (geminiApiKey / groqApiKey strings).
 * @returns {{ provider: string, key: string, label: string }[]}
 */
export async function loadApiConfigs() {
  const data = await chrome.storage.local.get(['apiKeys', 'geminiApiKey', 'groqApiKey', 'aiProvider']);

  // New format: explicit apiKeys array
  if (data.apiKeys && Array.isArray(data.apiKeys) && data.apiKeys.length > 0) {
    return data.apiKeys.filter(k => k && k.key && k.provider);
  }

  // Legacy migration: convert old single-key format to array
  const migrated = [];
  if (data.geminiApiKey) {
    migrated.push({ provider: 'gemini', key: data.geminiApiKey, label: 'Gemini (Account 1)' });
  }
  if (data.groqApiKey) {
    migrated.push({ provider: 'groq', key: data.groqApiKey, label: 'Groq (Account 1)' });
  }

  // Persist migrated keys so the UI shows them correctly
  if (migrated.length > 0) {
    await chrome.storage.local.set({ apiKeys: migrated });
  }

  return migrated;
}

/**
 * Save API key configs to chrome.storage.
 * @param {{ provider: string, key: string, label: string }[]} configs
 */
export async function saveApiConfigs(configs) {
  await chrome.storage.local.set({ apiKeys: configs });
}

// ─── Key Picker ───────────────────────────────────────────────────────
/**
 * Pick the best available key from a list:
 * 1. Not in cooldown
 * 2. Fewest requests this minute (load balancing)
 * Returns null if all keys are cooling down.
 */
function pickBestKey(configs) {
  const now = Date.now();
  const available = configs.filter(c => {
    const stats = getKeyStats(c.key);
    return stats.cooldownUntil < now;
  });

  if (available.length === 0) return null;

  // Pick the key with fewest requests this minute
  return available.sort((a, b) => {
    return (getKeyStats(a.key).requests) - (getKeyStats(b.key).requests);
  })[0];
}

// ─── Retryable Error Check ────────────────────────────────────────────
/**
 * Returns true if the error is a rate-limit or server overload error
 * that warrants rotating to the next key.
 * Does NOT rotate on auth errors (401) or bad requests (400).
 */
function isRetryableError(err) {
  if (err.code === 'RATE_LIMIT' || err.code === 'SERVER_ERROR') return true;
  if (err.code === 429 || err.code === 503) return true;
  if (/rate.?limit|quota|resource.?exhausted|overloaded|too many/i.test(err.message || '')) return true;
  return false;
}

// ─── Provider Caller ─────────────────────────────────────────────────
/**
 * Call a specific provider with a specific key.
 * Returns Gemini-format response.
 */
async function callProvider(config, messages, tools, systemPrompt) {
  switch (config.provider) {
    case 'groq':     return await callGroq(messages, tools, config.key, systemPrompt);
    case 'cerebras': return await callCerebras(messages, tools, config.key, systemPrompt);
    case 'together': return await callTogether(messages, tools, config.key, systemPrompt);
    default:         return await callGemini(messages, tools, config.key, systemPrompt);
  }
}

// ─── Main Router ─────────────────────────────────────────────────────
/**
 * Call the API with automatic multi-key rotation.
 *
 * Strategy:
 * 1. Pick the key with fewest recent requests (load balancing)
 * 2. On 429/503: mark key as cooling down for 60s, try next key
 * 3. Throw RouterError only if ALL keys are exhausted
 *
 * @param {Array} messages - Gemini-format conversation history
 * @param {Array} tools - Tool declarations (Gemini format)
 * @param {string} systemPrompt - System prompt text
 * @returns {Object} Gemini-format API response
 */
export async function callWithRotation(messages, tools, systemPrompt) {
  const configs = await loadApiConfigs();

  if (!configs || configs.length === 0) {
    throw new RouterError(
      'No API keys configured. Click ⚙️ and add at least one Gemini or Groq API key.',
      'NO_KEYS'
    );
  }

  const exhausted = new Set();

  while (exhausted.size < configs.length) {
    const remaining = configs.filter((_, i) => !exhausted.has(i));
    const config = pickBestKey(remaining);

    if (!config) {
      // All remaining keys are in cooldown
      break;
    }

    const configIndex = configs.indexOf(config);
    exhausted.add(configIndex);

    try {
      const result = await callProvider(config, messages, tools, systemPrompt);

      // Record successful request
      const stats = getKeyStats(config.key);
      stats.requests++;

      // Notify sidebar which provider/key was used
      chrome.runtime.sendMessage({
        type: 'PROVIDER_USED',
        provider: config.provider,
        label: config.label || config.provider
      }).catch(() => {});

      return result;

    } catch (err) {
      if (isRetryableError(err)) {
        // Mark key as cooling down for 60 seconds
        const stats = getKeyStats(config.key);
        stats.cooldownUntil = Date.now() + 60000;

        console.warn(`[Router] ${config.label || config.provider} hit rate limit. Rotating to next key. ${configs.length - exhausted.size} key(s) remaining.`);

        // Notify sidebar about the rotation
        chrome.runtime.sendMessage({
          type: 'KEY_ROTATION',
          from: config.label || config.provider,
          remaining: configs.length - exhausted.size
        }).catch(() => {});

        continue; // Try next key
      }

      // Non-retryable error (401 auth, 400 bad request) — throw immediately
      throw err;
    }
  }

  // All keys exhausted
  const cooldownEnds = Math.max(...configs.map(c => getKeyStats(c.key).cooldownUntil));
  const waitSecs = Math.ceil((cooldownEnds - Date.now()) / 1000);
  throw new RouterError(
    `All ${configs.length} API key(s) are rate-limited. Please wait ~${waitSecs}s or add more keys in Settings.`,
    'ALL_EXHAUSTED'
  );
}

/**
 * Get current key health status for display in sidebar.
 * @returns {{ total: number, available: number, cooling: number, keys: Array }}
 */
export function getKeyStatus() {
  const now = Date.now();
  return {
    available: [...keyStats.entries()].filter(([, s]) => s.cooldownUntil < now).length,
    cooling: [...keyStats.entries()].filter(([, s]) => s.cooldownUntil >= now).length
  };
}

// ─── RouterError ─────────────────────────────────────────────────────
export class RouterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}
