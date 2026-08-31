/**
 * Quyết định audio nào đang phải phát và âm nền video phải ở mức nào.
 *
 * Tách khỏi content.js để test được không cần DOM: đây là chỗ mọi lỗi đồng
 * bộ trú ngụ (chọn nhầm cửa sổ, tra nhầm mốc đường bao), còn phần tạo thẻ
 * <audio> và gọi play() thì không có gì để sai.
 *
 * Một cửa sổ phủ [startSec, endSec) của video. Audio bên trong nó dài đúng
 * bằng khoảng đó, nên vị trí phát = thời điểm video trừ startSec.
 */
var DUB = globalThis.DUB || (globalThis.DUB = {});

(function () {
  /** Cửa sổ phủ mốc thời gian này, hoặc null nếu chưa tổng hợp tới. */
  function pick(windows, seconds) {
    for (const win of windows) {
      if (seconds >= win.startSec && seconds < win.endSec) return win;
    }
    return null;
  }

  /** Chèn giữ thứ tự theo mốc bắt đầu — cửa sổ về không nhất thiết đúng thứ tự. */
  function insert(windows, entry) {
    windows.push(entry);
    windows.sort((a, b) => a.startSec - b.startSec);
    return windows;
  }

  /** base64 -> {bytes, fps}; null nếu thiếu, hỏng, hoặc rỗng. */
  function decodeEnvelope(envelope) {
    if (!envelope || !envelope.data || !envelope.fps) return null;
    try {
      const binary = atob(envelope.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      // Mảng rỗng vẫn "truthy": để lọt thì tra ra phần tử -1, thành NaN, và
      // video giữ nguyên âm lượng gốc thay vì được hạ xuống.
      return bytes.length ? { bytes, fps: envelope.fps } : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Âm lượng track gốc tại một mốc thời gian của video, theo đường bao của
   * chính cửa sổ đó. Trả 0 khi không có đường bao — nơi gọi hiểu là "mute".
   */
  function gainAt(win, seconds) {
    if (!win || !win.duck) return 0;
    const index = Math.round((seconds - win.startSec) * win.duck.fps);
    if (index < 0 || index >= win.duck.bytes.length) return 0;
    return win.duck.bytes[index] / 255;
  }

  /** Vị trí phát trong cửa sổ ứng với một mốc thời gian của video. */
  function offsetIn(win, seconds) {
    return Math.max(0, seconds - win.startSec);
  }

  DUB.windows = { pick, insert, decodeEnvelope, gainAt, offsetIn };
})();
