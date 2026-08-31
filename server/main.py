"""
TTS server cho Local AI Vietnamese Dubbing (Python/FastAPI) — chỉ API,
KHÔNG có UI/dashboard. Swagger UI tự sinh sẵn tại GET /docs — bấm nút
"Authorize" (góc trên phải), dán X-API-Key, mọi request "Try it out" tự
gắn kèm.

  GET  /api/health              -> {"ok","status":"loading"|"ready"|"error","model","error"}
  GET  /api/voices              -> {"voices":[{"id","label"}]} (503 nếu đang loading)
  POST /api/preview             body {text,voice} -> file WAV
  POST /api/synthesize          body {voice,durationSec,segments:[{id,start,end,vi}]} -> {"jobId"}
  GET  /api/job/{jobId}         -> {"status","progress","audioUrl","measuredSyllablesPerSec","segments","duckEnvelope","error",...}
  GET  /audio/{jobId}.{ext}     -> file audio

TOÀN BỘ route trên khoá bằng header X-API-Key (xem auth.py) — BẮT BUỘC,
không có kiểu "để trống = không khoá": server chỉ chạy qua API nên nếu
không auth thì ai biết địa chỉ cũng gọi được, tốn CPU. Server
từ chối khởi động luôn nếu chưa đặt API_KEY trong server/.env.

Vẫn cần ffmpeg trong PATH để nén audio vừa khe và xuất Opus/MP3.
"""

from __future__ import annotations

import argparse
import logging
import os
import platform
import re
import shutil
import statistics
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


# Windows mặc định chọn codepage ANSI (cp1252) cho stdout/stderr khi không
# chạy trong console thật (bị redirect ra file/pipe) — tiếng Việt có dấu
# vượt ngoài bảng mã đó, Python âm thầm escape thành "\uXXXX" thay vì in
# UTF-8 thật. Tự cấu hình trong code cho chắc, không phụ thuộc biến môi
# trường PYTHONIOENCODING người dùng có nhớ đặt hay không.
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

from dotenv import load_dotenv

SERVER_DIR = Path(__file__).resolve().parent

# Nạp server/.env TRƯỚC khi import auth.py — auth.py đọc API_KEY từ
# os.environ ngay lúc import (module-level, và tự sys.exit nếu rỗng), load
# muộn hơn sẽ không kịp.
load_dotenv(SERVER_DIR / ".env")

import uvicorn
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

import audio_pipeline
import tts_engine
from auth import require_api_key

WORK_DIR = Path(tempfile.gettempdir()) / "local-ai-vi-dub"
WORK_DIR.mkdir(exist_ok=True)
LOG_PATH = WORK_DIR / "server.log"
# Job xong vẫn giữ audio trong RAM/đĩa để client tải về; sau ngần này phút thì
# dọn — nếu không, mỗi bài giảng để lại một thư mục temp và một entry JOBS
# sống tới khi tắt server.
JOB_RETENTION_MIN = max(5, int(os.environ.get("JOB_RETENTION_MIN", "60")))
# Chỉ một worker chạy job, nên hàng đợi dài chỉ làm client chờ vô ích.
MAX_PENDING_JOBS = max(1, int(os.environ.get("MAX_PENDING_JOBS", "4")))
# Một job cho bài giảng dài có vài nghìn segment; chặn body lớn hơn để không
# ai đẩy được payload khổng lồ vào server.
MAX_BODY_BYTES = max(1, int(os.environ.get("MAX_BODY_MB", "16"))) * 1024 * 1024
# Swagger UI và openapi.json KHÔNG khoá được bằng dependency của FastAPI (chúng
# là route Starlette thuần, dependencies chỉ áp cho APIRoute), nên mặc định tắt
# hẳn. Bật lại bằng ENABLE_DOCS=1 khi cần thử tay trên máy mình.
ENABLE_DOCS = os.environ.get("ENABLE_DOCS", "").strip().lower() in ("1", "true", "yes")

# Trần thời gian tổng hợp MỘT câu. Kokoro chạy ~0.35x thời gian thực, nên một
# câu 30 giây mất khoảng 10 giây; quá ngần này là nó đã kẹt chứ không phải
# chậm. Không có trần thì job treo vĩnh viễn và worker duy nhất kẹt theo, mọi
# job sau xếp hàng sau một thứ không bao giờ xong.
SYNTH_TIMEOUT_SEC = max(30, int(os.environ.get("SYNTH_TIMEOUT_SEC", "300")))
# Số câu tổng hợp cùng lúc. onnxruntime không scale tuyến tính theo thread (đo
# trên 6 core: 1 thread RTF 0.84, 6 thread 0.40 — chỉ nhanh 2.1 lần), nên chạy
# vài câu song song lấp được phần CPU bỏ trống: 3 câu song song đưa RTF xuống
# 0.232, nhanh hơn 1.7 lần so với chạy tuần tự.
SYNTH_WORKERS = max(1, int(os.environ.get("SYNTH_WORKERS", "3")))
# Hệ số ước dung lượng cần cho một job: master WAV + toàn bộ câu đã cắt vừa
# khe (giữ tới lúc ghép) + file nén cuối.
DISK_BYTES_PER_SEC = 24000 * 2 * 2.5
DISK_MARGIN_BYTES = 64 * 1024 * 1024

# job_id do server sinh bằng uuid4().hex[:16] — chốt đúng dạng đó trước khi
# ghép vào đường dẫn file.
JOB_ID_RE = re.compile(r"^[0-9a-f]{16}$")
AUDIO_EXTS = {"opus", "mp3"}

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_PATH, encoding="utf-8")],
)
logger = logging.getLogger("server")


class JobCancelled(Exception):
    """Job bị huỷ giữa chừng — không phải lỗi, không cần log traceback."""


def _fmt_dur(sec: float) -> str:
    sec = max(0.0, sec)
    if sec >= 60:
        return "{}m{:02d}s".format(int(sec // 60), int(sec % 60))
    return "{:.1f}s".format(sec)


app = FastAPI(
    title="Local AI Vietnamese Dubbing — TTS server",
    description="Chỉ API — dán API key vào nút Authorize phía trên để thử.",
    dependencies=[Depends(require_api_key)],
    docs_url="/docs" if ENABLE_DOCS else None,
    redoc_url="/redoc" if ENABLE_DOCS else None,
    openapi_url="/openapi.json" if ENABLE_DOCS else None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ENGINE = None
ENGINE_ERROR: str | None = None
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
JOB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro-job")


@app.middleware("http")
async def limit_body_size(request, call_next):
    """Chặn body quá lớn theo SỐ BYTE THẬT nhận được.

    Chỉ nhìn Content-Length là hở: request chunked không khai header đó, và
    khi ấy toàn bộ body vẫn được đọc vào RAM rồi mới bị validate từ chối.
    """

    too_large = JSONResponse(
        {"detail": f"Body vượt {MAX_BODY_BYTES // (1024 * 1024)} MB"}, status_code=413
    )

    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return too_large

    received = 0
    original_receive = request.receive
    overflowed = False

    async def counting_receive():
        nonlocal received, overflowed
        message = await original_receive()
        if message.get("type") == "http.request":
            received += len(message.get("body", b""))
            if received > MAX_BODY_BYTES:
                overflowed = True
                # Cắt luồng thay vì đọc tiếp: phần đã nhận bị bỏ, handler thấy
                # body kết thúc sớm và trả lỗi, còn ta trả 413 ở dưới.
                return {"type": "http.disconnect"}
        return message

    request._receive = counting_receive
    response = await call_next(request)
    return too_large if overflowed else response


def _evict_old_jobs() -> None:
    """Xoá job quá hạn khỏi JOBS và xoá thư mục audio tương ứng."""

    cutoff = time.time() - JOB_RETENTION_MIN * 60
    with JOBS_LOCK:
        expired = [
            job_id
            for job_id, job in JOBS.items()
            if job.get("status") in ("done", "error", "cancelled")
            and job.get("finishedAt", 0) < cutoff
        ]
        for job_id in expired:
            JOBS.pop(job_id, None)
    for job_id in expired:
        shutil.rmtree(WORK_DIR / job_id, ignore_errors=True)
    if expired:
        logger.info("Đã dọn %d job quá hạn (> %d phút)", len(expired), JOB_RETENTION_MIN)


def _synth_with_timeout(text: str, out_path: Path, voice: str, speed: float):
    """Gọi ENGINE.synth trong thread riêng, bỏ cuộc nếu quá hạn.

    Thread không giết được từ bên ngoài nên nếu quá hạn thì coi như engine hỏng:
    đánh dấu ENGINE_ERROR để /api/health nói thật và job mới bị từ chối bằng
    503 thay vì xếp hàng sau một câu không bao giờ xong. Dùng daemon thread để
    cái đang kẹt không giữ tiến trình lại lúc tắt server.
    """

    global ENGINE, ENGINE_ERROR
    box: dict[str, object] = {}

    def run():
        try:
            box["result"] = ENGINE.synth(text, out_path, voice=voice, speed=speed)
        except BaseException as exc:  # noqa: BLE001 - chuyển nguyên vẹn sang luồng gọi
            box["error"] = exc

    worker = threading.Thread(target=run, daemon=True, name="kokoro-synth")
    worker.start()
    worker.join(SYNTH_TIMEOUT_SEC)
    if worker.is_alive():
        ENGINE_ERROR = (
            f"Tổng hợp một câu quá {SYNTH_TIMEOUT_SEC}s không xong — engine đang kẹt, "
            "khởi động lại server."
        )
        ENGINE = None
        logger.error(ENGINE_ERROR)
        raise RuntimeError(ENGINE_ERROR)
    if "error" in box:
        raise box["error"]
    return box["result"]


def _require_disk_space(duration_sec: float) -> None:
    """Từ chối sớm nếu đĩa không đủ chỗ cho job này.

    Hết đĩa giữa chừng thì job chết sau khi đã tổng hợp hàng trăm câu, và còn
    để lại đống file tạm làm đĩa đầy thêm.
    """

    needed = int(duration_sec * DISK_BYTES_PER_SEC) + DISK_MARGIN_BYTES
    free = shutil.disk_usage(WORK_DIR).free
    if free < needed:
        raise HTTPException(
            507,
            f"Không đủ dung lượng đĩa: cần khoảng {needed // (1024 * 1024)} MB cho video này, "
            f"còn trống {free // (1024 * 1024)} MB tại {WORK_DIR}",
        )


def _sweep_stale_job_dirs() -> None:
    """Dọn thư mục job còn sót từ lần chạy trước (server bị tắt giữa job)."""

    cutoff = time.time() - JOB_RETENTION_MIN * 60
    removed = 0
    for path in WORK_DIR.iterdir():
        if not path.is_dir() or not JOB_ID_RE.fullmatch(path.name):
            continue
        try:
            if path.stat().st_mtime < cutoff:
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        except OSError:
            logger.warning("Không dọn được thư mục job cũ: %s", path)
    if removed:
        logger.info("Đã dọn %d thư mục job sót lại từ lần chạy trước", removed)


def _job_cancelled(job_id: str) -> bool:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        return bool(job and job.get("cancelled"))


def _validated_job_id(job_id: str) -> str:
    if not JOB_ID_RE.fullmatch(job_id):
        raise HTTPException(404, "job_id không hợp lệ")
    return job_id


class Segment(BaseModel):
    id: int
    start: float = Field(ge=0, le=21600)
    end: float = Field(gt=0, le=21600)
    vi: str = Field(min_length=1, max_length=2000)


class SynthesizeRequest(BaseModel):
    voice: str = Field(default="", max_length=64)
    durationSec: float = Field(gt=0, le=21600)
    segments: list[Segment] = Field(min_length=1, max_length=5000)


class PreviewRequest(BaseModel):
    text: str = Field(default="Xin chào, đây là giọng đọc thử.", max_length=2000)
    voice: str = Field(default="", max_length=64)


@app.get("/api/health")
def health():
    if ENGINE_ERROR:
        return {"ok": False, "status": "error", "error": ENGINE_ERROR}
    if ENGINE is None:
        return {"ok": True, "status": "loading"}
    return {"ok": True, "status": "ready", "model": ENGINE.name}


@app.get("/api/voices")
def voices():
    if ENGINE is None:
        detail = ENGINE_ERROR or (
            "Model đang tải, chưa có danh sách giọng — kiểm tra GET /api/health"
        )
        raise HTTPException(503, detail)
    return {
        "voices": [
            {"id": voice["name"], "label": voice["label"]}
            for voice in ENGINE.list_voices()
        ]
    }


@app.post("/api/preview")
def preview(req: PreviewRequest):
    if ENGINE is None:
        detail = ENGINE_ERROR or (
            "Model đang tải, chưa nghe thử được — kiểm tra GET /api/health"
        )
        raise HTTPException(503, detail)
    text = req.text.strip() or "Xin chào, đây là giọng đọc thử."
    preview_dir = WORK_DIR / "_preview"
    preview_dir.mkdir(exist_ok=True)
    out_path = preview_dir / f"{uuid.uuid4().hex[:12]}.wav"
    t0 = time.time()
    try:
        ENGINE.synth(text, out_path, voice=req.voice)
    except Exception as e:
        logger.exception("Nghe thử lỗi")
        raise HTTPException(500, f"Tổng hợp giọng lỗi: {e}")
    logger.info("Nghe thử xong sau %.2fs — %d ký tự", time.time() - t0, len(text))
    return FileResponse(
        out_path,
        media_type="audio/wav",
        background=BackgroundTask(out_path.unlink, missing_ok=True),
    )


@app.post("/api/synthesize")
def synthesize(req: SynthesizeRequest):
    if ENGINE is None:
        detail = ENGINE_ERROR or (
            "Model đang tải, chưa sẵn sàng tổng hợp giọng — kiểm tra GET /api/health"
        )
        raise HTTPException(503, detail)
    if any(not segment.vi.strip() for segment in req.segments):
        raise HTTPException(422, "Mọi segment phải có bản dịch tiếng Việt")
    if any(
        segment.end <= segment.start or segment.end > req.durationSec
        for segment in req.segments
    ):
        raise HTTPException(422, "Timestamp segment không hợp lệ hoặc vượt thời lượng video")
    ids = [segment.id for segment in req.segments]
    if len(ids) != len(set(ids)):
        raise HTTPException(422, "ID segment bị trùng")
    _evict_old_jobs()
    _require_disk_space(req.durationSec)
    with JOBS_LOCK:
        pending = sum(1 for job in JOBS.values() if job["status"] in ("queued", "running"))
    if pending >= MAX_PENDING_JOBS:
        raise HTTPException(429, f"Đang có {pending} job chờ — thử lại sau")

    job_id = uuid.uuid4().hex[:16]
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    logger.info(
        "Nhận job %s — %d câu, video %.1fs",
        job_id,
        len(req.segments),
        req.durationSec,
    )

    with JOBS_LOCK:
        JOBS[job_id] = {
            "status": "queued",
            "progress": 0.0,
            "audioUrl": None,
            "error": None,
            "cancelled": False,
            "finishedAt": 0.0,
        }

    JOB_EXECUTOR.submit(_run_job, job_id, job_dir, req)
    return {"jobId": job_id}


@app.delete("/api/job/{job_id}")
def cancel_job(job_id: str):
    """Dừng một job đang chạy.

    Đóng tab lúc đang lồng tiếng không dừng được gì: server vẫn tổng hợp tới
    hết trên worker duy nhất, mọi job khác xếp hàng phía sau hàng phút.
    """

    with JOBS_LOCK:
        job = JOBS.get(_validated_job_id(job_id))
        if not job:
            raise HTTPException(404, "Không tìm thấy job")
        if job["status"] in ("done", "error", "cancelled"):
            return {"status": job["status"]}
        job["cancelled"] = True
    logger.info("Job %s: nhận yêu cầu huỷ", job_id)
    return {"status": "cancelling"}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(_validated_job_id(job_id))
    if not job:
        raise HTTPException(404, "Không tìm thấy job")
    return job


@app.get("/audio/{job_id}.{ext}")
def get_audio(job_id: str, ext: str):
    if ext not in AUDIO_EXTS:
        raise HTTPException(404, "Định dạng audio không hợp lệ")
    path = WORK_DIR / _validated_job_id(job_id) / f"final.{ext}"
    if not path.exists():
        raise HTTPException(404, "Chưa có file audio (job chưa xong hoặc job_id sai)")
    media_type = "audio/opus" if ext == "opus" else "audio/mpeg"
    return FileResponse(path, media_type=media_type)


def _run_job(job_id: str, job_dir: Path, req: SynthesizeRequest) -> None:
    def set_progress(pct: float, **extra):
        with JOBS_LOCK:
            JOBS[job_id].update(progress=pct, **extra)

    tag = f"[job {job_id}]"
    t_job = time.time()
    total = len(req.segments)
    logger.info(
        "%s BẮT ĐẦU — %d câu | video %.1fs | engine=%s",
        tag,
        total,
        req.durationSec,
        ENGINE.name,
    )
    set_progress(0.0, status="running")

    try:
        meta = []
        segment_wavs = []
        t_synth_total = 0.0
        slots = audio_pipeline.available_slots(
            [{"id": s.id, "start": s.start, "end": s.end} for s in req.segments],
            req.durationSec,
        )

        def synthesize_one(seg):
            """Tổng hợp một câu và nén cho vừa khe. Chạy trên nhiều luồng."""

            if _job_cancelled(job_id):
                raise JobCancelled()
            raw_wav = job_dir / f"{seg.id:04d}_raw.wav"
            fit_wav = job_dir / f"{seg.id:04d}_fit.wav"
            text = seg.vi.strip()
            slot_sec = slots[seg.id]

            t0 = time.time()
            result = _synth_with_timeout(text, raw_wav, req.voice, 1.0)
            base_sec = result.duration_sec
            # Vượt khe: đọc lại nhanh hơn bằng tốc độ native — prosody vẫn tự
            # nhiên, hơn hẳn kéo giãn tín hiệu bằng atempo ở bước sau.
            if base_sec > slot_sec + 0.02:
                result = _synth_with_timeout(text, raw_wav, req.voice, base_sec / slot_sec)
            t_synth = time.time() - t0

            info = audio_pipeline.stretch_to_fit(raw_wav, fit_wav, result.duration_sec, slot_sec)
            raw_wav.unlink(missing_ok=True)
            # baseSec = độ dài lúc đọc tốc độ thường; measuredSyllablesPerSec
            # phải tính trên nó, không phải trên bản đã tăng tốc.
            info.update(
                id=seg.id,
                syllables=tts_engine.count_vi_syllables(text),
                speed=result.speed,
                baseSec=round(base_sec, 3),
                peak=result.peak,
            )
            return info, ({"start": seg.start, "end": seg.end}, fit_wav), t_synth

        workers = min(SYNTH_WORKERS, total)
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="kokoro-seg") as pool:
            # map trả kết quả đúng thứ tự câu, nên tiến độ và log vẫn tuần tự
            # dù việc chạy song song.
            for i, (info, pair, t_synth) in enumerate(pool.map(synthesize_one, req.segments)):
                meta.append(info)
                segment_wavs.append(pair)
                t_synth_total += t_synth
                elapsed = time.time() - t_job
                eta = (elapsed / (i + 1)) * (total - i - 1)
                logger.info("%s [%3d/%d] id=%-4d %2d âm tiết | synth %5.2fs -> %5.2fs audio | khe %5.2fs | speed %.2fx | nén %.2fx%s | còn ~%s",
                            tag, i + 1, total, info["id"], info["syllables"], t_synth, info["naturalSec"], info["slotSec"], info["speed"], info["stretch"],
                            " | CẮT BỚT" if info["overflowTruncated"] else "", _fmt_dur(eta))
                set_progress((i + 1) / total * 0.7, etaSec=round(eta, 1), doneSegments=i + 1, totalSegments=total)

        master_wav = job_dir / "master.wav"
        t0 = time.time()
        audio_pipeline.assemble_timeline(segment_wavs, req.durationSec, master_wav)
        duck = audio_pipeline.duck_envelope(master_wav)
        logger.info("%s ghép %d câu vào timeline %.1fs — xong sau %.2fs", tag, total, req.durationSec, time.time() - t0)
        set_progress(0.85)

        final_no_ext = job_dir / "final"
        t0 = time.time()
        content_type, final_path = audio_pipeline.export_final(master_wav, final_no_ext)
        ext = "opus" if content_type == "audio/opus" else "mp3"
        logger.info("%s encode -> %s (%s) sau %.2fs — %.1f KB", tag, ext, content_type, time.time() - t0, final_path.stat().st_size / 1024)

        rates = [m["syllables"] / m["baseSec"] for m in meta if m["baseSec"] > 0]
        measured_rate = round(statistics.median(rates), 3) if rates else None
        overflow = [m["id"] for m in meta if m["overflowTruncated"]]

        master_wav.unlink(missing_ok=True)
        for _, wav_path in segment_wavs:
            wav_path.unlink(missing_ok=True)

        with JOBS_LOCK:
            JOBS[job_id].update(
                status="done", progress=1.0, audioUrl=f"/audio/{job_id}.{ext}",
                measuredSyllablesPerSec=measured_rate, overflowSegmentIds=overflow, segments=meta,
                duckEnvelope=duck, finishedAt=time.time(),
            )
        audio_sec = sum(m["finalSec"] for m in meta)
        elapsed = time.time() - t_job
        logger.info("%s XONG sau %s — %d luồng | %.1fs audio | RTF %.2fx | %d câu bị cắt",
                    tag, _fmt_dur(elapsed), min(SYNTH_WORKERS, total), audio_sec,
                    (elapsed / audio_sec) if audio_sec > 0 else 0.0, len(overflow))
    except JobCancelled:
        logger.info("%s ĐÃ HUỶ sau %s", tag, _fmt_dur(time.time() - t_job))
        shutil.rmtree(job_dir, ignore_errors=True)
        with JOBS_LOCK:
            JOBS[job_id].update(
                status="cancelled", error="Job bị huỷ theo yêu cầu", finishedAt=time.time()
            )
    except OSError as e:
        # Errno 28/ENOSPC trên Linux, WinError 112 trên Windows.
        logger.exception("%s LỖI ĐĨA sau %s", tag, _fmt_dur(time.time() - t_job))
        shutil.rmtree(job_dir, ignore_errors=True)
        detail = f"Lỗi ghi đĩa (có thể đã hết dung lượng tại {WORK_DIR}): {e}"
        with JOBS_LOCK:
            JOBS[job_id].update(status="error", error=detail, finishedAt=time.time())
    except Exception as e:
        logger.exception("%s LỖI sau %s", tag, _fmt_dur(time.time() - t_job))
        shutil.rmtree(job_dir, ignore_errors=True)
        with JOBS_LOCK:
            JOBS[job_id].update(status="error", error=str(e), finishedAt=time.time())


# ---------------------------------------------------------------------------
# Khởi động
# ---------------------------------------------------------------------------


def load_engine_background() -> None:
    global ENGINE, ENGINE_ERROR
    try:
        engine = tts_engine.load_engine()
        audio_pipeline.SAMPLE_RATE = getattr(engine, "sample_rate", audio_pipeline.SAMPLE_RATE)
        ENGINE = engine
        logger.info("Engine sẵn sàng: %s | %d Hz", engine.name, audio_pipeline.SAMPLE_RATE)
    except Exception as e:
        logger.exception("Nạp engine TTS thất bại")
        ENGINE_ERROR = str(e)


def print_server_info(host: str, port: int) -> None:
    logger.info(
        "Môi trường: %s/%s | Python %s",
        platform.system().lower(),
        platform.machine(),
        platform.python_version(),
    )
    logger.info(
        "Swagger UI: http://127.0.0.1:%d/docs — bấm Authorize để thử.", port
    )
    if host in ("0.0.0.0", "::"):
        logger.warning(
            "Server đang bind ra ngoài; hãy đặt HTTPS qua reverse proxy, "
            "xem deploy/README.md"
        )


def require_ffmpeg() -> None:
    """Chốt ffmpeg ngay lúc khởi động.

    Không có bước này thì thiếu ffmpeg chỉ lộ ra ở cuối job — sau khi đã tổng
    hợp xong hàng trăm câu và đã trả tiền cho bước dịch.
    """

    if shutil.which("ffmpeg"):
        return
    sys.exit(
        "LỖI: không tìm thấy ffmpeg trong PATH. Server cần nó để nén audio vừa "
        "khe và xuất Opus/MP3. Cài: winget install Gyan.FFmpeg (Windows), "
        "apt install ffmpeg (Debian/Ubuntu), brew install ffmpeg (macOS)."
    )


def main() -> None:
    require_ffmpeg()
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 18765)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    args = ap.parse_args()

    logger.info(
        "Đang mở HTTP trên %s:%d — nạp engine trong nền, "
        "theo dõi qua GET /api/health...",
        args.host,
        args.port,
    )
    _sweep_stale_job_dirs()
    threading.Thread(target=load_engine_background, daemon=True).start()
    print_server_info(args.host, args.port)

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
