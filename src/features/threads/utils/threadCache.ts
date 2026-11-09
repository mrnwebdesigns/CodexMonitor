import type { ConversationItem } from "@/types";

export const MAX_INACTIVE_THREADS = 12;
export const MAX_INACTIVE_THREAD_BYTES = 16 * 1024 * 1024;

export function isLocalConversationItem(item: ConversationItem) {
  return item.kind === "userInput"
    || item.id.startsWith("review-start-")
    || /^\d+-assistant$/.test(item.id);
}

function estimateBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2;
  if (value && typeof value === "object") {
    return Object.values(value).reduce<number>((total, field) => total + estimateBytes(field), 32);
  }
  return 8;
}

const snapshotSizes = new WeakMap<ConversationItem[], number>();

export function getReplayableThreadBytes(items: ConversationItem[]) {
  const cached = snapshotSizes.get(items);
  if (cached !== undefined) return cached;
  const bytes = items.reduce(
    (total, item) => total + (isLocalConversationItem(item) ? 0 : estimateBytes(item)),
    0,
  );
  snapshotSizes.set(items, bytes);
  return bytes;
}
