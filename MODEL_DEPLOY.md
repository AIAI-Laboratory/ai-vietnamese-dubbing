# VieNeu Nano model

The downloader puts the model here:

```text
server/models/vieneu-nano/
```

The directory is ignored by Git because it contains runtime binaries.

## Download

From the repository root:

```bash
uv sync --python 3.12
uv run python scripts/download_vieneu_model.py
```

The script downloads the six ONNX files, runs a short inference, and removes
temporary Hugging Face cache data. Use `--keep-cache` only when debugging a
download.

To choose another directory:

```bash
uv run python scripts/download_vieneu_model.py --model-dir /data/models/vieneu-nano
VIENEU_MODEL_DIR=/data/models/vieneu-nano uv run python server/main.py
```

## Check

```bash
du -sh server/models/vieneu-nano
curl -H "X-API-Key: $API_KEY" http://127.0.0.1:18765/api/health
```

The server is ready when the response contains:

```json
{"status":"ready","model":"VieNeu-TTS v3 Nano (ONNX, CPU, local)"}
```

When deploying to a new machine, run the downloader there or copy
`server/models/vieneu-nano/` through your deployment storage.
