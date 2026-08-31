"""
Ghép các câu đã tổng hợp thành MỘT file audio dài bằng video, mỗi câu neo
đúng vị trí tuyệt đối [start, end] lấy từ timestamp phụ đề gốc.

Khe của một câu KHÔNG phải [start,end] của phụ đề mà kéo dài tới sát câu
kế tiếp (available_slots): khoảng lặng giữa hai câu vốn không ai đọc, cho
câu trước mượn thì phần lớn câu dài hết vượt mà không phải nén hay cắt.

Quy tắc mỗi câu:
  1. Tổng hợp giọng ở tốc độ tự nhiên.
  2. Dài hơn khe: đọc lại bằng tốc độ native của engine (prosody thật, không
     phải kéo giãn tín hiệu) — xem tts_engine.SPEED_MAX.
  3. Vẫn dư chút: nén bằng ffmpeg atempo, giữ nguyên cao độ, tối đa 1.10x.
  4. Nén hết mức vẫn chưa vừa: CẮT audio cho vừa khe (fallback an toàn cuối
     cùng, đổi lấy việc không bao giờ đè vào câu kế tiếp) — đánh dấu
     "overflowTruncated": true để báo cho người dùng biết câu nào bị cắt.
  5. Ngắn hơn khe: giữ nguyên tốc độ tự nhiên, phần còn lại là im lặng.

Cần ffmpeg trong PATH.
"""

from __future__ import annotations

import base64
import math
import os
import subprocess
import wave
from pathlib import Path

STRETCH_MAX = 1.10
SAMPLE_RATE = 24000
# ffmpeg thường xong trong dưới một giây cho một câu, nhưng nếu nó chờ gì đó
# thì không có gì đánh thức nó dậy: job đứng im vô hạn và worker duy nhất của
# server kẹt theo. Chốt trần thời gian, và đóng luôn stdin — ffmpeg hỏi
# "overwrite?" trên stdin là một kiểu treo kinh điển.
FFMPEG_TIMEOUT_SEC = max(30, int(os.environ.get("FFMPEG_TIMEOUT_SEC", "120")))
# Khoảng thở chừa lại trước câu kế khi mượn khoảng lặng — hết sạch thì hai
# câu dính liền nhau, nghe hụt hơi.
BORROW_GAP_SEC = 0.08

# --- Đường bao ducking cho track gốc của video --------------------------------
# Trình duyệt hạ âm lượng video gốc theo đường cong này thay vì mute hẳn, nên
# nhạc nền và tiếng động vẫn còn. Tính từ chính track thuyết minh đã dựng
# xong: chỉ đổi độ lợi, không đụng vào phổ tín hiệu, nên không sinh nhiễu.
DUCK_FPS = 20  # 50 ms mỗi mẫu — đủ mịn, 40 phút video chỉ tốn 48 KB
# Mức nền khi đang đọc và khi im lặng; volume của HTML5 là biên độ tuyến
# tính nên quy đổi dB là 10^(dB/20). -20 dB dưới giọng thuyết minh và -9 dB
# trong khoảng lặng — thấp hơn mức -15/-6 dB của voice-over phát thanh, vì
# tiếng gốc ở đây cũng là giọng người: nghe rõ chữ là đâm vào giọng đọc,
# khác hẳn nhạc nền.
DUCK_SPEAKING = 0.10
DUCK_SILENT = 0.35
# Ngưỡng coi là "đang có tiếng đọc" (RMS trên toàn thang, ~-34 dBFS).
DUCK_SPEECH_RMS = 0.02
# Xuống nhanh để không đè lên đầu câu, lên chậm để nền dâng êm.
DUCK_ATTACK_SEC = 0.08
DUCK_RELEASE_SEC = 0.40


def _one_pole(tau_sec: float, fps: int) -> float:
    return math.exp(-1.0 / max(1e-6, tau_sec * fps))


def duck_envelope(wav_path: Path, fps: int = DUCK_FPS) -> dict | None:
    """Độ lợi cho track gốc theo thời gian, lấy từ track thuyết minh.

    Trả về {"fps", "data"} với data là chuỗi base64 của mảng uint8, mỗi byte
    là âm lượng track gốc (0-255 tương ứng 0.0-1.0) tại mốc index/fps giây;
    None khi track ngắn hơn một khung, để client biết là không có đường bao
    thay vì nhận một mảng rỗng rồi tính ra âm lượng NaN.
    """

    import numpy as np

    with wave.open(str(wav_path), "rb") as f:
        sample_rate = f.getframerate()
        pcm = f.readframes(f.getnframes())

    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    hop = max(1, sample_rate // fps)
    frames = len(samples) // hop
    if frames == 0:
        return None

    block = samples[: frames * hop].reshape(frames, hop)
    rms = np.sqrt(np.mean(np.square(block), axis=1))
    targets = np.where(rms > DUCK_SPEECH_RMS, DUCK_SPEAKING, DUCK_SILENT)

    attack = _one_pole(DUCK_ATTACK_SEC, fps)
    release = _one_pole(DUCK_RELEASE_SEC, fps)
    gains = np.empty(frames, dtype=np.float32)
    gain = float(DUCK_SILENT)
    for i, target in enumerate(targets):
        coef = attack if target < gain else release
        gain = float(target) + (gain - float(target)) * coef
        gains[i] = gain

    quantized = np.clip(np.rint(gains * 255), 0, 255).astype(np.uint8)
    return {"fps": fps, "data": base64.b64encode(quantized.tobytes()).decode("ascii")}


def available_slots(segments: list[dict], duration_sec: float) -> dict[int, float]:
    """Khe thật của từng câu: [start, start câu kế) trừ một khoảng thở.

    Không bao giờ ngắn hơn [start,end] gốc — chỉ nới rộng, nên hành vi với
    phụ đề chồng lấn giữ nguyên như trước.
    """

    ordered = sorted(segments, key=lambda seg: seg["start"])
    slots: dict[int, float] = {}
    for i, seg in enumerate(ordered):
        limit = ordered[i + 1]["start"] if i + 1 < len(ordered) else duration_sec
        borrowed = min(limit, duration_sec) - BORROW_GAP_SEC - seg["start"]
        slots[seg["id"]] = max(0.05, seg["end"] - seg["start"], borrowed)
    return slots


def _run_ffmpeg(args: list[str]) -> None:
    command = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error", *args]
    try:
        proc = subprocess.run(
            command,
            capture_output=True,
            text=True,
            stdin=subprocess.DEVNULL,
            timeout=FFMPEG_TIMEOUT_SEC,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffmpeg không phản hồi sau {FFMPEG_TIMEOUT_SEC}s, đã buộc dừng")
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg lỗi: " + proc.stderr.strip()[:500])


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as f:
        return f.getnframes() / float(f.getframerate())


def _wav_format(path: Path) -> tuple[int, int, int]:
    with wave.open(str(path), "rb") as f:
        return f.getnchannels(), f.getsampwidth(), f.getframerate()


def _read_pcm_mono16(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as f:
        assert f.getsampwidth() == 2, f"{path} không phải PCM 16-bit"
        return f.readframes(f.getnframes()), f.getframerate()


def _write_wav(path: Path, pcm: bytes, sample_rate: int) -> None:
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sample_rate)
        f.writeframes(pcm)


def stretch_to_fit(src_wav: Path, dst_wav: Path, natural_sec: float, slot_sec: float) -> dict:
    """Nén/giữ nguyên một câu để vừa khe thời gian. Trả về metadata để báo cáo."""
    if slot_sec <= 0:
        slot_sec = natural_sec

    need_factor = natural_sec / slot_sec if slot_sec > 0 else 1.0
    applied = min(max(need_factor, 1.0), STRETCH_MAX)

    if applied <= 1.02:
        import shutil
        if _wav_format(src_wav) == (1, 2, SAMPLE_RATE):
            shutil.copyfile(src_wav, dst_wav)
        else:
            _run_ffmpeg(["-i", str(src_wav), "-ar", str(SAMPLE_RATE), "-ac", "1", str(dst_wav)])
        applied = 1.0
    else:
        _run_ffmpeg(["-i", str(src_wav), "-filter:a", f"atempo={applied:.4f}",
                      "-ar", str(SAMPLE_RATE), "-ac", "1", str(dst_wav)])

    final_sec = _wav_duration(dst_wav)
    overflow_truncated = False

    if final_sec > slot_sec + 0.02:
        pcm, sr = _read_pcm_mono16(dst_wav)
        keep_samples = int(slot_sec * sr)
        _write_wav(dst_wav, pcm[: keep_samples * 2], sr)
        overflow_truncated = True
        final_sec = slot_sec

    return {
        "naturalSec": round(natural_sec, 3),
        "slotSec": round(slot_sec, 3),
        "stretch": round(applied, 3),
        "finalSec": round(final_sec, 3),
        "overflowTruncated": overflow_truncated,
    }


def assemble_timeline(segment_wavs: list[tuple[dict, Path]], duration_sec: float, out_wav: Path) -> None:
    """Đặt từng câu (đã cắt vừa khe) vào một track im lặng dài bằng video —
    ghi đè (slice) thay vì cộng dồn từng sample, các khe không chồng lấn."""
    total_bytes = max(2, int(duration_sec * SAMPLE_RATE) * 2)
    master = bytearray(total_bytes)  # PCM 16-bit mono, khởi tạo = im lặng

    for seg, wav_path in segment_wavs:
        pcm, sr = _read_pcm_mono16(wav_path)
        assert sr == SAMPLE_RATE, f"sample rate lệch: {sr} != {SAMPLE_RATE}"
        pos = int(seg["start"] * SAMPLE_RATE) * 2
        if pos < 0 or pos >= total_bytes:
            continue
        end = min(pos + len(pcm), total_bytes)
        master[pos:end] = pcm[: end - pos]

    _write_wav(out_wav, bytes(master), SAMPLE_RATE)


def export_final(wav_path: Path, out_path_no_ext: Path) -> tuple[str, Path]:
    """Xuất sang Opus; rơi xuống MP3 nếu ffmpeg build thiếu libopus.
    Trả về (content-type, đường dẫn file thật đã ghi)."""
    opus_path = out_path_no_ext.with_suffix(".opus")
    try:
        _run_ffmpeg(["-i", str(wav_path), "-c:a", "libopus", "-b:a", "32k", str(opus_path)])
        return "audio/opus", opus_path
    except Exception:
        mp3_path = out_path_no_ext.with_suffix(".mp3")
        _run_ffmpeg(["-i", str(wav_path), "-c:a", "libmp3lame", "-b:a", "48k", str(mp3_path)])
        return "audio/mpeg", mp3_path
