# Audit follow-up tasks

Pick one task per agent. Do not combine tasks that change the same ownership
boundary unless the dependency is listed below.

## P0 security and correctness

### [x] SEC-01 Preview guard

- Owner: server
- Files: server/main.py, tests/test_api.py
- Work: add a preview semaphore and reuse SYNTH_TIMEOUT_SEC.
- Acceptance: concurrent preview calls are bounded; a hung preview returns a
  controlled error; normal preview still returns WAV.
- Depends on: none.

### [x] SEC-02 Pin model artifacts

- Owner: model deployment
- Files: scripts/download_vieneu_model.py, MODEL_DEPLOY.md
- Work: pin the VieNeu repo commit and verify SHA-256 for all six files.
- Acceptance: changed artifact fails before inference; the pinned revision is
  shown in logs and docs.
- Depends on: none.

### [x] SEC-03 Protect runtime files

- Owner: server deployment
- Files: server/main.py, deploy/README.md
- Work: create the temp directory with mode 0700 and private output/log files.
- Acceptance: another local user cannot list or read job audio/logs.
- Depends on: none.

### [x] SEC-04 Reduce public exposure

- Owner: API/deployment
- Files: server/main.py, extension/options/options.js, deploy/README.md
- Work: constrain CORS, require HTTPS for remote endpoints, and keep loopback
  HTTP as the only exception.
- Acceptance: loopback still works; arbitrary remote HTTP endpoints are rejected
  or warned before saving.
- Depends on: none.

## P1 traceability

### [x] TRACE-01 Unify plan version

- Owner: extension settings
- Files: extension/background.js, extension/options/options.js,
  extension/content/content.js
- Work: define one plan version constant and use it for settings normalization,
  cache keys and content fallback.
- Acceptance: opening Options does not rewrite the version or reset the reading
  rate; old cache invalidation is intentional and tested.
- Depends on: none.

### [x] TRACE-02 Cancel before TTS exists

- Owner: service worker
- Files: extension/background.js, tests/background.test.js
- Work: add an abort state for translation/review and check it before each
  Gemini call; stop when the port disconnects.
- Acceptance: closing the tab before POST /api/synthesize stops later Gemini and
  TTS work.
- Depends on: none.

### [x] TRACE-03 Clean resynthesis jobs

- Owner: service worker
- Files: extension/background.js, tests/background.test.js
- Work: delete jobsByPort on successful RESYNTH DONE.
- Acceptance: disconnecting after successful resynthesis does not send DELETE.
- Depends on: none.

### [x] TRACE-04 Recover disconnected content

- Owner: content script
- Files: extension/content/content.js, tests/content.test.js
- Work: handle port.onDisconnect by clearing loading state, releasing the hold
  and resuming the original video when appropriate.
- Acceptance: worker disconnect cannot leave a stale paused/loading player.
- Depends on: none.

### [x] TRACE-05 Timeout health checks

- Owner: Options/service worker
- Files: extension/background.js, extension/options/options.js,
  tests/background.test.js
- Work: use one abortable request helper for health, voice list and preview.
- Acceptance: a stalled server produces a visible error within the configured
  timeout.
- Depends on: none.

## P2 performance

### [x] OPT-01 Measure Nano worker count

- Owner: TTS runtime
- Files: server/.env.example, benchmark notes
- Work: benchmark SYNTH_WORKERS 1 and 2 with ORT_THREADS values on the target
  CPU.
- Acceptance: choose the fastest stable configuration from measured RTF and
  first-window latency.
- Depends on: none.

### [x] OPT-02 Remove duplicate window audio

- Owner: worker/content protocol
- Files: extension/background.js, extension/content/content.js,
  tests/background.test.js, tests/content.test.js
- Work: do not resend base64 audio in DONE after WINDOW delivery.
- Acceptance: incremental playback remains unchanged and cache still stores a
  complete result.
- Depends on: TRACE-01.

### [x] OPT-03 Reduce first-window latency

- Owner: audio pipeline
- Files: server/audio_pipeline.py, server/.env.example, tests/test_audio.py
- Work: benchmark a configurable 10–15 second target against the current 30s.
- Acceptance: choose the target only when first audio improves without making
  total RTF materially worse.
- Depends on: OPT-01.

### [x] OPT-04 Avoid repeated subtitle DOM work

- Owner: content script
- Files: extension/content/content.js, tests/content.test.js
- Work: cache the active cue and update subtitle DOM only when it changes.
- Acceptance: same cue does not rebuild the subtitle element every 250ms.
- Depends on: none.

### [x] OPT-05 Bound IndexedDB cache size

- Owner: browser cache
- Files: extension/lib/cache.js, tests/content.test.js
- Work: enforce a byte or duration ceiling before eviction.
- Acceptance: a large video cannot grow cache without bound.
- Depends on: none.

### [x] OPT-06 Remove unused timing state

- Owner: server
- Files: server/main.py
- Work: delete t_synth_total if no metric consumes it.
- Acceptance: no behavior change; full tests pass.
- Depends on: none.

## Working rule

Each worker must include:

1. The finding or requested behavior.
2. The exact files and lines changed.
3. A focused regression test.
4. Full test output.
