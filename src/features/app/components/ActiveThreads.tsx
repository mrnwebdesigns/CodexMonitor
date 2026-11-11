import { Fragment, useEffect, useMemo, useState, type MouseEvent } from "react";
import Activity from "lucide-react/dist/esm/icons/activity";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import X from "lucide-react/dist/esm/icons/x";
import { activeThreadKey, type ActiveThread } from "@/features/workspaces/domain/activeThreads";
import type { UsageGovernorQueueItem, UsageGovernorSnapshot } from "@/types";
import { formatRelativeTimeShort } from "@utils/time";
import { sidebarColorStyle, type SidebarColor } from "@app/utils/sidebarColors";

const ACTIVE_THREADS_GROUPING_STORAGE_KEY = "codexmonitor.activeThreadsGrouping";
const LEGACY_ACTIVE_THREAD_ORDER_KEY = "codexmonitor.activeThreadOrder.v1";
const GROUPING_LABELS = { project: "Project", status: "Status", parent: "Parent thread" };
type ActiveThreadsGrouping = keyof typeof GROUPING_LABELS;

function getStoredGrouping(): ActiveThreadsGrouping {
  try {
    const grouping = localStorage.getItem(ACTIVE_THREADS_GROUPING_STORAGE_KEY);
    if (grouping === "project" || grouping === "status" || grouping === "parent") {
      return grouping;
    }
    if (localStorage.getItem(LEGACY_ACTIVE_THREAD_ORDER_KEY) === "parent") {
      return "parent";
    }
  } catch { /* The default remains available when storage is unavailable. */ }
  return "project";
}

function getRootThreadId(threadId: string, threadParentById: Record<string, string>) {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = threadId;
  while (!seen.has(current)) {
    seen.add(current);
    path.push(current);
    const parent = threadParentById[current]?.trim();
    if (!parent) return current;
    current = parent;
  }
  return path.slice(path.indexOf(current)).sort()[0];
}

type Props = {
  threads: ActiveThread[];
  threadParentById: Record<string, string>;
  threadNameById: ReadonlyMap<string, string>;
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

export function ActiveThreads({
  threads, threadParentById, threadNameById, activeWorkspaceId, activeThreadId,
  collapsed, onToggle, onSelect, onRemove, onShowThreadMenu, getProjectColor,
  usageGovernorSnapshot, usageGovernorQueue = [],
}: Props) {
  const [grouping, setGrouping] = useState<ActiveThreadsGrouping>(getStoredGrouping);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_THREADS_GROUPING_STORAGE_KEY, grouping);
    } catch { /* The preference still applies for this session. */ }
  }, [grouping]);

  const threadGroups = useMemo(() => {
    if (grouping === "status") {
      const running = threads.filter((entry) => entry.status === "Running" || entry.status === "Reviewing");
      const finishedOrWaiting = threads.filter((entry) => entry.status === "Recent" || entry.status === "Waiting");
      return [
        { id: "running", label: "Running", threads: running },
        { id: "finished-waiting", label: "Finished / waiting", threads: finishedOrWaiting },
      ].filter((group) => group.threads.length > 0);
    }

    const groups = new Map<string, { id: string; label: string; threads: ActiveThread[] }>();
    for (const entry of threads) {
      const id = grouping === "parent" ? getRootThreadId(entry.thread.id, threadParentById) : entry.projectId;
      const label = grouping === "parent" ? threadNameById.get(id) || "Untitled parent" : entry.projectName;
      const group = groups.get(id) ?? { id, label, threads: [] };
      group.threads.push(entry);
      groups.set(id, group);
    }
    if (grouping === "parent") {
      for (const { id, threads: rows } of groups.values()) {
        rows.sort((left, right) => Number(right.thread.id === id) - Number(left.thread.id === id));
      }
    }
    return [...groups.values()];
  }, [grouping, threadNameById, threadParentById, threads]);

  const queuedByThread = new Map(usageGovernorQueue.map((item) => [activeThreadKey(item.workspaceId, item.threadId), item]));
  const governorLabel = usageGovernorSnapshot
    ? usageGovernorSnapshot.state === "off"
      ? "Governor off"
      : `Governor ${usageGovernorSnapshot.state} · ${usageGovernorSnapshot.activeTurns}/${usageGovernorSnapshot.effectiveConcurrency}${usageGovernorQueue.length ? ` · ${usageGovernorQueue.length} queued` : ""}`
    : null;

  const renderThread = (entry: ActiveThread) => {
    const { workspaceId, projectId, projectName, thread, status } = entry;
    const label = thread.name.trim() || "Untitled thread";
    const queued = queuedByThread.get(activeThreadKey(workspaceId, thread.id));
    const finishedUnread = status === "Recent" && entry.hasUnread && !queued;
    const statusDetail = status === "Recent" ? `Updated ${formatRelativeTimeShort(entry.updatedAt)}` : status;
    const detail = queued ? `Governor queued · #${queued.position}` : finishedUnread ? "Finished · unread" : statusDetail;
    const activityClass = status === "Waiting" ? "is-waiting" : status !== "Recent" ? "is-running" : "";
    const dotClass = queued ? "is-queued" : finishedUnread ? "is-unread" : activityClass;
    const selected = activeWorkspaceId === workspaceId && activeThreadId === thread.id;
    return <div key={activeThreadKey(workspaceId, thread.id)} className="active-thread-row">
      <button type="button" className={`active-thread-link${selected ? " is-selected" : ""}`} aria-current={selected ? "page" : undefined}
        data-project-color={getProjectColor?.(projectId)} style={sidebarColorStyle(getProjectColor?.(projectId))}
        onClick={() => onSelect(workspaceId, thread.id)} onContextMenu={(event) => onShowThreadMenu(event, workspaceId, thread.id)}
        aria-label={`Open thread: ${label} (${projectName})`} aria-describedby={finishedUnread ? `active-thread-unread-${thread.id}` : undefined} title={`${label} · ${projectName} · ${detail}`}>
        <span className={`active-thread-dot ${dotClass}`} aria-hidden />
        {entry.hasUnread && !finishedUnread && <span className="active-thread-notification" role="status" aria-label="New activity" title="New activity" />}
        <span className="active-thread-copy"><span className="active-thread-name">{label}</span><span className="active-thread-meta">{projectName} · <span id={finishedUnread ? `active-thread-unread-${thread.id}` : undefined} className={finishedUnread ? "active-thread-unread" : undefined}>{detail}</span></span></span>
      </button>
      <button type="button" className="ghost active-thread-remove" aria-label={`Remove from Active Threads: ${label} (${projectName})`} title="Remove from Active Threads until new activity in this chat" onClick={() => onRemove(workspaceId, thread.id)}>
        <X aria-hidden />
      </button>
    </div>;
  };

  return <section className="active-threads" aria-label="Active Threads">
    <button type="button" className="active-threads-heading" aria-label={`Active Threads (${threads.length})`} aria-expanded={!collapsed} onClick={onToggle} title="Threads stay here once active until you remove them">
      <Activity aria-hidden />
      <span>Active Threads</span>
      <span className="active-threads-count">{threads.length}</span>
      {governorLabel && <span className={`active-threads-governor is-${usageGovernorSnapshot?.state}`} title={governorLabel}>{governorLabel}</span>}
      <ChevronDown className={collapsed ? "is-collapsed" : ""} aria-hidden />
    </button>
    {!collapsed && <div className="active-threads-list">
      {threads.length === 0 && <p className="active-threads-empty">Threads appear here as you work.</p>}
      {threads.length > 0 && <label className="active-threads-grouping">
        <span>Group by</span>
        <select aria-label="Group active threads by" value={grouping} onChange={(event) => setGrouping(event.target.value as ActiveThreadsGrouping)}>
          <option value="project">Project</option>
          <option value="status">Status</option>
          <option value="parent">Parent thread</option>
        </select>
      </label>}
      {threadGroups.map((group) => <Fragment key={group.id}>
        <div className="active-thread-group-divider" role="separator" aria-label={`${GROUPING_LABELS[grouping]}: ${group.label}`}><span>{group.label}</span></div>
        {group.threads.map(renderThread)}
      </Fragment>)}
    </div>}
  </section>;
}
