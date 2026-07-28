export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return 20;
  return Math.min(Math.max(value, 1), 100);
}

export type CreatePostInput = {
  userId: number;
  title: string;
  body: string;
};

export function parseCreatePostInput(value: unknown): CreatePostInput | null {
  if (typeof value !== "object" || value === null) return null;

  const { userId, title, body } = value as Record<string, unknown>;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 1) return null;
  if (typeof title !== "string" || typeof body !== "string") return null;

  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle || !trimmedBody) return null;

  return { userId, title: trimmedTitle, body: trimmedBody };
}
