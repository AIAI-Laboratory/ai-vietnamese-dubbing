"""G2P cho câu tiếng Việt có lẫn thuật ngữ tiếng Anh."""

from __future__ import annotations

import re
import threading

from vig2p import fix_phonemes
from vig2p.core import WORD_RE, tokenize_text

_backend = None
_backend_lock = threading.Lock()

_VI_MARKERS = re.compile(r"[1-7ɗɣɲʐ]|t̪|ɜ(?!ː)")
_EN_MARKERS = re.compile(r"[ʊʌðɚɝɾᵻʒɑɡ]|ɜː|iː|uː|oʊ|eɪ|aɪ|aʊ|dʒ|(?<!t)ʃ")

_TO_VIETNAMESE: tuple[tuple[str, str], ...] = (
    ("dʒ", "ʝ"),
    ("ɜː", "ə"),
    ("iː", "i"),
    ("uː", "u"),
    ("ɑː", "a"),
    ("ɔː", "ɔ"),
    ("ɪ", "i"),
    ("ʊ", "u"),
    ("ʌ", "ə"),
    ("ɚ", "ə"),
    ("ɝ", "ə"),
    ("ᵻ", "i"),
    ("ɑ", "a"),
    ("ð", "d"),
    ("ʃ", "ʂ"),
    ("ʒ", "ʝ"),
    ("ɾ", "t"),
    ("ɡ", "ɣ"),
    ("̩", ""),
)


def backend():
    """Trả về SEAPipeline dùng chung.

    vig2p.phonemize_text() dựng backend mới mỗi lần gọi, mà fit_to_context gọi
    nó hàng chục lần cho một câu dài.
    """

    global _backend
    if _backend is None:
        with _backend_lock:
            if _backend is None:
                from sea_g2p import SEAPipeline

                _backend = SEAPipeline(lang="vi")
    return _backend


def _looks_english(raw: str) -> bool:
    """Cho biết sea_g2p vừa đọc từ này bằng từ điển tiếng Anh hay tiếng Việt."""

    return bool(_EN_MARKERS.search(raw)) and not _VI_MARKERS.search(raw)


def to_vietnamese_sounds(phonemes: str) -> str:
    """Viết lại IPA tiếng Anh bằng bộ âm giọng tiếng Việt đọc được.

    Giọng Kokoro-Vietnamese chưa từng nghe ʊ ʌ ð ɚ ɾ ᵻ ʒ ɑ ɡ trong lúc học, giữ
    nguyên chúng thì phát ra âm không đoán trước được.
    """

    for english, vietnamese in _TO_VIETNAMESE:
        phonemes = phonemes.replace(english, vietnamese)
    return phonemes


def phonemize(text: str) -> str:
    """Chuyển câu thành phoneme, hậu xử lý theo ngôn ngữ của từng từ.

    Không dùng vig2p.phonemize_text: nó áp luật tiếng Việt cho cả từ tiếng Anh,
    biến nguyên âm ɜː thành dấu thanh nên "server" mất hẳn vần.
    """

    engine = backend()
    pieces: list[str] = []
    for token in tokenize_text(text):
        if token.isspace():
            pieces.append(" ")
        elif WORD_RE.match(token):
            result = engine.run(token)
            raw = result[0] if isinstance(result, tuple) else str(result)
            if _looks_english(raw):
                pieces.append(to_vietnamese_sounds(raw))
            else:
                pieces.append(fix_phonemes(raw, source_text=token))
        else:
            pieces.append(token)
    return "".join(pieces)
