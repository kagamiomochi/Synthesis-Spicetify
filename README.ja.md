<div align="center">
  <h1>Synthesis Spicetify</h1>
  <p>Transcending all musical boundaries.</p>
  <img src="./logo.png" alt="logo" width="300">

  ![GitHub Tag](https://img.shields.io/github/v/tag/kagamiomochi/Synthesis-Spicetify?sort=semver&style=for-the-badge&label=Latest%20Version)

  [English](./README.md) | 日本語
</div>

Spotify に **YouTube Music** と **SoundCloud** を統合する [Spicetify](https://spicetify.app/) 拡張機能です。

## 機能

- 検索結果ページに「Spotify」「YouTube Music」「SoundCloud」のタブを追加。選んだタブは検索ワードを変えても維持されます
- 再生、次に再生、キューに追加、Spotify のプレイリストに保存
- Spotify 以外の曲も Spotify の曲と同じように扱えます。Spotify 本体のプレイヤーバー、キュー、プレイリスト、シークバー、前へ/次へ、リピート、シャッフルがそのまま動きます([再生の仕組み](#再生の仕組み)を参照)
- Spotify を開き直したとき、前回聞いていた曲を再生位置ごと(一時停止の状態で)復元します
- 再生機能は任意でオンにする方式です。ローカル Wisp サーバーが無くても、検索と「ブラウザで開く」は使えます

## インストール

**Marketplace:** Spotify の Spicetify Marketplace で「Synthesis Spicetify」を検索してインストールします。

**手動:** `synthesis-spicetify.js` を Spicetify の `Extensions` フォルダに置き、次を実行します。

```sh
spicetify config extensions synthesis-spicetify.js
spicetify apply
```

## 再生機能を有効にする

再生機能は**既定でオフ**です。共有の公開 Wisp プロキシは YouTube に弾かれるため、自分の PC 上で小さなプロキシサーバー(Wisp)を動かす必要があります([理由](#ローカル-wisp-が必要な理由))。

1. 必要なものを用意します: [Node.js](https://nodejs.org/) 22.12 以上(npm が付属します。`node --version` で確認できます)。Linux では加えて systemd も必要です。
2. Spotify の設定で「再生機能を有効化」をオンにします。拡張がセットアップ手順(インストール済みバージョンに固定された 1 行のコマンド)を表示し、接続を確認します。確認できると再生機能が有効になります。

   手動で入れる場合は、このリポジトリを clone して次を実行します。

   ```sh
   node setup-wisp.mjs install
   ```

3. 削除は、同じコマンドの `install` を `uninstall` に変えて実行します。

サーバーはログイン時に起動します。Node.js のパスはインストール時に記録されるので、Node.js を移動・入れ替えたらもう一度 `install` を実行してください。
オプションなどの詳細は[ローカル Wisp ランチャー](#ローカル-wisp-ランチャー)を見てください。

> 再生機能がオフのとき、結果の行に「公開 Wisp で試しに再生」ボタンが出ます。ほぼ弾かれますが、通った場合はローカルサーバー無しで再生機能がオンのままになります。

## 使い方

1. Spotify で普通に検索し、結果ページ上部のタブを選びます。
2. 結果にカーソルを合わせます。カバー画像のボタンで再生、右側のボタンで「次に再生」「キューに追加」「プレイリストに保存」「ブラウザで開く」ができます。
3. キューに入れた曲は Spotify 標準のキューパネルに並び、並べ替えや削除ができます。
4. Spotify 以外の曲の再生中は、Spotify の再生ボタンがその曲の再生/一時停止になります。次へ/前へは、Spotify の曲かどうかを問わず、キューやプレイリストの次/前の曲に進みます。

### 前回の曲の復元

Spotify は起動時にローカルファイルを復元しないため、Spotify 以外の曲は再起動すると消えてしまいます。そこで拡張が、再生中の曲とその位置を数秒ごとに記録し、次の起動で元に戻します。Spotify をその曲のダミー曲に移し、保存した位置で**一時停止**の状態にします。再生ボタンを押すまでは何もダウンロードせず、押すとその位置から再生します(長い曲では、ダウンロードがその位置に届くまで数秒かかることがあります)。再生ボタンを押す前にシークバーを動かすこともできます。

- 別の曲を再生すると記録は新しい曲に置き換わります。通常の Spotify の曲を再生した場合は、Spotify 自身が復元するため記録を削除します。
- 再生機能がオフのとき、すでに何かを再生しているとき、その曲のダミー曲ファイルが残っていないとき(使われていないファイルの自動整理で消えた場合など。最後の曲のファイルは整理の対象外です)は復元しません。
- 曲が入っていたプレイリストやアルバムは復元しません。曲は単独で始まるため、その後はサービスのおすすめ曲が続きます(自動再生を参照)。
- [設定](#設定)でオフにできます。オフにすると保存した記録を削除します。

### 再生の仕組み

Spotify のプレイヤー、キュー、プレイリストには、Spotify の曲とローカルファイルしか入れられません。そこで、再生・キュー追加・保存する曲ごとに**無音のローカルファイル(ダミー曲)**を作り(アーティスト「YouTube」または「SoundCloud」、アルバム「Synthesis」、曲名は曲 ID)、ほかのローカル曲と同じように Spotify に渡します。Spotify がそのファイルを再生し始めると、拡張が Spotify を一時停止し、代わりに実際の曲を再生します。曲が終わると、Spotify はそのファイルの次の曲に進みます。Spotify 上の曲名・アーティスト名・カバー画像は、拡張が行・キュー・再生中パネル・プレイヤーバーの表示だけを本物に書き換えます(ファイルや Spotify のデータは変更しません)。

**セットアップ:** 再生機能をオンにすると、Spotify のローカルファイルも自動で有効になります。フォルダ選択のダイアログが一度出るので、ダミー曲を置くフォルダを選ぶと、拡張がローカルファイルのソースに追加します(Spotify の設定で自分で追加しても構いません)。権限の確認が再び出たら許可してください。

**注意:**

- ファイルは曲の長さ 1 秒あたり約 2 KB です。使われていないものは自動で削除されます([設定](#設定)を参照)。プレイリストに入っているものは削除されません。
- 保存した曲は、そのフォルダがある PC でだけ再生できます(他のデバイスでは不可)。ダミー曲のファイルを消すと、そのプレイリストの行は再生できなくなります。

## 設定

Spotify のプロフィールメニューから「Synthesis Spicetify 設定」を開きます。変更はすぐに反映されます。

| 設定 | 説明 |
| --- | --- |
| **再生機能を有効化** | 既定はオフ。オンにするとセットアップ手順を表示し、`ws://localhost:6001/` への接続を確認します。オフにすると再生中の曲を止めます。 |
| **自動再生** | 検索から再生した曲が終わったとき(または「次へ」を押したとき)、その曲のサービスのおすすめ曲を続けて再生します。プレイリストやキューの再生には影響しません。既定はオン。 |
| **前回の曲を復元** | 起動時に、前回再生していた曲を一時停止の状態で、保存した位置に戻します。オフにすると保存した記録を削除します。既定はオン。[前回の曲の復元](#前回の曲の復元)を参照。 |
| **ダミー曲を自動で整理** | 起動の少し後に、プレイリストやキューで使われていない 24 時間以上前のダミー曲を削除します。**今すぐ整理**で即実行もできます。既定はオン。 |
| **公開 Wisp プロキシ** | 1 行に 1 つ、上から順に試します。既定は `wss://wisp.mercurywork.shop/`。再生機能がオンの間は、ローカルの `ws://localhost:6001/` を最初に試します。 |
| **InnerTube クライアント** | `visionos`、`tv_samsung` を上から順に試します。既定では PO Token は不要です。 |
| **接続テスト** | libcurl、セッション、検索、プレイヤーリクエスト、音声ダウンロードまでを順に試し、各ステップの結果を表示します。 |
| **音声キャッシュを削除** | ダウンロード済みの音声(直近の数曲をメモリにキャッシュ)を解放します。 |
| **設定をリセット** | すべての設定を初期値に戻します。確認のため 2 回押します。 |

## トラブルシューティング

まず設定の**接続テスト**を実行すると、どのステップで失敗しているかが分かります。

| メッセージ | 考えられる原因と対処 |
| --- | --- |
| `LOGIN_REQUIRED: Sign in to confirm you're not a bot` | Wisp プロキシの IP が弾かれています。再生機能をオンにして、ローカル Wisp サーバーを用意してください。 |
| `No usable Wisp server` | 再生機能がオンならローカルサーバーを起動してください。オフなら、ネットワークと公開 Wisp の URL を確認してください。 |
| libcurl のステップが最初で失敗する | Spotify の CSP が WASM や jsDelivr からの import をブロックしている可能性があります。 |
| プレイヤーのステップで `EvalError` / CSP エラー | 一部のストリーム URL の復号に必要な `eval` を Spotify がブロックしています。`visionos` だけを使ってください。 |
| ローカル Wisp で `player request failed: HTTP 400/403` または `LOGIN_REQUIRED` | クライアント定義が古くなっています。[クライアント定義の更新](#クライアント定義の更新)を参照してください。 |

**ローカル Wisp のログ:** Linux は `journalctl --user -u synthesis-spicetify-wisp-backend.service -u synthesis-spicetify-wisp-proxy.service`。macOS と Windows は wisp-js ディレクトリの隣に出ます(ランチャーは `wisp-ondemand.log`、Wisp サーバーは `wisp-backend.log`)。

## プライバシーと免責

- リクエストは Wisp プロキシ経由で送られます。再生機能をオンにするまでは共有の公開サーバーで、接続先のホスト名が見えます(TLS は Spotify 内で終端されます)。ローカルサーバーを使う場合は自分の PC です。
- YouTube のセッション Cookie はメモリ上にのみ保持します。
- 最後に再生した曲(サービス、ID、曲名、アーティスト、アルバム、カバー画像の URL、ダミー曲の URI、再生位置)は、次回の起動で復元するためにブラウザのローカルストレージに保存します。保存先はあなたの PC だけで、「前回の曲を復元」をオフにすると削除します。
- SoundCloud の `client_id` は soundcloud.com 自身のスクリプトから読み取り、ブラウザのローカルストレージにキャッシュします。公開された値で、あなた個人とは紐づきません。
- 非公式の YouTube / SoundCloud API を使っており、各サービスの利用規約に反する可能性があります(SoundCloud の API 規約は、その曲を他のサービスと混ぜることも禁じています)。自己責任で使ってください。
- SoundCloud がフルで提供している曲だけを表示します。プレビュー、Go+、暗号化されたストリームは除外します。
- SoundCloud は AAC のみで、Spotify 内の Chromium はこれを再生できません。そのため拡張が [FAAD2](https://github.com/knik0/faad2) の WebAssembly 版(`@ohrstrom/faad2-wasm`、jsDelivr から読み込み)で復号し、ダウンロードと復号の続きを待たずに Web Audio で再生します。最初の約 10 秒分が揃ったところで再生が始まります。Web Audio を起動できない場合は、全体を復号してから WAV として再生するため、数秒かかります。
- Spotify、Google、YouTube、SoundCloud とは無関係です。

## 技術的な詳細

<details>
<summary>仕組み</summary>

| 部分 | ライブラリ |
| --- | --- |
| YouTube Music の検索 | [YouTube.js](https://github.com/LuanRT/YouTube.js) (youtubei.js) |
| CORS を回避するリクエスト | [libcurl.js](https://github.com/ading2210/libcurl.js) (WASM 版 libcurl) を Wisp WebSocket プロキシ経由で使用 |
| 再生 | ダウンロード中のチャンクを `MediaSource` に追加して逐次再生。完了した `Blob` はキャッシュ(直近の数曲、メモリ上)とフォールバックに使用 |

ライブラリは初回利用時に jsDelivr から読み込みます(バージョン固定: libcurl.js 0.7.5、youtubei.js 18.3.0、`@ohrstrom/faad2-wasm` 2.11.2-rc.4)。

YouTube のプレイヤーリクエスト(クライアント定義、ヘッダー、Cookie)は yt-dlp と同じ方法で組み立てています。YouTube.js がアプリ系クライアント向けに送るリクエストの形は、現在「Sign in to confirm you're not a bot」で拒否されるためです。

**サービス(プロバイダ):** 1 つの音楽サービスに関わる処理(検索、音声のダウンロード、サービスのページ、カバー画像の補助、接続テストの手順)は、`synthesis-spicetify.js` の `providers` レジストリの裏側にまとまっています。それ以外の部分はこのインターフェースだけを経由するので、新しいサービスはプロバイダを 1 つ追加すれば足ります。インターフェースの説明はレジストリの上のコメントにあります。

ダミー曲の曲名は、曲 ID の前にサービスのタグを付けたもの(`sc.123` など)で、アーティストのタグもサービスごとに別なので、`spotify:local:` の URI は重なりません。YouTube にはタグがなく(動画 ID だけの曲名、アーティスト「YouTube」)、旧バージョンで保存したプレイリストもそのまま動きます。

</details>

<details id="ローカル-wisp-が必要な理由">
<summary>ローカル Wisp が必要な理由</summary>

libcurl.js は Wisp プロキシ経由で通信します。TLS は Spotify 内で終端されるので、プロキシには接続先のホスト名しか見えません。ただ、YouTube はプロキシの IP アドレスで判定します。公開されている共有 Wisp サーバーはデータセンターの IP で動いていて、YouTube に弾かれます。検索は通りますが、再生はできません。自分の PC で動かす Wisp なら自分の IP が使われるので、再生できます。このため、再生機能は既定でオフにしています。

</details>

<details id="ローカル-wisp-ランチャー">
<summary>ローカル Wisp ランチャー</summary>

`setup-wisp.mjs` は、Wisp サーバー([wisp-js](https://github.com/MercuryWorkshop/wisp-js)、バージョン固定)を npm で `~/.local/share/synthesis-spicetify/wisp-js`(Windows は `%LOCALAPPDATA%\\synthesis-spicetify\\wisp-js`)にインストールし、ログイン時に `127.0.0.1:6001` で起動するよう登録します。インストール後、このスクリプトは不要です。

**コマンド:** `install` と `uninstall`。`install --port 番号` でポートを変えられます(設定のローカル Wisp URL も合わせて変更してください)。

**登録されるもの:**

| OS | 登録先 | ログ |
| --- | --- | --- |
| Linux | systemd のユーザーユニット `synthesis-spicetify-wisp.service` | `journalctl --user -u synthesis-spicetify-wisp.service` |
| macOS | LaunchAgent | wisp-js ディレクトリの隣の `wisp.log` |
| Windows | ログイン時に実行するタスクスケジューラのタスク(非表示の PowerShell) | なし。エラーを見たいときは `install` で表示されるコマンドを自分で実行してください。 |

systemd が無い Linux では、`install` は wisp-js のインストールだけを行い、自分の自動起動に登録するためのコマンドを表示します。

**動作確認の状況:** インストール、生成される systemd ユニット、サーバーの起動は Linux で確認しています。macOS と Windows の自動起動の登録は実機では確認していません。

**古いバージョンからの移行:** もう一度 `install` を実行してください。古い systemd ユニット(プロキシとバックエンド)と旧ランチャーのファイルを削除し、常時起動の `synthesis-spicetify-wisp.service`(古い README の例)は置き換え、macOS と Windows の登録も置き換えます。古い `libcurl.js` ディレクトリは使われなくなるので削除して構いません。

</details>

<details id="クライアント定義の更新">
<summary>クライアント定義の更新</summary>

YouTube 側の受け付ける内容が変わると、ローカル Wisp でもプレイヤーリクエストが `HTTP 400/403` や `LOGIN_REQUIRED` で失敗するようになります。`synthesis-spicetify.js` の `CLIENT_DEFS` を、yt-dlp の `INNERTUBE_CLIENTS` (`yt_dlp/extractor/youtube/_base.py`) に合わせて更新してください。

</details>

## クレジット

- [YouTube.js](https://github.com/LuanRT/YouTube.js) (LuanRT)
- [libcurl.js](https://github.com/ading2210/libcurl.js) (ading2210)
- [wisp-js](https://github.com/MercuryWorkshop/wisp-js) (MercuryWorkshop、ローカル Wisp サーバー)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (プレイヤーリクエストの参照元として、そのクライアント定義を利用)
