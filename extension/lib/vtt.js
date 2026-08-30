/**
 * Đọc phụ đề tiếng Anh từ video Coursera.
 *
 * Xác nhận bằng thực nghiệm trên trang bài giảng thật: Coursera gắn
 * <track kind="captions" srclang="en"> trỏ tới
 * /api/subtitleAssetProxy.v1/..., trả về text/vtt với
 * access-control-allow-origin: * — fetch trực tiếp từ content script được,
 * không cần qua service worker.
 *
 * KHÔNG có tier dự phòng đọc timestamp từ DOM (span.rc-Phrase): đã kiểm tra,
 * các phần tử đó không mang thuộc tính thời gian nào dùng được — chỉ có thứ
 * tự hiển thị. Không đủ để lồng tiếng đồng bộ nên cố tình không dùng.
 */
var DUB = globalThis.DUB || (globalThis.DUB = {});

(function () {
  const timeToSec = (t) => {
    const m = String(t).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  };

  const stripTags = (s) => String(s).replace(/<[^>]*>/g, '').replace(/​/g, '').trim();

  function parseVtt(text) {
    const cues = [];
    for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n').filter(Boolean);
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const parts = lines[i].split('-->');
      const start = timeToSec(parts[0]);
      const end = timeToSec((parts[1] || '').trim().split(/\s+/)[0] || '');
      const body = stripTags(lines.slice(i + 1).join(' '));
      if (start === null || end === null || !body) continue;
      cues.push({ start, end, text: body });
    }
    return cues;
  }

  /** Tìm <track> tiếng Anh gắn trên thẻ <video>. Ưu tiên srclang bắt đầu bằng "en". */
  function findEnglishTrackEl(video) {
    const tracks = [...video.querySelectorAll('track')];
    if (!tracks.length) return null;
    return (
      tracks.find((t) => /^en/i.test(t.srclang || '')) ||
      tracks.find((t) => (t.kind || '') === 'captions' || (t.kind || '') === 'subtitles') ||
      tracks[0]
    );
  }

  /** Tier 1: fetch trực tiếp file VTT từ src của <track>. Nhanh và chính xác nhất. */
  async function fetchTrackCues(video) {
    const el = findEnglishTrackEl(video);
    if (!el || !el.src) return null;
    try {
      const res = await fetch(el.src, { credentials: 'omit' });
      if (!res.ok) return null;
      const text = await res.text();
      const cues = parseVtt(text);
      return cues.length ? cues : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Tier 2: đọc trực tiếp từ video.textTracks. Dùng khi không có <track>
   * trong DOM (một số bài Coursera gắn track bằng JS thay vì thẻ tĩnh).
   */
  async function readLiveTextTrackCues(video, timeoutMs = 3000) {
    const tracks = [...video.textTracks].filter(
      (t) => t.kind === 'captions' || t.kind === 'subtitles'
    );
    if (!tracks.length) return null;
    const track = tracks.find((t) => /^en/i.test(t.language || '')) || tracks[0];
    const prevMode = track.mode;
    if (track.mode === 'disabled') track.mode = 'hidden';

    const deadline = Date.now() + timeoutMs;
    while ((!track.cues || track.cues.length === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    const cues = track.cues
      ? [...track.cues].map((c) => ({ start: c.startTime, end: c.endTime, text: stripTags(c.text) }))
      : [];
    track.mode = prevMode;
    return cues.length ? cues : null;
  }

  /**
   * Lấy cue tiếng Anh cho video hiện tại. Trả về null nếu không tìm được
   * phụ đề nào — gọi nơi dùng phải báo lỗi rõ ràng cho người dùng, không
   * đoán mò timestamp từ nguồn không đáng tin.
   */
  async function getEnglishCues(video) {
    const fromTrack = await fetchTrackCues(video);
    if (fromTrack) {
      console.log(`[LDUB] phụ đề lấy từ <track> src: ${fromTrack.length} cue`);
      return fromTrack;
    }
    console.log('[LDUB] không có <track> dùng được, thử video.textTracks...');
    const live = await readLiveTextTrackCues(video);
    console.log(live
      ? `[LDUB] phụ đề lấy từ textTracks: ${live.length} cue`
      : '[LDUB] textTracks cũng không có cue nào');
    return live;
  }

  DUB.vtt = { parseVtt, findEnglishTrackEl, fetchTrackCues, readLiveTextTrackCues, getEnglishCues, stripTags };
})();
