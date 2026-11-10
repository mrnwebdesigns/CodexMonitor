import { useCallback, useEffect, useRef, useState } from "react";
import type { GitLogEntry, WorkspaceInfo } from "../../../types";
import { getGitLog } from "../../../services/tauri";

type GitLogState = {
  entries: GitLogEntry[];
  total: number;
  ahead: number;
  behind: number;
  aheadEntries: GitLogEntry[];
  behindEntries: GitLogEntry[];
  upstream: string | null;
  isLoading: boolean;
  error: string | null;
};

const emptyState: GitLogState = {
  entries: [],
  total: 0,
  ahead: 0,
  behind: 0,
  aheadEntries: [],
  behindEntries: [],
  upstream: null,
  isLoading: false,
  error: null,
};

const REFRESH_INTERVAL_MS = 10000;

export function useGitLog(
  activeWorkspace: WorkspaceInfo | null,
  enabled: boolean,
) {
  const [state, setState] = useState<GitLogState>(emptyState);
  const requestIdRef = useRef(0);
  const workspaceId = activeWorkspace?.id ?? null;
  const gitRoot = activeWorkspace?.settings.gitRoot;
  const workspaceIdRef = useRef(workspaceId);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setState(emptyState);
      return;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const response = await getGitLog(workspaceId);
      if (
        requestIdRef.current !== requestId ||
        workspaceIdRef.current !== workspaceId
      ) {
        return;
      }
      setState({
        entries: response.entries,
        total: response.total,
        ahead: response.ahead,
        behind: response.behind,
        aheadEntries: response.aheadEntries,
        behindEntries: response.behindEntries,
        upstream: response.upstream,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      console.error("Failed to load git log", error);
      if (
        requestIdRef.current !== requestId ||
        workspaceIdRef.current !== workspaceId
      ) {
        return;
      }
      setState({
        entries: [],
        total: 0,
        ahead: 0,
        behind: 0,
        aheadEntries: [],
        behindEntries: [],
        upstream: null,
        isLoading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceIdRef.current !== workspaceId) {
      workspaceIdRef.current = workspaceId;
      requestIdRef.current += 1;
      setState(emptyState);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!enabled || !workspaceId) {
      return;
    }
    let pollInFlight = false;
    const fetchLog = async () => {
      if (pollInFlight) {
        return;
      }
      pollInFlight = true;
      try {
        await refresh();
      } finally {
        pollInFlight = false;
      }
    };
    void fetchLog();
    const interval = window.setInterval(fetchLog, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [enabled, gitRoot, refresh, workspaceId]);

  return {
    entries: state.entries,
    total: state.total,
    ahead: state.ahead,
    behind: state.behind,
    aheadEntries: state.aheadEntries,
    behindEntries: state.behindEntries,
    upstream: state.upstream,
    isLoading: state.isLoading,
    error: state.error,
    refresh,
  };
}
