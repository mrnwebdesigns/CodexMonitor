import Eye from "lucide-react/dist/esm/icons/eye";
import type { WorkspaceInfo } from "@/types";
import type { ProjectActivity } from "@/features/workspaces/domain/projectActivity";
import { buildGroupedWorkspaces } from "@/features/workspaces/domain/workspaceGroups";
import type { WorkspaceGroupSection } from "./sidebarTypes";

type Props = {
  projects: WorkspaceInfo[];
  groups: WorkspaceGroupSection[];
  activity: Map<string, ProjectActivity>;
  query: string;
  onShow: (id: string) => void;
  onShowAll: () => void;
};

export function HiddenProjects({ projects, groups, activity, query, onShow, onShowAll }: Props) {
  const sections = buildGroupedWorkspaces(
    projects,
    groups.flatMap((group) => group.id === null ? [] : [{ id: group.id, name: group.name }]),
  ).map((group) => ({
    ...group,
    workspaces: group.workspaces.filter((workspace) => workspace.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })),
  })).filter((group) => group.workspaces.length > 0);

  return (
    <section className="hidden-projects" aria-label="Hidden projects">
      <div className="hidden-projects-heading">
        <h2>Hidden Projects</h2>
        {projects.length > 0 && <button type="button" className="ghost" onClick={onShowAll}>Show all</button>}
      </div>
      <p className="hidden-projects-help">Projects and chats stay saved while hidden. Running agents keep working.</p>
      {sections.length === 0 && <p className="empty">{projects.length > 0 ? "No hidden projects match your search." : "No hidden projects. Right-click a project and choose Hide project."}</p>}
      {sections.map((section) => (
        <div key={section.id ?? "ungrouped"} className="hidden-projects-group">
          <h3>{section.name}</h3>
          {section.workspaces.map((project) => {
            const running = activity.get(project.id)?.runningCount ?? 0;
            return (
              <button key={project.id} type="button" className="hidden-project-row" onClick={() => onShow(project.id)} aria-label={`Show project: ${project.name}`}>
                <span className="hidden-project-copy"><strong>{project.name}</strong>{running > 0 && <small>{running} agent{running === 1 ? "" : "s"} running</small>}</span>
                <span className="hidden-project-show"><Eye aria-hidden />Show</span>
              </button>
            );
          })}
        </div>
      ))}
    </section>
  );
}
