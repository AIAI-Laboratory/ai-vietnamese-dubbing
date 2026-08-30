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
