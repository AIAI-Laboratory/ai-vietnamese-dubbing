"""Vòng đời job: dọn job quá hạn, chốt job_id, chặn body quá lớn."""

import os
import time
import unittest

os.environ.setdefault("API_KEY", "test-key")

from fastapi.testclient import TestClient

import main


class JobEvictionTest(unittest.TestCase):
    def setUp(self) -> None:
        main.JOBS.clear()

    def tearDown(self) -> None:
        main.JOBS.clear()

    def test_removes_finished_jobs_past_retention_and_their_files(self) -> None:
        stale_id = "a" * 16
        fresh_id = "b" * 16
        running_id = "c" * 16
        stale_dir = main.WORK_DIR / stale_id
        stale_dir.mkdir(parents=True, exist_ok=True)
        (stale_dir / "final.opus").write_bytes(b"x")
        expired_at = time.time() - (main.JOB_RETENTION_MIN + 1) * 60
        main.JOBS[stale_id] = {"status": "done", "finishedAt": expired_at}
        main.JOBS[fresh_id] = {"status": "done", "finishedAt": time.time()}
        # Job đang chạy chưa có finishedAt — không được dọn dù chạy lâu.
        main.JOBS[running_id] = {"status": "running", "finishedAt": 0.0}

        main._evict_old_jobs()

        self.assertEqual(set(main.JOBS), {fresh_id, running_id})
        self.assertFalse(stale_dir.exists())


class JobIdValidationTest(unittest.TestCase):
    def test_accepts_generated_shape_only(self) -> None:
        self.assertEqual(main._validated_job_id("0123456789abcdef"), "0123456789abcdef")
        for bad in ("..", "0123456789ABCDEF", "short", "0123456789abcdeff"):
            with self.assertRaises(main.HTTPException):
                main._validated_job_id(bad)


class HttpGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(main.app)
        self.headers = {"X-API-Key": os.environ["API_KEY"]}

    def test_rejects_body_over_limit_before_reading_it(self) -> None:
        res = self.client.post(
            "/api/debug/transcript",
            headers={**self.headers, "content-length": str(main.MAX_BODY_BYTES + 1)},
            content=b"{}",
        )
        self.assertEqual(res.status_code, 413)

    def test_rejects_malformed_job_id_on_audio_route(self) -> None:
        res = self.client.get("/audio/not-a-job-id.opus", headers=self.headers)
        self.assertEqual(res.status_code, 404)
        res = self.client.get(f"/audio/{'a' * 16}.exe", headers=self.headers)
        self.assertEqual(res.status_code, 404)

    def test_still_requires_api_key(self) -> None:
        self.assertEqual(self.client.get("/api/health").status_code, 401)


if __name__ == "__main__":
    unittest.main()
