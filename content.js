/**
 * Content Script — Đọc phụ đề YouTube và hiển thị bản dịch tiếng Việt
 * (v2: quét bằng setInterval thay vì MutationObserver, tự động bật CC,
 *  console log màu để dễ debug)
 */

const SUBTITLE_ID = 'my-vn-subtitle';
const HIDE_CC_STYLE_ID = 'yat-hide-youtube-captions';
const POLL_INTERVAL_MS = 700; // quét phụ đề mỗi 700ms — bền hơn MutationObserver
const DEBOUNCE_MS = 450; // chờ text ổn định rồi mới gửi API (tránh gửi câu dở dang)
const CC_WARNING = 'Hãy bật phụ đề (CC) của YouTube lên để extension có thể dịch!';

// ─── Console log màu (dễ nhìn khi debug) ────────────────────────────────────

const LOG_STYLE = {
  text: 'background:#2196F3;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
  api: 'background:#FF9800;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
  result: 'background:#4CAF50;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700;',
  error: 'background:#F44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700;',
  state: 'background:#9C27B0;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
};

const logText = (...a) => console.log('%c[TEXT GỐC]', LOG_STYLE.text, ...a);
const logApi = (...a) => console.log('%c[ĐANG DỊCH]', LOG_STYLE.api, ...a);
const logResult = (...a) => console.log('%c[KẾT QUẢ VN]', LOG_STYLE.result, ...a);
const logError = (...a) => console.error('%c[LỖI]', LOG_STYLE.error, ...a);
const logState = (...a) => console.log('%c[TRẠNG THÁI]', LOG_STYLE.state, ...a);

/** @type {boolean} */
let isActive = false;

/** @type {string} */
let lastSeenCaptionText = '';

/** @type {string} */
let lastSentCaptionText = '';

/** @type {number | null} */
let pollTimer = null;

/** @type {number | null} */
let debounceTimer = null;

/** Text đang chờ gửi API (debounce — chỉ lấy câu cuối) */
let pendingCaptionText = null;

/** Sequence để bỏ qua response cũ */
let requestSeq = 0;

/** Đánh dấu đã phát hiện extension bị reload (context chết) — tránh spam log */
let contextInvalidated = false;

/** Kiểm tra có phải lỗi "Extension context invalidated" không */
function isContextInvalidatedError(err) {
  const msg = err?.message || String(err || '');
  return msg.includes('Extension context invalidated') || msg.includes('context invalidated');
}

/**
 * Extension vừa được reload (ở chrome://extensions) trong khi tab này vẫn mở.
 * Content script cũ không thể kết nối lại chrome.runtime nữa — chỉ có cách
 * duy nhất là người dùng tải lại trang. Ta dừng hẳn polling để khỏi spam lỗi.
 */
function handleContextInvalidated() {
  if (contextInvalidated) return;
  contextInvalidated = true;

  logState('Extension vừa được cập nhật/reload — cần tải lại trang YouTube (F5) để tiếp tục dịch.');

  isActive = false;
  clearTimeout(debounceTimer);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  try {
    showSubtitle('⚠️ Extension vừa được cập nhật — hãy tải lại trang (F5) để tiếp tục dịch.');
  } catch {
    /* DOM cũng có thể không thao tác được nữa, bỏ qua */
  }
}

// ─── Tự động bật CC gốc của YouTube ──────────────────────────────────────────

/**
 * Tự động bật nút CC (.ytp-subtitles-button) nếu chưa bật.
 * Retry vì player có thể chưa render kịp khi mới vào trang / chuyển video.
 */
function ensureNativeCaptionsOn(retries = 12) {
  try {
    const btn = document.querySelector('.ytp-subtitles-button');

    if (!btn) {
      if (retries > 0) {
        setTimeout(() => ensureNativeCaptionsOn(retries - 1), 300);
      } else {
        logError('Không tìm thấy nút CC (.ytp-subtitles-button) — video có thể không có phụ đề.');
      }
      return;
    }

    const isPressed = btn.getAttribute('aria-pressed') === 'true';
    if (!isPressed) {
      btn.click();
      logState('Đã tự động bật CC (phụ đề gốc YouTube).');
    } else {
      logState('CC đã được bật sẵn.');
    }
  } catch (err) {
    logError('Lỗi khi tự bật CC:', err.message);
  }
}

// ─── Ẩn / hiện phụ đề gốc YouTube ───────────────────────────────────────────

function hideNativeCaptions() {
  if (document.getElementById(HIDE_CC_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = HIDE_CC_STYLE_ID;
  style.textContent = `
    .ytp-caption-segment,
    .caption-window,
    .ytp-caption-window-container,
    .ytp-caption-window-bottom {
      opacity: 0 !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
  `;
  document.head.appendChild(style);
  logState('Đã ẩn phụ đề gốc YouTube.');
}

function showNativeCaptions() {
  document.getElementById(HIDE_CC_STYLE_ID)?.remove();
  logState('Đã hiện lại phụ đề gốc YouTube.');
}

// ─── DOM: Phụ đề tiếng Việt ─────────────────────────────────────────────────

function getPlayerContainer() {
  return (
    document.querySelector('#movie_player') ||
    document.querySelector('.html5-video-player') ||
    document.querySelector('#player')
  );
}

function getOrCreateSubtitleElement() {
  let el = document.getElementById(SUBTITLE_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = SUBTITLE_ID;
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('role', 'status');
  }
  return el;
}

function mountSubtitle() {
  const container = getPlayerContainer();
  const el = getOrCreateSubtitleElement();
  if (!container) {
    setTimeout(mountSubtitle, 500);
    return;
  }
  if (el.parentElement !== container) {
    container.appendChild(el);
  }
}

function showSubtitle(text) {
  mountSubtitle();
  const el = getOrCreateSubtitleElement();
  el.textContent = text;
  el.classList.add('vn-visible');
}

function hideSubtitle() {
  const el = document.getElementById(SUBTITLE_ID);
  if (el) {
    el.textContent = '';
    el.classList.remove('vn-visible');
  }
}

// ─── Đọc phụ đề YouTube ──────────────────────────────────────────────────────

function getYouTubeCaptionText() {
  const player = document.querySelector('#movie_player');
  const segments = player
    ? player.querySelectorAll('.ytp-caption-segment')
    : document.querySelectorAll('.ytp-caption-segment');

  if (segments.length === 0) return null;

  const text = Array.from(segments)
    .map((seg) => seg.textContent.trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  return text || null;
}

// ─── Debounce + gửi API (chỉ dịch câu cuối cùng) ────────────────────────────

function scheduleTranslation(text) {
  pendingCaptionText = text;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushTranslation, DEBOUNCE_MS);
}

async function flushTranslation() {
  if (!isActive || !pendingCaptionText) return;

  const textToTranslate = pendingCaptionText;
  pendingCaptionText = null;

  // Bỏ qua nếu đã gửi cùng câu này (debounce theo nội dung)
  if (textToTranslate === lastSentCaptionText) return;

  lastSentCaptionText = textToTranslate;
  const seq = ++requestSeq;

  logText(textToTranslate);

  try {
    logApi('Gửi request tới Groq...');
    const response = await sendTranslateMessage(textToTranslate);

    // Bỏ response cũ nếu đã có request mới hơn
    if (seq !== requestSeq || !isActive) return;

    if (response?.skipped) return;

    if (response?.error) {
      logError('Lỗi dịch:', response.error);
      // Không dừng extension — chỉ log, tiếp tục câu sau
      return;
    }

    if (response?.translated) {
      logResult(response.translated);
      showSubtitle(response.translated);
    } else {
      logError('Background trả về response rỗng/không hợp lệ:', response);
    }
  } catch (err) {
    if (isContextInvalidatedError(err)) {
      handleContextInvalidated();
      return;
    }

    logError('Lỗi gửi request tới background:', err.message);
    // Reset lastSent để có thể thử lại câu này
    if (lastSentCaptionText === textToTranslate) {
      lastSentCaptionText = '';
    }
  }
}

/** Gửi message tới background, retry 1 lần nếu SW bị kill */
async function sendTranslateMessage(text, retries = 1) {
  if (contextInvalidated) {
    throw new Error('Extension context invalidated.');
  }

  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT', text }, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message || 'Service worker không phản hồi';

          // Context chết thì retry cũng vô ích — dừng luôn, không spam.
          if (isContextInvalidatedError({ message: errMsg })) {
            reject(new Error(errMsg));
            return;
          }

          if (retries > 0) {
            logError('Service worker không phản hồi, đang thử lại...', errMsg);
            setTimeout(() => {
              sendTranslateMessage(text, retries - 1).then(resolve).catch(reject);
            }, 300);
            return;
          }
          reject(new Error(errMsg));
          return;
        }
        resolve(response || {});
      });
    } catch (err) {
      reject(err);
    }
  });
}

/** Kiểm tra phụ đề thay đổi — được gọi mỗi POLL_INTERVAL_MS */
function checkCaptionChange() {
  if (!isActive || contextInvalidated) return;

  try {
    const captionText = getYouTubeCaptionText();

    if (captionText === null) {
      showSubtitle(CC_WARNING);
      lastSeenCaptionText = '';
      return;
    }

    if (captionText === lastSeenCaptionText) return;

    lastSeenCaptionText = captionText;
    scheduleTranslation(captionText);
  } catch (err) {
    logError('Lỗi khi quét phụ đề:', err.message);
  }
}

// ─── Bật / Tắt ─────────────────────────────────────────────────────────────

function startCaptionTranslation() {
  if (isActive) return;

  isActive = true;
  lastSeenCaptionText = '';
  lastSentCaptionText = '';
  pendingCaptionText = null;
  requestSeq = 0;

  logState('Bắt đầu dịch phụ đề.');

  ensureNativeCaptionsOn();
  hideNativeCaptions();
  mountSubtitle();
  showSubtitle('⏳ Đang chờ phụ đề YouTube...');

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(checkCaptionChange, POLL_INTERVAL_MS);
  checkCaptionChange();
}

function stopCaptionTranslation() {
  isActive = false;
  lastSeenCaptionText = '';
  lastSentCaptionText = '';
  pendingCaptionText = null;
  requestSeq++;

  clearTimeout(debounceTimer);
  debounceTimer = null;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  showNativeCaptions();
  hideSubtitle();
  logState('Đã dừng dịch phụ đề.');
}

// ─── Messages ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  try {
    if (message.type === 'START_CAPTION_TRANSLATION') startCaptionTranslation();
    if (message.type === 'STOP_CAPTION_TRANSLATION') stopCaptionTranslation();
  } catch (err) {
    logError('Lỗi xử lý message:', err.message);
  }
});

try {
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (status) => {
    if (chrome.runtime.lastError) return;
    if (status?.isTranslating) startCaptionTranslation();
  });
} catch (err) {
  if (isContextInvalidatedError(err)) {
    logState('Context đã invalidated ngay từ đầu — bỏ qua, chờ người dùng F5 trang.');
  }
}

// SPA navigation — YouTube chuyển video không load lại trang
let lastUrl = location.href;
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    lastSeenCaptionText = '';
    lastSentCaptionText = '';

    if (isActive) {
      logState('Phát hiện chuyển video (SPA) — reset trạng thái phụ đề.');
      ensureNativeCaptionsOn();
      hideNativeCaptions();
      mountSubtitle();
      checkCaptionChange();
    }
  }
});
navObserver.observe(document.body, { childList: true, subtree: true });

logState('YouTube Auto Translate content script đã load.');