// Framework-agnostic YouTube download engine built on yt-dlp + ffmpeg.
// No Express imports here so it can be reused from other servers (e.g. Next.js API routes).

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

// Binary resolution: env var → ./bin (from `npm run setup`) → npm static builds → PATH.
const BIN_DIR = path.join(__dirname, "..", "bin");
const EXE = process.platform === "win32" ? ".exe" : "";
const local = (name) => { const p = path.join(BIN_DIR, name + EXE); return fs.existsSync(p) ? p : null; };
const optional = (mod, pick) => { try { return pick(require(mod)); } catch { return null; } };

const venv = path.join(__dirname, "..", ".venv", process.platform === "win32" ? "Scripts" : "bin", "yt-dlp" + EXE);

const YTDLP = process.env.YTDLP_PATH || (fs.existsSync(venv) ? venv : null) || local("yt-dlp") || "yt-dlp";
const FFMPEG = process.env.FFMPEG_PATH || local("ffmpeg") || optional("ffmpeg-static", (m) => m) || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || local("ffprobe") || optional("ffprobe-static", (m) => m.path) || "ffprobe";

// yt-dlp needs a JS runtime (deno, or Node 20+) to solve YouTube's player challenges;
// without one, most high-resolution formats are missing.
function findJsRuntime() {
  if (process.env.JS_RUNTIME) return process.env.JS_RUNTIME; // e.g. "node:/path/to/node" or "deno"
  const deno = local("deno");
  if (deno) return `deno:${deno}`;
  if (Number(process.versions.node.split(".")[0]) >= 20) return `node:${process.execPath}`;
  // Running on an older Node: look for a newer one installed via nvm.
  const nvmDir = path.join(process.env.NVM_DIR || path.join(require("os").homedir(), ".nvm"), "versions", "node");
  try {
    const best = fs.readdirSync(nvmDir)
      .map((v) => ({ v, major: Number(v.replace(/^v/, "").split(".")[0]) }))
      .filter((x) => x.major >= 20)
      .sort((a, b) => b.v.localeCompare(a.v, undefined, { numeric: true }))[0];
    if (best) return `node:${path.join(nvmDir, best.v, "bin", "node")}`;
  } catch { /* no nvm */ }
  return null; // yt-dlp will still try deno on PATH
}
const JS_RUNTIME = findJsRuntime();

const YTDLP_BASE_ARGS = [
  ...(path.isAbsolute(FFMPEG) ? ["--ffmpeg-location", path.dirname(FFMPEG)] : []),
  ...(JS_RUNTIME ? ["--js-runtimes", JS_RUNTIME] : []),
];
const DOWNLOAD_DIR = path.resolve(process.env.DOWNLOAD_DIR || path.join(__dirname, "..", "downloads"));
const JOB_TTL_MS = 60 * 60 * 1000; // delete finished files after 1h
const STALL_MS = 30 * 1000;         // abort a ranged (clip) download if no bytes arrive for this long
const MAX_RANGED_SECONDS = 10 * 60; // clips longer than this download fully, then trim locally

const VIDEO_HEIGHTS = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];
const VIDEO_CONTAINERS = ["mp4", "mkv", "webm"];
const VIDEO_ENCODINGS = ["original", "h264", "compressed"];
const AUDIO_FORMATS = ["mp3", "m4a", "opus", "flac", "wav", "best"];
const AUDIO_BITRATES = ["320", "256", "192", "128", "96"];

const ALLOWED_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be", "www.youtu.be",
]);

function normalizeUrl(input) {
  const raw = String(input || "").trim();
  if (/^[\w-]{11}$/.test(raw)) return `https://www.youtube.com/watch?v=${raw}`;
  let u;
  try { u = new URL(raw); } catch { throw new Error("That doesn't look like a valid URL."); }
  if (!/^https?:$/.test(u.protocol) || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error("Only YouTube links are supported.");
  }
  return u.toString();
}

function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Own process group, so killing it also stops ffmpeg children that yt-dlp spawns.
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e) { return reject(e); }
    let stdout = "", stderr = "", buf = "";
    const feed = (chunk, isErr) => {
      const text = chunk.toString();
      if (isErr) stderr += text; else stdout += text;
      if (!onLine) return;
      buf += text;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop();
      lines.forEach((l) => l && onLine(l, isErr));
    };
    child.stdout.on("data", (c) => feed(c, false));
    child.stderr.on("data", (c) => feed(c, true));
    child.on("error", (e) => {
      if (e.code === "ENOENT") e.message = `"${cmd}" is not installed or not on PATH.`;
      reject(e);
    });
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const errLine = stderr.split("\n").reverse().find((l) => l.startsWith("ERROR:"));
      reject(new Error((errLine || stderr.trim().split("\n").pop() || `${cmd} exited with ${code}`).replace(/^ERROR:\s*/, "")));
    });
    run.lastChild = child;
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
}

async function checkDependencies() {
  const out = {};
  for (const [name, cmd, args] of [["yt-dlp", YTDLP, ["--version"]], ["ffmpeg", FFMPEG, ["-version"]], ["js-runtime", JS_RUNTIME && JS_RUNTIME.split(":").slice(1).join(":"), ["--version"]]]) {
    if (!cmd) { out[name] = null; continue; }
    try { out[name] = (await run(cmd, args)).stdout.split("\n")[0].trim(); }
    catch { out[name] = null; }
  }
  return out;
}

async function getInfo(input) {
  const url = normalizeUrl(input);
  const { stdout } = await run(YTDLP, [...YTDLP_BASE_ARGS, "-J", "--no-playlist", "--no-warnings", "--", url]);
  const info = JSON.parse(stdout);
  const formats = info.formats || [];
  const heights = [...new Set(
    formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.height).map((f) => f.height)
  )].sort((a, b) => b - a);
  // Snap odd heights (e.g. 1608 for ultrawide) to the standard tiers they satisfy.
  const max = heights[0] || 0;
  const tiers = VIDEO_HEIGHTS.filter((h) => h <= max || heights.includes(h));
  // Rough size estimate mirroring yt-dlp's default pick: https over HLS, AV1 > VP9 > H.264, best Opus/AAC audio.
  const bytes = (f) => (f && (f.filesize || f.filesize_approx || (f.tbr && info.duration ? f.tbr * 125 * info.duration : 0))) || 0;
  const codecRank = (c = "") => (c.startsWith("av01") ? 3 : c.startsWith("vp9") || c.startsWith("vp09") ? 2 : 1);
  const audio = formats
    .filter((f) => f.vcodec === "none" && f.acodec && f.acodec !== "none" && f.protocol === "https" && !/drc/.test(f.format_id))
    .sort((x, y) => ((y.acodec === "opus") - (x.acodec === "opus")) || ((y.abr || 0) - (x.abr || 0)))[0];
  const sizeFor = (h) => {
    const vids = formats.filter((f) => f.vcodec && f.vcodec !== "none" && f.acodec === "none" && f.height && f.height <= h);
    if (!vids.length) return null;
    const top = Math.max(...vids.map((f) => f.height));
    const v = vids.filter((f) => f.height === top)
      .sort((a, b) => ((b.protocol === "https") - (a.protocol === "https")) || (codecRank(b.vcodec) - codecRank(a.vcodec)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
    return bytes(v) + bytes(audio) || null;
  };
  return {
    url,
    id: info.id,
    title: info.title,
    channel: info.channel || info.uploader,
    duration: info.duration,
    thumbnail: info.thumbnail,
    isLive: !!info.is_live,
    maxHeight: max,
    qualities: tiers.map((h) => ({ height: h, label: qualityLabel(h), approxBytes: sizeFor(h) })),
  };
}

function qualityLabel(h) {
  return ({ 4320: "8K", 2160: "4K", 1440: "2K (1440p)" })[h] || `${h}p`;
}

// Accepts seconds (number) or "ss", "mm:ss", "hh:mm:ss" strings.
function parseTime(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : NaN;
  const parts = String(v).trim().split(":").map(Number);
  if (parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function fmtTime(sec) {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}-${pad(m)}-${pad(r)}` : `${m}-${pad(r)}`;
}

function validateOptions(o) {
  const base = validateFormatOptions(o);
  const start = parseTime(o.start), end = parseTime(o.end);
  if (start === null && end === null) return base;
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error("Invalid start/end time.");
  const s = start || 0;
  if (end !== null && end <= s) throw new Error("End time must be after start time.");
  return { ...base, section: { start: s, end }, preciseCut: base.mode === "video" && !!o.preciseCut };
}

function validateFormatOptions(o) {
  const mode = o.mode === "audio" ? "audio" : "video";
  if (mode === "video") {
    const height = o.height === "best" || !o.height ? "best" : Number(o.height);
    if (height !== "best" && !VIDEO_HEIGHTS.includes(height)) throw new Error("Invalid quality.");
    const encoding = VIDEO_ENCODINGS.includes(o.encoding) ? o.encoding : "original";
    let container = VIDEO_CONTAINERS.includes(o.container) ? o.container : "mp4";
    if (encoding !== "original") container = "mp4";
    return { mode, height, encoding, container };
  }
  const audioFormat = AUDIO_FORMATS.includes(o.audioFormat) ? o.audioFormat : "mp3";
  const audioBitrate = AUDIO_BITRATES.includes(String(o.audioBitrate)) ? String(o.audioBitrate) : "320";
  return { mode, audioFormat, audioBitrate };
}

function videoFormatArgs(opts) {
  const sort = [];
  if (opts.height !== "best") sort.push(`res:${opts.height}`);
  if (opts.encoding !== "original") sort.push("vcodec:h264", "acodec:aac"); // avoid a re-encode when possible
  else if (opts.container === "mp4") sort.push("ext:mp4:m4a");
  else if (opts.container === "webm") sort.push("ext:webm:webm");
  return ["-f", "bv*+ba/b", ...(sort.length ? ["-S", sort.join(",")] : [])];
}

// useSections: let yt-dlp fetch only the selected range (saves bandwidth on big videos).
function buildYtdlpArgs(url, opts, dir, useSections) {
  const args = [
    ...YTDLP_BASE_ARGS,
    "--no-playlist", "--newline", "--no-warnings", "--no-mtime",
    "--concurrent-fragments", "8", // HLS/DASH (e.g. past livestreams) are ~4x faster in parallel
    "--progress-template",
    "download:PROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
    "-o", path.join(dir, "%(title).150B [%(id)s]" + (opts.section ? ` (${fmtTime(opts.section.start)} to ${opts.section.end === null ? "end" : fmtTime(opts.section.end)})` : "") + ".%(ext)s"),
    ...(opts.section && useSections ? ["--download-sections", `*${opts.section.start}-${opts.section.end === null ? "inf" : opts.section.end}`] : []),
    ...(opts.section && useSections && opts.preciseCut ? ["--force-keyframes-at-cuts"] : []),
    // Chapter markers from the full video would be wrong (and stretch the container length) in a clip.
    ...(opts.section ? ["--no-embed-chapters"] : []),
    "--embed-metadata",
  ];
  if (opts.mode === "video") {
    args.push(...videoFormatArgs(opts));
    args.push("--merge-output-format", opts.container);
  } else {
    args.push("-f", "ba/b", "-x", "--audio-format", opts.audioFormat);
    if (["mp3", "m4a", "opus"].includes(opts.audioFormat)) args.push("--audio-quality", `${opts.audioBitrate}K`);
    else args.push("--audio-quality", "0");
    if (opts.audioFormat === "mp3") args.push("--embed-thumbnail");
  }
  args.push("--", url);
  return args;
}

async function probe(file) {
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,duration", "-of", "json", file,
  ]);
  const j = JSON.parse(stdout);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  // Prefer real A/V stream length: the container duration also counts chapter/data tracks.
  const avDur = Math.max(0, ...(j.streams || []).filter((s) => s.codec_type === "video" || s.codec_type === "audio").map((s) => Number(s.duration) || 0));
  return { duration: avDur || Number(j.format && j.format.duration) || 0, vcodec: v && v.codec_name, acodec: a && a.codec_name };
}

const ENCODE_PRESETS = {
  h264: { crf: "18", preset: "fast", audio: "192k" },       // visually lossless, plays everywhere
  compressed: { crf: "28", preset: "fast", audio: "128k" }, // much smaller file
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobs = new Map();

// Jobs live in memory, so job folders left over from a previous run can never be served: remove them.
try {
  for (const d of fs.readdirSync(DOWNLOAD_DIR)) if (/^[0-9a-f]{16}$/.test(d)) rmrf(path.join(DOWNLOAD_DIR, d));
} catch { /* dir doesn't exist yet */ }

class Job extends EventEmitter {
  constructor(url, opts) {
    super();
    this.id = crypto.randomBytes(8).toString("hex");
    this.url = url;
    this.opts = opts;
    this.dir = path.join(DOWNLOAD_DIR, this.id);
    this.state = { status: "queued", stage: "Starting…", percent: 0, speed: null, eta: null, error: null, filename: null };
    this.createdAt = Date.now();
    this.file = null;
    this.child = null;
    this.setMaxListeners(50);
  }
  update(patch) {
    Object.assign(this.state, patch);
    this.emit("update", this.state);
  }
  cancel() {
    this.cancelled = true;
    killTree(this.child);
  }
}

// limits.maxHeight lets a host app enforce tiers server-side (e.g. free users capped at 720p).
function createJob(input, rawOpts, limits = {}) {
  const url = normalizeUrl(input);
  const opts = validateOptions(rawOpts || {});
  if (opts.mode === "video" && limits.maxHeight) {
    if (opts.height === "best" || opts.height > limits.maxHeight) opts.height = limits.maxHeight;
  }
  const job = new Job(url, opts);
  jobs.set(job.id, job);
  process.nextTick(() => runJob(job));
  return job;
}

async function runJob(job) {
  try {
    fs.mkdirSync(job.dir, { recursive: true });
    job.update({ status: "running", stage: "Fetching streams…" });

    let part = 0, fullForTrim = false;
    const isVideo = job.opts.mode === "video";
    const sec = job.opts.section;
    const sectionLen = sec && sec.end !== null ? sec.end - sec.start : null;
    const onLine = (line) => {
      const t = sec && /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
      if (t && sectionLen && !fullForTrim) {
        const done = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        job.update({ stage: isVideo ? "Downloading clip" : "Downloading audio clip", percent: Math.min(100, (done / sectionLen) * 100) });
        return;
      }
      if (line.startsWith("[download] Destination:")) {
        part += 1;
        const label = sec && fullForTrim ? (part % 2 === 1 ? "Downloading full video (for trimming)" : "Downloading full audio (for trimming)")
          : sec ? (isVideo ? "Downloading clip" : "Downloading audio clip")
          : isVideo ? (part === 1 ? "Downloading video stream" : "Downloading audio stream") : "Downloading audio";
        job.update({ stage: label, percent: 0 });
      } else if (line.startsWith("PROGRESS ")) {
        const [done, total, est, speed, eta] = line.slice(9).split(" ").map((x) => (x === "NA" ? null : Number(x)));
        const t = total || est;
        if (t) job.update({ percent: Math.min(100, (done / t) * 100), speed, eta });
      } else if (line.startsWith("[Merger]")) {
        job.update({ stage: "Merging video + audio…", percent: 100, speed: null, eta: null });
      } else if (line.startsWith("[ExtractAudio]")) {
        job.update({ stage: `Converting to ${job.opts.audioFormat.toUpperCase()}…`, percent: 100, speed: null, eta: null });
      } else if (line.startsWith("[EmbedThumbnail]") || line.startsWith("[Metadata]")) {
        job.update({ stage: "Adding metadata…" });
      }
    };

    // useSections: ffmpeg fetches only the range. YouTube throttles or stalls those single-stream
    // reads (especially HLS), so a watchdog aborts if no bytes arrive for STALL_MS.
    const download = async (useSections) => {
      const p = run(YTDLP, buildYtdlpArgs(job.url, job.opts, job.dir, useSections), { onLine });
      job.child = run.lastChild;
      let stalled = false, watchdog;
      if (useSections) {
        let lastSize = -1, lastChange = Date.now();
        watchdog = setInterval(() => {
          const size = dirSize(job.dir);
          if (size !== lastSize) { lastSize = size; lastChange = Date.now(); return; }
          if (Date.now() - lastChange > STALL_MS) { stalled = true; killTree(job.child); }
        }, 2000);
      }
      try {
        await p;
      } catch (err) {
        if (job.cancelled) throw new Error("Cancelled.");
        if (stalled) throw Object.assign(new Error("stalled"), { stalled: true });
        throw err;
      } finally {
        clearInterval(watchdog);
      }
      if (job.cancelled) throw new Error("Cancelled.");
      const f = findOutput(job.dir);
      if (!f) throw new Error("Download finished but no output file was found.");
      return f;
    };

    // Audio is small: always fetch it whole and trim locally (exact, and immune to unseekable streams).
    // Video: fetch just the range; if the stream wasn't seekable the cut silently fails, so verify it
    // and fall back to a full download + local trim.
    const fullThenTrim = async (stage, exact) => {
      if (stage) job.update({ stage, percent: 0, speed: null, eta: null });
      for (const f of fs.readdirSync(job.dir)) rmrf(path.join(job.dir, f));
      fullForTrim = true; part = 0;
      return trimLocal(job, await download(false), { exact });
    };

    let file = null;
    if (sec) {
      try {
        file = await downloadHlsClip(job, (stage) => job.update({ stage, percent: 0 }));
      } catch (err) {
        if (job.cancelled) throw err;
        console.warn("HLS clip path failed, falling back:", err.message);
        for (const f of fs.readdirSync(job.dir)) rmrf(path.join(job.dir, f));
        file = null;
      }
    }
    if (file) {
      // done via the HLS clip path
    } else if (sec && isVideo && sectionLen && sectionLen <= MAX_RANGED_SECONDS) {
      // Short clip: try fetching just the range.
      try {
        file = await download(true);
        const got = (await probe(file)).duration;
        // Unseekable streams silently ignore the cut; they usually have sparse keyframes too, so cut exactly.
        if (got > sectionLen + 2) file = await fullThenTrim("Stream isn't seekable, downloading full video to trim…", true);
      } catch (err) {
        if (!err.stalled) throw err;
        file = await fullThenTrim("Clip download stalled, downloading full video to trim instead…", false);
      }
    } else if (sec && isVideo) {
      // Long or open-ended clip: the chunked downloader is far faster than a ranged ffmpeg read.
      file = await fullThenTrim(null, false);
    } else {
      file = await download(false);
      if (sec) file = await trimLocal(job, file);
    }

    if (isVideo && job.opts.encoding !== "original") {
      file = await reencode(job, file);
    }

    job.file = file;
    job.update({
      status: "done", stage: "Ready", percent: 100, speed: null, eta: null,
      filename: path.basename(file), size: fs.statSync(file).size,
    });
  } catch (err) {
    job.update({ status: "error", stage: "Failed", error: job.cancelled ? "Cancelled." : err.message });
    rmrf(job.dir);
  } finally {
    job.child = null;
    setTimeout(() => { rmrf(job.dir); jobs.delete(job.id); }, JOB_TTL_MS).unref();
  }
}

// ---------------------------------------------------------------------------
// HLS clip downloader. ffmpeg stalls on YouTube's segmented HLS streams (which
// past livestreams use), so for clips we fetch only the segments covering the
// range, in parallel, and trim locally.
// ---------------------------------------------------------------------------

const HLS_CONCURRENCY = 8;

function parseHlsPlaylist(text, base) {
  const lines = text.split(/\r?\n/);
  let init = null, t = 0, dur = null;
  const segs = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-MAP:")) {
      const m = /URI="([^"]+)"/.exec(line);
      if (m) init = new URL(m[1], base).toString();
    } else if (line.startsWith("#EXTINF:")) {
      dur = parseFloat(line.slice(8));
    } else if (line && !line.startsWith("#") && dur !== null) {
      segs.push({ url: new URL(line, base).toString(), start: t, duration: dur });
      t += dur;
      dur = null;
    }
  }
  return { init, segs, total: t };
}

async function fetchBuf(url, job, tries = 4) {
  for (let i = 1; ; i++) {
    if (job.cancelled) throw new Error("Cancelled.");
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

// Downloads the segments of one HLS stream covering [start, end] into outFile.
// Returns the timestamp (seconds) at which the written file begins.
async function downloadHlsRange(job, playlistUrl, start, end, outFile, progress) {
  const res = await fetch(playlistUrl);
  if (!res.ok) throw new Error(`Playlist HTTP ${res.status}`);
  const { init, segs } = parseHlsPlaylist(await res.text(), playlistUrl);
  const picked = segs.filter((s) => s.start + s.duration > start && (end === null || s.start < end));
  if (!picked.length) throw new Error("Selected range is outside the video.");
  progress.total += picked.length;
  // Stream to disk in order; workers stay within a small window ahead of the writer so memory
  // stays bounded (~WINDOW segments) even for multi-GB clips.
  const WINDOW = HLS_CONCURRENCY * 4;
  const fd = fs.openSync(outFile, "w");
  try {
    if (init) fs.writeSync(fd, await fetchBuf(init, job));
    const ready = new Map();
    let next = 0, flushed = 0, waiters = [], failed = null;
    const release = () => { const w = waiters; waiters = []; w.forEach((r) => r()); };
    const flush = () => {
      if (failed) return;
      while (ready.has(flushed)) {
        fs.writeSync(fd, ready.get(flushed));
        ready.delete(flushed);
        flushed++;
      }
      release();
    };
    const worker = async () => {
      try {
        while (!failed && next < picked.length) {
          while (!failed && next - flushed >= WINDOW) await new Promise((r) => waiters.push(r));
          if (failed || next >= picked.length) break;
          const i = next++;
          const buf = await fetchBuf(picked[i].url, job);
          if (failed) break;
          ready.set(i, buf);
          progress.done += 1;
          progress.bytes += buf.length;
          progress.tick();
          flush();
        }
      } catch (e) {
        failed = failed || e; // stop every worker; nothing writes after this
        release();
      }
    };
    await Promise.all(Array.from({ length: Math.min(HLS_CONCURRENCY, picked.length) }, worker));
    if (failed) throw failed;
    flush();
    if (flushed !== picked.length) throw new Error("HLS download incomplete");
  } finally {
    fs.closeSync(fd);
  }
  return picked[0].start;
}

function safeFilename(name) {
  return String(name || "video").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);
}

const isHls = (f) => /^m3u8/.test((f && f.protocol) || "");
const hasVideo = (f) => !!(f && f.vcodec && f.vcodec !== "none");
// YouTube's HLS audio formats (233 "low" / 234 "high") often report no codec or bitrate.
const bestHlsAudio = (formats) => formats
  .filter((f) => isHls(f) && f.vcodec === "none" && f.acodec !== "none")
  .sort((a, b) => ((b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)) || ((b.source_preference || 0) - (a.source_preference || 0)))[0];

// Pick HLS streams for a clip. Short video clips keep yt-dlp's exact pick (a ranged ffmpeg read is
// fine for a few seconds); longer ones switch to an HLS stream of the same resolution, because
// ranged reads of plain https streams are throttled to ~realtime.
function pickHlsFormats(info, opts, clipLen) {
  const formats = info.formats || [];
  const audio = bestHlsAudio(formats);
  if (opts.mode === "audio") return audio ? [audio] : null;
  const chosen = info.requested_formats || [info];
  if (chosen.every(isHls)) return chosen;
  const video = chosen.find(hasVideo);
  if (!video || !audio) return null;
  if (isHls(video)) return [video, audio];
  if (clipLen <= 60) return null;
  const family = (c = "") => c.split(".")[0].replace("avc1", "h264").replace("vp09", "vp9");
  const hlsVideo = formats
    .filter((f) => isHls(f) && hasVideo(f) && f.height === video.height)
    .sort((a, b) => ((family(b.vcodec) === family(video.vcodec)) - (family(a.vcodec) === family(video.vcodec))) || ((b.fps || 0) - (a.fps || 0)) || ((b.tbr || 0) - (a.tbr || 0)))[0];
  return hlsVideo ? [hlsVideo, audio] : null;
}

function audioEncodeArgs(opts) {
  const br = `${opts.audioBitrate}k`;
  switch (opts.audioFormat) {
    case "mp3": return { ext: "mp3", args: ["-c:a", "libmp3lame", "-b:a", br, "-id3v2_version", "3"] };
    case "opus": return { ext: "opus", args: ["-c:a", "libopus", "-b:a", br] };
    case "flac": return { ext: "flac", args: ["-c:a", "flac"] };
    case "wav": return { ext: "wav", args: ["-c:a", "pcm_s16le"] };
    case "m4a": // HLS audio is already AAC: keep it as-is unless the user asked for a lower bitrate
      return Number(opts.audioBitrate) < 128 ? { ext: "m4a", args: ["-c:a", "aac", "-b:a", br] } : { ext: "m4a", args: ["-c:a", "copy"] };
    default: return { ext: "m4a", args: ["-c:a", "copy"] }; // "best": original stream
  }
}

// Returns the output file, or null when no suitable HLS streams exist (caller uses the normal path).
async function downloadHlsClip(job, onStage) {
  const { start, end } = job.opts.section;
  const isVideo = job.opts.mode === "video";
  const { stdout } = await run(YTDLP, [...YTDLP_BASE_ARGS, "-J", "--no-playlist", "--no-warnings",
    ...(isVideo ? videoFormatArgs(job.opts) : ["-f", "ba/b"]), "--", job.url]);
  const info = JSON.parse(stdout);
  const end2 = end === null ? info.duration : Math.min(end, info.duration || end);
  const len = end2 - start;
  if (!(len > 0)) throw new Error("Selected range is outside the video.");
  const fmts = pickHlsFormats(info, job.opts, len);
  if (!fmts) return null;

  onStage(isVideo ? "Downloading clip" : "Downloading audio clip");
  const progress = {
    total: 0, done: 0, bytes: 0, started: Date.now(),
    tick() {
      if (!this.total) return;
      const elapsed = (Date.now() - this.started) / 1000;
      const pct = (this.done / this.total) * 100;
      job.update({ percent: Math.min(99, pct), speed: elapsed > 0 ? this.bytes / elapsed : null, eta: pct > 2 ? Math.round(elapsed * (100 - pct) / pct) : null });
    },
  };
  const parts = await Promise.all(fmts.map(async (f, i) => {
    const out = path.join(job.dir, `part${i}.mp4`);
    const offset = await downloadHlsRange(job, f.url, start, end2, out, progress);
    return { file: out, offset, video: hasVideo(f) };
  }));
  if (job.cancelled) throw new Error("Cancelled.");

  const label = ` (${fmtTime(start)} to ${end === null ? "end" : fmtTime(end)})`;
  const base = path.join(job.dir, `${safeFilename(info.title)} [${info.id}]${label}`);
  const v = parts.find((p) => p.video);
  const a = parts.find((p) => !p.video);
  const cut = (p) => ["-ss", String(Math.max(0, start - p.offset)), "-t", String(len), "-i", p.file];
  const meta = ["-metadata", `title=${info.title || ""}`, "-metadata", `artist=${info.channel || info.uploader || ""}`];
  let outFile, args;

  if (isVideo) {
    job.update({ stage: "Trimming to selected section…", percent: 100, speed: null, eta: null });
    outFile = `${base}.${job.opts.container === "mkv" ? "mkv" : "mp4"}`;
    args = ["-y", "-hide_banner", "-loglevel", "error", ...cut(v), ...(a ? cut(a) : []),
      "-map", "0:v:0", ...(a ? ["-map", "1:a:0"] : ["-map", "0:a:0?"]),
      ...(job.opts.preciseCut ? ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k"] : ["-c", "copy"]),
      ...meta, "-avoid_negative_ts", "make_zero", ...(outFile.endsWith(".mp4") ? ["-movflags", "+faststart"] : []), outFile];
  } else {
    const enc = audioEncodeArgs(job.opts);
    job.update({ stage: `Converting to ${job.opts.audioFormat === "best" ? "M4A" : job.opts.audioFormat.toUpperCase()}…`, percent: 100, speed: null, eta: null });
    outFile = `${base}.${enc.ext}`;
    // MP3 gets the video thumbnail as cover art, like the normal path.
    let cover = null;
    if (enc.ext === "mp3" && info.thumbnail) {
      try {
        cover = path.join(job.dir, "cover.img");
        fs.writeFileSync(cover, await fetchBuf(info.thumbnail, job, 2));
      } catch { cover = null; }
    }
    args = ["-y", "-hide_banner", "-loglevel", "error", ...cut(a),
      ...(cover ? ["-i", cover, "-map", "0:a:0", "-map", "1:v:0", "-c:v", "mjpeg", "-disposition:v:0", "attached_pic", "-metadata:s:v", "comment=Cover (front)"] : ["-map", "0:a:0"]),
      ...enc.args, ...meta, ...(enc.ext === "m4a" ? ["-movflags", "+faststart"] : []), outFile];
  }
  const p = run(FFMPEG, args);
  job.child = run.lastChild;
  await p;
  for (const f of fs.readdirSync(job.dir)) if (path.join(job.dir, f) !== outFile) rmrf(path.join(job.dir, f));
  return outFile;
}

async function trimLocal(job, file, { exact = false } = {}) {
  const { start, end } = job.opts.section;
  const isVideo = job.opts.mode === "video";
  job.update({ stage: "Trimming to selected section…", percent: 100, speed: null, eta: null });
  const ext = path.extname(file);
  const out = file.slice(0, -ext.length) + ".trim" + ext;
  const range = ["-ss", String(start), ...(end !== null ? ["-to", String(end)] : [])];
  const args = isVideo
    // Input seeking for video (keyframe-based with copy; exact when re-encoding).
    ? ["-y", "-hide_banner", "-loglevel", "error", ...range, "-i", file, "-map", "0:v:0", "-map", "0:a:0?",
       ...(job.opts.preciseCut || exact ? ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "192k"] : ["-c", "copy"]),
       "-map_chapters", "-1", "-avoid_negative_ts", "make_zero", out]
    // Audio: input seeking on a local file is frame-accurate (~20ms) and, unlike output seeking,
    // keeps the single-frame cover art (mp3) along with the tags.
    : ["-y", "-hide_banner", "-loglevel", "error", ...range, "-i", file, "-map", "0:a:0", "-map", "0:v?", "-c", "copy", "-map_metadata", "0", "-map_chapters", "-1", out];
  const p = run(FFMPEG, args);
  job.child = run.lastChild;
  await p;
  if (job.cancelled) throw new Error("Cancelled.");
  fs.unlinkSync(file);
  fs.renameSync(out, file);
  return file;
}

async function reencode(job, file) {
  const preset = ENCODE_PRESETS[job.opts.encoding];
  const info = await probe(file);
  const alreadyH264 = info.vcodec === "h264" && (!info.acodec || info.acodec === "aac");
  if (job.opts.encoding === "h264" && alreadyH264 && file.endsWith(".mp4")) return file;

  const out = file.replace(/\.[^.]+$/, "") + (job.opts.encoding === "compressed" ? " (compressed).mp4" : " (h264).mp4");
  job.update({ stage: job.opts.encoding === "compressed" ? "Compressing (H.264)…" : "Re-encoding to H.264…", percent: 0, speed: null, eta: null });
  const started = Date.now();
  const onLine = (line) => {
    const m = /^out_time_us=(\d+)/.exec(line);
    if (!m || !info.duration) return;
    const secs = Number(m[1]) / 1e6;
    const pct = Math.min(100, (secs / info.duration) * 100);
    const elapsed = (Date.now() - started) / 1000;
    const eta = pct > 1 ? Math.round(elapsed * (100 - pct) / pct) : null;
    job.update({ percent: pct, eta });
  };
  const p = run(FFMPEG, [
    "-y", "-hide_banner", "-nostats", "-progress", "pipe:1", "-i", file,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-c:v", "libx264", "-preset", preset.preset, "-crf", preset.crf, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", preset.audio, "-movflags", "+faststart", out,
  ], { onLine });
  job.child = run.lastChild;
  await p;
  if (job.cancelled) throw new Error("Cancelled.");
  fs.unlinkSync(file);
  return out;
}

function findOutput(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => /\.(mp4|mkv|webm|mp3|m4a|opus|flac|wav|ogg|aac)$/i.test(f))
    .filter((f) => !/\.f\d+[^.]*\.\w+$/.test(f) && !/\.temp\.\w+$/.test(f)) // skip un-merged / temp streams
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).isFile());
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return files[0] || null;
}

function dirSize(dir) {
  try { return fs.readdirSync(dir).reduce((n, f) => { try { return n + fs.statSync(path.join(dir, f)).size; } catch { return n; } }, 0); }
  catch { return 0; }
}

function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = {
  checkDependencies, getInfo, createJob, getJob, normalizeUrl,
  VIDEO_HEIGHTS, VIDEO_CONTAINERS, VIDEO_ENCODINGS, AUDIO_FORMATS, AUDIO_BITRATES, DOWNLOAD_DIR,
};
