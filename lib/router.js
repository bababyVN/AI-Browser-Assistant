/**
 * lib/router.js — Core Multi-Key API Router & Pipeline Orchestrator
 *
 * Exports:
 *  - loadApiConfigs()   — Loads and decrypts API key configs from storage
 *  - saveApiConfigs()   — Encrypts and saves API key configs to storage
 *  - callWithRotation() — Full 2-Turn pipeline: Turn 1 → Tool Exec → Turn 2
 *  - RouterError        — Error class for router-level failures
 */
import { callGemini } from './gemini.js';
import { callOpenRouter, callOpenAI } from './openai-adapter.js';
import { encryptKey, decryptKey } from './crypto.js';
import { executeTool } from './tools.js';

// ─── RouterError ─────────────────────────────────────────────────────
export class RouterError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}

// ─── API Key Storage (encrypted via AES-GCM) ────────────────────────

/**
 * Load API configs from chrome.storage.local, decrypting keys on the fly.
 * Returns an array of { provider, key, label } objects with plaintext keys.
 */
export async function loadApiConfigs() {
  const data = await chrome.storage.local.get(['apiKeys']);
  const raw = data.apiKeys || [];
  if (!raw.length) return [];

  const configs = [];
  for (const entry of raw) {
    if (!entry || !entry.provider) continue;
    try {
      const plainKey = await decryptKey(entry.key);
      if (plainKey) {
        configs.push({ provider: entry.provider, key: plainKey, label: entry.label || '' });
      }
    } catch (err) {
      console.warn('[Router] Failed to decrypt key:', err.message);
    }
  }
  return configs;
}

/**
 * Save API configs to chrome.storage.local, encrypting keys before storage.
 * @param {Array<{provider: string, key: string, label?: string}>} configs
 */
export async function saveApiConfigs(configs) {
  if (!Array.isArray(configs)) throw new RouterError('Invalid configs array', 'INVALID_INPUT');

  const encrypted = [];
  for (const entry of configs) {
    if (!entry?.provider || !entry?.key) continue;
    const encKey = await encryptKey(entry.key);
    encrypted.push({
      provider: entry.provider,
      key: encKey || entry.key, // Fallback to plaintext if encryption fails
      label: entry.label || ''
    });
  }
  await chrome.storage.local.set({ apiKeys: encrypted });
}

// ─── Provider Dispatcher ─────────────────────────────────────────────

async function dispatchProviderCall(config, messages, tools, systemPrompt) {
  switch (config.provider) {
    case 'openrouter': return await callOpenRouter(messages, tools, config.key, systemPrompt);
    case 'openai':     return await callOpenAI(messages, tools, config.key, systemPrompt);
    default:           return await callGemini(messages, tools, config.key, systemPrompt);
  }
}

// ─── Key Status ──────────────────────────────────────────────────────

/**
 * Returns a summary of configured API keys for UI display.
 */
export async function getKeyStatus() {
  const configs = await loadApiConfigs();
  return {
    total: configs.length,
    providers: [...new Set(configs.map(c => c.provider))],
    labels: configs.map(c => c.label || c.provider)
  };
}

// ─── Main Pipeline: 2-Turn Single-Shot ───────────────────────────────

/**
 * Full AI-Driven pipeline:
 *   Turn 1: Send prompt + context + tools → LLM returns text or functionCall(s)
 *   Tool Exec: Execute each functionCall locally via executeTool
 *   Turn 2: Package functionResponse(s) and send back → LLM returns final text
 *
 * @param {Array} messages   — Gemini-format conversation
 * @param {Array} tools      — TOOL_DECLARATIONS array
 * @param {string} systemPrompt
 * @param {object} [callbacks] — Optional UI notification callbacks
 * @returns {object} Final Gemini-format API response (text-only)
 */
export async function callWithRotation(messages, tools, systemPrompt, callbacks = {}) {
  const configs = await loadApiConfigs();
  if (!configs?.length) {
    throw new RouterError('Chưa có API Key nào được cấu hình trong hệ thống.', 'NO_KEYS');
  }

  // Use first available config (simplified rotation)
  const activeConfig = configs[0];

  // ─── TURN 1: Prompt + Tools → LLM ─────────────────────────────
  const firstResponse = await dispatchProviderCall(activeConfig, messages, tools, systemPrompt);

  const candidate = firstResponse.candidates?.[0];
  const modelParts = candidate?.content?.parts || [];
  const toolCalls = modelParts.filter(p => p.functionCall);

  // If no tool calls, return the text response directly
  if (toolCalls.length === 0) {
    return firstResponse;
  }

  // ─── TOOL EXECUTION (local) ────────────────────────────────────
  const toolResponses = [];
  let seqId = 0;

  for (const tc of toolCalls) {
    const { name, args = {} } = tc.functionCall;
    const currentSeqId = seqId++;

    // Notify UI that a tool is running
    if (callbacks.onToolCall) {
      callbacks.onToolCall(name, args, currentSeqId);
    } else {
      chrome.runtime.sendMessage({ type: 'TOOL_CALL', toolName: name, args, seqId: currentSeqId }).catch(() => {});
    }

    let result;
    try {
      result = await executeTool(name, args);
    } catch (err) {
      result = { error: err.message };
    }

    // Notify UI of tool result
    if (callbacks.onToolResult) {
      callbacks.onToolResult(result, currentSeqId);
    } else {
      chrome.runtime.sendMessage({ type: 'TOOL_RESULT', result, seqId: currentSeqId }).catch(() => {});
    }

    // Package as Gemini-compatible functionResponse
    toolResponses.push({
      functionResponse: {
        name,
        response: { content: result }
      }
    });
  }

  // ─── TURN 2: Append model's functionCall + tool results → LLM ──
  messages.push({ role: 'model', parts: modelParts });
  messages.push({ role: 'user', parts: toolResponses });

  // Lock tools to empty array to force a pure text conclusion
  return await dispatchProviderCall(activeConfig, messages, [], systemPrompt);
}