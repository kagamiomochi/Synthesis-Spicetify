// NAME: YT Music Local
// AUTHOR: kagamiomochi
// DESCRIPTION: Search YouTube Music directly from Spotify and open tracks in YouTube Music. No server required.
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

  const YTM_SEARCH_URL = "https://music.youtube.com/youtubei/v1/search";

  /**
   * Search YouTube Music.
   * Returns an array of result objects:
   *   { type, videoId, title, artist, album, duration, thumbnail }
   */
  async function ytmSearch(query) {
    const body = {
      query: query,
      context: {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: "1.20240903",
          platform: "DESKTOP",
        },
      },
    };

    const res = await fetch(YTM_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`YouTube Music API error: HTTP ${res.status}`);
    }

    const data = await res.json();
    return parseSearchResults(data);
  }

  /**
   * Parse YouTube Music search API response.
   * Navigates the response structure to extract playable items.
   */
  function parseSearchResults(data) {
    const results = [];

    // Navigate to the tabs array
    const tabs =
      data?.contents?.tabbedSearchResultsRenderer?.tabs;
    if (!tabs || !Array.isArray(tabs)) return results;

    for (const tab of tabs) {
      const tabContent = tab?.tabRenderer?.content;
      if (!tabContent) continue;

      const sections =
        tabContent?.sectionListRenderer?.contents;
      if (!Array.isArray(sections)) continue;

      for (const section of sections) {
        // musicCardShelfRenderer — featured track at the top
        const card = section?.musicCardShelfRenderer;
        if (card) {
          const parsed = parseMusicCardShelf(card);
          if (parsed) results.push(parsed);
        }

        // musicVerticalCardShelfRenderer — newer featured track format
        const vCard = section?.musicVerticalCardShelfRenderer;
        if (vCard) {
          const parsed = parseMusicVerticalCardShelf(vCard);
          if (parsed) results.push(parsed);
        }

        // itemSectionRenderer — list of tracks below
        const itemSection = section?.itemSectionRenderer;
        if (itemSection) {
          for (const sub of itemSection.contents || []) {
            const parsed = parseResponsiveListItem(sub);
            if (parsed) results.push(parsed);
          }
        }

        // reelShelfRenderer — ignore (reels/shorts)
        // horizontalCard / carouselRenderer — artist/album carousels (not playable directly)
      }
    }

    return results;
  }

  /**
   * Parse a musicCardShelfRenderer (featured track).
   */
  function parseMusicCardShelf(card) {
    const overlay =
      card?.overlay
      ?.musicItemThumbnailOverlayRenderer
      ?.content?.musicPlayButtonRenderer;

    if (!overlay?.playNavigationEndpoint) return null;

    const nav = overlay.playNavigationEndpoint.watchEndpoint;
    if (!nav?.videoId) return null;

    const thumb = card?.thumbnailRenderer
      ?.musicThumbnailRenderer?.thumbnail
      ?.thumbnails?.[0]?.url;

    // Extract runs (title, artist, etc.)
    const runs = card?.subtitle?.runs;
    if (!Array.isArray(runs) || runs.length < 1) return null;

    const titleRun = runs[0];
    const artistRun = runs.length >= 2 ? runs[1] : null;

    return {
      type: "song",
      videoId: nav.videoId,
      title: titleRun?.text || "",
      artist: artistRun?.text || "",
      thumbnail: thumb || "",
    };
  }

  /**
   * Parse a musicVerticalCardShelfRenderer (newer featured track format).
   */
  function parseMusicVerticalCardShelf(card) {
    const overlay =
      card?.overlay
      ?.musicItemThumbnailOverlayRenderer
      ?.content?.musicPlayButtonRenderer;

    if (!overlay?.playNavigationEndpoint) return null;

    const nav = overlay.playNavigationEndpoint.watchEndpoint;
    if (!nav?.videoId) return null;

    // Thumbnail
    const thumb = card?.thumbnailRenderer
      ?.musicThumbnailRenderer?.thumbnail
      ?.thumbnails?.[0]?.url;

    // Content rows: [title, artist/album, duration]
    const rows = card?.content?.musicDetailHeaderRenderer?.subtitle?.runs;
    if (!Array.isArray(rows) || rows.length < 1) return null;

    return {
      type: "song",
      videoId: nav.videoId,
      title: rows[0]?.text || "",
      artist: rows.length >= 2 ? rows[1]?.text || "" : "",
      thumbnail: thumb || "",
    };
  }

  /**
   * Parse a musicResponsiveListItemRenderer.
   */
  function parseResponsiveListItem(item) {
    // Only handle musicResponsiveListItemRenderer
    const flexColumns = item?.flexColumns;
    if (!Array.isArray(flexColumns)) return null;

    // Get the play endpoint from overlay
    const overlay =
      item?.overlay
      ?.musicItemThumbnailOverlayRenderer
      ?.content?.musicPlayButtonRenderer;

    const nav = overlay?.playNavigationEndpoint?.watchEndpoint;
    if (!nav?.videoId) return null;

    // Extract title from first flex column
    const titleColumn = flexColumns[0];
    const titleRun = titleColumn?.musicResponsiveListItemFlexColumnRenderer
      ?.text?.runs?.[0];
    if (!titleRun?.text) return null;

    // Extract artist from second flex column (if exists)
    let artist = "";
    let album = "";
    let duration = 0;

    if (flexColumns.length >= 2) {
      const secondCol =
        flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer;
      const runs = secondCol?.text?.runs;
      if (Array.isArray(runs)) {
        if (runs.length >= 3) {
          artist = runs[0]?.text || "";
          album = runs[2]?.text || "";
        } else if (runs.length === 2) {
          // Could be "artist · duration" or "artist · album"
          const r1 = runs[1]?.text || "";
          if (/^\d{1,2}:\d{2}$/.test(r1)) {
            artist = runs[0]?.text || "";
            duration = parseDuration(r1);
          } else {
            artist = runs[0]?.text || "";
            album = r1;
          }
        } else if (runs.length === 1) {
          const r = runs[0]?.text || "";
          if (/^\d{1,2}:\d{2}$/.test(r)) {
            duration = parseDuration(r);
          } else {
            artist = r;
          }
        }
      }
    }

    // Thumbnail from overlay or thumbnail column
    let thumbnail = "";
    const thumbOverlay =
      item?.overlay
      ?.musicItemThumbnailOverlayRenderer
      ?.content?.musicPlayButtonRenderer;

    if (!thumbOverlay) {
      const thumbCol =
        item?.thumbnail?.musicThumbnailRenderer?.thumbnail
        ?.thumbnails?.[0]?.url;
      if (thumbCol) thumbnail = thumbCol;
    }

    return {
      type: "song",
      videoId: nav.videoId,
      title: titleRun.text,
      artist,
      album,
      duration,
      thumbnail,
    };
  }

  function parseDuration(str) {
    const parts = str.split(":");
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }
    return 0;
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

    const root = el(
      "div",
      { style: { color: "var(--spice-text)" } },
      el("div", { style: { display: "flex", gap: "8px" } }, input, searchButton),
      status,
      list
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
