# TTS server

Python + FastAPI, API-only — no UI or dashboard. Swagger UI is
auto-generated at `/docs`: click **Authorize**, paste your API key, and
try requests directly from there.

## Install

```bash
cd server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt     # macOS/Linux

cp .env.example .env
python -c "import secrets; print(secrets.token_hex(16))"   # paste into API_KEY in .env
```

Always use a virtualenv — installing straight into the system Python can
break version constraints of unrelated tools.

Requires `ffmpeg` on your PATH — used to decode gTTS's MP3 output, time-
stretch audio to fit each subtitle slot, and export the final Opus/MP3.

## Auth

The server **refuses to start** if `API_KEY` is empty in `.env`. There is
no "local means no auth needed" fallback — it's an API server, and an
unauthenticated one is callable by anyone who knows the address.

Every route (`/api/health`, `/api/voices`, `/api/preview`,
`/api/synthesize`, `/api/job/{id}`, `/audio/{file}`) requires the
`X-API-Key` header to match `.env`. `/docs` and `/openapi.json` (the
Swagger UI page itself, not an API route) are the only exceptions, so the
docs page can load before you authorize.

## Run

```bash
.venv\Scripts\python main.py     # Windows
.venv/bin/python main.py         # macOS/Linux
```

Config loads from `server/.env` automatically (via `python-dotenv`).
Default port `18765`, host `127.0.0.1` — override via `.env` or flags:

```bash
.venv/bin/python main.py --host 0.0.0.0 --port 9000
```

### Logs

Written to both the console and `server.log` in a temp directory —
Windows: `%TEMP%\local-ai-vi-dub\server.log`; macOS/Linux: `$TMPDIR` or
`/tmp/local-ai-vi-dub/server.log`.

On startup the server logs its environment (OS/arch/Python version) and
the Swagger UI link. If `--host` is `0.0.0.0`/`::`, it also tries to
detect your public IP via `api.ipify.org` (fails silently if unreachable).

## gTTS: an unofficial endpoint

The only engine (`tts_engine.GttsEngine`, wrapping the `gTTS` package)
calls `translate.google.com`, which Google does not publish an SDK or SLA
for. Real, not theoretical, risks:

- It can stop working or get rate-limited without notice.
- Automated use may violate Google Translate's Terms of Service.
- Translated text (not the original audio/video) is sent over the network.

The trade-off: free, no model to install, faster than local CPU synthesis.
There is no mock fallback — if the engine fails to load, `/api/health`
reports `"status":"error"` directly.

## API

Full reference (and a live tester) at `GET /docs`. Summary:

```
GET  /api/health              -> {"ok","status":"loading"|"ready"|"error","model","mock","error"}
GET  /api/voices               -> {"voices":[{"id","label"}]}  (503 while loading)
POST /api/preview              body {text,voice} -> WAV file
POST /api/synthesize           body {voice,durationSec,segments:[{id,start,end,vi}]} -> {"jobId"}
GET  /api/job/{jobId}          -> {"status","progress","audioUrl","measuredSyllablesPerSec","segments","error",...}
GET  /audio/{jobId}.{ext}      -> audio file
```

All routes require `X-API-Key` (see Auth above).

## Verified

- Real end-to-end jobs with gTTS: correct duration and format returned.
- Auth tested live: missing/wrong key -> 401, correct key -> 200. `/docs`
  and `/openapi.json` confirmed reachable without a key.
- Server confirmed to refuse startup with no `API_KEY` set (real exit
  code 1, correct error message, no encoding issues).
- Public IP detection tested against the real `api.ipify.org`.

## Known limitations

- No installer, no bundled ffmpeg — Python and ffmpeg must be installed
  manually.
- No long-running stability testing (hours of continuous use, many jobs
  back to back).
- Voice quality not verified by ear in this environment — relies on the
  official `gTTS` package as-is.
- No systemd unit shipped for auto-restart on crash — see
  [deploy/README.md](../deploy/README.md).
