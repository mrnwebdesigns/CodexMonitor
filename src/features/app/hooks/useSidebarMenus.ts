import { useCallback, type MouseEvent } from "react";
import { CheckMenuItem, Menu, MenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { WorkspaceInfo } from "../../../types";
import { pushErrorToast } from "../../../services/toasts";
import { fileManagerName } from "../../../utils/platformPaths";
import { SIDEBAR_COLORS, type SidebarColor, type SidebarColorOption } from "@app/utils/sidebarColors";

type SidebarMenuHandlers = {
  onDeleteThread: (workspaceId: string, threadId: string) => void;
  onSyncThread: (workspaceId: string, threadId: string) => void;
  onPinThread: (workspaceId: string, threadId: string) => void;
  onUnpinThread: (workspaceId: string, threadId: string) => void;
  isThreadPinned: (workspaceId: string, threadId: string) => boolean;
  onRenameThread: (workspaceId: string, threadId: string) => void;
  onReloadWorkspaceThreads: (workspaceId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onHideWorkspace?: (workspaceId: string) => void;
  onRemoveActiveThread?: (workspaceId: string, threadId: string) => void;
  getProjectColor?: (workspaceId: string) => SidebarColor | undefined;
  projectColorPalette?: readonly SidebarColorOption[];
  onSetProjectColor?: (workspaceId: string, color: SidebarColor | null) => void;
  onDeleteWorktree: (workspaceId: string) => void;
};

export function useSidebarMenus({
  onDeleteThread,
  onSyncThread,
  onPinThread,
  onUnpinThread,
  isThreadPinned,
  onRenameThread,
  onReloadWorkspaceThreads,
  onDeleteWorkspace,
  onHideWorkspace,
  onRemoveActiveThread,
  getProjectColor,
  projectColorPalette = SIDEBAR_COLORS,
  onSetProjectColor,
  onDeleteWorktree,
}: SidebarMenuHandlers) {
  const showThreadMenu = useCallback(
    async (
      event: MouseEvent,
      workspaceId: string,
      threadId: string,
      canPin: boolean,
      options?: { isActiveThread?: boolean },
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const renameItem = await MenuItem.new({
        text: "Rename",
        action: () => onRenameThread(workspaceId, threadId),
      });
      const syncItem = await MenuItem.new({
        text: "Sync from server",
        action: () => onSyncThread(workspaceId, threadId),
      });
      const archiveItem = await MenuItem.new({
        text: "Archive",
        action: () => onDeleteThread(workspaceId, threadId),
      });
      const copyItem = await MenuItem.new({
        text: "Copy ID",
        action: async () => {
          try {
            await navigator.clipboard.writeText(threadId);
          } catch {
            // Clipboard failures are non-fatal here.
          }
        },
      });
      const items = [renameItem, syncItem];
      if (options?.isActiveThread && onRemoveActiveThread) {
        items.unshift(await MenuItem.new({ text: "Remove from Active Threads", action: () => onRemoveActiveThread(workspaceId, threadId) }));
      }
      if (canPin) {
        const isPinned = isThreadPinned(workspaceId, threadId);
        items.push(
          await MenuItem.new({
            text: isPinned ? "Unpin" : "Pin",
            action: () => {
              if (isPinned) {
                onUnpinThread(workspaceId, threadId);
              } else {
                onPinThread(workspaceId, threadId);
              }
            },
          }),
        );
      }
      items.push(copyItem, archiveItem);
      const menu = await Menu.new({ items });
      const window = getCurrentWindow();
      const position = new LogicalPosition(event.clientX, event.clientY);
      await menu.popup(position, window);
    },
    [
      isThreadPinned,
      onDeleteThread,
      onPinThread,
      onRenameThread,
      onSyncThread,
      onUnpinThread,
      onRemoveActiveThread,
    ],
  );

  const showWorkspaceMenu = useCallback(
    async (event: MouseEvent, workspaceId: string) => {
      event.preventDefault();
      event.stopPropagation();
      const reloadItem = await MenuItem.new({
        text: "Reload threads",
        action: () => onReloadWorkspaceThreads(workspaceId),
      });
      const deleteItem = await MenuItem.new({
        text: "Delete",
        action: () => onDeleteWorkspace(workspaceId),
      });
      const items: Array<MenuItem | Submenu> = [reloadItem, deleteItem];
      if (onSetProjectColor) {
        const selectedColor = getProjectColor?.(workspaceId);
        const colorItems = await Promise.all([
          CheckMenuItem.new({
            text: "None",
            checked: !selectedColor,
            action: () => onSetProjectColor(workspaceId, null),
          }),
          ...projectColorPalette.map((color) => CheckMenuItem.new({
            text: color.label,
            checked: selectedColor === color.id,
            action: () => onSetProjectColor(workspaceId, color.id),
          })),
        ]);
        items.unshift(await Submenu.new({ text: "Project color", items: colorItems }));
      }
      if (onHideWorkspace) {
        items.unshift(await MenuItem.new({ text: "Hide project", action: () => onHideWorkspace(workspaceId) }));
      }
      const menu = await Menu.new({ items });
      const window = getCurrentWindow();
      const position = new LogicalPosition(event.clientX, event.clientY);
      await menu.popup(position, window);
    },
    [onReloadWorkspaceThreads, onDeleteWorkspace, onHideWorkspace, getProjectColor, onSetProjectColor, projectColorPalette],
  );

  const showWorktreeMenu = useCallback(
    async (event: MouseEvent, worktree: WorkspaceInfo) => {
      event.preventDefault();
      event.stopPropagation();
      const fileManagerLabel = fileManagerName();
      const reloadItem = await MenuItem.new({
        text: "Reload threads",
        action: () => onReloadWorkspaceThreads(worktree.id),
      });
      const revealItem = await MenuItem.new({
        text: `Show in ${fileManagerLabel}`,
        action: async () => {
          if (!worktree.path) {
            return;
          }
          try {
            const { revealItemInDir } = await import(
              "@tauri-apps/plugin-opener"
            );
            await revealItemInDir(worktree.path);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushErrorToast({
              title: `Couldn't show worktree in ${fileManagerLabel}`,
              message,
            });
            console.warn("Failed to reveal worktree", {
              message,
              workspaceId: worktree.id,
              path: worktree.path,
            });
          }
        },
      });
      const deleteItem = await MenuItem.new({
        text: "Delete worktree",
        action: () => onDeleteWorktree(worktree.id),
      });
      const menu = await Menu.new({ items: [reloadItem, revealItem, deleteItem] });
      const window = getCurrentWindow();
      const position = new LogicalPosition(event.clientX, event.clientY);
      await menu.popup(position, window);
    },
    [onReloadWorkspaceThreads, onDeleteWorktree],
  );

  const showCloneMenu = useCallback(
    async (event: MouseEvent, clone: WorkspaceInfo) => {
      event.preventDefault();
      event.stopPropagation();
      const fileManagerLabel = fileManagerName();
      const reloadItem = await MenuItem.new({
        text: "Reload threads",
        action: () => onReloadWorkspaceThreads(clone.id),
      });
      const revealItem = await MenuItem.new({
        text: `Show in ${fileManagerLabel}`,
        action: async () => {
          if (!clone.path) {
            return;
          }
          try {
            const { revealItemInDir } = await import(
              "@tauri-apps/plugin-opener"
            );
            await revealItemInDir(clone.path);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            pushErrorToast({
              title: `Couldn't show clone in ${fileManagerLabel}`,
              message,
            });
            console.warn("Failed to reveal clone", {
              message,
              workspaceId: clone.id,
              path: clone.path,
            });
          }
        },
      });
      const deleteItem = await MenuItem.new({
        text: "Delete clone",
        action: () => onDeleteWorkspace(clone.id),
      });
      const menu = await Menu.new({ items: [reloadItem, revealItem, deleteItem] });
      const window = getCurrentWindow();
      const position = new LogicalPosition(event.clientX, event.clientY);
      await menu.popup(position, window);
    },
    [onReloadWorkspaceThreads, onDeleteWorkspace],
  );

  return { showThreadMenu, showWorkspaceMenu, showWorktreeMenu, showCloneMenu };
}
