/**
 * content/interaction.js — Element Scanning & Interaction
 * Handles scanning interactive elements, clicking, typing,
 * and selecting options on the page.
 * Loaded SECOND in the content_scripts order.
 */
'use strict';

window.__aiAssistant = window.__aiAssistant || {};

// ─── Element Index Map (refreshed on each scan) ────────────────────
let elementMap = new Map();

/**
 * Internal accessor — lets snapshot.js read the elementMap without re-scanning.
 * Only valid after getInteractiveElements() has been called.
 */
window.__aiAssistant._getElement = function(index) {
  return elementMap.get(index) || null;
};

// ─── Utility: Check if element is visible & in viewport ────────────
function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  // Viewport-aware filtering — only elements within ±100px of viewport
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  if (rect.bottom < -100 || rect.top > viewportHeight + 100) return false;
  if (rect.right < 0 || rect.left > viewportWidth) return false;
  return true;
}

// ─── Utility: Get meaningful text from element ─────────────────────
function getElementText(el) {
  const ariaLabel = el.getAttribute('aria-label') || '';
  const title = el.getAttribute('title') || '';
  const alt = el.getAttribute('alt') || '';
  const placeholder = el.getAttribute('placeholder') || '';
  const innerText = (el.innerText || '').trim();

  // Priority: aria-label > title > alt > innerText > placeholder
  let text = ariaLabel || title || alt || innerText || placeholder || '';
  // Truncate to 80 chars
  if (text.length > 80) text = text.substring(0, 77) + '...';
  return text;
}

// ─── Utility: Detect element type category ────────────────────────
function getElementType(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'submit' || type === 'button') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    return 'input';
  }
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'video') return 'video';
  if (tag === 'iframe') {
    const src = (el.getAttribute('src') || '').toLowerCase();
    if (src.includes('youtube') || src.includes('youtu.be') || src.includes('vimeo')) return 'video';
    return 'iframe';
  }
  if (tag === 'img') {
    // Check if wrapped in a link
    if (el.closest('a')) return 'image-link';
    return 'image';
  }
  // Elements with onclick or role=button
  if (el.getAttribute('role') === 'button' || el.hasAttribute('onclick')) return 'button';
  if (el.getAttribute('role') === 'link') return 'link';
  if (el.getAttribute('role') === 'tab') return 'tab';
  if (el.getAttribute('role') === 'menuitem') return 'menuitem';
  return 'interactive';
}

// ─── GET_INTERACTIVE_ELEMENTS ──────────────────────────────────────

window.__aiAssistant.getInteractiveElements = function() {
  // Clear previous map
  elementMap = new Map();

  const selectors = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'video',
    'iframe[src*="youtube"], iframe[src*="youtu.be"], iframe[src*="vimeo"]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[onclick]'
  ];

  const allElements = document.querySelectorAll(selectors.join(', '));
  const results = [];
  let index = 0;

  for (const el of allElements) {
    if (index >= 50) break;
    if (!isElementVisible(el)) continue;

    const rect = el.getBoundingClientRect();
    const type = getElementType(el);
    const text = getElementText(el);
    const tag = el.tagName.toLowerCase();

    const entry = {
      index: index,
      tag: tag,
      type: type,
      text: text,
      href: el.getAttribute('href') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      value: (tag === 'input' || tag === 'textarea') ? (el.value || '').substring(0, 50) : undefined,
      name: el.getAttribute('name') || undefined,
      inputType: (tag === 'input') ? (el.getAttribute('type') || 'text') : undefined,
      selector: el.className ? el.className.split(' ').slice(0, 3).join('.') : undefined,
      contentEditable: el.getAttribute('contenteditable') === 'true' ? true : undefined,
      isVisible: true,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };

    // Clean undefined fields
    Object.keys(entry).forEach(k => { if (entry[k] === undefined) delete entry[k]; });

    elementMap.set(index, el);
    results.push(entry);
    index++;
  }

  return results;
};

// ─── CLICK_ELEMENT ─────────────────────────────────────────────────

window.__aiAssistant.clickElement = function(index) {
  const el = elementMap.get(index);
  if (!el) {
    return { success: false, error: `Element at index ${index} not found. Try running get_page_elements again to refresh the list.` };
  }

  if (!document.body.contains(el)) {
    return { success: false, error: `Element at index ${index} is no longer in the DOM. The page may have changed. Try running get_page_elements again.` };
  }

  try {
    // Scroll into view
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const tag = el.tagName.toLowerCase();
    const type = getElementType(el);
    const text = getElementText(el);

    // For links with target="_blank", return the URL for background to open
    if (tag === 'a' && el.getAttribute('target') === '_blank' && el.href) {
      return {
        success: true,
        action: 'open_in_new_tab',
        url: el.href,
        description: `Link "${text}" opens in new tab`
      };
    }

    // For image-links, click the parent <a>
    if (type === 'image-link') {
      const parentLink = el.closest('a');
      if (parentLink) {
        if (parentLink.getAttribute('target') === '_blank' && parentLink.href) {
          return {
            success: true,
            action: 'open_in_new_tab',
            url: parentLink.href,
            description: `Image link "${text}" opens in new tab`
          };
        }
        parentLink.click();
        return { success: true, action: 'clicked', description: `Clicked image link "${text}"` };
      }
    }

    // Standard click
    el.click();
    return { success: true, action: 'clicked', description: `Clicked ${type} "${text}"` };
  } catch (err) {
    return { success: false, error: `Failed to click element: ${err.message}` };
  }
};

// ─── TYPE_TEXT ──────────────────────────────────────────────────────

window.__aiAssistant.typeText = function(index, text, clear) {
  const el = elementMap.get(index);
  if (!el) {
    return { success: false, error: `Element at index ${index} not found. Try running get_page_elements again.` };
  }

  const tag = el.tagName.toLowerCase();
  const isEditable = el.getAttribute('contenteditable') === 'true';

  if (tag !== 'input' && tag !== 'textarea' && !isEditable) {
    return { success: false, error: `Element at index ${index} (${tag}) is not a text input.` };
  }

  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    if (isEditable) {
      if (clear) el.textContent = '';
      el.textContent += text;
    } else {
      if (clear) el.value = '';
      // Use native input setter to trigger frameworks (React, Vue, etc.)
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set || Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value'
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, clear ? text : el.value + text);
      } else {
        el.value = clear ? text : el.value + text;
      }
    }

    // Dispatch events to trigger framework reactivity
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('keyup', { bubbles: true }));

    return {
      success: true,
      description: `Typed "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}" into ${tag}`
    };
  } catch (err) {
    return { success: false, error: `Failed to type text: ${err.message}` };
  }
};

// ─── SELECT_OPTION ─────────────────────────────────────────────────

window.__aiAssistant.selectOption = function(index, value) {
  const el = elementMap.get(index);
  if (!el) {
    return { success: false, error: `Element at index ${index} not found. Try running get_page_elements again.` };
  }

  if (el.tagName.toLowerCase() !== 'select') {
    return { success: false, error: `Element at index ${index} is not a <select> dropdown.` };
  }

  try {
    // Find option by value or text
    let found = false;
    for (const option of el.options) {
      if (option.value === value || option.text.toLowerCase().includes(value.toLowerCase())) {
        el.value = option.value;
        found = true;
        break;
      }
    }

    if (!found) {
      const available = Array.from(el.options).map(o => o.text).join(', ');
      return { success: false, error: `Option "${value}" not found. Available: ${available}` };
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));

    return { success: true, description: `Selected "${value}" from dropdown` };
  } catch (err) {
    return { success: false, error: `Failed to select option: ${err.message}` };
  }
};
