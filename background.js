/**
 * background.js — Manifest V3 Service Worker
 *
 * 100% AI-Driven Pipeline:
 *   1. Sidebar sends CHAT_MESSAGE
 *   2. Background collects DOM context, builds prompt
 *   3. callWithRotation handles Turn 1 → Tool Exec → Turn 2
 *   4. Final text returned to Sidebar
 */

import { BudgetTracker } from './lib/budget.js';
import { callWithRotation, loadApiConfigs } from './lib/router.js';
import { TOOL_DECLARATIONS, initTools, getActiveTabAndInject } from './lib/tools.js';
import { VectorHistoryStore } from './lib/history-store.js';
import { tryDirectExecution } from './lib/direct-executor.js';

const historyStore = new VectorHistoryStore();
const budget = new BudgetTracker();
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
  full: { historyMax: 10, toolMode: 'all' },
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

function needsBrowserElements(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return ['click','type','press','search','scroll','button','link','input','play','video',
    'like','comment','nhấp','gõ','nhập','tìm','mở','cuộn','nút','bình luận','thích','chọn','ấn','bấm','điền'].some(w => lower.includes(w));
}

// ─── Core Pipeline ──────────────────────────────────────────────────

async function runSingleShotCloudPipeline(userText, configs, quotaConfig) {
  sendToSidebar({ type: 'TYPING_START' });

  // ─── Thu thập DOM Map có điều kiện (Tiết kiệm token) ───
  let contextStr = '';
  if (quotaConfig.toolMode !== 'none' && needsBrowserElements(userText)) {
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
    budget.recordRequest();
    sendToSidebar({ type: 'BUDGET_UPDATE', stats: budget.getStats() });
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

const SYSTEM_PROMPT = `You are an expert AI browser assistant.

## DOM Map & Interaction
- If attached, the DOM Map lists elements like: #0 [VIDEO] "Title" | #1 [BTN:like] | #2 [SEARCH].
- If you need to interact (click/type) but DOM Map is missing, call get_page_elements first.
- Call click_element(#index) or type_into_element(#index) directly using # numbers.

## Content Reading
- Summarize/Read: read_page_content(section_index?) -> summary & sections.
- Specific Info: search_in_page(query) -> snippets.
- NEVER fabricate content.

## Tools
- click_element(index), type_into_element(index, text), scroll_page(dir), open_url(url), get_open_tabs()
- read_page_content(section_index), search_in_page(query), get_page_elements()
- like_video(), comment_video(text)

## Rules
1. Match requests accurately (e.g., "2nd video" -> count [VIDEO] items).
2. Answer in user's language. Use Markdown.
3. If tool fails, explain and suggest alternative.`;