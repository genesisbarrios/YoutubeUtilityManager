(function () {
  const $ = (id) => document.getElementById(id);
  const state = { info: null, mode: "video", height: "best", audioFormat: "mp3", jobId: null, es: null };

  const fmtDuration = (s) => {
    if (!s && s !== 0) return "";
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
  };
  const fmtBytes = (b) => {
    if (!b) return "";
    const u = ["B", "KB", "MB", "GB"]; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(b >= 100 || i === 0 ? 0 : 1) + " " + u[i];
  };
  const showError = (msg) => { $("formError").textContent = msg; $("formError").hidden = !msg; };

  async function api(path, opts) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed (" + res.status + ")");
    return data;
  }

  // Dependency check
  api("/api/health").then(({ deps }) => {
    const missing = Object.keys(deps).filter((k) => !deps[k]);
    if (missing.length) {
      $("depsWarning").textContent = "Missing on the server: " + missing.join(", ") + ". Run: brew install yt-dlp ffmpeg";
      $("depsWarning").hidden = false;
    }
  }).catch(() => {});

  $("urlForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    showError("");
    const btn = $("fetchBtn");
    btn.disabled = true; btn.textContent = "Loading…";
    try {
      const info = await api("/api/info", { method: "POST", body: JSON.stringify({ url: $("url").value }) });
      if (info.isLive) throw new Error("Live streams aren't supported.");
      state.info = info;
      renderInfo(info);
    } catch (err) {
      showError(err.message);
      $("result").hidden = true;
    } finally {
      btn.disabled = false; btn.textContent = "Get options";
    }
  });

  function renderInfo(info) {
    $("thumb").src = info.thumbnail || "";
    $("title").textContent = info.title;
    $("channel").textContent = info.channel || "";
    $("duration").textContent = fmtDuration(info.duration);

    const q = $("qualities");
    q.innerHTML = "";
    const best = info.qualities[0];
    const items = [{ value: "best", label: "Best" + (best ? " (" + best.label + ")" : ""), bytes: best && best.approxBytes }]
      .concat(info.qualities.map((x) => ({ value: String(x.height), label: x.label, bytes: x.approxBytes })));
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (i === 0 ? " active" : "");
      b.dataset.value = it.value;
      b.dataset.bytes = it.bytes || "";
      b.innerHTML = "<span></span>" + (it.bytes ? "<small></small>" : "");
      b.firstChild.textContent = it.label;
      q.appendChild(b);
    });
    state.height = "best";
    initClip(info);
    resetProgress();
    $("result").hidden = false;
    $("result").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Chip groups
  function chipGroup(containerId, key, after) {
    $(containerId).addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      $(containerId).querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
      state[key] = chip.dataset.value;
      after && after();
    });
  }
  chipGroup("qualities", "height");
  chipGroup("audioFormats", "audioFormat", updateAudioHint);

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    state.mode = t.dataset.mode;
    $("videoOpts").hidden = state.mode !== "video";
    $("audioOpts").hidden = state.mode !== "audio";
    $("preciseWrap").hidden = state.mode !== "video";
  }));

  function updateEncodingHint() {
    const enc = $("encoding").value;
    // Re-encoded output is H.264/AAC, which fits MP4 or MOV only.
    [...$("container").options].forEach((o) => { o.disabled = enc !== "original" && !["mp4", "mov"].includes(o.value); });
    if (enc !== "original" && !["mp4", "mov"].includes($("container").value)) $("container").value = "mp4";
    $("encodingHint").textContent = {
      original: "Exact streams from YouTube. 1440p and up are VP9/AV1. If QuickTime won't play the file, use VLC or pick H.264.",
      h264: "Downloads H.264 directly when YouTube has it (≤1080p). Higher resolutions get re-encoded, which takes longer.",
      compressed: "Re-encodes to H.264 at CRF 28. Much smaller files with a small quality trade-off. Takes a while for long or 4K videos.",
    }[enc] + ($("container").value === "mov" && enc === "original"
      ? " MOV (QuickTime/Final Cut): up to 1080p is a lossless copy; above 1080p the video is converted to H.264, which takes longer."
      : "");
  }
  $("encoding").addEventListener("change", updateEncodingHint);
  $("container").addEventListener("change", updateEncodingHint);
  updateEncodingHint();

  function updateAudioHint() {
    const f = state.audioFormat;
    const lossy = ["mp3", "m4a", "opus"].includes(f);
    $("bitrate").disabled = !lossy;
    $("audioHint").textContent = {
      mp3: "Most compatible. Album art and metadata are embedded.",
      m4a: "AAC in M4A. Great for Apple devices.",
      opus: "Best quality per bit. YouTube's native audio codec.",
      flac: "Lossless container. Note that YouTube's source audio is already lossy (~128–160 kbps Opus/AAC).",
      wav: "Uncompressed PCM, handy for DAWs and editing.",
      best: "Saves YouTube's original audio stream as-is, with no conversion.",
    }[f];
  }
  updateAudioHint();

  // Download job
  $("downloadBtn").addEventListener("click", async () => {
    if (!state.info) return;
    showError("");
    const body = state.mode === "video"
      ? { url: state.info.url, mode: "video", height: state.height, encoding: $("encoding").value, container: $("container").value }
      : { url: state.info.url, mode: "audio", audioFormat: state.audioFormat, audioBitrate: $("bitrate").value };
    if ($("clipToggle").checked) {
      const c = readClip();
      if (c.error) { $("clipError").textContent = c.error; $("clipError").hidden = false; return; }
      body.start = c.start;
      if (c.end < state.info.duration) body.end = c.end;
      if (state.mode === "video") body.preciseCut = $("preciseCut").checked;
    }
    $("downloadBtn").disabled = true;
    try {
      const { id } = await api("/api/jobs", { method: "POST", body: JSON.stringify(body) });
      state.jobId = id;
      watchJob(id);
    } catch (err) {
      showError(err.message);
      $("downloadBtn").disabled = false;
    }
  });

  function resetProgress() {
    if (state.es) state.es.close();
    $("progress").hidden = true;
    $("progress").classList.remove("done", "failed");
    $("saveBtn").hidden = true;
    $("cancelBtn").hidden = false;
    $("downloadBtn").disabled = false;
    $("barFill").style.width = "0%";
  }

  function watchJob(id) {
    resetProgress();
    $("downloadBtn").disabled = true;
    $("progress").hidden = false;
    const es = new EventSource("/api/jobs/" + id + "/events");
    state.es = es;
    es.onmessage = (ev) => {
      const s = JSON.parse(ev.data);
      $("stage").textContent = s.status === "error" ? (s.error || "Failed") : s.stage;
      $("pct").textContent = Math.floor(s.percent || 0) + "%";
      $("barFill").style.width = (s.percent || 0) + "%";
      $("speed").textContent = s.speed ? fmtBytes(s.speed) + "/s" : "";
      $("eta").textContent = s.eta ? "ETA " + fmtDuration(s.eta) : "";
      if (s.status === "done") {
        es.close();
        $("progress").classList.add("done");
        $("stage").textContent = "Ready · " + s.filename + (s.size ? " (" + fmtBytes(s.size) + ")" : "");
        $("pct").textContent = "100%";
        $("cancelBtn").hidden = true;
        const href = "/api/jobs/" + id + "/file";
        $("saveBtn").href = href;
        $("saveBtn").hidden = false;
        $("downloadBtn").disabled = false;
        window.location.href = href; // trigger the browser download
      } else if (s.status === "error") {
        es.close();
        $("progress").classList.add("failed");
        $("cancelBtn").hidden = true;
        $("downloadBtn").disabled = false;
      }
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }

  // ---------- Section / duration selection ----------
  const clipEls = { s: $("rangeStart"), e: $("rangeEnd") };

  // "83", "1:23", "1:02:03" -> seconds (NaN if invalid, null if empty)
  function parseTime(v) {
    v = String(v).trim();
    if (!v) return null;
    const parts = v.split(":").map(Number);
    if (parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
    return parts.reduce((a, n) => a * 60 + n, 0);
  }

  function initClip(info) {
    const d = Math.max(1, Math.floor(info.duration || 0));
    [clipEls.s, clipEls.e].forEach((r) => { r.max = d; });
    clipEls.s.value = 0;
    clipEls.e.value = d;
    $("startTime").value = "0:00";
    $("endTime").value = fmtDuration(d);
    $("clipToggle").checked = false;
    $("clipToggle").disabled = !info.duration;
    $("clipOpts").hidden = true;
    $("clipError").hidden = true;
    stopPreview();
    syncClip();
  }

  function readClip() {
    const d = state.info ? Math.floor(state.info.duration || 0) : 0;
    const start = parseTime($("startTime").value) ?? 0;
    const end = parseTime($("endTime").value) ?? d;
    if (Number.isNaN(start) || Number.isNaN(end)) return { error: "Use times like 1:23 or 1:02:03." };
    if (start >= d) return { error: "Start is past the end of the video." };
    if (end <= start) return { error: "End must be after start." };
    return { start, end: Math.min(end, d) };
  }

  // Slider -> text inputs
  function onRange(which) {
    let s = Number(clipEls.s.value), e = Number(clipEls.e.value);
    if (s >= e) { if (which === "s") s = Math.max(0, e - 1); else e = Math.min(Number(clipEls.e.max), s + 1); }
    clipEls.s.value = s; clipEls.e.value = e;
    $("startTime").value = fmtDuration(s);
    $("endTime").value = fmtDuration(e);
    syncClip();
  }
  clipEls.s.addEventListener("input", () => onRange("s"));
  clipEls.e.addEventListener("input", () => onRange("e"));

  // Text inputs -> slider
  ["startTime", "endTime"].forEach((id) => $(id).addEventListener("input", () => {
    const c = readClip();
    if (!c.error) { clipEls.s.value = c.start; clipEls.e.value = c.end; }
    syncClip();
  }));

  function syncClip() {
    const max = Number(clipEls.e.max) || 1;
    const c = readClip();
    $("clipError").textContent = c.error || "";
    $("clipError").hidden = !c.error || !$("clipToggle").checked;
    const s = c.error ? Number(clipEls.s.value) : c.start, e = c.error ? Number(clipEls.e.value) : c.end;
    $("rangeFill").style.left = (s / max) * 100 + "%";
    $("rangeFill").style.width = ((e - s) / max) * 100 + "%";
    $("clipLen").textContent = c.error ? "–" : fmtDuration(e - s);
    // The start thumb must stay grabbable when both handles sit at the far right.
    clipEls.s.style.zIndex = s > max - 2 ? 3 : 1;
    updateSizeEstimates();
  }

  function updateSizeEstimates() {
    let frac = 1;
    if ($("clipToggle").checked && state.info && state.info.duration) {
      const c = readClip();
      if (!c.error) frac = (c.end - c.start) / state.info.duration;
    }
    $("qualities").querySelectorAll(".chip").forEach((chip) => {
      const small = chip.querySelector("small");
      if (small && chip.dataset.bytes) small.textContent = "~" + fmtBytes(Number(chip.dataset.bytes) * frac);
    });
  }

  $("clipToggle").addEventListener("change", () => {
    $("clipOpts").hidden = !$("clipToggle").checked;
    if (!$("clipToggle").checked) stopPreview();
    syncClip();
  });

  function stopPreview() {
    $("previewFrame").src = "about:blank";
    $("previewFrame").hidden = true;
    $("thumb").hidden = false;
    $("thumb").parentElement.classList.remove("playing");
    $("previewBtn").textContent = "▶ Preview section";
  }

  $("previewBtn").addEventListener("click", () => {
    if (!$("previewFrame").hidden) return stopPreview();
    const c = readClip();
    if (c.error || !state.info) return;
    const p = new URLSearchParams({ start: Math.floor(c.start), end: Math.ceil(c.end), autoplay: "1", rel: "0" });
    $("previewFrame").src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(state.info.id) + "?" + p;
    $("previewFrame").hidden = false;
    $("thumb").hidden = true;
    $("thumb").parentElement.classList.add("playing");
    $("previewBtn").textContent = "■ Close preview";
  });

  $("cancelBtn").addEventListener("click", async () => {
    if (!state.jobId) return;
    await fetch("/api/jobs/" + state.jobId, { method: "DELETE" }).catch(() => {});
  });
})();
