"""VieNeu-TTS v3 Nano ONNX engine chạy hoàn toàn trên CPU."""

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
SPEED_MAX = 1.15
VIENEU_STEPS = max(1, int(os.environ.get("VIENEU_STEPS", "16")))
VIENEU_CFG = float(os.environ.get("VIENEU_CFG", "3.0"))
VIENEU_MODEL_DIR = Path(
    os.environ.get("VIENEU_MODEL_DIR", str(Path(__file__).resolve().parent / "models" / "vieneu-nano"))
)
_VIENEU_MODEL_FILES = (
    "text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx",
    "codec_decoder.onnx", "config.json", "constants.npz",
)

_LETTER_NAMES = {
    "A": "ây", "B": "bi", "C": "xi", "D": "đi", "E": "ê", "F": "ép", "G": "giê",
    "H": "hát", "I": "ai", "J": "giây", "K": "kê", "L": "eo", "M": "em",
    "N": "en", "O": "ô", "P": "pi", "Q": "kiu", "R": "e rờ", "S": "ét",
    "T": "ti", "U": "iu", "V": "vi", "W": "đắp liu", "X": "ích", "Y": "quai",
    "Z": "dét",
}

_SPOKEN_TERMS = {
    "JSON": "giây son",
    "SQL": "ét kiu eo",
}

_SPELLED_ACRONYMS = {
    "AI", "API", "AWS", "CDN", "CLI", "CNN", "CPU", "CSS", "CSV", "CV", "DB",
    "DL", "DNS", "ETL", "GPU", "GUI", "HDD", "HTML", "HTTP", "HTTPS", "IDE",
    "IP", "JPG", "JWT", "LLM", "LSTM", "ML", "NLP", "ORM", "OS", "PDF", "PNG",
    "RNN", "SDK", "SSD", "SSH", "SSL", "SVG", "TCP", "TLS", "UDP", "UI", "URL",
    "USB", "UUID", "UX", "VM", "VPN", "XML", "YAML",
}

_SPOKEN_TERM_RE = re.compile(
    r"\b(" + "|".join(map(re.escape, _SPOKEN_TERMS)) + r")\b",
    re.IGNORECASE,
)
_ACRONYM_RE = re.compile(r"\b[A-Z]{2,6}\b")
_VOWELS = set("AEIOU")

_IDENTIFIER_DOT = re.compile(r"(?<=[A-Za-z])\.(?=[A-Za-z])")
_BRACKETS = re.compile(r"[()\[\]{}]")


def spell_acronym(word: str) -> str:
    """Đọc từng chữ cái theo tên chữ cái tiếng Anh, viết bằng chữ Việt."""

    return " ".join(_LETTER_NAMES.get(letter, letter) for letter in word)


def _spell_if_acronym(match: re.Match) -> str:
    """Viết tắt thì đánh vần; từ tiếng Anh viết hoa (SAVE, NOTE) thì để nguyên.

    Danh sách _SPELLED_ACRONYMS là phần chắc chắn; ngoài danh sách chỉ đánh vần
    chuỗi không có nguyên âm, vì chuỗi đó không đọc liền thành từ được.
    """

    word = match.group(0)
    if word in _SPELLED_ACRONYMS or not (set(word) & _VOWELS):
        return spell_acronym(word)
    return word


_VI_MARKS = re.compile(
    "[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩị"
    "òóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]",
    re.IGNORECASE,
)


_DIGIT_WORDS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]
_SCALES = ["", " nghìn", " triệu", " tỷ"]
_SPELL_OUT_DIGITS = 12


def _read_three(value: int, leading: bool) -> str:
    """Đọc một nhóm ba chữ số. leading=True là nhóm đầu tiên của cả số."""

    hundreds, tens, ones = value // 100, (value // 10) % 10, value % 10
    parts: list[str] = []
    if hundreds or not leading:
        parts.append(f"{_DIGIT_WORDS[hundreds]} trăm")
    if tens == 0:
        if ones:
            parts.append(f"lẻ {_DIGIT_WORDS[ones]}" if parts else _DIGIT_WORDS[ones])
    elif tens == 1:
        parts.append("mười")
        if ones == 5:
            parts.append("lăm")
        elif ones:
            parts.append(_DIGIT_WORDS[ones])
    else:
        parts.append(f"{_DIGIT_WORDS[tens]} mươi")
        if ones == 1:
            parts.append("mốt")
        elif ones == 4:
            parts.append("tư")
        elif ones == 5:
            parts.append("lăm")
        elif ones:
            parts.append(_DIGIT_WORDS[ones])
    return " ".join(parts)


def read_number(digits: str) -> str:
    """Chuỗi chữ số -> cách đọc tiếng Việt."""

    if not digits.isdigit():
        return digits
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


_LETTER_DIGIT = re.compile(r"(?<=[A-Za-zÀ-ỹ])(?=\d)|(?<=\d)(?=[A-Za-zÀ-ỹ])")
_VERSION = re.compile(r"\b\d+(?:\.\d+){2,}\b")
_GROUPED = re.compile(r"\b(\d{1,3}(?:[.,]\d{3})+)\b(?![.,]?\d)")
_DECIMAL = re.compile(r"\b(\d+)[.,](\d{1,2})\b")
_INTEGER = re.compile(r"\d+")


def _read_decimal(match: re.Match) -> str:
    whole, fraction = match.group(1), match.group(2)
    digits = " ".join(_DIGIT_WORDS[int(d)] for d in fraction)
    return f"{read_number(whole)} phẩy {digits}"


def normalize_numbers(text: str) -> str:
    """Đổi mọi chữ số trong câu sang chữ đọc được.

    Thứ tự có ý nghĩa: _GROUPED phải chạy trước _VERSION, nếu không 1.234.567
    bị đọc thành số phiên bản.
    """

    text = _LETTER_DIGIT.sub(" ", text)
    text = text.replace("%", " phần trăm")
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
    normalized = _BRACKETS.sub(" ", normalized.replace("_", " "))
    normalized = _IDENTIFIER_DOT.sub(" ", normalized)
    normalized = _SPOKEN_TERM_RE.sub(
        lambda match: _SPOKEN_TERMS[match.group(0).upper()], normalized
    )
    normalized = _ACRONYM_RE.sub(_spell_if_acronym, normalized)
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


_LEGACY_VOICE_IDS = {
    "diem_trinh", "hung_thinh", "mai_linh", "mai_loan", "manh_dung", "my_yen",
    "ngoc_huyen", "phat_tai", "thanh_dat", "thuc_trinh", "tuan_ngoc", "storyvert",
    "duc_an", "duc_duy",
}


class VieneuNanoEngine:
    """VieNeu-TTS v3 Nano ONNX engine, chạy hoàn toàn trên CPU."""

    name = "VieNeu-TTS v3 Nano (ONNX, CPU, local)"
    sample_rate = SAMPLE_RATE

    def __init__(self, runtime=None) -> None:
        import numpy as np

        self._np = np
        if runtime is None:
            from vieneu import Vieneu

            threads = int(os.environ.get("ORT_THREADS", "0") or 0)
            runtime = Vieneu(
                mode="v3nano",
                steps=VIENEU_STEPS,
                cfg=VIENEU_CFG,
                threads=threads,
                **({"onnx_dir": str(VIENEU_MODEL_DIR)}
                   if all((VIENEU_MODEL_DIR / name).is_file() for name in _VIENEU_MODEL_FILES)
                   else {}),
            )
        self._runtime = runtime
        self._voices = self._load_voices()
        self._default_voice = os.environ.get("VIENEU_VOICE", "Adam").strip()
        if self._default_voice not in self._voices:
            self._default_voice = next(iter(self._voices), "")
        if not self._default_voice:
            raise RuntimeError("VieNeu Nano không có preset voice nào")
        self.sample_rate = int(getattr(runtime, "sample_rate", SAMPLE_RATE))

        if len(self._runtime.infer("Xin chào.", voice=self._default_voice,
                                  steps=VIENEU_STEPS, cfg=VIENEU_CFG,
                                  apply_watermark=False)) == 0:
            raise RuntimeError("VieNeu Nano warm-up không tạo được audio")
        logger.info(
            "VieNeu Nano sẵn sàng: voice=%s | sample_rate=%d",
            self._default_voice,
            self.sample_rate,
        )

    def _load_voices(self) -> dict[str, str]:
        return {
            voice_id: label
            for label, voice_id in self._runtime.list_preset_voices()
        }

    def list_voices(self) -> list[dict[str, str]]:
        """Trả danh sách voice theo hợp đồng API hiện tại."""

        return [
            {"name": name, "label": label}
            for name, label in sorted(self._voices.items())
        ]

    def _resolve_voice(self, voice: str) -> str:
        name = (
            voice.strip()
            if voice and voice.strip() != "vi"
            else self._default_voice
        )
        if name in _LEGACY_VOICE_IDS:
            return self._default_voice
        if name not in self._voices:
            raise ValueError(f"Không có voice VieNeu Nano {name!r}")
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
        audio = self._runtime.infer(
            spoken_text,
            voice=voice_name,
            speed=speed,
            steps=VIENEU_STEPS,
            cfg=VIENEU_CFG,
            apply_watermark=False,
        )

        audio = self._np.asarray(audio, dtype=self._np.float32).reshape(-1)
        if len(audio) == 0 or not self._np.isfinite(audio).all():
            raise RuntimeError("VieNeu Nano trả về audio rỗng hoặc không hợp lệ")

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


def load_engine() -> VieneuNanoEngine:
    """Nạp VieNeu Nano và warm-up trước khi server báo sẵn sàng."""

    return VieneuNanoEngine()
