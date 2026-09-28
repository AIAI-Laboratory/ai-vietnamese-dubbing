# Local AI Vietnamese Dubbing

Chrome extension for dubbing Coursera and YouTube videos in Vietnamese.

- Gemini translates the captions.
- VieNeu-TTS v3 Nano reads the Vietnamese text on your CPU.
- Audio plays in timeline windows, so playback can start before the whole video is ready.
- The browser keeps the finished dub in IndexedDB.

The video and generated audio stay local. Caption text is sent to Gemini.

## Project layout

```text
extension/   Chrome MV3 extension
server/      FastAPI server and VieNeu Nano runtime
tests/       JavaScript and Python tests
deploy/      Remote-server notes
scripts/     Model download tools
```

## Requirements

- Chrome 116+
- Python 3.12
- uv
- ffmpeg
- Gemini API key

Install uv from the [official guide](https://docs.astral.sh/uv/getting-started/installation/).

## Install

From the repository root:

```bash
uv sync --python 3.12
cp server/.env.example server/.env
uv run python -c "import secrets; print(secrets.token_hex(16))"
```

Put the generated value in `server/.env`:

```env
API_KEY=your-server-key
```

Download and validate the model:

```bash
uv run python scripts/download_vieneu_model.py
```

The model is stored in `server/models/vieneu-nano/`. That folder is ignored by
Git. See [MODEL_DEPLOY.md](MODEL_DEPLOY.md) for another machine or a custom
model directory.

Start the server:

```bash
uv run python server/main.py
```

Check it:

```bash
curl -H "X-API-Key: your-server-key" \
  http://127.0.0.1:18765/api/health
```

The response should contain `"status":"ready"`.

Load the extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `extension/`.
4. Open Options and enter the Gemini key, server URL and server API key.
5. Click **Check server** and **Load voices**.

## Use

1. Open a Coursera lecture or YouTube video with English captions.
2. Enable that site in **Options → Supported pages**.
3. Click the dubbing button in the video player.

The first audio window plays while the remaining windows are being rendered.
Reload the video tab after changing extension code or supported-page settings.

## Configuration

The server settings are in `server/.env`:

| Setting | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `18765` | HTTP port |
| `API_KEY` | required | Protects every API route |
| `VIENEU_VOICE` | `Adam` | Default voice |
| `VIENEU_STEPS` | `16` | Quality/speed trade-off |
| `VIENEU_CFG` | `3.0` | VieNeu guidance value |
| `SYNTH_WORKERS` | `2` | Parallel sentence workers |
| `WINDOW_TARGET_SEC` | `15` | Audio window target in seconds |
| `ORT_THREADS` | unset | ONNX Runtime thread limit |
| `JOB_RETENTION_MIN` | `60` | Finished-job retention |
| `MAX_PENDING_JOBS` | `4` | Queue limit |
| `MAX_BODY_MB` | `16` | Request body limit |
| `ENABLE_DOCS` | `0` | Swagger/OpenAPI routes |
| `CORS_ORIGINS` | empty | Optional comma-separated trusted origins |

The extension stores Gemini, server, voice and page settings in Chrome storage.
The popup stores volume and subtitle settings when you click **Save changes**.

## API

Every route requires `X-API-Key`.

```text
GET    /api/health
GET    /api/voices
POST   /api/preview
POST   /api/synthesize
GET    /api/job/{job_id}
DELETE /api/job/{job_id}
GET    /audio/{job_id}/w{index}.{ext}
```

Audio windows are Opus, with MP3 fallback when ffmpeg lacks Opus support.

## Tests

```bash
node --test tests/*.test.js
uv run python -m unittest discover -s tests -t tests
uv pip check
```

Current suite: 54 JavaScript tests and 52 Python tests.

## Limits

- Only Coursera and YouTube adapters are included.
- YouTube transcript timestamps are less precise than Coursera WebVTT.
- One voice is used for a job.
- Jobs live in memory and are lost when the server stops.
- A fresh machine must download the model once.

## License

The project is Apache-2.0. VieNeu-TTS v3 Nano is also distributed under
Apache-2.0. See [LICENSE](LICENSE).
