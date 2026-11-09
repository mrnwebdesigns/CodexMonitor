import { useLayoutEffect, useRef, type Dispatch, type RefObject } from "react";
import {
  getReplayableThreadBytes,
  MAX_INACTIVE_THREADS,
  MAX_INACTIVE_THREAD_BYTES,
} from "@threads/utils/threadCache";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";

export function useInactiveThreadCache(
  state: ThreadState,
  activeThreadId: string | null,
  dispatch: Dispatch<ThreadAction>,
  loadedThreadsRef: RefObject<Record<string, boolean>>,
  evictedThreadsRef: RefObject<Set<string>>,
  pendingInterruptsRef: RefObject<Set<string>>,
) {
  const recency = useRef(new Set<string>());

  useLayoutEffect(() => {
    const order = recency.current;
    for (const id of order) {
      if (!state.itemsByThread[id]) order.delete(id);
    }
    for (const id of Object.keys(state.itemsByThread)) order.add(id);
    if (activeThreadId && order.delete(activeThreadId)) order.add(activeThreadId);

    const pending = new Set(state.userInputRequests.map(({ params }) => params.thread_id));
    for (const { params } of state.approvals) {
      const id = params.threadId ?? params.thread_id;
      if (typeof id === "string") pending.add(id);
    }

    let retained = 0;
    let retainedBytes = 0;
    const evict = [];
    for (const id of Array.from(order).reverse()) {
      const status = state.threadStatusById[id];
      if (id === activeThreadId || status?.isProcessing || status?.isReviewing
        || state.activeTurnIdByThread[id] || state.threadResumeLoadingById[id]
        || pending.has(id) || pendingInterruptsRef.current.has(id)) {
        continue;
      }
      const bytes = getReplayableThreadBytes(state.itemsByThread[id]);
      if (bytes === 0) continue;
      if (retained >= MAX_INACTIVE_THREADS || retainedBytes + bytes > MAX_INACTIVE_THREAD_BYTES) {
        delete loadedThreadsRef.current[id];
        evictedThreadsRef.current.add(id);
        evict.push(id);
      } else {
        retained += 1;
        retainedBytes += bytes;
      }
    }
    if (evict.length) dispatch({ type: "evictThreadItems", threadIds: evict });
  }, [activeThreadId, dispatch, evictedThreadsRef, loadedThreadsRef, pendingInterruptsRef, state]);
}
