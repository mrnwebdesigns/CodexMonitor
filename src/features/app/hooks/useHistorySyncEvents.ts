import { useEffect, useRef } from "react";
import type { WorkspaceInfo } from "@/types";
import { subscribeAppServerEvents } from "@services/events";

type Options = {
  workspaces: WorkspaceInfo[];
  enabled: boolean;
  listThreadsForWorkspaces: (
    workspaces: WorkspaceInfo[],
    options: { preserveState: boolean },
  ) => Promise<void>;
};

export function useHistorySyncEvents({
  workspaces,
  enabled,
  listThreadsForWorkspaces,
}: Options) {
  const current = useRef({ workspaces, listThreadsForWorkspaces });
  current.current = { workspaces, listThreadsForWorkspaces };

  useEffect(() => {
    if (!enabled) return;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let refreshing = false;
    const flush = async () => {
      timer = undefined;
      if (refreshing || cancelled) return;
      const targets = current.current.workspaces.filter(
        (workspace) => workspace.connected && pending.has(workspace.id),
      );
      pending.clear();
      if (targets.length === 0) return;
      refreshing = true;
      try {
        await current.current.listThreadsForWorkspaces(targets, {
          preserveState: true,
        });
      } catch {
        // Keep the existing list on refresh failures; the next import or normal
        // workspace selection will retry through the existing error handling.
      } finally {
        refreshing = false;
        if (!cancelled && pending.size > 0) timer = setTimeout(() => void flush(), 100);
      }
    };
    const unsubscribe = subscribeAppServerEvents((event) => {
      if (event.message.method !== "codex/historySynced") return;
      pending.add(event.workspace_id);
      if (!timer && !refreshing) timer = setTimeout(() => void flush(), 100);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled]);
}
