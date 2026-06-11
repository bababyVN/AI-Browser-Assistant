# AI IDE Implementation Prompt — Single-Call Intent Architecture

> **IMPORTANT**: Read this ENTIRE file before making ANY changes. Follow EVERY instruction EXACTLY.

## Project
```
c:\Users\Windows\Downloads\Project2
```
This is a Manifest V3 Chrome Extension (ES Modules, `.js` extensions required). No npm, no build tools.

## The Problem
The extension has a 3-tier routing system but the UX is terrible:
1. **Tier 1 (Regex)** is too aggressive — it catches "search for trump" and always opens Google, even when the user is on YouTube. It handles "hi" poorly. It cannot understand typos, context, or natural language.
2. **Tier 3 (Cloud Agent Loop)** burns 3-8 API calls per message by looping with tool declarations. This causes constant rate limiting and schema validation crashes.
3. The AI never generates natural conversational responses — it just executes robotically.

## The Solution
**Strip Tier 1 down to ONLY handle unambiguous navigation commands.** Everything else goes to **Tier 1.5 (Intent Classifier)** which uses exactly ONE API call to understand the user AND generate a response, then executes locally for free. **Delete Tier 3 entirely.**

```
User message
  → Tier 1: ONLY handles "open [url]", "scroll [dir]", "go back/forward", "close tab"
  → Tier 1.5: ONE API call → AI returns JSON with intent + response → local execution
  → Tier 2: Ollama offline fallback only
```

---

## FILE CHANGES

### 1. `lib/direct-executor.js` — STRIP DOWN

**Remove ALL patterns EXCEPT these 6:**
1. `open [url]` / `go to [url]` — opens a URL
2. `scroll up/down/top/bottom` — scrolls the page
3. `close tab` — closes the active tab
4. `go back` / `go forward` — browser navigation
5. `list tabs` / `show tabs` — lists open tabs
6. `switch to tab [N]` — switches to tab by number

**DELETE these patterns** (they now go to Tier 1.5 which handles them smarter):
- ~~search [query]~~ (Tier 1.5 knows if you're on YouTube or Google)
- ~~search [query] on youtube~~ (Tier 1.5 handles this)
- ~~click [element]~~ (Tier 1.5 understands "sign in", "first video", etc.)
- ~~like / subscribe~~ (Tier 1.5 handles this)
- ~~comment [text]~~ (Tier 1.5 handles this)
- ~~type [text] in [target]~~ (Tier 1.5 handles this)
- ~~play video~~ (Tier 1.5 handles this)
- ~~press enter / submit~~ (Tier 1.5 handles this)
- ~~highlight section~~ (Tier 1.5 handles this)
- ~~select [option]~~ (Tier 1.5 handles this)

**Here is the EXACT replacement content for `lib/direct-executor.js`:**

```javascript
/**
 * lib/direct-executor.js — Tier 1 (Minimal Regex)
 * ONLY handles unambiguous navigation commands that don't need AI understanding.
 * Everything else goes to Tier 1.5 (Intent Classifier).
 */

const directPatterns = [
  // 1. open [URL] / go to [URL]
  {
    pattern: /^(?:open|go\s*to)\s+(.+)$/i,
    execute: async (match) => {
      let url = match[1].trim();
      // Don't catch natural language like "open the first result"
      if (/^(the|a|an|that|this|one|it)\b/i.test(url)) return false;
      if (!/^https?:\/\//i.test(url)) {
        if (url.includes('.')) {
          url = `https://${url}`;
        } else {
          url = `https://${url}.com`;
        }
      }
      await chrome.tabs.create({ url });
      return `Opened ${url}`;
    }
  },
  // 2. scroll up/down/top/bottom
  {
    pattern: /^scroll\s+(up|down|top|bottom)(?:\s+(\d+))?$/i,
    execute: async (match) => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      try {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['content/extractor.js', 'content/interaction.js', 'content/snapshot.js', 'content/main.js']
        });
      } catch {}
      const direction = match[1].toLowerCase();
      const amount = match[2] ? parseInt(match[2], 10) : 500;
      await chrome.tabs.sendMessage(activeTab.id, {
        action: 'SCROLL_PAGE', direction, amount
      });
      return `Scrolled ${direction}`;
    }
  },
  // 3. close tab
  {
    pattern: /^close\s+(?:this\s+)?tab$/i,
    execute: async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      await chrome.tabs.remove(activeTab.id);
      return `Closed tab`;
    }
  },
  // 4. go back / go forward / back / forward
  {
    pattern: /^(?:go\s+)?(back|forward)$/i,
    execute: async (match) => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      if (match[1].toLowerCase() === 'back') {
        await chrome.tabs.goBack(activeTab.id).catch(() => {});
      } else {
        await chrome.tabs.goForward(activeTab.id).catch(() => {});
      }
      return `Navigated ${match[1]}`;
    }
  },
  // 5. list tabs / show tabs
  {
    pattern: /^(?:list|show)\s+tabs$/i,
    execute: async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const lines = tabs.map((t, i) => `${i + 1}. ${t.title}`);
      return `${tabs.length} tabs open:\n${lines.join('\n')}`;
    }
  },
  // 6. switch to tab N
  {
    pattern: /^switch\s+(?:to\s+)?tab\s+(\d+)$/i,
    execute: async (match) => {
      const idx = parseInt(match[1], 10) - 1;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      if (idx >= 0 && idx < tabs.length) {
        await chrome.tabs.update(tabs[idx].id, { active: true });
        return `Switched to: ${tabs[idx].title}`;
      }
      return 'Tab index out of range.';
    }
  }
];

export async function tryDirectExecution(userText) {
  const text = userText.trim();
  for (const { pattern, execute } of directPatterns) {
    const match = pattern.exec(text);
    if (match) {
      try {
        const response = await execute(match, text);
        if (response === false) continue;
        return { handled: true, response };
      } catch (e) {
        return { handled: true, response: `Direct execution failed: ${e.message}` };
      }
    }
  }
  return { handled: false };
}
```

### 2. `lib/intent-classifier.js` — VERIFY OR CREATE

This file should already exist with the updated implementation. Verify it has:
- `INTENT_PROMPT` that requires a `"response"` field in every JSON
- `classifyIntent(callApiFn, userMessage, context, conversationHistory)` that accepts a rich context object `{page, history, userProfile}` (NOT a plain string)
- `executeIntent(intent)` with all handlers using `intent.response || 'fallback'`
- All 15 intent handlers: chat, click, type, scroll, open_url, search, navigate, tab, skip_ad, like, subscribe, press_key, play_video, select_option, complex

**If it does NOT exist or is wrong, create it.** The file should be ~350-420 lines.

Key things to verify in `classifyIntent()`:
- It builds a context string from `context.page`, `context.history`, and `context.userProfile`
- It calls the API with `tools: []` (empty array — NO tool declarations)
- It parses the JSON response and returns the intent object

Key things to verify in the INTENT_PROMPT:
- It lists ALL available intents with their JSON schemas
- It includes the rule: `"search X" while on YouTube → site:"current"`
- It includes the rule: `"open one"/"open first result" → click target "first search result"`
- It includes: `Optionally include "learn":"fact" to remember user preferences`

### 3. `background.js` — VERIFY AND FIX

Verify the routing in `handleChatMessage()` follows this EXACT order:

```
1. Tier 1: tryDirectExecution() → only catches open/scroll/close/back/forward/tabs
2. Tier 1.5: classifyIntent() with gatherContext() → handles EVERYTHING else
3. Tier 2: runOllamaAgentLoop() → offline fallback ONLY
```

**There MUST be NO Tier 3 agent loop.** No `for (let i = 0; i < maxIterations; i++)` in `handleChatMessage`. No `executeTool()` calls from the main handler. No tool declarations sent to `callWithRotation` from the main handler.

Verify these functions exist in background.js:
- `gatherContext()` — returns `{ page, history, userProfile }`
  - `page`: from content script's `GET_QUICK_CONTEXT` action
  - `history`: from `chrome.history.search()` (last 10 pages, last 1 hour)
  - `userProfile`: from `chrome.storage.local.get(['userProfile'])`
- `saveUserFact(fact)` — saves to `chrome.storage.local` under `userProfile.facts[]`, max 50

Verify the import exists:
```javascript
import { classifyIntent, executeIntent } from './lib/intent-classifier.js';
```

Verify that after successful intent execution, if `intent.learn` exists, it calls `saveUserFact(intent.learn)`.

Verify the Tier 1.5 block passes a `context` object (not a string) to `classifyIntent`:
```javascript
const context = await gatherContext();
const intent = await classifyIntent(callApiFn, userText, context, conversationHistory);
```

### 4. `manifest.json` — VERIFY

Must include `"history"` in permissions:
```json
"permissions": ["sidePanel", "storage", "scripting", "tabs", "activeTab", "history"],
```

### 5. `content/main.js` — VERIFY

Must have a `PRESS_KEY` action handler in the message listener. If missing, add it.

### 6. Files to NOT touch
- `lib/router.js` — keep as-is
- `lib/groq.js`, `lib/cerebras.js`, `lib/together.js`, `lib/gemini.js` — keep as-is
- `lib/tools.js` — keep as-is (Ollama fallback still uses tools)
- `lib/ollama.js` — keep as-is
- `lib/budget.js`, `lib/rag.js`, `lib/history-store.js` — keep as-is
- `content/interaction.js`, `content/extractor.js`, `content/snapshot.js` — keep as-is
- `sidebar.js`, `sidebar.html`, `sidebar.css` — keep as-is

---

## WHY THIS ARCHITECTURE WORKS

**Before (broken):**
- "search trump" → Tier 1 regex catches it → always Google → WRONG (user was on YouTube)
- "skip the ad" → Tier 3 agent loop → 3-5 API calls → rate limit crash
- "sign in" → Tier 3 → schema validation crash → 400 error
- "enter password" → Tier 3 → `expected string, but got number` crash
- "hi" → Tier 3 → wasted API call on a greeting

**After (fixed):**
- "search trump" (on YouTube) → Tier 1 doesn't match → Tier 1.5 sees YouTube context → searches YouTube
- "skip the ad" → Tier 1.5 → 1 API call → clicks Skip Ad button locally
- "sign in" → Tier 1.5 → 1 API call → clicks sign in button
- "enter password" → Tier 1.5 → 1 API call → types into focused input
- "hi" → Tier 1.5 → 1 API call → returns chat response

**Every message = max 1 API call. No loops. No tool schemas. No crashes.**

---

## TESTING CHECKLIST

After implementation, test ALL of these:

| Input | Expected | Badge |
|-------|----------|-------|
| `open youtube` | Opens youtube.com | ⚡ |
| `scroll down` | Scrolls page down | ⚡ |
| `go back` | Navigates back | ⚡ |
| `back` | Navigates back | ⚡ |
| `close tab` | Closes active tab | ⚡ |
| `hi` | Friendly greeting | 🧠 |
| `search trump` (on YouTube) | Searches YouTube NOT Google | 🧠 |
| `search trump` (on Google) | Searches Google | 🧠 |
| `click first video` | Clicks first video | 🧠 |
| `skip the ad` | Clicks Skip Ad button | 🧠 |
| `keep scrolling` | Scrolls down | 🧠 |
| `sign in` | Clicks sign in button | 🧠 |
| `enter user@gmail.com` | Types into focused input | 🧠 |
| `like` | Clicks like button | 🧠 |
| `subscribe` | Clicks subscribe button | 🧠 |
| `close all tabs except this` | Closes other tabs | 🧠 |
| `who are you` | Self-introduction | 🧠 |
| `cool` | Brief friendly reply | 🧠 |
| `find me cool music` | Searches YouTube | 🧠 |
| `open one` (on search results) | Clicks first result | 🧠 |
