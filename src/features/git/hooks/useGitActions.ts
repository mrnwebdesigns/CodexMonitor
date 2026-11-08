import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  type GitInitSelection,
  applyWorktreeChanges as applyWorktreeChangesService,
  createGitHubRepo as createGitHubRepoService,
  initGitRepo as initGitRepoService,
  revertGitAll,
  revertGitFile as revertGitFileService,
  stageGitAll as stageGitAllService,
  stageGitFile as stageGitFileService,
  unstageGitFile as unstageGitFileService,
} from "../../../services/tauri";
import type { WorkspaceInfo } from "../../../types";

type UseGitActionsOptions = {
  activeWorkspace: WorkspaceInfo | null;
  onRefreshGitStatus: () => void;
  onRefreshGitDiffs: () => void;
  onClearGitRootCandidates?: () => void;
  onGitRootInitialized?: (workspaceId: string, root: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
};

export type InitGitRepoOutcome = "initialized" | "cancelled" | "failed";

export function useGitActions({
  activeWorkspace,
  onRefreshGitStatus,
  onRefreshGitDiffs,
  onClearGitRootCandidates,
  onGitRootInitialized,
  onError,
}: UseGitActionsOptions) {
  const [worktreeApplyError, setWorktreeApplyError] = useState<string | null>(null);
  const [worktreeApplyLoading, setWorktreeApplyLoading] = useState(false);
  const [worktreeApplySuccess, setWorktreeApplySuccess] = useState(false);
  const [initGitRepoLoading, setInitGitRepoLoading] = useState(false);
  const [createGitHubRepoLoading, setCreateGitHubRepoLoading] = useState(false);
  const worktreeApplyTimerRef = useRef<number | null>(null);
  const workspaceIdRef = useRef<string | null>(activeWorkspace?.id ?? null);
  const workspaceId = activeWorkspace?.id ?? null;
  const isWorktree = activeWorkspace?.kind === "worktree";

  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  useEffect(() => {
    setWorktreeApplyError(null);
    setWorktreeApplyLoading(false);
    setWorktreeApplySuccess(false);
    setInitGitRepoLoading(false);
    setCreateGitHubRepoLoading(false);
    if (worktreeApplyTimerRef.current) {
      window.clearTimeout(worktreeApplyTimerRef.current);
      worktreeApplyTimerRef.current = null;
    }
  }, [workspaceId]);

  const refreshGitData = useCallback(() => {
    onRefreshGitStatus();
    onRefreshGitDiffs();
  }, [onRefreshGitDiffs, onRefreshGitStatus]);

  const stageGitFile = useCallback(
    async (path: string) => {
      if (!workspaceId) {
        return;
      }
      const actionWorkspaceId = workspaceId;
      try {
        await stageGitFileService(actionWorkspaceId, path);
      } catch (error) {
        onError?.(error);
      } finally {
        if (workspaceIdRef.current === actionWorkspaceId) {
          refreshGitData();
        }
      }
    },
    [onError, refreshGitData, workspaceId],
  );

  const stageGitAll = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    const actionWorkspaceId = workspaceId;
    try {
      await stageGitAllService(actionWorkspaceId);
    } catch (error) {
      onError?.(error);
    } finally {
      if (workspaceIdRef.current === actionWorkspaceId) {
        refreshGitData();
      }
    }
  }, [onError, refreshGitData, workspaceId]);

  const unstageGitFile = useCallback(
    async (path: string) => {
      if (!workspaceId) {
        return;
      }
      const actionWorkspaceId = workspaceId;
      try {
        await unstageGitFileService(actionWorkspaceId, path);
      } catch (error) {
        onError?.(error);
      } finally {
        if (workspaceIdRef.current === actionWorkspaceId) {
          refreshGitData();
        }
      }
    },
    [onError, refreshGitData, workspaceId],
  );

  const revertGitFile = useCallback(
    async (path: string) => {
      if (!workspaceId) {
        return;
      }
      const actionWorkspaceId = workspaceId;
      try {
        await revertGitFileService(actionWorkspaceId, path);
      } catch (error) {
        onError?.(error);
      } finally {
        if (workspaceIdRef.current === actionWorkspaceId) {
          refreshGitData();
        }
      }
    },
    [onError, refreshGitData, workspaceId],
  );

  const revertAllGitChanges = useCallback(async () => {
    if (!workspaceId) {
      return;
    }
    const confirmed = await ask(
      "Revert all changes in this repo?\n\nThis will discard all staged and unstaged changes, including untracked files.",
      { title: "Revert all changes", kind: "warning" },
    );
    if (!confirmed) {
      return;
    }
    try {
      await revertGitAll(workspaceId);
      refreshGitData();
    } catch (error) {
      onError?.(error);
    }
  }, [onError, refreshGitData, workspaceId]);

  const applyWorktreeChanges = useCallback(async () => {
    if (!workspaceId || !isWorktree) {
      return;
    }
    const applyWorkspaceId = workspaceId;
    setWorktreeApplyError(null);
    setWorktreeApplySuccess(false);
    setWorktreeApplyLoading(true);
    try {
      await applyWorktreeChangesService(applyWorkspaceId);
      if (workspaceIdRef.current !== applyWorkspaceId) {
        return;
      }
      if (worktreeApplyTimerRef.current) {
        window.clearTimeout(worktreeApplyTimerRef.current);
      }
      setWorktreeApplySuccess(true);
      worktreeApplyTimerRef.current = window.setTimeout(() => {
        if (workspaceIdRef.current !== applyWorkspaceId) {
          return;
        }
        setWorktreeApplySuccess(false);
        worktreeApplyTimerRef.current = null;
      }, 2500);
    } catch (error) {
      if (workspaceIdRef.current !== applyWorkspaceId) {
        return;
      }
      setWorktreeApplyError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (workspaceIdRef.current === applyWorkspaceId) {
        setWorktreeApplyLoading(false);
      }
    }
  }, [isWorktree, workspaceId]);

  const initGitRepo = useCallback(async (branch: string, setup?: GitInitSelection): Promise<InitGitRepoOutcome> => {
    if (!workspaceId || !setup) return "failed";
    const actionWorkspaceId = workspaceId;
    setInitGitRepoLoading(true);
    try {
      const response = await initGitRepoService(actionWorkspaceId, branch, false, setup);
      if (workspaceIdRef.current !== actionWorkspaceId) return "cancelled";
      if (response.status !== "initialized" || response.commitError) {
        throw new Error(response.status === "initialized" ? response.commitError : "Refresh the Git setup review before continuing.");
      }
      await onGitRootInitialized?.(actionWorkspaceId, response.relativeRoot ?? setup.root);
      onClearGitRootCandidates?.();
      refreshGitData();
      return "initialized";
    } catch (error) {
      onError?.(error);
      return "failed";
    } finally {
      if (workspaceIdRef.current === actionWorkspaceId) setInitGitRepoLoading(false);
    }
  }, [onClearGitRootCandidates, onError, onGitRootInitialized, refreshGitData, workspaceId]);

  const createGitHubRepo = useCallback(
    async (
      repo: string,
      visibility: "private" | "public",
      branch: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!workspaceId) {
        return { ok: false, error: "No active workspace." };
      }

      const actionWorkspaceId = workspaceId;
      setCreateGitHubRepoLoading(true);
      try {
        const response = await createGitHubRepoService(
          actionWorkspaceId,
          repo,
          visibility,
          branch,
        );
        if (workspaceIdRef.current !== actionWorkspaceId) {
          return { ok: false, error: "Workspace changed." };
        }

        if (response.status === "ok") {
          return { ok: true };
        }

        const pushError = response.pushError?.trim() ?? "";
        const defaultBranchError = response.defaultBranchError?.trim() ?? "";
        const parts = [];
        if (pushError) {
          parts.push(`Push failed:\n${pushError}`);
        }
        if (defaultBranchError) {
          parts.push(`Failed to set default branch:\n${defaultBranchError}`);
        }
        const errorMessage =
          parts.length > 0 ? parts.join("\n\n") : "Remote repo was created, but setup was incomplete.";
        return { ok: false, error: errorMessage };
      } catch (error) {
        if (workspaceIdRef.current !== actionWorkspaceId) {
          return { ok: false, error: "Workspace changed." };
        }
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        if (workspaceIdRef.current === actionWorkspaceId) {
          setCreateGitHubRepoLoading(false);
        }
      }
    },
    [workspaceId],
  );

  return {
    applyWorktreeChanges,
    createGitHubRepo,
    createGitHubRepoLoading,
    initGitRepo,
    initGitRepoLoading,
    revertAllGitChanges,
    revertGitFile,
    stageGitAll,
    stageGitFile,
    unstageGitFile,
    worktreeApplyError,
    worktreeApplyLoading,
    worktreeApplySuccess,
  };
}
