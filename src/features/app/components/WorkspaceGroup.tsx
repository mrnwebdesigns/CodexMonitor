import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business";
import Building2 from "lucide-react/dist/esm/icons/building-2";
import ChevronsDownUp from "lucide-react/dist/esm/icons/chevrons-down-up";
import ChevronsUpDown from "lucide-react/dist/esm/icons/chevrons-up-down";
import Folder from "lucide-react/dist/esm/icons/folder";
import GripVertical from "lucide-react/dist/esm/icons/grip-vertical";
import type { WorkspaceGroupSortProps } from "@app/hooks/useWorkspaceGroupSort";

type WorkspaceGroupProps = {
  toggleId: string | null;
  name: string;
  count?: number;
  showHeader: boolean;
  isCollapsed: boolean;
  onToggleCollapse: (groupId: string) => void;
  areAllProjectsCollapsed?: boolean;
  onToggleAllProjects?: (collapsed: boolean) => void;
  sortProps?: WorkspaceGroupSortProps;
  children: React.ReactNode;
};

export function WorkspaceGroup({
  toggleId,
  name,
  count,
  showHeader,
  isCollapsed,
  onToggleCollapse,
  areAllProjectsCollapsed = false,
  onToggleAllProjects,
  sortProps,
  children,
}: WorkspaceGroupProps) {
  const isToggleable = Boolean(toggleId);
  const tone = name.toLowerCase() === "clients" ? "clients" : name.toLowerCase() === "internal" ? "internal" : "default";
  const Icon = tone === "clients" ? BriefcaseBusiness : tone === "internal" ? Building2 : Folder;
  return (
    <div
      ref={sortProps?.ref}
      className={`workspace-group${sortProps?.isDragging ? " is-dragging" : ""}`}
      data-group-kind={tone}
      data-drop-position={sortProps?.dropPosition}
    >
      {showHeader && (
        <div
          className={`workspace-group-header${isToggleable ? " is-toggleable" : ""}`}
          onClick={
            toggleId
              ? () => {
                  onToggleCollapse(toggleId);
                }
              : undefined
          }
          onKeyDown={
            toggleId
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onToggleCollapse(toggleId);
                  }
                }
              : undefined
          }
          role={isToggleable ? "button" : undefined}
          aria-label={isToggleable ? `${isCollapsed ? "Expand" : "Collapse"} group` : undefined}
          aria-expanded={isToggleable ? !isCollapsed : undefined}
          tabIndex={isToggleable ? 0 : undefined}
        >
          {sortProps && (
            <button
              type="button"
              className="workspace-group-drag-handle"
              {...sortProps.handleProps}
            >
              <GripVertical aria-hidden />
            </button>
          )}
          <div className="workspace-group-label"><Icon aria-hidden />{name}</div>
          {count !== undefined && <span className="workspace-group-count">{count}</span>}
          {onToggleAllProjects && (
            <button
              className="workspace-group-bulk-toggle"
              onClick={(event) => {
                event.stopPropagation();
                onToggleAllProjects(!areAllProjectsCollapsed);
              }}
              aria-label={areAllProjectsCollapsed ? `Expand all projects in ${name}` : `Collapse all projects in ${name}`}
              title={areAllProjectsCollapsed ? "Expand all" : "Collapse all"}
              type="button"
            >
              {areAllProjectsCollapsed ? <ChevronsUpDown aria-hidden /> : <ChevronsDownUp aria-hidden />}
            </button>
          )}
          {isToggleable && (
            <button
              className={`group-toggle ${isCollapsed ? "" : "expanded"}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!toggleId) {
                  return;
                }
                onToggleCollapse(toggleId);
              }}
              aria-label={isCollapsed ? "Expand group" : "Collapse group"}
              aria-expanded={!isCollapsed}
              type="button"
            >
              <span className="group-toggle-icon">›</span>
            </button>
          )}
        </div>
      )}
      <div className={`workspace-group-list ${isCollapsed ? "collapsed" : ""}`} aria-hidden={isCollapsed} inert={isCollapsed ? true : undefined}>
        <div className="workspace-group-content">{children}</div>
      </div>
    </div>
  );
}
