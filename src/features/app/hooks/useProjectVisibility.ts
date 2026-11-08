import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceInfo } from "@/types";
import { getProjectOwnerId } from "@/features/workspaces/domain/projectHierarchy";

export const HIDDEN_PROJECTS_STORAGE_KEY = "codexmonitor.hiddenProjectIds.v1";

function readHiddenProjects(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function useProjectVisibility(workspaces: WorkspaceInfo[]) {
  const [hiddenIds, setHiddenIds] = useState(readHiddenProjects);
  const byId = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const ownerById = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, getProjectOwnerId(workspace.id, byId)])), [byId, workspaces]);
  const projects = useMemo(() => workspaces.filter((workspace) =>
    (workspace.kind ?? "main") === "main" && !workspace.parentId && ownerById.get(workspace.id) === workspace.id,
  ), [workspaces, ownerById]);
  const hiddenProjects = useMemo(() => projects.filter((project) => hiddenIds.has(project.id)), [projects, hiddenIds]);
  const visibleWorkspaces = useMemo(() => workspaces.filter((workspace) => !hiddenIds.has(ownerById.get(workspace.id) ?? workspace.id)), [workspaces, hiddenIds, ownerById]);
  const visibleIds = useMemo(() => new Set(visibleWorkspaces.map((workspace) => workspace.id)), [visibleWorkspaces]);

  useEffect(() => {
    try { localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify([...hiddenIds])); }
    catch { /* Keep the current session usable if storage is unavailable. */ }
  }, [hiddenIds]);

  const hideProject = useCallback((workspaceId: string) => {
    const owner = ownerById.get(workspaceId);
    if (!owner || !projects.some((project) => project.id === owner)) return;
    setHiddenIds((current) => new Set(current).add(owner));
  }, [ownerById, projects]);
  const showProject = useCallback((id: string) => {
    setHiddenIds((current) => { const next = new Set(current); next.delete(id); return next; });
  }, []);
  const showAllProjects = useCallback(() => setHiddenIds(new Set()), []);

  return { visibleWorkspaces, visibleIds, hiddenProjects, hideProject, showProject, showAllProjects };
}
