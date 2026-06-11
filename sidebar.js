/**
 * Sidebar UI — AI Browser Assistant
 * Chat interface, markdown rendering, tool cards, settings modal
 */

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
const cardGroq = document.getElementById('cardGroq');
const cardCerebras = document.getElementById('cardCerebras');
const cardTogether = document.getElementById('cardTogether');
const headerSubtitle = document.getElementById('headerSubtitle');
const toast = document.getElementById('toast');
// Multi-key UI
const apiKeysList = document.getElementById('apiKeysList');
const keyCountBadge = document.getElementById('keyCountBadge');
const addKeyBtn = document.getElementById('addKeyBtn');
const addKeyForm = document.getElementById('addKeyForm');
const newKeyProvider = document.getElementById('newKeyProvider');
const newKeyLabel = document.getElementById('newKeyLabel');
const newKeyValue = document.getElementById('newKeyValue');
const confirmAddKey = document.getElementById('confirmAddKey');
const cancelAddKey = document.getElementById('cancelAddKey');
// Budget & Quota DOM refs
const budgetDot = document.getElementById('budgetDot');
const budgetText = document.getElementById('budgetText');
const budgetMode = document.getElementById('budgetMode');
const cardFull = document.getElementById('cardFull');
const cardLite = document.getElementById('cardLite');
const cardChat = document.getElementById('cardChat');

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
  
  let badgeHtml = '';
  if (options.tier === 'direct') {
    badgeHtml = '<span class="tier-badge direct" title="Direct execution (No AI)">⚡</span>';
  } else if (options.fromOllama) {
    badgeHtml = '<span class="tier-badge local" title="Local AI">🦙</span>';
  } else if (!options.fromCache) {
    badgeHtml = '<span class="tier-badge cloud" title="Cloud AI">☁️</span>';
  }

  const div = document.createElement('div');
  div.className = 'message message-assistant';
  div.innerHTML = `
    <div class="message-bubble">${renderMarkdown(text)}</div>
    <div class="message-time">${getTimestamp()}${badgeHtml}</div>
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
  const allCards = [cardGemini, cardGroq, cardCerebras, cardTogether];
  allCards.forEach(c => {
    if (!c) return;
    const p = c.dataset.provider;
    c.classList.toggle('active', p === provider);
    const radio = c.querySelector('input');
    if (radio) radio.checked = p === provider;
  });
}

function updateHeaderSubtitle(provider) {
  const names = { gemini: 'Gemini', groq: 'Groq', cerebras: 'Cerebras', together: 'Together AI', ollama: 'Ollama (local)' };
  if (headerSubtitle) headerSubtitle.textContent = `Powered by ${names[provider] || provider}`;
}

// ─── Quota Mode State ───────────────────────────────────────────
let currentModalQuotaMode = 'lite';

const QUOTA_MODE_LABELS = { full: '🚀 Full', lite: '⚡ Lite', chat: '💬 Chat' };

function updateQuotaModeUI(mode) {
  currentModalQuotaMode = mode;
  [cardFull, cardLite, cardChat].forEach(c => {
    const m = c.dataset.mode;
    c.classList.toggle('active', m === mode);
    c.querySelector('input').checked = m === mode;
  });
}

function updateBudgetModeLabel(mode) {
  if (budgetMode) budgetMode.textContent = QUOTA_MODE_LABELS[mode] || '⚡ Lite';
}

function updateBudgetDisplay(stats) {
  if (!budgetText || !budgetDot) return;
  const r = stats.remainingThisMinute;
  budgetText.textContent = `${r} req/min left`;
  budgetDot.className = 'budget-dot ' + (r > 10 ? 'green' : r > 5 ? 'yellow' : 'red');
}

cardFull.addEventListener('click', () => updateQuotaModeUI('full'));
cardLite.addEventListener('click', () => updateQuotaModeUI('lite'));
cardChat.addEventListener('click', () => updateQuotaModeUI('chat'));
budgetMode.addEventListener('click', () => settingsBtn.click());

// ─── Multi-Key Management ────────────────────────────────────────
let currentApiKeys = []; // In-memory copy while modal is open

const PROVIDER_ICONS = { gemini: '✦', groq: '⚡', cerebras: '🧠', together: '🤝' };
const PROVIDER_NAMES = { gemini: 'Gemini', groq: 'Groq', cerebras: 'Cerebras', together: 'Together AI' };

function renderKeyList(keys) {
  currentApiKeys = keys;
  if (keyCountBadge) keyCountBadge.textContent = keys.length > 0 ? `(${keys.length})` : '';
  if (!apiKeysList) return;

  if (keys.length === 0) {
    apiKeysList.innerHTML = '<div class="key-empty">No API keys added yet. Add at least one key to start chatting.</div>';
    return;
  }

  apiKeysList.innerHTML = keys.map((k, i) => `
    <div class="api-key-row" data-index="${i}">
      <span class="key-provider-badge key-${k.provider}">${PROVIDER_ICONS[k.provider] || '🔑'}</span>
      <span class="key-label">${escapeHtml(k.label || PROVIDER_NAMES[k.provider] + ' ' + (i + 1))}</span>
      <span class="key-preview">···${escapeHtml(k.key.slice(-6))}</span>
      <button class="key-remove" data-index="${i}" title="Remove key">✕</button>
    </div>
  `).join('');

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
  // Basic format validation (only for known prefixes)
  if (provider === 'gemini' && !key.startsWith('AIza')) {
    showToast('Gemini keys start with "AIza"', 'error');
    return;
  }
  if (provider === 'groq' && !key.startsWith('gsk_')) {
    showToast('Groq keys start with "gsk_"', 'error');
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
  const data = await chrome.storage.local.get(['aiProvider', 'apiKeys', 'geminiApiKey', 'groqApiKey', 'quotaMode']);
  const provider = data.aiProvider || 'gemini';
  updateProviderUI(provider);
  updateQuotaModeUI(data.quotaMode || 'lite');

  // Load keys: prefer new format, fall back to legacy single keys
  let keys = data.apiKeys || [];
  if (keys.length === 0) {
    if (data.geminiApiKey) keys.push({ provider: 'gemini', key: data.geminiApiKey, label: 'Gemini (Account 1)' });
    if (data.groqApiKey) keys.push({ provider: 'groq', key: data.groqApiKey, label: 'Groq (Account 1)' });
  }
  renderKeyList(keys);

  // Check Ollama status
  checkOllamaStatusUI();

  settingsModal.classList.add('visible');
});

// Provider card click handlers
cardGemini.addEventListener('click', () => updateProviderUI('gemini'));
cardGroq.addEventListener('click', () => updateProviderUI('groq'));
if (cardCerebras) cardCerebras.addEventListener('click', () => updateProviderUI('cerebras'));
if (cardTogether) cardTogether.addEventListener('click', () => updateProviderUI('together'));

function closeModal() {
  settingsModal.classList.remove('visible');
}

modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);

settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeModal();
});

modalSave.addEventListener('click', async () => {
  // Allow saving with 0 keys if Ollama is available
  if (currentApiKeys.length === 0) {
    try {
      const ollamaStatus = await chrome.runtime.sendMessage({ type: 'GET_OLLAMA_STATUS' });
      if (!ollamaStatus?.available) {
        showToast('Add at least one API key, or install Ollama for local chat', 'error');
        return;
      }
    } catch {
      showToast('Add at least one API key to save', 'error');
      return;
    }
  }

  // Save keys + settings
  await chrome.storage.local.set({
    apiKeys: currentApiKeys,
    aiProvider: currentModalProvider,
    quotaMode: currentModalQuotaMode
  });

  updateHeaderSubtitle(currentModalProvider);
  updateBudgetModeLabel(currentModalQuotaMode);
  const keyCount = currentApiKeys.length;
  const keyMsg = keyCount > 0 ? `${keyCount} API ${keyCount === 1 ? 'key' : 'keys'}` : '🦙 Ollama only';
  showToast(`Saved — ${keyMsg}, ${QUOTA_MODE_LABELS[currentModalQuotaMode]} mode`, 'success');
  closeModal();
});

// ─── Send Message ───────────────────────────────────────────────────
async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isWaiting) return;

  // Handle /clear command
  if (text.toLowerCase() === '/clear') {
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
let lastToolCardId = null;

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
      addAssistantMessage(message.text, { 
        tier: message.tier, 
        fromOllama: message.fromOllama,
        fromCache: message.fromCache
      });
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

    case 'TOOL_CALL':
      lastToolCardId = addToolCallCard(message.toolName, message.args);
      break;

    case 'TOOL_RESULT':
      if (lastToolCardId) {
        updateToolCardResult(lastToolCardId, message.result);
      }
      break;

    case 'BUDGET_UPDATE':
      updateBudgetDisplay(message.stats);
      break;

    case 'PROVIDER_USED':
      // Briefly show which provider/key answered in the header
      if (headerSubtitle && message.label) {
        const prev = headerSubtitle.textContent;
        headerSubtitle.textContent = `⚡ ${message.label}`;
        setTimeout(() => { headerSubtitle.textContent = prev; }, 3000);
      }
      break;

    case 'KEY_ROTATION':
      // Show rotation notification
      showToast(`Key rotated — ${message.remaining} key(s) remaining`, 'info');
      break;
  }
});

// ─── Ollama Status UI ──────────────────────────────────────────
const ollamaIndicator = document.getElementById('ollamaIndicator');
const ollamaStatusIcon = document.getElementById('ollamaStatusIcon');
const ollamaStatusText = document.getElementById('ollamaStatusText');

async function checkOllamaStatusUI() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_OLLAMA_STATUS' });
    if (status && status.available) {
      if (ollamaIndicator) ollamaIndicator.style.display = '';
      if (ollamaStatusIcon) ollamaStatusIcon.textContent = '✅';
      if (ollamaStatusText) {
        const models = status.models?.slice(0, 3).join(', ') || 'connected';
        ollamaStatusText.textContent = `Running (${models})`;
      }
    } else {
      if (ollamaIndicator) ollamaIndicator.style.display = 'none';
      if (ollamaStatusIcon) ollamaStatusIcon.textContent = '❌';
      if (ollamaStatusText) ollamaStatusText.textContent = 'Not detected — install from ollama.com';
    }
  } catch {
    if (ollamaIndicator) ollamaIndicator.style.display = 'none';
    if (ollamaStatusIcon) ollamaStatusIcon.textContent = '❌';
    if (ollamaStatusText) ollamaStatusText.textContent = 'Not detected';
  }
}

// ─── Initialize ─────────────────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get(['aiProvider', 'apiKeys', 'geminiApiKey', 'quotaMode']);
  const provider = data.aiProvider || 'gemini';
  const mode = data.quotaMode || 'lite';
  updateHeaderSubtitle(provider);
  updateBudgetModeLabel(mode);

  // Check if any keys are configured (new or legacy format)
  const hasKeys = (data.apiKeys && data.apiKeys.length > 0) || data.geminiApiKey;
  if (!hasKeys) {
    // Only auto-open settings if Ollama isn't running either
    try {
      const ollamaStatus = await chrome.runtime.sendMessage({ type: 'GET_OLLAMA_STATUS' });
      if (!ollamaStatus?.available) {
        setTimeout(() => {
          settingsModal.classList.add('visible');
          updateProviderUI(provider);
          updateQuotaModeUI(mode);
          renderKeyList([]);
          checkOllamaStatusUI();
        }, 500);
      } else {
        updateHeaderSubtitle('ollama');
      }
    } catch {
      setTimeout(() => {
        settingsModal.classList.add('visible');
        updateProviderUI(provider);
        updateQuotaModeUI(mode);
        renderKeyList([]);
      }, 500);
    }
  }

  // Check Ollama status on sidebar open
  checkOllamaStatusUI();

  messageInput.focus();
}

init();
