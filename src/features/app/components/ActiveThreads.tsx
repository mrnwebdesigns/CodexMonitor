import { Fragment, useMemo, type MouseEvent } from "react";
import Activity from "lucide-react/dist/esm/icons/activity";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import X from "lucide-react/dist/esm/icons/x";
import { activeThreadKey, type ActiveThread } from "@/features/workspaces/domain/activeThreads";
import { formatRelativeTimeShort } from "@utils/time";
import { sidebarColorStyle, type SidebarColor } from "@app/utils/sidebarColors";

type Props = {
  threads: ActiveThread[];
  activeWorkspaceId: string | null;
  activeThreadId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (workspaceId: string, threadId: string) => void;
  onRemove: (workspaceId: string, threadId: string) => void;
  onShowThreadMenu: (event: MouseEvent, workspaceId: string, threadId: string) => void;
  getProjectColor?: (id: string) => SidebarColor | undefined;
};

export function ActiveThreads({ threads, activeWorkspaceId, activeThreadId, collapsed, onToggle, onSelect, onRemove, onShowThreadMenu, getProjectColor }: Props) {
  const projectGroups = useMemo(() => {
    const groups = new Map<string, { label: string; threads: ActiveThread[] }>();
    threads.forEach((entry) => {
      const group = groups.get(entry.projectId) ?? { label: entry.projectName, threads: [] };
      group.threads.push(entry);
      groups.set(entry.projectId, group);
    });
    return [...groups].map(([id, group]) => ({ id, ...group }));
  }, [threads]);

  const renderThread = (entry: ActiveThread) => {
    const { workspaceId, projectId, projectName, thread, status } = entry;
    const label = thread.name.trim() || "Untitled thread";
    const finishedUnread = status === "Recent" && entry.hasUnread;
    const detail = finishedUnread ? "Finished · unread" : status === "Recent" ? `Updated ${formatRelativeTimeShort(entry.updatedAt)}` : status;
    const selected = activeWorkspaceId === workspaceId && activeThreadId === thread.id;
    return <div key={activeThreadKey(workspaceId, thread.id)} className="active-thread-row">
      <button type="button" className={`active-thread-link${selected ? " is-selected" : ""}`} aria-current={selected ? "page" : undefined}
        data-project-color={getProjectColor?.(projectId)} style={sidebarColorStyle(getProjectColor?.(projectId))}
        onClick={() => onSelect(workspaceId, thread.id)} onContextMenu={(event) => onShowThreadMenu(event, workspaceId, thread.id)}
        aria-label={`Open thread: ${label} (${projectName})`} aria-describedby={finishedUnread ? `active-thread-unread-${thread.id}` : undefined} title={`${label} · ${projectName} · ${detail}`}>
        <span className={`active-thread-dot${finishedUnread ? " is-unread" : status !== "Recent" ? " is-running" : ""}`} aria-hidden />
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
      <ChevronDown className={collapsed ? "is-collapsed" : ""} aria-hidden />
    </button>
    {!collapsed && <div className="active-threads-list">
      {threads.length === 0 && <p className="active-threads-empty">Threads appear here as you work.</p>}
      {projectGroups.map((group) => <Fragment key={group.id}>
        <div className="active-thread-group-divider" role="separator" aria-label={`Project: ${group.label}`}><span>{group.label}</span></div>
        {group.threads.map(renderThread)}
      </Fragment>)}
    </div>}
  </section>;
}
