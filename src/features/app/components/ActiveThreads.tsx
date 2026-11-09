import { Fragment, useMemo, useState, type MouseEvent } from "react";
import Activity from "lucide-react/dist/esm/icons/activity";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ListTree from "lucide-react/dist/esm/icons/list-tree";
import X from "lucide-react/dist/esm/icons/x";
import { activeThreadKey, type ActiveThread } from "@/features/workspaces/domain/activeThreads";
import type { UsageGovernorQueueItem, UsageGovernorSnapshot } from "@/types";
import { formatRelativeTimeShort } from "@utils/time";
import { sidebarColorStyle, type SidebarColor } from "@app/utils/sidebarColors";

type Props = {
  threads: ActiveThread[];
  threadParentById: Record<string, string>;
  threadNameById: Record<string, string>;
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (workspaceId: string, threadId: string) => void;
  onRemove: (workspaceId: string, threadId: string) => void;
  onShowThreadMenu: (event: MouseEvent, workspaceId: string, threadId: string) => void;
  getProjectColor?: (id: string) => SidebarColor | undefined;
  usageGovernorSnapshot?: UsageGovernorSnapshot;
  usageGovernorQueue?: UsageGovernorQueueItem[];
};

const ACTIVE_THREAD_ORDER_STORAGE_KEY = "codexmonitor.activeThreadOrder.v1";

function readGroupByParent() {
  try {
    return localStorage.getItem(ACTIVE_THREAD_ORDER_STORAGE_KEY) === "parent";
  } catch {
    return false;
  }
}

function getRootThreadId(threadId: string, threadParentById: Record<string, string>) {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = threadId;
  while (current) {
    if (seen.has(current)) {
      const cycleStart = path.indexOf(current);
      return path.slice(Math.max(0, cycleStart)).sort((left, right) => left.localeCompare(right))[0] ?? threadId;
    }
    path.push(current);
    seen.add(current);
    const parent = threadParentById[current]?.trim();
    if (!parent) return current;
    current = parent;
  }
  return threadId;
}

export function ActiveThreads({ threads, threadParentById, threadNameById, activeWorkspaceId, activeThreadId, collapsed, onToggle, onSelect, onRemove, onShowThreadMenu, getProjectColor, usageGovernorSnapshot, usageGovernorQueue = [] }: Props) {
  const [groupByParent, setGroupByParent] = useState(readGroupByParent);
  const governorLabel = usageGovernorSnapshot
    ? usageGovernorSnapshot.state === "off"
      ? "Governor off"
      : `Governor ${usageGovernorSnapshot.state} · ${usageGovernorSnapshot.activeTurns}/${usageGovernorSnapshot.effectiveConcurrency}${usageGovernorQueue.length > 0 ? ` · ${usageGovernorQueue.length} queued` : ""}`
    : null;
  const queuedByThread = new Map(
    usageGovernorQueue.map((item) => [activeThreadKey(item.workspaceId, item.threadId), item]),
  );
  const threadGroups = useMemo(() => {
    if (!groupByParent) return [{ id: "activity", label: "", threads }];
    const groups = new Map<string, ActiveThread[]>();
    threads.forEach((entry) => {
      const rootId = getRootThreadId(entry.thread.id, threadParentById);
      const rows = groups.get(rootId) ?? [];
      rows.push(entry);
      groups.set(rootId, rows);
    });
    return [...groups].map(([rootId, rows]) => ({
      id: rootId,
      label: threadNameById[rootId]?.trim() || rows.find((entry) => entry.thread.id === rootId)?.thread.name.trim() || "Untitled parent",
      threads: rows.slice().sort((left, right) =>
        Number(right.thread.id === rootId) - Number(left.thread.id === rootId),
      ),
    }));
  }, [groupByParent, threadNameById, threadParentById, threads]);
  const toggleGroupByParent = () => {
    setGroupByParent((current) => {
      const next = !current;
      try {
        localStorage.setItem(ACTIVE_THREAD_ORDER_STORAGE_KEY, next ? "parent" : "activity");
      } catch { /* The preference still applies for this session. */ }
      return next;
    });
  };

  const renderThread = (entry: ActiveThread) => {
    const { workspaceId, projectId, projectName, thread, status } = entry;
    const label = thread.name.trim() || "Untitled thread";
    const queued = queuedByThread.get(activeThreadKey(workspaceId, thread.id));
    const finishedUnread = status === "Recent" && entry.hasUnread;
    const detail = queued
      ? `Governor queued · #${queued.position}`
      : finishedUnread ? "Finished · unread" : status === "Recent" ? `Updated ${formatRelativeTimeShort(entry.updatedAt)}` : status;
    const selected = activeWorkspaceId === workspaceId && activeThreadId === thread.id;
    return <div key={activeThreadKey(workspaceId, thread.id)} className="active-thread-row">
      <button type="button" className={`active-thread-link${selected ? " is-selected" : ""}`} aria-current={selected ? "page" : undefined}
        data-project-color={getProjectColor?.(projectId)} style={sidebarColorStyle(getProjectColor?.(projectId))}
        onClick={() => onSelect(workspaceId, thread.id)} onContextMenu={(event) => onShowThreadMenu(event, workspaceId, thread.id)}
        aria-label={`Open thread: ${label} (${projectName})`} aria-describedby={finishedUnread ? `active-thread-unread-${thread.id}` : undefined} title={`${label} · ${projectName} · ${detail}`}>
        <span className={`active-thread-dot${queued ? " is-queued" : finishedUnread ? " is-unread" : status !== "Recent" ? " is-running" : ""}`} aria-hidden />
        <span className="active-thread-copy"><span className="active-thread-name">{label}</span><span className="active-thread-meta">{projectName} · <span id={finishedUnread ? `active-thread-unread-${thread.id}` : undefined} className={finishedUnread ? "active-thread-unread" : undefined}>{detail}</span></span></span>
      </button>
      <button type="button" className="ghost active-thread-remove" aria-label={`Remove from Active Threads: ${label} (${projectName})`} title="Remove from Active Threads until new activity in this chat" onClick={() => onRemove(workspaceId, thread.id)}>
        <X aria-hidden />
      </button>
    </div>;
  };

  return <section className="active-threads" aria-label="Active Threads">
    <div className="active-threads-header">
      <button type="button" className="active-threads-heading" aria-label={`Active Threads (${threads.length})`} aria-expanded={!collapsed} onClick={onToggle} title="Threads stay here once active until you remove them">
        <Activity aria-hidden />
        <span>Active Threads</span>
        <span className="active-threads-count">{threads.length}</span>
        {governorLabel ? (
          <span
            className={`active-threads-governor is-${usageGovernorSnapshot?.state ?? "off"}`}
            title={governorLabel}
          >
            {governorLabel}
          </span>
        ) : null}
        <ChevronDown className={collapsed ? "is-collapsed" : ""} aria-hidden />
      </button>
      <button
        type="button"
        className={`ghost active-threads-order${groupByParent ? " is-active" : ""}`}
        aria-label={groupByParent ? "Sort Active Threads by activity" : "Sort Active Threads by parent"}
        aria-pressed={groupByParent}
        title={groupByParent ? "Sorted by parent" : "Sort by parent"}
        onClick={toggleGroupByParent}
      >
        <ListTree aria-hidden />
      </button>
    </div>
    {!collapsed && <div className="active-threads-list">
      {threads.length === 0 && <p className="active-threads-empty">Threads appear here as you work.</p>}
      {threadGroups.map((group) => <Fragment key={group.id}>
        {groupByParent && <div className="active-thread-group-divider" role="separator" aria-label={`Parent thread: ${group.label}`}><span>{group.label}</span></div>}
        {group.threads.map(renderThread)}
      </Fragment>)}
    </div>}
  </section>;
}
