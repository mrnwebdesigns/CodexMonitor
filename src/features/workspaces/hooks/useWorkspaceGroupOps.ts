import { useCallback } from "react";
import type { AppSettings, WorkspaceGroup, WorkspaceInfo, WorkspaceSettings } from "../../../types";
import {
  RESERVED_GROUP_NAME,
  createGroupId,
  isDuplicateGroupName,
  isReservedGroupName,
  normalizeGroupName,
  type ReorderWorkspaceGroup,
} from "../domain/workspaceGroups";

type UseWorkspaceGroupOpsOptions = {
  appSettings?: AppSettings;
  onUpdateAppSettings?: (next: AppSettings) => Promise<AppSettings>;
  workspaceGroups: WorkspaceGroup[];
  workspaceGroupById: Map<string, WorkspaceGroup>;
  workspaces: WorkspaceInfo[];
  updateWorkspaceSettings: (
    workspaceId: string,
    patch: Partial<WorkspaceSettings>,
  ) => Promise<WorkspaceInfo>;
};

export function useWorkspaceGroupOps({
  appSettings,
  onUpdateAppSettings,
  workspaceGroups,
  workspaceGroupById,
  workspaces,
  updateWorkspaceSettings,
}: UseWorkspaceGroupOpsOptions) {
  const updateWorkspaceGroups = useCallback(
    async (nextGroups: WorkspaceGroup[]) => {
      if (!appSettings || !onUpdateAppSettings) {
        return null;
      }
      const nextSettings = {
        ...appSettings,
        workspaceGroups: nextGroups,
      };
      return onUpdateAppSettings(nextSettings);
    },
    [appSettings, onUpdateAppSettings],
  );

  const createWorkspaceGroup = useCallback(
    async (name: string) => {
      if (!appSettings || !onUpdateAppSettings) {
        return null;
      }
      const trimmed = normalizeGroupName(name);
      if (!trimmed) {
        throw new Error("Group name is required.");
      }
      if (isReservedGroupName(trimmed)) {
        throw new Error(`"${RESERVED_GROUP_NAME}" is reserved.`);
      }
      const currentGroups = appSettings.workspaceGroups ?? [];
      if (isDuplicateGroupName(trimmed, currentGroups)) {
        throw new Error("Group name already exists.");
      }
      const nextSortOrder =
        currentGroups.reduce((max, group) => {
          if (typeof group.sortOrder === "number") {
            return Math.max(max, group.sortOrder);
          }
          return max;
        }, -1) + 1;
      const nextGroup: WorkspaceGroup = {
        id: createGroupId(),
        name: trimmed,
        sortOrder: nextSortOrder,
        copiesFolder: null,
      };
      await updateWorkspaceGroups([...currentGroups, nextGroup]);
      return nextGroup;
    },
    [appSettings, onUpdateAppSettings, updateWorkspaceGroups],
  );

  const renameWorkspaceGroup = useCallback(
    async (groupId: string, name: string) => {
      if (!appSettings || !onUpdateAppSettings) {
        return null;
      }
      const trimmed = normalizeGroupName(name);
      if (!trimmed) {
        throw new Error("Group name is required.");
      }
      if (isReservedGroupName(trimmed)) {
        throw new Error(`"${RESERVED_GROUP_NAME}" is reserved.`);
      }
      const currentGroups = appSettings.workspaceGroups ?? [];
      if (isDuplicateGroupName(trimmed, currentGroups, groupId)) {
        throw new Error("Group name already exists.");
      }
      const nextGroups = currentGroups.map((group) =>
        group.id === groupId ? { ...group, name: trimmed } : group,
      );
      await updateWorkspaceGroups(nextGroups);
      return true;
    },
    [appSettings, onUpdateAppSettings, updateWorkspaceGroups],
  );

  const reorderWorkspaceGroup = useCallback<ReorderWorkspaceGroup>(
    async (groupId, targetGroupId, position) => {
      if (!appSettings || !onUpdateAppSettings) {
        return null;
      }
      const ordered = workspaceGroups.slice();
      const index = ordered.findIndex((group) => group.id === groupId);
      if (index === -1 || groupId === targetGroupId) {
        return null;
      }
      const [moved] = ordered.splice(index, 1);
      const targetIndex = ordered.findIndex((group) => group.id === targetGroupId);
      if (targetIndex === -1) {
        return null;
      }
      const nextIndex = targetIndex + (position === "after" ? 1 : 0);
      if (nextIndex === index) {
        return null;
      }
      ordered.splice(nextIndex, 0, moved);
      const nextOrderById = new Map(
        ordered.map((group, idx) => [group.id, idx]),
      );
      const currentGroups = appSettings.workspaceGroups ?? [];
      const nextGroups = currentGroups.map((group) => {
        const nextOrder = nextOrderById.get(group.id);
        if (typeof nextOrder !== "number") {
          return group;
        }
        return { ...group, sortOrder: nextOrder };
      });
      await updateWorkspaceGroups(nextGroups);
      return true;
    },
    [appSettings, onUpdateAppSettings, updateWorkspaceGroups, workspaceGroups],
  );

  const moveWorkspaceGroup = useCallback(
    async (groupId: string, direction: "up" | "down") => {
      const index = workspaceGroups.findIndex((group) => group.id === groupId);
      const target = workspaceGroups[index + (direction === "up" ? -1 : 1)];
      if (index === -1 || !target) {
        return null;
      }
      const result = await reorderWorkspaceGroup(
        groupId,
        target.id,
        direction === "up" ? "before" : "after",
      );
      return result ? true : null;
    },
    [reorderWorkspaceGroup, workspaceGroups],
  );

  const deleteWorkspaceGroup = useCallback(
    async (groupId: string) => {
      if (!appSettings || !onUpdateAppSettings) {
        return null;
      }
      const currentGroups = appSettings.workspaceGroups ?? [];
      const nextGroups = currentGroups.filter((group) => group.id !== groupId);
      const workspacesToUpdate = workspaces.filter(
        (workspace) => (workspace.settings.groupId ?? null) === groupId,
      );
      await Promise.all([
        ...workspacesToUpdate.map((workspace) =>
          updateWorkspaceSettings(workspace.id, {
            groupId: null,
          }),
        ),
        updateWorkspaceGroups(nextGroups),
      ]);
      return true;
    },
    [
      appSettings,
      onUpdateAppSettings,
      updateWorkspaceGroups,
      updateWorkspaceSettings,
      workspaces,
    ],
  );

  const assignWorkspaceGroup = useCallback(
    async (workspaceId: string, groupId: string | null) => {
      const target = workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target || (target.kind ?? "main") === "worktree") {
        return null;
      }
      const resolvedGroupId = groupId && workspaceGroupById.has(groupId) ? groupId : null;
      await updateWorkspaceSettings(target.id, {
        groupId: resolvedGroupId,
      });
      return true;
    },
    [updateWorkspaceSettings, workspaceGroupById, workspaces],
  );

  return {
    assignWorkspaceGroup,
    createWorkspaceGroup,
    deleteWorkspaceGroup,
    moveWorkspaceGroup,
    reorderWorkspaceGroup,
    renameWorkspaceGroup,
  };
}
