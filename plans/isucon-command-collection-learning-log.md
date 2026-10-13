# ISUCON学習ログ：練習で使うコマンド集

private-isuの練習で使うコマンドを、ツールのセットアップ、ログ出力の設定、設定の反映、計測、最適化の順にまとめた。

## ツールをセットアップする

UbuntuまたはDebianの競技用サーバーで、先にVimをインストールする。rootユーザーでは`sudo`を外す。

```bash
sudo apt-get update
sudo apt-get install -y vim
```

### Bashの補完と履歴検索

[dotfilesのBash設定](https://github.com/sorafujitani/dotfiles/tree/main/dot_config/bash)を使う場合は、UbuntuまたはDebianのBash 4以上と、root権限またはsudo権限が必要。
SSH先で普段使うユーザーとして、`~/setup-remote-bash.sh`を作成し、次の内容を保存する。

```bash
vim ~/setup-remote-bash.sh
```

```bash
#!/usr/bin/env bash
set -e

if (( EUID == 0 )); then
  apt-get update
  apt-get install -y curl ca-certificates
else
  sudo apt-get update
  sudo apt-get install -y curl ca-certificates
fi

config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/bash"
download_dir=$(mktemp -d)
trap 'rm -rf -- "$download_dir"' EXIT
base_url=https://raw.githubusercontent.com/sorafujitani/dotfiles/main/dot_config/bash
for file in interactive.bash setup.sh; do
  curl -fL --retry 2 "$base_url/$file" -o "$download_dir/$file"
done

mkdir -p "$config_dir"
for file in interactive.bash setup.sh; do
  if [[ -e "$config_dir/$file" ]]; then
    cp -p "$config_dir/$file" "$config_dir/$file.backup.$(date +%Y%m%d%H%M%S).$$"
  fi
  cp "$download_dir/$file" "$config_dir/$file"
done
bash "$config_dir/setup.sh"
```

保存後、同じSSH先で実行してBashを開き直す。

```bash
bash ~/setup-remote-bash.sh && exec bash -l
```

この手順は`interactive.bash`と`setup.sh`を`${XDG_CONFIG_HOME:-$HOME/.config}/bash`へ配置する。
既存ファイルがあれば退避してからBashの読込み設定を追加する。
`setup.sh`は補完と履歴検索に使うツールのほか、`alp`と`pt-query-digest`も導入する。
セットアップが成功した場合は、後述の`alp`と`pt-query-digest`の手動導入は不要。
`isucon`ユーザーの`~/.local/bin/alp`を`/usr/local/bin`にも配置する場合は、次のコマンドを実行する。

```bash
sudo install -m 755 /home/isucon/.local/bin/alp /usr/local/bin/alp
```

### alp

上記のBashセットアップを使わない場合は、手動で導入する。

競技用サーバーでアーキテクチャを確認し、`/tmp`へ移動する。

```bash
uname -m
cd /tmp
```

alpのamd64版をダウンロードして展開し、実行ファイルを配置する。

```bash
curl -fLO https://github.com/tkuchiki/alp/releases/download/v1.0.21/alp_linux_amd64.tar.gz
tar -xzf alp_linux_amd64.tar.gz
sudo install -m 0755 alp /usr/local/bin/alp
alp --version
```

### pt-query-digest

上記のBashセットアップを使わない場合は、手動で導入する。

```bash
sudo apt update
sudo apt install percona-toolkit
pt-query-digest --version
```

## ログの出力を設定する

### NginxのアクセスログをJSON形式にする

競技用サーバーでNginxの設定ファイルを開く。

```bash
sudo vim /etc/nginx/nginx.conf
```

`http { ... }`ブロック内にJSON形式のログ設定を追記、または確認する。

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

### Nginxの設定を検査して再読み込みする

設定を検査し、成功した場合だけNginxへ反映する。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### MySQLのスロークエリ設定

競技用サーバーでMySQLの設定ファイルを開く。

```bash
sudo mkdir -p /etc/mysql/mysql.conf.d
sudo touch /etc/mysql/mysql.conf.d/mysqld.cnf
sudo vim /etc/mysql/mysql.conf.d/mysqld.cnf
```

```ini
[mysqld]
slow_query_log = 1
slow_query_log_file = /var/log/mysql/mysql-slow.log
long_query_time = 0
```

```bash
sudo mysqld --validate-config
sudo systemctl restart mysql
sudo systemctl status mysql
```

設定が反映されたことを確認する。

```bash
sudo mysql -e "
  SHOW VARIABLES
  WHERE Variable_name IN (
    'slow_query_log',
    'slow_query_log_file',
    'long_query_time',
    'log_output'
  );
"
```

権限の問題で書き込めない場合

```bash
sudo touch /var/log/mysql/mysql-slow.log
sudo chown mysql:adm /var/log/mysql/mysql-slow.log
sudo chmod 640 /var/log/mysql/mysql-slow.log
```

mysqlで問題が起こっていそうな時

```bash
sudo journalctl -xeu mysql --no-pager
```

## 計測コマンド

### ベンチマーク前にログを空にする

ベンチマークを回す直前に、アクセスログとスロークエリログを空にし、ログを開き直す。

```bash
sudo truncate -s 0 /var/log/nginx/access.log &&
  sudo truncate -s 0 /var/log/mysql/mysql-slow.log &&
  sudo mysqladmin flush-logs &&
  sudo systemctl reload nginx
```

### スロークエリログ

```bash
sudo mysqldumpslow -s t -t 10 /var/log/mysql/mysql-slow.log | less
```

### MySQLに接続

```bash
sudo mysql -u root
```

### MySQLのロック待ちを確認する

`id_generator`を含むテーブルのロック待ちと、待機側・ブロック側のクエリを確認する。

```sql
SELECT
  wait_started,
  wait_age,
  locked_table,
  locked_index,
  waiting_pid,
  blocking_pid,
  waiting_query,
  blocking_query
FROM sys.innodb_lock_waits
WHERE locked_table LIKE '%id_generator%';
```

### スキーマの確認

```sql
SHOW DATABASES;
USE データベース名;
SHOW CREATE TABLE comments;
```

### 実行計画

```sql
EXPLAIN SELECT * FROM comments
WHERE post_id = 1
ORDER BY created_at DESC
LIMIT 1;
```

### インデックスを貼る

```sql
ALTER TABLE comments
ADD INDEX post_id_idx (post_id, created_at DESC);
```

### Unicornのプロセス数

rbの設定ファイルの場所を探す

```bash
sudo find / -name 'unicorn_config.rb' 2>/dev/null
```

設定更新

```bash
sudo systemctl restart isu-ruby.service
```

### JSONログの出力を確認する

古いログやテキスト形式のログを空にしてから、テストリクエストを送る。

```bash
sudo truncate -s 0 /var/log/nginx/access.log
curl -I http://localhost/
```

ログの先頭行がJSON形式であることを確認する。

```bash
sudo head -n 1 /var/log/nginx/access.log
```

### alpでアクセスログを集計する

`alp json`でアクセスログを解析、集計する。

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

### pt-query-digestでスロークエリを集計する

スロークエリログを表示する。

```bash
sudo pt-query-digest /var/log/mysql/mysql-slow.log | less
```

解析結果をファイルへ保存する。

```bash
sudo pt-query-digest /var/log/mysql/mysql-slow.log | tee "digest_$(date +%Y%m%d%H%M).txt"
```

### 投稿一覧のSQLを確認する

```sql
SELECT `id`, `user_id`, `body`, `created_at`, `mime`
FROM `posts`
ORDER BY `created_at` DESC;
```

## 最適化コマンド

### VS Codeでサーバーに接続する

VS CodeにMicrosoftのRemote - SSH拡張機能をインストールする。

1. `Cmd + Shift + P`でコマンドパレットを開く。
2. `Remote-SSH: Connect to Host...`を選ぶ。
3. 普段ターミナルからSSH接続するときと同じ接続先を選ぶ。例えば、普段`ssh isucon-01`なら`isucon-01`を選ぶ。
4. 接続後、「ファイル → フォルダーを開く」で次のパスを指定する。

```text
/home/isucon/private_isu.git/webapp
```

### Macへコードと設定をコピーする

Mac側で作業ディレクトリを作り、サーバーから`webapp`を取得する。

```bash
mkdir -p ~/work/private-isu-local/server-config/system

rsync -avz \
  isucon-01:/home/isucon/private_isu.git/webapp \
  ~/work/private-isu-local/
```

NginxとMySQLの設定をコピーする。

```bash
rsync -avzL \
  isucon-01:/etc/nginx \
  isucon-01:/etc/mysql \
  ~/work/private-isu-local/server-config/
```

systemdの設定をコピーする。

```bash
rsync -avzL \
  isucon-01:/etc/systemd/system/isu-ruby.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/nginx.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/mysql.service \
  isucon-01:/etc/systemd/system/multi-user.target.wants/memcached.service \
  ~/work/private-isu-local/server-config/system/
```

```bash
codex
```

### Rubyの配置先を確認してファイルを反映する

実行中のRubyの配置先を確認する。

```bash
sudo systemctl show isu-ruby -p WorkingDirectory -p ExecStart
```

サーバー上で、変更前の`app.rb`を退避する。

```bash
cp -p /home/isucon/private_isu.git/webapp/ruby/app.rb \
  "/home/isucon/app.rb.before-$(date +%Y%m%d-%H%M%S)"
```

Mac側から確認したファイルをサーバーへ転送する。

```bash
rsync -avz \
  ~/work/private-isu-local/webapp/ruby/app.rb \
  isucon-01:/home/isucon/private_isu.git/webapp/ruby/app.rb
```

Rubyサービスの設定を変更した場合は、再起動して反映する。

```bash
sudo systemctl restart isu-ruby.service
```

### Nginxから静的ファイルを配信する

競技用サーバーで`sites-enabled`を確認し、`sites-available/isucon.conf`を編集する。

```bash
ls -la /etc/nginx/sites-enabled/
sudo vim /etc/nginx/sites-available/isucon.conf
```

```nginx
location ~ ^/(favicon\.ico|css/|js/|img/) {
  root /home/isucon/private_isu/webapp/public/;
  expires 1d;
}
```

### 投稿画像のNginx設定

```nginx
location /image/ {
  root /home/isucon/private_isu/webapp/public/;
  expires 1d;
  try_files $uri @app;
}

location @app {
  internal;
  proxy_pass http://localhost:8080;
}
```

設定を検査し、問題がなければ反映する。

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## pproteinでCPU・HTTP・SQLをまとめて計測する

pproteinを使うと、同じベンチマーク中のCPU使用状況、HTTPアクセスログ、SQLの実行時間をまとめて確認できる。
以下は[pprotein導入・確認手順](https://scrapbox.io/sorafujitani/pprotein_integ)のGoアプリ環境を対象とする。
未導入環境向けの設定例は、[公式v1.2.4](https://github.com/kaz/pprotein/tree/v1.2.4)の実装に基づいて補足した。
この記事のprivate-isuのRuby環境とは、アプリの配置先・サービス名・ログ形式が異なる。

### 導入済み環境の構成

| 対象 | 配置・設定 |
| --- | --- |
| pprotein v1.2.4 | `/home/isucon/bin/pprotein`。画面は9000番 |
| pprotein-agent | `/home/isucon/bin/pprotein-agent`。ログ取得は19000番で、localhost限定 |
| Goアプリ | `webapp/go/profiling.go`で`127.0.0.1:6060`にpprofを追加し、`main.go`から起動 |
| Nginx | LTSV形式のアクセスログを出力 |
| MySQL | スロークエリログを有効にし、`long_query_time=0` |
| 集計ツール | 既存の`~/.local/bin/alp`、`~/.local/bin/slp`とGraphvizを使用 |

設定の控えは`/home/isucon/pprotein/config/`、サービス定義は`/home/isucon/pprotein/systemd/`にある。
実際に使う設定と計測結果は`/home/isucon/pprotein/data/`に保存され、pprotein-agentは補助グループ`adm`でログを読み取る。
Nginxの設定は`/etc/nginx/conf.d/pprotein.conf`に置き、ログは`/var/log/nginx/pprotein-access.log`へ出力する。
MySQLのログ出力先は`/var/log/mysql/mysql-slow.log`。
この節のNginxログはLTSV形式で、前述の`alp json`に渡すJSONログとは別のファイル。

### 未導入環境にセットアップする

Ubuntu/Debian、systemd、`isucon`ユーザーでの作業を前提とする。
Goアプリ、Nginx、MySQLは導入済みとし、設定変更前に既存ファイルを退避する。
以下は新規導入用の例で、参照元サーバーに保存された設定ファイルそのものではない。
導入済みの場合は実行せず、「手元のPCから画面を開く」へ進む。

#### 本体と集計ツールを配置する

サーバー上で実行する。Linuxのamd64とarm64に対応する。
途中で失敗した場合は、解決するまで次の手順へ進まない。

```bash
sudo apt-get update && sudo apt-get install -y curl ca-certificates graphviz
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

#### Goアプリにpprofを追加する

pprofはGoのCPU使用状況などを取得するHTTPエンドポイント。
`/home/isucon/webapp/go/profiling.go`に次のコードを追加し、`main.go`の`main()`から`startProfiling()`を呼ぶ。
既にpprofを起動している場合は追加せず、その待受先を利用する。

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

後述の「導入時の設定配置とGoアプリの反映」でビルド・再起動する。

#### NginxとMySQLのログを用意する

`/home/isucon/pprotein/config/nginx-pprotein.conf`にログ形式の定義を保存する。
Ubuntu/Debian標準の構成では、`conf.d/*.conf`は`http`コンテキストから読み込まれる。
異なる構成では、`log_format`を`http`内に配置する。

```nginx
log_format pprotein_ltsv 'time:$time_iso8601\tmethod:$request_method\turi:$request_uri\tstatus:$status\tsize:$body_bytes_sent\treqtime:$request_time';
```

計測対象の`server`ブロックに次の行を追加する。
既存のJSONログも残す場合は、その`access_log`行と同じブロックへ追加する。
ログ形式の定義だけでは、アクセスログは出力されない。

```nginx
access_log /var/log/nginx/pprotein-access.log pprotein_ltsv;
```

MySQLは前述の「MySQLのスロークエリ設定」に従い、ファイルへの出力を有効にする。
`log_output=FILE`、`slow_query_log=ON`、`long_query_time=0`を確認する。
`long_query_time=0`はログ量が増えるため、空き容量も確認する。
ログ作成後、エージェントの実行ユーザーが読み取れるようにする。

```bash
sudo touch /var/log/nginx/pprotein-access.log /var/log/mysql/mysql-slow.log
sudo chown www-data:adm /var/log/nginx/pprotein-access.log
sudo chown mysql:adm /var/log/mysql/mysql-slow.log
sudo chmod 640 /var/log/nginx/pprotein-access.log /var/log/mysql/mysql-slow.log
sudo -u isucon -g adm test -r /var/log/nginx/pprotein-access.log
sudo -u isucon -g adm test -r /var/log/mysql/mysql-slow.log
```

Nginxの実行ユーザーが`www-data`でない環境では、所有者を置き換える。
ログローテーション後も所有者と権限を維持する。

#### systemdサービスを用意する

次を`/home/isucon/pprotein/systemd/pprotein.service`に保存する。
`PATH`には集計ツールの配置先を含める。
既存の`alp`・`slp`が別のディレクトリにある場合は、そのパスも追加する。

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

次を`/home/isucon/pprotein/systemd/pprotein-agent.service`に保存する。

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

`PPROTEIN_GIT_REPOSITORY`はアプリのGitリポジトリのパスへ置き換える。
公式バイナリは9000番・19000番を全アドレスで待ち受けるため、上記ではsystemdでlocalhost以外の通信を拒否する。
この制限にはカーネルのcgroup BPF対応が必要で、非対応環境では効かない。
起動前に、ファイアウォールでも両ポートへの外部アクセスを遮断する。
SSH転送だけでは、サーバー側の公開ポートを制限できない。

後述の「導入時の設定配置とGoアプリの反映」で配置・起動する。
`nginx -t`、アプリのビルド、サービス起動のいずれかが失敗した場合は、計測へ進まずログを確認する。

#### 計測先を設定する

「手元のPCから画面を開く」に従い、画面のグループ計測のtargets設定を次の内容に変更する。
初期値の9000番はpprotein自身を計測するため、アプリの6060番とエージェントの19000番へ変更する。

```json
[
  {
    "Type": "pprof",
    "Label": "isuconquest-cpu",
    "URL": "http://127.0.0.1:6060/debug/pprof/profile",
    "Duration": 60
  },
  {
    "Type": "httplog",
    "Label": "nginx",
    "URL": "http://127.0.0.1:19000/debug/log/httplog",
    "Duration": 60
  },
  {
    "Type": "slowlog",
    "Label": "mysql",
    "URL": "http://127.0.0.1:19000/debug/log/slowlog",
    "Duration": 60
  }
]
```

まず`Duration`をすべて5に変更してCollectを押し、ベンチマークなどでアプリに負荷をかける。
CPU・HTTP・SQLの収集を確認する。
3種類の結果とレポートを開けたら、すべて60へ戻してベンチマークと同時に計測する。
URLのまとめ方は、画面のhttplog設定にある`matching_groups`をアプリのパスに合わせて変更する。

### 手元のPCから画面を開く

導入済みの場合はここから始める。手元のPCのターミナルで、SSH接続を通じてサーバーの9000番を転送する。
次の`-F`には、参照元の環境で使うSSH設定ファイルを指定している。別の環境では、普段使うSSH設定ファイルと接続先に置き換える。

```bash
ssh -F ~/.ssh/prox-isu-portal/79904627-26ab-4ff9-a5e8-d9ec3f189dce/config \
  -N -L 9000:127.0.0.1:9000 \
  -o ExitOnForwardFailure=yes isucon-01
```

何も表示されず待機していれば、ブラウザで`http://localhost:9000/`を開く。
VS Codeは不要。接続を終了するときは、このターミナルで`Ctrl+C`を押す。

### ベンチマークと同時に計測する

1. 画面のグループ計測の`Collect`を押す。
2. すぐにベンチマークを実行する。
3. 60秒後、同じグループの結果を開く。

| 結果 | 確認すること |
| --- | --- |
| `isuconquest-cpu` / pprof | CPUを使っているGoの関数 |
| `nginx` / httplog | 時間がかかるAPI。ユーザーIDなどが異なるURLはまとめて集計 |
| `mysql` / slowlog | 時間がかかるSQL |

計測時間は画面のtargets設定の`Duration`で変更する。ログは計測中に追記された部分が対象。

### 状態とログを確認する

画面を開けない、または結果が出ない場合は、サーバー上でサービスの状態とログを確認する。

```bash
sudo systemctl status pprotein pprotein-agent isuconquest.go
sudo journalctl -u pprotein -u pprotein-agent -n 50 --no-pager
```

### 導入時の設定配置とGoアプリの反映

以下は参照元の環境で実施済みの設定配置手順。
新規導入の場合は、前述の手順で本体・設定ファイル・サービス定義を用意してから実行する。
サーバー上で実行する。

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

Goアプリを変更した場合は、サーバー上で実行ファイルを作り直し、サービスを再起動する。

```bash
cd /home/isucon/webapp/go
go build -buildvcs=false -o isuconquest.new . &&
  mv isuconquest.new isuconquest &&
  sudo systemctl restart isuconquest.go
```

参照元では、導入時の5秒間の動作確認でCPU・HTTP・SQLの収集とレポート生成が成功したと記録されている。
公式リポジトリ：[kaz/pprotein](https://github.com/kaz/pprotein)。
