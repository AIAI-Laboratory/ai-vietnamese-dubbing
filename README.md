# Local AI Vietnamese Dubbing

A Chrome extension that dubs Coursera lecture videos into Vietnamese,
in sync with the video timeline.

It reads the video's existing English captions, translates them with an
LLM API, synthesizes speech with a local TTS server, and plays the dubbed
audio on top of the video. Seeking works instantly — the whole track is
rendered once, so there's no buffering or drift.

Two network calls happen: translation (any OpenAI-compatible API) and
speech synthesis (gTTS, an unofficial Google Translate endpoint — see the
warning in [server/README.md](server/README.md)). Video and audio never
leave your machine; the translated text does.

## How it works

```
Coursera <track> (VTT captions)
        |  fetched directly by the content script
        v
Group captions into sentences, budget syllables per sentence
        |
        v
Translate EN -> VI via an LLM API
        |
        v
Synthesize speech (TTS server, gTTS)
        |  time-stretch/trim each sentence to fit its slot
        v
Assemble one audio track, exact length of the video
        v
Play through a single <audio> element, locked to video.currentTime
```

No real-time scheduler — the whole video is rendered once, then played
back like a normal audio file. Seeking, pausing, and changing playback
speed are just a currentTime assignment, nothing more.

Single voice per video (no speaker diarization).

## Install

### 1. Run the TTS server

```bash
cd server
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt     # macOS/Linux

copy .env.example .env                          # Windows
# cp .env.example .env                          # macOS/Linux

.venv\Scripts\python main.py                    # Windows
# .venv/bin/python main.py                      # macOS/Linux
```

Requires [Python 3.10+](https://python.org) and `ffmpeg` on your PATH.

The server is API-only (no UI) — use the auto-generated Swagger UI at
`http://127.0.0.1:18765/docs` (click **Authorize**, paste your API key).
It loads `server/.env` on startup and refuses to start without an
`API_KEY` set — every request must carry it. Details in
[server/README.md](server/README.md).

### 2. Load the extension

`chrome://extensions` -> enable **Developer mode** -> **Load unpacked** ->
select the `extension/` folder.

### 3. Configure translation

Click the extension icon -> **Open settings** -> **Translate** tab. Fill in
Base URL, API key, and model name. A couple of free-tier providers:

| Provider | Base URL | Suggested model |
|---|---|---|
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.5-flash` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |

Click **Test model**. In the **Voice** tab, leave the server URL at
`http://127.0.0.1:18765` (or point it at a remote server, with its API key)
and click **Load voices**.

### 4. Use it

Open a Coursera lecture, make sure captions (CC) are on, and click the mic
button next to the video controls.

## Verified

- End-to-end tested with real gTTS calls: captions grouped, translated,
  synthesized, assembled, and played back in sync on real lecture videos.
- Auth tested live: missing/wrong API key -> 401, correct key -> 200,
  server refuses to start with no `API_KEY` set.
- Full JS syntax check (`node --check`) and Python compile check pass.

## Known limitations

- gTTS is an unofficial endpoint — it can rate-limit or break without
  notice, and automated calls may violate Google Translate's ToS.
- No long-running stability testing yet (hours of continuous use).
- Subtitle drag-to-reposition tested by logic only, not on real
  mouse/touch input.
- Glossary in `extension/lib/glossary.js` was seeded from one sample
  lecture — review it for your own courses.
- No speaker diarization (single voice per video).

## Project structure

```
extension/            Chrome MV3 extension
  manifest.json
  background.js          service worker: translation + TTS server calls
  lib/                    vtt.js, cache.js, glossary.js, plan.js
  content/                dub button, subtitles, audio/video sync
  options/                settings page (translation + voice)
  popup/                  toolbar popup (volume, subtitles, cache)

server/                TTS server (Python + FastAPI, API-only)
  main.py                 HTTP API, job management, startup
  tts_engine.py            GttsEngine
  audio_pipeline.py         time-stretch, timeline assembly, export
  auth.py                   mandatory X-API-Key check
  requirements.txt
  .env.example

deploy/                Remote server deployment guide
  README.md
  Caddyfile               reverse proxy + automatic HTTPS
```
