import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { pool, waitForDatabase } from "./db.ts";
import { parseLimit } from "./request.ts";
import { ensureStorageBucket } from "./storage.ts";

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
      SELECT
        p.id,
        p.title,
        p.body,
        u.display_name AS "authorName",
        COUNT(DISTINCT c.id)::int AS "commentCount",
        COUNT(DISTINCT l.user_id)::int AS "likeCount",
        p.created_at AS "createdAt"
      FROM posts p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN comments c ON c.post_id = p.id
      LEFT JOIN likes l ON l.post_id = p.id
      GROUP BY p.id, u.display_name
      ORDER BY p.created_at DESC
      LIMIT $1
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
  const body = await context.req.json<{ userId?: number; title?: string; body?: string }>();
  if (!body.userId || !body.title?.trim() || !body.body?.trim()) {
    return context.json({ error: "userId, title and body are required" }, 400);
  }
  const result = await pool.query({
    text: `INSERT INTO posts (user_id, title, body) VALUES ($1, $2, $3)
           RETURNING id, user_id AS "userId", title, body, created_at AS "createdAt"`,
    values: [body.userId, body.title.trim(), body.body.trim()],
  });
  return context.json({ post: result.rows[0] }, 201);
});

app.get("/api/storage", async (context) => {
  const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4566";
  const response = await fetch(`${endpoint}/sakaguchi-assets?list-type=2`);
  return context.json({
    status: response.ok ? "ok" : "error",
    endpoint,
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
