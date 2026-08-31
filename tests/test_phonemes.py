"""Kiểm tra G2P với câu tiếng Việt lẫn thuật ngữ tiếng Anh."""

import json
import re
import unittest
from pathlib import Path

import phonemes

VIETNAMESE_SOUNDS = set("abcdefhijklmnopstuvwxyzæăŋɔəɛɣɪɲɹʂʈʔʝʧθˈˌː→↓↗↘")

ENGLISH_TERMS = [
    "server", "learning", "code", "data", "helper", "button", "image", "video",
    "model", "object", "function", "python", "update", "user", "review",
    "machine", "feature", "layer", "network", "output", "the", "this",
]

VIETNAMESE_SENTENCES = [
    "Chúng ta sẽ tìm hiểu cách máy tính xử lý dữ liệu.",
    "Sinh viên cần nắm vững kiến thức nền tảng.",
    "Trong phần tiếp theo, tôi trình bày cách giải quyết bài toán.",
]


def sounds(text):
    return {c for c in phonemes.phonemize(text) if not c.isspace() and c not in ".,;:!?-—"}


class TestEnglishInVietnamese(unittest.TestCase):
    def test_english_words_use_only_vietnamese_sounds(self):
        for term in ENGLISH_TERMS:
            with self.subTest(term=term):
                self.assertLessEqual(sounds(term), VIETNAMESE_SOUNDS)

    def test_english_vowels_survive(self):
        """ɜː từng bị VI_FIXUPS biến thành dấu thanh, xoá sạch nguyên âm của từ."""

        for term in ("server", "learning", "search", "world", "first"):
            with self.subTest(term=term):
                out = phonemes.phonemize(term)
                self.assertNotIn("↗", out)
                self.assertTrue(re.search(r"[aeiouəɛɔæ]", out), out)

    def test_english_s_is_not_retroflex(self):
        self.assertTrue(phonemes.phonemize("save").startswith("s"))
        self.assertTrue(phonemes.phonemize("server").startswith("s"))

    def test_vietnamese_s_stays_retroflex(self):
        self.assertTrue(phonemes.phonemize("sinh").startswith("ʂ"))

    def test_vietnamese_unchanged(self):
        """Đường tiếng Việt phải giống hệt vig2p, đây là phần đã chạy tốt."""

        from vig2p import phonemize_text

        for sentence in VIETNAMESE_SENTENCES:
            with self.subTest(sentence=sentence):
                self.assertEqual(
                    phonemes.phonemize(sentence),
                    phonemize_text(sentence, phonemes.backend()),
                )

    def test_mixed_sentence_stays_in_model_vocabulary(self):
        config = Path.home() / (
            ".cache/huggingface/hub/models--contextboxai--Kokoro-Vietnamese"
            "/snapshots/9f210d622209fcc216fe2ac6159fed2ff381cb8a/config.json"
        )
        if not config.exists():
            self.skipTest("chưa tải model")
        vocab = json.loads(config.read_text(encoding="utf-8"))["vocab"]
        out = phonemes.phonemize("Nhấn nút save trên server để lưu code.")
        self.assertEqual([c for c in out if c not in vocab], [])

    def test_backend_is_shared(self):
        self.assertIs(phonemes.backend(), phonemes.backend())


if __name__ == "__main__":
    unittest.main()
