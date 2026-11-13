<div align="center">
  <h1>Synthesis Spicetify</h1>
  <p>Transcending all musical boundaries.</p>
  <img src="./logo.png" alt="logo" width="300">
</div>


[![Latest Tag](https://img.shields.io/github/v/tag/kagamiomochi/Synthesis-Spicetify?sort=semver)](https://github.com/kagamiomochi/Synthesis-Spicetify/tags)

A [Spicetify](https://spicetify.app/) extension that brings YouTube Music into Spotify.

- A "Synthesis Spicetify" section with YouTube Music results appears on Spotify's search results page
- Play a result, add it to the queue, or play it next
- Queued tracks play between Spotify tracks (shown in Spotify's own queue panel)
- While a YouTube track is active, Spotify's own player bar shows it (cover, title, progress bar) and its play/pause,
  previous and next buttons control it. A small mini player is only shown if the player bar cannot be used
- Audio is downloaded into a Blob and played from a Blob URL, so there is no streaming proxy
- Playback is opt-in: without the optional local Wisp server you can still search and open results in the browser

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
- **A local Wisp server** (see below), only if you want playback. Search and "Open in browser" work without it.

### Why a local Wisp server is needed

libcurl.js sends its traffic through a Wisp proxy. TLS is terminated inside Spotify, so the proxy only sees
destination hostnames, but YouTube judges the proxy's IP address. Shared public Wisp servers run on data center
IPs, which YouTube rejects (`LOGIN_REQUIRED: Sign in to confirm you're not a bot`). Search still works through
them, playback does not. A Wisp server on your own PC uses your own IP and works. For this reason playback is off
by default, and only public Wisp proxies are used until you turn on **Enable playback** in the settings.

## Installation

### Marketplace

Open the Spicetify Marketplace in Spotify, search for "Synthesis Spicetify" and install it.

### Manual

1. Copy `synthesis-spicetify.js` into the Spicetify `Extensions` folder.
2. Run:

   ```sh
   spicetify config extensions synthesis-spicetify.js
   spicetify apply
   ```

## Setting up the local Wisp server

When you turn on **Enable playback** in the settings, the extension shows these steps and checks the connection to the
local server. Playback is enabled once the check succeeds.

The steps are the same on Linux, macOS and Windows. One script, `wisp-launcher/portable/wisp_ondemand.py`, installs
[wisp-js](https://github.com/MercuryWorkshop/wisp-js) (a Wisp server for Node.js) with npm, registers an on-demand
start with the OS and starts it. It listens on `127.0.0.1:6001`, starts the Wisp server on `127.0.0.1:6002` at the first connection,
forwards the connection, and stops the server again after 5 idle minutes. Once **Enable playback** is on,
the extension tries `ws://localhost:6001/` first, so nothing inside Spotify has to launch
anything.

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

   wisp-js (pinned to one version) is installed into `~/.local/share/synthesis-spicetify/wisp-js` (Windows:
   `%LOCALAPPDATA%\synthesis-spicetify\wisp-js`). Use `--install-dir PATH` to change it, `--node PATH` to choose the
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

Logs: on Linux, use `journalctl --user -u synthesis-spicetify-wisp-backend.service -u synthesis-spicetify-wisp-proxy.service`.
On macOS and Windows, logs are written next to the wisp-js directory (`wisp-ondemand.log` for the launcher,
`wisp-backend.log` for the Wisp server).

Other commands:

- `wisp_ondemand.py setup` only installs wisp-js with npm.
- `wisp_ondemand.py run` runs the launcher in the foreground. This works on every OS, so it is also the way to go on
  Linux without systemd.
- Older versions of this script used the Python Wisp server from libcurl.js. Run `install` again to switch to wisp-js;
  the old `libcurl.js` directory is no longer used and can be deleted.
- If an older version of this README had you enable `synthesis-spicetify-wisp.service` (the always-on service), disable it
  first with `systemctl --user disable --now synthesis-spicetify-wisp.service`. It uses port 6001 too, and the installer
  stops with a message when it finds it.

The proxy, on-demand start and idle stop were tested on Linux. The macOS socket activation was only simulated on
Linux (the `launch_activate_socket` call itself needs macOS), and the macOS and Windows autostart steps have not been
tested on real machines yet.

## Usage

1. Search in Spotify as usual. The "Synthesis Spicetify" section appears on the search results page.
2. Hover a result:
   - Play button on the cover: play now
   - "Play next" / "Add to queue" buttons on the right
3. Open Spotify's queue panel (the queue button on the playbar) to see, play or remove queued YouTube tracks.
4. While a YouTube track is active, Spotify's play button toggles play/pause of that track and Spotify itself stays
   silent. Spotify's next/previous buttons move on to the next queued YouTube track, or back to Spotify when the
   queue is empty.

Queue behavior: queued YouTube tracks play when Spotify moves to its next track within the same playback context.
Starting a different playlist or album in Spotify stops the YouTube track.

## Settings

Open the profile menu in Spotify and choose "Synthesis Spicetify settings".

- **Enable playback**: off by default. While it is off, only the public Wisp proxies below are used, so you can search
  and open results in the browser, but not play them. Turning it on shows the local Wisp setup steps and checks the
  connection to `ws://localhost:6001/`; playback is enabled once the check succeeds. Turning it off stops the current
  YouTube track and clears the queue.
- **Public Wisp proxies**: one per line, tried in order. Default: a shared public server. While playback is enabled,
  the local server `ws://localhost:6001/` is tried first.
- **InnerTube clients**: `visionos`, `tv_samsung`, tried in order. Defaults work without a PO token.
- **Connection test**: runs the whole chain (libcurl, session, search, player request, audio download) and prints
  the result of each step.
- **Clear audio cache**: frees the downloaded audio (the last few tracks are cached in memory).
- **Reset settings**: restores every setting to its default (playback off, default Wisp proxies and clients). Click it twice to confirm. Turning playback off this way stops the current YouTube track and clears the queue.

## Troubleshooting

| Message | Likely cause and fix |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | The Wisp proxy's IP is flagged. Turn on **Enable playback** in the settings and set up a local Wisp server. |
| `No usable Wisp server` | No Wisp server is reachable. If playback is enabled, start the local server; otherwise check your network and the public Wisp URL in the settings. |
| libcurl step fails right at the start | Spotify's CSP may be blocking WASM or the jsDelivr import. |
| `EvalError` / CSP error in the player step | Spotify blocked `eval`, which is needed to decipher some stream URLs. Use `visionos` only. |
| `player request failed: HTTP 400/403` or `LOGIN_REQUIRED` on a local Wisp | The client definitions are outdated. Update `CLIENT_DEFS` in `synthesis-spicetify.js` from `INNERTUBE_CLIENTS` in yt-dlp (`yt_dlp/extractor/youtube/_base.py`). |

## Privacy and disclaimer

- Requests to YouTube go through a Wisp proxy. Until you enable playback this is a shared public server, which sees
  which hostnames you connect to (TLS is terminated inside Spotify). With playback enabled and a local server it is
  your own machine.
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

- Spotify の検索結果ページに、YouTube Music の結果を「Synthesis Spicetify」セクションとして表示
- 結果から再生、次に再生、キューに追加
- キューに入れた曲は Spotify の曲の間に挟まって再生(プレイバーのキューボタンで確認)
- YouTube の曲の再生中は、Spotify 本体のプレイヤーバー(カバー・曲名・シークバー)にその曲を表示し、
  再生/一時停止・前へ・次へボタンでそのまま操作できます。プレイヤーバーを使えない場合だけ、小さなミニプレイヤーを表示します
- 音声は Blob にダウンロードして Blob URL で再生するため、ストリーミング用のプロキシは不要
- 再生機能は任意でオンにする方式です。ローカル Wisp サーバーが無くても、検索と「ブラウザで開く」は使えます

対応サービスは現在 YouTube Music(YouTube)のみです。今後ほかのサービスにも対応する予定です。

[English](#synthesis-spicetify)

## 仕組み

| 部分 | ライブラリ |
| --- | --- |
| YouTube Music の検索 | [YouTube.js](https://github.com/LuanRT/YouTube.js) (youtubei.js) |
| CORS を回避するリクエスト | [libcurl.js](https://github.com/ading2210/libcurl.js) (WASM 版 libcurl) を Wisp WebSocket プロキシ経由で使用 |
| 再生 | 音声を `Blob` にダウンロードし、`URL.createObjectURL` で再生 |

プレイヤーリクエスト(クライアント定義、ヘッダー、Cookie)は yt-dlp と同じ方法で組み立てています。YouTube.js がアプリ系クライアント向けに送るリクエストの形は、現在「Sign in to confirm you're not a bot」で拒否されるためです。

どちらのライブラリも初回利用時に jsDelivr から読み込みます (バージョン固定: libcurl.js 0.7.5、youtubei.js 18.3.0)。

## 必要なもの

- Spicetify(Spotify デスクトップアプリ)
- **ローカルの Wisp サーバー**(再生したい場合のみ。検索と「ブラウザで開く」は無くても使えます)

### ローカル Wisp が必要な理由

libcurl.js は Wisp プロキシ経由で通信します。TLS は Spotify 内で終端されるので、プロキシには接続先のホスト名しか見えません。ただ、YouTube はプロキシの IP アドレスで判定します。公開されている共有 Wisp サーバーはデータセンターの IP で動いていて、YouTube に弾かれます(`LOGIN_REQUIRED: Sign in to confirm you're not a bot`)。検索は通りますが、再生はできません。自分の PC で動かす Wisp なら自分の IP が使われるので、再生できます。このため、設定で「再生機能を有効化」をオンにするまでは再生機能はオフで、公開 Wisp だけを使います。

## インストール

### Marketplace
Spotify の Spicetify Marketplace で「Synthesis Spicetify」を検索してインストールします。

### 手動
`synthesis-spicetify.js` を Spicetify の `Extensions` フォルダに置き、次を実行します。

  ```sh
  spicetify config extensions synthesis-spicetify.js
  spicetify apply
  ```

## ローカル Wisp サーバーの用意

設定で「再生機能を有効化」をオンにすると、拡張がこの手順を表示し、ローカルサーバーへの接続を確認します。確認できると再生機能が有効になります。

手順は Linux、macOS、Windows で共通です。`wisp-launcher/portable/wisp_ondemand.py` という 1 つのスクリプトが、[wisp-js](https://github.com/MercuryWorkshop/wisp-js) (Node.js 製の Wisp サーバー) の npm でのインストール、OS へのオンデマンド起動の登録、起動までを行います。`127.0.0.1:6001` で待ち受け、最初の接続で Wisp サーバーを `127.0.0.1:6002` に起動して接続を転送し、5 分間アイドルになるとサーバーを止めます。「再生機能を有効化」がオンの間、拡張は `ws://localhost:6001/` を最初に試すので、Spotify の中から何かを起動する必要はありません。

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

   wisp-js (バージョン固定) は `~/.local/share/synthesis-spicetify/wisp-js` にインストールされます (Windows は `%LOCALAPPDATA%\synthesis-spicetify\wisp-js`)。`--install-dir パス` で場所を、`--node パス` で使う Node.js を、`--idle-minutes 分` でアイドル時間を変えられます。Node.js のパスはインストール時に記録されるので、Node.js を移動したり (バージョン管理ツールなどで) 入れ替えたりしたら、もう一度 `install` を実行してください。macOS では `--resident` を付けると、ソケットアクティベーションではなく常駐型のランチャーになります。

2. 削除は `uninstall` で行います (上と同じ Python コマンドの `install` を `uninstall` に変えます)。

登録される内容:

| OS | 登録先 | 常駐プロセス |
| --- | --- | --- |
| Linux | systemd のユーザーユニット (ソケットアクティベーション) | なし。6001 番ポートは systemd が保持し、最初の接続で Wisp サーバーを起動します。 |
| macOS | LaunchAgent (launchd のソケットアクティベーション) | なし。6001 番ポートは launchd が保持し、アイドルになるとランチャーも終了します。 |
| Windows | ログイン時に実行するタスクスケジューラのタスク | 小さなランチャーのプロセス。Wisp サーバーだけがオンデマンドで動きます。 |

ログ: Linux は `journalctl --user -u synthesis-spicetify-wisp-backend.service -u synthesis-spicetify-wisp-proxy.service` で見ます。macOS と Windows は wisp-js ディレクトリの隣に出ます (ランチャーは `wisp-ondemand.log`、Wisp サーバーは `wisp-backend.log`)。

そのほかのコマンド:

- `wisp_ondemand.py setup` は wisp-js の npm でのインストールだけを行います。
- `wisp_ondemand.py run` はランチャーをフォアグラウンドで実行します。どの OS でも使えるので、systemd を使わない Linux ではこれを使います。
- 以前のバージョンのスクリプトは libcurl.js 付属の Python 製 Wisp サーバーを使っていました。wisp-js に切り替えるには、もう一度 `install` を実行してください。古い `libcurl.js` ディレクトリは使われなくなるので削除して構いません。
- 以前の README の手順で常時起動サービス `synthesis-spicetify-wisp.service` を有効にしている場合は、先に `systemctl --user disable --now synthesis-spicetify-wisp.service` で無効にしてください。同じ 6001 番ポートを使うため、インストーラーは見つけるとメッセージを出して止まります。

転送、オンデマンド起動、アイドル停止は Linux で確認しています。macOS のソケットアクティベーションは Linux 上で模擬しただけで (`launch_activate_socket` の呼び出し自体は macOS が必要です)、macOS と Windows の自動起動の登録は実機では確認していません。

## 使い方

1. Spotify で普通に検索すると、検索結果ページに「Synthesis Spicetify」セクションが出ます。
2. 結果にカーソルを合わせて、カバー画像の再生ボタンで再生、右側のボタンで「次に再生」「キューに追加」ができます。
3. プレイバーのキューボタンで、キュー中の YouTube 曲を確認、再生、削除できます。
4. YouTube の曲の再生中は、Spotify の再生ボタンがその曲の再生/一時停止になります(Spotify 自体は無音のままです)。次へ/前へは、キュー中の次の YouTube 曲に進み、キューが空なら Spotify に戻ります。

キューの挙動: キューに入れた YouTube の曲は、Spotify が同じ再生コンテキスト内で次の曲に移るタイミングで再生されます。Spotify で別のプレイリストやアルバムを再生し始めると、YouTube の曲は止まります。

## 設定

Spotify のプロフィールメニューから「Synthesis Spicetify 設定」を開きます。

- **再生機能を有効化:** 既定はオフです。オフの間は下の公開 Wisp プロキシだけを使い、検索結果の表示と「ブラウザで開く」のみ使えます (再生はできません)。オンにしようとするとローカル Wisp のセットアップ手順を表示し、`ws://localhost:6001/` への接続を確認します。確認できると有効になります。オフにすると、再生中の YouTube の曲を止めてキューを空にします。
- **公開 Wisp プロキシ:** 1 行に 1 つ、上から順に試します。既定は共有の公開サーバーです。再生機能がオンの間は、ローカルの `ws://localhost:6001/` を最初に試します。
- **InnerTube クライアント:** `visionos`、`tv_samsung` を上から順に試します。既定では PO Token は不要です。
- **接続テスト:** libcurl、セッション、検索、プレイヤーリクエスト、音声ダウンロードまでを順に試し、各ステップの結果を表示します。
- **音声キャッシュを削除:** ダウンロード済みの音声(直近の数曲をメモリにキャッシュ)を解放します。
- **設定をリセット:** すべての設定を初期値(再生機能オフ、既定の Wisp プロキシとクライアント)に戻します。確認のため 2 回押す必要があります。再生機能がオンだった場合は、再生中の YouTube の曲を止めてキューを空にします。

## トラブルシューティング

| メッセージ | 考えられる原因と対処 |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | Wisp プロキシの IP が弾かれています。設定で「再生機能を有効化」をオンにして、ローカル Wisp サーバーを用意してください。 |
| `No usable Wisp server` | 使える Wisp サーバーがありません。再生機能がオンならローカルサーバーを起動してください。オフなら、ネットワークと設定の公開 Wisp の URL を確認してください。 |
| libcurl のステップが最初で失敗する | Spotify の CSP が WASM や jsDelivr からの import をブロックしている可能性があります。 |
| プレイヤーのステップで `EvalError` / CSP エラー | 一部のストリーム URL の復号に必要な `eval` を Spotify がブロックしています。`visionos` だけを使ってください。 |
| ローカル Wisp で `player request failed: HTTP 400/403` または `LOGIN_REQUIRED` | クライアント定義が古くなっています。`synthesis-spicetify.js` の `CLIENT_DEFS` を、yt-dlp の `INNERTUBE_CLIENTS` (`yt_dlp/extractor/youtube/_base.py`) に合わせて更新してください。 |

## プライバシーと免責

- YouTube へのリクエストは Wisp プロキシ経由で送られます。再生機能をオンにするまでは共有の公開サーバーで、接続先のホスト名が見えます。再生機能をオンにしてローカルサーバーを使う場合は自分の PC です。
- YouTube のセッション Cookie はメモリ上にのみ保持します。
- 非公式の YouTube API を使っており、YouTube の利用規約に反する可能性があります。自己責任で使ってください。
- Spotify、Google、YouTube とは無関係です。

## クレジット

- [YouTube.js](https://github.com/LuanRT/YouTube.js) (LuanRT)
- [libcurl.js](https://github.com/ading2210/libcurl.js) (ading2210)
- [wisp-js](https://github.com/MercuryWorkshop/wisp-js) (MercuryWorkshop、ローカル Wisp サーバー)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (プレイヤーリクエストの参照元として、そのクライアント定義を利用)
