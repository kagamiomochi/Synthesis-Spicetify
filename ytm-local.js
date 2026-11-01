// NAME: YT Music Local
// AUTHOR: kagamiomochi
// DESCRIPTION: Search YouTube Music, download via a local yt-dlp server, and play as Spotify local files.

(async function ytmLocal() {
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
  const DEFAULT_PORT = 8765;
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
        "Unable to connect to the server. Please check to see if server.js is running."
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

    // Port setting: must match YTM_PORT of server.js.
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
})();
