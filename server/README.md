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

## Run

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

Limits include six-hour videos, 5000 segments, a 16 MB request body and four
queued/running jobs. Jobs are kept in memory. Finished audio is removed after
`JOB_RETENTION_MIN`.

## Tests

```bash
uv run python -m unittest discover -s tests -t tests
uv pip check
```

See [MODEL_DEPLOY.md](../MODEL_DEPLOY.md) for model storage and deployment.
