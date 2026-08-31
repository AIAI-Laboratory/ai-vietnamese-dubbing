/** Đọc phụ đề tiếng Anh từ video Coursera. */
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

  /** Tìm <track> tiếng Anh gắn trên thẻ <video>. */
  function findEnglishTrackEl(video) {
    const tracks = [...video.querySelectorAll('track')];
    if (!tracks.length) return null;
    return (
      tracks.find((t) => /^en/i.test(t.srclang || '')) ||
      tracks.find((t) => (t.kind || '') === 'captions' || (t.kind || '') === 'subtitles') ||
      tracks[0]
    );
  }

  /** Tier 1 */
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

  /** Tier 2 */
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

  /** Lấy cue tiếng Anh cho video hiện tại. */
  async function getEnglishCues(video) {
    return (await fetchTrackCues(video)) || (await readLiveTextTrackCues(video));
  }

  DUB.vtt = { parseVtt, findEnglishTrackEl, fetchTrackCues, readLiveTextTrackCues, getEnglishCues, stripTags };
})();
