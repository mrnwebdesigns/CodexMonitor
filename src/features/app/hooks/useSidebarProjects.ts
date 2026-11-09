import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ThreadSummary, WorkspaceInfo } from "@/types";
import type { ThreadStatusById } from "@/utils/threadStatus";
import { buildProjectActivity, type ProjectSortKey } from "@/features/workspaces/domain/projectActivity";
import { activeThreadKey, buildActiveThreads, getActiveThreads } from "@/features/workspaces/domain/activeThreads";

const SORT_STORAGE_KEY = "codexmonitor.projectSortKey";
export const REMOVED_ACTIVE_PROJECTS_STORAGE_KEY = "codexmonitor.removedActiveProjects.v1";
export const REMOVED_ACTIVE_THREADS_STORAGE_KEY = "codexmonitor.removedActiveThreads.v1";
export const RETAINED_ACTIVE_THREADS_STORAGE_KEY = "codexmonitor.retainedActiveThreads.v1";

function readRemovals(key: string): Map<string, number> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return new Map();
    return new Map(Object.entries(value).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
    ));
  } catch {
    return new Map();
  }
}

function readRetainedThreads(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RETAINED_ACTIVE_THREADS_STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function readSort(): ProjectSortKey {
  try {
    const value = localStorage.getItem(SORT_STORAGE_KEY);
    if (value === "name_desc" || value === "activity" || value === "saved") return value;
  } catch { /* Keep the directory usable when storage is unavailable. */ }
  return "name_asc";
}

export function useSidebarProjects(
  workspaces: WorkspaceInfo[],
  projects: WorkspaceInfo[],
  threads: Record<string, ThreadSummary[]>,
  statuses: ThreadStatusById,
  isThreadHidden?: (workspaceId: string, threadId: string) => boolean,
  pendingUserInputKeys?: Set<string>,
) {
  const [sortKey, setSortKey] = useState<ProjectSortKey>(readSort);
  const [removedProjects] = useState(() => readRemovals(REMOVED_ACTIVE_PROJECTS_STORAGE_KEY));
  const [removedThreads, setRemovedThreads] = useState(() => readRemovals(REMOVED_ACTIVE_THREADS_STORAGE_KEY));
  const [retainedThreadKeys, setRetainedThreadKeys] = useState(readRetainedThreads);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    try {
      localStorage.setItem(REMOVED_ACTIVE_THREADS_STORAGE_KEY, JSON.stringify(Object.fromEntries(removedThreads)));
    } catch { /* Removals still apply for this session when storage is unavailable. */ }
  }, [removedThreads]);
  useEffect(() => {
    try {
      localStorage.setItem(RETAINED_ACTIVE_THREADS_STORAGE_KEY, JSON.stringify([...retainedThreadKeys]));
    } catch { /* Retained membership still applies for this session when storage is unavailable. */ }
  }, [retainedThreadKeys]);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);
  const setProjectSortKey = useCallback((value: ProjectSortKey) => {
    setSortKey(value);
    try { localStorage.setItem(SORT_STORAGE_KEY, value); } catch { /* Session preference still applies. */ }
  }, []);
  const activity = useMemo(() => buildProjectActivity(workspaces, threads, statuses), [workspaces, threads, statuses]);
  const rows = useMemo(() => buildActiveThreads(
    workspaces,
    projects,
    threads,
    statuses,
    isThreadHidden,
    pendingUserInputKeys,
  ), [workspaces, projects, threads, statuses, isThreadHidden, pendingUserInputKeys]);
  const currentRows = useRef(rows);
  useEffect(() => {
    currentRows.current = rows;
  }, [rows]);
  const activeThreads = useMemo(() => getActiveThreads(rows, now, removedThreads, removedProjects, retainedThreadKeys),
    [rows, now, removedThreads, removedProjects, retainedThreadKeys]);
  useEffect(() => {
    const activeKeys = activeThreads.map((row) => activeThreadKey(row.workspaceId, row.thread.id));
    if (activeKeys.every((key) => retainedThreadKeys.has(key))) return;
    setRetainedThreadKeys((current) => new Set([...current, ...activeKeys]));
  }, [activeThreads, retainedThreadKeys]);
  const removeActiveThread = useCallback((workspaceId: string, threadId: string) => {
    // Native menus can remain open while new activity arrives.
    const row = currentRows.current.find((entry) => entry.workspaceId === workspaceId && entry.thread.id === threadId);
    if (!row) return;
    const key = activeThreadKey(workspaceId, threadId);
    setRetainedThreadKeys((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    setRemovedThreads((current) => new Map(current).set(key, row.updatedAt));
  }, []);
  return { projectSortKey: sortKey, setProjectSortKey, activity, activeThreads, removeActiveThread };
}
