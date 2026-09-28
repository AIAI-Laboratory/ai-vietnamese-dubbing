# Security, optimization and traceability audit

Date: 2026-09-28

Six read-only audits covered security, optimization and four traceability
layers: UI, service worker, API server, and TTS/audio/deployment.

Verification after implementation:

- JavaScript: 54 tests pass.
- Python: 52 tests pass.
- `uv run python -m compileall -q server scripts`: pass.
- `uv pip check`: pass.

The worktree already contained uncommitted UI changes before the audit.

## Executive summary

No critical vulnerability was found.

Highest priority before this pass:

1. Preview bypasses the job queue and has no timeout or concurrency limit.
2. Model downloads follow the repository default branch and have no checksum.
3. Audio is copied through several base64 and Blob representations.
4. Closing the video tab before TTS starts does not cancel Gemini work.
5. Plan-version defaults disagree and can reset cache/calibration state.

Implemented in this pass: preview timeout/semaphore, pinned model checksums,
private runtime files, explicit CORS allowlist, HTTPS for remote TTS URLs,
queue admission locking, one plan version, pre-TTS cancellation checks,
resynthesis cleanup, content disconnect recovery, health timeout, glossary
cache clearing, duplicate DONE audio removal, subtitle DOM caching, bounded
IndexedDB audio cache, runtime window-size setting, and removal of unused
timing state.

Normal UI-to-API-to-audio contracts are connected correctly.

## Security

### Critical

None found.

### High

#### SEC-01: Preview can exhaust CPU — fixed

Evidence: [server/main.py:279](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:279)

POST /api/preview calls ENGINE.synth directly. It has no synthesis timeout or
concurrency gate. A client holding the API key can create unbounded preview
work.

Minimal fix: use the existing synthesis timeout and a preview semaphore.

#### SEC-02: Model supply chain is not pinned — fixed

Evidence: [scripts/download_vieneu_model.py:30](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/scripts/download_vieneu_model.py:30)

The downloader follows the repository default revision and validates only that
the expected files exist.

Minimal fix: pin a Hugging Face commit SHA and verify SHA-256 for each file.

### Medium

#### SEC-03: Temporary audio and logs are readable by local users — fixed

Evidence: [server/main.py:51](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:51)

The server uses /tmp/local-ai-vi-dub without explicitly creating private
directory and file permissions.

Minimal fix: directory mode 0700 and file mode 0600.

#### SEC-04: CORS allows every origin — fixed

Evidence: [server/main.py:94](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:94)

This increases exposure if the service is made public and the API key leaks.

Minimal fix: disable CORS for loopback-only use, or allow only known origins.

#### SEC-05: One API key controls every job

Evidence: [server/main.py:352](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:352)

Any holder of the key can poll, cancel or download any known job. This is
acceptable for one local user, not for a shared public service.

Minimal fix: per-job capability tokens, or enforce private/loopback deployment.

#### SEC-06: Configured server URL receives the server key — mitigated

Evidence: [extension/background.js:877](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:877)

The endpoint is user-configurable, so a wrong or malicious remote URL can
receive X-API-Key.

Minimal fix: allow HTTP only for loopback, require HTTPS for remote URLs, and
warn before saving a remote endpoint.

#### SEC-07: Internal errors reach API clients — mitigated

Evidence: [server/main.py:525](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:525)

Some errors expose paths, ffmpeg details and raw exception text.

Minimal fix: keep details in server logs and return a request ID to clients.

#### SEC-08: Swagger is unauthenticated when enabled — fixed

Evidence: [server/main.py:86](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:86)

The docs routes sit outside the global API-key dependency.

Minimal fix: enable only on loopback, or add explicit docs authentication.

#### SEC-09: Queue admission has a race — fixed

Evidence: [server/main.py:323](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:323) and [server/main.py:338](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:338)

Concurrent requests can all see capacity before inserting their jobs.

Minimal fix: reserve the queue slot and insert the job under one lock.

### Low

- Localhost permissions cover all ports: [extension/manifest.json:11](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/manifest.json:11).
- Message handlers do not validate sender: [extension/background.js:850](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:850). Risk is low while external messaging stays disabled.
- Deployment docs do not set an env-file permission or systemd umask.

## Optimization

### High

#### OPT-01: Nano inference is serialized — measured and configured

Evidence: [server/main.py:454](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:454)

VieNeu Nano protects core inference with an internal lock. SYNTH_WORKERS=3
therefore adds scheduling overhead rather than three concurrent inferences.

Minimal fix: benchmark SYNTH_WORKERS=1 versus 2 and keep the faster setting.

Measured on this CPU: 1 worker RTF 0.451, 2 workers 0.265, 3 workers 0.282.
The default is now 2 workers.

#### OPT-02: Audio is copied through multiple representations — partially fixed

Evidence: [extension/background.js:615](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:615), [extension/background.js:767](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:767), [extension/content/content.js:740](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:740)

Audio moves from server file to ArrayBuffer, base64 string, port message,
Blob, object URL and IndexedDB. DONE also repeats windows already sent earlier.

Minimal fix: omit window audio from DONE after incremental delivery, or fetch
short-lived audio URLs directly from content.

#### OPT-03: First audio waits for a full 30-second window — fixed/configurable

Evidence: [server/audio_pipeline.py:28](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/audio_pipeline.py:28) and [server/main.py:456](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:456)

Playback is progressive by window, not by sentence.

Minimal fix: benchmark a 10–15 second target before changing the current 30s.

Measured with a representative 52-second job: first window 4.921s at 30s,
2.372s at 15s, and 2.230s at 10s. Total time was 8.024s, 6.304s, and
6.509s respectively, so 15s is the default balance.

### Medium

- The normal path writes raw WAV, copies it to fit WAV, then deletes raw:
  [server/audio_pipeline.py:157](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/audio_pipeline.py:157).
- Subtitle lookup still runs every 250ms, but DOM rebuild is cached:
  [extension/content/content.js:889](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:889).
- IndexedDB eviction still reads the bounded record set, now with a 64 MiB cap:
  [extension/lib/cache.js:54](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/lib/cache.js:54).
- Preview is now timeout-bounded and limited to one concurrent request:
  [server/main.py:279](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:279).

### Low

- Translation ID validation still has small includes/indexOf scans:
  [extension/background.js:354](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:354).
- Subtitle construction is shared by normal synthesis and resynthesis:
  [extension/background.js:739](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:739).
- `t_synth_total` was unused and has been removed.
- Navigation polling runs every second per content-script tab:
  [extension/content/content.js:246](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:246).

No safe direct dependency removal was found after the legacy cleanup.

## Traceability

### Verified path

UI controls call runtime messages or the dub-job port. The worker builds the
translation plan, calls Gemini, posts the TTS payload, polls the job and sends
windows back. The API validates the same segment fields, creates the job,
calls VieNeu, fits audio into the timeline, creates ducking data and returns
window URLs. Content turns each window into a Blob URL and syncs it to the
video timestamp.

Key contracts:

- START payload: [extension/content/content.js:594](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:594).
- TTS request: [extension/background.js:559](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:559).
- Pydantic request models: [server/main.py:237](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:237).
- Audio validation: [server/main.py:376](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/server/main.py:376).
- Browser audio conversion: [extension/background.js:625](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:625).

### Findings

#### TRACE-01: Plan versions disagree — fixed

Background uses gemini-v3, Options uses gemini-v2, and Content fallback uses
vieneu-nano-v1. Opening Options can reset the version and reading-rate
calibration.

Evidence: [extension/background.js:4](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:4), [extension/options/options.js:3](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/options/options.js:3), [extension/content/content.js:13](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:13).

Severity: high.

#### TRACE-02: Disconnect before TTS does not cancel Gemini work — fixed

jobsByPort is populated only after the server TTS job exists. A tab closed
during translation can leave Gemini work running and later create a TTS job.

Evidence: [extension/background.js:697](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:697) and [extension/background.js:747](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:747).

Severity: high.

#### TRACE-03: Resynthesis leaves a completed job mapped — fixed

runResynth sets jobsByPort but does not delete it after DONE. Port disconnect
then sends an unnecessary DELETE request.

Evidence: [extension/background.js:801](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:801) and [extension/background.js:818](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:818).

Severity: medium.

#### TRACE-04: Content has no port-disconnect recovery — fixed

The content script can remain loading or paused if the service worker
disconnects without sending ERROR.

Evidence: [extension/content/content.js:594](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:594).

Severity: medium.

#### TRACE-05: Health check has no timeout — fixed

The Options health request can stay pending indefinitely:
[extension/background.js:882](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/background.js:882).

Severity: medium.

#### TRACE-06: Clear cache does not clear glossary cache — fixed

The popup deletes IndexedDB but leaves glossaryCache in extension storage:
[extension/popup/popup.js:151](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/popup/popup.js:151).

Severity: low.

#### TRACE-07: Site toggles hide UI after injection

The manifest still injects on both supported domains. The setting stops overlay
creation after injection; it is not a content-script permission toggle.

Evidence: [extension/manifest.json:21](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/manifest.json:21) and [extension/content/content.js:266](/home/nguyenn/Desktop/Projects/ai-vietnamese-dubbing/extension/content/content.js:266).

Severity: low.

## Priority order

1. Unify planVersion.
2. Add preview timeout and concurrency control.
3. Pin model revision and checksums.
4. Cancel the active translation pipeline on port disconnect.
5. Clean up resynthesis mappings and recover disconnected content.
6. Measure Nano worker count and window size.
7. Remove duplicate audio/base64 delivery.
8. Harden temp-file permissions and CORS.
