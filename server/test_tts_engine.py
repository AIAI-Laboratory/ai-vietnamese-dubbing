import unittest
import unicodedata

from tts_engine import count_vi_syllables, normalize_for_speech


class SpeechNormalizationTest(unittest.TestCase):
    def test_normalizes_common_technical_acronyms(self) -> None:
        text = normalize_for_speech("API gọi HTTPS và trả JSON.")
        self.assertEqual(text, "ây pi ai gọi hát ti ti pi ét và trả giây son.")
        self.assertEqual(count_vi_syllables("API"), 3)

    def test_preserves_words_and_nfc(self) -> None:
        text = normalize_for_speech("Giao diện framework ổn định.")
        self.assertIn("framework", text)
        self.assertTrue(unicodedata.is_normalized("NFC", text))


if __name__ == "__main__":
    unittest.main()
