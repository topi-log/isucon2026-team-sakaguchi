export const storageEndpoint = process.env.AWS_ENDPOINT ?? "http://localhost:4566";
const storageRequestTimeoutMs = 3_000;

export function fetchStorage(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${storageEndpoint}${path}`, {
    ...init,
    signal: AbortSignal.timeout(storageRequestTimeoutMs),
  });
}

export async function ensureStorageBucket(): Promise<void> {
  const response = await fetchStorage("/sakaguchi-assets", { method: "PUT" });
  if (!response.ok && response.status !== 409) {
    throw new Error(`failed to initialize storage bucket: HTTP ${response.status}`);
  }
}
