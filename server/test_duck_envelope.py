"""Đường bao ducking: hạ nền khi có tiếng đọc, nâng lại khi im lặng."""

import base64
import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path

import audio_pipeline as ap


def _write_tone_then_silence(path: Path, tone_sec: float, silence_sec: float) -> None:
    """1 giây tiếng (sin biên độ lớn) rồi 1 giây im lặng tuyệt đối."""
    rate = ap.SAMPLE_RATE
    frames = []
    for i in range(int(tone_sec * rate)):
        frames.append(int(0.5 * 32767 * math.sin(2 * math.pi * 220 * i / rate)))
    frames.extend([0] * int(silence_sec * rate))
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(struct.pack(f"<{len(frames)}h", *frames))


class DuckEnvelopeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.wav = Path(self.tmp.name) / "master.wav"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _gains(self, tone_sec: float, silence_sec: float) -> list[float]:
        _write_tone_then_silence(self.wav, tone_sec, silence_sec)
        env = ap.duck_envelope(self.wav)
        self.assertEqual(env["fps"], ap.DUCK_FPS)
        return [b / 255 for b in base64.b64decode(env["data"])]

    def test_ducks_while_speaking_and_recovers_in_silence(self) -> None:
        gains = self._gains(tone_sec=1.0, silence_sec=1.5)
        self.assertEqual(len(gains), int(2.5 * ap.DUCK_FPS))
        # Cuối đoạn có tiếng: đã hạ xuống sát mức đọc.
        end_of_speech = gains[ap.DUCK_FPS - 1]
        self.assertLess(end_of_speech, ap.DUCK_SPEAKING + 0.02)
        # Cuối đoạn im lặng: đã dâng lại gần mức nền.
        self.assertGreater(gains[-1], ap.DUCK_SILENT - 0.05)

    def test_attack_is_faster_than_release(self) -> None:
        gains = self._gains(tone_sec=1.0, silence_sec=1.0)
        span = ap.DUCK_SILENT - ap.DUCK_SPEAKING
        # Sau 0.1s tiếng nói đã đi được phần lớn quãng đường xuống...
        drop = (ap.DUCK_SILENT - gains[int(0.1 * ap.DUCK_FPS)]) / span
        # ...còn sau 0.1s im lặng mới nhích lên một phần nhỏ.
        rise = (gains[int(1.1 * ap.DUCK_FPS)] - gains[ap.DUCK_FPS - 1]) / span
        self.assertGreater(drop, rise)
        self.assertGreater(drop, 0.5)

    def test_silent_track_never_ducks(self) -> None:
        gains = self._gains(tone_sec=0.0, silence_sec=2.0)
        # Đường bao truyền đi dưới dạng uint8 nên mỗi mẫu lệch tối đa nửa bước
        # lượng tử (1/255) so với mức lý thuyết.
        quantization_step = 1 / 255
        self.assertTrue(all(g >= ap.DUCK_SILENT - quantization_step for g in gains))


if __name__ == "__main__":
    unittest.main()
