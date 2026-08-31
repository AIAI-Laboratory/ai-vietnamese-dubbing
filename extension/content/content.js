/**
 * Content script — chạy trên trang video được lib/sites.js hỗ trợ (Coursera,
 * YouTube). Mọi chi tiết riêng của từng trang nằm trong adapter đó, file này
 * chỉ dùng interface chung.
 *
 * Luồng: bấm nút Dub -> đọc phụ đề tiếng Anh (adapter) -> kiểm tra cache
 * (lib/cache.js) -> nếu chưa có, mở Port tới service worker (background.js)
 * chạy job dịch qua Gemini API + tổng hợp giọng (TTS server local, server/) ->
 * nhận về MỘT file audio dài bằng video -> phát bằng thẻ <audio> neo cứng
 * currentTime = video.currentTime. Tua/pause/đổi tốc độ chỉ là một phép gán,
 * luôn đúng ngay lập tức dù tua tới đâu, không cần buffer.
 */
(function () {
  // Content script chạy ở isolated world: muốn thấy cảnh báo này trong
  // DevTools thì chọn context của extension ở dropdown "top".
  const warn = (...args) => console.warn("[LDUB]", ...args);

  // Phải khớp PROTOCOL_VERSION trong background.js. Tải lại extension không
  // thay content script trong tab đang mở, nên số này là cách duy nhất để
  // phát hiện bản cũ đang chạy — xem chi tiết ở background.js.
  const PROTOCOL_VERSION = 2;
  console.log(`[LDUB] content script v${PROTOCOL_VERSION} đã nạp`);

  // SVG nhúng thẳng (không dùng sprite <symbol> dùng chung như trang Cài đặt)
  // — tiêm sprite id cố định vào DOM của Coursera dễ đụng id trùng với chính
  // trang đó. Nguồn: Lucide (MIT, github.com/lucide-icons/lucide), giữ
  // nguyên path gốc. stroke="currentColor" ăn theo màu chữ nút.
  const ICON_MIC =
    '<svg class="ldub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>';
  const ICON_PLAY =
    '<svg class="ldub-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>';

  const DEFAULT_SETTINGS = {
    subtitlesOn: false, // chỉ nghe, không hiện phụ đề — bật lại ở popup icon extension
    subtitlesEnOn: true, // phụ đề tiếng Anh (gốc) — bật mặc định cùng tiếng Việt
    // Mặc định theo chuẩn Netflix/BBC: chữ trắng nền đen bán trong suốt
    // (tương phản trắng/đen ~21:1, vượt xa mức tối thiểu WCAG 4.5:1), đặt
    // dưới video, cỡ vừa. Đổi trong popup icon extension.
    subtitlePosition: "bottom", // 'bottom' | 'top'
    subtitleSize: "medium", // 'small' | 'medium' | 'large'
    subtitleColor: "white-black", // 'white-black' | 'yellow-black' | 'black-white' — 3 preset của Netflix
    // Lệch tay do người dùng KÉO phụ đề tới vị trí họ muốn — cộng thêm vào vị
    // trí mặc định tính từ subtitlePosition, không thay thế nó (đổi preset
    // Trên/Dưới thì lệch tay vẫn giữ nguyên, tính từ mốc mới).
    subtitleOffsetX: 0,
    subtitleOffsetY: 0,
    dubVolume: 1.0,
    // Hệ số nhân lên đường bao ducking do server tính: 1.0 = giữ nhạc nền
    // và tiếng động của video ở mức server đề xuất, 0 = mute hẳn như bản cũ.
    bedVolume: 1.0,
    serverUrl: "http://127.0.0.1:18765",
    serverApiKey: "",
    voice: "",
    viSyllablesPerSec: 3.8,
    planVersion: "kokoro-v11",
  };

  // % chiều cao video — theo nghiên cứu ngành (phụ đề chuyên nghiệp ~7-10%
  // chiều cao khung hình ở khoảng cách xem TV); hạ xuống một chút cho màn
  // hình laptop xem gần. "medium" khớp cỡ chữ mặc định cũ (18px trên video
  // ~430px cao, để không đổi cảm giác quen thuộc cho người đã dùng trước đó).
  const SUBTITLE_SIZE_PCT = { small: 0.032, medium: 0.042, large: 0.056 };

  let video = null;
  let overlay = null;
  let dubBtn = null;
  let dockObserver = null;
  let dockRetryTimer = null;
  // Audio đến theo cửa sổ ~30s, mỗi cửa sổ một thẻ <audio> phủ đúng đoạn
  // [startSec, endSec) của video. Nghe được ngay khi cửa sổ đầu về, phần còn
  // lại tổng hợp trong lúc đang phát.
  let audioWindows = [];
  let activeWindow = null;
  let subtitleEl = null;
  let controlsEl = null;
  let currentState = "idle"; // idle | loading | ready | error
  let currentPlan = null;
  let currentTranslated = null;
  let currentSubtitles = null;
  let syncTimer = null;
  let syncAbort = null; // gỡ listener của lần dub trước (xem startSync)
  let mode = "dubbed"; // dubbed | original
  let settings = { ...DEFAULT_SETTINGS };
  let voicesCache = null;
  let truncatedIds = new Set(); // id câu server phải cắt bớt cho vừa khe
  let duckTimer = null;
  // Object URL sống theo vòng đời document chứ không theo phần tử: gỡ thẻ
  // <audio> KHÔNG giải phóng blob. Không thu hồi tay thì mỗi lần lồng tiếng,
  // đổi giọng hay điều hướng SPA để lại 5-15 MB trong tab tới khi đóng tab.
  const liveObjectUrls = new Set();

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
  const previewAudioCache = new Map(); // voice -> {base64, mime} — nghe lại không tổng hợp lại

  // Adapter của trang đang mở. KHÔNG chốt một lần lúc nạp: content script chỉ
  // được Chrome tiêm khi tải trang, còn YouTube/Coursera điều hướng kiểu SPA —
  // vào trang chủ rồi bấm vào video thì URL đổi mà script vẫn là script cũ.
  // Vì vậy manifest khớp cả site, và adapter được tính lại mỗi lần URL đổi.
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

  // -------------------------------------------------------------------------
  // Tìm video + theo dõi điều hướng SPA (Coursera lẫn YouTube không phát sự
  // kiện điều hướng công khai nên poll URL nhẹ nhàng mỗi giây).
  // -------------------------------------------------------------------------

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
    if (dubBtn) {
      dubBtn.remove();
      dubBtn = null;
    }
    if (overlay) {
      overlay.remove();
      overlay = null;
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
      /* video có thể đã bị gỡ khỏi DOM */
    }
  }

  // Khởi tạo bằng URL hiện tại: để rỗng thì tick đầu tiên tưởng là vừa đổi
  // trang và dọn sạch overlay vừa gắn xong.
  let lastPath = location.pathname + location.search;
  let navTimer = null;
  let orphaned = false;

  /**
   * Reload extension trong lúc trang đang mở sẽ để lại content script này
   * "mồ côi": chrome.runtime của nó không còn dùng được nữa. Không nhận ra
   * thì vòng lặp dưới đây gọi sendMessage mỗi giây và ném "Extension context
   * invalidated" mãi mãi.
   */
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
      // Trang là SPA — <video> có thể render SAU thời điểm content script
      // chạy (document_idle), nên phải thử lại đều đặn, không chỉ khi URL
      // đổi. Đổi URL thì dọn dẹp overlay/audio cũ trước khi thử lại.
      // YouTube giữ nguyên /watch khi đổi video, chỉ ?v= đổi — so cả query.
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
    if (!site) return; // refreshSite đã log lý do

    const v = findVideo();
    if (!v || v === video) return; // chưa có video, hoặc đã gắn overlay cho đúng video này rồi
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

  // -------------------------------------------------------------------------
  // UI nổi trên video — dùng position:fixed tính theo getBoundingClientRect
  // của video, KHÔNG chèn vào cây DOM của Coursera để tránh phá layout player.
  // -------------------------------------------------------------------------

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
    document.body.appendChild(dubBtn); // vị trí nổi mặc định/dự phòng — xem tryDockToControlBar()

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

  // -------------------------------------------------------------------------
  // Gắn nút vào thanh điều khiển thật của trình phát (cạnh nút tốc độ "1x"/
  // "2x"...), theo đúng vị trí người dùng chỉ định — thay vì nổi rời trên
  // video. RỦI RO THẬT: thanh điều khiển này gần như chắc chắn do framework
  // (React) tự vẽ lại (timestamp nhảy mỗi giây), có thể TỰ XOÁ node của mình
  // ở lần vẽ lại kế tiếp vì nó không nằm trong cây mà framework quản lý.
  //
  // Selector neo do adapter của từng trang cung cấp (lib/sites.js) — ưu tiên
  // aria-label/class ổn định thay vì tên class do build tool sinh ra, thứ đổi
  // sau mỗi lần trang deploy lại.
  //
  // Thất bại (không tìm thấy, hoặc bị xoá liên tục) thì tự rơi về vị trí nổi
  // sẵn có (đã kiểm chứng hoạt động) — không bao giờ để mất nút hẳn.
  // -------------------------------------------------------------------------

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
      // Phải nằm gần video (dưới hoặc ngang mép dưới) — tránh bắt nhầm "2x"
      // xuất hiện ở chỗ khác trên trang.
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

      row.appendChild(dubBtn); // cuối hàng — ngoài cùng bên phải, sau nút Toàn màn hình
      dubBtn.classList.remove("ldub-btn-floating");
      dubBtn.classList.add("ldub-btn-docked");
      dubBtn.style.position = ""; // bỏ fixed — chạy theo flow thật của thanh điều khiển
      dubBtn.style.top = dubBtn.style.left = dubBtn.style.bottom = "";
      positionOverlay(); // panel bám theo vị trí mới của nút

      if (dockObserver) dockObserver.disconnect();
      dockObserver = new MutationObserver(() => {
        if (!row.contains(dubBtn)) tryDockToControlBar(); // bị framework vẽ lại đè mất — gắn lại ngay
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
    // Thanh điều khiển có thể chưa render xong lúc nút Dub được gắn
    // (document_idle chạy sớm hơn React thuỷ hợp). Thử lại vài lần trong vài
    // giây đầu rồi bỏ cuộc, giữ vị trí nổi — không thử vô hạn, tránh tốn CPU
    // nếu trang đổi hẳn cấu trúc UI khác.
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
      // Vị trí nổi (mặc định/dự phòng khi không gắn được vào thanh điều
      // khiển): neo gần đáy-phải video, sát khu vực thanh điều khiển/tua của
      // trình phát thay vì góc trên (trước đây đụng nút "Download this
      // video" của Coursera).
      const btnClearance = Math.max(64, r.height * 0.11);
      dubBtn.style.position = "fixed";
      dubBtn.style.top = "auto";
      dubBtn.style.bottom =
        Math.round(window.innerHeight - r.bottom + btnClearance) + "px";
      dubBtn.style.left = r.left + r.width - dubBtn.offsetWidth - 12 + "px";
    }
    // Panel luôn bám theo vị trí THẬT của nút (đọc getBoundingClientRect trực
    // tiếp) — đúng cả khi nút đang nổi lẫn khi đã gắn trong thanh điều khiển.
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

      // "bottom" neo từ đáy video đi lên — box cao thêm khi bật cả 2 dòng
      // Anh+Việt vẫn tự đẩy lên đúng, không cần đoán chiều cao box trước.
      // Clearance co giãn theo cỡ video: người dùng Coursera từng thấy phụ
      // đề đè lên thanh điều khiển của trình phát ở mức cố định 64px — nới
      // rộng + cho đổi sang "Trên" trong popup, hoặc tự KÉO ô phụ đề, nếu
      // skin trình phát khác vẫn còn che (không có DOM Coursera thật để
      // test hết mọi trường hợp).
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
      // Lệch tay do người dùng tự kéo — cộng thêm vào vị trí mặc định vừa
      // tính, không đụng top/bottom ở trên (transform không ảnh hưởng layout
      // nên video/scroll đổi kích thước vẫn tính lại đúng gốc trước khi cộng lệch).
      subtitleEl.style.transform = `translate(${settings.subtitleOffsetX || 0}px, ${settings.subtitleOffsetY || 0}px)`;
    }
  }

  // ------------------------------------------------------------------------
  // Kéo phụ đề tới vị trí muốn — không phải mọi giao diện Coursera đều đoán
  // đúng bằng preset Trên/Dưới, nên cho tự kéo là chắc chắn nhất. Nhấp đúp
  // để đặt lại vị trí mặc định.
  // ------------------------------------------------------------------------
  let subtitleDrag = null; // {startX, startY, startOffX, startOffY} khi đang kéo

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

  /** Nút chỉ còn icon (xem .ldub-btn trong CSS) — text vẫn cập nhật trong DOM
   * (đọc được bằng screen reader) và làm title, hiện khi rê chuột vào. */
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
    positionOverlay(); // panel đổi kích thước có thể làm overlay lệch khỏi mép phải video
  }

  // -------------------------------------------------------------------------
  // Cache: nếu bài này đã thuyết minh trước đó (đúng giọng), dùng lại ngay,
  // không gọi lại API dịch / TTS server.
  // -------------------------------------------------------------------------

  async function tryLoadFromCache() {
    try {
      const rec = await DUB.cache.get(cacheKeyParts(videoIdFromUrl()));
      if (rec && rec.audioBase64) {
        setBtnLabel("Xem lại bản đã thuyết minh");
      }
    } catch (e) {
      /* IndexedDB có thể bị chặn (chế độ ẩn danh) — bỏ qua, không chặn luồng chính */
    }
  }

  // -------------------------------------------------------------------------
  // Bấm nút Dub
  // -------------------------------------------------------------------------

  async function onDubClick() {
    if (currentState === "ready") {
      toggleControls();
      return;
    }
    if (currentState === "loading") return;

    // Livestream cho duration = Infinity, video chưa nạp xong cho NaN. Server
    // sẽ từ chối (durationSec phải hữu hạn, <= 6 giờ) NHƯNG chỉ ở bước cuối,
    // sau khi đã trả tiền cho toàn bộ phần dịch.
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

    const videoId = videoIdFromUrl();
    try {
      const cached = await DUB.cache
        .get(cacheKeyParts(videoId))
        .catch(() => null);
      if (cached && cached.audioBase64) {
        setPanel(80, "Đang tải từ cache...", true);
        applyResult(cached);
        return;
      }

      const cues = await site.getCues(video);
      if (!cues || !cues.length) {
        setPanel(
          0,
          (site && site.noCuesHint)
            || "Không tìm thấy phụ đề tiếng Anh cho bài này. Hãy bật CC trên player rồi thử lại.",
          true,
        );
        currentState = "error";
        return;
      }

      const port = chrome.runtime.connect({ name: "dub-job" });
      port.onMessage.addListener((msg) => {
        if (msg.type === "PROGRESS") reportProgress(msg);
        else if (msg.type === "WINDOW") {
          try {
            applyWindow(msg);
          } catch (error) {
            // Hỏng ở đây mà nuốt lỗi thì panel đứng im ở tiến độ cuối cùng,
            // trông như treo. DONE bên dưới vẫn là lưới đỡ, nhưng phải biết.
            warn("không dựng được cửa sổ audio:", error);
            setPanel(0, "Lỗi khi nhận audio: " + (error && error.message ? error.message : error), true);
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
        } else if (msg.type === "ERROR") {
          setPanel(0, "Lỗi: " + msg.message, true);
          currentState = "error";
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
    }
  }

  /**
   * Tiến độ job. Khi đã phát được rồi thì KHÔNG mở lại bảng: phần còn lại
   * vẫn đang tổng hợp trong nền, nhưng người xem đang nghe rồi nên bảng tiến
   * độ che video chẳng để làm gì — trước đây nó bật lại mỗi 700ms và nằm lì
   * ở đó tới hết job.
   */
  function reportProgress(msg) {
    const playing = currentState === "ready" && audioWindows.length > 0;
    setPanel(msg.pct, msg.note, !playing);
    if (playing && dubBtn) {
      dubBtn.title = msg.pct >= 99
        ? "Thuyết minh tiếng Việt"
        : `Đang tổng hợp phần còn lại — ${Math.round(msg.pct)}%`;
    }
  }

  /** Bản ghi đầy đủ (từ cache, hoặc lúc job xong): dựng lại mọi cửa sổ. */
  function applyResult(record) {
    reportTruncatedSentences(record);
    currentPlan = record.plan || null;
    currentTranslated = record.translated || null;
    currentSubtitles = record.subtitles;

    const windows = Array.isArray(record.windows) && record.windows.length
      ? record.windows
      // Bản cũ trong cache là một file duy nhất phủ cả video.
      : [{
        index: 0,
        startSec: 0,
        endSec: Infinity,
        base64: record.audioBase64,
        mime: record.audioMime,
        duckEnvelope: record.duckEnvelope,
      }];
    // Dựng lại từ đầu: bỏ mọi cửa sổ đang có để không nhân đôi khi lưới đỡ
    // DONE chạy sau khi vài cửa sổ đã về.
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

  /**
   * Lưới đỡ cuối: DONE mang đủ mọi cửa sổ. Nếu đường phát dần không chạy
   * (message WINDOW lỗi, hoặc extension và server lệch phiên bản) thì dựng
   * lại từ đây thay vì để panel đứng im ở tiến độ cuối.
   */
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

    injectControls();
    startSync();
    setMode("dubbed");
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
      /* trình duyệt cũ không hỗ trợ, chấp nhận đổi cao độ khi đổi tốc độ */
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

  /** Đổi cửa sổ đang phát: dừng cái cũ, đặt đúng vị trí cho cái mới. */
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
      // Neo tuyệt đối: vị trí trong cửa sổ = thời điểm video trừ mốc bắt đầu.
      activeWindow.el.currentTime = DUB.windows.offsetIn(activeWindow, video.currentTime);
    } catch (e) {
      /* audio chưa sẵn sàng nhận currentTime — vòng sync 250ms sẽ chỉnh lại */
    }
  }

  function pauseAllWindows() {
    for (const win of audioWindows) win.el.pause();
  }

  // -------------------------------------------------------------------------
  // Ducking: hạ âm lượng video gốc theo đường bao thay vì mute hẳn, nên nhạc
  // nền và tiếng động vẫn nghe được dưới giọng thuyết minh. Chỉ đổi độ lợi
  // qua video.volume — KHÔNG dùng Web Audio createMediaElementSource, node đó
  // chiếm quyền định tuyến audio của player và tắt tiếng hẳn nếu media bị
  // tainted CORS.
  // -------------------------------------------------------------------------

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
      /* video có thể vừa bị gỡ khỏi DOM */
    }
  }

  function startDucking() {
    stopDucking();
    if (!hasDuckEnvelope()) return;
    // 50 ms một bước: bước độ lợi đủ nhỏ để không nghe ra tiếng rít khi đổi.
    duckTimer = setInterval(applyBedVolume, 50);
  }

  function stopDucking() {
    if (duckTimer) {
      clearInterval(duckTimer);
      duckTimer = null;
    }
  }

  /**
   * Server cắt bớt câu nào không nhét vừa khe thì báo lại qua
   * overflowSegmentIds. Không hiện ra thì người dùng nghe câu cụt mà tưởng
   * bản dịch vốn thế.
   */
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

  // -------------------------------------------------------------------------
  // Đồng bộ — neo cứng: gán currentTime theo video, không cộng dồn thời
  // lượng segment nào cả nên tua tới đâu cũng đúng ngay, không cần buffer.
  // -------------------------------------------------------------------------

  // Lệch dưới ngưỡng này coi như khớp — không chỉnh gì, tránh rung liên tục.
  const SYNC_DEADBAND_SEC = 0.04;
  // Lệch trên ngưỡng này mới tua cứng (nghe rõ chỗ cắt). Dưới nó chỉnh bằng
  // playbackRate để tai không nhận ra.
  const SYNC_HARD_SEC = 0.3;
  // Biên chỉnh tốc độ mềm. 5% với preservesPitch=true là không nghe ra.
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
    // startSync() chạy lại mỗi lần đổi giọng. Không gỡ listener cũ thì handler
    // chồng lên nhau, mỗi sự kiện tua chạy nhiều lần và audio bị giật.
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

    // Tua: DỪNG audio trước rồi mới nhảy, và chỉ phát lại ở 'seeked' khi video
    // đã chốt vị trí cuối. Để audio chạy tiếp trong lúc video còn đang seek thì
    // nó đọc trước hình rồi bị kéo giật ngược — đúng cảm giác "tua không mượt".
    on(video, "seeking", pauseAllWindows);
    on(video, "seeked", () => {
      hardResync();
      resumeIfPlaying();
    });

    // Video buffer giữa chừng — im lặng chờ thay vì đọc tiếp một mình.
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

    // Qua ranh giới cửa sổ (hoặc vừa tua tới đoạn đã tổng hợp xong) thì đổi
    // thẻ audio trước, tick sau mới chỉnh trôi.
    const wanted = windowAt(video.currentTime);
    if (wanted !== activeWindow) {
      useWindow(wanted);
      return;
    }
    // Chưa có cửa sổ nào phủ mốc này: phần đó còn đang tổng hợp.
    if (!activeWindow) return;

    const el = activeWindow.el;
    // Lưới an toàn: 'waiting' đã pause audio nhưng 'playing' không phải lúc nào
    // cũng bắn (đổi tab, player tự phục hồi) — tự phát lại thay vì đứng im.
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
      // Kéo audio về đúng chỗ bằng cách đi nhanh/chậm hơn vài phần trăm thay vì
      // tua cứng — không cắt tiếng giữa câu.
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
    // Tiếng Anh (gốc) nhỏ hơn, mờ hơn — phụ, đọc lướt qua. Tiếng Việt
    // (bản dịch, mục đích chính của extension) đậm và to hơn.
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

  // -------------------------------------------------------------------------
  // Bảng điều khiển: Gốc / Thuyết minh, phụ đề, âm lượng, đổi giọng.
  // -------------------------------------------------------------------------

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

    // Chỉ đổi trạng thái disabled/mờ đi khi đang chờ — giữ nguyên icon SVG
    // bên trong nút (không đụng innerHTML/textContent của nút này).
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

  // Hai chế độ: Gốc (mute thuyết minh, trả âm video về nguyên) hoặc Thuyết
  // minh. Ở chế độ Thuyết minh, video gốc được hạ theo đường bao ducking để
  // giữ nhạc nền; không có đường bao (bản cũ trong cache, hoặc người dùng đặt
  // bedVolume = 0) thì mute hẳn như trước.
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
    const videoId = videoIdFromUrl();
    const port = chrome.runtime.connect({ name: "dub-job" });
    // Giọng mới thay hẳn audio cũ: bỏ mọi cửa sổ đang có rồi nhận cửa sổ mới
    // theo đúng cơ chế phát dần như lần lồng tiếng đầu.
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
        if (!replaced) finalizeFromDone(msg); // không cửa sổ nào tới được
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

  // -------------------------------------------------------------------------

  watchNavigation();
  init();
})();
