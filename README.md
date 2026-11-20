<div align="center">
  <h1>Synthesis Spicetify</h1>
  <p>Transcending all musical boundaries.</p>
  <img src="./logo.png" alt="logo" width="300">
</div>


[![Latest Version](https://img.shields.io/github/v/tag/kagamiomochi/Synthesis-Spicetify?sort=semver)](https://github.com/kagamiomochi/Synthesis-Spicetify/tags)

A [Spicetify](https://spicetify.app/) extension that brings YouTube Music into Spotify.

Currently supported service: YouTube Music (YouTube). More services are planned.

[Japanese / 日本語](#日本語) | [Technical details](#technical-details)

## Features

- Spotify's search results page gets "Spotify" and "YouTube Music" tabs, so you can switch between the standard results and the YouTube Music results
- Play a result, add it to the queue, or play it next
- Every YouTube track goes through a silent local file, so it plays, queues and saves like a normal Spotify track (see [How playback works](#how-playback-works))
- While a YouTube track is active, Spotify's own player bar shows it (cover, title). Spotify plays the silent placeholder as the clock of the track and the audio follows it, so the progress bar, play/pause, previous / next, repeat and shuffle all work natively. A small mini player is only shown if the player bar cannot be used
- Save tracks to your Spotify playlists (see [Saving tracks to playlists](#saving-tracks-to-playlists))
- Playback is opt-in: without the optional local Wisp server you can still search and open results in the browser

## Requirements

- Spicetify (with the Spotify desktop app)
- **A local Wisp server**, only if you want playback. Search and "Open in browser" work without it.
  See [Enabling playback](#enabling-playback).

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

## Enabling playback

Playback is off by default. To turn it on you need a small proxy server (Wisp) running on your own PC, because YouTube
rejects the shared public proxies (see [Why a local Wisp server is needed](#why-a-local-wisp-server-is-needed)).
Search and "Open in browser" keep working without it.

When you turn on **Enable playback** in the settings, the extension shows these steps and checks the connection to the
local server. Playback is enabled once the check succeeds.

The steps are the same on Linux, macOS and Windows. One script, `wisp-launcher/portable/wisp_ondemand.py`, installs
[wisp-js](https://github.com/MercuryWorkshop/wisp-js) (a Wisp server for Node.js) with npm, registers an on-demand
start with the OS and starts it. The server starts when it is needed and stops again after 5 idle minutes, so nothing
inside Spotify (or by hand) has to launch anything.

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

   The Node.js path is recorded at install time, so run `install` again after you move or replace Node.js (for example
   with a version manager).

2. Remove it with `uninstall` (same Python command as above, with `uninstall` instead of `install`).

Install options, the other commands and upgrade notes are in [Local Wisp launcher](#local-wisp-launcher).
If something does not work, see [Troubleshooting](#troubleshooting).

## Usage

1. Search in Spotify as usual. "Spotify" and "YouTube Music" tabs appear at the top of the search results page. Spotify's own results are shown by default; click the "YouTube Music" tab to switch to the YouTube Music results (and back). The selected tab is kept while you change the search query.
2. Hover a result:
   - Play button on the cover: play now
   - "Play next" / "Add to queue" buttons on the right
3. Queued YouTube tracks appear in Spotify's own queue panel and can be reordered or removed there.
4. While a YouTube track is active, Spotify's play button toggles play/pause of that track and Spotify itself stays
   silent. Spotify's next/previous buttons move to the next/previous item of Spotify's queue or playlist, whether it is
   a YouTube track or a Spotify track.

### How playback works

Spotify's player, queue and playlists can only hold Spotify tracks and local files. So when you play or queue a result, the extension makes a silent local file for it (the artist \"YouTube\", the album \"Synthesis\", the video ID as the title) and hands that file to Spotify like any other local track. When Spotify starts it, the extension pauses Spotify and streams the real track instead. When the track ends, Spotify moves on to whatever follows it.

This needs the same folder setup as saving to playlists (below). The first time you play or queue a result, choose the folder in the dialog. Playlist saving, the queue and plain playback all use the same files, and the files are kept in the folder (about 2 KB per second of track length); delete the ones you no longer need, except those that are in your playlists.

### Saving tracks to playlists

The playlist button on a result saves the track to one of your Spotify playlists. A Spotify playlist can only hold Spotify tracks and local files, so each saved track is stored as a silent local file (the same file that playing uses), and when Spotify starts it, the extension pauses Spotify and plays the real track from YouTube Music instead.

1. Turning on playback also turns on Spotify's Local Files. A folder dialog asks for the placeholder folder once, and the extension adds it as a Local Files source (you can also add one yourself in Spotify's settings).
2. Click the playlist button on a result and pick a playlist. The first time, choose that same folder in the dialog. It is remembered afterwards; if a permission prompt appears again, allow it.
3. The track shows up in the playlist as the artist "YouTube" and the album "Synthesis", with only its video ID as the title. The placeholder file holds no other song information (the title and thumbnail shown while playing are kept in the extension data, not in the file). Inside Spotify, the extension rewrites the displayed text of these rows (and of the queue, the now playing panel and the player bar) to the real title and artist, and lays the real cover art over the placeholder icon; the file and Spotify's data are not changed. If the extension data is missing, the title and artist are looked up from YouTube instead. Playing it streams the real track, and when it ends the playlist moves on to the next item.

Notes: playback must be enabled. The placeholders are local files, so saved tracks only play on the PC that has the folder, not on other devices. If a placeholder file is deleted from the folder, its playlist row becomes unplayable.

## Settings

Open the profile menu in Spotify and choose "Synthesis Spicetify settings".

- **Enable playback**: off by default. While it is off, only the public Wisp proxies below are used, so you can search
  and open results in the browser, but not play them. Turning it on shows the local Wisp setup steps and checks the
  connection to `ws://localhost:6001/`; playback is enabled once the check succeeds. Turning it off stops the current
  YouTube track.
- **Public Wisp proxies**: one per line, tried in order. Default: a shared public server. While playback is enabled,
  the local server `ws://localhost:6001/` is tried first.
- **InnerTube clients**: `visionos`, `tv_samsung`, tried in order. Defaults work without a PO token.
- **Connection test**: runs the whole chain (libcurl, session, search, player request, audio download) and prints
  the result of each step.
- **Clear audio cache**: frees the downloaded audio (the last few tracks are cached in memory).
- **Reset settings**: restores every setting to its default (playback off, default Wisp proxies and clients). Click it twice to confirm. Turning playback off this way stops the current YouTube track.

## Troubleshooting

Run the **Connection test** in the settings first; it shows which step fails.

| Message | Likely cause and fix |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | The Wisp proxy's IP is flagged. Turn on **Enable playback** in the settings and set up a local Wisp server. |
| `No usable Wisp server` | No Wisp server is reachable. If playback is enabled, start the local server; otherwise check your network and the public Wisp URL in the settings. |
| libcurl step fails right at the start | Spotify's CSP may be blocking WASM or the jsDelivr import. |
| `EvalError` / CSP error in the player step | Spotify blocked `eval`, which is needed to decipher some stream URLs. Use `visionos` only. |
| `player request failed: HTTP 400/403` or `LOGIN_REQUIRED` on a local Wisp | The client definitions are outdated. Update `CLIENT_DEFS` in `synthesis-spicetify.js` from `INNERTUBE_CLIENTS` in yt-dlp (`yt_dlp/extractor/youtube/_base.py`). See [Updating client definitions](#updating-client-definitions). |

Local Wisp server logs: on Linux, use `journalctl --user -u synthesis-spicetify-wisp-backend.service -u synthesis-spicetify-wisp-proxy.service`.
On macOS and Windows, logs are written next to the wisp-js directory (`wisp-ondemand.log` for the launcher,
`wisp-backend.log` for the Wisp server).

## Privacy and disclaimer

- Requests to YouTube go through a Wisp proxy. Until you enable playback this is a shared public server, which sees
  which hostnames you connect to (TLS is terminated inside Spotify). With playback enabled and a local server it is
  your own machine.
- Session cookies from YouTube are kept in memory only.
- This extension uses unofficial YouTube APIs and may violate YouTube's Terms of Service. Use it at your own risk.
- Not affiliated with Spotify, Google or YouTube.

---

## Technical details

### How it works

| Part | Library |
| --- | --- |
| YouTube Music search | [YouTube.js](https://github.com/LuanRT/YouTube.js) (youtubei.js) |
| Requests that bypass CORS | [libcurl.js](https://github.com/ading2210/libcurl.js) (WASM libcurl) over a Wisp WebSocket proxy |
| Playback | Chunks are appended to a `MediaSource` while downloading (progressive playback); the finished `Blob` is cached and used as the fallback |

The player request (client definitions, headers, cookies) is built the same way yt-dlp does it, because the
request shape YouTube.js sends for app clients is currently rejected with "Sign in to confirm you're not a bot".

Both libraries are loaded from jsDelivr on first use (pinned versions: libcurl.js 0.7.5, youtubei.js 18.3.0).

### Playback pipeline

Audio is downloaded in chunks and played progressively through Media Source Extensions (playback starts before the
download finishes). The finished download is cached as a Blob URL, so there is no streaming proxy. The last few
tracks are kept in the in-memory cache (see **Clear audio cache** in the settings).

### Why a local Wisp server is needed

libcurl.js sends its traffic through a Wisp proxy. TLS is terminated inside Spotify, so the proxy only sees
destination hostnames, but YouTube judges the proxy's IP address. Shared public Wisp servers run on data center
IPs, which YouTube rejects (`LOGIN_REQUIRED: Sign in to confirm you're not a bot`). Search still works through
them, playback does not. A Wisp server on your own PC uses your own IP and works. For this reason playback is off
by default, and only public Wisp proxies are used until you turn on **Enable playback** in the settings.

### Local Wisp launcher

`wisp-launcher/portable/wisp_ondemand.py` listens on `127.0.0.1:6001`, starts the Wisp server (wisp-js) on
`127.0.0.1:6002` at the first connection, forwards the connection, and stops the server again after 5 idle minutes.
While **Enable playback** is on, the extension tries `ws://localhost:6001/` first.

wisp-js (pinned to one version) is installed into `~/.local/share/synthesis-spicetify/wisp-js` (Windows:
`%LOCALAPPDATA%\synthesis-spicetify\wisp-js`).

Install options:

- `--install-dir PATH` changes the install location.
- `--node PATH` chooses the Node.js binary.
- `--idle-minutes N` changes the idle time.
- `--resident` (macOS) keeps a resident launcher instead of using socket activation.

What gets registered:

| OS | Registered as | Resident process |
| --- | --- | --- |
| Linux | systemd user units (socket activation) | None. systemd owns port 6001 and starts the Wisp server on the first connection. |
| macOS | LaunchAgent (launchd socket activation) | None. launchd owns port 6001, and the launcher exits again when idle. |
| Windows | Scheduled task that runs at login | A small launcher process. Only the Wisp server runs on demand. |

Other commands:

- `wisp_ondemand.py setup` only installs wisp-js with npm.
- `wisp_ondemand.py run` runs the launcher in the foreground. This works on every OS, so it is also the way to go on
  Linux without systemd.

Test status: the proxy, on-demand start and idle stop were tested on Linux. The macOS socket activation was only
simulated on Linux (the `launch_activate_socket` call itself needs macOS), and the macOS and Windows autostart steps
have not been tested on real machines yet.

#### Migrating from older versions

- Older versions of this script used the Python Wisp server from libcurl.js. Run `install` again to switch to wisp-js;
  the old `libcurl.js` directory is no longer used and can be deleted.
- If an older version of this README had you enable `synthesis-spicetify-wisp.service` (the always-on service), disable it
  first with `systemctl --user disable --now synthesis-spicetify-wisp.service`. It uses port 6001 too, and the installer
  stops with a message when it finds it.

### Updating client definitions

When YouTube changes what it accepts, the player request starts failing with `HTTP 400/403` or `LOGIN_REQUIRED` even on
a local Wisp server. Update `CLIENT_DEFS` in `synthesis-spicetify.js` from `INNERTUBE_CLIENTS` in yt-dlp
(`yt_dlp/extractor/youtube/_base.py`).

## Credits

- [YouTube.js](https://github.com/LuanRT/YouTube.js) by LuanRT
- [libcurl.js](https://github.com/ading2210/libcurl.js) by ading2210
- [wisp-js](https://github.com/MercuryWorkshop/wisp-js) by MercuryWorkshop (the local Wisp server)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp), whose client definitions are used as the reference for the player request

---

# 日本語

Spotify に YouTube Music を統合する [Spicetify](https://spicetify.app/) 拡張機能です。

対応サービスは現在 YouTube Music(YouTube)のみです。今後ほかのサービスにも対応する予定です。

[English](#synthesis-spicetify) | [技術的な詳細](#技術的な詳細)

## 機能

- Spotify の検索結果ページに「Spotify」「YouTube Music」のタブを追加し、標準の検索結果と YouTube Music の結果をタブで切り替えて表示
- 結果から再生、次に再生、キューに追加
- YouTube の曲はすべて無音のローカルファイル経由で扱うため、Spotify の曲と同じように再生・キュー・プレイリスト保存ができます([ダミー曲を経由した再生](#ダミー曲を経由した再生)を参照)
- YouTube の曲の再生中は、Spotify 本体のプレイヤーバー(カバー・曲名)にその曲を表示します。Spotify が無音のダミー曲を「時計」として再生し、実際の音声がそれに追従するため、シークバー・再生/一時停止・前へ/次へ・リピート・シャッフルがそのまま動きます。プレイヤーバーを使えない場合だけ、小さなミニプレイヤーを表示します
- Spotify のプレイリストに曲を保存可能([プレイリストに保存する](#プレイリストに保存する)を参照)
- 再生機能は任意でオンにする方式です。ローカル Wisp サーバーが無くても、検索と「ブラウザで開く」は使えます

## 必要なもの

- Spicetify(Spotify デスクトップアプリ)
- **ローカルの Wisp サーバー**(再生したい場合のみ。検索と「ブラウザで開く」は無くても使えます)。
  [再生機能を有効にする](#再生機能を有効にする)を参照してください。

## インストール

### Marketplace
Spotify の Spicetify Marketplace で「Synthesis Spicetify」を検索してインストールします。

### 手動
`synthesis-spicetify.js` を Spicetify の `Extensions` フォルダに置き、次を実行します。

  ```sh
  spicetify config extensions synthesis-spicetify.js
  spicetify apply
  ```

## 再生機能を有効にする

再生機能は既定でオフです。オンにするには、自分の PC 上で小さなプロキシサーバー(Wisp)を動かす必要があります。共有の公開プロキシは
YouTube に弾かれるためです([ローカル Wisp が必要な理由](#ローカル-wisp-が必要な理由)を参照)。
検索と「ブラウザで開く」は、サーバーが無くても使えます。

設定で「再生機能を有効化」をオンにすると、拡張がこの手順を表示し、ローカルサーバーへの接続を確認します。確認できると再生機能が有効になります。

手順は Linux、macOS、Windows で共通です。`wisp-launcher/portable/wisp_ondemand.py` という 1 つのスクリプトが、[wisp-js](https://github.com/MercuryWorkshop/wisp-js) (Node.js 製の Wisp サーバー) の npm でのインストール、OS へのオンデマンド起動の登録、起動までを行います。サーバーは必要になったときに起動し、5 分間アイドルになると止まるので、Spotify の中でも手動でも何かを起動する必要はありません。

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

   Node.js のパスはインストール時に記録されるので、Node.js を移動したり (バージョン管理ツールなどで) 入れ替えたりしたら、もう一度 `install` を実行してください。

2. 削除は `uninstall` で行います (上と同じ Python コマンドの `install` を `uninstall` に変えます)。

インストールのオプション、そのほかのコマンド、旧バージョンからの移行は[ローカル Wisp ランチャー](#ローカル-wisp-ランチャー)にあります。
うまく動かないときは[トラブルシューティング](#トラブルシューティング)を見てください。

## 使い方

1. Spotify で普通に検索すると、検索結果ページの上部に「Spotify」「YouTube Music」のタブが出ます。初期表示は Spotify の標準の検索結果で、「YouTube Music」タブをクリックすると YouTube Music の結果に切り替わります(「Spotify」タブで元に戻せます)。選んだタブは、検索ワードを変えても維持されます。
2. 結果にカーソルを合わせて、カバー画像の再生ボタンで再生、右側のボタンで「次に再生」「キューに追加」ができます。
3. キューに入れた YouTube の曲は Spotify 標準のキューパネルに並び、そこで並べ替えや削除ができます。
4. YouTube の曲の再生中は、Spotify の再生ボタンがその曲の再生/一時停止になります(Spotify 自体は無音のままです)。次へ/前へは、YouTube の曲か Spotify の曲かを問わず、Spotify のキューやプレイリストの次/前の曲に進みます。

### ダミー曲を経由した再生

Spotify のプレイヤー、キュー、プレイリストには、Spotify の曲とローカルファイルしか入れられません。そのため、結果を再生またはキューに追加するときは、その曲用の無音のローカルファイル(アーティスト「YouTube」、アルバム「Synthesis」、曲名は動画 ID)を作り、ほかのローカル曲と同じように Spotify に渡します。Spotify がそのファイルを再生し始めると、拡張機能が Spotify を一時停止し、代わりに実際の曲を再生します。曲が終わると、Spotify はそのファイルの次の曲に進みます。

プレイリストへの保存と同じフォルダの設定が必要です(下記)。初めて再生またはキュー追加をするときに、ダイアログでフォルダを選んでください。再生、キュー、プレイリスト保存は同じファイルを使い、ファイルはフォルダに残ります(曲の長さ 1 秒あたり約 2 KB)。不要なものは、プレイリストに入れているもの以外なら削除して構いません。

### プレイリストに保存する

結果のプレイリストボタンで、曲を Spotify のプレイリストに保存できます。Spotify のプレイリストには Spotify の曲とローカルファイルしか入れられないため、保存した曲は無音のローカルファイル(ダミー曲。再生にも同じファイルを使います)として入れます。Spotify がそのダミー曲を再生し始めると、拡張機能が Spotify を一時停止し、代わりに YouTube Music の実際の曲を再生します。

1. 再生機能をオンにすると、Spotify のローカルファイルも自動で有効になります。フォルダ選択のダイアログが一度出るので、ダミー曲を置くフォルダを選ぶと、拡張機能がローカルファイルのソースに追加します(Spotify の設定で自分で追加しても構いません)。
2. 結果のプレイリストボタンを押してプレイリストを選びます。初回はダイアログで同じフォルダを選んでください。以降は記憶されます。権限の確認が再び出たら許可してください。
3. プレイリストには、アーティスト「YouTube」、アルバム「Synthesis」、曲名が動画 ID だけの曲として並びます。ダミー曲のファイルには、これ以外の曲の情報は入りません(再生中に表示する曲名やサムネイルは、ファイルではなく拡張機能のデータに保存されます)。Spotify 上の表示だけは、拡張機能がこれらの行(キュー、再生中パネル、プレイヤーバーも含む)の文字を本物の曲名とアーティスト名に書き換え、プレースホルダのアイコンの上に本物のアルバムアートを重ねて表示します。ファイルや Spotify のデータは変更しません。拡張機能のデータが無い場合は、YouTube から曲名とアーティスト名を取得します。再生すると実際の曲が流れ、終わるとプレイリストの次の曲に進みます。

注意: 再生機能が有効である必要があります。ダミー曲はローカルファイルなので、保存した曲はそのフォルダがある PC でだけ再生でき、他のデバイスでは再生できません。フォルダからダミー曲のファイルを消すと、そのプレイリストの行は再生できなくなります。

## 設定

Spotify のプロフィールメニューから「Synthesis Spicetify 設定」を開きます。

- **再生機能を有効化:** 既定はオフです。オフの間は下の公開 Wisp プロキシだけを使い、検索結果の表示と「ブラウザで開く」のみ使えます (再生はできません)。オンにしようとするとローカル Wisp のセットアップ手順を表示し、`ws://localhost:6001/` への接続を確認します。確認できると有効になります。オフにすると、再生中の YouTube の曲を止めます。
- **公開 Wisp プロキシ:** 1 行に 1 つ、上から順に試します。既定は共有の公開サーバーです。再生機能がオンの間は、ローカルの `ws://localhost:6001/` を最初に試します。
- **InnerTube クライアント:** `visionos`、`tv_samsung` を上から順に試します。既定では PO Token は不要です。
- **接続テスト:** libcurl、セッション、検索、プレイヤーリクエスト、音声ダウンロードまでを順に試し、各ステップの結果を表示します。
- **音声キャッシュを削除:** ダウンロード済みの音声(直近の数曲をメモリにキャッシュ)を解放します。
- **設定をリセット:** すべての設定を初期値(再生機能オフ、既定の Wisp プロキシとクライアント)に戻します。確認のため 2 回押す必要があります。再生機能がオンだった場合は、再生中の YouTube の曲を止めます。

## トラブルシューティング

まず設定の**接続テスト**を実行すると、どのステップで失敗しているかが分かります。

| メッセージ | 考えられる原因と対処 |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | Wisp プロキシの IP が弾かれています。設定で「再生機能を有効化」をオンにして、ローカル Wisp サーバーを用意してください。 |
| `No usable Wisp server` | 使える Wisp サーバーがありません。再生機能がオンならローカルサーバーを起動してください。オフなら、ネットワークと設定の公開 Wisp の URL を確認してください。 |
| libcurl のステップが最初で失敗する | Spotify の CSP が WASM や jsDelivr からの import をブロックしている可能性があります。 |
| プレイヤーのステップで `EvalError` / CSP エラー | 一部のストリーム URL の復号に必要な `eval` を Spotify がブロックしています。`visionos` だけを使ってください。 |
| ローカル Wisp で `player request failed: HTTP 400/403` または `LOGIN_REQUIRED` | クライアント定義が古くなっています。`synthesis-spicetify.js` の `CLIENT_DEFS` を、yt-dlp の `INNERTUBE_CLIENTS` (`yt_dlp/extractor/youtube/_base.py`) に合わせて更新してください。[クライアント定義の更新](#クライアント定義の更新)を参照。 |

ローカル Wisp サーバーのログ: Linux は `journalctl --user -u synthesis-spicetify-wisp-backend.service -u synthesis-spicetify-wisp-proxy.service` で見ます。macOS と Windows は wisp-js ディレクトリの隣に出ます (ランチャーは `wisp-ondemand.log`、Wisp サーバーは `wisp-backend.log`)。

## プライバシーと免責

- YouTube へのリクエストは Wisp プロキシ経由で送られます。再生機能をオンにするまでは共有の公開サーバーで、接続先のホスト名が見えます。再生機能をオンにしてローカルサーバーを使う場合は自分の PC です。
- YouTube のセッション Cookie はメモリ上にのみ保持します。
- 非公式の YouTube API を使っており、YouTube の利用規約に反する可能性があります。自己責任で使ってください。
- Spotify、Google、YouTube とは無関係です。

---

## 技術的な詳細

### 仕組み

| 部分 | ライブラリ |
| --- | --- |
| YouTube Music の検索 | [YouTube.js](https://github.com/LuanRT/YouTube.js) (youtubei.js) |
| CORS を回避するリクエスト | [libcurl.js](https://github.com/ading2210/libcurl.js) (WASM 版 libcurl) を Wisp WebSocket プロキシ経由で使用 |
| 再生 | ダウンロード中のチャンクを `MediaSource` に追加して逐次再生。完了した `Blob` はキャッシュとフォールバックに使用 |

プレイヤーリクエスト(クライアント定義、ヘッダー、Cookie)は yt-dlp と同じ方法で組み立てています。YouTube.js がアプリ系クライアント向けに送るリクエストの形は、現在「Sign in to confirm you're not a bot」で拒否されるためです。

どちらのライブラリも初回利用時に jsDelivr から読み込みます (バージョン固定: libcurl.js 0.7.5、youtubei.js 18.3.0)。

### 再生の仕組み

音声はチャンクごとにダウンロードしながら Media Source Extensions で逐次再生します(ダウンロード完了を待たずに再生開始)。完了後は Blob URL としてキャッシュするため、ストリーミング用のプロキシは不要です。直近の数曲はメモリ上にキャッシュされます(設定の「音声キャッシュを削除」で解放できます)。

### ローカル Wisp が必要な理由

libcurl.js は Wisp プロキシ経由で通信します。TLS は Spotify 内で終端されるので、プロキシには接続先のホスト名しか見えません。ただ、YouTube はプロキシの IP アドレスで判定します。公開されている共有 Wisp サーバーはデータセンターの IP で動いていて、YouTube に弾かれます(`LOGIN_REQUIRED: Sign in to confirm you're not a bot`)。検索は通りますが、再生はできません。自分の PC で動かす Wisp なら自分の IP が使われるので、再生できます。このため、設定で「再生機能を有効化」をオンにするまでは再生機能はオフで、公開 Wisp だけを使います。

### ローカル Wisp ランチャー

`wisp-launcher/portable/wisp_ondemand.py` は `127.0.0.1:6001` で待ち受け、最初の接続で Wisp サーバー (wisp-js) を `127.0.0.1:6002` に起動して接続を転送し、5 分間アイドルになるとサーバーを止めます。「再生機能を有効化」がオンの間、拡張は `ws://localhost:6001/` を最初に試します。

wisp-js (バージョン固定) は `~/.local/share/synthesis-spicetify/wisp-js` にインストールされます (Windows は `%LOCALAPPDATA%\synthesis-spicetify\wisp-js`)。

インストールのオプション:

- `--install-dir パス` でインストール先を変えられます。
- `--node パス` で使う Node.js を指定できます。
- `--idle-minutes 分` でアイドル時間を変えられます。
- `--resident` (macOS) を付けると、ソケットアクティベーションではなく常駐型のランチャーになります。

登録される内容:

| OS | 登録先 | 常駐プロセス |
| --- | --- | --- |
| Linux | systemd のユーザーユニット (ソケットアクティベーション) | なし。6001 番ポートは systemd が保持し、最初の接続で Wisp サーバーを起動します。 |
| macOS | LaunchAgent (launchd のソケットアクティベーション) | なし。6001 番ポートは launchd が保持し、アイドルになるとランチャーも終了します。 |
| Windows | ログイン時に実行するタスクスケジューラのタスク | 小さなランチャーのプロセス。Wisp サーバーだけがオンデマンドで動きます。 |

そのほかのコマンド:

- `wisp_ondemand.py setup` は wisp-js の npm でのインストールだけを行います。
- `wisp_ondemand.py run` はランチャーをフォアグラウンドで実行します。どの OS でも使えるので、systemd を使わない Linux ではこれを使います。

動作確認の状況: 転送、オンデマンド起動、アイドル停止は Linux で確認しています。macOS のソケットアクティベーションは Linux 上で模擬しただけで (`launch_activate_socket` の呼び出し自体は macOS が必要です)、macOS と Windows の自動起動の登録は実機では確認していません。

#### 旧バージョンからの移行

- 以前のバージョンのスクリプトは libcurl.js 付属の Python 製 Wisp サーバーを使っていました。wisp-js に切り替えるには、もう一度 `install` を実行してください。古い `libcurl.js` ディレクトリは使われなくなるので削除して構いません。
- 以前の README の手順で常時起動サービス `synthesis-spicetify-wisp.service` を有効にしている場合は、先に `systemctl --user disable --now synthesis-spicetify-wisp.service` で無効にしてください。同じ 6001 番ポートを使うため、インストーラーは見つけるとメッセージを出して止まります。

### クライアント定義の更新

YouTube 側の受け付ける内容が変わると、ローカル Wisp でもプレイヤーリクエストが `HTTP 400/403` や `LOGIN_REQUIRED` で失敗するようになります。`synthesis-spicetify.js` の `CLIENT_DEFS` を、yt-dlp の `INNERTUBE_CLIENTS` (`yt_dlp/extractor/youtube/_base.py`) に合わせて更新してください。

## クレジット

- [YouTube.js](https://github.com/LuanRT/YouTube.js) (LuanRT)
- [libcurl.js](https://github.com/ading2210/libcurl.js) (ading2210)
- [wisp-js](https://github.com/MercuryWorkshop/wisp-js) (MercuryWorkshop、ローカル Wisp サーバー)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (プレイヤーリクエストの参照元として、そのクライアント定義を利用)
