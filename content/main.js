/**
 * content/main.js — Message Router & Async Operations Orchestrator
 * Loaded LAST in the content_scripts chain.
 */
'use strict';

const ai = window.__aiAssistant;

// Hàm Polling đồng bộ an toàn bằng Promise (Không gây treo rò rỉ bộ nhớ)
function waitForElementHeuristic(selectors, regexes, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    function check() {
      const el = ai.findGenericElement(selectors, regexes);
      if (el) return resolve(el);
      
      if (Date.now() - startTime > timeout) {
        return reject(new Error('Hết thời gian chờ (Timeout) - Không tìm thấy phần tử phù hợp ngữ nghĩa trên trang này.'));
      }
      requestAnimationFrame(check);
    }
    check();
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    switch (message.action) {
      case 'EXTRACT_PAGE':
        sendResponse({ success: true, sections: ai.extractPageContent() });
        break;

      case 'GET_INTERACTIVE_ELEMENTS':
        sendResponse({ success: true, elements: ai.getInteractiveElements() });
        break;

      case 'CLICK_ELEMENT':
        sendResponse(ai.clickElement(message.index));
        break;

      case 'TYPE_TEXT':
        sendResponse(ai.typeText(message.index, message.text, message.clear !== false, message.submit === true));
        break;

      case 'PRESS_ENTER': {
        const activeEl = document.activeElement;
        if (activeEl) {
          activeEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
          activeEl.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
          activeEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
          if (activeEl.form) {
            try { activeEl.form.submit(); } catch {}
          }
          sendResponse({ success: true, description: 'Đã nhấn phím Enter trên phần tử đang focus.' });
        } else {
          sendResponse({ success: false, error: 'Không có phần tử nào đang được focus để nhấn Enter.' });
        }
        break;
      }

      case 'SCROLL_PAGE':
        sendResponse(ai.scrollPage(message.direction, message.amount));
        break;

      case 'GET_PAGE_SNAPSHOT':
        sendResponse({ success: true, snapshot: ai.getPageSnapshot() });
        break;

      case 'PLAY_VIDEO':
        sendResponse(ai.playVideo(message.index));
        break;

      case 'LIKE_VIDEO': {
        const target = ai.findGenericElement(['button', '[role="button"]', 'a'], [/like/i, /thích/i, /upvote/i, /favorite/i]);
        if (target) {
          target.click();
          sendResponse({ success: true, description: 'Đã thực hiện bấm Thích/Like!' });
        } else {
          sendResponse({ success: false, error: 'Không tìm thấy nút bấm tương tự nút Thích.' });
        }
        break;
      }

      case 'DISLIKE_VIDEO': {
        const target = ai.findGenericElement(['button', '[role="button"]'], [/dislike/i, /không thích/i, /downvote/i]);
        if (target) {
          target.click();
          sendResponse({ success: true, description: 'Đã thực hiện bấm Không thích!' });
        } else {
          sendResponse({ success: false, error: 'Không tìm thấy nút Không thích.' });
        }
        break;
      }

      case 'COMMENT_VIDEO': {
        const commentText = message.text;
        if (!commentText) {
          sendResponse({ success: false, error: 'Vui lòng cung cấp chuỗi văn bản cần bình luận.' });
          break;
        }

        // Tách luồng Async an toàn ra khỏi luồng đồng bộ của Switch Case
        (async () => {
          try {
            // Cuộn nhẹ để kích hoạt tải Lazy-load vùng bình luận của các Website hiện đại
            window.scrollBy({ top: 500, behavior: 'smooth' });

            // 1. Tìm ô nhập bình luận bằng Heuristic tổng quát
            const txtSelectors = ['textarea', 'input[type="text"]', '[contenteditable="true"]', '[role="textbox"]'];
            const txtRegexes = [/comment/i, /bình luận/i, /viết câu trả lời/i, /reply/i, /placeholder/i];
            
            const inputField = await waitForElementHeuristic(txtSelectors, txtRegexes, 6000);
            inputField.scrollIntoView({ behavior: 'smooth', block: 'center' });
            inputField.click();
            inputField.focus();

            // Nhập text
            if (inputField.getAttribute('contenteditable') === 'true') {
              inputField.textContent = commentText;
            } else {
              inputField.value = commentText;
            }
            inputField.dispatchEvent(new Event('input', { bubbles: true }));

            // Chờ một khoảng rất ngắn để Framework UI (React/Vue) mở khóa nút Submit từ Disabled -> Enabled
            await new Promise(resolve => setTimeout(resolve, 300));

            // 2. Tìm nút gửi (Submit / Đăng bình luận)
            const btnSelectors = ['button', '[role="button"]', 'input[type="submit"]'];
            const btnRegexes = [/submit/i, /post/i, /gửi/i, /đăng/i, /comment/i];
            
            const submitBtn = ai.findGenericElement(btnSelectors, btnRegexes);
            if (submitBtn) {
              submitBtn.click();
              sendResponse({ success: true, description: `Đăng bình luận thành công: "${commentText}"` });
            } else {
              sendResponse({ success: false, error: 'Đã nhập văn bản bình luận nhưng không tìm thấy nút Đăng/Gửi phù hợp.' });
            }
          } catch (err) {
            sendResponse({ success: false, error: err.message });
          }
        })();

        return true; // GIỮ CỔNG KẾT NỐI: Luôn mở cổng phản hồi bất đồng bộ cho Chrome API
      }

      case 'GET_QUICK_CONTEXT': {
        // Legacy fallback — giữ lại cho tương thích ngược
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 8)
          .map(h => h.innerText.trim())
          .filter(t => t.length > 0 && t.length < 80)
          .join(' | ');

        let topElements = '';
        if (message.includeElements !== false && ai.getInteractiveElements) {
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

      // ─── DOM Map + Lazy Content Architecture ─────────────────────────

      case 'BUILD_DOM_MAP': {
        // Xây dựng bản đồ DOM siêu nén cho LLM — thay thế GET_QUICK_CONTEXT
        const result = ai.buildDomMap();
        sendResponse({ success: true, ...result });
        break;
      }

      case 'READ_PAGE_CONTENT': {
        // Đọc nội dung trang — lazy loading với cache
        const result = ai.extractSmartContent(message.sectionIndex);
        sendResponse(result);
        break;
      }

      case 'SEARCH_PAGE': {
        // Tìm kiếm từ khóa trên trang — không cần gửi full page cho LLM
        const result = ai.searchInPage(message.query);
        sendResponse(result);
        break;
      }

      default:
        sendResponse({ success: false, error: `Hành động không xác định: ${message.action}` });
    }
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
  return true;
});