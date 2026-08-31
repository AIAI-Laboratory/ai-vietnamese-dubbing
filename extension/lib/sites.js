/** Adapter cho từng trang video. */
var DUB = globalThis.DUB || (globalThis.DUB = {});

(function () {
  const coursera = {
    id: 'coursera',
    label: 'Coursera',
    matches: (url) => /^https:\/\/www\.coursera\.org\/learn\//.test(url),

    videoId() {
      const m = location.pathname.match(/\/learn\/([^/]+)\/lecture\/([^/]+)/);
      return m ? `${m[1]}::${m[2]}` : location.pathname;
    },

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

    /** Phụ đề lấy từ bảng "Show transcript" mà chính YouTube render ra DOM. */
    async getCues(video) {
      const fromDom = await DUB.vtt.getEnglishCues(video);
      if (fromDom && fromDom.length) return fromDom;
      return readTranscriptPanel(video);
    },

    noCuesHint:
      'Không đọc được phụ đề. Mở "Show transcript" dưới phần mô tả video, '
      + 'chọn ngôn ngữ English, rồi bấm lại. Video không có phụ đề tiếng Anh thì không lồng tiếng được.',
  };

  const TRANSCRIPT_SEGMENT = 'ytd-transcript-segment-renderer';
  const TRANSCRIPT_BUTTON = [
    'ytd-video-description-transcript-section-renderer button',
    'button[aria-label*="transcript" i]',
    'button[aria-label*="lời thoại" i]',
    'button[aria-label*="bản chép" i]',
  ];
  const VI_MARKS = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const warn = (...args) => console.warn("[LDUB]", ...args);

  /** "1 */
  function parseClockTime(text) {
    const parts = String(text).trim().split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every((part) => /^\d+$/.test(part.trim()))) return null;
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  }

  /** Dòng transcript -> cue. */
  function segmentsToCues(rows, durationSec) {
    const clean = rows
      .map((row) => ({ start: parseClockTime(row.time), text: String(row.text || '').trim() }))
      .filter((row) => row.start !== null && row.text)
      .sort((a, b) => a.start - b.start);
    return clean.map((row, i) => {
      const next = i + 1 < clean.length ? clean[i + 1].start : durationSec;
      return {
        start: row.start,
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
      warn('không tìm thấy nút mở bảng transcript của YouTube');
      return null;
    }
    const deadline = Date.now() + timeoutMs;
    while (!document.querySelector(TRANSCRIPT_SEGMENT) && Date.now() < deadline) {
      await sleep(200);
    }
    const rows = readTranscriptRows();
    if (!rows.length) {
      warn('bảng transcript mở nhưng không có dòng nào — video có thể không có phụ đề');
      return null;
    }
    const cues = segmentsToCues(rows, video && video.duration);
    if (!cues.length) return null;
    if (looksVietnamese(cues)) {
      warn('bảng transcript đang ở tiếng Việt — mở menu ngôn ngữ trong bảng, chọn English rồi bấm lại');
      return null;
    }
    return cues;
  }

  const ADAPTERS = [coursera, youtube];

  /** Adapter cho trang đang mở, hoặc null nếu extension không hỗ trợ trang này. */
  function current(url = location.href) {
    return ADAPTERS.find((site) => site.matches(url)) || null;
  }

  DUB.sites = { ADAPTERS, current, parseClockTime, segmentsToCues, looksVietnamese };
})();
