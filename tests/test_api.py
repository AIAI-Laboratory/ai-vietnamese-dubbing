"""Hợp đồng HTTP: xác thực, giới hạn, vòng đời job.

Chạy từ gốc repo: python -m unittest discover -s tests -t tests
"""

import asyncio
import shutil
import time
import unittest

import conftest  # noqa: F401  (đặt sys.path + API_KEY trước khi import server)

import auth
import main
from fastapi.testclient import TestClient

KEY = {"X-API-Key": "test-key"}
JOB_BODY = {
    "voice": "",
    "durationSec": 10.0,
    "segments": [{"id": 1, "start": 0.0, "end": 5.0, "vi": "xin chào"}],
}


async def raw_request(headers):
    """Gọi thẳng ASGI app để gửi được header mà client HTTP thường chặn."""

    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": "GET", "path": "/api/health", "raw_path": b"/api/health",
        "query_string": b"", "root_path": "", "scheme": "http",
        "server": ("127.0.0.1", 18765), "client": ("127.0.0.1", 5555),
        "headers": headers,
    }
    sent = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    await main.app(scope, receive, send)
    return next(m["status"] for m in sent if m["type"] == "http.response.start")


class AuthTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_every_api_route_requires_the_key(self):
        for method, path in [
            ("get", "/api/health"), ("get", "/api/voices"),
            ("post", "/api/preview"), ("post", "/api/synthesize"),
            ("get", "/api/job/" + "a" * 16), ("get", f"/audio/{'a' * 16}/w0.opus"),
            ("delete", "/api/job/" + "a" * 16),
        ]:
            with self.subTest(path=path):
                self.assertEqual(getattr(self.client, method)(path).status_code, 401)

    def test_wrong_key_is_rejected(self):
        self.assertEqual(
            self.client.get("/api/health", headers={"X-API-Key": "sai"}).status_code, 401
        )

    def test_non_ascii_key_gives_401_not_an_exception(self):
        # Header HTTP được decode latin-1; compare_digest trên str như vậy ném
        # TypeError, và lỗi đó từng thoát ra khỏi ứng dụng.
        status = asyncio.run(raw_request([(b"host", b"x"), (b"x-api-key", b"caf\xe9")]))
        self.assertEqual(status, 401)

    def test_correct_key_passes(self):
        status = asyncio.run(raw_request([(b"host", b"x"), (b"x-api-key", b"test-key")]))
        self.assertEqual(status, 200)

    def test_docs_are_off_unless_enabled(self):
        # Swagger UI không khoá được bằng API key nên mặc định phải tắt.
        self.assertFalse(main.ENABLE_DOCS)
        for path in ("/docs", "/redoc", "/openapi.json"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)


class RequestLimitTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_declared_oversize_body_is_refused(self):
        res = self.client.post(
            "/api/synthesize",
            headers={**KEY, "content-length": str(main.MAX_BODY_BYTES + 1)},
            content=b"{}",
        )
        self.assertEqual(res.status_code, 413)

    def test_chunked_body_cannot_slip_past_the_limit(self):
        # Không khai Content-Length: bản trước chỉ nhìn header nên bỏ lọt.
        def stream():
            yield b'{"voice":"","durationSec":10,"segments":[{"id":1,"start":0,"end":5,"vi":"'
            for _ in range(main.MAX_BODY_BYTES // 100_000 + 5):
                yield b"x" * 100_000
            yield b'"}]}'

        res = self.client.post("/api/synthesize", headers=KEY, content=stream())
        self.assertEqual(res.status_code, 413)

    def test_malformed_job_id_index_and_extension_are_refused(self):
        for path in (
            "/audio/khong-hop-le/w0.opus",      # job id không đúng dạng
            f"/audio/{'a' * 16}/w0.exe",        # đuôi file không cho phép
            f"/audio/{'a' * 16}/w-1.opus",      # chỉ số âm
            f"/audio/{'a' * 16}/w999999.opus",  # chỉ số ngoài biên
            "/api/job/..%2f",
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path, headers=KEY).status_code, 404)


class JobLifecycleTest(unittest.TestCase):
    def setUp(self):
        main.JOBS.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        main.JOBS.clear()

    def test_rejects_jobs_when_disk_is_full(self):
        real = shutil.disk_usage
        shutil.disk_usage = lambda _p: type("U", (), {"total": 1 << 40, "used": 0, "free": 5 << 20})
        main.ENGINE = object()  # qua được cửa kiểm tra engine, tới cửa kiểm tra đĩa
        try:
            res = self.client.post(
                "/api/synthesize", headers=KEY, json={**JOB_BODY, "durationSec": 600.0}
            )
        finally:
            shutil.disk_usage = real
            main.ENGINE = None
        self.assertEqual(res.status_code, 507)
        self.assertIn("dung lượng", res.json()["detail"])

    def test_rejects_jobs_while_the_engine_is_unavailable(self):
        self.assertIsNone(main.ENGINE)  # engine chưa nạp trong test
        self.assertEqual(
            self.client.post("/api/synthesize", headers=KEY, json=JOB_BODY).status_code, 503
        )

    def test_queue_is_bounded(self):
        with main.JOBS_LOCK:
            for i in range(main.MAX_PENDING_JOBS):
                main.JOBS[f"{i:016x}"] = {"status": "queued", "finishedAt": 0.0}
        main.ENGINE = object()
        try:
            res = self.client.post("/api/synthesize", headers=KEY, json=JOB_BODY)
        finally:
            main.ENGINE = None
        self.assertEqual(res.status_code, 429)

    def test_cancelling_marks_the_job_and_the_worker_sees_it(self):
        job_id = "b" * 16
        with main.JOBS_LOCK:
            main.JOBS[job_id] = {"status": "running", "cancelled": False, "finishedAt": 0.0}
        res = self.client.delete(f"/api/job/{job_id}", headers=KEY)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "cancelling")
        self.assertTrue(main._job_cancelled(job_id))

    def test_cancelling_a_finished_job_is_harmless(self):
        job_id = "c" * 16
        with main.JOBS_LOCK:
            main.JOBS[job_id] = {"status": "done", "cancelled": False, "finishedAt": time.time()}
        self.assertEqual(
            self.client.delete(f"/api/job/{job_id}", headers=KEY).json()["status"], "done"
        )

    def test_cancelling_an_unknown_job_is_404(self):
        self.assertEqual(self.client.delete(f"/api/job/{'d' * 16}", headers=KEY).status_code, 404)

    def test_expired_jobs_and_their_files_are_evicted(self):
        stale, fresh, running = "e" * 16, "f" * 16, "0" * 16
        stale_dir = main.WORK_DIR / stale
        stale_dir.mkdir(parents=True, exist_ok=True)
        (stale_dir / "final.opus").write_bytes(b"x")
        expired = time.time() - (main.JOB_RETENTION_MIN + 1) * 60
        with main.JOBS_LOCK:
            main.JOBS[stale] = {"status": "done", "finishedAt": expired}
            main.JOBS[fresh] = {"status": "done", "finishedAt": time.time()}
            main.JOBS[running] = {"status": "running", "finishedAt": 0.0}

        main._evict_old_jobs()

        self.assertEqual(set(main.JOBS), {fresh, running})
        self.assertFalse(stale_dir.exists())

    def test_cancelled_jobs_are_evicted_too(self):
        job_id = "1" * 16
        with main.JOBS_LOCK:
            main.JOBS[job_id] = {
                "status": "cancelled",
                "finishedAt": time.time() - (main.JOB_RETENTION_MIN + 1) * 60,
            }
        main._evict_old_jobs()
        self.assertNotIn(job_id, main.JOBS)


class SynthTimeoutTest(unittest.TestCase):
    def test_a_wedged_engine_is_abandoned_and_reported(self):
        class Hanging:
            name = "treo"

            def synth(self, *_a, **_kw):
                time.sleep(3600)

        main.ENGINE, main.ENGINE_ERROR = Hanging(), None
        original = main.SYNTH_TIMEOUT_SEC
        main.SYNTH_TIMEOUT_SEC = 1
        try:
            with self.assertRaises(RuntimeError):
                main._synth_with_timeout("xin chào", main.WORK_DIR / "khong-dung.wav", "", 1.0)
            self.assertIsNone(main.ENGINE)          # engine bị coi là hỏng
            self.assertIn("kẹt", main.ENGINE_ERROR)  # lý do đi vào /api/health
        finally:
            main.SYNTH_TIMEOUT_SEC = original
            main.ENGINE, main.ENGINE_ERROR = None, None


class AuthUnitTest(unittest.TestCase):
    def test_empty_key_is_rejected(self):
        with self.assertRaises(Exception):
            asyncio.run(auth.require_api_key(""))

    def test_non_ascii_key_does_not_raise_type_error(self):
        with self.assertRaises(Exception) as caught:
            asyncio.run(auth.require_api_key("café"))
        self.assertNotIsInstance(caught.exception, TypeError)


if __name__ == "__main__":
    unittest.main()
