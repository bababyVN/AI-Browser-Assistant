/**
 * content/snapshot.js — Page Snapshot, Scrolling & Video Playback
 * Handles full page snapshots, directional scrolling, and video playback.
 * Loaded THIRD in the content_scripts order.
 * Depends on: interaction.js (getInteractiveElements, clickElement, _getElement)
 */
'use strict';

window.__aiAssistant = window.__aiAssistant || {};

// ─── SCROLL_PAGE ───────────────────────────────────────────────────

window.__aiAssistant.scrollPage = function(direction, amount) {
  try {
    const px = amount || 500;
    switch (direction) {
      case 'up':
        window.scrollBy({ top: -px, behavior: 'smooth' });
        break;
      case 'down':
        window.scrollBy({ top: px, behavior: 'smooth' });
        break;
      case 'left':
        window.scrollBy({ left: -px, behavior: 'smooth' });
        break;
      case 'right':
        window.scrollBy({ left: px, behavior: 'smooth' });
        break;
      case 'top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        break;
      default:
        return { success: false, error: `Unknown direction: ${direction}` };
    }

    return {
      success: true,
      description: `Scrolled ${direction}${direction !== 'top' && direction !== 'bottom' ? ` by ${px}px` : ''}`,
      scrollPosition: { x: window.scrollX, y: window.scrollY }
    };
  } catch (err) {
    return { success: false, error: `Failed to scroll: ${err.message}` };
  }
};

// ─── GET_PAGE_SNAPSHOT ─────────────────────────────────────────────

window.__aiAssistant.getPageSnapshot = function() {
  const meta = document.querySelector('meta[name="description"]');
  const bodyText = (document.body?.innerText || '').trim();
  const elements = window.__aiAssistant.getInteractiveElements();

  // Count element types
  const counts = { links: 0, buttons: 0, inputs: 0, videos: 0, images: 0, selects: 0 };
  elements.forEach(el => {
    if (el.type === 'link') counts.links++;
    else if (el.type === 'button') counts.buttons++;
    else if (el.type === 'input' || el.type === 'textarea') counts.inputs++;
    else if (el.type === 'video') counts.videos++;
    else if (el.type === 'image' || el.type === 'image-link') counts.images++;
    else if (el.type === 'select') counts.selects++;
  });

  return {
    title: document.title,
    url: window.location.href,
    metaDescription: meta?.getAttribute('content') || '',
    contentSummary: bodyText.substring(0, 2000),
    counts: counts,
    totalInteractiveElements: elements.length,
    elements: elements
  };
};

// ─── PLAY_VIDEO ────────────────────────────────────────────────────

window.__aiAssistant.playVideo = function(index) {
  // _getElement() is exposed by interaction.js to give direct DOM access
  const el = window.__aiAssistant._getElement(index);
  if (!el) {
    return { success: false, error: `Element at index ${index} not found. Try running get_page_elements again.` };
  }

  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const tag = el.tagName.toLowerCase();

    if (tag === 'video') {
      el.play();
      return { success: true, description: 'Playing video element' };
    }

    if (tag === 'iframe') {
      // For YouTube embeds, try the postMessage API
      const src = el.getAttribute('src') || '';
      if (src.includes('youtube') || src.includes('youtu.be')) {
        try {
          el.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
          return { success: true, description: 'Sent play command to YouTube iframe' };
        } catch (e) {
          return { success: true, description: 'YouTube iframe found — user may need to click play manually', action: 'manual' };
        }
      }
      return { success: false, error: 'Cannot control this iframe video directly. Try clicking it instead.' };
    }

    // Maybe it's a thumbnail/link — delegate to clickElement
    return window.__aiAssistant.clickElement(index);
  } catch (err) {
    return { success: false, error: `Failed to play video: ${err.message}` };
  }
};
