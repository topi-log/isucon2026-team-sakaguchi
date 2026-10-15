# Go環境向けのISUCON練習コマンド集

Goアプリを使うISUCON練習環境の準備、計測、最適化で使うコマンドをまとめる。
初回にツールとログを設定し、pproteinでCPU使用状況、HTTPアクセス、SQL実行時間を計測する。
結果から遅い処理を選び、Goのコード、SQL、Nginxを調整して同じ条件で測り直す。

## 対象環境

サーバーのコマンドはSSH接続後、sudo権限のある`isucon`ユーザーで実行する。

| 対象 | 例 |
| --- | --- |
| SSH接続先 | `isucon-01` |
| Goアプリ | `/home/isucon/webapp/go` |
| Goサービス | `isuconquest.go` |
| 実行ファイル | `/home/isucon/webapp/go/isuconquest` |
| pproteinの作業先 | `/home/isucon/pprotein` |

GoアプリとMySQL、Nginxが同じサーバーで稼働し、Goのビルド環境が導入済みであることを前提とする。
配置先とサービス名は[導入記録](https://scrapbox.io/sorafujitani/pprotein_integ)に合わせた例。
最初にサーバーで、Goサービスの起動先とGoのバージョンを確認する。

```bash
sudo systemctl show isuconquest.go -p WorkingDirectory -p ExecStart
go version
```

実際のサービス名が異なる場合は、`systemctl list-unit-files --type=service`で対象を探す。
以降のパスとサービス名は、この確認結果に合わせて置き換える。
Goの必要バージョンは、アプリの`go.mod`や既存の構築手順に合わせる。

## 必要なツールを導入する

実行場所：サーバー。
pproteinはHTTPログの集計にalp、SQLログの集計にslpを使う。
下の例では、編集用のVimと、GoのCPUグラフ表示に使うGraphvizも導入する。
ツールの導入はここで一度だけ行う。

```bash
sudo apt-get update && sudo apt-get install -y vim curl ca-certificates graphviz
mkdir -p /home/isucon/bin /home/isucon/.local/bin \
  /home/isucon/pprotein/{config,systemd,data}

(
  set -eu
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo '未対応のアーキテクチャ' >&2; exit 1 ;;
  esac
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cd "$work"
  curl -fL -o pprotein.tar.gz \
    "https://github.com/kaz/pprotein/releases/download/v1.2.4/pprotein_1.2.4_linux_${arch}.tar.gz"
  tar -xzf pprotein.tar.gz
  install -m 755 pprotein pprotein-agent /home/isucon/bin/

  # 既存のalp・slpは上書きしない。
  if ! command -v alp >/dev/null && ! test -x /home/isucon/.local/bin/alp; then
    curl -fL -o alp.tar.gz \
      "https://github.com/tkuchiki/alp/releases/download/v1.0.21/alp_linux_${arch}.tar.gz"
    tar -xzf alp.tar.gz
    install -m 755 alp /home/isucon/.local/bin/
  fi
  if ! command -v slp >/dev/null && ! test -x /home/isucon/.local/bin/slp; then
    curl -fL -o slp.tar.gz \
      "https://github.com/tkuchiki/slp/releases/download/v0.2.3/slp_linux_${arch}.tar.gz"
    tar -xzf slp.tar.gz
    install -m 755 slp /home/isucon/.local/bin/
  fi
)

PATH="/home/isucon/.local/bin:$PATH" alp --version
PATH="/home/isucon/.local/bin:$PATH" slp --version
dot -V
```

確認：alp、slp、Graphvizのバージョンが表示されること。
既存のalpやslpが別の場所にある場合は、後述するサービスの`PATH`にもその配置先を含める。

## GoアプリのCPU計測を有効にする

実行場所：サーバー。
pprofは、Goの関数がCPUをどれだけ使っているかを調べる仕組み。
`/home/isucon/webapp/go/profiling.go`へ次を保存する。
既にpprofがある場合は追加せず、その待受先を後述の計測先に指定する。

```go
package main

import (
    "log"
    "net/http"
    _ "net/http/pprof"
)

func startProfiling() {
    go func() {
        log.Print(http.ListenAndServe("127.0.0.1:6060", nil))
    }()
}
```

同じディレクトリの`main.go`を開き、既存の`main()`内で`startProfiling()`を呼ぶ。
アプリのHTTPサーバーを起動して待機する処理より前へ、次の1行を追加する。

```go
startProfiling()
```

既存の`main()`全体は置き換えない。
この例はGo標準の`net/http/pprof`を使う。詳しくは[公式文書](https://pkg.go.dev/net/http/pprof)を参照する。
アプリ本体も標準の`DefaultServeMux`を使う場合は、pprofがアプリのポートからも公開されないよう、待受先とルーティングを確認する。

実行中のバイナリを退避し、ビルドに成功した場合だけ置き換えて再起動する。

```bash
cd /home/isucon/webapp/go &&
  cp -p isuconquest "isuconquest.before-$(date +%Y%m%d-%H%M%S)" &&
  go build -buildvcs=false -o isuconquest.new . &&
  mv isuconquest.new isuconquest &&
  sudo systemctl restart isuconquest.go
sudo systemctl status isuconquest.go --no-pager
curl -fsS -o /dev/null http://127.0.0.1:6060/debug/pprof/ && echo 'pprof: OK'
```

確認：サービスが稼働し、`pprof: OK`が表示されること。
ビルドや起動に失敗した場合は、原因を解消してから計測へ進む。

## 計測するログを設定する

実行場所：サーバー。
HTTPログはLTSV形式、SQLログはMySQLのスロークエリログを使う。
LTSVは、項目名と値をタブで区切るログ形式。

### NginxのLTSVログ

SSH接続したサーバーで、次の2ファイルを編集する。

| 編集するファイル | 書く内容 |
| --- | --- |
| `/home/isucon/pprotein/config/nginx-pprotein.conf` | ログの書式を定義する`log_format` |
| `/etc/nginx/sites-available/isucon.conf` | ログの出力先を指定する`access_log` |

2つ目の`isucon.conf`は例なので、以下の手順で実際に使われるファイルを確認する。

#### 1. ログ形式のファイルを作る

```bash
vim /home/isucon/pprotein/config/nginx-pprotein.conf
```

次の内容を保存する。
このファイルは設定の控えで、手順3で`/etc/nginx/conf.d/pprotein.conf`へコピーして反映する。

```nginx
log_format pprotein_ltsv 'time:$time_iso8601\tmethod:$request_method\turi:$request_uri\tstatus:$status\tsize:$body_bytes_sent\treqtime:$request_time';
```

以下は、Nginxが`/etc/nginx/conf.d/*.conf`を`http`内で読み込む構成を前提とする。
読み込みの指定は`/etc/nginx/nginx.conf`で確認できる。
異なる構成では、`log_format`を`http`内から読み込まれる場所へ配置する。

#### 2. Goアプリのサイト設定を編集する

有効なサイト設定のリンク先を確認する。

```bash
ls -l /etc/nginx/sites-enabled/
```

Goアプリの設定が`/etc/nginx/sites-available/isucon.conf`を指していれば、次のコマンドで開く。
別のファイル名なら、表示されたリンク先へ置き換える。
複数の設定がある場合は、計測対象のホスト名やGoアプリへの転送先に対応するものを選ぶ。

```bash
sudo vim /etc/nginx/sites-available/isucon.conf
```

既存の`server { ... }`の中へ、次の1行を追加する。
`server`ブロック全体を置き換えず、既存の待受ポートやアプリへの転送設定は残す。

```nginx
access_log /var/log/nginx/pprotein-access.log pprotein_ltsv;
```

同じログ出力が既にあれば追加しない。
対象の`location`で`access_log`を上書きしている場合は、その設定にも同じ出力先と書式を指定する。

#### 3. 配置して反映する

手順1のファイルをNginxの読み込み先へコピーし、構文検査に成功した場合だけ再読み込みする。

```bash
sudo install -D -m 644 /home/isucon/pprotein/config/nginx-pprotein.conf \
  /etc/nginx/conf.d/pprotein.conf &&
  sudo nginx -t &&
  sudo systemctl reload nginx
```

反映に成功したらリクエストを送り、ログを確認する。
`/var/log/nginx/pprotein-access.log`は設定ファイルではなく、Nginxが書き出す計測用ログ。

```bash
curl -I http://localhost/
sudo tail -n 1 /var/log/nginx/pprotein-access.log
```

確認：新しい行に`method:`、`uri:`、`reqtime:`があること。
この手順ではJSON形式のログを追加する必要はない。
既存のログ出力を停止する場合は、他の用途で使われていないことを確認する。

### MySQLのスロークエリログ

`/etc/mysql/mysql.conf.d/mysqld.cnf`の既存の`[mysqld]`内へ設定する。
同じ項目は重複させず、既存の値を変更する。

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/mysql-slow.log
long_query_time = 0
log_output = FILE
```
構文検査に成功した場合だけMySQLを再起動する。
再起動中はDB接続が切れる。

```bash
sudo mysqld --validate-config && sudo systemctl restart mysql
sudo systemctl status mysql --no-pager
sudo mysql -e "SHOW VARIABLES WHERE Variable_name IN (
  'slow_query_log', 'slow_query_log_file', 'long_query_time', 'log_output'
);"
```

確認：`slow_query_log=ON`、`long_query_time=0`、`log_output=FILE`と指定したログパスが表示されること。
`--validate-config`が未対応なら、利用中のMySQLで使える検査方法を確認してから続ける。

### エージェントの読み取り権限

pprotein-agentは、アプリが出力したログをpproteinへ渡すプロセス。
サービスの補助グループ`adm`で両方のログを読めるようにする。

```bash
sudo touch /var/log/nginx/pprotein-access.log /var/log/mysql/mysql-slow.log
sudo chown www-data:adm /var/log/nginx/pprotein-access.log
sudo chown mysql:adm /var/log/mysql/mysql-slow.log
sudo chmod 640 /var/log/nginx/pprotein-access.log /var/log/mysql/mysql-slow.log
sudo -n runuser -u isucon -g adm -- test -r /var/log/nginx/pprotein-access.log && echo 'Nginx: OK'
sudo -n runuser -u isucon -g adm -- test -r /var/log/mysql/mysql-slow.log && echo 'MySQL: OK'
```

確認：`Nginx: OK`と`MySQL: OK`の両方が表示されること。
エラーが出る、または`OK`が表示されない場合は、解決するまでサービスの起動へ進まない。
Nginxの実行ユーザーが`www-data`でない場合は、所有者を置き換える。
ログローテーション後も同じ所有者と権限を維持する。

## pproteinを起動する

実行場所：サーバー。
次を`/home/isucon/pprotein/systemd/pprotein.service`へ保存する。

```ini
[Unit]
Description=pprotein
After=network.target

[Service]
User=isucon
WorkingDirectory=/home/isucon/pprotein
Environment="PATH=/home/isucon/.local/bin:/usr/local/bin:/usr/bin:/bin"
Environment=PORT=9000
ExecStart=/home/isucon/bin/pprotein
Restart=on-failure
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=multi-user.target
```

次を`/home/isucon/pprotein/systemd/pprotein-agent.service`へ保存する。
`WorkingDirectory`と`PPROTEIN_GIT_REPOSITORY`は、アプリの配置先に合わせる。
Gitリポジトリのルートは、サーバーで次のコマンドを実行して確認する。

```bash
git -C /home/isucon/webapp/go rev-parse --show-toplevel
```

下の`PPROTEIN_GIT_REPOSITORY=/home/isucon/webapp`は出力がそのパスだった場合の例。
異なる場合は出力されたパスに置き換える。

```ini
[Unit]
Description=pprotein-agent
After=network.target

[Service]
User=isucon
SupplementaryGroups=adm
WorkingDirectory=/home/isucon/webapp/go
Environment=PORT=19000
Environment=PPROTEIN_HTTPLOG=/var/log/nginx/pprotein-access.log
Environment=PPROTEIN_SLOWLOG=/var/log/mysql/mysql-slow.log
Environment=PPROTEIN_GIT_REPOSITORY=/home/isucon/webapp
ExecStart=/home/isucon/bin/pprotein-agent
Restart=on-failure
IPAddressDeny=any
IPAddressAllow=localhost

[Install]
WantedBy=multi-user.target
```

公式バイナリは9000番と19000番を全アドレスで待ち受ける。
上記の`IPAddressDeny`と`IPAddressAllow`は、通信をlocalhostへ限定する設定。
この制限が働くには、カーネルのcgroup BPF対応が必要となる。
起動前に、ファイアウォールでも両ポートへの外部アクセスを遮断する。
SSH転送だけではサーバー側の公開ポートを制限できない。

設定を配置し、サービスを起動する。

```bash
sudo install -m 644 /home/isucon/pprotein/systemd/pprotein.service \
  /home/isucon/pprotein/systemd/pprotein-agent.service /etc/systemd/system/ &&
  sudo systemctl daemon-reload &&
  sudo systemctl enable --now pprotein pprotein-agent
sudo systemctl status pprotein pprotein-agent --no-pager
```

確認：両サービスが稼働していること。
既存のサービス定義を変更した場合は、`daemon-reload`後に対象サービスを再起動する。
pproteinの設定と計測結果は`/home/isucon/pprotein/data/`へ保存される。

## 画面を開いて計測する

### 手元のPCから接続する

実行場所：手元のMac。
普段のSSH接続先に9000番を転送する。
専用のSSH設定ファイルを使う場合は、普段使う`-F`の指定も加える。

```bash
ssh -N -L 9000:127.0.0.1:9000 -o ExitOnForwardFailure=yes isucon-01
```

接続したままブラウザで<http://localhost:9000/>を開く。
終了するときはターミナルで`Ctrl+C`を押す。

### 計測先を設定する

ブラウザで開いたpproteinのグループ計測画面で、targets設定を次の内容にする。
これは「どのデータを、どこから、何秒間集めるか」を指定するJSON。
`Type`はデータの種類、`Label`は結果の名前、`URL`は取得先、`Duration`は収集する秒数を表す。
URLの`127.0.0.1`はpproteinが動くサーバー自身を指す。
Goアプリの6060番からCPU情報、エージェントの19000番からHTTPログとSQLログを取得する。

```json
[
  {
    "Type": "pprof",
    "Label": "isuconquest-cpu",
    "URL": "http://127.0.0.1:6060/debug/pprof/profile",
    "Duration": 5
  },
  {
    "Type": "httplog",
    "Label": "nginx",
    "URL": "http://127.0.0.1:19000/debug/log/httplog",
    "Duration": 5
  },
  {
    "Type": "slowlog",
    "Label": "mysql",
    "URL": "http://127.0.0.1:19000/debug/log/slowlog",
    "Duration": 5
  }
]
```

初回は`Duration=5`でCollectを押し、ベンチマークなどで負荷をかける。
CPU・HTTP・SQLの3種類のレポートが開けたら、すべての`Duration`を60へ変更する。
レポートが欠ける場合は、本計測へ進まず「結果が出ないとき」を確認する。
HTTPログのURLのまとめ方は、httplog設定の`matching_groups`をアプリのパスに合わせる。

### ベンチマークと同時に計測する

1. グループ計測の`Collect`を押す。
2. すぐに練習環境のベンチマークを実行する。
3. 設定した60秒後、同じグループのレポートを開く。
4. スコアと結果を保存し、コード変更後に同じ条件で測り直す。

| 結果 | 確認すること |
| --- | --- |
| `isuconquest-cpu` | CPUを使っているGoの関数 |
| `nginx` | 時間がかかるAPI |
| `mysql` | 時間がかかるSQL |

エージェントは計測開始時のログ末尾から、終了時までに追記された部分を収集する。
ベンチマークごとのログ消去や、ログを開き直すための再読み込みは不要。
計測中はログを消去したり、ローテーションしたりしない。
ログの容量管理は計測とは別に行う。

## 遅いSQLの原因を調べる

pproteinで見つけた遅いSQLを、MySQLクライアントで調べる。
実行場所：サーバー。
一覧から対象DBを選び、`DB_NAME`に設定して接続する。

```bash
sudo mysql -u root -e 'SHOW DATABASES;'
DB_NAME=''
sudo mysql -u root "${DB_NAME:?DB_NAMEを設定してください}"
```

### EXPLAINで実行計画を確認する

SQLは接続したMySQLクライアント内で実行する。
以下は投稿へのコメントを保存する`comments`テーブルを使ったSQLの例。
Goアプリの実際のテーブル構成は環境ごとに異なるため、pproteinで見つけたSQLとテーブルに置き換える。
この例と同じテーブルがある場合は、投稿に紐づく最新のコメントを1件取得する。
`SHOW CREATE TABLE`で定義を、`EXPLAIN`で使われるインデックスと読み取り行数を確認する。

```sql
SHOW TABLES;
SHOW CREATE TABLE comments;
EXPLAIN SELECT * FROM comments
WHERE post_id = 1
ORDER BY created_at DESC
LIMIT 1;
```

### インデックスを追加して比較する

先に`SHOW INDEX`で既存のインデックスを確認する。
次の例は投稿IDによる絞り込みと作成日時による並べ替えに使う候補で、無条件に追加するものではない。
同名や同じ列構成のインデックスがないことを確かめ、必要な場合だけ実行する。

```sql
SHOW INDEX FROM comments;
ALTER TABLE comments
ADD INDEX post_id_idx (post_id, created_at DESC);
```

追加後に同じ`EXPLAIN`とベンチマークを実行し、実行計画、SQLの集計結果、スコアを比較する。
インデックスの作成中に、負荷の増加や処理待ちが起こる場合もある。
効果がなく戻す場合は、今回追加したインデックスだけを削除する。

```sql
ALTER TABLE comments DROP INDEX post_id_idx;
```

### ロック待ちを確認する

ロック待ちが疑わしい場合は、次を実行する。

```sql
SELECT
  wait_started, wait_age, locked_table, locked_index,
  waiting_pid, blocking_pid, waiting_query, blocking_query
FROM sys.innodb_lock_waits;
```

結果が空なら、その時点ではロック待ちがない。
インデックスやSQLを変更したら、同じSQLの実行計画とpproteinの計測結果を比較する。

## アプリを編集してサーバーへ反映する

### VS Codeでサーバーに接続する

実行場所：手元のMac。
VS CodeにMicrosoftのRemote - SSH拡張機能をインストールする。

1. `Cmd + Shift + P`でコマンドパレットを開く。
2. `Remote-SSH: Connect to Host...`を選ぶ。
3. 普段SSH接続するときと同じ`isucon-01`を選ぶ。
4. 「ファイル → フォルダーを開く」で、確認したアプリの配置先を開く。

```text
/home/isucon/webapp
```

ここで編集するのはサーバー上のファイル。
Nginxの`/etc/nginx/`とMySQLの`/etc/mysql/`は、アプリとは別のフォルダにある。
VS Codeの「ファイルを開く」でパスを指定すれば確認できる。
保存には管理者権限を求められる場合がある。

### Macへコードと設定をコピーする

ローカルで編集する場合は、Macのターミナルで作業先を作り、サーバーからコードを取得する。

```bash
mkdir -p ~/work/isucon-local/server-config/system
rsync -avz \
  isucon-01:/home/isucon/webapp \
  ~/work/isucon-local/
```

NginxとMySQLの設定を手元で確認する場合：

```bash
rsync -avzL \
  isucon-01:/etc/nginx \
  isucon-01:/etc/mysql \
  ~/work/isucon-local/server-config/
```

systemdのサービス定義も確認する場合：

```bash
rsync -avzL \
  isucon-01:/etc/systemd/system/isuconquest.go.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/nginx.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/mysql.service \
  ~/work/isucon-local/server-config/system/
```

取得できるのはSSHユーザーが読み取れるファイルだけ。
サービス定義のパスが異なる場合は実環境のものへ置き換える。
設定に認証情報が含まれる場合は、公開リポジトリへ追加しない。

### Goの変更を反映する

編集前にサーバーで、変更するソースファイルと稼働中のバイナリを退避する。
次は`main.go`を編集する場合の例。

```bash
cd /home/isucon/webapp/go &&
  cp -p main.go "main.go.before-$(date +%Y%m%d-%H%M%S)" &&
  cp -p isuconquest "isuconquest.before-$(date +%Y%m%d-%H%M%S)"
```

Macで編集した場合は、Macから変更したファイルをサーバーへ転送する。
Remote - SSHで直接編集した場合、この転送は不要。

```bash
rsync -avz \
  ~/work/isucon-local/webapp/go/main.go \
  isucon-01:/home/isucon/webapp/go/main.go
```

複数のファイルを変更した場合は、追加したファイルも含めて転送する。
ソースを保存しただけでは稼働中のGoアプリには反映されない。
サーバーでビルドし、成功した場合だけバイナリを置き換えて再起動する。

```bash
cd /home/isucon/webapp/go &&
  go build -buildvcs=false -o isuconquest.new . &&
  mv isuconquest.new isuconquest &&
  sudo systemctl restart isuconquest.go
sudo systemctl status isuconquest.go --no-pager
curl -I http://localhost/
```

正常に応答したら、pproteinとベンチマークで変更前後を比較する。
起動に失敗した場合は、退避したバイナリを`isuconquest`へ戻して再起動する。
ソースも退避版へ戻し、次のビルドで同じ変更を再び反映しないようにする。

## Nginxから静的ファイルと画像を配信する

実行場所：サーバー。
Nginxでファイルを直接返すと、そのリクエストをGoアプリで処理する必要がなくなる。
以下は公開ディレクトリが`/home/isucon/webapp/public`、アプリの待受先が8080番の例。
公開ディレクトリ、URLのパス、待受先は、アプリと既存のNginx設定に合わせる。

```bash
ls -la /etc/nginx/sites-enabled/
ls -ld /home/isucon/webapp/public
sudo cp -p /etc/nginx/sites-available/isucon.conf \
  "/etc/nginx/sites-available/isucon.conf.before-$(date +%Y%m%d-%H%M%S)"
sudo vim /etc/nginx/sites-available/isucon.conf
```

対象の`server`内へ設定する。
同じ`location`がある場合は既存の定義を変更する。
認証が必要なファイルは静的配信の対象に含めない。

```nginx
location ~ ^/(favicon\.ico|css/|js/|img/) {
  root /home/isucon/webapp/public/;
  expires 1d;
}

location /image/ {
  root /home/isucon/webapp/public/;
  expires 1d;
  try_files $uri @app;
}

location @app {
  internal;
  proxy_pass http://localhost:8080;
}
```

`/image/`はファイルが存在すればNginxが返し、存在しなければアプリへ渡す。
この設定だけで画像ファイルが生成されるわけではない。

```bash
sudo nginx -t && sudo systemctl reload nginx
```

確認：静的ファイルと画像を取得でき、ファイルがない画像のリクエストはアプリへ渡ること。
同じベンチマークで、スコアとHTTPログの集計結果を比較する。

## 結果が出ないとき

実行場所：サーバー。
サービスが停止していないか、ログを読めない状態になっていないかを確認する。

```bash
sudo systemctl status pprotein pprotein-agent isuconquest.go --no-pager
sudo journalctl -u pprotein -u pprotein-agent -u isuconquest.go -n 50 --no-pager
sudo journalctl -u nginx -u mysql -n 50 --no-pager
```

CPUだけ失敗する場合は、Goアプリのpprofの待受先とtargetsのURLを確認する。
HTTPだけ失敗する場合はLTSVログの出力先、SQLだけ失敗する場合はスロークエリログの設定を確認する。
エラーが解消するまで計測を止め、変更後に異常が出た場合は退避した設定へ戻す。

## 補足：手動集計が必要な場合

pproteinの画面を使えないときは、導入済みのalpとslpで同じログを集計できる。
pproteinの計測区間と異なり、次のコマンドはログファイル全体を対象にする。
必要な計測区間を切り出したファイルを使う場合は、`--file`のパスを置き換える。

```bash
sudo env PATH=/home/isucon/.local/bin:/usr/local/bin:/usr/bin:/bin \
  alp ltsv --file /var/log/nginx/pprotein-access.log --sort sum -r
sudo env PATH=/home/isucon/.local/bin:/usr/local/bin:/usr/bin:/bin \
  slp my --file /var/log/mysql/mysql-slow.log
```

通常の計測では`pt-query-digest`や`mysqldumpslow`を追加で実行する必要はない。
これらを使う別の調査方法や、Bash補完の導入は任意とする。

## 参考

- [pproteinの導入記録](https://scrapbox.io/sorafujitani/pprotein_integ)
- [pprotein v1.2.4](https://github.com/kaz/pprotein/tree/v1.2.4)
- [Goのnet/http/pprof](https://pkg.go.dev/net/http/pprof)
- [alpを呼び出す処理](https://github.com/kaz/pprotein/blob/v1.2.4/internal/extproc/alp/processor.go)
- [slpを呼び出す処理](https://github.com/kaz/pprotein/blob/v1.2.4/internal/extproc/slp/processor.go)
- [計測区間のログを収集する処理](https://github.com/kaz/pprotein/blob/v1.2.4/internal/tail/tail.go)
