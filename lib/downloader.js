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
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
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

// useSections: let yt-dlp fetch only the selected range (saves bandwidth on big videos).
function buildYtdlpArgs(url, opts, dir, useSections) {
  const args = [
    ...YTDLP_BASE_ARGS,
    "--no-playlist", "--newline", "--no-warnings", "--no-mtime",
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
    const sort = [];
    if (opts.height !== "best") sort.push(`res:${opts.height}`);
    if (opts.encoding !== "original") sort.push("vcodec:h264", "acodec:aac"); // avoid a re-encode when possible
    else if (opts.container === "mp4") sort.push("ext:mp4:m4a");
    else if (opts.container === "webm") sort.push("ext:webm:webm");
    args.push("-f", "bv*+ba/b");
    if (sort.length) args.push("-S", sort.join(","));
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
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.cancelled = true;
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
      if (t && sectionLen) {
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

    const download = async (useSections) => {
      const p = run(YTDLP, buildYtdlpArgs(job.url, job.opts, job.dir, useSections), { onLine });
      job.child = run.lastChild;
      await p;
      if (job.cancelled) throw new Error("Cancelled.");
      const f = findOutput(job.dir);
      if (!f) throw new Error("Download finished but no output file was found.");
      return f;
    };

    // Audio is small: always fetch it whole and trim locally (exact, and immune to unseekable streams).
    // Video: fetch just the range; if the stream wasn't seekable the cut silently fails, so verify it
    // and fall back to a full download + local trim.
    let file;
    if (sec && isVideo) {
      file = await download(true);
      if (sectionLen) {
        const got = (await probe(file)).duration;
        if (got > sectionLen + 2) {
          job.update({ stage: "Stream isn't seekable, downloading full video to trim…", percent: 0 });
          for (const f of fs.readdirSync(job.dir)) rmrf(path.join(job.dir, f));
          fullForTrim = true; part = 0;
          // Unseekable streams usually have sparse keyframes too, so cut exactly (re-encode).
          file = await trimLocal(job, await download(false), { exact: true });
        }
      }
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
