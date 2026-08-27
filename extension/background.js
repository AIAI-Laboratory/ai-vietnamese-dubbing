/**
 * Service worker — điều phối job lồng tiếng:
 *   plan (lib/plan.js) -> dịch qua LLM API (OpenAI-compatible) -> gửi sang
 *   TTS server (server/, http://127.0.0.1:18765 mặc định) -> trả audio về
 *   content script qua Port.
 *
 * Chỉ hai lời gọi mạng từ EXTENSION: API dịch (bắt buộc, do người dùng cấu
 * hình) và TTS server trên chính máy này. Audio/video không bao giờ rời
 * máy. TTS server tự gọi thêm một mạng thứ ba: gTTS gửi văn bản đã dịch ra
 * ngoài để đọc (xem server/README.md mục "gTTS").
 *
 * Không dùng "type":"module" trong manifest nên nạp lib bằng importScripts —
 * đúng chuẩn MV3 cho service worker cổ điển, không cần build step.
 */
importScripts('lib/vtt.js', 'lib/glossary.js', 'lib/plan.js');

const DEFAULT_SETTINGS = {
  // Dịch — theo đúng pattern OpenAI-compatible: base URL + API key + model.
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  timeoutMs: 30000,
  sendSystemRole: true,

  // TTS server (server/, xem server/README.md) — serverApiKey BẮT BUỘC:
  // server từ chối khởi động nếu chưa đặt API_KEY, nên mọi request đều cần
  // đúng key đó (đọc trong server/.env), không có kiểu "để trống được".
  serverUrl: 'http://127.0.0.1:18765',
  serverApiKey: '',
  voice: '',

  // Hiệu chỉnh sync — đo thật, không phải giá trị mượn.
  // gTTS đo được 3.0-3.036 âm tiết/giây (đo trên 2 job thật, xem server/README.md).
  viSyllablesPerSec: 3.0,

  planVersion: 'v1',
};

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TRANSLATE_MAX_TOKENS = 6000;
const TRANSLATE_CHUNK_SIZE = 25;
// Số chunk dịch chạy song song. Cao hơn = nhanh hơn nhưng dễ dính 429 rate
// limit (Gemini free tier ~10 request/phút). 429 có retry backoff nhưng chậm.
const TRANSLATE_CONCURRENCY = 4;

/** Log vào console của service worker: chrome://extensions -> "service worker". */
function log(...args) { console.log('[dub]', ...args); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// ---------------------------------------------------------------------------
// Client OpenAI-compatible — cùng pattern base URL/apiKey/model/retry như
// công cụ prompt_optimizer đã dùng: POST {baseUrl}/chat/completions,
// Authorization: Bearer <key>, JSON qua payload.choices[0].message.content.
// ---------------------------------------------------------------------------

/** Rút gọn thông báo lỗi HTTP — hiểu cả 2 format hay gặp: OpenAI-style
 * {"error":{"message"}} (API dịch) và FastAPI-style {"detail"} (TTS server,
 * dùng cho lỗi thiếu/sai X-API-Key). Không khớp cái nào thì in nguyên văn. */
function buildErrorDetail(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && parsed.error && parsed.error.message) return `HTTP ${status}: ${parsed.error.message}`;
    if (parsed && typeof parsed.detail === 'string') return `HTTP ${status}: ${parsed.detail}`;
  } catch (e) { /* không phải JSON, dùng nguyên văn */ }
  const trimmed = rawBody.trim();
  return trimmed ? `HTTP ${status}: ${trimmed.slice(0, 300)}` : `HTTP ${status}`;
}

async function chatComplete({ apiBaseUrl, apiKey, model, timeoutMs, sendSystemRole }, systemPrompt, userPrompt) {
  const url = apiBaseUrl.replace(/\/+$/, '') + '/chat/completions';
  const messages = sendSystemRole !== false
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
    : [{ role: 'user', content: systemPrompt + '\n\n---\n\n' + userPrompt }];

  const body = JSON.stringify({ model, messages, temperature: 0.3, max_tokens: TRANSLATE_MAX_TOKENS });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('Hết thời gian chờ API dịch (timeout)');
      throw new Error('Lỗi mạng khi gọi API dịch: ' + (e && e.message ? e.message : String(e)));
    }
    clearTimeout(timer);

    if (res.ok) {
      const raw = await res.text();
      let payload;
      try { payload = JSON.parse(raw); } catch (e) { throw new Error('Phản hồi API dịch không phải JSON: ' + raw.slice(0, 200)); }
      if (payload.error && payload.error.message) throw new Error('API dịch báo lỗi: ' + payload.error.message);
      const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
      if (typeof content !== 'string' || !content.length) throw new Error('API dịch trả về rỗng (thiếu content)');
      return content;
    }

    const errBody = await res.text().catch(() => '');
    const detail = buildErrorDetail(res.status, errBody);
    lastErr = new Error(detail);
    if (res.status === 401) throw new Error('API key sai hoặc hết hạn — ' + detail);
    if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) throw lastErr;
    console.warn(`[dub] API dịch lỗi (lần ${attempt}/${MAX_ATTEMPTS}): ${detail} — thử lại sau ${2 ** (attempt - 1)}s`);
    await sleep(1000 * 2 ** (attempt - 1));
  }
  throw lastErr || new Error('Gọi API dịch thất bại không rõ lý do');
}

async function fetchModels({ baseUrl, apiKey, timeoutMs }) {
  const url = baseUrl.replace(/\/+$/, '') + '/models';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  let res;
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(buildErrorDetail(res.status, await res.text().catch(() => '')));
  const payload = await res.json();
  const ids = (payload.data || []).map((m) => m.id).filter((id) => typeof id === 'string');
  return ids.sort();
}

async function testModel({ baseUrl, apiKey, model, timeoutMs }) {
  const content = await chatComplete(
    { apiBaseUrl: baseUrl, apiKey, model, timeoutMs: timeoutMs || 15000, sendSystemRole: false },
    'Trả lời đúng một từ: OK', 'OK'
  );
  return content.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// Dịch toàn bộ plan — chia chunk để tránh phản hồi quá dài bị cắt cụt; các
// chunk chạy song song (TRANSLATE_CONCURRENCY) để rút ngắn thời gian chờ.
// ---------------------------------------------------------------------------

async function translatePlan(plan, settings, onProgress) {
  const system = DUB.plan.buildTranslateSystemPrompt(settings.viSyllablesPerSec);
  const chunks = DUB.plan.chunkSegments(plan.segments, TRANSLATE_CHUNK_SIZE);
  const results = new Array(chunks.length);
  const workers = Math.min(TRANSLATE_CONCURRENCY, chunks.length);
  const t0 = Date.now();
  let cursor = 0;
  let doneCount = 0;

  log(`dịch ${plan.segments.length} câu — ${chunks.length} chunk x ${TRANSLATE_CHUNK_SIZE} câu, ${workers} luồng song song`);

  // Mỗi worker tự bốc chunk kế tiếp thay vì chia đều trước: một chunk chậm
  // không chặn worker khác, tổng thời gian bám chunk chậm nhất chứ không cộng dồn.
  async function worker() {
    for (let i = cursor++; i < chunks.length; i = cursor++) {
      const segs = chunks[i].map((g) => ({ ...g, __rate: settings.viSyllablesPerSec }));
      const user = DUB.plan.buildTranslateUserPrompt(segs);
      const t = Date.now();
      log(`chunk ${i + 1}/${chunks.length} gửi đi — ${segs.length} câu, ${user.length} ký tự`);
      const raw = await chatComplete(settings, system, user);
      const parsed = DUB.plan.parseTranslationResponse(raw);
      results[i] = parsed;
      doneCount += parsed.length;
      log(`chunk ${i + 1}/${chunks.length} xong sau ${Date.now() - t}ms — nhận ${parsed.length}/${segs.length} câu`);
      if (parsed.length < segs.length) {
        const missing = segs.map((g) => g.id).filter((id) => !parsed.some((r) => r.id === id));
        console.warn(`[dub] chunk ${i + 1} thiếu ${missing.length} câu — id:`, missing);
      }
      if (onProgress) onProgress(doneCount, plan.segments.length);
    }
  }

  // Promise.all: worker đầu tiên ném lỗi thì cả translatePlan ném theo, giống
  // hành vi cũ — không nuốt lỗi, job dừng chứ không trả bản dịch thiếu.
  await Promise.all(Array.from({ length: workers }, worker));

  const all = results.flat();
  log(`dịch xong ${all.length}/${plan.segments.length} câu trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return all;
}

// ---------------------------------------------------------------------------
// TTS server local — hợp đồng API mô tả trong server/README.md. Server chỉ
// đòi hỏi header X-API-Key khi tự bật biến môi trường API_KEY (mặc định
// không) — apiKey rỗng thì authHeaders() trả object rỗng, không đổi hành
// vi so với trước khi có tính năng này.
// ---------------------------------------------------------------------------

function authHeaders(apiKey) {
  return apiKey ? { 'X-API-Key': apiKey } : {};
}

async function fetchVoices(serverUrl, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  let res;
  try {
    res = await fetch(serverUrl.replace(/\/+$/, '') + '/api/voices', {
      signal: controller.signal, headers: authHeaders(apiKey),
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(buildErrorDetail(res.status, await res.text().catch(() => '')));
  const data = await res.json();
  return data.voices || [];
}

/** Nghe thử nhanh một câu — POST /api/preview, trả thẳng WAV, không qua job queue. */
async function previewVoice(serverUrl, apiKey, text, voice, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  let res;
  try {
    res = await fetch(serverUrl.replace(/\/+$/, '') + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ text, voice }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('Hết thời gian chờ tổng hợp giọng (timeout)');
    throw new Error('Lỗi mạng khi gọi TTS server: ' + (e && e.message ? e.message : String(e)));
  }
  clearTimeout(timer);
  if (!res.ok) throw new Error(buildErrorDetail(res.status, await res.text().catch(() => '')));
  const mime = res.headers.get('content-type') || 'audio/wav';
  const buf = await res.arrayBuffer();
  return { base64: arrayBufferToBase64(buf), mime };
}

async function ttsSynthesize(plan, translated, settings) {
  const byId = new Map(translated.map((r) => [r.id, r.vi]));
  const segments = plan.segments.map((g) => ({ id: g.id, start: g.start, end: g.end, vi: byId.get(g.id) || '' }));
  const url = settings.serverUrl.replace(/\/+$/, '') + '/api/synthesize';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(settings.serverApiKey) },
    body: JSON.stringify({ voice: settings.voice, durationSec: plan.videoDuration, segments }),
  });
  if (!res.ok) throw new Error('TTS server từ chối yêu cầu: ' + buildErrorDetail(res.status, await res.text().catch(() => '')));
  const data = await res.json();
  if (!data.jobId) throw new Error('TTS server không trả jobId');
  return data.jobId;
}

/** "125.4" -> "2m05s"; "8.3" -> "8.3s" — khớp _fmt_dur() bên server.py, cùng định dạng ETA hai phía. */
function formatDur(sec) {
  sec = Math.max(0, sec || 0);
  if (sec >= 60) return `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
  return `${sec.toFixed(1)}s`;
}

async function ttsPoll(jobId, settings, onProgress) {
  const url = settings.serverUrl.replace(/\/+$/, '') + '/api/job/' + jobId;
  for (;;) {
    const res = await fetch(url, { headers: authHeaders(settings.serverApiKey) });
    if (!res.ok) throw new Error('Không lấy được trạng thái job TTS: ' + buildErrorDetail(res.status, await res.text().catch(() => '')));
    const data = await res.json();
    if (onProgress) onProgress(data);
    if (data.status === 'done') return data;
    if (data.status === 'error') throw new Error('TTS server báo lỗi: ' + (data.error || 'không rõ nguyên nhân'));
    await sleep(700);
  }
}

/** Câu trạng thái cho panel — có ETA thật (server đo được) thì dùng, chưa có (vài trăm ms đầu job) thì lùi về câu chung chung. */
function synthesizeNote(data) {
  if (typeof data.doneSegments === 'number' && typeof data.totalSegments === 'number') {
    const eta = typeof data.etaSec === 'number' ? `, còn ~${formatDur(data.etaSec)}` : '';
    return `Đang tổng hợp giọng đọc — ${data.doneSegments}/${data.totalSegments} câu${eta}`;
  }
  return 'Đang tổng hợp giọng đọc...';
}

function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function fetchAudioAsBase64(audioUrl, serverBaseUrl, apiKey) {
  const full = /^https?:\/\//i.test(audioUrl) ? audioUrl : serverBaseUrl.replace(/\/+$/, '') + audioUrl;
  const res = await fetch(full, { headers: authHeaders(apiKey) });
  if (!res.ok) throw new Error('Không tải được audio từ TTS server: HTTP ' + res.status);
  const mime = res.headers.get('content-type') || 'audio/opus';
  const buf = await res.arrayBuffer();
  return { base64: arrayBufferToBase64(buf), mime };
}

// ---------------------------------------------------------------------------
// Điều phối job qua Port — giữ service worker sống nhờ fetch liên tục trong
// lúc chạy; job cho một bài giảng vài chục phút vẫn hoàn tất trong một lượt.
// ---------------------------------------------------------------------------

function post(port, type, data) {
  try { port.postMessage({ type, ...data }); } catch (e) { /* port đã đóng, bỏ qua */ }
}

async function runJob(msg, port) {
  const settings = await loadSettings();
  if (!settings.apiKey) throw new Error('Chưa cấu hình API key trong Cài đặt extension');
  if (!settings.model) throw new Error('Chưa chọn model dịch trong Cài đặt extension');

  const tJob = Date.now();
  post(port, 'PROGRESS', { stage: 'plan', pct: 5, note: 'Đang dựng timeline...' });
  const plan = DUB.plan.buildPlan(msg.cues, msg.durationSec, { viSyllablesPerSec: settings.viSyllablesPerSec });
  log(`plan: ${msg.cues.length} cue -> ${plan.segments.length} câu | video ${msg.durationSec}s | model=${settings.model}`);

  post(port, 'PROGRESS', { stage: 'translate', pct: 12, note: `Đang dịch ${plan.segments.length} câu...` });
  const translated = await translatePlan(plan, settings, (done, total) => {
    post(port, 'PROGRESS', { stage: 'translate', pct: 12 + Math.round((done / total) * 38), note: `Dịch ${done}/${total} câu` });
  });

  const verify = DUB.plan.verifyPlan(plan, translated, settings.viSyllablesPerSec);
  log(`verify: ${verify.overflowCount}/${verify.total} câu vượt hạn mức âm tiết`);
  if (verify.overflowCount > 0) {
    post(port, 'PROGRESS', {
      stage: 'translate', pct: 52,
      note: `${verify.overflowCount} câu vượt hạn mức — sẽ tự động cắt bớt khi ghép audio`,
    });
  }

  const subtitles = plan.segments.map((s) => {
    const vi = translated.find((t) => t.id === s.id);
    return { id: s.id, start: s.start, end: s.end, vi: vi ? vi.vi : '', en: s.en || '' };
  });

  post(port, 'PROGRESS', { stage: 'synthesize', pct: 55, note: 'Đang gửi tới TTS server...' });
  const tTts = Date.now();
  const jobId = await ttsSynthesize(plan, translated, settings);
  log(`TTS job ${jobId} — đang tổng hợp ${plan.segments.length} câu...`);
  const done = await ttsPoll(jobId, settings, (data) => {
    const p = typeof data.progress === 'number' ? data.progress : 0;
    post(port, 'PROGRESS', { stage: 'synthesize', pct: 55 + Math.round(p * 40), note: synthesizeNote(data) });
  });
  log(`TTS xong sau ${((Date.now() - tTts) / 1000).toFixed(1)}s`);
  post(port, 'PROGRESS', { stage: 'packaging', pct: 97, note: 'Đang đóng gói audio...' });
  const { base64, mime } = await fetchAudioAsBase64(done.audioUrl, settings.serverUrl, settings.serverApiKey);

  post(port, 'DONE', {
    plan, translated, verify, subtitles,
    audioBase64: base64, audioMime: mime,
    measuredSyllablesPerSec: done.measuredSyllablesPerSec || null,
  });
  log(`job xong toàn bộ sau ${((Date.now() - tJob) / 1000).toFixed(1)}s`);
}

/** Chạy lại chỉ bước tổng hợp giọng, dùng bản dịch đã có (đổi giọng, không tốn lượt gọi LLM). */
async function runResynth(msg, port) {
  const settings = await loadSettings();
  const subtitles = msg.plan.segments.map((s) => {
    const vi = msg.translated.find((t) => t.id === s.id);
    return { id: s.id, start: s.start, end: s.end, vi: vi ? vi.vi : '', en: s.en || '' };
  });

  post(port, 'PROGRESS', { stage: 'synthesize', pct: 10, note: 'Đang tổng hợp lại với giọng mới...' });
  const jobId = await ttsSynthesize(msg.plan, msg.translated, { ...settings, voice: msg.voice || settings.voice });
  const done = await ttsPoll(jobId, settings, (data) => {
    const p = typeof data.progress === 'number' ? data.progress : 0;
    post(port, 'PROGRESS', { stage: 'synthesize', pct: 10 + Math.round(p * 85), note: synthesizeNote(data) });
  });
  const { base64, mime } = await fetchAudioAsBase64(done.audioUrl, settings.serverUrl, settings.serverApiKey);
  post(port, 'DONE', { plan: msg.plan, translated: msg.translated, subtitles, audioBase64: base64, audioMime: mime });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dub-job') return;
  port.onMessage.addListener((msg) => {
    const handler = msg.type === 'RESYNTH' ? runResynth : msg.type === 'START' ? runJob : null;
    if (!handler) return;
    handler(msg, port).catch((err) => {
      post(port, 'ERROR', { message: (err && err.message) ? err.message : String(err) });
    });
  });
});

// ---------------------------------------------------------------------------
// Messages một-lượt cho trang Options: kiểm thử/nạp danh sách model dịch,
// xin quyền origin cho base URL tuỳ ý người dùng nhập
// (optional_host_permissions), kiểm tra/nạp danh sách giọng của TTS server.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FETCH_MODELS') {
    fetchModels(msg.config).then((models) => sendResponse({ ok: true, models }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'TEST_MODEL') {
    testModel(msg.config).then((reply) => sendResponse({ ok: true, reply }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CHECK_TTS_SERVER') {
    (async () => {
      try {
        const r = await fetch(msg.serverUrl.replace(/\/+$/, '') + '/api/health', { headers: authHeaders(msg.serverApiKey) });
        const text = await r.text();
        if (!r.ok) { sendResponse({ ok: false, error: buildErrorDetail(r.status, text) }); return; }
        sendResponse({ ok: true, data: JSON.parse(text) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'FETCH_TTS_VOICES') {
    fetchVoices(msg.serverUrl, msg.serverApiKey, msg.timeoutMs).then((voices) => sendResponse({ ok: true, voices }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'TTS_PREVIEW_LOCAL') {
    previewVoice(msg.serverUrl, msg.serverApiKey, msg.text, msg.voice, msg.timeoutMs)
      .then(({ base64, mime }) => sendResponse({ ok: true, base64, mime }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});
