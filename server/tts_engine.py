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


# --- Đọc số ------------------------------------------------------------------
# vig2p KHÔNG đọc chữ số: đo trên engine thật, "1000" ra phoneme "→000",
# "3.14" ra "↗.→↓", "50%" ra "ʔ↗0%" — nghĩa là mọi con số trong bài giảng
# thành tiếng rác. Phải đổi sang chữ trước khi đưa vào G2P.
_DIGIT_WORDS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]
_SCALES = ["", " nghìn", " triệu", " tỷ"]
# Số dài hơn ngần này đọc từng chữ số (mã đơn hàng, số điện thoại, hash...)
# thay vì đọc thành hàng tỷ — nghe không ai theo kịp mà cũng không phải ý.
_SPELL_OUT_DIGITS = 12


def _read_three(value: int, leading: bool) -> str:
    """Đọc một nhóm ba chữ số. leading=True là nhóm đầu tiên của cả số."""

    hundreds, tens, ones = value // 100, (value // 10) % 10, value % 10
    parts: list[str] = []
    if hundreds or not leading:
        parts.append(f"{_DIGIT_WORDS[hundreds]} trăm")
    if tens == 0:
        if ones:
            # "lẻ" chỉ cần khi phía trước đã có hàng trăm: 105 -> một trăm lẻ năm.
            parts.append(f"lẻ {_DIGIT_WORDS[ones]}" if parts else _DIGIT_WORDS[ones])
    elif tens == 1:
        parts.append("mười")
        if ones == 5:
            parts.append("lăm")  # 15 là "mười lăm", không phải "mười năm"
        elif ones:
            parts.append(_DIGIT_WORDS[ones])
    else:
        parts.append(f"{_DIGIT_WORDS[tens]} mươi")
        if ones == 1:
            parts.append("mốt")  # 21 là "hai mươi mốt"
        elif ones == 4:
            parts.append("tư")   # 24 là "hai mươi tư"
        elif ones == 5:
            parts.append("lăm")  # 25 là "hai mươi lăm"
        elif ones:
            parts.append(_DIGIT_WORDS[ones])
    return " ".join(parts)


def read_number(digits: str) -> str:
    """Chuỗi chữ số -> cách đọc tiếng Việt."""

    if not digits.isdigit():
        return digits
    # Số 0 đứng đầu mang nghĩa mã số chứ không phải giá trị: đọc từng chữ số.
    if len(digits) > _SPELL_OUT_DIGITS or (len(digits) > 1 and digits[0] == "0"):
        return " ".join(_DIGIT_WORDS[int(d)] for d in digits)

    value = int(digits)
    if value == 0:
        return _DIGIT_WORDS[0]

    groups: list[int] = []
    while value:
        groups.append(value % 1000)
        value //= 1000

    spoken: list[str] = []
    for index in range(len(groups) - 1, -1, -1):
        group = groups[index]
        if group == 0:
            continue
        chunk = _read_three(group, leading=index == len(groups) - 1)
        spoken.append(chunk + _SCALES[index] if index < len(_SCALES) else chunk)
    return " ".join(spoken)


# "SAVE10" -> "SAVE 10": G2P đọc được cả hai vế khi chúng tách rời.
_LETTER_DIGIT = re.compile(r"(?<=[A-Za-zÀ-ỹ])(?=\d)|(?<=\d)(?=[A-Za-zÀ-ỹ])")
# Số phiên bản (3.11.4) đọc "chấm", không phải "phẩy" — và phải xử lý TRƯỚC
# luật thập phân, nếu không "3.11" bị nuốt còn ".4" rơi lại nguyên xi.
_VERSION = re.compile(r"\b\d+(?:\.\d+){2,}\b")
# 1.000 / 1,000 là dấu phân nhóm nghìn; 3.14 / 3,14 là phần thập phân.
# Lookahead cuối chặn khớp một phần: "3.111.4" không được ăn thành "3.111"
# rồi bỏ lại ".4" — cả chuỗi đó là số phiên bản.
_GROUPED = re.compile(r"\b(\d{1,3}(?:[.,]\d{3})+)\b(?![.,]?\d)")
_DECIMAL = re.compile(r"\b(\d+)[.,](\d{1,2})\b")
_INTEGER = re.compile(r"\d+")


def _read_decimal(match: re.Match) -> str:
    whole, fraction = match.group(1), match.group(2)
    digits = " ".join(_DIGIT_WORDS[int(d)] for d in fraction)
    return f"{read_number(whole)} phẩy {digits}"


def normalize_numbers(text: str) -> str:
    """Đổi mọi chữ số trong câu sang chữ đọc được."""

    text = _LETTER_DIGIT.sub(" ", text)
    text = text.replace("%", " phần trăm")
    # Nhóm nghìn xét TRƯỚC số phiên bản: "1.234.567" khớp cả hai kiểu, và mọi
    # nhóm đúng ba chữ số thì đó là dấu phân nhóm chứ không phải phiên bản.
    text = _GROUPED.sub(lambda m: read_number(re.sub(r"[.,]", "", m.group(1))), text)
    text = _VERSION.sub(
        lambda m: " chấm ".join(read_number(part) for part in m.group(0).split(".")), text
    )
    text = _DECIMAL.sub(_read_decimal, text)
    text = _INTEGER.sub(lambda m: read_number(m.group(0)), text)
    return re.sub(r"\s{2,}", " ", text).strip()


def normalize_for_speech(text: str) -> str:
    """Chuẩn hoá câu trước khi đưa vào G2P: acronym và chữ số."""

    normalized = unicodedata.normalize("NFC", text).strip()
    normalized = _SPOKEN_TERM_RE.sub(
        lambda match: _SPOKEN_TERMS[match.group(0).upper()], normalized
    )
    return normalize_numbers(normalized)


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
