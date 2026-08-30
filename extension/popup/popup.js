/**
 * Popup icon extension — nơi chỉnh nhanh mọi thứ TRỪ API dịch/giọng đọc
 * (Gemini API key và giọng đọc nằm ở trang Cài đặt, xem options/options.js). Đổi ở đây áp
 * dụng ngay cho lần mở/tải lại tab Coursera kế tiếp — content script chỉ
 * đọc settings lúc trang tải, không có kênh đẩy live vào tab đang mở.
 *
 * QUAN TRỌNG: settings là MỘT object dùng chung với options.js. save()
 * dưới đây đọc bản hiện có rồi chỉ ghi đè đúng các trường popup quản —
 * không tự bịa nguyên object mới, sẽ xoá mất API key/model options.js giữ.
 */

const DEFAULTS = {
  dubVolume: 1.0,
  subtitlesOn: false,
  subtitlesEnOn: true,
  subtitlePosition: 'bottom',
  subtitleSize: 'medium',
  subtitleColor: 'white-black',
  subtitleOffsetX: 0,
  subtitleOffsetY: 0,
};

const $ = (id) => document.getElementById(id);

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

/** Đọc bản hiện có, ghi đè đúng field trong `patch`, lưu lại nguyên object —
 * giữ Gemini API key/giọng của options.js an toàn. */
async function saveFields(patch) {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...(stored.settings || {}), ...patch };
  await chrome.storage.local.set({ settings });
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

  $('subtitlesOn').checked = s.subtitlesOn === true;
  $('subtitlesEnOn').checked = s.subtitlesEnOn !== false;
  $('subtitlePosition').value = s.subtitlePosition;
  $('subtitleSize').value = s.subtitleSize;
  $('subtitleColor').value = s.subtitleColor;
}

// Âm lượng: lưu ngay khi kéo (input), không đợi thả chuột — cùng lúc cập
// nhật số hiển thị + thanh trượt tô màu.
$('dubVolume').addEventListener('input', (e) => {
  $('dubVolumeVal').textContent = (+e.target.value).toFixed(2);
  fillSlider(e.target);
  saveFields({ dubVolume: +e.target.value });
});
$('subtitlesOn').addEventListener('change', (e) => saveFields({ subtitlesOn: e.target.checked }));
$('subtitlesEnOn').addEventListener('change', (e) => saveFields({ subtitlesEnOn: e.target.checked }));
$('subtitlePosition').addEventListener('change', (e) => saveFields({ subtitlePosition: e.target.value }));
$('subtitleSize').addEventListener('change', (e) => saveFields({ subtitleSize: e.target.value }));
$('subtitleColor').addEventListener('change', (e) => saveFields({ subtitleColor: e.target.value }));

$('btnResetSubPos').addEventListener('click', async () => {
  await saveFields({ subtitleOffsetX: 0, subtitleOffsetY: 0 });
  const btn = $('btnResetSubPos');
  const original = btn.textContent;
  btn.textContent = 'Đã đặt lại — tải lại tab Coursera để thấy';
  setTimeout(() => { btn.textContent = original; }, 2500);
});

async function onClearCache() {
  const status = $('cacheStatus');
  const tabs = await chrome.tabs.query({ url: 'https://www.coursera.org/*' });
  if (!tabs.length) { setStatus(status, 'Mở một tab Coursera rồi thử lại (cache lưu theo trang).', false); return; }
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
  setStatus(status, `Đã xoá cache trên ${cleared}/${tabs.length} tab Coursera đang mở.`, cleared > 0);
}
$('btnClearCache').addEventListener('click', onClearCache);

$('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// Trạng thái cấu hình + TTS server — giữ nguyên hành vi cũ, chỉ dời xuống
// dưới các control mới thêm.
// ---------------------------------------------------------------------------

async function main() {
  await loadControls();

  const statusEl = $('status');
  const stored = await chrome.storage.local.get('settings');
  const s = stored.settings || {};

  const missing = [];
  if (!s.geminiApiKey) missing.push('Gemini API key');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onCoursera = tab && /^https:\/\/www\.coursera\.org\/learn\//.test(tab.url || '');

  if (missing.length) {
    statusEl.textContent = 'Chưa cấu hình: ' + missing.join(', ') + '. Mở Cài đặt để thiết lập.';
    statusEl.className = 'status err';
  } else if (!onCoursera) {
    statusEl.textContent = 'Đã cấu hình. Mở một bài giảng Coursera để dùng.';
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
