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
     * YouTube không gắn <track> vào DOM: danh sách phụ đề nằm trong
     * ytInitialPlayerResponse của trang. Content script chạy ở isolated world
     * nên không đọc được biến đó, nhưng tải lại chính trang watch (cùng
     * origin, kèm cookie) rồi bóc JSON thì không cần tiêm script vào MAIN
     * world — ít quyền hơn và không đụng CSP của YouTube.
     */
    async getCues(video) {
      const fromDom = await DUB.vtt.getEnglishCues(video);
      if (fromDom && fromDom.length) return fromDom;

      const tracks = await fetchCaptionTracks();
      if (!tracks.length) return null;
      const track =
        tracks.find((t) => /^en/i.test(t.languageCode || '') && t.kind !== 'asr') ||
        tracks.find((t) => /^en/i.test(t.languageCode || '')) ||
        null;
      if (!track || !track.baseUrl) return null;

      // fmt=vtt để dùng lại parser sẵn có thay vì thêm nhánh đọc XML.
      const url = track.baseUrl + (track.baseUrl.includes('?') ? '&' : '?') + 'fmt=vtt';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return null;
      const cues = DUB.vtt.parseVtt(await res.text());
      return cues.length ? cues : null;
    },
  };

  /** Bóc captionTracks từ HTML trang watch. */
  async function fetchCaptionTracks() {
    const res = await fetch(location.href, { credentials: 'include' });
    if (!res.ok) return [];
    const html = await res.text();
    const marker = '"captionTracks":';
    const at = html.indexOf(marker);
    if (at < 0) return [];
    const arrayStart = html.indexOf('[', at);
    const arrayEnd = html.indexOf(']', arrayStart);
    if (arrayStart < 0 || arrayEnd < 0) return [];
    try {
      return JSON.parse(html.slice(arrayStart, arrayEnd + 1));
    } catch (e) {
      console.warn('[LDUB] không đọc được captionTracks của YouTube:', e);
      return [];
    }
  }

  const ADAPTERS = [coursera, youtube];

  /** Adapter cho trang đang mở, hoặc null nếu extension không hỗ trợ trang này. */
  function current(url = location.href) {
    return ADAPTERS.find((site) => site.matches(url)) || null;
  }

  DUB.sites = { ADAPTERS, current };
})();
