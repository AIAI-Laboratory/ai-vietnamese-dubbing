/**
 * Timeline planner — gộp cue phụ đề thành câu, gắn timestamp tuyệt đối và
 * tính hạn mức âm tiết cho mỗi câu.
 *
 * Hai điểm đáng lưu ý:
 *  - viSyllablesPerSec truyền vào theo tham số (đọc từ settings, người dùng
 *    hiệu chỉnh sau khi benchmark TTS) thay vì hằng số cố định.
 *  - Prompt yêu cầu trả JSON dạng OBJECT {"segments":[...]}  thay vì mảng
 *    trần, vì một số gateway OpenAI-compatible chỉ đảm bảo hợp lệ khi bật
 *    response_format json_object — object dễ tương thích hơn mảng.
 *
 * File này chạy được ở cả hai môi trường: content script (world DOM) và
 * service worker (nạp bằng importScripts trong background.js) — nên không
 * dùng API nào ngoài JS thuần.
 */
var DUB = globalThis.DUB || (globalThis.DUB = {});

(function () {
  const STRETCH_MIN = 0.90;
  const STRETCH_MAX = 1.10;
  const ROOMY_RATIO = 0.75;
  // gTTS đo được 3.0-3.036 âm tiết/giây (đo trên 2 job thật, xem server/README.md).
  const DEFAULT_RATE = 3.0;

  const VI_MARKS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

  /** Ước lượng âm tiết tiếng Việt; thuật ngữ tiếng Anh giữ nguyên tính thô theo độ dài. */
  function countViSyllables(text) {
    let n = 0;
    for (const tok of String(text).split(/\s+/)) {
      const w = tok.replace(/[^\p{L}\p{N}]/gu, '');
      if (!w) continue;
      const isEnglish = !VI_MARKS.test(w) && /^[a-zA-Z]+$/.test(w) && w.length > 4;
      n += isEnglish ? Math.ceil(w.length / 3) : 1;
    }
    return n;
  }

  const countEnWords = (s) => (String(s).match(/[A-Za-z][A-Za-z'-]*/g) || []).length;

  /**
   * Gộp cue (cắt theo dòng hiển thị) thành câu hoàn chỉnh, giữ ánh xạ vị trí
   * ký tự -> mốc thời gian để câu bắt đầu giữa cue vẫn có timestamp hợp lý.
   */
  function cuesToSentences(cues) {
    let flat = '';
    const charStart = [];
    const charEnd = [];
    const exactStartAt = new Map();
    const exactEndAt = new Map();

    for (const c of cues) {
      const offset = flat.length;
      const t = c.text;
      if (!t.length) continue;
      exactStartAt.set(offset, c.start);
      for (let i = 0; i < t.length; i++) {
        charStart.push(c.start + (c.end - c.start) * (i / t.length));
        charEnd.push(c.start + (c.end - c.start) * ((i + 1) / t.length));
      }
      exactEndAt.set(offset + t.length - 1, c.end);
      flat += t + ' ';
      charStart.push(c.end);
      charEnd.push(c.end);
    }

    const sentences = [];
    const re = /[^.!?]*[.!?]+["')\]]*(?:\s+|$)/g;
    let m;
    let lastEnd = 0;
    while ((m = re.exec(flat)) !== null) {
      const raw = m[0];
      const text = raw.trim();
      if (!text) continue;
      const s = m.index + (raw.length - raw.trimStart().length);
      const e = s + text.length - 1;
      lastEnd = m.index + raw.length;
      sentences.push({
        text,
        start: exactStartAt.has(s) ? exactStartAt.get(s) : charStart[s],
        end: exactEndAt.has(e) ? exactEndAt.get(e) : charEnd[e],
        anchorExact: exactStartAt.has(s),
      });
    }

    const tailRaw = flat.slice(lastEnd);
    const tail = tailRaw.trim();
    if (tail) {
      const s = lastEnd + (tailRaw.length - tailRaw.trimStart().length);
      sentences.push({
        text: tail,
        start: exactStartAt.has(s) ? exactStartAt.get(s) : charStart[s],
        end: charEnd[charEnd.length - 1],
        anchorExact: exactStartAt.has(s),
      });
    }
    return sentences;
  }

  function buildPlan(cues, duration, opts) {
    opts = opts || {};
    const rate = opts.viSyllablesPerSec || DEFAULT_RATE;
    const stretchMax = opts.stretchMax || STRETCH_MAX;

    const sentences = cuesToSentences(cues);
    const segments = sentences.map((s, i) => {
      const slot = +(s.end - s.start).toFixed(3);
      const max = Math.max(1, Math.floor(slot * rate * stretchMax));
      const target = Math.round(slot * rate);
      return {
        id: i + 1,
        start: +s.start.toFixed(3),
        end: +s.end.toFixed(3),
        slot,
        anchorExact: s.anchorExact,
        en: s.text,
        enWords: countEnWords(s.text),
        budget: { target, max },
      };
    });

    const totalSlot = +segments.reduce((a, g) => a + g.slot, 0).toFixed(2);
    return {
      videoDuration: duration,
      calibration: {
        viSyllablesPerSec: rate,
        stretchMin: STRETCH_MIN,
        stretchMax,
        note: rate === DEFAULT_RATE
          ? 'mặc định đo từ gTTS — đổi engine thì hiệu chỉnh lại trong Cài đặt'
          : 'đã hiệu chỉnh theo Cài đặt',
      },
      stats: {
        cues: cues.length,
        sentences: segments.length,
        totalSlotSec: totalSlot,
        anchorsExact: segments.filter((g) => g.anchorExact).length,
        totalTargetSyllables: segments.reduce((a, g) => a + g.budget.target, 0),
      },
      segments,
    };
  }

  /** Chia nhỏ segment thành từng chunk để gọi LLM (tránh output quá dài bị cắt). */
  function chunkSegments(segments, chunkSize) {
    chunkSize = chunkSize || 80;
    const chunks = [];
    for (let i = 0; i < segments.length; i += chunkSize) chunks.push(segments.slice(i, i + chunkSize));
    return chunks;
  }

  function buildTranslateSystemPrompt(rate) {
    const glossaryLines = Object.keys(DUB.GLOSSARY)
      .map((k) => '  ' + k + ' -> ' + DUB.GLOSSARY[k]).join('\n');
    return [
      'Bạn dịch phụ đề bài giảng lập trình từ tiếng Anh sang tiếng Việt để lồng tiếng cho video.',
      '',
      'RÀNG BUỘC QUAN TRỌNG NHẤT — độ dài:',
      'Mỗi câu có một hạn mức âm tiết. Bản dịch KHÔNG ĐƯỢC vượt hạn mức đó.',
      'Âm tiết đếm theo tiếng cách nhau bằng khoảng trắng; thuật ngữ tiếng Anh giữ',
      'nguyên tính theo số âm tiết khi đọc lên (roughly ceil(độ_dài/3)).',
      'Vượt hạn mức thì lồng tiếng lệch khỏi hình. Thà diễn đạt gọn hơn còn hơn vượt.',
      'Cắt cụm độn quen thuộc của dịch máy: "Đó là lý do tại sao" thành "Vì thế",',
      '"Điều này có nghĩa là" thành "Tức là"; bỏ "việc", "một cách", "sự" khi không cần.',
      '',
      'GIỮ NGUYÊN TIẾNG ANH (không dịch, không phiên âm):',
      DUB.KEEP_ENGLISH.join(', '),
      '',
      'DỊCH THỐNG NHẤT (dùng đúng một cách suốt cả bài, không đổi qua lại):',
      glossaryLines,
      '',
      'VĂN PHONG: giọng giảng bài, trung tính, câu ngắn thuận tai khi đọc lên.',
      'Số/ký hiệu viết thành chữ như cách người Việt đọc, ví dụ "O(n)" -> "ô của en".',
      '',
      'CHỈ trả về JSON, không kèm giải thích, không bọc trong code fence, đúng dạng:',
      '{"segments":[{"id":1,"vi":"..."},{"id":2,"vi":"..."}]}',
    ].join('\n');
  }

  function buildTranslateUserPrompt(segments) {
    const lines = segments.map((g) => {
      const rate = g.__rate || DEFAULT_RATE;
      const roomy = g.slot * rate * ROOMY_RATIO > g.budget.target;
      const cap = roomy ? g.budget.max + ' (thoải mái)' : String(g.budget.max);
      return g.id + '\t[tối đa ' + cap + ' âm tiết]\t' + g.en;
    });
    return 'CÂU CẦN DỊCH (id, hạn mức, nội dung):\n' + lines.join('\n');
  }

  /** Trích JSON khoan dung: bỏ code fence, tìm khối {...} hoặc [...] đầu tiên hợp lệ. */
  function extractJson(text) {
    let s = String(text).trim();
    s = s.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(s); } catch (e) { /* thử tiếp */ }
    const objMatch = s.match(/\{[\s\S]*\}/);
    if (objMatch) { try { return JSON.parse(objMatch[0]); } catch (e) { /* fallthrough */ } }
    const arrMatch = s.match(/\[[\s\S]*\]/);
    if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch (e) { /* fallthrough */ } }
    throw new Error('Không trích được JSON từ phản hồi: ' + s.slice(0, 200));
  }

  /** Chuẩn hoá phản hồi model về mảng {id, vi} — chấp nhận cả {segments:[...]} lẫn [...] trần. */
  function parseTranslationResponse(text) {
    const data = extractJson(text);
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.segments) ? data.segments : null);
    if (!arr) throw new Error('Phản hồi không có mảng "segments"');
    return arr
      .filter((r) => r && (typeof r.id === 'number' || typeof r.id === 'string') && typeof r.vi === 'string')
      .map((r) => ({ id: +r.id, vi: r.vi }));
  }

  function verifyPlan(plan, translated, rate) {
    rate = rate || plan.calibration.viSyllablesPerSec || DEFAULT_RATE;
    const byId = new Map(translated.map((r) => [r.id, r.vi]));
    const rows = plan.segments.map((g) => {
      const vi = byId.get(g.id);
      if (vi === undefined) return { id: g.id, start: g.start, slot: g.slot, vi: null, status: 'THIẾU' };
      const syl = countViSyllables(vi);
      const need = syl / rate;
      const ratio = g.slot > 0 ? need / g.slot : 99;
      let status = 'ok';
      if (ratio > STRETCH_MAX) status = 'VƯỢT';
      else if (ratio > 1) status = 'nén nhẹ';
      return { id: g.id, start: g.start, end: g.end, slot: g.slot, en: g.en, vi, syl, need: +need.toFixed(2), ratio: +ratio.toFixed(2), status };
    });
    const overflow = rows.filter((r) => r.status === 'VƯỢT' || r.status === 'THIẾU');
    return { rows, overflow, overflowCount: overflow.length, total: rows.length };
  }

  DUB.plan = {
    STRETCH_MIN, STRETCH_MAX, DEFAULT_RATE,
    countViSyllables, cuesToSentences, buildPlan, chunkSegments,
    buildTranslateSystemPrompt, buildTranslateUserPrompt,
    extractJson, parseTranslationResponse, verifyPlan,
  };
})();
