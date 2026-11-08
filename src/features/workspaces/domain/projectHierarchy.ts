import type { WorkspaceInfo } from "@/types";

/** Resolve worktrees and clones to their owning project without following cycles. */
export function getProjectOwnerId(id: string, byId: Map<string, WorkspaceInfo>): string {
  let current = id;
  const visited = new Set<string>();
  for (let hop = 0; hop <= byId.size; hop += 1) {
    if (visited.has(current)) return [...visited].sort()[0] ?? id;
    visited.add(current);
    const workspace = byId.get(current);
    const parent = workspace?.parentId || workspace?.settings.cloneSourceWorkspaceId;
    if (!parent || !byId.has(parent)) return current;
    current = parent;
  }
  return id;
}
