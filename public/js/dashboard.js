(function () {
  const $ = (id) => document.getElementById(id);
  const SCOPES = "https://www.googleapis.com/auth/youtube.force-ssl";
  const API = "https://www.googleapis.com/youtube/v3/";
  const STORE_KEY = "yum_token";
  let token = null, me = null, tokenClient = null, threads = [];

  // ---------- Auth (Google Identity Services token flow) ----------
  function loadStoredToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(STORE_KEY) || "null");
      if (t && t.exp > Date.now() + 60000) return t.value;
    } catch { /* ignore */ }
    return null;
  }
  function storeToken(value, expiresIn) {
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify({ value, exp: Date.now() + expiresIn * 1000 })); } catch { /* ignore */ }
  }
  function clearToken() { try { sessionStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }

  function initGis() {
    if (!window.GOOGLE_CLIENT_ID) { $("noClientId").hidden = false; return; }
    if (!window.google || !google.accounts) return setTimeout(initGis, 100);
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: window.GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: async (resp) => {
        if (resp.error) return gateError(resp.error_description || resp.error);
        token = resp.access_token;
        storeToken(token, Number(resp.expires_in) || 3600);
        await enterDashboard();
      },
      error_callback: (err) => gateError(err.message || "Sign-in was cancelled."),
    });
    $("signInBtn").disabled = false;
  }

  function gateError(msg) { $("gateError").textContent = msg; $("gateError").hidden = !msg; }

  $("signInBtn").addEventListener("click", () => { gateError(""); tokenClient && tokenClient.requestAccessToken(); });

  $("signOutBtn").addEventListener("click", () => {
    if (token && window.google) google.accounts.oauth2.revoke(token, () => {});
    token = null; me = null; clearToken();
    $("dash").hidden = true; $("gate").hidden = false;
  });

  async function yt(path, { method = "GET", params = {}, body } = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(API + path + (qs ? "?" + qs : ""), {
      method,
      headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearToken(); throw new Error("Session expired. Please sign in again."); }
    if (!res.ok) throw new Error((data.error && data.error.message) || "YouTube API error " + res.status);
    return data;
  }

  async function enterDashboard() {
    try {
      const data = await yt("channels", { params: { part: "snippet", mine: "true" } });
      const ch = data.items && data.items[0];
      if (!ch) throw new Error("This Google account has no YouTube channel.");
      me = { id: ch.id, title: ch.snippet.title, avatar: ch.snippet.thumbnails.default.url };
      $("channelName").textContent = me.title;
      $("avatar").src = me.avatar;
      $("gate").hidden = true;
      $("dash").hidden = false;
    } catch (err) {
      token = null; clearToken();
      $("gate").hidden = false; $("dash").hidden = true;
      gateError(err.message);
    }
  }

  // ---------- Mass comment reply ----------
  function parseVideoId(input) {
    const s = input.trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.hostname.includes("youtu.be")) return u.pathname.slice(1, 12);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const m = u.pathname.match(/\/(shorts|live|embed)\/([\w-]{11})/);
      if (m) return m[2];
    } catch { /* fall through */ }
    return null;
  }

  function feedback(msg, kind) {
    const el = $("feedback");
    el.textContent = msg;
    el.className = "alert " + (kind || "");
    el.hidden = !msg;
  }

  $("findForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    feedback("");
    const videoId = parseVideoId($("videoId").value);
    if (!videoId) return feedback("Couldn't read a video ID from that input.", "danger");
    const keyword = $("keyword").value.trim().toLowerCase();
    const max = Number($("maxComments").value);
    const skipReplied = $("skipReplied").checked;

    $("findBtn").disabled = true; $("findBtn").textContent = "Scanning…";
    try {
      const all = [];
      let pageToken;
      do {
        const params = { part: "snippet,replies", videoId, maxResults: "100", textFormat: "plainText" };
        if (pageToken) params.pageToken = pageToken;
        const data = await yt("commentThreads", { params });
        all.push(...(data.items || []));
        pageToken = data.nextPageToken;
        $("findBtn").textContent = "Scanning… " + all.length;
      } while (pageToken && all.length < max);

      threads = all.slice(0, max).filter((t) => {
        const s = t.snippet;
        if (!s.canReply) return false;
        if (keyword && !s.topLevelComment.snippet.textOriginal.toLowerCase().includes(keyword)) return false;
        if (skipReplied && me) {
          const replies = (t.replies && t.replies.comments) || [];
          if (replies.some((r) => r.snippet.authorChannelId && r.snippet.authorChannelId.value === me.id)) return false;
        }
        return true;
      });
      renderMatches(all.length);
    } catch (err) {
      feedback(err.message, "danger");
    } finally {
      $("findBtn").disabled = false; $("findBtn").textContent = "Find comments";
    }
  });

  function renderMatches(scanned) {
    const list = $("commentList");
    list.innerHTML = "";
    threads.forEach((t, i) => {
      const c = t.snippet.topLevelComment.snippet;
      const li = document.createElement("li");
      li.dataset.i = i;
      li.innerHTML = '<label class="check"><input type="checkbox" checked></label>' +
        '<div><strong></strong><p></p></div><span class="status"></span>';
      li.querySelector("strong").textContent = c.authorDisplayName;
      li.querySelector("p").textContent = c.textOriginal;
      list.appendChild(li);
    });
    $("matchCount").textContent = threads.length + " matching of " + scanned + " scanned";
    $("selectAll").checked = true;
    $("matches").hidden = false;
    if (!threads.length) feedback("No matching comments found.", "");
  }

  $("selectAll").addEventListener("change", (e) => {
    $("commentList").querySelectorAll("input[type=checkbox]").forEach((c) => { c.checked = e.target.checked; });
  });

  $("replyBtn").addEventListener("click", async () => {
    const text = $("replyText").value.trim();
    if (!text) return feedback("Reply text is empty.", "danger");
    const rows = [...$("commentList").children].filter((li) => li.querySelector("input").checked && !li.classList.contains("sent"));
    if (!rows.length) return feedback("No comments selected.", "danger");
    if (!confirm("Reply to " + rows.length + " comment(s) as " + (me ? me.title : "you") + "?")) return;

    $("replyBtn").disabled = true;
    let ok = 0, fail = 0;
    for (const li of rows) {
      const t = threads[Number(li.dataset.i)];
      const status = li.querySelector(".status");
      status.textContent = "Sending…";
      try {
        await yt("comments", { method: "POST", params: { part: "snippet" }, body: { snippet: { parentId: t.id, textOriginal: text } } });
        li.classList.add("sent"); status.textContent = "✓ Replied"; ok++;
      } catch (err) {
        li.classList.add("failed"); status.textContent = "✕ " + err.message; fail++;
        if (/quota/i.test(err.message)) { feedback("YouTube API quota exceeded. Stopped early.", "danger"); break; }
      }
      feedback("Sent " + ok + " / " + rows.length + (fail ? " · " + fail + " failed" : ""), fail ? "danger" : "success");
      await new Promise((r) => setTimeout(r, 1500));
    }
    $("replyBtn").disabled = false;
  });

  // ---------- Boot ----------
  token = loadStoredToken();
  if (token) enterDashboard();
  window.addEventListener("load", initGis);
})();
