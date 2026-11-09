require("dotenv").config();
const express = require("express");
const path = require("path");
const dl = require("./lib/downloader");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "localhost";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.json({ limit: "16kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- Pages ----------
app.get("/", (req, res) => res.render("index", { page: "home" }));
app.get("/dashboard", (req, res) => res.render("dashboard", { page: "dashboard", googleClientId: GOOGLE_CLIENT_ID }));

// ---------- Downloader API ----------
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(400).json({ error: e.message || "Something went wrong." });
});

app.get("/api/health", wrap(async (req, res) => {
  res.json({ ok: true, deps: await dl.checkDependencies() });
}));

app.post("/api/info", wrap(async (req, res) => {
  res.json(await dl.getInfo(req.body && req.body.url));
}));

app.post("/api/jobs", wrap(async (req, res) => {
  const { url, ...opts } = req.body || {};
  const job = dl.createJob(url, opts);
  res.status(201).json({ id: job.id, opts: job.opts });
}));

app.get("/api/jobs/:id/events", (req, res) => {
  const job = dl.getJob(req.params.id);
  if (!job) return res.status(404).end();
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  let last = 0;
  const send = (state, force) => {
    const now = Date.now();
    if (!force && state.status === "running" && now - last < 250) return; // throttle
    last = now;
    res.write(`data: ${JSON.stringify(state)}\n\n`);
  };
  const onUpdate = (s) => send(s, s.status !== "running");
  send(job.state, true);
  job.on("update", onUpdate);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(ping); job.off("update", onUpdate); });
});

app.get("/api/jobs/:id/file", (req, res) => {
  const job = dl.getJob(req.params.id);
  if (!job || !job.file) return res.status(404).send("File not found or expired.");
  res.download(job.file, path.basename(job.file));
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = dl.getJob(req.params.id);
  if (job) job.cancel();
  res.json({ ok: true });
});

const server = app.listen(PORT, HOST, async () => {
  console.log(`YoutubeUtilityManager running at http://${HOST}:${PORT}`);
  const deps = await dl.checkDependencies();
  if (!deps["yt-dlp"] || !deps.ffmpeg) {
    console.warn("⚠️  Missing dependencies:", deps, "\n   Install with: brew install yt-dlp ffmpeg");
  } else {
    console.log(`yt-dlp ${deps["yt-dlp"]} · ${deps.ffmpeg.split(" ").slice(0, 3).join(" ")}`);
  }
  if (!GOOGLE_CLIENT_ID) console.warn("ℹ️  GOOGLE_CLIENT_ID not set — dashboard sign-in disabled (see .env.example).");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌ Port ${PORT} is already in use. Stop the other process (lsof -nP -iTCP:${PORT} -sTCP:LISTEN) or run with PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
});
