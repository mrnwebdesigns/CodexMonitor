import { getProjectOwnerId } from "./projectHierarchy";
import type { ThreadSummary, WorkspaceInfo } from "@/types";
import type { ThreadStatusById } from "@/utils/threadStatus";

export type ProjectSortKey = "name_asc" | "name_desc" | "activity" | "saved";
export type ProjectActivity = { updatedAt: number; runningCount: number; threadCount: number };

export function buildProjectActivity(
  workspaces: WorkspaceInfo[],
  threadsByWorkspace: Record<string, ThreadSummary[]>,
  statuses: ThreadStatusById,
): Map<string, ProjectActivity> {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const result = new Map<string, ProjectActivity>();
  const seenThreads = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    const ownerId = getProjectOwnerId(workspace.id, byId);
    const activity = result.get(ownerId) ?? { updatedAt: 0, runningCount: 0, threadCount: 0 };
    const seen = seenThreads.get(ownerId) ?? new Set<string>();
    for (const thread of threadsByWorkspace[workspace.id] ?? []) {
      const updatedAt = thread.updatedAt ?? thread.createdAt ?? 0;
      if (Number.isFinite(updatedAt)) activity.updatedAt = Math.max(activity.updatedAt, updatedAt);
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      activity.threadCount += 1;
      if (statuses[thread.id]?.isProcessing || statuses[thread.id]?.isReviewing) activity.runningCount += 1;
    }
    seenThreads.set(ownerId, seen);
    result.set(ownerId, activity);
  }
  return result;
}

export function sortProjects(
  projects: WorkspaceInfo[],
  order: ProjectSortKey,
  activity: Map<string, ProjectActivity>,
): WorkspaceInfo[] {
  if (order === "saved") return projects;
  return projects.slice().sort((a, b) => {
    if (order === "activity") {
      const delta = (activity.get(b.id)?.updatedAt ?? 0) - (activity.get(a.id)?.updatedAt ?? 0);
      if (delta) return delta;
    }
    const nameOrder = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    return order === "name_desc" ? -nameOrder : nameOrder;
  });
}
