/**
 * Background Service Worker — AI Browser Assistant
 * Slim agent loop. Tool declarations, executor functions, and provider
 * management are now in lib/tools.js and lib/providers.js respectively.
 */

import { BudgetTracker } from './lib/budget.js';
import { isProviderError } from './lib/providers.js';
import { callWithRotation, RouterError, loadApiConfigs, getKeyStatus } from './lib/router.js';
import { LocalRAG } from './lib/rag.js';
import { VectorHistoryStore } from './lib/history-store.js';
import { callOllama, callOllamaWithTools, checkOllamaStatus, OllamaError, OLLAMA_TOOL_DECLARATIONS } from './lib/ollama.js';
import { TOOL_DECLARATIONS, executeTool, initTools, getToolsByIntent } from './lib/tools.js';
import { tryDirectExecution } from './lib/direct-executor.js';
import { classifyIntent, executeIntent } from './lib/intent-classifier.js';

// ─── Tier 2 Patterns ────────────────────────────────────────────────
const TIER2_PATTERN = /\b(what|summarize|summary|summery|explain|tell|describe|about|mean|say|find.*page|find.*visited|history|earlier|before|remember|read)\b/i;
const TIER2_EXCLUDE = /\b(click|type|fill|submit|open|play|scroll|navigate|go to|switch|close|like|subscribe|sub|comment|press|enter|send|select)\b/i;


// ─── Ollama Status ──────────────────────────────────────────────────
let ollamaAvailable = false;
let ollamaModels = [];

async function refreshOllamaStatus() {
  const status = await checkOllamaStatus();
  ollamaAvailable = status.available;
  ollamaModels = status.models;
  return status;
}
// Check on startup, then every 30 seconds
refreshOllamaStatus();
setInterval(refreshOllamaStatus, 30000);

// ─── Local RAG Engine ────────────────────────────────────────────────
const rag = new LocalRAG();

// ─── Browsing History Store ──────────────────────────────────────────
const historyStore = new VectorHistoryStore();

// Initialize tools with all required dependencies
initTools({
  getCachedPage: getCachedPage,
  setCachedPage: setCachedPage,
  extractRelevantChunks: extractRelevantChunks,
  rag: rag,
  historyStore: historyStore
});

// ─── Budget Tracker Instance ─────────────────────────────────────────
const budget = new BudgetTracker();

// ─── Page Content Cache ──────────────────────────────────────────────
const pageCache = new Map();
const CACHE_TTL = 60000;

function getCachedPage(tabId, url) {
  const key = `${tabId}:${url}`;
  const c = pageCache.get(key);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  return null;
}

function setCachedPage(tabId, url, data) {
  pageCache.set(`${tabId}:${url}`, { data, ts: Date.now() });
  if (pageCache.size > 20) pageCache.delete(pageCache.keys().next().value);
}

// ─── Keyword-Based Chunk Retrieval ───────────────────────────────────
/**
 * Split page content into chunks and return only the most relevant
 * ones based on keyword overlap with the user's query.
 * Pure function — no side effects.
 */
function extractRelevantChunks(content, query, maxChunks = 5) {
  if (!query || content.length < 5000) return content;

  const rawChunks = content.split(/\n\n+/);
  const chunks = [];
  for (const raw of rawChunks) {
    if (raw.trim().length < 20) continue;
    if (raw.length <= 600) {
      chunks.push(raw.trim());
    } else {
      for (let i = 0; i < raw.length; i += 500) {
        const piece = raw.substring(i, i + 500).trim();
        if (piece.length > 20) chunks.push(piece);
      }
    }
  }

  if (chunks.length <= maxChunks) return content;

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = chunks.map((chunk, i) => {
    const lower = chunk.toLowerCase();
    let score = 0;
    for (const word of queryWords) {
      const regex = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      const matches = lower.match(regex);
      score += matches ? matches.length : 0;
    }
    if (i === 0 || i === chunks.length - 1) score += 0.5;
    return { chunk, score, index: i };
  });

  scored.sort((a, b) => b.score - a.score);
  const topChunks = scored.slice(0, maxChunks);
  topChunks.sort((a, b) => a.index - b.index);
  return topChunks.map(c => c.chunk).join('\n\n---\n\n');
}

// Wire cache, chunk helpers, RAG, and history store into tools.js
initTools({ getCachedPage, setCachedPage, extractRelevantChunks, rag, historyStore });

// ─── Quota Mode Config ────────────────────────────────────────────────
// maxIterations = how many API round-trips per user message (each tool call = 1)
// "open youtube + search edm" needs ~4 tool calls, so lite needs ≥5
const QUOTA_CONFIGS = {
  full: { historyMax: 20, maxIterations: 8, toolMode: 'all' },
  lite: { historyMax: 10, maxIterations: 5, toolMode: 'smart' },
  chat: { historyMax: 6,  maxIterations: 1, toolMode: 'none' }
};

async function getQuotaConfig() {
  const data = await chrome.storage.local.get('quotaMode');
  return QUOTA_CONFIGS[data.quotaMode || 'lite'];
}

// ─── Response Cache ──────────────────────────────────────────────────
// Caches final text responses keyed by (userText + pageURL).
// Same question on same page → instant answer, zero API tokens.
const responseCache = new Map();
const RESPONSE_CACHE_TTL = 300000; // 5 minutes

function getResponseCacheKey(text, url) {
  return `${text.toLowerCase().trim().replace(/\s+/g, ' ')}::${url || ''}`;
}

function getCachedResponse(text, url) {
  const key = getResponseCacheKey(text, url);
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < RESPONSE_CACHE_TTL) return entry.response;
  responseCache.delete(key);
  return null;
}

function setCachedResponse(text, url, response) {
  responseCache.set(getResponseCacheKey(text, url), { response, ts: Date.now() });
  // Cap cache size at 50 entries
  if (responseCache.size > 50) responseCache.delete(responseCache.keys().next().value);
}

// ─── History Trimming ────────────────────────────────────────────────
function trimHistory(history, maxMessages) {
  if (history.length <= maxMessages) return history;
  const first = history[0];
  return [first, ...history.slice(-(maxMessages - 1))];
}

// ─── Tool Result Summarizer ──────────────────────────────────────────
function summarizeToolResult(toolName, result) {
  if (!result || result.error) return result;
  switch (toolName) {
    case 'get_page_elements': {
      const els = result.elements || [];
      const types = {};
      els.forEach(e => { types[e.type] = (types[e.type] || 0) + 1; });
      const typeSummary = Object.entries(types).map(([t, c]) => `${c} ${t}s`).join(', ');
      const allElements = els.map(e => `[${e.index}] ${e.type}: "${e.text || ''}"`).join('\n');
      return { summary: `Found ${els.length} elements on '${result.pageTitle}'. Types: ${typeSummary}.\nElements:\n${allElements}` };
    }
    case 'get_page_snapshot': {
      const c = result.counts || {};
      return { summary: `Page '${result.title}' at ${result.url}. ${c.links || 0} links, ${c.buttons || 0} buttons, ${c.inputs || 0} inputs, ${c.videos || 0} videos. Preview: ${(result.contentSummary || '').substring(0, 1500)}` };
    }
    case 'get_open_tabs': {
      const tabs = result.tabs || [];
      const active = tabs.find(t => t.active);
      const tabList = tabs.map(t => `- [${t.id}] ${t.title} (${t.url})`).join('\n');
      return { summary: `Found ${tabs.length} open tabs. Active: '${active?.title || 'unknown'}'\n\nTabs:\n${tabList}` };
    }
    case 'ask_website': {
      const content = result.content || '';
      return { summary: content.substring(0, 15000) + (content.length > 15000 ? '...' : ''), pageTitle: result.pageTitle };
    }
    case 'find_history': {
      const r = result.results || [];
      if (r.length === 0) return { summary: 'No matching pages found in history.' };
      const historyList = r.map(p => `- ${p.title}\n  URL: ${p.url}\n  Visited: ${new Date(p.visited).toLocaleString()}`).join('\n\n');
      return { summary: `Found ${r.length} page(s) in history:\n\n${historyList}` };
    }
    default:
      return result;
  }
}

// ─── Conditional Tool Declarations (Fix 1: Lazy Loading) ─────────────
const TOOL_KEYWORDS = /\b(page|tab|tabs|click|open|video|scroll|type|website|site|browse|search|link|button|form|highlight|url|navigate|what.s on|show me|find|read|content|element|play|history|visited|earlier|before|remember)\b/i;

function getToolsForMessage(userText, iteration, toolMode) {
  if (toolMode === 'none') return [];
  // On subsequent iterations, AI may need any tool — send full set
  if (iteration > 0) return TOOL_DECLARATIONS;
  // Both 'all' and 'smart' modes use intent-based filtering on first turn
  if (toolMode === 'all') return getToolsByIntent(userText);
  // 'smart' mode: only send tools if message contains tool-related keywords
  return TOOL_KEYWORDS.test(userText) ? getToolsByIntent(userText) : [];
}

// ─── Fix 2: Quick Page Context Injector ─────────────────────────────
/**
 * Grab a lightweight page fingerprint (title + URL + headings) from the
 * active tab. Returns a ~50-token string the AI can use to answer simple
 * questions without calling any tools. Fails silently.
 */
async function getQuickPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return null;
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_QUICK_CONTEXT' });
    if (!response || !response.success) return null;
    return `[Current page: "${response.title}" — ${response.url}]\n[Headings: ${response.headings}]\n[Top Elements: ${response.elements}]`;
  } catch {
    return null; // No active tab, page not accessible — that's fine
  }
}

// ─── Fix 5: Smarter System Prompt ────────────────────────────────────
// Instructs AI to answer directly from page context before reaching for tools.
const SYSTEM_PROMPT = `You are a helpful AI browser assistant.

Each user message may include a [Current page: ...] header showing the page title, URL, and main headings. Use this to answer simple questions DIRECTLY without calling tools.

ONLY call tools when you genuinely need to:
- ask_website: when you need actual page text content — always use detail_level "brief" first, then "full" only if brief was insufficient
- get_page_elements / click_element: when the user wants to interact with the page
- scroll_page: when the user wants to see different content
- open_url / get_open_tabs: when managing browser tabs
- get_page_snapshot: when you need to see all interactive elements at once
- find_history: when the user asks about pages they visited before or wants to find a page from their browsing history

AVOID unnecessary tool calls:
- If the [Current page] header answers the question, respond directly — no tools needed
- Use ask_website "brief" before "full"
- Do NOT call get_page_elements unless the user explicitly wants to click/type something

Be concise. Explain actions before doing them.
Always reference elements by their visible text or description, not just index numbers.`;

// ─── Conversation State ──────────────────────────────────────────────
let conversationHistory = [];
let isProcessing = false;

// ─── Open side panel on icon click ──────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error('Failed to open side panel:', err);
  }
});

// Enable side panel to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ─── Auto-Index Browsing History ──────────────────────────────────────
// Silently record visited pages for find_history tool
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  // Extract meta description from the page
  chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.querySelector('meta[name="description"]')?.content || ''
  }).then(results => {
    const desc = results?.[0]?.result || '';
    historyStore.addEntry(tab.url, tab.title || '', desc);
  }).catch(() => {
    // Page may not be scriptable (e.g. chrome web store) — store without description
    historyStore.addEntry(tab.url, tab.title || '', '');
  });
});

// ─── Message Handler ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CHAT_MESSAGE') {
    handleChatMessage(message.text).then(() => {
      sendResponse({ success: true });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // Keep channel open
  }

  if (message.type === 'CLEAR_HISTORY') {
    conversationHistory = [];
    sendResponse({ success: true });
    return;
  }

  if (message.type === 'GET_STATUS') {
    sendResponse({ isProcessing });
    return;
  }

  // Return current key rotation health for sidebar display
  if (message.type === 'GET_KEY_STATUS') {
    sendResponse(getKeyStatus());
    return;
  }

  // Return history store stats
  if (message.type === 'GET_HISTORY_STATS') {
    historyStore.getStats().then(stats => sendResponse(stats));
    return true;
  }

  // Return Ollama status for sidebar display
  if (message.type === 'GET_OLLAMA_STATUS') {
    refreshOllamaStatus().then(status => sendResponse(status));
    return true;
  }
});

// ─── Send update to sidebar ───────────────────────────────────────────
function sendToSidebar(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {
    // Sidebar might not be open — that's fine
  });
}

// ─── Rich Context Gatherer ───────────────────────────────────────────
/**
 * Build a rich context package: current page + browsing history + user profile.
 * Total ~1,200-1,600 tokens — well within all provider limits.
 */
async function gatherContext() {
  const context = { page: null, history: [], userProfile: { facts: [] } };

  // 1. Current page context (title, URL, headings, interactive elements)
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'GET_QUICK_CONTEXT' });
      if (response?.success) {
        context.page = {
          title: response.title,
          url: response.url,
          headings: response.headings,
          elements: response.elements
        };
      }
    }
  } catch {}

  // 2. Recent browsing history (last 10 pages, last 1 hour)
  try {
    const oneHourAgo = Date.now() - 3600000;
    const historyItems = await chrome.history.search({
      text: '',
      maxResults: 10,
      startTime: oneHourAgo
    });
    context.history = historyItems.map(h => ({
      title: (h.title || '').substring(0, 60),
      url: h.url,
      visitedAt: new Date(h.lastVisitTime).toLocaleTimeString()
    }));
  } catch {}

  // 3. User profile from GraphRAG (stored in chrome.storage.local)
  try {
    const data = await chrome.storage.local.get(['userProfile']);
    if (data.userProfile && data.userProfile.facts) {
      context.userProfile = data.userProfile;
    }
  } catch {}

  return context;
}

// ─── GraphRAG: Save User Facts ──────────────────────────────────────
async function saveUserFact(fact) {
  if (!fact || typeof fact !== 'string') return;
  try {
    const data = await chrome.storage.local.get(['userProfile']);
    const profile = data.userProfile || { facts: [] };
    // Avoid duplicates
    if (!profile.facts.includes(fact)) {
      profile.facts.push(fact);
      // Keep max 50 facts
      if (profile.facts.length > 50) profile.facts.shift();
      await chrome.storage.local.set({ userProfile: profile });
    }
  } catch {}
}

// ─── Main Message Handler ────────────────────────────────────────────
async function handleChatMessage(userText) {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // Ensure we have the latest Ollama status before checking keys
    if (!ollamaAvailable) {
      await refreshOllamaStatus();
    }

    const configs = await loadApiConfigs();
    const hasApiKeys = configs && configs.length > 0;
    if (!hasApiKeys && !ollamaAvailable) {
      const status = await checkOllamaStatus();
      sendToSidebar({
        type: 'ASSISTANT_ERROR',
        error: `No API keys configured and Ollama offline. Add a key in ⚙️ Settings, or start Ollama. Debug: ${status.error || 'No error'}`
      });
      return;
    }

    // ── STEP 1: Smart Intent Classifier (1 API call) ──────────────────
    // AI sees the full context (page, history, user profile) and decides
    // what to do. This is the PRIMARY path for all messages.
    if (hasApiKeys) {
      try {
        // Budget check
        if (budget.shouldBlock()) {
          // If rate-limited, fall through to regex fallback
          console.warn('[Smart] Rate-limited, trying regex fallback');
        } else {
          sendToSidebar({ type: 'TYPING_START' });

          // Gather rich context (page + history + user profile)
          const context = await gatherContext();
          console.log('[Smart] Context gathered:', JSON.stringify({
            hasPage: !!context.page,
            pageTitle: context.page?.title,
            historyCount: context.history?.length,
            factsCount: context.userProfile?.facts?.length
          }));

          // ONE API call — classify intent + generate response
          const intent = await classifyIntent(
            (msgs, tools, sysPrompt) => callWithRotation(msgs, tools, sysPrompt),
            userText,
            context,
            conversationHistory
          );
          budget.recordRequest();
          sendToSidebar({ type: 'BUDGET_UPDATE', stats: budget.getStats() });

          console.log('[Smart] Intent result:', JSON.stringify(intent));

          if (intent) {
            // GraphRAG: learn user facts if the AI discovered any
            if (intent.learn) {
              await saveUserFact(intent.learn);
            }

            // Execute the classified intent locally (free)
            const result = await executeIntent(intent);
            console.log('[Smart] Execution result:', JSON.stringify({ handled: result.handled, response: result.response?.substring(0, 100) }));

            if (result.handled) {
              sendToSidebar({ type: 'TYPING_STOP' });
              const tier = intent.intent === 'chat' ? undefined : 'direct';
              sendToSidebar({ type: 'ASSISTANT_MESSAGE', text: result.response, tier });
              if (tier === 'direct') {
                sendToSidebar({ type: 'PROVIDER_USED', provider: 'intent', label: '🧠 Smart (1 API call)' });
              }
              // Add to conversation history
              conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
              conversationHistory.push({ role: 'model', parts: [{ text: result.response }] });
              // Trim history to prevent unbounded growth
              if (conversationHistory.length > 20) {
                conversationHistory = [conversationHistory[0], ...conversationHistory.slice(-19)];
              }
              isProcessing = false;
              return;
            }

            // Intent was 'complex' — fall through to Ollama
            console.log('[Smart] Complex task, falling to Ollama:', result.description);
            sendToSidebar({ type: 'TYPING_STOP' });
          } else {
            console.warn('[Smart] Intent classification returned null — API may have returned non-JSON');
            sendToSidebar({ type: 'TYPING_STOP' });
          }
        }
      } catch (err) {
        console.error('[Smart] Classification FAILED:', err.message);
        sendToSidebar({ type: 'TYPING_STOP' });
        // If rate-limited, tell the user instead of silently falling through
        if (/rate.?limit|exhausted|all.*key/i.test(err.message)) {
          sendToSidebar({ type: 'ASSISTANT_ERROR', error: err.message });
          isProcessing = false;
          return;
        }
        // Other errors → fall through to regex fallback
      }
    }

    // ── STEP 2: Regex Fallback (zero cost, used when API unavailable) ─
    // Only reached if: no API keys, rate-limited, or API call failed
    const directResult = await tryDirectExecution(userText);
    if (directResult.handled) {
      sendToSidebar({ type: 'TYPING_START' });
      await new Promise(r => setTimeout(r, 200));
      sendToSidebar({ type: 'TYPING_STOP' });
      sendToSidebar({ type: 'ASSISTANT_MESSAGE', text: directResult.response, tier: 'direct' });
      sendToSidebar({ type: 'PROVIDER_USED', provider: 'direct', label: '⚡ Direct (no AI)' });
      conversationHistory.push({ role: 'user', parts: [{ text: userText }] });
      conversationHistory.push({ role: 'model', parts: [{ text: directResult.response }] });
      isProcessing = false;
      return;
    }

    // ── TIER 2: Ollama Fallback (offline / complex tasks) ────────────
    if (ollamaAvailable) {
      try {
        const quotaConfig = await getQuotaConfig();
        await runOllamaAgentLoop(userText, quotaConfig);
        isProcessing = false;
        return;
      } catch (err) {
        console.warn('[Tier 2] Ollama failed:', err.message);
        sendToSidebar({
          type: 'ASSISTANT_ERROR',
          error: `Local AI (Ollama) encountered an error: ${err.message}`
        });
        isProcessing = false;
        return;
      }
    }

    // ── No handler available ─────────────────────────────────────────
    sendToSidebar({
      type: 'ASSISTANT_ERROR',
      error: 'Could not process your request. Please try rephrasing.'
    });

  } catch (err) {
    sendToSidebar({ type: 'TYPING_STOP' });
    sendToSidebar({ type: 'ASSISTANT_ERROR', error: `Unexpected error: ${err.message}` });
  } finally {
    isProcessing = false;
  }
}

// ─── TIER 2: Ollama Agent Loop ──────────────────────────────────────
async function runOllamaAgentLoop(userText, quotaConfig) {
  sendToSidebar({ type: 'TYPING_START' });
  const pageCtx = await getQuickPageContext();
  const enrichedText = pageCtx ? `${pageCtx}\n\n${userText}` : userText;
  
  conversationHistory.push({ role: 'user', parts: [{ text: enrichedText }] });
  
  const localPrompt = 'You are a helpful browser assistant. Only use tools if the user explicitly asks about the current page, history, or highlighting. For general greetings or chat (e.g., "hi", "hello"), just respond directly and DO NOT use tools. Answer concisely.';
  
  let iteration = 0;
  const MAX_ITERATIONS = 2; // Small models get confused with too many steps
  
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    const trimmed = trimHistory(conversationHistory, quotaConfig.historyMax);
    
    // Call Ollama with our limited 3-tool set
    const data = await callOllamaWithTools(trimmed, OLLAMA_TOOL_DECLARATIONS, localPrompt);
    const candidate = data.candidates[0];
    const parts = candidate.content?.parts || [];
    
    conversationHistory.push({
      role: 'model',
      parts: parts
    });
    
    const toolCalls = parts.filter(p => p.functionCall);
    const textPart = parts.find(p => p.text);
    
    if (textPart && textPart.text) {
      sendToSidebar({ type: 'ASSISTANT_TEXT', text: textPart.text });
    }
    
    if (toolCalls.length === 0) {
      // Done
      setCachedResponse(userText, '', textPart?.text || '');
      sendToSidebar({ type: 'TYPING_STOP' });
      sendToSidebar({ type: 'ASSISTANT_MESSAGE', text: textPart?.text || '', fromOllama: true });
      sendToSidebar({ type: 'PROVIDER_USED', provider: 'ollama', label: '🦙 Ollama (local)' });
      return;
    }
    
    // Execute tool calls
    const toolResponses = [];
    for (const tc of toolCalls) {
      const { name, args } = tc.functionCall;
      sendToSidebar({ type: 'TOOL_CALL', toolName: name, args });
      
      const result = await executeTool(name, args);
      sendToSidebar({ type: 'TOOL_RESULT', result });
      
      toolResponses.push({
        functionResponse: {
          name: name,
          response: { content: result }
        }
      });
    }
    
    conversationHistory.push({
      role: 'function',
      parts: toolResponses
    });
  }
  
  // Reached max iterations
  sendToSidebar({ type: 'TYPING_STOP' });
  sendToSidebar({ type: 'ASSISTANT_ERROR', error: 'Local AI reached maximum reasoning steps.' });
}
