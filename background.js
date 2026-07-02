/**
 * Service Worker — Gọi Groq API dịch phụ đề (queue + try-catch toàn diện)
 * (v3: bỏ hẳn API key mặc định — bắt buộc user tự nhập & lưu trong storage)
 */

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const TRANSLATE_MODEL = 'llama-3.1-8b-instant';

const TRANSLATE_SYSTEM_PROMPT =
  'Bạn là một máy dịch thuật. Hãy dịch câu sau sang tiếng Việt tự nhiên nhất, chỉ trả về kết quả dịch, không thêm chữ nào khác.';

// ─── Console log màu ─────────────────────────────────────────────────────

const LOG_STYLE = {
  api: 'background:#FF9800;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
  result: 'background:#4CAF50;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700;',
  error: 'background:#F44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700;',
  state: 'background:#9C27B0;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
};

const logApi = (...a) => console.log('%c[ĐANG DỊCH]', LOG_STYLE.api, ...a);
const logResult = (...a) => console.log('%c[KẾT QUẢ VN]', LOG_STYLE.result, ...a);
const logError = (...a) => console.error('%c[LỖI]', LOG_STYLE.error, ...a);
const logState = (...a) => console.log('%c[TRẠNG THÁI]', LOG_STYLE.state, ...a);

/** @type {boolean} */
let isTranslating = false;

/** @type {number | null} */
let activeTabId = null;

const translationCache = new Map();
const CACHE_MAX_SIZE = 150;

/** Hàng đợi — xử lý tuần tự, bỏ qua câu cũ nếu có câu mới */
let translateQueue = [];
let isQueueProcessing = false;

// ─── Storage ───────────────────────────────────────────────────────────────

async function getApiKey() {
  try {
    const { groqApiKey } = await chrome.storage.local.get('groqApiKey');
    return groqApiKey || '';
  } catch (err) {
    logError('Không đọc được API key từ storage:', err.message);
    return '';
  }
}

async function persistState() {
  try {
    await chrome.storage.local.set({ isTranslating, activeTabId });
  } catch (err) {
    logError('Không lưu được state:', err.message);
  }
}

async function restoreState() {
  try {
    const { isTranslating: saved, activeTabId: savedTab } =
      await chrome.storage.local.get(['isTranslating', 'activeTabId']);
    if (saved && savedTab) {
      isTranslating = true;
      activeTabId = savedTab;
    }
  } catch (err) {
    logError('Không khôi phục được state:', err.message);
  }
}

restoreState();

// ─── Groq API ───────────────────────────────────────────────────────────────

async function translateToVietnamese(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';

  if (translationCache.has(trimmed)) {
    return translationCache.get(trimmed);
  }

  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error('Chưa nhập Groq API Key.');
  }

  logApi('Gửi request tới Groq API:', trimmed);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        messages: [
          { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
          { role: 'user', content: trimmed },
        ],
        temperature: 0.2,
        max_tokens: 512,
      }),
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Groq API timeout (15s) — mất kết nối hoặc mạng chậm.');
    }
    throw new Error(`Lỗi mạng khi gọi Groq API: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    await handleGroqError(response);
  }

  const data = await response.json();
  const translated = (data.choices?.[0]?.message?.content || '').trim();

  if (translationCache.size >= CACHE_MAX_SIZE) {
    translationCache.delete(translationCache.keys().next().value);
  }
  translationCache.set(trimmed, translated);

  return translated;
}

async function handleGroqError(response) {
  const status = response.status;
  let detail = '';

  try {
    const errBody = await response.json();
    detail = errBody.error?.message || JSON.stringify(errBody);
  } catch {
    detail = '';
  }

  if (status === 401) {
    logError('API key không hợp lệ (401).', detail);
    throw new Error('API key không hợp lệ.');
  }
  if (status === 429) {
    logError('Rate limit — bị Groq giới hạn request (429).', detail);
    throw new Error('Rate limit (429). Thử lại sau.');
  }

  logError(`Groq lỗi HTTP ${status}:`, detail);
  throw new Error(`Groq lỗi HTTP ${status}: ${detail}`);
}

// ─── Queue xử lý dịch ───────────────────────────────────────────────────────

/**
 * Thêm vào hàng đợi — nếu cùng lúc nhiều câu, giữ câu cuối (debounce phía queue)
 */
function enqueueTranslation(text, sendResponse) {
  translateQueue = translateQueue.filter((item) => item.processing);
  translateQueue.push({ text, sendResponse, processing: false });

  processTranslateQueue();
}

async function processTranslateQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  while (translateQueue.length > 0 && isTranslating) {
    const pending = translateQueue.filter((item) => !item.processing);
    if (pending.length === 0) break;

    const latest = pending[pending.length - 1];

    for (const item of pending.slice(0, -1)) {
      try {
        item.sendResponse({ skipped: true });
      } catch {
        /* popup/tab đã đóng */
      }
      item.processing = true;
    }

    latest.processing = true;
    translateQueue = translateQueue.filter((item) => !item.processing || item === latest);

    try {
      const translated = await translateToVietnamese(latest.text);
      logResult(translated);
      latest.sendResponse({ translated });
    } catch (err) {
      logError('Lỗi dịch (tiếp tục câu sau):', err.message);
      try {
        latest.sendResponse({ error: err.message });
      } catch {
        /* bỏ qua */
      }

      if (err.message.includes('429')) {
        await sleep(2000);
      }
    }

    translateQueue = translateQueue.filter((item) => item !== latest);
  }

  isQueueProcessing = false;

  if (translateQueue.some((item) => !item.processing) && isTranslating) {
    processTranslateQueue();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tab communication ─────────────────────────────────────────────────────

async function sendToContentTab(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    logError('Không gửi được tới content script:', err.message);
  }
}

async function startTranslation(tabId) {
  try {
    if (isTranslating) {
      return { success: false, message: 'Đang dịch rồi.' };
    }

    const apiKey = await getApiKey();
    if (!apiKey) {
      logError('Chưa có API key — không thể bắt đầu dịch.');
      return { success: false, message: 'Vui lòng nhập Groq API Key.' };
    }

    isTranslating = true;
    activeTabId = tabId;
    await persistState();

    await sendToContentTab(tabId, { type: 'START_CAPTION_TRANSLATION' });

    logState('Bắt đầu dịch, tab:', tabId);
    return { success: true };
  } catch (err) {
    logError('Lỗi start:', err.message);
    isTranslating = false;
    activeTabId = null;
    await persistState();
    return { success: false, message: err.message };
  }
}

async function stopTranslation() {
  try {
    isTranslating = false;
    translateQueue = [];

    if (activeTabId) {
      await sendToContentTab(activeTabId, { type: 'STOP_CAPTION_TRANSLATION' });
    }

    activeTabId = null;
    await persistState();
    logState('Đã dừng dịch.');
    return { success: true };
  } catch (err) {
    logError('Lỗi stop:', err.message);
    return { success: true };
  }
}

// ─── Message handler ────────────────────────────────────────────────────────
// Luôn trả về true để giữ kênh (port) mở, tránh lỗi
// "message port closed before a response was received".

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message.type === 'START_TRANSLATION') {
      startTranslation(message.tabId)
        .then(sendResponse)
        .catch((err) => {
          logError('Lỗi handler START_TRANSLATION:', err.message);
          sendResponse({ success: false, message: err.message });
        });
      return true;
    }

    if (message.type === 'STOP_TRANSLATION') {
      stopTranslation()
        .then(sendResponse)
        .catch((err) => {
          logError('Lỗi handler STOP_TRANSLATION:', err.message);
          sendResponse({ success: false, message: err.message });
        });
      return true;
    }

    if (message.type === 'GET_STATUS') {
      sendResponse({ isTranslating, activeTabId });
      return true;
    }

    if (message.type === 'TRANSLATE_TEXT') {
      if (!isTranslating) {
        sendResponse({ error: 'Dịch chưa được bật.' });
        return true;
      }

      enqueueTranslation(message.text, sendResponse);
      return true;
    }
  } catch (err) {
    logError('Lỗi handler onMessage:', err.message);
    try {
      sendResponse({ error: err.message });
    } catch {
      /* bỏ qua */
    }
  }

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    isTranslating = false;
    activeTabId = null;
    translateQueue = [];
    persistState();
  }
});

logState('Service worker sẵn sàng.');
