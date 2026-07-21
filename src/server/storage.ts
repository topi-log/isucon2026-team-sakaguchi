const endpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4566";

export async function ensureStorageBucket(): Promise<void> {
  const response = await fetch(`${endpoint}/sakaguchi-assets`, { method: "PUT" });
  if (!response.ok && response.status !== 409) {
    throw new Error(`failed to initialize storage bucket: HTTP ${response.status}`);
  }
}
