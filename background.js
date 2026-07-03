/**
 * background.js — Manifest V3 Service Worker
 *
 * 100% AI-Driven Pipeline:
 *   1. Sidebar sends CHAT_MESSAGE
 *   2. Background collects DOM context, builds prompt
 *   3. callWithRotation handles Turn 1 → Tool Exec → Turn 2
 *   4. Final text returned to Sidebar
 */

import { callWithRotation, loadApiConfigs } from './lib/router.js';
import { TOOL_DECLARATIONS, initTools, getActiveTabAndInject } from './lib/tools.js';
import { VectorHistoryStore } from './lib/history-store.js';
import { tryDirectExecution } from './lib/direct-executor.js';

// ─── Initialize Side Panel Behavior ──────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error("Could not open side panel:", err);
  }
});

const historyStore = new VectorHistoryStore();

const pageCache = new Map();
const CACHE_TTL = 60_000;

function getCachedPage(tabId, url) {
  const entry = pageCache.get(`${tabId}:${url}`);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCachedPage(tabId, url, data) {
  pageCache.set(`${tabId}:${url}`, { data, ts: Date.now() });
  if (pageCache.size > 20) pageCache.delete(pageCache.keys().next().value);
}


initTools({ getCachedPage, setCachedPage, historyStore });

const QUOTA_CONFIGS = {
  full: { historyMax: 20, toolMode: 'all' },
  chat: { historyMax: 6,  toolMode: 'none' }
};

async function getQuotaConfig() {
  const data = await chrome.storage.local.get('quotaMode');
  const mode = data.quotaMode;
  return QUOTA_CONFIGS[mode === 'chat' ? 'chat' : 'full'];
}

let conversationHistory = [];

async function saveConversation() {
  try { await chrome.storage.local.set({ conversationHistory: conversationHistory.slice(-20) }); } catch {}
}

async function loadConversation() {
  try {
    const data = await chrome.storage.local.get('conversationHistory');
    conversationHistory = data.conversationHistory || [];
  } catch {
    conversationHistory = [];
  }
}
loadConversation();

// Trạng thái khóa luồng an toàn lưu trên bộ nhớ Session của Chrome Extension
async function setProcessingStatus(status) {
  await chrome.storage.session.set({ isProcessing: status });
}

async function getProcessingStatus() {
  const res = await chrome.storage.session.get('isProcessing');
  return !!res.isProcessing;
}

// Seed default settings (no hardcoded keys)
async function seedDefaultApiKeys() {
  if (!chrome.storage?.local) return;
  try {
    const data = await chrome.storage.local.get(['seeded_keys_v4']);
    if (!data.seeded_keys_v4) {
      await chrome.storage.local.set({ apiKeys: [], seeded_keys_v4: true });
    }
  } catch (err) {
    console.error(err);
  }
}
seedDefaultApiKeys();

// ─── Message Router ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'CHAT_MESSAGE':
      handleChatMessage(message.text)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GET_STATUS':
      getProcessingStatus().then(status => sendResponse({ isProcessing: status }));
      return true;

    case 'GET_CONVERSATION_HISTORY':
      sendResponse(conversationHistory);
      return true;

    case 'CLEAR_HISTORY':
      conversationHistory = [];
      saveConversation();
      sendResponse({ success: true });
      return true;

    default:
      return false;
  }
});

function sendToSidebar(payload) {
  chrome.runtime.sendMessage(payload).catch(() => {});
}


function trimHistory(history, maxMessages) {
  if (history.length <= maxMessages) return history;
  return [history[0], ...history.slice(-(maxMessages - 1))];
}

// ─── Core Pipeline ──────────────────────────────────────────────────

async function runSingleShotCloudPipeline(userText, configs, quotaConfig) {
  sendToSidebar({ type: 'TYPING_START' });

  // ─── Thu thập DOM Map siêu nén (LUÔN đính kèm — rất nhẹ ~200-400 token) ───
  let contextStr = '';
  if (quotaConfig.toolMode !== 'none') {
    try {
      const tab = await getActiveTabAndInject();
      if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'BUILD_DOM_MAP' });
        if (response?.success && response.map) {
          contextStr = response.map;
        }
      }
    } catch (err) { console.warn('[BG] DOM Map collection error:', err.message); }
  }

  const promptText = contextStr ? `${contextStr}\nUser Prompt: ${userText}` : `User Prompt: ${userText}`;

  // Chọn tools theo chế độ quota
  const activeTools = quotaConfig.toolMode === 'none' ? [] : TOOL_DECLARATIONS;

  const messages = [
    ...trimHistory(conversationHistory, quotaConfig.historyMax),
    { role: 'user', parts: [{ text: promptText }] }
  ];

  // ─── callWithRotation xử lý toàn bộ: Turn 1 → Tool Exec → Turn 2 ─
  let finalResponseData = null;
  try {
    finalResponseData = await callWithRotation(messages, activeTools, SYSTEM_PROMPT);
  } catch (err) {
    sendToSidebar({ type: 'TYPING_STOP' });
    sendToSidebar({ type: 'ASSISTANT_ERROR', error: `API Error: ${err.message}` });
    return;
  }

  // ─── Trích xuất văn bản cuối cùng ─────────────────────────────
  const candidate = finalResponseData.candidates?.[0];
  const finalText = candidate?.content?.parts?.find(p => p.text)?.text || 'Hoàn thành tác vụ.';

  sendToSidebar({ type: 'TYPING_STOP' });
  sendToSidebar({ type: 'ASSISTANT_MESSAGE', text: finalText });

  // Lưu lịch sử đơn giản hóa (chỉ text, không lưu tool calls)
  conversationHistory.push(
    { role: 'user', parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: finalText }] }
  );
  await saveConversation();
}

// ─── Entry Point ─────────────────────────────────────────────────────

export async function handleChatMessage(userText) {
  if (await getProcessingStatus()) return;
  await setProcessingStatus(true);

  try {
    const configs = await loadApiConfigs();
    if (!configs?.length) {
      sendToSidebar({ type: 'ASSISTANT_ERROR', error: 'Vui lòng cấu hình API Key trong mục ⚙️ Cài đặt.' });
      return;
    }

    // Tier 0: Direct Executor (zero API quota) — for simple navigation commands
    const directResult = await tryDirectExecution(userText);
    if (directResult.handled) {
      sendToSidebar({ type: 'TYPING_STOP' });
      sendToSidebar({ type: 'ASSISTANT_MESSAGE', text: directResult.response });
      return;
    }

    const quotaConfig = await getQuotaConfig();
    await runSingleShotCloudPipeline(userText, configs, quotaConfig);
  } catch (err) {
    sendToSidebar({ type: 'TYPING_STOP' });
    sendToSidebar({ type: 'ASSISTANT_ERROR', error: err.message });
  } finally {
    await setProcessingStatus(false);
  }
}

// ─── System Prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert AI browser assistant that helps users control their web browser and analyze web pages.

## DOM Map
Every message includes a DOM Map — a compact listing of ALL interactive elements on the current page.
The DOM Map uses this format:
- \"MAIN CONTENT\" section = primary page content (videos, articles, posts, forms)
- \"NAV/HEADER\" section = navigation and utility elements
- Element types: [VIDEO] [THUMBNAIL] [BTN] [BTN:like] [BTN:share] [BTN:subscribe] [LINK] [INPUT] [SEARCH] [INPUT:comment] [TAB] [SELECT] [CHECKBOX] [RADIO]
- Each element has a # index number for interaction

## How to Use the DOM Map
- To click the 2nd video: find the second [VIDEO] in MAIN CONTENT → call click_element with its #index
- To type in search: find [SEARCH] → call type_into_element with its #index
- You do NOT need to call get_page_elements first — the DOM Map already provides all indexes
- Only call get_page_elements if you need to rescan after the page changed (scrolling, navigation)

## Reading Page Content
- To summarize a page: call read_page_content() — returns a short overview + list of sections
- To read a specific section in detail: call read_page_content(section_index=N)
- To find specific information: call search_in_page(query=\"...\") — returns matching snippets
- NEVER fabricate or guess page content — always use tools to read it

## Tools Available
- **click_element**: Click an element by its DOM Map index number
- **type_into_element**: Type text into an input by its DOM Map index
- **scroll_page**: Scroll the page (up/down/top/bottom)
- **open_url**: Navigate to a URL
- **get_open_tabs**: List all open browser tabs
- **read_page_content**: Read/summarize the page content (lazy-loaded, token-efficient)
- **search_in_page**: Search for specific text on the current page
- **get_page_elements**: Rescan page elements (only needed after page changes)
- **like_video**: Click the Like button on social media / video platforms
- **comment_video**: Auto-find comment box, type and submit a comment

## Rules
1. Use element index numbers from the DOM Map directly — no need to scan first.
2. When matching user requests like \"video thứ 2\", count [VIDEO] elements in MAIN CONTENT section.
3. For social media actions (like, comment, subscribe), prefer specialized tools.
4. Answer in the same language the user uses.
5. Use Markdown formatting for readability.
6. If a tool fails, explain what happened and suggest alternatives.
7. Never fabricate information about what's on the page.`;