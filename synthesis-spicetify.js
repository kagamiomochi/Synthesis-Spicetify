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
 *  - Spotify:  search page injection, and Spotify's own player bar, which shows and controls a non-Spotify
 *              track while it is active (a small mini player is only the fallback when the player bar
 *              cannot be used).
 *  - Playback: every non-Spotify track goes through a silent local-file placeholder (a spotify:local: item).
 *              Play, queue and playlist actions hand that placeholder to Spotify's own player, queue and
 *              playlists. When Spotify starts it, the extension pauses Spotify and streams the real track
 *              instead, and when the track ends Spotify moves on to whatever follows the placeholder.
 *
 * Both libraries are loaded lazily from jsDelivr (pinned versions) on first use.
 *
 * The file is one script (the Marketplace installs a single file), laid out top to bottom in dependency order:
 * boot, constants and config, i18n, utilities, network, images, YouTube Music provider, playback state and
 * registries, audio cache, progressive playback, playback control, placeholders (files, registry, playlist
 * picker, handing them to Spotify, real names, cover art), styles, mini player, player bar takeover, search
 * page, diagnostics, settings, registration.
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

	/* VERSION */ const VERSION = "v0.6.1";
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
		// Set when a trial over the public Wisp actually started playing: playback is then kept on without a local Wisp.
		publicPlayback: false,
		// Absolute path of the folder registered as a Spotify Local Files source for the placeholders.
		placeholderFolder: "",
		// InnerTube clients tried in order to obtain a directly playable audio URL.
		clients: ["visionos", "tv_samsung"],
		resultLimit: 20,
		prefetchNext: true,
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

	// One-shot trial: the video ID the user explicitly asked to try over a public Wisp while playback is off.
	// Never saved, and it only unlocks that one track; it is cleared as soon as the download starts or fails.
	let trialTrackId = null;

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
			loading: (p) => `読み込み中 ${Math.round(p * 100)}%`,
			preparing: "準備中...",
			addedQueue: "キューに追加しました",
			addedNext: "次に再生します",
			playFailed: (m) => `再生に失敗しました: ${m}`,
			tryPlay: "公開 Wisp で試しに再生 (ほぼ通らないです)",
			trialSaved: "公開 Wisp で再生できたため、再生機能を有効のまま保存しました",
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
			badTrackId: "この曲は扱えません (IDが不正です)。",
			pickFolder: "ダミー曲を置くフォルダを選んでください (Spotify のローカルファイルのソースに追加済みのフォルダ)。",
			pickFolderAt: (path) => `ダミー曲を置くフォルダとして ${path} を選んでください。`,
			folderMismatch: (path) => `選んだフォルダが登録済みのフォルダ (${path}) と違う可能性があります。違う場合、ダミー曲が Spotify に現れません。`,
			localFilesPick: "ダミー曲を置くフォルダを選んでください。Spotify のローカルファイルのソースに自動で追加します。",
			localFilesReady: "ローカルファイルは有効で、フォルダも登録済みです。",
			localFilesAdded: (path) => `ローカルファイルを有効にし、${path} をソースに追加しました。`,
			localFilesCancelled: "フォルダの選択がキャンセルされました。Spotify の設定でローカルファイルのソースにフォルダを追加してください。",
			localFilesFailed: "ローカルファイルの自動設定に失敗しました。Spotify の設定で手動で追加してください。",
			localFilesUnsupported: "この Spotify ではローカルファイルを自動設定できません。Spotify の設定で手動で追加してください。",
			placeholderNotPlayed: "Spotify がダミー曲を再生しませんでした。",
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
			loading: (p) => `Loading ${Math.round(p * 100)}%`,
			preparing: "Preparing...",
			addedQueue: "Added to queue",
			addedNext: "Will play next",
			playFailed: (m) => `Playback failed: ${m}`,
			tryPlay: "Try playing via public Wisp (often blocked)",
			trialSaved: "Playback worked over the public Wisp, so it stays enabled",
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
			badTrackId: "This track cannot be used (invalid ID).",
			pickFolder: "Choose the folder for the placeholder files (it must be a Local Files source in Spotify).",
			pickFolderAt: (path) => `Choose ${path} as the folder for the placeholder files.`,
			folderMismatch: (path) => `The chosen folder may differ from the registered one (${path}). If it does, the placeholders will not show up in Spotify.`,
			localFilesPick: "Choose the folder for the placeholder files. It is added to Spotify's Local Files sources automatically.",
			localFilesReady: "Local Files is on and the folder is already registered.",
			localFilesAdded: (path) => `Turned on Local Files and added ${path} as a source.`,
			localFilesCancelled: "Folder selection was cancelled. Add a folder as a Local Files source in Spotify's settings.",
			localFilesFailed: "Could not set up Local Files automatically. Add the folder in Spotify's settings instead.",
			localFilesUnsupported: "This Spotify version cannot set up Local Files automatically. Add the folder in Spotify's settings instead.",
			placeholderNotPlayed: "Spotify did not play the placeholder.",
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

	// Formats whole seconds as m:ss.
	const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

	// Track length of a result row; empty while unknown.
	function formatTime(ms) {
		if (!Number.isFinite(ms) || ms <= 0) return "";
		return mmss(Math.round(ms / 1000));
	}

	// Playback position of the player bar; an unknown value shows 0:00.

	const setText = (el, text) => {
		if (el.textContent !== text) el.textContent = text;
	};

	const notify = (message, isError = false) => Spicetify.showNotification(message, isError);

	const abortError = () => new DOMException("Aborted", "AbortError");

	function throwIfAborted(signal) {
		if (signal?.aborted) throw abortError();
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
		if (!config.playbackEnabled || config.publicPlayback) return config.wispServers;
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

	// Plain WebSocket handshake against the local Wisp server. With on-demand start this also wakes it up.
	function probeLocalWisp(url, timeoutMs = 10000) {
		return new Promise((resolve) => {
			let ws = null;
			let settled = false;
			let timer = null;
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
			timer = setTimeout(() => finish(false), timeoutMs);
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

	// Shows the cover of a track in ui.cover, unless it already shows that URL.
	function setCover(ui, url) {
		if (ui.lastCoverUrl === url) return;
		ui.lastCoverUrl = url;
		ui.cover.removeAttribute("data-fallback");
		loadImage(ui.cover, url);
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

	// Open the track on YouTube Music in the default external browser
	function openInBrowser(track) {
		const url = `https://music.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
		// Do not check the return value: the Spotify client may return null even when the browser opened,
		// and a fallback would open a second tab
		window.open(url, "_blank", "noopener,noreferrer");
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
		const trial = !config.playbackEnabled && track.id === trialTrackId;
		trialTrackId = null; // a trial is single-use
		if (!config.playbackEnabled && !trial) throw new Error(t("playbackDisabled"));
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
						if (trial && !config.playbackEnabled) {
							saveConfig({ playbackEnabled: true, publicPlayback: true });
							renderSearch();
							notify(t("trialSaved"));
						}
						onStart?.(format.mimeType);
					},
					userAgent: CLIENT_DEFS[client].client.userAgent,
				});
				return { blob, mime: format.mimeType };
			} catch (error) {
				// libcurl.js rejects aborted requests with a DOMException named "Error" (or errors the body
				// stream with a plain string), so check the signal instead of relying on error.name.
				if (signal?.aborted || error?.name === "AbortError") throw abortError();
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

	function resetNetwork() {
		// Reset the lazily created singletons so new Wisp settings take effect.
		curlPromise = null;
		innertubes.plain = null;
		innertubes.player = null;
		warmUpPromise = null;
		cookieJar.clear();
	}

	// ---------------------------------------------------------------------
	// Playback state and track registries
	// ---------------------------------------------------------------------

	const audio = new Audio();
	audio.preload = "auto";

	const state = {
		current: null, // active non-Spotify track
		status: "idle", // idle | loading | playing | paused
		progress: 0, // download progress while loading (0..1)
		placeholderUri: null, // spotify:local: URI of the placeholder Spotify is paused on while our track plays
		suppressUntil: 0, // ignore Spotify events until this timestamp
		advancingUntil: 0, // Spotify is being moved to another item: what it does meanwhile is not a new start
		holding: false, // we stopped Spotify's clock ourselves (loading, or the audio has not been downloaded that far yet)
	};
	let playToken = 0;

	const SAVED_KEY = "synthesis-spicetify:saved";

	function loadSaved() {
		try {
			return JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
		} catch {
			return {};
		}
	}

	const savedTracks = loadSaved(); // spotify:local: URI -> track (saved to a playlist, kept in localStorage)
	const placeholderTracks = new Map(); // spotify:local: URI -> track (made for playing or queueing, memory only)

	function rememberSaved(uri, track) {
		savedTracks[uri] = track;
		try {
			localStorage.setItem(SAVED_KEY, JSON.stringify(savedTracks));
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to store saved tracks", error);
		}
	}

	const displayInfo = new Map(); // video ID -> { title, artist, album, thumbnail, letterbox }

	const youtubeThumbnail = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

	// What Spotify's rows show for a track's placeholder. Without a stored cover, YouTube's own thumbnail is used,
	// which has black bars above and below the picture (hence "letterbox").
	function displayInfoOf(track) {
		return {
			title: track.title,
			artist: (track.artists || []).join(", "),
			album: track.album || "",
			thumbnail: track.thumbnail || youtubeThumbnail(track.id),
			letterbox: !track.thumbnail,
		};
	}

	// The part of a track that is kept for its placeholder (in memory, or in localStorage once it is saved to a playlist).
	function snapshotTrack(track) {
		return {
			provider: track.provider,
			id: track.id,
			title: track.title,
			artists: track.artists,
			album: track.album,
			durationMs: track.durationMs,
			thumbnail: track.thumbnail,
		};
	}

	// ---------------------------------------------------------------------
	// Audio cache (Blob URLs)
	// ---------------------------------------------------------------------

	const audioCache = new Map(); // key -> { url }
	let prefetchKey = null; // key of the next placeholder track that is being downloaded ahead of time
	const inflight = new Map(); // key -> { controller, listeners, promise }
	const trackKey = (track) => `${track.provider}:${track.id}`;

	function evictCache() {
		const keep = new Set([state.current && trackKey(state.current), prefetchKey].filter(Boolean));
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
		if (key === prefetchKey) return; // still wanted as the next track
		inflight.get(key)?.controller.abort();
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
			activeStream = { job, sink, track, token, cancel: () => settle(reject, abortError()) };

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
					stopTrack(true);
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

	function trackDurationSec() {
		return Number.isFinite(audio.duration) ? audio.duration : (state.current?.durationMs ?? 0) / 1000;
	}

	// The OS media controller (MPRIS, SMTC) and tools built on it (Discord RPC, scrobblers) see two players: Spotify's
	// own, which is playing the placeholder, and this page's audio element. Its Media Session is the one that
	// can carry the real song, so keep it in step with the track state.
	let mediaSessionKey = null; // track the current metadata was built for
	let positionStateAt = 0; // last time the position was reported

	function setupMediaSessionHandlers() {
		if (!("mediaSession" in navigator)) return;
		// The audio element is only a slave of Spotify's clock, so every action goes to Spotify, not to the element.
		const handlers = {
			play: () => {
				if (state.status === "paused") Spicetify.Player.play();
			},
			pause: () => {
				if (state.status === "playing") Spicetify.Player.pause();
			},
			nexttrack: () => skipNext(),
			previoustrack: () => Spicetify.Player.back(),
			seekto: (details) => {
				if ((state.status === "playing" || state.status === "paused") && Number.isFinite(details?.seekTime)) seekSpotify(details.seekTime);
			},
		};
		for (const [action, handler] of Object.entries(handlers)) {
			try {
				navigator.mediaSession.setActionHandler(action, handler);
			} catch {
				// This action is not supported here.
			}
		}
	}

	// Reports position and length, so that progress bars and Discord's timestamps are right.
	function updatePositionState(force) {
		if (!("mediaSession" in navigator) || !state.current) return;
		const now = Date.now();
		if (!force && now - positionStateAt < 1000) return;
		const duration = trackDurationSec();
		if (!(duration > 0) || !Number.isFinite(duration)) return;
		positionStateAt = now;
		try {
			navigator.mediaSession.setPositionState({
				duration,
				playbackRate: 1,
				position: Math.min(Math.max(spotifyPosition(), 0), duration),
			});
		} catch {
			// MediaSession is best effort only.
		}
	}

	// Called on every state change (from renderMini). Metadata is only replaced when the track changes.
	function syncMediaSession() {
		if (!("mediaSession" in navigator)) return;
		const track = state.current;
		try {
			if (!track || state.status === "idle") {
				// Nothing of ours is playing: leave no stale song behind.
				if (mediaSessionKey !== null) {
					navigator.mediaSession.metadata = null;
					mediaSessionKey = null;
				}
				navigator.mediaSession.playbackState = "none";
				return;
			}
			const key = trackKey(track);
			if (key !== mediaSessionKey) {
				navigator.mediaSession.metadata = new MediaMetadata({
					title: track.title,
					artist: track.artists.join(", "),
					album: track.album || providers[track.provider].label,
					artwork: track.thumbnail ? [{ src: track.thumbnail, sizes: "226x226" }] : [],
				});
				mediaSessionKey = key;
			}
			// While loading, Spotify is held paused and nothing is audible yet.
			navigator.mediaSession.playbackState = state.status === "playing" ? "playing" : "paused";
			updatePositionState(true);
		} catch {
			// MediaSession is best effort only.
		}
	}
	setupMediaSessionHandlers();

	// ---------------------------------------------------------------------
	// Playback control
	// ---------------------------------------------------------------------

	// Streams the real track. Only called once Spotify has started a placeholder (see startFromPlaceholder), and
	// Spotify has already been paused on it by then.
	async function playTrack(track) {
		const token = ++playToken;
		const previous = state.current;
		if (previous && state.status === "loading") abortLoad(previous);

		detachStream();
		audio.pause();
		state.current = track;
		state.status = "loading";
		state.progress = 0;
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
			releaseClock();
			renderMini();
			prefetchNext();
		} catch (error) {
			if (token !== playToken || error?.name === "AbortError") return;
			console.error("[Synthesis Spicetify] playback failed", error);
			notify(t("playFailed", error?.message || error), true);
			stopTrack(true);
		}
	}

	// Downloads the next item of Spotify's queue ahead of time when it is one of our placeholders, so that
	// it starts without a wait. The queue API is internal, so this is best effort only.
	function prefetchNext() {
		prefetchKey = null;
		if (!config.prefetchNext) return;
		try {
			const entry = Spicetify.Queue?.nextTracks?.[0];
			const uri = entry?.contextTrack?.uri ?? entry?.uri;
			const track = uri && (placeholderTracks.get(uri) ?? savedTracks[uri]);
			if (!track) return;
			prefetchKey = trackKey(track);
			getAudioUrl(track).catch(() => {});
		} catch (error) {
			console.warn("[Synthesis Spicetify] prefetch skipped", error);
		}
	}

	// Stops our track. With `advance`, Spotify then moves on to whatever follows the placeholder it is
	// paused on (the end of a track, the next button, or a failure); without it Spotify stays where it is.
	function stopTrack(advance) {
		playToken++;
		abortLoad(state.current);
		detachStream();
		audio.pause();
		audio.removeAttribute("src");
		audio.load();
		state.current = null;
		state.status = "idle";
		state.progress = 0;
		state.placeholderUri = null;
		state.holding = false;
		renderMini();
		if (advance) moveSpotify("next");
	}

	// Closes our track at the user's request (close button, playback switched off): unlike stopTrack(false)
	// this also stops Spotify, which is playing the silent placeholder as the clock of our track.
	function closeTrack() {
		const onPlaceholder = state.status !== "idle" && readSpotify().uri === state.placeholderUri;
		stopTrack(false);
		if (onPlaceholder && Spicetify.Player.isPlaying()) {
			state.suppressUntil = Date.now() + 500;
			Spicetify.Player.pause();
		}
	}

	// Spotify is the master clock of our track: the buttons below drive Spotify, and syncSlave() moves the
	// audio along with it. This is why pause, seek, previous / next, repeat and shuffle all work natively.
	function togglePause() {
		if (state.status === "loading") return; // nothing to play yet
		Spicetify.Player.togglePlay();
	}

	function skipNext() {
		Spicetify.Player.next();
	}

	// Seeks Spotify. Spicetify reads values up to 1 as a fraction, so a tiny position is sent as 0.
	function seekSpotify(seconds) {
		const ms = Math.round(seconds * 1000);
		Spicetify.Player.seek(ms > 1 ? ms : 0);
	}

	function spotifyPosition() {
		return (Spicetify.Player.getProgress() || 0) / 1000;
	}

	const SYNC_TOLERANCE = 0.4; // seconds the audio may be off Spotify's position before it is moved
	const RESUME_MARGIN = 1.5; // seconds that must be downloaded beyond a position before the clock runs from there

	// True when the audio can play from this position right now (it is downloaded far enough).
	function audioCanPlayAt(seconds) {
		if (!activeStream || activeStream.sink.isComplete() || activeStream.job.finished) return true;
		const duration = trackDurationSec();
		const ranges = audio.buffered;
		for (let i = 0; i < ranges.length; i++) {
			if (seconds < ranges.start(i) - 0.05) continue;
			if (ranges.end(i) >= seconds + RESUME_MARGIN || ranges.end(i) >= duration - 0.1) return true;
		}
		return false;
	}

	// Stops Spotify's clock until the audio has caught up (the data behind a seek has not arrived yet).
	function holdClock() {
		state.holding = true;
		audio.pause();
		state.suppressUntil = Date.now() + 500; // our own pause must not look like a user action
		Spicetify.Player.pause();
	}

	// The track has loaded while Spotify was held on its placeholder: bring Spotify's clock to the audio and
	// let it run. The audio keeps following it from here on.
	function releaseClock() {
		if (!state.holding) return;
		state.holding = false;
		const at = audio.currentTime;
		if (Math.abs(at - spotifyPosition()) > SYNC_TOLERANCE) seekSpotify(at);
		Spicetify.Player.play();
	}

	// Keeps the audio on Spotify's clock. Runs on Spotify's play / pause events and on a timer.
	function syncSlave() {
		if (state.status === "idle" || state.status === "loading") return; // playTrack() hands the clock over
		if (!state.placeholderUri || readSpotify().uri !== state.placeholderUri) return;
		const position = spotifyPosition();

		if (state.holding) {
			if (!audioCanPlayAt(position)) {
				// Spotify must not run while there is nothing to hear (a play press, for example).
				if (Spicetify.Player.isPlaying()) {
					state.suppressUntil = Date.now() + 300;
					Spicetify.Player.pause();
				}
				return;
			}
			state.holding = false;
			Spicetify.Player.play(); // Spotify's play event calls this function again
			return;
		}

		if (!Spicetify.Player.isPlaying()) {
			if (!audio.paused) audio.pause();
			if (state.status !== "paused") {
				state.status = "paused";
				renderMini();
			}
			return;
		}

		// Spotify runs. After the audio has ended, Spotify may still be inside the last seconds of its placeholder.
		const tail = audio.ended && position >= audio.currentTime - 2;
		if (!tail && Math.abs(audio.currentTime - position) > SYNC_TOLERANCE) {
			if (!audioCanPlayAt(position)) {
				holdClock();
				return;
			}
			seekAudio(position);
		}
		if (audio.paused && !tail) audio.play().catch(() => {});
		if (state.status !== "playing") {
			state.status = "playing";
			renderMini();
		}
	}
	setInterval(syncSlave, 250);

	function requirePlayback(track) {
		if (config.playbackEnabled) return true;
		if (track?.id && track.id === trialTrackId) return true;
		notify(t("playbackDisabled"), true);
		return false;
	}

	// Audio element events
	audio.addEventListener("ended", () => {
		if (state.status === "idle" || state.holding || readSpotify().uri !== state.placeholderUri) return;
		// Let Spotify run out its placeholder by itself, so that repeat and shuffle apply as usual.
		const duration = Spicetify.Player.getDuration();
		if (duration - spotifyPosition() * 1000 > 300) seekSpotify((duration - 150) / 1000);
	});
	audio.addEventListener("error", () => {
		if (!audio.getAttribute("src")) return;
		notify(t("playFailed", audio.error?.message || "media error"), true);
		stopTrack(true);
	});
	audio.addEventListener("timeupdate", () => {
		activeStream?.sink.poke();
		updateSeek();
		updatePositionState(false);
	});

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
	// Placeholders (silent local files) for playing, queueing and saving tracks
	// ---------------------------------------------------------------------

	// Spotify's player, queue and playlists can only hold Spotify items and local files, so every track of
	// another service is represented by a silent MP3 whose tags (artist / "Synthesis" / title) and length
	// give it a unique spotify:local: URI. The tags carry no song information: the title is only the video
	// ID, the artist a fixed label. The MP3 is written into a folder that Spotify uses as a Local Files
	// source and the URI is handed to Spotify: played, added to its queue, or added to a playlist. When
	// Spotify starts playing that URI the extension pauses Spotify and streams the real track instead.

	const PLACEHOLDER_ALBUM = "Synthesis"; // album tag of every placeholder, also used to recognise them
	const PLACEHOLDER_ARTIST = "YouTube"; // artist tag of every placeholder (fixed, so no song info is written)

	// The title tag of a placeholder. Only the video ID is written, which is unique per video, so the
	// playlist row does not reveal the song and the real track can be found again from the ID alone.
	const placeholderTitle = (track) => track.id;

	const HANDLE_DB = "synthesis-spicetify";

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
		const mpeg = new Uint8Array(FRAME * (frames + 1));
		// Frame header: MPEG-2 Layer III, no CRC, bitrate index 2 (16 kbps), 24 kHz, mono.
		// The bitrate index must match FRAME, otherwise decoders reject the file as unplayable.
		for (let f = 0; f <= frames; f++) mpeg.set([0xff, 0xf3, 0x24, 0xc0], f * FRAME);
		mpeg.set([0x49, 0x6e, 0x66, 0x6f], 13); // "Info"
		new DataView(mpeg.buffer).setUint32(17, 1); // flags: frame count present
		new DataView(mpeg.buffer).setUint32(21, frames);
		const out = new Uint8Array(10 + tagSize + mpeg.length);
		out.set(header, 0);
		let pos = 10;
		for (const p of parts) {
			out.set(p, pos);
			pos += p.length;
		}
		out.set(mpeg, pos);
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
	async function getPlaceholderDir() {
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
		notify(config.placeholderFolder ? t("pickFolderAt", config.placeholderFolder) : t("pickFolder"));
		dir = await window.showDirectoryPicker({ id: "synthesis-saved", mode: "readwrite" });
		// The picker only returns a handle (no path), so the folder name is the only thing that can be compared.
		const registeredName = normalizeFolder(config.placeholderFolder).split("/").pop();
		if (registeredName && dir.name !== registeredName) notify(t("folderMismatch", config.placeholderFolder), true);
		try {
			await handleStore("readwrite", (store) => store.put(dir, "dir"));
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to remember the folder", error);
		}
		return dir;
	}

	// Compares folder paths regardless of separator style, a trailing separator and (on Windows) letter case.
	const normalizeFolder = (path) => {
		const normalized = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
		return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
	};

	// Turns on Spotify's Local Files and registers the placeholder folder as a source, using Spotify's own
	// LocalFilesAPI. Returns "ready", "added", "cancelled", "failed" or "unsupported". It needs no user gesture.
	async function setupLocalFiles() {
		const api = Spicetify.Platform?.LocalFilesAPI;
		const required = ["getIsEnabled", "setIsEnabled", "getSources", "addFolder", "browseForFolder"];
		if (!api || required.some((name) => typeof api[name] !== "function")) return "unsupported";
		const hasFolder = async (path) => {
			const wanted = normalizeFolder(path);
			const sources = await api.getSources();
			return (sources?.folders ?? []).some((folder) => normalizeFolder(folder.path) === wanted);
		};
		// The source list can lag a little behind addFolder, so look a few times before giving up.
		const waitForFolder = async (path) => {
			for (let i = 0; i < 10; i++) {
				if (await hasFolder(path)) return true;
				await sleep(500);
			}
			return false;
		};
		try {
			if (!api.getIsEnabled()) {
				api.setIsEnabled(true); // returns nothing; the pending flag is private, so it is only read defensively
				for (let i = 0; i < 20 && api._hasPendingEnabledChange; i++) await sleep(250);
			}
			if (config.placeholderFolder && (await hasFolder(config.placeholderFolder))) return "ready";
			notify(t("localFilesPick"));
			const picked = await api.browseForFolder();
			if (!picked?.path) return "cancelled";
			if (!(await hasFolder(picked.path))) {
				await api.addFolder({ path: picked.path });
				if (!(await waitForFolder(picked.path))) return "failed";
			}
			saveConfig({ placeholderFolder: picked.path });
			return "added";
		} catch (error) {
			console.warn("[Synthesis Spicetify] could not set up local files", error);
			return "failed";
		}
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
						track.album?.name === PLACEHOLDER_ALBUM &&
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
			const uri = localUri(PLACEHOLDER_ARTIST, PLACEHOLDER_ALBUM, placeholderTitle(track), seconds);
			const owner = savedTracks[uri];
			if (!owner || owner.id === track.id) return { uri, seconds };
		}
		throw new Error("too many saved tracks share this title and length");
	}

	// The URI Spotify's local file index uses for a placeholder, or null while it is not listed (or the index
	// cannot be read).
	async function findIndexedUri(expected) {
		const api = Spicetify.Platform?.LocalFilesAPI;
		if (typeof api?.getTracks !== "function") return null;
		try {
			const tracks = (await api.getTracks()) ?? [];
			return tracks.find((track) => track.uri === expected)?.uri ?? null;
		} catch (error) {
			console.warn("[Synthesis Spicetify] local files index not readable", error);
			return null;
		}
	}

	// A video that already has a placeholder keeps its length, so that it keeps its URI even when a later
	// search reports a slightly different duration.
	function knownSeconds(id) {
		let uri = null;
		for (const [key, track] of placeholderTracks) if (track.id === id) uri = key;
		uri ??= Object.keys(savedTracks).find((key) => savedTracks[key].id === id) ?? null;
		const seconds = uri ? Number(uri.split(":").pop()) : NaN;
		return seconds > 0 ? seconds : null;
	}

	// ---- Placeholder registry: making a placeholder for a track, and saving it to a playlist ----

	const placeholderJobs = new Map(); // video ID -> promise of a placeholder that is being made

	async function makePlaceholder(track, busyText) {
		const title = placeholderTitle(track);
		const base = Math.max(1, Math.round((track.durationMs || 180000) / 1000));
		const { uri: expected, seconds } = pickLocalUri(track, knownSeconds(track.id) ?? base);

		// A placeholder that Spotify already lists is reused as it is. No file access is needed then.
		let uri = await findIndexedUri(expected);
		if (!uri) {
			if (busyText) notify(busyText);
			const dir = await getPlaceholderDir();
			// The file name does not matter to Spotify (the URI comes from the tags). Including the length
			// keeps two placeholders of the same video, if there ever are two, in separate files.
			const handle = await dir.getFileHandle(`${track.id}-${seconds}.mp3`, { create: true });
			const writable = await handle.createWritable();
			await writable.write(makeSilentMp3({ artist: PLACEHOLDER_ARTIST, album: PLACEHOLDER_ALBUM, title, seconds }));
			await writable.close();
			uri = await waitForLocalUri(expected, { artist: PLACEHOLDER_ARTIST, title, seconds });
			if (!uri) throw new Error(t("saveNotIndexed"));
		}

		placeholderTracks.set(uri, snapshotTrack(track));
		// Spotify's rows for the placeholder can show the real text and cover art right away.
		displayInfo.set(track.id, displayInfoOf(track));
		return uri;
	}

	// Returns the spotify:local: URI of the track's placeholder, making the file when needed. Call it from a
	// click handler without awaiting anything first: the folder dialog needs the click's user gesture.
	function ensurePlaceholder(track, busyText) {
		if (!/^[\w-]+$/.test(track.id)) return Promise.reject(new Error(t("badTrackId")));
		let job = placeholderJobs.get(track.id);
		if (!job) {
			job = makePlaceholder(track, busyText).finally(() => placeholderJobs.delete(track.id));
			placeholderJobs.set(track.id, job);
		}
		return job;
	}

	async function saveTrackToPlaylist(track, playlist) {
		const uri = await ensurePlaceholder(track, t("saving"));
		await Spicetify.Platform.PlaylistAPI.add(playlist.uri, [uri], { after: "end" });
		rememberSaved(uri, snapshotTrack(track));
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

	// ---------------------------------------------------------------------
	// Handing placeholders to Spotify and taking them back
	// ---------------------------------------------------------------------

	function readSpotify() {
		return { uri: Spicetify.Player.data?.item?.uri ?? null };
	}

	// Moves Spotify to its next or previous item. Spotify is paused on our placeholder at that point, so a
	// regular track it lands on has to be started by hand. A placeholder it lands on is picked up by the
	// songchange handler.
	function moveSpotify(step) {
		const before = readSpotify().uri;
		state.advancingUntil = Date.now() + 1500;
		if (step === "back") Spicetify.Player.back();
		else Spicetify.Player.next();
		setTimeout(() => {
			if (state.status !== "idle") return; // another placeholder has taken over
			if (readSpotify().uri === before) {
				// Spotify could not move (start or end of its context). Going back then restarts the same
				// placeholder, so restart our track too. Going forward must not, or the last track would
				// repeat forever; just keep Spotify from playing the silent file.
				if (step === "back" && isPlaceholderItem()) startFromPlaceholder();
				else if (Spicetify.Player.isPlaying() && isPlaceholderItem()) Spicetify.Player.pause();
				return;
			}
			if (!Spicetify.Player.isPlaying()) Spicetify.Player.play();
		}, 500);
	}

	function reportPlaceholderError(error) {
		if (error?.name === "AbortError") return; // the folder dialog was cancelled
		console.error("[Synthesis Spicetify] could not hand the track to Spotify", error);
		notify(t("playFailed", error?.message || error), true);
	}

	// True once Spotify's current item is the placeholder. Spotify may spell a local file's URI differently from
	// the local files index, so the tags (title = video ID, album "Synthesis") count as well.
	async function waitForSpotifyItem(uri, id, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const item = Spicetify.Player.data?.item;
			if (item?.uri === uri) return true;
			if (item?.uri?.startsWith("spotify:local:") && item.name === id && item.album?.name === PLACEHOLDER_ALBUM) return true;
			await sleep(100);
		}
		return false;
	}

	const LOCAL_FILES_CONTEXT = "spotify:local-files"; // the playback context Spotify uses for local files

	// Plays a placeholder in Spotify's own player. The songchange handler then takes over and streams the
	// real track (see startFromPlaceholder).
	async function playPlaceholder(uri, id) {
		// A local file can only be played inside the Local Files context, so start that context at the placeholder.
		for (const attempt of [
			() => Spicetify.Player.playUri(LOCAL_FILES_CONTEXT, {}, { skipTo: { uri } }),
			() => Spicetify.Player.playUri(uri),
		]) {
			try {
				await attempt();
			} catch (error) {
				console.warn("[Synthesis Spicetify] could not start the placeholder", error);
			}
			if (await waitForSpotifyItem(uri, id, 2000)) return;
		}
		console.warn("[Synthesis Spicetify] Spotify did not switch to the placeholder", { expected: uri, current: Spicetify.Player.data?.item?.uri });
		// Spotify did not switch. Put the placeholder at the front of the queue and skip to it instead.
		// (Both fail without an active Spotify session, which is reported below.)
		try {
			await queuePlaceholder(uri, true);
			await Spicetify.Player.next();
		} catch (error) {
			console.warn("[Synthesis Spicetify] queue fallback failed", error);
		}
		if (await waitForSpotifyItem(uri, id, 2000)) return;
		throw new Error(t("placeholderNotPlayed"));
	}

	// Adds a placeholder to Spotify's own queue, at the front (play next) or at the end. Resolves with true
	// when it ended up at the front. These queue calls are internal APIs.
	async function queuePlaceholder(uri, next) {
		const api = Spicetify.Platform?.PlayerAPI;
		const items = [{ uri }];
		const addToEnd = () => (typeof api?.addToQueue === "function" ? api.addToQueue(items) : Spicetify.addToQueue(items));
		const upcoming = Spicetify.Queue?.nextTracks;
		if (!next || !Array.isArray(upcoming)) {
			await addToEnd();
			return false;
		}
		const first = upcoming[0]?.contextTrack;
		if (!first?.uri) {
			await addToEnd(); // nothing follows yet, so the end is also the front
			return true;
		}
		if (typeof api?.insertIntoQueue === "function") {
			try {
				await api.insertIntoQueue(items, { before: { uri: first.uri, uid: first.uid } });
				return true;
			} catch (error) {
				console.warn("[Synthesis Spicetify] could not insert at the front of the queue", error);
			}
		}
		await addToEnd();
		return false;
	}

	async function playNow(track) {
		if (!requirePlayback(track)) return;
		// The same track is already active: restart it instead of asking Spotify to play its placeholder
		// again, which would look like a press of the play/pause button.
		if (state.current && trackKey(state.current) === trackKey(track) && state.status !== "idle") {
			if (state.status === "loading") return;
			seekSpotify(0);
			if (state.status === "paused") Spicetify.Player.play();
			return;
		}
		try {
			// Nothing may be awaited before this: choosing the placeholder folder needs the click's user gesture.
			const uri = await ensurePlaceholder(track, t("preparing"));
			await playPlaceholder(uri, track.id);
		} catch (error) {
			trialTrackId = null;
			reportPlaceholderError(error);
		}
	}

	// Explicit one-off attempt while the playback switch is off. Only this click unlocks this one track.
	function tryPlay(track) {
		if (config.playbackEnabled) return playNow(track);
		trialTrackId = track.id;
		return playNow(track);
	}

	async function addToQueue(track, { next = false } = {}) {
		if (!requirePlayback()) return;
		try {
			const uri = await ensurePlaceholder(track, t("preparing"));
			// Nothing is playing at all: there is no queue to add to, so start right away.
			if (!readSpotify().uri && state.status === "idle") {
				await playPlaceholder(uri, track.id);
				return;
			}
			const placedNext = await queuePlaceholder(uri, next);
			notify(t(placedNext ? "addedNext" : "addedQueue"));
			if (state.status !== "idle") setTimeout(prefetchNext, 800); // the queue needs a moment to update
		} catch (error) {
			reportPlaceholderError(error);
		}
	}

	// ---- Spotify started a placeholder ----
	function isPlaceholderItem() {
		const item = Spicetify.Player.data?.item;
		if (!item?.uri?.startsWith("spotify:local:")) return false;
		return Boolean(savedTracks[item.uri]) || item.album?.name === PLACEHOLDER_ALBUM;
	}

	// Spotify just started a placeholder. Pause it (keeping its session, so that the queue or playlist can
	// move on afterwards) and stream the real track instead.
	async function startFromPlaceholder() {
		const item = Spicetify.Player.data?.item;
		const uri = item?.uri;
		if (!uri || (state.status !== "idle" && uri === state.placeholderUri)) return; // already handling it
		state.suppressUntil = Date.now() + 500; // our own pause must not look like a user action
		Spicetify.Player.pause();
		if (!requirePlayback(savedTracks[uri] ?? placeholderTracks.get(uri) ?? { id: item.name })) return;

		let track = savedTracks[uri] ?? placeholderTracks.get(uri);
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
					thumbnail: info?.thumbnail || "",
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

		state.placeholderUri = uri;
		state.holding = true; // Spotify stays paused on the placeholder until the audio is ready (see releaseClock)
		playTrack({ ...track });
	}

	let lastSpotify = readSpotify();

	// Spotify is playing a placeholder that none of our tracks belongs to yet (it was started again after
	// our track had been stopped, or an event was missed): stream the real track.
	function reconcilePlaceholder() {
		const now = Date.now();
		if (now < state.suppressUntil || now < state.advancingUntil) return;
		if (!Spicetify.Player.isPlaying() || !isPlaceholderItem()) return;
		if (state.status !== "idle" && readSpotify().uri === state.placeholderUri) return;
		startFromPlaceholder();
	}

	Spicetify.Player.addEventListener("onplaypause", () => {
		if (Date.now() < state.suppressUntil) return;
		if (state.status !== "idle" && readSpotify().uri === state.placeholderUri) {
			// Spotify is the clock of the active track: a play or pause press moves the audio along with it.
			if (state.status === "loading" && Spicetify.Player.isPlaying()) {
				// Nothing to hear yet, so keep the clock stopped until the track has loaded.
				state.suppressUntil = Date.now() + 300;
				Spicetify.Player.pause();
				return;
			}
			syncSlave();
			return;
		}
		if (!Spicetify.Player.isPlaying()) return;
		reconcilePlaceholder();
	});

	Spicetify.Player.addEventListener("songchange", () => {
		const now = readSpotify();
		const prev = lastSpotify;
		lastSpotify = now;
		if (!now.uri || now.uri === prev.uri) return;
		if (Date.now() < state.suppressUntil) return;

		// One of our placeholders started: stream the real track instead.
		if (isPlaceholderItem()) {
			startFromPlaceholder();
			return;
		}

		// Spotify moved on to a regular track, or the user started something else: our track is over.
		if (state.status !== "idle") stopTrack(false);
	});

	// Safety net: events are ignored while our own pause is settling, so a placeholder that Spotify lands on
	// in that moment would otherwise play as silence.
	setInterval(reconcilePlaceholder, 700);

	// ---------------------------------------------------------------------
	// Real names and cover art for placeholders
	// ---------------------------------------------------------------------

	// ---- Showing real names for placeholders ----
	// The placeholder file only carries the video ID as its title and a fixed artist / album, so Spotify's own
	// rows (playlists, queue, player bar) would show "dQw4w9WgXcQ / YouTube / Synthesis". Only the DOM text is
	// rewritten here: nothing is written to the file or to Spotify's data, and the real values live in memory.

	const VIDEO_ID_RE = /^[\w-]{11}$/;
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
			const info = displayInfoOf(saved);
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
			displayInfo.set(id, { title: data.title, artist, album: "", thumbnail: data.thumbnail_url || youtubeThumbnail(id), letterbox: true });
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

	// True inside this extension's own UI. <body> is skipped on purpose: it carries "ss-takeover" while a
	// non-Spotify track is playing, and that must not count as "inside our UI".
	function isOwnUi(el) {
		for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
			for (const name of el.classList) if (name.startsWith("ss-")) return true;
		}
		return false;
	}

	// Number of ID-like text nodes in scope, not counting `except` (the title being handled, which may already
	// have been rewritten when this runs again for a retry).
	function countIdNodes(scope, except) {
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		let count = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node !== except && VIDEO_ID_RE.test(node.nodeValue.trim())) count++;
		}
		return count;
	}

	// The element that holds exactly one track: a tracklist row, or else (queue, player bar) the nearest
	// ancestor that has the fixed artist next to this title and no other ID-like text, so that a list
	// containing several rows is never mistaken for one track.
	function findTrackScope(owner, titleNode) {
		const row = owner.closest('[data-testid="tracklist-row"], [role="row"]');
		if (row) return findTextNode(row, PLACEHOLDER_ARTIST) ? row : null;
		let scope = owner;
		for (let depth = 0; depth < 6 && scope; depth++, scope = scope.parentElement) {
			if (!findTextNode(scope, PLACEHOLDER_ARTIST)) continue;
			return countIdNodes(scope, titleNode) === 0 ? scope : null;
		}
		return null;
	}

	// ---- Cover art for placeholders ----
	// Spotify shows a generic icon for a local file. The real cover is laid over that slot as a separate element
	// (Spotify's own nodes are left alone), and removed again as soon as the row shows something else.

	const rewritten = new WeakMap(); // rewritten title text node -> { title, art }

	let artFailReason = ""; // why the last placeArt() call gave up, for the console hint below

	const ART_RETRY_DELAYS = [120, 350, 800, 1600, 3200]; // ms after the first attempt, see retryArt()

	// A cover slot is the cover image itself, or the tile around a placeholder icon.
	function slotOf(el, titleNode) {
		const parent = el.parentElement;
		if (el.tagName.toLowerCase() === "svg" && parent && !parent.contains(titleNode)) return parent;
		return el;
	}

	// The biggest cover slot that comes before the title: inside the title's cell in a tracklist row, otherwise
	// (queue, now playing panel) inside the nearest ancestor that holds only this track. The biggest one wins,
	// so that small icons next to the cover (buttons, badges) are not mistaken for it.
	function findCoverSlot(titleNode, scope) {
		const owner = titleNode.parentElement;
		const containers = [];
		const cell = owner.closest('[aria-colindex="2"]');
		if (cell && scope.contains(cell)) containers.push(cell);
		else {
			for (let el = owner, depth = 0; el && el !== document.body && depth < 14; el = el.parentElement, depth++) {
				if (countIdNodes(el, titleNode) !== 0) break;
				containers.push(el);
			}
		}
		for (const container of containers) {
			let best = null;
			let bestArea = 0;
			for (const el of container.querySelectorAll("img, svg")) {
				if (el.closest(".ss-art")) continue;
				if (!(el.compareDocumentPosition(titleNode) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
				const slot = slotOf(el, titleNode);
				const rect = slot.getBoundingClientRect();
				if (rect.width * rect.height > bestArea) {
					best = slot;
					bestArea = rect.width * rect.height;
				}
			}
			if (best) return best;
		}
		return null;
	}

	// URL of the stored cover at about the size it is shown at (YT Music covers accept a size in the URL).
	function sizedThumbnail(url, cssSize) {
		const wanted = Math.min(1200, Math.ceil((cssSize * (window.devicePixelRatio || 1)) / 64) * 64);
		if (/=w\d+-h\d+/.test(url)) return resizeThumbnail(url, Math.max(226, wanted));
		return url;
	}

	// A plain YouTube thumbnail is a small picture with black bars. For a big cover, swap in the full-size
	// frame when YouTube has one (it has no bars, so the crop that hides them is dropped as well).
	function upgradeYoutubeThumbnail(art, img, url) {
		const match = /^(https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/)\w+\.jpg/.exec(url);
		if (!match) return;
		const maxres = `${match[1]}maxresdefault.jpg`;
		const probe = new Image();
		probe.onload = () => {
			// A missing full-size frame comes back as a tiny placeholder picture.
			if (probe.naturalWidth < 640 || !art.isConnected) return;
			art.classList.remove("ss-letterbox");
			loadImage(img, maxres);
		};
		probe.src = maxres;
	}

	function placeArt(titleNode, scope, info) {
		if (!info.thumbnail) {
			artFailReason = "no thumbnail URL";
			return null;
		}
		const slot = findCoverSlot(titleNode, scope);
		if (!slot) {
			artFailReason = "no cover slot found before the title (or it has no size yet)";
			return null;
		}
		const host = slot.parentElement;
		if (!host) {
			artFailReason = "cover slot has no parent";
			return null;
		}
		// Drop an old cover first: it may have resized this very slot.
		for (const old of host.querySelectorAll(":scope > .ss-art")) removeArt(old);
		let rect = slot.getBoundingClientRect();
		if (rect.width < 16 || rect.height < 16) {
			artFailReason = `cover slot too small (${Math.round(rect.width)}x${Math.round(rect.height)})`;
			return null;
		}
		// The now playing panel shows a wide, short box for a local file: make it square so the cover fits.
		let slotHeight = null;
		if (rect.width > rect.height * 1.5) {
			slotHeight = slot.style.height;
			slot.style.height = `${rect.width}px`;
			rect = slot.getBoundingClientRect();
		}
		if (getComputedStyle(host).position === "static") host.style.position = "relative";
		const hostRect = host.getBoundingClientRect();

		// Thumbnails are stored small (226px), which looks blurry in a big cover such as the now playing panel.
		const size = Math.max(rect.width, rect.height);
		const img = h("img", { alt: "" });
		loadImage(img, sizedThumbnail(info.thumbnail, size));
		const left = rect.left - hostRect.left - host.clientLeft;
		const top = rect.top - hostRect.top - host.clientTop;
		const art = h(
			"div",
			{ class: info.letterbox ? "ss-art ss-letterbox" : "ss-art", style: `left:${left}px;top:${top}px;width:${rect.width}px;height:${rect.height}px` },
			img
		);
		if (info.letterbox && size * (window.devicePixelRatio || 1) > 240) upgradeYoutubeThumbnail(art, img, info.thumbnail);
		art._titleNode = titleNode;
		art._slot = slot;
		art._slotHeight = slotHeight;
		host.append(art);
		return art;
	}

	// Compact outline of an element (tags, classes, test ids only, no text) for the console hint.
	function describeNode(el, depth = 0, max = 7) {
		const attrs = [...el.attributes]
			.filter((a) => a.name === "class" || a.name === "data-testid" || a.name === "aria-colindex" || a.name === "role")
			.map((a) => `${a.name}="${a.value.slice(0, 70)}"`)
			.join(" ");
		const head = `${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>`;
		if (depth >= max) return head;
		const kids = [...el.children].map((child) => describeNode(child, depth + 1, max)).join("\n");
		return kids ? `${head}\n${kids}` : head;
	}

	// The cover often cannot be placed on the first try (the row or panel is not laid out yet), so a few
	// retries follow the first attempt. The last failure is reported in the console.

	function retryArt(node, last) {
		const entry = rewritten.get(node);
		if (!entry || entry.art || !node.isConnected || node.nodeValue !== entry.title || !entry.scope.isConnected) return;
		entry.art = placeArt(node, entry.scope, entry.info);
		if (entry.art || !last) return;
		let root = node.parentElement;
		for (let i = 0; i < 8 && root?.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
		console.warn(`[Synthesis Spicetify] cover art not shown: ${artFailReason}\n${describeNode(root).slice(0, 6000)}`);
	}

	function removeArt(art) {
		if (art._slotHeight !== null && art._slotHeight !== undefined && art._slot) art._slot.style.height = art._slotHeight;
		art.remove();
	}

	// Removes covers whose row was reused for another track or has gone away.
	function sweepArt() {
		for (const art of document.querySelectorAll(".ss-art")) {
			const node = art._titleNode;
			const entry = node && rewritten.get(node);
			if (!entry || entry.art !== art || !node.isConnected || node.nodeValue !== entry.title) removeArt(art);
		}
	}

	// If this text node is a placeholder's title (a video ID next to the fixed artist), swap in the real text.
	// Only nodeValue is changed, so React keeps owning the node and simply overwrites it when the row is reused.
	function rewriteTextNode(node) {
		const id = node.nodeValue?.trim();
		if (!id || !VIDEO_ID_RE.test(id)) return;
		const owner = node.parentElement;
		if (!owner || isOwnUi(owner)) return;

		const scope = findTrackScope(owner, node);
		if (!scope) return;
		const artistNode = findTextNode(scope, PLACEHOLDER_ARTIST);
		if (!artistNode) return;

		const info = lookupDisplay(id);
		if (!info) return;
		const entry = { title: info.title, art: placeArt(node, scope, info), scope, info };
		node.nodeValue = info.title;
		rewritten.set(node, entry);
		if (!entry.art) {
			ART_RETRY_DELAYS.forEach((delay, i) => setTimeout(() => retryArt(node, i === ART_RETRY_DELAYS.length - 1), delay));
		}
		if (info.artist) artistNode.nodeValue = info.artist;
		if (info.album) {
			const albumNode = findTextNode(scope, PLACEHOLDER_ALBUM);
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
			sweepArt();
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
		.ss-art { position: absolute; z-index: 1; overflow: hidden; border-radius: 4px; background: rgba(128, 128, 128, 0.3); pointer-events: none; }
		.ss-art img { display: block; width: 100%; height: 100%; object-fit: cover; }
		.ss-art.ss-letterbox img { transform: scale(1.34); }
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
			const duration = Spicetify.Player.getDuration() / 1000;
			if (duration > 0) seekSpotify((Number(seek.value) / 1000) * duration);
		});
		const toggle = h("button", { class: "ss-btn", onClick: togglePause });
		const next = h("button", { class: "ss-btn", title: t("playNext"), html: ICONS.next, onClick: skipNext });
		const close = h("button", { class: "ss-btn", html: ICONS.close, onClick: closeTrack });
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
		syncMediaSession();
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
		setCover(ui, track.thumbnail);
		ui.toggle.innerHTML = state.status === "playing" ? ICONS.pause : ICONS.play;
		ui.toggle.title = state.status === "playing" ? "Pause" : t("play");
		ui.seek.disabled = state.status === "loading";
		if (state.status === "loading") ui.seek.value = String(Math.round(state.progress * 1000));
	}

	function updateSeek() {
		if (!mini || state.status === "loading") return;
		const duration = trackDurationSec();
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
	};

	const takeover = { active: false, ui: null, widget: null };

	const isTrackActive = () => Boolean(state.current) && state.status !== "idle";

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
		takeover.ui = { np, cover, title, sub, lastCoverUrl: "" };
		return takeover.ui;
	}

	// Cached lookup: renderMini() runs often while a track is loading.
	function lookupHosts() {
		if (!takeover.widget?.isConnected) takeover.widget = document.querySelector(PLAYBAR.widget);
	}

	function mountInto(host, own) {
		host.dataset.ssHost = "1";
		if (own.parentElement !== host) host.append(own);
	}

	// Returns true while Spotify's now playing widget is showing the active non-Spotify track.
	// Only the widget is replaced. The progress bar and the buttons of the player bar stay Spotify's own,
	// because Spotify is the clock of the track (see syncSlave).
	function syncTakeover() {
		if (!isTrackActive()) {
			if (takeover.active) {
				takeover.active = false;
				document.body.classList.remove("ss-takeover");
			}
			return false;
		}
		lookupHosts();
		const { widget } = takeover;
		if (!widget) {
			takeover.active = false;
			document.body.classList.remove("ss-takeover");
			return false;
		}

		const ui = ensureTakeoverUi();
		mountInto(widget, ui.np);

		const track = state.current;
		const providerLabel = providers[track.provider]?.label;
		const artists = [track.artists.join(", "), providerLabel].filter(Boolean).join(" \u00b7 ");
		setText(ui.title, track.title);
		setText(ui.sub, state.status === "loading" ? `${t("loading", state.progress)}  -  ${artists}` : artists);
		setCover(ui, track.thumbnail);

		document.body.classList.add("ss-takeover");
		takeover.active = true;
		return true;
	}

	// ---------------------------------------------------------------------
	// Search page integration
	// ---------------------------------------------------------------------

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

	// The buttons of a result. Without playback enabled a result only offers "open in browser".
	function actionButtons(track) {
		const canPlay = config.playbackEnabled;
		return h(
			"div",
			{ class: "ss-actions" },
			canPlay && h("button", { class: "ss-btn", title: t("playNext"), html: ICONS.playNext, onClick: () => addToQueue(track, { next: true }) }),
			canPlay && h("button", { class: "ss-btn", title: t("addQueue"), html: ICONS.plus, onClick: () => addToQueue(track) }),
			canPlay && h("button", { class: "ss-btn", title: t("saveToPlaylist"), html: ICONS.savePlaylist, onClick: (event) => openPlaylistPicker(track, event.currentTarget) }),
			!canPlay && h("button", { class: "ss-btn", title: t("tryPlay"), html: ICONS.play, onClick: () => tryPlay(track) }),
			h("button", { class: "ss-btn", title: t("openBrowser"), html: ICONS.external, onClick: () => openInBrowser(track) })
		);
	}

	function trackRow(track) {
		const img = h("img", { class: "ss-cover", alt: "", loading: "lazy" });
		loadImage(img, track.thumbnail);
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
			actionButtons(track),
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
			actionButtons(track),
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
		if (attachScheduled || (!search.query && !isTrackActive())) return;
		// Ignore changes made by this extension to its own player bar elements.
		if (mutations.every((m) => m.target.closest?.(".ss-own"))) return;
		attachScheduled = true;
		requestAnimationFrame(() => {
			attachScheduled = false;
			attachSection();
			if (isTrackActive()) syncTakeover();
		});
	}).observe(document.body, { childList: true, subtree: true });

	// ---------------------------------------------------------------------
	// Diagnostics
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

	// ---------------------------------------------------------------------
	// Settings
	// ---------------------------------------------------------------------

	// A command of the setup guide. Clicking it copies the text.
	function commandBlock(label, text) {
		return h(
			"div",
			{},
			label && h("div", { class: "ss-desc" }, label),
			h("pre", { class: "ss-cmd", title: t("copyHint"), onClick: () => copyText(text) }, text)
		);
	}

	// A button that needs two clicks within a few seconds: the first one arms it, the second one confirms.
	function createConfirmButton(label, armedLabel, onConfirm) {
		let armed = false;
		let timer = null;
		const button = h(
			"button",
			{
				class: "ss-secondary",
				onClick: () => {
					if (!armed) {
						armed = true;
						button.textContent = armedLabel;
						timer = setTimeout(disarm, 4000);
						return;
					}
					disarm();
					onConfirm();
				},
			},
			label
		);
		function disarm() {
			armed = false;
			clearTimeout(timer);
			button.textContent = label;
		}
		return button;
	}

	// The "Enable playback" switch and the setup guide of the local Wisp server. The switch shows the saved
	// state; turning it on only sticks once the local Wisp answers. Returns the elements to show, and reset()
	// which cancels a running check, hides the guide and shows the saved state again.
	function createPlaybackSection() {
		const playback = h("input", { type: "checkbox" });
		playback.checked = config.playbackEnabled;
		const playbackSwitch = h("span", { class: "ss-switch" }, playback, h("span", {}));
		const guideStatus = h("div", { class: "ss-guide-status" });
		const checkButton = h("button", { class: "ss-primary", onClick: () => checkLocalWisp() }, t("guideCheck"));
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
					commandBlock("Linux / macOS", `curl -fsSLO ${WISP_SCRIPT_URL} && python3 wisp_ondemand.py install`),
					commandBlock("Windows (PowerShell)", `curl.exe -fsSLO ${WISP_SCRIPT_URL}; py -3 wisp_ondemand.py install`)
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
						onClick: () => window.open("https://github.com/kagamiomochi/Synthesis-Spicetify#setting-up-the-local-wisp-server", "_blank", "noopener,noreferrer"),
					},
					t("guideReadme")
				)
			),
			guideStatus
		);
		const guideToggle = h(
			"button",
			{
				class: "ss-link",
				style: "margin-top:6px",
				onClick: () => {
					guide.style.display = guide.style.display === "none" ? "block" : "none";
				},
			},
			t("showGuide")
		);

		let checkToken = 0;
		let checking = false;
		// While the connection is being verified the switch stays off and shows a spinner instead of the knob.
		function setChecking(value) {
			checking = value;
			playbackSwitch.classList.toggle("ss-checking", value);
			checkButton.disabled = value;
		}
		function setPlayback(enabled) {
			saveConfig({ playbackEnabled: enabled, publicPlayback: false });
			playback.checked = enabled;
			if (!enabled && state.status !== "idle") closeTrack();
			resetNetwork();
			renderSearch();
			notify(t(enabled ? "playbackOnToast" : "playbackOffToast"));
		}
		async function checkLocalWisp() {
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
				if (!config.playbackEnabled || config.publicPlayback) setPlayback(true);
				// Playback needs Spotify's Local Files for the placeholders, so set that up as well.
				const result = await setupLocalFiles();
				if (token !== checkToken) return;
				const messages = {
					ready: t("localFilesReady"),
					added: t("localFilesAdded", config.placeholderFolder),
					cancelled: t("localFilesCancelled"),
					failed: t("localFilesFailed"),
					unsupported: t("localFilesUnsupported"),
				};
				guideStatus.textContent = `${t("guideOk")} ${messages[result]}`;
			} else {
				guideStatus.textContent = t("guideFailed", config.localWisp);
				playback.checked = config.playbackEnabled;
			}
		}

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

		return {
			nodes: [h("label", { class: "ss-toggle" }, playbackSwitch, t("playbackLabel")), h("div", { class: "ss-desc" }, t("playbackDesc")), guideToggle, guide],
			reset() {
				checkToken++;
				setChecking(false);
				guide.style.display = "none";
				guideStatus.textContent = "";
				playback.checked = config.playbackEnabled;
			},
		};
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
		const apply = () => {
			saveConfig(collect());
			resetNetwork();
		};

		const playbackSection = createPlaybackSection();
		const resetButton = createConfirmButton(t("resetSettings"), t("resetConfirm"), () => {
			// Defaults have playback off, so stop the current track like the switch does.
			if (config.playbackEnabled && state.status !== "idle") closeTrack();
			resetConfig();
			// Sync the form with the restored defaults.
			wisp.value = config.wispServers.join("\n");
			clients.value = config.clients.join(", ");
			output.style.display = "none";
			output.textContent = "";
			playbackSection.reset();
			resetNetwork();
			renderSearch();
			notify(t("resetDone"));
		});

		const content = h(
			"div",
			{ class: "ss-settings" },
			...playbackSection.nodes,
			h("label", {}, t("wispLabel")),
			wisp,
			h("label", {}, t("clientsLabel")),
			clients,
			h(
				"div",
				{ class: "ss-buttons" },
				h(
					"button",
					{
						class: "ss-primary",
						onClick: () => {
							apply();
							notify(t("saved"));
						},
					},
					t("save")
				),
				h(
					"button",
					{
						class: "ss-secondary",
						onClick: async () => {
							apply();
							output.textContent = "";
							await runDiagnostics(log);
						},
					},
					t("test")
				),
				h(
					"button",
					{
						class: "ss-secondary",
						onClick: () => {
							clearAudioCache();
							notify(t("cacheCleared"));
						},
					},
					t("clearCache")
				),
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