import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceInfo } from "../../../types";
import type { TerminalSessionState } from "../../terminal/hooks/useTerminalSession";
import type { WorkspaceSettings } from "../../../types";
import { writeTerminalSession } from "../../../services/tauri";

type PendingLaunch = {
  workspaceId: string;
  threadId: string;
  terminalId: string;
  script: string;
};

type UseWorkspaceLaunchScriptOptions = {
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId?: string | null;
  updateWorkspaceSettings: (id: string, settings: WorkspaceSettings) => Promise<WorkspaceInfo>;
  openTerminal: () => void;
  ensureLaunchTerminal: (workspaceId: string, threadId: string) => string;
  restartLaunchSession: (workspaceId: string, threadId: string, terminalId: string) => Promise<void>;
  terminalState: TerminalSessionState | null;
  activeTerminalId: string | null;
};

export type WorkspaceLaunchScriptState = {
  launchScript: string | null;
  editorOpen: boolean;
  draftScript: string;
  isSaving: boolean;
  error: string | null;
  onRunLaunchScript: () => void;
  onOpenEditor: () => void;
  onCloseEditor: () => void;
  onDraftScriptChange: (value: string) => void;
  onSaveLaunchScript: () => Promise<void>;
};

export function useWorkspaceLaunchScript({
  activeWorkspace,
  activeThreadId,
  updateWorkspaceSettings,
  openTerminal,
  ensureLaunchTerminal,
  restartLaunchSession,
  terminalState,
  activeTerminalId,
}: UseWorkspaceLaunchScriptOptions): WorkspaceLaunchScriptState {
  const terminalThreadId = activeThreadId ?? "legacy-thread";
  const [editorOpen, setEditorOpen] = useState(false);
  const [draftScript, setDraftScript] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRunRef = useRef<PendingLaunch | null>(null);

  const launchScript = activeWorkspace?.settings.launchScript ?? null;

  useEffect(() => {
    setEditorOpen(false);
    setDraftScript(launchScript ?? "");
    pendingRunRef.current = null;
    setError(null);
  }, [activeWorkspace?.id, launchScript]);

  const onOpenEditor = useCallback(() => {
    setDraftScript(launchScript ?? "");
    setEditorOpen(true);
    setError(null);
  }, [launchScript]);

  const onCloseEditor = useCallback(() => {
    setEditorOpen(false);
    setError(null);
  }, []);

  const onDraftScriptChange = useCallback((value: string) => {
    setDraftScript(value);
  }, []);

  const onSaveLaunchScript = useCallback(async () => {
    if (!activeWorkspace) {
      return;
    }
    setIsSaving(true);
    setError(null);
    const trimmed = draftScript.trim();
    const nextScript = trimmed.length > 0 ? draftScript : null;
    try {
      await updateWorkspaceSettings(activeWorkspace.id, {
        ...activeWorkspace.settings,
        launchScript: nextScript,
      });
      setEditorOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [activeWorkspace, draftScript, updateWorkspaceSettings]);

  const onRunLaunchScript = useCallback(() => {
    if (!activeWorkspace) {
      return;
    }
    const script = activeWorkspace.settings.launchScript ?? "";
    if (!script.trim()) {
      onOpenEditor();
      return;
    }
    setError(null);
    const terminalId = ensureLaunchTerminal(activeWorkspace.id, terminalThreadId);
    pendingRunRef.current = {
      workspaceId: activeWorkspace.id,
      threadId: terminalThreadId,
      terminalId,
      script,
    };
    openTerminal();
    restartLaunchSession(activeWorkspace.id, terminalThreadId, terminalId)
      .catch((err) => {
        pendingRunRef.current = null;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [
    activeWorkspace,
    terminalThreadId,
    ensureLaunchTerminal,
    onOpenEditor,
    openTerminal,
    restartLaunchSession,
  ]);

  useEffect(() => {
    const pending = pendingRunRef.current;
    const pendingKey = pending
      ? `${pending.workspaceId}:${pending.threadId}:${pending.terminalId}`
      : null;
    if (
      !pending ||
      terminalState?.readyKey !== pendingKey ||
      activeTerminalId !== pending.terminalId ||
      activeWorkspace?.id !== pending.workspaceId ||
      terminalThreadId !== pending.threadId
    ) {
      return;
    }
    pendingRunRef.current = null;
    writeTerminalSession(pending.workspaceId, pending.threadId, pending.terminalId, `${pending.script}\n`).catch(
      (err) => {
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  }, [activeTerminalId, activeWorkspace?.id, terminalState?.readyKey, terminalThreadId]);

  return {
    launchScript,
    editorOpen,
    draftScript,
    isSaving,
    error,
    onRunLaunchScript,
    onOpenEditor,
    onCloseEditor,
    onDraftScriptChange,
    onSaveLaunchScript,
  };
}
