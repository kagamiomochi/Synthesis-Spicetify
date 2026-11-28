<div align="center">
  <h1>Synthesis Spicetify</h1>
  <p>Transcending all musical boundaries.</p>
  <img src="./logo.png" alt="logo" width="300">

  ![GitHub Tag](https://img.shields.io/github/v/tag/kagamiomochi/Synthesis-Spicetify?sort=semver&style=for-the-badge&label=Latest%20Version)

  English | [日本語](./README.ja.md)
</div>

A [Spicetify](https://spicetify.app/) extension that brings **YouTube Music** and **SoundCloud** into Spotify.

## Features

- Search results get extra tabs ("Spotify", "YouTube Music", "SoundCloud"); the selected tab is kept while you change the query
- Play, play next, add to queue, or save to a Spotify playlist
- Non-Spotify tracks behave like normal Spotify tracks: Spotify's own player bar, queue, playlists, seek bar, previous / next, repeat and shuffle all work (see [How it plays](#how-it-plays))
- Restores the track you were listening to when Spotify is opened again (paused, at the position where you left off)
- Playback is opt-in. Without the local Wisp server you can still search and open results in the browser.

## Installation

**Marketplace:** open the Spicetify Marketplace in Spotify, search for "Synthesis Spicetify" and install it.

**Manual:** copy `synthesis-spicetify.js` into the Spicetify `Extensions` folder, then run:

```sh
spicetify config extensions synthesis-spicetify.js
spicetify apply
```

## Enabling playback

Playback is **off by default**. YouTube rejects the shared public Wisp proxies, so you need to run a small proxy (Wisp) on your own PC ([why?](#why-a-local-wisp-server)).

1. Install the requirements: Node.js 22.12+ (npm comes with it). Linux also needs systemd.
2. In Spotify, open the settings and turn on **Enable playback**. The extension shows the setup steps (a one-line command pinned to your installed version) and checks the connection. Playback is enabled once the check succeeds.

   Or install by hand: clone this repository and run

   ```sh
   node setup-wisp.mjs install
   ```

3. To remove it, run the same command with `uninstall`.

The server starts at login. The Node.js path is recorded at install time, so run `install` again after moving or replacing Node.js.
More options and details: [Local Wisp launcher](#local-wisp-launcher).

> If playback is off, the result rows have a "Try playing via public Wisp" button. It is often blocked, but if it works the playback stays enabled without a local server.

## Usage

1. Search in Spotify as usual and pick a tab at the top of the results.
2. Hover a result: the cover button plays it, the buttons on the right play it next, add it to the queue, save it to a playlist or open it in the browser.
3. Queued tracks appear in Spotify's own queue panel, where you can reorder or remove them.
4. While a non-Spotify track is active, Spotify's play button toggles its play/pause. Next / previous move to the next / previous item of the queue or playlist, Spotify track or not.

### Restoring the last track

Spotify does not bring back a local file when it starts, so a non-Spotify track would be gone after a restart. The extension therefore remembers the track you were playing and its position (every few seconds) and puts it back at the next start: Spotify is moved onto the track's placeholder and left **paused** at the saved position. Nothing is downloaded until you press play, which then continues from that position (for a long track it can take a few seconds until the download has reached it). You can move the seek bar before pressing play.

- The saved record is replaced as soon as you play something else, and removed when you play a regular Spotify track, because Spotify restores those itself.
- Nothing is restored while playback is off, when something is already playing, or when the track's placeholder file no longer exists (for example after the automatic tidy-up of an unused file; the file of the last track is kept).
- The playlist or album the track came from is not restored: the track starts on its own, so its service's recommendation follows it (see Autoplay).
- It can be turned off in [Settings](#settings). Turning it off deletes the saved record.

### How it plays

Spotify's player, queue and playlists can only hold Spotify tracks and local files. So the extension creates a **silent local file** for every track you play, queue or save (artist "YouTube" or "SoundCloud", album "Synthesis", the track ID as the title) and hands it to Spotify like any local track. When Spotify starts it, the extension pauses Spotify and streams the real track instead. When the track ends, Spotify moves on to whatever follows. The extension rewrites the displayed title, artist and cover in Spotify's rows, queue, now playing panel and player bar; the files and Spotify's data are not changed.

**Setup:** turning on playback also turns on Spotify's Local Files. A folder dialog asks once for the placeholder folder, which the extension registers as a Local Files source (you can also add it yourself in Spotify's settings). Allow the permission prompt if it appears again.

**Notes:**

- The files are about 2 KB per second of track length. The extension deletes unused ones automatically (see [Settings](#settings)); files used by a playlist are never deleted.
- Saved tracks only play on the PC that has the folder, not on other devices. If a placeholder file is deleted, its playlist row becomes unplayable.

## Settings

Open the profile menu in Spotify and choose "Synthesis Spicetify settings". Changes take effect immediately.

| Setting | Description |
| --- | --- |
| **Enable playback** | Off by default. Turning it on shows the setup steps and checks `ws://localhost:6001/`. Turning it off stops the current track. |
| **Autoplay** | When a track played from search ends (or you press Next), play the next recommendation from its service. Does not affect playlists or the queue. On by default. |
| **Restore the last track** | At startup, put the track that was playing last back, paused at its saved position. Turning it off deletes the saved record. On by default. See [Restoring the last track](#restoring-the-last-track). |
| **Tidy up placeholders automatically** | Shortly after startup, delete placeholder files older than 24 hours that no playlist or queue uses. **Tidy up now** runs it immediately. On by default. |
| **Public Wisp proxies** | One per line, tried in order. Default: `wss://wisp.mercurywork.shop/`. While playback is enabled, the local server `ws://localhost:6001/` is tried first. |
| **InnerTube clients** | `visionos`, `tv_samsung`, tried in order. The defaults work without a PO token. |
| **Connection test** | Runs the whole chain (libcurl, session, search, player request, audio download) and prints each step's result. |
| **Clear audio cache** | Frees the downloaded audio (the last few tracks are cached in memory). |
| **Reset settings** | Restores every setting to its default. Click twice to confirm. |

## Troubleshooting

Run the **Connection test** in the settings first; it shows which step fails.

| Message | Likely cause and fix |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | The Wisp proxy's IP is flagged. Enable playback and set up a local Wisp server. |
| `No usable Wisp server` | If playback is enabled, start the local server. Otherwise check your network and the public Wisp URL. |
| The libcurl step fails right at the start | Spotify's CSP may be blocking WASM or the jsDelivr import. |
| `EvalError` / CSP error in the player step | Spotify blocked `eval`, which some stream URLs need. Use `visionos` only. |
| `player request failed: HTTP 400/403` or `LOGIN_REQUIRED` on a local Wisp | The client definitions are outdated. See [Updating client definitions](#updating-client-definitions). |

**Local Wisp logs:** on Linux, `journalctl --user -u synthesis-spicetify-wisp-backend.service -u synthesis-spicetify-wisp-proxy.service`. On macOS and Windows, the logs are next to the wisp-js directory (`wisp-ondemand.log` for the launcher, `wisp-backend.log` for the Wisp server).

## Privacy and disclaimer

- Requests go through a Wisp proxy. Until you enable playback this is a shared public server, which sees the hostnames you connect to (TLS is terminated inside Spotify). With a local server it is your own machine.
- YouTube session cookies are kept in memory only.
- The last track (its service, ID, title, artists, album, cover URL, placeholder URI and position) is kept in the browser's local storage so it can be restored at the next start. It stays on your PC, and is deleted when you turn off "Restore the last track".
- SoundCloud's `client_id` is read from soundcloud.com's own scripts and cached in the browser's local storage. It is public and not tied to you.
- This extension uses unofficial YouTube and SoundCloud APIs and may violate their Terms of Service (SoundCloud's API terms also forbid mixing its tracks with other services). Use it at your own risk.
- Only tracks SoundCloud offers in full are shown. Previews, Go+ and encrypted streams are skipped.
- SoundCloud serves AAC only, which the Chromium inside Spotify cannot decode. The extension decodes it with [FAAD2](https://github.com/knik0/faad2) compiled to WebAssembly (`@ohrstrom/faad2-wasm`, loaded from jsDelivr) and plays it through Web Audio while the rest is still downloading, so a track starts after its first ~10 seconds of audio. If Web Audio cannot start, the track is played as a WAV file once fully decoded, which takes a few seconds.
- Not affiliated with Spotify, Google, YouTube or SoundCloud.

## Technical details

<details>
<summary>How it works</summary>

| Part | Library |
| --- | --- |
| YouTube Music search | [YouTube.js](https://github.com/LuanRT/YouTube.js) (youtubei.js) |
| Requests that bypass CORS | [libcurl.js](https://github.com/ading2210/libcurl.js) (WASM libcurl) over a Wisp WebSocket proxy |
| Playback | Chunks are appended to a `MediaSource` while downloading; the finished `Blob` is cached (last few tracks, in memory) and used as the fallback |

The libraries are loaded from jsDelivr on first use (pinned: libcurl.js 0.7.5, youtubei.js 18.3.0, `@ohrstrom/faad2-wasm` 2.11.2-rc.4).

The YouTube player request (client definitions, headers, cookies) is built the way yt-dlp does it, because the request shape YouTube.js sends for app clients is currently rejected with "Sign in to confirm you're not a bot".

**Services.** Everything that belongs to one music service sits behind the `providers` registry in `synthesis-spicetify.js` (search, audio download, the service page, cover helpers, connection test steps). The rest of the extension only talks to that interface, so a new service is one more provider entry. The interface is described in the comment above the registry.

A placeholder's title carries the service tag in front of the track ID (`sc.123`), and every service has its own artist tag, so `spotify:local:` URIs never clash. YouTube has no tag (bare video ID, artist "YouTube"), so playlists saved by older versions keep working.

</details>

<details id="why-a-local-wisp-server">
<summary>Why a local Wisp server</summary>

libcurl.js sends its traffic through a Wisp proxy. TLS is terminated inside Spotify, so the proxy only sees destination hostnames, but YouTube judges the proxy's IP address. Shared public Wisp servers run on data center IPs, which YouTube rejects. Search still works through them, playback does not. A Wisp server on your own PC uses your own IP and works. That is why playback is off by default.

</details>

<details id="local-wisp-launcher">
<summary>Local Wisp launcher</summary>

`setup-wisp.mjs` installs the Wisp server ([wisp-js](https://github.com/MercuryWorkshop/wisp-js), pinned version) with npm into `~/.local/share/synthesis-spicetify/wisp-js` (Windows: `%LOCALAPPDATA%\\synthesis-spicetify\\wisp-js`) and registers it to start at login on `127.0.0.1:6001`. The script is not needed after the install.

**Commands:** `install` and `uninstall`. `install --port N` changes the port (also set the local Wisp URL in the settings).

**What gets registered:**

| OS | Registered as | Logs |
| --- | --- | --- |
| Linux | systemd user unit `synthesis-spicetify-wisp.service` | `journalctl --user -u synthesis-spicetify-wisp.service` |
| macOS | LaunchAgent | `wisp.log` next to the wisp-js directory |
| Windows | Scheduled task that runs at login (hidden PowerShell window) | None. Run the command from `install` yourself to see errors. |

Without systemd, `install` only installs wisp-js and prints the command to start it from your own autostart.

**Test status:** the install, the generated systemd unit and the server start were tested on Linux. The macOS and Windows autostart registration has not been tested on real machines.

**Migrating from older versions:** run `install` again. It removes the old systemd units (proxy, backend and the always-on `synthesis-spicetify-wisp.service` of old READMEs is replaced) and the old launcher files, and replaces the macOS and Windows entries. The old `libcurl.js` directory is no longer used and can be deleted.

</details>

<details id="updating-client-definitions">
<summary>Updating client definitions</summary>

When YouTube changes what it accepts, the player request starts failing with `HTTP 400/403` or `LOGIN_REQUIRED` even on a local Wisp server. Update `CLIENT_DEFS` in `synthesis-spicetify.js` from `INNERTUBE_CLIENTS` in yt-dlp (`yt_dlp/extractor/youtube/_base.py`).

</details>

## Credits

- [YouTube.js](https://github.com/LuanRT/YouTube.js) by LuanRT
- [libcurl.js](https://github.com/ading2210/libcurl.js) by ading2210
- [wisp-js](https://github.com/MercuryWorkshop/wisp-js) by MercuryWorkshop (the local Wisp server)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp), whose client definitions are the reference for the player request
