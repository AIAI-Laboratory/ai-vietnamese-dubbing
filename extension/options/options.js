/** Trang Cài đặt — CHỈ cấu hình Gemini API và giọng đọc (TTS server + giọng + hiệu chỉnh đồng bộ). */

const DEFAULTS = {
  geminiApiKey: "",
  timeoutMs: 30000,

  serverUrl: "http://127.0.0.1:18765",
  serverApiKey: "",
  voice: "",

  viSyllablesPerSec: 3.8,
  planVersion: "gemini-v2",
};

const $ = (id) => document.getElementById(id);

const THEME_KEY = "ldub-theme";

function currentThemeChoice() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch (e) {
    return "system";
  }
}

function applyTheme(choice) {
  if (choice === "system") {
    delete document.documentElement.dataset.theme;
    try {
      localStorage.removeItem(THEME_KEY);
    } catch (e) {
    }
  } else {
    document.documentElement.dataset.theme = choice;
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch (e) {
    }
  }
  document.querySelectorAll("#themeSwitch button").forEach((b) => {
    b.classList.toggle("active", b.dataset.themeChoice === choice);
  });
}

document.querySelectorAll("#themeSwitch button").forEach((b) => {
  b.addEventListener("click", () => applyTheme(b.dataset.themeChoice));
});
applyTheme(currentThemeChoice());

const TAB_META = {
  "tab-translate": {
    title: "Dịch",
    sub: "Gemini API chính thức, chỉ cần một API key.",
  },
  "tab-voice": {
    title: "Giọng đọc",
    sub: "Server TTS chạy trên máy bạn (hoặc VPS riêng) — cấu hình địa chỉ, API key và giọng.",
  },
};

function switchTab(tabId) {
  document
    .querySelectorAll(".nav-item")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  document
    .querySelectorAll(".tab-panel")
    .forEach((p) => p.classList.toggle("active", p.id === tabId));
  const meta = TAB_META[tabId];
  if (meta) {
    $("contentTitle").textContent = meta.title;
    $("contentSub").textContent = meta.sub;
  }
}

document.querySelectorAll(".nav-item").forEach((b) => {
  b.addEventListener("click", () => switchTab(b.dataset.tab));
});

function currentGeminiConfig() {
  return {
    geminiApiKey: $("geminiApiKey").value.trim(),
    timeoutMs: DEFAULTS.timeoutMs,
  };
}

let loadedSyllableRate = "";

async function load() {
  const stored = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(stored.settings || {}) };
  if (s.planVersion !== DEFAULTS.planVersion) {
    s.planVersion = DEFAULTS.planVersion;
    s.viSyllablesPerSec = DEFAULTS.viSyllablesPerSec;
    if (s.voice === "vi") s.voice = "";
  }
  if (!s.geminiApiKey) s.geminiApiKey = "";
  delete s.apiBaseUrl;
  delete s.apiKey;
  delete s.model;
  delete s.reviewModel;
  delete s.sendSystemRole;
  await chrome.storage.local.set({ settings: s });
  $("geminiApiKey").value = s.geminiApiKey;

  $("serverUrl").value = s.serverUrl;
  $("serverApiKey").value = s.serverApiKey || "";
  if (s.voice) {
    const opt = document.createElement("option");
    opt.value = s.voice;
    opt.textContent = s.voice;
    $("voice").appendChild(opt);
    $("voice").value = s.voice;
  }

  $("viSyllablesPerSec").value = s.viSyllablesPerSec;
  loadedSyllableRate = String(s.viSyllablesPerSec);

  onCheckServer();
}

/** Đọc bản settings hiện có rồi chỉ ghi đè các trường trang này quản — không tự bịa nguyên object mới, sẽ xoá mất phần popup.js đang giữ (âm lượng, phụ đề, cache...). */
async function save() {
  const stored = await chrome.storage.local.get("settings");
  const settings = {
    ...(stored.settings || {}),
    geminiApiKey: $("geminiApiKey").value.trim(),
    timeoutMs: DEFAULTS.timeoutMs,

    serverUrl: $("serverUrl").value.trim() || DEFAULTS.serverUrl,
    serverApiKey: $("serverApiKey").value.trim(),
    voice: $("voice").value,

    planVersion: DEFAULTS.planVersion,
  };
  const typedRate = $("viSyllablesPerSec").value;
  if (typedRate !== loadedSyllableRate) {
    settings.viSyllablesPerSec = +typedRate || DEFAULTS.viSyllablesPerSec;
    loadedSyllableRate = typedRate;
  }
  delete settings.apiBaseUrl;
  delete settings.apiKey;
  delete settings.model;
  delete settings.reviewModel;
  delete settings.sendSystemRole;
  await chrome.storage.local.set({ settings });
  $("saveStatus").textContent = "Đã lưu.";
  $("saveStatus").className = "status ok";
  setTimeout(() => {
    $("saveStatus").textContent = "";
  }, 2500);
}

function setStatus(el, text, ok) {
  el.textContent = text;
  el.className =
    el.className.replace(/\bok\b|\berr\b/g, "").trim() +
    (ok === true ? " ok" : ok === false ? " err" : "");
}

async function onTestGemini() {
  const cfg = currentGeminiConfig();
  if (!cfg.geminiApiKey) {
    setStatus($("apiStatus"), "Chưa nhập Gemini API key.", false);
    return;
  }
  const status = $("apiStatus");
  const button = $("btnTestGemini");
  button.disabled = true;
  setStatus(status, "Đang kiểm tra Gemini API key...", null);
  try {
    const res = await chrome.runtime.sendMessage({
      type: "TEST_GEMINI",
      config: cfg,
    });
    if (!res || !res.ok) {
      setStatus(status, "Lỗi: " + ((res && res.error) || "Không nhận được phản hồi"), false);
    } else {
      setStatus(status, `Sẵn sàng — ${res.model}.`, true);
    }
  } catch (error) {
    setStatus(status, "Lỗi mạng: " + (error.message || String(error)), false);
  } finally {
    button.disabled = false;
  }
}

async function onCheckServer() {
  const status = $("serverStatus");
  const serverUrl = $("serverUrl").value.trim() || DEFAULTS.serverUrl;
  const serverApiKey = $("serverApiKey").value.trim();
  setStatus(status, "Đang kiểm tra...", true);
  const res = await chrome.runtime.sendMessage({
    type: "CHECK_TTS_SERVER",
    serverUrl,
    serverApiKey,
  });
  if (!res.ok) {
    const is401 = /HTTP 401/.test(res.error || "");
    setStatus(
      status,
      is401
        ? 'Sai hoặc thiếu API key — điền đúng giá trị API_KEY của server vào ô "API key" bên dưới rồi kiểm tra lại.'
        : "Chưa kết nối được — server đã chạy chưa? (" +
            (res.error || "không rõ lỗi") +
            ") Xem server/README.md.",
      false,
    );
    return;
  }
  const d = res.data || {};
  if (d.status === "loading") {
    setStatus(
      status,
      "Server đã chạy, đang tải model (lần đầu có thể mất vài chục phút) — chờ chút rồi bấm Kiểm tra lại.",
      false,
    );
    return;
  }
  if (d.status === "error") {
    setStatus(
      status,
      "Server báo lỗi khi nạp model: " + (d.error || "?"),
      false,
    );
    return;
  }
  setStatus(status, `Sẵn sàng — model: ${d.model || "?"}`, true);
}

async function onLoadVoices() {
  const status = $("serverStatus");
  const serverUrl = $("serverUrl").value.trim() || DEFAULTS.serverUrl;
  const serverApiKey = $("serverApiKey").value.trim();
  setStatus(status, "Đang tải danh sách giọng...", true);
  const res = await chrome.runtime.sendMessage({
    type: "FETCH_TTS_VOICES",
    serverUrl,
    serverApiKey,
    timeoutMs: 15000,
  });
  if (!res.ok) {
    setStatus(status, "Lỗi tải giọng: " + res.error, false);
    return;
  }

  const sel = $("voice");
  const prev = sel.value;
  sel.innerHTML = "";
  res.voices.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.label || v.id;
    sel.appendChild(opt);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  setStatus(status, `Tìm thấy ${res.voices.length} giọng.`, true);
}

const previewCache = new Map();

function playPreviewBase64(base64, mime) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: mime || "audio/wav" });
  const audio = $("previewAudio");
  audio.hidden = false;
  if (audio.dataset.blobUrl) URL.revokeObjectURL(audio.dataset.blobUrl);
  const url = URL.createObjectURL(blob);
  audio.dataset.blobUrl = url;
  audio.src = url;
  audio.play();
}

async function onPreviewVoice() {
  const status = $("previewStatus");
  const voice = $("voice").value;

  const cached = previewCache.get(voice);
  if (cached) {
    playPreviewBase64(cached.base64, cached.mime);
    setStatus(
      status,
      "Đang phát (đã nhớ từ lần trước, không tổng hợp lại).",
      true,
    );
    return;
  }

  const serverUrl = $("serverUrl").value.trim() || DEFAULTS.serverUrl;
  const serverApiKey = $("serverApiKey").value.trim();
  setStatus(status, "Đang tổng hợp câu mẫu...", true);
  const res = await chrome.runtime.sendMessage({
    type: "TTS_PREVIEW_LOCAL",
    serverUrl,
    serverApiKey,
    voice,
    timeoutMs: 30000,
    text: "Xin chào, đây là giọng đọc thử cho video bài giảng tiếng Việt.",
  });
  if (!res.ok) {
    setStatus(status, "Lỗi: " + res.error, false);
    return;
  }

  previewCache.set(voice, { base64: res.base64, mime: res.mime });
  playPreviewBase64(res.base64, res.mime);
  setStatus(status, "Xong — đang phát.", true);
}

$("btnSave").addEventListener("click", save);
$("btnTestGemini").addEventListener("click", onTestGemini);
$("btnCheckServer").addEventListener("click", onCheckServer);
$("btnLoadVoices").addEventListener("click", onLoadVoices);
$("btnPreviewVoice").addEventListener("click", onPreviewVoice);

load();
