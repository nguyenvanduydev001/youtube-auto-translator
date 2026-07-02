/**
 * Popup — UI tối giản, bật/tắt dịch phụ đề
 * (v3: console log màu, bỏ hẳn API key mặc định — chỉ dùng key user tự nhập)
 */

const LOG_STYLE = {
  error: 'background:#F44336;color:#fff;padding:2px 6px;border-radius:3px;font-weight:700;',
  state: 'background:#9C27B0;color:#fff;padding:2px 6px;border-radius:3px;font-weight:600;',
};
const logError = (...a) => console.error('%c[LỖI]', LOG_STYLE.error, ...a);
const logState = (...a) => console.log('%c[TRẠNG THÁI]', LOG_STYLE.state, ...a);

const apiKeyInput = document.getElementById('apiKey');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const statusLine = document.getElementById('statusLine');
const btnGuide = document.getElementById('btnGuide');

function setRunningState(isRunning) {
  btnStart.disabled = isRunning;
  btnStop.disabled = !isRunning;

  if (isRunning) {
    statusLine.textContent = '● Đang dịch';
    statusLine.className = 'running';
  } else {
    statusLine.textContent = '● Đã dừng';
    statusLine.className = 'stopped';
  }
}

async function loadSettings() {
  try {
    const { groqApiKey } = await chrome.storage.local.get('groqApiKey');
    apiKeyInput.value = groqApiKey || '';
  } catch (err) {
    logError('Không đọc được cài đặt:', err.message);
  }
}

apiKeyInput.addEventListener('change', async () => {
  try {
    await chrome.storage.local.set({ groqApiKey: apiKeyInput.value.trim() });
  } catch (err) {
    logError('Không lưu được API key:', err.message);
  }
});

async function getActiveYouTubeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) throw new Error('Không tìm thấy tab đang active.');
  if (!tab.url?.includes('youtube.com/watch')) {
    throw new Error('Hãy mở video YouTube trước.');
  }

  return tab;
}

async function sendMessageSafe(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

btnStart.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    apiKeyInput.focus();
    return;
  }

  await chrome.storage.local.set({ groqApiKey: apiKey });
  btnStart.disabled = true;

  try {
    const tab = await getActiveYouTubeTab();
    logState('Đang gửi lệnh bắt đầu dịch tới tab:', tab.id);
    const result = await sendMessageSafe({
      type: 'START_TRANSLATION',
      tabId: tab.id,
    });

    if (result?.success) {
      logState('Bắt đầu dịch thành công.');
      setRunningState(true);
    } else {
      logError('Không bắt đầu được dịch:', result?.message || 'Không rõ nguyên nhân.');
      setRunningState(false);
    }
  } catch (err) {
    logError('Lỗi khi bắt đầu dịch:', err.message);
    setRunningState(false);
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  try {
    await sendMessageSafe({ type: 'STOP_TRANSLATION' });
    logState('Đã gửi lệnh dừng dịch.');
  } catch (err) {
    logError('Lỗi khi dừng dịch:', err.message);
  }
  setRunningState(false);
});

btnGuide.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('api-guide.html') });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NOTIFY' && message.notifyType === 'error') {
    logError(message.message);
    if (message.message?.includes('API key')) {
      setRunningState(false);
    }
  }
});

async function syncStatus() {
  try {
    const status = await sendMessageSafe({ type: 'GET_STATUS' });
    setRunningState(status?.isTranslating ?? false);
  } catch (err) {
    logError('Không đồng bộ được trạng thái:', err.message);
    setRunningState(false);
  }
}

loadSettings();
syncStatus();
