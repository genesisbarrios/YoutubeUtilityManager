// Mass Description Editor (dashboard tool). Depends on window.YUM from dashboard.js.

const MAX_DESC_BYTES = 5000; // YouTube's limit is 5000 bytes (UTF-8)

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function findRegex(find, caseSensitive) {
  return new RegExp(escapeRegExp(find), caseSensitive ? "g" : "gi");
}

// Pure function: compute the new description for one video.
// edit = { mode: "replaceAll", text } | { mode: "findReplace", find, replace, caseSensitive } | { mode: "add", text, where: "top"|"bottom" }
// Returns { next, changed, count, error, note }
function transformDescription(desc, edit) {
  desc = desc || "";
  let next = desc, count = 0, note = "";
  if (edit.mode === "replaceAll") {
    next = edit.text;
  } else if (edit.mode === "findReplace") {
    if (!edit.find) return { next: desc, changed: false, count: 0, error: "Nothing to find." };
    next = desc.replace(findRegex(edit.find, edit.caseSensitive), () => { count++; return edit.replace; });
    if (!count) note = "Text not found";
  } else if (edit.mode === "add") {
    const text = edit.text.trim();
    if (!text) return { next: desc, changed: false, count: 0, error: "Nothing to add." };
    if (desc.includes(text)) {
      note = "Already contains this text";
    } else {
      const body = desc.trim();
      next = !body ? text : edit.where === "top" ? `${text}\n\n${body}` : `${body}\n\n${text}`;
    }
  }
  const changed = next !== desc;
  let error = null;
  if (changed) {
    if (/[<>]/.test(next)) error = "YouTube doesn't allow < or > in descriptions";
    else if (new TextEncoder().encode(next).length > MAX_DESC_BYTES) error = `Over YouTube's ${MAX_DESC_BYTES}-byte limit`;
  }
  return { next, changed, count, error, note };
}

if (typeof module !== "undefined") module.exports = { transformDescription };

if (typeof document !== "undefined") (function () {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const videos = new Map(); // id -> { id, title, description, thumb, published, privacy }
  const order = [];          // ids, newest first
  const selected = new Set();
  let loadedFor = null, loading = false, mode = "replaceAll", plan = [], backup = new Map();

  // ---------- Load videos ----------
  async function loadVideos(force) {
    const me = YUM.me();
    if (!me || loading || (!force && loadedFor === me.id)) return;
    if (!me.uploads) { $("vidCount").textContent = "No uploads playlist found for this channel."; return; }
    loading = true;
    videos.clear(); order.length = 0; selected.clear();
    $("vidCount").textContent = "Loading your videos…";
    $("videoList").innerHTML = "";
    try {
      let pageToken, ids = [];
      do {
        const params = { part: "contentDetails", playlistId: me.uploads, maxResults: "50" };
        if (pageToken) params.pageToken = pageToken;
        const page = await YUM.yt("playlistItems", { params });
        const batch = (page.items || []).map((i) => i.contentDetails.videoId);
        ids.push(...batch);
        await fetchVideoDetails(batch);
        $("vidCount").textContent = `Loading your videos… ${order.length}`;
        pageToken = page.nextPageToken;
      } while (pageToken);
      loadedFor = me.id;
    } catch (err) {
      $("vidCount").textContent = "Couldn't load videos: " + err.message;
    } finally {
      loading = false;
      renderVideos();
    }
  }

  // videos.list in batches of 50; also used to re-read fresh snippets before updating.
  async function fetchVideoDetails(ids, { raw = false } = {}) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await YUM.yt("videos", { params: { part: "snippet,status", id: ids.slice(i, i + 50).join(","), maxResults: "50" } });
      for (const v of data.items || []) {
        out.push(v);
        if (raw) continue;
        if (!videos.has(v.id)) order.push(v.id);
        videos.set(v.id, {
          id: v.id,
          title: v.snippet.title,
          description: v.snippet.description || "",
          thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default || {}).url,
          published: v.snippet.publishedAt,
          privacy: v.status && v.status.privacyStatus,
        });
      }
    }
    return out;
  }

  function renderVideos() {
    const q = $("vidSearch").value.trim().toLowerCase();
    const list = $("videoList");
    list.innerHTML = "";
    const visible = order.filter((id) => {
      const v = videos.get(id);
      return !q || v.title.toLowerCase().includes(q) || v.description.toLowerCase().includes(q);
    });
    for (const id of visible) {
      const v = videos.get(id);
      const li = document.createElement("li");
      li.dataset.id = id;
      li.innerHTML = '<input type="checkbox"><img alt="" loading="lazy"><div><strong></strong><small></small></div>';
      li.querySelector("input").checked = selected.has(id);
      li.querySelector("img").src = v.thumb || "";
      li.querySelector("strong").textContent = v.title;
      li.querySelector("small").textContent = [new Date(v.published).toLocaleDateString(), v.privacy !== "public" ? v.privacy : ""].filter(Boolean).join(" · ");
      list.appendChild(li);
    }
    if (!visible.length && !loading) list.innerHTML = '<li class="empty">' + (order.length ? "No videos match that filter." : "No videos found.") + "</li>";
    const allSel = visible.length > 0 && visible.every((id) => selected.has(id));
    $("vidSelectAll").checked = allSel;
    $("vidSelectAll").dataset.visible = JSON.stringify(visible);
    $("vidCount").textContent = `${selected.size} selected · ${visible.length}${q ? " matching" : ""} of ${order.length} videos`;
  }

  $("videoList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    const cb = li.querySelector("input");
    if (e.target !== cb) cb.checked = !cb.checked;
    cb.checked ? selected.add(li.dataset.id) : selected.delete(li.dataset.id);
    renderVideos();
  });
  $("vidSelectAll").addEventListener("change", (e) => {
    const visible = JSON.parse(e.target.dataset.visible || "[]");
    visible.forEach((id) => (e.target.checked ? selected.add(id) : selected.delete(id)));
    renderVideos();
  });
  $("vidSearch").addEventListener("input", renderVideos);
  $("loadVideosBtn").addEventListener("click", () => loadVideos(true));

  $("addPastedBtn").addEventListener("click", async () => {
    const ids = [...new Set($("vidPaste").value.split(/[\s,]+/).map((x) => x && YUM.parseVideoId(x)).filter(Boolean))];
    if (!ids.length) return;
    try {
      const found = await fetchVideoDetails(ids.filter((id) => !videos.has(id)));
      ids.forEach((id) => videos.has(id) && selected.add(id));
      const missing = ids.filter((id) => !videos.has(id));
      $("vidPaste").value = missing.join("\n");
      renderVideos();
      if (missing.length) alert(`${missing.length} video(s) couldn't be found and were left in the box.`);
      void found;
    } catch (err) { alert(err.message); }
  });

  // ---------- Edit mode ----------
  $("descModes").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    mode = t.dataset.mode;
    document.querySelectorAll("#descModes .tab").forEach((x) => x.classList.toggle("active", x === t));
    document.querySelectorAll("[data-mode-panel]").forEach((p) => { p.hidden = p.dataset.modePanel !== mode; });
    $("descReview").hidden = true;
  });

  $("newDesc").addEventListener("input", () => {
    const n = new TextEncoder().encode($("newDesc").value).length;
    const el = document.querySelector('.char-count[data-for="newDesc"]');
    el.textContent = `${n} / ${MAX_DESC_BYTES}`;
    el.classList.toggle("over", n > MAX_DESC_BYTES);
  });

  function currentEdit() {
    if (mode === "replaceAll") return { mode, text: $("newDesc").value };
    if (mode === "findReplace") return { mode, find: $("findText").value, replace: $("replaceText").value, caseSensitive: $("caseSensitive").checked };
    return { mode, text: $("addText").value, where: document.querySelector('input[name="addWhere"]:checked').value };
  }

  // ---------- Preview ----------
  $("previewDescBtn").addEventListener("click", () => {
    const edit = currentEdit();
    if (!selected.size) return alert("Select at least one video.");
    if (mode === "replaceAll" && !edit.text.trim() && !confirm("The new description is empty. Clear the description on all selected videos?")) return;
    if (mode === "findReplace" && !edit.find) return alert("Enter the text to find.");
    if (mode === "add" && !edit.text.trim()) return alert("Enter the text to add.");
    plan = [...selected].filter((id) => videos.has(id)).map((id) => ({ id, ...transformDescription(videos.get(id).description, edit) }));
    renderPlan(edit);
  });

  function highlight(pre, text, needle, edit, cls) {
    pre.textContent = "";
    if (!needle) { pre.textContent = text; return; }
    const re = edit.mode === "findReplace" && cls !== "add" ? findRegex(needle, edit.caseSensitive) : new RegExp(escapeRegExp(needle), "g");
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      pre.append(text.slice(last, m.index));
      const mark = document.createElement("mark");
      if (cls) mark.className = cls;
      mark.textContent = m[0];
      pre.append(mark);
      last = m.index + m[0].length;
    }
    pre.append(text.slice(last));
  }

  function renderPlan(edit) {
    const list = $("descPreviewList");
    list.innerHTML = "";
    const changes = plan.filter((p) => p.changed && !p.error);
    const skipped = plan.filter((p) => !p.changed);
    const errors = plan.filter((p) => p.error);
    for (const p of plan) {
      const v = videos.get(p.id);
      const li = document.createElement("li");
      li.dataset.id = p.id;
      const badge = p.error ? ["err", p.error]
        : !p.changed ? ["", p.note || "No change"]
        : ["change", edit.mode === "findReplace" ? `${p.count} replacement${p.count > 1 ? "s" : ""}` : "Will update"];
      li.innerHTML = '<details><summary><strong></strong><span class="badge"></span></summary><div class="diff"><div><small>Before</small><pre></pre></div><div><small>After</small><pre></pre></div></div></details>';
      li.querySelector("strong").textContent = v.title;
      const b = li.querySelector(".badge");
      b.className = "badge " + badge[0];
      b.textContent = badge[1];
      const [before, after] = li.querySelectorAll("pre");
      if (edit.mode === "findReplace") {
        highlight(before, v.description, edit.find, edit, "");
        highlight(after, p.next, edit.replace, edit, "add");
      } else if (edit.mode === "add") {
        before.textContent = v.description;
        highlight(after, p.next, edit.text.trim(), edit, "add");
      } else {
        before.textContent = v.description;
        after.textContent = p.next;
      }
      if (!before.textContent) before.textContent = "(empty)";
      if (!after.textContent) after.textContent = "(empty)";
      list.appendChild(li);
    }
    const parts = [`${changes.length} video${changes.length === 1 ? "" : "s"} will be updated`];
    if (skipped.length) parts.push(`${skipped.length} unchanged`);
    if (errors.length) parts.push(`${errors.length} can't be updated`);
    $("descSummary").textContent = parts.join(" · ") + ". Click a video to compare before and after.";
    $("descSummary").className = "alert " + (errors.length ? "danger" : "");
    $("applyDescBtn").textContent = `Update ${changes.length} video${changes.length === 1 ? "" : "s"}`;
    $("applyDescBtn").disabled = !changes.length;
    $("revertDescBtn").hidden = true;
    $("descReview").hidden = false;
    $("descReview").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function setRowStatus(id, kind, text) {
    const b = document.querySelector(`#descPreviewList li[data-id="${id}"] .badge`);
    if (b) { b.className = "badge " + kind; b.textContent = text; }
  }

  // videos.update replaces the whole snippet, so always send the existing title/category/tags back.
  function snippetFor(fresh, description) {
    const s = fresh.snippet;
    const out = { title: s.title, categoryId: s.categoryId, description };
    if (s.tags) out.tags = s.tags;
    if (s.defaultLanguage) out.defaultLanguage = s.defaultLanguage;
    if (s.defaultAudioLanguage) out.defaultAudioLanguage = s.defaultAudioLanguage;
    return out;
  }

  // ---------- Apply ----------
  $("applyDescBtn").addEventListener("click", async () => {
    const edit = currentEdit();
    const todo = plan.filter((p) => p.changed && !p.error);
    if (!todo.length) return;
    if (!confirm(`Update the description on ${todo.length} video(s)? You can revert afterwards from this page.`)) return;
    $("applyDescBtn").disabled = true;
    $("previewDescBtn").disabled = true;
    backup = new Map();
    let ok = 0, fail = 0;
    try {
      // Re-read the latest snippets so edits made elsewhere since loading aren't overwritten.
      const fresh = new Map((await fetchVideoDetails(todo.map((p) => p.id), { raw: true })).map((v) => [v.id, v]));
      for (const p of todo) {
        const f = fresh.get(p.id);
        if (!f) { setRowStatus(p.id, "err", "Video not found"); fail++; continue; }
        const original = f.snippet.description || "";
        const r = transformDescription(original, edit);
        if (r.error) { setRowStatus(p.id, "err", r.error); fail++; continue; }
        if (!r.changed) { setRowStatus(p.id, "", "Already up to date"); continue; }
        setRowStatus(p.id, "change", "Updating…");
        try {
          await YUM.yt("videos", { method: "PUT", params: { part: "snippet" }, body: { id: p.id, snippet: snippetFor(f, r.next) } });
          backup.set(p.id, { title: f.snippet.title, description: original });
          const v = videos.get(p.id);
          if (v) v.description = r.next;
          setRowStatus(p.id, "ok", "✓ Updated");
          ok++;
        } catch (err) {
          setRowStatus(p.id, "err", err.message);
          fail++;
          if (/quota/i.test(err.message)) { $("descSummary").textContent = "YouTube API quota exceeded. Stopped early."; break; }
        }
        $("descSummary").textContent = `Updated ${ok} of ${todo.length}` + (fail ? ` · ${fail} failed` : "");
        await sleep(400);
      }
    } catch (err) {
      $("descSummary").textContent = err.message;
    }
    $("descSummary").className = "alert " + (fail ? "danger" : "success");
    $("revertDescBtn").hidden = backup.size === 0;
    $("previewDescBtn").disabled = false;
  });

  // ---------- Backup & revert ----------
  $("backupDescBtn").addEventListener("click", () => {
    const rows = (backup.size ? [...backup].map(([id, b]) => ({ id, ...b }))
      : plan.map((p) => ({ id: p.id, title: videos.get(p.id).title, description: videos.get(p.id).description })));
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), videos: rows }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `descriptions-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $("revertDescBtn").addEventListener("click", async () => {
    if (!backup.size || !confirm(`Restore the previous description on ${backup.size} video(s)?`)) return;
    $("revertDescBtn").disabled = true;
    let ok = 0, fail = 0;
    const fresh = new Map((await fetchVideoDetails([...backup.keys()], { raw: true })).map((v) => [v.id, v]));
    for (const [id, b] of backup) {
      const f = fresh.get(id);
      if (!f) { fail++; continue; }
      try {
        await YUM.yt("videos", { method: "PUT", params: { part: "snippet" }, body: { id, snippet: snippetFor(f, b.description) } });
        const v = videos.get(id);
        if (v) v.description = b.description;
        setRowStatus(id, "", "↺ Reverted");
        ok++;
      } catch (err) { setRowStatus(id, "err", "Revert failed: " + err.message); fail++; }
      await sleep(400);
    }
    $("descSummary").textContent = `Reverted ${ok} video(s)` + (fail ? ` · ${fail} failed` : "");
    $("descSummary").className = "alert " + (fail ? "danger" : "success");
    if (!fail) { backup.clear(); $("revertDescBtn").hidden = true; }
    $("revertDescBtn").disabled = false;
  });

  // Load the video list the first time the tool is opened while signed in.
  const maybeLoad = () => { if (location.hash === "#descriptions" && YUM.me()) loadVideos(false); };
  document.addEventListener("yum:tool", maybeLoad);
  document.addEventListener("yum:signedin", maybeLoad);
})();
