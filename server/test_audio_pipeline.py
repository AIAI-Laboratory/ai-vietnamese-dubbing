"""Khe thời gian của từng câu sau khi mượn khoảng lặng của câu kế."""

import unittest

from audio_pipeline import BORROW_GAP_SEC, available_slots


class AvailableSlotsTest(unittest.TestCase):
    def test_borrows_silence_up_to_the_next_sentence(self) -> None:
        segments = [
            {"id": 1, "start": 0.0, "end": 2.0},
            {"id": 2, "start": 5.0, "end": 6.0},
        ]
        slots = available_slots(segments, duration_sec=10.0)
        self.assertAlmostEqual(slots[1], 5.0 - BORROW_GAP_SEC)
        # Câu cuối mượn tới hết video.
        self.assertAlmostEqual(slots[2], 10.0 - BORROW_GAP_SEC - 5.0)

    def test_never_shrinks_below_the_original_subtitle_slot(self) -> None:
        # Hai câu dính sát nhau: không còn khoảng lặng để mượn.
        segments = [
            {"id": 1, "start": 0.0, "end": 3.0},
            {"id": 2, "start": 3.0, "end": 4.0},
        ]
        slots = available_slots(segments, duration_sec=4.0)
        self.assertAlmostEqual(slots[1], 3.0)
        self.assertAlmostEqual(slots[2], 1.0)

    def test_handles_unsorted_and_overlapping_segments(self) -> None:
        segments = [
            {"id": 2, "start": 4.0, "end": 6.0},
            {"id": 1, "start": 0.0, "end": 5.0},  # chồng lấn câu sau
        ]
        slots = available_slots(segments, duration_sec=8.0)
        self.assertAlmostEqual(slots[1], 5.0)  # giữ khe gốc, không nới
        self.assertAlmostEqual(slots[2], 8.0 - BORROW_GAP_SEC - 4.0)


if __name__ == "__main__":
    unittest.main()
