// NAME: Synthesis Spicetify
// AUTHOR: kagamiomochi
// DESCRIPTION: Transcending all musical boundaries.

/*
 * Synthesis Spicetify
 *
 * Architecture overview:
 *  - Network:  libcurl.js (WASM libcurl + Wisp websocket proxy) replaces fetch() to bypass CORS.
 *  - Data:     youtubei.js (YouTube.js) talks to YouTube Music through that custom fetch. SoundCloud is read
 *              from the web client's api-v2 (the client_id is taken from soundcloud.com's own scripts).
 *  - Audio:    the audio stream is downloaded in ranged chunks and fed to a hidden <audio> through
 *              Media Source Extensions, so playback starts as soon as the first chunk has arrived.
 *              The finished download is kept as a Blob URL cache (also the fallback without MSE).
 *  - Spotify:  search page injection, and Spotify's own player bar, which shows and controls a non-Spotify
 *              track while it is active.
 *  - Playback: every non-Spotify track goes through a silent local-file placeholder (a spotify:local: item).
 *              Play, queue and playlist actions hand that placeholder to Spotify's own player, queue and
 *              playlists. When Spotify starts it, the extension pauses Spotify and streams the real track
 *              instead, and when the track ends Spotify moves on to whatever follows the placeholder.
 *
 * Both libraries are loaded lazily from jsDelivr (pinned versions) on first use.
 *
 * The file is one script (the Marketplace installs a single file), laid out top to bottom in dependency order:
 * boot, constants and config, i18n, utilities, network, images, YouTube Music and SoundCloud providers, playback state and
 * registries, audio cache, progressive playback, playback control, placeholders (files, registry, playlist
 * picker, handing them to Spotify, real names, cover art), styles, player bar takeover, search
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

	/* VERSION */ const VERSION = "v0.7.1";
	// The setup script is taken from the tag of the installed release, so the file that is downloaded and run
	// does not change under the user's feet when main moves on.
	const WISP_SCRIPT_REF = /^v\d+\.\d+\.\d+$/.test(VERSION) ? VERSION : "main";
	const WISP_SCRIPT_URL = `https://raw.githubusercontent.com/kagamiomochi/Synthesis-Spicetify/${WISP_SCRIPT_REF}/wisp-launcher/portable/wisp_ondemand.py`;
	const LIBCURL_URL = "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.5/libcurl_full.mjs";
	const YTJS_URL = "https://cdn.jsdelivr.net/npm/youtubei.js@18.3.0/bundle/browser.js";
	const FAAD2_URL = "https://cdn.jsdelivr.net/npm/@ohrstrom/faad2-wasm@2.11.2-rc.4/faad2_wasm.mjs"; // AAC decoder (SoundCloud)
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
		// When a track that was started on its own ends, play its service's next recommendation instead of
		// letting Spotify move on to the next local file.
		autoRecommend: true,
	};

	const CONFIG_VERSION = 6;
	const LOCAL_WISP_RE = /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/;

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

	// One-shot trial: the key (see trackKey) of the track the user explicitly asked to try over a public Wisp while
	// playback is off. Never saved, and it only unlocks that one track; it is cleared as soon as the download starts or fails.
	let trialKey = null;

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
			searching: (service) => `${service} を検索中...`,
			noResults: (service) => `${service} に該当する曲が見つかりませんでした。`,
			failed: (service) => `${service} の検索に失敗しました。`,
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
			recommendFailed: "おすすめの曲を取得できなかったため、再生を止めました",
			tryPlay: "公開 Wisp で試しに再生 (ほぼ通らないです)",
			trialSaved: "公開 Wisp で再生できたため、再生機能を有効のまま保存しました",
			settingsTitle: "Synthesis Spicetify 設定",
			wispLabel: "公開 Wisp プロキシ (1行に1つ、上から順に試行)",
			clientsLabel: "InnerTube クライアント (visionos / tv_samsung、カンマ区切り、上から順に試行)",
			clientsInvalid: (names) => `不明なクライアントです: ${names}`,
			wispInvalid: (urls) => `Wisp の URL は ws:// か wss:// で始めてください: ${urls}`,
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
			autoRecommendLabel: "自動再生",
			autoRecommendDesc: "検索から再生した曲が終わったとき、または次へを押したときに、次の配信元のおすすめの曲を再生します。プレイリストやキューからの再生には影響しません。",
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
			soundcloudRestricted: "この曲は SoundCloud 側の制限で全編を再生できません (プレビューのみ、または地域制限・非公開)。",
			soundcloudNoFormat: (formats) => `この曲は、この Spotify で再生できる形式が SoundCloud から提供されていません (提供: ${formats})。`,
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
			searching: (service) => `Searching ${service}...`,
			noResults: (service) => `No matching songs on ${service}.`,
			failed: (service) => `${service} search failed.`,
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
			recommendFailed: "Could not get a recommended track, so playback was stopped",
			tryPlay: "Try playing via public Wisp (often blocked)",
			trialSaved: "Playback worked over the public Wisp, so it stays enabled",
			settingsTitle: "Synthesis Spicetify settings",
			wispLabel: "Public Wisp proxies (one per line, tried in order)",
			clientsLabel: "InnerTube clients (visionos / tv_samsung, comma separated, tried in order)",
			clientsInvalid: (names) => `Unknown client: ${names}`,
			wispInvalid: (urls) => `A Wisp URL must start with ws:// or wss://: ${urls}`,
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
			autoRecommendLabel: "Autoplay",
			autoRecommendDesc: "When a song played from a search ends, or when you tap Next, the next recommended song from that source will play. This does not affect playback from playlists or queues.",
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
			soundcloudRestricted: "This track cannot be played in full (SoundCloud only offers a preview, or it is restricted or private).",
			soundcloudNoFormat: (formats) => `SoundCloud offers no format of this track that this Spotify can play (offered: ${formats}).`,
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
		plus: svg("M15 7H9V1H7v6H1v2h6v6h2V9h6z"),
		savePlaylist: svg("M1 2h9v1.5H1zM1 6.25h9v1.5H1zM1 10.5h5v1.5H1zM12 8v2.5h2.5V12H12v2.5h-1.5V12H8v-1.5h2.5V8z"),
		playNext: svg("M1 2h9v1.5H1zM1 6.25h9v1.5H1zM1 10.5h5v1.5H1zM10 9.5v5l4.5-2.5z"),
		external: svg("M7 2v1.5H3.5v9h9V9H14v5.5H2V2zM9 1h6v6h-1.5V3.56L8.53 8.53 7.47 7.47l4.97-4.97H9z"),
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

	const setText = (el, text) => {
		if (el.textContent !== text) el.textContent = text;
	};

	const notify = (message, isError = false) => Spicetify.showNotification(message, isError);

	const abortError = () => new DOMException("Aborted", "AbortError");

	// Console log of what the player and the services are doing (open the devtools of Spotify and filter by
	// "Synthesis Spicetify"). Signed URLs and keys are never logged in full.
	const debug = (scope, ...args) => console.log(`[Synthesis Spicetify][${scope}]`, ...args);
	const debugError = (scope, ...args) => console.error(`[Synthesis Spicetify][${scope}]`, ...args);
	const rangesText = (ranges) =>
		Array.from({ length: ranges.length }, (_, i) => `${ranges.start(i).toFixed(2)}-${ranges.end(i).toFixed(2)}`).join(", ") || "(none)";
	const audioStateText = (el) =>
		`time ${el.currentTime.toFixed(2)}, readyState ${el.readyState}, networkState ${el.networkState}, buffered ${rangesText(el.buffered)}`;

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

	let curlEntry = null; // the load of the current network generation: { generation, promise, session, url }
	let curlGeneration = 0; // bumped by resetNetwork(); a load that finds it changed is stale and drops its result
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

	class StaleNetworkError extends Error {}

	const closeQuietly = (session) => {
		try {
			session?.close();
		} catch {
			// ignore
		}
	};

	// libcurl.js keeps its Wisp sockets in one table keyed by the Wisp URL (always with a trailing slash).
	const wispKey = (url) => (url.endsWith("/") ? url : `${url}/`);

	// Closes the sockets of every Wisp except `keepUrl`, or only those of `onlyUrl`.
	function closeWispConnections(libcurl, { keepUrl = null, onlyUrl = null } = {}) {
		for (const [key, connection] of Object.entries(libcurl.wisp?.wisp_connections ?? {})) {
			if (keepUrl && key === wispKey(keepUrl)) continue;
			if (onlyUrl && key !== wispKey(onlyUrl)) continue;
			try {
				connection.ws?.close();
			} catch {
				// ignore
			}
		}
	}

	// Returns { url, session }. Every Wisp gets its own HTTPSession: libcurl.js keeps a connection cache per
	// session, so reusing the default session after switching the Wisp URL would keep sending requests to
	// youtube.com over the old (public) Wisp, which YouTube answers with LOGIN_REQUIRED.
	// Throws StaleNetworkError as soon as resetNetwork() has started a newer generation: libcurl.js is one shared
	// module, so an outdated load must not touch its global Wisp URL or session any more.
	async function pickWispServer(libcurl, generation) {
		const failures = [];
		for (const url of activeWispServers()) {
			if (generation !== curlGeneration) throw new StaleNetworkError();
			libcurl.set_websocket(url);
			const session = new libcurl.HTTPSession();
			try {
				const res = await withTimeout(session.fetch("https://www.gstatic.com/generate_204"), 10000, `Wisp ${url}`);
				if (generation !== curlGeneration) {
					closeQuietly(session);
					throw new StaleNetworkError();
				}
				if (res.status === 204 || res.ok) return { url, session };
				failures.push(`${url}: HTTP ${res.status}`);
			} catch (error) {
				if (error instanceof StaleNetworkError) throw error;
				failures.push(`${url}: ${error?.message || error}`);
			}
			closeQuietly(session);
		}
		throw new Error(`No usable Wisp server. ${failures.join(" / ")}`);
	}

	function startCurl() {
		const generation = curlGeneration;
		const entry = { generation, promise: null, session: null, url: "" };
		entry.promise = (async () => {
			const mod = await import(LIBCURL_URL);
			const libcurl = mod.libcurl;
			// The "full" build embeds the WASM binary, so no URL is needed here.
			await libcurl.load_wasm();
			if (generation !== curlGeneration) throw new StaleNetworkError();
			const picked = await pickWispServer(libcurl, generation);
			if (generation !== curlGeneration) {
				closeQuietly(picked.session);
				throw new StaleNetworkError();
			}
			entry.session = picked.session;
			entry.url = picked.url;
			libcurl.activeWisp = picked.url;
			libcurl.session = picked.session;
			activeWisp = picked.url;
			libcurl.set_websocket(picked.url);
			// Sockets of an earlier Wisp (or of a probe that was cancelled) would keep going out through it.
			closeWispConnections(libcurl, { keepUrl: picked.url });
			return libcurl;
		})();
		return entry;
	}

	async function loadCurl() {
		for (;;) {
			const generation = curlGeneration;
			if (!curlEntry || curlEntry.generation !== generation) curlEntry = startCurl();
			const entry = curlEntry;
			try {
				return await entry.promise;
			} catch (error) {
				if (curlEntry === entry) curlEntry = null; // a failed load is tried again by the next call
				// resetNetwork() ran while this load was working: its result was dropped, so ask again with the new settings.
				if (generation !== curlGeneration) continue;
				throw error;
			}
		}
	}

	// Drop-in replacement for fetch(), also handed to youtubei.js.
	async function curlFetch(input, init = {}) {
		const libcurl = await loadCurl();
		// libcurl.js reads the Wisp URL when a socket is opened, not when a session is created, so make sure it is ours.
		if (libcurl.activeWisp && libcurl.websocket_url !== libcurl.activeWisp) libcurl.set_websocket(libcurl.activeWisp);
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

		const res = await libcurl.session.fetch(url, {
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
		img.dataset.wanted = url || "";
		if (!url) {
			// No cover: do not keep showing the previous track's picture in a reused <img>.
			img.removeAttribute("src");
			return;
		}
		if (imageCache.has(url)) {
			img.src = imageCache.get(url);
			return;
		}
		// Assigned (not added) so that a reused <img> only ever has the handler of the URL it loads right now.
		img.onerror = async () => {
			if (img.dataset.fallback === url) return;
			img.dataset.fallback = url;
			try {
				const res = await curlFetch(url);
				const blobUrl = URL.createObjectURL(await res.blob());
				imageCache.set(url, blobUrl);
				if (img.dataset.wanted === url) img.src = blobUrl; // the <img> may have moved on to another cover
			} catch {
				// leave the placeholder
			}
		};
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
			const locale = new Intl.Locale(navigator.language || "en-US");
			// "ja" has no region: use the likely one ("JP") rather than falling back to "US".
			const region = locale.region ?? locale.maximize().region;
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
					// Without an artist the title alone says too little to call two results the same track.
					const artist = normalizeText(track.artists?.[0]);
					const key = artist ? `${normalizeText(track.title)}|${artist}` : null;
					if (seen.has(track.id) || (key && seen.has(key))) continue;
					seen.add(track.id);
					if (key) seen.add(key);
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

	// The tracks YouTube Music plays after this one (its "Up next" list, or the automix when there is none).
	// The list starts with the track itself. An entry is a PlaylistPanelVideo, or a wrapper around one in `primary`.
	async function youtubeRecommend(track) {
		const yt = await getInnertube();
		const panel = await yt.music.getUpNext(track.id);
		const tracks = [];
		for (const node of Array.from(panel?.contents ?? [])) {
			const video = node?.primary ?? node;
			const title = video?.title?.toString?.() ?? "";
			if (!video?.video_id || !title) continue;
			const people = video.artists?.length ? video.artists.map((person) => person.name) : [video.author];
			const thumbs = Array.from(video.thumbnail ?? []);
			tracks.push({
				provider: "youtube",
				id: video.video_id,
				title,
				artists: people.filter(Boolean),
				album: video.album?.name || "",
				durationMs: (video.duration?.seconds ?? 0) * 1000,
				thumbnail: resizeThumbnail(thumbs[thumbs.length - 1]?.url || thumbs[0]?.url),
			});
		}
		return tracks;
	}

	const youtubeOpenUrl = (track) => `https://music.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
	const youtubeThumbnail = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

	// A plain YouTube thumbnail is a small picture with black bars. The full-size frame (when YouTube has one)
	// has no bars: this is its URL, or null when the URL is not a plain YouTube thumbnail.
	function youtubeUpgradeThumbnail(url) {
		const match = /^(https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/)\w+\.jpg/.exec(url);
		return match ? `${match[1]}maxresdefault.jpg` : null;
	}

	// Title, artist and cover of a video that no stored data knows about: ask YouTube's oEmbed endpoint, which
	// needs no API key and returns the title and the channel name of any public video.
	async function youtubeFetchDisplay(id) {
		const watch = `https://www.youtube.com/watch?v=${id}`;
		const res = await curlFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`, {
			method: "GET",
			headers: { accept: "application/json" },
		});
		if (!res.ok) throw new Error(`oEmbed returned HTTP ${res.status}`);
		const data = await res.json();
		if (!data?.title) return null;
		// Auto-generated artist channels are called "<artist> - Topic".
		const artist = String(data.author_name || "").replace(/\s+-\s+Topic$/i, "");
		return { title: data.title, artist, album: "", thumbnail: data.thumbnail_url || youtubeThumbnail(id), letterbox: true };
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

	// Playback needs "Enable playback", except for the single trial of one track (see trialKey). Returns whether this
	// download is that trial.
	function claimPlayback(track) {
		const trial = !config.playbackEnabled && trackKey(track) === trialKey;
		trialKey = null; // a trial is single-use
		if (!config.playbackEnabled && !trial) throw new Error(t("playbackDisabled"));
		return trial;
	}

	// A trial that got as far as receiving audio over the public Wisp keeps playback enabled.
	function confirmTrial(trial) {
		if (!trial || config.playbackEnabled) return;
		saveConfig({ playbackEnabled: true, publicPlayback: true });
		renderSearch();
		notify(t("trialSaved"));
	}

	async function youtubeFetchAudio(track, { signal, onProgress, onStart, onChunk } = {}) {
		const trial = claimPlayback(track);
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
						confirmTrial(trial);
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

	// ---------------------------------------------------------------------
	// SoundCloud provider (unofficial: the web client's api-v2 and its public client_id)
	// ---------------------------------------------------------------------
	// SoundCloud's official API needs an Artist Pro account for its credentials, cannot keep a secret in an
	// extension, and its terms forbid mixing SoundCloud with other services. So this talks to
	// api-v2.soundcloud.com the way soundcloud.com itself (and yt-dlp) does: the client_id is read from the site's
	// own JS and cached, and read again when SoundCloud rejects it (HTTP 401 / 403). This may violate SoundCloud's
	// Terms of Service. If it breaks, compare with yt_dlp/extractor/soundcloud.py in yt-dlp.

	const SOUNDCLOUD_WEB = "https://soundcloud.com/";
	const SOUNDCLOUD_API = "https://api-v2.soundcloud.com";
	const SOUNDCLOUD_CLIENT_ID_KEY = "synthesis-spicetify:soundcloud-client-id";
	const SOUNDCLOUD_HEADERS = {
		accept: "application/json, text/javascript, */*; q=0.01",
		origin: "https://soundcloud.com",
		referer: "https://soundcloud.com/",
		"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/84.0.4147.105 Safari/537.36",
	};
	let soundcloudClientIdPromise = null;

	// Logging helpers: the client_id is public but still only shown shortened, and signed URLs lose their query.
	const soundcloudMask = (id) => `${String(id).slice(0, 4)}...`;
	const soundcloudShortUrl = (url) => {
		try {
			const parsed = new URL(url);
			return parsed.origin + parsed.pathname;
		} catch {
			return String(url);
		}
	};
	const soundcloudHead = (bytes) => Array.from(bytes.subarray(0, 12), (b) => b.toString(16).padStart(2, "0")).join(" ");

	function storedSoundcloudClientId() {
		try {
			return localStorage.getItem(SOUNDCLOUD_CLIENT_ID_KEY) || "";
		} catch {
			return "";
		}
	}

	// The web client keeps its client_id in one of the scripts of the main page: client_id:"<32 characters>".
	async function extractSoundcloudClientId() {
		debug("soundcloud", "client_id: reading soundcloud.com");
		const page = await curlFetch(SOUNDCLOUD_WEB, { headers: { ...SOUNDCLOUD_HEADERS, accept: "text/html" } });
		if (!page.ok) throw new Error(`soundcloud.com returned HTTP ${page.status}`);
		const html = await page.text();
		// Only SoundCloud's own scripts are read, newest bundle first (the same order yt-dlp uses).
		const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
			.map((match) => new URL(match[1], SOUNDCLOUD_WEB))
			.filter((url) => url.hostname.endsWith("sndcdn.com"))
			.reverse();
		debug("soundcloud", `client_id: ${scripts.length} SoundCloud scripts to search`);
		for (const url of scripts) {
			try {
				const res = await curlFetch(url.href, { headers: { ...SOUNDCLOUD_HEADERS, accept: "*/*" } });
				if (!res.ok) {
					debug("soundcloud", `client_id: ${url.pathname} returned HTTP ${res.status}`);
					continue;
				}
				const found = /client_id\s*:\s*"([0-9a-zA-Z]{32})"/.exec(await res.text());
				if (found) {
					debug("soundcloud", `client_id: found ${soundcloudMask(found[1])} in ${url.pathname}`);
					return found[1];
				}
			} catch (error) {
				debug("soundcloud", `client_id: ${url.pathname} failed:`, error?.message || error);
			}
		}
		throw new Error("could not find a SoundCloud client_id");
	}

	// `rejected` is a client_id SoundCloud just refused: the cached one is then replaced (unless a concurrent call
	// has already replaced it).
	function soundcloudClientId(rejected = "") {
		if (!soundcloudClientIdPromise || rejected) {
			const previous = soundcloudClientIdPromise;
			const promise = (async () => {
				if (rejected && previous) {
					const current = await previous.catch(() => "");
					if (current && current !== rejected) return current;
				}
				if (!rejected) {
					const stored = storedSoundcloudClientId();
					if (stored) {
						debug("soundcloud", `client_id: using the stored ${soundcloudMask(stored)}`);
						return stored;
					}
				} else {
					debug("soundcloud", `client_id: ${soundcloudMask(rejected)} was rejected, getting a new one`);
				}
				const id = await extractSoundcloudClientId();
				try {
					localStorage.setItem(SOUNDCLOUD_CLIENT_ID_KEY, id);
				} catch {
					// keep it in memory only
				}
				return id;
			})();
			soundcloudClientIdPromise = promise;
			promise.catch(() => {
				if (soundcloudClientIdPromise === promise) soundcloudClientIdPromise = null;
			});
		}
		return soundcloudClientIdPromise;
	}

	// GET a JSON document of api-v2 (also used for the media URLs it hands out), with the client_id attached.
	async function soundcloudCall(url, query = {}, signal) {
		let rejected = "";
		for (let attempt = 0; ; attempt++) {
			const clientId = await soundcloudClientId(rejected);
			const target = new URL(url);
			for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
			target.searchParams.set("client_id", clientId);
			const began = performance.now();
			const res = await curlFetch(target.href, { method: "GET", headers: SOUNDCLOUD_HEADERS, signal });
			debug("soundcloud", `GET ${soundcloudShortUrl(target.href)} -> HTTP ${res.status} (${Math.round(performance.now() - began)} ms)`);
			if ((res.status === 401 || res.status === 403) && attempt === 0) {
				rejected = clientId;
				continue;
			}
			if (!res.ok) {
				const error = new Error(`SoundCloud returned HTTP ${res.status}`);
				error.status = res.status;
				throw error;
			}
			return res.json();
		}
	}

	// ---- Tracks and covers ----
	const SOUNDCLOUD_COVER_RE = /^(https:\/\/i\d*\.sndcdn\.com\/.+-)(?:mini|tiny|small|badge|t67x67|large|t300x300|crop|t500x500|t1080x1080|original)(\.(?:jpg|jpeg|png))(\?.*)?$/;

	// Covers come in fixed sizes that are named in the file name (-large.jpg is 100 px, -t500x500.jpg is 500 px).
	function soundcloudResizeThumbnail(url, size) {
		const match = SOUNDCLOUD_COVER_RE.exec(url);
		if (!match) return null;
		const name = size <= 67 ? "t67x67" : size <= 100 ? "large" : size <= 300 ? "t300x300" : "t500x500";
		return `${match[1]}${name}${match[2]}`;
	}

	// An api-v2 track object as a track of this extension, or null for what cannot be played in full.
	function soundcloudToTrack(item) {
		if (!item || (item.kind && item.kind !== "track") || !item.id || !item.title) return null;
		// BLOCK: not available here. SNIP: a 30 second preview (SoundCloud Go+ content, which is not touched).
		if (item.policy === "BLOCK" || item.policy === "SNIP" || item.streamable === false) return null;
		const cover = item.artwork_url || item.user?.avatar_url || "";
		return {
			provider: "soundcloud",
			id: String(item.id),
			title: String(item.title),
			artists: [item.publisher_metadata?.artist || item.user?.username || ""].filter(Boolean),
			album: item.publisher_metadata?.album_title || "",
			durationMs: item.full_duration || item.duration || 0,
			thumbnail: (cover && soundcloudResizeThumbnail(cover, 500)) || cover,
			url: item.permalink_url || "",
		};
	}

	function createSoundcloudSearch(query) {
		const seen = new Set();
		let buffer = [];
		let next = null; // next_href of the last page
		let started = false;
		let done = false;

		async function fillBuffer() {
			const page = started
				? await soundcloudCall(next)
				: await soundcloudCall(`${SOUNDCLOUD_API}/search/tracks`, { q: query, limit: 20, linked_partitioning: 1 });
			started = true;
			next = page?.next_href || null;
			const items = page?.collection ?? [];
			if (!next || !items.length) done = true;
			for (const item of items) {
				const track = soundcloudToTrack(item);
				if (!track || seen.has(track.id)) continue;
				seen.add(track.id);
				buffer.push(track);
			}
		}

		return {
			get hasMore() {
				return buffer.length > 0 || !done;
			},
			async take(count) {
				// A page can be entirely unplayable or duplicates, so allow a few fetches before giving up.
				for (let attempt = 0; attempt < 5 && buffer.length < count && !done; attempt++) await fillBuffer();
				return buffer.splice(0, count);
			},
		};
	}

	const soundcloudSearch = (query, limit) => createSoundcloudSearch(query).take(limit);

	// The tracks SoundCloud lists as related to this one (the "Related tracks" of its web player).
	async function soundcloudRecommend(track) {
		const page = await soundcloudCall(`${SOUNDCLOUD_API}/tracks/${encodeURIComponent(track.id)}/related`, { limit: 20, linked_partitioning: 1 });
		return (page?.collection ?? []).map(soundcloudToTrack).filter(Boolean);
	}
	const soundcloudOpenUrl = (track) => track.url || null;

	async function soundcloudFetchDisplay(id) {
		const item = await soundcloudCall(`${SOUNDCLOUD_API}/tracks/${encodeURIComponent(id)}`);
		if (!item?.title) return null;
		const track = soundcloudToTrack({ ...item, policy: "ALLOW", streamable: true });
		return { title: track.title, artist: track.artists.join(", "), album: track.album, thumbnail: track.thumbnail, letterbox: false };
	}

	// ---- Audio ----

	// The downloadable full-length transcodings of a track, best first. Progressive MP3 is a plain file, HLS MP3
	// is a list of MP3 pieces that simply follow each other, Opus is Ogg Opus (played from the finished download,
	// MSE has no Ogg), HLS AAC is a fragmented MP4. Previews and DRM / encrypted HLS are left out.
	function soundcloudCandidates(info) {
		// AAC comes last: the Chromium inside Spotify has no AAC decoder (see soundcloudCanPlay).
		const rank = { "progressive:mp3": 0, "hls:mp3": 1, "progressive:opus": 2, "hls:opus": 3, "hls:aac": 4 };
		const candidates = [];
		for (const transcoding of info?.media?.transcodings ?? []) {
			if (!transcoding?.url || !transcoding.preset) continue;
			if (transcoding.snipped || transcoding.url.includes("/preview/")) continue;
			const protocol = transcoding.format?.protocol || "progressive";
			const codec = transcoding.preset.split("_")[0];
			const order = rank[`${protocol}:${codec}`];
			if (order === undefined) continue;
			candidates.push({ url: transcoding.url, protocol, codec, order });
		}
		return candidates.sort((a, b) => a.order - b.order);
	}

	const SOUNDCLOUD_MIME = { mp3: "audio/mpeg", opus: 'audio/ogg; codecs="opus"', aac: 'audio/mp4; codecs="mp4a.40.2"' };

	// Whether the <audio> of this Spotify build can decode the format. The Chromium inside Spotify can play MP3 and
	// Opus but has no AAC ("FFmpegDemuxer: no supported streams"), and SoundCloud often offers AAC only.
	function soundcloudCanPlay(mime) {
		try {
			return document.createElement("audio").canPlayType(mime) !== "";
		} catch {
			return false;
		}
	}

	const soundcloudLabel = (candidate) => `${candidate.protocol}_${candidate.codec}`;
	const soundcloudNeedsDecoding = (candidate) => candidate.protocol === "hls" && candidate.codec === "aac" && !soundcloudCanPlay(SOUNDCLOUD_MIME.aac);

	// Reads an HLS playlist. A master playlist yields `variant` (the media playlist to read instead).
	function parseHlsPlaylist(text, baseUrl) {
		const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		if (lines[0] !== "#EXTM3U") throw new Error("not an HLS playlist");
		const parsed = { variant: null, init: null, segments: [], encrypted: false };
		let expectVariant = false;
		for (const line of lines) {
			if (line.startsWith("#EXT-X-STREAM-INF")) {
				expectVariant = true;
			} else if (line.startsWith("#EXT-X-MAP:")) {
				const uri = /URI="([^"]+)"/.exec(line);
				if (uri) parsed.init = new URL(uri[1], baseUrl).href;
			} else if (line.startsWith("#EXT-X-KEY:")) {
				if (!/METHOD=NONE/.test(line)) parsed.encrypted = true;
			} else if (!line.startsWith("#")) {
				const url = new URL(line, baseUrl).href;
				if (expectVariant) parsed.variant ??= url;
				else parsed.segments.push(url);
				expectVariant = false;
			}
		}
		return parsed;
	}

	const soundcloudMediaHeaders = { ...SOUNDCLOUD_HEADERS, accept: "*/*" };

	// A progressive file: one request, streamed.
	async function soundcloudDownloadFile(url, codec, { signal, onProgress, onStart, onChunk } = {}) {
		const mime = SOUNDCLOUD_MIME[codec] || "audio/mpeg";
		const res = await curlFetch(url, { method: "GET", headers: soundcloudMediaHeaders, signal });
		if (!res.ok) throw new Error(`SoundCloud media returned HTTP ${res.status}`);
		const total = Number(res.headers?.get?.("content-length")) || 0;
		debug("soundcloud", `file: ${soundcloudShortUrl(url)}, content-length ${total || "unknown"}, mime ${mime}`);
		onStart?.(mime);
		const parts = [];
		let received = 0;
		const reader = res.body.getReader();
		for (;;) {
			throwIfAborted(signal);
			const { done, value } = await reader.read();
			if (done) break;
			if (!parts.length) debug("soundcloud", `file: first bytes ${soundcloudHead(value)}`);
			parts.push(value);
			onChunk?.(value);
			received += value.byteLength;
			if (total) onProgress?.(Math.min(received / total, 1));
		}
		throwIfAborted(signal);
		debug("soundcloud", `file: received ${received} bytes`);
		if (!received || (total && received < total * 0.98)) throw new Error("incomplete download");
		return new Blob(parts, { type: mime });
	}

	// HLS: the pieces (and the init segment of an fMP4) are fetched in order, one ahead, and handed on as they come.
	async function soundcloudDownloadHls(url, codec, { signal, onProgress, onStart, onChunk, out } = {}) {
		const readPlaylist = async (playlistUrl) => {
			const res = await curlFetch(playlistUrl, { method: "GET", headers: soundcloudMediaHeaders, signal });
			if (!res.ok) throw new Error(`SoundCloud playlist returned HTTP ${res.status}`);
			return parseHlsPlaylist(await res.text(), playlistUrl);
		};
		let playlist = await readPlaylist(url);
		if (playlist.variant) playlist = await readPlaylist(playlist.variant);
		if (playlist.encrypted) throw new Error("encrypted HLS is not supported");
		if (!playlist.segments.length) throw new Error("empty HLS playlist");

		const mime = codec === "aac" && !playlist.init ? "audio/aac" : SOUNDCLOUD_MIME[codec] || "audio/mpeg";
		const urls = playlist.init ? [playlist.init, ...playlist.segments] : playlist.segments;
		debug("soundcloud", `HLS: ${playlist.segments.length} pieces, init ${playlist.init ? soundcloudShortUrl(playlist.init) : "none"}, mime ${mime}`);
		if (out) out.hasInit = Boolean(playlist.init); // out.pieces gets the downloaded pieces (init first)
		const began = performance.now();
		let total = 0;
		const fetchPart = async (partUrl) => {
			const res = await curlFetch(partUrl, { method: "GET", headers: soundcloudMediaHeaders, signal });
			if (!res.ok) throw new Error(`SoundCloud media returned HTTP ${res.status}`);
			return new Uint8Array(await res.arrayBuffer());
		};

		const parts = [];
		let started = false;
		let pending = fetchPart(urls[0]);
		pending.catch(() => {}); // it is awaited below, but not when the signal is already aborted at the first check
		for (let i = 0; i < urls.length; i++) {
			throwIfAborted(signal);
			const current = pending;
			pending = i + 1 < urls.length ? fetchPart(urls[i + 1]) : null;
			pending?.catch(() => {}); // not awaited when this loop ends early; its error is not unhandled
			const bytes = await current;
			total += bytes.byteLength;
			// The first bytes tell the container: "00 00 00 xx 66 74 79 70" (ftyp) is MP4, "ff f1" / "ff f9" is ADTS AAC.
			if (i < 3 || (i + 1) % 10 === 0 || i === urls.length - 1) {
				// For Ogg Opus: does a piece start its own stream (OpusHead)? Then the pieces are chained streams.
				const opusHead = codec === "opus" ? `, OpusHead ${new TextDecoder("latin1").decode(bytes.subarray(0, 128)).includes("OpusHead")}` : "";
				debug("soundcloud", `HLS: piece ${i + 1}/${urls.length}, ${bytes.byteLength} bytes, first bytes ${soundcloudHead(bytes)}${opusHead}`);
			}
			if (!started) {
				started = true;
				onStart?.(mime);
			}
			parts.push(bytes);
			out?.pieces?.push(bytes);
			onChunk?.(bytes);
			onProgress?.((i + 1) / urls.length);
		}
		debug("soundcloud", `HLS: done, ${total} bytes in ${Math.round(performance.now() - began)} ms`);
		return new Blob(parts, { type: mime });
	}

	// ---- AAC without an AAC decoder in the player ----
	// The Chromium inside Spotify has no AAC decoder and SoundCloud offers AAC only. So the fragmented MP4 is taken
	// apart here and the AAC frames are decoded by FAAD2 (WebAssembly, loaded from the CDN like libcurl.js) while
	// the pieces download. The PCM is played through Web Audio as it comes (see createPcmEngine) and is also
	// collected into a WAV file for the cache.

	const FAAD2_SAMPLE_RATES = { 1: 8000, 2: 16000, 3: 22050, 4: 32000, 5: 44100, 6: 48000, 7: 64000, 8: 88200, 9: 96000 };
	const FAAD2_INPUT_CAPACITY = 1 << 15;
	const FAAD2_OUTPUT_BYTES = 4096 * 2 * 4; // up to 4096 samples of two channels as float32

	// The boxes of an MP4 between `start` and `end`: { type, start, body, end }.
	function* mp4Boxes(bytes, start = 0, end = bytes.length) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let pos = start;
		while (pos + 8 <= end) {
			let size = view.getUint32(pos);
			const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
			let header = 8;
			if (size === 1) {
				size = Number(view.getBigUint64(pos + 8));
				header = 16;
			} else if (size === 0) {
				size = end - pos;
			}
			if (size < header || pos + size > end) break; // truncated
			yield { type, start: pos, body: pos + header, end: pos + size };
			pos += size;
		}
	}

	function mp4Child(bytes, parent, type, skip = 0) {
		for (const box of mp4Boxes(bytes, parent.body + skip, parent.end)) if (box.type === type) return box;
		return null;
	}

	function mp4Path(bytes, root, path) {
		let box = root;
		for (const type of path) {
			box = box && mp4Child(bytes, box, type);
			if (!box) return null;
		}
		return box;
	}

	// The AudioSpecificConfig, the channel count and the default sample size of an AAC init segment.
	function readAacInit(init) {
		const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
		const moov = mp4Child(init, { body: 0, end: init.length }, "moov");
		const stsd = mp4Path(init, moov, ["trak", "mdia", "minf", "stbl", "stsd"]);
		if (!stsd) throw new Error("no sample description in the init segment");
		// stsd: version + flags (4), entry count (4), then the sample entries
		const entry = mp4Boxes(init, stsd.body + 8, stsd.end).next().value;
		if (entry?.type !== "mp4a") throw new Error(`unexpected sample entry ${entry?.type}`);
		const channels = view.getUint16(entry.body + 16);
		// The entry has 28 bytes of audio fields, then child boxes; esds holds the descriptors.
		const esds = mp4Child(init, entry, "esds", 28);
		if (!esds) throw new Error("no esds box in the init segment");
		let p = esds.body + 4; // version + flags
		const descriptor = () => {
			const tag = init[p++];
			let length = 0;
			for (let i = 0; i < 4; i++) {
				const b = init[p++];
				length = (length << 7) | (b & 0x7f);
				if (!(b & 0x80)) break;
			}
			return { tag, length };
		};
		if (descriptor().tag !== 0x03) throw new Error("bad ES descriptor");
		p += 2; // ES_ID
		const flags = init[p++];
		if (flags & 0x80) p += 2; // stream dependence
		if (flags & 0x40) p += init[p] + 1; // URL
		if (flags & 0x20) p += 2; // OCR
		if (descriptor().tag !== 0x04) throw new Error("bad decoder config descriptor");
		p += 13; // object type, stream type, buffer size, max and average bitrate
		const specific = descriptor();
		if (specific.tag !== 0x05) throw new Error("no AudioSpecificConfig");
		const asc = init.slice(p, p + specific.length);
		const trex = mp4Path(init, moov, ["mvex", "trex"]);
		return { asc, channels, defaultSize: trex ? view.getUint32(trex.body + 16) : 0 };
	}

	// The raw AAC frames of one media segment (styp? moof mdat), found through the sample sizes of the trun box.
	function readAacFragment(bytes, defaultSize = 0) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		const frames = [];
		const mdat = mp4Child(bytes, { body: 0, end: bytes.length }, "mdat");
		for (const moof of mp4Boxes(bytes)) {
			if (moof.type !== "moof") continue;
			for (const traf of mp4Boxes(bytes, moof.body, moof.end)) {
				if (traf.type !== "traf") continue;
				let sampleSize = defaultSize;
				for (const box of mp4Boxes(bytes, traf.body, traf.end)) {
					const flags = box.type === "tfhd" || box.type === "trun" ? view.getUint32(box.body) & 0xffffff : 0;
					if (box.type === "tfhd") {
						let q = box.body + 8; // version + flags, track ID
						if (flags & 0x1) q += 8; // base data offset: the offsets below stay relative to the moof box
						if (flags & 0x2) q += 4; // sample description index
						if (flags & 0x8) q += 4; // default sample duration
						if (flags & 0x10) sampleSize = view.getUint32(q);
					} else if (box.type === "trun") {
						const count = view.getUint32(box.body + 4);
						let q = box.body + 8;
						let pos = mdat ? mdat.body : 0;
						if (flags & 0x1) {
							pos = moof.start + view.getInt32(q);
							q += 4;
						}
						if (flags & 0x4) q += 4; // first sample flags
						for (let i = 0; i < count; i++) {
							if (flags & 0x100) q += 4; // duration
							let size = sampleSize;
							if (flags & 0x200) {
								size = view.getUint32(q);
								q += 4;
							}
							if (flags & 0x400) q += 4; // flags
							if (flags & 0x800) q += 4; // composition time offset
							if (!size || pos + size > bytes.length) throw new Error("truncated AAC fragment");
							frames.push(bytes.subarray(pos, pos + size));
							pos += size;
						}
					}
				}
			}
		}
		return frames;
	}

	let soundcloudFaad2Promise = null;

	// FAAD2 as a WebAssembly module. If the page may not fetch the .wasm itself, it is fetched through the proxy.
	function loadFaad2() {
		soundcloudFaad2Promise ??= (async () => {
			const factory = (await import(FAAD2_URL)).default;
			try {
				return await factory({});
			} catch (error) {
				debug("soundcloud", "FAAD2: loading the wasm directly failed, fetching it through the proxy:", error?.message || error);
				const res = await curlFetch(new URL("faad2_wasm.wasm", FAAD2_URL).href, { method: "GET" });
				if (!res.ok) throw new Error(`FAAD2 wasm returned HTTP ${res.status}`);
				return factory({ wasmBinary: new Uint8Array(await res.arrayBuffer()) });
			}
		})();
		soundcloudFaad2Promise.catch(() => {
			soundcloudFaad2Promise = null;
		});
		return soundcloudFaad2Promise;
	}

	// The FAAD2 module has one decoder, so tracks are decoded one at a time.
	let soundcloudDecodeLock = Promise.resolve();
	function withSoundcloudDecodeLock(task) {
		const run = soundcloudDecodeLock.then(task, task);
		soundcloudDecodeLock = run.catch(() => {});
		return run;
	}

	function wavHeader(dataBytes, sampleRate, channels) {
		const view = new DataView(new ArrayBuffer(44));
		const text = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
		text(0, "RIFF");
		view.setUint32(4, 36 + dataBytes, true);
		text(8, "WAVEfmt ");
		view.setUint32(16, 16, true); // fmt chunk size
		view.setUint16(20, 1, true); // PCM
		view.setUint16(22, channels, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * channels * 2, true);
		view.setUint16(32, channels * 2, true);
		view.setUint16(34, 16, true);
		text(36, "data");
		view.setUint32(40, dataBytes, true);
		return view.buffer;
	}

	// The mime type that a download reports (onStart) when it hands decoded audio on. Its chunks are then
	// { pcm: Int16Array (interleaved), sampleRate, channels } blocks instead of bytes (see createPcmEngine).
	const PCM_STREAM_MIME = "audio/x-synthesis-pcm";
	const AAC_BLOCK_SECONDS = 1; // how much decoded audio is handed to the player at a time
	const AAC_YIELD_FRAMES = 256; // AAC frames decoded between two yields to the UI

	// A queue: the downloader pushes the pieces in, the decoder pulls them out.
	function createPieceQueue() {
		const items = [];
		let waiting = null; // { resolve, reject } of a next() that has to wait
		let closed = false;
		let failure = null;
		const settle = (method, value) => {
			const pending = waiting;
			waiting = null;
			pending?.[method](value);
		};
		return {
			push(item) {
				if (waiting) settle("resolve", item);
				else items.push(item);
			},
			close() {
				closed = true;
				settle("resolve", null);
			},
			fail(error) {
				failure = error;
				settle("reject", error);
			},
			next() {
				if (failure) return Promise.reject(failure);
				if (items.length) return Promise.resolve(items.shift());
				if (closed) return Promise.resolve(null);
				return new Promise((resolve, reject) => {
					waiting = { resolve, reject };
				});
			},
		};
	}

	// Decodes an fMP4 AAC stream piece by piece. `pieces.next()` resolves with the init segment first, then with the
	// media segments, and with null at the end. `onBlock({ pcm, sampleRate, channels })` gets about a second of 16 bit
	// interleaved PCM at a time. Resolves with all the blocks (for a WAV file) and the format.
	async function soundcloudDecodeAacStream(pieces, { signal, onBlock, hasInit = () => true } = {}) {
		const faad = await loadFaad2();
		return withSoundcloudDecodeLock(async () => {
			const began = performance.now();
			const init = await pieces.next();
			if (!init) throw new Error("empty HLS playlist");
			if (!hasInit()) throw new Error("AAC without an init segment (ADTS) is not supported");
			const { asc, defaultSize } = readAacInit(init);
			const inPtr = faad._malloc(FAAD2_INPUT_CAPACITY + 64);
			const outPtr = faad._malloc(FAAD2_OUTPUT_BYTES);
			try {
				const ascPtr = faad._malloc(asc.length);
				faad.HEAPU8.set(asc, ascPtr);
				const result = faad._init_decoder(ascPtr, asc.length);
				faad._free(ascPtr);
				if (result < 0) throw new Error(`FAAD2 could not start the decoder (${result}), ASC ${Array.from(asc, (b) => b.toString(16)).join(" ")}`);

				const blocks = [];
				let work = null; // the block that is being filled
				let capacity = 0; // samples (all channels) at which a block is handed on
				let filled = 0;
				let sampleRate = 0;
				let channels = 0;
				let dataBytes = 0;
				let frameCount = 0;
				let skipped = 0;
				const flush = () => {
					if (!filled) return;
					const block = { pcm: work.slice(0, filled), sampleRate, channels };
					filled = 0;
					dataBytes += block.pcm.byteLength;
					if (!blocks.length) debug("soundcloud", `FAAD2: first block after ${Math.round(performance.now() - began)} ms`);
					blocks.push(block);
					onBlock?.(block);
				};

				for (let piece = await pieces.next(); piece; piece = await pieces.next()) {
					throwIfAborted(signal);
					const frames = readAacFragment(piece, defaultSize);
					for (let i = 0; i < frames.length; i++) {
						if (i % AAC_YIELD_FRAMES === 0) {
							await new Promise((resolve) => setTimeout(resolve)); // keep the UI alive
							throwIfAborted(signal);
						}
						frameCount++;
						const frame = frames[i];
						if (frame.length > FAAD2_INPUT_CAPACITY) throw new Error(`AAC frame of ${frame.length} bytes is too large`);
						faad.HEAPU8.set(frame, inPtr);
						faad.HEAPU8.fill(0, inPtr + frame.length, inPtr + frame.length + 64);
						const packed = faad._decode_frame(inPtr, frame.length, outPtr, FAAD2_OUTPUT_BYTES);
						if (packed === 0 || (packed < 0 && packed > -1000)) {
							skipped++; // no output (decoder start-up) or a broken frame
							continue;
						}
						const rate = FAAD2_SAMPLE_RATES[(packed >>> 28) & 0xf];
						const count = packed & 0xffffff;
						const frameChannels = (packed >>> 24) & 0xf;
						if (!rate || !frameChannels || !count) {
							skipped++;
							continue;
						}
						if (!sampleRate) {
							sampleRate = rate;
							channels = frameChannels;
							capacity = Math.ceil(sampleRate * AAC_BLOCK_SECONDS) * channels;
							work = new Int16Array(capacity + FAAD2_OUTPUT_BYTES / 4); // room for the frame that crosses the limit
						} else if (rate !== sampleRate || frameChannels !== channels) {
							throw new Error("the AAC stream changes its format");
						}
						const raw = new Float32Array(faad.HEAPU8.buffer, outPtr, count);
						for (let k = 0; k < count; k++) work[filled + k] = Math.round(Math.max(-1, Math.min(1, raw[k])) * 32767);
						filled += count;
						if (filled >= capacity) flush();
					}
				}
				flush();
				throwIfAborted(signal);
				if (!blocks.length) throw new Error("FAAD2 decoded no audio");
				debug("soundcloud", `FAAD2: ${frameCount} frames (${skipped} without output) -> ${dataBytes} bytes of PCM, ${sampleRate} Hz, ${channels} ch, ${Math.round(performance.now() - began)} ms`);
				return { blocks, sampleRate, channels, dataBytes, frames: frameCount };
			} finally {
				faad._free(inPtr);
				faad._free(outPtr);
			}
		});
	}

	function wavBlob({ blocks, dataBytes, sampleRate, channels }) {
		return new Blob([wavHeader(dataBytes, sampleRate, channels), ...blocks.map((block) => block.pcm)], { type: "audio/wav" });
	}

	// Decodes an fMP4 AAC track that is already in memory (init segment + media segments) to a 16 bit WAV Blob.
	async function soundcloudDecodeAac(init, pieces, { signal } = {}) {
		const queue = createPieceQueue();
		for (const piece of [init, ...pieces]) queue.push(piece);
		queue.close();
		const decoded = await soundcloudDecodeAacStream(queue, { signal });
		return { blob: wavBlob(decoded), sampleRate: decoded.sampleRate, channels: decoded.channels, frames: decoded.frames };
	}

	// HLS AAC: the pieces are decoded while they download, and the decoded audio is handed on as it comes: onStart
	// with PCM_STREAM_MIME before the first block, then onChunk for every block. The finished WAV is the return
	// value, for the cache.
	async function soundcloudDownloadAacStreamed(url, codec, { signal, onProgress, onStart, onChunk } = {}) {
		const queue = createPieceQueue();
		const out = { hasInit: false };
		// The decoder can fail before the download is done: this stops the download then.
		const inner = new AbortController();
		const abortInner = () => inner.abort();
		signal?.addEventListener("abort", abortInner, { once: true });
		if (signal?.aborted) inner.abort();

		// A failed download reaches the decoder through the queue, so this promise never rejects.
		const download = soundcloudDownloadHls(url, codec, {
			signal: inner.signal,
			out,
			onProgress: (p) => onProgress?.(p * 0.95),
			onChunk: (bytes) => queue.push(bytes),
		}).then(
			() => queue.close(),
			(error) => queue.fail(error)
		);

		let started = false;
		try {
			const decoded = await soundcloudDecodeAacStream(queue, {
				signal,
				hasInit: () => out.hasInit,
				onBlock: (block) => {
					if (!started) {
						started = true;
						onStart?.(PCM_STREAM_MIME);
					}
					onChunk?.(block);
				},
			});
			await download;
			onProgress?.(1);
			return wavBlob(decoded);
		} finally {
			signal?.removeEventListener("abort", abortInner);
			inner.abort(); // nothing is left to stop once the download has finished
		}
	}

	async function soundcloudFetchAudio(track, { signal, onProgress, onStart, onChunk } = {}) {
		const trial = claimPlayback(track);
		const info = await soundcloudCall(`${SOUNDCLOUD_API}/tracks/${encodeURIComponent(track.id)}`, {}, signal);
		const offered = soundcloudCandidates(info);
		// AAC is always usable: when the player cannot decode it, it is decoded here.
		const candidates = offered.filter((candidate) => candidate.codec === "aac" || soundcloudCanPlay(SOUNDCLOUD_MIME[candidate.codec]));
		debug("soundcloud", `track ${track.id}: policy ${info.policy}, access ${info.access}, streamable ${info.streamable}, duration ${info.duration} / full ${info.full_duration}`);
		debug("soundcloud", `transcodings: ${(info.media?.transcodings ?? []).map((x) => `${x.format?.protocol}/${x.preset}${x.snipped ? " (snipped)" : ""}`).join(", ")}`);
		debug("soundcloud", `this player can play: ${Object.entries(SOUNDCLOUD_MIME).map(([codec, mime]) => `${codec}=${soundcloudCanPlay(mime)}`).join(", ")}`);
		debug("soundcloud", `offered, best first: ${offered.map(soundcloudLabel).join(", ") || "(none)"}; playable here: ${candidates.map((c) => soundcloudLabel(c) + (soundcloudNeedsDecoding(c) ? " (decoded here)" : "")).join(", ") || "(none)"}`);
		if (!offered.length) throw new Error(t("soundcloudRestricted"));
		if (!candidates.length) throw new Error(t("soundcloudNoFormat", offered.map(soundcloudLabel).join(", ")));
		const query = info.track_authorization ? { track_authorization: info.track_authorization } : {};
		const errors = [];
		let started = false;

		for (const candidate of candidates) {
			throwIfAborted(signal);
			const label = soundcloudLabel(candidate);
			try {
				debug("soundcloud", `trying ${label}`);
				const data = await soundcloudCall(candidate.url, query, signal);
				if (!data?.url) throw new Error("no stream URL in the response");
				debug("soundcloud", `${label}: stream URL ${soundcloudShortUrl(data.url)}`);
				const download = soundcloudNeedsDecoding(candidate) ? soundcloudDownloadAacStreamed : candidate.protocol === "hls" ? soundcloudDownloadHls : soundcloudDownloadFile;
				const blob = await download(data.url, candidate.codec, {
					signal,
					onProgress,
					onChunk,
					onStart: (mime) => {
						started = true;
						confirmTrial(trial);
						debug("soundcloud", `${label}: handing audio to the player as ${mime}`);
						onStart?.(mime);
					},
				});
				debug("soundcloud", `${label}: download finished, ${blob.size} bytes`);
				return { blob, mime: blob.type };
			} catch (error) {
				if (signal?.aborted || error?.name === "AbortError") throw abortError();
				debugError("soundcloud", `${label} failed${started ? " after the audio had started" : ""}:`, error);
				// Chunks already handed to the player cannot be taken back, so a failure mid-stream is final.
				if (started) throw error;
				errors.push(`${label}: ${error?.message || error}`);
			}
		}
		throw new Error(errors.join(" | "));
	}

	// The SoundCloud steps of the connection test: client_id + search, then the first bytes of a stream.
	async function soundcloudDiagnose(log, step) {
		let tracks = [];
		if (!(await step("SoundCloud client_id + search", async () => {
			tracks = await soundcloudSearch("daft punk one more time", 3);
			if (!tracks.length) throw new Error("0 results");
			return `${tracks.length} results`;
		}))) return;

		if (!config.playbackEnabled) {
			log("Playback is disabled, so the SoundCloud stream steps are skipped.");
			return;
		}
		let sample = null; // init segment and first piece of an AAC track that this player cannot decode itself
		const streamOk = await step("SoundCloud stream (first bytes)", async () => {
			const info = await soundcloudCall(`${SOUNDCLOUD_API}/tracks/${tracks[0].id}`);
			const offered = soundcloudCandidates(info);
			if (!offered.length) throw new Error("no full-length transcoding");
			const candidate = offered.find((c) => c.codec === "aac" || soundcloudCanPlay(SOUNDCLOUD_MIME[c.codec]));
			if (!candidate) throw new Error(`no format this player can play (offered: ${offered.map(soundcloudLabel).join(", ")})`);
			const query = info.track_authorization ? { track_authorization: info.track_authorization } : {};
			const data = await soundcloudCall(candidate.url, query);
			if (!data?.url) throw new Error("no stream URL in the response");
			if (candidate.protocol === "hls") {
				let playlist = parseHlsPlaylist(await (await curlFetch(data.url, { headers: soundcloudMediaHeaders })).text(), data.url);
				if (playlist.variant) playlist = parseHlsPlaylist(await (await curlFetch(playlist.variant, { headers: soundcloudMediaHeaders })).text(), playlist.variant);
				const first = playlist.init || playlist.segments[0];
				const res = await curlFetch(first, { headers: soundcloudMediaHeaders });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const firstBytes = new Uint8Array(await res.arrayBuffer());
				if (playlist.init && soundcloudNeedsDecoding(candidate)) {
					const piece = await curlFetch(playlist.segments[0], { headers: soundcloudMediaHeaders });
					if (!piece.ok) throw new Error(`HTTP ${piece.status}`);
					sample = { init: firstBytes, piece: new Uint8Array(await piece.arrayBuffer()) };
				}
				return `hls_${candidate.codec}, ${playlist.segments.length} pieces${playlist.init ? ", fMP4" : ""}, first piece ${firstBytes.byteLength} bytes`;
			}
			const res = await curlFetch(data.url, { headers: { ...soundcloudMediaHeaders, range: "bytes=0-65535" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return `${candidate.protocol}_${candidate.codec}, ${(await res.arrayBuffer()).byteLength} bytes`;
		});
		if (streamOk && sample) {
			await step("SoundCloud AAC decoder (FAAD2, WebAssembly)", async () => {
				const decoded = await soundcloudDecodeAac(sample.init, [sample.piece]);
				return `${decoded.frames} frames, ${decoded.sampleRate} Hz, ${decoded.channels} ch, ${decoded.blob.size} bytes of WAV`;
			});
		}
	}

	// Registry of the music services. Everything that belongs to one service sits behind this interface, so
	// that adding a service means implementing it and listing it here:
	//   id, label              the id (also the id of its search tab) and the name shown to the user
	//   tag                    prefix of its placeholders' title tag, "<tag>.<id>" ("" = the bare ID, see placeholderTitle)
	//   artist                 artist tag of its placeholders (fixed, so no song info is written to the file)
	//   idPattern              what one of its track IDs looks like (recognises a title tag, refuses bad IDs)
	//   search(query, limit)   one-off search, resolves with tracks
	//   createSearch(query)    paged search session { take(n), hasMore }
	//   fetchAudio(track, hooks), streamable   download (see getAudioJob); streamable = reports onStart / onChunk
	//   openUrl(track)         the track's page on the service
	// Optional:
	//   recommend(track)       the tracks the service itself would play next, best first (see queueRecommendation)
	//   fetchDisplay(id)       title, artist, album and cover of an ID, for when no stored track data is left
	//   fallbackThumbnail(id)  { url, letterbox } cover derived from the ID alone
	//   resizeThumbnail(url, size) / upgradeThumbnail(url)   a cover URL at another size, or null if not this service's
	//   reset(), warmUp(), diagnose(log, step)   network reset, idle-time warm-up, steps of the connection test
	const LEGACY_PROVIDER = "youtube"; // placeholders without a tag were made when YouTube was the only service
	const providers = {
		youtube: {
			id: "youtube",
			label: "YouTube Music",
			tag: "",
			artist: "YouTube",
			idPattern: /^[\w-]{11}$/,
			search: youtubeSearch,
			createSearch: createYoutubeSearch,
			recommend: youtubeRecommend,
			fetchAudio: youtubeFetchAudio,
			// fetchAudio reports onStart(mime) and onChunk(bytes) while downloading.
			streamable: true,
			openUrl: youtubeOpenUrl,
			fetchDisplay: youtubeFetchDisplay,
			fallbackThumbnail: (id) => ({ url: youtubeThumbnail(id), letterbox: true }),
			resizeThumbnail: (url, size) => (/=w\d+-h\d+/.test(url) ? resizeThumbnail(url, size) : null),
			upgradeThumbnail: youtubeUpgradeThumbnail,
			reset: youtubeReset,
			warmUp: () => getInnertube(),
			diagnose: youtubeDiagnose,
		},
		soundcloud: {
			id: "soundcloud",
			label: "SoundCloud",
			tag: "sc",
			artist: "SoundCloud",
			idPattern: /^\d{1,20}$/,
			search: soundcloudSearch,
			createSearch: createSoundcloudSearch,
			recommend: soundcloudRecommend,
			fetchAudio: soundcloudFetchAudio,
			// Reports bytes, or decoded PCM blocks for AAC (see PCM_STREAM_MIME).
			streamable: true,
			openUrl: soundcloudOpenUrl,
			fetchDisplay: soundcloudFetchDisplay,
			resizeThumbnail: soundcloudResizeThumbnail,
			diagnose: soundcloudDiagnose,
		},
	};

	// Open the track on its service in the default external browser
	function openInBrowser(track) {
		const url = providers[track.provider]?.openUrl(track);
		if (!url) return;
		// Do not check the return value: the Spotify client may return null even when the browser opened,
		// and a fallback would open a second tab
		window.open(url, "_blank", "noopener,noreferrer");
	}

	// The YouTube side of resetNetwork(): its sessions, warm-up and cookies belong to the old connection.
	function youtubeReset() {
		innertubes.plain = null;
		innertubes.player = null;
		warmUpPromise = null;
		lastPlayerUserAgent = null;
		cookieJar.clear();
	}

	function resetNetwork() {
		// A new generation: loads that are still running notice it and drop their result (see pickWispServer).
		curlGeneration++;
		const old = curlEntry;
		curlEntry = null;
		activeWisp = "";
		for (const provider of Object.values(providers)) provider.reset?.();
		// Close the old session and its Wisp socket, otherwise pooled connections keep going out through the previous
		// Wisp (the public one while playback was off), and a local Wisp would never become idle.
		old?.promise
			.then((libcurl) => {
				closeQuietly(old.session);
				// Not when the new settings still try this very Wisp: its socket is shared and may be in use already.
				const wanted = activeWispServers().some((url) => wispKey(url) === wispKey(old.url));
				if (!wanted) closeWispConnections(libcurl, { onlyUrl: old.url });
			})
			.catch(() => {});
	}

	// ---------------------------------------------------------------------
	// Playback state and track registries
	// ---------------------------------------------------------------------

	const audio = new Audio();
	audio.preload = "auto";

	// What the playback logic talks to: the audio element, or the Web Audio engine while a decoded stream is played
	// (see createPcmEngine). Both offer currentTime, paused, ended, duration, buffered, volume, muted, play() and pause().
	let player = audio;

	const state = {
		current: null, // active non-Spotify track
		status: "idle", // idle | loading | playing | paused
		progress: 0, // download progress while loading (0..1)
		placeholderUri: null, // spotify:local: URI of the placeholder Spotify is paused on while our track plays
		suppressUntil: 0, // ignore Spotify events until this timestamp
		advancingUntil: 0, // Spotify is being moved to another item: what it does meanwhile is not a new start
		holding: false, // we stopped Spotify's clock ourselves (loading, or the audio has not been downloaded that far yet)
		autoChain: false, // the active track was started on its own (Local Files context) or came from a recommendation
	};
	let playToken = 0;

	const SAVED_KEY = "synthesis-spicetify:saved";

	function loadSaved() {
		try {
			const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
			// Tracks saved before there was more than one service carry no provider: they are YouTube tracks.
			for (const track of Object.values(saved)) if (track && !track.provider) track.provider = LEGACY_PROVIDER;
			return saved;
		} catch {
			return {};
		}
	}

	const savedTracks = loadSaved(); // spotify:local: URI -> track (saved to a playlist, kept in localStorage)
	const placeholderTracks = new Map(); // spotify:local: URI -> track (made for playing or queueing, memory only)

	let savedTitleIndex = null; // placeholder title tag -> saved track, built on first use (see savedByTitle)

	function rememberSaved(uri, track) {
		savedTracks[uri] = track;
		savedTitleIndex = null;
		try {
			localStorage.setItem(SAVED_KEY, JSON.stringify(savedTracks));
		} catch (error) {
			console.warn("[Synthesis Spicetify] failed to store saved tracks", error);
		}
	}

	const displayInfo = new Map(); // placeholder title tag (see placeholderTitle) -> { title, artist, album, thumbnail, letterbox }

	// What Spotify's rows show for a track's placeholder. Without a stored cover, the service's own thumbnail for
	// the ID is used (YouTube's has black bars above and below the picture, hence "letterbox").
	function displayInfoOf(track) {
		const fallback = track.thumbnail ? null : providers[track.provider]?.fallbackThumbnail?.(track.id);
		return {
			title: track.title,
			artist: (track.artists || []).join(", "),
			album: track.album || "",
			thumbnail: track.thumbnail || fallback?.url || "",
			letterbox: Boolean(fallback?.letterbox),
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
			url: track.url, // for the services whose track page cannot be derived from the ID alone
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
		let appended = 0;
		let updates = 0;

		function fail(error) {
			// An unsupported format is expected (the player then waits for the whole download), not an error.
			(error?.streamUnsupported ? debug : debugError)("mse", "failed:", error?.name, error?.message, "|", audioStateText(audio), "| audio.error:", audio.error?.code, audio.error?.message);
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
						debug("mse", `endOfStream (${appended} appends), ${audioStateText(audio)}`);
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
				if (appended++ < 3) debug("mse", `append #${appended}: ${chunk.byteLength} bytes`);
				stalled = null;
				blocked = false;
			} catch (error) {
				if (error?.name !== "QuotaExceededError") {
					debugError("mse", `appendBuffer #${appended + 1} (${chunk.byteLength} bytes) threw`, error);
					fail(error);
					return;
				}
				debug("mse", "buffer full, waiting for playback to advance");
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
				debug("mse", `start: ${mime}, supported: ${typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime)}`);
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
						debugError("mse", "addSourceBuffer threw", error);
						fail(error);
						return;
					}
					debug("mse", `sourceopen: SourceBuffer created, mode ${buffer.mode}`);
					buffer.addEventListener("updateend", () => {
						if (updates++ < 3) debug("mse", `updateend #${updates}: ${audioStateText(audio)}`);
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

	// ---------------------------------------------------------------------
	// Decoded PCM playback (Web Audio)
	// ---------------------------------------------------------------------

	// A SoundCloud track that is only offered as AAC is decoded in this page while it downloads (see
	// soundcloudDownloadAacStreamed). Decoded audio cannot go through MediaSource, so it is scheduled on a Web Audio
	// graph instead. The engine offers the parts of an audio element that the playback logic uses, so that it can take
	// the element's place (`player`): Spotify stays the master clock and the engine follows it like the element does.

	const PCM_LOOKAHEAD_SEC = 8; // how far ahead of the playhead decoded audio is handed to the audio graph
	const PCM_TICK_MS = 200;
	const PCM_START_DELAY_SEC = 0.03; // from "start" to the first sample, so that nothing is scheduled in the past
	const PCM_RESUME_TIMEOUT_MS = 2500; // the context is held back by the autoplay policy: fall back to the whole file

	let pcmContext = null;

	// One context per sample rate, so that the decoded audio is not resampled block by block.
	function getPcmContext(sampleRate) {
		if (pcmContext && pcmContext.state !== "closed" && pcmContext.sampleRate === sampleRate) return pcmContext;
		pcmContext?.close().catch(() => {});
		pcmContext = new AudioContext({ sampleRate, latencyHint: "playback" });
		return pcmContext;
	}

	function createPcmEngine({ onEnded, onTick } = {}) {
		const blocks = []; // { start, pcm, channels }; start is counted in frames (samples per channel)
		const sources = new Set(); // the buffer sources that are scheduled or playing
		const waiters = []; // play() calls that wait for the first block
		let totalFrames = 0;
		let sampleRate = 0;
		let channels = 0;
		let context = null;
		let gain = null;
		let timer = 0;
		let complete = false; // every block has arrived
		let wantPlay = false; // play() was called and pause() was not
		let running = false; // blocks are scheduled and the clock runs
		let stalled = false; // the playhead reached the end of the data that has arrived so far
		let finished = false; // played to the end of a complete stream
		let disposed = false;
		let anchor = 0; // the context time that track time 0 would have
		let basePosition = 0; // track time while the clock does not run
		let nextBlock = 0; // the next block to hand to the audio graph
		let volume = 1;
		let muted = false;

		const decodedEnd = () => (sampleRate ? totalFrames / sampleRate : 0);
		const applyGain = () => {
			if (gain) gain.gain.value = muted ? 0 : volume;
		};

		function position() {
			if (!running) return basePosition;
			return Math.max(basePosition, Math.min(context.currentTime - anchor, decodedEnd()));
		}

		function stopSources() {
			for (const source of sources) {
				source.onended = null;
				try {
					source.stop();
				} catch {
					// it has ended already
				}
				source.disconnect();
			}
			sources.clear();
		}

		// The index of the block that holds this frame.
		function blockIndexAt(frame) {
			let low = 0;
			let high = blocks.length - 1;
			while (low < high) {
				const middle = (low + high + 1) >> 1;
				if (blocks[middle].start <= frame) low = middle;
				else high = middle - 1;
			}
			return low;
		}

		function toAudioBuffer(block) {
			const frames = block.pcm.length / block.channels;
			const buffer = context.createBuffer(block.channels, frames, sampleRate);
			for (let c = 0; c < block.channels; c++) {
				const data = buffer.getChannelData(c);
				for (let i = 0, j = c; i < frames; i++, j += block.channels) data[i] = block.pcm[j] / 32768;
			}
			return buffer;
		}

		function schedule(index, when, offset) {
			const source = context.createBufferSource();
			source.buffer = toAudioBuffer(blocks[index]);
			source.connect(gain);
			source.onended = () => {
				sources.delete(source);
				source.disconnect();
				pump(); // events are not throttled like timers are while the window is in the background
			};
			sources.add(source);
			source.start(when, offset);
		}

		// Hands the blocks that are due within the look-ahead to the audio graph.
		function pump() {
			if (!running || disposed) return;
			const now = context.currentTime;
			while (nextBlock < blocks.length) {
				const when = anchor + blocks[nextBlock].start / sampleRate;
				if (when > now + PCM_LOOKAHEAD_SEC) break;
				if (when < now - 0.05) {
					// The page was too busy to hand the block over in time: start again from where the playhead is.
					startAt(Math.min(now - anchor, decodedEnd()));
					return;
				}
				schedule(nextBlock, Math.max(when, now), 0);
				nextBlock++;
			}
		}

		function done() {
			stopSources();
			running = false;
			stalled = false;
			wantPlay = false;
			finished = true;
			basePosition = decodedEnd();
			onEnded?.();
		}

		// Starts the clock at a track time (stops whatever was scheduled).
		function startAt(seconds) {
			stopSources();
			running = false;
			stalled = false;
			finished = false;
			const end = decodedEnd();
			basePosition = Math.min(Math.max(seconds, 0), end);
			if (!blocks.length) return;
			if (basePosition >= end - 0.005) {
				if (complete) done();
				else stalled = true; // wait for the next block
				return;
			}
			const index = blockIndexAt(Math.floor(basePosition * sampleRate));
			const when = context.currentTime + PCM_START_DELAY_SEC;
			anchor = when - basePosition;
			schedule(index, when, basePosition - blocks[index].start / sampleRate);
			nextBlock = index + 1;
			running = true;
			pump();
		}

		function tick() {
			if (disposed) return;
			if (running) {
				if (context.currentTime - anchor >= decodedEnd() - 0.005 && nextBlock >= blocks.length) {
					if (complete) {
						done();
					} else {
						// The decoder has not kept up: wait where the data ends.
						stopSources();
						running = false;
						stalled = true;
						basePosition = decodedEnd();
					}
				} else {
					pump();
				}
			}
			onTick?.();
		}

		function init(block) {
			try {
				context = getPcmContext(block.sampleRate);
				gain = context.createGain();
				gain.connect(context.destination);
			} catch (error) {
				error.streamUnsupported = true; // the caller waits for the whole file instead
				throw error;
			}
			sampleRate = block.sampleRate;
			channels = block.channels;
			applyGain();
			timer = setInterval(tick, PCM_TICK_MS);
			for (const waiter of waiters.splice(0)) waiter.resolve();
		}

		async function resumeContext() {
			if (context.state === "running") return;
			const unsupported = () => {
				const error = new Error("the audio context did not start");
				error.streamUnsupported = true;
				return error;
			};
			let timeout = 0;
			try {
				await Promise.race([
					context.resume(),
					new Promise((resolve, reject) => {
						timeout = setTimeout(() => reject(unsupported()), PCM_RESUME_TIMEOUT_MS);
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}
			if (context.state !== "running") throw unsupported();
		}

		// Resolves once there is audio and the context runs.
		async function play() {
			if (disposed) throw abortError();
			wantPlay = true;
			if (finished) {
				finished = false;
				basePosition = 0; // like an audio element that has ended
			}
			if (!context) await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
			await resumeContext();
			if (disposed) throw abortError();
			if (wantPlay && !running) startAt(basePosition);
		}

		function pause() {
			wantPlay = false;
			if (running) {
				basePosition = position();
				stopSources();
				running = false;
			}
			stalled = false;
		}

		function seek(seconds) {
			finished = false;
			const target = Number.isFinite(seconds) ? seconds : 0;
			if (wantPlay) startAt(target);
			else basePosition = Math.min(Math.max(target, 0), decodedEnd());
		}

		function addBlock(block) {
			if (disposed) return;
			if (!context) init(block);
			else if (block.sampleRate !== sampleRate || block.channels !== channels) throw new Error("the decoded stream changes its format");
			blocks.push({ start: totalFrames, pcm: block.pcm, channels });
			totalFrames += block.pcm.length / channels;
			if (wantPlay && !running) startAt(basePosition);
			else pump();
		}

		function end() {
			complete = true;
			if (stalled && wantPlay && basePosition >= decodedEnd() - 0.005) done();
		}

		function dispose() {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			stopSources();
			try {
				gain?.disconnect();
			} catch {
				// already disconnected
			}
			running = false;
			wantPlay = false;
			for (const waiter of waiters.splice(0)) waiter.reject(abortError());
		}

		return {
			get currentTime() {
				return position();
			},
			set currentTime(seconds) {
				seek(seconds);
			},
			get paused() {
				return !wantPlay;
			},
			get ended() {
				return finished;
			},
			// Only known once everything has been decoded (the callers then use the length of the track).
			get duration() {
				return complete ? decodedEnd() : NaN;
			},
			// One range: everything that has been decoded so far.
			get buffered() {
				const decoded = decodedEnd();
				return { length: decoded > 0 ? 1 : 0, start: () => 0, end: () => decoded };
			},
			get volume() {
				return volume;
			},
			set volume(value) {
				volume = value;
				applyGain();
			},
			get muted() {
				return muted;
			},
			set muted(value) {
				muted = Boolean(value);
				applyGain();
			},
			play,
			pause,
			addBlock,
			end,
			dispose,
			isComplete: () => complete,
		};
	}

	// The sink of a decoded stream: hands the PCM blocks to a PCM engine, which then is the `player`.
	function createPcmSink({ onAttached, onError }) {
		let engine = null;
		let dead = false;

		function fail(error) {
			(error?.streamUnsupported ? debug : debugError)("pcm", "failed:", error?.name, error?.message);
			dead = true;
			onError(error);
		}

		return {
			start() {
				if (dead || engine) return;
				if (typeof AudioContext === "undefined") {
					const error = new Error("Web Audio is not available");
					error.streamUnsupported = true;
					fail(error);
					return;
				}
				engine = createPcmEngine({ onEnded: handlePlayerEnded, onTick: () => updatePositionState(false) });
				player = engine;
				debug("pcm", "start: decoded audio is played through Web Audio");
				onAttached();
			},
			append(block) {
				if (dead || !engine) return;
				try {
					engine.addBlock(block);
				} catch (error) {
					fail(error);
				}
			},
			end() {
				if (!dead) engine?.end();
			},
			poke() {},
			isBlocked: () => false,
			isComplete: () => Boolean(engine?.isComplete()),
			dispose() {
				dead = true;
				engine?.dispose();
			},
		};
	}

	// Picks the sink for what the download reports: PCM blocks go to the engine, bytes go to a MediaSource.
	function createStreamSink(options) {
		let impl = null;
		return {
			start(mime) {
				if (impl) return;
				impl = mime === PCM_STREAM_MIME ? createPcmSink(options) : createMseSink(options);
				impl.start(mime);
			},
			append: (chunk) => impl?.append(chunk),
			end: () => impl?.end(),
			poke: () => impl?.poke(),
			isBlocked: () => Boolean(impl?.isBlocked()),
			isComplete: () => Boolean(impl?.isComplete()),
			dispose: () => impl?.dispose(),
		};
	}

	// Plays a track while it is still downloading. Resolves once playback has started. Rejects with an
	// error whose streamUnsupported flag is set when the caller should fall back to a full download.
	function streamTrack(track, token, onProgress) {
		return new Promise((resolve, reject) => {
			const job = getAudioJob(track);
			if (onProgress) job.listeners.add(onProgress);

			let settled = false;
			const watchdog = setTimeout(() => {
				if (!settled) debugError("stream", `no playback 10 s after the start: ${audioStateText(audio)}, paused ${audio.paused}`);
			}, 10000);
			const settle = (fn, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(watchdog);
				fn(value);
			};

			const sink = createStreamSink({
				expectedSec: (track.durationMs ?? 0) / 1000,
				onAttached: () => {
					syncVolume();
					// Resolves as soon as enough data is buffered to start, not when the download is done.
					debug("stream", "play() called");
					player.play().then(
						() => {
							debug("stream", `play() resolved: ${audioStateText(player)}`);
							settle(resolve);
						},
						(error) => {
							(error?.streamUnsupported ? debug : debugError)("stream", "play() rejected:", error?.name, error?.message);
							settle(reject, error);
						}
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
		player = audio; // the PCM engine, if there was one, is gone with its sink
		cancel();
	}

	// Replaces the stream by the finished download, keeping the position and the play state.
	function switchToBlob(track, token, position = player.currentTime) {
		const url = peekAudioUrl(track);
		if (!url || token !== playToken) return false;
		const wasPlaying = !player.paused;
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
			const ranges = player.buffered;
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
		player.currentTime = seconds;
	}

	function trackDurationSec() {
		return Number.isFinite(player.duration) ? player.duration : (state.current?.durationMs ?? 0) / 1000;
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

	// Called on every state change (from syncPlayerUi). Metadata is only replaced when the track changes.
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

	// How many tracks in a row may fail before we stop skipping to the next one.
	const MAX_CONSECUTIVE_FAILURES = 2;
	let consecutiveFailures = 0;

	// Streams the real track. Only called once Spotify has started a placeholder (see startFromPlaceholder), and
	// Spotify has already been paused on it by then.
	async function playTrack(track) {
		const token = ++playToken;
		const previous = state.current;
		// A download that is still running (also while it is streamed) is dropped when another track takes over.
		if (previous && (state.status === "loading" || trackKey(previous) !== trackKey(track))) abortLoad(previous);

		detachStream();
		audio.pause();
		state.current = track;
		state.status = "loading";
		state.progress = 0;
		syncPlayerUi();

		try {
			// The progress is only shown while loading; after playback has started it is no longer needed.
			const onProgress = (p) => {
				if (token !== playToken || state.status !== "loading") return;
				state.progress = p;
				syncPlayerUi();
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
			consecutiveFailures = 0;
			releaseClock();
			syncPlayerUi();
			prefetchNext();
			prepareRecommendation(track);
		} catch (error) {
			if (token !== playToken || error?.name === "AbortError") return;
			console.error("[Synthesis Spicetify] playback failed", error);
			notify(t("playFailed", error?.message || error), true);
			// Skipping ahead only makes sense while failures are isolated. When several tracks in a row fail the
			// cause is the connection (e.g. LOGIN_REQUIRED), so stop instead of looping through the queue.
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				consecutiveFailures = 0;
				closeTrack();
				return;
			}
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
		syncPlayerUi();
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
		const ranges = player.buffered;
		for (let i = 0; i < ranges.length; i++) {
			if (seconds < ranges.start(i) - 0.05) continue;
			if (ranges.end(i) >= seconds + RESUME_MARGIN || ranges.end(i) >= duration - 0.1) return true;
		}
		return false;
	}

	// Stops Spotify's clock until the audio has caught up (the data behind a seek has not arrived yet).
	function holdClock() {
		state.holding = true;
		player.pause();
		state.suppressUntil = Date.now() + 500; // our own pause must not look like a user action
		Spicetify.Player.pause();
	}

	// The track has loaded while Spotify was held on its placeholder: bring Spotify's clock to the audio and
	// let it run. The audio keeps following it from here on.
	function releaseClock() {
		if (!state.holding) return;
		state.holding = false;
		const at = player.currentTime;
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
			if (!player.paused) player.pause();
			if (state.status !== "paused") {
				state.status = "paused";
				syncPlayerUi();
			}
			return;
		}

		// Spotify runs. After the audio has ended, Spotify may still be inside the last seconds of its placeholder.
		const tail = player.ended && position >= player.currentTime - 2;
		if (!tail && Math.abs(player.currentTime - position) > SYNC_TOLERANCE) {
			if (!audioCanPlayAt(position)) {
				holdClock();
				return;
			}
			seekAudio(position);
		}
		if (player.paused && !tail) player.play().catch(() => {});
		if (state.status !== "playing") {
			state.status = "playing";
			syncPlayerUi();
		}
	}
	setInterval(syncSlave, 250);

	function requirePlayback(track) {
		if (config.playbackEnabled) return true;
		if (track && trialKey && trackKey(track) === trialKey) return true;
		notify(t("playbackDisabled"), true);
		return false;
	}

	// ---- Recommendations: what plays after a track that was started on its own ----
	// A track started from the search page runs in Spotify's Local Files context, so when its placeholder ends
	// Spotify would move on to the next local file. Instead the service's own recommendation is put in front
	// of Spotify's queue shortly before the end, and Spotify plays that placeholder next. The same goes for
	// the recommendation itself, so the chain goes on until the user plays or queues something else.
	const RECOMMEND_LEAD_SECONDS = 20; // how long before the end the recommendation is queued
	const RECOMMEND_WAIT_MS = 4000; // how long the end of a track waits for a recommendation that is not ready yet
	const RECENT_LIMIT = 100;
	const recentKeys = []; // keys of the tracks played or recommended lately, so that a chain does not loop
	let recommendation = null; // { key, promise } the lookup for the active track, resolves with { track, uri }
	let queueJob = null; // { key, promise } putting that recommendation into Spotify's queue
	let pendingAuto = null; // placeholder URI of a recommendation that sits in Spotify's queue
	let localStartUri = null; // placeholder that was just started in the Local Files context

	// The same song as a video and as an audio track has two IDs, so the title and first artist count too.
	function recentKeysOf(track) {
		const artist = normalizeText(track.artists?.[0]);
		return [trackKey(track), artist ? `${normalizeText(track.title)}|${artist}` : null].filter(Boolean);
	}

	function rememberRecent(track) {
		for (const key of recentKeysOf(track)) if (!recentKeys.includes(key)) recentKeys.push(key);
		while (recentKeys.length > RECENT_LIMIT) recentKeys.shift();
	}

	// Looks up the recommendation of the track that has just started and makes its placeholder, so that it
	// is ready by the time it is needed.
	function prepareRecommendation(track) {
		recommendation = null;
		queueJob = null;
		rememberRecent(track);
		const provider = providers[track.provider];
		if (!config.autoRecommend || !provider?.recommend) return;
		const promise = (async () => {
			const candidates = await provider.recommend(track);
			const next = candidates.find((candidate) => !recentKeysOf(candidate).some((key) => recentKeys.includes(key)));
			if (!next) throw new Error("no recommendation that was not played lately");
			return { track: next, uri: await ensurePlaceholder(next) };
		})();
		promise.catch((error) => console.warn("[Synthesis Spicetify] recommendation failed", error));
		recommendation = { key: trackKey(track), promise };
	}

	function inLocalFilesContext() {
		const data = Spicetify.Player.data;
		return /local-files/i.test(data?.context?.uri ?? data?.context_uri ?? data?.contextUri ?? "");
	}

	// URIs the user queued. Our own recommendation does not count.
	function userQueueUris() {
		const upcoming = Spicetify.Queue?.nextTracks;
		if (!Array.isArray(upcoming)) return [];
		return upcoming
			.filter((entry) => entry?.provider === "queue")
			.map((entry) => entry.contextTrack?.uri ?? entry.uri)
			.filter((uri) => uri && uri !== pendingAuto);
	}

	function userQueueHasItems() {
		return userQueueUris().length > 0;
	}

	// What the user had queued a moment ago. Spotify's queue has already moved on when songchange fires, so a
	// jump to one of these is the user's own queue, not a skip into the Local Files context.
	let userQueueSnapshot = new Set();
	setInterval(() => {
		userQueueSnapshot = new Set(userQueueUris());
	}, 1000);

	async function runQueueRecommendation(key) {
		if (!config.autoRecommend || !recommendation || recommendation.key !== key) return "skip";
		if (!(state.autoChain || inLocalFilesContext())) return "skip"; // a playlist, an album or a queue decides what follows
		if (Spicetify.Player.getRepeat?.() > 0) return "skip"; // repeat is on
		if (userQueueHasItems()) return "skip";
		try {
			const result = await Promise.race([recommendation.promise, sleep(RECOMMEND_WAIT_MS).then(() => null)]);
			if (!result) throw new Error("the recommendation was not ready in time");
			if (!state.current || trackKey(state.current) !== key) return "skip"; // another track took over meanwhile
			await queuePlaceholder(result.uri, true);
			pendingAuto = result.uri;
			rememberRecent(result.track);
			debug("recommend", `queued ${trackKey(result.track)} "${result.track.title}" after ${key}`);
			return "queued";
		} catch (error) {
			console.warn("[Synthesis Spicetify] could not queue the recommendation", error);
			return "failed";
		}
	}

	// Puts the recommendation of the active track in front of Spotify's queue, once per track.
	// Resolves with "queued", "skip" (Spotify decides what follows) or "failed".
	function queueRecommendation() {
		const key = state.current && trackKey(state.current);
		if (!key) return Promise.resolve("skip");
		if (queueJob?.key !== key) queueJob = { key, promise: runQueueRecommendation(key) };
		return queueJob.promise;
	}

	// Shortly before the end of a track the recommendation goes into Spotify's queue. Doing it this early leaves
	// time for the queue API, which is slower than the last second of the placeholder.
	setInterval(() => {
		if (state.status !== "playing" || !state.current || state.holding) return;
		if (queueJob?.key === trackKey(state.current)) return;
		const remaining = trackDurationSec() - spotifyPosition();
		if (remaining > 0 && remaining <= RECOMMEND_LEAD_SECONDS) queueRecommendation();
	}, 1000);

	// ---- Skipping (Spotify's own next button, media keys) ----
	// Spotify moves to the next local file on its own, and songchange tells us afterwards. So when our active track
	// is left for another placeholder that nobody queued, that placeholder is stopped and the recommendation is
	// played instead.
	function isSkipIntoLocalFiles(prev, now) {
		if (!config.autoRecommend || state.status === "idle" || !state.current || prev.uri !== state.placeholderUri) return false;
		if (!recommendation || recommendation.key !== trackKey(state.current)) return false;
		if (!(state.autoChain || inLocalFilesContext())) return false;
		if (Spicetify.Player.getRepeat?.() > 0) return false;
		return now.uri !== pendingAuto && !userQueueSnapshot.has(now.uri);
	}

	// True when Spotify went back to the track that was playing before (the previous button), not forward.
	function movedBackTo(prevUri) {
		const next = Spicetify.Queue?.nextTracks?.[0];
		return (next?.contextTrack?.uri ?? next?.uri) === prevUri;
	}

	async function redirectSkipToRecommendation(prev) {
		const job = recommendation;
		const token = playToken;
		// The next local file is a silent placeholder: keep it from running while this is sorted out.
		state.suppressUntil = Date.now() + 500;
		state.advancingUntil = Date.now() + RECOMMEND_WAIT_MS + 2500;
		Spicetify.Player.pause();
		await sleep(250); // Spotify's queue needs a moment to show which way it moved
		if (token !== playToken) return;
		if (movedBackTo(prev.uri)) {
			// The previous button: nothing to redirect, play what Spotify went back to.
			state.advancingUntil = 0;
			startFromPlaceholder();
			return;
		}
		let result = null;
		try {
			result = await Promise.race([job.promise, sleep(RECOMMEND_WAIT_MS).then(() => null)]);
		} catch {
			// reported by prepareRecommendation
		}
		if (token !== playToken) return;
		state.advancingUntil = 0;
		state.suppressUntil = 0; // the songchange of the recommendation must not be ignored
		stopTrack(false);
		if (!result) {
			notify(t("recommendFailed"), true); // Spotify stays paused on the local file
			return;
		}
		rememberRecent(result.track);
		debug("recommend", `skip: playing ${trackKey(result.track)} "${result.track.title}" instead of ${prev.uri}`);
		try {
			await playPlaceholder(result.uri, placeholderTitle(result.track));
		} catch (error) {
			reportPlaceholderError(error);
		}
	}

	// The player (the audio element or the PCM engine) has played to the end.
	async function handlePlayerEnded() {
		if (state.status === "idle" || state.holding || readSpotify().uri !== state.placeholderUri) return;
		const token = playToken;
		const outcome = await queueRecommendation();
		if (token !== playToken || state.status === "idle") return; // another track took over while waiting
		if (outcome === "failed") {
			// Letting Spotify move on would play an arbitrary local file, so stop here instead.
			notify(t("recommendFailed"), true);
			closeTrack();
			return;
		}
		// Let Spotify run out its placeholder by itself, so that repeat and shuffle apply as usual.
		const duration = Spicetify.Player.getDuration();
		if (duration - spotifyPosition() * 1000 > 300) seekSpotify((duration - 150) / 1000);
	}

	// Audio element events
	audio.addEventListener("ended", handlePlayerEnded);
	for (const name of ["loadedmetadata", "canplay", "playing", "waiting", "stalled", "emptied", "abort"]) {
		audio.addEventListener(name, () => {
			if (audio.getAttribute("src")) debug("audio", `${name}: ${audioStateText(audio)}`);
		});
	}
	audio.addEventListener("error", () => {
		if (!audio.getAttribute("src")) return;
		// MediaError codes: 1 aborted, 2 network, 3 decode, 4 source not supported
		debugError("audio", `error: code ${audio.error?.code}, message "${audio.error?.message}", ${audioStateText(audio)}`);
		notify(t("playFailed", audio.error?.message || "media error"), true);
		stopTrack(true);
	});
	audio.addEventListener("timeupdate", () => {
		activeStream?.sink.poke();
		updatePositionState(false);
	});

	// Keep the volume in sync with Spotify's volume slider.
	function syncVolume() {
		try {
			const volume = Math.min(1, Math.max(0, Spicetify.Player.getVolume()));
			const muted = Spicetify.Player.getMute();
			audio.volume = volume;
			audio.muted = muted;
			if (player !== audio) {
				player.volume = volume;
				player.muted = muted;
			}
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

	// The title tag of a placeholder. Only the video ID is written, which is unique per video, so the
	// playlist row does not reveal the song and the real track can be found again from the ID alone.
	const placeholderArtist = (track) => providers[track.provider].artist;

	// The title tag of a placeholder: the track ID, with the service's tag in front of it ("sc.123") unless the
	// service has none. YouTube has none, so its placeholders keep the bare video ID they always had.
	function placeholderTitle(track) {
		const { tag } = providers[track.provider];
		return tag ? `${tag}.${track.id}` : track.id;
	}

	// Reads a title tag back into { provider, id }, or null when the text is not a placeholder title. A text
	// without a tag belongs to the legacy service (a tag never fits an ID pattern, nor the other way round).
	function parsePlaceholderTitle(text) {
		const value = String(text ?? "").trim();
		if (!value || value.length > 80) return null;
		const dot = value.indexOf(".");
		const tagged = dot > 0 ? Object.values(providers).find((p) => p.tag && p.tag === value.slice(0, dot)) : null;
		const provider = tagged ?? providers[LEGACY_PROVIDER];
		const id = tagged ? value.slice(dot + 1) : value;
		return provider.idPattern.test(id) ? { provider, id } : null;
	}

	const HANDLE_DB = "synthesis-spicetify";

	// Builds a silent MP3 (MPEG-2 Layer III, 24 kHz, mono, 16 kbps) with ID3v2.3 tags. The first frame is an
	// Info header that carries the frame count, so the length is exact; TLEN repeats it for tag readers.
	function makeSilentMp3({ artist, album, title, seconds }) {
		const FRAME = 48; // 72 * 16000 / 24000 bytes, 576 samples = 24 ms per frame
		const CHUNK_FRAMES = 20000; // about 1 MB
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
		// The first frame carries the Xing/Info header, all the others are silent (a frame header and zeros).
		// Frame header: MPEG-2 Layer III, no CRC, bitrate index 2 (16 kbps), 24 kHz, mono.
		// The bitrate index must match FRAME, otherwise decoders reject the file as unplayable.
		const silent = (count) => {
			const bytes = new Uint8Array(FRAME * count);
			for (let f = 0; f < count; f++) bytes.set([0xff, 0xf3, 0x24, 0xc0], f * FRAME);
			return bytes;
		};
		const first = silent(1);
		first.set([0x49, 0x6e, 0x66, 0x6f], 13); // "Info"
		new DataView(first.buffer).setUint32(17, 1); // flags: frame count present
		new DataView(first.buffer).setUint32(21, frames);
		// A track of several hours is tens of megabytes, so the file is assembled as a Blob from one shared chunk
		// instead of one huge array (plus a copy of it).
		const blobParts = [header, ...parts, first];
		let left = frames;
		if (left >= CHUNK_FRAMES) {
			const chunk = silent(CHUNK_FRAMES);
			while (left >= CHUNK_FRAMES) {
				blobParts.push(chunk);
				left -= CHUNK_FRAMES;
			}
		}
		if (left > 0) blobParts.push(silent(left));
		return new Blob(blobParts, { type: "audio/mpeg" });
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

	// Two different tracks can share artist, title and length. They must not share a URI, so the length
	// moves up by a second until the URI is free (or already belongs to the same track).
	function pickLocalUri(track, seconds) {
		for (let i = 0; i < 30; i++, seconds++) {
			const uri = localUri(placeholderArtist(track), PLACEHOLDER_ALBUM, placeholderTitle(track), seconds);
			const owner = savedTracks[uri];
			if (!owner || trackKey(owner) === trackKey(track)) return { uri, seconds };
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

	// A track that already has a placeholder keeps its length, so that it keeps its URI even when a later
	// search reports a slightly different duration.
	function knownSeconds(track) {
		const wanted = trackKey(track);
		let uri = null;
		for (const [key, other] of placeholderTracks) if (trackKey(other) === wanted) uri = key;
		uri ??= Object.keys(savedTracks).find((key) => trackKey(savedTracks[key]) === wanted) ?? null;
		const seconds = uri ? Number(uri.split(":").pop()) : NaN;
		return seconds > 0 ? seconds : null;
	}

	// ---- Placeholder registry: making a placeholder for a track, and saving it to a playlist ----

	const placeholderJobs = new Map(); // track key -> promise of a placeholder that is being made

	async function makePlaceholder(track, busyText) {
		const title = placeholderTitle(track);
		const artist = placeholderArtist(track);
		const base = Math.max(1, Math.round((track.durationMs || 180000) / 1000));
		const { uri: expected, seconds } = pickLocalUri(track, knownSeconds(track) ?? base);

		// A placeholder that Spotify already lists is reused as it is. No file access is needed then.
		let uri = await findIndexedUri(expected);
		if (!uri) {
			if (busyText) notify(busyText);
			const dir = await getPlaceholderDir();
			// The file name does not matter to Spotify (the URI comes from the tags). Including the length
			// keeps two placeholders of the same video, if there ever are two, in separate files.
			const handle = await dir.getFileHandle(`${title}-${seconds}.mp3`, { create: true });
			const writable = await handle.createWritable();
			await writable.write(makeSilentMp3({ artist, album: PLACEHOLDER_ALBUM, title, seconds }));
			await writable.close();
			uri = await waitForLocalUri(expected, { artist, title, seconds });
			if (!uri) throw new Error(t("saveNotIndexed"));
		}

		placeholderTracks.set(uri, snapshotTrack(track));
		// Spotify's rows for the placeholder can show the real text and cover art right away.
		displayInfo.set(title, displayInfoOf(track));
		return uri;
	}

	// Returns the spotify:local: URI of the track's placeholder, making the file when needed. Call it from a
	// click handler without awaiting anything first: the folder dialog needs the click's user gesture.
	function ensurePlaceholder(track, busyText) {
		if (!providers[track.provider]?.idPattern.test(track.id)) return Promise.reject(new Error(t("badTrackId")));
		const key = trackKey(track);
		let job = placeholderJobs.get(key);
		if (!job) {
			job = makePlaceholder(track, busyText).finally(() => placeholderJobs.delete(key));
			placeholderJobs.set(key, job);
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
	// the local files index, so the tags (the title tag, album "Synthesis") count as well.
	async function waitForSpotifyItem(uri, title, timeoutMs) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const item = Spicetify.Player.data?.item;
			if (item?.uri === uri) return true;
			if (item?.uri?.startsWith("spotify:local:") && item.name === title && item.album?.name === PLACEHOLDER_ALBUM) return true;
			await sleep(100);
		}
		return false;
	}

	const LOCAL_FILES_CONTEXT = "spotify:local-files"; // the playback context Spotify uses for local files

	// Plays a placeholder in Spotify's own player. The songchange handler then takes over and streams the
	// real track (see startFromPlaceholder).
	async function playPlaceholder(uri, title) {
		// A local file can only be played inside the Local Files context, so start that context at the placeholder.
		localStartUri = uri; // startFromPlaceholder reads this: such a track is followed by a recommendation
		for (const attempt of [
			() => Spicetify.Player.playUri(LOCAL_FILES_CONTEXT, {}, { skipTo: { uri } }),
			() => {
				localStartUri = null;
				return Spicetify.Player.playUri(uri);
			},
		]) {
			try {
				await attempt();
			} catch (error) {
				console.warn("[Synthesis Spicetify] could not start the placeholder", error);
			}
			if (await waitForSpotifyItem(uri, title, 2000)) return;
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
		if (await waitForSpotifyItem(uri, title, 2000)) return;
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
			await playPlaceholder(uri, placeholderTitle(track));
		} catch (error) {
			trialKey = null;
			reportPlaceholderError(error);
		}
	}

	// Explicit one-off attempt while the playback switch is off. Only this click unlocks this one track.
	function tryPlay(track) {
		if (config.playbackEnabled) return playNow(track);
		trialKey = trackKey(track);
		return playNow(track);
	}

	async function addToQueue(track, { next = false } = {}) {
		if (!requirePlayback()) return;
		try {
			const uri = await ensurePlaceholder(track, t("preparing"));
			// Nothing is playing at all: there is no queue to add to, so start right away.
			if (!readSpotify().uri && state.status === "idle") {
				await playPlaceholder(uri, placeholderTitle(track));
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
		let track = savedTracks[uri] ?? placeholderTracks.get(uri);
		// No stored mapping (for example the extension data was cleared): the title tag names the service and
		// the ID, and playback only needs those.
		const parsed = track ? null : parsePlaceholderTitle(item.name);
		const known = track ?? (parsed && { provider: parsed.provider.id, id: parsed.id });
		if (!requirePlayback(known)) return;
		if (known && !providers[known.provider]) {
			notify(t("playFailed", known.provider), true);
			return;
		}

		if (!track) {
			// Display details are missing, so the ID stands in for the title.
			if (parsed) {
				const info = displayInfo.get(item.name.trim());
				track = {
					provider: parsed.provider.id,
					id: parsed.id,
					title: info?.title || parsed.id,
					artists: info?.artist ? [info.artist] : [],
					album: "",
					durationMs: item.duration?.milliseconds ?? 0,
					thumbnail: info?.thumbnail || "",
				};
			} else {
				// A placeholder made by an older version: its tags hold the artist and title, so search by them
				// (a version that old only knew the legacy service).
				const query = [item.artists?.[0]?.name, item.name].filter(Boolean).join(" ");
				try {
					track = (await providers[LEGACY_PROVIDER].search(query, 1))[0];
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
		// Started on its own in the Local Files context, or it is the recommendation that was queued: either way a
		// recommendation follows. A track that comes from a playlist or from the user's queue keeps that order.
		state.autoChain = uri === localStartUri || uri === pendingAuto;
		if (uri === localStartUri) localStartUri = null;
		if (uri === pendingAuto) pendingAuto = null;
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
			if (isSkipIntoLocalFiles(prev, now)) redirectSkipToRecommendation(prev);
			else startFromPlaceholder();
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
	// The placeholder file only carries the track ID as its title (with the service's tag in front of it, see
	// placeholderTitle) and a fixed artist / album, so Spotify's own rows (playlists, queue, player bar) would
	// show "dQw4w9WgXcQ / YouTube / Synthesis". Only the DOM text is rewritten here: nothing is written to the
	// file or to Spotify's data, and the real values live in memory.

	const displayFetchedAt = new Map(); // title tag -> time of the last lookup, so a failure is retried only rarely

	function savedByTitle(title) {
		if (!savedTitleIndex) {
			savedTitleIndex = new Map();
			for (const track of Object.values(savedTracks)) {
				if (!providers[track.provider]) continue;
				const tag = placeholderTitle(track);
				if (!savedTitleIndex.has(tag)) savedTitleIndex.set(tag, track);
			}
		}
		return savedTitleIndex.get(title) ?? null;
	}

	// Display details of a placeholder's title tag, or null while they are still being looked up.
	function lookupDisplay(title) {
		const known = displayInfo.get(title);
		if (known) return known;
		const saved = savedByTitle(title);
		if (saved?.title) {
			const info = displayInfoOf(saved);
			displayInfo.set(title, info);
			return info;
		}
		fetchDisplay(title);
		return null;
	}

	// No stored mapping (for example the extension data was cleared): ask the service about the ID, if it can say.
	async function fetchDisplay(title) {
		const parsed = parsePlaceholderTitle(title);
		if (!parsed?.provider.fetchDisplay) return;
		if (Date.now() - (displayFetchedAt.get(title) || 0) < 60000) return;
		displayFetchedAt.set(title, Date.now());
		try {
			const info = await parsed.provider.fetchDisplay(parsed.id);
			if (!info?.title) return;
			displayInfo.set(title, info);
			scheduleDisplayRewrite(true);
		} catch (error) {
			console.warn("[Synthesis Spicetify] display lookup failed", title, error);
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

	// Number of placeholder title tags in scope, not counting `except` (the title being handled, which may
	// already have been rewritten when this runs again for a retry).
	function countIdNodes(scope, except) {
		const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
		let count = 0;
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			if (node !== except && parsePlaceholderTitle(node.nodeValue)) count++;
		}
		return count;
	}

	// The element that holds exactly one track: a tracklist row, or else (queue, player bar) the nearest
	// ancestor that has the service's fixed artist next to this title and no other title tag, so that a list
	// containing several rows is never mistaken for one track.
	function findTrackScope(owner, titleNode, artist) {
		const row = owner.closest('[data-testid="tracklist-row"], [role="row"]');
		if (row) return findTextNode(row, artist) ? row : null;
		let scope = owner;
		for (let depth = 0; depth < 6 && scope; depth++, scope = scope.parentElement) {
			if (!findTextNode(scope, artist)) continue;
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

	// URL of the stored cover at about the size it is shown at (for the services whose cover URLs take a size).
	function sizedThumbnail(url, cssSize) {
		const wanted = Math.max(226, Math.min(1200, Math.ceil((cssSize * (window.devicePixelRatio || 1)) / 64) * 64));
		for (const provider of Object.values(providers)) {
			const resized = provider.resizeThumbnail?.(url, wanted);
			if (resized) return resized;
		}
		return url;
	}

	// A plain thumbnail can be a small picture with black bars (YouTube's is). For a big cover, swap in the
	// full-size frame when the service has one (it has no bars, so the crop that hides them is dropped as well).
	function upgradeLetterboxThumbnail(art, img, url) {
		let better = null;
		for (const provider of Object.values(providers)) {
			better = provider.upgradeThumbnail?.(url) ?? null;
			if (better) break;
		}
		if (!better) return;
		const probe = new Image();
		probe.onload = () => {
			// A missing full-size frame comes back as a tiny placeholder picture.
			if (probe.naturalWidth < 640 || !art.isConnected) return;
			art.classList.remove("ss-letterbox");
			loadImage(img, better);
		};
		probe.src = better;
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
		if (info.letterbox && size * (window.devicePixelRatio || 1) > 240) upgradeLetterboxThumbnail(art, img, info.thumbnail);
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

	// If this text node is a placeholder's title (a title tag next to the service's fixed artist), swap in the
	// real text. Only nodeValue is changed, so React keeps owning the node and simply overwrites it when the row
	// is reused.
	function rewriteTextNode(node) {
		const title = node.nodeValue?.trim();
		const parsed = title && parsePlaceholderTitle(title);
		if (!parsed) return;
		const owner = node.parentElement;
		if (!owner || isOwnUi(owner)) return;

		const scope = findTrackScope(owner, node, parsed.provider.artist);
		if (!scope) return;
		const artistNode = findTextNode(scope, parsed.provider.artist);
		if (!artistNode) return;

		const info = lookupDisplay(title);
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

	// Called on every state change: keeps the Media Session and Spotify's player bar in sync with the active track.
	function syncPlayerUi() {
		syncMediaSession();
		syncTakeover();
	}

	// ---------------------------------------------------------------------
	// Player bar takeover
	// While a non-Spotify track is active, Spotify's own player bar shows and controls it:
	// the now playing widget, the progress bar and the play/pause, previous and next buttons.
	// Spotify's React nodes are never modified: our elements are appended next to them and
	// the originals are only hidden with CSS, so a re-render of Spotify cannot break anything.
	// ---------------------------------------------------------------------

	const PLAYBAR = {
		// "-v2" is what current Spotify builds use; the plain name is kept for older builds.
		widget: '[data-testid="now-playing-widget-v2"], [data-testid="now-playing-widget"]',
	};

	const takeover = { active: false, ui: null, widget: null, warned: false };

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

	// Cached lookup: syncPlayerUi() runs often while a track is loading.
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
			// Warn once per missing period, so a changed Spotify layout does not fail silently.
			if (!takeover.warned) {
				takeover.warned = true;
				console.warn("[Synthesis Spicetify] now playing widget not found, the track is not shown in the player bar", PLAYBAR.widget);
			}
			return false;
		}
		takeover.warned = false;

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
		tab: "spotify", // "spotify", or the id of a service
		service: Object.keys(providers)[0], // the service tab selected last: its results are shown, and kept ready while the Spotify tab is open
		host: null,
		panes: {}, // service id -> that service's results for the current query
		observer: null // fires when the footer of the shown pane comes close to the visible area
	};

	// The results of one service for the current query. Besides the rows it holds the paged search session
	// (infinite scroll) and a footer element that doubles as the scroll sentinel.
	const newPane = () => ({ status: "idle", results: [], error: null, session: null, hasMore: false, loadingMore: false, moreError: null, footer: null });
	const paneOf = (id) => (search.panes[id] ??= newPane());
	// The service whose results the body shows (on the Spotify tab, the one that was selected last).
	const shownService = () => (search.tab === "spotify" ? search.service : search.tab);

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
				...["spotify", ...Object.keys(providers)].map((id) =>
					h(
						"button",
						{ class: "ss-tab", role: "tab", "data-tab": id, onClick: () => setTab(id) },
						id === "spotify" ? t("tabSpotify") : providers[id].label
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
		const native = search.tab === "spotify";
		search.section.classList.toggle("ss-tab-spotify", native);
		for (const btn of search.tabs.children) btn.setAttribute("aria-selected", String(btn.dataset.tab === search.tab));
		const host = search.section.parentElement;
		if (search.host && search.host !== host) search.host.classList.remove("ss-native-hidden");
		search.host = host;
		host?.classList.toggle("ss-native-hidden", !native);
	}

	function setTab(id) {
		if (search.tab === id) return;
		search.tab = id;
		if (id !== "spotify") search.service = id;
		applyTab();
		if (id === "spotify") return;
		// Only the selected service is searched, so the others are not hit on every keystroke: one that has
		// not been searched for this query yet is searched now.
		if (search.query && paneOf(id).status === "idle") runSearch(id);
		else renderSearch();
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
	function updateFooter(pane) {
		pane.footer ??= h("div", { class: "ss-more" });
		const { footer } = pane;
		if (pane.loadingMore) {
			footer.replaceChildren(h("div", { class: "ss-status" }, t("loadingMore")));
		} else if (pane.moreError) {
			footer.replaceChildren(
				h(
					"div",
					{ class: "ss-status" },
					h("span", {}, `${t("loadMoreFailed")} ${pane.moreError}`),
					h("button", { class: "ss-link", onClick: loadMore }, t("retry"))
				)
			);
		} else {
			footer.replaceChildren();
		}
	}

	// (Re)start observing the footer of the shown pane. observe() reports the current state right away, so a
	// footer that is already visible (few rows, tall window) immediately triggers the next page as well.
	function armObserver() {
		const pane = paneOf(shownService());
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
		if (pane.footer && pane.hasMore && !pane.moreError) search.observer.observe(pane.footer);
	}

	async function loadMore() {
		const id = shownService();
		const pane = paneOf(id);
		const { session } = pane;
		if (!session || pane.loadingMore || !pane.hasMore || pane.status !== "done") return;
		const token = search.token;
		pane.loadingMore = true;
		pane.moreError = null;
		updateFooter(pane);
		try {
			const more = await session.take(config.resultLimit);
			if (token !== search.token) return;
			pane.results.push(...more);
			pane.footer.before(...more.map(trackRow));
			// An empty page means nothing new is left, even if the service still offers a continuation.
			pane.hasMore = more.length > 0 && session.hasMore;
		} catch (error) {
			if (token !== search.token) return;
			console.error("[Synthesis Spicetify] loading more results failed", error);
			pane.moreError = error?.message || String(error);
		} finally {
			// A newer search resets these fields itself, so a stale call must not touch them.
			if (token === search.token) {
				pane.loadingMore = false;
				updateFooter(pane);
				if (id === shownService()) armObserver();
			}
		}
	}

	function renderSearch() {
		if (!search.body) return;
		const id = shownService();
		const pane = paneOf(id);
		const { status } = pane;
		const label = providers[id].label;
		if (status !== "done") search.observer?.disconnect();
		if (status === "idle") {
			search.body.replaceChildren();
		} else if (status === "loading") {
			search.body.replaceChildren(h("div", { class: "ss-status" }, t("searching", label)));
		} else if (status === "error") {
			search.body.replaceChildren(
				h(
					"div",
					{ class: "ss-status" },
					h("span", {}, `${t("failed", label)} ${pane.error || ""}`),
					h("button", { class: "ss-link", onClick: () => runSearch(id) }, t("retry")),
					h("button", { class: "ss-link", onClick: openSettings }, t("openSettings"))
				)
			);
		} else if (status === "done" && !pane.results.length) {
			search.body.replaceChildren(h("div", { class: "ss-status" }, t("noResults", label)));
		} else if (status === "done") {
			updateFooter(pane);
			search.body.replaceChildren(...(config.playbackEnabled ? [] : [playbackNotice()]), ...pane.results.map((track, i) => (i === 0 ? topResultRow(track) : trackRow(track))), pane.footer);
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

	// A new query: the results of every service are dropped, and the shown service is searched.
	function startQuery(query) {
		search.token++;
		search.query = query;
		search.panes = {};
		ensureSection();
		runSearch(shownService());
	}

	// Searches one service for the current query and shows the outcome if that service is the shown one.
	async function runSearch(id) {
		const { token, query } = search;
		const pane = paneOf(id);
		Object.assign(pane, newPane(), { status: "loading" });
		if (id === shownService()) renderSearch();
		attachSection();

		try {
			const session = providers[id].createSearch(query);
			const results = await session.take(config.resultLimit);
			if (token !== search.token) return;
			pane.session = session;
			pane.results = results;
			pane.hasMore = session.hasMore;
			pane.status = "done";
		} catch (error) {
			if (token !== search.token) return;
			console.error("[Synthesis Spicetify] search failed", error);
			pane.error = error?.message || String(error);
			pane.status = "error";
		}
		if (id === shownService()) renderSearch();
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
		if (query === search.query && paneOf(shownService()).status !== "error") {
			attachSection();
			return;
		}
		// Spotify updates the route while typing, so debounce before hitting the service.
		search.timer = setTimeout(() => startQuery(query), SEARCH_DEBOUNCE_MS);
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

		const checked = Object.values(providers).filter((provider) => provider.diagnose);
		for (const provider of checked) {
			if (checked.length > 1) log(`--- ${provider.label} ---`);
			await provider.diagnose(log, step);
		}
	}

	// The YouTube steps of the connection test: session and search, every client's player response, a download.
	async function youtubeDiagnose(log, step) {
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
						onClick: () => window.open("https://github.com/kagamiomochi/Synthesis-Spicetify#enabling-playback", "_blank", "noopener,noreferrer"),
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

	// The "Play a recommended track" switch. It applies at once. Returns the elements to show, and reset() which
	// shows the saved state again.
	function createRecommendSection() {
		const input = h("input", { type: "checkbox" });
		input.checked = config.autoRecommend;
		input.addEventListener("change", () => {
			saveConfig({ autoRecommend: input.checked });
			// The active track started before the switch was on, so nothing has been looked up for it yet.
			if (input.checked && state.status !== "idle" && state.current) prepareRecommendation(state.current);
		});
		return {
			nodes: [
				h("label", { class: "ss-toggle", style: "margin-top:16px" }, h("span", { class: "ss-switch" }, input, h("span", {})), t("autoRecommendLabel")),
				h("div", { class: "ss-desc" }, t("autoRecommendDesc")),
			],
			reset() {
				input.checked = config.autoRecommend;
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
		const parseList = (text, separator) => text.split(separator).map((item) => item.trim()).filter(Boolean);
		const sameList = (a, b) => a.length === b.length && a.every((item, i) => item === b[i]);
		// Settings apply as soon as they are edited. A field that is empty or invalid is left alone (the saved value
		// stays in effect) and is put back to the saved value when the field loses focus.
		let commitTimer = null;
		function commit(final = false) {
			clearTimeout(commitTimer);
			const wispList = parseList(wisp.value, "\n");
			const clientList = parseList(clients.value, ",");
			const unknown = clientList.filter((name) => !CLIENT_DEFS[name]);
			const badWisp = wispList.filter((url) => !/^wss?:\/\/\S+$/.test(url));
			const patch = {};
			if (wispList.length && !badWisp.length && !sameList(wispList, config.wispServers)) patch.wispServers = wispList;
			if (clientList.length && !unknown.length && !sameList(clientList, config.clients)) patch.clients = clientList;
			if (final) {
				if (unknown.length) notify(t("clientsInvalid", unknown.join(", ")), true);
				if (badWisp.length) notify(t("wispInvalid", badWisp.join(", ")), true);
				if (!wispList.length || badWisp.length) wisp.value = config.wispServers.join("\n");
				if (!clientList.length || unknown.length) clients.value = config.clients.join(", ");
			}
			if (!Object.keys(patch).length) return;
			saveConfig(patch);
			// Only the Wisp list changes the connection; the client list is read on every player request.
			if (patch.wispServers) resetNetwork();
		}
		const scheduleCommit = () => {
			clearTimeout(commitTimer);
			commitTimer = setTimeout(commit, 600);
		};
		for (const field of [wisp, clients]) {
			field.addEventListener("input", scheduleCommit);
			field.addEventListener("change", () => commit(true));
		}

		const playbackSection = createPlaybackSection();
		const recommendSection = createRecommendSection();
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
			recommendSection.reset();
			resetNetwork();
			renderSearch();
			notify(t("resetDone"));
		});

		const content = h(
			"div",
			{ class: "ss-settings" },
			...playbackSection.nodes,
			...recommendSection.nodes,
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
						onClick: async () => {
							commit(true); // test what is typed in right now
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
		for (const provider of Object.values(providers)) {
			Promise.resolve()
				.then(() => provider.warmUp?.())
				.catch((error) => console.warn(`[Synthesis Spicetify] ${provider.label} warm-up failed`, error));
		}
	});

	window.SynthesisSpicetify = { version: VERSION, state, get config() { return config; }, providers, runDiagnostics };
	console.log(`[Synthesis Spicetify] ${VERSION} loaded`);
})();