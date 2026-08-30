"""Kokoro-Vietnamese ONNX engine chạy hoàn toàn trên CPU."""

from __future__ import annotations

import logging
import os
import re
import threading
import unicodedata
import wave
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("tts_engine")

SAMPLE_RATE = 24000
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


class KokoroOnnxEngine:
    """Một ONNX session dùng chung, voicepack được cache và đổi dưới lock."""

    name = "Kokoro-Vietnamese ONNX (CPU, local)"
    sample_rate = SAMPLE_RATE

    def __init__(self) -> None:
        import numpy as np
        import torch
        from huggingface_hub import hf_hub_download
        from kokoro_vietnamese import (
            DEFAULT_CONFIG_FILE,
            DEFAULT_HF_REPO_ID,
            DEFAULT_ONNX_FILE,
            DEFAULT_VOICE,
            VOICES,
        )
        from kokoro_vietnamese.onnx_cli import KokoroVietnameseONNX

        self._np = np
        self._torch = torch
        self._hf_hub_download = hf_hub_download
        self._repo_id = DEFAULT_HF_REPO_ID
        self._voices = VOICES
        self._default_voice = os.environ.get("KOKORO_VOICE", DEFAULT_VOICE).strip()
        if self._default_voice not in self._voices:
            available = ", ".join(sorted(self._voices))
            raise ValueError(
                f"KOKORO_VOICE={self._default_voice!r} không hợp lệ. Có: {available}"
            )

        self._lock = threading.Lock()
        model_path = hf_hub_download(
            repo_id=self._repo_id,
            filename=DEFAULT_ONNX_FILE,
            revision=MODEL_REVISION,
        )
        config_path = hf_hub_download(
            repo_id=self._repo_id,
            filename=DEFAULT_CONFIG_FILE,
            revision=MODEL_REVISION,
        )
        voicepack_path = hf_hub_download(
            repo_id=self._repo_id,
            filename=self._voices[self._default_voice]["filename"],
            revision=MODEL_REVISION,
        )
        self._runtime = KokoroVietnameseONNX(
            device="cpu",
            voice=self._default_voice,
            onnx_path=model_path,
            config_path=config_path,
            voicepack_path=voicepack_path,
        )
        self._voicepacks = {self._default_voice: self._runtime.voicepack}

        # Warm-up một lần để request đầu tiên không chịu chi phí tối ưu graph.
        audio, _ = self._runtime.synthesize("Xin chào.", crossfade_ms=0)
        if len(audio) == 0:
            raise RuntimeError("Kokoro warm-up không tạo được audio")
        logger.info(
            "Kokoro sẵn sàng: voice=%s | providers=%s",
            self._default_voice,
            self._runtime.session.get_providers(),
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

    def _load_voicepack(self, voice: str):
        cached = self._voicepacks.get(voice)
        if cached is not None:
            return cached
        path = self._hf_hub_download(
            repo_id=self._repo_id,
            filename=self._voices[voice]["filename"],
            revision=MODEL_REVISION,
        )
        voicepack = self._torch.load(path, map_location="cpu", weights_only=True)
        self._voicepacks[voice] = voicepack
        return voicepack

    def synth(self, text: str, out_path: Path, voice: str = "") -> SynthResult:
        """Tổng hợp một segment thành WAV mono PCM 16-bit."""

        spoken_text = normalize_for_speech(text)
        if not spoken_text:
            raise ValueError("Văn bản TTS không được để trống")

        voice_name = self._resolve_voice(voice)
        with self._lock:
            self._runtime.voicepack = self._load_voicepack(voice_name)
            audio, _ = self._runtime.synthesize(spoken_text)

        audio = self._np.asarray(audio, dtype=self._np.float32).reshape(-1)
        if len(audio) == 0 or not self._np.isfinite(audio).all():
            raise RuntimeError("Kokoro trả về audio rỗng hoặc không hợp lệ")

        pcm = (self._np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        with wave.open(str(out_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(pcm)
        return SynthResult(out_path, len(audio) / self.sample_rate)


def load_engine() -> KokoroOnnxEngine:
    """Nạp model ONNX và warm-up trước khi server báo sẵn sàng."""

    return KokoroOnnxEngine()
