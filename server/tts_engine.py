"""Kokoro-Vietnamese ONNX engine chạy hoàn toàn trên CPU (xem kokoro_onnx.py)."""

from __future__ import annotations

import logging
import os
import re
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("tts_engine")

SAMPLE_RATE = 24000
# Trần tốc độ đọc. Kokoro nhận speed native (đổi prosody thật, khác hẳn kéo
# giãn tín hiệu sau khi tổng hợp), nhưng qua ngưỡng này thì nghe hối hả.
SPEED_MAX = 1.15
MODEL_REVISION = "9f210d622209fcc216fe2ac6159fed2ff381cb8a"

# vig2p đọc acronym tiếng Anh không ổn định. Chuẩn hoá những thuật ngữ xuất
# hiện thường xuyên trong bài giảng lập trình, còn phụ đề vẫn giữ nguyên.
_SPOKEN_TERMS = {
    "HTTPS": "hát ti ti pi ét",
    "HTTP": "hát ti ti pi",
    "HTML": "hát ti em eo",
    "JSON": "giây son",
    "SQL": "ét kiu eo",
    "URL": "iu a eo",
    "CPU": "xi pi iu",
    "GPU": "gi pi iu",
    "API": "ây pi ai",
    "CSS": "xi ét ét",
    "UI": "iu ai",
    "AI": "ây ai",
}
_SPOKEN_TERM_RE = re.compile(
    r"\b(" + "|".join(map(re.escape, _SPOKEN_TERMS)) + r")\b",
    re.IGNORECASE,
)
_VI_MARKS = re.compile(
    "[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩị"
    "òóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]",
    re.IGNORECASE,
)


def normalize_for_speech(text: str) -> str:
    """Đổi acronym kỹ thuật phổ biến sang cách đọc tiếng Việt."""

    normalized = unicodedata.normalize("NFC", text).strip()
    return _SPOKEN_TERM_RE.sub(
        lambda match: _SPOKEN_TERMS[match.group(0).upper()], normalized
    )


def count_vi_syllables(text: str) -> int:
    """Ước lượng số âm tiết của đúng chuỗi sẽ được đưa vào TTS."""

    count = 0
    for token in normalize_for_speech(text).split():
        word = "".join(
            char for char in token if unicodedata.category(char)[0] in ("L", "N")
        )
        if not word:
            continue
        is_english = (
            not _VI_MARKS.search(word)
            and re.fullmatch(r"[a-zA-Z]+", word)
            and len(word) > 4
        )
        count += -(-len(word) // 3) if is_english else 1
    return max(count, 1)


@dataclass(frozen=True, slots=True)
class SynthResult:
    wav_path: Path
    duration_sec: float
    speed: float = 1.0
    peak: float = 0.0


class KokoroOnnxEngine:
    """Một ONNX session dùng chung; voicepack đổi dưới lock giữa các job."""

    name = "Kokoro-Vietnamese ONNX (CPU, local)"
    sample_rate = SAMPLE_RATE

    def __init__(self) -> None:
        import numpy as np

        import kokoro_onnx

        self._np = np
        self._voices = kokoro_onnx.VOICES
        self._default_voice = os.environ.get("KOKORO_VOICE", kokoro_onnx.DEFAULT_VOICE).strip()
        if self._default_voice not in self._voices:
            available = ", ".join(sorted(self._voices))
            raise ValueError(
                f"KOKORO_VOICE={self._default_voice!r} không hợp lệ. Có: {available}"
            )

        self._runtime = kokoro_onnx.KokoroOnnx(
            revision=MODEL_REVISION, voice=self._default_voice
        )

        # Warm-up một lần để request đầu tiên không chịu chi phí tối ưu graph.
        if len(self._runtime.synthesize("Xin chào.", crossfade_ms=0)) == 0:
            raise RuntimeError("Kokoro warm-up không tạo được audio")
        logger.info(
            "Kokoro sẵn sàng: voice=%s | providers=%s",
            self._default_voice,
            self._runtime.providers,
        )

    def list_voices(self) -> list[dict[str, str]]:
        """Trả danh sách voice theo hợp đồng API hiện tại."""

        return [
            {"name": name, "label": info["label"]}
            for name, info in sorted(self._voices.items())
        ]

    def _resolve_voice(self, voice: str) -> str:
        # "vi" là giá trị gTTS cũ có thể còn trong chrome.storage.
        name = (
            voice.strip()
            if voice and voice.strip() != "vi"
            else self._default_voice
        )
        if name not in self._voices:
            raise ValueError(f"Không có voice Kokoro {name!r}")
        return name

    def synth(
        self, text: str, out_path: Path, voice: str = "", speed: float = 1.0
    ) -> SynthResult:
        """Tổng hợp một segment thành WAV mono PCM 16-bit."""

        spoken_text = normalize_for_speech(text)
        if not spoken_text:
            raise ValueError("Văn bản TTS không được để trống")

        voice_name = self._resolve_voice(voice)
        speed = min(max(float(speed), 1.0), SPEED_MAX)
        # KHÔNG khoá ở đây: kokoro_onnx.synthesize không giữ state giữa các lần
        # gọi và onnxruntime cho phép chạy song song. Đo trên 6 core: 3 câu
        # song song hạ RTF từ 0.397 xuống 0.232.
        audio = self._runtime.synthesize(spoken_text, voice=voice_name, speed=speed)

        audio = self._np.asarray(audio, dtype=self._np.float32).reshape(-1)
        if len(audio) == 0 or not self._np.isfinite(audio).all():
            raise RuntimeError("Kokoro trả về audio rỗng hoặc không hợp lệ")

        # Kokoro trả biên độ vượt toàn thang khá thường xuyên (đo trên 8 câu
        # thật: peak 1.10-1.39, tức 0.04-0.31% số mẫu). Cắt phẳng bằng clip là
        # méo nghe được ở âm to; hạ đều cả câu xuống dưới trần thì không.
        # Hạ theo từng câu chứ không theo cả bài vì bài được ghép dần từng
        # câu; RMS của model rất ổn định (0.2474 +- 0.0001) nên chênh lệch độ
        # to giữa các câu sau khi hạ vẫn dưới 2 dB.
        peak = float(self._np.max(self._np.abs(audio)))
        if peak > 0.99:
            audio = audio * (0.99 / peak)
        pcm = (self._np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        with wave.open(str(out_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(pcm)
        return SynthResult(out_path, len(audio) / self.sample_rate, speed, round(peak, 3))


def load_engine() -> KokoroOnnxEngine:
    """Nạp model ONNX và warm-up trước khi server báo sẵn sàng."""

    return KokoroOnnxEngine()
