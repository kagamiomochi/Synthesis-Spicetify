"use strict";

// YT Music Local: helper server + Spicetify extension in a single file.
//
//   node server.js              Start the helper server (wraps yt-dlp).
//   node server.js --install    Install the Spicetify extension and register
//                               the server so that it starts automatically:
//                                 Linux:   systemd user socket unit (started on
//                                          demand, exits after being idle)
//                                 macOS:   launchd LaunchAgent (runs at login)
//                                 Windows: Startup folder script (runs at login)
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
const SOCKET_NAME = "ytm-local.socket";
const LAUNCHD_LABEL = "io.github.kagamiomochi.ytm-local";
const WINDOWS_LAUNCHER = "ytm-local.vbs";
// Settings that are carried over from the --install environment to the server.
const PASSTHROUGH_ENV_KEYS = [
  "YTM_PORT",
  "YTM_DIR",
  "YTDLP_PATH",
  "YTM_ALLOWED_ORIGIN_SUFFIX",
];

// Socket activation: systemd passes the listening socket as fd 3.
const SOCKET_ACTIVATED =
  Number(process.env.LISTEN_FDS) >= 1 &&
  process.env.LISTEN_PID === String(process.pid);
// Exit after this many seconds without any request (0 disables). Defaults to
// 10 minutes when socket-activated, because systemd restarts the server on the
// next connection.
const IDLE_TIMEOUT_SEC =
  Number(process.env.YTM_IDLE_TIMEOUT ?? (SOCKET_ACTIVATED ? 600 : 0)) || 0;

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

  function renderResults(listEl, items, status, limit = Infinity) {
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(el("div", { style: { opacity: "0.7" } }, "Nothing was found."));
      return;
    }
    for (const item of items.slice(0, limit)) {
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

  // -------------------------------------------------------------------------
  // Integration with Spotify's built-in search page.
  //
  // Spotify's search page lives at /search/<query>. We watch the route, run the
  // same query against the helper server, and inject a "YouTube Music" section
  // at the top of the search results. The DOM of Spotify's search page is not a
  // public API, so the container lookup below may need adjusting after a
  // Spotify update.
  // -------------------------------------------------------------------------
  const SEARCH_SECTION_ID = "ytm-local-search-section";
  const SEARCH_DEBOUNCE_MS = 700;
  const SEARCH_VISIBLE_ROWS = 5;
  const searchCache = new Map();
  const searchState = { query: "", token: 0, timer: null, setupChecked: false };
  let searchSection = null;

  function getSearchQuery() {
    const pathname = Spicetify.Platform?.History?.location?.pathname || "";
    const m = pathname.match(/^\/search\/([^/]+)/);
    if (!m) return "";
    try {
      return decodeURIComponent(m[1]).trim();
    } catch {
      return "";
    }
  }

  function findSearchContainer() {
    return (
      document.querySelector(".main-view-container__scroll-node-child") ||
      document.querySelector("main")
    );
  }

  function createSearchSection() {
    const title = el(
      "h2",
      { style: { fontSize: "24px", fontWeight: "700", margin: "0 0 8px" } },
      "YouTube Music"
    );
    const status = el("div", {
      style: { minHeight: "18px", fontSize: "12px", margin: "4px 0", opacity: "0.8" },
    });
    const list = el("div");
    const moreButton = el(
      "button",
      {
        className: "main-buttons-button main-button-secondary",
        style: { padding: "6px 14px", cursor: "pointer", marginTop: "4px", display: "none" },
      },
      "Show more"
    );
    const root = el(
      "section",
      { id: SEARCH_SECTION_ID, style: { padding: "16px 32px 8px", color: "var(--spice-text)" } },
      title,
      status,
      list,
      moreButton
    );
    return { root, status, list, moreButton };
  }

  function mountSearchSection() {
    if (!searchSection) searchSection = createSearchSection();
    if (searchSection.root.isConnected) return true;
    const container = findSearchContainer();
    if (!container) return false;
    container.prepend(searchSection.root);
    return true;
  }

  function unmountSearchSection() {
    if (searchSection && searchSection.root.isConnected) searchSection.root.remove();
  }

  function showSearchResults(items) {
    const { list, status, moreButton } = searchSection;
    renderResults(list, items, status, SEARCH_VISIBLE_ROWS);
    if (items.length > SEARCH_VISIBLE_ROWS) {
      moreButton.style.display = "";
      moreButton.onclick = () => {
        renderResults(list, items, status);
        moreButton.style.display = "none";
      };
    } else {
      moreButton.style.display = "none";
    }
  }

  // Local file settings are only prompted for through the top bar button, so
  // point the user to it once instead of failing silently after a download.
  async function checkSetupHint() {
    if (searchState.setupChecked) return;
    searchState.setupChecked = true;
    const needEnable = (await isLocalFilesEnabled()) === false;
    const needSource = (await isSourceRegistered(await getDownloadDir())) === false;
    if (needEnable || needSource) {
      Spicetify.showNotification(
        'Local file settings are required. Click the "YT Music Local" button once to set them up.'
      );
    }
  }

  async function runSearchPageQuery(query, token) {
    try {
      let items = searchCache.get(query);
      if (!items) {
        const data = await api(`/search?q=${encodeURIComponent(query)}`);
        items = data.results;
        searchCache.set(query, items);
      }
      // Ignore the response if the user has already typed something else.
      if (token !== searchState.token || !mountSearchSection()) return;
      searchSection.status.textContent = "";
      showSearchResults(items);
      checkSetupHint();
    } catch (e) {
      if (token !== searchState.token || !mountSearchSection()) return;
      searchSection.list.replaceChildren();
      searchSection.moreButton.style.display = "none";
      searchSection.status.textContent = `Error: ${e.message}`;
    }
  }

  function onSearchRouteChange() {
    const query = getSearchQuery();
    if (!query) {
      clearTimeout(searchState.timer);
      searchState.query = "";
      searchState.token++;
      unmountSearchSection();
      return;
    }
    if (query === searchState.query) {
      // Same query: only make sure the section survived a re-render.
      mountSearchSection();
      return;
    }

    searchState.query = query;
    const token = ++searchState.token;
    clearTimeout(searchState.timer);
    // The container may not be rendered yet; the search below mounts it again.
    if (mountSearchSection()) {
      searchSection.list.replaceChildren();
      searchSection.moreButton.style.display = "none";
      searchSection.status.textContent = "Searching...";
    }
    // Spotify updates the URL while the user is typing, so debounce to avoid
    // spawning a yt-dlp process for every keystroke. Cached queries are instant.
    const delay = searchCache.has(query) ? 0 : SEARCH_DEBOUNCE_MS;
    searchState.timer = setTimeout(() => runSearchPageQuery(query, token), delay);
  }

  Spicetify.Platform?.History?.listen?.(onSearchRouteChange);
  // The search page can be rendered after the route change, and React may
  // replace the container, so also re-check periodically (cheap: no request is
  // sent unless the query changed).
  setInterval(onSearchRouteChange, 1000);
  onSearchRouteChange();

  const ButtonClass = Spicetify.Topbar?.Button || Spicetify.Playbar.Button;
  new ButtonClass("YT Music Local", "download", onButtonClick);
}

function buildExtensionSource() {
  return [
    "// NAME: YT Music Local",
    "// AUTHOR: kagamiomochi",
    "// DESCRIPTION: Search YouTube Music from the Spotify search page, download via a local yt-dlp server, and play as Spotify local files.",
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

// Exit when no request has been in flight for IDLE_TIMEOUT_SEC seconds.
function watchIdle(server) {
  if (IDLE_TIMEOUT_SEC <= 0) return;
  let active = 0;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.log(`idle for ${IDLE_TIMEOUT_SEC}s, exiting`);
      process.exit(0);
    }, IDLE_TIMEOUT_SEC * 1000);
  };
  server.on("request", (req, res) => {
    active++;
    clearTimeout(timer);
    // "close" fires on both normal completion and aborted connections.
    res.on("close", () => {
      if (--active === 0) arm();
    });
  });
  arm();
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
  watchIdle(server);
  const onListening = () => {
    console.log(`ytm-local server: http://${HOST}:${PORT}`);
    console.log(`download dir: ${MUSIC_DIR}`);
  };
  if (SOCKET_ACTIVATED) {
    server.listen({ fd: 3 }, onListening);
  } else {
    server.listen(PORT, HOST, onListening);
  }
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
  if (process.platform === "darwin") return installLaunchAgent();
  if (process.platform === "win32") return installWindowsStartup();
  if (process.platform !== "linux") {
    console.log(`[service] skipped (unsupported platform: ${process.platform})`);
    return;
  }
  const unitDir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "systemd",
    "user"
  );

  // Migrate from the old always-running service: disable it before the unit
  // file is overwritten. Failures are ignored (it may not exist).
  await runCommand("systemctl", ["--user", "disable", "--now", SERVICE_NAME]).catch(() => {});

  // User services get a minimal PATH, so pass the current PATH to find yt-dlp / ffmpeg.
  const env = [`PATH=${process.env.PATH || ""}`];
  // YTM_IDLE_TIMEOUT only makes sense here, where the socket restarts the server.
  for (const key of [...PASSTHROUGH_ENV_KEYS, "YTM_IDLE_TIMEOUT"]) {
    if (process.env[key]) env.push(`${key}=${process.env[key]}`);
  }

  // The service has no [Install] section: it is only started by the socket.
  const service = [
    "[Unit]",
    "Description=YT Music Local helper server",
    "Requires=" + SOCKET_NAME,
    "",
    "[Service]",
    `ExecStart=${unitQuote(process.execPath)} ${unitQuote(__filename)}`,
    ...env.map((e) => `Environment=${unitQuote(e)}`),
    "Restart=on-failure",
    "",
  ].join("\n");

  const socket = [
    "[Unit]",
    "Description=YT Music Local helper server (socket)",
    "",
    "[Socket]",
    `ListenStream=${HOST}:${PORT}`,
    "",
    "[Install]",
    "WantedBy=sockets.target",
    "",
  ].join("\n");

  fs.mkdirSync(unitDir, { recursive: true });
  const serviceDest = path.join(unitDir, SERVICE_NAME);
  const socketDest = path.join(unitDir, SOCKET_NAME);
  fs.writeFileSync(serviceDest, service, "utf8");
  fs.writeFileSync(socketDest, socket, "utf8");
  console.log(`[service] written: ${serviceDest}`);
  console.log(`[service] written: ${socketDest}`);

  try {
    for (const args of [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", SOCKET_NAME],
    ]) {
      const r = await runCommand("systemctl", args);
      if (r.code !== 0) throw new Error(r.err.trim() || `systemctl ${args.join(" ")} failed`);
    }
    console.log(`[service] socket enabled (systemctl --user status ${SOCKET_NAME})`);
    console.log("[service] the server starts on the first request and exits when idle");
  } catch (e) {
    console.warn(`[service] could not finish automatically: ${e.message}`);
    console.warn(`Run manually:\n  systemctl --user daemon-reload\n  systemctl --user enable --now ${SOCKET_NAME}`);
  }
}

// ---------------------------------------------------------------------------
// macOS: launchd LaunchAgent (starts at login, restarted on failure)
// ---------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function installLaunchAgent() {
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LAUNCHD_LABEL}.plist`
  );
  const logPath = path.join(os.homedir(), "Library", "Logs", "ytm-local.log");

  // launchd gives agents a minimal PATH, so pass the current PATH to find
  // yt-dlp / ffmpeg (for example the ones installed by Homebrew).
  const env = { PATH: process.env.PATH || "" };
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }

  const str = (v) => `<string>${xmlEscape(v)}</string>`;
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${str(LAUNCHD_LABEL)}`,
    "  <key>ProgramArguments</key>",
    `  <array>${str(process.execPath)}${str(__filename)}</array>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).map(([k, v]) => `    <key>${xmlEscape(k)}</key>${str(v)}`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    // Restart only when the server crashed (non-zero exit).
    "  <key>KeepAlive</key>",
    "  <dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardOutPath</key>${str(logPath)}`,
    `  <key>StandardErrorPath</key>${str(logPath)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist, "utf8");
  console.log(`[service] written: ${plistPath}`);

  const domain = `gui/${process.getuid()}`;
  try {
    // Unload a previous version first; failure is fine if it was not loaded.
    await runCommand("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    await new Promise((r) => setTimeout(r, 500));
    const r = await runCommand("launchctl", ["bootstrap", domain, plistPath]);
    if (r.code !== 0) throw new Error(r.err.trim() || "launchctl bootstrap failed");
    console.log(`[service] loaded and started (log: ${logPath})`);
  } catch (e) {
    console.warn(`[service] could not finish automatically: ${e.message}`);
    console.warn(`Run manually:\n  launchctl bootstrap ${domain} ${plistPath}`);
  }
}

// ---------------------------------------------------------------------------
// Windows: script in the Startup folder (starts at login, no console window)
// ---------------------------------------------------------------------------

async function installWindowsStartup() {
  const appData =
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dir = path.join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  const dest = path.join(dir, WINDOWS_LAUNCHER);

  // VBScript string literal: double quotes are escaped by doubling them.
  const vq = (s) => `"${String(s).replace(/"/g, '""')}"`;
  const lines = [
    'Set sh = CreateObject("WScript.Shell")',
    'Set env = sh.Environment("Process")',
  ];
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (process.env[key]) lines.push(`env(${vq(key)}) = ${vq(process.env[key])}`);
  }
  // Window style 0 = hidden, False = do not wait for the server to exit.
  lines.push(`sh.Run ${vq(`${vq(process.execPath)} ${vq(__filename)}`)}, 0, False`);

  fs.mkdirSync(dir, { recursive: true });
  // wscript reads scripts as ANSI unless there is a BOM, which would break
  // non-ASCII paths (for example a Japanese user name), so write UTF-16LE.
  fs.writeFileSync(
    dest,
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(lines.join("\r\n") + "\r\n", "utf16le"),
    ])
  );
  console.log(`[service] written: ${dest}`);

  try {
    // Start it now as well; the script itself returns immediately.
    const r = await runCommand("wscript.exe", [dest]);
    if (r.code !== 0) throw new Error(r.err.trim() || "wscript failed");
    console.log("[service] started (it will also start at every login)");
  } catch (e) {
    console.warn(`[service] could not start it now: ${e.message}`);
    console.warn(`It will start at the next login, or run:\n  node ${__filename}`);
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
