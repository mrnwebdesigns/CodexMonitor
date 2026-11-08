import { useEffect, useState } from "react";
import { searchMessages } from "@services/tauri";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { MessageSearchResponse } from "../messageSearchTypes";

export function useMessageSearch(query: string, workspaceIds: string[], includeTools: boolean) {
  const trimmed = query.trim();
  const delayed = useDebouncedValue(trimmed, 350);
  const idsKey = JSON.stringify(workspaceIds);
  const key = JSON.stringify([delayed, idsKey, includeTools]);
  const [state, setState] = useState<{ key: string; response?: MessageSearchResponse; error?: string; loading: boolean }>({ key: "", loading: false });
  useEffect(() => {
    if (delayed.length < 3 || delayed.length > 256 || !JSON.parse(idsKey).length) return;
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setState((old) => old.key === key ? { ...old, loading: true } : { key, loading: true });
      try {
        const response = await searchMessages(delayed, JSON.parse(idsKey), includeTools);
        if (!cancelled) setState({ key, response, loading: false });
      } catch {
        if (!cancelled) setState({ key, loading: false, error: "Message search is unavailable. Check Search & storage on Home." });
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [delayed, idsKey, includeTools, key]);
  const current = trimmed === delayed && state.key === key;
  return {
    results: current ? state.response?.results ?? [] : [],
    status: current ? state.response?.status ?? null : null,
    elapsedMs: current ? state.response?.elapsedMs : undefined,
    error: current ? state.error : undefined,
    loading: trimmed.length >= 3 && trimmed.length <= 256 && workspaceIds.length > 0 && (!current || state.loading),
  };
}
