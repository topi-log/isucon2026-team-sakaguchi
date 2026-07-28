# Sakaguchi ローカル練習環境

軽量なコンテナを中心にした、最小の Sakaguchi Web アプリです。普段のコード・SQL・nginx改善はDocker Compose、本番同様のsystemd操作を含む総合練習はUbuntu VMで行えます。

## 構成

- nginx: 静的 frontend の配信と `/api` の reverse proxy
- Node.js 24 + Hono: JSON API
- PostgreSQL 17: users / posts / comments / likes と seed data
- kumo 0.25.3: 軽量な Go 製 AWS emulator。S3 bucket を API 起動時に作成
- Vite+: Vite、Vitest、Oxlint、Oxfmt、TypeScript check
- autocannon: connection数やpipeliningを変更できるHTTP負荷試験
- pgweb: 任意起動の DB UI

runtime image は Alpine と multi-stage build を使います。nginx は `nginx`、app server は `app` という別コンテナで起動します。pgweb は通常起動には含まれません。

## 起動

```sh
cp .env.example .env
task up
task ports
```

ホスト側ポートは起動時に空きポートを自動割り当てします。`task up`と`task ports`に表示されたnginxのURLをブラウザで開いてください。PostgreSQLは接続文字列を表示します。コンテナ内ではnginx `8080`、PostgreSQL `5432`、kumo `4566`のままです。

固定したい場合は、`.env`の該当項目だけ設定します。

```env
APP_PORT=18080
POSTGRES_PORT=15432
```

初回は PostgreSQL に users 100件、posts 500件、comments 5,000件、likes 10,000件を投入します。

## 練習用コマンド

```sh
task bench   # autocannonで負荷試験
task stats   # pg_stat_statements の重いクエリ上位を表示
task reset   # seed data を初期状態に戻す
task logs    # nginx / app server / PostgreSQL / kumo の timing log
task ports   # ホストに割り当てられたポートを表示
task tools   # pgwebを起動し、割り当てられたポートを表示
task sizes   # 関連 image のサイズ確認
task down
```

connection数、実行時間、HTTP pipelining、対象URLを変更できます。

```sh
task bench CONNECTIONS=100 DURATION=30 PIPELINING=10
task bench BENCH_URL='http://127.0.0.1:18080/api/posts/1' CONNECTIONS=50
```

method、header、body、worker数など、autocannonの追加オプションも渡せます。

```sh
task bench -- --workers 4 --latency
task bench BENCH_URL='http://127.0.0.1:8080/api/posts' -- \
  --method POST \
  --headers content-type=application/json \
  --body '{"userId":1,"title":"bench","body":"request"}'
```

DB を volume ごと完全に作り直す場合だけ、次を実行します。

```sh
docker compose down -v
task up
```

## systemdを使うVM練習

macOSでは、LimaでUbuntu 24.04のVMを統一して作成できます。初回だけLimaとTaskを用意し、次を実行します。

```sh
brew install lima go-task
task vm:setup
```

VM内ではnginx、app server、PostgreSQL、kumoを別々のsystemd serviceとして操作できます。ホストからは <http://127.0.0.1:18080> へアクセスします。
VMはUbuntu 24.04標準のPostgreSQL 16を使い、Compose環境のPostgreSQL 17とはmajor versionが異なります。

```sh
task vm:up       # VMを起動
task vm:down     # VMを停止
task vm:ssh      # VMへ接続
task vm:deploy   # source同期、build、service再起動
task vm:status   # systemd serviceの状態
task vm:logs     # journalを追跡
task vm:bench    # VMへ負荷試験
```

`task vm:delete CONFIRM=sakaguchi-practice`はVM diskとVM内のPostgreSQLデータを完全に削除します。

VMは各Macのnative architectureで動きます。Intel MacとApple Siliconでは実行条件が異なるため、VM間のscoreは直接比較できません。

## ローカル開発

package manager は pnpm に固定しています。Vite+ の各機能も pnpm script から実行します。

```sh
pnpm install
pnpm check
pnpm test
pnpm build
```

app server は `DATABASE_URL` を指定して `pnpm dev:app`、frontend は `pnpm dev` で個別起動できます。

## API

- `GET /api/health`
- `GET /api/posts?limit=20`
- `GET /api/posts/:id`
- `POST /api/posts`
- `GET /api/storage`
- `POST /api/initialize`（header: `x-initialize-token: sakaguchi-local`）
