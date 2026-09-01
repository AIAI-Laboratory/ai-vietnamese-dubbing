/** Chạy content.js thật trong Node với DOM và chrome giả lập. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');

/** Phần tử DOM giả — chỉ những gì content.js thực sự đụng tới. */
function makeElement(tag = 'div') {
  const children = [];
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(),
    children,
    listeners,
    style: {},
    dataset: {},
    className: '',
    id: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    value: '',
    src: '',
    options: [],
    currentTime: 0,
    duration: 600,
    paused: true,
    volume: 1,
    muted: false,
    playbackRate: 1,
    preservesPitch: true,
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((n) => this._set.add(n)); },
      remove(...names) { names.forEach((n) => this._set.delete(n)); },
      contains(name) { return this._set.has(name); },
    },
    appendChild(child) {
      if (child.parentElement) {
        const at = child.parentElement.children.indexOf(child);
        if (at >= 0) child.parentElement.children.splice(at, 1);
      }
      children.push(child);
      child.parentElement = el;
      return child;
    },
    remove() {
      el.removed = true;
      if (el.parentElement) {
        const at = el.parentElement.children.indexOf(el);
        if (at >= 0) el.parentElement.children.splice(at, 1);
      }
      el.parentElement = null;
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    getBoundingClientRect() { return { top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450 }; },
    closest() { return null; },
    querySelector(selector) {
      el.__found = el.__found || new Map();
      if (!el.__found.has(selector)) el.__found.set(selector, makeElement());
      return el.__found.get(selector);
    },
    querySelectorAll() { return []; },
    play() { el.paused = false; return Promise.resolve(); },
    pause() { el.paused = true; },
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
  };
  return el;
}

function loadContentScript() {
  const created = [];
  const video = makeElement('video');
  video.duration = 600;
  video.paused = false;
  video.textTracks = [{
    kind: 'captions',
    language: 'en',
    mode: 'showing',
    cues: [
      { startTime: 0, endTime: 4, text: 'First sentence here.' },
      { startTime: 4, endTime: 9, text: 'Second sentence here.' },
    ],
  }];

  const body = makeElement('body');
  const context = {
    console: { log() {}, warn(...a) { context.__warnings.push(a.map(String).join(' ')); }, error(...a) { context.__warnings.push(a.map(String).join(' ')); } },
    __warnings: [],
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    setInterval: (fn) => { context.__intervals.push(fn); return context.__intervals.length; },
    clearInterval: () => {},
    __intervals: [],
    atob,
    btoa,
    Uint8Array,
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts?.type; } },
    URL: {
      _live: new Set(),
      createObjectURL(blob) { const u = `blob:${Math.random()}`; this._live.add(u); return u; },
      revokeObjectURL(url) { this._live.delete(url); },
    },
    AbortController,
    Audio: class { constructor(src) { this.src = src; } play() { return Promise.resolve(); } addEventListener() {} },
    Math, Date, JSON, Promise, Error, Number, Object, Array, Set, Map, RegExp, String, Boolean,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    indexedDB: { open() { const req = {}; setTimeout(() => req.onerror?.({}), 0); return req; } },
    location: {
      href: 'https://www.coursera.org/learn/abc/lecture/XYZ/name',
      pathname: '/learn/abc/lecture/XYZ/name',
      search: '',
    },
  };
  context.globalThis = context;
  context.window = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  const documentListeners = {};
  context.document = {
    body,
    documentElement: makeElement('html'),
    fullscreenElement: null,
    createElement(tag) { const el = makeElement(tag); created.push(el); return el; },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; },
    addEventListener(type, fn) { (documentListeners[type] = documentListeners[type] || []).push(fn); },
    __fire(type) { (documentListeners[type] || []).forEach((fn) => fn({})); },
  };

  const ports = [];
  context.chrome = {
    runtime: {
      id: 'test-extension',
      async sendMessage(msg) {
        if (msg.type === 'GET_CONTENT_SETTINGS') {
          return { ok: true, settings: { serverUrl: 'http://127.0.0.1:18765', voice: '', dubVolume: 1, bedVolume: 1, viSyllablesPerSec: 3.8, planVersion: 'gemini-v2', subtitlesOn: false, subtitlesEnOn: true } };
        }
        if (msg.type === 'FETCH_TTS_VOICES') return { ok: true, voices: [{ id: 'diem_trinh', label: 'Diễm Trinh' }] };
        return { ok: true };
      },
      connect() {
        const port = {
          postMessage(msg) { port.sent.push(msg); },
          sent: [],
          onMessage: { addListener(fn) { port.__deliver = fn; } },
          onDisconnect: { addListener() {} },
        };
        ports.push(port);
        return port;
      },
    },
  };

  vm.createContext(context);
  for (const file of ['lib/vtt.js', 'lib/sites.js', 'lib/windows.js', 'lib/cache.js', 'content/content.js']) {
    vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), context, { filename: file });
  }
  return { context, video, ports, created, body };
}

/** Màu chấm trạng thái đang gắn trên nút Dub */
function statusOf(harness) {
  const button = harness.created.find(
    (el) => el.tagName === 'BUTTON' && /ldub-btn/.test(el.className) && el.listeners.click,
  );
  const found = [...(button?.classList?._set || [])].find((c) => c.startsWith('ldub-status-'));
  return found ? found.replace('ldub-status-', '') : null;
}

/** Bảng tiến độ có đang hiện không. */
function panelVisible(harness) {
  const overlay = harness.created.find((el) => el.className === 'ldub-overlay');
  return overlay?.__found?.get('.ldub-panel')?.hidden === false;
}

/** Chữ đang hiện trong panel nổi. */
function panelText(harness) {
  const overlay = harness.created.find((el) => el.className === 'ldub-overlay');
  return overlay?.__found?.get('.ldub-note')?.textContent || '';
}

/** Chạy toàn bộ interval đang đăng ký một lượt (mô phỏng thời gian trôi). */
function tick(context, times = 1) {
  for (let i = 0; i < times; i++) {
    for (const fn of [...context.__intervals]) fn();
  }
}

/** Đưa content script tới trạng thái đã gắn nút và mở port job. */
async function startJob(harness) {
  tick(harness.context);
  await new Promise((r) => setTimeout(r, 5));

  const dubButton = harness.created.find(
    (el) => el.tagName === 'BUTTON' && /ldub-btn/.test(el.className) && el.listeners.click,
  );
  assert.ok(dubButton, 'phải gắn được nút Dub');
  dubButton.listeners.click[0]({ preventDefault() {}, stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 20));

  const port = harness.ports[0];
  assert.ok(port, 'phải mở port tới service worker');
  return port;
}

function windowMessage(index, startSec, endSec, extra = {}) {
  return {
    type: 'WINDOW',
    window: {
      index,
      startSec,
      endSec,
      base64: btoa('audio-gia'),
      mime: 'audio/opus',
      duckEnvelope: { fps: 20, data: Buffer.from([25, 25, 90, 90]).toString('base64') },
    },
    ...extra,
  };
}

const PLAN = { segments: [{ id: 1, start: 0, end: 5, en: 'Hello.' }] };
const SUBTITLES = [{ id: 1, start: 0, end: 5, vi: 'Xin chào.', en: 'Hello.' }];

test('cửa sổ đầu về là dựng được audio và chuyển sang trạng thái phát', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES, translated: [] }));
  await new Promise((r) => setTimeout(r, 10));

  const failures = harness.context.__warnings.filter((w) => /không dựng được cửa sổ/.test(w));
  assert.deepStrictEqual(failures, [], 'không được có lỗi khi dựng cửa sổ');

  const audios = harness.created.filter((el) => el.tagName === 'AUDIO');
  assert.strictEqual(audios.length, 1, 'phải tạo đúng một thẻ audio cho cửa sổ đầu');
  assert.match(audios[0].src, /^blob:/, 'audio phải trỏ vào blob đã tạo');
});

test('cửa sổ sau về thì thêm thẻ audio, không dựng lại từ đầu', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));
  port.__deliver(windowMessage(1, 36, 72));
  port.__deliver(windowMessage(2, 72, 120));
  await new Promise((r) => setTimeout(r, 10));

  assert.deepStrictEqual(
    harness.context.__warnings.filter((w) => /không dựng được|ReferenceError/.test(w)),
    [],
  );
  assert.strictEqual(harness.created.filter((el) => el.tagName === 'AUDIO').length, 3);
});

test('vòng đồng bộ chạy được sau khi có cửa sổ, không ném lỗi', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  port.__deliver(windowMessage(1, 36, 72));
  await new Promise((r) => setTimeout(r, 10));

  harness.video.currentTime = 40;
  harness.video.paused = false;
  tick(harness.context, 3);

  const errors = harness.context.__warnings.filter((w) => /Error|error/.test(w));
  assert.deepStrictEqual(errors, [], `vòng sync không được ném lỗi: ${errors.join(' | ')}`);
});

test('DONE không kèm audio nói rõ là lệch phiên bản, không đứng im', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);

  port.__deliver({ type: 'DONE', plan: PLAN, subtitles: SUBTITLES, windows: [] });
  await new Promise((r) => setTimeout(r, 10));

  assert.match(panelText(harness), /lệch phiên bản|không có audio/);
});

test('job lỗi hiện thông báo thay vì im lặng', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  port.__deliver({ type: 'ERROR', message: 'server tắt' });
  await new Promise((r) => setTimeout(r, 10));

  assert.match(panelText(harness), /server tắt/);
});

test('tiến độ của phần còn lại không mở lại bảng khi đã phát được', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);

  port.__deliver({ type: 'PROGRESS', pct: 60, note: 'Đang tổng hợp giọng đọc — 10/50 câu' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(panelVisible(harness), true, 'lúc chưa phát được thì bảng phải hiện');

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(panelVisible(harness), false, 'phát được rồi thì bảng phải đóng');

  for (const pct of [70, 80, 95]) {
    port.__deliver({ type: 'PROGRESS', pct, note: `Đang tổng hợp giọng đọc — ${pct}%` });
  }
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(panelVisible(harness), false, 'tiến độ phần còn lại không được che video');
});

test('chấm trạng thái đổi màu theo từng bước', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);

  assert.strictEqual(statusOf(harness), 'working');

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(statusOf(harness), 'partial');

  port.__deliver({ type: 'PROGRESS', pct: 80, note: '40/50 câu' });
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(statusOf(harness), 'partial');

  port.__deliver({ type: 'DONE', plan: PLAN, subtitles: SUBTITLES, windows: [], overflowSegmentIds: [] });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(statusOf(harness), 'ready');
});

test('job lỗi thì chấm chuyển đỏ', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  port.__deliver({ type: 'ERROR', message: 'server tắt' });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(statusOf(harness), 'error');
});

test('đèn không được xanh lá khi job còn đang chạy', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);

  for (const pct of [12, 50, 95, 97, 99, 100]) {
    port.__deliver({ type: 'PROGRESS', pct, note: `bước ${pct}%` });
    await new Promise((r) => setTimeout(r, 2));
    assert.strictEqual(statusOf(harness), 'working', `pct=${pct} vẫn đang chạy, chưa có audio`);
  }

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  port.__deliver({ type: 'PROGRESS', pct: 100, note: 'gần xong' });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(statusOf(harness), 'partial');

  port.__deliver({ type: 'DONE', plan: PLAN, subtitles: SUBTITLES, windows: [], overflowSegmentIds: [] });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(statusOf(harness), 'ready');
});

test('bản ghi cache rỗng audio không được coi là đã xong', async () => {
  const harness = loadContentScript();
  harness.context.DUB.cache.get = async () => ({ windows: [], plan: PLAN, subtitles: SUBTITLES });
  const port = await startJob(harness);

  assert.strictEqual(statusOf(harness), 'working', 'phải chạy job thật chứ không dùng cache rỗng');
  assert.ok(port.sent.some((m) => m.type === 'START'), 'phải gửi START để dịch lại');
});

/** Một phần tử rời để đóng vai "phần tử đang fullscreen". */
function makeElementForTest() {
  return makeElement('div');
}

/** Phần tử phụ đề nổi (gắn thẳng vào body, không nằm trong overlay). */
function subtitleBox(harness) {
  return harness.created.find((el) => /ldub-subtitle/.test(el.className));
}

test('rời trang video thì phụ đề biến mất cùng', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));

  const subtitle = subtitleBox(harness);
  assert.ok(subtitle, 'phải có hộp phụ đề');
  assert.strictEqual(subtitle.parentElement, harness.body, 'phụ đề gắn thẳng vào body');

  harness.context.location.pathname = '/learn/abc/quiz/KHAC';
  tick(harness.context);
  await new Promise((r) => setTimeout(r, 5));

  assert.strictEqual(subtitle.parentElement, null, 'phụ đề phải bị gỡ khỏi trang');
  assert.ok(subtitle.removed, 'và bị remove() thật sự');
});

test('vào toàn màn hình thì phụ đề chuyển vào trong phần tử fullscreen', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));

  const subtitle = subtitleBox(harness);
  assert.strictEqual(subtitle.parentElement, harness.body);

  const player = makeElementForTest();
  harness.context.document.fullscreenElement = player;
  harness.context.document.__fire('fullscreenchange');

  assert.strictEqual(subtitle.parentElement, player, 'phụ đề phải nằm trong phần tử fullscreen');

  harness.context.document.fullscreenElement = null;
  harness.context.document.__fire('fullscreenchange');
  assert.strictEqual(subtitle.parentElement, harness.body);
});

test('đang tổng hợp thì video dừng, có audio thì tự chạy lại', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  assert.strictEqual(harness.video.paused, true, 'phải dừng video trong lúc chờ audio');

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(harness.video.paused, false, 'cửa sổ đầu về thì phải chạy tiếp');
});

test('video vốn đang dừng thì không tự chạy khi audio về', async () => {
  const harness = loadContentScript();
  harness.video.paused = true;
  const port = await startJob(harness);

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(harness.video.paused, true, 'người xem đang dừng thì để yên');
});

test('người xem tự bấm play trong lúc chờ thì mình thôi điều khiển', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  (harness.video.listeners.play || []).forEach((fn) => fn({}));
  harness.video.paused = true;

  port.__deliver(windowMessage(0, 0, 36, { plan: PLAN, subtitles: SUBTITLES }));
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(harness.video.paused, true, 'người xem đã giành lại quyền điều khiển');
});

test('job lỗi thì trả video chạy tiếp, không để treo ở trạng thái dừng', async () => {
  const harness = loadContentScript();
  const port = await startJob(harness);
  assert.strictEqual(harness.video.paused, true);

  port.__deliver({ type: 'ERROR', message: 'server sập' });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(harness.video.paused, false, 'lỗi thì phải cho xem tiếp bản gốc');
  assert.strictEqual(statusOf(harness), 'error');
});
