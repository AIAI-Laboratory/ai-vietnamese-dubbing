/**
 * Adapter cho từng trang video. Content script chỉ biết interface này, mọi
 * chỗ phụ thuộc cấu trúc riêng của Coursera/YouTube nằm gọn ở đây.
 *
 * Mỗi adapter:
 *   id            định danh ngắn, đi vào khoá cache nên đổi là mất cache cũ
 *   matches(url)  trang này có phải của adapter không
 *   videoId()     khoá ổn định cho một bài giảng/video
 *   dockSelectors selector nút trên thanh điều khiển để neo nút Dub cạnh nó
 *   getCues(video) -> [{start,end,text}] phụ đề tiếng Anh, hoặc null
 *   noCuesHint    câu hướng dẫn khi không lấy được phụ đề (mỗi trang một khác)
 *
 * Thêm trang mới = thêm một object vào ADAPTERS + một entry matches/
 * host_permissions trong manifest.json.
 */
var DUB = globalThis.DUB || (globalThis.DUB = {});

(function () {
  const coursera = {
    id: 'coursera',
    label: 'Coursera',
    matches: (url) => /^https:\/\/www\.coursera\.org\/learn\//.test(url),

    videoId() {
      // .../learn/<course-slug>/lecture/<itemId>/<item-slug>
      const m = location.pathname.match(/\/learn\/([^/]+)\/lecture\/([^/]+)/);
      return m ? `${m[1]}::${m[2]}` : location.pathname;
    },

    // Neo bằng aria-label thay vì tên class — class do build tool sinh
    // ("css-179heut") đổi mỗi lần Coursera deploy, aria-label phục vụ
    // accessibility nên ổn định hơn nhiều.
    dockSelectors: ['button[aria-label="Video playback rate switcher"]'],

    getCues: (video) => DUB.vtt.getEnglishCues(video),

    noCuesHint:
      'Không tìm thấy phụ đề tiếng Anh cho bài này. Bật CC trên player Coursera rồi thử lại.',
  };

  const youtube = {
    id: 'youtube',
    label: 'YouTube',
    matches: (url) => /^https:\/\/(www|m)\.youtube\.com\/watch/.test(url),

    videoId() {
      return new URLSearchParams(location.search).get('v') || location.pathname;
    },

    dockSelectors: ['.ytp-settings-button', '.ytp-subtitles-button'],

    /**
     * Phụ đề lấy từ bảng "Show transcript" mà chính YouTube render ra DOM.
     *
     * KHÔNG tải file phụ đề qua captionTrack.baseUrl nữa: từ 2025 YouTube bắt
     * buộc tham số PoToken (chữ ký do player sinh lúc chạy) cho endpoint
     * /api/timedtext. Đã kiểm chứng bằng request thật — thiếu token thì server
     * trả HTTP 200 với body RỖNG, cả fmt=vtt lẫn json3/srv3, kể cả khi có
     * cookie phiên. Endpoint nội bộ youtubei/v1/get_transcript cũng trả 400
     * FAILED_PRECONDITION. Bảng transcript thì do trang tự dựng nên không
     * phải ký gì cả.
     *
     * Đánh đổi: mốc thời gian trong bảng chỉ chính xác tới giây và chỉ có
     * điểm bắt đầu, nên điểm kết thúc lấy theo câu kế tiếp.
     */
    async getCues(video) {
      const fromDom = await DUB.vtt.getEnglishCues(video);
      if (fromDom && fromDom.length) return fromDom;
      return readTranscriptPanel(video);
    },

    noCuesHint:
      'Không đọc được phụ đề. Mở "Show transcript" dưới phần mô tả video, '
      + 'chọn ngôn ngữ English, rồi bấm lại. Video không có phụ đề tiếng Anh thì không lồng tiếng được.',
  };

  // --- Bảng transcript của YouTube -----------------------------------------

  const TRANSCRIPT_SEGMENT = 'ytd-transcript-segment-renderer';
  // Nút mở bảng nằm trong phần mô tả; aria-label đổi theo ngôn ngữ giao diện
  // nên phải dò cả nhãn lẫn vị trí.
  const TRANSCRIPT_BUTTON = [
    'ytd-video-description-transcript-section-renderer button',
    'button[aria-label*="transcript" i]',
    'button[aria-label*="lời thoại" i]',
    'button[aria-label*="bản chép" i]',
  ];
  const VI_MARKS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** "1:02" -> 62; "1:02:03" -> 3723. Trả null nếu không phải mốc thời gian. */
  function parseClockTime(text) {
    const parts = String(text).trim().split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every((part) => /^\d+$/.test(part.trim()))) return null;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  }

  /**
   * Dòng transcript -> cue. Bảng chỉ cho mốc bắt đầu, nên mỗi dòng kéo dài
   * tới dòng kế tiếp; dòng cuối kéo tới hết video.
   */
  function segmentsToCues(rows, durationSec) {
    const clean = rows
      .map((row) => ({ start: parseClockTime(row.time), text: String(row.text || '').trim() }))
      .filter((row) => row.start !== null && row.text)
      .sort((a, b) => a.start - b.start);
    return clean.map((row, i) => {
      const next = i + 1 < clean.length ? clean[i + 1].start : durationSec;
      return {
        start: row.start,
        // Dòng cuối của video ngắn hơn mốc của nó thì vẫn phải có độ dài dương.
        end: Math.max(row.start + 0.5, Number(next) || row.start + 2),
        text: row.text,
      };
    });
  }

  /** Bảng đang mở tiếng Việt thì dịch tiếp sang tiếng Việt là vô nghĩa. */
  function looksVietnamese(cues) {
    if (!cues.length) return false;
    const marked = cues.filter((cue) => VI_MARKS.test(cue.text)).length;
    return marked / cues.length > 0.3;
  }

  function readTranscriptRows() {
    return [...document.querySelectorAll(TRANSCRIPT_SEGMENT)].map((node) => ({
      time: (node.querySelector('.segment-timestamp') || {}).textContent || '',
      text: (node.querySelector('.segment-text') || {}).textContent || '',
    }));
  }

  /** Bấm nút mở bảng transcript nếu nó chưa mở. */
  function openTranscriptPanel() {
    if (document.querySelector(TRANSCRIPT_SEGMENT)) return true;
    // Phần mô tả phải mở rộng thì nút transcript mới được render.
    const expand = document.querySelector('#description-inline-expander #expand');
    if (expand) expand.click();
    for (const selector of TRANSCRIPT_BUTTON) {
      const button = document.querySelector(selector);
      if (button) {
        button.click();
        return true;
      }
    }
    return false;
  }

  async function readTranscriptPanel(video, timeoutMs = 8000) {
    if (!openTranscriptPanel()) {
      console.warn('[LDUB] không tìm thấy nút mở bảng transcript của YouTube');
      return null;
    }
    const deadline = Date.now() + timeoutMs;
    while (!document.querySelector(TRANSCRIPT_SEGMENT) && Date.now() < deadline) {
      await sleep(200);
    }
    const rows = readTranscriptRows();
    if (!rows.length) return null;

    const cues = segmentsToCues(rows, video && video.duration);
    if (!cues.length) return null;
    if (looksVietnamese(cues)) {
      console.warn('[LDUB] bảng transcript đang ở tiếng Việt — đổi sang English rồi thử lại');
      return null;
    }
    return cues;
  }

  const ADAPTERS = [coursera, youtube];

  /** Adapter cho trang đang mở, hoặc null nếu extension không hỗ trợ trang này. */
  function current(url = location.href) {
    return ADAPTERS.find((site) => site.matches(url)) || null;
  }

  // parseClockTime/segmentsToCues xuất ra để test được không cần DOM.
  DUB.sites = { ADAPTERS, current, parseClockTime, segmentsToCues, looksVietnamese };
})();
