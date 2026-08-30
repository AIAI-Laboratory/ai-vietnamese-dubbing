/** Chạy: node --test extension/test/sites.test.js */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sites.js'), 'utf8');

/** Nạp sites.js với một location giả lập. */
function loadAt(href) {
  const url = new URL(href);
  const context = {
    console,
    URLSearchParams, // có sẵn trong trình duyệt, phải cấp cho sandbox vm
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
