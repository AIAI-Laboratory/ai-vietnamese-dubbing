import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

os.environ.setdefault("API_KEY", "test-key")
sys.path.insert(0, str(Path(__file__).parent))

from main import DEBUG_DIR, DEBUG_RETENTION_DAYS, DebugTranscriptRequest, _write_debug_transcript


class DebugTranscriptTest(unittest.TestCase):
    def test_default_directory_is_inside_project_server(self) -> None:
        self.assertEqual(DEBUG_DIR, Path(__file__).parent / "debug_transcripts")

    def test_writes_utf8_json_removes_expired_files_and_drops_secrets(self) -> None:
        request = DebugTranscriptRequest.model_validate(
            {
                "videoId": "course::lecture",
                "model": "model-id",
                "reviewModel": "quality-model-id",
                "apiBaseUrl": "https://example.test/v1",
                "durationSec": 10,
                "planVersion": "debug-v1",
                "viSyllablesPerSec": 2.6,
                "terminologyDraft": {"subject": "Kỹ thuật phần mềm"},
                "finalTranslation": [{"id": 1, "vi": "Bản dịch tiếng Việt."}],
                "apiKey": "must-not-be-saved",
                "serverApiKey": "must-not-be-saved",
            }
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            directory = Path(temp_dir)
            expired = directory / "expired.json"
            expired.write_text("{}", encoding="utf-8")
            old_time = time.time() - (DEBUG_RETENTION_DAYS + 1) * 86400
            os.utime(expired, (old_time, old_time))

            path = _write_debug_transcript(request.model_dump(), directory)
            payload = json.loads(path.read_text(encoding="utf-8"))

            self.assertFalse(expired.exists())
            self.assertEqual(payload["terminologyDraft"]["subject"], "Kỹ thuật phần mềm")
            self.assertEqual(payload["reviewModel"], "quality-model-id")
            self.assertEqual(payload["finalTranslation"][0]["vi"], "Bản dịch tiếng Việt.")
            self.assertNotIn("apiKey", payload)
            self.assertNotIn("serverApiKey", payload)


if __name__ == "__main__":
    unittest.main()
