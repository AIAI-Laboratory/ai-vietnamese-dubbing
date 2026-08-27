"""
Engine tổng hợp giọng nói — GttsEngine, gọi endpoint TTS không chính thức
của Google Translate (qua package `gTTS`). CẢNH BÁO: endpoint KHÔNG CHÍNH
THỨC — có thể ngừng hoạt động hoặc bị giới hạn tốc độ bất cứ lúc nào không
báo trước, và việc gọi tự động hoá có thể vi phạm Điều khoản dịch vụ Google
Translate. Xem server/README.md mục "gTTS" để biết rủi ro đầy đủ trước khi
dùng lâu dài.

Không có engine giả (mock) — lỗi nạp thì báo lỗi thật qua /api/health
("status":"error"), không âm thầm chạy chế độ giả.
"""

from __future__ import annotations

import io
import logging
import os
import re
import subprocess
import tempfile
import time
import unicodedata
import wave
from pathlib import Path

logger = logging.getLogger("tts_engine")

VI_MARKS = re.compile(
    "[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩị"
    "òóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]",
    re.IGNORECASE,
)


def count_vi_syllables(text: str) -> int:
    """Khớp countViSyllables trong extension/lib/plan.js — cùng logic ở
    nhiều ngôn ngữ để hạn mức tính lúc PLAN và lúc TTS thật đồng nhất."""
    n = 0
    for tok in text.split():
        w = "".join(c for c in tok if unicodedata.category(c)[0] in ("L", "N"))
        if not w:
            continue
        is_english = not VI_MARKS.search(w) and re.fullmatch(r"[a-zA-Z]+", w) and len(w) > 4
        n += -(-len(w) // 3) if is_english else 1
    return max(n, 1)


class SynthResult:
    __slots__ = ("wav_path", "duration_sec")

    def __init__(self, wav_path: Path, duration_sec: float):
        self.wav_path = wav_path
        self.duration_sec = duration_sec


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as f:
        return f.getnframes() / float(f.getframerate())


GTTS_SAMPLE_RATE = 24000
GTTS_MAX_ATTEMPTS = 3
GTTS_TIMEOUT_SEC = 15


def _mp3_bytes_to_wav(mp3_bytes: bytes, out_path: Path, sample_rate: int) -> None:
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp.write(mp3_bytes)
        tmp_path = tmp.name
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", tmp_path,
             "-ar", str(sample_rate), "-ac", "1", str(out_path)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg giải mã MP3 lỗi: " + proc.stderr.strip()[:500])
    finally:
        os.unlink(tmp_path)


_session_patched = False


def _patch_requests_session_reuse() -> None:
    """gTTS.stream() tự mở `with requests.Session() as s:` MỚI mỗi câu — đo
    thật: 2.20s/câu (session mới mỗi lần) so với 1.44s/câu (dùng chung) —
    nhanh hơn 1.53x chỉ nhờ tái dùng kết nối. Vá 1 lần ở cấp module."""
    global _session_patched
    if _session_patched:
        return
    import requests

    shared = requests.Session()
    real_session_cls = requests.Session

    class _ReusedSession(real_session_cls):
        def __new__(cls, *a, **k):
            return shared

        def close(self):
            pass

        def __exit__(self, *a):
            pass

    requests.Session = _ReusedSession
    _session_patched = True
    logger.info("gTTS: bật tái dùng kết nối HTTP — đo được nhanh hơn ~1.5x.")


class GttsEngine:
    is_mock = False
    name = "Google Translate TTS (gTTS, không chính thức)"
    sample_rate = GTTS_SAMPLE_RATE

    def __init__(self):
        from gtts import gTTS

        self._gTTS = gTTS
        _patch_requests_session_reuse()
        buf_path = Path(tempfile.gettempdir()) / "gtts_selftest.mp3"
        try:
            self._gTTS(text="Xin chào", lang="vi", timeout=GTTS_TIMEOUT_SEC).save(str(buf_path))
        finally:
            buf_path.unlink(missing_ok=True)

    def list_voices(self) -> list[dict]:
        return [{"name": "vi", "label": "Google (giọng máy, qua mạng — không chọn được nam/nữ)"}]

    def synth(self, text: str, out_path: Path, voice: str = "") -> SynthResult:
        last_err = None
        for attempt in range(1, GTTS_MAX_ATTEMPTS + 1):
            try:
                buf = io.BytesIO()
                self._gTTS(text=text, lang="vi", timeout=GTTS_TIMEOUT_SEC).write_to_fp(buf)
                _mp3_bytes_to_wav(buf.getvalue(), out_path, self.sample_rate)
                return SynthResult(out_path, _wav_duration(out_path))
            except Exception as e:
                last_err = e
                if attempt < GTTS_MAX_ATTEMPTS:
                    logger.warning("gTTS lỗi (lần %d/%d): %s — thử lại", attempt, GTTS_MAX_ATTEMPTS, e)
                    time.sleep(1.5 * attempt)
        raise RuntimeError(f"gTTS lỗi sau {GTTS_MAX_ATTEMPTS} lần thử: {last_err}")


def load_engine() -> GttsEngine:
    """Nạp GttsEngine — lỗi (mất mạng, endpoint chặn...) thì ném lỗi thật ra
    ngoài, không có engine giả để rơi xuống. Người gọi (main.py
    load_engine_background) bắt exception, đặt ENGINE_ERROR — /api/health
    báo lỗi rõ ràng thay vì âm thầm chạy giả."""
    return GttsEngine()
