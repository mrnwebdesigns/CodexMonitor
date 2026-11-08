export type MessageSearchStatus = {
  phase: "starting" | "indexing" | "ready" | "paused" | "lowDisk" | "stalled";
  paused: boolean;
  includeTools: boolean;
  threadsTotal: number;
  threadsIndexed: number;
  messageCount: number;
  toolCount: number;
  indexBytes: number;
  reclaimableBytes: number;
  transcriptBytes: number;
  referencedTranscriptBytes: number;
  historyDatabaseBytes: number;
  diskFreeBytes: number;
  lastIndexedMs: number | null;
  lastInventoryMs: number | null;
  lastBatchMs: number | null;
  warnings: string[];
};

export type MessageSearchResult = {
  threadId: string;
  workspaceId: string;
  title: string;
  excerpt: string;
  category: "message" | "tool";
};

export type MessageSearchResponse = {
  results: MessageSearchResult[];
  elapsedMs: number;
  status: MessageSearchStatus | null;
};

export type MessageSearchAction = "pause" | "resume" | "clear" | "rebuild" | "compact" | "enableTools" | "disableTools";
