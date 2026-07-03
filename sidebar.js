/**
 * Sidebar UI — AI Browser Assistant
 * Chat interface, markdown rendering, tool cards, settings modal
 */

import { loadApiConfigs, saveApiConfigs } from './lib/router.js';

// ─── DOM Elements ───────────────────────────────────────────────────
const chatArea = document.getElementById('chatArea');
const emptyState = document.getElementById('emptyState');
const typingIndicator = document.getElementById('typingIndicator');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const modalClose = document.getElementById('modalClose');
const modalCancel = document.getElementById('modalCancel');
const modalSave = document.getElementById('modalSave');
const cardGemini = document.getElementById('cardGemini');
const cardOpenAI = document.getElementById('cardOpenAI');
const cardOpenRouter = document.getElementById('cardOpenRouter');
const headerSubtitle = document.getElementById('headerSubtitle');
const toast = document.getElementById('toast');
// Multi-key UI
const apiKeysList = document.getElementById('apiKeysList');
const keyCountBadge = document.getElementById('keyCountBadge');
const addKeyBtn = document.getElementById('addKeyBtn');
const headerModeSelect = document.getElementById('headerModeSelect');
const addKeyForm = document.getElementById('addKeyForm');
const newKeyProvider = document.getElementById('newKeyProvider');
const newKeyLabel = document.getElementById('newKeyLabel');
const newKeyValue = document.getElementById('newKeyValue');
const confirmAddKey = document.getElementById('confirmAddKey');
const cancelAddKey = document.getElementById('cancelAddKey');
// Budget & Quota DOM refs (deleted/disabled)
const budgetDot = null;
const budgetText = null;
const budgetMode = null;
const cardFull = document.getElementById('cardFull');
const cardLite = null;
const cardChat = document.getElementById('cardChat');
const openrouterModelGroup = document.getElementById('openrouterModelGroup');
const openrouterModelInput = document.getElementById('openrouterModelInput');
const debugModeCheckbox = document.getElementById('debugModeCheckbox');
const debugPanel = document.getElementById('debugPanel');
const debugClose = document.getElementById('debugClose');
const debugSentPrompt = document.getElementById('debugSentPrompt');
const debugReceivedResponse = document.getElementById('debugReceivedResponse');

let isWaiting = false;

// ─── Lightweight Markdown Parser ────────────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';
  let html = text;

  // Escape HTML first
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and Italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rule
  html = html.replace(/^---$/gm, '<hr>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered lists
  html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Ordered lists
  html = html.replace(/^[\s]*\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs — wrap remaining lines
  html = html.replace(/^(?!<[hulpboh]|<\/)(.+)$/gm, '<p>$1</p>');

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

// ─── Tool Icons ─────────────────────────────────────────────────────
const TOOL_ICONS = {
  get_open_tabs: '📑',
  open_url: '🔗',
  ask_website: '🔍',
  highlight_element: '✨',
  get_page_elements: '👁️',
  click_element: '👆',
  type_into_element: '⌨️',
  select_option: '📋',
  scroll_page: '📜',
  play_video: '▶️',
  get_page_snapshot: '📸',
  find_history: '🔎'
};

const TOOL_LABELS = {
  get_open_tabs: 'Get Open Tabs',
  open_url: 'Open URL',
  ask_website: 'Ask Website',
  highlight_element: 'Highlight Section',
  get_page_elements: 'Scan Page Elements',
  click_element: 'Click Element',
  type_into_element: 'Type Text',
  select_option: 'Select Option',
  scroll_page: 'Scroll Page',
  play_video: 'Play Video',
  get_page_snapshot: 'Page Snapshot',
  find_history: 'Search History'
};

// ─── Message Rendering ──────────────────────────────────────────────
function getTimestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function hideEmptyState() {
  if (emptyState) emptyState.style.display = 'none';
}

function addUserMessage(text) {
  hideEmptyState();
  const div = document.createElement('div');
  div.className = 'message message-user';
  div.innerHTML = `
    <div class="message-bubble">${escapeHtml(text)}</div>
    <div class="message-time">${getTimestamp()}</div>
  `;
  chatArea.insertBefore(div, typingIndicator);
  scrollToBottom();
}

function addAssistantMessage(text, options = {}) {
  hideEmptyState();

  const div = document.createElement('div');
  div.className = 'message message-assistant';
  div.innerHTML = `
    <div class="message-bubble">${renderMarkdown(text)}</div>
    <div class="message-time">${getTimestamp()}</div>
  `;
  chatArea.insertBefore(div, typingIndicator);
  scrollToBottom();
}

function addErrorMessage(text) {
  hideEmptyState();
  const div = document.createElement('div');
  div.className = 'message message-error';
  div.innerHTML = `
    <div class="message-bubble">⚠️ ${escapeHtml(text)}</div>
    <div class="message-time">${getTimestamp()}</div>
  `;
  chatArea.insertBefore(div, typingIndicator);
  scrollToBottom();
}

function addToolCallCard(toolName, args) {
  hideEmptyState();
  const cardId = 'tool-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5);
  const div = document.createElement('div');
  div.className = 'tool-card';
  div.id = cardId;
  div.innerHTML = `
    <div class="tool-card-header">
      <div class="tool-icon tool-${toolName}">${TOOL_ICONS[toolName] || '🔧'}</div>
      <div class="tool-card-info">
        <div class="tool-card-name">${TOOL_LABELS[toolName] || toolName}</div>
        <div class="tool-card-status running">⏳ Running...</div>
      </div>
      <div class="tool-card-chevron">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </div>
    </div>
    <div class="tool-card-body">
      <pre>${JSON.stringify(args || {}, null, 2)}</pre>
    </div>
  `;
  
  const header = div.querySelector('.tool-card-header');
  header.addEventListener('click', () => {
    toggleToolCard(cardId);
  });
  
  chatArea.insertBefore(div, typingIndicator);
  scrollToBottom();
  return cardId;
}

// ─── Element Type Icons for compact list ────────────────────────────
const ELEMENT_TYPE_ICONS = {
  link: '🔗', button: '🔘', input: '📝', textarea: '📝',
  select: '📋', video: '▶️', iframe: '🖼️', 'image-link': '🖼️',
  image: '🖼️', checkbox: '☑️', radio: '🔘', tab: '📑',
  menuitem: '📄', interactive: '⚡'
};

function formatToolResult(result) {
  // If result has an elements array, render as compact numbered list
  if (result && result.elements && Array.isArray(result.elements)) {
    const lines = result.elements.map(el => {
      const icon = ELEMENT_TYPE_ICONS[el.type] || '⚡';
      const text = el.text || el.placeholder || el.ariaLabel || '(no text)';
      const detail = el.href ? ` — ${el.href.substring(0, 60)}${el.href.length > 60 ? '...' : ''}` : '';
      return `${el.index}. ${icon} [${el.type}] "${text}"${detail}`;
    });

    let header = '';
    if (result.pageTitle) header += `📄 ${result.pageTitle}\n`;
    if (result.elementCount !== undefined) header += `Found ${result.elementCount} interactive elements:\n\n`;

    return header + lines.join('\n');
  }

  // If result has a snapshot with elements, show summary + elements
  if (result && result.elements && result.counts) {
    const c = result.counts;
    let summary = `📄 ${result.title || 'Page'}\n🔗 ${result.url || ''}\n\n`;
    summary += `📊 Elements: ${c.links} links, ${c.buttons} buttons, ${c.inputs} inputs, ${c.videos} videos, ${c.selects} selects\n\n`;

    if (result.contentSummary) {
      summary += `📝 Content preview:\n${result.contentSummary.substring(0, 500)}...\n\n`;
    }

    const lines = result.elements.map(el => {
      const icon = ELEMENT_TYPE_ICONS[el.type] || '⚡';
      const text = el.text || el.placeholder || el.ariaLabel || '(no text)';
      return `${el.index}. ${icon} [${el.type}] "${text}"`;
    });
    summary += lines.join('\n');
    return summary;
  }

  // Default: JSON
  return JSON.stringify(result, null, 2);
}

function updateToolCardResult(cardId, result) {
  const card = document.getElementById(cardId);
  if (!card) return;

  const status = card.querySelector('.tool-card-status');
  const body = card.querySelector('.tool-card-body');
  const hasError = result && (result.error || result.success === false);

  status.textContent = hasError ? '❌ Error' : '✅ Completed';
  status.className = `tool-card-status ${hasError ? 'error' : 'completed'}`;

  const resultPre = document.createElement('pre');
  resultPre.textContent = formatToolResult(result);
  body.appendChild(resultPre);
}

// ─── Toggle Tool Card ───────────────────────────────────────────────
// Needs to be global for onclick handler
window.toggleToolCard = function(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const body = card.querySelector('.tool-card-body');
  const chevron = card.querySelector('.tool-card-chevron');
  body.classList.toggle('expanded');
  chevron.classList.toggle('expanded');
};

// ─── Typing Indicator ───────────────────────────────────────────────
function showTyping() {
  typingIndicator.classList.add('visible');
  scrollToBottom();
}

function hideTyping() {
  typingIndicator.classList.remove('visible');
}

// ─── Scroll ─────────────────────────────────────────────────────────
function scrollToBottom() {
  requestAnimationFrame(() => {
    chatArea.scrollTop = chatArea.scrollHeight;
  });
}

// ─── Escape HTML ────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Toast ──────────────────────────────────────────────────────────
function showToast(message, type = 'success') {
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ─── Provider State ─────────────────────────────────────────────
let currentModalProvider = 'gemini';

function updateProviderUI(provider) {
  currentModalProvider = provider;
  const allCards = [cardGemini, cardOpenAI, cardOpenRouter].filter(Boolean);
  allCards.forEach(c => {
    if (!c) return;
    const p = c.dataset.provider;
    c.classList.toggle('active', p === provider);
    const radio = c.querySelector('input');
    if (radio) radio.checked = p === provider;
  });
  if (openrouterModelGroup) {
    openrouterModelGroup.style.display = (provider === 'openrouter') ? 'block' : 'none';
  }
}

function updateHeaderSubtitle(provider) {
  const names = { gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' };
  if (headerSubtitle) headerSubtitle.textContent = `Powered by ${names[provider] || provider}`;
}
// ─── Quota Mode State ───────────────────────────────────────────
let currentModalQuotaMode = 'full';

const QUOTA_MODE_LABELS = { full: '🚀 Full', chat: '💬 Chat' };

function updateQuotaModeUI(mode) {
  currentModalQuotaMode = mode;
  [cardFull, cardLite, cardChat].filter(Boolean).forEach(c => {
    const m = c.dataset.mode;
    c.classList.toggle('active', m === mode);
    c.querySelector('input').checked = m === mode;
  });
}

function updateBudgetModeLabel(mode) {
  if (budgetMode) budgetMode.textContent = QUOTA_MODE_LABELS[mode] || '';
}

function updateBudgetDisplay(stats) {
  if (!budgetText || !budgetDot) return;
  const r = stats.remainingThisMinute;
  budgetText.textContent = `${r} req/min left`;
  budgetDot.className = 'budget-dot ' + (r > 10 ? 'green' : r > 5 ? 'yellow' : 'red');
}

if (cardFull) cardFull.addEventListener('click', () => updateQuotaModeUI('full'));
if (cardChat) cardChat.addEventListener('click', () => updateQuotaModeUI('chat'));

if (headerModeSelect) {
  headerModeSelect.addEventListener('change', async (e) => {
    const mode = e.target.value;
    currentModalQuotaMode = mode;
    updateQuotaModeUI(mode);
    await chrome.storage.local.set({ quotaMode: mode });
    showToast(`Switched to ${mode === 'chat' ? 'Chat' : 'Full'} mode`, 'success');
  });
}

// ─── Multi-Key Management ────────────────────────────────────────
let currentApiKeys = []; // In-memory copy while modal is open

const PROVIDER_ICONS = { gemini: '✦', openai: '🟢', openrouter: '🌐' };
const PROVIDER_NAMES = { gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' };

function renderKeyList(keys) {
  currentApiKeys = keys;
  if (keyCountBadge) keyCountBadge.textContent = keys.length > 0 ? `(${keys.length})` : '';
  if (!apiKeysList) return;

  if (keys.length === 0) {
    apiKeysList.innerHTML = '<div class="key-empty">No API keys added yet. Add at least one key to start chatting.</div>';
    return;
  }

  apiKeysList.innerHTML = keys.map((k, i) => {
    const preview = typeof k.key === 'string' ? k.key.slice(-6) : '******';
    return `
      <div class="api-key-row" data-index="${i}">
        <span class="key-provider-badge key-${k.provider}">${PROVIDER_ICONS[k.provider] || '🔑'}</span>
        <span class="key-label">${escapeHtml(k.label || PROVIDER_NAMES[k.provider] + ' ' + (i + 1))}</span>
        <span class="key-preview">···${escapeHtml(preview)}</span>
        <button class="key-remove" data-index="${i}" title="Remove key">✕</button>
      </div>
    `;
  }).join('');

  // Attach remove handlers
  apiKeysList.querySelectorAll('.key-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.index);
      currentApiKeys = currentApiKeys.filter((_, i) => i !== idx);
      renderKeyList(currentApiKeys);
    });
  });
}

// Show/hide add-key form
addKeyBtn.addEventListener('click', () => {
  addKeyForm.style.display = '';
  addKeyBtn.style.display = 'none';
  newKeyValue.focus();
});

cancelAddKey.addEventListener('click', () => {
  addKeyForm.style.display = 'none';
  addKeyBtn.style.display = '';
  newKeyLabel.value = '';
  newKeyValue.value = '';
});

confirmAddKey.addEventListener('click', () => {
  const key = newKeyValue.value.trim();
  const provider = newKeyProvider.value;
  const label = newKeyLabel.value.trim() || `${PROVIDER_NAMES[provider]} (${currentApiKeys.filter(k => k.provider === provider).length + 1})`;

  if (!key) {
    showToast('Please paste an API key', 'error');
    return;
  }
  // Format validation per provider
  if (provider === 'gemini' && !key.startsWith('AIza') && !key.startsWith('AQ.')) {
    showToast('Gemini keys must start with "AIza" or "AQ."', 'error');
    return;
  }
  if (provider === 'openrouter' && !key.startsWith('sk-or-')) {
    showToast('OpenRouter keys start with "sk-or-"', 'error');
    return;
  }
  if (provider === 'openai' && !key.startsWith('sk-')) {
    showToast('OpenAI keys start with "sk-"', 'error');
    return;
  }
  if (key.length < 10) {
    showToast('Key seems too short', 'error');
    return;
  }
  // Prevent duplicates
  if (currentApiKeys.some(k => k.key === key)) {
    showToast('This key is already added', 'error');
    return;
  }

  currentApiKeys = [...currentApiKeys, { provider, key, label }];
  renderKeyList(currentApiKeys);
  newKeyLabel.value = '';
  newKeyValue.value = '';
  addKeyForm.style.display = 'none';
  addKeyBtn.style.display = '';
  showToast(`${label} added`, 'success');
});

// ─── Settings Modal ─────────────────────────────────────────────────
settingsBtn.addEventListener('click', async () => {
  try {
    const data = await chrome.storage.local.get(['aiProvider', 'quotaMode', 'openrouterModel', 'debugMode']);
    const provider = data.aiProvider || 'gemini';
    updateProviderUI(provider);
    updateQuotaModeUI(data.quotaMode || 'full');
    if (openrouterModelInput) {
      openrouterModelInput.value = data.openrouterModel || 'google/gemini-2.5-flash';
    }
    if (debugModeCheckbox) {
      debugModeCheckbox.checked = !!data.debugMode;
    }

    // Load keys using the secure router (which decrypts keys on the fly)
    const keys = await loadApiConfigs();
    renderKeyList(keys);

    settingsModal.classList.add('visible');
  } catch (err) {
    console.error('[Sidebar] Settings click error:', err);
    showToast(`Error opening settings: ${err.message}`, 'error');
  }
});

// Provider card click handlers
if (cardGemini) cardGemini.addEventListener('click', () => updateProviderUI('gemini'));
if (cardOpenAI) cardOpenAI.addEventListener('click', () => updateProviderUI('openai'));
if (cardOpenRouter) cardOpenRouter.addEventListener('click', () => updateProviderUI('openrouter'));

function closeModal() {
  settingsModal.classList.remove('visible');
}

modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeModal();
});

modalSave.addEventListener('click', async () => {
  try {
    if (currentApiKeys.length === 0) {
      showToast('Add at least one API key to save', 'error');
      return;
    }

    // Save keys + settings with encryption
    await saveApiConfigs(currentApiKeys);
    const openrouterModel = (openrouterModelInput?.value || '').trim() || 'google/gemini-2.5-flash';
    const debugMode = !!debugModeCheckbox?.checked;
    await chrome.storage.local.set({
      aiProvider: currentModalProvider,
      quotaMode: currentModalQuotaMode,
      openrouterModel,
      debugMode
    });
    if (debugPanel) {
      debugPanel.style.display = debugMode ? 'block' : 'none';
    }

    updateHeaderSubtitle(currentModalProvider);
    updateBudgetModeLabel(currentModalQuotaMode);
    if (headerModeSelect) {
      headerModeSelect.value = currentModalQuotaMode;
    }
    const keyCount = currentApiKeys.length;
    showToast(`Saved — ${keyCount} API ${keyCount === 1 ? 'key' : 'keys'}, ${QUOTA_MODE_LABELS[currentModalQuotaMode]} mode`, 'success');
    closeModal();
  } catch (err) {
    console.error('[Sidebar] Save settings error:', err);
    showToast(`Error saving settings: ${err.message}`, 'error');
  }
});

if (debugClose) {
  debugClose.addEventListener('click', () => {
    if (debugPanel) debugPanel.style.display = 'none';
    if (debugModeCheckbox) debugModeCheckbox.checked = false;
    chrome.storage.local.set({ debugMode: false });
  });
}

// ─── Send Message ───────────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isWaiting) return;

  // Handle /clear command or natural-language clear requests
  if (/^\/clear$/i.test(text) || /^(?:clear|reset)\s+(?:chat|conversation|history)$/i.test(text)) {
    messageInput.value = '';
    messageInput.style.height = 'auto';
    clearChat();
    return;
  }

  messageInput.value = '';
  messageInput.style.height = 'auto';
  addUserMessage(text);

  isWaiting = true;
  sendBtn.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: 'CHAT_MESSAGE', text });
  } catch (err) {
    addErrorMessage('Failed to send message. Please try again.');
    isWaiting = false;
    sendBtn.disabled = false;
  }
}

function clearChat() {
  // Remove all messages and tool cards
  const elements = chatArea.querySelectorAll('.message, .tool-card');
  elements.forEach(el => el.remove());

  // Show empty state
  if (emptyState) emptyState.style.display = '';

  // Clear history in background
  chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' });
  showToast('Conversation cleared', 'success');
}

// ─── Event Listeners ────────────────────────────────────────────────
sendBtn.addEventListener('click', sendMessage);

messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
});

// ─── Listen for Background Messages ─────────────────────────────────
// Maps tool call sequence index → card ID to handle multiple concurrent tool calls
const toolCardMap = new Map();
let toolCallSequence = 0;

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'TYPING_START':
      showTyping();
      break;

    case 'TYPING_STOP':
      hideTyping();
      isWaiting = false;
      sendBtn.disabled = false;
      break;

    case 'ASSISTANT_MESSAGE':
      hideTyping();
      addAssistantMessage(message.text, { fromCache: message.fromCache });
      isWaiting = false;
      sendBtn.disabled = false;
      break;

    case 'ASSISTANT_TEXT':
      // Partial text before tool calls
      if (message.text) {
        addAssistantMessage(message.text);
      }
      break;

    case 'ASSISTANT_ERROR':
      hideTyping();
      addErrorMessage(message.error);
      isWaiting = false;
      sendBtn.disabled = false;
      break;

    case 'TOOL_CALL': {
      const seqId = message.seqId ?? toolCallSequence++;
      const cardId = addToolCallCard(message.toolName, message.args);
      toolCardMap.set(seqId, cardId);
      break;
    }

    case 'TOOL_RESULT': {
      const seqId = message.seqId ?? (toolCallSequence - 1);
      const cardId = toolCardMap.get(seqId);
      if (cardId) {
        updateToolCardResult(cardId, message.result);
        toolCardMap.delete(seqId);
      }
      break;
    }

    case 'BUDGET_UPDATE':
      updateBudgetDisplay(message.stats);
      break;

    case 'PROVIDER_USED':
      // Briefly show which provider/key answered in the header
      if (headerSubtitle && message.label) {
        const prev = headerSubtitle.textContent;
        const icon = message.provider === 'smart' ? '🧠' : message.provider === 'direct' ? '⚡' : '☁️';
        headerSubtitle.textContent = `${icon} ${message.label}`;
        setTimeout(() => { headerSubtitle.textContent = prev; }, 3000);
      }
      break;

    case 'DEBUG_INFO':
      if (debugSentPrompt) debugSentPrompt.textContent = message.sentPrompt || '';
      if (debugReceivedResponse) debugReceivedResponse.textContent = message.rawResponse || '';
      break;

    case 'KEY_ROTATION':
      // Show rotation notification
      showToast(`Key rotated — ${message.remaining} key(s) remaining`, 'info');
      break;
  }
});



// ─── Render Conversation History ─────────────────────────────────────
async function loadAndRenderHistory() {
  try {
    const history = await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION_HISTORY' });
    if (history && Array.isArray(history) && history.length > 0) {
      if (emptyState) emptyState.style.display = 'none';

      // Clear any existing messages in chatArea except typingIndicator
      const existing = chatArea.querySelectorAll('.message, .tool-card');
      existing.forEach(e => e.remove());

      // Render messages
      for (const msg of history) {
        if (msg.role === 'user') {
          let cleanText = msg.parts?.[0]?.text || '';
          if (cleanText.includes('\n\n')) {
            const parts = cleanText.split('\n\n');
            if (parts[0].startsWith('[Current page:')) {
              cleanText = parts.slice(1).join('\n\n'); // get everything after the context header
            }
          }
          addUserMessage(cleanText);
        } else if (msg.role === 'model') {
          const cleanText = msg.parts?.[0]?.text || '';
          addAssistantMessage(cleanText);
        }
      }
      scrollToBottom();
    }
  } catch (err) {
    console.warn('[Sidebar] Failed to load conversation history:', err.message);
  }
}

// ─── Initialize ──────────────────────────────────────────────────
async function init() {
  try {
    const data = await chrome.storage.local.get(['aiProvider', 'apiKeys', 'geminiApiKey', 'quotaMode', 'debugMode']);
    const provider = data.aiProvider || 'gemini';
    const mode = data.quotaMode || 'full';
    updateHeaderSubtitle(provider);
    updateBudgetModeLabel(mode);
    if (headerModeSelect) {
      headerModeSelect.value = mode === 'chat' ? 'chat' : 'full';
    }
    if (debugPanel) debugPanel.style.display = data.debugMode ? 'block' : 'none';

    // Auto-open settings modal if no API keys are configured
    const hasKeys = (data.apiKeys && data.apiKeys.length > 0) || data.geminiApiKey;
    if (!hasKeys) {
      setTimeout(() => {
        settingsModal.classList.add('visible');
        updateProviderUI(provider);
        updateQuotaModeUI(mode);
        renderKeyList([]);
      }, 500);
    }

    await loadAndRenderHistory();
    messageInput.focus();
  } catch (err) {
    console.error('[Sidebar] Initialization error:', err);
    showToast(`Error initializing sidebar: ${err.message}`, 'error');
  }
}

init();
