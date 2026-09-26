# VieNeu Nano model deployment

The active TTS model is VieNeu-TTS v3 Nano. The downloader stores the files in
the project-local model directory:

```text
server/models/vieneu-nano/
```

`server/models/` is intentionally ignored by Git. It is runtime data, not
source code or a release artifact.

## Install and prefetch

From the repository root:

```bash
uv sync --python 3.12
cp server/.env.example server/.env
uv run python scripts/download_vieneu_model.py
```

Windows PowerShell:

```powershell
uv run python scripts/download_vieneu_model.py
```

The downloader validates a real inference and removes the temporary Hugging Face
cache after success. The normal server command uses the local model directory:

```bash
uv run python server/main.py
```

To store the model somewhere else:

```bash
uv run python scripts/download_vieneu_model.py --model-dir /data/models/vieneu-nano
VIENEU_MODEL_DIR=/data/models/vieneu-nano uv run python server/main.py
```

## Verify

```bash
du -sh server/models/vieneu-nano
curl -H "X-API-Key: $API_KEY" http://127.0.0.1:18765/api/health
```

The health response must report `"status":"ready"` and
`"model":"VieNeu-TTS v3 Nano (ONNX, CPU, local)"`.

## Deploying to another machine

Copying the repository does not copy the ignored model directory. Run the
downloader once on the target machine, or copy `server/models/vieneu-nano/`
through your deployment artifact/storage layer. Do not commit model binaries
into normal Git history.
