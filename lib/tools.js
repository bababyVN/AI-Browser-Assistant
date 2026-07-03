/**
 * lib/tools.js — Unified Tool Declarations & Executor Dispatcher
 */
'use strict';

let _getCachedPage = null;
let _setCachedPage = null;

let _historyStore = null;

export function initTools(deps) {
  _getCachedPage = deps.getCachedPage;
  _setCachedPage = deps.setCachedPage;

  _historyStore = deps.historyStore || null;
}

export const TOOL_DECLARATIONS = [
  {
    name: 'get_open_tabs',
    description: 'Liệt kê các tab đang mở (ID, Title).',
    parameters: { type: 'OBJECT', properties: {}, required: [] }
  },
  {
    name: 'open_url',
    description: 'Mở URL.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'Địa chỉ đường dẫn URL cần truy cập.' },
        new_tab: { type: 'BOOLEAN', description: 'Mở ở tab mới hay không. Mặc định là false.' }
      },
      required: ['url']
    }
  },
  {
    name: 'read_page_content',
    description: 'Đọc/tóm tắt trang. Bỏ qua tham số để lấy tóm tắt. Truyền section_index để đọc chi tiết.',
    parameters: {
      type: 'OBJECT',
      properties: {
        section_index: { type: 'INTEGER', description: 'Chỉ số section cần đọc chi tiết (0-based). Bỏ qua để nhận tóm tắt tổng quan.' }
      },
      required: []
    }
  },
  {
    name: 'search_in_page',
    description: 'Tìm text trên trang hiện tại. Trả về các đoạn text chứa từ khóa.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Từ khóa hoặc nội dung cần tìm kiếm trên trang.' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_page_elements',
    description: 'Quét lại trang để lấy danh sách phần tử (nếu DOM Map bị thiếu/lỗi).',
    parameters: { type: 'OBJECT', properties: {}, required: [] }
  },
  {
    name: 'click_element',
    description: 'Click phần tử theo số index.',
    parameters: {
      type: 'OBJECT',
      properties: { index: { type: 'INTEGER', description: 'Chỉ số index của phần tử cần bấm.' } },
      required: ['index']
    }
  },
  {
    name: 'type_into_element',
    description: 'Gõ chữ vào ô nhập theo index.',
    parameters: {
      type: 'OBJECT',
      properties: {
        index: { type: 'INTEGER', description: 'Chỉ số index của ô nhập dữ liệu.' },
        text: { type: 'STRING', description: 'Nội dung chuỗi chữ muốn điền.' },
        clear: { type: 'BOOLEAN', description: 'Xóa ký tự cũ trước khi nhập hay không. Mặc định là true.' },
        submit: { type: 'BOOLEAN', description: 'Tự động gửi/nhấn Enter sau khi nhập xong. Mặc định là false.' }
      },
      required: ['index', 'text']
    }
  },
  {
    name: 'scroll_page',
    description: 'Cuộn trang.',
    parameters: {
      type: 'OBJECT',
      properties: {
        direction: { type: 'STRING', description: 'Hướng cuộn: "up", "down", "top", "bottom".' },
        amount: { type: 'INTEGER', description: 'Số lượng pixel muốn cuộn. Mặc định là 500.' }
      },
      required: ['direction']
    }
  },
  {
    name: 'like_video',
    description: 'Tự động bấm Like.',
    parameters: { type: 'OBJECT', properties: {}, required: [] }
  },
  {
    name: 'comment_video',
    description: 'Tự động tìm ô bình luận, gõ và gửi.',
    parameters: {
      type: 'OBJECT',
      properties: { text: { type: 'STRING', description: 'Nội dung chuỗi chữ cần gửi lên khu vực bình luận.' } },
      required: ['text']
    }
  }
];

export async function getActiveTabAndInject() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) throw new Error('Không tìm thấy tab nào đang hoạt động.');
  
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ['content/extractor.js', 'content/interaction.js', 'content/snapshot.js', 'content/main.js']
    });
  } catch {}
  return activeTab;
}

export async function executeTool(name, args = {}) {
  // Chuẩn hóa tên gọi an toàn (Đề phòng LLM sinh sai kiểu camelCase/snake_case)
  const normName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Chuẩn hóa và Ép kiểu dữ liệu nghiêm ngặt để phòng ngừa lỗi Runtime ở Content Script
  if (args.index !== undefined) args.index = parseInt(args.index, 10);
  if (args.amount !== undefined) args.amount = parseInt(args.amount, 10);
  if (args.clear === undefined) args.clear = true;

  const activeTab = await getActiveTabAndInject();

  switch (normName) {
    case 'getopentabs':
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.map(t => ({ id: t.id, title: t.title, url: t.url })) };

    case 'openurl':
      if (args.new_tab) {
        await chrome.tabs.create({ url: args.url });
      } else {
        await chrome.tabs.update(activeTab.id, { url: args.url });
      }
      return { success: true, url: args.url };

    case 'getpageelements':
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'GET_INTERACTIVE_ELEMENTS' });

    case 'clickelement':
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'CLICK_ELEMENT', index: args.index });

    case 'typeintoelement':
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'TYPE_TEXT', index: args.index, text: args.text, clear: args.clear, submit: args.submit });

    case 'scrollpage':
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'SCROLL_PAGE', direction: args.direction, amount: args.amount });

    case 'likevideo':
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'LIKE_VIDEO' });

    case 'commentvideo':
      // Gửi trực tiếp yêu cầu xử lý bình luận Heuristic vạn năng sang main.js mới
      return await chrome.tabs.sendMessage(activeTab.id, { action: 'COMMENT_VIDEO', text: args.text });

    case 'readpagecontent':
      return await chrome.tabs.sendMessage(activeTab.id, {
        action: 'READ_PAGE_CONTENT',
        sectionIndex: args.section_index !== undefined ? parseInt(args.section_index, 10) : undefined
      });

    case 'searchinpage':
      return await chrome.tabs.sendMessage(activeTab.id, {
        action: 'SEARCH_PAGE',
        query: args.query || ''
      });

    // Legacy fallback cho ask_website
    case 'askwebsite': {
      const resp = await chrome.tabs.sendMessage(activeTab.id, { action: 'READ_PAGE_CONTENT' });
      return { content: resp?.summary || 'Không thể trích xuất nội dung.' };
    }

    default:
      return { error: `Công cụ yêu cầu không tồn tại: ${name}` };
  }
}
