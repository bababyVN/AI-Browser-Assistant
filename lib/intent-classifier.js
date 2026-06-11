/**
 * lib/intent-classifier.js — Tier 1.5 Intent Classifier
 * Uses ONE API call to understand what the user wants, then executes locally.
 * No tool calling, no looping, no schema validation.
 *
 * Flow: user text + rich context → 1 API call → structured JSON → local execution
 */

// ─── Intent Classification Prompt ────────────────────────────────────
const INTENT_PROMPT = `You are a smart browser assistant. Given the user's message and page context, respond with ONLY a valid JSON object. Include a natural, conversational "response" field in every reply.

INTENT SCHEMA (pick exactly one):
{"intent":"click","target":"text or description of element","response":"..."}
{"intent":"type","text":"what to type","target":"input field description","response":"..."}
{"intent":"scroll","direction":"up|down|top|bottom","response":"..."}
{"intent":"open_url","url":"full URL","response":"..."}
{"intent":"search","query":"terms","site":"youtube|google|current","response":"..."}
{"intent":"navigate","action":"back|forward","response":"..."}
{"intent":"tab","action":"close|close_others|switch|list","index":1,"response":"..."}
{"intent":"skip_ad","response":"..."}
{"intent":"like","response":"..."}
{"intent":"subscribe","response":"..."}
{"intent":"press_key","key":"Enter","response":"..."}
{"intent":"play_video","index":1,"response":"..."}
{"intent":"select_option","value":"option text","response":"..."}
{"intent":"chat","response":"your conversational reply here"}
{"intent":"complex","description":"brief task description","response":"..."}

RULES:
- "sign in"/"log in"/"login" → click target "sign in"
- "back"/"go back" → navigate back
- "enter X" without target → type into the focused/first input
- "search X" while on YouTube → site:"current"
- "open one"/"open first result" → click target "first search result"
- "skip ad" → skip_ad
- "cool"/"thanks"/"ok" → chat with brief friendly reply
- "who are you" → chat introducing yourself as a browser assistant
- If user says "search X" without specifying site, check page context to decide youtube vs google
- If the task requires multiple sequential steps → complex
- Always include "response" with a natural, helpful message
- Optionally include "learn":"fact" to remember user preferences/info (email, name, preferences)
- "click 3 vid"/"click the 3rd video"/"click video 3" → play_video with index:3
- "play N video"/"play the Nth video" → play_video with index:N (1-based)
- "comment X"/"write X in comment" → type with text:"X" and target:"comment". ALWAYS execute, never ask.
- NEVER respond with a question when the user gives a clear command. Just do it.
- Respond with ONLY the JSON object. No markdown. No explanation.`;

// ─── Classify User Intent ────────────────────────────────────────────
/**
 * Makes ONE API call to classify user intent into structured JSON.
 * @param {Function} callApiFn - The API caller (callWithRotation)
 * @param {string} userMessage - Raw user text
 * @param {Object} context - Rich context { page, history, userProfile }
 * @param {Array} conversationHistory - Recent conversation for context
 * @returns {Object|null} Parsed intent object, or null if classification failed
 */
export async function classifyIntent(callApiFn, userMessage, context, conversationHistory) {
  // Build a minimal message array for classification
  // Include last 4 messages for conversational context
  const recentHistory = conversationHistory.slice(-4).map(msg => {
    const text = msg.parts?.map(p => p.text || '').filter(Boolean).join('') || '';
    if (!text) return null;
    return { role: msg.role === 'model' ? 'model' : 'user', parts: [{ text }] };
  }).filter(Boolean);

  // Build the rich context string
  let contextStr = '';

  // Current page
  if (context.page) {
    contextStr += `[Current page: "${context.page.title}" — ${context.page.url}]\n`;
    if (context.page.headings) contextStr += `[Headings: ${context.page.headings}]\n`;
    if (context.page.elements) contextStr += `[Elements: ${context.page.elements}]\n`;
  }

  // Recent browsing history
  if (context.history && context.history.length > 0) {
    const historyStr = context.history.map(h => `${h.title} (${h.visitedAt})`).join(', ');
    contextStr += `[Recent history: ${historyStr}]\n`;
  }

  // User profile / GraphRAG facts
  if (context.userProfile && context.userProfile.facts && context.userProfile.facts.length > 0) {
    contextStr += `[User profile: ${context.userProfile.facts.join('; ')}]\n`;
  }

  // Build the classification request
  const classificationMessage = contextStr
    ? `${contextStr}\nUser: ${userMessage}`
    : `User: ${userMessage}`;

  const messages = [
    ...recentHistory,
    { role: 'user', parts: [{ text: classificationMessage }] }
  ];

  try {
    // Call API with NO tools — just text classification
    const data = await callApiFn(messages, [], INTENT_PROMPT);

    const candidate = data.candidates?.[0];
    const responseText = candidate?.content?.parts
      ?.filter(p => p.text)
      .map(p => p.text)
      .join('') || '';

    // Parse JSON from response (handle markdown code blocks too)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const intent = JSON.parse(jsonMatch[0]);
    if (!intent || !intent.intent) return null;

    return intent;
  } catch (err) {
    console.warn('[Intent Classifier] Failed:', err.message);
    // Re-throw rate limit errors so background.js can handle them properly
    if (/rate.?limit|exhausted|all.*key/i.test(err.message)) {
      throw err;
    }
    return null;
  }
}

// ─── Execute Classified Intent ───────────────────────────────────────
/**
 * Executes a classified intent locally using content scripts.
 * No API calls needed — all execution is free.
 * @param {Object} intent - The classified intent object
 * @returns {{ response: string, handled: boolean }}
 */
export async function executeIntent(intent) {
  try {
    switch (intent.intent) {

      case 'chat':
        return { handled: true, response: intent.response || "I'm not sure how to help with that." };

      case 'click': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const elements = await _getElements(tab);
        if (elements.length === 0) return { handled: true, response: 'No interactive elements found on this page.' };
        const target = _findElement(elements, intent.target);
        if (!target) return { handled: true, response: `Could not find "${intent.target}" on this page.` };
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'CLICK_ELEMENT', index: target.index });
        if (res?.success) {
          if (res.action === 'open_in_new_tab' && res.url) {
            await chrome.tabs.create({ url: res.url, active: true });
          }
          return { handled: true, response: intent.response || `Clicked "${target.text || intent.target}"` };
        }
        return { handled: true, response: `Failed to click "${intent.target}".` };
      }

      case 'type': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const elements = await _getElements(tab);
        const inputs = elements.filter(el =>
          el.type === 'input' || el.type === 'textarea' || el.tag === 'input' || el.tag === 'textarea'
        );
        let targetInput = null;
        if (intent.target) {
          const t = intent.target.toLowerCase();
          targetInput = inputs.find(el =>
            (el.text || '').toLowerCase().includes(t) ||
            (el.placeholder || '').toLowerCase().includes(t) ||
            (el.ariaLabel || '').toLowerCase().includes(t) ||
            (el.name || '').toLowerCase().includes(t) ||
            (el.inputType || '').toLowerCase().includes(t)
          );
        }
        if (!targetInput) targetInput = inputs[0];
        if (!targetInput) return { handled: true, response: 'No input field found on this page.' };
        const res = await chrome.tabs.sendMessage(tab.id, {
          action: 'TYPE_TEXT', index: targetInput.index, text: intent.text, clear: true
        });
        return { handled: true, response: intent.response || (res?.success ? `Typed "${intent.text}"` : 'Failed to type.') };
      }

      case 'scroll': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const dir = intent.direction || 'down';
        await chrome.tabs.sendMessage(tab.id, {
          action: 'SCROLL_PAGE', direction: dir, amount: intent.amount || 500
        });
        return { handled: true, response: intent.response || `Scrolled ${dir}` };
      }

      case 'open_url': {
        let url = intent.url || '';
        if (!/^https?:\/\//i.test(url)) {
          url = url.includes('.') ? `https://${url}` : `https://${url}.com`;
        }
        await chrome.tabs.create({ url, active: true });
        return { handled: true, response: intent.response || `Opened ${url}` };
      }

      case 'search': {
        const query = intent.query || '';
        const site = (intent.site || 'google').toLowerCase();
        const tab = await _getActiveTab();
        let url;
        if (site === 'youtube' || site === 'current') {
          const currentUrl = tab?.url || '';
          if (site === 'current' || currentUrl.includes('youtube.com')) {
            if (currentUrl.includes('youtube.com')) {
              url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            } else if (currentUrl.includes('google.com')) {
              url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            } else if (tab) {
              // Try to type into search box on current page
              const elements = await _getElements(tab);
              const searchInput = elements.find(el =>
                (el.type === 'input' || el.type === 'textarea') &&
                (/search/i.test(el.placeholder || '') || /search/i.test(el.ariaLabel || '') ||
                 /search/i.test(el.name || '') || el.inputType === 'search')
              ) || elements.find(el => el.type === 'input' || el.type === 'textarea');
              if (searchInput) {
                await chrome.tabs.sendMessage(tab.id, {
                  action: 'TYPE_TEXT', index: searchInput.index, text: query, clear: true
                });
                await new Promise(r => setTimeout(r, 300));
                await chrome.tabs.sendMessage(tab.id, { action: 'PRESS_KEY', key: 'Enter' });
                return { handled: true, response: intent.response || `Searched for "${query}" on this page` };
              }
              url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
            } else {
              url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
            }
          } else {
            url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
          }
        } else {
          url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        }
        if (url) {
          // Navigate CURRENT tab instead of opening a new one
          if (tab) {
            await chrome.tabs.update(tab.id, { url });
          } else {
            await chrome.tabs.create({ url, active: true });
          }
        }
        return { handled: true, response: intent.response || `Searched for "${query}"` };
      }

      case 'navigate': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        if (intent.action === 'back') {
          await chrome.tabs.goBack(tab.id).catch(() => {});
        } else {
          await chrome.tabs.goForward(tab.id).catch(() => {});
        }
        return { handled: true, response: intent.response || `Navigated ${intent.action}` };
      }

      case 'tab': {
        if (intent.action === 'close') {
          const tab = await _getActiveTab();
          if (tab) await chrome.tabs.remove(tab.id);
          return { handled: true, response: intent.response || 'Closed tab' };
        }
        if (intent.action === 'close_others') {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const activeTab = tabs.find(t => t.active);
          const toClose = tabs.filter(t => !t.active).map(t => t.id);
          if (toClose.length > 0) await chrome.tabs.remove(toClose);
          return { handled: true, response: intent.response || `Closed ${toClose.length} other tab(s). Kept: "${activeTab?.title || 'current'}"` };
        }
        if (intent.action === 'switch') {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const idx = (intent.index || 1) - 1;
          if (idx >= 0 && idx < tabs.length) {
            await chrome.tabs.update(tabs[idx].id, { active: true });
            return { handled: true, response: intent.response || `Switched to: "${tabs[idx].title}"` };
          }
          return { handled: true, response: 'Tab index out of range.' };
        }
        if (intent.action === 'list') {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const lines = tabs.map((t, i) => `${i + 1}. ${t.title}`);
          return { handled: true, response: intent.response || `${tabs.length} tabs open:\n${lines.join('\n')}` };
        }
        return { handled: true, response: 'Unknown tab action.' };
      }

      case 'skip_ad': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const elements = await _getElements(tab);
        const skipBtn = elements.find(el =>
          /skip\s*ad/i.test(el.text || '') || /skip\s*ad/i.test(el.ariaLabel || '')
        ) || elements.find(el =>
          /skip/i.test(el.text || '') && (el.type === 'button' || el.tag === 'button')
        );
        if (!skipBtn) return { handled: true, response: 'No "Skip Ad" button found yet. The ad may not be skippable right now.' };
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'CLICK_ELEMENT', index: skipBtn.index });
        return { handled: true, response: intent.response || (res?.success ? 'Skipped ad ⏭️' : 'Failed to skip ad.') };
      }

      case 'like': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const elements = await _getElements(tab);
        const likeBtn = elements.find(el =>
          (el.type === 'button' || el.tag === 'button') && /^like$/i.test((el.text || '').trim())
        ) || elements.find(el =>
          /like/i.test(el.ariaLabel || '') && !/dislike|unlike/i.test(el.ariaLabel || '')
        );
        if (!likeBtn) return { handled: true, response: 'Could not find a like button.' };
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'CLICK_ELEMENT', index: likeBtn.index });
        return { handled: true, response: intent.response || (res?.success ? 'Liked! 👍' : 'Failed to like.') };
      }

      case 'subscribe': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const elements = await _getElements(tab);
        const subBtn = elements.find(el =>
          /subscribe/i.test(el.text || '') && !/unsubscribe/i.test(el.text || '') &&
          (el.type === 'button' || el.tag === 'button')
        ) || elements.find(el =>
          /subscribe/i.test(el.ariaLabel || '') && !/unsubscribe/i.test(el.ariaLabel || '')
        );
        if (!subBtn) return { handled: true, response: 'Could not find a subscribe button.' };
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'CLICK_ELEMENT', index: subBtn.index });
        return { handled: true, response: intent.response || (res?.success ? 'Subscribed! 🔔' : 'Failed to subscribe.') };
      }

      case 'press_key': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        await chrome.tabs.sendMessage(tab.id, { action: 'PRESS_KEY', key: intent.key || 'Enter' });
        return { handled: true, response: intent.response || `Pressed ${intent.key || 'Enter'} ↵` };
      }

      case 'play_video': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const index = Math.max(0, (intent.index || 1) - 1);
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'PLAY_VIDEO', index });
        if (res?.success) {
          if (res.action === 'open_in_new_tab' && res.url) {
            await chrome.tabs.create({ url: res.url, active: true });
          }
          return { handled: true, response: intent.response || `Playing video #${index + 1}` };
        }
        return { handled: true, response: 'Failed to play video.' };
      }

      case 'select_option': {
        const tab = await _getActiveTab();
        if (!tab) return { handled: true, response: intent.response || 'No active tab found.' };
        const elements = await _getElements(tab);
        const selectEl = elements.find(el => el.tag === 'select');
        if (!selectEl) return { handled: true, response: 'No dropdown found on this page.' };
        const res = await chrome.tabs.sendMessage(tab.id, {
          action: 'SELECT_OPTION', index: selectEl.index, value: intent.value
        });
        return { handled: true, response: intent.response || (res?.success ? `Selected "${intent.value}"` : 'Failed to select.') };
      }

      case 'complex':
        // Multi-step task — signal that this needs Ollama/fallback
        return { handled: false, reason: 'complex', description: intent.description };

      default:
        return { handled: false, reason: 'unknown_intent' };
    }
  } catch (err) {
    return { handled: true, response: `Action failed: ${err.message}` };
  }
}

// ─── Internal Helpers ────────────────────────────────────────────────

async function _getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/extractor.js', 'content/interaction.js', 'content/snapshot.js', 'content/main.js']
    });
  } catch { /* already injected */ }
  return tab;
}

async function _getElements(tab) {
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'GET_INTERACTIVE_ELEMENTS' });
    return res?.success ? (res.elements || []) : [];
  } catch { return []; }
}

/**
 * Smart element finder — matches by text, aria-label, type, or ordinal.
 */
function _findElement(elements, target) {
  if (!target) return elements[0] || null;
  const lower = target.toLowerCase().trim();

  // Ordinal + type: "first video", "3rd link", "second button"
  const ordinalMatch = lower.match(/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+(video|vid|link|button|btn|result|image|img|input)/);
  if (ordinalMatch) {
    const ordinalMap = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5, seventh: 6, eighth: 7, ninth: 8, tenth: 9 };
    let idx = ordinalMap[ordinalMatch[1]] ?? (parseInt(ordinalMatch[1], 10) - 1);
    const typeKeyword = ordinalMatch[2].toLowerCase();
    const typeFilter = {
      video: el => el.type === 'video' || (el.type === 'link' && /watch|video|vid/i.test((el.href || '') + (el.text || ''))),
      vid: el => el.type === 'video' || (el.type === 'link' && /watch|video|vid/i.test((el.href || '') + (el.text || ''))),
      link: el => el.type === 'link',
      button: el => el.type === 'button', btn: el => el.type === 'button',
      result: el => el.type === 'link',
      image: el => el.type === 'image' || el.type === 'image-link',
      img: el => el.type === 'image' || el.type === 'image-link',
      input: el => el.type === 'input' || el.type === 'textarea'
    };
    const filtered = elements.filter(typeFilter[typeKeyword] || (() => true));
    if (idx === -1) idx = filtered.length - 1;
    return filtered[idx] || null;
  }

  // "first/second search result"
  const resultMatch = lower.match(/^(first|second|third|\d+(?:st|nd|rd|th)?)\s+(?:search\s+)?result/);
  if (resultMatch) {
    const ordinalMap = { first: 0, second: 1, third: 2 };
    const idx = ordinalMap[resultMatch[1]] ?? (parseInt(resultMatch[1], 10) - 1);
    const links = elements.filter(el => el.type === 'link');
    return links[idx] || null;
  }

  // Exact text match
  let match = elements.find(el => (el.text || '').toLowerCase().trim() === lower);
  if (match) return match;

  // Partial text match
  match = elements.find(el => (el.text || '').toLowerCase().includes(lower));
  if (match) return match;

  // Aria-label match
  match = elements.find(el => (el.ariaLabel || '').toLowerCase().includes(lower));
  if (match) return match;

  // Placeholder match
  match = elements.find(el => (el.placeholder || '').toLowerCase().includes(lower));
  if (match) return match;

  return null;
}
