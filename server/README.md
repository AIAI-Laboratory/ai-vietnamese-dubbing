# TTS server

FastAPI, API only. Speech synthesis uses VieNeu-TTS v3 Nano through ONNX Runtime
on the local CPU, so once the model is downloaded no text reaches a speech provider.

For the full picture — architecture, timeline anchoring, pronunciation, the
security model — see the [main README](../README.md).

## Layout

| File                | Role                                                        |
| ------------------- | ----------------------------------------------------------- |
| `main.py`           | Routes, job queue, job lifecycle, request limits             |
| `auth.py`           | `X-API-Key` dependency applied to every route                |
| `tts_engine.py`     | Text normalisation, VieNeu Nano synthesis, WAV output        |
| `phonemes.py`       | Grapheme to phoneme for Vietnamese text with English terms   |
| `kokoro_onnx.py`    | Legacy Kokoro ONNX implementation kept for tests             |
| `audio_pipeline.py` | Slot fitting, window assembly, ducking envelope, encoding    |

The active engine is `vieneu.Vieneu(mode="v3nano")`: a 48M-parameter,
24 kHz Vietnamese model that runs torch-free on ONNX Runtime. Its Hugging Face
cache is stored under `server/models/huggingface/` by default; set `HF_HOME` to
override that location.

## Install

```bash
cd ..
uv sync --python 3.12

copy server/.env.example server/.env             # Windows
# cp server/.env.example server/.env             # macOS/Linux
python -c "import secrets; print(secrets.token_hex(16))"
```

`uv sync` owns the root `.venv/`; do not create or activate another virtualenv.

Paste the generated key into `API_KEY` in `.env`. Python 3.12 and `ffmpeg` on
`PATH` are required; the server refuses to start without either the key or
ffmpeg.

The first start downloads the Nano ONNX graphs and preset voices from Hugging
Face (about 280 MB). Later starts use the project-local cache.

## Run

```bash
uv run python server/main.py
```

The default address is `http://127.0.0.1:18765`, overridable through `.env` or
flags:

```bash
uv run python server/main.py --host 0.0.0.0 --port 9000
```

Logs go to the console and to `local-ai-vi-dub/server.log` in the OS temp
directory. Every setting is documented in `.env.example`; the table in the
[main README](../README.md#configuration) lists them with defaults.

## Auth

`API_KEY` is mandatory — an empty value stops startup. Every API and audio
route requires the `X-API-Key` header, compared with `secrets.compare_digest`
on bytes.

Swagger UI (`/docs`, `/redoc`, `/openapi.json`) is **off by default**. Those
are plain Starlette routes that the global dependency cannot cover, so anyone
reaching the port could otherwise read the API surface. Set `ENABLE_DOCS=1`
when the server is on loopback and you want to try requests by hand; `POST
/api/preview` is the quickest way to confirm the model loads and to hear a
voice on the target machine.

## Engine

`tts_engine.VieneuNanoEngine` keeps one ONNX runtime warm for the process
lifetime. One job runs at a time; within a job, `SYNTH_WORKERS` sentences are
synthesised in parallel (3 by default).

`VIENEU_VOICE` picks the default voice, and `GET /api/voices` lists all voice
ids. Extension settings still holding old Kokoro voice ids or gTTS voice id
`vi` fall back to the configured VieNeu default.

Before synthesis, text goes through `normalize_for_speech`: technical acronyms
such as API, HTTPS, JSON, CPU and GPU become Vietnamese spoken forms, digits
are spelled out, and English words are phonemised as English and then mapped
onto Vietnamese sounds. Subtitle text is left untouched.

## API

```text
GET    /api/health               -> loading | ready | error
GET    /api/voices               -> available VieNeu Nano voices
POST   /api/preview              -> WAV for one sentence
POST   /api/synthesize           -> { jobId }
GET    /api/job/{jobId}          -> queued | running | done | error | cancelled
DELETE /api/job/{jobId}          -> cancel a running job
GET    /audio/{jobId}/w{i}.{ext} -> one ~30s window, Opus or MP3
```

Requests are limited to six-hour videos, 5000 non-empty segments and valid
timestamps. Incomplete translation output is rejected rather than rendered as
placeholder speech. Request and response shapes, plus every status code, are
in the [main README](../README.md#server-api).

Audio comes back as ~30-second windows rather than one file the length of the
video, each published as soon as it is ready: the first lands about four
seconds into a job that takes half a minute, so playback starts while the rest
is still being synthesised. Window edges always fall on a sentence start, so no
sentence is split across two files, and each window is exactly as long as the
slice of video it covers.

## Checks

```bash
uv run python -m compileall -q server tests
uv pip check
uv run python -m unittest discover -s tests -t tests
```

## Known limitations

- No bundled Python, ffmpeg or offline model installer.
- Voice quality varies by voice and by technical vocabulary.
- Job status lives in memory only, so a restart loses running jobs; finished
  audio is deleted after `JOB_RETENTION_MIN` and stale directories are swept at
  startup.
- No long-running stability test has been done.
- No systemd unit is shipped — see [deploy/README.md](../deploy/README.md).
