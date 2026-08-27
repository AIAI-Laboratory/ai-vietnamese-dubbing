/**
 * Trang Cài đặt — CHỈ cấu hình API dịch và giọng đọc (TTS server + giọng +
 * hiệu chỉnh đồng bộ). Âm lượng, phụ đề (song ngữ/vị trí/cỡ/màu) và cache
 * chỉnh trong popup icon extension — xem popup/popup.js — vì đó là những
 * thứ người dùng muốn đổi nhanh, không phải cấu hình một lần rồi để đó như
 * API key/model.
 *
 * Lưu vào chrome.storage.local dưới key "settings". QUAN TRỌNG: settings là
 * MỘT object dùng chung với popup.js. save() ở đây phải đọc bản hiện có rồi
 * chỉ ghi đè đúng các trường trang này quản — ghi nguyên object mới từ đầu
 * (như code cũ) sẽ xoá mất mọi thứ popup.js vừa lưu.
 *
 * Chỉ hai lời gọi mạng: API dịch (mục 1, bắt buộc, người dùng tự cấu hình)
 * và TTS server local (mục 2, chạy trên chính máy này — xem server/README.md).
 *
 * Base URL API dịch là tuỳ người dùng nhập nên KHÔNG khai báo sẵn quyền cho
 * mọi origin trong manifest (sẽ rất rộng, đáng ngại lúc cài đặt). Thay vào
 * đó xin quyền đúng origin đó ngay khi bấm nút liên quan — chuẩn
 * optional_host_permissions của MV3.
 */

const DEFAULTS = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  sendSystemRole: true,
  timeoutMs: 30000,

  serverUrl: "http://127.0.0.1:18765",
  serverApiKey: "",
  voice: "",

  viSyllablesPerSec: 3.0,
  planVersion: "v1",
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Giao diện sáng/tối — lưu vào localStorage (KHÔNG chrome.storage.local):
// cần đọc được đồng bộ ngay trong script chặn ở <head>, trước khi CSS áp
// dụng, mới tránh được việc nhấp nháy sáng->tối. Cùng origin extension nên
// popup.html đọc lại đúng giá trị này.
// ---------------------------------------------------------------------------

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
      /* private mode — chấp nhận không nhớ được */
    }
  } else {
    document.documentElement.dataset.theme = choice;
    try {
      localStorage.setItem(THEME_KEY, choice);
    } catch (e) {
      /* private mode — chấp nhận không nhớ được */
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

// ---------------------------------------------------------------------------
// Tab điều hướng (sidebar) — "Dịch" / "Giọng đọc". Không lưu lựa chọn, luôn
// mở lại ở tab đầu khi mở trang — đây chỉ là cách nhóm hiển thị, không phải
// trạng thái cấu hình.
// ---------------------------------------------------------------------------

const TAB_META = {
  "tab-translate": {
    title: "Dịch",
    sub: "Tương thích OpenAI — dùng được với OpenAI, Gemini, Groq hoặc endpoint riêng của bạn.",
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

function currentConfig() {
  return {
    baseUrl: $("apiBaseUrl").value.trim() || DEFAULTS.apiBaseUrl,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    sendSystemRole: DEFAULTS.sendSystemRole,
    timeoutMs: DEFAULTS.timeoutMs,
  };
}

function originPatternFor(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol + "//" + u.hostname + "/*";
  } catch (e) {
    return null;
  }
}

async function ensureOriginPermission(urlStr) {
  const pattern = originPatternFor(urlStr);
  if (!pattern) throw new Error("Base URL không hợp lệ");
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

async function load() {
  const stored = await chrome.storage.local.get("settings");
  const s = { ...DEFAULTS, ...(stored.settings || {}) };
  $("apiBaseUrl").value = s.apiBaseUrl;
  $("apiKey").value = s.apiKey;
  $("model").value = s.model;

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

  onCheckServer(); // tự kiểm tra ngay khi mở trang, không bắt bấm tay
}

/** Đọc bản settings hiện có rồi chỉ ghi đè các trường trang này quản — không
 * tự bịa nguyên object mới, sẽ xoá mất phần popup.js đang giữ (âm lượng,
 * phụ đề, cache...). */
async function save() {
  const stored = await chrome.storage.local.get("settings");
  const settings = {
    ...(stored.settings || {}),
    apiBaseUrl: $("apiBaseUrl").value.trim() || DEFAULTS.apiBaseUrl,
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim(),
    sendSystemRole: DEFAULTS.sendSystemRole,
    timeoutMs: DEFAULTS.timeoutMs,

    serverUrl: $("serverUrl").value.trim() || DEFAULTS.serverUrl,
    serverApiKey: $("serverApiKey").value.trim(),
    voice: $("voice").value,

    viSyllablesPerSec:
      +$("viSyllablesPerSec").value || DEFAULTS.viSyllablesPerSec,
    planVersion: DEFAULTS.planVersion,
  };
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
    " " +
    (ok ? "ok" : "err");
}

async function onLoadModels() {
  const cfg = currentConfig();
  const status = $("apiStatus");
  setStatus(status, "Đang xin quyền truy cập " + cfg.baseUrl + " ...", true);
  const granted = await ensureOriginPermission(cfg.baseUrl).catch((e) => {
    setStatus(status, "Lỗi quyền: " + e.message, false);
    return false;
  });
  if (!granted) {
    setStatus(status, "Cần cấp quyền để gọi API này.", false);
    return;
  }

  setStatus(status, "Đang tải danh sách model...", true);
  const res = await chrome.runtime.sendMessage({
    type: "FETCH_MODELS",
    config: cfg,
  });
  if (!res.ok) {
    setStatus(status, "Lỗi: " + res.error, false);
    return;
  }

  const sel = $("modelList");
  sel.innerHTML = '<option value="">— chọn model —</option>';
  res.models.forEach((id) => {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  });
  setStatus(status, `Tải được ${res.models.length} model.`, true);
}

async function onTestModel() {
  const cfg = currentConfig();
  if (!cfg.model) {
    setStatus($("apiStatus"), "Chưa nhập tên model.", false);
    return;
  }
  const status = $("apiStatus");
  setStatus(status, "Đang xin quyền...", true);
  const granted = await ensureOriginPermission(cfg.baseUrl).catch((e) => {
    setStatus(status, "Lỗi quyền: " + e.message, false);
    return false;
  });
  if (!granted) {
    setStatus(status, "Cần cấp quyền để gọi API này.", false);
    return;
  }

  setStatus(status, "Đang gọi model...", true);
  const res = await chrome.runtime.sendMessage({
    type: "TEST_MODEL",
    config: cfg,
  });
  if (!res.ok) {
    setStatus(status, "Lỗi: " + res.error, false);
    return;
  }
  setStatus(status, 'OK — model trả lời: "' + res.reply + '"', true);
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
    // res.error là network error (server chưa chạy/URL sai) hoặc HTTP lỗi
    // thật (buildErrorDetail đã rút gọn) — 401 nghĩa là thiếu/sai API key,
    // không phải "server chưa chạy" như thông báo chung chung trước đây.
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
  const mockNote = d.mock
    ? " — CHẾ ĐỘ MOCK (âm thanh giả để test luồng, chưa phải giọng thật)"
    : "";
  setStatus(status, `Sẵn sàng — model: ${d.model || "?"}${mockNote}`, !d.mock);
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

// Nghe thử theo giọng — cache lại kết quả để bấm lại cùng giọng phát ngay,
// không tổng hợp lại (đổi giọng khác vẫn phải chờ tổng hợp thật lần đầu).
const previewCache = new Map(); // voice -> {base64, mime}

function playPreviewBase64(base64, mime) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  const blob = new Blob([arr], { type: mime || "audio/wav" });
  const audio = $("previewAudio");
  audio.hidden = false;
  audio.src = URL.createObjectURL(blob);
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
$("btnLoadModels").addEventListener("click", onLoadModels);
$("btnTestModel").addEventListener("click", onTestModel);
$("btnCheckServer").addEventListener("click", onCheckServer);
$("btnLoadVoices").addEventListener("click", onLoadVoices);
$("btnPreviewVoice").addEventListener("click", onPreviewVoice);
$("modelList").addEventListener("change", (e) => {
  if (e.target.value) $("model").value = e.target.value;
});

load();
