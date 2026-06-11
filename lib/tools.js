/**
 * lib/tools.js — Tool Declarations & Executor
 * Contains all 11 tool schemas (TOOL_DECLARATIONS) and their
 * corresponding executor functions. Imported by background.js.
 */

// ─── Helpers passed in from background.js ────────────────────────────
// These are injected via initTools() to avoid circular imports.
let _getCachedPage = null;
let _setCachedPage = null;
let _extractRelevantChunks = null;
let _rag = null; // LocalRAG instance (Phase 1: TF-IDF search engine)
let _historyStore = null; // VectorHistoryStore instance

/**
 * Call once at startup to wire in background.js's cache/chunk helpers.
 * @param {Object} deps
 * @param {Function} deps.getCachedPage
 * @param {Function} deps.setCachedPage
 * @param {Function} deps.extractRelevantChunks
 * @param {Object}  [deps.rag] - LocalRAG instance for semantic search
 */
export function initTools(deps) {
  _getCachedPage = deps.getCachedPage;
  _setCachedPage = deps.setCachedPage;
  _extractRelevantChunks = deps.extractRelevantChunks;
  _rag = deps.rag || null;
  _historyStore = deps.historyStore || null;
}

// ─── Fix 1: Tool Groups for Lazy Loading ────────────────────────────
/**
 * Tools categorized by intent — only the relevant groups are sent per request.
 */
export const TOOL_GROUPS = {
  browse:   ['ask_website', 'highlight_element'],
  interact: ['get_page_elements', 'click_element', 'type_into_element', 'select_option'],
  navigate: ['get_open_tabs', 'open_url', 'scroll_page', 'find_history'],
  observe:  ['get_page_snapshot', 'play_video']
};

/**
 * Analyze user text and return only the tool declarations relevant to
 * the detected intent. Returns [] for pure chat (no tools needed).
 */
export function getToolsByIntent(userText) {
  const text = userText.toLowerCase();
  const needed = new Set();

  // Browse intent: reading, summarizing, questioning page content
  if (/\b(what|tell|explain|summarize|about|read|content|article|text|meaning|say)\b/.test(text)) {
    needed.add('browse');
  }
  // Interact intent: clicking, typing, filling forms
  if (/\b(click|press|tap|type|fill|enter|write|submit|login|sign|check|select|choose|pick)\b/.test(text)) {
    needed.add('interact');
  }
  // Navigate intent: opening URLs, switching tabs, scrolling
  if (/\b(open|go|navigate|url|tab|tabs|scroll|top|bottom|up|down|visit|search)\b/.test(text)) {
    needed.add('navigate');
  }
  // Observe intent: looking at page state, playing video
  if (/\b(show|see|look|page|elements|video|play|watch|find|list)\b/.test(text)) {
    needed.add('observe');
  }

  // Nothing matched — pure chat, no tools needed
  if (needed.size === 0) return [];

  // Build the filtered declaration list
  const toolNames = new Set();
  for (const group of needed) {
    TOOL_GROUPS[group].forEach(name => toolNames.add(name));
  }
  return TOOL_DECLARATIONS.filter(t => toolNames.has(t.name));
}

// ─── Tool Declarations ───────────────────────────────────────────────
export const TOOL_DECLARATIONS = [
  {
    name: 'get_open_tabs',
    description: 'Get a list of all currently open browser tabs with their IDs, titles, URLs, and active status.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: []
    }
  },
  {
    name: 'open_url',
    description: 'Open a URL in a new browser tab.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: {
          type: 'STRING',
          description: 'The URL to open in a new tab.'
        },
        active: {
          type: 'BOOLEAN',
          description: 'Whether to make the new tab active. Defaults to true.'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'ask_website',
    // Fix 3: Two-tier content — brief (default, ~200 tokens) or full (~3750 tokens)
    description: 'Extract and analyze the content of the currently active webpage. Use detail_level "brief" (default) for a quick overview to answer most questions. Only use "full" if the brief was clearly insufficient.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'The question or query about the webpage content.'
        },
        detail_level: {
          type: 'STRING',
          description: 'Level of detail: "brief" (default, ~200 tokens, heading list + intro) or "full" (~3000 tokens, complete content). Always try "brief" first.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'highlight_element',
    description: 'Highlight and scroll to a specific section on the current webpage. Use section IDs obtained from ask_website results.',
    parameters: {
      type: 'OBJECT',
      properties: {
        section_id: {
          type: 'STRING',
          description: 'The section ID to highlight (e.g., "section-0", "section-1").'
        }
      },
      required: ['section_id']
    }
  },
  // ─── Interaction Tools ─────────────────────────────────────────────
  {
    name: 'get_page_elements',
    description: 'Get all interactive elements (links, buttons, inputs, videos) on the current page. Returns a numbered list of elements the user can interact with. Always call this before clicking or interacting with page elements.',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: []
    }
  },
  {
    name: 'click_element',
    description: 'Click on an interactive element by its index number. Use get_page_elements first to see available elements and their indices.',
    parameters: {
      type: 'OBJECT',
      properties: {
        index: {
          type: 'INTEGER',
          description: 'The index number of the element to click (from get_page_elements results).'
        }
      },
      required: ['index']
    }
  },
  {
    name: 'type_into_element',
    description: 'Type text into an input field or textarea by its index number. Use get_page_elements first to find input fields.',
    parameters: {
      type: 'OBJECT',
      properties: {
        index: {
          type: 'INTEGER',
          description: 'The index number of the input element to type into.'
        },
        text: {
          type: 'STRING',
          description: 'The text to type into the element.'
        },
        clear: {
          type: 'BOOLEAN',
          description: 'Whether to clear existing text before typing. Defaults to true.'
        }
      },
      required: ['index', 'text']
    }
  },
  {
    name: 'select_option',
    description: 'Select an option from a dropdown (<select>) menu by element index. The value can be the option value or visible text.',
    parameters: {
      type: 'OBJECT',
      properties: {
        index: {
          type: 'INTEGER',
          description: 'The index number of the select dropdown element.'
        },
        value: {
          type: 'STRING',
          description: 'The option value or visible text to select.'
        }
      },
      required: ['index', 'value']
    }
  },
  {
    name: 'scroll_page',
    description: 'Scroll the page in a direction to reveal more content or navigate. Use "top" or "bottom" to jump to page extremes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        direction: {
          type: 'STRING',
          description: 'Direction to scroll: "up", "down", "left", "right", "top", or "bottom".'
        },
        amount: {
          type: 'INTEGER',
          description: 'Number of pixels to scroll. Defaults to 500. Ignored for "top" and "bottom".'
        }
      },
      required: ['direction']
    }
  },
  {
    name: 'play_video',
    description: 'Play a video element on the page by its index number. Works with HTML5 <video> elements and attempts to play YouTube/Vimeo iframes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        index: {
          type: 'INTEGER',
          description: 'The index number of the video element to play.'
        }
      },
      required: ['index']
    }
  },
  {
    name: 'get_page_snapshot',
    description: 'Get a structured overview of the current page including title, URL, meta description, content summary, and counts of interactive elements. Does NOT return the elements themselves (use get_page_elements for that).',
    parameters: {
      type: 'OBJECT',
      properties: {},
      required: []
    }
  },
  {
    name: 'find_history',
    description: 'Search your browsing history using natural language. Returns pages you visited that match your query. Useful for finding pages you saw earlier.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Natural language search query (e.g. "that page about machine learning")'
        },
        limit: {
          type: 'INTEGER',
          description: 'Max number of results to return (default: 5)'
        }
      },
      required: ['query']
    }
  }
];

// ─── Helper: Get active tab and ensure content scripts are injected ──
async function getActiveTabAndInject() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    throw new Error('No active tab found.');
  }
  // Try to inject content scripts if not already present
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: [
        'content/extractor.js',
        'content/interaction.js',
        'content/snapshot.js',
        'content/main.js'
      ]
    });
  } catch (e) {
    // Content scripts might already be injected — continue
  }
  return activeTab;
}

// ─── Tool Executor Dispatcher ────────────────────────────────────────
export async function executeTool(name, args) {
  // Lenient Type Casting to avoid API crashes
  if (args) {
    if (args.index !== undefined) args.index = parseInt(args.index, 10);
    if (args.amount !== undefined) args.amount = parseInt(args.amount, 10);
  }

  switch (name) {
    case 'get_open_tabs':       return await toolGetOpenTabs();
    case 'open_url':            return await toolOpenUrl(args);
    case 'ask_website':         return await toolAskWebsite(args);
    case 'highlight_element':   return await toolHighlightElement(args);
    case 'get_page_elements':   return await toolGetPageElements();
    case 'click_element':       return await toolClickElement(args);
    case 'type_into_element':   return await toolTypeIntoElement(args);
    case 'select_option':       return await toolSelectOption(args);
    case 'scroll_page':         return await toolScrollPage(args);
    case 'play_video':          return await toolPlayVideo(args);
    case 'get_page_snapshot':   return await toolGetPageSnapshot();
    case 'find_history':        return await toolFindHistory(args);
    default:                    return { error: `Unknown tool: ${name}` };
  }
}

// ─── Individual Tool Executors ────────────────────────────────────────

async function toolGetOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const tabData = tabs.map(t => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active
    }));
    return { tabs: tabData };
  } catch (err) {
    return { error: `Failed to get tabs: ${err.message}` };
  }
}

async function toolOpenUrl(args) {
  try {
    const url = args.url;
    const active = args.active !== undefined ? args.active : true;
    const tab = await chrome.tabs.create({ url, active });
    return { success: true, tabId: tab.id, url };
  } catch (err) {
    return { error: `Failed to open URL: ${err.message}` };
  }
}

async function toolAskWebsite(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const isFull = args.detail_level === 'full';

    // ── Step 1: Get page content (cache or fresh extraction) ──────────
    let sections, fullContent;
    const cached = _getCachedPage(activeTab.id, activeTab.url);

    if (cached) {
      sections = cached.sections || [];
      fullContent = cached.content;
    } else {
      const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'EXTRACT_PAGE' });
      if (!response || !response.success) {
        return { error: 'Failed to extract page content. The page may not be accessible.' };
      }
      sections = response.sections || [];
      if (sections.length === 0) {
        return { error: 'No content found on this page.' };
      }

      // Build full content string (stored in cache)
      fullContent = '';
      for (const section of sections) {
        const sectionText = `## ${section.heading} [${section.id}]\n${section.content}\n\n`;
        if (fullContent.length + sectionText.length > 15000) {
          fullContent += '\n[Content truncated]';
          break;
        }
        fullContent += sectionText;
      }

      _setCachedPage(activeTab.id, activeTab.url, {
        pageTitle: activeTab.title,
        url: activeTab.url,
        content: fullContent,
        sections,
        sectionsCount: sections.length
      });
    }

    // ── Step 2: Index page for RAG (lazy — only when first accessed) ──
    if (_rag && !_rag.isIndexed(activeTab.url)) {
      _rag.indexPage(activeTab.url, fullContent);
    }

    // ── Step 3: Build response content ───────────────────────────────
    let pageContent;
    let detailLevel;

    if (isFull) {
      // Full mode: keyword-based chunk retrieval (broad coverage)
      pageContent = args.query ? _extractRelevantChunks(fullContent, args.query, 5) : fullContent;
      detailLevel = 'full';
    } else if (_rag && args.query && _rag.isIndexed(activeTab.url)) {
      // RAG mode: semantically relevant chunks only (~300 tokens vs ~3750)
      const ragResults = _rag.search(activeTab.url, args.query, 3);
      if (ragResults.length > 0) {
        pageContent = ragResults.map(r => r.text).join('\n\n---\n\n');
        detailLevel = 'rag';
      } else {
        // No good RAG matches — fall back to heading brief
        pageContent = _buildBriefContent(sections, fullContent);
        detailLevel = 'brief';
      }
    } else {
      // No RAG / no query — heading list + intro
      pageContent = _buildBriefContent(sections, fullContent);
      detailLevel = 'brief';
    }

    return {
      pageTitle: activeTab.title,
      url: activeTab.url,
      content: pageContent,
      sectionsCount: sections.length,
      detail_level: detailLevel,
      note: detailLevel !== 'full' ? 'Call again with detail_level "full" if you need more content.' : undefined
    };
  } catch (err) {
    return { error: `Failed to analyze website: ${err.message}` };
  }
}

/**
 * Build a compact page brief: heading list + first section intro (~800 chars).
 * Fallback when RAG is unavailable or returns no results.
 */
function _buildBriefContent(sections, fullContent) {
  if (!sections || sections.length === 0) {
    return (fullContent || '').substring(0, 800);
  }
  const headingList = sections.map(s => `• ${s.heading} [${s.id}]`).join('\n');
  const firstContent = (sections[0]?.content || '').substring(0, 500);
  return `Headings:\n${headingList}\n\nIntro:\n${firstContent}`;
}

async function toolHighlightElement(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'HIGHLIGHT',
      sectionId: args.section_id
    });

    if (response && response.success) {
      return { success: true, message: `Highlighted section "${args.section_id}" on the page.` };
    } else {
      return { error: response?.error || 'Failed to highlight section.' };
    }
  } catch (err) {
    return { error: `Failed to highlight: ${err.message}` };
  }
}

async function toolGetPageElements() {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_INTERACTIVE_ELEMENTS' });

    if (!response || !response.success) {
      return { error: 'Failed to scan page elements. The page may not be accessible.' };
    }

    return {
      pageTitle: activeTab.title,
      pageUrl: activeTab.url,
      elementCount: response.elements.length,
      elements: response.elements
    };
  } catch (err) {
    return { error: `Failed to get page elements: ${err.message}` };
  }
}

async function toolClickElement(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'CLICK_ELEMENT',
      index: args.index
    });

    if (!response) {
      return { error: 'No response from content script.' };
    }

    // Handle target="_blank" links — open via background
    if (response.success && response.action === 'open_in_new_tab' && response.url) {
      try {
        const newTab = await chrome.tabs.create({ url: response.url, active: true });
        return {
          success: true,
          description: response.description,
          action: 'opened_new_tab',
          tabId: newTab.id,
          url: response.url
        };
      } catch (e) {
        return { error: `Clicked element but failed to open new tab: ${e.message}` };
      }
    }

    return response;
  } catch (err) {
    return { error: `Failed to click element: ${err.message}` };
  }
}

async function toolTypeIntoElement(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'TYPE_TEXT',
      index: args.index,
      text: args.text,
      clear: args.clear !== undefined ? args.clear : true
    });
    return response || { error: 'No response from content script.' };
  } catch (err) {
    return { error: `Failed to type text: ${err.message}` };
  }
}

async function toolSelectOption(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'SELECT_OPTION',
      index: args.index,
      value: args.value
    });
    return response || { error: 'No response from content script.' };
  } catch (err) {
    return { error: `Failed to select option: ${err.message}` };
  }
}

async function toolScrollPage(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'SCROLL_PAGE',
      direction: args.direction,
      amount: args.amount
    });
    return response || { error: 'No response from content script.' };
  } catch (err) {
    return { error: `Failed to scroll page: ${err.message}` };
  }
}

async function toolPlayVideo(args) {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      action: 'PLAY_VIDEO',
      index: args.index
    });

    if (!response) {
      return { error: 'No response from content script.' };
    }

    // Handle case where play_video returns a link to open
    if (response.success && response.action === 'open_in_new_tab' && response.url) {
      try {
        const newTab = await chrome.tabs.create({ url: response.url, active: true });
        return {
          success: true,
          description: response.description,
          action: 'opened_new_tab',
          tabId: newTab.id,
          url: response.url
        };
      } catch (e) {
        return { error: `Failed to open video in new tab: ${e.message}` };
      }
    }

    return response;
  } catch (err) {
    return { error: `Failed to play video: ${err.message}` };
  }
}

async function toolGetPageSnapshot() {
  try {
    const activeTab = await getActiveTabAndInject();
    const response = await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_PAGE_SNAPSHOT' });

    if (!response || !response.success) {
      return { error: 'Failed to get page snapshot. The page may not be accessible.' };
    }

    return response.snapshot;
  } catch (err) {
    return { error: `Failed to get page snapshot: ${err.message}` };
  }
}

async function toolFindHistory(args) {
  try {
    if (!_historyStore) {
      return { error: 'History store not available.' };
    }
    const results = await _historyStore.search(args.query, {
      limit: args.limit || 5,
      from: args.from,
      to: args.to
    });
    if (results.length === 0) {
      return { message: 'No matching pages found in browsing history.', results: [] };
    }
    return {
      message: `Found ${results.length} matching page(s) in history.`,
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        visited: r.timestamp,
        relevance: Math.round(r.score * 100) + '%'
      }))
    };
  } catch (err) {
    return { error: `Failed to search history: ${err.message}` };
  }
}
