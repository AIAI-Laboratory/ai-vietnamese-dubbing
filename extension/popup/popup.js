/** Popup icon extension — chỉnh playback, captions và voice; API Gemini nằm ở Options. */

const DEFAULTS = {
  dubVolume: 1.0,
  bedVolume: 1.0,
  subtitlesOn: false,
  subtitlesEnOn: true,
  subtitlePosition: 'bottom',
  subtitleSize: 'medium',
  subtitleColor: 'white-black',
  subtitleOffsetX: 0,
  subtitleOffsetY: 0,
  voice: '',
};

const $ = (id) => document.getElementById(id);

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

/** Đọc bản hiện có, ghi đè đúng field trong `patch`, lưu lại nguyên object — giữ Gemini API key/giọng của options.js an toàn. */
async function saveFields(patch) {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...(stored.settings || {}), ...patch };
  await chrome.storage.local.set({ settings });
}

let dirty = false;

function markDirty() {
  dirty = true;
  $('btnSavePopup').textContent = 'Lưu thay đổi *';
  $('popupSaveStatus').textContent = 'Có thay đổi chưa lưu.';
  $('popupSaveStatus').className = 'status-sm';
}

function fillSlider(el) {
  const min = +el.min || 0, max = +el.max || 1;
  const pct = ((+el.value - min) / (max - min)) * 100;
  el.style.background = `linear-gradient(90deg, var(--accent) ${pct}%, var(--line) ${pct}%)`;
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className = el.className.replace(/\bok\b|\berr\b/g, '').trim() + ' ' + (ok ? 'ok' : 'err');
}

async function loadControls() {
  const s = await getSettings();

  $('dubVolume').value = s.dubVolume;
  $('dubVolumeVal').textContent = (+s.dubVolume).toFixed(2);
  fillSlider($('dubVolume'));
  $('bedVolume').value = s.bedVolume;
  $('bedVolumeVal').textContent = (+s.bedVolume).toFixed(2);
  fillSlider($('bedVolume'));

  $('subtitlesOn').checked = s.subtitlesOn === true;
  $('subtitlesEnOn').checked = s.subtitlesEnOn !== false;
  $('subtitlePosition').value = s.subtitlePosition;
  $('subtitleSize').value = s.subtitleSize;
  $('subtitleColor').value = s.subtitleColor;
  await loadVoiceOptions(s);
}

async function loadVoiceOptions(settings) {
  const select = $('popupVoice');
  const status = $('popupVoiceStatus');
  const res = await chrome.runtime.sendMessage({
    type: 'FETCH_TTS_VOICES',
    serverUrl: settings.serverUrl || 'http://127.0.0.1:18765',
    serverApiKey: settings.serverApiKey || '',
    timeoutMs: 15000,
  }).catch((error) => ({ ok: false, error: error.message }));
  if (!res.ok) {
    select.innerHTML = '<option value="">Không tải được danh sách giọng</option>';
    status.textContent = 'Lỗi: ' + res.error;
    status.className = 'status-sm err';
    return;
  }
  select.innerHTML = '<option value="">Mặc định của server</option>';
  res.voices.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.id;
    option.textContent = voice.label || voice.id;
    select.appendChild(option);
  });
  select.value = settings.voice || '';
  status.textContent = `${res.voices.length} giọng sẵn sàng.`;
  status.className = 'status-sm ok';
}

async function savePopup() {
  const button = $('btnSavePopup');
  button.disabled = true;
  try {
    await saveFields({
      dubVolume: +$('dubVolume').value,
      bedVolume: +$('bedVolume').value,
      subtitlesOn: $('subtitlesOn').checked,
      subtitlesEnOn: $('subtitlesEnOn').checked,
      subtitlePosition: $('subtitlePosition').value,
      subtitleSize: $('subtitleSize').value,
      subtitleColor: $('subtitleColor').value,
      voice: $('popupVoice').value,
    });
    dirty = false;
    button.textContent = 'Đã lưu thay đổi';
    $('popupSaveStatus').textContent = 'Đã lưu. Tải lại tab video để áp dụng cỡ chữ hoặc giọng mới.';
    $('popupSaveStatus').className = 'status-sm ok';
    setTimeout(() => { button.textContent = 'Lưu thay đổi'; }, 2200);
  } finally {
    button.disabled = false;
  }
}

$('bedVolume').addEventListener('input', (e) => {
  $('bedVolumeVal').textContent = (+e.target.value).toFixed(2);
  fillSlider(e.target);
  markDirty();
});

$('dubVolume').addEventListener('input', (e) => {
  $('dubVolumeVal').textContent = (+e.target.value).toFixed(2);
  fillSlider(e.target);
  markDirty();
});
$('subtitlesOn').addEventListener('change', markDirty);
$('subtitlesEnOn').addEventListener('change', markDirty);
$('subtitlePosition').addEventListener('change', markDirty);
$('subtitleSize').addEventListener('change', markDirty);
$('subtitleColor').addEventListener('change', markDirty);
$('popupVoice').addEventListener('change', markDirty);

$('btnResetSubPos').addEventListener('click', async () => {
  await saveFields({ subtitleOffsetX: 0, subtitleOffsetY: 0 });
  const btn = $('btnResetSubPos');
  const original = btn.textContent;
  btn.textContent = 'Đã đặt lại — tải lại tab video để thấy';
  $('popupSaveStatus').textContent = 'Đã đặt lại vị trí phụ đề.';
  $('popupSaveStatus').className = 'status-sm ok';
  setTimeout(() => { btn.textContent = original; }, 2500);
});
$('btnSavePopup').addEventListener('click', savePopup);

const SUPPORTED_TAB_URLS = ['https://www.coursera.org/*', 'https://www.youtube.com/*'];
const SUPPORTED_PAGE_RE = /^https:\/\/(www\.coursera\.org\/learn\/|www\.youtube\.com\/watch)/;

async function onClearCache() {
  const status = $('cacheStatus');
  const tabs = await chrome.tabs.query({ url: SUPPORTED_TAB_URLS });
  if (!tabs.length) { setStatus(status, 'Mở một tab Coursera hoặc YouTube rồi thử lại (cache lưu theo trang).', false); return; }
  let cleared = 0;
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => new Promise((resolve) => {
          const req = indexedDB.deleteDatabase('local-ai-vi-dub');
          req.onsuccess = () => resolve(true);
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        }),
      });
      cleared++;
    } catch (e) { /* tab có thể không cho inject (chrome://, extension page...) — bỏ qua */ }
  }
  setStatus(status, `Đã xoá cache trên ${cleared}/${tabs.length} tab đang mở.`, cleared > 0);
}
$('btnClearCache').addEventListener('click', onClearCache);

$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function main() {
  await loadControls();

  const statusEl = $('status');
  const stored = await chrome.storage.local.get('settings');
  const s = stored.settings || {};

  const missing = [];
  if (!s.geminiApiKey) missing.push('Gemini API key');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSupportedPage = tab && SUPPORTED_PAGE_RE.test(tab.url || '');

  if (missing.length) {
    statusEl.textContent = 'Chưa cấu hình: ' + missing.join(', ') + '. Mở Cài đặt để thiết lập.';
    statusEl.className = 'status err';
  } else if (!onSupportedPage) {
    statusEl.textContent = 'Đã cấu hình. Mở một bài giảng Coursera hoặc video YouTube để dùng.';
    statusEl.className = 'status ok';
  } else {
    statusEl.textContent = 'Sẵn sàng — bấm nút Thuyết minh tiếng Việt nổi trên video.';
    statusEl.className = 'status ok';
  }

  const server = await chrome.runtime.sendMessage({
    type: 'CHECK_TTS_SERVER', serverUrl: s.serverUrl || 'http://127.0.0.1:18765', serverApiKey: s.serverApiKey || '',
  }).catch(() => ({ ok: false }));
  const d = (server.ok && server.data) || {};
  const serverEl = document.createElement('div');
  let text, ok;
  if (!server.ok) { text = 'TTS server: chưa kết nối được — xem server/README.md'; ok = false; }
  else if (d.status === 'loading') { text = 'TTS server: đang tải model, chờ chút...'; ok = false; }
  else if (d.status === 'error') { text = 'TTS server: lỗi nạp model — ' + (d.error || '?'); ok = false; }
  else { text = 'TTS server: sẵn sàng'; ok = true; }
  serverEl.className = 'status ' + (ok ? 'ok' : 'err');
  serverEl.textContent = text;
  statusEl.after(serverEl);
}

main();
