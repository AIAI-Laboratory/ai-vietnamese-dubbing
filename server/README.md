# TTS server

Python + FastAPI, API-only. Swagger UI is available at `/docs`: click
**Authorize**, paste the API key, then run requests directly from the page.

Speech synthesis uses Kokoro-Vietnamese ONNX on the local CPU. After the
model is downloaded, translated text is not sent to a speech provider.

## Install

```bash
cd server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt     # macOS/Linux

copy .env.example .env                          # Windows
# cp .env.example .env                          # macOS/Linux
python -c "import secrets; print(secrets.token_hex(16))"
```

Paste the generated key into `API_KEY` in `.env`. Installation requires
Python 3.10+, `git`, and `ffmpeg`. Always use a virtualenv.

The first start downloads the ONNX model (about 311 MB), config, and default
voicepack from Hugging Face. Later starts use the local cache. Set `HF_HOME`
to control the cache location.

## Run

```bash
.venv\Scripts\python main.py     # Windows
# .venv/bin/python main.py       # macOS/Linux
```

The default address is `http://127.0.0.1:18765`. Override it through `.env`
or command-line flags:

```bash
.venv/bin/python main.py --host 0.0.0.0 --port 9000
```

Logs are written to the console and the OS temp directory at
`local-ai-vi-dub/server.log`.

## Auth

The server refuses to start if `API_KEY` is empty. Every API and audio route
requires `X-API-Key`; `/docs` and `/openapi.json` remain public so Swagger can
load before authorization.

## Kokoro engine

`tts_engine.KokoroOnnxEngine` keeps one ONNX session warm for the server
lifetime. Voicepacks are loaded on demand and cached without loading another
copy of the model. CPU jobs run one at a time to avoid contention.

Set `KOKORO_VOICE` in `.env` to choose the default. Query `GET /api/voices`
for all voice IDs. Existing extension settings that contain the old gTTS
voice ID `vi` automatically use the configured Kokoro default.

Common technical acronyms such as API, HTTPS, JSON, CPU, and GPU are converted
to Vietnamese spoken forms before synthesis; subtitle text is unchanged.

## API

```text
GET  /api/health               -> loading | ready | error
GET  /api/voices               -> available Kokoro voices
POST /api/preview              -> WAV preview
POST /api/debug/transcript     -> save translation debug JSON under server/debug_transcripts
POST /api/synthesize           -> jobId
GET  /api/job/{jobId}          -> queued | running | done | error
GET  /audio/{jobId}.{ext}      -> final Opus/MP3 audio
```

Requests are limited to six-hour videos, 5000 non-empty segments, and valid
timestamps. Incomplete translation output is rejected instead of being
rendered as placeholder speech.

Translation debug files are stored inside this project at
`server/debug_transcripts/*.json`. The directory is ignored by Git. Files
contain source cues, terminology, draft, reviewed, and final translations,
but no API keys. Files older than
`DEBUG_RETENTION_DAYS` (default: 7) are removed when a new debug file is saved.

The extension may use a separate optional quality-review model for glossary and
semantic review. Debug JSON records both the translation model and review model.

## Checks

```bash
python -m unittest test_tts_engine.py
python -m compileall -q .
python -m pip check
```

Use `POST /api/preview` in Swagger to verify model loading and listen to each
voice on the target machine.

## Known limitations

- No bundled Python, ffmpeg, or offline model installer.
- Voice quality varies by voice and technical vocabulary.
- Job status is memory-only; final audio files do not have automatic TTL cleanup.
- No long-running stability test has been completed yet.
- No systemd unit is shipped; see [deploy/README.md](../deploy/README.md).
