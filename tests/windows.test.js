/** Logic chọn cửa sổ audio và tra đường bao ducking. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { atob, Uint8Array, Math, Number, console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'windows.js'), 'utf8'),
  context,
);
const windows = context.DUB.windows;

/** Ba cửa sổ liền nhau, giống hệt cách server cắt. */
const LIST = [
  { startSec: 0, endSec: 36, id: 'a' },
  { startSec: 36, endSec: 72, id: 'b' },
  { startSec: 72, endSec: 120, id: 'c' },
];

test('chọn đúng cửa sổ phủ mốc thời gian', () => {
  assert.strictEqual(windows.pick(LIST, 0).id, 'a');
  assert.strictEqual(windows.pick(LIST, 35.999).id, 'a');
  assert.strictEqual(windows.pick(LIST, 36).id, 'b', 'mốc biên thuộc về cửa sổ sau');
  assert.strictEqual(windows.pick(LIST, 71.5).id, 'b');
  assert.strictEqual(windows.pick(LIST, 72).id, 'c');
  assert.strictEqual(windows.pick(LIST, 119.99).id, 'c');
});

test('mốc chưa có cửa sổ nào phủ thì trả null, không ném lỗi', () => {
  assert.strictEqual(windows.pick(LIST, 120), null, 'quá cửa sổ cuối');
  assert.strictEqual(windows.pick(LIST, -1), null, 'trước cửa sổ đầu');
  assert.strictEqual(windows.pick([], 5), null, 'chưa có cửa sổ nào');
  assert.strictEqual(windows.pick([LIST[0]], 95), null);
});

test('cửa sổ về sai thứ tự vẫn được xếp lại đúng', () => {
  const list = [];
  windows.insert(list, LIST[2]);
  windows.insert(list, LIST[0]);
  windows.insert(list, LIST[1]);
  assert.deepStrictEqual(list.map((w) => w.id), ['a', 'b', 'c']);
  assert.strictEqual(windows.pick(list, 40).id, 'b');
});

test('vị trí phát là thời điểm video trừ mốc bắt đầu cửa sổ', () => {
  assert.strictEqual(windows.offsetIn(LIST[1], 45), 9);
  assert.strictEqual(windows.offsetIn(LIST[0], 12.5), 12.5);
  assert.strictEqual(windows.offsetIn(LIST[2], 10), 0);
});

/** Đường bao 4 mẫu ở 20fps */
function envelope() {
  return windows.decodeEnvelope({ fps: 20, data: Buffer.from([0, 128, 255, 64]).toString('base64') });
}

test('giải mã đường bao và tra theo thời gian của video', () => {
  const win = { startSec: 36, endSec: 72, duck: envelope() };
  assert.strictEqual(win.duck.bytes.length, 4);
  assert.strictEqual(windows.gainAt(win, 36), 0);
  assert.strictEqual(windows.gainAt(win, 36.05), 128 / 255);
  assert.strictEqual(windows.gainAt(win, 36.1), 1);
  assert.strictEqual(windows.gainAt(win, 36.15), 64 / 255);
});

test('tra ngoài phạm vi đường bao trả 0 chứ không NaN', () => {
  const win = { startSec: 36, endSec: 72, duck: envelope() };
  for (const t of [35, 36 - 0.1, 60, 1000]) {
    const gain = windows.gainAt(win, t);
    assert.ok(Number.isFinite(gain), `t=${t} phải ra số hữu hạn, nhận ${gain}`);
  }
  assert.strictEqual(windows.gainAt({ startSec: 0, endSec: 10, duck: null }, 5), 0);
  assert.strictEqual(windows.gainAt(null, 5), 0);
});

test('đường bao thiếu, hỏng hoặc rỗng đều thành null', () => {
  assert.strictEqual(windows.decodeEnvelope(null), null);
  assert.strictEqual(windows.decodeEnvelope({ fps: 20 }), null);
  assert.strictEqual(windows.decodeEnvelope({ data: 'AAAA' }), null);
  assert.strictEqual(windows.decodeEnvelope({ fps: 20, data: '' }), null);
  assert.strictEqual(windows.decodeEnvelope({ fps: 20, data: '!!!not base64!!!' }), null);
});

test('cửa sổ cũ trong cache phủ cả video vẫn dùng được', () => {
  const legacy = [{ startSec: 0, endSec: Infinity, id: 'legacy' }];
  assert.strictEqual(windows.pick(legacy, 0).id, 'legacy');
  assert.strictEqual(windows.pick(legacy, 3599).id, 'legacy');
  assert.strictEqual(windows.offsetIn(legacy[0], 42), 42);
});
