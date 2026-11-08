// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_THREAD_WINDOW_MS, activeThreadKey } from "@/features/workspaces/domain/activeThreads";
import type { WorkspaceInfo } from "@/types";
import { REMOVED_ACTIVE_PROJECTS_STORAGE_KEY, REMOVED_ACTIVE_THREADS_STORAGE_KEY, useSidebarProjects } from "./useSidebarProjects";

const projects: WorkspaceInfo[] = Array.from({ length: 8 }, (_, index) => ({
  id: `project-${index}`, name: `Project ${index}`, path: `/tmp/project-${index}`,
  connected: true, settings: { sidebarCollapsed: false },
}));

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Active Threads removal", () => {
  it("persists removals across refreshes and remounts and fills the six recent slots", () => {
    const now = Date.now();
    const threads = Object.fromEntries(projects.map((project, index) => [
      project.id, [{ id: `thread-${index}`, name: "Chat", updatedAt: now - index }],
    ]));
    const first = renderHook(() => useSidebarProjects(projects, projects, threads, {}));
    act(() => first.result.current.removeActiveThread("project-0", "thread-0"));
    expect(first.result.current.activeThreads.map((entry) => entry.workspaceId)).toEqual(projects.slice(1, 7).map((project) => project.id));
    expect(JSON.parse(localStorage.getItem(REMOVED_ACTIVE_THREADS_STORAGE_KEY) || "{}")).toEqual({ [activeThreadKey("project-0", "thread-0")]: now });
    first.rerender();
    expect(first.result.current.activeThreads.map((entry) => entry.workspaceId)).not.toContain(projects[0].id);
    first.unmount();
    const second = renderHook(() => useSidebarProjects(projects, projects, threads, {}));
    expect(second.result.current.activeThreads.map((entry) => entry.workspaceId)).toEqual(projects.slice(1, 7).map((project) => project.id));
  });

  it("lets a running thread be removed and restores it for newer activity in the same chat", () => {
    const root = projects[0];
    const child: WorkspaceInfo = { ...root, id: "tree", kind: "worktree", parentId: root.id };
    const threads = { tree: [{ id: "task", name: "Task", updatedAt: Date.now() }] };
    const statuses = { task: { isProcessing: true } };
    const view = renderHook(({ chats }) => useSidebarProjects([root, child], [root], chats, statuses), {
      initialProps: { chats: threads },
    });
    expect(view.result.current.activeThreads.map((entry) => entry.thread.id)).toEqual(["task"]);
    const removeFromOpenMenu = view.result.current.removeActiveThread;
    act(() => view.result.current.removeActiveThread("tree", "task"));
    expect(view.result.current.activeThreads).toEqual([]);
    view.rerender({ chats: { tree: [{ ...threads.tree[0] }] } });
    expect(view.result.current.activeThreads).toEqual([]);
    view.rerender({ chats: { tree: [{ ...threads.tree[0], updatedAt: threads.tree[0].updatedAt + 1 }] } });
    expect(view.result.current.activeThreads.map((entry) => entry.thread.id)).toEqual(["task"]);
    act(() => removeFromOpenMenu("tree", "task"));
    expect(view.result.current.activeThreads).toEqual([]);
  });

  it.each(['{invalid', 'null', '[]', '{"project-0":"invalid","project-1":-1}'])("ignores malformed removal preferences: %s", (stored) => {
    localStorage.setItem(REMOVED_ACTIVE_THREADS_STORAGE_KEY, stored);
    const view = renderHook(() => useSidebarProjects(projects, projects, {}, { task: { isProcessing: true } }));
    expect(view.result.current.activeThreads).toEqual([]);
    expect(localStorage.getItem(REMOVED_ACTIVE_THREADS_STORAGE_KEY)).toBe("{}");
    act(() => view.result.current.removeActiveThread("missing", "task"));
    expect(localStorage.getItem(REMOVED_ACTIVE_THREADS_STORAGE_KEY)).toBe("{}");
  });

  it("applies removals for the session when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    const threads = { [projects[0].id]: [{ id: "task", name: "Chat", updatedAt: Date.now() }] };
    const view = renderHook(() => useSidebarProjects(projects, projects, threads, {}));
    expect(view.result.current.activeThreads.map((entry) => entry.workspaceId)).toEqual([projects[0].id]);
    act(() => view.result.current.removeActiveThread(projects[0].id, "task"));
    expect(view.result.current.activeThreads).toEqual([]);
  });

  it("preserves existing project dismissals until a thread receives newer activity", () => {
    const now = Date.now();
    localStorage.setItem(REMOVED_ACTIVE_PROJECTS_STORAGE_KEY, JSON.stringify({ "project-0": now }));
    const view = renderHook(({ updatedAt }) => useSidebarProjects(projects, projects, {
      "project-0": [{ id: "task", name: "Task", updatedAt }],
    }, {}), { initialProps: { updatedAt: now } });
    expect(view.result.current.activeThreads).toEqual([]);
    view.rerender({ updatedAt: now + 1 });
    expect(view.result.current.activeThreads).toHaveLength(1);
    expect(localStorage.getItem(REMOVED_ACTIVE_PROJECTS_STORAGE_KEY)).toBe(JSON.stringify({ "project-0": now }));
  });

  it("keeps sibling threads visible and expires recent chats as the sidebar clock advances", () => {
    vi.useFakeTimers();
    const updatedAt = Date.now() - ACTIVE_THREAD_WINDOW_MS;
    const view = renderHook(() => useSidebarProjects(projects, projects, { "project-0": [
      { id: "first", name: "First", updatedAt }, { id: "second", name: "Second", updatedAt },
    ] }, {}));
    act(() => view.result.current.removeActiveThread("project-0", "first"));
    expect(view.result.current.activeThreads.map((entry) => entry.thread.id)).toEqual(["second"]);
    act(() => vi.advanceTimersByTime(60_000));
    expect(view.result.current.activeThreads).toEqual([]);
  });

});
