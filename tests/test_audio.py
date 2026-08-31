"""Đường ống audio: ghép timeline, đường bao ducking, khe thời gian, voicepack."""

import base64
import math
import pickle
import struct
import tempfile
import tracemalloc
import unittest
import wave
import zipfile
from pathlib import Path

import conftest  # noqa: F401

import audio_pipeline as ap
import kokoro_onnx


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
        # Câu đầu dài 2s nhưng câu kế bắt đầu ở giây thứ 1.
        out = self.build([(0.0, 2.0), (1.0, 0.5)], 3.0)
        self.assertEqual(len(read_frames(out)), int(3.0 * ap.SAMPLE_RATE))

    def test_output_is_never_longer_than_the_video(self):
        out = self.build([(0.0, 1.0), (2.5, 2.0)], 3.0)
        self.assertEqual(len(read_frames(out)), int(3.0 * ap.SAMPLE_RATE))

    def test_sentence_starting_past_the_end_is_dropped(self):
        out = self.build([(0.0, 0.5), (99.0, 0.5)], 2.0)
        self.assertEqual(len(read_frames(out)), int(2.0 * ap.SAMPLE_RATE))

    def test_memory_does_not_scale_with_video_length(self):
        # Bản trước dựng cả timeline trong RAM rồi copy: video 1 tiếng ~825 MB.
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
        # Release tau 0.4s: sau 1.5s im lặng còn cách mức nền vài phần nghìn,
        # cộng sai số lượng tử 8-bit.
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
        # Mảng rỗng lọt xuống client sẽ thành âm lượng NaN, nên phải trả None.
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


class VoicepackLoaderTest(unittest.TestCase):
    """Voicepack là file pickle tải từ mạng — đây là bề mặt tấn công."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def write_pt(self, path, payload, storage_bytes):
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("vp/data.pkl", payload)
            archive.writestr("vp/data/0", storage_bytes)

    def rebuild_payload(self, size, stride, offset=0, numel=1):
        """Dựng đúng chuỗi opcode mà torch.save sinh ra cho một tensor.

        Viết tay thay vì gọi torch, vì torch cố tình không còn được cài trong
        môi trường chạy server.
        """

        def text(value):
            raw = value.encode()
            return b"X" + len(raw).to_bytes(4, "little") + raw

        def number(value):
            return b"J" + int(value).to_bytes(4, "little", signed=True)

        def tuple_of(values):
            return b"(" + b"".join(number(v) for v in values) + b"t"

        return b"".join([
            b"\x80\x02",                                  # PROTO 2
            b"ctorch._utils\n_rebuild_tensor_v2\n",       # GLOBAL: hàm dựng tensor
            b"(",                                         # MARK: tuple tham số
            b"(",                                         # MARK: persistent id
            text("storage"),
            b"ctorch\nFloatStorage\n",                    # GLOBAL: kiểu lưu trữ
            text("0"), text("cpu"), number(numel),
            b"tQ",                                        # TUPLE, BINPERSID
            number(offset),
            tuple_of(size),
            tuple_of(stride),
            b"\x89",                                      # requires_grad = False
            b"}",                                         # backward_hooks = {}
            b"tR.",                                       # TUPLE, REDUCE, STOP
        ])

    def test_reads_a_normal_voicepack(self):
        import numpy as np

        source = np.arange(3 * 1 * 256, dtype=np.float32)
        path = self.dir / "ok.pt"
        self.write_pt(
            path,
            self.rebuild_payload((3, 1, 256), (256, 256, 1), numel=source.size),
            source.tobytes(),
        )
        loaded = kokoro_onnx.load_voicepack(path)
        self.assertEqual(loaded.shape, (3, 1, 256))
        self.assertTrue(np.array_equal(loaded, source.reshape(3, 1, 256)))

    def test_refuses_shape_that_reaches_past_the_stored_data(self):
        # as_strided không kiểm biên: shape dối trá đọc được ra ngoài buffer.
        import numpy as np

        source = np.zeros(1 * 1 * 256, dtype=np.float32)
        path = self.dir / "evil.pt"
        self.write_pt(
            path,
            self.rebuild_payload((10_000, 1, 256), (256, 256, 1), numel=source.size),
            source.tobytes(),
        )
        with self.assertRaises(ValueError):
            kokoro_onnx.load_voicepack(path)

    def test_refuses_negative_stride(self):
        import numpy as np

        source = np.zeros(256, dtype=np.float32)
        path = self.dir / "neg.pt"
        self.write_pt(
            path,
            self.rebuild_payload((1, 1, 256), (256, 256, -1), numel=source.size),
            source.tobytes(),
        )
        with self.assertRaises(ValueError):
            kokoro_onnx.load_voicepack(path)

    def test_refuses_a_file_that_is_not_a_voicepack(self):
        path = self.dir / "empty.pt"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("readme.txt", "trống")
        with self.assertRaises(ValueError):
            kokoro_onnx.load_voicepack(path)

    def test_refuses_a_pickle_that_calls_something_else(self):
        # Voicepack cố gọi os.system phải bị unpickler chặn.
        path = self.dir / "rce.pt"
        payload = b"\x80\x02cos\nsystem\nX\x04\x00\x00\x00echo\x85R."
        self.write_pt(path, payload, b"")
        with self.assertRaises(pickle.UnpicklingError):
            kokoro_onnx.load_voicepack(path)

    def test_refuses_wrong_shape(self):
        import numpy as np

        source = np.zeros(64, dtype=np.float32)
        path = self.dir / "shape.pt"
        self.write_pt(
            path,
            self.rebuild_payload((64,), (1,), numel=source.size),
            source.tobytes(),
        )
        with self.assertRaises(ValueError):
            kokoro_onnx.load_voicepack(path)


class SentenceChunkingTest(unittest.TestCase):
    """Cửa sổ phoneme của model là 512; phụ đề tự động không có dấu câu."""

    def test_short_text_is_left_alone(self):
        self.assertEqual(kokoro_onnx.fit_to_context("Xin chào.", 512), ["Xin chào."])

    def test_long_unpunctuated_text_is_split_to_fit(self):
        text = "linux la he dieu hanh ma nguon mo rat pho bien " * 40
        pieces = kokoro_onnx.fit_to_context(text, 512)
        self.assertGreater(len(pieces), 1)
        for piece in pieces:
            self.assertLessEqual(len(kokoro_onnx.phonemize(piece)), 510)
        self.assertEqual("".join(pieces).replace(" ", ""), text.replace(" ", ""))

    def test_a_single_token_longer_than_the_window_is_still_split(self):
        pieces = kokoro_onnx.fit_to_context("a" * 900, 512)
        self.assertGreater(len(pieces), 1)
        for piece in pieces:
            self.assertLessEqual(len(kokoro_onnx.phonemize(piece)), 510)

    def test_sentence_splitting_keeps_decimals_together(self):
        self.assertEqual(kokoro_onnx.split_text("Giá là 3.5 đồng."), ["Giá là 3.5 đồng."])

    def test_empty_text_produces_no_chunks(self):
        self.assertEqual(kokoro_onnx.split_text("   "), [])


if __name__ == "__main__":
    unittest.main()


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
