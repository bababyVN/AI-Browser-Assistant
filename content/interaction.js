/**
 * content/interaction.js — Element Scanning & Interaction (Generic Version)
 * Handles scanning interactive elements, clicking, typing, and generalized heuristics.
 */
'use strict';

window.__aiAssistant = window.__aiAssistant || {};

// Sử dụng Map để ánh xạ chỉ số với Node DOM thực tế
let elementMap = new Map();

/**
 * Thu hồi và giải phóng bộ nhớ để tránh Detached DOM Trees Memory Leak trên SPA
 */
function resetElementMap() {
  if (elementMap) {
    elementMap.clear();
  }
  elementMap = new Map();
}

window.__aiAssistant._getElement = function(index) {
  return elementMap.get(index) || null;
};

function isElementVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 3 || rect.height < 3) return false;
  
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' || style.pointerEvents === 'none') return false;
  
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  if (rect.bottom < -200 || rect.top > viewportHeight + 300) return false;
  if (rect.right < 0 || rect.left > viewportWidth) return false;
  
  return true;
}
window.__aiAssistant.isElementVisible = isElementVisible;

function getElementText(el) {
  const ariaLabel = el.getAttribute('aria-label') || '';
  const title = el.getAttribute('title') || '';
  const alt = el.getAttribute('alt') || '';
  const placeholder = el.getAttribute('placeholder') || '';
  const innerText = (el.innerText || '').trim();

  let text = ariaLabel || title || alt || innerText || placeholder || '';
  if (text.length > 80) text = text.substring(0, 77) + '...';
  return text;
}

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
    if (el.closest('a')) return 'image-link';
    return 'image';
  }
  if (el.getAttribute('role') === 'button' || el.hasAttribute('onclick')) return 'button';
  if (el.getAttribute('role') === 'link') return 'link';
  if (el.getAttribute('role') === 'tab') return 'tab';
  if (el.getAttribute('role') === 'menuitem') return 'menuitem';
  return 'interactive';
}

/**
 * Hàm Heuristic quét phần tử dựa trên trọng số từ khóa ngữ nghĩa (Chạy tốt trên mọi Website)
 */
window.__aiAssistant.findGenericElement = function(selectors, regexes) {
  const candidates = document.querySelectorAll(selectors.join(', '));
  let bestCandidate = null;
  let maxScore = 0;

  for (const el of candidates) {
    if (!isElementVisible(el)) continue;

    const textSources = [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.innerText,
      el.getAttribute('placeholder'),
      el.className
    ].filter(Boolean).map(t => t.toLowerCase());

    let score = 0;
    for (const text of textSources) {
      regexes.forEach((regex, index) => {
        if (regex.test(text)) {
          score += (index === 0) ? 10 : 5; // Ưu tiên các regex chính xác cao đứng đầu mảng
        }
      });
    }

    if (score > maxScore) {
      maxScore = score;
      bestCandidate = el;
    }
  }

  return bestCandidate;
};

window.__aiAssistant.getInteractiveElements = function() {
  resetElementMap(); // Giải phóng tham chiếu cũ trước khi quét mới

  const selectors = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'video',
    'iframe[src*="youtube"]', 'iframe[src*="youtu.be"]', 'iframe[src*="vimeo"]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[onclick]'
  ];

  const allElements = document.querySelectorAll(selectors.join(', '));
  const mainElements = [];
  const navElements = [];
  const navJunkPattern = /\b(nav|menu|sidebar|footer|header|cookie|banner|popup|modal|ads?|advert|social|share|comments?|related|widget|masthead|searchbox)\b/i;

  for (const el of allElements) {
    if (!isElementVisible(el)) continue;

    // Check if the element or any of its parents is a nav/header/footer element
    let isNav = false;
    let parent = el;
    while (parent && parent !== document.body) {
      const tag = parent.tagName.toLowerCase();
      if (['nav', 'header', 'footer', 'aside'].includes(tag)) {
        isNav = true;
        break;
      }
      const classAndId = (parent.className || '') + ' ' + (parent.id || '');
      if (navJunkPattern.test(classAndId)) {
        isNav = true;
        break;
      }
      parent = parent.parentElement;
    }

    if (isNav) {
      navElements.push(el);
    } else {
      mainElements.push(el);
    }
  }

  // Combine lists with main elements first
  const prioritized = [...mainElements, ...navElements];
  const results = [];
  let index = 0;

  for (const el of prioritized) {
    if (results.length >= 150) break;

    const rect = el.getBoundingClientRect();
    const type = getElementType(el);
    const text = getElementText(el);
    const tag = el.tagName.toLowerCase();

    const entry = {
      index: index,
      tag: tag,
      type: type,
      text: text,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };

    if (el.getAttribute('href')) entry.href = el.getAttribute('href');
    if (el.getAttribute('placeholder')) entry.placeholder = el.getAttribute('placeholder');
    if (tag === 'input' || tag === 'textarea') entry.value = (el.value || '').substring(0, 50);

    elementMap.set(index, el);
    results.push(entry);
    index++;
  }

  return results;
};

window.__aiAssistant.clickElement = function(index) {
  const el = elementMap.get(index);
  if (!el || !document.body.contains(el)) {
    return { success: false, error: `Phần tử tại index ${index} không còn tồn tại trong DOM.` };
  }

  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const text = getElementText(el);

    const anchor = el.tagName.toLowerCase() === 'a' ? el : el.closest('a');
    if (anchor && anchor.href) {
      if (anchor.getAttribute('target') === '_blank') {
        window.open(anchor.href, '_blank');
        return { success: true, action: 'open_in_new_tab', url: anchor.href, description: `Đã mở liên kết "${text}" ở tab mới` };
      } else {
        window.location.href = anchor.href;
        return { success: true, action: 'clicked', url: anchor.href, description: `Đã chuyển hướng đến "${text}"` };
      }
    }

    el.click();
    return { success: true, action: 'clicked', description: `Đã click vào phần tử "${text}"` };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

window.__aiAssistant.typeText = function(index, text, clear, submit) {
  const el = elementMap.get(index);
  if (!el) return { success: false, error: `Không tìm thấy phần tử nhập liệu tại index ${index}` };

  try {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    const isEditable = el.getAttribute('contenteditable') === 'true';
    if (isEditable) {
      if (clear) el.textContent = '';
      el.textContent += text;
    } else {
      if (clear) el.value = '';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
                     Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(el, clear ? text : el.value + text);
      } else {
        el.value = clear ? text : el.value + text;
      }
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (submit) {
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, xi: 13, which: 13 }));
      el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, xi: 13, which: 13 }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, xi: 13, which: 13 }));
      if (el.form) {
        try { el.form.submit(); } catch {}
      }
    }

    return { success: true, description: `Đã nhập dữ liệu thành công.${submit ? ' Đã gửi lệnh Enter.' : ''}` };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

/**
 * Phân loại ngữ nghĩa thông minh cho phần tử DOM.
 * Trả về nhãn ngữ nghĩa chi tiết hơn getElementType().
 */
function classifyElement(el) {
  const tag = el.tagName.toLowerCase();
  const href = (el.getAttribute('href') || '').toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
  const text = (el.innerText || '').trim().toLowerCase();
  const allText = `${ariaLabel} ${text} ${el.className || ''}`;

  // Video detection (YouTube, generic)
  if (tag === 'a' && (href.includes('/watch?v=') || href.includes('/shorts/') || href.includes('/video/'))) {
    return 'VIDEO';
  }
  if (tag === 'video' || (tag === 'iframe' && /youtube|youtu\.be|vimeo/.test(el.getAttribute('src') || ''))) {
    return 'VIDEO';
  }

  // Semantic button subtypes
  if (tag === 'button' || el.getAttribute('role') === 'button') {
    if (/\b(like|thích|upvote|👍)\b/i.test(allText)) return 'BTN:like';
    if (/\b(dislike|không thích|downvote|👎)\b/i.test(allText)) return 'BTN:dislike';
    if (/\b(share|chia sẻ)\b/i.test(allText)) return 'BTN:share';
    if (/\b(subscribe|đăng ký|follow|theo dõi)\b/i.test(allText)) return 'BTN:subscribe';
    if (/\b(save|lưu|bookmark)\b/i.test(allText)) return 'BTN:save';
    if (/\b(reply|trả lời|phản hồi)\b/i.test(allText)) return 'BTN:reply';
    if (/\b(send|gửi|submit|đăng|post)\b/i.test(allText)) return 'BTN:submit';
    if (/\b(menu|more|thêm|⋮|\.\.\.)\b/i.test(allText)) return 'BTN:menu';
    return 'BTN';
  }

  // Input subtypes
  if (tag === 'input' || tag === 'textarea') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'search' || /search|tìm/i.test(allText)) return 'SEARCH';
    if (type === 'checkbox') return 'CHECKBOX';
    if (type === 'radio') return 'RADIO';
    if (/comment|bình luận/i.test(allText)) return 'INPUT:comment';
    return 'INPUT';
  }
  if (tag === 'select') return 'SELECT';

  // Link subtypes
  if (tag === 'a') {
    if (tag === 'a' && el.querySelector('img, picture, svg')) {
      // Image-link, could be a thumbnail
      const img = el.querySelector('img');
      if (img && img.width > 100 && img.height > 60) return 'THUMBNAIL';
    }
    return 'LINK';
  }

  if (el.getAttribute('role') === 'tab') return 'TAB';
  if (el.getAttribute('role') === 'menuitem') return 'MENUITEM';
  return 'INTERACTIVE';
}

/**
 * Xây dựng nhãn hiển thị nén cho 1 phần tử.
 */
function buildLabel(el, smartType) {
  const tag = el.tagName.toLowerCase();
  let text = '';

  // Lấy text hiển thị
  const ariaLabel = el.getAttribute('aria-label') || '';
  const title = el.getAttribute('title') || '';
  const alt = el.querySelector('img')?.getAttribute('alt') || '';
  const innerText = (el.innerText || '').trim();
  const placeholder = el.getAttribute('placeholder') || '';

  text = ariaLabel || title || alt || innerText || placeholder || '';
  // Cắt ngắn
  if (text.length > 80) text = text.substring(0, 77) + '...';
  // Escape newlines
  text = text.replace(/[\n\r]+/g, ' ').trim();

  // Build label based on type
  let label = `[${smartType}]`;

  if (smartType === 'VIDEO') {
    // Enrich with channel/views from parent container
    const meta = extractVideoMeta(el);
    label += ` "${text}"`;
    if (meta.channel) label += ` · ${meta.channel}`;
    if (meta.views) label += ` · ${meta.views}`;
  } else if (smartType === 'SEARCH' || smartType === 'INPUT' || smartType === 'INPUT:comment') {
    const val = el.value || '';
    if (val) {
      label += ` "${val.substring(0, 40)}"`;
    } else if (placeholder) {
      label += ` placeholder="${placeholder.substring(0, 40)}"`;
    }
  } else if (smartType === 'THUMBNAIL') {
    const img = el.querySelector('img');
    const imgAlt = img?.getAttribute('alt') || text;
    label += ` "${imgAlt}"`;
  } else if (text) {
    label += ` "${text}"`;
  }

  return label;
}

/**
 * Trích xuất metadata video từ container cha (channel, views).
 */
function extractVideoMeta(el) {
  const meta = { channel: '', views: '' };

  // Tìm container cha gần nhất chứa video info
  // YouTube: ytd-video-renderer, ytd-rich-item-renderer
  // Generic: article, li, .card, .video-item
  const container = el.closest('ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, article, li, [class*="video"], [class*="card"]');
  if (!container) return meta;

  const containerText = container.innerText || '';
  const lines = containerText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length < 100);

  // Tìm view count pattern
  for (const line of lines) {
    if (/\d+[\s,.]*(views|lượt xem|lượt phát|watching|người xem)/i.test(line)) {
      meta.views = line.substring(0, 30);
      break;
    }
  }

  // Tìm channel name (thường là dòng text ngắn không chứa view count và không phải title)
  const titleText = (el.getAttribute('title') || el.getAttribute('aria-label') || el.innerText || '').trim();
  for (const line of lines) {
    if (line === titleText) continue;
    if (/views|lượt xem|ago|trước|watching/i.test(line)) continue;
    if (line.length > 3 && line.length < 50) {
      meta.channel = line;
      break;
    }
  }

  return meta;
}

/**
 * Xây dựng DOM Map siêu nén — bản đồ toàn bộ phần tử tương tác trên trang.
 * Trả về chuỗi text nén phục vụ đính kèm vào prompt cho LLM.
 *
 * Output format:
 * [PAGE: "title" — hostname/path]
 * --- MAIN CONTENT ---
 * #0 [VIDEO] "React Full Course" · Bro Code · 5.2M views
 * #1 [BTN:like] "Like"
 * #2 [INPUT] placeholder="Add comment..."
 * --- NAV/HEADER ---
 * #30 [SEARCH] "current search text"
 * #31 [LINK] "Home"
 */
window.__aiAssistant.buildDomMap = function() {
  resetElementMap();

  const selectors = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'video',
    'iframe[src*="youtube"]', 'iframe[src*="youtu.be"]', 'iframe[src*="vimeo"]',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[onclick]'
  ];

  const allElements = document.querySelectorAll(selectors.join(', '));
  const mainEntries = [];
  const navEntries = [];
  const navJunkPattern = /\b(nav|menu|sidebar|footer|header|cookie|banner|popup|modal|ads?|advert|social|share|comments?-section|related|widget|masthead|topbar|toolbar|chips)\b/i;

  let index = 0;

  for (const el of allElements) {
    if (index >= 200) break;
    if (!isElementVisible(el)) continue;

    // Phân loại main vs nav
    let isNav = false;
    let parent = el;
    while (parent && parent !== document.body) {
      const tag = parent.tagName.toLowerCase();
      if (['nav', 'header', 'footer', 'aside'].includes(tag)) { isNav = true; break; }
      const classAndId = (parent.className || '') + ' ' + (parent.id || '');
      if (navJunkPattern.test(classAndId)) { isNav = true; break; }
      parent = parent.parentElement;
    }

    // Phân loại ngữ nghĩa thông minh
    const smartType = classifyElement(el);
    const label = buildLabel(el, smartType);

    elementMap.set(index, el);
    const entry = `#${index} ${label}`;

    if (isNav) {
      navEntries.push(entry);
    } else {
      mainEntries.push(entry);
    }
    index++;
  }

  // Build final compact string
  const pageHeader = `[PAGE: "${document.title}" — ${location.hostname}${location.pathname}]`;
  let map = pageHeader + '\n';

  if (mainEntries.length > 0) {
    map += '--- MAIN CONTENT ---\n';
    map += mainEntries.join('\n') + '\n';
  }
  if (navEntries.length > 0) {
    map += '--- NAV/HEADER ---\n';
    map += navEntries.join('\n') + '\n';
  }

  return { map, elementCount: index };
};
