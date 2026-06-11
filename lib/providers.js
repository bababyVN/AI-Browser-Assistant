import { callGemini, GeminiError } from './gemini.js';
import { callGroq, GroqError } from './groq.js';
import { RouterError } from './router.js';
import { CerebrasError } from './cerebras.js';
import { TogetherError } from './together.js';

/**
 * Get the currently selected provider ('gemini' or 'groq').
 */
export async function getProvider() {
  const data = await chrome.storage.local.get('aiProvider');
  return data.aiProvider || 'gemini';
}

/**
 * Get the API key for the currently active provider.
 */
export async function getActiveApiKey() {
  const provider = await getProvider();
  if (provider === 'groq') {
    const data = await chrome.storage.local.get('groqApiKey');
    return data.groqApiKey || '';
  } else {
    const data = await chrome.storage.local.get('geminiApiKey');
    return data.geminiApiKey || '';
  }
}

/**
 * Call the active provider's API.
 * Returns a Gemini-format response object regardless of the underlying provider.
 */
export async function callActiveProvider(messages, tools, apiKey, systemPrompt) {
  const provider = await getProvider();
  if (provider === 'groq') {
    return await callGroq(messages, tools, apiKey, systemPrompt);
  } else {
    return await callGemini(messages, tools, apiKey, systemPrompt);
  }
}

/**
 * Returns true if the error is a known provider or router error.
 */
export function isProviderError(err) {
  return err instanceof GeminiError || err instanceof GroqError ||
    err instanceof RouterError || err instanceof CerebrasError || err instanceof TogetherError;
}

// Re-export error classes
export { GeminiError, GroqError, RouterError, CerebrasError, TogetherError };
