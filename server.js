"use strict";

// YT Music Local: helper server + Spicetify extension in a single file.
//
//   node server.js              Start the helper server (wraps yt-dlp).
//   node server.js --install    Install the Spicetify extension and, on Linux,
//                               register the server as a systemd user service
//                               so that it starts automatically at login.
//
// No npm dependencies. Requires: node, yt-dlp, ffmpeg, spicetify.

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

const EXTENSION_FILE = "ytm-local.js";
const SERVICE_NAME = "ytm-local.service";

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const URL_ID_RE = /(?:youtube\.com\/watch\?[^#]*\bv=|youtu\.be\/)([A-Za-z0-9_-]{11})/;

// ---------------------------------------------------------------------------
// Spicetify extension
//
// IMPORTANT: this function is NOT executed by Node. It is serialized with
// Function.prototype.toString() and written to the Spicetify Extensions
// folder by "--install", then runs inside Spotify. Do not reference any
// variable from the surrounding Node scope; pass values as arguments.
// ---------------------------------------------------------------------------
async function ytmLocalExtension(defaultPort) {
  // Wait until Spicetify APIs are ready.
  while (
    !window.Spicetify ||
    !Spicetify.PopupModal ||
    !Spicetify.showNotification ||
    !(Spicetify.Topbar?.Button || Spicetify.Playbar?.Button)
  ) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const PORT_KEY = "ytmLocalPort";
  const DEFAULT_PORT = defaultPort;
  const getPort = () => {
    const n = Number(Spicetify.LocalStorage.get(PORT_KEY));
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
  };
  const getServer = () => `http://127.0.0.1:${getPort()}`;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    const { style, ...rest } = props;
    Object.assign(node, rest);
    if (style) Object.assign(node.style, style);
    for (const c of children) {
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function formatDuration(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  async function api(pathname, options) {
    let res;
    try {
      res = await fetch(getServer() + pathname, options);
    } catch (e) {
      throw new Error(
        "Unable to connect to the server. Please make sure the helper server is running (node server.js)."
      );
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // Try to find the downloaded file in Spotify's local files and return its URI.
  // Spotify may need some time to notice new files, so poll for a while.
  async function findLocalTrackUri(title, tries = 6, intervalMs = 2000) {
    const localApi = Spicetify.Platform?.LocalFilesAPI;
    if (!localApi || typeof localApi.getTracks !== "function") return null;

    const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const want = norm(title);
    if (!want) return null;

    for (let i = 0; i < tries; i++) {
      try {
        const tracks = await localApi.getTracks();
        const hit = (tracks || []).find((t) => {
          const name = norm(t.name);
          return name && (name === want || name.includes(want) || want.includes(name));
        });
        if (hit && hit.uri) return hit.uri;
      } catch (e) {
        console.warn("[ytm-local] LocalFilesAPI.getTracks failed", e);
      }
      await sleep(intervalMs);
    }
    return null;
  }

  async function downloadItem(item, button, status) {
    button.disabled = true;
    button.textContent = "Downloading...";
    status.textContent = "";
    try {
      const result = await api("/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      button.textContent = "Saved";
      Spicetify.showNotification(`Saved: ${result.file}`);

      const uri = await findLocalTrackUri(result.title || item.title);
      if (uri) {
        await Spicetify.addToQueue([{ uri }]);
        Spicetify.showNotification("Added to the queue");
      } else {
        status.textContent =
          "Spotify hasn't recognized it yet. Please add it from your local files once it's recognized.";
      }
    } catch (e) {
      button.disabled = false;
      button.textContent = "Download";
      status.textContent = `Error: ${e.message}`;
    }
  }

  function renderResults(listEl, items, status) {
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(el("div", { style: { opacity: "0.7" } }, "Nothing was found."));
      return;
    }
    for (const item of items) {
      const button = el(
        "button",
        {
          className: "main-buttons-button main-button-secondary",
          style: { padding: "6px 14px", cursor: "pointer", flexShrink: "0" },
          onclick: () => downloadItem(item, button, status),
        },
        "Download"
      );
      const row = el(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "8px 0",
          },
        },
        el("img", {
          src: item.thumbnail,
          style: { width: "64px", height: "36px", objectFit: "cover", borderRadius: "4px" },
        }),
        el(
          "div",
          { style: { flex: "1", minWidth: "0" } },
          el(
            "div",
            {
              style: {
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              },
            },
            item.title
          ),
          el(
            "div",
            { style: { fontSize: "12px", opacity: "0.7" } },
            [item.artist, formatDuration(item.duration)].filter(Boolean).join(" / ")
          )
        ),
        button
      );
      listEl.append(row);
    }
  }

  function openModal() {
    const status = el("div", {
      style: { minHeight: "18px", fontSize: "12px", margin: "8px 0", opacity: "0.8" },
    });
    const list = el("div", { style: { maxHeight: "50vh", overflowY: "auto" } });
    const input = el("input", {
      type: "text",
      placeholder: "Song title, artist name, or YouTube/YT Music URL",
      style: {
        flex: "1",
        padding: "8px 12px",
        borderRadius: "4px",
        border: "none",
        background: "var(--spice-card)",
        color: "var(--spice-text)",
      },
    });

    const doSearch = async () => {
      const q = input.value.trim();
      if (!q) return;
      status.textContent = "Searching...";
      list.replaceChildren();
      try {
        const data = await api(`/search?q=${encodeURIComponent(q)}`);
        status.textContent = "";
        renderResults(list, data.results, status);
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    };

    const searchButton = el(
      "button",
      {
        className: "main-buttons-button main-button-primary",
        style: { padding: "8px 18px", cursor: "pointer" },
        onclick: doSearch,
      },
      "Search"
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });

    // Port setting: must match YTM_PORT of the helper server.
    const portInput = el("input", {
      type: "number",
      min: "1",
      max: "65535",
      value: String(getPort()),
      style: {
        width: "90px",
        padding: "4px 8px",
        borderRadius: "4px",
        border: "none",
        background: "var(--spice-card)",
        color: "var(--spice-text)",
      },
    });
    portInput.addEventListener("change", () => {
      const n = Number(portInput.value);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        portInput.value = String(getPort());
        status.textContent = "Please specify a port number as an integer between 1 and 65535.";
        return;
      }
      Spicetify.LocalStorage.set(PORT_KEY, String(n));
      status.textContent = `The port has been changed to ${n}.`;
    });
    const portRow = el(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          marginTop: "12px",
          fontSize: "12px",
          opacity: "0.8",
        },
      },
      "Server Port:",
      portInput
    );

    const root = el(
      "div",
      { style: { color: "var(--spice-text)" } },
      el("div", { style: { display: "flex", gap: "8px" } }, input, searchButton),
      status,
      list,
      portRow
    );

    Spicetify.PopupModal.display({
      title: "Added from YouTube Music",
      content: root,
      isLarge: true,
    });
    setTimeout(() => input.focus(), 100);
  }

  // LocalFilesAPI.getIsEnabled / setIsEnabled exist in Spotify's client, but their
  // signatures are undocumented. Assume a boolean result and treat anything else
  // as "unknown" (no prompt shown).
  let enableDeclined = false;

  async function isLocalFilesEnabled() {
    const localApi = Spicetify.Platform?.LocalFilesAPI;
    if (!localApi || typeof localApi.getIsEnabled !== "function") return null;
    try {
      const v = await localApi.getIsEnabled();
      return typeof v === "boolean" ? v : null;
    } catch (e) {
      console.warn("[ytm-local] LocalFilesAPI.getIsEnabled failed", e);
      return null;
    }
  }

  // Returns true / false when the registration state is known, otherwise null.
  // The shape of getSources() is undocumented, so match the path in its JSON form.
  async function isSourceRegistered(dir) {
    const localApi = Spicetify.Platform?.LocalFilesAPI;
    if (!dir || !localApi || typeof localApi.getSources !== "function") return null;
    try {
      // getSources() returns { defaultSources: [], folders: [] }.
      const sources = await localApi.getSources();
      const folders = sources?.folders ?? sources;
      const needle = JSON.stringify(dir).slice(1, -1);
      return JSON.stringify(folders).includes(needle);
    } catch (e) {
      console.warn("[ytm-local] LocalFilesAPI.getSources failed", e);
      return null;
    }
  }

  async function getDownloadDir() {
    try {
      const health = await api("/health");
      return health.dir || null;
    } catch {
      return null;
    }
  }

  function showSetupDialog(needEnable, needSource, dir) {
    const tasks = [];
    if (needEnable) tasks.push(`Enable "Show Local Files" on Spotify`);
    if (needSource) tasks.push(`Add the destination folder ${dir} to the local file sources`);

    const message = el(
      "div",
      { style: { lineHeight: "1.5" } },
      "To play the downloaded songs, follow these steps.",
      el(
        "ul",
        { style: { margin: "8px 0 0 20px", listStyle: "disc" } },
        ...tasks.map((t) => el("li", {}, t))
      )
    );
    const note = el("div", {
      style: { minHeight: "18px", fontSize: "12px", margin: "12px 0", opacity: "0.8" },
    });

    const okButton = el(
      "button",
      {
        className: "main-buttons-button main-button-primary",
        style: { padding: "8px 18px", cursor: "pointer" },
        onclick: async () => {
          okButton.disabled = true;
          note.textContent = "";
          try {
            const localApi = Spicetify.Platform.LocalFilesAPI;
            if (needEnable) {
              await localApi.setIsEnabled(true);
              await sleep(300);
              if ((await isLocalFilesEnabled()) === false) {
                throw new Error("Unable to enable local files.");
              }
            }
            if (needSource) {
              // addFolder expects an object: { path }
              await localApi.addFolder({ path: dir });
              await sleep(300);
              if ((await isSourceRegistered(dir)) === false) {
                throw new Error(
                  `The folder could not be added automatically. Please manually add the following path from the local files in Settings: ${dir}`
                );
              }
            }
            Spicetify.showNotification("The local file configuration is complete.");
            openModal();
          } catch (e) {
            okButton.disabled = false;
            note.textContent = `Error: ${e.message}`;
          }
        },
      },
      "Set"
    );
    const cancelButton = el(
      "button",
      {
        className: "main-buttons-button main-button-secondary",
        style: { padding: "8px 18px", cursor: "pointer" },
        onclick: () => {
          enableDeclined = true;
          openModal();
        },
      },
      "Continue as is"
    );

    Spicetify.PopupModal.display({
      title: "Local File Settings",
      content: el(
        "div",
        { style: { color: "var(--spice-text)" } },
        message,
        note,
        el("div", { style: { display: "flex", gap: "8px" } }, okButton, cancelButton)
      ),
    });
  }

  async function onButtonClick() {
    if (!enableDeclined) {
      const needEnable = (await isLocalFilesEnabled()) === false;
      const dir = await getDownloadDir();
      const needSource = (await isSourceRegistered(dir)) === false;
      if (needEnable || needSource) {
        showSetupDialog(needEnable, needSource, dir);
        return;
      }
    }
    openModal();
  }

  const ButtonClass = Spicetify.Topbar?.Button || Spicetify.Playbar.Button;
  new ButtonClass("YT Music Local", "download", onButtonClick);
}

function buildExtensionSource() {
  return [
    "// NAME: YT Music Local",
    "// AUTHOR: kagamiomochi",
    "// DESCRIPTION: Search YouTube Music, download via a local yt-dlp server, and play as Spotify local files.",
    "// Generated by server.js --install. Edit server.js instead of this file.",
    "",
    `(${ytmLocalExtension.toString()})(${PORT});`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// Run a command with an argument array (no shell, so no injection).
// Resolves with { code, out, err } even when the exit code is not zero.
// Rejects only when the command cannot be started.
function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) =>
      reject(new Error(`failed to start ${cmd}: ${e.message}`))
    );
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// Run yt-dlp and reject on a non-zero exit code.
async function runYtDlp(args) {
  let r;
  try {
    r = await runCommand(YTDLP, args);
  } catch (e) {
    throw new Error(`failed to start yt-dlp (${YTDLP}): ${e.message}`);
  }
  if (r.code === 0) return r.out;
  throw new Error(r.err.trim() || `yt-dlp exited with code ${r.code}`);
}

// ---------------------------------------------------------------------------
// Search / download
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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

function createServer() {
  return http.createServer(async (req, res) => {
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
}

// Warn (but do not exit) when a required external tool is missing.
async function checkDependencies() {
  const tools = [
    [YTDLP, ["--version"]],
    ["ffmpeg", ["-version"]],
  ];
  for (const [cmd, args] of tools) {
    try {
      const r = await runCommand(cmd, args);
      if (r.code !== 0) console.warn(`warning: "${cmd}" exited with code ${r.code}`);
    } catch {
      console.warn(`warning: "${cmd}" was not found in PATH. Downloads will fail until it is installed.`);
    }
  }
}

async function startServer() {
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  await checkDependencies();

  const server = createServer();
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. Is the server already running?`);
    } else {
      console.error(e);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`ytm-local server: http://${HOST}:${PORT}`);
    console.log(`download dir: ${MUSIC_DIR}`);
  });
}

// ---------------------------------------------------------------------------
// Installer (--install)
// ---------------------------------------------------------------------------

async function getExtensionsDir() {
  // Ask spicetify first, because the location can be customized.
  try {
    const r = await runCommand("spicetify", ["path", "userdata"]);
    const base = r.out.trim().split("\n")[0];
    if (r.code === 0 && base) return path.join(base, "Extensions");
  } catch {
    // spicetify is not in PATH; fall back to the default location below.
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "spicetify", "Extensions");
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(config, "spicetify", "Extensions");
}

async function installExtension() {
  const dir = await getExtensionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, EXTENSION_FILE);
  fs.writeFileSync(dest, buildExtensionSource(), "utf8");
  console.log(`[extension] written: ${dest}`);

  try {
    const cfg = await runCommand("spicetify", ["config", "extensions", EXTENSION_FILE]);
    if (cfg.code !== 0) throw new Error(cfg.err.trim() || cfg.out.trim());
    console.log("[extension] registered in spicetify config");

    const apply = await runCommand("spicetify", ["apply"]);
    if (apply.code !== 0) {
      throw new Error(
        (apply.err.trim() || apply.out.trim()) +
          '\nIf this is the first time, try "spicetify backup apply".'
      );
    }
    console.log("[extension] spicetify apply finished");
  } catch (e) {
    console.warn(`[extension] could not finish automatically: ${e.message}`);
    console.warn(`Run manually:\n  spicetify config extensions ${EXTENSION_FILE}\n  spicetify apply`);
  }
}

// systemd unit values: "%" must be escaped, and arguments are double-quoted.
function unitQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

async function installService() {
  if (process.platform !== "linux") {
    console.log("[service] skipped (systemd user service is Linux only)");
    return;
  }
  const unitDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "systemd",
    "user"
  );

  // User services get a minimal PATH, so pass the current PATH to find yt-dlp / ffmpeg.
  const env = [`PATH=${process.env.PATH || ""}`];
  for (const key of ["YTM_PORT", "YTM_DIR", "YTDLP_PATH", "YTM_ALLOWED_ORIGIN_SUFFIX"]) {
    if (process.env[key]) env.push(`${key}=${process.env[key]}`);
  }

  const unit = [
    "[Unit]",
    "Description=YT Music Local helper server",
    "",
    "[Service]",
    `ExecStart=${unitQuote(process.execPath)} ${unitQuote(__filename)}`,
    ...env.map((e) => `Environment=${unitQuote(e)}`),
    "Restart=on-failure",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  fs.mkdirSync(unitDir, { recursive: true });
  const dest = path.join(unitDir, SERVICE_NAME);
  fs.writeFileSync(dest, unit, "utf8");
  console.log(`[service] written: ${dest}`);

  try {
    for (const args of [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", SERVICE_NAME],
    ]) {
      const r = await runCommand("systemctl", args);
      if (r.code !== 0) throw new Error(r.err.trim() || `systemctl ${args.join(" ")} failed`);
    }
    console.log("[service] enabled and started (systemctl --user status ytm-local)");
  } catch (e) {
    console.warn(`[service] could not finish automatically: ${e.message}`);
    console.warn(`Run manually:\n  systemctl --user daemon-reload\n  systemctl --user enable --now ${SERVICE_NAME}`);
  }
}

async function install() {
  await installExtension();
  await installService();
  console.log("Done. Restart Spotify if the extension does not show up.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.argv.includes("--install")) {
  install().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  startServer();
}
