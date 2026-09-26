import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

import conftest  # noqa: F401
import tts_engine


class FakeVieneu:
    sample_rate = 24000

    def __init__(self):
        self.calls = []

    def list_preset_voices(self):
        return [("Giọng A", "voice-a"), ("Giọng B", "voice-b")]

    def infer(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return np.array([0.0, 0.5, -0.5, 0.0], dtype=np.float32)


class VieneuNanoEngineTest(unittest.TestCase):
    def test_synth_writes_vieneu_audio_and_passes_nano_settings(self):
        runtime = FakeVieneu()
        engine = tts_engine.VieneuNanoEngine(runtime=runtime)
        runtime.calls.clear()

        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "speech.wav"
            result = engine.synth("Xin chào", output, voice="voice-b", speed=1.1)

            with wave.open(str(output), "rb") as audio:
                self.assertEqual(audio.getframerate(), 24000)
                self.assertEqual(audio.getnchannels(), 1)
                self.assertEqual(audio.getsampwidth(), 2)
                self.assertEqual(audio.getnframes(), 4)

        self.assertEqual(result.wav_path, output)
        self.assertAlmostEqual(result.duration_sec, 4 / 24000)
        self.assertEqual(runtime.calls[0][0], "Xin chào")
        self.assertEqual(runtime.calls[0][1]["voice"], "voice-b")
        self.assertEqual(runtime.calls[0][1]["steps"], 16)
        self.assertEqual(runtime.calls[0][1]["cfg"], 3.0)
        self.assertEqual(runtime.calls[0][1]["speed"], 1.1)
        self.assertFalse(runtime.calls[0][1]["apply_watermark"])

    def test_legacy_voice_id_falls_back_to_nano_default(self):
        runtime = FakeVieneu()
        engine = tts_engine.VieneuNanoEngine(runtime=runtime)
        runtime.calls.clear()

        with tempfile.TemporaryDirectory() as temp:
            engine.synth("Xin chào", Path(temp) / "speech.wav", voice="diem_trinh")

        self.assertEqual(runtime.calls[0][1]["voice"], "voice-a")


if __name__ == "__main__":
    unittest.main()
