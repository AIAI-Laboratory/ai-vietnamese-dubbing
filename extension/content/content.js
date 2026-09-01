/** Content script — chạy trên trang video được lib/sites.js hỗ trợ (Coursera, YouTube). */
(function () {
  const warn = (...args) => console.warn("[LDUB]", ...args);

  const PROTOCOL_VERSION = 2;
  console.log(`[LDUB] content script v${PROTOCOL_VERSION} đã nạp`);

  const ICON_MIC =
    '<svg class="ldub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>';
  const ICON_PLAY =
    '<svg class="ldub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>';

  const DEFAULT_SETTINGS = {
    subtitlesOn: false,
    subtitlesEnOn: true,
    subtitlePosition: "bottom",
    subtitleSize: "medium",
    subtitleColor: "white-black",
    subtitleOffsetX: 0,
    subtitleOffsetY: 0,
    dubVolume: 1.0,
    bedVolume: 1.0,
    serverUrl: "http://127.0.0.1:18765",
    serverApiKey: "",
    voice: "",
    viSyllablesPerSec: 3.8,
    planVersion: "kokoro-v11",
  };

  const SUBTITLE_SIZE_PCT = { small: 0.032, medium: 0.042, large: 0.056 };

  let video = null;
  let overlay = null;
  let dubBtn = null;
  let dockObserver = null;
  let dockRetryTimer = null;
  let audioWindows = [];
  let activeWindow = null;
  let subtitleEl = null;
  let controlsEl = null;
  let fullscreenBound = false;
  let currentState = "idle";
  let currentPlan = null;
  let currentTranslated = null;
  let currentSubtitles = null;
  let syncTimer = null;
  let syncAbort = null;
  let mode = "dubbed";
  let settings = { ...DEFAULT_SETTINGS };
  let voicesCache = null;
  let truncatedIds = new Set();
  let jobRunning = false;
  let heldForSynthesis = false;
  let duckTimer = null;
  const liveObjectUrls = new Set();

  /** Người xem tự bấm play trong lúc chờ thì trả quyền điều khiển lại cho họ. */
  function releaseHold() {
    heldForSynthesis = false;
  }

  /** Dừng video trong lúc tổng hợp — không có gì để nghe thì xem cũng vô nghĩa. */
  function holdVideoForSynthesis() {
    if (!video || video.paused || heldForSynthesis) return;
    heldForSynthesis = true;
    video.addEventListener("play", releaseHold);
    video.pause();
  }

  /** Chạy tiếp khi audio đầu tiên đã sẵn sàng, chỉ khi chính mình đã dừng nó. */
  function resumeVideoAfterSynthesis() {
    if (!heldForSynthesis) return;
    heldForSynthesis = false;
    video.removeEventListener("play", releaseHold);
    video.play().catch(() => {});
  }

  /** Object URL sống theo document, gỡ thẻ <audio> không giải phóng blob — phải thu hồi tay. */
  function trackedObjectUrl(blob) {
    const url = URL.createObjectURL(blob);
    liveObjectUrls.add(url);
    return url;
  }

  function releaseObjectUrl(url) {
    if (!url || !liveObjectUrls.has(url)) return;
    URL.revokeObjectURL(url);
    liveObjectUrls.delete(url);
  }

  function releaseAllObjectUrls() {
    for (const url of liveObjectUrls) URL.revokeObjectURL(url);
    liveObjectUrls.clear();
  }
  const previewAudioCache = new Map();

  let site = null;
  if (!DUB.sites) {
    warn("lib/sites.js CHƯA nạp — kiểm tra content_scripts.js trong manifest.json");
  }

  function refreshSite() {
    const next = DUB.sites && DUB.sites.current ? DUB.sites.current() : null;
    if (next === site) return;
    site = next;
  }

  function videoIdFromUrl() {
    return site ? `${site.id}::${site.videoId()}` : location.pathname;
  }

  async function loadSettings() {
    const response = await chrome.runtime.sendMessage({ type: "GET_CONTENT_SETTINGS" });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || "Không đọc được cài đặt extension");
    }
    settings = { ...DEFAULT_SETTINGS, ...(response.settings || {}) };
  }

  function saveSettings(patch) {
    Object.assign(settings, patch);
    chrome.runtime.sendMessage({ type: "PATCH_CONTENT_SETTINGS", patch })
      .then((response) => {
        if (!response || !response.ok) {
          console.warn("[LDUB] không lưu được cài đặt:", response && response.error);
        }
      })
      .catch((error) => console.warn("[LDUB] không lưu được cài đặt:", error));
  }

  function cacheKeyParts(videoId, voice = settings.voice) {
    return {
      videoId,
      voice,
      planVersion: settings.planVersion,
      translationModel: "gemini-3.1-flash-lite",
    };
  }

  function findVideo() {
    const vids = [...document.querySelectorAll("video")];
    return vids.find((v) => v.duration > 0) || vids[0] || null;
  }

  function teardown() {
    if (syncAbort) {
      syncAbort.abort();
      syncAbort = null;
    }
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    stopDucking();
    for (const win of audioWindows) {
      win.el.pause();
      win.el.remove();
    }
    audioWindows = [];
    activeWindow = null;
    releaseAllObjectUrls();
    if (dockObserver) {
      dockObserver.disconnect();
      dockObserver = null;
    }
    if (dockRetryTimer) {
      clearTimeout(dockRetryTimer);
      dockRetryTimer = null;
    }
    jobRunning = false;
    heldForSynthesis = false;
    if (dubBtn) {
      setStatus(null);
      dubBtn.remove();
      dubBtn = null;
    }
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (subtitleEl) {
      subtitleEl.remove();
      subtitleEl = null;
    }
    if (controlsEl) {
      controlsEl.remove();
      controlsEl = null;
    }
    if (video) resetVideoVolume();
    currentState = "idle";
    currentPlan = currentTranslated = currentSubtitles = null;
  }

  function resetVideoVolume() {
    try {
      video.muted = false;
      video.volume = 1;
    } catch (e) {
    }
  }

  let lastPath = location.pathname + location.search;
  let navTimer = null;
  let orphaned = false;

  /** Reload extension trong lúc trang đang mở sẽ để lại content script này "mồ côi" */
  function contextGone() {
    try {
      return !chrome.runtime || !chrome.runtime.id;
    } catch (e) {
      return true;
    }
  }

  function shutdownOrphan() {
    if (orphaned) return;
    orphaned = true;
    if (navTimer) clearInterval(navTimer);
    navTimer = null;
    stopDucking();
    if (syncTimer) clearInterval(syncTimer);
    if (syncAbort) syncAbort.abort();
    pauseAllWindows();
    if (video) resetVideoVolume();
    warn("extension vừa được tải lại — bản cũ trong trang này dừng lại, F5 để dùng tiếp");
    if (overlay) {
      setPanel(0, "Extension vừa được tải lại. Nhấn F5 để dùng tiếp.", true);
    }
  }

  function watchNavigation() {
    refreshSite();
    navTimer = setInterval(() => {
      if (contextGone()) {
        shutdownOrphan();
        return;
      }
      const here = location.pathname + location.search;
      if (here !== lastPath) {
        lastPath = here;
        teardown();
        refreshSite();
      }
      init();
    }, 1000);
  }

  async function init() {
    if (!site) return;

    const v = findVideo();
    if (!v || v === video) return;
    video = v;
    try {
      await loadSettings();
    } catch (error) {
      video = null;
      if (contextGone()) {
        shutdownOrphan();
        return;
      }
      console.error("[LDUB] không nạp được cài đặt extension:", error);
      return;
    }
    injectOverlay();
  }

  /** Nơi gắn phần tử nổi: toàn màn hình chỉ vẽ phần tử fullscreen và con cháu của nó. */
  function floatingHost() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
  }

  /** Đưa phụ đề, bảng điều khiển và nút nổi về đúng nơi cần gắn. */
  function remountFloating() {
    const host = floatingHost();
    for (const el of [overlay, subtitleEl]) {
      if (el && el.parentElement !== host) host.appendChild(el);
    }
    if (dubBtn && !dubBtn.classList.contains("ldub-btn-docked")
        && dubBtn.parentElement !== host) {
      host.appendChild(dubBtn);
    }
    positionOverlay();
  }

  function injectOverlay() {
    overlay = document.createElement("div");
    overlay.className = "ldub-overlay";
    overlay.innerHTML = `
      <div class="ldub-panel" hidden>
        <div class="ldub-panel-title">Local AI Vietnamese Dubbing</div>
        <div class="ldub-progress"><div class="ldub-progress-bar"></div></div>
        <div class="ldub-note">Sẵn sàng.</div>
      </div>
    `;
    document.body.appendChild(overlay);

    dubBtn = document.createElement("button");
    dubBtn.className = "ldub-btn ldub-btn-floating";
    dubBtn.type = "button";
    dubBtn.title = "Thuyết minh tiếng Việt";
    dubBtn.innerHTML = `${ICON_MIC}<span class="ldub-btn-text">Thuyết minh tiếng Việt</span>`;
    dubBtn.addEventListener("click", onDubClick);
    document.body.appendChild(dubBtn);

    if (!fullscreenBound) {
      fullscreenBound = true;
      document.addEventListener("fullscreenchange", remountFloating);
      document.addEventListener("webkitfullscreenchange", remountFloating);
    }

    subtitleEl = document.createElement("div");
    subtitleEl.className = "ldub-subtitle";
    subtitleEl.hidden = true;
    document.body.appendChild(subtitleEl);
    initSubtitleDrag();

    const reposition = () => positionOverlay();
    new ResizeObserver(reposition).observe(video);
    window.addEventListener("scroll", reposition, { passive: true });
    window.addEventListener("resize", reposition, { passive: true });
    reposition();

    tryDockToControlBar();
    tryLoadFromCache();
  }

  const SPEED_BTN_TEXT_RE = /^\d+(\.\d+)?x$/i; // dự phòng nếu trang đổi aria-label

  function findSpeedControlNear(v) {
    let btn = null;
    for (const selector of (site && site.dockSelectors) || []) {
      btn = document.querySelector(selector);
      if (btn) return btn;
    }
    const vr = v.getBoundingClientRect();
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const text = (el.textContent || "").trim();
      if (!SPEED_BTN_TEXT_RE.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < vr.top - 20 || r.top > vr.bottom + 80) continue;
      if (r.left < vr.left - 20 || r.right > vr.right + 20) continue;
      btn = el;
      break;
    }
    return btn || null;
  }

  function tryDockToControlBar() {
    if (!video || !dubBtn) return;
    try {
      const speedBtn = findSpeedControlNear(video);
      const slot = speedBtn
        ? speedBtn.closest("div") || speedBtn.parentElement
        : null;
      const row = slot ? slot.parentElement : null;
      if (!slot || !row) {
        scheduleDockRetry();
        return;
      }

      row.appendChild(dubBtn);
      dubBtn.classList.remove("ldub-btn-floating");
      dubBtn.classList.add("ldub-btn-docked");
      dubBtn.style.position = "";
      dubBtn.style.top = dubBtn.style.left = dubBtn.style.bottom = "";
      positionOverlay();

      if (dockObserver) dockObserver.disconnect();
      dockObserver = new MutationObserver(() => {
        if (!row.contains(dubBtn)) tryDockToControlBar();
      });
      dockObserver.observe(row, { childList: true });
    } catch (e) {
      console.warn(
        "[LDUB] không gắn được vào thanh điều khiển của trang, giữ vị trí nổi.",
        e,
      );
    }
  }

  function scheduleDockRetry() {
    clearTimeout(dockRetryTimer);
    let attempts = 0;
    const tick = () => {
      attempts++;
      if (dubBtn && dubBtn.classList.contains("ldub-btn-docked")) return;
      if (findSpeedControlNear(video)) {
        tryDockToControlBar();
        return;
      }
      if (attempts < 6) dockRetryTimer = setTimeout(tick, 1000);
    };
    dockRetryTimer = setTimeout(tick, 1000);
  }

  function positionOverlay() {
    if (!video || !overlay || !dubBtn) return;
    const r = video.getBoundingClientRect();
    if (!dubBtn.classList.contains("ldub-btn-docked")) {
      const btnClearance = Math.max(64, r.height * 0.11);
      dubBtn.style.position = "fixed";
      dubBtn.style.top = "auto";
      dubBtn.style.bottom =
        Math.round(window.innerHeight - r.bottom + btnClearance) + "px";
      dubBtn.style.left = r.left + r.width - dubBtn.offsetWidth - 12 + "px";
    }
    const br = dubBtn.getBoundingClientRect();
    overlay.style.top = "auto";
    overlay.style.left = "auto";
    overlay.style.right = Math.round(window.innerWidth - br.right) + "px";
    overlay.style.bottom = Math.round(window.innerHeight - br.top + 8) + "px";
    if (subtitleEl) {
      subtitleEl.style.left = r.left + "px";
      subtitleEl.style.width = r.width + "px";
      subtitleEl.style.fontSize =
        Math.round(
          r.height *
            (SUBTITLE_SIZE_PCT[settings.subtitleSize] ||
              SUBTITLE_SIZE_PCT.medium),
        ) + "px";
      subtitleEl.dataset.color = settings.subtitleColor || "white-black";

      if (settings.subtitlePosition === "top") {
        subtitleEl.style.top =
          Math.round(r.top + Math.max(16, r.height * 0.03)) + "px";
        subtitleEl.style.bottom = "auto";
      } else {
        const clearance = Math.max(72, r.height * 0.12);
        subtitleEl.style.bottom =
          Math.round(window.innerHeight - r.bottom + clearance) + "px";
        subtitleEl.style.top = "auto";
      }
      subtitleEl.style.transform = `translate(${settings.subtitleOffsetX || 0}px, ${settings.subtitleOffsetY || 0}px)`;
    }
  }

  let subtitleDrag = null;

  function initSubtitleDrag() {
    subtitleEl.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".ldub-sub-box")) return;
      subtitleDrag = {
        startX: e.clientX,
        startY: e.clientY,
        startOffX: settings.subtitleOffsetX || 0,
        startOffY: settings.subtitleOffsetY || 0,
      };
      subtitleEl.classList.add("ldub-dragging");
      subtitleEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    subtitleEl.addEventListener("pointermove", (e) => {
      if (!subtitleDrag) return;
      settings.subtitleOffsetX =
        subtitleDrag.startOffX + (e.clientX - subtitleDrag.startX);
      settings.subtitleOffsetY =
        subtitleDrag.startOffY + (e.clientY - subtitleDrag.startY);
      subtitleEl.style.transform = `translate(${settings.subtitleOffsetX}px, ${settings.subtitleOffsetY}px)`;
    });
    const endDrag = () => {
      if (!subtitleDrag) return;
      subtitleDrag = null;
      subtitleEl.classList.remove("ldub-dragging");
      saveSettings({ subtitleOffsetX: settings.subtitleOffsetX, subtitleOffsetY: settings.subtitleOffsetY });
    };
    subtitleEl.addEventListener("pointerup", endDrag);
    subtitleEl.addEventListener("pointercancel", endDrag);
    subtitleEl.addEventListener("dblclick", (e) => {
      if (!e.target.closest(".ldub-sub-box")) return;
      settings.subtitleOffsetX = 0;
      settings.subtitleOffsetY = 0;
      saveSettings({ subtitleOffsetX: 0, subtitleOffsetY: 0 });
      positionOverlay();
    });
  }

  /** Nút chỉ còn icon (xem .ldub-btn trong CSS) — text vẫn cập nhật trong DOM (đọc được bằng screen reader) và làm title, hiện khi rê chuột vào. */
  const STATUS_CLASSES = [
    "ldub-status-working",
    "ldub-status-partial",
    "ldub-status-ready",
    "ldub-status-error",
  ];

  function setStatus(status) {
    if (!dubBtn) return;
    dubBtn.classList.remove(...STATUS_CLASSES);
    if (status) dubBtn.classList.add(`ldub-status-${status}`);
  }

  /** Đèn = hàm của (có lỗi?, job còn chạy?, đã có audio chưa?). */
  function refreshStatus() {
    if (currentState === "error") return setStatus("error");
    if (jobRunning) return setStatus(audioWindows.length ? "partial" : "working");
    return setStatus(audioWindows.length ? "ready" : null);
  }

  function setBtnLabel(text) {
    dubBtn.querySelector(".ldub-btn-text").textContent = text;
    dubBtn.title = text;
  }

  function setPanel(pct, note, open) {
    const panel = overlay.querySelector(".ldub-panel");
    const bar = overlay.querySelector(".ldub-progress-bar");
    const noteEl = overlay.querySelector(".ldub-note");
    if (open !== undefined) panel.hidden = !open;
    if (pct !== undefined)
      bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (note !== undefined) noteEl.textContent = note;
    positionOverlay();
  }

  async function tryLoadFromCache() {
    try {
      const rec = await DUB.cache.get(cacheKeyParts(videoIdFromUrl()));
      if (rec && rec.audioBase64) {
        setBtnLabel("Xem lại bản đã thuyết minh");
      }
    } catch (e) {
    }
  }

  async function onDubClick() {
    if (currentState === "ready") {
      toggleControls();
      return;
    }
    if (currentState === "loading") return;

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      setPanel(
        0,
        "Video này chưa có thời lượng xác định (livestream, hoặc chưa nạp xong). "
          + "Không lồng tiếng được — thử lại khi video đã tải.",
        true,
      );
      currentState = "error";
      return;
    }

    setPanel(2, "Đang đọc phụ đề tiếng Anh...", true);
    currentState = "loading";
    jobRunning = true;
    refreshStatus();

    const videoId = videoIdFromUrl();
    try {
      const cached = await DUB.cache
        .get(cacheKeyParts(videoId))
        .catch(() => null);
      if (hasPlayableAudio(cached)) {
        setPanel(80, "Đang tải từ cache...", true);
        applyResult(cached);
        jobRunning = false;
        refreshStatus();
        return;
      }

      holdVideoForSynthesis();
      const cues = await site.getCues(video);
      if (!cues || !cues.length) {
        setPanel(
          0,
          (site && site.noCuesHint)
            || "Không tìm thấy phụ đề tiếng Anh cho bài này. Hãy bật CC trên player rồi thử lại.",
          true,
        );
        currentState = "error";
        resumeVideoAfterSynthesis();
        return;
      }

      const port = chrome.runtime.connect({ name: "dub-job" });
      port.onMessage.addListener((msg) => {
        if (msg.type === "PROGRESS") reportProgress(msg);
        else if (msg.type === "WINDOW") {
          try {
            applyWindow(msg);
          } catch (error) {
            warn("không dựng được cửa sổ audio:", error);
            setPanel(0, "Lỗi khi nhận audio: " + (error && error.message ? error.message : error), true);
            currentState = "error";
            resumeVideoAfterSynthesis();
            refreshStatus();
          }
        } else if (msg.type === "DONE") {
          DUB.cache
            .put(cacheKeyParts(videoId), {
              videoId,
              voice: settings.voice,
              planVersion: settings.planVersion,
              ...msg,
            })
            .catch((error) => console.warn("[LDUB] không lưu được cache:", error));
          reportTruncatedSentences(msg);
          finalizeFromDone(msg);
          jobRunning = false;
          refreshStatus();
          if (dubBtn) dubBtn.title = "Thuyết minh tiếng Việt";
        } else if (msg.type === "ERROR") {
          setPanel(0, "Lỗi: " + msg.message, true);
          currentState = "error";
          jobRunning = false;
          resumeVideoAfterSynthesis();
          refreshStatus();
        }
      });
      port.postMessage({
        type: "START",
        protocol: PROTOCOL_VERSION,
        videoId,
        durationSec: video.duration,
        cues,
      });
    } catch (e) {
      setPanel(0, "Lỗi: " + (e && e.message ? e.message : String(e)), true);
      currentState = "error";
      resumeVideoAfterSynthesis();
    }
  }

  /** Tiến độ job. */
  function reportProgress(msg) {
    const playing = currentState === "ready" && audioWindows.length > 0;
    const note = heldForSynthesis
      ? msg.note + " — video đang tạm dừng, tự chạy lại khi có tiếng"
      : msg.note;
    setPanel(msg.pct, note, !playing);
    refreshStatus();
    if (playing && dubBtn) {
      dubBtn.title = `Đang tổng hợp phần còn lại — ${Math.round(msg.pct)}%`;
    }
  }

  /** Bản ghi có audio phát được không. */
  function hasPlayableAudio(record) {
    if (!record) return false;
    if (record.audioBase64) return true;
    return Array.isArray(record.windows) && record.windows.some((win) => win && win.base64);
  }

  /** Bản ghi đầy đủ (từ cache, hoặc lúc job xong) */
  function applyResult(record) {
    reportTruncatedSentences(record);
    currentPlan = record.plan || null;
    currentTranslated = record.translated || null;
    currentSubtitles = record.subtitles;

    const windows = Array.isArray(record.windows) && record.windows.length
      ? record.windows
      : [{
        index: 0,
        startSec: 0,
        endSec: Infinity,
        base64: record.audioBase64,
        mime: record.audioMime,
        duckEnvelope: record.duckEnvelope,
      }];
    pauseAllWindows();
    for (const win of audioWindows) {
      releaseObjectUrl(win.el.src);
      win.el.remove();
    }
    audioWindows = [];
    activeWindow = null;

    for (const win of windows) addWindow(win);
    finishSetup();
  }

  /** Một cửa sổ vừa tổng hợp xong đã về — phát được ngay nếu là cửa sổ đầu. */
  function applyWindow(msg) {
    currentPlan = msg.plan || currentPlan;
    currentTranslated = msg.translated || currentTranslated;
    currentSubtitles = msg.subtitles || currentSubtitles;
    addWindow(msg.window);
    if (audioWindows.length === 1) finishSetup();
  }

  /** Lưới đỡ cuối */
  function finalizeFromDone(msg) {
    if (currentState === "ready" && audioWindows.length) return;
    const hasWindows = Array.isArray(msg.windows) && msg.windows.length;
    if (!hasWindows && !msg.audioBase64) {
      setPanel(
        0,
        "Server trả về job xong nhưng không có audio. Nhiều khả năng extension "
          + "và server lệch phiên bản — tải lại extension rồi F5 trang.",
        true,
      );
      currentState = "error";
      return;
    }
    warn("đường phát dần không chạy, dựng lại từ bản đầy đủ khi job xong");
    applyResult(msg);
  }

  /** Chuyển sang trạng thái "đang thuyết minh" khi đã có audio để phát. */
  function finishSetup() {
    if (currentState === "ready") return;
    currentState = "ready";
    setPanel(
      100,
      truncatedIds.size
        ? `Sẵn sàng — ${truncatedIds.size} câu bị cắt cho vừa khe thời gian.`
        : "Sẵn sàng — đã thuyết minh.",
      false,
    );
    setBtnLabel("Đang thuyết minh");
    dubBtn.classList.add("ldub-btn-active");
    refreshStatus();

    injectControls();
    startSync();
    setMode("dubbed");
    resumeVideoAfterSynthesis();
  }

  function addWindow(win) {
    const el = document.createElement("audio");
    el.className = "ldub-audio";
    el.preload = "auto";
    el.src = trackedObjectUrl(base64ToBlob(win.base64, win.mime || "audio/opus"));
    el.style.display = "none";
    try {
      el.preservesPitch = true;
      el.mozPreservesPitch = true;
      el.webkitPreservesPitch = true;
    } catch (e) {
    }
    document.body.appendChild(el);

    DUB.windows.insert(audioWindows, {
      startSec: Number(win.startSec) || 0,
      endSec: typeof win.endSec === "number" ? win.endSec : Infinity,
      el,
      duck: DUB.windows.decodeEnvelope(win.duckEnvelope),
    });
  }

  function windowAt(seconds) {
    return DUB.windows.pick(audioWindows, seconds);
  }

  /** Đổi cửa sổ đang phát */
  function useWindow(next) {
    if (next === activeWindow) return;
    if (activeWindow) activeWindow.el.pause();
    activeWindow = next;
    if (!activeWindow) return;
    activeWindow.el.playbackRate = video.playbackRate;
    activeWindow.el.volume = mode === "original" ? 0 : (settings.dubVolume ?? 1);
    syncActiveTime();
    if (!video.paused && mode !== "original") activeWindow.el.play().catch(() => {});
  }

  function syncActiveTime() {
    if (!activeWindow || !video) return;
    try {
      activeWindow.el.currentTime = DUB.windows.offsetIn(activeWindow, video.currentTime);
    } catch (e) {
    }
  }

  function pauseAllWindows() {
    for (const win of audioWindows) win.el.pause();
  }

  function hasDuckEnvelope() {
    return audioWindows.some((win) => win.duck);
  }

  function bedGainAt(seconds) {
    return DUB.windows.gainAt(activeWindow || windowAt(seconds), seconds);
  }

  function applyBedVolume() {
    if (!video || mode === "original") return;
    const bed = (settings.bedVolume ?? 1) * bedGainAt(video.currentTime);
    try {
      video.muted = bed <= 0.001;
      video.volume = Math.min(1, Math.max(0, bed));
    } catch (e) {
    }
  }

  function startDucking() {
    stopDucking();
    if (!hasDuckEnvelope()) return;
    duckTimer = setInterval(applyBedVolume, 50);
  }

  function stopDucking() {
    if (duckTimer) {
      clearInterval(duckTimer);
      duckTimer = null;
    }
  }

  /** Server cắt bớt câu nào không nhét vừa khe thì báo lại qua overflowSegmentIds. */
  function reportTruncatedSentences(record) {
    const cut = Array.isArray(record.overflowSegmentIds) ? record.overflowSegmentIds : [];
    truncatedIds = new Set(cut);
    if (!cut.length) return;
    console.warn(`[LDUB] ${cut.length} câu bị cắt cho vừa khe thời gian, id:`, cut);
  }

  /** Phát một câu mẫu rồi thu hồi blob ngay khi nghe xong. */
  function playAndRelease(blob) {
    const url = trackedObjectUrl(blob);
    const audio = new Audio(url);
    const release = () => releaseObjectUrl(url);
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener("error", release, { once: true });
    audio.play().catch(release);
  }

  function base64ToBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  const SYNC_DEADBAND_SEC = 0.04;
  const SYNC_HARD_SEC = 0.3;
  const SYNC_RATE_TRIM = 0.05;

  function hardResync() {
    if (!video || !audioWindows.length) return;
    useWindow(windowAt(video.currentTime));
    syncActiveTime();
  }

  function resumeIfPlaying() {
    if (!video || !activeWindow) return;
    if (!video.paused && mode !== "original") activeWindow.el.play().catch(() => {});
  }

  function startSync() {
    if (syncAbort) syncAbort.abort();
    syncAbort = new AbortController();
    const on = (target, ev, fn) =>
      target.addEventListener(ev, fn, { signal: syncAbort.signal });

    hardResync();
    applyVolumeForMode();

    on(video, "play", resumeIfPlaying);
    on(video, "pause", pauseAllWindows);
    on(video, "ratechange", () => {
      if (activeWindow) activeWindow.el.playbackRate = video.playbackRate;
    });

    on(video, "seeking", pauseAllWindows);
    on(video, "seeked", () => {
      hardResync();
      resumeIfPlaying();
    });

    on(video, "waiting", pauseAllWindows);
    on(video, "playing", () => {
      hardResync();
      resumeIfPlaying();
    });
    on(video, "ended", pauseAllWindows);

    if (syncTimer) clearInterval(syncTimer);
    syncTimer = setInterval(tickSync, 250);
  }

  function tickSync() {
    if (!video || !audioWindows.length) return;
    updateSubtitle();
    if (video.paused || video.seeking || mode === "original") return;

    const wanted = windowAt(video.currentTime);
    if (wanted !== activeWindow) {
      useWindow(wanted);
      return;
    }
    if (!activeWindow) return;

    const el = activeWindow.el;
    if (el.paused) {
      el.play().catch(() => {});
      return;
    }

    const drift = DUB.windows.offsetIn(activeWindow, video.currentTime) - el.currentTime;
    const base = video.playbackRate;

    if (Math.abs(drift) > SYNC_HARD_SEC) {
      syncActiveTime();
      el.playbackRate = base;
    } else if (Math.abs(drift) > SYNC_DEADBAND_SEC) {
      const trim = Math.max(
        -SYNC_RATE_TRIM,
        Math.min(SYNC_RATE_TRIM, drift * 0.5),
      );
      el.playbackRate = base * (1 + trim);
    } else if (el.playbackRate !== base) {
      el.playbackRate = base;
    }
  }

  function updateSubtitle() {
    const showVi = settings.subtitlesOn && mode !== "original";
    const showEn = settings.subtitlesEnOn && mode !== "original";
    if ((!showVi && !showEn) || !currentSubtitles) {
      subtitleEl.hidden = true;
      return;
    }
    const t = video.currentTime;
    const seg = currentSubtitles.find((s) => t >= s.start && t <= s.end);
    const vi = showVi && seg ? seg.vi : "";
    const en = showEn && seg ? seg.en : "";
    if (!vi && !en) {
      subtitleEl.hidden = true;
      return;
    }
    subtitleEl.innerHTML = "";
    const box = document.createElement("span");
    box.className = "ldub-sub-box";
    if (en) {
      const l = document.createElement("span");
      l.className = "ldub-sub-line ldub-sub-en";
      l.textContent = en;
      box.appendChild(l);
    }
    if (vi) {
      const l = document.createElement("span");
      l.className = "ldub-sub-line ldub-sub-vi";
      l.textContent = vi;
      box.appendChild(l);
    }
    subtitleEl.appendChild(box);
    subtitleEl.hidden = false;
  }

  function injectControls() {
    if (controlsEl) controlsEl.remove();
    controlsEl = document.createElement("div");
    controlsEl.className = "ldub-controls";
    controlsEl.hidden = true;
    controlsEl.innerHTML = `
      <div class="ldub-seg" role="radiogroup" aria-label="Chế độ phát">
        <label class="ldub-seg-opt"><input type="radio" name="ldub-mode" value="dubbed" checked><span>Thuyết minh</span></label>
        <label class="ldub-seg-opt"><input type="radio" name="ldub-mode" value="original"><span>Gốc</span></label>
      </div>
      <label class="ldub-row ldub-switch-row">
        <span>Phụ đề tiếng Việt</span>
        <span class="ldub-switch"><input type="checkbox" class="ldub-cc" ${settings.subtitlesOn ? "checked" : ""}><span class="ldub-switch-track"></span></span>
      </label>
      <div class="ldub-block">
        <div class="ldub-block-label">Giọng đọc</div>
        <span class="ldub-voice-pick">
          <select class="ldub-voice"></select>
          <button type="button" class="ldub-preview-btn" title="Nghe thử giọng này">${ICON_PLAY}</button>
        </span>
      </div>
      <div class="ldub-hint"></div>
    `;
    overlay.appendChild(controlsEl);
    populateVoiceSelect();

    controlsEl.querySelectorAll('input[name="ldub-mode"]').forEach((el) => {
      el.addEventListener("change", (e) => setMode(e.target.value));
    });
    controlsEl.querySelector(".ldub-cc").addEventListener("change", (e) => {
      settings.subtitlesOn = e.target.checked;
      saveSettings({ subtitlesOn: settings.subtitlesOn });
      updateSubtitle();
    });
    controlsEl
      .querySelector(".ldub-voice")
      .addEventListener("change", (e) => onVoiceChange(e.target.value));
    controlsEl
      .querySelector(".ldub-preview-btn")
      .addEventListener("click", onPreviewVoiceClick);
  }

  async function onPreviewVoiceClick(e) {
    const btn = e.currentTarget;
    const hint = controlsEl.querySelector(".ldub-hint");
    const voice = controlsEl.querySelector(".ldub-voice").value;

    const cached = previewAudioCache.get(voice);
    if (cached) {
      playAndRelease(base64ToBlob(cached.base64, cached.mime));
      hint.textContent = "Đang phát (đã nhớ từ lần trước).";
      return;
    }

    btn.disabled = true;
    hint.textContent = "Đang tổng hợp câu mẫu...";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "TTS_PREVIEW_LOCAL",
        voice,
        timeoutMs: 30000,
        text: "Xin chào, đây là giọng đọc thử cho video bài giảng tiếng Việt.",
      });
      if (!res.ok) {
        hint.textContent = "Lỗi nghe thử: " + res.error;
        return;
      }
      previewAudioCache.set(voice, { base64: res.base64, mime: res.mime });
      playAndRelease(base64ToBlob(res.base64, res.mime || "audio/wav"));
      hint.textContent = "Đang phát...";
    } finally {
      btn.disabled = false;
    }
  }

  /** Danh sách giọng lấy động từ TTS server (GET /api/voices) — không đoán tên. */
  async function populateVoiceSelect() {
    const sel = controlsEl.querySelector(".ldub-voice");
    const hint = controlsEl.querySelector(".ldub-hint");
    if (!voicesCache) {
      sel.innerHTML = "<option>Đang tải danh sách giọng...</option>";
      sel.disabled = true;
      const res = await chrome.runtime.sendMessage({
        type: "FETCH_TTS_VOICES",
        timeoutMs: 15000,
      });
      if (!res.ok) {
        sel.innerHTML = "<option>Không tải được danh sách giọng</option>";
        hint.textContent = "Lỗi: " + res.error;
        return;
      }
      voicesCache = res.voices;
    }
    sel.disabled = false;
    sel.innerHTML = "";
    voicesCache.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label || v.id;
      sel.appendChild(opt);
    });
    if (settings.voice && voicesCache.some((v) => v.id === settings.voice))
      sel.value = settings.voice;
    else if (sel.options.length) {
      settings.voice = sel.value;
      saveSettings({ voice: settings.voice });
    }
    hint.textContent =
      "Đổi giọng sẽ tổng hợp lại (không tốn lượt gọi API dịch).";
  }

  function toggleControls() {
    if (controlsEl) {
      controlsEl.hidden = !controlsEl.hidden;
      positionOverlay();
    }
  }

  function setMode(next) {
    mode = next;
    applyVolumeForMode();
    if (mode === "original") {
      pauseAllWindows();
    } else {
      useWindow(windowAt(video.currentTime));
      syncActiveTime();
      if (!video.paused && activeWindow) activeWindow.el.play().catch(() => {});
    }
    updateSubtitle();
  }

  function applyVolumeForMode() {
    if (mode === "original") {
      stopDucking();
      resetVideoVolume();
      for (const win of audioWindows) win.el.volume = 0;
      return;
    }
    for (const win of audioWindows) win.el.volume = settings.dubVolume ?? 1;
    if (hasDuckEnvelope() && (settings.bedVolume ?? 1) > 0) {
      applyBedVolume();
      startDucking();
    } else {
      stopDucking();
      video.muted = true;
    }
  }

  async function onVoiceChange(voice) {
    settings.voice = voice;
    saveSettings({ voice });
    if (!currentPlan || !currentTranslated) return;

    setPanel(5, "Đang đổi giọng...", true);
    holdVideoForSynthesis();
    const videoId = videoIdFromUrl();
    const port = chrome.runtime.connect({ name: "dub-job" });
    let replaced = false;
    port.onMessage.addListener((msg) => {
      if (msg.type === "PROGRESS") reportProgress(msg);
      else if (msg.type === "WINDOW") {
        if (!replaced) {
          replaced = true;
          pauseAllWindows();
          for (const win of audioWindows) {
            releaseObjectUrl(win.el.src);
            win.el.remove();
          }
          audioWindows = [];
          activeWindow = null;
          currentState = "loading";
        }
        applyWindow(msg);
      } else if (msg.type === "DONE") {
        if (!replaced) finalizeFromDone(msg);
        DUB.cache
          .put(cacheKeyParts(videoId, voice), {
            videoId,
            voice,
            planVersion: settings.planVersion,
            plan: msg.plan,
            translated: msg.translated,
            subtitles: msg.subtitles,
            windows: msg.windows,
          })
          .catch((error) => console.warn("[LDUB] không lưu được cache:", error));
      } else if (msg.type === "ERROR") {
        setPanel(0, "Lỗi đổi giọng: " + msg.message, true);
        resumeVideoAfterSynthesis();
      }
    });
    port.postMessage({
      type: "RESYNTH",
      protocol: PROTOCOL_VERSION,
      plan: currentPlan,
      translated: currentTranslated,
      voice,
    });
  }

  watchNavigation();
  init();
})();
