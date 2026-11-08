import { useCallback, useEffect, useRef, useState } from "react";
import { controlMessageSearch, getMessageSearchStatus } from "@services/tauri";
import type { MessageSearchAction, MessageSearchStatus } from "../messageSearchTypes";

export function useSearchStorage() {
  const [status, setStatus] = useState<MessageSearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(true);
  const pending = useRef(false);
  const maintaining = useRef(false);
  const refresh = useCallback(async () => {
    if (pending.current || maintaining.current) return;
    pending.current = true;
    const current = ++revision.current;
    try {
      const next = await getMessageSearchStatus();
      if (mounted.current && current === revision.current) { setStatus(next); setError(null); }
    } catch {
      if (mounted.current && current === revision.current) setError("Search storage is unavailable. Check that the configured Python runtime supports SQLite FTS5.");
    } finally { pending.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 8_000);
    return () => { mounted.current = false; revision.current += 1; window.clearInterval(timer); };
  }, [refresh]);
  const control = useCallback(async (action: MessageSearchAction) => {
    if (maintaining.current) return;
    maintaining.current = true;
    revision.current += 1;
    setBusy(true);
    setError(null);
    try {
      const next = await controlMessageSearch(action);
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError("Search maintenance failed. Your chat history is unchanged. Refresh to check the index status.");
    } finally { maintaining.current = false; if (mounted.current) setBusy(false); }
  }, []);
  return { status, error, busy, refresh, control };
}
