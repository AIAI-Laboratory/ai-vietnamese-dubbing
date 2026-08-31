/** Chạy */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { globalThis: {} };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'extension', 'lib', 'plan.js'), 'utf8'),
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

  assert.strictEqual(first.slot, 2);
  assert.ok(first.usableSlot > 5.9 && first.usableSlot < 6);
  assert.ok(first.budget.max > Math.floor(first.slot * 2 * 1.15));
  assert.strictEqual(first.budget.target, 4);
  assert.ok(second.usableSlot > 3.9 && second.usableSlot < 4);
});

test('verifyPlan chấm theo khe đã mượn, không phải khe hiển thị', () => {
  const built = plan.buildPlan([cue(0, 2, 'Hello there.'), cue(6, 7, 'Bye.')], 10, {
    viSyllablesPerSec: 2,
  });
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
  let rate = 3.8;
  const seen = [];
  for (let i = 0; i < 6; i++) {
    rate = plan.nextCalibratedRate(rate, 4.4);
    seen.push(rate);
  }
  assert.ok(seen[0] > 3.8 && seen[0] < 4.4, `bước đầu phải nhích dần, nhận ${seen[0]}`);
  assert.ok(seen.at(-1) > 4.2, `sau 6 lần phải gần 4.4, nhận ${seen.at(-1)}`);
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

test('glossary rỗng ruột bị coi là không dùng được', () => {
  const ok = { subject: 'Software Engineering', terms: [{ source: 'code smell', target: 'code smell', action: 'keep' }] };
  assert.strictEqual(plan.isUsableTerminology(ok), true);
  for (const bad of [
    null,
    undefined,
    {},
    { subject: '', terms: [] },
    { subject: '   ', terms: [{ source: 'a', target: 'b' }] },
    { subject: 'Software Engineering', terms: [] },
    { subject: 'Software Engineering' },
  ]) {
    assert.strictEqual(plan.isUsableTerminology(bad), false, `phải loại: ${JSON.stringify(bad)}`);
  }
});

test('câu thiếu bản dịch bị đánh dấu THIẾU chứ không lọt qua', () => {
  const built = plan.buildPlan([cue(0, 2, 'One.'), cue(3, 5, 'Two.')], 8, {
    viSyllablesPerSec: 3.8,
  });
  const verified = plan.verifyPlan(built, [{ id: 1, vi: 'một hai' }], 3.8);
  assert.strictEqual(verified.rows[1].status, 'THIẾU');
  assert.strictEqual(verified.rows[1].vi, null);
  assert.strictEqual(verified.overflowCount, 1);
});

test('chunkSegments chia đủ và không mất câu nào', () => {
  const segments = Array.from({ length: 57 }, (_, i) => ({ id: i + 1 }));
  const chunks = plan.chunkSegments(segments, 25);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(chunks.map((c) => c.length))), [25, 25, 7]);
  assert.strictEqual(chunks.flat().length, segments.length);
  assert.strictEqual(new Set(chunks.flat().map((s) => s.id)).size, segments.length);
});

test('glossary hợp lệ đi qua, mọi biến thể rỗng bị chặn', () => {
  assert.strictEqual(
    plan.isUsableTerminology({ subject: 'X', terms: [{ source: 'a', target: 'a' }] }),
    true,
  );
  assert.strictEqual(plan.isUsableTerminology({ subject: 'X', terms: [] }), false);
});
