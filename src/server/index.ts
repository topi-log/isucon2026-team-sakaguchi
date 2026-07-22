import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pool, waitForDatabase } from "./db.ts";
import { parseCreatePostInput, parseLimit } from "./request.ts";
import { ensureStorageBucket, fetchStorage, storageEndpoint } from "./storage.ts";

const app = new Hono();
const port = Number(process.env.PORT ?? 3000);
const seedPath = process.env.SEED_PATH ?? "/app/database/seed.sql";

app.use("*", async (context, next) => {
  const startedAt = performance.now();
  await next();
  const durationMs = performance.now() - startedAt;
  context.header("Server-Timing", `app;dur=${durationMs.toFixed(1)}`);
  console.log(
    JSON.stringify({
      method: context.req.method,
      path: context.req.path,
      status: context.res.status,
      durationMs: Number(durationMs.toFixed(2)),
    }),
  );
});

app.get("/api/health", async (context) => {
  const result = await pool.query<{ now: string }>("SELECT now()::text AS now");
  return context.json({ status: "ok", databaseTime: result.rows[0]?.now });
});

app.get("/api/posts", async (context) => {
  const limit = parseLimit(context.req.query("limit"));
  const result = await pool.query({
    text: `
      WITH selected_posts AS MATERIALIZED (
        SELECT id, user_id, title, body, created_at
        FROM posts
        ORDER BY created_at DESC
        LIMIT $1
      )
      SELECT
        p.id,
        p.title,
        p.body,
        u.display_name AS "authorName",
        COALESCE(c.count, 0)::int AS "commentCount",
        COALESCE(l.count, 0)::int AS "likeCount",
        p.created_at AS "createdAt"
      FROM selected_posts p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count FROM comments WHERE post_id = p.id
      ) c ON true
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS count FROM likes WHERE post_id = p.id
      ) l ON true
      ORDER BY p.created_at DESC
    `,
    values: [limit],
  });
  return context.json({ posts: result.rows });
});

app.get("/api/posts/:id", async (context) => {
  const id = Number(context.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: "invalid post id" }, 400);

  const post = await pool.query({
    text: `SELECT p.id, p.title, p.body, p.created_at AS "createdAt",
                  u.id AS "authorId", u.display_name AS "authorName"
           FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
    values: [id],
  });
  if (!post.rows[0]) return context.json({ error: "post not found" }, 404);

  const comments = await pool.query({
    text: `SELECT c.id, c.body, c.created_at AS "createdAt", u.display_name AS "authorName"
           FROM comments c JOIN users u ON u.id = c.user_id
           WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
    values: [id],
  });
  return context.json({ post: post.rows[0], comments: comments.rows });
});

app.post("/api/posts", async (context) => {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    return context.json({ error: "userId, title and body are required" }, 400);
  }
  const body = parseCreatePostInput(value);
  if (!body) return context.json({ error: "userId, title and body are required" }, 400);
  const result = await pool.query({
    text: `INSERT INTO posts (user_id, title, body) VALUES ($1, $2, $3)
           RETURNING id, user_id AS "userId", title, body, created_at AS "createdAt"`,
    values: [body.userId, body.title, body.body],
  });
  return context.json({ post: result.rows[0] }, 201);
});

app.get("/api/storage", async (context) => {
  const response = await fetchStorage("/sakaguchi-assets?list-type=2");
  return context.json({
    status: response.ok ? "ok" : "error",
    endpoint: storageEndpoint,
    httpStatus: response.status,
  });
});

app.post("/api/initialize", async (context) => {
  if (
    context.req.header("x-initialize-token") !== (process.env.INITIALIZE_TOKEN ?? "sakaguchi-local")
  ) {
    return context.json({ error: "invalid initialize token" }, 403);
  }
  const seedSql = await readFile(seedPath, "utf8");
  await pool.query(seedSql);
  await ensureStorageBucket();
  return context.json({ status: "ok" });
});

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: "internal server error" }, 500);
});

await waitForDatabase();
await ensureStorageBucket();
serve({ fetch: app.fetch, port }, (info) => console.log(`API listening on :${info.port}`));
