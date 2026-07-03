/**
 * content/extractor.js — Content Extraction & Highlighting
 * Handles reading page content, mini-readability parsing,
 * section highlighting and clearing.
 * Loaded FIRST in the content_scripts order.
 */
'use strict';

window.__aiAssistant = window.__aiAssistant || {};

const HIGHLIGHT_CLASS = 'ai-assistant-highlight';
const HIGHLIGHT_STYLE_ID = 'ai-assistant-highlight-style';

// Inject highlight styles once
if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
  const style = document.createElement('style');
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background-color: rgba(255, 235, 59, 0.35) !important;
      outline: 2px solid rgba(255, 235, 59, 0.7) !important;
      outline-offset: 2px;
      border-radius: 4px;
      transition: background-color 0.3s ease, outline 0.3s ease;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Upgrade 1: Mini-Readability Parser
 * Finds the main content container, strips junk nodes, returns clean text.
 * Returns null if no suitable container is found.
 */
window.__aiAssistant.extractMainContent = function() {
  const prioritySelectors = [
    'article',
    'main',
    '[role="main"]',
    '.post-content', '.article-body', '.entry-content',
    '#content', '.content'
  ];

  let container = null;

  // Try priority selectors first
  for (const sel of prioritySelectors) {
    const el = document.querySelector(sel);
    if (el && el.innerText.trim().length > 200) {
      container = el;
      break;
    }
  }

  // Fallback: find the div/section with the most <p> tags
  if (!container) {
    let maxP = 0;
    document.querySelectorAll('div, section').forEach(el => {
      const pCount = el.querySelectorAll('p').length;
      if (pCount > maxP && el.innerText.trim().length > 200) {
        maxP = pCount;
        container = el;
      }
    });
  }

  if (!container) return null;

  // Clone and strip junk elements
  const clone = container.cloneNode(true);

  const junkSelectors = [
    'nav', 'header', 'footer', 'aside', 'script', 'style', 'svg',
    'noscript', 'iframe', 'form',
    '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
    '[role="contentinfo"]', '[aria-hidden="true"]'
  ];
  clone.querySelectorAll(junkSelectors.join(',')).forEach(el => el.remove());

  // Remove elements with junk class/ID patterns
  const junkPattern = /\b(nav|menu|sidebar|footer|header|cookie|banner|popup|modal|ads?|advert|social|share|comments?|related|widget)\b/i;
  clone.querySelectorAll('[class], [id]').forEach(el => {
    const classAndId = (el.className || '') + ' ' + (el.id || '');
    if (junkPattern.test(classAndId)) el.remove();
  });

  // Remove hidden elements
  clone.querySelectorAll('[style]').forEach(el => {
    const s = el.getAttribute('style') || '';
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(s)) el.remove();
  });

  const text = clone.innerText?.trim() || '';
  return text.length > 100 ? text : null;
};

/**
 * Extract page content as structured sections based on headings.
 * Walks all h1-h6 headings, collects following paragraphs until next heading.
 * Returns array of {id, heading, content}.
 */
window.__aiAssistant.extractPageContent = function() {
  const sections = [];
  
  let currentSection = {
    id: 'section-0',
    heading: document.title || 'Introduction',
    contentParts: []
  };
  
  sections.push(currentSection);
  let headingIndex = 1;
  
  function walk(node) {
    if (!node) return;
    
    const tagName = node.tagName?.toLowerCase();
    if (['script', 'style', 'nav', 'footer', 'header', 'noscript', 'iframe', 'svg'].includes(tagName)) {
      return;
    }
    
    // Check if it's a heading
    if (/^h[1-6]$/.test(tagName)) {
      const headingText = node.innerText.trim();
      if (headingText) {
        const sectionId = `section-${headingIndex++}`;
        node.setAttribute('data-ai-section-id', sectionId);
        currentSection = {
          id: sectionId,
          heading: headingText,
          contentParts: []
        };
        sections.push(currentSection);
      }
      return;
    }
    
    // If it's a leaf text block, collect it
    if (['p', 'li', 'dd', 'dt', 'pre', 'code'].includes(tagName)) {
      const text = node.innerText.trim();
      if (text && text.length > 5) {
        currentSection.contentParts.push(text);
      }
      return;
    }
    
    // Fallback for divs or sections containing raw text
    if (tagName === 'div' || tagName === 'section' || tagName === 'article') {
      const hasBlockChildren = Array.from(node.children).some(child => 
        ['p', 'div', 'section', 'article', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(child.tagName.toLowerCase())
      );
      if (!hasBlockChildren) {
        const text = node.innerText.trim();
        if (text && text.length > 10) {
          currentSection.contentParts.push(text);
        }
        return;
      }
    }
    
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        walk(child);
      }
    }
  }
  
  if (document.body) {
    walk(document.body);
  }
  
  return sections.map(sec => ({
    id: sec.id,
    heading: sec.heading,
    content: sec.contentParts.join('\n')
  })).filter(sec => sec.content.trim().length > 0 || sec.heading !== 'Introduction');
};

/**
 * Highlight a section by its ID with yellow background and smooth scroll.
 */
window.__aiAssistant.highlightSection = function(sectionId) {
  // Clear previous highlights first
  window.__aiAssistant.clearHighlights();

  const heading = document.querySelector(`[data-ai-section-id="${sectionId}"]`);
  if (!heading) {
    return { success: false, error: `Section "${sectionId}" not found on this page.` };
  }

  // Highlight the heading
  heading.classList.add(HIGHLIGHT_CLASS);

  // Highlight sibling content elements
  let sibling = heading.nextElementSibling;
  while (sibling) {
    const tagName = sibling.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tagName)) break;
    sibling.classList.add(HIGHLIGHT_CLASS);
    sibling = sibling.nextElementSibling;
  }

  // Smooth scroll to the heading
  heading.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return { success: true };
};

/**
 * Remove all highlights from the page.
 */
window.__aiAssistant.clearHighlights = function() {
  const highlighted = document.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
  highlighted.forEach(el => el.classList.remove(HIGHLIGHT_CLASS));
};

// ─── Smart Content Extraction & Caching ─────────────────────────────

// Cache nội dung trang trên client-side để tái sử dụng
let __pageContentCache = null;

/**
 * Trích xuất nội dung chính của trang một cách thông minh.
 * Trả về bản tóm tắt ngắn (≤300 token) + cache chunks cho lazy loading.
 * 
 * @param {number} [sectionIndex] - Nếu có, trả về chi tiết section cụ thể từ cache.
 * @returns {object} {title, url, summary, headings, totalChunks, cachedAt} hoặc {sectionContent}
 */
window.__aiAssistant.extractSmartContent = function(sectionIndex) {
  const currentUrl = location.href;

  // Nếu yêu cầu section cụ thể → trả từ cache
  if (sectionIndex !== undefined && sectionIndex !== null) {
    if (!__pageContentCache || __pageContentCache.url !== currentUrl) {
      // Cache chưa có → build cache trước
      buildContentCache();
    }
    const chunk = __pageContentCache?.chunks?.[sectionIndex];
    if (chunk) {
      return {
        success: true,
        sectionIndex: sectionIndex,
        heading: chunk.heading,
        content: chunk.content,
        totalChunks: __pageContentCache.chunks.length
      };
    }
    return { success: false, error: `Section ${sectionIndex} không tồn tại. Tổng: ${__pageContentCache?.chunks?.length || 0} sections.` };
  }

  // Overview mode: build cache nếu chưa có hoặc URL đã đổi
  if (!__pageContentCache || __pageContentCache.url !== currentUrl) {
    buildContentCache();
  }

  const cache = __pageContentCache;
  
  // Tạo bản tóm tắt ngắn gọn (≤300 token ≈ 1200 ký tự)
  let summary = '';
  
  // Lấy 3 đoạn nội dung đầu tiên (mỗi đoạn ≤400 chars)
  const leadChunks = cache.chunks.slice(0, 3);
  for (const chunk of leadChunks) {
    const preview = chunk.content.substring(0, 400);
    if (chunk.heading && chunk.heading !== document.title) {
      summary += `## ${chunk.heading}\n`;
    }
    summary += preview;
    if (chunk.content.length > 400) summary += '...';
    summary += '\n\n';
  }

  return {
    success: true,
    title: cache.title,
    url: cache.url,
    summary: summary.trim(),
    headings: cache.chunks.map((c, i) => `[${i}] ${c.heading}`),
    totalChunks: cache.chunks.length,
    cachedAt: cache.cachedAt
  };
};

/**
 * Tìm kiếm từ khóa trên trang. Trả về các đoạn chứa kết quả.
 * @param {string} query - Từ khóa cần tìm.
 * @returns {object} {results: [{heading, snippet, sectionIndex}]}
 */
window.__aiAssistant.searchInPage = function(query) {
  if (!query) return { success: false, error: 'Vui lòng cung cấp từ khóa tìm kiếm.' };

  const currentUrl = location.href;
  if (!__pageContentCache || __pageContentCache.url !== currentUrl) {
    buildContentCache();
  }

  const normalizedQuery = query.toLowerCase().trim();
  const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 1);
  const results = [];

  for (let i = 0; i < __pageContentCache.chunks.length; i++) {
    const chunk = __pageContentCache.chunks[i];
    const lowerContent = chunk.content.toLowerCase();
    const lowerHeading = chunk.heading.toLowerCase();

    let score = 0;
    let matchPositions = [];

    for (const word of queryWords) {
      // Tìm trong heading (trọng số cao)
      if (lowerHeading.includes(word)) score += 10;
      
      // Tìm trong content
      let pos = lowerContent.indexOf(word);
      while (pos !== -1) {
        score += 2;
        matchPositions.push(pos);
        pos = lowerContent.indexOf(word, pos + word.length);
      }
    }

    if (score > 0) {
      // Trích xuất snippet xung quanh vị trí match đầu tiên
      let snippet = '';
      if (matchPositions.length > 0) {
        const start = Math.max(0, matchPositions[0] - 60);
        const end = Math.min(chunk.content.length, matchPositions[0] + 200);
        snippet = (start > 0 ? '...' : '') + chunk.content.substring(start, end) + (end < chunk.content.length ? '...' : '');
      } else {
        snippet = chunk.content.substring(0, 200) + (chunk.content.length > 200 ? '...' : '');
      }

      results.push({
        sectionIndex: i,
        heading: chunk.heading,
        snippet: snippet,
        score: score
      });
    }
  }

  // Sắp xếp theo score giảm dần, lấy top 5
  results.sort((a, b) => b.score - a.score);
  const topResults = results.slice(0, 5);

  return {
    success: true,
    query: query,
    resultCount: results.length,
    results: topResults
  };
};

/**
 * Xây dựng cache nội dung trang từ DOM.
 * Sử dụng extractMainContent() (readability) trước, fallback sang extractPageContent() (heading-based).
 */
function buildContentCache() {
  const title = document.title || '';
  const url = location.href;
  const chunks = [];

  // Thử readability-style extraction trước
  const mainContent = window.__aiAssistant.extractMainContent();
  
  if (mainContent && mainContent.length > 200) {
    // Cắt thành chunks theo đoạn văn
    const paragraphs = mainContent.split(/\n{2,}/);
    let currentChunk = { heading: title, content: '' };
    
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed || trimmed.length < 10) continue;
      
      // Nếu đoạn hiện tại đã quá dài, tạo chunk mới
      if (currentChunk.content.length > 800) {
        chunks.push({ ...currentChunk });
        currentChunk = { heading: `(tiếp theo)`, content: '' };
      }
      
      currentChunk.content += (currentChunk.content ? '\n' : '') + trimmed;
    }
    
    if (currentChunk.content.length > 0) {
      chunks.push(currentChunk);
    }
  }

  // Fallback hoặc bổ sung: heading-based sections
  if (chunks.length === 0) {
    const sections = window.__aiAssistant.extractPageContent();
    for (const sec of sections) {
      if (sec.content.trim().length < 10) continue;
      
      // Cắt section dài thành nhiều chunks
      if (sec.content.length > 1000) {
        const subParts = sec.content.split(/\n/);
        let subChunk = { heading: sec.heading, content: '' };
        for (const part of subParts) {
          if (subChunk.content.length > 800) {
            chunks.push({ ...subChunk });
            subChunk = { heading: `${sec.heading} (tiếp)`, content: '' };
          }
          subChunk.content += (subChunk.content ? '\n' : '') + part;
        }
        if (subChunk.content.length > 0) chunks.push(subChunk);
      } else {
        chunks.push({ heading: sec.heading, content: sec.content });
      }
    }
  }

  __pageContentCache = {
    title,
    url,
    chunks,
    cachedAt: Date.now()
  };
}
