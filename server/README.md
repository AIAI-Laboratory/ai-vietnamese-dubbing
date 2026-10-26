# TTS server

FastAPI server for VieNeu-TTS v3 Nano on CPU.

## Setup

From the repository root:

```bash
uv sync --python 3.12
cp server/.env.example server/.env
uv run python scripts/download_vieneu_model.py
```

Put a random value in `API_KEY` inside `server/.env`.

## Run with Docker Compose

```bash
cp server/.env.example server/.env   # đặt API_KEY trước
docker compose build                 # lần đầu: build image
docker compose run --rm tts python scripts/download_vieneu_model.py
docker compose up -d
```

- Service auto-restarts on boot (`restart: unless-stopped`); `docker.service`
  phải được `systemctl enable`.
- Port được publish chỉ trên loopback: `127.0.0.1:18765`.
- Model nằm trong volume `vieneu-models`, tải một lần bằng lệnh trên; container
  bind `HOST=0.0.0.0` bên trong, `server/.env` cung cấp `API_KEY`.

Kiểm tra:

```bash
curl -H "X-API-Key: your-server-key" http://127.0.0.1:18765/api/health
```

Cần thấy `"status":"ready"`. Không có key thì server trả 401.

## Run (không Docker)

```bash
uv run python server/main.py
```

Default address: `http://127.0.0.1:18765`.

The server uses `server/models/vieneu-nano/`. Set `VIENEU_MODEL_DIR` to use a
different directory.

## API

Every route needs `X-API-Key`.

```text
GET    /api/health
GET    /api/voices
POST   /api/preview
POST   /api/synthesize
GET    /api/job/{job_id}
DELETE /api/job/{job_id}
GET    /audio/{job_id}/w{index}.{ext}
```

Requests support videos up to six hours, 5000 segments, a 16 MB body and four
queued/running jobs. Subtitle cues extending past the video duration are clipped;
cues starting at or after the end are discarded before synthesis. Long jobs are
processed in short audio windows, but total CPU time grows with subtitle count
and duration. Jobs are kept in memory; finished audio is removed after
`JOB_RETENTION_MIN`.

## Tests

```bash
uv run python -m unittest discover -s tests -t tests
uv pip check
```

See [MODEL_DEPLOY.md](../MODEL_DEPLOY.md) for model storage and deployment.
