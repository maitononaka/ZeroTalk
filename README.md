# ZeroChat — private chat (GitHub Pages + Cloudflare Workers + D1)

**Version: a1.0.0**

匿名でも始められ、Googleアカウントをあとから紐づけられる、URL招待型のシンプルな1対1チャットです。

## 構成

- `docs/` — GitHub Pagesで公開するフロントエンド（依存パッケージなし）
- `worker/` — Cloudflare Worker API
- Cloudflare D1 — ユーザー、セッション、チャット、メッセージ保存
- Google OAuth 2.0 — 任意のGoogleログイン / 匿名アカウントへの連携

## 主な機能

- 匿名で即開始（メール・電話番号不要）
- 自分専用の招待URLを発行
- Googleアカウントをあとから連携
- Google風のモダンUI / レスポンシブ
- 1対1チャット
- チャットごとの保存期限: 1時間 / 24時間 / 7日
- メッセージ削除
- HTTPS / CORS / bearer session token
- D1の定期クリーンアップ用Cron

## 1. Cloudflare側

1. Cloudflare DashboardでWorkersを作成。
2. D1 databaseを作り、`worker/schema.sql` を実行。
3. `worker/wrangler.toml` の `database_id` を自分のD1 IDに変更。
4. Worker secretsを登録。

```bash
cd worker
npm install
npx wrangler d1 execute zerochat_db --remote --file=./schema.sql
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler deploy
```

Worker variables:

- `GOOGLE_CLIENT_ID` = Google Cloudで作ったWeb OAuth Client ID
- `APP_ORIGIN` = GitHub PagesのOrigin（例: `https://maitononaka.github.io`）
- `GOOGLE_REDIRECT_URI` = Workerのcallback URL（例: `https://chat-api.example.workers.dev/api/auth/google/callback`）
- `COOKIE_DOMAIN` はこの構成では不要

Google CloudのOAuthクライアントでは、Authorized redirect URIに `GOOGLE_REDIRECT_URI` を登録してください。

## 2. フロントエンド

`docs/config.js` の `API_BASE` をWorker URLに変更。

GitHubのSettings → Pages → Deploy from a branch → `main` / `/docs` を選択。

## 3. ローカル開発

### Worker

```bash
cd worker
npm install
npx wrangler dev
```

### フロントエンド

静的ファイルなので、例えばVS CodeのLive Serverや次のコマンドで配信できます。

```bash
python3 -m http.server 8080 -d docs
```

`config.js` をローカルWorker URLに変更してください。

## API概要

- `POST /api/session/anonymous`
- `GET /api/me`
- `POST /api/profile`
- `POST /api/auth/google/start`
- `GET /api/auth/google/callback`
- `POST /api/auth/google/exchange`
- `GET /api/chats`
- `POST /api/chats`
- `GET /api/chats/:id/messages`
- `POST /api/chats/:id/messages`
- `DELETE /api/chats/:id`

## セキュリティ上の注意

このプロジェクトは小規模な個人利用向けMVPです。匿名性を保証するサービスではありません。Cloudflare、Google、GitHub Pages等の各サービス側のログや運用については別途確認してください。

特に「IPログを保存しない」ことをアプリだけで保証する実装にはしていません。必要ならCloudflare側のログ・分析機能も含めた運用設計が必要です。
