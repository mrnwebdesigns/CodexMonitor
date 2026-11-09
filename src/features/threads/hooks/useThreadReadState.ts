import { useCallback, useEffect, useRef } from "react";
import type { Dispatch } from "react";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";

export const UNREAD_THREADS_STORAGE_KEY = "codexmonitor.unreadThreads.v1";
export const IMPORTED_THREAD_ACTIVITY_STORAGE_KEY = "codexmonitor.importedThreadActivity.v1";
export type ImportedThreadActivity = {
  threadId: string;
  turnId: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
};

function loadImportedActivity(): Record<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(IMPORTED_THREAD_ACTIVITY_STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry) => typeof entry[1] === "string"));
  } catch { return {}; }
}

export function loadUnreadThreadStatuses(): ThreadState["threadStatusById"] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(UNREAD_THREADS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(stored)) return {};
    return Object.fromEntries(stored
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .map((id) => [id, {
        isProcessing: false,
        isReviewing: false,
        hasUnread: true,
        processingStartedAt: null,
        lastDurationMs: null,
      }]));
  } catch {
    return {};
  }
}

function isWindowVisible() {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useThreadReadState({
  activeThreadId,
  threadStatusById,
  dispatch,
}: {
  activeThreadId: string | null;
  threadStatusById: ThreadState["threadStatusById"];
  dispatch: Dispatch<ThreadAction>;
}) {
  const importedActivityRef = useRef<Record<string, string> | null>(null);
  if (!importedActivityRef.current) importedActivityRef.current = loadImportedActivity();
  useEffect(() => {
    try {
      localStorage.setItem(UNREAD_THREADS_STORAGE_KEY, JSON.stringify(
        Object.keys(threadStatusById).filter((id) => {
          const status = threadStatusById[id];
          // Restored flags start idle; do not restore an in-progress message as finished.
          return status.hasUnread && !status.isProcessing && !status.isReviewing;
        }),
      ));
    } catch { /* Keep read state usable for this session when storage is unavailable. */ }
  }, [threadStatusById]);

  const activeHasUnread = activeThreadId ? threadStatusById[activeThreadId]?.hasUnread : false;
  useEffect(() => {
    const markViewed = () => {
      if (activeThreadId && activeHasUnread && isWindowVisible()) {
        dispatch({ type: "markUnread", threadId: activeThreadId, hasUnread: false });
      }
    };
    markViewed();
    window.addEventListener("focus", markViewed);
    document.addEventListener("visibilitychange", markViewed);
    return () => {
      window.removeEventListener("focus", markViewed);
      document.removeEventListener("visibilitychange", markViewed);
    };
  }, [activeThreadId, activeHasUnread, dispatch]);

  const onThreadCompleted = useCallback((_workspaceId: string, threadId: string) => {
    dispatch({
      type: "markUnread",
      threadId,
      hasUnread: threadId !== activeThreadId || !isWindowVisible(),
    });
  }, [activeThreadId, dispatch]);

  const onImportedThreadActivity = useCallback((workspaceId: string, activity: ImportedThreadActivity) => {
    const { threadId, turnId, status } = activity;
    const key = JSON.stringify([turnId, status]);
    if (importedActivityRef.current?.[threadId] === key && status !== "inProgress") return;
    importedActivityRef.current = { ...importedActivityRef.current, [threadId]: key };
    try {
      localStorage.setItem(IMPORTED_THREAD_ACTIVITY_STORAGE_KEY, JSON.stringify(importedActivityRef.current));
    } catch { /* Deduplication still applies for this session. */ }
    if (status === "inProgress") {
      // Persisted unfinished history does not prove a live executor is running.
      dispatch({ type: "markUnread", threadId, hasUnread: false });
    } else {
      dispatch({ type: "markProcessing", threadId, isProcessing: false, timestamp: Date.now() });
      onThreadCompleted(workspaceId, threadId);
    }
  }, [dispatch, onThreadCompleted]);

  return { onThreadCompleted, onImportedThreadActivity };
}
