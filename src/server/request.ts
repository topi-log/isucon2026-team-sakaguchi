export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 20;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return 20;
  return Math.min(Math.max(value, 1), 100);
}
