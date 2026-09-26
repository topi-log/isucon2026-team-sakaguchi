# ISUCONコマンド集の追加

## 目的と完了条件

ZennのISUCONコマンド集をチームリポジトリで参照できるようにする。本文を追加してREADMEから辿れるようにし、`main`向けのPRを作成する。

## 確認済みの状態

- 作業ブランチ: `docs/add-isucon-command-collection`（`origin/main`から分岐）
- 記事はZenn固有のfront matterを外し、GitHubで読めるMarkdownとして配置した。
- すべての`nano`を`vim`に変更し、冒頭に`vim`のインストール手順を追加した。指定されたdotfilesの`setup.sh`にも`vim`が含まれる。
- MySQL再起動後に`slow_query_log`、`slow_query_log_file`、`long_query_time`、`log_output`を表示する確認コマンドを追加した。
- `id_generator`を含むテーブルのInnoDBロック待ちを調べるSQLを追加した。
- ベンチマーク前のログ消去、MySQLログ再オープン、Nginx再読込みを、失敗時に後続を止める`&&`で順につないだ。
- READMEに学習ログへのリンクを追加した。
- 既存checkoutには未コミット変更があるため、専用worktreeで作業している。
- GitHub repositoryの既定ブランチは`main`、作成時点のopen PRは0件。
- PRは未作成。base=`main`、reviewer=なし、title案を提示し、作成確認を待っている。

## 次の作業

PR作成案はbase=`main`、reviewer=なし、title=`docs: add ISUCON command collection learning log`。ユーザーの実行確認後、現在のfeature branchからPRを作成する。
