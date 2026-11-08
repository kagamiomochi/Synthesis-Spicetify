# Synthesis Spotify

[![Latest Tag](https://img.shields.io/github/v/tag/kagamiomochi/Synthesis-Spotify?sort=semver)](https://github.com/kagamiomochi/Synthesis-Spotify/tags)

A [Spicetify](https://spicetify.app/) extension that brings YouTube Music into Spotify.

- A "Synthesis Spotify" section with YouTube Music results appears on Spotify's search results page
- Play a result, add it to the queue, or play it next
- Queued tracks play between Spotify tracks (shown in the queue button on the playbar)
- A small mini player appears while a YouTube track is active
- Audio is downloaded into a Blob and played from a Blob URL, so there is no streaming proxy

Currently supported service: YouTube Music (YouTube). More services are planned.

[Japanese / 日本語](#日本語)

## How it works

| Part | Library |
| --- | --- |
| YouTube Music search | [YouTube.js](https://github.com/LuanRT/YouTube.js) (youtubei.js) |
| Requests that bypass CORS | [libcurl.js](https://github.com/ading2210/libcurl.js) (WASM libcurl) over a Wisp WebSocket proxy |
| Playback | Audio is downloaded into a `Blob` and played via `URL.createObjectURL` |

The player request (client definitions, headers, cookies) is built the same way yt-dlp does it, because the
request shape YouTube.js sends for app clients is currently rejected with "Sign in to confirm you're not a bot".

Both libraries are loaded from jsDelivr on first use (pinned versions: libcurl.js 0.7.5, youtubei.js 18.3.0).

## Requirements

- Spicetify (with the Spotify desktop app)
- **A local Wisp server** (see below). This is required for playback.

### Why a local Wisp server is needed

libcurl.js sends its traffic through a Wisp proxy. TLS is terminated inside Spotify, so the proxy only sees
destination hostnames, but YouTube judges the proxy's IP address. Shared public Wisp servers run on data center
IPs, which YouTube rejects (`LOGIN_REQUIRED: Sign in to confirm you're not a bot`). Search still works through
them, playback does not. A Wisp server on your own PC uses your own IP and works.

## Installation

### Marketplace

Open the Spicetify Marketplace in Spotify, search for "Synthesis Spotify" and install it.

### Manual

1. Copy `synthesis-spotify.js` into the Spicetify `Extensions` folder.
2. Run:

   ```sh
   spicetify config extensions synthesis-spotify.js
   spicetify apply
   ```

## Setting up the local Wisp server

The steps are the same on Linux, macOS and Windows. One script, `wisp-launcher/portable/wisp_ondemand.py`, installs
[wisp-js](https://github.com/MercuryWorkshop/wisp-js) (a Wisp server for Node.js) with npm, registers an on-demand
start with the OS and starts it. It listens on `127.0.0.1:6001`, starts the Wisp server on `127.0.0.1:6002` at the first connection,
forwards the connection, and stops the server again after 5 idle minutes. Spotify only connects to
`ws://localhost:6001/`, which is the first address the extension tries, so nothing inside Spotify has to launch
anything and no extension setting is needed.

Requirements: Python 3.9+ (the script itself uses only the standard library), Node.js 22.18+ (or 24.11+) and npm.
On Linux you also need systemd (with `systemd-socket-proxyd`).

1. Clone this repository and run the installer:

   ```sh
   # Linux / macOS
   python3 wisp-launcher/portable/wisp_ondemand.py install
   ```

   ```bat
   :: Windows
   py -3 wisp-launcher\portable\wisp_ondemand.py install
   ```

   wisp-js (pinned to one version) is installed into `~/.local/share/synthesis-spotify/wisp-js` (Windows:
   `%LOCALAPPDATA%\synthesis-spotify\wisp-js`). Use `--install-dir PATH` to change it, `--node PATH` to choose the
   Node.js binary, and `--idle-minutes N` to change the idle time. The Node.js path is recorded at install time, so run
   `install` again after you move or replace Node.js (for example with a version manager). On macOS, `--resident`
   keeps a resident launcher instead of using socket activation.

2. Remove it with `uninstall` (same Python command as above, with `uninstall` instead of `install`).

What gets registered:

| OS | Registered as | Resident process |
| --- | --- | --- |
| Linux | systemd user units (socket activation) | None. systemd owns port 6001 and starts the Wisp server on the first connection. |
| macOS | LaunchAgent (launchd socket activation) | None. launchd owns port 6001, and the launcher exits again when idle. |
| Windows | Scheduled task that runs at login | A small launcher process. Only the Wisp server runs on demand. |

Logs: on Linux, use `journalctl --user -u synthesis-spotify-wisp-backend.service -u synthesis-spotify-wisp-proxy.service`.
On macOS and Windows, logs are written next to the wisp-js directory (`wisp-ondemand.log` for the launcher,
`wisp-backend.log` for the Wisp server).

Other commands:

- `wisp_ondemand.py setup` only installs wisp-js with npm.
- `wisp_ondemand.py run` runs the launcher in the foreground. This works on every OS, so it is also the way to go on
  Linux without systemd.
- Older versions of this script used the Python Wisp server from libcurl.js. Run `install` again to switch to wisp-js;
  the old `libcurl.js` directory is no longer used and can be deleted.
- If an older version of this README had you enable `synthesis-spotify-wisp.service` (the always-on service), disable it
  first with `systemctl --user disable --now synthesis-spotify-wisp.service`. It uses port 6001 too, and the installer
  stops with a message when it finds it.

The proxy, on-demand start and idle stop were tested on Linux. The macOS socket activation was only simulated on
Linux (the `launch_activate_socket` call itself needs macOS), and the macOS and Windows autostart steps have not been
tested on real machines yet.

## Usage

1. Search in Spotify as usual. The "Synthesis Spotify" section appears on the search results page.
2. Hover a result:
   - Play button on the cover: play now
   - "Play next" / "Add to queue" buttons on the right
3. Open the queue button on the playbar to see, play or remove queued YouTube tracks.
4. While a YouTube track is active, Spotify's play button toggles play/pause of that track and Spotify itself stays
   silent. Spotify's next/previous buttons move on to the next queued YouTube track, or back to Spotify when the
   queue is empty.

Queue behavior: queued YouTube tracks play when Spotify moves to its next track within the same playback context.
Starting a different playlist or album in Spotify stops the YouTube track.

## Settings

Open the profile menu in Spotify and choose "Synthesis Spotify settings".

- **Wisp proxies**: one per line, tried in order. Default: `ws://localhost:6001/`, then a shared public server.
- **InnerTube clients**: `visionos`, `tv_samsung`, tried in order. Defaults work without a PO token.
- **Connection test**: runs the whole chain (libcurl, session, search, player request, audio download) and prints
  the result of each step.
- **Clear audio cache**: frees the downloaded audio (the last few tracks are cached in memory).

## Troubleshooting

| Message | Likely cause and fix |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | The Wisp proxy's IP is flagged. Use a local Wisp server (`ws://localhost:6001/`). |
| `No usable Wisp server` | The local server is not running and the public one is unreachable. Start the local server. |
| libcurl step fails right at the start | Spotify's CSP may be blocking WASM or the jsDelivr import. |
| `EvalError` / CSP error in the player step | Spotify blocked `eval`, which is needed to decipher some stream URLs. Use `visionos` only. |
| `player request failed: HTTP 400/403` or `LOGIN_REQUIRED` on a local Wisp | The client definitions are outdated. Update `CLIENT_DEFS` in `synthesis-spotify.js` from `INNERTUBE_CLIENTS` in yt-dlp (`yt_dlp/extractor/youtube/_base.py`). |

## Privacy and disclaimer

- Requests to YouTube go through the Wisp proxy you configure. With a local server this is your own machine.
  A shared public server sees which hostnames you connect to (TLS is terminated inside Spotify).
- Session cookies from YouTube are kept in memory only.
- This extension uses unofficial YouTube APIs and may violate YouTube's Terms of Service. Use it at your own risk.
- Not affiliated with Spotify, Google or YouTube.

## Credits

- [YouTube.js](https://github.com/LuanRT/YouTube.js) by LuanRT
- [libcurl.js](https://github.com/ading2210/libcurl.js) by ading2210
- [wisp-js](https://github.com/MercuryWorkshop/wisp-js) by MercuryWorkshop (the local Wisp server)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp), whose client definitions are used as the reference for the player request

---

# 日本語

Spotify に YouTube Music を統合する [Spicetify](https://spicetify.app/) 拡張機能です。

- Spotify の検索結果ページに、YouTube Music の結果を「Synthesis Spotify」セクションとして表示
- 結果から再生、次に再生、キューに追加
- キューに入れた曲は Spotify の曲の間に挟まって再生(プレイバーのキューボタンで確認)
- YouTube の曲の再生中は小さなミニプレイヤーを表示
- 音声は Blob にダウンロードして Blob URL で再生

対応サービスは現在 YouTube Music(YouTube)のみです。

## 必要なもの

- Spicetify(Spotify デスクトップアプリ)
- **ローカルの Wisp サーバー**(再生に必須)

### ローカル Wisp が必要な理由

libcurl.js は Wisp プロキシ経由で通信します。TLS は Spotify 内で終端されるので、プロキシには接続先のホスト名しか見えません。ただ、YouTube はプロキシの IP アドレスで判定します。公開されている共有 Wisp サーバーはデータセンターの IP で動いていて、YouTube に弾かれます(`LOGIN_REQUIRED: Sign in to confirm you're not a bot`)。検索は通りますが、再生はできません。自分の PC で動かす Wisp なら自分の IP が使われるので、再生できます。

## インストール

### Marketplace
Spotify の Spicetify Marketplace で「Synthesis Spotify」を検索してインストールします。

### 手動
`synthesis-spotify.js` を Spicetify の `Extensions` フォルダに置き、次を実行します。

  ```sh
  spicetify config extensions synthesis-spotify.js
  spicetify apply
  ```

## ローカル Wisp サーバーの用意

手順は Linux、macOS、Windows で共通です。`wisp-launcher/portable/wisp_ondemand.py` という 1 つのスクリプトが、[wisp-js](https://github.com/MercuryWorkshop/wisp-js) (Node.js 製の Wisp サーバー) の npm でのインストール、OS へのオンデマンド起動の登録、起動までを行います。`127.0.0.1:6001` で待ち受け、最初の接続で Wisp サーバーを `127.0.0.1:6002` に起動して接続を転送し、5 分間アイドルになるとサーバーを止めます。Spotify はこれまで通り `ws://localhost:6001/` (拡張が最初に試すアドレス) に接続するだけなので、Spotify の中から何かを起動する必要はなく、拡張の設定も不要です。

必要なもの: Python 3.9 以上 (スクリプト自体は標準ライブラリだけで動きます)、Node.js 22.18 以上 (または 24.11 以上)、npm。Linux では加えて systemd (`systemd-socket-proxyd` を含む) も必要です。

1. このリポジトリを clone して、インストーラーを実行します。

   ```sh
   # Linux / macOS
   python3 wisp-launcher/portable/wisp_ondemand.py install
   ```

   ```bat
   :: Windows
   py -3 wisp-launcher\portable\wisp_ondemand.py install
   ```

   wisp-js (バージョン固定) は `~/.local/share/synthesis-spotify/wisp-js` にインストールされます (Windows は `%LOCALAPPDATA%\synthesis-spotify\wisp-js`)。`--install-dir パス` で場所を、`--node パス` で使う Node.js を、`--idle-minutes 分` でアイドル時間を変えられます。Node.js のパスはインストール時に記録されるので、Node.js を移動したり (バージョン管理ツールなどで) 入れ替えたりしたら、もう一度 `install` を実行してください。macOS では `--resident` を付けると、ソケットアクティベーションではなく常駐型のランチャーになります。

2. 削除は `uninstall` で行います (上と同じ Python コマンドの `install` を `uninstall` に変えます)。

登録される内容:

| OS | 登録先 | 常駐プロセス |
| --- | --- | --- |
| Linux | systemd のユーザーユニット (ソケットアクティベーション) | なし。6001 番ポートは systemd が保持し、最初の接続で Wisp サーバーを起動します。 |
| macOS | LaunchAgent (launchd のソケットアクティベーション) | なし。6001 番ポートは launchd が保持し、アイドルになるとランチャーも終了します。 |
| Windows | ログイン時に実行するタスクスケジューラのタスク | 小さなランチャーのプロセス。Wisp サーバーだけがオンデマンドで動きます。 |

ログ: Linux は `journalctl --user -u synthesis-spotify-wisp-backend.service -u synthesis-spotify-wisp-proxy.service` で見ます。macOS と Windows は wisp-js ディレクトリの隣に出ます (ランチャーは `wisp-ondemand.log`、Wisp サーバーは `wisp-backend.log`)。

そのほかのコマンド:

- `wisp_ondemand.py setup` は wisp-js の npm でのインストールだけを行います。
- `wisp_ondemand.py run` はランチャーをフォアグラウンドで実行します。どの OS でも使えるので、systemd を使わない Linux ではこれを使います。
- 以前のバージョンのスクリプトは libcurl.js 付属の Python 製 Wisp サーバーを使っていました。wisp-js に切り替えるには、もう一度 `install` を実行してください。古い `libcurl.js` ディレクトリは使われなくなるので削除して構いません。
- 以前の README の手順で常時起動サービス `synthesis-spotify-wisp.service` を有効にしている場合は、先に `systemctl --user disable --now synthesis-spotify-wisp.service` で無効にしてください。同じ 6001 番ポートを使うため、インストーラーは見つけるとメッセージを出して止まります。

転送、オンデマンド起動、アイドル停止は Linux で確認しています。macOS のソケットアクティベーションは Linux 上で模擬しただけで (`launch_activate_socket` の呼び出し自体は macOS が必要です)、macOS と Windows の自動起動の登録は実機では確認していません。

## 使い方

1. Spotify で普通に検索すると、検索結果ページに「Synthesis Spotify」セクションが出ます。
2. 結果にカーソルを合わせて、カバー画像の再生ボタンで再生、右側のボタンで「次に再生」「キューに追加」ができます。
3. プレイバーのキューボタンで、キュー中の YouTube 曲を確認、再生、削除できます。
4. YouTube の曲の再生中は、Spotify の再生ボタンがその曲の再生/一時停止になります(Spotify 自体は無音のままです)。次へ/前へは、キュー中の次の YouTube 曲に進み、キューが空なら Spotify に戻ります。

キューの挙動: キューに入れた YouTube の曲は、Spotify が同じ再生コンテキスト内で次の曲に移るタイミングで再生されます。Spotify で別のプレイリストやアルバムを再生し始めると、YouTube の曲は止まります。

## 設定

Spotify のプロフィールメニューから「Synthesis Spotify 設定」を開きます。

- **Wisp プロキシ:** 1 行に 1 つ、上から順に試します。既定は `ws://localhost:6001/`、次に共有の公開サーバーです。
- **InnerTube クライアント:** `visionos`、`tv_samsung` を上から順に試します。既定では PO Token は不要です。
- **接続テスト:** libcurl、セッション、検索、プレイヤーリクエスト、音声ダウンロードまでを順に試し、各ステップの結果を表示します。
- **音声キャッシュを削除:** ダウンロード済みの音声(直近の数曲をメモリにキャッシュ)を解放します。

## トラブルシューティング

上の英語セクションの表を参照してください。特に `LOGIN_REQUIRED` が出る場合は、ローカル Wisp を使っているか確認してください。クライアントのバージョンが古くなった場合は、`synthesis-spotify.js` の `CLIENT_DEFS` を yt-dlp の `INNERTUBE_CLIENTS` に合わせて更新します。

## プライバシーと免責

- YouTube へのリクエストは、設定した Wisp プロキシ経由で送られます。ローカルサーバーなら自分の PC です。共有の公開サーバーには、接続先のホスト名が見えます。
- YouTube のセッション Cookie はメモリ上にのみ保持します。
- 非公式の YouTube API を使っており、YouTube の利用規約に反する可能性があります。自己責任で使ってください。
- Spotify、Google、YouTube とは無関係です。
