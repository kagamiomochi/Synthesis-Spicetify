// NAME: Synthesis Spicetify
// AUTHOR: kagamiomochi
// DESCRIPTION: Transcending all musical boundaries.

/*
 * Synthesis Spicetify
 *
 * Architecture overview:
 *  - Network:  libcurl.js (WASM libcurl + Wisp websocket proxy) replaces fetch() to bypass CORS.
 *  - Data:     youtubei.js (YouTube.js) talks to YouTube Music through that custom fetch.
 *  - Audio:    the audio stream is downloaded in ranged chunks and fed to a hidden <audio> through
 *              Media Source Extensions, so playback starts as soon as the first chunk has arrived.
 *              The finished download is kept as a Blob URL cache (also the fallback without MSE).
 *  - Spotify:  search page injection, a virtual queue interleaved with Spotify's own queue,
 *              and Spotify's own player bar, which shows and controls a non-Spotify track while it is active
 *              (a small mini player is only the fallback when the player bar cannot be used).
 *  - Playlists: a saved track is a silent local-file placeholder in a Spotify playlist; when Spotify starts
 *              it, the extension pauses Spotify and streams the real track instead.
 *
 * Both libraries are loaded lazily from jsDelivr (pinned versions) on first use.
 */

(async function SynthesisSpicetify() {
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
		console.error("[Synthesis Spicetify] Spicetify did not become ready, aborting.");
		return;
	}

	// ---------------------------------------------------------------------
	// Constants and configuration
	// ---------------------------------------------------------------------
	/* VERSION */ const VERSION = "v0.6.0";
	const WISP_SCRIPT_URL = "https://raw.githubusercontent.com/kagamiomochi/Synthesis-Spicetify/main/wisp-launcher/portable/wisp_ondemand.py";
	const LIBCURL_URL = "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.5/libcurl_full.mjs";
	const YTJS_URL = "https://cdn.jsdelivr.net/npm/youtubei.js@18.3.0/bundle/browser.js";
	const CONFIG_KEY = "synthesis-spicetify:config";
	const MAX_CACHED_TRACKS = 4;
	const SEARCH_DEBOUNCE_MS = 700;

	const DEFAULT_CONFIG = {
		// Public (shared) Wisp proxies, tried in order. They are enough for search, but YouTube rejects
		// their data center IPs for playback. Traffic stays end-to-end TLS encrypted.
		wispServers: ["wss://wisp.mercurywork.shop/"],
		// Local Wisp server (your own IP). Only used while playback is enabled.
		localWisp: "ws://localhost:6001/",
		// Playback needs the local Wisp server, so it is opt-in.
		playbackEnabled: false,
		// InnerTube clients tried in order to obtain a directly playable audio URL.
		clients: ["visionos", "tv_samsung"],
		resultLimit: 20,
		prefetchNext: true,
		// End Spotify's playback session (not just pause) while a non-Spotify track plays, so that
		// the OS media controls and Discord RPC stop showing the Spotify track. Uses an internal API.
		stopSpotify: true,
	};

	const CONFIG_VERSION = 6;
	const LOCAL_WISP_RE = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])/;

	function loadConfig() {
		try {
			const stored = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
			// v4 changed the default client list; drop an older saved list so the new defaults apply.
			if ((stored.configVersion ?? 0) < 4) delete stored.clients;
			// v6 raised the default result limit and now merges songs and videos; drop the old saved limit.
			if ((stored.configVersion ?? 0) < 6) delete stored.resultLimit;
			// v5 split the local Wisp server out of wispServers and made playback opt-in. Anyone who saved a
			// local address before is treated as having set it up, so their playback keeps working.
			if ((stored.configVersion ?? 0) < 5 && Array.isArray(stored.wispServers)) {
				const local = stored.wispServers.find((url) => LOCAL_WISP_RE.test(url));
				stored.wispServers = stored.wispServers.filter((url) => !LOCAL_WISP_RE.test(url));
				if (!stored.wispServers.length) delete stored.wispServers;
				if (local) {
					stored.localWisp = local;
					stored.playbackEnabled = true;
				}
			}
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
			console.warn("[Synthesis Spicetify] Failed to save config", error);
		}
	}

	// Drop the saved settings entirely and go back to the defaults.
	function resetConfig() {
		try {
			localStorage.removeItem(CONFIG_KEY);
		} catch (error) {
			console.warn("[Synthesis Spicetify] Failed to remove config", error);
		}
		config = { ...DEFAULT_CONFIG, configVersion: CONFIG_VERSION };
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
			tabSpotify: "Spotify",
			tabYouTubeMusic: "YouTube Music",
			searching: "YouTube Music を検索中...",
			noResults: "YouTube Music に該当する曲が見つかりませんでした。",
			failed: "YouTube Music の検索に失敗しました。",
			retry: "再試行",
			loadingMore: "さらに読み込み中...",
			loadMoreFailed: "続きの読み込みに失敗しました。",
			openSettings: "設定を開く",
			play: "再生",
			addQueue: "キューに追加",
			playNext: "次に再生",
			openBrowser: "ブラウザで開く",
			queueTitle: "Synthesis Spicetify キュー",
			queueEmpty: "キューは空です。",
			remove: "削除",
			clear: "すべて削除",
			playNow: "今すぐ再生",
			queueNowPlaying: "Synthesis Spicetify で再生中",
			queueSynthesisHead: "Synthesis Spicetify のキュー",
			loading: (p) => `読み込み中 ${Math.round(p * 100)}%`,
			preparing: "準備中...",
			addedQueue: "キューに追加しました",
			addedNext: "次に再生します",
			playFailed: (m) => `再生に失敗しました: ${m}`,
			settingsTitle: "Synthesis Spicetify 設定",
			wispLabel: "公開 Wisp プロキシ (1行に1つ、上から順に試行)",
			clientsLabel: "InnerTube クライアント (visionos / tv_samsung、カンマ区切り、上から順に試行)",
			save: "保存",
			saved: "設定を保存しました",
			test: "接続テスト",
			clearCache: "音声キャッシュを削除",
			cacheCleared: "音声キャッシュを削除しました",
			resetSettings: "設定をリセット",
			resetConfirm: "もう一度押すとリセットします",
			resetDone: "設定を初期値に戻しました",
			privacyNote: "通信は libcurl.js により端末内で TLS 終端され、Wisp プロキシには接続先ホスト名のみ見えます。",
			menu: "Synthesis Spicetify 設定",
			botHint: "共有Wispプロキシの出口IPがYouTubeに弾かれている可能性があります。自宅PCでローカルのWispサーバーを用意し、設定で「再生機能を有効化」をオンにしてください。",
			playbackLabel: "再生機能を有効化",
			playbackDesc: "オフの間は公開 Wisp だけを使い、検索結果の表示と「ブラウザで開く」のみ使えます。再生にはローカル Wisp サーバーが必要です。",
			playbackOffNotice: "再生機能はオフです。検索結果の表示と「ブラウザで開く」のみ使えます。",
			playbackDisabled: "再生機能がオフです。設定で「再生機能を有効化」をオンにしてください。",
			playbackOnToast: "再生機能を有効にしました",
			playbackOffToast: "再生機能を無効にしました",
			showGuide: "セットアップ手順を見る",
			guideTitle: "ローカル Wisp サーバーのセットアップ",
			guideIntro: (url) => `再生機能は、自分の PC 上の Wisp サーバー (${url}) を経由して動きます。次の手順で用意してください。`,
			guideStep1: "Python 3.9 以上、Node.js 22.18 以上 (または 24.11 以上)、npm を用意します (Linux は systemd も必要)。",
			guideStep2: "ターミナルで次のコマンドを実行します (クリックでコピーできます)。セットアップスクリプトをダウンロードしてインストールを行います。完了したらダウンロードしたファイルは削除しても構いません。",
			guideStep3: "終わったら、下のボタンで接続を確認します。確認できると再生機能が有効になります。",
			guideCheck: "接続を確認",
			guideReadme: "詳しい手順 (README)",
			guideChecking: "ローカル Wisp を確認中...",
			guideOk: "接続できました。",
			guideFailed: (url) => `${url} に接続できませんでした。セットアップを済ませてから、もう一度確認してください。`,
			copyHint: "クリックでコピー",
			copied: "コピーしました",
			saveToPlaylist: "プレイリストに保存",
			pickPlaylist: "保存先のプレイリスト",
			currentPlaylist: "いま開いているプレイリスト",
			loadingPlaylists: "読み込み中...",
			noPlaylists: "プレイリストが見つかりませんでした。",
			saving: "保存中...",
			savedToPlaylist: (name) => `「${name}」に保存しました`,
			saveNotIndexed: "ダミー曲が Spotify のローカルファイルに現れませんでした。選んだフォルダが Spotify の設定でローカルファイルのソースに入っているか確認してください。",
			saveFailed: (m) => `保存に失敗しました: ${m}`,
			badTrackId: "この曲は保存できません (IDが不正です)。",
		},
		en: {
			tabSpotify: "Spotify",
			tabYouTubeMusic: "YouTube Music",
			searching: "Searching YouTube Music...",
			noResults: "No matching songs on YouTube Music.",
			failed: "YouTube Music search failed.",
			retry: "Retry",
			loadingMore: "Loading more...",
			loadMoreFailed: "Failed to load more results.",
			openSettings: "Open settings",
			play: "Play",
			addQueue: "Add to queue",
			playNext: "Play next",
			openBrowser: "Open in browser",
			queueTitle: "Synthesis Spicetify queue",
			queueEmpty: "The queue is empty.",
			remove: "Remove",
			clear: "Clear all",
			playNow: "Play now",
			queueNowPlaying: "Playing from Synthesis Spicetify",
			queueSynthesisHead: "Synthesis Spicetify queue",
			loading: (p) => `Loading ${Math.round(p * 100)}%`,
			preparing: "Preparing...",
			addedQueue: "Added to queue",
			addedNext: "Will play next",
			playFailed: (m) => `Playback failed: ${m}`,
			settingsTitle: "Synthesis Spicetify settings",
			wispLabel: "Public Wisp proxies (one per line, tried in order)",
			clientsLabel: "InnerTube clients (visionos / tv_samsung, comma separated, tried in order)",
			save: "Save",
			saved: "Settings saved",
			test: "Connection test",
			clearCache: "Clear audio cache",
			cacheCleared: "Audio cache cleared",
			resetSettings: "Reset settings",
			resetConfirm: "Click again to reset",
			resetDone: "Settings restored to defaults",
			privacyNote: "TLS is terminated inside this app by libcurl.js; the Wisp proxy only sees destination hostnames.",
			menu: "Synthesis Spicetify settings",
			botHint: "The shared Wisp proxy's IP is probably flagged by YouTube. Set up a local Wisp server on your PC and turn on \"Enable playback\" in the settings.",
			playbackLabel: "Enable playback",
			playbackDesc: "While off, only public Wisp proxies are used: you can search and open results in the browser, but not play them. Playback needs a local Wisp server.",
			playbackOffNotice: "Playback is off. You can search and open results in the browser.",
			playbackDisabled: "Playback is off. Turn on \"Enable playback\" in the settings.",
			playbackOnToast: "Playback enabled",
			playbackOffToast: "Playback disabled",
			showGuide: "Show setup steps",
			guideTitle: "Setting up the local Wisp server",
			guideIntro: (url) => `Playback goes through a Wisp server on your own PC (${url}). Set it up with these steps.`,
			guideStep1: "Get Python 3.9+, Node.js 22.18+ (or 24.11+) and npm (Linux also needs systemd).",
			guideStep2: "Run the following command in the terminal (you can click to copy it). Download the setup script and run the installation. Once complete, you may delete the downloaded file.",
			guideStep3: "When it is done, check the connection with the button below. Playback is enabled once the check succeeds.",
			guideCheck: "Check connection",
			guideReadme: "Detailed steps (README)",
			guideChecking: "Checking the local Wisp server...",
			guideOk: "Connected.",
			guideFailed: (url) => `Could not connect to ${url}. Finish the setup and check again.`,
			copyHint: "Click to copy",
			copied: "Copied",
			saveToPlaylist: "Save to playlist",
			pickPlaylist: "Save to playlist",
			currentPlaylist: "Currently open playlist",
			loadingPlaylists: "Loading...",
			noPlaylists: "No playlists found.",
			saving: "Saving...",
			savedToPlaylist: (name) => `Saved to "${name}"`,
			saveNotIndexed: "The placeholder did not show up in Spotify's local files. Check that the chosen folder is a local files source in Spotify's settings.",
			saveFailed: (m) => `Saving failed: ${m}`,
			badTrackId: "This track cannot be saved (invalid ID).",
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
		// Same shapes as the icons of Spotify's own play/pause button (rounded bars, slightly larger triangle).
		barPlay: svg("M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"),
		barPause: svg("M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"),
		next: svg("M12.7 1h1.6v14h-1.6zM1.7 1.6v12.8a.5.5 0 0 0 .8.4l8.6-6.4a.5.5 0 0 0 0-.8L2.5 1.2a.5.5 0 0 0-.8.4z"),
		plus: svg("M15 7H9V1H7v6H1v2h6v6h2V9h6z"),
		savePlaylist: svg("M1 2h9v1.5H1zM1 6.25h9v1.5H1zM1 10.5h5v1.5H1zM12 8v2.5h2.5V12H12v2.5h-1.5V12H8v-1.5h2.5V8z"),
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
	const isLocalWisp = () => LOCAL_WISP_RE.test(activeWisp);

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

	// Playback needs a Wisp server on the user's own IP, so the local one is only tried when enabled.
	function activeWispServers() {
		if (!config.playbackEnabled) return config.wispServers;
		return [config.localWisp, ...config.wispServers.filter((url) => url !== config.localWisp)];
	}

	async function pickWispServer(libcurl) {
		const failures = [];
		for (const url of activeWispServers()) {
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
	// "gl" must be a two-letter ISO 3166-1 region. navigator.language may be "ja" (no region),
	// "en-001" / "es-419" (numeric UN M.49 area) or "zh-Hans-CN" (script subtag), and passing those
	// through as-is makes InnerTube answer HTTP 400 INVALID_ARGUMENT.
	function detectRegion() {
		try {
			const region = new Intl.Locale(navigator.language || "en-US").region;
			if (region && /^[A-Z]{2}$/.test(region)) return region;
		} catch {
			// Malformed locale tag: fall through to the default.
		}
		return "US";
	}

	const innertubes = { plain: null, player: null };
	function getInnertube(withPlayer = false) {
		const slot = withPlayer ? "player" : "plain";
		innertubes[slot] ??= (async () => {
			const mod = await import(YTJS_URL);
			// The web build has no JS evaluator; it is required to decipher signatures and "n" params.
			mod.Platform.shim.eval = async (data) => new Function(data.output)();
			const region = detectRegion();
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
				console.warn("[Synthesis Spicetify] Session bootstrap failed, retrying with a local session", error);
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

	// Fold width/case differences and drop punctuation so "Ado" / "ＡＤＯ" / "ado!" compare equal.
	function normalizeText(text) {
		return String(text ?? "")
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.trim();
	}

	function toTrack(item) {
		if (!item?.id || !item.title) return null;
		// Songs expose "artists"; videos (official MVs, uploads, covers) expose "authors" instead.
		const people = item.artists ?? item.authors ?? [];
		const thumbs = item.thumbnail?.contents ?? [];
		return {
			provider: "youtube",
			id: item.id,
			title: item.title,
			artists: people.map((person) => person.name).filter(Boolean),
			album: item.album?.name || "",
			durationMs: (item.duration?.seconds ?? 0) * 1000,
			thumbnail: resizeThumbnail(thumbs[thumbs.length - 1]?.url || thumbs[0]?.url),
		};
	}

	// One result stream for a single search type. The first page comes from search(); every later page
	// comes from getContinuation() (YouTube Music only offers continuations for filtered searches).
	function createPagedSearch(yt, query, type) {
		let page = null;
		let done = false;
		return {
			get done() {
				return done;
			},
			async next() {
				if (done) return [];
				// Assign state only after the request succeeded, so a failed call can simply be retried.
				let nextPage;
				let nodes;
				if (!page) {
					nextPage = await yt.music.search(query, { type });
					nodes = nextPage.contents?.find((node) => node.type === "MusicShelf")?.contents ?? [];
				} else {
					nextPage = await page.getContinuation();
					nodes = nextPage.contents?.contents ?? [];
				}
				page = nextPage;
				done = !page.has_continuation;
				return Array.from(nodes).map(toTrack).filter(Boolean);
			}
		};
	}

	// Songs only (the old behaviour) hides covers, live versions, remixes and uploads that exist only as
	// videos, which is why many tracks never showed up. Query both and merge the two result lists.
	// The returned session hands out results in pages (take) so the UI can load more while scrolling.
	function createYoutubeSearch(query) {
		const words = normalizeText(query).split(" ").filter(Boolean);
		const seen = new Set();
		const buffer = [];
		let streams = null;

		// Stable partition: tracks whose title/artist/album contain every query word go first. Everything
		// else keeps YouTube's own order, so a mismatch (e.g. localized artist names) never reorders results.
		// This only reorders within one fetched batch, so rows that are already on screen never move.
		const matches = (track) => {
			const haystack = normalizeText([track.title, ...track.artists, track.album].join(" "));
			return words.every((word) => haystack.includes(word));
		};

		async function fillBuffer() {
			const active = streams.filter((stream) => !stream.done);
			const settled = await Promise.allSettled(active.map((stream) => stream.next()));
			if (settled.every((r) => r.status === "rejected")) throw settled[0].reason;
			const lists = settled.map((r) => (r.status === "fulfilled" ? r.value : []));

			// Interleave by rank so neither list drowns the other, then drop duplicates (same id, or the same
			// title and first artist, which is typically a song and its own music video). The seen set is shared
			// across pages, so duplicates are also dropped between pages.
			const merged = [];
			for (let i = 0; i < Math.max(0, ...lists.map((list) => list.length)); i++) {
				for (const track of lists.map((list) => list[i])) {
					if (!track) continue;
					const key = `${normalizeText(track.title)}|${normalizeText(track.artists[0])}`;
					if (seen.has(track.id) || seen.has(key)) continue;
					seen.add(track.id);
					seen.add(key);
					merged.push(track);
				}
			}
			const hit = [];
			const rest = [];
			for (const track of merged) (words.length && matches(track) ? hit : rest).push(track);
			buffer.push(...hit, ...rest);
		}

		return {
			// True while there is anything left to hand out or to fetch.
			get hasMore() {
				return buffer.length > 0 || !streams || streams.some((stream) => !stream.done);
			},
			// Returns up to `count` tracks. Fetches further pages when the buffer runs dry.
			async take(count) {
				const yt = await getInnertube();
				streams ??= ["song", "video"].map((type) => createPagedSearch(yt, query, type));
				// A page can consist entirely of duplicates, so allow a few fetches before giving up.
				for (let attempt = 0; attempt < 5 && buffer.length < count && streams.some((stream) => !stream.done); attempt++) {
					await fillBuffer();
				}
				return buffer.splice(0, count);
			}
		};
	}

	async function youtubeSearch(query, limit) {
		return createYoutubeSearch(query).take(limit);
	}

	// ---- Audio download through libcurl (ranged requests, like YouTube's own player) ----
	async function downloadFormat(url, total, mime, { signal, onProgress, onStart, onChunk, userAgent } = {}) {
		const CHUNK = 10 * 1024 * 1024;
		const cpn = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[n % 64]).join("");
		const parts = [];
		let received = 0;
		let started = false;

		while (!total || received < total) {
			throwIfAborted(signal);
			const end = (total ? Math.min(received + CHUNK, total) : received + CHUNK) - 1;
			const res = await curlFetch(`${url}&cpn=${cpn}&range=${received}-${end}`, {
				method: "GET",
				headers: { accept: "*/*", origin: "https://www.youtube.com", referer: "https://www.youtube.com", ...(userAgent ? { "user-agent": userAgent } : {}) },
				signal,
			});
			if (!res.ok) throw new Error(`googlevideo returned HTTP ${res.status}`);
			if (!started) {
				started = true;
				onStart?.();
			}

			const reader = res.body.getReader();
			let chunkBytes = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parts.push(value);
				onChunk?.(value);
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
			.catch((error) => console.warn("[Synthesis Spicetify] session warm-up failed", error));
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

	async function youtubeFetchAudio(track, { signal, onProgress, onStart, onChunk } = {}) {
		if (!config.playbackEnabled) throw new Error(t("playbackDisabled"));
		const errors = [];
		let started = false;

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
					onChunk,
					onStart: () => {
						started = true;
						onStart?.(format.mimeType);
					},
					userAgent: CLIENT_DEFS[client].client.userAgent,
				});
				return { blob, mime: format.mimeType };
			} catch (error) {
				// libcurl.js rejects aborted requests with a DOMException named "Error" (or errors the body
				// stream with a plain string), so check the signal instead of relying on error.name.
				if (signal?.aborted || error?.name === "AbortError") throw new DOMException("Aborted", "AbortError");
				// Chunks already handed to the player cannot be taken back, so a failure mid-stream is final.
				if (started) throw error;
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
			createSearch: createYoutubeSearch,
			fetchAudio: youtubeFetchAudio,
			// fetchAudio reports onStart(mime) and onChunk(bytes) while downloading.
			streamable: true,
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

	// Returns the cached Blob URL of a finished download, or null.
	function peekAudioUrl(track) {
		const key = trackKey(track);
		const cached = audioCache.get(key);
		if (!cached) return null;
		audioCache.delete(key);
		audioCache.set(key, cached); // refresh LRU order
		return cached.url;
	}

	// Starts (or joins) the download of a track. Besides the final Blob URL, a job lets "sinks" follow
	// the download chunk by chunk. It keeps the chunks received so far, so a sink can join late.
	function getAudioJob(track) {
		const key = trackKey(track);
		let job = inflight.get(key);
		// A job that was aborted may still be listed until its request settles. Joining it would make this
		// request fail with an abort error, so start a fresh job instead.
		if (job && !job.controller.signal.aborted) return job;

		const controller = new AbortController();
		const created = { controller, listeners: new Set(), sinks: new Set(), mime: "", parts: [], finished: false, promise: null };
		created.promise = providers[track.provider]
			.fetchAudio(track, {
				signal: controller.signal,
				onProgress: (p) => created.listeners.forEach((fn) => fn(p)),
				onStart: (mime) => {
					created.mime = mime;
					created.sinks.forEach((sink) => sink.start(mime));
				},
				onChunk: (chunk) => {
					created.parts.push(chunk);
					created.sinks.forEach((sink) => sink.append(chunk));
				},
			})
			.then(({ blob }) => {
				created.finished = true;
				created.parts = [];
				created.sinks.forEach((sink) => sink.end());
				const url = URL.createObjectURL(blob);
				audioCache.set(key, { url });
				evictCache();
				return url;
			})
			.finally(() => {
				// Do not remove a newer job that replaced this one under the same key.
				if (inflight.get(key) === created) inflight.delete(key);
			});
		inflight.set(key, created);
		return created;
	}

	// Resolves with the Blob URL once the whole track has been downloaded.
	function getAudioUrl(track, onProgress) {
		const cachedUrl = peekAudioUrl(track);
		if (cachedUrl) return Promise.resolve(cachedUrl);

		const job = getAudioJob(track);
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
		history: [], // tracks already played from the virtual queue (for the previous button)
		resumeSpotify: false, // resume Spotify once the virtual queue drains
		suppressUntil: 0, // ignore Spotify events until this timestamp
		spotifySnapshot: null, // where Spotify was before its session was stopped ({ uri, ctx, position })
		viaDummy: false, // the active track was started from a saved placeholder; Spotify stays paused on it
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

	// Ends Spotify's playback session through the internal context player. Returns false when the
	// method is unavailable (Spotify update) or throws, so the caller can fall back to a plain pause.
	function stopSpotifySession() {
		try {
			const player = Spicetify.Platform?.PlayerAPI?._contextPlayer;
			if (typeof player?.stop !== "function") return false;
			const result = player.stop();
			if (result && typeof result.catch === "function") result.catch(() => {});
			return true;
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to stop Spotify session", error);
			return false;
		}
	}

	function pauseSpotify() {
		if (!Spicetify.Player.isPlaying()) return;
		state.resumeSpotify = true;
		const { uri, ctx } = readSpotify();
		const position = Spicetify.Player.getProgress();
		Spicetify.Player.pause();
		if (!config.stopSpotify || !uri) return;
		state.suppressUntil = Date.now() + 1000;
		if (stopSpotifySession()) state.spotifySnapshot = { uri, ctx, position };
	}

	// A stopped session cannot be resumed with play(), so start the saved track again.
	async function restoreSpotifySession(snapshot) {
		state.suppressUntil = Date.now() + 3000;
		try {
			await Spicetify.Player.playUri(snapshot.ctx || snapshot.uri, {}, { skipTo: { uri: snapshot.uri } });
			if (snapshot.position > 1000) Spicetify.Player.seek(snapshot.position);
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to restore Spotify session", error);
			Spicetify.Player.play();
		}
		state.suppressUntil = Date.now() + 1000;
	}

	function resumeSpotifyIfNeeded() {
		if (!state.resumeSpotify) return;
		state.resumeSpotify = false;
		const snapshot = state.spotifySnapshot;
		state.spotifySnapshot = null;
		if (snapshot) {
			restoreSpotifySession(snapshot);
			return;
		}
		state.suppressUntil = Date.now() + 1000;
		Spicetify.Player.play();
	}

	// A saved track leaves Spotify paused on its silent placeholder. Move on to whatever follows it in the
	// playlist instead of restoring the placeholder (which would start the same track again).
	function advancePastDummy() {
		Spicetify.Player.next();
		setTimeout(() => {
			// If the next item is a placeholder too, the songchange handler has already taken over.
			if (state.status === "idle" && !Spicetify.Player.isPlaying()) Spicetify.Player.play();
		}, 400);
	}

	// ---------------------------------------------------------------------
	// Progressive playback (Media Source Extensions)
	// ---------------------------------------------------------------------
	let activeStream = null; // { job, sink, cancel } of the track that is currently being streamed

	// Feeds downloaded chunks into a MediaSource attached to the shared <audio> element.
	function createMseSink({ expectedSec, onAttached, onError, onBlocked }) {
		const MAX_APPEND_BYTES = 512 * 1024;
		let mediaSource = null;
		let buffer = null;
		let objectUrl = "";
		let pending = [];
		let stalled = null; // a merged chunk that the browser refused for lack of space
		let blocked = false;
		let ended = false;
		let dead = false;

		function fail(error) {
			dead = true;
			pending = [];
			stalled = null;
			onError(error);
		}

		// Some containers (fragmented MP4) report no duration up front. Use the track's known length.
		function applyDuration() {
			if (!expectedSec || mediaSource.readyState !== "open") return;
			if (Number.isFinite(mediaSource.duration) && mediaSource.duration >= expectedSec) return;
			try {
				mediaSource.duration = expectedSec;
			} catch {
				// Best effort only: the real duration becomes known once the stream ends.
			}
		}

		function pump() {
			if (dead || !buffer || buffer.updating || mediaSource.readyState !== "open") return;
			if (!stalled && !pending.length) {
				if (ended) {
					try {
						mediaSource.endOfStream();
					} catch (error) {
						console.warn("[Synthesis Spicetify] endOfStream failed", error);
					}
				}
				return;
			}

			let chunk = stalled;
			if (!chunk) {
				// Merge small network chunks, so that there are fewer appendBuffer calls.
				let count = 0;
				let size = 0;
				while (count < pending.length && size < MAX_APPEND_BYTES) size += pending[count++].byteLength;
				chunk = new Uint8Array(size);
				let offset = 0;
				for (const part of pending.splice(0, count)) {
					chunk.set(part, offset);
					offset += part.byteLength;
				}
			}
			try {
				buffer.appendBuffer(chunk);
				stalled = null;
				blocked = false;
			} catch (error) {
				if (error?.name !== "QuotaExceededError") {
					fail(error);
					return;
				}
				// The browser's buffer is full of data ahead of the playhead (long tracks). Keep the chunk and
				// retry as playback advances: the browser then drops what has been played to make room.
				stalled = chunk;
				if (!blocked) {
					blocked = true;
					onBlocked?.();
				}
			}
		}

		return {
			start(mime) {
				if (dead || mediaSource) return;
				if (typeof MediaSource === "undefined" || !MediaSource.isTypeSupported(mime)) {
					const error = new Error(`MediaSource does not support ${mime}`);
					error.streamUnsupported = true;
					fail(error);
					return;
				}
				mediaSource = new MediaSource();
				objectUrl = URL.createObjectURL(mediaSource);
				mediaSource.addEventListener("sourceopen", () => {
					// The MediaSource also reopens after endOfStream() (e.g. on a seek), so create the buffer once.
					if (dead || buffer) return;
					try {
						buffer = mediaSource.addSourceBuffer(mime);
					} catch (error) {
						fail(error);
						return;
					}
					buffer.addEventListener("updateend", () => {
						applyDuration();
						pump();
					});
					buffer.addEventListener("error", () => fail(new Error("SourceBuffer error")));
					pump();
				});
				audio.src = objectUrl;
				onAttached();
			},
			append(chunk) {
				if (dead) return;
				pending.push(chunk);
				pump();
			},
			end() {
				ended = true;
				pump();
			},
			// Retries a refused chunk. Called while playback advances.
			poke() {
				if (blocked) pump();
			},
			isBlocked: () => blocked,
			// True once everything has been handed to the browser, so that nothing is left to wait for.
			isComplete: () => ended && !stalled && !pending.length && Boolean(buffer) && !buffer.updating,
			dispose() {
				dead = true;
				pending = [];
				stalled = null;
				if (objectUrl) URL.revokeObjectURL(objectUrl);
			},
		};
	}

	// Plays a track while it is still downloading. Resolves once playback has started. Rejects with an
	// error whose streamUnsupported flag is set when the caller should fall back to a full download.
	function streamTrack(track, token, onProgress) {
		return new Promise((resolve, reject) => {
			const job = getAudioJob(track);
			if (onProgress) job.listeners.add(onProgress);

			let settled = false;
			const settle = (fn, value) => {
				if (settled) return;
				settled = true;
				fn(value);
			};

			const sink = createMseSink({
				expectedSec: (track.durationMs ?? 0) / 1000,
				onAttached: () => {
					syncVolume();
					// Resolves as soon as enough data is buffered to start, not when the download is done.
					audio.play().then(
						() => settle(resolve),
						(error) => settle(reject, error)
					);
				},
				onError: (error) => {
					if (!settled) settle(reject, error);
					else console.error("[Synthesis Spicetify] stream error", error);
				},
				onBlocked: () => switchIfBlocked(),
			});
			activeStream = { job, sink, track, token, cancel: () => settle(reject, new DOMException("Aborted", "AbortError")) };

			// A long track does not fit into the browser's buffer. Once the whole file has been downloaded,
			// continue from the finished Blob at the current position.
			function switchIfBlocked() {
				if (settled && job.finished && sink.isBlocked() && activeStream?.sink === sink) switchToBlob(track, token);
			}

			// Join the download: replay what has arrived so far, then follow it.
			job.sinks.add(sink);
			if (job.mime) sink.start(job.mime);
			for (const chunk of job.parts) sink.append(chunk);
			if (job.finished) sink.end();

			job.promise.then(
				() => switchIfBlocked(),
				(error) => {
					if (!settled) {
						settle(reject, error);
						return;
					}
					// The download died after playback had started: nothing more will arrive.
					if (token !== playToken || error?.name === "AbortError") return;
					notify(t("playFailed", error?.message || error), true);
					playNextFromQueue();
				}
			);
		});
	}

	function detachStream() {
		if (!activeStream) return;
		const { job, sink, cancel } = activeStream;
		activeStream = null;
		job.sinks.delete(sink);
		sink.dispose();
		cancel();
	}

	// Replaces the stream by the finished download, keeping the position and the play state.
	function switchToBlob(track, token, position = audio.currentTime) {
		const url = peekAudioUrl(track);
		if (!url || token !== playToken) return false;
		const wasPlaying = !audio.paused;
		detachStream();
		audio.src = url;
		audio.addEventListener(
			"loadedmetadata",
			() => {
				if (token !== playToken) return;
				audio.currentTime = position;
				if (wasPlaying) audio.play().catch(() => {});
			},
			{ once: true }
		);
		return true;
	}

	// Fraction (0..1) of the track that can actually be played right now.
	function loadedFraction(duration) {
		if (!(duration > 0)) return 0;
		// Not streaming means the track plays from a finished download.
		if (!activeStream || activeStream.sink.isComplete()) return 1;
		const ranges = audio.buffered;
		if (!ranges.length) return 0;
		return Math.min(1, ranges.end(ranges.length - 1) / duration);
	}

	// While streaming, only positions inside the buffered data can be played.
	function seekAudio(seconds) {
		if (activeStream && !activeStream.sink.isComplete()) {
			const ranges = audio.buffered;
			let inside = false;
			for (let i = 0; i < ranges.length; i++) {
				if (seconds >= ranges.start(i) && seconds <= ranges.end(i)) inside = true;
			}
			if (!inside) {
				// Data behind the playhead may have been dropped on a long track. The finished download has it all.
				if (activeStream.job.finished && switchToBlob(activeStream.track, activeStream.token, seconds)) return;
				if (ranges.length) {
					const first = ranges.start(0);
					seconds = Math.min(Math.max(seconds, first), Math.max(first, ranges.end(ranges.length - 1) - 1));
				}
			}
		}
		audio.currentTime = seconds;
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

	async function playTrack(track, { fromHistory = false, keepSpotify = false } = {}) {
		const token = ++playToken;
		const previous = state.current;
		const previousStatus = state.status;
		if (previous && previousStatus === "loading") abortLoad(previous);
		// Remember tracks that actually played, so that the previous button can go back to them.
		if (previous && !fromHistory && (previousStatus === "playing" || previousStatus === "paused")) {
			state.history.push(previous);
			if (state.history.length > 20) state.history.shift();
		}

		detachStream();
		audio.pause();
		state.current = track;
		state.status = "loading";
		state.progress = 0;
		// A placeholder track is paused by the caller and must keep its Spotify session (see startFromDummy).
		if (!keepSpotify) pauseSpotify();
		renderMini();

		try {
			// The progress is only shown while loading; after playback has started it is no longer needed.
			const onProgress = (p) => {
				if (token !== playToken || state.status !== "loading") return;
				state.progress = p;
				renderMini();
			};

			let url = peekAudioUrl(track);
			let streamed = false;
			if (!url && providers[track.provider].streamable) {
				try {
					await streamTrack(track, token, onProgress);
					streamed = true;
				} catch (error) {
					// Without MSE support for this format, wait for the whole download instead.
					if (!error?.streamUnsupported) throw error;
					detachStream();
				}
			}
			if (token !== playToken) return;

			if (!streamed) {
				url ??= await getAudioUrl(track, onProgress);
				if (token !== playToken) return;
				audio.src = url;
				syncVolume();
				await audio.play();
				if (token !== playToken) return;
			}

			state.status = "playing";
			updateMediaSession(track);
			renderMini();
			if (config.prefetchNext && state.queue[0]) {
				getAudioUrl(state.queue[0]).catch(() => {});
			}
		} catch (error) {
			if (token !== playToken || error?.name === "AbortError") return;
			console.error("[Synthesis Spicetify] playback failed", error);
			notify(t("playFailed", error?.message || error), true);
			playNextFromQueue();
		}
	}

	function playNextFromQueue() {
		const next = state.queue.shift();
		renderQueueSection();
		if (next) {
			playTrack(next);
		} else {
			stopYT(true);
		}
	}

	function stopYT(resumeSpotify) {
		const viaDummy = state.viaDummy;
		state.viaDummy = false;
		playToken++;
		abortLoad(state.current);
		detachStream();
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		state.current = null;
		state.status = "idle";
		state.progress = 0;
		state.history.length = 0;
		renderMini();
		if (resumeSpotify) {
			if (viaDummy) advancePastDummy();
			else resumeSpotifyIfNeeded();
		} else {
			state.resumeSpotify = false;
			state.spotifySnapshot = null;
		}
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

	// Next button of Spotify's player bar while a non-Spotify track is active.
	function skipNext() {
		if (state.queue.length) {
			playNextFromQueue();
			return;
		}
		if (state.viaDummy) {
			stopYT(true); // moves Spotify on to whatever follows the placeholder
			return;
		}
		// The virtual queue is empty: hand control back to Spotify and skip to its next track.
		const wasPlaying = state.resumeSpotify;
		const snapshot = state.spotifySnapshot;
		stopYT(false);
		if (snapshot) {
			// The session was stopped: bring the saved track back, then skip it.
			restoreSpotifySession(snapshot).then(() => {
				Spicetify.Player.next();
			});
			return;
		}
		Spicetify.Player.next();
		if (wasPlaying) {
			setTimeout(() => {
				if (!Spicetify.Player.isPlaying()) Spicetify.Player.play();
			}, 400);
		}
	}

	// Previous button of Spotify's player bar: restart the track, or go back to the one before it.
	function skipPrev() {
		if (state.status === "loading") return;
		if (audio.currentTime > 3 || !state.history.length) {
			seekAudio(0);
			return;
		}
		const previous = state.history.pop();
		if (state.current) state.queue.unshift({ ...state.current, qid: ++qidCounter });
		playTrack(previous, { fromHistory: true });
		renderQueueSection();
	}

	function requirePlayback() {
		if (config.playbackEnabled) return true;
		notify(t("playbackDisabled"), true);
		return false;
	}

	function addToQueue(track, { next = false } = {}) {
		if (!requirePlayback()) return;
		const entry = { ...track, qid: ++qidCounter };
		if (next) state.queue.unshift(entry);
		else state.queue.push(entry);
		renderQueueSection();

		// Nothing is playing at all: start right away instead of leaving the track stranded.
		if (state.status === "idle" && !Spicetify.Player.isPlaying()) {
			playNextFromQueue();
			return;
		}
		notify(next ? t("addedNext") : t("addedQueue"));
		if (config.prefetchNext && state.queue[0]) getAudioUrl(state.queue[0]).catch(() => {});
	}

	function playNow(track) {
		if (!requirePlayback()) return;
		playTrack({ ...track });
	}

	// Audio element events
	audio.addEventListener("ended", () => playNextFromQueue());
	audio.addEventListener("error", () => {
		if (!audio.getAttribute("src")) return;
		notify(t("playFailed", audio.error?.message || "media error"), true);
		playNextFromQueue();
	});
	audio.addEventListener("timeupdate", () => {
		activeStream?.sink.poke();
		updateSeek();
	});
	audio.addEventListener("progress", () => updateTakeoverProgress());

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
	// Saving tracks to Spotify playlists (silent local-file placeholders)
	// ---------------------------------------------------------------------
	// A Spotify playlist can only hold Spotify items and local files, so a saved track is stored as a silent
	// MP3 whose tags (artist / "Synthesis" / title) and length give it a unique spotify:local: URI. The tags
	// carry no song information: the title is only the video ID, the artist a fixed label. The MP3 is
	// written into a folder that Spotify uses as a Local Files source, the URI is added to the playlist, and
	// when Spotify starts playing that URI the extension pauses Spotify and streams the real track instead.
	const SAVED_KEY = "synthesis-spicetify:saved";
	const DUMMY_ALBUM = "Synthesis"; // album tag of every placeholder, also used to recognise them
	const DUMMY_ARTIST = "YouTube"; // artist tag of every placeholder (fixed, so no song info is written)

	// The title tag of a placeholder. Only the video ID is written, which is unique per video, so the
	// playlist row does not reveal the song and the real track can be found again from the ID alone.
	const placeholderTitle = (track) => track.id;
	const HANDLE_DB = "synthesis-spicetify";

	function loadSaved() {
		try {
			return JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
		} catch {
			return {};
		}
	}

	const savedTracks = loadSaved(); // spotify:local: URI -> track

	function rememberSaved(uri, track) {
		savedTracks[uri] = track;
		try {
			localStorage.setItem(SAVED_KEY, JSON.stringify(savedTracks));
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to store saved tracks", error);
		}
	}

	// Builds a silent MP3 (MPEG-2 Layer III, 24 kHz, mono, 16 kbps) with ID3v2.3 tags. The first frame is an
	// Info header that carries the frame count, so the length is exact; TLEN repeats it for tag readers.
	function makeSilentMp3({ artist, album, title, seconds }) {
		const FRAME = 48; // 72 * 16000 / 24000 bytes, 576 samples = 24 ms per frame
		const frames = Math.ceil((seconds * 1000) / 24);
		const frame = (id, body) => {
			const out = new Uint8Array(10 + body.length);
			for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
			new DataView(out.buffer).setUint32(4, body.length); // ID3v2.3 frame sizes are plain big-endian
			out.set(body, 10);
			return out;
		};
		// UTF-16 with BOM (encoding byte 1), so that any title survives
		const text = (id, value) => {
			const body = new Uint8Array(3 + value.length * 2);
			body.set([1, 0xff, 0xfe]);
			for (let i = 0; i < value.length; i++) {
				const c = value.charCodeAt(i);
				body[3 + i * 2] = c & 0xff;
				body[4 + i * 2] = c >> 8;
			}
			return frame(id, body);
		};
		// TLEN is plain ISO-8859-1 digits, in milliseconds
		const numeric = (id, value) => {
			const s = String(value);
			const body = new Uint8Array(1 + s.length);
			for (let i = 0; i < s.length; i++) body[1 + i] = s.charCodeAt(i);
			return frame(id, body);
		};
		const parts = [text("TIT2", title), text("TPE1", artist), text("TALB", album), numeric("TLEN", seconds * 1000)];
		const tagSize = parts.reduce((n, p) => n + p.length, 0);
		const header = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f]);
		const audio = new Uint8Array(FRAME * (frames + 1));
		// Frame header: MPEG-2 Layer III, no CRC, bitrate index 2 (16 kbps), 24 kHz, mono.
		// The bitrate index must match FRAME, otherwise decoders reject the file as unplayable.
		for (let f = 0; f <= frames; f++) audio.set([0xff, 0xf3, 0x24, 0xc0], f * FRAME);
		audio.set([0x49, 0x6e, 0x66, 0x6f], 13); // "Info"
		new DataView(audio.buffer).setUint32(17, 1); // flags: frame count present
		new DataView(audio.buffer).setUint32(21, frames);
		const out = new Uint8Array(10 + tagSize + audio.length);
		out.set(header, 0);
		let pos = 10;
		for (const p of parts) {
			out.set(p, pos);
			pos += p.length;
		}
		out.set(audio, pos);
		return out;
	}

	// Escapes one URI field the way Spotify does for local files: A-Z a-z 0-9 - . _ ~ stay, a space becomes
	// "+", and every other UTF-8 byte becomes %XX. Both a mismatch and a missing file make the playlist row
	// unplayable, so waitForLocalUri() below prefers the URI Spotify reports itself.
	function encodeLocalField(value) {
		return Array.from(new TextEncoder().encode(value), (byte) => {
			if (byte === 0x20) return "+";
			const char = String.fromCharCode(byte);
			return /[A-Za-z0-9\-._~]/.test(char) ? char : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
		}).join("");
	}

	const localUri = (artist, album, title, seconds) =>
		`spotify:local:${encodeLocalField(artist)}:${encodeLocalField(album)}:${encodeLocalField(title)}:${seconds}`;

	// The placeholder folder handle is kept in IndexedDB so the folder only has to be chosen once.
	function openHandleDb() {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(HANDLE_DB, 1);
			request.onupgradeneeded = () => request.result.createObjectStore("handles");
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	}

	async function handleStore(mode, run) {
		const db = await openHandleDb();
		try {
			return await new Promise((resolve, reject) => {
				const request = run(db.transaction("handles", mode).objectStore("handles"));
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
		} finally {
			db.close();
		}
	}

	// Returns a writable handle of the placeholder folder. Call it from a click handler: both the folder
	// picker and the permission prompt need a user gesture.
	async function getDummyDir() {
		let dir = null;
		try {
			dir = await handleStore("readonly", (store) => store.get("dir"));
			if (dir) {
				let permission = await dir.queryPermission({ mode: "readwrite" });
				if (permission !== "granted") permission = await dir.requestPermission({ mode: "readwrite" });
				if (permission === "granted") return dir;
			}
		} catch (error) {
			console.warn("[Synthesis Spicetify] stored folder is not usable", error);
		}
		dir = await window.showDirectoryPicker({ id: "synthesis-saved", mode: "readwrite" });
		try {
			await handleStore("readwrite", (store) => store.put(dir, "dir"));
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to remember the folder", error);
		}
		return dir;
	}

	// Waits until Spotify's local file index lists the new placeholder and returns the URI Spotify uses for
	// it (null on timeout). Without the index API the URI we computed ourselves is trusted.
	async function waitForLocalUri(expected, { artist, title, seconds }) {
		const api = Spicetify.Platform?.LocalFilesAPI;
		if (typeof api?.getTracks !== "function") return expected;
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			try {
				const tracks = (await api.getTracks()) ?? [];
				const exact = tracks.find((track) => track.uri === expected);
				if (exact) return exact.uri;
				const loose = tracks.find(
					(track) =>
						track.name === title &&
						track.album?.name === DUMMY_ALBUM &&
						track.artists?.[0]?.name === artist &&
						Math.round((track.duration?.milliseconds ?? 0) / 1000) === seconds
				);
				if (loose) return loose.uri;
			} catch (error) {
				console.warn("[Synthesis Spicetify] local files index not readable yet", error);
			}
			await sleep(500);
		}
		return null;
	}

	// Two different videos can share artist, title and length. They must not share a URI, so the length
	// moves up by a second until the URI is free (or already belongs to the same video).
	function pickLocalUri(track, seconds) {
		for (let i = 0; i < 30; i++, seconds++) {
			const uri = localUri(DUMMY_ARTIST, DUMMY_ALBUM, placeholderTitle(track), seconds);
			const owner = savedTracks[uri];
			if (!owner || owner.id === track.id) return { uri, seconds };
		}
		throw new Error("too many saved tracks share this title and length");
	}

	async function saveTrackToPlaylist(track, playlist) {
		if (!/^[\w-]+$/.test(track.id)) throw new Error(t("badTrackId"));
		const dir = await getDummyDir(); // first: it needs the user gesture of the click
		const title = placeholderTitle(track);
		const base = Math.max(1, Math.round((track.durationMs || 180000) / 1000));
		const { uri: expected, seconds } = pickLocalUri(track, base);
		notify(t("saving"));

		// The file name does not matter to Spotify (the URI comes from the tags), so the video ID is used.
		const handle = await dir.getFileHandle(`${track.id}.mp3`, { create: true });
		const writable = await handle.createWritable();
		await writable.write(makeSilentMp3({ artist: DUMMY_ARTIST, album: DUMMY_ALBUM, title, seconds }));
		await writable.close();

		const uri = await waitForLocalUri(expected, { artist: DUMMY_ARTIST, title, seconds });
		if (!uri) throw new Error(t("saveNotIndexed"));
		await Spicetify.Platform.PlaylistAPI.add(playlist.uri, [uri], { after: "end" });
		rememberSaved(uri, {
			provider: track.provider,
			id: track.id,
			title: track.title,
			artists: track.artists,
			album: track.album,
			durationMs: track.durationMs,
			thumbnail: track.thumbnail,
		});
		notify(t("savedToPlaylist", playlist.name));
	}

	// ---- Playlist picker (small popup next to the save button) ----
	let picker = null;

	function closePicker() {
		picker?.remove();
		picker = null;
		document.removeEventListener("mousedown", onPickerOutside, true);
		document.removeEventListener("keydown", onPickerKey, true);
	}

	function onPickerOutside(event) {
		if (picker && !picker.contains(event.target)) closePicker();
	}

	function onPickerKey(event) {
		if (event.key === "Escape") closePicker();
	}

	// The playlist page that is open right now, if any (works without any internal API).
	function currentPlaylist() {
		const match = (Spicetify.Platform.History.location?.pathname || "").match(/^\/playlist\/([A-Za-z0-9]+)/);
		return match ? { uri: `spotify:playlist:${match[1]}`, name: t("currentPlaylist") } : null;
	}

	// The user's playlists from the sidebar library, folders flattened. Uses an internal API.
	async function listPlaylists() {
		const api = Spicetify.Platform?.RootlistAPI;
		if (typeof api?.getContents !== "function") return [];
		const root = await api.getContents();
		const found = [];
		const walk = (items) => {
			for (const item of items ?? []) {
				if (item.type === "folder") walk(item.items);
				else if (item.type === "playlist" && item.uri) found.push({ uri: item.uri, name: item.name || item.uri });
			}
		};
		walk(root?.items);
		return found;
	}

	async function openPlaylistPicker(track, anchor) {
		closePicker();
		const list = h("div", { class: "ss-picker-list" }, h("div", { class: "ss-picker-note" }, t("loadingPlaylists")));
		const popup = h("div", { class: "ss-picker", role: "menu" }, h("div", { class: "ss-picker-head" }, t("pickPlaylist")), list);
		picker = popup;
		document.body.append(popup);

		// Below the button, right edges aligned, kept inside the window
		const rect = anchor.getBoundingClientRect();
		popup.style.left = `${Math.max(8, Math.min(window.innerWidth - 288, rect.right - 280))}px`;
		popup.style.top = `${Math.max(8, Math.min(window.innerHeight - 328, rect.bottom + 4))}px`;
		document.addEventListener("mousedown", onPickerOutside, true);
		document.addEventListener("keydown", onPickerKey, true);

		const choose = (playlist) => {
			closePicker();
			saveTrackToPlaylist(track, playlist).catch((error) => {
				if (error?.name === "AbortError") return; // the folder dialog was cancelled
				console.error("[Synthesis Spicetify] saving failed", error);
				notify(t("saveFailed", error?.message || error), true);
			});
		};

		let playlists = [];
		try {
			playlists = await listPlaylists();
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to list playlists", error);
		}
		if (picker !== popup) return; // closed while the list was loading
		const open = currentPlaylist();
		const entries = open ? [open, ...playlists.filter((playlist) => playlist.uri !== open.uri)] : playlists;
		list.replaceChildren(
			...(entries.length
				? entries.map((playlist) => h("button", { class: "ss-picker-item", title: playlist.name, onClick: () => choose(playlist) }, playlist.name))
				: [h("div", { class: "ss-picker-note" }, t("noPlaylists"))])
		);
	}

	// ---- Playing a placeholder ----
	function isDummyItem() {
		const item = Spicetify.Player.data?.item;
		if (!item?.uri?.startsWith("spotify:local:")) return false;
		return Boolean(savedTracks[item.uri]) || item.album?.name === DUMMY_ALBUM;
	}

	// Spotify just started a placeholder. Pause it (keeping its session, so that the playlist can move on
	// afterwards) and stream the real track instead.
	async function startFromDummy() {
		const item = Spicetify.Player.data?.item;
		const uri = item?.uri;
		state.suppressUntil = Date.now() + 500; // our own pause must not look like a user action
		Spicetify.Player.pause();
		if (!requirePlayback()) return;

		let track = savedTracks[uri];
		if (!track) {
			// No stored mapping (for example the extension data was cleared): the title tag is the video ID,
			// and playback only needs the ID. Display details are missing, so the ID stands in for the title.
			if (/^[\w-]+$/.test(item.name || "")) {
				const info = displayInfo.get(item.name);
				track = {
					provider: "youtube",
					id: item.name,
					title: info?.title || item.name,
					artists: info?.artist ? [info.artist] : [],
					album: "",
					durationMs: item.duration?.milliseconds ?? 0,
					thumbnail: "",
				};
			} else {
				// A placeholder made by an older version: its tags hold the artist and title, so search by them.
				const query = [item.artists?.[0]?.name, item.name].filter(Boolean).join(" ");
				try {
					track = (await youtubeSearch(query, 1))[0];
				} catch (error) {
					console.warn("[Synthesis Spicetify] placeholder lookup failed", error);
				}
				if (!track) {
					notify(t("playFailed", query), true);
					return;
				}
			}
		}
		if (Spicetify.Player.data?.item?.uri !== uri) return; // Spotify moved on while we were searching

		state.resumeSpotify = false;
		state.spotifySnapshot = null;
		state.viaDummy = true;
		playTrack({ ...track }, { keepSpotify: true });
	}

	// ---- Showing real names for placeholders ----
	// The placeholder file only carries the video ID as its title and a fixed artist / album, so Spotify's own
	// rows (playlists, queue, player bar) would show "dQw4w9WgXcQ / YouTube / Synthesis". Only the DOM text is
	// rewritten here: nothing is written to the file or to Spotify's data, and the real values live in memory.
	const VIDEO_ID_RE = /^[\w-]{11}$/;
	const displayInfo = new Map(); // video ID -> { title, artist, album }
	const displayFetchedAt = new Map(); // video ID -> time of the last lookup, so a failure is retried only rarely

	function savedById(id) {
		for (const track of Object.values(savedTracks)) if (track.id === id) return track;
		return null;
	}

	// Display details of a placeholder's video ID, or null while they are still being looked up.
	function lookupDisplay(id) {
		const known = displayInfo.get(id);
		if (known) return known;
		const saved = savedById(id);
		if (saved?.title) {
			const info = { title: saved.title, artist: (saved.artists || []).join(", "), album: saved.album || "" };
			displayInfo.set(id, info);
			return info;
		}
		fetchDisplay(id);
		return null;
	}

	// No stored mapping (for example the extension data was cleared): ask YouTube's oEmbed endpoint, which
	// needs no API key and returns the title and the channel name of any public video.
	async function fetchDisplay(id) {
		if (Date.now() - (displayFetchedAt.get(id) || 0) < 60000) return;
		displayFetchedAt.set(id, Date.now());
		try {
			const watch = `https://www.youtube.com/watch?v=${id}`;
			const res = await curlFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
				method: "GET",
				headers: { accept: "application/json" },
			});
			if (!res.ok) throw new Error(`oEmbed returned HTTP ${res.status}`);
			const data = await res.json();
			if (!data?.title) return;
			// Auto-generated artist channels are called "<artist> - Topic".
			const artist = String(data.author_name || "").replace(/\s+-\s+Topic$/i, "");
			displayInfo.set(id, { title: data.title, artist, album: "" });
			scheduleDisplayRewrite(true);
		} catch (error) {
			console.warn("[Synthesis Spicetify] display lookup failed", id, error);
		}
	}

	function findTextNode(scope, value) {
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node.nodeValue.trim() === value) return node;
		}
		return null;
	}

	function countIdNodes(scope) {
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		let count = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (VIDEO_ID_RE.test(node.nodeValue.trim())) count++;
		}
		return count;
	}

	// The element that holds exactly one track: a tracklist row, or else (queue, player bar) the nearest
	// ancestor that has the fixed artist next to this title and no other ID-like text, so that a list
	// containing several rows is never mistaken for one track.
	function findTrackScope(owner) {
		const row = owner.closest('[data-testid="tracklist-row"], [role="row"]');
		if (row) return findTextNode(row, DUMMY_ARTIST) ? row : null;
		let scope = owner;
		for (let depth = 0; depth < 6 && scope; depth++, scope = scope.parentElement) {
			if (!findTextNode(scope, DUMMY_ARTIST)) continue;
			return countIdNodes(scope) === 1 ? scope : null;
		}
		return null;
	}

	// If this text node is a placeholder's title (a video ID next to the fixed artist), swap in the real text.
	// Only nodeValue is changed, so React keeps owning the node and simply overwrites it when the row is reused.
	function rewriteTextNode(node) {
		const id = node.nodeValue?.trim();
		if (!id || !VIDEO_ID_RE.test(id)) return;
		const owner = node.parentElement;
		if (!owner || owner.closest('[class^="ss-"], [class*=" ss-"]')) return;

		const scope = findTrackScope(owner);
		if (!scope) return;
		const artistNode = findTextNode(scope, DUMMY_ARTIST);
		if (!artistNode) return;

		const info = lookupDisplay(id);
		if (!info) return;
		node.nodeValue = info.title;
		if (info.artist) artistNode.nodeValue = info.artist;
		if (info.album) {
			const albumNode = findTextNode(scope, DUMMY_ALBUM);
			if (albumNode) albumNode.nodeValue = info.album;
		}
	}

	function rewriteWithin(root) {
		if (root.nodeType === Node.TEXT_NODE) {
			rewriteTextNode(root);
			return;
		}
		if (root.nodeType !== Node.ELEMENT_NODE) return;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const found = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) found.push(node);
		for (const node of found) rewriteTextNode(node);
	}

	const rewriteQueue = new Set();
	let rewriteScheduled = false;
	let rewriteAll = false;

	function scheduleDisplayRewrite(everything = false) {
		if (everything) rewriteAll = true;
		if (rewriteScheduled) return;
		rewriteScheduled = true;
		requestAnimationFrame(() => {
			rewriteScheduled = false;
			const nodes = [...rewriteQueue];
			rewriteQueue.clear();
			if (rewriteAll) {
				rewriteAll = false;
				rewriteWithin(document.body);
				return;
			}
			for (const node of nodes) if (node.isConnected) rewriteWithin(node);
		});
	}

	new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			if (mutation.type === "characterData") rewriteQueue.add(mutation.target);
			else for (const node of mutation.addedNodes) rewriteQueue.add(node);
		}
		if (rewriteQueue.size) scheduleDisplayRewrite();
	}).observe(document.body, { childList: true, subtree: true, characterData: true });
	scheduleDisplayRewrite(true);

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

		// A saved track's silent placeholder started: stream the real track instead.
		if (isDummyItem()) {
			startFromDummy();
			return;
		}

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
		h("style", { id: "synthesis-spicetify-style" }, `
		.ss-section { margin: 8px 0 24px; padding: 0 var(--content-spacing, 32px); box-sizing: border-box; }
		.ss-tabs { display: flex; gap: 8px; margin: 8px 0 16px; }
		.ss-tab { appearance: none; border: 0; cursor: pointer; padding: 6px 14px; border-radius: 999px; font-size: 14px; font-weight: 500; font-family: inherit; background: rgba(128, 128, 128, 0.22); color: var(--text-base, #fff); }
		.ss-tab:hover { background: rgba(128, 128, 128, 0.36); }
		.ss-tab[aria-selected="true"] { background: var(--text-base, #fff); color: var(--background-base, #121212); }
		/* While the YouTube Music tab is active, hide everything Spotify rendered next to our section */
		.ss-native-hidden > :not(.ss-section) { display: none !important; }
		.ss-section.ss-tab-spotify > .ss-body { display: none; }
		.ss-status { padding: 16px 8px; color: var(--text-subdued, #a7a7a7); font-size: 14px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
		.ss-more { min-height: 48px; }
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

		/* Search results: match the look of Spotify's own search rows (centered column, 64px cover, 16px/14px text) */
		.ss-body { max-width: 1152px; margin-left: auto; margin-right: auto; box-sizing: border-box; }
		.ss-body .ss-row { grid-template-columns: 64px minmax(0, 1fr) minmax(0, 0.5fr) auto 48px; gap: 12px; padding: 8px 12px; border-radius: 4px; }
		.ss-body .ss-row:hover, .ss-body .ss-row:focus-within { background: rgba(255, 255, 255, 0.1); }
		.ss-body .ss-cover-wrap, .ss-body .ss-cover { width: 64px; height: 64px; }
		.ss-body .ss-cover-play { background: rgba(0, 0, 0, 0.5); }
		.ss-body .ss-row:focus-within .ss-cover-play { display: flex; }
		.ss-body .ss-row:focus-within .ss-actions { opacity: 1; }
		.ss-body .ss-title { font-size: 16px; line-height: 24px; }
		.ss-body .ss-sub, .ss-body .ss-album, .ss-body .ss-dur { font-size: 14px; line-height: 20px; }
		.ss-body .ss-status { padding-left: 12px; padding-right: 12px; }
		@media (max-width: 900px) { .ss-body .ss-row { grid-template-columns: 64px minmax(0, 1fr) auto 48px; } }

		/* Top result: highlighted card like Spotify's own "top result" (72px cover, 24px bold title, green play button) */
		.ss-top { display: grid; grid-template-columns: 72px minmax(0, 1fr); grid-auto-flow: column; grid-auto-columns: auto; gap: 16px; align-items: center; margin: 0 0 24px; padding: 16px; border-radius: 8px; background: rgba(255, 255, 255, 0.07); }
		.ss-top:hover, .ss-top:focus-within { background: rgba(255, 255, 255, 0.1); }
		.ss-top-cover { width: 72px; height: 72px; border-radius: 4px; object-fit: cover; background: rgba(128, 128, 128, 0.3); }
		.ss-top-title { font-size: 24px; line-height: 32px; font-weight: 700; color: var(--text-base, #fff); }
		.ss-top-sub { font-size: 14px; line-height: 20px; color: var(--text-subdued, #a7a7a7); }
		.ss-top-title, .ss-top-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-top:hover .ss-actions, .ss-top:focus-within .ss-actions { opacity: 1; }
		.ss-top-play { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border: 0; border-radius: 50%; background: var(--essential-bright-accent, #1ed760); color: #000; cursor: pointer; }
		.ss-top-play:hover { transform: scale(1.06); }
		.ss-top-play:active { transform: scale(1); filter: brightness(0.7); }

		.ss-picker { position: fixed; z-index: 10000; width: 280px; max-height: 320px; display: flex; flex-direction: column; border-radius: 8px; background: var(--background-elevated-base, #282828); color: var(--text-base, #fff); box-shadow: 0 16px 24px rgba(0, 0, 0, 0.45); overflow: hidden; font-size: 14px; }
		.ss-picker-head { padding: 10px 12px 6px; font-weight: 700; }
		.ss-picker-list { overflow-y: auto; padding: 4px; }
		.ss-picker-item { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; padding: 8px 10px; border-radius: 4px; cursor: pointer; font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-picker-item:hover, .ss-picker-item:focus-visible { background: rgba(255, 255, 255, 0.1); outline: none; }
		.ss-picker-note { padding: 8px 10px; color: var(--text-subdued, #a7a7a7); }

		.ss-mini { position: fixed; left: 16px; bottom: 104px; z-index: 9999; width: 340px; display: none; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 10px; border-radius: 10px; background: var(--background-elevated-base, #242424); color: var(--text-base, #fff); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
		.ss-mini.ss-visible { display: grid; }
		.ss-mini-cover { width: 48px; height: 48px; border-radius: 6px; object-fit: cover; background: rgba(128, 128, 128, 0.3); }
		.ss-mini-title { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-mini-sub { font-size: 12px; color: var(--text-subdued, #a7a7a7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-mini-seek { width: 100%; margin: 6px 0 0; accent-color: var(--essential-bright-accent, #1ed760); }
		.ss-mini-ctrl { display: flex; gap: 2px; }

		.ss-own { display: none; }
		.ss-takeover [data-ss-host] > :not(.ss-own) { display: none !important; }
		.ss-takeover .ss-np { display: flex; align-items: center; gap: 12px; min-width: 0; grid-column: 1 / -1; width: 100%; }
		.ss-np-cover { width: 56px; height: 56px; flex: none; border-radius: 4px; object-fit: cover; background: rgba(128, 128, 128, 0.3); }
		.ss-np-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
		.ss-np-title { padding: 0; border: 0; background: transparent; color: var(--text-base, #fff); font: inherit; font-size: 14px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
		.ss-np-title:hover { text-decoration: underline; }
		.ss-np-sub { font-size: 12px; color: var(--text-subdued, #a7a7a7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.ss-takeover .ss-pb { display: flex; align-items: center; gap: 8px; width: 100%; }
		.ss-pb-time { flex: none; min-width: 40px; font-size: 11px; color: var(--text-subdued, #a7a7a7); font-variant-numeric: tabular-nums; }
		.ss-pb-pos { text-align: right; }
		/* Progress bar that mimics Spotify's own: 12px hit area, 4px track, white fill that turns green on hover, thumb and time tooltip on hover */
		.ss-pb-bar { --ss-fill: var(--text-base, #fff); --ss-pct: 0%; --ss-buf: 100%; --ss-prev: 0%; position: relative; display: flex; align-items: center; flex: 1; min-width: 0; height: 12px; cursor: pointer; touch-action: none; outline: none; }
		.ss-pb-bar:hover, .ss-pb-bar.ss-seeking { --ss-fill: var(--essential-bright-accent, #1ed760); }
		.ss-pb-bar.ss-disabled { cursor: progress; }
		.ss-pb-bar.ss-disabled:hover { --ss-fill: var(--text-base, #fff); }
		.ss-pb-track { position: relative; width: 100%; height: 4px; border-radius: 2px; overflow: hidden; background: #4d4d4d; }
		.ss-pb-track > div { position: absolute; top: 0; bottom: 0; left: 0; }
		/* Part of the track that cannot be played yet while the audio is still streaming */
		.ss-pb-unloaded { left: var(--ss-buf) !important; right: 0; background: rgba(0, 0, 0, 0.35); }
		/* Lighter highlight between the playhead and the mouse pointer */
		.ss-pb-preview { width: var(--ss-prev); background: #cacaca; opacity: 0; }
		.ss-pb-bar:hover:not(.ss-disabled) .ss-pb-preview, .ss-pb-bar.ss-seeking .ss-pb-preview { opacity: 1; }
		.ss-pb-fill { width: var(--ss-pct); background: var(--ss-fill); }
		.ss-pb-thumb { position: absolute; top: 50%; left: var(--ss-pct); width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #fff; box-shadow: 0 2px 4px rgba(0, 0, 0, 0.5); opacity: 0; pointer-events: none; }
		.ss-pb-bar:hover:not(.ss-disabled) .ss-pb-thumb, .ss-pb-bar.ss-seeking .ss-pb-thumb, .ss-pb-bar:focus-visible .ss-pb-thumb { opacity: 1; }
		.ss-pb-tip { position: fixed; z-index: 100000; display: none; padding: 4px 8px; border-radius: 4px; background: #2a2a2a; color: #fff; font-size: 12px; font-weight: 700; line-height: 16px; font-variant-numeric: tabular-nums; white-space: nowrap; pointer-events: none; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }
		.ss-pb-tip.ss-visible { display: block; }
		/* Spotify's own play/pause circle lives in a child element that is hidden above, so draw the circle here */
		.ss-takeover .ss-pp-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--text-base, #fff); color: var(--background-base, #000); transition: transform 0.03s linear; }
		.ss-takeover .ss-pp-icon svg { display: block; width: 16px; height: 16px; }
		.ss-takeover [data-ss-host]:hover > .ss-pp-icon { transform: scale(1.06); }
		.ss-takeover [data-ss-host]:active > .ss-pp-icon { transform: scale(1); filter: brightness(0.7); }

		.ss-queue-block { display: flex; flex-direction: column; gap: 0; padding: 0 0 8px; box-sizing: border-box; }
		/* Rows look like Spotify's own queue rows: 48px cover, 16px title, 14px subtitle, hover highlight bleeding 8px outwards */
		.ss-queue-block .ss-row { grid-template-columns: 48px minmax(0, 1fr) auto; gap: 12px; margin: 0 -8px; padding: 8px; border-radius: 4px; }
		.ss-queue-block .ss-row:hover, .ss-queue-block .ss-row:focus-within { background: rgba(255, 255, 255, 0.1); }
		.ss-queue-block .ss-cover-wrap, .ss-queue-block .ss-cover { width: 48px; height: 48px; }
		.ss-queue-block .ss-cover-play { background: rgba(0, 0, 0, 0.5); }
		.ss-queue-block .ss-row:focus-within .ss-cover-play { display: flex; }
		.ss-queue-block .ss-title { font-size: 16px; line-height: 24px; }
		.ss-queue-block .ss-sub { font-size: 14px; line-height: 20px; }
		.ss-queue-block .ss-row.ss-current .ss-title { color: var(--text-bright-accent, var(--essential-bright-accent, #1ed760)); }
		.ss-queue-block .ss-actions { opacity: 0; }
		.ss-queue-block .ss-row:hover .ss-actions, .ss-queue-block .ss-row:focus-within .ss-actions { opacity: 1; }
		.ss-queue-block .ss-link { align-self: flex-start; margin: 8px 0 0; font-size: 14px; }
		.ss-queue-head { margin: 16px 0 8px; font-size: 16px; line-height: 24px; font-weight: 700; color: var(--text-base, #fff); }
		.ss-settings label { display: block; margin: 12px 0 4px; font-size: 13px; color: var(--text-subdued, #a7a7a7); }
		.ss-settings textarea, .ss-settings input[type="text"] { width: 100%; box-sizing: border-box; padding: 8px; border-radius: 6px; border: 1px solid rgba(128, 128, 128, 0.5); background: rgba(128, 128, 128, 0.15); color: var(--text-base, #fff); font-family: monospace; font-size: 12px; }
		.ss-settings .ss-buttons { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
		.ss-settings button.ss-primary { padding: 8px 16px; border: 0; border-radius: 500px; background: var(--essential-bright-accent, #1ed760); color: #000; font-weight: 700; cursor: pointer; }
		.ss-settings button.ss-secondary { padding: 8px 16px; border: 1px solid rgba(128, 128, 128, 0.6); border-radius: 500px; background: transparent; color: var(--text-base, #fff); cursor: pointer; }
		.ss-settings pre { margin: 12px 0 0; padding: 10px; max-height: 220px; overflow: auto; border-radius: 6px; background: rgba(0, 0, 0, 0.35); font-size: 11px; white-space: pre-wrap; }
		.ss-settings small { display: block; margin-top: 10px; color: var(--text-subdued, #a7a7a7); }
		.ss-settings label.ss-toggle { display: flex; align-items: center; gap: 12px; margin: 0; font-size: 15px; font-weight: 600; color: var(--text-base, #fff); cursor: pointer; }
		.ss-switch { position: relative; width: 40px; height: 22px; flex: none; }
		.ss-switch input { position: absolute; inset: 0; z-index: 1; margin: 0; opacity: 0; cursor: pointer; }
		.ss-switch span { position: absolute; inset: 0; border-radius: 22px; background: rgba(128, 128, 128, 0.6); transition: background 0.15s; }
		.ss-switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
		.ss-switch input:checked + span { background: var(--essential-bright-accent, #1ed760); }
		.ss-switch input:checked + span::after { transform: translateX(18px); }
		.ss-switch.ss-checking input { cursor: progress; }
		.ss-switch.ss-checking span::after { left: 11px; box-sizing: border-box; background: transparent; border: 2px solid #fff; border-top-color: transparent; animation: ss-spin 0.8s linear infinite; }
		@keyframes ss-spin { to { transform: rotate(360deg); } }
		.ss-settings .ss-desc { margin: 6px 0 0; font-size: 12px; color: var(--text-subdued, #a7a7a7); }
		.ss-settings .ss-guide { margin-top: 12px; padding: 12px 14px; border-radius: 8px; background: rgba(128, 128, 128, 0.12); font-size: 13px; }
		.ss-settings .ss-guide ol { margin: 8px 0 0; padding-left: 20px; }
		.ss-settings .ss-guide li { margin: 8px 0; }
		.ss-settings .ss-guide pre.ss-cmd { margin: 4px 0 0; max-height: none; cursor: pointer; user-select: all; }
		.ss-settings .ss-guide-status { margin-top: 10px; font-size: 13px; }
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
			if (duration > 0) seekAudio((Number(seek.value) / 1000) * duration);
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
		// The mini player is only a fallback for when Spotify's own player bar cannot be used.
		const takenOver = syncTakeover();
		ui.root.classList.toggle("ss-visible", Boolean(track) && state.status !== "idle" && !takenOver);
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
		updateTakeoverProgress();
		if (!mini || state.status === "loading") return;
		const duration = Number.isFinite(audio.duration) ? audio.duration : (state.current?.durationMs ?? 0) / 1000;
		if (duration > 0) mini.seek.value = String(Math.round((audio.currentTime / duration) * 1000));
	}

	// ---------------------------------------------------------------------
	// Player bar takeover
	// While a non-Spotify track is active, Spotify's own player bar shows and controls it:
	// the now playing widget, the progress bar and the play/pause, previous and next buttons.
	// Spotify's React nodes are never modified: our elements are appended next to them and
	// the originals are only hidden with CSS, so a re-render of Spotify cannot break anything.
	// If a part of the player bar cannot be found, the mini player is shown instead.
	// ---------------------------------------------------------------------
	const PLAYBAR = {
		// "-v2" is what current Spotify builds use; the plain name is kept for older builds.
		widget: '[data-testid="now-playing-widget-v2"], [data-testid="now-playing-widget"]',
		position: '[data-testid="playback-position"]',
		bar: '[data-testid="playback-progressbar"]',
		duration: '[data-testid="playback-duration"]',
		playPause: '[data-testid="control-button-playpause"]',
		skipForward: '[data-testid="control-button-skip-forward"]',
		skipBack: '[data-testid="control-button-skip-back"]',
	};
	const takeover = { active: false, ui: null, widget: null, progressHost: null, playPause: null };

	const isYTActive = () => Boolean(state.current) && state.status !== "idle";
	const setText = (el, text) => {
		if (el.textContent !== text) el.textContent = text;
	};
	const clock = (sec) => {
		const total = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
	};

	function trackDurationSec() {
		return Number.isFinite(audio.duration) ? audio.duration : (state.current?.durationMs ?? 0) / 1000;
	}

	function ensureTakeoverUi() {
		if (takeover.ui) return takeover.ui;
		const cover = h("img", { class: "ss-np-cover", alt: "" });
		const title = h("button", {
			class: "ss-np-title",
			title: t("openBrowser"),
			onClick: () => state.current && openInBrowser(state.current),
		});
		const sub = h("div", { class: "ss-np-sub" });
		const np = h("div", { class: "ss-own ss-np" }, cover, h("div", { class: "ss-np-text" }, title, sub));

		const pos = h("span", { class: "ss-pb-time ss-pb-pos" });
		const dur = h("span", { class: "ss-pb-time" });
		const fill = h("div", { class: "ss-pb-fill" });
		const preview = h("div", { class: "ss-pb-preview" });
		const unloaded = h("div", { class: "ss-pb-unloaded" });
		const track = h("div", { class: "ss-pb-track" }, unloaded, preview, fill);
		const thumb = h("div", { class: "ss-pb-thumb" });
		const tip = h("div", { class: "ss-pb-tip" });
		const seek = h("div", { class: "ss-pb-bar", role: "slider", tabindex: "0", "aria-label": "Seek", "aria-valuemin": "0" }, track, thumb);
		const ui = { np, cover, title, sub, pos, dur, seek, tip, seeking: false, dragFraction: 0, lastCoverUrl: "", lastIcon: "" };

		// Fraction (0..1) of the bar under the pointer.
		const fractionAt = (event) => {
			const rect = seek.getBoundingClientRect();
			return rect.width > 0 ? Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) : 0;
		};
		// Show the time under the pointer in a tooltip above the bar. It is attached to the body so that
		// no overflow rule of Spotify's player bar can clip it.
		const showTip = (event, fraction) => {
			const duration = trackDurationSec();
			if (!(duration > 0) || state.status === "loading") return hideTip();
			if (!tip.isConnected) document.body.append(tip);
			setText(tip, clock(fraction * duration));
			tip.classList.add("ss-visible");
			const rect = seek.getBoundingClientRect();
			const half = tip.offsetWidth / 2;
			const x = Math.min(Math.max(event.clientX, rect.left + half), rect.right - half);
			tip.style.left = `${Math.round(x - half)}px`;
			tip.style.top = `${Math.round(rect.top - tip.offsetHeight - 2)}px`;
		};
		const hideTip = () => tip.classList.remove("ss-visible");
		// Draw the playhead at the given fraction while dragging (the audio is only moved on release).
		const previewDrag = (fraction) => {
			ui.dragFraction = fraction;
			seek.style.setProperty("--ss-pct", `${(fraction * 100).toFixed(2)}%`);
			setText(pos, clock(fraction * trackDurationSec()));
		};
		const endDrag = (commit) => {
			if (!ui.seeking) return;
			ui.seeking = false;
			seek.classList.remove("ss-seeking");
			const duration = trackDurationSec();
			if (commit && duration > 0) seekAudio(ui.dragFraction * duration);
			updateTakeoverProgress();
		};

		seek.addEventListener("pointerdown", (event) => {
			if (event.button !== 0 || state.status === "loading" || !(trackDurationSec() > 0)) return;
			seek.setPointerCapture(event.pointerId);
			ui.seeking = true;
			seek.classList.add("ss-seeking");
			previewDrag(fractionAt(event));
		});
		seek.addEventListener("pointermove", (event) => {
			const fraction = fractionAt(event);
			seek.style.setProperty("--ss-prev", `${(fraction * 100).toFixed(2)}%`);
			if (ui.seeking) previewDrag(fraction);
			showTip(event, fraction);
		});
		seek.addEventListener("pointerup", () => endDrag(true));
		seek.addEventListener("pointercancel", () => endDrag(false));
		seek.addEventListener("pointerleave", () => {
			// While dragging, the pointer is captured, so the tooltip keeps following it.
			if (!ui.seeking) hideTip();
		});
		seek.addEventListener("pointerup", () => {
			if (!seek.matches(":hover")) hideTip();
		});
		// Keyboard: arrow keys move by 5 seconds like Spotify's own bar, Home and End jump to the edges.
		seek.addEventListener("keydown", (event) => {
			const duration = trackDurationSec();
			if (!(duration > 0) || state.status === "loading") return;
			const current = audio.currentTime;
			let target = null;
			if (event.key === "ArrowRight" || event.key === "ArrowUp") target = current + 5;
			else if (event.key === "ArrowLeft" || event.key === "ArrowDown") target = current - 5;
			else if (event.key === "Home") target = 0;
			else if (event.key === "End") target = duration;
			if (target == null) return;
			event.preventDefault();
			event.stopPropagation();
			seekAudio(Math.min(Math.max(target, 0), duration));
			updateTakeoverProgress();
		});
		ui.pb = h("div", { class: "ss-own ss-pb" }, pos, seek, dur);
		ui.icon = h("span", { class: "ss-own ss-pp-icon" });
		takeover.ui = ui;
		return ui;
	}

	// Find the smallest element that contains the position label, the bar and the duration label.
	function findProgressHost() {
		const pos = document.querySelector(PLAYBAR.position);
		const bar = document.querySelector(PLAYBAR.bar);
		const dur = document.querySelector(PLAYBAR.duration);
		if (!pos || !bar || !dur) return null;
		let el = pos.parentElement;
		while (el && el !== document.body && !(el.contains(bar) && el.contains(dur))) el = el.parentElement;
		return el && el !== document.body ? el : null;
	}

	// Cached lookups: renderMini() runs often while a track is loading.
	function lookupHosts() {
		if (!takeover.widget?.isConnected) takeover.widget = document.querySelector(PLAYBAR.widget);
		if (!takeover.progressHost?.isConnected) takeover.progressHost = findProgressHost();
		if (!takeover.playPause?.isConnected) takeover.playPause = document.querySelector(PLAYBAR.playPause);
	}

	function mountInto(host, own) {
		host.dataset.ssHost = "1";
		if (own.parentElement !== host) host.append(own);
	}

	// Returns true while Spotify's player bar is showing the active non-Spotify track.
	function syncTakeover() {
		if (!isYTActive()) {
			if (takeover.active) {
				takeover.active = false;
				document.body.classList.remove("ss-takeover");
			}
			return false;
		}
		lookupHosts();
		const { widget, progressHost, playPause } = takeover;
		if (!widget || !progressHost) {
			takeover.active = false;
			document.body.classList.remove("ss-takeover");
			return false;
		}

		const ui = ensureTakeoverUi();
		mountInto(widget, ui.np);
		mountInto(progressHost, ui.pb);
		if (playPause) mountInto(playPause, ui.icon);

		const track = state.current;
		const providerLabel = providers[track.provider]?.label;
		const artists = [track.artists.join(", "), providerLabel].filter(Boolean).join(" \u00b7 ");
		setText(ui.title, track.title);
		setText(ui.sub, state.status === "loading" ? `${t("loading", state.progress)}  -  ${artists}` : artists);
		if (ui.lastCoverUrl !== track.thumbnail) {
			ui.lastCoverUrl = track.thumbnail;
			ui.cover.removeAttribute("data-fallback");
			loadImage(ui.cover, track.thumbnail);
		}
		const icon = state.status === "playing" ? "barPause" : "barPlay";
		if (ui.lastIcon !== icon) {
			ui.lastIcon = icon;
			ui.icon.innerHTML = ICONS[icon];
		}

		document.body.classList.add("ss-takeover");
		takeover.active = true;
		updateTakeoverProgress();
		return true;
	}

	function updateTakeoverProgress() {
		const ui = takeover.ui;
		if (!ui || !takeover.active || ui.seeking) return;
		const loading = state.status === "loading";
		const duration = trackDurationSec();
		const fraction = loading ? state.progress : duration > 0 ? Math.min(1, audio.currentTime / duration) : 0;
		ui.seek.classList.toggle("ss-disabled", loading);
		ui.seek.style.setProperty("--ss-pct", `${(fraction * 100).toFixed(2)}%`);
		const loaded = loading ? 1 : loadedFraction(duration);
		ui.seek.style.setProperty("--ss-buf", `${(loaded * 100).toFixed(2)}%`);
		if (loading) ui.seek.removeAttribute("aria-valuenow");
		else {
			ui.seek.setAttribute("aria-valuemax", String(Math.round(duration)));
			ui.seek.setAttribute("aria-valuenow", String(Math.round(audio.currentTime)));
			ui.seek.setAttribute("aria-valuetext", clock(audio.currentTime));
		}
		setText(ui.pos, loading ? "" : clock(audio.currentTime));
		setText(ui.dur, duration > 0 ? clock(duration) : "");
	}

	// Route the buttons of Spotify's player bar to our track while it is taken over. This runs in the
	// capture phase on the document, before React sees the click, so Spotify never starts its own track.
	document.addEventListener(
		"click",
		(event) => {
			if (!takeover.active || !(event.target instanceof Element)) return;
			let action = null;
			if (event.target.closest(PLAYBAR.playPause)) action = toggleYT;
			else if (event.target.closest(PLAYBAR.skipForward)) action = skipNext;
			else if (event.target.closest(PLAYBAR.skipBack)) action = skipPrev;
			if (!action) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			action();
		},
		true
	);

	// ---------------------------------------------------------------------
	// Queue (injected into Spotify's own queue page)
	// ---------------------------------------------------------------------
	function renderQueueRow(track, index) {
		const img = h("img", { class: "ss-cover", alt: "" });
		loadImage(img, track.thumbnail);
		const playHere = () => {
			state.queue.splice(index, 1);
			playTrack(track);
			renderQueueSection();
		};
		return h(
			"div",
			{ class: "ss-row", onDblclick: playHere },
			h("div", { class: "ss-cover-wrap" }, img, h("button", { class: "ss-cover-play", title: t("playNow"), html: ICONS.play, onClick: playHere })),
			h("div", { class: "ss-meta" }, h("div", { class: "ss-title" }, track.title), h("div", { class: "ss-sub" }, track.artists.join(", "))),
			h(
				"div",
				{ class: "ss-actions" },
				h("button", {
					class: "ss-btn",
					title: t("remove"),
					html: ICONS.close,
					onClick: () => {
						state.queue.splice(index, 1);
						renderQueueSection();
					},
				})
			)
		);
	}

	// Read-only row for the Synthesis track that is currently playing.
	function renderStaticRow(track) {
		const img = h("img", { class: "ss-cover", alt: "" });
		loadImage(img, track.thumbnail);
		return h(
			"div",
			{ class: "ss-row ss-current" },
			h("div", { class: "ss-cover-wrap" }, img),
			h("div", { class: "ss-meta" }, h("div", { class: "ss-title" }, track.title), h("div", { class: "ss-sub" }, track.artists.join(", "))),
			h("div", { class: "ss-actions" })
		);
	}

	const queuePanel = { active: false, block: null };
	const QUEUE_BUTTON = '[data-testid="control-button-queue"]';

	// The queue lives in the right-hand panel; it is open while the queue button is pressed.
	function isQueueOpen() {
		return document.querySelector(QUEUE_BUTTON)?.getAttribute("aria-pressed") === "true";
	}

	// Section headings of Spotify's own queue ("Now playing", "Next in queue", ...), used as anchors.
	// Nothing here depends on obfuscated class names, except the stable "tab-panel" fragment of the panel.
	function findQueueHeadings() {
		const usable = (el) => !el.closest(".ss-queue-block");
		const headings = [...document.querySelectorAll('[class*="tab-panel"] h2')].filter(usable);
		if (!headings.length) return [];
		const panel = headings[0].closest('[class*="tab-panel"]');
		return headings.filter((el) => panel.contains(el));
	}

	// Rebuild our block for Spotify's queue panel: the active Synthesis track and the virtual queue.
	function renderQueueSection() {
		if (!queuePanel.active) return;
		if (!queuePanel.block) queuePanel.block = h("div", { class: "ss-queue-block" });
		const children = [];
		if (state.current) children.push(h("div", { class: "ss-queue-head" }, t("queueNowPlaying")), renderStaticRow(state.current));
		if (state.queue.length) {
			children.push(
				h("div", { class: "ss-queue-head" }, t("queueSynthesisHead")),
				...state.queue.map(renderQueueRow),
				h("button", { class: "ss-link", onClick: () => { state.queue.length = 0; renderQueueSection(); } }, t("clear"))
			);
		}
		queuePanel.block.replaceChildren(...children);
		attachQueueSection();
	}

	// While Spotify is the active player the block goes between the "Now playing" and "Next in queue"
	// sections (the order in which tracks play); while a Synthesis track is active it goes first.
	function attachQueueSection() {
		const block = queuePanel.block;
		if (!block) return;
		if (!queuePanel.active || !block.childElementCount) {
			block.remove();
			return;
		}
		const headings = findQueueHeadings();

		let parent = null;
		let before = null; // insert before this node; null means append to parent

		if (headings.length >= 2) {
			// The lowest common ancestor of the first two headings holds the queue's sections.
			parent = headings[0];
			while (parent && !parent.contains(headings[1])) parent = parent.parentElement;
			if (parent) {
				const sectionOf = (heading) => {
					let node = heading;
					while (node.parentElement && node.parentElement !== parent) node = node.parentElement;
					return node;
				};
				before = sectionOf(state.current ? headings[0] : headings[1]);
			}
		} else if (headings.length === 1) {
			parent = headings[0].parentElement?.parentElement || headings[0].parentElement;
			before = state.current ? headings[0].parentElement : headings[0].parentElement?.nextElementSibling || null;
			if (before && before.parentElement !== parent) before = null;
		}
		// Never put the block anywhere but into Spotify's queue panel.
		if (!parent) {
			block.remove();
			return;
		}

		// Already in place: do nothing, so the MutationObserver does not loop on our own change.
		if (block.parentElement === parent && (before ? block.nextElementSibling === before : block.nextElementSibling === null)) return;
		parent.insertBefore(block, before);
	}

	// Our playback state can change without a render call (e.g. a track ends) and the panel can be opened or
	// closed at any time, so poll; this also re-attaches the block if Spotify re-rendered the panel.
	let queueSignature = "";
	setInterval(() => {
		const active = isQueueOpen();
		const signature = [active, state.status, state.current?.title, state.queue.length].join("|");
		if (signature === queueSignature) {
			if (active) attachQueueSection();
			return;
		}
		queueSignature = signature;
		queuePanel.active = active;
		if (active) renderQueueSection();
		else queuePanel.block?.remove();
	}, 500);

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

	const search = {
		query: "",
		token: 0,
		timer: null,
		section: null,
		body: null,
		tabs: null,
		tab: "spotify",
		host: null,
		status: "idle",
		results: [],
		error: null,
		// Infinite scroll: the paged search session, a footer element that doubles as the scroll sentinel,
		// and the observer that fires when the footer comes close to the visible area.
		session: null,
		hasMore: false,
		loadingMore: false,
		moreError: null,
		footer: null,
		observer: null
	};

	function trackRow(track) {
		const img = h("img", { class: "ss-cover", alt: "", loading: "lazy" });
		loadImage(img, track.thumbnail);
		// Without playback enabled the rows only offer "open in browser".
		const canPlay = config.playbackEnabled;
		return h(
			"div",
			{ class: "ss-row", onDblclick: canPlay ? () => playNow(track) : null },
			h(
				"div",
				{ class: "ss-cover-wrap" },
				img,
				canPlay && h("button", { class: "ss-cover-play", title: t("play"), html: ICONS.play, onClick: () => playNow(track) })
			),
			h("div", { class: "ss-meta" }, h("div", { class: "ss-title" }, track.title), h("div", { class: "ss-sub" }, track.artists.join(", "))),
			h("div", { class: "ss-album" }, track.album),
			h(
				"div",
				{ class: "ss-actions" },
				canPlay && h("button", { class: "ss-btn", title: t("playNext"), html: ICONS.playNext, onClick: () => addToQueue(track, { next: true }) }),
				canPlay && h("button", { class: "ss-btn", title: t("addQueue"), html: ICONS.plus, onClick: () => addToQueue(track) }),
				canPlay && h("button", { class: "ss-btn", title: t("saveToPlaylist"), html: ICONS.savePlaylist, onClick: (event) => openPlaylistPicker(track, event.currentTarget) }),
				h("button", { class: "ss-btn", title: t("openBrowser"), html: ICONS.external, onClick: () => openInBrowser(track) })
			),
			h("div", { class: "ss-dur" }, formatTime(track.durationMs))
		);
	}

	// Highlighted card for the first search result
	function topResultRow(track) {
		const img = h("img", { class: "ss-top-cover", alt: "", loading: "lazy" });
		loadImage(img, track.thumbnail);
		const canPlay = config.playbackEnabled;
		return h(
			"div",
			{ class: "ss-top", onDblclick: canPlay ? () => playNow(track) : null },
			img,
			h("div", { class: "ss-meta" }, h("div", { class: "ss-top-title" }, track.title), h("div", { class: "ss-top-sub" }, track.artists.join(", "))),
			h(
				"div",
				{ class: "ss-actions" },
				canPlay && h("button", { class: "ss-btn", title: t("playNext"), html: ICONS.playNext, onClick: () => addToQueue(track, { next: true }) }),
				canPlay && h("button", { class: "ss-btn", title: t("addQueue"), html: ICONS.plus, onClick: () => addToQueue(track) }),
				canPlay && h("button", { class: "ss-btn", title: t("saveToPlaylist"), html: ICONS.savePlaylist, onClick: (event) => openPlaylistPicker(track, event.currentTarget) }),
				h("button", { class: "ss-btn", title: t("openBrowser"), html: ICONS.external, onClick: () => openInBrowser(track) })
			),
			canPlay && h("button", { class: "ss-top-play", title: t("play"), html: ICONS.play, onClick: () => playNow(track) })
		);
	}

	function ensureSection() {
		if (!search.section) {
			search.body = h("div", { class: "ss-body" });
			search.tabs = h(
				"div",
				{ class: "ss-tabs", role: "tablist" },
				...["spotify", "youtube"].map((id) =>
					h(
						"button",
						{ class: "ss-tab", role: "tab", "data-tab": id, onClick: () => setTab(id) },
						t(id === "spotify" ? "tabSpotify" : "tabYouTubeMusic")
					)
				)
			);
			search.section = h(
				"section",
				{ class: "ss-section" },
				search.tabs,
				search.body
			);
			applyTab();
		}
		return search.section;
	}

	// Reflect the selected tab on our section and on the Spotify results rendered next to it
	function applyTab() {
		if (!search.section) return;
		const youtube = search.tab === "youtube";
		search.section.classList.toggle("ss-tab-spotify", !youtube);
		for (const btn of search.tabs.children) btn.setAttribute("aria-selected", String(btn.dataset.tab === search.tab));
		const host = search.section.parentElement;
		if (search.host && search.host !== host) search.host.classList.remove("ss-native-hidden");
		search.host = host;
		host?.classList.toggle("ss-native-hidden", youtube);
	}

	function setTab(id) {
		if (search.tab === id) return;
		search.tab = id;
		applyTab();
	}

	function playbackNotice() {
		return h(
			"div",
			{ class: "ss-status" },
			h("span", {}, t("playbackOffNotice")),
			h("button", { class: "ss-link", onClick: openSettings }, t("openSettings"))
		);
	}

	// Footer below the result rows: shows the loading state or a retry button, and is the sentinel that
	// triggers loading the next page when it scrolls into view.
	function updateFooter() {
		if (!search.footer) search.footer = h("div", { class: "ss-more" });
		const { footer } = search;
		if (search.loadingMore) {
			footer.replaceChildren(h("div", { class: "ss-status" }, t("loadingMore")));
		} else if (search.moreError) {
			footer.replaceChildren(
				h(
					"div",
					{ class: "ss-status" },
					h("span", {}, `${t("loadMoreFailed")} ${search.moreError}`),
					h("button", { class: "ss-link", onClick: loadMore }, t("retry"))
				)
			);
		} else {
			footer.replaceChildren();
		}
	}

	// (Re)start observing the footer. observe() reports the current state right away, so a footer that is
	// already visible (few rows, tall window) immediately triggers the next page as well.
	function armObserver() {
		if (!search.observer) {
			// rootMargin starts loading before the user actually reaches the bottom.
			search.observer = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) loadMore();
				},
				{ rootMargin: "0px 0px 400px 0px" }
			);
		}
		search.observer.disconnect();
		if (search.footer && search.hasMore && !search.moreError) search.observer.observe(search.footer);
	}

	async function loadMore() {
		const { session } = search;
		if (!session || search.loadingMore || !search.hasMore || search.status !== "done") return;
		const token = search.token;
		search.loadingMore = true;
		search.moreError = null;
		updateFooter();
		try {
			const more = await session.take(config.resultLimit);
			if (token !== search.token) return;
			search.results.push(...more);
			search.footer.before(...more.map(trackRow));
			// An empty page means nothing new is left, even if YouTube still offers a continuation.
			search.hasMore = more.length > 0 && session.hasMore;
		} catch (error) {
			if (token !== search.token) return;
			console.error("[Synthesis Spicetify] loading more results failed", error);
			search.moreError = error?.message || String(error);
		} finally {
			// A newer search resets these fields itself, so a stale call must not touch them.
			if (token === search.token) {
				search.loadingMore = false;
				updateFooter();
				armObserver();
			}
		}
	}

	function renderSearch() {
		if (!search.body) return;
		const { status } = search;
		if (status !== "done") search.observer?.disconnect();
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
			updateFooter();
			search.body.replaceChildren(...(config.playbackEnabled ? [] : [playbackNotice()]), ...search.results.map((track, i) => (i === 0 ? topResultRow(track) : trackRow(track))), search.footer);
			armObserver();
		}
	}

	function attachSection() {
		if (!search.query || !search.section) return;
		if (!search.section.isConnected) {
			const scroll = document.querySelector(".main-view-container__scroll-node-child");
			if (!scroll) return;
			const host = scroll.querySelector('[data-testid="search-body"]') || scroll.firstElementChild || scroll;
			host.prepend(search.section);
		}
		applyTab();
	}

	function detachSection() {
		search.observer?.disconnect();
		search.host?.classList.remove("ss-native-hidden");
		search.host = null;
		search.section?.remove();
	}

	async function runSearch(query) {
		const token = ++search.token;
		search.query = query;
		search.status = "loading";
		search.session = null;
		search.hasMore = false;
		search.loadingMore = false;
		search.moreError = null;
		ensureSection();
		renderSearch();
		attachSection();

		try {
			const session = providers.youtube.createSearch(query);
			const results = await session.take(config.resultLimit);
			if (token !== search.token) return;
			search.session = session;
			search.results = results;
			search.hasMore = session.hasMore;
			search.status = "done";
		} catch (error) {
			if (token !== search.token) return;
			console.error("[Synthesis Spicetify] search failed", error);
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
	new MutationObserver((mutations) => {
		if (attachScheduled || (!search.query && !isYTActive() && !queuePanel.active)) return;
		// Ignore changes made by this extension to its own player bar elements.
		if (mutations.every((m) => m.target.closest?.(".ss-own"))) return;
		attachScheduled = true;
		requestAnimationFrame(() => {
			attachScheduled = false;
			attachSection();
			attachQueueSection();
			if (isYTActive()) syncTakeover();
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
			// Show the locale-dependent values that went into the request, to make HTTP 400 easier to trace.
			try {
				const client = (await getInnertube()).session.context.client;
				log(`Session context: gl=${client.gl}, hl=${client.hl}, timeZone=${client.timeZone}, navigator.language=${navigator.language}`);
			} catch (error) {
				log(`Session context unavailable: ${error?.message || error}`);
			}
			return;
		}

		if (!config.playbackEnabled) {
			log("Playback is disabled, so the player steps are skipped.");
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

	function resetNetwork() {
		// Reset the lazily created singletons so new Wisp settings take effect.
		curlPromise = null;
		innertubes.plain = null;
		innertubes.player = null;
		warmUpPromise = null;
		cookieJar.clear();
	}

	// Plain WebSocket handshake against the local Wisp server. With on-demand start this also wakes it up.
	function probeLocalWisp(url, timeoutMs = 10000) {
		return new Promise((resolve) => {
			let ws = null;
			let settled = false;
			const finish = (ok) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				try {
					ws?.close();
				} catch {
					// ignore
				}
				resolve(ok);
			};
			const timer = setTimeout(() => finish(false), timeoutMs);
			try {
				ws = new WebSocket(url);
				ws.addEventListener("open", () => finish(true));
				ws.addEventListener("error", () => finish(false));
				ws.addEventListener("close", () => finish(false));
			} catch {
				finish(false);
			}
		});
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			try {
				Spicetify.Platform.ClipboardAPI.copy(text);
			} catch {
				return;
			}
		}
		notify(t("copied"));
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
		const collect = () => {
			const wispList = wisp.value.split("\n").map((s) => s.trim()).filter(Boolean);
			const clientList = clients.value.split(",").map((s) => s.trim()).filter(Boolean);
			// An empty list would leave no usable Wisp server / client, so fall back to the defaults.
			return {
				wispServers: wispList.length ? wispList : DEFAULT_CONFIG.wispServers,
				clients: clientList.length ? clientList : DEFAULT_CONFIG.clients,
			};
		};

		// Playback toggle. The switch shows the saved state; turning it on only sticks once the local Wisp answers.
		const playback = h("input", { type: "checkbox" });
		playback.checked = config.playbackEnabled;
		const playbackSwitch = h("span", { class: "ss-switch" }, playback, h("span", {}));
		const guideStatus = h("div", { class: "ss-guide-status" });
		const checkButton = h("button", { class: "ss-primary", onClick: () => checkLocalWisp() }, t("guideCheck"));
		const command = (label, text) =>
			h(
				"div",
				{},
				label && h("div", { class: "ss-desc" }, label),
				h("pre", { class: "ss-cmd", title: t("copyHint"), onClick: () => copyText(text) }, text)
			);
		const guide = h(
			"div",
			{ class: "ss-guide", style: "display:none" },
			h("strong", {}, t("guideTitle")),
			h("div", { class: "ss-desc" }, t("guideIntro", config.localWisp)),
			h(
				"ol",
				{},
				h("li", {}, t("guideStep1")),
				h(
					"li",
					{},
					t("guideStep2"),
					command("Linux / macOS", `curl -fsSLO ${WISP_SCRIPT_URL} && python3 wisp_ondemand.py install`),
					command("Windows (PowerShell)", `curl.exe -fsSLO ${WISP_SCRIPT_URL}; py -3 wisp_ondemand.py install`)
				),
				h("li", {}, t("guideStep3"))
			),
			h(
				"div",
				{ class: "ss-buttons" },
				checkButton,
				h(
					"button",
					{
						class: "ss-secondary",
						onClick: () =>
							window.open("https://github.com/kagamiomochi/Synthesis-Spicetify#setting-up-the-local-wisp-server", "_blank", "noopener,noreferrer"),
					},
					t("guideReadme")
				)
			),
			guideStatus
		);

		let checkToken = 0;
		let checking = false;
		// While the connection is being verified the switch stays off and shows a spinner instead of the knob.
		const setChecking = (value) => {
			checking = value;
			playbackSwitch.classList.toggle("ss-checking", value);
			checkButton.disabled = value;
		};
		const setPlayback = (enabled) => {
			saveConfig({ playbackEnabled: enabled });
			playback.checked = enabled;
			if (!enabled) {
				if (state.status !== "idle") stopYT(true);
				state.queue.length = 0;
				renderQueueSection();
			}
			resetNetwork();
			renderSearch();
			notify(t(enabled ? "playbackOnToast" : "playbackOffToast"));
		};
		const checkLocalWisp = async () => {
			const token = ++checkToken;
			guideStatus.textContent = t("guideChecking");
			guide.style.display = "block";
			// Do not show the switch as on until the connection is confirmed.
			if (!config.playbackEnabled) playback.checked = false;
			setChecking(true);
			const ok = await probeLocalWisp(config.localWisp);
			if (token !== checkToken) return; // a newer check or the switch took over
			setChecking(false);
			if (ok) {
				guideStatus.textContent = t("guideOk");
				if (!config.playbackEnabled) setPlayback(true);
			} else {
				guideStatus.textContent = t("guideFailed", config.localWisp);
				playback.checked = config.playbackEnabled;
			}
		};
		playback.addEventListener("change", () => {
			if (!playback.checked) {
				checkToken++;
				setChecking(false);
				guide.style.display = "none";
				guideStatus.textContent = "";
				if (config.playbackEnabled) setPlayback(false);
				return;
			}
			if (checking) {
				// Clicked again while verifying: cancel the check and keep the switch off.
				checkToken++;
				setChecking(false);
				guideStatus.textContent = "";
				playback.checked = config.playbackEnabled;
				return;
			}
			checkLocalWisp();
		});

		// Reset button. The first click arms it, the second click within a few seconds actually resets.
		let resetArmed = false;
		let resetTimer = null;
		const disarmReset = () => {
			resetArmed = false;
			clearTimeout(resetTimer);
			resetButton.textContent = t("resetSettings");
		};
		const performReset = () => {
			// Cancel any running connection check and hide the setup guide.
			checkToken++;
			setChecking(false);
			guide.style.display = "none";
			guideStatus.textContent = "";
			output.style.display = "none";
			output.textContent = "";
			// Defaults have playback off, so stop the current YouTube track and clear the queue like the switch does.
			if (config.playbackEnabled) {
				if (state.status !== "idle") stopYT(true);
				state.queue.length = 0;
				renderQueueSection();
			}
			resetConfig();
			// Sync the form with the restored defaults.
			wisp.value = config.wispServers.join("\n");
			clients.value = config.clients.join(", ");
			playback.checked = config.playbackEnabled;
			resetNetwork();
			renderSearch();
			notify(t("resetDone"));
		};
		const resetButton = h(
			"button",
			{
				class: "ss-secondary",
				onClick: () => {
					if (!resetArmed) {
						resetArmed = true;
						resetButton.textContent = t("resetConfirm");
						resetTimer = setTimeout(disarmReset, 4000);
						return;
					}
					disarmReset();
					performReset();
				},
			},
			t("resetSettings")
		);

		const content = h(
			"div",
			{ class: "ss-settings" },
			h("label", { class: "ss-toggle" }, playbackSwitch, t("playbackLabel")),
			h("div", { class: "ss-desc" }, t("playbackDesc")),
			h(
				"button",
				{
					class: "ss-link",
					style: "margin-top:6px",
					onClick: () => {
						guide.style.display = guide.style.display === "none" ? "block" : "none";
					},
				},
				t("showGuide")
			),
			guide,
			h("label", {}, t("wispLabel")),
			wisp,
			h("label", {}, t("clientsLabel")),
			clients,
			h(
				"div",
				{ class: "ss-buttons" },
				h("button", { class: "ss-primary", onClick: () => { saveConfig(collect()); resetNetwork(); notify(t("saved")); } }, t("save")),
				h(
					"button",
					{
						class: "ss-secondary",
						onClick: async () => {
							saveConfig(collect());
							resetNetwork();
							output.textContent = "";
							await runDiagnostics(log);
						},
					},
					t("test")
				),
				h("button", { class: "ss-secondary", onClick: () => { clearAudioCache(); notify(t("cacheCleared")); } }, t("clearCache")),
				resetButton
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
		console.warn("[Synthesis Spicetify] Failed to register menu item", error);
	}
	// Warm up the heavy libraries while the app is idle so the first search feels fast.
	(window.requestIdleCallback || ((fn) => setTimeout(fn, 4000)))(() => {
		getInnertube().catch((error) => console.warn("[Synthesis Spicetify] warm-up failed", error));
	});

	window.SynthesisSpicetify = { version: VERSION, state, get config() { return config; }, providers, runDiagnostics };
	console.log(`[Synthesis Spicetify] ${VERSION} loaded`);
})();