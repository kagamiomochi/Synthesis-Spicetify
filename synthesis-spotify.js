// NAME: Synthesis-Spotify
// AUTHOR: kagamiomochi
// DESCRIPTION: Search YouTube Music from Spotify, save tracks as MP3 local files and play them inside Spotify. No local server required.
// SOURCE: https://github.com/kagamiomochi/Synthesis-Spotify

(async function () {
  "use strict";

  /* VERSION */ const VERSION = "v0.3.3";
  (() => {
    try {
      for (const s of document.scripts) {
        if (/\/\* VERSION \*\/ const VERSION = "v\d+\.\d+\.\d+";/.test(s.textContent)) {
          const m = /\/\* VERSION \*\/ const VERSION = "([^"]+)";/.exec(s.textContent);
          if (m) VERSION = m[1];
          break;
        }
      }
    } catch {}
  })();

  // ===========================================================================
  // Part 1: Pure helpers (no Spicetify dependency, unit-testable in Node)
  // ===========================================================================

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    get(key) {
      try {
        return globalThis.Spicetify?.LocalStorage?.get(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        globalThis.Spicetify?.LocalStorage?.set(key, value);
      } catch {
        // Ignore storage errors.
      }
    },
  };

  const API_KEY_STORAGE = "synthesisSpotifyApiKey";
  const PIPED_URL_STORAGE = "synthesisSpotifyPipedUrl";
  const PIPED_LAST_GOOD_STORAGE = "synthesisSpotifyPipedLast";
  const PIPED_REGISTRY_STORAGE = "synthesisSpotifyPipedRegistry";

  // Search latency tuning.
  const PIPED_REGISTRY_TTL_MS = 6 * 60 * 60 * 1000; // Re-fetch the instance registry at most every 6 hours.
  const SEARCH_TIMEOUT_MS = 3500; // Per-instance timeout for search requests.
  const INSTANCE_COOLDOWN_MS = 5 * 60 * 1000; // Skip an instance for this long after it failed.
  const HEDGE_STEP_MS = 1500; // Each later backend joins the race this much after the previous one.

  const MP3_KBPS = 192;
  const MP3_SAMPLE_RATE = 44100;
  const MAX_DURATION_SEC = 20 * 60;
  const DEFAULT_ALBUM = "YouTube Music";
  const LAME_URLS = [
    "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js",
  ];

  const YOUTUBE_ID_RE =
    /(?:youtube\.com\/watch\?[^#&]*v=|youtu\.be\/|music\.youtube\.com\/watch\?[^#&]*v=)([A-Za-z0-9_-]{11})/;

  function extractVideoId(input) {
    const m = String(input).match(YOUTUBE_ID_RE);
    return m ? m[1] : null;
  }

  // Piped returns relative paths such as "/watch?v=XXXXXXXXXXX".
  function parseVideoIdFromPath(path) {
    const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(String(path || ""));
    return m ? m[1] : null;
  }

  // Auto-generated music channels are named "<Artist> - Topic".
  const cleanArtist = (name) => String(name || "").replace(/ - Topic$/, "").trim();

  function formatDuration(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60);
    const s = String(Math.floor(sec % 60)).padStart(2, "0");
    return `${m}:${s}`;
  }

  function sanitizeFileName(name) {
    return (
      String(name)
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .trim()
        .slice(0, 120) || "track"
    );
  }

  function buildFileName(item) {
    const base = [item.artist, item.title].filter(Boolean).join(" - ") || item.videoId;
    return `${sanitizeFileName(base)} [${item.videoId}].mp3`;
  }

  // "PT1H2M3S" -> seconds
  function parseIsoDuration(iso) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
    if (!m) return 0;
    const [, d, h, min, sec] = m.map((x) => Number(x || 0));
    return ((d * 24 + h) * 60 + min) * 60 + sec;
  }

  function decodeHtml(str) {
    const t = document.createElement("textarea");
    t.innerHTML = str;
    return t.value;
  }

  // ---------------------------------------------------------------------------
  // ID3v2.3 tag writer (UTF-16 text so that Japanese titles survive)
  // ---------------------------------------------------------------------------

  function concatBytes(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  function latin1Bytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function utf16leBytes(str) {
    const out = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      out[i * 2] = c & 0xff;
      out[i * 2 + 1] = c >> 8;
    }
    return out;
  }

  function detectImageMime(bytes) {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return "image/png";
    return null;
  }

  function id3Frame(id, payload) {
    const head = new Uint8Array(10);
    head.set(latin1Bytes(id), 0);
    new DataView(head.buffer).setUint32(4, payload.length); // v2.3: plain big-endian size
    return concatBytes([head, payload]);
  }

  function buildId3Tag({ title, artist, album, durationMs, cover }) {
    const frames = [];
    const text = (id, value) => {
      if (!value) return;
      frames.push(id3Frame(id, concatBytes([Uint8Array.of(0x01, 0xff, 0xfe), utf16leBytes(String(value))])));
    };
    text("TIT2", title);
    text("TPE1", artist);
    text("TPE2", artist);
    text("TALB", album);
    if (durationMs > 0) {
      frames.push(id3Frame("TLEN", concatBytes([Uint8Array.of(0x00), latin1Bytes(String(Math.round(durationMs)))])));
    }
    if (cover?.bytes?.length) {
      const mime = detectImageMime(cover.bytes);
      if (mime) {
        frames.push(
          id3Frame(
            "APIC",
            concatBytes([
              Uint8Array.of(0x00),
              latin1Bytes(mime),
              Uint8Array.of(0x00, 0x03, 0x00), // end of mime, picture type 3 (front cover), empty description
              cover.bytes,
            ])
          )
        );
      }
    }
    const body = concatBytes(frames);
    const size = body.length;
    const header = Uint8Array.of(
      0x49, 0x44, 0x33, // "ID3"
      0x03, 0x00, // version 2.3.0
      0x00, // flags
      (size >> 21) & 0x7f,
      (size >> 14) & 0x7f,
      (size >> 7) & 0x7f,
      size & 0x7f // syncsafe size
    );
    return concatBytes([header, body]);
  }

  // ---------------------------------------------------------------------------
  // MP3 encoding (lamejs, loaded lazily). Works in slices so the UI stays alive.
  // ---------------------------------------------------------------------------

  async function encodeMp3(audio, lame, { kbps = MP3_KBPS, onProgress } = {}) {
    const channels = Math.min(audio.numberOfChannels, 2);
    const encoder = new lame.Mp3Encoder(channels, audio.sampleRate, kbps);
    const left = audio.getChannelData(0);
    const right = channels === 2 ? audio.getChannelData(1) : null;
    const total = left.length;
    const SLICE = 1152 * 64;
    const out = [];

    const toInt16 = (src, start, end) => {
      const buf = new Int16Array(end - start);
      for (let i = start, j = 0; i < end; i++, j++) {
        const s = Math.max(-1, Math.min(1, src[i]));
        buf[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return buf;
    };

    for (let pos = 0; pos < total; pos += SLICE) {
      const end = Math.min(total, pos + SLICE);
      const l = toInt16(left, pos, end);
      const chunk = right ? encoder.encodeBuffer(l, toInt16(right, pos, end)) : encoder.encodeBuffer(l);
      if (chunk.length) out.push(new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)));
      onProgress?.(end / total);
      await sleep(0);
    }
    const tail = encoder.flush();
    if (tail.length) out.push(new Uint8Array(tail.buffer.slice(tail.byteOffset, tail.byteOffset + tail.byteLength)));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Piped client (public instances, CORS enabled, no local server needed)
  // ---------------------------------------------------------------------------

  const PIPED_LIST_URL = "https://piped-instances.kavin.rocks/";
  const PIPED_FALLBACK = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.leptons.xyz",
    "https://pipedapi.nosebs.ru",
    "https://pipedapi-libre.kavin.rocks",
    "https://piped-api.privacy.com.de",
    "https://pipedapi.adminforge.de",
    "https://api.piped.yt",
    "https://pipedapi.drgns.space",
    "https://pipedapi.owo.si",
    "https://pipedapi.ducks.party",
    "https://piped-api.codespace.cz",
    "https://pipedapi.reallyaweso.me",
    "https://api.piped.private.coffee",
    "https://pipedapi.darkness.services",
    "https://pipedapi.orangenet.cc",
  ];

  let pipedList = null;

  function normalizeBase(url) {
    const u = String(url || "").trim().replace(/\/+$/, "");
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[^\s]*)?$/.test(u) ? u : null;
  }

  async function fetchWithTimeout(url, { signal, timeout = 7000 } = {}) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function fetchJson(url, opts) {
    const res = await fetchWithTimeout(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function readRegistryCache() {
    try {
      const cached = JSON.parse(store.get(PIPED_REGISTRY_STORAGE) || "null");
      if (!Array.isArray(cached?.list)) return { list: [], fresh: false };
      return {
        list: cached.list.map(normalizeBase).filter(Boolean),
        fresh: Date.now() - Number(cached.at) < PIPED_REGISTRY_TTL_MS,
      };
    } catch {
      return { list: [], fresh: false };
    }
  }

  // Refresh the public instance registry in the background. A search never waits for it.
  let registryRefresh = null;
  function refreshPipedRegistry() {
    if (registryRefresh) return registryRefresh;
    registryRefresh = (async () => {
      try {
        const data = await fetchJson(PIPED_LIST_URL, { timeout: 5000 });
        if (!Array.isArray(data)) return;
        const list = data.map((i) => normalizeBase(i?.api_url)).filter(Boolean);
        if (!list.length) return;
        store.set(PIPED_REGISTRY_STORAGE, JSON.stringify({ at: Date.now(), list }));
        pipedList = null; // Rebuild with the fresh registry on the next call.
      } catch {
        // The registry is optional; cached and built-in instances are used instead.
      }
    })();
    return registryRefresh;
  }

  async function getPipedInstances() {
    if (pipedList) return pipedList;
    const { list: cached, fresh } = readRegistryCache();
    if (!fresh) refreshPipedRegistry();
    const custom = normalizeBase(store.get(PIPED_URL_STORAGE));
    const lastGood = normalizeBase(store.get(PIPED_LAST_GOOD_STORAGE));
    pipedList = [...new Set([custom, lastGood, ...cached, ...PIPED_FALLBACK].filter(Boolean))];
    return pipedList;
  }

  function resetPipedInstances() {
    pipedList = null;
  }

  // Instances that failed recently are skipped so that dead ones do not slow down every search.
  const deadUntil = new Map();
  const isCoolingDown = (base) => (deadUntil.get(base) || 0) > Date.now();
  // A 4xx (except 429) means the instance is alive and only rejected this request.
  const isInstanceFault = (e) => !/^HTTP 4\d\d$/.test(e?.message || "") || e.message === "HTTP 429";

  /**
   * Run fn(base, signal) against Piped instances, four at a time (first success wins).
   * Instances in `exclude` and instances that failed recently are skipped. Returns { base, value }.
   */
  async function withPiped(fn, { exclude = new Set(), batch = 4, maxTried = 8 } = {}) {
    const candidates = (await getPipedInstances()).filter((b) => !exclude.has(b));
    const alive = candidates.filter((b) => !isCoolingDown(b));
    // If everything is cooling down, try them anyway instead of failing outright.
    const all = (alive.length ? alive : candidates).slice(0, maxTried);
    let lastError = null;
    for (let i = 0; i < all.length; i += batch) {
      const group = all.slice(i, i + batch);
      const ctrl = new AbortController();
      try {
        const winner = await Promise.any(
          group.map(async (base) => {
            try {
              const value = await fn(base, ctrl.signal);
              deadUntil.delete(base);
              return { base, value };
            } catch (e) {
              // Do not blame an instance that was only aborted because another one won.
              if (!ctrl.signal.aborted && isInstanceFault(e)) {
                deadUntil.set(base, Date.now() + INSTANCE_COOLDOWN_MS);
              }
              throw e;
            }
          })
        );
        ctrl.abort();
        if (store.get(PIPED_LAST_GOOD_STORAGE) !== winner.base) {
          store.set(PIPED_LAST_GOOD_STORAGE, winner.base);
          pipedList = null; // Put the new last-good instance first next time.
        }
        return winner;
      } catch (e) {
        lastError = e instanceof AggregateError ? e.errors[0] : e;
      }
    }
    throw new Error(`No Piped instance responded${lastError ? ` (${lastError.message})` : ""}`);
  }

  function mapPipedSearchItem(it) {
    const videoId = parseVideoIdFromPath(it?.url);
    if (!videoId || (it.type && it.type !== "stream")) return null;
    return {
      type: "song",
      videoId,
      title: it.title || "",
      artist: cleanArtist(it.uploaderName),
      album: "",
      duration: it.duration > 0 ? it.duration : 0,
      thumbnail: it.thumbnail || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    };
  }

  async function searchWithPiped(query) {
    const q = encodeURIComponent(query);
    const { value } = await withPiped((base, signal) =>
      fetchJson(`${base}/search?q=${q}&filter=music_songs`, { signal, timeout: SEARCH_TIMEOUT_MS })
    );
    const items = (value?.items || []).map(mapPipedSearchItem).filter(Boolean);
    if (!items.length) throw new Error("no results");
    return items.slice(0, 15);
  }

  function rankAudioStreams(data) {
    const list = (data?.audioStreams || []).filter((s) => s?.url && !s.videoOnly);
    const score = (s) => {
      const mime = String(s.mimeType || "").toLowerCase();
      // Opus/WebM first: it decodes in Spotify's Chromium build without proprietary codecs.
      let sc = mime.includes("webm") || mime.includes("opus") ? 2_000_000 : 0;
      const track = String(s.audioTrackType || "").toLowerCase();
      if (track && !track.includes("original")) sc -= 1_000_000;
      return sc + (Number(s.bitrate) || 0);
    };
    return list.sort((a, b) => score(b) - score(a));
  }

  // ---------------------------------------------------------------------------
  // Fallback search backends (kept from the previous version)
  // ---------------------------------------------------------------------------

  const getApiKey = () => (store.get(API_KEY_STORAGE) || "").trim();

  async function searchWithDataApi(query, key) {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoCategoryId: "10",
      maxResults: "10",
      q: query,
      key,
    });
    const res = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/search?${params}`, { timeout: 6000 });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    const items = (data.items || []).filter((i) => i?.id?.videoId);
    const durations = {};
    if (items.length) {
      try {
        const vp = new URLSearchParams({
          part: "contentDetails",
          id: items.map((i) => i.id.videoId).join(","),
          key,
        });
        const vr = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3/videos?${vp}`, { timeout: 4000 });
        const vd = await vr.json();
        for (const v of vd.items || []) durations[v.id] = parseIsoDuration(v.contentDetails?.duration);
      } catch (e) {
        console.warn("[synthesis-spotify] duration lookup failed", e);
      }
    }
    return items.map((i) => ({
      type: "song",
      videoId: i.id.videoId,
      title: decodeHtml(i.snippet?.title || ""),
      artist: cleanArtist(decodeHtml(i.snippet?.channelTitle || "")),
      album: "",
      duration: durations[i.id.videoId] || 0,
      thumbnail:
        i.snippet?.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`,
    }));
  }

  let invidiousInstances = null;

  async function searchWithInvidious(query) {
    if (!invidiousInstances) {
      const list = await fetchJson("https://api.invidious.io/instances.json?sort_by=health", { timeout: 4000 });
      invidiousInstances = list
        .filter(([, i]) => i?.api === true && i?.cors === true && i?.type === "https")
        .map(([, i]) => String(i.uri).replace(/\/$/, ""))
        .slice(0, 3);
    }
    try {
      // Ask all instances at once; the first valid answer wins.
      return await Promise.any(
        invidiousInstances.map(async (base) => {
          const data = await fetchJson(`${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {
            timeout: SEARCH_TIMEOUT_MS,
          });
          if (!Array.isArray(data)) throw new Error("unexpected response");
          return data
            .filter((v) => v?.videoId)
            .slice(0, 10)
            .map((v) => ({
              type: "song",
              videoId: v.videoId,
              title: v.title || "",
              artist: cleanArtist(v.author),
              album: "",
              duration: v.lengthSeconds || 0,
              thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
            }));
        })
      );
    } catch (e) {
      invidiousInstances = null;
      throw e instanceof AggregateError ? e.errors[0] : e;
    }
  }

  /**
   * Run search backends as a hedged race. The first backend starts immediately; each later one
   * starts after its delay, or at once when every earlier one has already failed. The first
   * success wins. This keeps a dead or slow Piped pool from blocking the fallbacks.
   * backends: { label, delay, run }[]
   */
  function raceBackends(backends, signal) {
    return new Promise((resolve, reject) => {
      const errors = [];
      const timers = [];
      const started = new Set();
      let finished = false;
      let failures = 0;

      const finish = (fn, arg) => {
        if (finished) return;
        finished = true;
        timers.forEach(clearTimeout);
        fn(arg);
      };

      const start = (i) => {
        if (finished || started.has(i)) return;
        // The query is stale (the user kept typing): do not spend more requests or API quota on it.
        if (signal?.aborted) return finish(reject, new Error("search cancelled"));
        started.add(i);
        backends[i].run().then(
          (value) => finish(resolve, value),
          (e) => {
            if (finished) return;
            errors.push(`${backends[i].label}: ${e.message}`);
            if (++failures === backends.length) {
              finish(reject, new Error(`Search failed. ${errors.join(" / ")}`));
              return;
            }
            const next = backends.findIndex((_, idx) => !started.has(idx));
            if (next !== -1) start(next);
          }
        );
      };

      backends.forEach((b, i) => {
        if (i === 0) start(0);
        else timers.push(setTimeout(() => start(i), b.delay));
      });
    });
  }

  /**
   * Search YouTube. Order: YouTube Data API (only when a key is set) -> Invidious -> Piped.
   * The first backend starts immediately; each later one joins after HEDGE_STEP_MS, or at once
   * if every earlier one has failed. The first success wins.
   * Returns { type, videoId, title, artist, album, duration, thumbnail }[]
   */
  async function ytmSearch(query, { signal } = {}) {
    const runs = [];
    const key = getApiKey();
    if (key) runs.push({ label: "YouTube API", run: () => searchWithDataApi(query, key) });
    runs.push({ label: "Invidious", run: () => searchWithInvidious(query) });
    runs.push({ label: "Piped", run: () => searchWithPiped(query) });
    return raceBackends(
      runs.map((b, i) => ({ ...b, delay: i * HEDGE_STEP_MS })),
      signal
    );
  }

  // ---------------------------------------------------------------------------
  // Spotify local file URI helpers
  // ---------------------------------------------------------------------------

  const normText = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

  // spotify:local:<artist>:<album>:<title>:<duration>
  function parseLocalUri(uri) {
    const parts = String(uri || "").split(":");
    if (parts[0] !== "spotify" || parts[1] !== "local" || parts.length < 6) return null;
    const dec = (s) => {
      try {
        return decodeURIComponent(s.replace(/\+/g, " "));
      } catch {
        return s;
      }
    };
    return {
      artist: dec(parts[2]),
      album: dec(parts[3]),
      title: dec(parts.slice(4, -1).join(":")),
      duration: Number(parts[parts.length - 1]) || 0,
    };
  }

  function matchLocalTrack(tracks, { title, artist }) {
    const t = normText(title);
    const a = normText(artist);
    const titleHits = [];
    for (const tr of tracks || []) {
      const p = parseLocalUri(tr?.uri);
      if (!p || normText(p.title) !== t) continue;
      if (!a || normText(p.artist) === a) return tr;
      titleHits.push(tr);
    }
    // Same title but a different artist string: accept only if it is unambiguous.
    return titleHits.length === 1 ? titleHits[0] : null;
  }

  // Test hook: expose pure helpers and stop before touching Spicetify.
  if (globalThis.__YTM_LOCAL_TEST__) {
    globalThis.__YTM_LOCAL_TEST__.exports = {
      extractVideoId,
      parseVideoIdFromPath,
      sanitizeFileName,
      buildFileName,
      buildId3Tag,
      encodeMp3,
      withPiped,
      mapPipedSearchItem,
      rankAudioStreams,
      parseLocalUri,
      matchLocalTrack,
      resetPipedInstances,
      normalizeBase,
      raceBackends,
      ytmSearch,
    };
    return;
  }

  // ===========================================================================
  // Part 2: Spicetify-dependent code
  // ===========================================================================

  while (
    !window.Spicetify ||
    !Spicetify.PopupModal ||
    !Spicetify.showNotification ||
    !Spicetify.LocalStorage ||
    !(Spicetify.Topbar?.Button || Spicetify.Playbar?.Button)
  ) {
    await sleep(300);
  }

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

  const notify = (text, isError = false) => Spicetify.showNotification(text, isError);

  // ---------------------------------------------------------------------------
  // Download folder (File System Access API, handle persisted in IndexedDB)
  // ---------------------------------------------------------------------------

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("synthesis-spotify", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await idbOpen();
      return await new Promise((resolve, reject) => {
        const req = db.transaction("kv").objectStore("kv").get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async function idbSet(key, value) {
    try {
      const db = await idbOpen();
      await new Promise((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn("[synthesis-spotify] could not persist folder handle", e);
    }
  }

  /**
   * Resolve the folder to save into. Must be called directly from a click handler
   * (before any long await) because permission prompts and pickers need a user gesture.
   * Returns a FileSystemDirectoryHandle, or null when the picker API is unavailable
   * (the caller then falls back to a plain browser download).
   */
  async function prepareFolder({ forcePick = false } = {}) {
    if (typeof window.showDirectoryPicker !== "function") return null;

    if (!forcePick) {
      const saved = await idbGet("dir");
      if (saved) {
        try {
          let perm = await saved.queryPermission({ mode: "readwrite" });
          if (perm !== "granted") perm = await saved.requestPermission({ mode: "readwrite" });
          if (perm === "granted") return saved;
        } catch (e) {
          console.warn("[synthesis-spotify] saved folder is not usable, asking again", e);
        }
      }
    }

    const handle = await window.showDirectoryPicker({ id: "synthesis-spotify", mode: "readwrite", startIn: "music" });
    await idbSet("dir", handle);
    return handle;
  }

  async function fileExists(dir, name) {
    try {
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async function writeToFolder(dir, name, blob) {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (e) {
      try {
        await writable.abort();
      } catch {
        // Ignore.
      }
      throw e;
    }
  }

  function saveViaAnchor(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name, style: { display: "none" } });
    document.body.append(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 15000);
  }

  // ---------------------------------------------------------------------------
  // Download pipeline: Piped stream -> decode (WebAudio) -> MP3 (lamejs) -> file
  // ---------------------------------------------------------------------------

  let lamePromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.append(s);
    });
  }

  function loadLame() {
    if (window.lamejs?.Mp3Encoder) return Promise.resolve(window.lamejs);
    if (!lamePromise) {
      lamePromise = (async () => {
        let lastError = null;
        for (const url of LAME_URLS) {
          try {
            await loadScript(url);
            if (window.lamejs?.Mp3Encoder) return window.lamejs;
          } catch (e) {
            lastError = e;
          }
        }
        throw lastError || new Error("MP3 encoder is unavailable");
      })().catch((e) => {
        lamePromise = null;
        throw e;
      });
    }
    return lamePromise;
  }

  async function downloadBytes(url, { expected = 0, onProgress } = {}) {
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || expected || 0;
      if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer());
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), 20000);
        if (total) onProgress?.(Math.min(1, got / total));
      }
      return concatBytes(chunks);
    } finally {
      clearTimeout(timer);
    }
  }

  async function decodeAudio(bytes) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("WebAudio is not available");
    const ctx = new Ctx({ sampleRate: MP3_SAMPLE_RATE });
    try {
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return await ctx.decodeAudioData(copy);
    } finally {
      ctx.close?.().catch(() => {});
    }
  }

  async function fetchCover(urls) {
    for (const url of urls.filter(Boolean)) {
      try {
        const res = await fetchWithTimeout(url, { timeout: 8000 });
        if (!res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length && bytes.length < 2_000_000 && detectImageMime(bytes)) return { bytes };
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  }

  /** Fetch a stream and decode it. Tries other instances if one fails. */
  async function fetchDecodedAudio(item, report) {
    const exclude = new Set();
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      report("Looking up stream");
      let found;
      try {
        found = await withPiped(
          (base, signal) => fetchJson(`${base}/streams/${item.videoId}`, { signal, timeout: 12000 }),
          { exclude }
        );
      } catch (e) {
        throw lastError || e;
      }
      exclude.add(found.base);
      const info = found.value;
      if (info?.livestream) throw new Error("live streams are not supported");
      if (info?.duration > MAX_DURATION_SEC) throw new Error("this video is too long to be a song");

      for (const stream of rankAudioStreams(info).slice(0, 2)) {
        try {
          const bytes = await downloadBytes(stream.url, {
            expected: Number(stream.contentLength) || 0,
            onProgress: (p) => report(`Downloading ${Math.round(p * 100)}%`),
          });
          report("Decoding");
          const audio = await decodeAudio(bytes);
          return { audio, info };
        } catch (e) {
          lastError = e;
          console.warn("[synthesis-spotify] stream failed", stream.mimeType, e);
        }
      }
    }
    throw lastError || new Error("could not fetch audio");
  }

  async function downloadTrack(item, dir, report) {
    const fileName = buildFileName(item);
    const meta = { title: item.title, artist: item.artist };

    if (dir && (await fileExists(dir, fileName))) {
      report("Already saved");
      return { fileName, meta, existed: true };
    }

    const { audio, info } = await fetchDecodedAudio(item, report);
    if (!meta.title) meta.title = info?.title || item.videoId;
    if (!meta.artist) meta.artist = cleanArtist(info?.uploader);

    report("Loading encoder");
    const lame = await loadLame();
    const chunks = await encodeMp3(audio, lame, {
      onProgress: (p) => report(`Encoding ${Math.round(p * 100)}%`),
    });

    report("Tagging");
    const cover = await fetchCover([item.thumbnail, info?.thumbnailUrl]);
    const tag = buildId3Tag({
      title: meta.title,
      artist: meta.artist,
      album: DEFAULT_ALBUM,
      durationMs: audio.duration * 1000,
      cover,
    });
    const blob = new Blob([tag, ...chunks], { type: "audio/mpeg" });

    report("Saving");
    if (dir) await writeToFolder(dir, fileName, blob);
    else saveViaAnchor(blob, fileName);

    return { fileName, meta, existed: false };
  }

  // Serialize downloads: decoding and encoding are memory heavy.
  let queueTail = Promise.resolve();
  function enqueue(task) {
    const run = queueTail.then(() => task());
    queueTail = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------------------
  // Playback of the saved file through Spotify's Local Files
  // ---------------------------------------------------------------------------

  async function waitForLocalTrack(meta, timeoutMs) {
    const api = Spicetify.Platform?.LocalFilesAPI;
    if (!api?.getTracks) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const hit = matchLocalTrack(await api.getTracks(), meta);
        if (hit) return hit;
      } catch (e) {
        console.warn("[synthesis-spotify] LocalFilesAPI.getTracks failed", e);
      }
      if (Date.now() >= deadline) return null;
      await sleep(1500);
    }
  }

  async function playSaved(meta, timeoutMs) {
    const hit = await waitForLocalTrack(meta, timeoutMs);
    if (!hit) return false;
    await Spicetify.Player.playUri(hit.uri);
    return true;
  }

  const LOCAL_FILES_HINT =
    "Saved, but Spotify has not listed it yet. Make sure the chosen folder is added under " +
    "Settings > Local Files > Add a source (and Show local files is on).";

  // ---------------------------------------------------------------------------
  // UI: result rows
  // ---------------------------------------------------------------------------

  const ytmUrl = (id) => `https://music.youtube.com/watch?v=${id}`;

  function renderResultRow(item, status) {
    let saved = null;
    let busy = false;

    const dlButton = el(
      "button",
      {
        className: "main-buttons-button main-button-primary",
        style: { padding: "6px 14px", cursor: "pointer", flexShrink: "0", minWidth: "132px" },
      },
      "Download"
    );
    const openButton = el(
      "button",
      {
        className: "main-buttons-button main-button-secondary",
        style: { padding: "6px 14px", cursor: "pointer", flexShrink: "0" },
        onclick: () => window.open(ytmUrl(item.videoId), "_blank"),
      },
      "YT Music"
    );

    const setLabel = (text) => {
      dlButton.textContent = text;
    };

    dlButton.onclick = async () => {
      if (busy) return;
      busy = true;
      dlButton.disabled = true;
      try {
        if (saved) {
          setLabel("Opening...");
          if (!(await playSaved(saved, 8000))) notify(LOCAL_FILES_HINT, true);
          setLabel("Play");
          return;
        }

        // Folder access needs the click's user gesture, so ask before queuing.
        let dir;
        try {
          dir = await prepareFolder();
        } catch (e) {
          if (e?.name === "AbortError") {
            setLabel("Download");
            return;
          }
          throw e;
        }

        setLabel("Queued");
        const result = await enqueue(() => downloadTrack(item, dir, setLabel));
        saved = result.meta;

        setLabel("Waiting for Spotify");
        if (await playSaved(saved, 25000)) {
          notify(`Playing: ${saved.title}`);
        } else {
          notify(LOCAL_FILES_HINT, true);
        }
        setLabel("Play");
      } catch (e) {
        console.error("[synthesis-spotify] download failed", e);
        setLabel("Retry");
        const message = `Download failed: ${e?.message || e}`;
        dlButton.title = message;
        if (status) status.textContent = message;
        notify(message, true);
      } finally {
        busy = false;
        dlButton.disabled = false;
      }
    };

    return el(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "12px", padding: "8px 0" } },
      el("img", {
        src: item.thumbnail || "",
        style: {
          width: "48px",
          height: "48px",
          objectFit: "cover",
          borderRadius: "4px",
          backgroundColor: "var(--spice-card)",
        },
      }),
      el(
        "div",
        { style: { flex: "1", minWidth: "0" } },
        el(
          "div",
          { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } },
          item.title
        ),
        el(
          "div",
          { style: { fontSize: "12px", opacity: "0.7" } },
          [item.artist, formatDuration(item.duration)].filter(Boolean).join(" / ")
        )
      ),
      dlButton,
      openButton
    );
  }

  function renderResults(listEl, items, status, limit = Infinity) {
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(el("div", { style: { opacity: "0.7" } }, "Nothing was found."));
      return;
    }
    for (const item of items.slice(0, limit)) {
      listEl.append(renderResultRow(item, status));
    }
  }

  // ---------------------------------------------------------------------------
  // UI: popup modal
  // ---------------------------------------------------------------------------

  const searchCache = new Map();

  async function resolveUrlItem(videoId) {
    try {
      const { value } = await withPiped((base, signal) =>
        fetchJson(`${base}/streams/${videoId}`, { signal, timeout: 12000 })
      );
      return {
        type: "song",
        videoId,
        title: value?.title || videoId,
        artist: cleanArtist(value?.uploader),
        album: "",
        duration: value?.duration || 0,
        thumbnail: value?.thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      };
    } catch {
      return {
        type: "song",
        videoId,
        title: videoId,
        artist: "",
        album: "",
        duration: 0,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      };
    }
  }

  function inputStyle() {
    return {
      flex: "1",
      padding: "6px 10px",
      borderRadius: "4px",
      border: "none",
      background: "var(--spice-card)",
      color: "var(--spice-text)",
    };
  }

  function openModal() {
    const status = el("div", {
      style: { minHeight: "18px", fontSize: "12px", margin: "8px 0", opacity: "0.8" },
    });
    const list = el("div", { style: { maxHeight: "46vh", overflowY: "auto" } });
    const input = el("input", {
      type: "text",
      placeholder: "Song title, artist name, or YouTube / YT Music URL",
      style: { ...inputStyle(), padding: "8px 12px" },
    });

    const doSearch = async () => {
      const query = input.value.trim();
      if (!query) return;
      status.textContent = "Searching...";
      list.replaceChildren();
      try {
        const videoId = extractVideoId(query);
        const results = videoId ? [await resolveUrlItem(videoId)] : await ytmSearch(query);
        status.textContent = `${results.length} result${results.length !== 1 ? "s" : ""} found.`;
        renderResults(list, results, status);
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

    // Download folder row
    const folderName = el("span", { style: { flex: "1", opacity: "0.9" } }, "Not set");
    idbGet("dir").then((h) => {
      if (h?.name) folderName.textContent = h.name;
    });
    const folderButton = el(
      "button",
      {
        className: "main-buttons-button main-button-secondary",
        style: { padding: "4px 12px", cursor: "pointer" },
        onclick: async () => {
          try {
            const handle = await prepareFolder({ forcePick: true });
            if (handle) folderName.textContent = handle.name;
          } catch (e) {
            if (e?.name !== "AbortError") status.textContent = `Folder error: ${e.message}`;
          }
        },
      },
      "Choose folder"
    );
    const folderRow = el(
      "div",
      { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "12px", fontSize: "12px" } },
      "Save to:",
      folderName,
      folderButton
    );
    const folderHint = el(
      "div",
      { style: { fontSize: "11px", opacity: "0.6", marginTop: "4px" } },
      "Add this folder in Spotify: Settings > Local Files > Add a source."
    );

    // Optional settings
    const pipedInput = el("input", {
      type: "text",
      value: store.get(PIPED_URL_STORAGE) || "",
      placeholder: "Custom Piped API URL (optional)",
      style: inputStyle(),
    });
    pipedInput.addEventListener("change", () => {
      store.set(PIPED_URL_STORAGE, pipedInput.value.trim());
      resetPipedInstances();
      searchCache.clear();
      status.textContent = "Piped URL saved.";
    });
    const keyInput = el("input", {
      type: "password",
      value: getApiKey(),
      placeholder: "YouTube Data API v3 key (optional fallback)",
      style: inputStyle(),
    });
    keyInput.addEventListener("change", () => {
      store.set(API_KEY_STORAGE, keyInput.value.trim());
      searchCache.clear();
      status.textContent = keyInput.value.trim() ? "API key saved." : "API key removed.";
    });
    const optionalRow = (label, field) =>
      el(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "8px", fontSize: "12px", opacity: "0.8" } },
        label,
        field
      );

    const root = el(
      "div",
      { style: { color: "var(--spice-text)", position: "relative" } },
      el("div", { style: { display: "flex", gap: "8px" } }, input, searchButton),
      status,
      list,
      folderRow,
      folderHint,
      optionalRow("Piped:", pipedInput),
      optionalRow("API key:", keyInput),
      el(
        "span",
        {
          style: {
            position: "absolute",
            bottom: "4px",
            right: "8px",
            fontSize: "10px",
            opacity: "0.35",
            pointerEvents: "none",
            userSelect: "none",
          },
        },
        VERSION
      )
    );

    Spicetify.PopupModal.display({ title: "Synthesis-Spotify", content: root, isLarge: true });
    setTimeout(() => input.focus(), 100);
  }

  // ---------------------------------------------------------------------------
  // Integration with Spotify's search page
  // ---------------------------------------------------------------------------

  const SEARCH_SECTION_ID = "synthesis-spotify-search-section";
  const SEARCH_DEBOUNCE_MS = 450;
  const SEARCH_VISIBLE_ROWS = 5;
  const searchState = { query: "", token: 0, timer: null, ctrl: null };
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
    return document.querySelector(".main-view-container__scroll-node-child") || document.querySelector("main");
  }

  function createSearchSection() {
    const title = el("h2", { style: { fontSize: "24px", fontWeight: "700", margin: "0 0 8px" } }, "YouTube Music");
    const status = el("div", { style: { minHeight: "18px", fontSize: "12px", margin: "4px 0", opacity: "0.8" } });
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
    if (searchSection?.root.isConnected) searchSection.root.remove();
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

  async function runSearchPageQuery(query, token, signal) {
    try {
      let items = searchCache.get(query);
      if (!items) {
        items = await ytmSearch(query, { signal });
        searchCache.set(query, items);
      }
      if (token !== searchState.token || !mountSearchSection()) return;
      searchSection.status.textContent = `${items.length} result${items.length !== 1 ? "s" : ""} found.`;
      showSearchResults(items);
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
      searchState.ctrl?.abort();
      unmountSearchSection();
      return;
    }
    if (query === searchState.query) {
      mountSearchSection();
      return;
    }

    searchState.query = query;
    const token = ++searchState.token;
    clearTimeout(searchState.timer);
    searchState.ctrl?.abort();
    const { signal } = (searchState.ctrl = new AbortController());
    if (mountSearchSection()) {
      searchSection.list.replaceChildren();
      searchSection.moreButton.style.display = "none";
      searchSection.status.textContent = "Searching...";
    }
    const delay = searchCache.has(query) ? 0 : SEARCH_DEBOUNCE_MS;
    searchState.timer = setTimeout(() => runSearchPageQuery(query, token, signal), delay);
  }

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  Spicetify.Platform?.History?.listen?.(onSearchRouteChange);
  // Re-check periodically because React may replace containers.
  setInterval(onSearchRouteChange, 1000);
  onSearchRouteChange();

  const ButtonClass = Spicetify.Topbar?.Button || Spicetify.Playbar.Button;
  new ButtonClass("Synthesis-Spotify", "download", openModal);
})();
