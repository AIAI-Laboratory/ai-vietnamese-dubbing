"""Đường ống audio: ghép timeline, đường bao ducking và khe thời gian."""

import base64
import math
import struct
import tempfile
import tracemalloc
import unittest
import wave
from pathlib import Path

import conftest  # noqa: F401

import audio_pipeline as ap


def write_wav(path: Path, samples: list[int]) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(ap.SAMPLE_RATE)
        handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def read_frames(path: Path) -> list[int]:
    with wave.open(str(path), "rb") as handle:
        raw = handle.readframes(handle.getnframes())
    return list(struct.unpack(f"<{len(raw) // 2}h", raw))


def tone(seconds: float, amplitude: int = 12000) -> list[int]:
    frames = int(seconds * ap.SAMPLE_RATE)
    return [int(amplitude * math.sin(i / 30)) for i in range(frames)]


class TimelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, specs, duration):
        segments = []
        for index, (start, seconds) in enumerate(specs):
            path = self.dir / f"seg{index}.wav"
            write_wav(path, tone(seconds))
            segments.append(({"start": start, "end": start + seconds}, path))
        out = self.dir / "master.wav"
        ap.assemble_timeline(segments, duration, out)
        return out

    def test_sentence_lands_at_its_absolute_timestamp(self):
        out = self.build([(1.0, 0.5)], 3.0)
        frames = read_frames(out)
        self.assertEqual(len(frames), int(3.0 * ap.SAMPLE_RATE))
        self.assertEqual(set(frames[: ap.SAMPLE_RATE - 1]), {0})
        self.assertTrue(any(frames[ap.SAMPLE_RATE : ap.SAMPLE_RATE + 100]))
        self.assertEqual(set(frames[int(1.6 * ap.SAMPLE_RATE) :]), {0})

    def test_unordered_input_is_placed_by_timestamp(self):
        out = self.build([(2.0, 0.4), (0.2, 0.4)], 4.0)
        frames = read_frames(out)
        self.assertTrue(any(frames[int(0.2 * ap.SAMPLE_RATE) : int(0.5 * ap.SAMPLE_RATE)]))
        self.assertTrue(any(frames[int(2.0 * ap.SAMPLE_RATE) : int(2.3 * ap.SAMPLE_RATE)]))

    def test_sentence_never_spills_into_the_next_one(self):
        out = self.build([(0.0, 2.0), (1.0, 0.5)], 3.0)
        self.assertEqual(len(read_frames(out)), int(3.0 * ap.SAMPLE_RATE))

    def test_output_is_never_longer_than_the_video(self):
        out = self.build([(0.0, 1.0), (2.5, 2.0)], 3.0)
        self.assertEqual(len(read_frames(out)), int(3.0 * ap.SAMPLE_RATE))

    def test_sentence_starting_past_the_end_is_dropped(self):
        out = self.build([(0.0, 0.5), (99.0, 0.5)], 2.0)
        self.assertEqual(len(read_frames(out)), int(2.0 * ap.SAMPLE_RATE))

    def test_memory_does_not_scale_with_video_length(self):
        path = self.dir / "one.wav"
        write_wav(path, tone(0.2))
        tracemalloc.start()
        ap.assemble_timeline([({"start": 1.0, "end": 1.2}, path)], 3600.0, self.dir / "long.wav")
        peak = tracemalloc.get_traced_memory()[1]
        tracemalloc.stop()
        self.assertLess(peak, 8 * 1024 * 1024, f"đỉnh RAM {peak / 1024 / 1024:.1f} MB")


class DuckEnvelopeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "master.wav"

    def tearDown(self):
        self.tmp.cleanup()

    def gains(self, speech_sec, silence_sec):
        write_wav(self.path, tone(speech_sec, 16000) + [0] * int(silence_sec * ap.SAMPLE_RATE))
        envelope = ap.duck_envelope(self.path)
        self.assertEqual(envelope["fps"], ap.DUCK_FPS)
        return [b / 255 for b in base64.b64decode(envelope["data"])]

    def test_bed_drops_under_speech_and_returns_in_silence(self):
        gains = self.gains(1.0, 1.5)
        self.assertLess(gains[ap.DUCK_FPS - 1], ap.DUCK_SPEAKING + 0.02)
        self.assertGreater(gains[-1], ap.DUCK_SILENT - 0.01)

    def test_attack_is_faster_than_release(self):
        gains = self.gains(1.0, 1.0)
        span = ap.DUCK_SILENT - ap.DUCK_SPEAKING
        drop = (ap.DUCK_SILENT - gains[int(0.1 * ap.DUCK_FPS)]) / span
        rise = (gains[int(1.1 * ap.DUCK_FPS)] - gains[ap.DUCK_FPS - 1]) / span
        self.assertGreater(drop, rise)
        self.assertGreater(drop, 0.5)

    def test_silent_track_never_ducks(self):
        gains = self.gains(0.0, 2.0)
        self.assertTrue(all(g >= ap.DUCK_SILENT - 1 / 255 for g in gains))

    def test_track_shorter_than_one_frame_has_no_envelope(self):
        write_wav(self.path, [0] * 100)
        self.assertIsNone(ap.duck_envelope(self.path))

    def test_envelope_length_matches_the_track(self):
        gains = self.gains(0.0, 3.0)
        self.assertEqual(len(gains), int(3.0 * ap.DUCK_FPS))


class AvailableSlotsTest(unittest.TestCase):
    def test_borrows_silence_up_to_the_next_sentence(self):
        slots = ap.available_slots(
            [{"id": 1, "start": 0.0, "end": 2.0}, {"id": 2, "start": 5.0, "end": 6.0}], 10.0
        )
        self.assertAlmostEqual(slots[1], 5.0 - ap.BORROW_GAP_SEC)
        self.assertAlmostEqual(slots[2], 10.0 - ap.BORROW_GAP_SEC - 5.0)

    def test_never_shrinks_below_the_subtitle_slot(self):
        slots = ap.available_slots(
            [{"id": 1, "start": 0.0, "end": 3.0}, {"id": 2, "start": 3.0, "end": 4.0}], 4.0
        )
        self.assertAlmostEqual(slots[1], 3.0)

    def test_handles_unsorted_and_overlapping_input(self):
        slots = ap.available_slots(
            [{"id": 2, "start": 4.0, "end": 6.0}, {"id": 1, "start": 0.0, "end": 5.0}], 8.0
        )
        self.assertAlmostEqual(slots[1], 5.0)
        self.assertAlmostEqual(slots[2], 8.0 - ap.BORROW_GAP_SEC - 4.0)


class WindowPlanTest(unittest.TestCase):
    """Cửa sổ để phát dần: ranh giới phải rơi đúng mốc bắt đầu một câu."""

    def segments(self, count, step=7.0, length=5.0):
        return [{"id": i + 1, "start": i * step, "end": i * step + length} for i in range(count)]

    def test_windows_tile_the_video_without_gaps(self):
        windows = ap.plan_windows(self.segments(12), 90.0, target_sec=30.0)
        self.assertEqual(windows[0]["startSec"], 0.0)
        self.assertGreaterEqual(windows[-1]["endSec"], 90.0)
        for earlier, later in zip(windows, windows[1:]):
            self.assertEqual(earlier["endSec"], later["startSec"])

    def test_no_sentence_is_lost_or_duplicated(self):
        segments = self.segments(12)
        ids = [i for w in ap.plan_windows(segments, 90.0, target_sec=30.0) for i in w["segmentIds"]]
        self.assertEqual(ids, sorted(ids))
        self.assertEqual(sorted(ids), [s["id"] for s in segments])

    def test_a_boundary_always_falls_on_a_sentence_start(self):
        segments = self.segments(12)
        starts = {s["start"] for s in segments}
        windows = ap.plan_windows(segments, 90.0, target_sec=30.0)
        for window in windows[1:]:
            self.assertIn(window["startSec"], starts)

    def test_one_sentence_gives_one_window_covering_the_video(self):
        windows = ap.plan_windows([{"id": 1, "start": 5.0, "end": 8.0}], 60.0)
        self.assertEqual(len(windows), 1)
        self.assertEqual(windows[0]["startSec"], 0.0)
        self.assertEqual(windows[0]["endSec"], 60.0)

    def test_no_segments_gives_no_windows(self):
        self.assertEqual(ap.plan_windows([], 60.0), [])

    def test_unsorted_input_is_ordered_first(self):
        segments = list(reversed(self.segments(8)))
        windows = ap.plan_windows(segments, 60.0, target_sec=20.0)
        starts = [w["startSec"] for w in windows]
        self.assertEqual(starts, sorted(starts))


class NumberReadingTest(unittest.TestCase):
    """Chữ số phải được đổi sang cách đọc tiếng Việt trước khi tổng hợp."""

    def spoken(self, text):
        import tts_engine

        return tts_engine.normalize_for_speech(text)

    def test_reads_plain_integers(self):
        cases = {
            "0": "không",
            "7": "bảy",
            "10": "mười",
            "100": "một trăm",
            "1000": "một nghìn",
            "1000000": "một triệu",
            "2000000000": "hai tỷ",
        }
        for digits, expected in cases.items():
            with self.subTest(digits=digits):
                self.assertEqual(self.spoken(digits), expected)

    def test_follows_vietnamese_irregular_forms(self):
        self.assertEqual(self.spoken("15"), "mười lăm")
        self.assertEqual(self.spoken("21"), "hai mươi mốt")
        self.assertEqual(self.spoken("24"), "hai mươi tư")
        self.assertEqual(self.spoken("25"), "hai mươi lăm")
        self.assertEqual(self.spoken("105"), "một trăm lẻ năm")

    def test_splits_letters_from_digits(self):
        self.assertEqual(self.spoken("SAVE10"), "SAVE mười")
        self.assertEqual(self.spoken("mã save 20"), "mã save hai mươi")

    def test_thousands_separator_is_not_a_decimal_point(self):
        self.assertEqual(self.spoken("1.000"), "một nghìn")
        self.assertEqual(self.spoken("1,000"), "một nghìn")
        self.assertEqual(self.spoken("1.234.567"),
                         "một triệu hai trăm ba mươi tư nghìn năm trăm sáu mươi bảy")

    def test_decimals_and_percent(self):
        self.assertEqual(self.spoken("3.14"), "ba phẩy một bốn")
        self.assertEqual(self.spoken("50%"), "năm mươi phần trăm")

    def test_version_numbers_say_cham(self):
        self.assertEqual(self.spoken("3.11.4"), "ba chấm mười một chấm bốn")

    def test_identifiers_are_spelled_out(self):
        self.assertEqual(self.spoken("007"), "không không bảy")
        self.assertEqual(self.spoken("0912"), "không chín một hai")

    def test_no_digit_survives_into_the_phonemiser(self):
        samples = ["Bài 12 nói về 3 quy tắc.", "Giảm 50% cho mã SAVE10.",
                   "Có 1.000 dòng code trong Python 3.11.4."]
        for sample in samples:
            with self.subTest(sample=sample):
                spoken = self.spoken(sample)
                self.assertFalse(any(ch.isdigit() for ch in spoken), spoken)
                self.assertGreater(len(spoken), 20)
