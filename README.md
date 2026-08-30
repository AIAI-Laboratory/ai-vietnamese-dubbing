# Local AI Vietnamese Dubbing

A Chrome extension that dubs Coursera lecture videos into Vietnamese,
in sync with the video timeline.

It reads the video's existing English captions, translates them with the
official Gemini API, synthesizes speech locally with Kokoro-Vietnamese ONNX, and plays
the dubbed audio on top of the video. Seeking works instantly — the whole
track is rendered once, so there's no buffering or drift.

Only translation uses the Gemini API. TTS runs on the local CPU after the
model has been downloaded once, so translated text is not sent to a speech
provider. Video and audio never leave your machine.

## How it works

```
Coursera <track> (VTT captions)
        |  fetched directly by the content script
        v
Group captions into sentences, budget syllables per sentence
        |
        v
Translate EN -> VI via Gemini API
        |
        v
Synthesize speech (local Kokoro-Vietnamese ONNX, CPU)
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

Requires [Python 3.10+](https://python.org), `git`, and `ffmpeg` on your PATH.
The first server start downloads the Kokoro ONNX model (about 311 MB) and
the selected voicepack; later starts use the local Hugging Face cache.

The server is API-only (no UI) — use the auto-generated Swagger UI at
`http://127.0.0.1:18765/docs` (click **Authorize**, paste your API key).
It loads `server/.env` on startup and refuses to start without an
`API_KEY` set — every request must carry it. Details in
[server/README.md](server/README.md).

### 2. Load the extension

`chrome://extensions` -> enable **Developer mode** -> **Load unpacked** ->
select the `extension/` folder.

### 3. Configure translation

Click the extension icon -> **Open settings** -> **Translate** tab. Paste a
[Gemini API key](https://aistudio.google.com/apikey), click **Save settings**,
then optionally click **Check Gemini**. The extension uses Gemini 3.1 Flash-Lite
through the official Gemini API; no Base URL or model selection is required.

In the **Voice** tab, leave the server URL at
`http://127.0.0.1:18765` (or point it at a remote server, with its API key)
and click **Load voices**.

### 4. Use it

Open a Coursera lecture, make sure captions (CC) are on, and click the mic
button next to the video controls.

## Verification

- JavaScript syntax, Python compilation, server unit tests, and dependency
  integrity are checked locally before release.
- Kokoro model loading and CPU synthesis can be smoke-tested with the
  Swagger preview route at `POST /api/preview`.

## Known limitations

- Kokoro voice quality varies; test the available voices on course material.
- No long-running stability testing yet (hours of continuous use).
- Subtitle drag-to-reposition tested by logic only, not on real
  mouse/touch input.
- Each video gets an automatic subject-specific terminology pass and a
  bilingual semantic review before speech synthesis.
- No speaker diarization (single voice per video).

## Project structure

```
extension/            Chrome MV3 extension
  manifest.json
  background.js          service worker: translation + TTS server calls
  lib/                    vtt.js, cache.js, plan.js
  content/                dub button, subtitles, audio/video sync
  options/                settings page (translation + voice)
  popup/                  toolbar popup (volume, subtitles, cache)

server/                TTS server (Python + FastAPI, API-only)
  main.py                 HTTP API, job management, startup
  tts_engine.py            KokoroOnnxEngine
  audio_pipeline.py         time-stretch, timeline assembly, export
  auth.py                   mandatory X-API-Key check
  requirements.txt
  .env.example

deploy/                Remote server deployment guide
  README.md
  Caddyfile               reverse proxy + automatic HTTPS
```
