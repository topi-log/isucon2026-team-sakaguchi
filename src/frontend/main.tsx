import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Post = {
  id: string;
  title: string;
  body: string;
  authorName: string;
  commentCount: number;
  likeCount: number;
  createdAt: string;
};

function App() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/posts")
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ posts: Post[] }>;
      })
      .then(({ posts: loadedPosts }) => setPosts(loadedPosts))
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "読み込みに失敗しました"),
      );
  }, []);

  return (
    <main>
      <header>
        <p className="eyebrow">LOCAL BENCHMARK</p>
        <h1>Sakaguchi Practice Feed</h1>
        <p>nginx / Hono / PostgreSQL / kumo</p>
      </header>
      {error && <p className="error">API error: {error}</p>}
      <section aria-label="投稿一覧">
        {posts.map((post) => (
          <article key={post.id}>
            <div className="meta">
              <span>{post.authorName}</span>
              <time>{new Date(post.createdAt).toLocaleString("ja-JP")}</time>
            </div>
            <h2>{post.title}</h2>
            <p>{post.body}</p>
            <footer>
              ♥ {post.likeCount}　⌁ {post.commentCount} comments
            </footer>
          </article>
        ))}
      </section>
    </main>
  );
}

const root = document.querySelector("#root");
if (!root) throw new Error("#root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
