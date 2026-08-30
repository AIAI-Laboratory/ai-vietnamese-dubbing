/**
 * Service worker — điều phối job lồng tiếng:
 *   plan (lib/plan.js) -> dịch qua Gemini API chính thức -> gửi sang
 *   TTS server (server/, http://127.0.0.1:18765 mặc định) -> trả audio về
 *   content script qua Port.
 *
 * Extension chỉ gọi API dịch do người dùng cấu hình và TTS server trên
 * chính máy này. Kokoro chạy local; audio/video và bản dịch không được gửi
 * tới dịch vụ giọng nói bên ngoài.
 *
 * Không dùng "type":"module" trong manifest nên nạp lib bằng importScripts —
 * đúng chuẩn MV3 cho service worker cổ điển, không cần build step.
 */
importScripts('lib/vtt.js', 'lib/plan.js');

const DEFAULT_SETTINGS = {
  // Dịch qua Gemini API chính thức. Model cố định để tối ưu độ ổn định/quota.
  geminiApiKey: '',
  timeoutMs: 30000,

  // TTS server (server/, xem server/README.md) — serverApiKey BẮT BUỘC:
  // server từ chối khởi động nếu chưa đặt API_KEY, nên mọi request đều cần
  // đúng key đó (đọc trong server/.env), không có kiểu "để trống được".
  serverUrl: 'http://127.0.0.1:18765',
  serverApiKey: '',
  voice: '',

  // Baseline ban đầu của giọng Kokoro mặc định; sau mỗi job, tốc độ server
  // đo được sẽ kéo giá trị này về đúng giọng đang dùng (xem calibrateRate).
  viSyllablesPerSec: 3.8,

  planVersion: 'gemini-v2',
};

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const TRANSLATE_MAX_TOKENS = 2400;
const TRANSLATE_CHUNK_SIZE = 25;
// Tuần tự để tương thích các gói có TPM thấp; mỗi request vẫn hoàn tất nhanh.
const TRANSLATE_CONCURRENCY = 1;
let apiCooldownUntil = 0;

/** Log vào console của service worker: chrome://extensions -> "service worker". */
function log(...args) { console.log('[dub]', ...args); }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function outputTokenBudget(rows, floor = 500, ceiling = TRANSLATE_MAX_TOKENS) {
  const syllables = rows.reduce((sum, row) => sum + Number(row.budget && row.budget.max || row.max || 0), 0);
  return Math.min(ceiling, Math.max(floor, syllables * 2 + 120));
}

function reviewTokenBudget(rows, floor = 400, ceiling = 1200) {
  const characters = rows.reduce((sum, row) => sum + String(row.vi || row.en || '').length, 0);
  return Math.min(ceiling, Math.max(floor, Math.ceil(characters / 3) + 160));
}

function retryDelayMs(response, rawBody, fallbackMs) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(fallbackMs, seconds * 1000 + 500);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(fallbackMs, timestamp - Date.now() + 500);
  }
  const match = String(rawBody).match(/(?:try again|retry) in\s+([\d.]+)\s*(ms|s)|retryDelay["\s:]+["']?([\d.]+)s/i);
  if (!match) return fallbackMs;
  const amount = Number(match[1] || match[3]);
  const unit = match[2] || 's';
  return Math.max(fallbackMs, amount * (unit.toLowerCase() === 'ms' ? 1 : 1000) + 500);
}

async function waitForApiCooldown() {
  const remaining = apiCooldownUntil - Date.now();
  if (remaining > 0) await sleep(remaining);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  let changed = false;
  if (settings.planVersion !== DEFAULT_SETTINGS.planVersion) {
    settings.planVersion = DEFAULT_SETTINGS.planVersion;
    settings.viSyllablesPerSec = DEFAULT_SETTINGS.viSyllablesPerSec;
    if (settings.voice === 'vi') settings.voice = '';
    delete settings.apiBaseUrl;
    delete settings.apiKey;
    delete settings.model;
    delete settings.reviewModel;
    delete settings.sendSystemRole;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ settings });
  return settings;
}

// ---------------------------------------------------------------------------
// Gemini API chính thức: POST models/{model}:generateContent?key=...
// ---------------------------------------------------------------------------

/** Rút gọn lỗi Gemini/FastAPI về thông báo đủ ngắn cho UI. */
function buildErrorDetail(status, rawBody) {
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && parsed.error && parsed.error.message) return `HTTP ${status}: ${parsed.error.message}`;
    if (parsed && typeof parsed.detail === 'string') return `HTTP ${status}: ${parsed.detail}`;
  } catch (e) { /* không phải JSON, dùng nguyên văn */ }
  const trimmed = rawBody.trim();
  return trimmed ? `HTTP ${status}: ${trimmed.slice(0, 300)}` : `HTTP ${status}`;
}

function logGeminiTest(level, message, data) {
  const logger = console[level] || console.log;
  logger(`[dub] Gemini test ${message}`, data);
}

function responsePreview(raw) {
  return String(raw).slice(0, 4000);
}

function geminiText(payload) {
  const candidate = payload.candidates && payload.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  return Array.isArray(parts)
    ? parts.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('')
    : '';
}

async function chatComplete({ geminiApiKey, timeoutMs }, systemPrompt, userPrompt, maxTokens = TRANSLATE_MAX_TOKENS, options = {}) {
  const url = `${GEMINI_API_ROOT}/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(geminiApiKey)}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
    },
  });

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForApiCooldown();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const detail = e && e.name === 'AbortError'
        ? 'Hết thời gian chờ API dịch (timeout)'
        : 'Lỗi mạng khi gọi API dịch: ' + (e && e.message ? e.message : String(e));
      if (options.debugLabel) {
        logGeminiTest('error', 'network failure', { model: GEMINI_MODEL, attempt, error: detail });
      }
      throw new Error(detail);
    }
    clearTimeout(timer);

    if (res.ok) {
      const raw = await res.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        if (options.debugLabel) {
          logGeminiTest('error', 'non-JSON response', {
            model: GEMINI_MODEL, attempt, status: res.status, response: responsePreview(raw),
          });
        }
        throw new Error('Phản hồi API dịch không phải JSON: ' + raw.slice(0, 200));
      }
      if (payload.error && payload.error.message) {
        if (options.debugLabel) {
          logGeminiTest('error', 'error payload with HTTP 2xx', {
            model: GEMINI_MODEL, attempt, status: res.status, response: payload,
          });
        }
        throw new Error('API dịch báo lỗi: ' + payload.error.message);
      }
      const content = geminiText(payload);
      if (typeof content !== 'string' || !content.length) {
        if (options.debugLabel) {
          logGeminiTest('error', 'missing candidate content', {
            model: GEMINI_MODEL, attempt, status: res.status, response: payload,
          });
        }
        throw new Error('API dịch trả về rỗng (thiếu content)');
      }
      if (options.debugLabel) {
        logGeminiTest('log', 'completed', {
          model: GEMINI_MODEL, attempt, status: res.status, content, response: payload,
        });
      }
      return content;
    }

    const errBody = await res.text().catch(() => '');
    const detail = buildErrorDetail(res.status, errBody);
    lastErr = new Error(detail);
    if (options.debugLabel) {
      logGeminiTest('error', 'HTTP failure', {
        model: GEMINI_MODEL, attempt, status: res.status, response: responsePreview(errBody),
      });
    }
    if (res.status === 401 || res.status === 403) throw new Error('Gemini API key sai, bị hạn chế hoặc hết hạn — ' + detail);
    if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) throw lastErr;
    const fallbackMs = 1000 * 2 ** (attempt - 1) + Math.round(Math.random() * 400);
    const delayMs = retryDelayMs(res, errBody, fallbackMs);
    if (res.status === 429) apiCooldownUntil = Math.max(apiCooldownUntil, Date.now() + delayMs);
    const label = res.status === 429 ? 'API dịch chạm rate limit' : 'API dịch lỗi tạm thời';
    console.warn(`[dub] ${label} (lần ${attempt}/${MAX_ATTEMPTS}): ${detail} — chờ ${(delayMs / 1000).toFixed(1)}s`);
    await sleep(delayMs);
  }
  throw lastErr || new Error('Gọi API dịch thất bại không rõ lý do');
}

async function testGemini({ geminiApiKey, timeoutMs }) {
  const config = { geminiApiKey, timeoutMs: timeoutMs || 15000 };
  try {
    const content = await chatComplete(
      config,
      'Chỉ trả JSON object {"ok":true}.',
      'Kiểm tra kết nối Gemini.',
      32,
      { debugLabel: 'manual' },
    );
    const parsed = DUB.plan.extractJson(content);
    if (!parsed || parsed.ok !== true) throw new Error('Gemini không trả JSON kiểm tra hợp lệ');
    return GEMINI_MODEL;
  } catch (error) {
    logGeminiTest('error', 'failed', {
      model: GEMINI_MODEL, error: error && error.message ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Dịch toàn bộ plan — chia chunk để tránh phản hồi quá dài bị cắt cụt. Số
// worker mặc định là 1 để không vượt TPM của các gói API thấp.
// ---------------------------------------------------------------------------

async function analyzeTerminology(plan, settings) {
  let terminology;
  try {
    const raw = await chatComplete(
      settings,
      DUB.plan.buildTerminologySystemPrompt(),
      DUB.plan.buildTerminologyUserPrompt(plan.segments),
      700,
    );
    terminology = DUB.plan.parseTerminologyResponse(raw);
  } catch (firstError) {
    const raw = await chatComplete(
      settings,
      DUB.plan.buildTerminologySystemPrompt(),
      DUB.plan.buildTerminologyRetryUserPrompt(plan.segments),
      450,
    );
    try {
      terminology = DUB.plan.parseTerminologyResponse(raw);
    } catch (secondError) {
      throw new Error(`Glossary không hợp lệ sau 2 lần thử: ${secondError.message}; lần đầu: ${firstError.message}`);
    }
  }
  const transcript = plan.segments.map((segment) => segment.en).join(' ').toLocaleLowerCase('en');
  return {
    subject: terminology.subject,
    terms: terminology.terms.filter((term) => transcript.includes(term.source.toLocaleLowerCase('en'))),
  };
}

async function reviewTerminology(terminology, settings) {
  const raw = await chatComplete(
    settings,
    DUB.plan.buildTerminologyReviewSystemPrompt(),
    DUB.plan.buildTerminologyReviewUserPrompt(terminology),
    700,
  );
  return DUB.plan.parseTerminologyResponse(raw);
}

async function translatePlan(plan, settings, terminology, onProgress) {
  const system = DUB.plan.buildTranslateSystemPrompt(settings.viSyllablesPerSec, terminology);
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
      const raw = await chatComplete(settings, system, user, outputTokenBudget(segs, 600));
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

  // Worker đầu tiên ném lỗi thì toàn bộ job dừng, không cache kết quả thiếu.
  await Promise.all(Array.from({ length: workers }, worker));

  const all = results.flat();
  const expectedIds = new Set(plan.segments.map((segment) => segment.id));
  const returnedIds = all.map((segment) => segment.id);
  const missingIds = [...expectedIds].filter((id) => !returnedIds.includes(id));
  const invalidIds = returnedIds.filter((id) => !expectedIds.has(id));
  const duplicateIds = returnedIds.filter((id, index) => returnedIds.indexOf(id) !== index);
  if (missingIds.length || invalidIds.length || duplicateIds.length) {
    throw new Error(
      `Bản dịch không đầy đủ (thiếu: ${missingIds.join(', ') || 'không'}; ` +
      `sai ID: ${invalidIds.join(', ') || 'không'}; trùng: ${duplicateIds.join(', ') || 'không'})`,
    );
  }
  log(`dịch xong ${all.length}/${plan.segments.length} câu trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return all;
}

async function reviewTranslations(plan, translated, settings, terminology, onProgress) {
  const sourceById = new Map(plan.segments.map((segment) => [segment.id, segment]));
  const rows = translated.map((segment) => ({
    id: segment.id,
    en: sourceById.get(segment.id).en,
    vi: segment.vi,
    max: sourceById.get(segment.id).budget.max,
  }));
  const chunks = DUB.plan.chunkSegments(rows, TRANSLATE_CHUNK_SIZE);
  const reviewed = new Map();
  let cursor = 0;
  let done = 0;

  async function worker() {
    for (let index = cursor++; index < chunks.length; index = cursor++) {
      const raw = await chatComplete(
        settings,
        DUB.plan.buildReviewSystemPrompt(settings.viSyllablesPerSec, terminology),
        DUB.plan.buildReviewUserPrompt(chunks[index]),
        reviewTokenBudget(chunks[index]),
      );
      const parsed = DUB.plan.parseTranslationResponse(raw);
      const expectedIds = new Set(chunks[index].map((row) => row.id));
      for (const segment of parsed) {
        if (expectedIds.has(segment.id) && segment.vi.trim()) reviewed.set(segment.id, segment.vi.trim());
      }
      done++;
      if (onProgress) onProgress(done, chunks.length);
    }
  }

  const workerCount = Math.min(TRANSLATE_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, worker));

  return translated.map((segment) => (
    reviewed.has(segment.id) ? { ...segment, vi: reviewed.get(segment.id) } : segment
  ));
}

async function enforceKeptTerms(plan, translated, settings, terminology) {
  const keptTerms = (terminology.terms || []).filter((term) => term.action === 'keep');
  if (!keptTerms.length) return translated;

  const sourceById = new Map(plan.segments.map((segment) => [segment.id, segment]));
  const rows = translated.map((segment) => {
    const source = sourceById.get(segment.id);
    const required = keptTerms.filter((term) => (
      source.en.toLocaleLowerCase('en').includes(term.source.toLocaleLowerCase('en'))
      && !segment.vi.toLocaleLowerCase('en').includes(term.target.toLocaleLowerCase('en'))
    ));
    return required.length ? {
      id: segment.id,
      en: source.en,
      vi: segment.vi,
      max: source.budget.max,
      required,
    } : null;
  }).filter(Boolean);
  if (!rows.length) return translated;

  const terms = [...new Map(rows.flatMap((row) => row.required).map((term) => [term.source, term])).values()];
  const raw = await chatComplete(
    settings,
    DUB.plan.buildReviewSystemPrompt(settings.viSyllablesPerSec, terminology),
    DUB.plan.buildGlossaryCompliancePrompt(rows, terms),
    reviewTokenBudget(rows, 400, 1000),
  );
  const replacements = new Map(DUB.plan.parseTranslationResponse(raw).map((segment) => [segment.id, segment.vi]));
  return translated.map((segment) => (
    replacements.has(segment.id) ? { ...segment, vi: replacements.get(segment.id) } : segment
  ));
}

async function compactOverflowTranslations(plan, translated, settings, terminology) {
  const verification = DUB.plan.verifyPlan(plan, translated, settings.viSyllablesPerSec);
  const overflow = verification.rows.filter((row) => row.status === 'VƯỢT');
  if (!overflow.length) return translated;

  const byId = new Map(plan.segments.map((segment) => [segment.id, segment]));
  const rows = overflow.map((row) => ({
    id: row.id,
    en: row.en,
    vi: row.vi,
    max: byId.get(row.id).budget.max,
  }));
  const raw = await chatComplete(
    settings,
    DUB.plan.buildTranslateSystemPrompt(settings.viSyllablesPerSec, terminology),
    DUB.plan.buildCompactUserPrompt(rows),
    outputTokenBudget(rows, 300, 1600),
  );
  const compacted = DUB.plan.parseTranslationResponse(raw);
  const originalById = new Map(translated.map((segment) => [segment.id, segment.vi]));
  const replacements = new Map(compacted
    .filter((segment) => {
      const original = originalById.get(segment.id);
      return original && DUB.plan.countViSyllables(segment.vi) < DUB.plan.countViSyllables(original);
    })
    .map((segment) => [segment.id, segment.vi]));
  return translated.map((segment) => (
    replacements.has(segment.id) ? { ...segment, vi: replacements.get(segment.id) } : segment
  ));
}

// ---------------------------------------------------------------------------
// TTS server local — hợp đồng API mô tả trong server/README.md.
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

async function saveDebugTranscript(settings, payload) {
  const url = settings.serverUrl.replace(/\/+$/, '') + '/api/debug/transcript';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(settings.serverApiKey) },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(buildErrorDetail(res.status, await res.text().catch(() => '')));
  }
  return res.json();
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
  if (!settings.geminiApiKey) throw new Error('Chưa cấu hình Gemini API key trong Cài đặt extension');
  const reviewerSettings = settings;

  const tJob = Date.now();
  post(port, 'PROGRESS', { stage: 'plan', pct: 5, note: 'Đang dựng timeline...' });
  const plan = DUB.plan.buildPlan(msg.cues, msg.durationSec, { viSyllablesPerSec: settings.viSyllablesPerSec });
  log(`plan: ${msg.cues.length} cue -> ${plan.segments.length} câu | video ${msg.durationSec}s | model=${GEMINI_MODEL}`);

  let terminologyDraft = { subject: '', terms: [] };
  let terminology = terminologyDraft;
  let terminologyError = '';
  let terminologyReviewError = '';
  post(port, 'PROGRESS', { stage: 'terminology', pct: 8, note: 'Đang phân tích lĩnh vực và thuật ngữ...' });
  try {
    terminologyDraft = await analyzeTerminology(plan, settings);
    terminology = terminologyDraft;
    post(port, 'PROGRESS', { stage: 'terminology', pct: 10, note: 'Đang kiểm định thuật ngữ chuyên ngành...' });
    try {
      terminology = await reviewTerminology(terminologyDraft, reviewerSettings);
    } catch (error) {
      terminologyReviewError = error && error.message ? error.message : String(error);
      console.warn('[dub] không kiểm định lại được glossary, dùng bản phân tích đầu:', error);
    }
    log(`thuật ngữ: lĩnh vực=${terminology.subject || '?'} | ${terminology.terms.length} mục`);
  } catch (error) {
    terminologyError = error && error.message ? error.message : String(error);
    console.warn('[dub] không tạo được glossary riêng, dùng quy tắc nền:', error);
  }

  post(port, 'PROGRESS', { stage: 'translate', pct: 12, note: `Đang dịch ${plan.segments.length} câu...` });
  let translated;
  let draftTranslation = [];
  let reviewedTranslation = [];
  try {
    translated = await translatePlan(plan, settings, terminology, (done, total) => {
      post(port, 'PROGRESS', { stage: 'translate', pct: 12 + Math.round((done / total) * 38), note: `Dịch ${done}/${total} câu` });
    });
    draftTranslation = translated.map((segment) => ({ ...segment }));
    post(port, 'PROGRESS', { stage: 'review', pct: 49, note: 'Đang đối chiếu bản dịch với câu gốc...' });
    try {
      translated = await reviewTranslations(plan, translated, reviewerSettings, terminology, (done, total) => {
        post(port, 'PROGRESS', { stage: 'review', pct: 49 + Math.round((done / total) * 3), note: `Đang review bản dịch ${done}/${total}...` });
      });
    } catch (error) {
      console.warn('[dub] review bản dịch thất bại, giữ bản dịch đầu:', error);
    }
    try {
      translated = await enforceKeptTerms(plan, translated, reviewerSettings, terminology);
    } catch (error) {
      console.warn('[dub] không khôi phục được canonical term, giữ bản review:', error);
    }
    reviewedTranslation = translated.map((segment) => ({ ...segment }));

    const beforeCompact = DUB.plan.verifyPlan(plan, translated, settings.viSyllablesPerSec).overflowCount;
    if (beforeCompact > 0) {
      post(port, 'PROGRESS', { stage: 'translate', pct: 51, note: `Đang rút gọn ${beforeCompact} câu dài...` });
      try {
        translated = await compactOverflowTranslations(plan, translated, settings, terminology);
      } catch (error) {
        console.warn('[dub] không rút gọn lại được câu dài, giữ bản dịch đầu:', error);
      }
    }
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    throw new Error('API dịch thất bại: ' + detail);
  }

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

  post(port, 'PROGRESS', { stage: 'debug', pct: 53, note: 'Đang lưu transcript debug...' });
  try {
    const debug = await saveDebugTranscript(settings, {
      videoId: msg.videoId,
      model: GEMINI_MODEL,
      reviewModel: GEMINI_MODEL,
      apiBaseUrl: GEMINI_API_ROOT,
      durationSec: msg.durationSec,
      planVersion: settings.planVersion,
      viSyllablesPerSec: settings.viSyllablesPerSec,
      sourceCues: msg.cues,
      plan,
      terminologyDraft,
      terminology,
      terminologyError,
      terminologyReviewError,
      draftTranslation,
      reviewedTranslation,
      finalTranslation: translated,
      verification: verify,
    });
    log(`transcript debug: ${debug.path} | tự xoá sau ${debug.retentionDays} ngày`);
  } catch (error) {
    console.warn('[dub] không lưu được transcript debug, job vẫn tiếp tục:', error);
  }

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
    plan, terminology, translated, verify, subtitles,
    audioBase64: base64, audioMime: mime,
    measuredSyllablesPerSec: done.measuredSyllablesPerSec || null,
  });
  await calibrateRate(settings, done.measuredSyllablesPerSec);
  log(`job xong toàn bộ sau ${((Date.now() - tJob) / 1000).toFixed(1)}s`);
}

/**
 * Kéo viSyllablesPerSec về tốc độ đọc thật mà server vừa đo. Không có bước
 * này thì baseline đứng yên mãi: hạn mức âm tiết sai, bản dịch bị ép ngắn
 * hơn mức audio chứa được, và verifyPlan báo "vượt" cho những câu vốn vừa.
 */
async function calibrateRate(settings, measured) {
  const next = DUB.plan.nextCalibratedRate(settings.viSyllablesPerSec, measured);
  if (next === settings.viSyllablesPerSec) return;
  try {
    const stored = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...(stored.settings || {}), viSyllablesPerSec: next },
    });
    log(`hiệu chỉnh tốc độ đọc: ${settings.viSyllablesPerSec} -> ${next} âm tiết/giây (đo được ${measured})`);
  } catch (error) {
    console.warn('[dub] không lưu được tốc độ đọc đã hiệu chỉnh:', error);
  }
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
// Messages một-lượt cho trang Options, content script và TTS server.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_CONTENT_SETTINGS') {
    loadSettings().then((settings) => {
      const { geminiApiKey, ...contentSettings } = settings;
      sendResponse({ ok: true, settings: contentSettings });
    })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (msg.type === 'PATCH_CONTENT_SETTINGS') {
    (async () => {
      try {
        const current = await loadSettings();
        const requestedPatch = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
        const allowedKeys = ['subtitlesOn', 'subtitleOffsetX', 'subtitleOffsetY', 'voice'];
        const patch = Object.fromEntries(
          Object.entries(requestedPatch).filter(([key]) => allowedKeys.includes(key)),
        );
        const settings = { ...current, ...patch };
        await chrome.storage.local.set({ settings });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  }
  if (msg.type === 'TEST_GEMINI') {
    testGemini(msg.config).then((model) => sendResponse({ ok: true, model }))
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
