# YT Music Local

Search YouTube Music directly from Spotify and open tracks in YouTube Music — no server, no yt-dlp, no ffmpeg required.

## Features

- **Search without a server** — uses the YouTube Data API v3 (with your own free API key, recommended) or public Invidious instances (no key, best effort). The YouTube Music web API itself cannot be called from Spotify because of CORS
- **One-click playback** — opens the matched track in YouTube Music (in your browser)
- **Search page integration** — when you type in Spotify's search bar, a YouTube Music results section appears automatically
- **URL support** — paste a YouTube / YouTube Music URL to open it directly
- **Zero dependencies** — works out of the box, no helper server needed

## Installation

### Via Spicetify Marketplace (recommended)

1. Open Spotify and go to the **Marketplace** tab
2. Search for **YT Music Local**
3. Click **Install**

### Manual installation

1. Copy `ytm-local.js` to your Spicetify Extensions folder:
   ```bash
   # Linux
   cp ytm-local.js ~/.config/spicetify/Extensions/
   # macOS
   cp ytm-local.js ~/Library/Application Support/spicetify/Extensions/
   # Windows
   copy ytm-local.js %APPDATA%\spicetify\Extensions\
   ```
2. Register the extension:
   ```bash
   spicetify config extensions ytm-local.js
   spicetify apply
   ```

## Usage

1. Click the **"YT Music Local"** button in the top bar, or
2. Type a query in Spotify's built-in search bar to see YouTube Music results inline

Click the **"▶ Open"** button next to any track to open it in YouTube Music.

## Legacy: Download Mode

The old server-based download mode (using yt-dlp + ffmpeg) is still available in the `server.js` file. Run `node server.js --install` to set up the helper server and the legacy extension. See the original repository history for details.
