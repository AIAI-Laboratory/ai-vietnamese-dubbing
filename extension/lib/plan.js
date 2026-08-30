/**
 * Timeline planner — gộp cue phụ đề thành câu, gắn timestamp tuyệt đối,
 * tính hạn mức âm tiết và tạo prompt dịch học thuật theo chuyên ngành.
 *
 * Hai điểm đáng lưu ý:
 *  - viSyllablesPerSec truyền vào theo tham số (đọc từ settings, người dùng
 *    hiệu chỉnh sau khi benchmark TTS) thay vì hằng số cố định.
 *  - Prompt trả JSON dạng object {"segments":[...]} để Gemini structured
 *    output luôn có schema nhất quán giữa các bước dịch/review.
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
  // Baseline an toàn; tốc độ thực tế phụ thuộc voice Kokoro và CPU.
  const DEFAULT_RATE = 2.6;

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
          ? 'baseline Kokoro — hiệu chỉnh lại trong Cài đặt sau khi chạy thử'
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

  function buildTerminologySystemPrompt() {
    return [
      'Bạn là biên tập viên thuật ngữ học thuật Anh-Việt cho bài giảng trực tuyến.',
      'Đọc mẫu transcript, xác định đúng lĩnh vực và lập glossary dùng thống nhất khi lồng tiếng.',
      '',
      'QUY TẮC:',
      '- Chỉ lấy tối đa 8 thuật ngữ có rủi ro dịch sai cao nhất.',
      '- Không liệt kê từ phổ thông, từ chỉ xuất hiện một lần mà nghĩa đã rõ, hoặc biến thể trùng nhau.',
      '- Chỉ dịch sang tiếng Việt khi đó là cách gọi chuẩn, tự nhiên mà giới chuyên môn Việt Nam thực sự dùng.',
      '- Giữ nguyên tên riêng, tên sản phẩm và thuật ngữ mà người Việt trong ngành thường dùng bằng tiếng Anh.',
      '- Không dịch từng chữ nếu nghĩa chuyên ngành khác nghĩa thông thường.',
      '- Chỉ đưa vào glossary khi đủ chắc chắn; nếu còn phụ thuộc ngữ cảnh từng câu thì bỏ qua.',
      '- Không thêm diễn giải, định nghĩa hoặc kiến thức ngoài transcript.',
      '',
      'Mỗi mục có action="keep" khi phải giữ nguyên canonical English, hoặc action="translate" khi có thuật ngữ Việt tự nhiên.',
      'Mặc định thận trọng: với nhãn kỹ thuật, tên pattern, tên category, idiom hoặc thuật ngữ ẩn dụ, giữ canonical English trừ khi chắc chắn có cách gọi Việt tự nhiên.',
      'Không được dịch đen các nhãn kỹ thuật mang tính ẩn dụ, idiom, tên pattern hay tên khái niệm đã quen dùng bằng tiếng Anh.',
      'Nếu không chắc giới chuyên môn Việt Nam dùng bản dịch nào, chọn action="keep".',
      '',
      'CHỈ trả JSON đúng dạng:',
      '{"subject":"lĩnh vực cụ thể","terms":[{"source":"English term","target":"cách dùng thống nhất","action":"keep|translate"}]}',
    ].join('\n');
  }

  function buildTerminologyUserPrompt(segments) {
    const transcript = segments.map((segment) => segment.en).join(' ').slice(0, 10000);
    return 'MẪU TRANSCRIPT BÀI GIẢNG:\n' + transcript;
  }

  function buildTerminologyRetryUserPrompt(segments) {
    const transcript = segments.map((segment) => segment.en).join(' ').slice(0, 6000);
    return [
      'Chỉ chọn tối đa 5 thuật ngữ chuyên ngành dễ dịch sai từ transcript sau.',
      'Với mỗi thuật ngữ, dùng action="keep" trừ khi chắc chắn có bản dịch Việt tự nhiên.',
      'Trả JSON object ngắn, không giải thích.',
      '',
      transcript,
    ].join('\n');
  }

  function parseTerminologyResponse(text) {
    const data = extractJson(text);
    const subject = data && typeof data.subject === 'string'
      ? data.subject.trim().slice(0, 120)
      : '';
    const sourceTerms = data && Array.isArray(data.terms) ? data.terms : [];
    const seen = new Set();
    const terms = [];
    for (const term of sourceTerms) {
      if (!term || typeof term.source !== 'string' || typeof term.target !== 'string') continue;
      const source = term.source.trim().slice(0, 120);
      const rawTarget = term.target.trim().slice(0, 120);
      const key = source.toLocaleLowerCase('en');
      if (!source || !rawTarget || seen.has(key)) continue;
      seen.add(key);
      // Schema thiếu action không đủ căn cứ để tự dịch thuật ngữ chuyên ngành.
      const action = term.action === 'translate' ? 'translate' : 'keep';
      const target = action === 'keep' ? source : rawTarget;
      terms.push({ source, target, action });
      if (terms.length >= 8) break;
    }
    return { subject, terms };
  }

  function buildTranslateSystemPrompt(rate, terminology) {
    terminology = terminology || {};
    const courseTerms = Array.isArray(terminology.terms) ? terminology.terms : [];
    const courseGlossaryLines = courseTerms.length
      ? courseTerms.map((term) => '  ' + term.source + ' [' + term.action + '] -> ' + term.target).join('\n')
      : '  (chưa có; tự suy luận thận trọng từ ngữ cảnh)';
    const subject = terminology.subject || 'tự xác định từ nội dung';
    return [
      'Bạn là biên dịch viên học thuật Anh-Việt, chuyên dịch bài giảng và khoá học để lồng tiếng.',
      'Lĩnh vực bài học: ' + subject + '.',
      '',
      'THỨ TỰ ƯU TIÊN:',
      '1. Đúng nghĩa học thuật và đúng ngữ cảnh chuyên ngành.',
      '2. Nhất quán thuật ngữ trong toàn bài.',
      '3. Tự nhiên, rõ ràng khi giảng bằng tiếng Việt.',
      '4. Vừa thời lượng lồng tiếng.',
      '',
      'ĐỘ CHÍNH XÁC HỌC THUẬT:',
      '- Giữ nguyên phủ định, điều kiện, mức độ chắc chắn, quan hệ nguyên nhân-kết quả và phép so sánh.',
      '- Câu định nghĩa phải giữ đúng đối tượng và thuộc tính; không đảo nghĩa, suy diễn hay thêm kiến thức.',
      '- Giữ nguyên tên riêng, tổ chức, sản phẩm, công thức, biến, đơn vị và ký hiệu chuyên môn.',
      '- Tuân thủ action trong glossary: keep nghĩa là giữ canonical English; translate nghĩa là dùng target.',
      '- Khi cân nhắc một bản dịch, tự hỏi liệu người trong ngành có thực sự nói cụm Việt đó không. Nếu cụm nghe như hình ảnh đen, từ phổ thông ghép máy móc hoặc văn dịch, dùng canonical English.',
      '- Không dịch đen nhãn kỹ thuật mang tính ẩn dụ, idiom, tên pattern hoặc tên khái niệm nếu ngành thường dùng canonical English.',
      '- Dịch theo ý trọn vẹn của câu, không bám từng từ và không dùng văn phong máy dịch.',
      '',
      'GLOSSARY TỰ ĐỘNG CỦA BÀI:',
      courseGlossaryLines,
      '',
      'GIỚI HẠN THỜI LƯỢNG:',
      'Mỗi câu có một hạn mức âm tiết. Bản dịch KHÔNG ĐƯỢC vượt hạn mức đó.',
      'Tốc độ tham chiếu là ' + rate + ' âm tiết/giây.',
      'Âm tiết đếm theo tiếng cách nhau bằng khoảng trắng; thuật ngữ tiếng Anh giữ',
      'nguyên tính theo số âm tiết khi đọc lên (roughly ceil(độ_dài/3)).',
      'Rút gọn cách diễn đạt, nhưng KHÔNG được bỏ phủ định, điều kiện, số liệu hoặc ý chính để vừa hạn mức.',
      'Cắt cụm độn quen thuộc của dịch máy: "Đó là lý do tại sao" thành "Vì thế",',
      '"Điều này có nghĩa là" thành "Tức là"; bỏ "việc", "một cách", "sự" khi không cần.',
      '',
      'VĂN PHONG: giọng giảng viên trung tính, mạch lạc, câu ngắn thuận tai; dùng "chúng ta" cho inclusive we.',
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

  function buildCompactUserPrompt(rows) {
    const lines = rows.map((row) => (
      row.id + '\t[tối đa ' + row.max + ' âm tiết]\tEN: ' + row.en + '\tVI hiện tại: ' + row.vi
    ));
    return [
      'RÚT GỌN CÁC CÂU SAU ĐỂ VỪA THỜI LƯỢNG.',
      'Giữ nguyên nghĩa học thuật, thuật ngữ, phủ định, điều kiện, số liệu và quan hệ logic.',
      'Chỉ bỏ từ đệm hoặc diễn đạt cô đọng hơn; không tóm tắt mất ý.',
      'CHỈ trả JSON dạng {"segments":[{"id":1,"vi":"..."}]}.',
      '',
      lines.join('\n'),
    ].join('\n');
  }

  function buildReviewSystemPrompt(rate, terminology) {
    terminology = terminology || {};
    const glossaryLines = Array.isArray(terminology.terms) && terminology.terms.length
      ? terminology.terms.map((term) => '  ' + term.source + ' [' + term.action + '] -> ' + term.target).join('\n')
      : '  (không có)';
    return [
      'Bạn là biên tập viên độc lập kiểm định bản dịch bài giảng Anh-Việt.',
      'Lĩnh vực: ' + (terminology.subject || 'tự xác định từ nội dung') + '.',
      '',
      'Đối chiếu từng câu EN-VI và tự sửa khi cần:',
      '- Phát hiện nghĩa sai theo ngữ cảnh, false friend, dịch từng chữ và thuật ngữ không tự nhiên.',
      '- Bảo toàn phủ định, điều kiện, số liệu, định nghĩa, quan hệ logic và mức độ chắc chắn.',
      '- Dùng glossary để giữ nhất quán, nhưng xem đây là bản nháp tự động: sửa cách dịch nếu glossary mâu thuẫn với câu gốc hoặc ngữ cảnh ngành.',
      '- Không chấp nhận bản dịch đen của nhãn ẩn dụ, idiom, tên pattern hay tên khái niệm nếu giới chuyên môn thường giữ canonical English.',
      '- Viết như giảng viên Việt Nam nói, không như bản dịch máy.',
      '- Không thêm kiến thức, giải thích hoặc ý không có trong câu gốc.',
      '- Tôn trọng hạn mức âm tiết; chỉ rút gọn cách diễn đạt, không bỏ ý chính.',
      '',
      'GLOSSARY TỰ ĐỘNG CỦA BÀI:',
      glossaryLines,
      '',
      'Tốc độ tham chiếu: ' + rate + ' âm tiết/giây.',
      'Trả lại TẤT CẢ id được cung cấp, kể cả câu không cần sửa.',
      'CHỈ trả JSON dạng {"segments":[{"id":1,"vi":"..."}]}.',
    ].join('\n');
  }

  function buildReviewUserPrompt(rows) {
    return 'CÂU CẦN KIỂM ĐỊNH:\n' + rows.map((row) => (
      row.id + '\t[tối đa ' + row.max + ' âm tiết]\tEN: ' + row.en + '\tVI: ' + row.vi
    )).join('\n');
  }

  function buildGlossaryCompliancePrompt(rows, terms) {
    const termLines = terms.map((term) => '  ' + term.source + ' -> ' + term.target).join('\n');
    const rowLines = rows.map((row) => (
      row.id + '\tEN: ' + row.en + '\tVI hiện tại: ' + row.vi
    )).join('\n');
    return [
      'SỬA CÁC CÂU SAU ĐỂ KHÔI PHỤC CANONICAL TERM BẮT BUỘC.',
      'Giữ nguyên nghĩa, phủ định, số liệu và thời lượng gần nhất có thể.',
      'Không thêm giải thích. Chỉ thay phần thuật ngữ sai hoặc bị dịch đen.',
      'CANONICAL TERM PHẢI GIỮ:',
      termLines,
      '',
      'CÂU CẦN SỬA:',
      rowLines,
      '',
      'CHỈ trả JSON dạng {"segments":[{"id":1,"vi":"..."}]}.',
    ].join('\n');
  }

  function buildTerminologyReviewSystemPrompt() {
    return [
      'Bạn là biên tập viên thuật ngữ học thuật Anh-Việt độc lập.',
      'Kiểm định glossary tự sinh cho một bài giảng trước khi dùng để dịch.',
      '',
      'Chỉ giữ thuật ngữ chính xác và thực sự hữu ích. Sửa hoặc bỏ mục sai ngữ cảnh.',
      'Không chấp nhận dịch đen nhãn ẩn dụ, idiom, tên pattern hoặc khái niệm có canonical English được giới chuyên môn Việt Nam dùng.',
      'Tự kiểm tra độ tự nhiên: nếu target nghe như hình ảnh đen, từ phổ thông ghép máy móc hoặc văn dịch, đặt action="keep" và target bằng source.',
      'Nếu không chắc bản dịch Việt là cách dùng thật của ngành, đặt action="keep" và dùng canonical English ở target.',
      'Không thêm kiến thức ngoài transcript.',
      '',
      'CHỈ trả JSON đúng dạng:',
      '{"subject":"lĩnh vực cụ thể","terms":[{"source":"English term","target":"cách dùng thống nhất","action":"keep|translate"}]}',
    ].join('\n');
  }

  function buildTerminologyReviewUserPrompt(terminology) {
    return 'GLOSSARY CẦN KIỂM ĐỊNH:\n' + JSON.stringify(terminology || { subject: '', terms: [] });
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
    buildTerminologySystemPrompt, buildTerminologyUserPrompt, buildTerminologyRetryUserPrompt,
    parseTerminologyResponse,
    buildTerminologyReviewSystemPrompt, buildTerminologyReviewUserPrompt,
    buildTranslateSystemPrompt, buildTranslateUserPrompt, buildCompactUserPrompt,
    buildReviewSystemPrompt, buildReviewUserPrompt,
    buildGlossaryCompliancePrompt,
    extractJson, parseTranslationResponse, verifyPlan,
  };
})();
