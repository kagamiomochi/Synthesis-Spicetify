// NAME: YT Music Local
// AUTHOR: kagamiomochi
// DESCRIPTION: Search YouTube from Spotify (YouTube Data API key or public Invidious instances) and open tracks in YouTube Music. No server required.
// SOURCE: https://github.com/kagamiomochi/YT-Music-Local

(async function () {
  "use strict";

  // Wait until Spicetify APIs are ready.
  while (
    !window.Spicetify ||
    !Spicetify.PopupModal ||
    !Spicetify.showNotification ||
    !(Spicetify.Topbar?.Button || Spicetify.Playbar?.Button)
  ) {
    await new Promise((r) => setTimeout(r, 300));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // YouTube Music Web API
  // ---------------------------------------------------------------------------

  // music.youtube.com cannot be reached from Spotify's renderer: fetch() is
  // blocked by CORS, and Spicetify.CosmosAsync routes external requests through
  // cors-proxy.spicetify.app, which gets 403 from YouTube. So the search uses
  // backends that allow cross-origin requests:
  //   1. YouTube Data API v3 (needs a free API key, most reliable)
  //   2. Public Invidious instances with CORS enabled (no key, best effort)
  // Both return normal YouTube videos; the "Music" category is requested where
  // the API supports it, and tracks are still opened in YouTube Music.

  const API_KEY_STORAGE = "ytmLocalApiKey";
  const getApiKey = () => (Spicetify.LocalStorage.get(API_KEY_STORAGE) || "").trim();

  function decodeHtml(str) {
    const t = document.createElement("textarea");
    t.innerHTML = str;
    return t.value;
  }

  // "PT1H2M3S" -> seconds
  function parseIsoDuration(iso) {
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
    if (!m) return 0;
    const [, d, h, min, sec] = m.map((x) => Number(x || 0));
    return ((d * 24 + h) * 60 + min) * 60 + sec;
  }

  // Auto-generated music channels are named "<Artist> - Topic".
  const cleanArtist = (name) => String(name || "").replace(/ - Topic$/, "");

  async function searchWithDataApi(query, key) {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      videoCategoryId: "10",
      maxResults: "10",
      q: query,
      key,
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

    const items = (data.items || []).filter((i) => i?.id?.videoId);
    // Durations need a second (cheap, 1 quota unit) request.
    const durations = {};
    if (items.length) {
      try {
        const vp = new URLSearchParams({
          part: "contentDetails",
          id: items.map((i) => i.id.videoId).join(","),
          key,
        });
        const vr = await fetch(`https://www.googleapis.com/youtube/v3/videos?${vp}`);
        const vd = await vr.json();
        for (const v of vd.items || []) {
          durations[v.id] = parseIsoDuration(v.contentDetails?.duration);
        }
      } catch (e) {
        console.warn("[ytm-local] duration lookup failed", e);
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
        i.snippet?.thumbnails?.medium?.url ||
        `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`,
    }));
  }

  let invidiousInstances = null;

  async function getInvidiousInstances() {
    if (invidiousInstances) return invidiousInstances;
    const res = await fetch("https://api.invidious.io/instances.json?sort_by=health");
    const list = await res.json();
    invidiousInstances = list
      .filter(([, i]) => i?.api === true && i?.cors === true && i?.type === "https")
      .map(([, i]) => String(i.uri).replace(/\/$/, ""))
      .slice(0, 5);
    return invidiousInstances;
  }

  async function searchWithInvidious(query) {
    let lastError = null;
    try {
      for (const base of await getInvidiousInstances()) {
        try {
          const res = await fetch(
            `${base}/api/v1/search?q=${encodeURIComponent(query)}&type=video`,
            { signal: AbortSignal.timeout(6000) }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
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
        } catch (e) {
          lastError = e;
        }
      }
    } catch (e) {
      lastError = e;
    }
    // Forget the list so that the next search fetches a fresh one.
    invidiousInstances = null;
    throw new Error(
      `No public search instance responded${lastError ? ` (${lastError.message})` : ""}. ` +
        "Set a YouTube Data API key in the YT Music Local window for reliable results."
    );
  }

  /**
   * Search YouTube.
   * Returns an array of result objects:
   *   { type, videoId, title, artist, album, duration, thumbnail }
   */
  async function ytmSearch(query) {
    const key = getApiKey();
    return key ? searchWithDataApi(query, key) : searchWithInvidious(query);
  }

  // ---------------------------------------------------------------------------
  // UI: Popup Modal
  // ---------------------------------------------------------------------------

  function renderResultRow(item, onOpen) {
    const button = el(
      "button",
      {
        className:
          "main-buttons-button main-button-secondary",
        style: {
          padding: "6px 14px",
          cursor: "pointer",
          flexShrink: "0",
        },
        onclick: () => onOpen(item),
      },
      "▶ Open"
    );

    return el(
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
        src: item.thumbnail || "",
        style: {
          width: "64px",
          height: "36px",
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
          [item.artist, formatDuration(item.duration)].filter(
            Boolean
          ).join(" / ")
        )
      ),
      button
    );
  }

  function openModal() {
    const status = el("div", {
      style: {
        minHeight: "18px",
        fontSize: "12px",
        margin: "8px 0",
        opacity: "0.8",
      },
    });
    const list = el("div", {
      style: { maxHeight: "50vh", overflowY: "auto" },
    });
    const input = el("input", {
      type: "text",
      placeholder:
        "Song title, artist name, or YouTube/YT Music URL",
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
      const query = input.value.trim();
      if (!query) return;

      // Extract video ID from YouTube/YT Music URLs
      const videoId = extractVideoId(query);
      if (videoId) {
        status.textContent = "Opening in YouTube Music...";
        window.open(
          `https://music.youtube.com/watch?v=${videoId}`,
          "_blank"
        );
        return;
      }

      status.textContent = "Searching...";
      list.replaceChildren();

      try {
        const results = await ytmSearch(query);
        status.textContent = `${results.length} result${
          results.length !== 1 ? "s" : ""
        } found.`;
        renderResults(list, results, status);
      } catch (e) {
        status.textContent = `Error: ${e.message}`;
      }
    };

    const searchButton = el(
      "button",
      {
        className:
          "main-buttons-button main-button-primary",
        style: { padding: "8px 18px", cursor: "pointer" },
        onclick: doSearch,
      },
      "Search"
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });

    // Optional YouTube Data API key (stored locally in Spotify).
    const keyInput = el("input", {
      type: "password",
      value: getApiKey(),
      placeholder: "YouTube Data API v3 key (optional, more reliable)",
      style: {
        flex: "1",
        padding: "4px 8px",
        borderRadius: "4px",
        border: "none",
        background: "var(--spice-card)",
        color: "var(--spice-text)",
      },
    });
    keyInput.addEventListener("change", () => {
      Spicetify.LocalStorage.set(API_KEY_STORAGE, keyInput.value.trim());
      searchCache.clear();
      status.textContent = keyInput.value.trim()
        ? "API key saved."
        : "API key removed. Public instances will be used.";
    });
    const keyRow = el(
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
      "API key:",
      keyInput
    );

    const root = el(
      "div",
      { style: { color: "var(--spice-text)" } },
      el("div", { style: { display: "flex", gap: "8px" } }, input, searchButton),
      status,
      list,
      keyRow
    );

    Spicetify.PopupModal.display({
      title: "YT Music Local",
      content: root,
      isLarge: true,
    });
    setTimeout(() => input.focus(), 100);
  }

  function renderResults(listEl, items, status, limit = Infinity) {
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(
        el("div", { style: { opacity: "0.7" } }, "Nothing was found.")
      );
      return;
    }
    for (const item of items.slice(0, limit)) {
      listEl.append(
        renderResultRow(item, (it) => {
          const url = `https://music.youtube.com/watch?v=${it.videoId}`;
          window.open(url, "_blank");
        })
      );
    }
  }

  // ---------------------------------------------------------------------------
  // URL parsing — extract video ID from YouTube / YT Music URLs
  // ---------------------------------------------------------------------------

  const YOUTUBE_ID_RE =
    /(?:youtube\.com\/watch\?[^#&]*v=|youtu\.be\/|music\.youtube\.com\/watch\?v=)([A-Za-z0-9_-]{11})/;

  function extractVideoId(input) {
    const m = String(input).match(YOUTUBE_ID_RE);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------------------
  // Integration with Spotify search page
  // ---------------------------------------------------------------------------

  const SEARCH_SECTION_ID = "ytm-local-search-section";
  const SEARCH_DEBOUNCE_MS = 700;
  const SEARCH_VISIBLE_ROWS = 5;
  const searchCache = new Map();
  const searchState = {
    query: "",
    token: 0,
    timer: null,
    setupChecked: false,
  };
  let searchSection = null;

  function getSearchQuery() {
    const pathname =
      Spicetify.Platform?.History?.location?.pathname || "";
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
      document.querySelector(
        ".main-view-container__scroll-node-child"
      ) || document.querySelector("main")
    );
  }

  function createSearchSection() {
    const title = el(
      "h2",
      {
        style: {
          fontSize: "24px",
          fontWeight: "700",
          margin: "0 0 8px",
        },
      },
      "YouTube Music"
    );
    const status = el("div", {
      style: {
        minHeight: "18px",
        fontSize: "12px",
        margin: "4px 0",
        opacity: "0.8",
      },
    });
    const list = el("div");
    const moreButton = el(
      "button",
      {
        className:
          "main-buttons-button main-button-secondary",
        style: {
          padding: "6px 14px",
          cursor: "pointer",
          marginTop: "4px",
          display: "none",
        },
      },
      "Show more"
    );
    const root = el(
      "section",
      {
        id: SEARCH_SECTION_ID,
        style: {
          padding: "16px 32px 8px",
          color: "var(--spice-text)",
        },
      },
      title,
      status,
      list,
      moreButton
    );
    return { root, status, list, moreButton };
  }

  function mountSearchSection() {
    if (!searchSection)
      searchSection = createSearchSection();
    if (searchSection.root.isConnected) return true;
    const container = findSearchContainer();
    if (!container) return false;
    container.prepend(searchSection.root);
    return true;
  }

  function unmountSearchSection() {
    if (
      searchSection &&
      searchSection.root.isConnected
    )
      searchSection.root.remove();
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

  async function runSearchPageQuery(query, token) {
    try {
      let items = searchCache.get(query);
      if (!items) {
        items = await ytmSearch(query);
        searchCache.set(query, items);
      }
      if (token !== searchState.token || !mountSearchSection())
        return;
      searchSection.status.textContent = `${items.length} result${
        items.length !== 1 ? "s" : ""
      } found.`;
      showSearchResults(items);
    } catch (e) {
      if (token !== searchState.token || !mountSearchSection())
        return;
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
      mountSearchSection();
      return;
    }

    searchState.query = query;
    const token = ++searchState.token;
    clearTimeout(searchState.timer);
    if (mountSearchSection()) {
      searchSection.list.replaceChildren();
      searchSection.moreButton.style.display = "none";
      searchSection.status.textContent = "Searching...";
    }
    const delay = searchCache.has(query)
      ? 0
      : SEARCH_DEBOUNCE_MS;
    searchState.timer = setTimeout(
      () => runSearchPageQuery(query, token),
      delay
    );
  }

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  Spicetify.Platform?.History?.listen?.(onSearchRouteChange);
  // Re-check periodically — React may replace containers.
  setInterval(onSearchRouteChange, 1000);
  onSearchRouteChange();

  const ButtonClass =
    Spicetify.Topbar?.Button || Spicetify.Playbar.Button;
  new ButtonClass("YT Music Local", "download", openModal);
})();
