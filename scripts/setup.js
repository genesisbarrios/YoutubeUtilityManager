#!/usr/bin/env node
// Local tool setup (runs on `npm install`, or manually with `npm run setup`):
//  - yt-dlp: installed with pip into ./.venv  (`yt-dlp[default]` includes the YouTube JS challenge solver)
//  - ffmpeg/ffprobe: npm static builds, linked into ./bin so yt-dlp finds both
// `npm run setup -- --update` upgrades yt-dlp (do this whenever YouTube downloads start failing).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin");
const VENV = path.join(ROOT, ".venv");
const win = process.platform === "win32";
const exe = win ? ".exe" : "";
const venvBin = path.join(VENV, win ? "Scripts" : "bin");
const update = process.argv.includes("--update");

function findPython() {
  const candidates = [process.env.PYTHON, "python3.14", "python3.13", "python3.12", "python3.11", "python3.10", "python3", "python"].filter(Boolean);
  for (const py of candidates) {
    try {
      const v = execFileSync(py, ["-c", "import sys;print('%d.%d'%sys.version_info[:2])"]).toString().trim();
      const [maj, min] = v.split(".").map(Number);
      if (maj === 3 && min >= 10) return py;
    } catch { /* try next */ }
  }
  return null;
}

function setupYtdlp() {
  const ytdlp = path.join(venvBin, "yt-dlp" + exe);
  if (fs.existsSync(ytdlp) && !update) return;
  const py = findPython();
  if (!py) { console.warn("⚠ Python 3.10+ not found. Install it, or install yt-dlp yourself and set YTDLP_PATH."); return; }
  if (!fs.existsSync(venvBin)) {
    console.log("• creating .venv with", py);
    execFileSync(py, ["-m", "venv", VENV], { stdio: "inherit" });
  }
  console.log("• pip install -U yt-dlp[default]");
  execFileSync(path.join(venvBin, "python" + exe), ["-m", "pip", "install", "-q", "-U", "yt-dlp[default]"], { stdio: "inherit" });
}

function linkFfmpeg() {
  fs.mkdirSync(BIN, { recursive: true });
  const statics = [["ffmpeg", () => require("ffmpeg-static")], ["ffprobe", () => require("ffprobe-static").path]];
  for (const [name, resolve] of statics) {
    const dest = path.join(BIN, name + exe);
    let src;
    try { src = resolve(); } catch { console.warn(`⚠ ${name}-static not installed; will fall back to PATH`); continue; }
    if (!src || !fs.existsSync(src)) continue;
    fs.rmSync(dest, { force: true });
    try { fs.symlinkSync(src, dest); } catch { fs.copyFileSync(src, dest); fs.chmodSync(dest, 0o755); }
  }
}

try {
  if (!process.env.SKIP_BINARY_SETUP) {
    linkFfmpeg();
    setupYtdlp();
    console.log("✓ tools ready");
  }
} catch (e) {
  console.warn("⚠ Setup failed:", e.message, "\n  You can install yt-dlp + ffmpeg yourself and set YTDLP_PATH / FFMPEG_PATH in .env");
}
