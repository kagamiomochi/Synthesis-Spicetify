// NAME: Synthesis Spotify
// AUTHOR: kagamiomochi
// DESCRIPTION: Transcending all musical boundaries.

/*
 * Synthesis Spotify
 *
 * Architecture overview:
 *  - Network:  libcurl.js (WASM libcurl + Wisp websocket proxy) replaces fetch() to bypass CORS.
 *  - Data:     youtubei.js (YouTube.js) talks to YouTube Music through that custom fetch.
 *  - Audio:    the audio stream is downloaded into a Blob, played via a Blob URL on a hidden <audio>.
 *  - Spotify:  search page injection, a virtual queue interleaved with Spotify's own queue,
 *              and a small mini player that is shown while a non-Spotify track is active.
 *
 * Both libraries are loaded lazily from jsDelivr (pinned versions) on first use.
 */

(async function SynthesisSpotify() {
	"use strict";

	// ---------------------------------------------------------------------
	// Boot: wait until Spicetify is ready
	// ---------------------------------------------------------------------
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	for (let i = 0; i < 150; i++) {
		if (
			window.Spicetify?.Player?.addEventListener &&
			Spicetify.Platform?.History &&
			Spicetify.Menu &&
			Spicetify.PopupModal &&
			Spicetify.showNotification
		) {
			break;
		}
		await sleep(200);
	}
	if (!window.Spicetify?.Platform?.History) {
		console.error("[Synthesis Spotify] Spicetify did not become ready, aborting.");
		return;
	}

	// ---------------------------------------------------------------------
	// Constants and configuration
	// ---------------------------------------------------------------------
	/* VERSION */ const VERSION = "v0.4.1";
	const LIBCURL_URL = "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.5/libcurl_full.mjs";
	const YTJS_URL = "https://cdn.jsdelivr.net/npm/youtubei.js@18.3.0/bundle/browser.js";
	const CONFIG_KEY = "synthesis-spotify:config";
	const MAX_CACHED_TRACKS = 4;
	const SEARCH_DEBOUNCE_MS = 700;

	const DEFAULT_CONFIG = {
		// Wisp proxy servers, tried in order. A local one (your own IP) is far more reliable with YouTube
		// than the shared public one. Traffic stays end-to-end TLS encrypted.
		wispServers: ["ws://localhost:6001/", "wss://wisp.mercurywork.shop/"],
		// InnerTube clients tried in order to obtain a directly playable audio URL.
		clients: ["visionos", "tv_samsung"],
		resultLimit: 8,
		prefetchNext: true,
	};

	const CONFIG_VERSION = 4;

	function loadConfig() {
		try {
			const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
			// v4 changed the default client list; drop an older saved list so the new defaults apply.
			if (stored.configVersion !== CONFIG_VERSION) delete stored.clients;
			return { ...DEFAULT_CONFIG, ...stored, configVersion: CONFIG_VERSION };
		} catch {
			return { ...DEFAULT_CONFIG };
		}
	}

	let config = loadConfig();

	function saveConfig(patch) {
		config = { ...config, ...patch };
		try {
			localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
		} catch (error) {
			console.warn("[Synthesis Spotify] Failed to save config", error);
		}
	}

	// ---------------------------------------------------------------------
	// i18n (ja / en)
	// ---------------------------------------------------------------------
	const lang = String(Spicetify.Locale?.getLocale?.() || navigator.language || "en")
		.toLowerCase()
		.startsWith("ja")
		? "ja"
		: "en";

	const STRINGS = {
		ja: {
			sectionTitle: "Synthesis Spotify",
			sectionSub: "YouTube Music の検索結果",
			searching: "YouTube Music を検索中...",
			noResults: "YouTube Music に該当する曲が見つかりませんでした。",
			failed: "YouTube Music の検索に失敗しました。",
			retry: "再試行",
			openSettings: "設定を開く",
			play: "再生",
			addQueue: "キューに追加",
			playNext: "次に再生",
			openBrowser: "ブラウザで開く",
			queueTitle: "Synthesis Spotify キュー",
			queueEmpty: "キューは空です。",
			remove: "削除",
			clear: "すべて削除",
			playNow: "今すぐ再生",
			loading: (p) => `読み込み中 ${Math.round(p * 100)}%`,
			preparing: "準備中...",
			addedQueue: "キューに追加しました",
			addedNext: "次に再生します",
			playFailed: (m) => `再生に失敗しました: ${m}`,
			settingsTitle: "Synthesis Spotify 設定",
			wispLabel: "Wisp プロキシ (1行に1つ、上から順に試行)",
			clientsLabel: "InnerTube クライアント (visionos / tv_samsung、カンマ区切り、上から順に試行)",
			save: "保存",
			saved: "設定を保存しました",
			test: "接続テスト",
			clearCache: "音声キャッシュを削除",
			cacheCleared: "音声キャッシュを削除しました",
			privacyNote: "通信は libcurl.js により端末内で TLS 終端され、Wisp プロキシには接続先ホスト名のみ見えます。",
			menu: "Synthesis Spotify 設定",
			botHint: "共有Wispプロキシの出口IPがYouTubeに弾かれている可能性があります。自宅PCでローカルのWispサーバーを起動し、設定のWisp欄に ws://localhost:6001/ を指定してください。",
		},
		en: {
			sectionTitle: "Synthesis Spotify",
			sectionSub: "YouTube Music results",
			searching: "Searching YouTube Music...",
			noResults: "No matching songs on YouTube Music.",
			failed: "YouTube Music search failed.",
			retry: "Retry",
			openSettings: "Open settings",
			play: "Play",
			addQueue: "Add to queue",
			playNext: "Play next",
			openBrowser: "Open in browser",
			queueTitle: "Synthesis Spotify queue",
			queueEmpty: "The queue is empty.",
			remove: "Remove",
			clear: "Clear all",
			playNow: "Play now",
			loading: (p) => `Loading ${Math.round(p * 100)}%`,
			preparing: "Preparing...",
			addedQueue: "Added to queue",
			addedNext: "Will play next",
			playFailed: (m) => `Playback failed: ${m}`,
			settingsTitle: "Synthesis Spotify settings",
			wispLabel: "Wisp proxies (one per line, tried in order)",
			clientsLabel: "InnerTube clients (visionos / tv_samsung, comma separated, tried in order)",
			save: "Save",
			saved: "Settings saved",
			test: "Connection test",
			clearCache: "Clear audio cache",
			cacheCleared: "Audio cache cleared",
			privacyNote: "TLS is terminated inside this app by libcurl.js; the Wisp proxy only sees destination hostnames.",
			menu: "Synthesis Spotify settings",
			botHint: "The shared Wisp proxy's IP is probably flagged by YouTube. Run a local Wisp server on your PC and set ws://localhost:6001/ in the settings.",
		},
	};

	const t = (key, ...args) => {
		const value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
		return typeof value === "function" ? value(...args) : value;
	};

	// ---------------------------------------------------------------------
	// Small DOM helpers and icons
	// ---------------------------------------------------------------------
	const svg = (path) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
	const ICONS = {
		play: svg("M3 1.7v12.6a.7.7 0 0 0 1.05.6l10.5-6.3a.7.7 0 0 0 0-1.2L4.05 1.1A.7.7 0 0 0 3 1.7z"),
		pause: svg("M2.7 1h3.6v14H2.7zM9.7 1h3.6v14H9.7z"),
		next: svg("M12.7 1h1.6v14h-1.6zM1.7 1.6v12.8a.5.5 0 0 0 .8.4l8.6-6.4a.5.5 0 0 0 0-.8L2.5 1.2a.5.5 0 0 0-.8.4z"),
		plus: svg("M15 7H9V1H7v6H1v2h6v6h2V9h6z"),
		playNext: svg("M1 2h9v1.5H1zM1 6.25h9v1.5H1zM1 10.5h5v1.5H1zM10 9.5v5l4.5-2.5z"),
		external: svg("M7 2v1.5H3.5v9h9V9H14v5.5H2V2zM9 1h6v6h-1.5V3.56L8.53 8.53 7.47 7.47l4.97-4.97H9z"),
		close: svg("M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z"),
	};

	function h(tag, props = {}, ...children) {
		const el = document.createElement(tag);
		for (const [key, value] of Object.entries(props || {})) {
			if (value == null || value === false) continue;
			if (key === "class") el.className = value;
			else if (key === "html") el.innerHTML = value;
			else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2).toLowerCase(), value);
			else el.setAttribute(key, value === true ? "" : value);
		}
		for (const child of children.flat()) {
			if (child == null || child === false) continue;
			el.append(child.nodeType ? child : document.createTextNode(String(child)));
		}
		return el;
	}

	function formatTime(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return "";
		const total = Math.round(ms / 1000);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
	}

	const notify = (message, isError = false) => Spicetify.showNotification(message, isError);

	function throwIfAborted(signal) {
		if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
	}

	function withTimeout(promise, ms, label) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label || "operation"} timed out`)), ms);
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				}
			);
		});
	}

	// ---------------------------------------------------------------------
	// Network layer: libcurl.js (fetch replacement that is not bound by CORS)
	// ---------------------------------------------------------------------
	let curlPromise = null;
	let activeWisp = "";
	let lastPlayerUserAgent = null;
	const isLocalWisp = () => /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(activeWisp);

	// Minimal cookie jar for *.youtube.com (libcurl.js has no cookie storage of its own).
	const cookieJar = new Map();
	const isYouTubeHost = (hostname) => hostname === "youtube.com" || hostname.endsWith(".youtube.com");

	function storeCookies(res) {
		for (const [name, value] of res.raw_headers || []) {
			if (String(name).toLowerCase() !== "set-cookie") continue;
			const pair = String(value).split(";")[0];
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const key = pair.slice(0, eq).trim();
			const val = pair.slice(eq + 1).trim();
			if (!val || /expires=Thu, 01 Jan 1970/i.test(value)) cookieJar.delete(key);
			else cookieJar.set(key, val);
		}
	}

	async function pickWispServer(libcurl) {
		const failures = [];
		for (const url of config.wispServers) {
			try {
				libcurl.set_websocket(url);
				const res = await withTimeout(libcurl.fetch("https://www.gstatic.com/generate_204"), 10000, `Wisp ${url}`);
				if (res.status === 204 || res.ok) return url;
				failures.push(`${url}: HTTP ${res.status}`);
			} catch (error) {
				failures.push(`${url}: ${error?.message || error}`);
			}
		}
		throw new Error(`No usable Wisp server. ${failures.join(" / ")}`);
	}

	function loadCurl() {
		curlPromise ??= (async () => {
			const mod = await import(LIBCURL_URL);
			const libcurl = mod.libcurl;
			// The "full" build embeds the WASM binary, so no URL is needed here.
			await libcurl.load_wasm();
			libcurl.activeWisp = await pickWispServer(libcurl);
			activeWisp = libcurl.activeWisp;
			return libcurl;
		})().catch((error) => {
			curlPromise = null;
			throw error;
		});
		return curlPromise;
	}

	// Drop-in replacement for fetch(), also handed to youtubei.js.
	async function curlFetch(input, init = {}) {
		const libcurl = await loadCurl();
		const isRequest = typeof Request !== "undefined" && input instanceof Request;
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headers = new Headers(init.headers || (isRequest ? input.headers : undefined));

		if (url.includes("/youtubei/v1/player") && headers.get("User-Agent")) {
			lastPlayerUserAgent = headers.get("User-Agent");
		}
		// googlevideo URLs are signed for a specific client, so reuse the UA of the last /player call.
		if (new URL(url).hostname.endsWith(".googlevideo.com") && !headers.get("User-Agent") && lastPlayerUserAgent) {
			headers.set("User-Agent", lastPlayerUserAgent);
		}

		// Do NOT hand the Request object to libcurl.fetch: unlike native fetch, libcurl.js lets the
		// Request's own body override init.body. youtubei.js builds the Request from the raw payload and
		// passes the processed body (with the InnerTube context) in init, so we resolve everything here.
		let body = init.body;
		if (body === undefined && isRequest && input.body) body = await input.clone().arrayBuffer();

		const youtubeHost = isYouTubeHost(new URL(url).hostname);
		if (youtubeHost && cookieJar.size && !headers.get("Cookie")) {
			headers.set("Cookie", [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; "));
		}

		const res = await libcurl.fetch(url, {
			method: init.method || (isRequest ? input.method : "GET"),
			headers,
			body,
			redirect: init.redirect || (isRequest ? input.redirect : "follow"),
			signal: init.signal || (isRequest ? input.signal : undefined),
		});
		if (youtubeHost) storeCookies(res);
		return res;
	}

	// ---------------------------------------------------------------------
	// Provider: YouTube Music (youtubei.js)
	// ---------------------------------------------------------------------
	const innertubes = { plain: null, player: null };
	function getInnertube(withPlayer = false) {
		const slot = withPlayer ? "player" : "plain";
		innertubes[slot] ??= (async () => {
			const mod = await import(YTJS_URL);
			// The web build has no JS evaluator; it is required to decipher signatures and "n" params.
			mod.Platform.shim.eval = async (data) => new Function(data.output)();
			const region = (navigator.language || "en-US").split("-")[1]?.toUpperCase() || "US";
			const base = {
				fetch: curlFetch,
				cache: new mod.UniversalCache(false),
				// The JS player (base.js + eval) is only loaded for clients that need deciphering.
				retrieve_player: withPlayer,
				lang: "en",
				location: region,
			};
			try {
				return await mod.Innertube.create(base);
			} catch (error) {
				console.warn("[Synthesis Spotify] Session bootstrap failed, retrying with a local session", error);
				return await mod.Innertube.create({ ...base, generate_session_locally: true });
			}
		})().catch((error) => {
			innertubes[slot] = null;
			throw error;
		});
		return innertubes[slot];
	}

	function resizeThumbnail(url, size = 226) {
		if (!url) return "";
		return url.replace(/=w\d+-h\d+[^&]*$/, `=w${size}-h${size}-l90-rj`);
	}

	async function youtubeSearch(query, limit) {
		const yt = await getInnertube();
		const res = await yt.music.search(query, { type: "song" });
		const shelf = res.contents?.find((node) => node.type === "MusicShelf");
		const items = shelf?.contents ?? [];
		const tracks = [];
		for (const item of items) {
			if (!item?.id || !item.title) continue;
			const thumbs = item.thumbnail?.contents ?? [];
			tracks.push({
				provider: "youtube",
				id: item.id,
				title: item.title,
				artists: (item.artists ?? []).map((artist) => artist.name).filter(Boolean),
				album: item.album?.name || "",
				durationMs: (item.duration?.seconds ?? 0) * 1000,
				thumbnail: resizeThumbnail(thumbs[thumbs.length - 1]?.url || thumbs[0]?.url),
			});
			if (tracks.length >= limit) break;
		}
		return tracks;
	}

	// ---- Audio download through libcurl (ranged requests, like YouTube's own player) ----
	async function downloadFormat(url, total, mime, { signal, onProgress, userAgent } = {}) {
		const CHUNK = 10 * 1024 * 1024;
		const cpn = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[n % 64]).join("");
		const parts = [];
		let received = 0;

		while (!total || received < total) {
			throwIfAborted(signal);
			const end = (total ? Math.min(received + CHUNK, total) : received + CHUNK) - 1;
			const res = await curlFetch(`${url}&cpn=${cpn}&range=${received}-${end}`, {
				method: "GET",
				headers: { accept: "*/*", origin: "https://www.youtube.com", referer: "https://www.youtube.com", ...(userAgent ? { "user-agent": userAgent } : {}) },
				signal,
			});
			if (!res.ok) throw new Error(`googlevideo returned HTTP ${res.status}`);

			const reader = res.body.getReader();
			let chunkBytes = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parts.push(value);
				chunkBytes += value.byteLength;
				received += value.byteLength;
				if (total) onProgress?.(Math.min(received / total, 1));
			}
			if (!chunkBytes || (!total && chunkBytes < CHUNK)) break;
		}
		throwIfAborted(signal);
		if (total && received < total * 0.98) throw new Error("incomplete download");
		return new Blob(parts, { type: mime });
	}

	// ---- InnerTube clients (copied from yt-dlp's definitions, 2026-11) ----
	// These two currently return playable audio without a PO token. If YouTube starts rejecting them,
	// compare with INNERTUBE_CLIENTS in yt-dlp (yt_dlp/extractor/youtube/_base.py) and update the versions.
	const CLIENT_DEFS = {
		visionos: {
			id: 101,
			needsPlayer: false,
			client: {
				clientName: "VISIONOS",
				clientVersion: "1.02",
				deviceMake: "Apple",
				deviceModel: "RealityDevice17,1",
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
				osName: "visionOS",
				osVersion: "26.5.23O471",
			},
		},
		tv_samsung: {
			id: 7,
			needsPlayer: true,
			client: {
				clientName: "TVHTML5",
				clientVersion: "5.20260707",
				deviceMake: "Samsung",
				deviceModel: "UKS9800",
				userAgent: "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1",
				osName: "Tizen",
				osVersion: "2.4.0",
			},
		},
	};

	// yt-dlp downloads the watch page first, which also hands out the session cookies.
	let warmUpPromise = null;
	function warmUpSession() {
		warmUpPromise ??= curlFetch("https://www.youtube.com/", {
			headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.5" },
		})
			.then((res) => res.arrayBuffer())
			.catch((error) => console.warn("[Synthesis Spotify] session warm-up failed", error));
		return warmUpPromise;
	}

	// Builds the /player request the same way yt-dlp does (no web-only fields mixed into app clients).
	async function requestPlayer(videoId, clientKey, signal) {
		const def = CLIENT_DEFS[clientKey];
		if (!def) throw new Error(`unknown client "${clientKey}" (use ${Object.keys(CLIENT_DEFS).join(" / ")})`);

		const yt = await getInnertube(false);
		const visitorData = yt.session.context.client.visitorData;
		await warmUpSession();

		const contentPlaybackContext = { html5Preference: "HTML5_PREF_WANTS" };
		if (def.needsPlayer) {
			const ytWithPlayer = await getInnertube(true);
			const sts = ytWithPlayer.session.player?.signature_timestamp;
			if (sts) contentPlaybackContext.signatureTimestamp = sts;
		}

		const res = await curlFetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
			method: "POST",
			headers: {
				accept: "*/*",
				"accept-language": "en-US,en;q=0.5",
				"content-type": "application/json",
				origin: "https://www.youtube.com",
				"user-agent": def.client.userAgent,
				"x-youtube-client-name": String(def.id),
				"x-youtube-client-version": def.client.clientVersion,
				"x-goog-visitor-id": visitorData,
			},
			body: JSON.stringify({
				context: { client: { ...def.client, hl: "en", timeZone: "UTC", utcOffsetMinutes: 0, visitorData } },
				videoId,
				playbackContext: { contentPlaybackContext },
				contentCheckOk: true,
				racyCheckOk: true,
			}),
			signal,
		});
		if (!res.ok) throw new Error(`player request failed: HTTP ${res.status}`);

		const data = await res.json();
		const status = data.playabilityStatus?.status;
		if (status !== "OK") {
			const reason = data.playabilityStatus?.reason;
			throw new Error(reason ? `${status}: ${reason}` : String(status));
		}
		return data;
	}

	// Prefers Opus (WebM), which Chromium plays reliably, then the best AAC (MP4).
	function pickAudioFormat(streamingData) {
		const candidates = (streamingData?.adaptiveFormats ?? []).filter(
			(f) =>
				f.mimeType?.startsWith("audio/") &&
				(f.url || f.signatureCipher || f.cipher) &&
				f.audioTrack?.audioIsDefault !== false
		);
		const score = (f) => (f.mimeType.includes("opus") ? 1e9 : 0) + (f.bitrate || 0);
		return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
	}

	// Plain URLs are used as they are; ciphered ones / "n" params need the JS player.
	async function resolveFormatUrl(format) {
		const needsDecipher = Boolean(format.signatureCipher || format.cipher) || /[?&]n=/.test(format.url || "");
		if (!needsDecipher) return format.url;
		const yt = await getInnertube(true);
		return yt.session.player.decipher(format.url, format.signatureCipher, format.cipher);
	}

	async function youtubeFetchAudio(track, { signal, onProgress } = {}) {
		const errors = [];

		for (const client of config.clients) {
			throwIfAborted(signal);
			try {
				const data = await requestPlayer(track.id, client, signal);
				const format = pickAudioFormat(data.streamingData);
				if (!format) throw new Error("no audio format in the response");

				const url = await resolveFormatUrl(format);
				if (!url) throw new Error("could not build a stream URL");
				const blob = await downloadFormat(url, Number(format.contentLength) || 0, format.mimeType, {
					signal,
					onProgress,
					userAgent: CLIENT_DEFS[client].client.userAgent,
				});
				return { blob, mime: format.mimeType };
			} catch (error) {
				if (error?.name === "AbortError") throw error;
				errors.push(`${client}: ${error?.message || error}`);
			}
		}
		const joined = errors.join(" | ") || "no client available";
		if (/not a bot/i.test(joined) && !isLocalWisp()) throw new Error(`${joined} (${t("botHint")})`);
		throw new Error(joined);
	}

	// Registry so that more services can be added later.
	const providers = {
		youtube: {
			id: "youtube",
			label: "YouTube Music",
			search: youtubeSearch,
			fetchAudio: youtubeFetchAudio,
		},
	};

	// ---------------------------------------------------------------------
	// Audio cache (Blob URLs)
	// ---------------------------------------------------------------------
	const audioCache = new Map(); // key -> { url }
	const inflight = new Map(); // key -> { controller, listeners, promise }
	const trackKey = (track) => `${track.provider}:${track.id}`;

	function evictCache() {
		const keep = new Set([state.current && trackKey(state.current), state.queue[0] && trackKey(state.queue[0])].filter(Boolean));
		for (const key of [...audioCache.keys()]) {
			if (audioCache.size <= MAX_CACHED_TRACKS) break;
			if (keep.has(key)) continue;
			URL.revokeObjectURL(audioCache.get(key).url);
			audioCache.delete(key);
		}
	}

	function clearAudioCache() {
		const current = state.current && trackKey(state.current);
		for (const [key, entry] of [...audioCache]) {
			if (key === current && state.status !== "idle") continue;
			URL.revokeObjectURL(entry.url);
			audioCache.delete(key);
		}
	}

	function getAudioUrl(track, onProgress) {
		const key = trackKey(track);
		const cached = audioCache.get(key);
		if (cached) {
			audioCache.delete(key);
			audioCache.set(key, cached); // refresh LRU order
			return Promise.resolve(cached.url);
		}

		let job = inflight.get(key);
		if (!job) {
			const controller = new AbortController();
			job = { controller, listeners: new Set(), promise: null };
			job.promise = providers[track.provider]
				.fetchAudio(track, {
					signal: controller.signal,
					onProgress: (p) => job.listeners.forEach((fn) => fn(p)),
				})
				.then(({ blob }) => {
					const url = URL.createObjectURL(blob);
					audioCache.set(key, { url });
					evictCache();
					return url;
				})
				.finally(() => inflight.delete(key));
			inflight.set(key, job);
		}
		if (onProgress) job.listeners.add(onProgress);
		return job.promise;
	}

	function abortLoad(track) {
		if (!track) return;
		const key = trackKey(track);
		if (state.queue.some((queued) => trackKey(queued) === key)) return; // still wanted
		inflight.get(key)?.controller.abort();
	}

	// ---------------------------------------------------------------------
	// Playback engine
	// ---------------------------------------------------------------------
	const audio = new Audio();
	audio.preload = "auto";

	const state = {
		current: null, // active non-Spotify track
		status: "idle", // idle | loading | playing | paused
		progress: 0, // download progress while loading (0..1)
		queue: [], // virtual queue of non-Spotify tracks
		resumeSpotify: false, // resume Spotify once the virtual queue drains
		suppressUntil: 0, // ignore Spotify events until this timestamp
	};
	let playToken = 0;
	let qidCounter = 0;

	function readSpotify() {
		const data = Spicetify.Player.data;
		return {
			uri: data?.item?.uri ?? null,
			ctx: data?.context?.uri ?? data?.contextUri ?? null,
		};
	}

	function pauseSpotify() {
		if (Spicetify.Player.isPlaying()) {
			state.resumeSpotify = true;
			Spicetify.Player.pause();
		}
	}

	function resumeSpotifyIfNeeded() {
		if (!state.resumeSpotify) return;
		state.resumeSpotify = false;
		state.suppressUntil = Date.now() + 1000;
		Spicetify.Player.play();
	}

	function updateMediaSession(track) {
		if (!("mediaSession" in navigator) || !track) return;
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: track.title,
				artist: track.artists.join(", "),
				album: track.album || providers[track.provider].label,
				artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: "226x226" }] : [],
			});
			navigator.mediaSession.playbackState = "playing";
		} catch {
			// MediaSession is best effort only.
		}
	}

	async function playTrack(track) {
		const token = ++playToken;
		const previous = state.current;
		if (previous && state.status === "loading") abortLoad(previous);

		audio.pause();
		state.current = track;
		state.status = "loading";
		state.progress = 0;
		pauseSpotify();
		renderMini();

		try {
			const url = await getAudioUrl(track, (p) => {
				if (token !== playToken) return;
				state.progress = p;
				renderMini();
			});
			if (token !== playToken) return;

			audio.src = url;
			syncVolume();
			await audio.play();
			if (token !== playToken) return;

			state.status = "playing";
			updateMediaSession(track);
			renderMini();
			if (config.prefetchNext && state.queue[0]) {
				getAudioUrl(state.queue[0]).catch(() => {});
			}
		} catch (error) {
			if (token !== playToken || error?.name === "AbortError") return;
			console.error("[Synthesis Spotify] playback failed", error);
			notify(t("playFailed", error?.message || error), true);
			playNextFromQueue();
		}
	}

	function playNextFromQueue() {
		const next = state.queue.shift();
		renderQueueModal();
		if (next) {
			playTrack(next);
		} else {
			stopYT(true);
		}
	}

	function stopYT(resumeSpotify) {
		playToken++;
		abortLoad(state.current);
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		state.current = null;
		state.status = "idle";
		state.progress = 0;
		renderMini();
		if (resumeSpotify) resumeSpotifyIfNeeded();
		else state.resumeSpotify = false;
	}

	function toggleYT() {
		if (state.status === "playing") {
			audio.pause();
			state.status = "paused";
		} else if (state.status === "paused") {
			audio.play().catch(() => {});
			state.status = "playing";
		}
		renderMini();
	}

	function addToQueue(track, { next = false } = {}) {
		const entry = { ...track, qid: ++qidCounter };
		if (next) state.queue.unshift(entry);
		else state.queue.push(entry);
		renderQueueModal();

		// Nothing is playing at all: start right away instead of leaving the track stranded.
		if (state.status === "idle" && !Spicetify.Player.isPlaying()) {
			playNextFromQueue();
			return;
		}
		notify(next ? t("addedNext") : t("addedQueue"));
		if (config.prefetchNext && state.queue[0]) getAudioUrl(state.queue[0]).catch(() => {});
	}

	function playNow(track) {
		playTrack({ ...track });
	}

	// Audio element events
	audio.addEventListener("ended", () => playNextFromQueue());
	audio.addEventListener("error", () => {
		if (!audio.getAttribute("src")) return;
		notify(t("playFailed", audio.error?.message || "media error"), true);
		playNextFromQueue();
	});
	audio.addEventListener("timeupdate", () => updateSeek());

	// Keep the volume in sync with Spotify's volume slider.
	function syncVolume() {
		try {
			audio.volume = Math.min(1, Math.max(0, Spicetify.Player.getVolume()));
			audio.muted = Spicetify.Player.getMute();
		} catch {
			// ignore
		}
	}
	setInterval(() => {
		if (state.status !== "idle") syncVolume();
	}, 500);

	// ---------------------------------------------------------------------
	// Spotify player integration
	// ---------------------------------------------------------------------
	let lastSpotify = readSpotify();

	Spicetify.Player.addEventListener("onplaypause", () => {
		const playing = Spicetify.Player.isPlaying();
		if (Date.now() < state.suppressUntil) return;

		if (playing) {
			// Spotify's play button was pressed while a non-Spotify track is active:
			// keep Spotify silent and use the button as play/pause for our track.
			if (state.status !== "idle") {
				state.suppressUntil = Date.now() + 300;
				Spicetify.Player.pause();
				toggleYT();
			}
			return;
		}

		// Spotify stopped at the very end of its last track: continue with our queue.
		if (state.status === "idle" && state.queue.length) {
			const remaining = Spicetify.Player.getDuration() - Spicetify.Player.getProgress();
			if (Spicetify.Player.getDuration() > 0 && remaining < 1500) {
				state.resumeSpotify = false;
				playNextFromQueue();
			}
		}
	});

	Spicetify.Player.addEventListener("songchange", () => {
		const now = readSpotify();
		const prev = lastSpotify;
		lastSpotify = now;
		if (!now.uri || now.uri === prev.uri) return;
		if (Date.now() < state.suppressUntil) return;

		// Same playback context means "next/previous/auto-advance"; a different one means the user
		// started something else in Spotify.
		const advance = Boolean(prev.uri) && prev.ctx === now.ctx;

		if (state.status !== "idle") {
			if (!advance) {
				stopYT(false);
			} else if (state.queue.length) {
				state.suppressUntil = Date.now() + 300;
				Spicetify.Player.pause();
				playNextFromQueue();
			} else {
				stopYT(false); // Spotify already started the new track
			}
			return;
		}

		if (advance && state.queue.length) {
			// Queued non-Spotify tracks play between the finished Spotify track and the next one.
			state.suppressUntil = Date.now() + 300;
			state.resumeSpotify = true;
			Spicetify.Player.pause();
			playNextFromQueue();
		}
	});

	// ---------------------------------------------------------------------
	// Styles
	// ---------------------------------------------------------------------
	document.head.append(
		h("style", { id: "synthesis-spotify-style" }, `
		.ss-section { margin: 8px 0 24px; padding: 0 var(--content-spacing, 32px); box-sizing: border-box; }
		.ss-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
		.ss-head h2 { margin: 0; font-size: 24px; font-weight: 700; color: var(--text-base, #fff); }
		.ss-head span { font-size: 13px; color: var(--text-subdued, #a7a7a7); }
		.ss-status { padding: 16px 8px; color: var(--text-subdued, #a7a7a7); font-size: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
		.ss-row { display: grid; grid-template-columns: 48px minmax(0, 1fr) minmax(0, 0.6fr) auto 48px; gap: 12px; align-items: center; padding: 6px 8px; border-radius: 6px; }
		.ss-row:hover { background: rgba(128, 128, 128, 0.18); }
		.ss-cover-wrap { position: relative; width: 40px; height: 40px; }
		.ss-cover { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; background: rgba(128, 128, 128, 0.3); }
		.ss-cover-play { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; border: 0; border-radius: 4px; background: rgba(0, 0, 0, 0.55); color: #fff; cursor: pointer; }
		.ss-row:hover .ss-cover-play { display: flex; }
		.ss-meta { min-width: 0; }
		.ss-title, .ss-sub, .ss-album { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-title { font-size: 15px; color: var(--text-base, #fff); }
		.ss-sub, .ss-album { font-size: 13px; color: var(--text-subdued, #a7a7a7); }
		.ss-actions { display: flex; gap: 4px; opacity: 0; }
		.ss-row:hover .ss-actions { opacity: 1; }
		.ss-dur { font-size: 13px; color: var(--text-subdued, #a7a7a7); text-align: right; font-variant-numeric: tabular-nums; }
		.ss-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: transparent; color: var(--text-subdued, #a7a7a7); cursor: pointer; }
		.ss-btn:hover { color: var(--text-base, #fff); transform: scale(1.08); }
		.ss-link { border: 0; background: transparent; color: var(--text-base, #fff); text-decoration: underline; cursor: pointer; font-size: 13px; padding: 0; }
		@media (max-width: 900px) { .ss-row { grid-template-columns: 48px minmax(0, 1fr) auto 48px; } .ss-album { display: none; } }

		.ss-mini { position: fixed; left: 16px; bottom: 104px; z-index: 9999; width: 340px; display: none; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px; border-radius: 10px; background: var(--background-elevated-base, #242424); color: var(--text-base, #fff); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
		.ss-mini.ss-visible { display: grid; }
		.ss-mini-cover { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; background: rgba(128, 128, 128, 0.3); }
		.ss-mini-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-mini-sub { font-size: 12px; color: var(--text-subdued, #a7a7a7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-mini-seek { width: 100%; margin: 6px 0 0; accent-color: var(--essential-bright-accent, #1ed760); }
		.ss-mini-ctrl { display: flex; gap: 2px; }

		.ss-queue { display: flex; flex-direction: column; gap: 4px; min-width: 380px; max-height: 60vh; overflow-y: auto; }
		.ss-queue .ss-row { grid-template-columns: 48px minmax(0, 1fr) auto; }
		.ss-queue .ss-actions { opacity: 1; }
		.ss-settings label { display: block; margin: 12px 0 4px; font-size: 13px; color: var(--text-subdued, #a7a7a7); }
		.ss-settings textarea, .ss-settings input[type="text"] { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid rgba(128, 128, 128, 0.5); background: rgba(128, 128, 128, 0.15); color: var(--text-base, #fff); font-family: monospace; font-size: 12px; }
		.ss-settings .ss-buttons { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
		.ss-settings button.ss-primary { padding: 8px 16px; border: 0; border-radius: 500px; background: var(--essential-bright-accent, #1ed760); color: #000; font-weight: 700; cursor: pointer; }
		.ss-settings button.ss-secondary { padding: 8px 16px; border: 1px solid rgba(128, 128, 128, 0.6); border-radius: 500px; background: transparent; color: var(--text-base, #fff); cursor: pointer; }
		.ss-settings pre { margin: 12px 0 0; padding: 10px; max-height: 220px; overflow: auto; border-radius: 6px; background: rgba(0, 0, 0, 0.35); font-size: 11px; white-space: pre-wrap; }
		.ss-settings small { display: block; margin-top: 10px; color: var(--text-subdued, #a7a7a7); }
	`)
	);

	// ---------------------------------------------------------------------
	// Images (fall back to Blob URLs fetched through libcurl if <img> is blocked)
	// ---------------------------------------------------------------------
	const imageCache = new Map();

	function loadImage(img, url) {
		if (!url) return;
		if (imageCache.has(url)) {
			img.src = imageCache.get(url);
			return;
		}
		img.addEventListener(
			"error",
			async () => {
				if (img.dataset.fallback) return;
				img.dataset.fallback = "1";
				try {
					const res = await curlFetch(url);
					const blobUrl = URL.createObjectURL(await res.blob());
					imageCache.set(url, blobUrl);
					img.src = blobUrl;
				} catch {
					// leave the placeholder
				}
			},
			{ once: true }
		);
		img.src = url;
	}

	// ---------------------------------------------------------------------
	// Mini player (visible while a non-Spotify track is active)
	// ---------------------------------------------------------------------
	let mini = null;

	function ensureMini() {
		if (mini) return mini;
		const cover = h("img", { class: "ss-mini-cover", alt: "" });
		const title = h("div", { class: "ss-mini-title" });
		const sub = h("div", { class: "ss-mini-sub" });
		const seek = h("input", { class: "ss-mini-seek", type: "range", min: "0", max: "1000", value: "0" });
		seek.addEventListener("input", () => {
			const duration = Number.isFinite(audio.duration) ? audio.duration : (state.current?.durationMs ?? 0) / 1000;
			if (duration > 0) audio.currentTime = (Number(seek.value) / 1000) * duration;
		});
		const toggle = h("button", { class: "ss-btn", onClick: toggleYT });
		const next = h("button", { class: "ss-btn", title: t("playNext"), html: ICONS.next, onClick: playNextFromQueue });
		const close = h("button", { class: "ss-btn", html: ICONS.close, onClick: () => stopYT(true) });
		const root = h(
			"div",
			{ class: "ss-mini" },
			cover,
			h("div", { style: "min-width:0" }, title, sub, seek),
			h("div", { class: "ss-mini-ctrl" }, toggle, next, close)
		);
		document.body.append(root);
		mini = { root, cover, title, sub, seek, toggle, lastCoverUrl: "" };
		return mini;
	}

	function renderMini() {
		const ui = ensureMini();
		const track = state.current;
		ui.root.classList.toggle("ss-visible", Boolean(track) && state.status !== "idle");
		if (!track) return;

		ui.title.textContent = track.title;
		ui.sub.textContent =
			state.status === "loading"
				? `${t("loading", state.progress)}  -  ${track.artists.join(", ")}`
				: track.artists.join(", ");
		if (ui.lastCoverUrl !== track.thumbnail) {
			ui.lastCoverUrl = track.thumbnail;
			ui.cover.removeAttribute("data-fallback");
			loadImage(ui.cover, track.thumbnail);
		}
		ui.toggle.innerHTML = state.status === "playing" ? ICONS.pause : ICONS.play;
		ui.toggle.title = state.status === "playing" ? "Pause" : t("play");
		ui.seek.disabled = state.status === "loading";
		if (state.status === "loading") ui.seek.value = String(Math.round(state.progress * 1000));
	}

	function updateSeek() {
		if (!mini || state.status === "loading") return;
		const duration = Number.isFinite(audio.duration) ? audio.duration : (state.current?.durationMs ?? 0) / 1000;
		if (duration > 0) mini.seek.value = String(Math.round((audio.currentTime / duration) * 1000));
	}

	// ---------------------------------------------------------------------
	// Queue popup
	// ---------------------------------------------------------------------
	let queueModalBody = null;

	function renderQueueRow(track, index) {
		const img = h("img", { class: "ss-cover", alt: "" });
		loadImage(img, track.thumbnail);
		return h(
			"div",
			{ class: "ss-row" },
			h("div", { class: "ss-cover-wrap" }, img),
			h("div", { class: "ss-meta" }, h("div", { class: "ss-title" }, track.title), h("div", { class: "ss-sub" }, track.artists.join(", "))),
			h(
				"div",
				{ class: "ss-actions" },
				h("button", {
					class: "ss-btn",
					title: t("playNow"),
					html: ICONS.play,
					onClick: () => {
						state.queue.splice(index, 1);
						playTrack(track);
						renderQueueModal();
					},
				}),
				h("button", {
					class: "ss-btn",
					title: t("remove"),
					html: ICONS.close,
					onClick: () => {
						state.queue.splice(index, 1);
						renderQueueModal();
					},
				})
			)
		);
	}

	function renderQueueModal() {
		if (!queueModalBody || !queueModalBody.isConnected) return;
		queueModalBody.replaceChildren(
			...(state.queue.length
				? [
						...state.queue.map(renderQueueRow),
						h("button", { class: "ss-link", onClick: () => { state.queue.length = 0; renderQueueModal(); } }, t("clear")),
				  ]
				: [h("div", { class: "ss-status" }, t("queueEmpty"))])
		);
	}

	function openQueue() {
		queueModalBody = h("div", { class: "ss-queue" });
		Spicetify.PopupModal.display({ title: t("queueTitle"), content: queueModalBody });
		renderQueueModal();
	}

	// ---------------------------------------------------------------------
	// Search page integration
	// ---------------------------------------------------------------------
	// Open the track on YouTube Music in the default external browser
	function openInBrowser(track) {
		const url = `https://music.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
		// Do not check the return value: the Spotify client may return null even when the browser opened,
		// and a fallback would open a second tab
		window.open(url, "_blank", "noopener,noreferrer");
	}

	const search = { query: "", token: 0, timer: null, section: null, body: null, status: "idle", results: [], error: null };

	function trackRow(track) {
		const img = h("img", { class: "ss-cover", alt: "", loading: "lazy" });
		loadImage(img, track.thumbnail);
		return h(
			"div",
			{ class: "ss-row", onDblclick: () => playNow(track) },
			h(
				"div",
				{ class: "ss-cover-wrap" },
				img,
				h("button", { class: "ss-cover-play", title: t("play"), html: ICONS.play, onClick: () => playNow(track) })
			),
			h("div", { class: "ss-meta" }, h("div", { class: "ss-title" }, track.title), h("div", { class: "ss-sub" }, track.artists.join(", "))),
			h("div", { class: "ss-album" }, track.album),
			h(
				"div",
				{ class: "ss-actions" },
				h("button", { class: "ss-btn", title: t("playNext"), html: ICONS.playNext, onClick: () => addToQueue(track, { next: true }) }),
				h("button", { class: "ss-btn", title: t("addQueue"), html: ICONS.plus, onClick: () => addToQueue(track) }),
				h("button", { class: "ss-btn", title: t("openBrowser"), html: ICONS.external, onClick: () => openInBrowser(track) })
			),
			h("div", { class: "ss-dur" }, formatTime(track.durationMs))
		);
	}

	function ensureSection() {
		if (!search.section) {
			search.body = h("div", { class: "ss-body" });
			search.section = h(
				"section",
				{ class: "ss-section" },
				h("div", { class: "ss-head" }, h("h2", {}, t("sectionTitle")), h("span", {}, t("sectionSub"))),
				search.body
			);
		}
		return search.section;
	}

	function renderSearch() {
		if (!search.body) return;
		const { status } = search;
		if (status === "loading") {
			search.body.replaceChildren(h("div", { class: "ss-status" }, t("searching")));
		} else if (status === "error") {
			search.body.replaceChildren(
				h(
					"div",
					{ class: "ss-status" },
					h("span", {}, `${t("failed")} ${search.error || ""}`),
					h("button", { class: "ss-link", onClick: () => runSearch(search.query) }, t("retry")),
					h("button", { class: "ss-link", onClick: openSettings }, t("openSettings"))
				)
			);
		} else if (status === "done" && !search.results.length) {
			search.body.replaceChildren(h("div", { class: "ss-status" }, t("noResults")));
		} else if (status === "done") {
			search.body.replaceChildren(...search.results.map(trackRow));
		}
	}

	function attachSection() {
		if (!search.query || !search.section || search.section.isConnected) return;
		const scroll = document.querySelector(".main-view-container__scroll-node-child");
		if (!scroll) return;
		const host = scroll.querySelector('[data-testid="search-body"]') || scroll.firstElementChild || scroll;
		host.prepend(search.section);
	}

	function detachSection() {
		search.section?.remove();
	}

	async function runSearch(query) {
		const token = ++search.token;
		search.query = query;
		search.status = "loading";
		ensureSection();
		renderSearch();
		attachSection();

		try {
			const results = await providers.youtube.search(query, config.resultLimit);
			if (token !== search.token) return;
			search.results = results;
			search.status = "done";
		} catch (error) {
			if (token !== search.token) return;
			console.error("[Synthesis Spotify] search failed", error);
			search.error = error?.message || String(error);
			search.status = "error";
		}
		renderSearch();
		attachSection();
	}

	function onRoute(location) {
		const match = (location?.pathname || "").match(/^\/search\/([^/]+)/);
		clearTimeout(search.timer);
		if (!match) {
			search.token++;
			search.query = "";
			detachSection();
			return;
		}
		let query = "";
		try {
			query = decodeURIComponent(match[1]).trim();
		} catch {
			query = match[1];
		}
		if (!query) {
			search.token++;
			search.query = "";
			detachSection();
			return;
		}
		if (query === search.query && search.status !== "error") {
			attachSection();
			return;
		}
		// Spotify updates the route while typing, so debounce before hitting YouTube.
		search.timer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
	}

	Spicetify.Platform.History.listen(onRoute);
	onRoute(Spicetify.Platform.History.location);

	// Spotify re-renders the search page and may drop our section; re-attach when needed.
	let attachScheduled = false;
	new MutationObserver(() => {
		if (attachScheduled || !search.query) return;
		attachScheduled = true;
		requestAnimationFrame(() => {
			attachScheduled = false;
			attachSection();
		});
	}).observe(document.body, { childList: true, subtree: true });

	// ---------------------------------------------------------------------
	// Diagnostics and settings
	// ---------------------------------------------------------------------
	async function runDiagnostics(log) {
		const step = async (label, fn) => {
			log(`[..] ${label}`);
			try {
				const detail = await fn();
				log(`[OK] ${label}${detail ? ` (${detail})` : ""}`);
				return true;
			} catch (error) {
				log(`[NG] ${label}: ${error?.message || error}`);
				return false;
			}
		};

		let libcurl = null;
		if (!(await step("libcurl.js (WASM)", async () => {
			libcurl = await loadCurl();
			return `wisp: ${libcurl.activeWisp}`;
		}))) {
			log("Hint: the WASM may be blocked by Spotify's CSP, or no Wisp server is reachable.");
			return;
		}

		let tracks = [];
		if (!(await step("youtubei.js session + YouTube Music search", async () => {
			tracks = await youtubeSearch("daft punk one more time", 3);
			if (!tracks.length) throw new Error("0 results");
			return `${tracks.length} results`;
		}))) {
			return;
		}

		const working = [];
		for (const client of config.clients) {
			await step(`player response with ${client}`, async () => {
				const data = await requestPlayer(tracks[0].id, client);
				const fmt = pickAudioFormat(data.streamingData);
				if (!fmt) throw new Error("no audio format in the response");
				const ciphered = Boolean(fmt.signatureCipher || fmt.cipher || /[?&]n=/.test(fmt.url || ""));
				const url = await resolveFormatUrl(fmt);
				working.push({ url, client, fmt });
				return `${fmt.mimeType}, ${Math.round((Number(fmt.contentLength) || 0) / 1024)} KiB${ciphered ? ", deciphered with JS player" : ""}`;
			});
		}
		log(`Session cookies: ${[...cookieJar.keys()].join(", ") || "(none)"}`);
		if (!working.length) {
			log("Hint: every client failed. Check the messages above (eval/CSP errors, HTTP status, or LOGIN_REQUIRED).");
			if (!isLocalWisp()) log(`Hint: ${t("botHint")}`);
			return;
		}
		const info = working[0];
		log(`Using ${info.client} for the download test.`);

		await step("audio fetch via libcurl (first 64 KiB)", async () => {
			const res = await curlFetch(`${info.url}&range=0-65535`, {
				headers: {
					origin: "https://www.youtube.com",
					referer: "https://www.youtube.com",
					"user-agent": CLIENT_DEFS[info.client].client.userAgent,
				},
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buf = await res.arrayBuffer();
			return `${buf.byteLength} bytes`;
		});
	}

	function openSettings() {
		const wisp = h("textarea", { rows: "3" });
		wisp.value = config.wispServers.join("\n");
		const clients = h("input", { type: "text" });
		clients.value = config.clients.join(", ");
		const output = h("pre", { style: "display:none" });
		const log = (line) => {
			output.style.display = "block";
			output.textContent += `${line}\n`;
			output.scrollTop = output.scrollHeight;
		};
		const collect = () => ({
			wispServers: wisp.value.split("\n").map((s) => s.trim()).filter(Boolean),
			clients: clients.value.split(",").map((s) => s.trim()).filter(Boolean),
		});

		const content = h(
			"div",
			{ class: "ss-settings" },
			h("label", {}, t("wispLabel")),
			wisp,
			h("label", {}, t("clientsLabel")),
			clients,
			h(
				"div",
				{ class: "ss-buttons" },
				h("button", { class: "ss-primary", onClick: () => { saveConfig(collect()); notify(t("saved")); } }, t("save")),
				h(
					"button",
					{
						class: "ss-secondary",
						onClick: async () => {
							saveConfig(collect());
							// Reset the lazily created singletons so the new settings take effect.
							curlPromise = null;
							innertubes.plain = null;
							innertubes.player = null;
							warmUpPromise = null;
							cookieJar.clear();
							output.textContent = "";
							await runDiagnostics(log);
						},
					},
					t("test")
				),
				h("button", { class: "ss-secondary", onClick: () => { clearAudioCache(); notify(t("cacheCleared")); } }, t("clearCache"))
			),
			output,
			h("small", {}, `${t("privacyNote")}  ${VERSION}`)
		);
		Spicetify.PopupModal.display({ title: t("settingsTitle"), content });
	}

	// ---------------------------------------------------------------------
	// Registration
	// ---------------------------------------------------------------------
	try {
		new Spicetify.Menu.Item(t("menu"), false, () => openSettings()).register();
	} catch (error) {
		console.warn("[Synthesis Spotify] Failed to register menu item", error);
	}
	try {
		new Spicetify.Playbar.Button(t("queueTitle"), "queue", () => openQueue());
	} catch (error) {
		console.warn("[Synthesis Spotify] Failed to register playbar button", error);
	}

	// Warm up the heavy libraries while the app is idle so the first search feels fast.
	(window.requestIdleCallback || ((fn) => setTimeout(fn, 4000)))(() => {
		getInnertube().catch((error) => console.warn("[Synthesis Spotify] warm-up failed", error));
	});

	window.SynthesisSpotify = { version: VERSION, state, get config() { return config; }, providers, runDiagnostics };
	console.log(`[Synthesis Spotify] ${VERSION} loaded`);
})();