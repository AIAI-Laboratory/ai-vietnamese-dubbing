/**
 * Chạy: node --test extension/test/
 *
 * plan.js là script cổ điển gắn vào globalThis.DUB (dùng chung cho content
 * script và service worker), nên nạp bằng vm thay vì import.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { globalThis: {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'lib', 'plan.js'), 'utf8'),
  context,
);
const plan = context.DUB.plan;

const cue = (start, end, text) => ({ start, end, text });

test('hạn mức âm tiết mượn khoảng lặng tới sát câu kế', () => {
  const built = plan.buildPlan(
    [cue(0, 2, 'First sentence.'), cue(6, 7, 'Second one.')],
    10,
    { viSyllablesPerSec: 2 },
  );
  const [first, second] = built.segments;

  // Khe hiển thị 2s, nhưng tới câu sau còn 6s -> usableSlot ~5.92s.
  assert.strictEqual(first.slot, 2);
  assert.ok(first.usableSlot > 5.9 && first.usableSlot < 6);
  assert.ok(first.budget.max > Math.floor(first.slot * 2 * 1.15));
  // target vẫn theo khe hiển thị để câu không bị kéo dài quá mức tự nhiên.
  assert.strictEqual(first.budget.target, 4);
  // Câu cuối mượn tới hết video: 10s - 6s - khoảng thở.
  assert.ok(second.usableSlot > 3.9 && second.usableSlot < 4);
});

test('verifyPlan chấm theo khe đã mượn, không phải khe hiển thị', () => {
  const built = plan.buildPlan([cue(0, 2, 'Hello there.'), cue(6, 7, 'Bye.')], 10, {
    viSyllablesPerSec: 2,
  });
  // 8 âm tiết / 2 âm tiết mỗi giây = 4s: vượt khe 2s, vừa khe đã mượn 5.92s.
  const translated = [
    { id: 1, vi: 'một hai ba bốn năm sáu bảy tám' },
    { id: 2, vi: 'chào' },
  ];
  const verified = plan.verifyPlan(built, translated, 2);
  assert.strictEqual(verified.overflowCount, 0);
  assert.strictEqual(verified.rows[0].status, 'ok');
});

test('plan cũ trong cache không có usableSlot vẫn chấm được', () => {
  const legacy = {
    calibration: { viSyllablesPerSec: 2 },
    segments: [{ id: 1, start: 0, end: 2, slot: 2, en: 'Hi.' }],
  };
  const verified = plan.verifyPlan(legacy, [{ id: 1, vi: 'một hai ba bốn năm sáu' }], 2);
  assert.strictEqual(verified.rows[0].status, 'VƯỢT');
});

test('tốc độ đọc hội tụ dần về số server đo được', () => {
  // Baseline 3.8, giọng thật đọc 4.4: mỗi lần chạy kéo lại một phần.
  let rate = 3.8;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    rate = plan.nextCalibratedRate(rate, 4.4);
    seen.push(rate);
  }
  assert.ok(seen[0] > 3.8 && seen[0] < 4.4, `bước đầu phải nhích dần, nhận ${seen[0]}`);
  assert.ok(seen.at(-1) > 4.2, `sau 6 lần phải gần 4.4, nhận ${seen.at(-1)}`);
  // Làm tròn 0.1 vì rate nằm trong khoá cache.
  for (const r of seen) assert.strictEqual(r, Math.round(r * 10) / 10);
});

test('bỏ qua số đo vô lý thay vì phá cấu hình', () => {
  for (const bad of [null, undefined, 0, -1, NaN, 'nhanh', 12, 1.2]) {
    assert.strictEqual(plan.nextCalibratedRate(3.8, bad), 3.8, `giá trị ${bad} phải bị bỏ qua`);
  }
});

test('số đo trùng giá trị hiện tại không tạo thay đổi (không bust cache)', () => {
  assert.strictEqual(plan.nextCalibratedRate(3.8, 3.8), 3.8);
});
