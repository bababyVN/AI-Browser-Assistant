/**
 * content/main.js — Message Router (Entry Point)
 * Routes Chrome runtime messages to the appropriate handler function.
 * Loaded LAST in the content_scripts order — all other content/ modules
 * must be loaded first so window.__aiAssistant is fully populated.
 */
'use strict';

const ai = window.__aiAssistant;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.action) {
      case 'EXTRACT_PAGE':
        sendResponse({ success: true, sections: ai.extractPageContent() });
        break;

      case 'HIGHLIGHT':
        sendResponse(ai.highlightSection(message.sectionId));
        break;

      case 'CLEAR_HIGHLIGHT':
        ai.clearHighlights();
        sendResponse({ success: true });
        break;

      case 'GET_INTERACTIVE_ELEMENTS':
        sendResponse({ success: true, elements: ai.getInteractiveElements() });
        break;

      case 'CLICK_ELEMENT':
        sendResponse(ai.clickElement(message.index));
        break;

      case 'TYPE_TEXT':
        sendResponse(ai.typeText(message.index, message.text, message.clear !== false));
        break;

      case 'SELECT_OPTION':
        sendResponse(ai.selectOption(message.index, message.value));
        break;

      case 'SCROLL_PAGE':
        sendResponse(ai.scrollPage(message.direction, message.amount));
        break;

      case 'GET_PAGE_SNAPSHOT':
        sendResponse({ success: true, snapshot: ai.getPageSnapshot() });
        break;

      case 'PLAY_VIDEO':
        sendResponse(ai.playVideo(message.index));
        break;

      case 'PRESS_KEY': {
        const key = message.key || 'Enter';
        const activeElement = document.activeElement || document.body;
        const keyEvent = new KeyboardEvent('keydown', {
          key: key,
          code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`,
          keyCode: key === 'Enter' ? 13 : key.charCodeAt(0),
          which: key === 'Enter' ? 13 : key.charCodeAt(0),
          bubbles: true,
          cancelable: true
        });
        activeElement.dispatchEvent(keyEvent);
        // Also dispatch keypress and keyup for maximum compatibility
        activeElement.dispatchEvent(new KeyboardEvent('keypress', {
          key, bubbles: true, cancelable: true
        }));
        activeElement.dispatchEvent(new KeyboardEvent('keyup', {
          key, bubbles: true, cancelable: true
        }));
        // For input/textarea, also simulate form submission on Enter
        if (key === 'Enter' && activeElement.form) {
          try { activeElement.form.requestSubmit(); } catch { activeElement.form.submit(); }
        }
        sendResponse({ success: true, description: `Pressed ${key}` });
        break;
      }

      case 'GET_QUICK_CONTEXT': {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 8)
          .map(h => h.innerText.trim())
          .filter(t => t.length > 0 && t.length < 80)
          .join(' | ');

        // Auto-scan elements for AI "vision" without needing a separate tool call
        let topElements = '';
        if (ai.getInteractiveElements) {
          const els = ai.getInteractiveElements().slice(0, 20);
          topElements = els.map(e => `[${e.index}] ${e.type}: "${e.text}"`).join('; ');
        }

        sendResponse({
          success: true,
          title: document.title,
          url: window.location.href,
          headings: headings || '(no headings)',
          elements: topElements || '(no interactive elements)'
        });
        break;
      }

      default:
        sendResponse({ success: false, error: `Unknown action: ${message.action}` });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
  return true; // Keep message channel open for async response
});
