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
      // Common abbreviations
      const aliases = {
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
      const aliasUrl = aliases[url.toLowerCase()];
      if (aliasUrl === '__NEW_TAB__') {
        await chrome.tabs.create({});
        return 'Opened new tab';
      }
      if (aliasUrl) url = aliasUrl;
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
