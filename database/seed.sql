TRUNCATE likes, comments, posts, users RESTART IDENTITY CASCADE;

INSERT INTO users (username, display_name, created_at)
SELECT 'user' || n, 'ユーザー ' || n, now() - (n || ' hours')::interval
FROM generate_series(1, 100) AS n;

INSERT INTO posts (user_id, title, body, created_at)
SELECT
  ((n - 1) % 100) + 1,
  '練習投稿 #' || n,
  'これは Sakaguchi のローカル負荷試験に使うサンプル投稿です。投稿番号: ' || n,
  now() - (n || ' minutes')::interval
FROM generate_series(1, 500) AS n;

INSERT INTO comments (post_id, user_id, body, created_at)
SELECT
  ((n - 1) % 500) + 1,
  ((n * 7 - 1) % 100) + 1,
  'コメント ' || n,
  now() - (n || ' seconds')::interval
FROM generate_series(1, 5000) AS n;

INSERT INTO likes (post_id, user_id, created_at)
SELECT post_id, user_id, now() - ((post_id + user_id) || ' seconds')::interval
FROM generate_series(1, 500) AS post_id
CROSS JOIN generate_series(1, 20) AS user_id;

ANALYZE;
