import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectTimeSnapshot } from "@/types";
import { projectTimeSnapshot } from "@services/tauri";

type State = {
  key: string;
  snapshot: ProjectTimeSnapshot | null;
  loading: boolean;
  error: string | null;
};

export function useProjectTime(workspaceId: string, days: number) {
  const key = `${workspaceId}:${days}`;
  const [state, setState] = useState<State>({
    key,
    snapshot: null,
    loading: true,
    error: null,
  });
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setState((previous) => ({
      key,
      snapshot: previous.key === key ? previous.snapshot : null,
      loading: true,
      error: null,
    }));
    try {
      const snapshot = await projectTimeSnapshot(workspaceId, days);
      if (id === request.current)
        setState({ key, snapshot, loading: false, error: null });
    } catch (error) {
      if (id === request.current)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
    }
  }, [key, workspaceId, days]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      request.current += 1;
      window.clearInterval(interval);
    };
  }, [refresh]);

  return {
    snapshot: state.key === key ? state.snapshot : null,
    loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : null,
    refresh,
  };
}
