"""
TTS server cho Local AI Vietnamese Dubbing (Python/FastAPI) — chỉ API,
KHÔNG có UI/dashboard. Swagger UI tự sinh sẵn tại GET /docs — bấm nút
"Authorize" (góc trên phải), dán X-API-Key, mọi request "Try it out" tự
gắn kèm.

  GET  /api/health              -> {"ok","status":"loading"|"ready"|"error","model","error"}
  GET  /api/voices              -> {"voices":[{"id","label"}]} (503 nếu đang loading)
  POST /api/preview             body {text,voice} -> file WAV
  POST /api/synthesize          body {voice,durationSec,segments:[{id,start,end,vi}]} -> {"jobId"}
  GET  /api/job/{jobId}         -> {"status","progress","audioUrl","measuredSyllablesPerSec","segments","error",...}
  GET  /audio/{jobId}.{ext}     -> file audio

TOÀN BỘ route trên khoá bằng header X-API-Key (xem auth.py) — BẮT BUỘC,
không có kiểu "để trống = không khoá": server chỉ chạy qua API nên nếu
không auth thì ai biết địa chỉ cũng gọi được, tốn CPU. Server
từ chối khởi động luôn nếu chưa đặt API_KEY trong server/.env.

Vẫn cần ffmpeg trong PATH để nén audio vừa khe và xuất Opus/MP3.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import platform
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
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

import audio_pipeline
import tts_engine
from auth import require_api_key

WORK_DIR = Path(tempfile.gettempdir()) / "local-ai-vi-dub"
WORK_DIR.mkdir(exist_ok=True)
LOG_PATH = WORK_DIR / "server.log"
DEBUG_DIR = SERVER_DIR / "debug_transcripts"
DEBUG_RETENTION_DAYS = max(1, int(os.environ.get("DEBUG_RETENTION_DAYS", "7")))

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_PATH, encoding="utf-8")],
)
logger = logging.getLogger("server")


def _fmt_dur(sec: float) -> str:
    sec = max(0.0, sec)
    if sec >= 60:
        return "{}m{:02d}s".format(int(sec // 60), int(sec % 60))
    return "{:.1f}s".format(sec)


app = FastAPI(
    title="Local AI Vietnamese Dubbing — TTS server",
    description="Chỉ API — dán API key vào nút Authorize phía trên để thử.",
    dependencies=[Depends(require_api_key)],
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


class DebugTranscriptRequest(BaseModel):
    videoId: str = Field(min_length=1, max_length=1000)
    model: str = Field(default="", max_length=300)
    reviewModel: str = Field(default="", max_length=300)
    apiBaseUrl: str = Field(default="", max_length=1000)
    durationSec: float = Field(gt=0, le=21600)
    planVersion: str = Field(default="", max_length=100)
    viSyllablesPerSec: float = Field(gt=0, le=20)
    sourceCues: list[dict] = Field(default_factory=list, max_length=10000)
    plan: dict = Field(default_factory=dict)
    terminologyDraft: dict = Field(default_factory=dict)
    terminology: dict = Field(default_factory=dict)
    terminologyError: str = Field(default="", max_length=4000)
    terminologyReviewError: str = Field(default="", max_length=4000)
    draftTranslation: list[dict] = Field(default_factory=list, max_length=5000)
    reviewedTranslation: list[dict] = Field(default_factory=list, max_length=5000)
    finalTranslation: list[dict] = Field(default_factory=list, max_length=5000)
    verification: dict = Field(default_factory=dict)


def _write_debug_transcript(data: dict, directory: Path = DEBUG_DIR) -> Path:
    """Ghi debug JSON và xoá các bản quá hạn trong cùng thư mục."""

    directory.mkdir(parents=True, exist_ok=True)
    now = time.time()
    cutoff = now - DEBUG_RETENTION_DAYS * 86400
    for old_path in directory.glob("*.json"):
        try:
            if old_path.stat().st_mtime < cutoff:
                old_path.unlink()
        except OSError:
            logger.warning("Không dọn được debug file cũ: %s", old_path)

    filename = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    path = directory / f"{filename}-{uuid.uuid4().hex[:8]}.json"
    payload = {"savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), **data}
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


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


@app.post("/api/debug/transcript")
def save_debug_transcript(req: DebugTranscriptRequest):
    path = _write_debug_transcript(req.model_dump())
    logger.info("Đã lưu transcript debug: %s", path)
    return {"ok": True, "path": str(path), "retentionDays": DEBUG_RETENTION_DAYS}


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
        }

    JOB_EXECUTOR.submit(_run_job, job_id, job_dir, req)
    return {"jobId": job_id}


@app.get("/api/job/{job_id}")
def job_status(job_id: str):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Không tìm thấy job")
    return job


@app.get("/audio/{job_id}.{ext}")
def get_audio(job_id: str, ext: str):
    path = WORK_DIR / job_id / f"final.{ext}"
    if not path.exists():
        raise HTTPException(404, "Chưa có file audio (job chưa xong hoặc job_id sai)")
    media_type = "audio/opus" if ext == "opus" else "audio/mpeg" if ext == "mp3" else "application/octet-stream"
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
        segment_wavs = []
        meta = []
        t_synth_total = 0.0
        for i, seg in enumerate(req.segments):
            raw_wav = job_dir / f"{seg.id:04d}_raw.wav"
            fit_wav = job_dir / f"{seg.id:04d}_fit.wav"
            text = seg.vi.strip()
            syllables = tts_engine.count_vi_syllables(text)

            t0 = time.time()
            result = ENGINE.synth(text, raw_wav, voice=req.voice)
            t_synth = time.time() - t0
            t_synth_total += t_synth

            info = audio_pipeline.stretch_to_fit(
                raw_wav,
                fit_wav,
                result.duration_sec,
                max(0.05, seg.end - seg.start),
            )
            raw_wav.unlink(missing_ok=True)
            info.update(id=seg.id, syllables=syllables)
            meta.append(info)
            segment_wavs.append(({"start": seg.start, "end": seg.end}, fit_wav))

            eta = (t_synth_total / (i + 1)) * (total - i - 1)
            logger.info("%s [%3d/%d] id=%-4d %2d âm tiết | synth %5.2fs -> %5.2fs audio | khe %5.2fs | nén %.2fx%s | còn ~%s",
                        tag, i + 1, total, seg.id, syllables, t_synth, info["naturalSec"], info["slotSec"], info["stretch"],
                        " | CẮT BỚT" if info["overflowTruncated"] else "", _fmt_dur(eta))
            set_progress((i + 1) / total * 0.7, etaSec=round(eta, 1), doneSegments=i + 1, totalSegments=total)

        master_wav = job_dir / "master.wav"
        t0 = time.time()
        audio_pipeline.assemble_timeline(segment_wavs, req.durationSec, master_wav)
        logger.info("%s ghép %d câu vào timeline %.1fs — xong sau %.2fs", tag, total, req.durationSec, time.time() - t0)
        set_progress(0.85)

        final_no_ext = job_dir / "final"
        t0 = time.time()
        content_type, final_path = audio_pipeline.export_final(master_wav, final_no_ext)
        ext = "opus" if content_type == "audio/opus" else "mp3"
        logger.info("%s encode -> %s (%s) sau %.2fs — %.1f KB", tag, ext, content_type, time.time() - t0, final_path.stat().st_size / 1024)

        rates = [m["syllables"] / m["naturalSec"] for m in meta if m["naturalSec"] > 0]
        measured_rate = round(statistics.median(rates), 3) if rates else None
        overflow = [m["id"] for m in meta if m["overflowTruncated"]]

        master_wav.unlink(missing_ok=True)
        for _, wav_path in segment_wavs:
            wav_path.unlink(missing_ok=True)

        with JOBS_LOCK:
            JOBS[job_id].update(
                status="done", progress=1.0, audioUrl=f"/audio/{job_id}.{ext}",
                measuredSyllablesPerSec=measured_rate, overflowSegmentIds=overflow, segments=meta,
            )
        audio_sec = sum(m["finalSec"] for m in meta)
        elapsed = time.time() - t_job
        logger.info("%s XONG sau %s — synth chiếm %s | %.1fs audio | RTF %.2fx | %d câu bị cắt",
                    tag, _fmt_dur(elapsed), _fmt_dur(t_synth_total), audio_sec,
                    (t_synth_total / audio_sec) if audio_sec > 0 else 0.0, len(overflow))
    except Exception as e:
        logger.exception("%s LỖI sau %s", tag, _fmt_dur(time.time() - t_job))
        with JOBS_LOCK:
            JOBS[job_id].update(status="error", error=str(e))


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


def main() -> None:
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
    threading.Thread(target=load_engine_background, daemon=True).start()
    print_server_info(args.host, args.port)

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
