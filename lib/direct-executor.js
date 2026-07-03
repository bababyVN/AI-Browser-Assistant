/**
 * lib/direct-executor.js — Tier 0.5 (Zero-API Regex Executor)
 * Handles basic browser navigation and tab control commands WITHOUT any API call.
 * Pure DOM interactions (Like, Dislike, Subscribe) are delegated entirely to the AI Tool Pipeline.
 */
'use strict';

// ─── Ordinal word → number ────────────────────────────────────────────
const ORDINALS = {
  'first': 1, '1st': 1, 'one': 1, '1': 1,
  'second': 2, '2nd': 2, 'two': 2, '2': 2,
  'third': 3, '3rd': 3, 'three': 3, '3': 3,
  'fourth': 4, '4th': 4, 'four': 4, '4': 4,
  'fifth': 5, '5th': 5, 'five': 5, '5': 5,
  'sixth': 6, '6th': 6, 'six': 6, '6': 6,
  'seventh': 7, '7th': 7, 'seven': 7, '7': 7,
  'eighth': 8, '8th': 8, 'eight': 8, '8': 8,
  'ninth': 9, '9th': 9, 'nine': 9, '9': 9,
  'tenth': 10, '10th': 10, 'ten': 10, '10': 10,
  // Vietnamese ordinals
  'đầu tiên': 1, 'đầu': 1, 'nhất': 1, 'thứ nhất': 1, 'một': 1,
  'hai': 2, 'thứ hai': 2,
  'ba': 3, 'thứ ba': 3,
  'tư': 4, 'thứ tư': 4, 'bốn': 4,
  'năm': 5, 'thứ năm': 5,
  'sáu': 6, 'thứ sáu': 6,
  'bảy': 7, 'thứ bảy': 7,
  'tám': 8, 'thứ tám': 8,
  'chín': 9, 'thứ chín': 9,
  'mười': 10, 'thứ mười': 10
};

function parseOrdinal(str) {
  if (!str) return null;
  const norm = str.trim().toLowerCase();
  if (ORDINALS[norm] !== undefined) return ORDINALS[norm];
  const n = parseInt(norm, 10);
  return isNaN(n) ? null : n;
}

// ─── Inject content scripts helper ───────────────────────────────────
async function injectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/extractor.js', 'content/interaction.js', 'content/snapshot.js', 'content/main.js']
    });
  } catch { /* already injected */ }
}

// ─── Navigate to video by index on current page ───────────────────────
async function openVideoOnPage(tab, videoIndex) {
  await injectContentScripts(tab.id);
  return await chrome.tabs.sendMessage(tab.id, {
    action: 'PLAY_VIDEO',
    index: videoIndex - 1
  });
}

// ─── Wait for tab to load ─────────────────────────────────────────────
function waitForTabLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    function listener(changedTabId, info) {
      if (changedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Known single-word site aliases ──────────────────────────────────
const SITE_ALIASES = {
  'yt': 'youtube.com', 'youtube': 'youtube.com',
  'ig': 'instagram.com', 'insta': 'instagram.com', 'instagram': 'instagram.com',
  'fb': 'facebook.com', 'facebook': 'facebook.com',
  'tw': 'twitter.com', 'twitter': 'twitter.com', 'x': 'x.com',
  'reddit': 'reddit.com', 'gh': 'github.com', 'github': 'github.com',
  'gm': 'mail.google.com', 'gmail': 'mail.google.com',
  'gd': 'drive.google.com', 'gdrive': 'drive.google.com',
  'maps': 'maps.google.com', 'google': 'google.com',
  'amazon': 'amazon.com', 'netflix': 'netflix.com',
  'tiktok': 'tiktok.com', 'tt': 'tiktok.com',
  'linkedin': 'linkedin.com', 'li': 'linkedin.com',
  'twitch': 'twitch.tv', 'spotify': 'open.spotify.com',
  'wp': 'wordpress.com', 'medium': 'medium.com',
  'new tab': '__NEW_TAB__'
};

const SITE_SEARCH_URLS = {
  'youtube': (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  'yt':      (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  'google':  (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  'reddit':  (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}`,
  'github':  (q) => `https://github.com/search?q=${encodeURIComponent(q)}`,
  'amazon':  (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
};

const RESOLVED_SITES = {
  'youtube': 'youtube', 'youtbe': 'youtube', 'youtub': 'youtube', 'ytb': 'youtube', 'yt': 'youtube',
  'google': 'google', 'googl': 'google', 'gogle': 'google',
  'facebook': 'facebook', 'fb': 'facebook',
  'github': 'github', 'githb': 'github',
  'reddit': 'reddit',
  'amazon': 'amazon'
};

const directPatterns = [
  // ══ GREETINGS: hi, hello, xin chào, etc.
  {
    pattern: /^(?:hi+|hello+|hey+|xin\s*chào|chào|chào\s*bạn|ollam|ollâ|olam)(?:\s+.*)?$/i,
    execute: async () => {
      return "Hello! I am your AI Browser Assistant. 🤖\nHow can I help you control your browser or analyze pages today?";
    }
  },

  // ══ VIETNAMESE COMPOUND: tìm [query] trên [site]
  {
    pattern: /^(?:tìm\s+kiếm\s+|tìm\s+)(.+?)\s+(?:trên|ở)\s+(youtube|youtbe|youtub|ytb|yt|google|googl|gogle|facebook|fb|github|githb|reddit|amazon)(?:\s+cho\s+tôi)?$/i,
    execute: async (match) => {
      const query = match[1].trim();
      const rawSite = match[2].trim().toLowerCase();
      const site = RESOLVED_SITES[rawSite] || 'google';

      const searchUrl = SITE_SEARCH_URLS[site]
        ? SITE_SEARCH_URLS[site](query)
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url: searchUrl });
      } else {
        await chrome.tabs.create({ url: searchUrl });
      }
      return `Searching ${site} for "${query}"`;
    }
  },

  // ══ VIETNAMESE OPEN: mở [site] / vào [site]
  {
    pattern: /^(?:mở|vào)\s+(.+?)(?:\s+cho\s+tôi)?$/i,
    execute: async (match) => {
      let url = match[1].trim();

      if (/^(cái|trang|kết|video|clip|link)\b/i.test(url)) return false;

      const rawKey = url.toLowerCase();
      const key = RESOLVED_SITES[rawKey] || rawKey;
      const aliasUrl = SITE_ALIASES[key];

      if (aliasUrl) {
        url = `https://${aliasUrl}`;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await chrome.tabs.update(activeTab.id, { url });
        } else {
          await chrome.tabs.create({ url });
        }
        return `Opened ${url}`;
      }

      const hasSpaces = url.includes(' ');
      const looksLikeUrl = url.includes('.') || /^https?:\/\//i.test(url);
      if (hasSpaces && !looksLikeUrl) return false;

      if (!/^https?:\/\//i.test(url)) {
        url = url.includes('.') ? `https://${url}` : `https://${url}.com`;
      }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url });
      } else {
        await chrome.tabs.create({ url });
      }
      return `Opened ${url}`;
    }
  },

  // ══ VIETNAMESE SIMPLE: mở video số N
  {
    pattern: /^(?:mở|play|chạy|phát)\s+(?:video|vid|clip|kết\s*quả|vido|vidio|vide)\s*(?:số\s+|thứ\s+)?(\w+|\d+)(?:\s+cho\s+tôi)?$/i,
    execute: async (match) => {
      const ordinalStr = match[1];
      const videoNum = parseOrdinal(ordinalStr);
      if (!videoNum) return false;

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';

      const res = await openVideoOnPage(activeTab, videoNum);
      if (res && res.success) {
        return `Opening video #${videoNum} 🎬`;
      }
      return `Couldn't find video #${videoNum} on this page. Make sure you're on a search results page.`;
    }
  },

  // ══ RESEARCH / FIND OUT ABOUT: tìm hiểu về / tra cứu / research / find out about
  {
    pattern: /^(?:tìm\s+hiểu\s+về|tra\s+cứu\s+thông\s+tin\s+về|tra\s+cứu|tìm\s+kiếm\s+về|research|find\s+out\s+about)\s+(.+?)(?:\s+cho\s+tôi)?$/i,
    execute: async (match) => {
      const query = match[1].trim();
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url: searchUrl });
      } else {
        await chrome.tabs.create({ url: searchUrl });
      }
      return `Searching Google for "${query}"`;
    }
  },

  // ══ SINGLE SITE: youtube, google, facebook (without "open")
  {
    pattern: /^(youtube|youtbe|youtub|ytb|yt|google|googl|gogle|facebook|fb|github|githb|gmail|amazon|reddit|x|tiktok)$/i,
    execute: async (match) => {
      const key = match[1].toLowerCase();
      const resolvedKey = RESOLVED_SITES[key] || key;
      const aliasUrl = SITE_ALIASES[resolvedKey];
      if (aliasUrl) {
        const url = `https://${aliasUrl}`;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await chrome.tabs.update(activeTab.id, { url });
        } else {
          await chrome.tabs.create({ url });
        }
        return `Opened ${url}`;
      }
      return false;
    }
  },

  // ══ HELP: help, what can you do, hướng dẫn, etc.
  {
    pattern: /^(?:help|hướng\s*dẫn|what\s+can\s+you\s+do|bạn\s+làm\s+được\s+gì)(?:\s+.*)?$/i,
    execute: async () => {
      return `Here are some things I can do for you:
• **Navigate**: "open youtube", "go to google.com"
• **Search & Play**: "open youtube and search for mr beast open 1st vid"
• **Scroll**: "scroll down", "scroll to top"
• **Tabs**: "close tab", "list tabs", "switch to tab 2"
• **Page Actions**: "summarize the page", "translate to Vietnamese" (requires a valid Gemini API Key in Settings ⚙️)`;
    }
  },

  // ══ COMPOUND: "open [site] and search for [query] [and open Nth vid]"
  {
    pattern: /^(?:open|go\s+to)\s+(youtube|yt|google|reddit|amazon|github)\s*(?:and|then|to|,|;)?\s*(?:search(?:\s+for)?\s+)(.+?)(?:\s*(?:and|then|to|,|;)?\s*(?:open|play)\s+(?:the\s+)?(\w+)\s+(?:vid(?:eo)?|result)(?:\s+for\s+me)?)?$/i,
    execute: async (match) => {
      const site = match[1].trim().toLowerCase();
      const query = match[2].trim();
      const ordinalStr = match[3];

      const searchUrl = SITE_SEARCH_URLS[site]
        ? SITE_SEARCH_URLS[site](query)
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let tab;
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url: searchUrl });
        tab = activeTab;
      } else {
        tab = await chrome.tabs.create({ url: searchUrl });
      }

      const videoNum = ordinalStr ? parseOrdinal(ordinalStr) : null;
      if (!videoNum) {
        return `Searched ${site} for "${query}"`;
      }

      await waitForTabLoad(tab.id, 8000);
      await new Promise(r => setTimeout(r, 1500));

      const res = await openVideoOnPage(tab, videoNum);
      if (res && res.success) {
        return `Searched for "${query}" on ${site} and opened video #${videoNum} 🎬`;
      }
      return `Searched for "${query}" on ${site}. Tap on a video to play it (page may still be loading).`;
    }
  },

  // ══ COMPOUND: "[search for] [query] on youtube [and open Nth vid]"
  {
    pattern: /^(?:find|search(?:\s+for)?)\s+(.+?)\s+on\s+(youtube|yt|google|reddit)(?:\s*(?:and|then|to|,|;)?\s*(?:open|play)\s+(?:the\s+)?(\w+)\s+(?:vid(?:eo)?|result))?(?:\s+for\s+me)?$/i,
    execute: async (match) => {
      const query = match[1].trim();
      const site = match[2].trim().toLowerCase();
      const ordinalStr = match[3];

      const searchUrl = SITE_SEARCH_URLS[site]
        ? SITE_SEARCH_URLS[site](query)
        : `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let tab;
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url: searchUrl });
        tab = activeTab;
      } else {
        tab = await chrome.tabs.create({ url: searchUrl });
      }

      const videoNum = ordinalStr ? parseOrdinal(ordinalStr) : null;
      if (!videoNum) {
        return `Searching ${site} for "${query}"`;
      }

      await waitForTabLoad(tab.id, 8000);
      await new Promise(r => setTimeout(r, 1500));

      const res = await openVideoOnPage(tab, videoNum);
      if (res && res.success) {
        return `Searched for "${query}" on ${site} and opened video #${videoNum} 🎬`;
      }
      return `Searched for "${query}" on ${site}. Tap a video to play it.`;
    }
  },

  // ══ SIMPLE: open [Nth] video/vid/result
  {
    pattern: /^(?:open|play)\s+(?:the\s+)?(\w+)\s+(?:vid(?:eo)?|result)(?:\s+(?:for\s+me|please))?$/i,
    execute: async (match) => {
      const ordinalStr = match[1];
      const videoNum = parseOrdinal(ordinalStr);
      if (!videoNum) return false;

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';

      const res = await openVideoOnPage(activeTab, videoNum);
      if (res && res.success) {
        return `Opening video #${videoNum} 🎬`;
      }
      return `Couldn't find video #${videoNum} on this page. Make sure you're on a search results page.`;
    }
  },

  // ══ SIMPLE: open [URL] / go to [URL]
  {
    pattern: /^(?:open|go\s*to)\s+(.+)$/i,
    execute: async (match) => {
      let url = match[1].trim();

      if (/^(the|a|an|that|this|one|it)\b/i.test(url)) return false;

      const key = url.toLowerCase();
      const resolvedKey = RESOLVED_SITES[key] || key;
      const aliasUrl = SITE_ALIASES[resolvedKey];

      if (aliasUrl === '__NEW_TAB__') {
        await chrome.tabs.create({});
        return 'Opened new tab';
      }

      if (aliasUrl) {
        url = `https://${aliasUrl}`;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await chrome.tabs.update(activeTab.id, { url });
        } else {
          await chrome.tabs.create({ url });
        }
        return `Opened ${url}`;
      }

      const hasSpaces = url.includes(' ');
      const looksLikeUrl = url.includes('.') || /^https?:\/\//i.test(url);
      if (hasSpaces && !looksLikeUrl) {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab) {
          await chrome.tabs.update(activeTab.id, { url: searchUrl });
        } else {
          await chrome.tabs.create({ url: searchUrl });
        }
        return `Searching Google for "${url}"`;
      }

      if (!/^https?:\/\//i.test(url)) {
        url = url.includes('.') ? `https://${url}` : `https://${url}.com`;
      }
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url });
      } else {
        await chrome.tabs.create({ url });
      }
      return `Opened ${url}`;
    }
  },

  // ══ search for [query] / google [query] / search on [site]
  {
    pattern: /^(?:search\s+|find\s+|google\s+|youtube\s+|yt\s+)(.+)$/i,
    execute: async (match, rawText) => {
      const rest = match[1].trim();
      if (!rest) return false;

      let isYouTube = /^(?:youtube\s+|yt\s+)/i.test(rawText);
      let query = rest;
      let targetSite = isYouTube ? 'youtube' : 'google';

      const onSitePrefix = /^on\s+(youtube|yt|google|reddit|amazon|github)\s+(?:for\s+)?/i;
      const onSitePrefixMatch = onSitePrefix.exec(rest);
      if (onSitePrefixMatch) {
        const site = onSitePrefixMatch[1].toLowerCase();
        targetSite = (site === 'yt' || site === 'youtube') ? 'youtube' : site;
        query = rest.replace(onSitePrefix, '').trim();
      }

      const onSiteSuffix = /\s+on\s+(youtube|yt|google|reddit|amazon|github)$/i;
      const onSiteSuffixMatch = onSiteSuffix.exec(rest);
      if (onSiteSuffixMatch) {
        const site = onSiteSuffixMatch[1].toLowerCase();
        targetSite = (site === 'yt' || site === 'youtube') ? 'youtube' : site;
        query = rest.replace(onSiteSuffix, '').trim();
      }

      const siteForPrefix = /^(youtube|yt|google|reddit|amazon|github)\s+for\s+/i;
      const siteForPrefixMatch = siteForPrefix.exec(rawText.trim());
      if (siteForPrefixMatch) {
        const site = siteForPrefixMatch[1].toLowerCase();
        targetSite = (site === 'yt' || site === 'youtube') ? 'youtube' : site;
        query = rawText.trim().replace(siteForPrefix, '').trim();
      }

      const cleanPrefix = /^(?:for\s+|search\s+(?:for\s+)?|find\s+(?:for\s+)?)/i;
      if (cleanPrefix.test(query)) {
        query = query.replace(cleanPrefix, '').trim();
      }

      if (!query) return false;

      const url = SITE_SEARCH_URLS[targetSite]
        ? SITE_SEARCH_URLS[targetSite](query)
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url });
      } else {
        await chrome.tabs.create({ url });
      }

      const siteLabel = targetSite.charAt(0).toUpperCase() + targetSite.slice(1);
      return `Searching ${siteLabel} for "${query}"`;
    }
  },

  // ══ scroll up/down/top/bottom
  {
    pattern: /^scroll\s+(up|down|top|bottom)(?:\s+(\d+))?$/i,
    execute: async (match) => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      await injectContentScripts(activeTab.id);
      const direction = match[1].toLowerCase();
      const amount = match[2] ? parseInt(match[2], 10) : 500;
      await chrome.tabs.sendMessage(activeTab.id, { action: 'SCROLL_PAGE', direction, amount });
      return `Scrolled ${direction}`;
    }
  },

  // ══ close tab
  {
    pattern: /^close\s+(?:this\s+)?tab$/i,
    execute: async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      await chrome.tabs.remove(activeTab.id);
      return 'Closed tab';
    }
  },

  // ══ go back / go forward
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

  // ══ list tabs / show tabs
  {
    pattern: /^(?:list|show)\s+tabs$/i,
    execute: async () => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const lines = tabs.map((t, i) => `${i + 1}. ${t.title}`);
      return `${tabs.length} tabs open:\n${lines.join('\n')}`;
    }
  },

  // ══ switch to tab N
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
  },

  // ══ next tab / prev tab
  {
    pattern: /^(?:next\s+tab|prev(?:ious)?\s+tab)$/i,
    execute: async (match) => {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const activeIdx = tabs.findIndex(t => t.active);
      if (activeIdx === -1) return 'No active tab found.';
      const isNext = /next/i.test(match[0]);
      const newIdx = isNext
        ? (activeIdx + 1) % tabs.length
        : (activeIdx - 1 + tabs.length) % tabs.length;
      await chrome.tabs.update(tabs[newIdx].id, { active: true });
      return `Switched to: ${tabs[newIdx].title}`;
    }
  },

  // ══ reload page / refresh page
  {
    pattern: /^(?:reload|refresh)\s+(?:page|tab)$/i,
    execute: async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      await chrome.tabs.reload(activeTab.id);
      return 'Page reloaded.';
    }
  },
  
  // ══ enter / press enter
  {
    pattern: /^(?:enter|nhấn\s+enter|bấm\s+enter|gửi|submit)$/i,
    execute: async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab) return 'No active tab found.';
      await injectContentScripts(activeTab.id);
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'PRESS_ENTER' });
    }
  }
];

export async function tryDirectExecution(userText) {
  const text = userText.trim().replace(/[.,?!;\s]+$/, '');
  for (const { pattern, execute } of directPatterns) {
    const match = pattern.exec(text);
    if (match) {
      try {
        const response = await execute(match, text);
        if (response === false) continue;
        return { handled: true, response };
      } catch (e) {
        return { handled: true, response: `Action failed: ${e.message}` };
      }
    }
  }
  return { handled: false };
}