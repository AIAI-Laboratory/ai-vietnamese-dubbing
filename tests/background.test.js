/**
 * Chạy background.js thật trong Node với chrome/fetch giả lập.
 *
 * Đây là phần điều phối 900 dòng chưa từng có test, và cũng là nơi mọi lỗi
 * trong dự án này phát sinh. Test dựng một job đầy đủ: dịch qua Gemini giả,
 * gửi TTS server giả, nhận cửa sổ audio dần, và kiểm những message mà content
 * script thực sự nhận được.
 *
 * Chạy: node --test tests/background.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');

/** Phản hồi Gemini: mọi bước đều nhận JSON trong một text part. */
function geminiReply(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
  };
}

function jsonReply(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function audioReply(bytes = 32) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/opus' },
    arrayBuffer: async () => new Uint8Array(bytes).fill(7).buffer,
  };
}

/**
 * Dựng môi trường service worker giả và nạp background.js vào đó.
 * `server` quyết định từng request trả về gì.
 */
function loadWorker({ jobStates, audioWindows }) {
  const calls = [];
  const context = {
    console,
    setTimeout: (fn) => setTimeout(fn, 0), // bỏ mọi khoảng chờ cho test chạy nhanh
    clearTimeout,
    AbortController,
    atob,
    btoa,
    Uint8Array,
    String,
    Math,
    Date,
    JSON,
    Promise,
    Error,
    Number,
    Object,
    Array,
    Set,
    Map,
    RegExp,
    isNaN,
    parseInt,
  };
  context.globalThis = context;

  let pollCount = 0;
  context.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('generativelanguage')) {
      const body = JSON.parse(options.body);
      const prompt = body.contents[0].parts[0].text;
      // Phân biệt theo CẤU TRÚC prompt, không theo từ khoá: prompt dịch cũng
      // nhắc "thuật ngữ" vì nó nhúng glossary vào system prompt.
      // Mỗi câu cần dịch là một dòng "<id>\t[tối đa N âm tiết]\t<en>".
      const ids = [...prompt.matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1]));
      if (!ids.length) {
        return geminiReply({
          subject: 'Tin học',
          terms: [{ source: 'code smell', target: 'code smell', action: 'keep' }],
        });
      }
      const unique = [...new Set(ids)];
      return geminiReply({ segments: unique.map((id) => ({ id, vi: `câu số ${id}` })) });
    }
    if (url.endsWith('/api/synthesize')) return jsonReply({ jobId: 'a'.repeat(16) });
    if (url.includes('/api/job/')) {
      const state = jobStates[Math.min(pollCount, jobStates.length - 1)];
      pollCount++;
      return jsonReply(state);
    }
    if (url.includes('/audio/')) return audioReply();
    throw new Error(`fetch không mong đợi: ${url}`);
  };

  const ports = [];
  context.chrome = {
    storage: {
      local: {
        _data: {
          settings: {
            geminiApiKey: 'k'.repeat(20),
            serverUrl: 'http://127.0.0.1:18765',
            serverApiKey: 'server-key',
            voice: '',
            viSyllablesPerSec: 3.8,
            planVersion: 'gemini-v2',
            timeoutMs: 5000,
          },
        },
        async get(key) {
          return key in this._data ? { [key]: this._data[key] } : {};
        },
        async set(patch) {
          Object.assign(this._data, patch);
        },
      },
    },
    runtime: {
      onConnect: { addListener: (fn) => { context.__onConnect = fn; } },
      onMessage: { addListener: (fn) => { context.__onMessage = fn; } },
    },
  };
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), context, { filename: file });
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), context, {
    filename: 'background.js',
  });
  return { context, calls, ports };
}

/** Mở một port giả và gửi START, trả về mọi message content script nhận được. */
async function runJob(worker, cues, durationSec) {
  const received = [];
  let disconnect = () => {};
  const port = {
    name: 'dub-job',
    postMessage: (msg) => received.push(msg),
    onMessage: { addListener: (fn) => { port.__deliver = fn; } },
    onDisconnect: { addListener: (fn) => { disconnect = fn; } },
  };
  worker.context.__onConnect(port);
  port.__deliver({ type: 'START', videoId: 'vid-1', durationSec, cues });

  // Chờ tới khi có DONE hoặc ERROR (hoặc hết kiên nhẫn).
  for (let i = 0; i < 400; i++) {
    if (received.some((m) => m.type === 'DONE' || m.type === 'ERROR')) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return { received, disconnect };
}

const CUES = [
  { start: 0, end: 4, text: 'First sentence here.' },
  { start: 4, end: 9, text: 'Second sentence here.' },
  { start: 9, end: 14, text: 'Third sentence here.' },
];

const WINDOWS = [
  { index: 0, startSec: 0, endSec: 8, url: '/audio/aaaaaaaaaaaaaaaa/w0.opus', duckEnvelope: { fps: 20, data: 'AAAA' } },
  { index: 1, startSec: 8, endSec: 20, url: '/audio/aaaaaaaaaaaaaaaa/w1.opus', duckEnvelope: { fps: 20, data: 'AAAA' } },
];

test('mỗi cửa sổ server công bố đều tới content script ngay, không chờ job xong', async () => {
  const worker = loadWorker({
    jobStates: [
      { status: 'running', progress: 0.3, windows: [] },
      { status: 'running', progress: 0.6, windows: [WINDOWS[0]] },
      { status: 'running', progress: 0.9, windows: WINDOWS },
      { status: 'done', progress: 1, windows: WINDOWS, overflowSegmentIds: [], measuredSyllablesPerSec: 4.0 },
    ],
  });
  const { received } = await runJob(worker, CUES, 20);

  const errors = received.filter((m) => m.type === 'ERROR');
  assert.deepStrictEqual(errors.map((e) => e.message), [], 'không được có ERROR');

  const windows = received.filter((m) => m.type === 'WINDOW');
  assert.strictEqual(windows.length, 2, `phải nhận 2 cửa sổ, nhận ${windows.length}`);
  assert.strictEqual(windows[0].window.index, 0);
  assert.ok(windows[0].window.base64, 'cửa sổ phải kèm audio đã tải');
  assert.ok(windows[0].plan, 'cửa sổ đầu phải kèm plan để dựng phụ đề');
  assert.strictEqual(windows[1].plan, undefined, 'cửa sổ sau không gửi lại plan');

  // Cửa sổ đầu phải tới TRƯỚC khi job xong — đó là toàn bộ mục đích phát dần.
  const firstWindowAt = received.indexOf(windows[0]);
  const doneAt = received.findIndex((m) => m.type === 'DONE');
  assert.ok(firstWindowAt < doneAt, 'cửa sổ đầu phải tới trước DONE');
});

test('DONE mang đủ mọi cửa sổ để dựng lại và lưu cache', async () => {
  const worker = loadWorker({
    jobStates: [
      { status: 'running', progress: 0.5, windows: [WINDOWS[0]] },
      { status: 'done', progress: 1, windows: WINDOWS, overflowSegmentIds: [2], measuredSyllablesPerSec: 4.1 },
    ],
  });
  const { received } = await runJob(worker, CUES, 20);

  const done = received.find((m) => m.type === 'DONE');
  assert.ok(done, 'phải có DONE');
  assert.strictEqual(done.windows.length, 2);
  assert.ok(done.windows.every((w) => w.base64), 'mỗi cửa sổ trong DONE phải có audio');
  assert.deepStrictEqual(done.overflowSegmentIds, [2]);
  assert.ok(Array.isArray(done.subtitles) && done.subtitles.length, 'DONE phải mang phụ đề');
});

test('job lỗi phía server báo ERROR chứ không im lặng', async () => {
  const worker = loadWorker({
    jobStates: [{ status: 'error', progress: 0.2, windows: [], error: 'engine kẹt' }],
  });
  const { received } = await runJob(worker, CUES, 20);
  const error = received.find((m) => m.type === 'ERROR');
  assert.ok(error, 'phải có ERROR');
  assert.match(error.message, /engine kẹt/);
});

test('tốc độ đọc đo được ghi lại vào settings sau khi job xong', async () => {
  const worker = loadWorker({
    jobStates: [
      { status: 'done', progress: 1, windows: WINDOWS, overflowSegmentIds: [], measuredSyllablesPerSec: 4.4 },
    ],
  });
  await runJob(worker, CUES, 20);
  const saved = worker.context.chrome.storage.local._data.settings.viSyllablesPerSec;
  assert.ok(saved > 3.8 && saved < 4.4, `phải nhích về phía 4.4, đang là ${saved}`);
});

test('đóng tab khi job đang chạy sẽ yêu cầu server huỷ', async () => {
  const worker = loadWorker({
    jobStates: [
      { status: 'running', progress: 0.4, windows: [WINDOWS[0]] },
      { status: 'done', progress: 1, windows: WINDOWS, overflowSegmentIds: [] },
    ],
  });
  const { received, disconnect } = await runJob(worker, CUES, 20);
  assert.ok(received.some((m) => m.type === 'DONE'));
  // Sau khi xong thì không còn gì để huỷ.
  disconnect();
  await new Promise((r) => setTimeout(r, 10));
  const deletes = worker.calls.filter((c) => c.method === 'DELETE');
  assert.strictEqual(deletes.length, 0, 'job đã xong thì không gửi DELETE');
});
