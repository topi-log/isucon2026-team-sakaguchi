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

この手順は`interactive.bash`と`setup.sh`を`${XDG_CONFIG_HOME:-$HOME/.config}/bash`へ配置し、既存ファイルがあれば退避してからBashの読込み設定を追加する。
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

```sql
sudo mysqldumpslow -s t -t 10 /var/log/mysql/mysql-slow.log | less
```

### MySQLに接続

```bash
sudo mysql -u root
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
