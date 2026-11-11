import { useCallback, useState } from "react";

type UsePanelVisibilityOptions = {
  isCompact: boolean;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  setActiveTab: (tab: "home" | "codex" | "git" | "log" | "projects") => void;
  setDebugOpen: (value: boolean | ((prev: boolean) => boolean)) => void;
};

export function usePanelVisibility({
  isCompact,
  activeWorkspaceId,
  activeThreadId,
  setActiveTab,
  setDebugOpen,
}: UsePanelVisibilityOptions) {
  const [terminalOpenByThread, setTerminalOpenByThread] = useState<Record<string, boolean>>({});
  const terminalScope = activeWorkspaceId && activeThreadId
    ? `${activeWorkspaceId}:${activeThreadId}`
    : null;
  const terminalOpen = terminalScope ? terminalOpenByThread[terminalScope] ?? false : false;

  const onToggleDebug = useCallback(() => {
    if (isCompact) {
      setActiveTab("log");
      return;
    }
    setDebugOpen((prev) => !prev);
  }, [isCompact, setActiveTab, setDebugOpen]);

  const onToggleTerminal = useCallback(() => {
    if (!terminalScope) {
      return;
    }
    setTerminalOpenByThread((current) => ({
      ...current,
      [terminalScope]: !(current[terminalScope] ?? false),
    }));
  }, [terminalScope]);

  const openTerminal = useCallback(() => {
    if (!terminalScope) {
      return;
    }
    setTerminalOpenByThread((current) => ({ ...current, [terminalScope]: true }));
  }, [terminalScope]);

  const closeTerminal = useCallback(() => {
    if (!terminalScope) {
      return;
    }
    setTerminalOpenByThread((current) => ({ ...current, [terminalScope]: false }));
  }, [terminalScope]);

  return {
    terminalOpen,
    onToggleDebug,
    onToggleTerminal,
    openTerminal,
    closeTerminal,
  };
}
