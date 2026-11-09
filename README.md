# YoutubeUtilityManager

A set of YouTube tools that runs locally:

- **Downloader** (home page). Paste a link and download in full quality.
  - **Video:** Best / 8K / 4K / 2K (1440p) / 1080p / 720p / 480p / 360p…, depending on what the video offers
  - **Encoding:** original streams (lossless merge, fastest), H.264/AAC (plays everywhere), or compressed (H.264 CRF 28, smaller)
  - **Container:** MP4, MKV or WebM
  - **Audio only:** MP3 (with cover art), M4A/AAC, Opus, FLAC, WAV, or the original stream; 96–320 kbps
  - **Section / duration selection:** download just part of a video or track (start/end slider or typed times like `1:23`, with an in-page preview). Audio cuts are exact. Video cuts snap to keyframes unless you tick "frame-accurate"
  - Live progress (speed and ETA), cancel, and files auto-deleted after 1 hour
- **Dashboard** (`/dashboard`, needs Google sign-in). Includes the **Mass Comment Reply** tool: scan a video's comments, filter by keyword, skip threads you already replied to, pick which ones to answer, and reply to all of them.

## Requirements

- Node.js 18+
- Python 3.10+, used only to install [yt-dlp](https://github.com/yt-dlp/yt-dlp) into a local `.venv`
- A JavaScript runtime for yt-dlp's YouTube challenge solver: **Node 20+** or [deno](https://deno.com). Without one, YouTube hides most HD/4K formats. The app picks one automatically, in this order:
  1. `JS_RUNTIME` from `.env`
  2. `./bin/deno`
  3. the Node running the server, if it's v20+
  4. the newest Node 20+ installed with nvm

You don't need to install ffmpeg. It comes with the npm dependencies (`ffmpeg-static`, `ffprobe-static`).

## Run

```bash
npm install            # also runs `npm run setup`: creates .venv with yt-dlp, links ffmpeg into ./bin
cp .env.example .env   # optional; only needed for the dashboard sign-in
npm start              # or: npm run dev (auto-restart)
```

YouTube changes often, and an outdated yt-dlp is the most common reason downloads break. To update it:

```bash
npm run setup -- --update
```

Open http://localhost:3000.

## Dashboard sign-in setup

1. In [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API v3**.
2. Go to **Credentials → Create credentials → OAuth client ID → Web application**.
3. Add `http://localhost:3000` to **Authorized JavaScript origins**.
4. Put the client ID in `.env` as `GOOGLE_CLIENT_ID=...` and restart.

Sign-in uses Google Identity Services. The old `gapi.auth2` library was shut down by Google.

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/info` | `{ url }` → title, thumbnail, duration, available qualities |
| `POST` | `/api/jobs` | `{ url, mode: "video", height, encoding, container }` or `{ url, mode: "audio", audioFormat, audioBitrate }`, plus optional `start` / `end` (seconds or `"mm:ss"`) and `preciseCut` → `{ id }` |
| `GET` | `/api/jobs/:id/events` | Server-sent events with progress |
| `GET` | `/api/jobs/:id/file` | Download the finished file |
| `DELETE` | `/api/jobs/:id` | Cancel a job |

The download engine in `lib/downloader.js` doesn't depend on any framework. `createJob(url, opts, { maxHeight })` accepts a server-side resolution cap, so a host app can set limits by plan (e.g. free users get 720p).

## Legal

Only download videos you own or have permission to use, and follow YouTube's Terms of Service.
