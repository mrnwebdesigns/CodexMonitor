import { useCallback, useMemo, useState } from "react";

export type TerminalTab = {
  id: string;
  title: string;
};

type TerminalTabRecord = TerminalTab & {
  autoNamed: boolean;
};

type UseTerminalTabsOptions = {
  activeWorkspaceId: string | null;
  activeThreadId?: string | null;
  onCloseTerminal?: (workspaceId: string, threadId: string, terminalId: string) => void;
};

function terminalScope(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

function createTerminalId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `terminal-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function renumberAutoNamedTabs(tabs: TerminalTabRecord[]): TerminalTabRecord[] {
  let autoNamedIndex = 1;
  let changed = false;
  const nextTabs = tabs.map((tab) => {
    if (!tab.autoNamed) {
      return tab;
    }
    const nextTitle = `Terminal ${autoNamedIndex}`;
    autoNamedIndex += 1;
    if (tab.title === nextTitle) {
      return tab;
    }
    changed = true;
    return {
      ...tab,
      title: nextTitle,
    };
  });
  return changed ? nextTabs : tabs;
}

export function useTerminalTabs({
  activeWorkspaceId,
  activeThreadId,
  onCloseTerminal,
}: UseTerminalTabsOptions) {
  const [tabsByWorkspace, setTabsByWorkspace] = useState<
    Record<string, TerminalTabRecord[]>
  >({});
  const [activeTerminalIdByWorkspace, setActiveTerminalIdByWorkspace] = useState<
    Record<string, string | null>
  >({});

  const createTerminal = useCallback((workspaceId: string, threadId = activeThreadId ?? "default") => {
    const scope = terminalScope(workspaceId, threadId);
    const id = createTerminalId();
    setTabsByWorkspace((prev) => {
      const existing = prev[scope] ?? [];
      const nextTabs = renumberAutoNamedTabs([
        ...existing,
        { id, title: "", autoNamed: true },
      ]);
      return {
        ...prev,
        [scope]: nextTabs,
      };
    });
    setActiveTerminalIdByWorkspace((prev) => ({ ...prev, [scope]: id }));
    return id;
  }, [activeThreadId]);

  const ensureTerminalWithTitle = useCallback(
    (workspaceId: string, threadOrTerminalId: string, terminalIdOrTitle: string, title?: string) => {
      const threadId = title === undefined ? activeThreadId ?? "default" : threadOrTerminalId;
      const terminalId = title === undefined ? threadOrTerminalId : terminalIdOrTitle;
      const resolvedTitle = title ?? terminalIdOrTitle;
      const scope = terminalScope(workspaceId, threadId);
      setTabsByWorkspace((prev) => {
        const existing = prev[scope] ?? [];
        const index = existing.findIndex((tab) => tab.id === terminalId);
        if (index === -1) {
          const nextTabs = renumberAutoNamedTabs([
            ...existing,
            { id: terminalId, title: resolvedTitle, autoNamed: false },
          ]);
          return {
            ...prev,
            [scope]: nextTabs,
          };
        }
        if (!existing[index].autoNamed && existing[index].title === resolvedTitle) {
          return prev;
        }
        const nextTabs = existing.slice();
        nextTabs[index] = {
          ...existing[index],
          title: resolvedTitle,
          autoNamed: false,
        };
        return {
          ...prev,
          [scope]: renumberAutoNamedTabs(nextTabs),
        };
      });
      setActiveTerminalIdByWorkspace((prev) => ({ ...prev, [scope]: terminalId }));
      return terminalId;
    },
    [activeThreadId],
  );

  const closeTerminal = useCallback(
    (workspaceId: string, threadOrTerminalId: string, terminalId?: string) => {
      const threadId = terminalId === undefined ? activeThreadId ?? "default" : threadOrTerminalId;
      const resolvedTerminalId = terminalId ?? threadOrTerminalId;
      const scope = terminalScope(workspaceId, threadId);
      setTabsByWorkspace((prev) => {
        const existing = prev[scope] ?? [];
        const nextTabs = renumberAutoNamedTabs(
          existing.filter((tab) => tab.id !== resolvedTerminalId),
        );
        setActiveTerminalIdByWorkspace((prevActive) => {
          const active = prevActive[scope];
          if (active !== resolvedTerminalId) {
            return prevActive;
          }
          const nextActive = nextTabs.length > 0 ? nextTabs[nextTabs.length - 1].id : null;
          if (!nextActive) {
            const { [scope]: _, ...rest } = prevActive;
            return rest;
          }
          return { ...prevActive, [scope]: nextActive };
        });
        if (nextTabs.length === 0) {
          const { [scope]: _, ...rest } = prev;
          return rest;
        }
        return { ...prev, [scope]: nextTabs };
      });
      onCloseTerminal?.(workspaceId, threadId, resolvedTerminalId);
    },
    [activeThreadId, onCloseTerminal],
  );

  const setActiveTerminal = useCallback((workspaceId: string, threadOrTerminalId: string, terminalId?: string) => {
    const threadId = terminalId === undefined ? activeThreadId ?? "default" : threadOrTerminalId;
    const resolvedTerminalId = terminalId ?? threadOrTerminalId;
    const scope = terminalScope(workspaceId, threadId);
    setActiveTerminalIdByWorkspace((prev) => ({ ...prev, [scope]: resolvedTerminalId }));
  }, [activeThreadId]);

  const ensureTerminal = useCallback(
    (workspaceId: string, threadId = activeThreadId ?? "default") => {
      const scope = terminalScope(workspaceId, threadId);
      const active = activeTerminalIdByWorkspace[scope];
      if (active) {
        return active;
      }
      return createTerminal(workspaceId, threadId);
    },
    [activeTerminalIdByWorkspace, activeThreadId, createTerminal],
  );

  const terminals = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return (tabsByWorkspace[terminalScope(activeWorkspaceId, activeThreadId ?? "default")] ?? []).map(({ id, title }) => ({
      id,
      title,
    }));
  }, [activeThreadId, activeWorkspaceId, tabsByWorkspace]);

  const activeTerminalId = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    return activeTerminalIdByWorkspace[terminalScope(activeWorkspaceId, activeThreadId ?? "default")] ?? null;
  }, [activeTerminalIdByWorkspace, activeThreadId, activeWorkspaceId]);

  return {
    terminals,
    activeTerminalId,
    createTerminal,
    ensureTerminalWithTitle,
    closeTerminal,
    setActiveTerminal,
    ensureTerminal,
  };
}
