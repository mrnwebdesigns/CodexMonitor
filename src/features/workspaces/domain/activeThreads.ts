import type { ThreadSummary, WorkspaceInfo } from "@/types";
import type { ThreadStatusById } from "@utils/threadStatus";
import { getProjectOwnerId } from "./projectHierarchy";

export const ACTIVE_THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const RECENT_THREAD_LIMIT = 6;

export type ActiveThread = {
  workspaceId: string;
  projectId: string;
  projectName: string;
  thread: ThreadSummary;
  updatedAt: number;
  status: "Running" | "Reviewing" | "Recent";
  hasUnread: boolean;
};

export const activeThreadKey = (workspaceId: string, threadId: string) =>
  JSON.stringify([workspaceId, threadId]);

export function buildActiveThreads(
  workspaces: WorkspaceInfo[],
  projects: WorkspaceInfo[],
  threadsByWorkspace: Record<string, ThreadSummary[]>,
  statuses: ThreadStatusById,
  isThreadHidden?: (workspaceId: string, threadId: string) => boolean,
): ActiveThread[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const visibleProjects = new Map(projects.map((project) => [project.id, project]));
  const rows = new Map<string, ActiveThread>();
  for (const workspace of workspaces) {
    const projectId = getProjectOwnerId(workspace.id, byId);
    const project = visibleProjects.get(projectId);
    if (!project) continue;
    for (const thread of threadsByWorkspace[workspace.id] ?? []) {
      if (isThreadHidden?.(workspace.id, thread.id)) continue;
      const timestamp = thread.updatedAt ?? thread.createdAt ?? 0;
      const flags = statuses[thread.id];
      const row: ActiveThread = {
        workspaceId: workspace.id,
        projectId,
        projectName: project.name,
        thread,
        updatedAt: Number.isFinite(timestamp) ? Math.max(0, timestamp) : 0,
        status: flags?.isProcessing ? "Running" : flags?.isReviewing ? "Reviewing" : "Recent",
        hasUnread: flags?.hasUnread ?? false,
      };
      // Imported histories can list the same chat in a parent and a worktree.
      // Keep its most specific workspace so opening it uses the right checkout.
      const previous = rows.get(thread.id);
      const previousPathLength = previous ? byId.get(previous.workspaceId)?.path.length ?? 0 : -1;
      if (!previous || workspace.path.length > previousPathLength ||
        (workspace.path.length === previousPathLength && row.updatedAt > previous.updatedAt)) {
        rows.set(thread.id, row);
      }
    }
  }
  return [...rows.values()];
}

export function getActiveThreads(
  rows: ActiveThread[],
  now: number,
  removedThreads: Map<string, number>,
  removedProjects: Map<string, number>,
): ActiveThread[] {
  const eligible = rows.filter((row) => {
    const removedAt = removedThreads.get(activeThreadKey(row.workspaceId, row.thread.id));
    const projectRemovedAt = removedProjects.get(row.projectId);
    return (removedAt === undefined || row.updatedAt > removedAt) &&
      (projectRemovedAt === undefined || row.updatedAt > projectRemovedAt);
  });
  const byRecency = (a: ActiveThread, b: ActiveThread) =>
    b.updatedAt - a.updatedAt || a.thread.name.localeCompare(b.thread.name) ||
    activeThreadKey(a.workspaceId, a.thread.id).localeCompare(activeThreadKey(b.workspaceId, b.thread.id));
  const running = eligible.filter((row) => row.status !== "Recent").sort(byRecency);
  const recent = eligible.filter((row) => row.status === "Recent" && row.updatedAt > 0 &&
    row.updatedAt >= now - ACTIVE_THREAD_WINDOW_MS).sort(byRecency).slice(0, RECENT_THREAD_LIMIT);
  return [...running, ...recent];
}
