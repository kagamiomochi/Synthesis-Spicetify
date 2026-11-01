"use strict";

// Local helper server for the Spicetify extension "ytm-local".
// It wraps yt-dlp to search YouTube and download audio into a folder
// that Spotify is configured to read as a "Local Files" source.
// No npm dependencies. Requires: node, yt-dlp, ffmpeg.

const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = Number(process.env.YTM_PORT || 8765);
const HOST = "127.0.0.1";

// Default download location: a per-user folder inside the home directory.
// The extension asks this server for the path and registers it in Spotify,
// so the path does not need to be the same for every user.
const MUSIC_DIR =
  process.env.YTM_DIR || path.join(os.homedir(), "Music", "YTMusic");
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Only browser origins whose hostname ends with this suffix may call the API.
const ALLOWED_ORIGIN_SUFFIX =
  process.env.YTM_ALLOWED_ORIGIN_SUFFIX || ".spotify.com";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const URL_ID_RE = /(?:youtube\.com\/watch\?[^#]*\bv=|youtu\.be\/)([A-Za-z0-9_-]{11})/;

fs.mkdirSync(MUSIC_DIR, { recursive: true });

// Run yt-dlp with an argument array (no shell, so no injection).
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`failed to start yt-dlp (${YTDLP}): ${e.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function toResult(e) {
  return {
    id: e.id,
    title: e.track || e.title || "",
    artist: e.artist || e.channel || e.uploader || "",
    duration: e.duration || 0,
    thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
  };
}

async function search(query) {
  const q = String(query || "").trim().slice(0, 200);
  if (!q) return [];

  // A pasted YouTube / YouTube Music URL resolves to a single item.
  const m = q.match(URL_ID_RE);
  if (m) {
    const out = await runYtDlp([
      "--no-playlist",
      "--skip-download",
      "--dump-json",
      "--no-warnings",
      `https://www.youtube.com/watch?v=${m[1]}`,
    ]);
    return [toResult(JSON.parse(out.trim().split("\n")[0]))];
  }

  const out = await runYtDlp([
    "--flat-playlist",
    "--dump-json",
    "--no-warnings",
    `ytsearch10:${q}`,
  ]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => toResult(JSON.parse(line)));
}

// Downloads are serialized so that several clicks do not overload the machine.
let downloadChain = Promise.resolve();
function enqueue(task) {
  const p = downloadChain.then(task);
  downloadChain = p.catch(() => {});
  return p;
}

function download(id) {
  return enqueue(async () => {
    const template = path.join(
      MUSIC_DIR,
      "%(artist,channel,uploader)s - %(track,title)s.%(ext)s"
    );
    const out = await runYtDlp([
      "--no-playlist",
      "--no-simulate",
      "--no-warnings",
      "-x",
      "--audio-format",
      "mp3",
      "--audio-quality",
      "0",
      "--embed-metadata",
      "--embed-thumbnail",
      "--convert-thumbnails",
      "jpg",
      "-o",
      template,
      // --print implies --quiet, so stdout only contains these two lines.
      "--print",
      "after_move:filepath",
      "--print",
      "after_move:%(track,title)s",
      `https://www.youtube.com/watch?v=${id}`,
    ]);
    const lines = out.trim().split("\n");
    const file = lines[0] || "";
    return { file: path.basename(file), path: file, title: lines[1] || "" };
  });
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients such as curl
  try {
    return new URL(origin).hostname.endsWith(ALLOWED_ORIGIN_SUFFIX);
  } catch {
    return false;
  }
}

function isAllowedHost(host) {
  // Basic protection against DNS rebinding.
  return host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;

  if (!isAllowedHost(req.headers.host || "")) {
    return send(res, 403, { error: "forbidden host" });
  }
  if (!isAllowedOrigin(origin)) {
    return send(res, 403, { error: "forbidden origin" });
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { ok: true, dir: MUSIC_DIR });
    }

    if (req.method === "GET" && url.pathname === "/search") {
      const results = await search(url.searchParams.get("q"));
      return send(res, 200, { results });
    }

    if (req.method === "POST" && url.pathname === "/download") {
      const body = await readJsonBody(req);
      if (!VIDEO_ID_RE.test(String(body.id || ""))) {
        return send(res, 400, { error: "invalid video id" });
      }
      const result = await download(body.id);
      return send(res, 200, result);
    }

    return send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ytm-local server: http://${HOST}:${PORT}`);
  console.log(`download dir: ${MUSIC_DIR}`);
});
