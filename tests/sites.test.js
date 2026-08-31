/** Chạy */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'sites.js'), 'utf8');

/** Nạp sites.js với một location giả lập. */
function loadAt(href) {
  const url = new URL(href);
  const context = {
    console,
    URLSearchParams,
    location: { href, pathname: url.pathname, search: url.search },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return context.DUB.sites;
}

test('nhận đúng trang bài giảng Coursera', () => {
  const sites = loadAt('https://www.coursera.org/learn/ml-course/lecture/aBcD/intro');
  const site = sites.current();
  assert.strictEqual(site.id, 'coursera');
  assert.strictEqual(site.videoId(), 'ml-course::aBcD');
});

test('nhận đúng trang xem video YouTube', () => {
  const sites = loadAt('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
  const site = sites.current();
  assert.strictEqual(site.id, 'youtube');
  assert.strictEqual(site.videoId(), 'dQw4w9WgXcQ');
});

test('trang không hỗ trợ trả về null', () => {
  const sites = loadAt('https://www.youtube.com/feed/subscriptions');
  assert.strictEqual(sites.current(), null);
  assert.strictEqual(sites.current('https://example.com/watch?v=x'), null);
});

test('mỗi adapter khai báo đủ interface content script dùng', () => {
  const sites = loadAt('https://www.coursera.org/learn/x/lecture/y/z');
  for (const site of sites.ADAPTERS) {
    assert.strictEqual(typeof site.id, 'string');
    assert.strictEqual(typeof site.matches, 'function');
    assert.strictEqual(typeof site.videoId, 'function');
    assert.strictEqual(typeof site.getCues, 'function');
    assert.ok(Array.isArray(site.dockSelectors));
  }
});

test('mốc thời gian của bảng transcript', () => {
  const sites = loadAt('https://www.youtube.com/watch?v=x');
  assert.strictEqual(sites.parseClockTime('0:05'), 5);
  assert.strictEqual(sites.parseClockTime('1:02'), 62);
  assert.strictEqual(sites.parseClockTime('1:02:03'), 3723);
  assert.strictEqual(sites.parseClockTime(' 12:34 '), 754);
  for (const bad of ['', 'abc', '5', '1:2:3:4', 'a:b']) {
    assert.strictEqual(sites.parseClockTime(bad), null, `phải loại: "${bad}"`);
  }
});

test('dòng transcript thành cue liên tục, dòng cuối kéo tới hết video', () => {
  const sites = loadAt('https://www.youtube.com/watch?v=x');
  const cues = sites.segmentsToCues(
    [
      { time: '0:10', text: 'second line' },
      { time: '0:00', text: 'first line' },
      { time: 'xx', text: 'rác' },
      { time: '0:20', text: '   ' },
    ],
    45,
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(cues)),
    [
      { start: 0, end: 10, text: 'first line' },
      { start: 10, end: 45, text: 'second line' },
    ],
  );
});

test('dòng cuối vẫn có độ dài dương khi thiếu thời lượng video', () => {
  const sites = loadAt('https://www.youtube.com/watch?v=x');
  const [cue] = sites.segmentsToCues([{ time: '1:00', text: 'chỉ một dòng' }], undefined);
  assert.ok(cue.end > cue.start, `end (${cue.end}) phải lớn hơn start (${cue.start})`);
});

test('nhận ra bảng transcript đang ở tiếng Việt', () => {
  const sites = loadAt('https://www.youtube.com/watch?v=x');
  const english = [{ text: 'hello there' }, { text: 'how are you' }, { text: 'fine thanks' }];
  const vietnamese = [{ text: 'xin chào các bạn' }, { text: 'hôm nay chúng ta học' }, { text: 'ok' }];
  assert.strictEqual(sites.looksVietnamese(english), false);
  assert.strictEqual(sites.looksVietnamese(vietnamese), true);
  assert.strictEqual(sites.looksVietnamese([]), false);
});
