# ISUCON練習手順

private-isuの準備・計測・変更と、Goアプリ環境でのpprotein計測を行うための手順。
このチームリポジトリ自体の起動手順は、[README](../README.md)を参照する。

## 対象と実行ルール

- private-isu：Ubuntu/Debian、Nginx、MySQL、Ruby（Unicorn）が導入済みの練習サーバー。
- pprotein：後半の「pproteinでCPU・HTTP・SQLをまとめて計測する」だけを使う。private-isuのRuby環境には適用しない。
- サーバーのコマンドはSSH接続後に実行する。ローカルのコマンドは手元のMacで実行する。
- サーバーではsudo権限が必要。rootユーザーで作業する場合は`sudo`を外す。
- 同じコードブロックは同じシェルで上から順に実行する。導入・変更に失敗したら原因を確認してから続ける。
- 設定変更前には元のファイルを退避する。
- ログの消去は保存済みの計測結果を確認してから行う。SQL・アプリ・設定の変更例は必要なものだけ実行する。

以下の接続先・パス・サービス名は例。実環境と一致しない場合は置き換える。

| 対象 | この文書の例 |
| --- | --- |
| SSH接続先 | `isucon-01` |
| private-isuのアプリ | `/home/isucon/private_isu.git/webapp` |
| Rubyサービス | `isu-ruby.service` |
| Nginxのサイト設定 | `/etc/nginx/sites-available/isucon.conf` |
| ローカルの作業先 | `~/work/private-isu-local` |

ベンチマークは練習環境のコマンドを別途用意する。この文書では実行方法を指定しない。

## 1. private-isuの計測を準備する

実行場所：サーバー。初回だけ行う。

### 1.1. ツールを導入する

```bash
sudo apt-get update && sudo apt-get install -y vim curl ca-certificates
```

alpはHTTPアクセスログ、pt-query-digestはMySQLのスロークエリログを集計する。
alpを導入する。対応アーキテクチャはamd64とarm64。

```bash
(
  set -eu
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo '未対応のアーキテクチャ' >&2; exit 1 ;;
  esac
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fL -o "$work/alp.tar.gz" \
    "https://github.com/tkuchiki/alp/releases/download/v1.0.21/alp_linux_${arch}.tar.gz"
  tar -xzf "$work/alp.tar.gz" -C "$work"
  sudo install -m 755 "$work/alp" /usr/local/bin/alp
)
sudo apt-get install -y percona-toolkit
```

確認：両方のバージョンが表示されること。

```bash
alp --version
pt-query-digest --version
```

### 1.2. NginxのJSONログを設定する

設定を退避してから編集する。

```bash
sudo cp -p /etc/nginx/nginx.conf "/etc/nginx/nginx.conf.before-$(date +%Y%m%d-%H%M%S)"
sudo vim /etc/nginx/nginx.conf
```

`http { ... }`内へ追加する。同名の定義がある場合は、新設せずその定義を変更する。
対象の`server`や`location`に別の`access_log`設定がある場合は、そちらも確認する。

```nginx
log_format json escape=json '{"time":"$time_iso8601",'
    '"remote_addr":"$remote_addr",'
    '"request_method":"$request_method",'
    '"request_uri":"$request_uri",'
    '"status":"$status",'
    '"body_bytes_sent":"$body_bytes_sent",'
    '"referer":"$http_referer",'
    '"user_agent":"$http_user_agent",'
    '"request_time":"$request_time",'
    '"response_time":"$upstream_response_time"}';

access_log /var/log/nginx/access.log json;
```

構文検査に成功した場合だけ再読み込みする。

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -I http://localhost/
sudo tail -n 1 /var/log/nginx/access.log
```

確認：新しいアクセスログがJSON形式で、`request_method`・`request_uri`・`request_time`を含むこと。
古い形式のログは残っていてもよい。次の計測前に消去する。

### 1.3. MySQLのスロークエリログを設定する

```bash
sudo mkdir -p /etc/mysql/mysql.conf.d
sudo touch /etc/mysql/mysql.conf.d/mysqld.cnf
sudo cp -p /etc/mysql/mysql.conf.d/mysqld.cnf \
  "/etc/mysql/mysql.conf.d/mysqld.cnf.before-$(date +%Y%m%d-%H%M%S)"
sudo vim /etc/mysql/mysql.conf.d/mysqld.cnf
```

既存の`[mysqld]`内に設定する。同じ設定を重複して追加しない。

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/mysql-slow.log
long_query_time = 0
log_output = FILE
```

`long_query_time=0`はログ量が増えるため、空き容量を確認する。
構文検査に成功した場合だけMySQLを再起動する。再起動中はDB接続が切れる。
`--validate-config`が未対応の場合は、MySQLのバージョンと検査方法を確認してから続ける。

```bash
sudo mysqld --validate-config && sudo systemctl restart mysql
sudo systemctl status mysql --no-pager
sudo mysql -e "SHOW VARIABLES WHERE Variable_name IN (
  'slow_query_log', 'slow_query_log_file', 'long_query_time', 'log_output'
);"
```

確認：`slow_query_log=ON`、`long_query_time=0`、`log_output=FILE`と指定したログパスが表示されること。

ログへ書き込めない場合だけ、ファイルの所有者と権限を修正する。

```bash
sudo touch /var/log/mysql/mysql-slow.log
sudo chown mysql:adm /var/log/mysql/mysql-slow.log
sudo chmod 640 /var/log/mysql/mysql-slow.log
```

## 2. private-isuを計測する

実行場所：サーバー。ベンチマークごとに繰り返す。
スコアと集計結果は、変更前後の比較用に保存する。

### 2.1. ログを消去してベンチマークを実行する

注意：次のコマンドは既存のログを消去する。必要な結果は先に保存する。

```bash
sudo truncate -s 0 /var/log/nginx/access.log &&
  sudo truncate -s 0 /var/log/mysql/mysql-slow.log &&
  sudo mysqladmin flush-logs &&
  sudo systemctl reload nginx
```

すべて成功したら、練習環境のベンチマークを実行する。

### 2.2. HTTPログを集計する

```bash
sudo alp json \
  --file /var/log/nginx/access.log \
  --method-key request_method \
  --uri-key request_uri \
  --body-bytes-key body_bytes_sent \
  --sort sum -r \
  -m '/posts/[0-9]+,/@\w+,/image/\d+' \
  -o count,method,uri,min,avg,max,sum
```

確認：合計時間`sum`が大きいAPIから調べる。
JSON解析に失敗した場合は、対象ファイルの新しい行がJSON形式か確認する。

### 2.3. SQLログを集計する

```bash
sudo pt-query-digest /var/log/mysql/mysql-slow.log | less
```

結果を保存する場合：

```bash
sudo pt-query-digest /var/log/mysql/mysql-slow.log \
  | tee "digest_$(date +%Y%m%d-%H%M%S).txt"
```

上位10件を簡易表示する場合：

```bash
sudo mysqldumpslow -s t -t 10 /var/log/mysql/mysql-slow.log | less
```

確認：実行時間と実行回数が大きいSQLを選び、次の手順で調べる。

## 3. MySQLの原因を調べる

実行場所：サーバー。SQLブロックはMySQLクライアント内で実行する。

### 3.1. 対象データベースに接続する

一覧から対象DBを確認し、`DB_NAME`に設定して接続する。空のままでは接続しない。

```bash
sudo mysql -u root -e 'SHOW DATABASES;'
DB_NAME='' # 確認したデータベース名を設定する
sudo mysql -u root "${DB_NAME:?DB_NAMEを設定してください}"
```

### 3.2. テーブル定義と実行計画を確認する

次は`comments`テーブルの例。調査対象のテーブル・SQLに置き換える。

```sql
SHOW CREATE TABLE comments;
EXPLAIN SELECT * FROM comments
WHERE post_id = 1
ORDER BY created_at DESC
LIMIT 1;
```

投稿一覧のSQLを確認する場合：

```sql
SELECT `id`, `user_id`, `body`, `created_at`, `mime`
FROM `posts`
ORDER BY `created_at` DESC;
```

確認：既存のインデックス、実行計画で使うキー、読み取り行数を確認する。

### 3.3. ロック待ちを確認する

次は`id_generator`を含むテーブルの例。対象が異なる場合は絞り込み条件を変更する。

```sql
SELECT
  wait_started, wait_age, locked_table, locked_index,
  waiting_pid, blocking_pid, waiting_query, blocking_query
FROM sys.innodb_lock_waits
WHERE locked_table LIKE '%id_generator%';
```

確認：待機側・ブロック側の接続とSQLを確認する。結果が空なら、その時点では該当する待ちがない。

### 3.4. 必要な場合だけインデックスを追加する

注意：次はDBを変更する例。対象DB・既存インデックス・実行計画を確認してから実行する。
インデックス作成中は負荷や待ちが発生することもある。適用前に戻し方も確認する。

```sql
ALTER TABLE comments
ADD INDEX post_id_idx (post_id, created_at DESC);
```

追加後に同じSQLの`EXPLAIN`とベンチマークを再実行し、変更前と比較する。

## 4. private-isuの変更を反映する

必要な変更だけ選ぶ。反映後は「2. private-isuを計測する」で効果を確認する。

### 4.1. Rubyの実行先を確認する

実行場所：サーバー。

```bash
sudo systemctl show isu-ruby.service -p WorkingDirectory -p ExecStart
```

確認：以降の転送先が、表示されたアプリの配置先と一致すること。

### 4.2. アプリを編集して転送する

VS Codeを使う場合は、Remote - SSH拡張で`isucon-01`へ接続する。
サーバーの`/home/isucon/private_isu.git/webapp`を開けば、直接編集できる。

ローカルで編集する場合は、Macでアプリを取得する。

```bash
mkdir -p ~/work/private-isu-local
rsync -avz isucon-01:/home/isucon/private_isu.git/webapp ~/work/private-isu-local/
```

編集前にサーバーで元のファイルを退避する。

```bash
cp -p /home/isucon/private_isu.git/webapp/ruby/app.rb \
  "/home/isucon/app.rb.before-$(date +%Y%m%d-%H%M%S)"
```

ローカルで編集した場合は、Macから転送する。

```bash
rsync -avz ~/work/private-isu-local/webapp/ruby/app.rb \
  isucon-01:/home/isucon/private_isu.git/webapp/ruby/app.rb
```

サーバーで再起動し、状態とHTTP応答を確認する。

```bash
sudo systemctl restart isu-ruby.service &&
  sudo systemctl status isu-ruby.service --no-pager
curl -I http://localhost/
```

### 4.3. Unicornのプロセス数を変更する場合

実行場所：サーバー。

```bash
sudo find / -name unicorn_config.rb 2>/dev/null
```

実際に読み込まれる設定ファイルを確認し、退避してからプロセス数を変更する。
反映と確認は、前節のRubyサービスの再起動手順を使う。

### 4.4. Nginxから静的ファイル・画像を配信する場合

実行場所：サーバー。公開ディレクトリとアプリの待受先を確認してから設定する。
次の例は公開ディレクトリが`/home/isucon/private_isu.git/webapp/public`、待受先が8080番の場合。

```bash
ls -la /etc/nginx/sites-enabled/
ls -ld /home/isucon/private_isu.git/webapp/public
sudo cp -p /etc/nginx/sites-available/isucon.conf \
  "/etc/nginx/sites-available/isucon.conf.before-$(date +%Y%m%d-%H%M%S)"
sudo vim /etc/nginx/sites-available/isucon.conf
```

対象の`server`内に設定する。同じ`location`がある場合は既存の定義を変更する。
認証が必要なファイルは、静的配信の対象に含めない。

```nginx
location ~ ^/(favicon\.ico|css/|js/|img/) {
  root /home/isucon/private_isu.git/webapp/public/;
  expires 1d;
}

location /image/ {
  root /home/isucon/private_isu.git/webapp/public/;
  expires 1d;
  try_files $uri @app;
}

location @app {
  internal;
  proxy_pass http://localhost:8080;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

確認：静的ファイルと画像を取得でき、存在しない画像のリクエストがアプリへ渡ること。

## 5. 任意の作業環境を用意する

計測には不要。必要な場合だけ行う。

### 5.1. Bashの補完と履歴検索

実行場所：サーバー。Bash 4以上で、普段使うユーザーとして実行する。
[dotfilesのBash設定](https://github.com/sorafujitani/dotfiles/tree/main/dot_config/bash)を取得する。
外部のセットアップスクリプトなので、内容を確認してから実行する。

```bash
(
  set -eu
  config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/bash"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  base_url=https://raw.githubusercontent.com/sorafujitani/dotfiles/main/dot_config/bash
  mkdir -p "$config_dir"
  for file in interactive.bash setup.sh; do
    curl -fL --retry 2 "$base_url/$file" -o "$work/$file"
    if [ -e "$config_dir/$file" ]; then
      cp -p "$config_dir/$file" "$config_dir/$file.before-$(date +%Y%m%d-%H%M%S).$$"
    fi
    cp "$work/$file" "$config_dir/$file"
  done
)
less "${XDG_CONFIG_HOME:-$HOME/.config}/bash/interactive.bash" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/bash/setup.sh"
```

内容を確認後、実行してBashを開き直す。

```bash
bash "${XDG_CONFIG_HOME:-$HOME/.config}/bash/setup.sh" && exec bash -l
```

このセットアップは`alp`と`pt-query-digest`も導入するため、両方が使えれば手動導入は不要。
`alp`が`~/.local/bin`にだけある場合は、`sudo alp`でも使える場所へ配置する。

```bash
sudo install -m 755 "$HOME/.local/bin/alp" /usr/local/bin/alp
```

### 5.2. サーバー設定をMacへ保存する

実行場所：ローカル。SSHユーザーが読み取れる設定だけを取得する。

```bash
mkdir -p ~/work/private-isu-local/server-config/system
rsync -avzL isucon-01:/etc/nginx isucon-01:/etc/mysql \
  ~/work/private-isu-local/server-config/
rsync -avzL \
  isucon-01:/etc/systemd/system/isu-ruby.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/nginx.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/mysql.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/memcached.service \
  ~/work/private-isu-local/server-config/system/
```

取得先に認証情報が含まれる場合は、公開リポジトリへ追加しない。

## pproteinでCPU・HTTP・SQLをまとめて計測する

pproteinはGoのCPUプロファイル（pprof）、HTTPログ、SQLスロークエリログをまとめて収集する。
[参照元](https://scrapbox.io/sorafujitani/pprotein_integ)のGoアプリ環境向け。
private-isuのRuby環境とは別の手順。導入済みなら「手元のPCから画面を開く」へ進む。

### 初回の導入

実行場所：Ubuntu/Debianのサーバー。`isucon`ユーザーで作業する。
`alp`・`slp`は導入済みとし、次の設定を用意する。

| 対象 | 必要な設定 |
| --- | --- |
| Goアプリ | pprofを`127.0.0.1:6060`で起動 |
| Nginx | `/var/log/nginx/pprotein-access.log`にLTSV形式で出力 |
| MySQL | `/var/log/mysql/mysql-slow.log`に出力 |
| MySQLの設定値 | `slow_query_log=ON`、`long_query_time=0`、`log_output=FILE` |
| pprotein-agent | 上記ログを読み取り、補助グループ`adm`で実行 |

MySQLの設定は「1.3. MySQLのスロークエリログを設定する」を参照する。
NginxのLTSVログはprivate-isuのJSONログとは別のファイル。

本体とGraphvizをインストールする。

```bash
(
  set -eu
  sudo apt-get update
  sudo apt-get install -y curl ca-certificates graphviz
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo '未対応のアーキテクチャ' >&2; exit 1 ;;
  esac
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fL -o "$work/pprotein.tar.gz" \
    "https://github.com/kaz/pprotein/releases/download/v1.2.4/pprotein_1.2.4_linux_${arch}.tar.gz"
  tar -xzf "$work/pprotein.tar.gz" -C "$work"
  mkdir -p /home/isucon/bin
  install -m 755 "$work/pprotein" "$work/pprotein-agent" /home/isucon/bin/
)
```

次の配置手順は、参照元サーバーの保存済み設定がある場合だけ使える。
設定ファイルとサービス定義は、このリポジトリには含まれない。
開始前に次を確認する。

- `/home/isucon/pprotein/config/nginx-pprotein.conf`が用意されている。
- `/home/isucon/pprotein/systemd/`に`pprotein.service`と`pprotein-agent.service`がある。
- サービスの`PATH`に`alp`・`slp`の配置先が含まれる。
- pprotein-agentの`PPROTEIN_HTTPLOG`が`/var/log/nginx/pprotein-access.log`に設定されている。
- ファイアウォールなどで9000番・19000番をlocalhostからのアクセスに限定している。

公式バイナリは全アドレスで待ち受ける。SSH転送だけでは外部公開を防げない。

```bash
(
  set -eu
  cd /home/isucon/pprotein
  sudo install -D -m 644 config/nginx-pprotein.conf /etc/nginx/conf.d/pprotein.conf
  sudo nginx -t
  sudo systemctl reload nginx
  sudo install -m 644 systemd/pprotein*.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now pprotein pprotein-agent
)
```

Goアプリにpprofを追加した場合は、ビルドして再起動する。

```bash
cd /home/isucon/webapp/go &&
  go build -buildvcs=false -o isuconquest.new . &&
  mv isuconquest.new isuconquest &&
  sudo systemctl restart isuconquest.go
```

確認：サービスが稼働し、後述の5秒計測でCPU・HTTP・SQLのレポートを開けること。

### 手元のPCから画面を開く

実行場所：ローカル。`isucon-01`は普段使うSSH接続先へ置き換える。
専用のSSH設定ファイルを使う場合は、`-F /path/to/config`も指定する。

```bash
ssh -N -L 9000:127.0.0.1:9000 -o ExitOnForwardFailure=yes isucon-01
```

接続したままブラウザで <http://localhost:9000/> を開く。終了はCtrl+C。

### ベンチマークと同時に計測する

実行場所：pproteinの画面と、練習環境のベンチマーク実行端末。
初回は画面のtargets設定を次の内容にする。

| Type | Label | URL |
| --- | --- | --- |
| pprof | isuconquest-cpu | `http://127.0.0.1:6060/debug/pprof/profile` |
| httplog | nginx | `http://127.0.0.1:19000/debug/log/httplog` |
| slowlog | mysql | `http://127.0.0.1:19000/debug/log/slowlog` |

1. 動作確認は全targetsを`Duration=5`にする。本計測は`Duration=60`にする。
2. グループ計測の`Collect`を押す。
3. すぐにベンチマークを実行する。
4. 設定した秒数の後、同じグループのCPU・HTTP・SQLのレポートを開く。

確認：3種類のレポートを開けること。動作確認後は`Duration=60`へ戻す。
CPUは関数、HTTPはAPI、SQLはクエリごとの時間を確認する。
ログは計測中に追記された部分が対象。設定と結果は`/home/isucon/pprotein/data/`に保存される。

公式: <https://github.com/kaz/pprotein>

## 失敗したとき

実行場所：サーバー。該当するサービスだけを確認する。

```bash
sudo nginx -t
sudo systemctl status nginx mysql isu-ruby.service --no-pager
sudo journalctl -u nginx -u mysql -u isu-ruby.service -n 50 --no-pager
```

pprotein環境の場合：

```bash
sudo systemctl status pprotein pprotein-agent isuconquest.go --no-pager
sudo journalctl -u pprotein -u pprotein-agent -u isuconquest.go -n 50 --no-pager
```

アプリや設定ファイルの変更後に異常が出たら、退避版へ戻し、該当する検査と再起動を行う。
解決できなければ作業を止め、実行コマンド・エラー・変更箇所をチームへ共有する。
