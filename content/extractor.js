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
  const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');

  if (headings.length === 0) {
    // Try smart content extraction first (Mini-Readability)
    const mainContent = window.__aiAssistant.extractMainContent();
    const finalContent = mainContent || (document.body?.innerText?.trim() || '');
    if (finalContent) {
      sections.push({
        id: 'section-0',
        heading: document.title || 'Page Content',
        content: finalContent.substring(0, 15000)
      });
    }
    return sections;
  }

  headings.forEach((heading, index) => {
    const sectionId = `section-${index}`;

    // Mark the heading element with the section ID for highlighting
    heading.setAttribute('data-ai-section-id', sectionId);

    const headingText = heading.innerText.trim();
    const contentParts = [];

    // Collect siblings until the next heading
    let sibling = heading.nextElementSibling;
    while (sibling) {
      const tagName = sibling.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tagName)) break;
      const text = sibling.innerText?.trim();
      if (text) contentParts.push(text);
      sibling = sibling.nextElementSibling;
    }

    sections.push({
      id: sectionId,
      heading: headingText,
      content: contentParts.join('\n')
    });
  });

  return sections;
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
