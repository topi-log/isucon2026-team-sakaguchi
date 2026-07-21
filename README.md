# Sakaguchi ローカル練習環境

軽量なコンテナを中心にした、最小の Sakaguchi Web アプリです。

## 構成

- nginx: 静的 frontend の配信と `/api` の reverse proxy
- Node.js 24 + Hono: JSON API
- PostgreSQL 17: users / posts / comments / likes と seed data
- kumo 0.25.3: 軽量な Go 製 AWS emulator。S3 bucket を API 起動時に作成
- Vite+: Vite、Vitest、Oxlint、Oxfmt、TypeScript check
- k6: 任意起動の負荷試験
- pgweb: 任意起動の DB UI

runtime image は Alpine と multi-stage build を使います。k6 と pgweb は通常起動には含まれません。

## 起動

```sh
cp .env.example .env
task up
curl http://localhost:8080/api/health
open http://localhost:8080
```

初回は PostgreSQL に users 100件、posts 500件、comments 5,000件、likes 10,000件を投入します。

## 練習用コマンド

```sh
task bench   # k6 を一時コンテナで実行
task stats   # pg_stat_statements の重いクエリ上位を表示
task reset   # seed data を初期状態に戻す
task logs    # nginx / API / PostgreSQL / kumo の timing log
task tools   # pgweb を http://localhost:8081 で起動
task sizes   # 関連 image のサイズ確認
task down
```

負荷を変える場合は Compose に環境変数を渡します。

```sh
VUS=50 DURATION=60s docker compose --profile bench run --rm k6
```

DB を volume ごと完全に作り直す場合だけ、次を実行します。

```sh
docker compose down -v
task up
```

## ローカル開発

package manager は pnpm に固定しています。Vite+ の各機能も pnpm script から実行します。

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

API は `DATABASE_URL` を指定して `node --watch src/server/index.ts`、frontend は `vp dev` で個別起動できます。

## API

- `GET /api/health`
- `GET /api/posts?limit=20`
- `GET /api/posts/:id`
- `POST /api/posts`
- `GET /api/storage`
- `POST /api/initialize`（header: `x-initialize-token: sakaguchi-local`）
