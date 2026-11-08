// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { HIDDEN_PROJECTS_STORAGE_KEY, useProjectVisibility } from "./useProjectVisibility";

const root: WorkspaceInfo = { id: "client", name: "Client", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: false, groupId: "clients" } };
const clone: WorkspaceInfo = { ...root, id: "clone", settings: { ...root.settings, cloneSourceWorkspaceId: "client" } };
const tree: WorkspaceInfo = { ...root, id: "tree", kind: "worktree", parentId: "clone" };
const internal: WorkspaceInfo = { ...root, id: "internal", name: "Internal", settings: { sidebarCollapsed: true, groupId: "internal" } };
const workspaces = [root, clone, tree, internal];
beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("project visibility", () => {
  it("hides a project family through its clone, persists it, and restores its original workspace data", () => {
    const first = renderHook(() => useProjectVisibility(workspaces));
    act(() => first.result.current.hideProject("clone"));
    expect(first.result.current.visibleWorkspaces).toEqual([internal]);
    expect(first.result.current.hiddenProjects).toEqual([root]);
    expect(JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_STORAGE_KEY) || "[]")).toEqual(["client"]);
    first.unmount();
    const second = renderHook(() => useProjectVisibility(workspaces));
    expect(second.result.current.visibleWorkspaces).toEqual([internal]);
    act(() => second.result.current.showProject("client"));
    expect(second.result.current.visibleWorkspaces).toEqual(workspaces);
    expect(root.settings.groupId).toBe("clients");
    expect(root.connected).toBe(true);
  });
  it("keeps newly arriving children hidden and supports showing all projects", () => {
    localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, '["client","internal"]');
    const view = renderHook(({ items }) => useProjectVisibility(items), { initialProps: { items: workspaces } });
    const newTree: WorkspaceInfo = { ...tree, id: "new-tree", parentId: "client" };
    view.rerender({ items: [...workspaces, newTree] });
    expect(view.result.current.visibleWorkspaces).toEqual([]);
    act(() => view.result.current.showAllProjects());
    expect(view.result.current.visibleWorkspaces).toEqual([...workspaces, newTree]);
    expect(view.result.current.hiddenProjects).toEqual([]);
  });
  it("ignores malformed preferences and does not hide unrelated or missing workspaces", () => {
    localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, '{invalid');
    const view = renderHook(() => useProjectVisibility(workspaces));
    expect(view.result.current.visibleWorkspaces).toEqual(workspaces);
    act(() => view.result.current.hideProject("missing"));
    expect(view.result.current.visibleWorkspaces).toEqual(workspaces);
  });
});
