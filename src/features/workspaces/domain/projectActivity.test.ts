import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { buildProjectActivity, sortProjects } from "./projectActivity";
const project = (id: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({ id, name: id, path: `/tmp/${id}`, connected: true, settings: { sidebarCollapsed: false }, ...extra });

describe("project activity", () => {
  it("uses the latest update across all loaded chats and nested worktrees/clones, regardless of chat sort order", () => {
    const root = project("root");
    const clone = project("clone", { settings: { sidebarCollapsed: false, cloneSourceWorkspaceId: "root" } });
    const tree = project("tree", { kind: "worktree", parentId: "clone" });
    const activity = buildProjectActivity([root, clone, tree], {
      root: [{ id: "old", name: "Old", updatedAt: 10 }, { id: "recent", name: "Recent", updatedAt: 200 }],
      tree: [{ id: "running", name: "Task", updatedAt: 300 }],
    }, { running: { isProcessing: true } });
    expect(activity.get("root")).toEqual({ updatedAt: 300, runningCount: 1, threadCount: 3 });
    expect(activity.has("tree")).toBe(false);
  });
  it("sorts without mutating saved group order and uses numeric names", () => {
    const projects = [project("Project 10"), project("project 2"), project("Alpha")];
    expect(sortProjects(projects, "name_asc", new Map()).map((p) => p.id)).toEqual(["Alpha", "project 2", "Project 10"]);
    expect(sortProjects(projects, "name_desc", new Map()).map((p) => p.id)).toEqual(["Project 10", "project 2", "Alpha"]);
    expect(sortProjects(projects, "saved", new Map())).toBe(projects);
    expect(projects[0].id).toBe("Project 10");
  });
});
