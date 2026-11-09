// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import type { WorkspaceInfo } from "@/types";
import { HIDDEN_PROJECTS_STORAGE_KEY } from "../hooks/useProjectVisibility";
import { PROJECT_COLORS_STORAGE_KEY } from "@app/hooks/useProjectColors";
import { Sidebar } from "./Sidebar";

type NativeMenuItem = { text: string; action?: () => void; items?: NativeMenuItem[] };
const nativeMenuNew = vi.hoisted(() => vi.fn(async (_options: { items: NativeMenuItem[] }) => ({ popup: vi.fn() })));
vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: nativeMenuNew },
  MenuItem: { new: async (options: NativeMenuItem) => options },
  CheckMenuItem: { new: async (options: NativeMenuItem) => options },
  Submenu: { new: async (options: NativeMenuItem) => options },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

beforeEach(() => localStorage.clear());

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  }
  cleanup();
});

const baseProps = {
  workspaces: [],
  groupedWorkspaces: [],
  hasWorkspaceGroups: false,
  deletingWorktreeIds: new Set<string>(),
  threadsByWorkspace: {},
  threadParentById: {},
  threadStatusById: {},
  threadListLoadingByWorkspace: {},
  threadListPagingByWorkspace: {},
  threadListCursorByWorkspace: {},
  pinnedThreadsVersion: 0,
  threadListSortKey: "updated_at" as const,
  onSetThreadListSortKey: vi.fn(),
  threadListOrganizeMode: "by_project" as const,
  onSetThreadListOrganizeMode: vi.fn(),
  onRefreshAllThreads: vi.fn(),
  activeWorkspaceId: null,
  activeThreadId: null,
  accountRateLimits: null,
  usageShowRemaining: false,
  accountInfo: null,
  onSwitchAccount: vi.fn(),
  onCancelSwitchAccount: vi.fn(),
  accountSwitching: false,
  onOpenSettings: vi.fn(),
  onOpenDebug: vi.fn(),
  showDebugButton: false,
  onAddWorkspace: vi.fn(),
  onSelectHome: vi.fn(),
  onSelectWorkspace: vi.fn(),
  onConnectWorkspace: vi.fn(),
  onAddAgent: vi.fn(),
  onAddWorktreeAgent: vi.fn(),
  onAddCloneAgent: vi.fn(),
  onToggleWorkspaceCollapse: vi.fn(),
  onSelectThread: vi.fn(),
  onDeleteThread: vi.fn(),
  onSyncThread: vi.fn(),
  pinThread: vi.fn(() => false),
  unpinThread: vi.fn(),
  isThreadPinned: vi.fn(() => false),
  getPinTimestamp: vi.fn(() => null),
  onRenameThread: vi.fn(),
  onDeleteWorkspace: vi.fn(),
  onDeleteWorktree: vi.fn(),
  onLoadOlderThreads: vi.fn(),
  onReloadWorkspaceThreads: vi.fn(),
  workspaceDropTargetRef: createRef<HTMLElement>(),
  isWorkspaceDropActive: false,
  workspaceDropText: "Drop Project Here",
  onWorkspaceDragOver: vi.fn(),
  onWorkspaceDragEnter: vi.fn(),
  onWorkspaceDragLeave: vi.fn(),
  onWorkspaceDrop: vi.fn(),
};

describe("Sidebar", () => {
  it("updates active thread colors from the project menu and opens the thread directly", async () => {
    nativeMenuNew.mockClear();
    const project = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    const props = {
      ...baseProps, workspaces: [project],
      groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [project] }],
      threadsByWorkspace: { client: [{ id: "task", name: "Task", updatedAt: Date.now() }] },
    };
    const view = render(<Sidebar {...props} />);
    const row = view.container.querySelector<HTMLElement>(".workspace-row")!;
    fireEvent.contextMenu(row);
    await waitFor(() => expect(nativeMenuNew).toHaveBeenCalledTimes(1));
    const colorItems = () => nativeMenuNew.mock.lastCall![0].items.find((item) => item.text === "Project color")!.items!;
    act(() => colorItems().find((item) => item.text === "Purple")!.action!());
    const activeLink = screen.getByRole("button", { name: "Open thread: Task (Client Alpha)" });
    expect(row.dataset.projectColor).toBe("purple");
    expect(activeLink.dataset.projectColor).toBe("purple");
    expect(row.style.getPropertyValue("--sidebar-item-color")).toBe(activeLink.style.getPropertyValue("--sidebar-item-color"));
    fireEvent.click(activeLink);
    expect(baseProps.onSelectThread).toHaveBeenCalledWith("client", "task");
    expect(JSON.parse(localStorage.getItem(PROJECT_COLORS_STORAGE_KEY) || "{}")).toEqual({ client: "purple" });
    view.unmount();
    const next = render(<Sidebar {...props} activeWorkspaceId="client" />);
    expect(next.container.querySelector<HTMLElement>(".workspace-row.active")?.dataset.projectColor).toBe("purple");
    fireEvent.contextMenu(next.container.querySelector(".workspace-row")!);
    await waitFor(() => expect(nativeMenuNew).toHaveBeenCalledTimes(2));
    act(() => colorItems().find((item) => item.text === "None")!.action!());
    expect(next.container.querySelector("[data-project-color]")).toBeNull();
  });

  function renderSortableGroups(onReorderWorkspaceGroup = vi.fn().mockResolvedValue(true)) {
    const projects = ["Clients", "Internal", "Other", "Ungrouped"].map((name) => ({
      id: name, name: `${name} project`, path: `/tmp/${name}`, connected: true,
      settings: { sidebarCollapsed: false },
    }));
    const props = {
      ...baseProps,
      workspaces: projects,
      groupedWorkspaces: projects.map((workspace) => ({
        id: workspace.id === "Ungrouped" ? null : workspace.id,
        name: workspace.id, workspaces: [workspace],
      })),
      hasWorkspaceGroups: true,
      onReorderWorkspaceGroup,
    };
    const view = render(<Sidebar {...props} />);
    const sections = Array.from(view.container.querySelectorAll<HTMLElement>(".workspace-group"));
    sections.forEach((section, index) => {
      vi.spyOn(section, "getBoundingClientRect").mockReturnValue(new DOMRect(0, index * 100, 250, 90));
    });
    vi.spyOn(view.container.querySelector(".sidebar-body")!, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 250, 500));
    const handle = screen.getByRole("button", { name: "Reorder Clients group" });
    handle.setPointerCapture = vi.fn();
    return { ...view, props, handle, sections, onReorderWorkspaceGroup };
  }

  it("drag sorts collapsed groups without toggling them or changing projects", async () => {
    localStorage.setItem("codexmonitor.collapsedGroups", '["Clients"]');
    const { handle, sections, onReorderWorkspaceGroup } = renderSortableGroups();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 270 });
    expect(sections[0].className).toContain("is-dragging");
    expect(sections[2].dataset.dropPosition).toBe("after");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 270 });
    await waitFor(() => expect(onReorderWorkspaceGroup).toHaveBeenCalledWith("Clients", "Other", "after"));
    expect(onReorderWorkspaceGroup).toHaveBeenCalledTimes(1);
    expect(sections[0].querySelector(".workspace-group-list")?.className).toContain("collapsed");
    expect(localStorage.getItem("codexmonitor.collapsedGroups")).toBe('["Clients"]');
    expect(sections[2].dataset.dropPosition).toBeUndefined();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Clients moved after Other."));
  });

  it("collapses and expands every project from its group heading", () => {
    const onToggleWorkspaceCollapse = vi.fn();
    const projects: WorkspaceInfo[] = [
      { id: "alpha", name: "Alpha", path: "/tmp/alpha", connected: true, settings: { sidebarCollapsed: false } },
      { id: "beta", name: "Beta", path: "/tmp/beta", connected: true, settings: { sidebarCollapsed: true } },
    ];
    const props = {
      ...baseProps,
      workspaces: projects,
      groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: projects }],
      hasWorkspaceGroups: true,
      onToggleWorkspaceCollapse,
    };
    const view = render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Collapse all projects in Clients" }));
    expect(onToggleWorkspaceCollapse).toHaveBeenCalledTimes(1);
    expect(onToggleWorkspaceCollapse).toHaveBeenCalledWith("alpha", true);

    const collapsedProjects = projects.map((project) => ({
      ...project,
      settings: { ...project.settings, sidebarCollapsed: true },
    }));
    view.rerender(
      <Sidebar
        {...props}
        workspaces={collapsedProjects}
        groupedWorkspaces={[{ id: "clients", name: "Clients", workspaces: collapsedProjects }]}
      />,
    );
    onToggleWorkspaceCollapse.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Expand all projects in Clients" }));
    expect(onToggleWorkspaceCollapse).toHaveBeenCalledTimes(2);
    expect(onToggleWorkspaceCollapse).toHaveBeenCalledWith("alpha", false);
    expect(onToggleWorkspaceCollapse).toHaveBeenCalledWith("beta", false);
  });

  it.each(["escape", "cancel", "outside", "click", "ungrouped"])("does not save when a drag ends with %s", (ending) => {
    const { handle, sections, onReorderWorkspaceGroup } = renderSortableGroups();
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    if (ending !== "click") {
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 270 });
    }
    if (ending === "escape") fireEvent.keyDown(handle, { key: "Escape" });
    if (ending === "cancel") fireEvent.pointerCancel(window, { pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: ending === "outside" ? 500 : 20,
      clientY: ending === "click" ? 20 : ending === "ungrouped" ? 350 : 270 });
    expect(onReorderWorkspaceGroup).not.toHaveBeenCalled();
    expect(sections[0].className).not.toContain("is-dragging");
  });

  it("supports keyboard sorting and reports persistence failures", async () => {
    const onReorder = vi.fn().mockRejectedValue(new Error("disk full"));
    const { handle } = renderSortableGroups(onReorder);
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    expect(onReorder).toHaveBeenCalledWith("Clients", "Internal", "after");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not save group order"));
    expect(handle.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Reorder Ungrouped group" })).toBeNull();
  });

  it("retains keyboard focus and prevents overlapping saves", async () => {
    let finish!: (value: boolean) => void;
    const onReorder = vi.fn().mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    const { handle } = renderSortableGroups(onReorder);
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    expect(handle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(handle, { key: "ArrowDown", altKey: true });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(handle);
    finish(true);
    await waitFor(() => expect(handle.getAttribute("aria-disabled")).toBe("false"));
    expect(document.activeElement).toBe(handle);
  });

  it("disables sorting in filtered search results", async () => {
    renderSortableGroups();
    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "project" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Reorder Clients group" })).toBeNull());
  });

  it("keeps hidden projects, child chats, and pins out of the sidebar and restores them in their group", () => {
    localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, '["client"]');
    const client: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: false, groupId: "clients" } };
    const clone: WorkspaceInfo = { ...client, id: "clone", name: "Client Clone", settings: { ...client.settings, cloneSourceWorkspaceId: "client" } };
    const tree: WorkspaceInfo = { ...client, id: "tree", name: "Client Worktree", kind: "worktree", parentId: "clone" };
    const internal: WorkspaceInfo = { ...client, id: "internal", name: "Internal Beta", settings: { sidebarCollapsed: false, groupId: "internal" } };
    const onDeleteWorkspace = vi.fn();
    const p = { ...baseProps, workspaces: [client, clone, tree, internal], groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [client, clone] }, { id: "internal", name: "Internal", workspaces: [internal] }], hasWorkspaceGroups: true,
      threadsByWorkspace: { client: [{ id: "hidden-pin", name: "Hidden pinned chat", updatedAt: Date.now() }], tree: [{ id: "running-child", name: "Hidden worktree chat", updatedAt: Date.now() }], internal: [{ id: "visible-chat", name: "Visible internal chat", updatedAt: Date.now() }] },
      threadStatusById: { "running-child": { isProcessing: true } },
      isThreadPinned: (_workspaceId: string, id: string) => id === "hidden-pin",
      getPinTimestamp: (_workspaceId: string, id: string) => id === "hidden-pin" ? 1 : null,
      onDeleteWorkspace,
    };
    const view = render(<Sidebar {...p} />);
    expect(screen.queryByRole("button", { name: "Open thread: Hidden worktree chat (Client Alpha)" })).toBeNull();
    expect(screen.queryByText("Hidden pinned chat")).toBeNull();
    expect(screen.queryByText("Hidden worktree chat")).toBeNull();
    expect(view.container.querySelectorAll(".workspace-row .workspace-name")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hidden projects (1)" }));
    expect(screen.getByRole("region", { name: "Hidden projects" }).textContent).toContain("Clients");
    expect(screen.getByText("1 agent running")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show project: Client Alpha" }));
    expect(screen.getByRole("button", { name: "Hidden projects (0)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open thread: Hidden worktree chat (Client Alpha)" })).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Active Threads" })).getByText("Hidden pinned chat")).toBeTruthy();
    expect(view.container.querySelector('[data-group-kind="clients"]')?.textContent).toContain("Client Alpha");
    expect(onDeleteWorkspace).not.toHaveBeenCalled();
  });

  it("does not resurrect hidden projects during search, refresh, or thread-list mode", async () => {
    localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, '["hidden"]');
    const projects = ["hidden", "visible"].map((id) => ({ id, name: `${id} project`, path: `/tmp/${id}`, connected: true, settings: { sidebarCollapsed: false } }));
    const p = { ...baseProps, workspaces: projects, groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: projects }], threadsByWorkspace: { hidden: [{ id: "secret-chat", name: "Hidden chat", updatedAt: Date.now() }], visible: [{ id: "public-chat", name: "Visible chat", updatedAt: Date.now() }] } };
    const view = render(<Sidebar {...p} threadListOrganizeMode="threads_only" />);
    expect(screen.queryByText("Hidden chat")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Active Threads" })).getByText("Visible chat")).toBeTruthy();
    view.rerender(<Sidebar {...p} threadListOrganizeMode="threads_only" threadListCursorByWorkspace={{ hidden: "more-pages" }} threadStatusById={{ "secret-chat": { isProcessing: true } }} />);
    expect(screen.queryByText("Hidden chat")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "hidden" } });
    await waitFor(() => expect(screen.getByText("No titles or project names match your search.")).toBeTruthy());
    expect(screen.queryByText("Hidden chat")).toBeNull();
  });

  it("opens all counted hidden projects with a separate search and resets it on reentry", async () => {
    localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, '["alpha","beta"]');
    const projects = ["alpha", "beta", "visible"].map((id) => ({
      id, name: `${id} project`, path: `/tmp/${id}`, connected: true,
      settings: { sidebarCollapsed: false, groupId: "clients" },
    }));
    render(<Sidebar {...baseProps} workspaces={projects}
      groupedWorkspaces={[{ id: "clients", name: "Clients", workspaces: projects }]}
      threadsByWorkspace={{ visible: [{ id: "public-chat", name: "Public conversation", updatedAt: Date.now() }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "Public conversation" } });
    await waitFor(() => expect(screen.queryByRole("region", { name: "Active Threads" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Hidden projects (2)" }));
    expect(screen.getAllByRole("button", { name: /^Show project:/ })).toHaveLength(2);
    const hiddenSearch = screen.getByLabelText("Search hidden projects") as HTMLInputElement;
    expect(hiddenSearch.value).toBe("");
    fireEvent.change(hiddenSearch, { target: { value: "alpha" } });
    expect(screen.getByRole("button", { name: "Show project: alpha project" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show project: beta project" })).toBeNull();
    fireEvent.change(hiddenSearch, { target: { value: "missing" } });
    expect(screen.getByText("No hidden projects match your search.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to projects" }));
    expect((screen.getByLabelText("Search conversations") as HTMLInputElement).value).toBe("Public conversation");
    fireEvent.click(screen.getByRole("button", { name: "Hidden projects (2)" }));
    expect(screen.getAllByRole("button", { name: /^Show project:/ })).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Search hidden projects"), { target: { value: "missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    expect(screen.getAllByRole("button", { name: /^Show project:/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show project: alpha project" }));
    expect(screen.getAllByRole("button", { name: /^Show project:/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show project: beta project" }));
    expect(screen.getByRole("button", { name: "Hidden projects (0)" })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(HIDDEN_PROJECTS_STORAGE_KEY) || "[]")).toEqual([]);
  });

  it("keeps a restoration control when every project is hidden", () => {
    localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, '["client"]');
    const client = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: false } };
    render(<Sidebar {...baseProps} workspaces={[client]} groupedWorkspaces={[{ id: "clients", name: "Clients", workspaces: [client] }]} />);
    expect(screen.getByText("All projects are hidden. Open Hidden projects to show them.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hidden projects (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByRole("button", { name: "Hidden projects (0)" })).toBeTruthy();
    expect(screen.getByText("Client Alpha")).toBeTruthy();
  });

  it("shows the running worktree thread with its project label and opens the correct checkout", () => {
    const root = { id: "project", name: "Client project", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    const tree = { ...root, id: "tree", name: "Worktree", kind: "worktree" as const, parentId: "project" };
    const p = { ...baseProps, workspaces: [root, tree], groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [root] }], hasWorkspaceGroups: true, threadsByWorkspace: { tree: [{ id: "task", name: "Task", updatedAt: 1 }] } };
    const view = render(<Sidebar {...p} threadStatusById={{ task: { isProcessing: true } }} />);
    const active = screen.getByRole("region", { name: "Active Threads" });
    expect(active.textContent).toContain("Task");
    expect(active.querySelector(".active-thread-meta")?.textContent).toBe("Client project · Running");
    expect(active.textContent).toContain("Running");
    expect(active.querySelector(".active-thread-dot.is-running")).toBeTruthy();
    expect(view.container.querySelectorAll(".workspace-group .workspace-name")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open thread: Task (Client project)" }));
    expect(baseProps.onSelectThread).toHaveBeenCalledWith("tree", "task");
    view.rerender(<Sidebar {...p} threadStatusById={{}} />);
    expect(active.textContent).toContain("Client project · Updated");
    expect(view.container.querySelector(".workspace-group .workspace-name")?.textContent).toBe("Client project");
  });

  it("shows governor capacity and queued positions in Active Threads", () => {
    const project: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    render(<Sidebar
      {...baseProps}
      workspaces={[project]}
      groupedWorkspaces={[{ id: "clients", name: "Clients", workspaces: [project] }]}
      threadsByWorkspace={{ client: [{ id: "task", name: "Queued task", updatedAt: Date.now() }] }}
      usageGovernorSnapshot={{
        state: "throttled",
        usedPercent: 82,
        resetsAt: null,
        projectedExhaustionAt: null,
        activeTurns: 1,
        effectiveConcurrency: 1,
        queuedTurns: 1,
      }}
      usageGovernorQueue={[{ id: "queued-1", workspaceId: "client", threadId: "task", createdAt: Date.now(), position: 1 }]}
    />);
    const active = screen.getByRole("region", { name: "Active Threads" });
    expect(within(active).getByText("Governor throttled · 1/1 · 1 queued")).toBeTruthy();
    expect(within(active).getByText("Governor queued · #1")).toBeTruthy();
    expect(active.querySelector(".active-thread-dot.is-queued")).toBeTruthy();
  });

  it("marks finished unread active threads and clears the indicator after they are viewed", () => {
    const project: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    const props = { ...baseProps, workspaces: [project], groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [project] }],
      threadsByWorkspace: { client: [{ id: "task", name: "Finished task", updatedAt: Date.now() }] },
    };
    const view = render(<Sidebar {...props} threadStatusById={{ task: { hasUnread: true, isProcessing: true } }} />);
    const active = screen.getByRole("region", { name: "Active Threads" });
    expect(active.textContent).not.toContain("Finished · unread");
    view.rerender(<Sidebar {...props} threadStatusById={{ task: { hasUnread: true, isProcessing: false } }} />);
    expect(within(active).getByText("Finished · unread")).toBeTruthy();
    expect(active.querySelector(".active-thread-dot.is-unread")).toBeTruthy();
    const link = within(active).getByRole("button", { name: "Open thread: Finished task (Client Alpha)" });
    expect(link.getAttribute("aria-describedby")).toBe("active-thread-unread-task");
    fireEvent.click(link);
    expect(baseProps.onSelectThread).toHaveBeenCalledWith("client", "task");
    view.rerender(<Sidebar {...props} activeWorkspaceId="client" activeThreadId="task" threadStatusById={{ task: { hasUnread: false } }} />);
    expect(active.textContent).not.toContain("Finished · unread");
    expect(active.querySelector(".active-thread-dot.is-unread")).toBeNull();
    view.rerender(<Sidebar {...props} threadStatusById={{ task: { hasUnread: true, isReviewing: true } }} />);
    expect(active.textContent).toContain("Reviewing");
    expect(active.textContent).not.toContain("Finished · unread");
  });

  it("keeps Active Threads available in thread-list mode and collapses the area independently", () => {
    const project: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    const props = { ...baseProps, workspaces: [project], groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [project] }],
      threadsByWorkspace: { client: [{ id: "task", name: "Active task", updatedAt: Date.now() }] },
    };
    const view = render(<Sidebar {...props} threadListOrganizeMode="threads_only" activeWorkspaceId="client" activeThreadId="task" />);
    const active = screen.getByRole("region", { name: "Active Threads" });
    expect(within(active).getByRole("button", { name: "Open thread: Active task (Client Alpha)" }).getAttribute("aria-current")).toBe("page");
    const heading = within(active).getByRole("button", { name: "Active Threads (1)" });
    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(within(active).queryByText("Active task")).toBeNull();
    view.unmount();
    render(<Sidebar {...props} threadListOrganizeMode="by_project_activity" />);
    const remounted = screen.getByRole("region", { name: "Active Threads" });
    expect(within(remounted).queryByText("Active task")).toBeNull();
    fireEvent.click(within(remounted).getByRole("button", { name: "Active Threads (1)" }));
    expect(within(remounted).getByText("Active task")).toBeTruthy();
  });

  it("keeps hidden chats out of Active Threads even when a stale summary says they are running", () => {
    const project: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    render(<Sidebar {...baseProps} workspaces={[project]} groupedWorkspaces={[{ id: "clients", name: "Clients", workspaces: [project] }]}
      threadsByWorkspace={{ client: [{ id: "archived", name: "Archived task", updatedAt: Date.now() }] }}
      threadStatusById={{ archived: { isProcessing: true } }} isThreadHidden={(_, threadId) => threadId === "archived"} />);
    expect(within(screen.getByRole("region", { name: "Active Threads" })).queryByText("Archived task")).toBeNull();
  });

  it("groups Active Threads by their root parent with labeled dividers and remembers the order", () => {
    const project: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: true } };
    const now = Date.now();
    const props = {
      ...baseProps,
      workspaces: [project],
      groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [project] }],
      threadsByWorkspace: { client: [
        { id: "parent-a", name: "Parent A", updatedAt: now - 4 },
        { id: "child-a", name: "Child A", updatedAt: now },
        { id: "parent-b", name: "Parent B", updatedAt: now - 2 },
        { id: "child-b", name: "Child B", updatedAt: now - 3 },
      ] },
      threadParentById: { "child-a": "parent-a", "child-b": "parent-b" },
    };
    const view = render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Sort Active Threads by parent" }));
    expect(screen.getByRole("separator", { name: "Parent thread: Parent A" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Parent thread: Parent B" })).toBeTruthy();
    expect(Array.from(view.container.querySelectorAll(".active-thread-name")).map((node) => node.textContent))
      .toEqual(["Parent A", "Child A", "Parent B", "Child B"]);

    view.unmount();
    const remounted = render(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: "Sort Active Threads by activity" }).getAttribute("aria-pressed")).toBe("true");
    expect(remounted.container.querySelectorAll(".active-thread-group-divider")).toHaveLength(2);
  });

  it("sorts projects within a group and remembers the selected order after remounting", () => {
    const projects = ["Zulu", "Alpha"].map((name) => ({ id: name, name, path: `/tmp/${name}`, connected: true, settings: { sidebarCollapsed: false } }));
    const p = { ...baseProps, workspaces: projects, groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: projects }], hasWorkspaceGroups: true };
    const view = render(<Sidebar {...p} />);
    const names = () => Array.from(view.container.querySelectorAll(".workspace-group .workspace-name")).map((node) => node.textContent);
    expect(names()).toEqual(["Alpha", "Zulu"]);
    fireEvent.click(screen.getByRole("button", { name: "Organize and sort threads" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name Z–A" }));
    expect(names()).toEqual(["Zulu", "Alpha"]);
    view.unmount();
    const second = render(<Sidebar {...p} />);
    expect(Array.from(second.container.querySelectorAll(".workspace-group .workspace-name")).map((node) => node.textContent)).toEqual(["Zulu", "Alpha"]);
  });

  it("dismisses only the active thread while keeping its project and running chat in the normal group", () => {
    const root: WorkspaceInfo = { id: "client", name: "Client Alpha", path: "/tmp/client", connected: true, settings: { sidebarCollapsed: false } };
    const tree: WorkspaceInfo = { ...root, id: "tree", name: "Client tree", kind: "worktree", parentId: root.id };
    const updatedAt = Date.now();
    const onDeleteWorkspace = vi.fn();
    const onSelectWorkspace = vi.fn();
    const props = { ...baseProps, workspaces: [root, tree], groupedWorkspaces: [{ id: "clients", name: "Clients", workspaces: [root] }],
      threadsByWorkspace: { tree: [{ id: "task", name: "Running task", updatedAt }] },
      threadStatusById: { task: { isProcessing: true } }, onDeleteWorkspace, onSelectWorkspace,
    };
    const first = render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove from Active Threads: Running task (Client Alpha)" }));
    expect(screen.queryByRole("button", { name: "Open thread: Running task (Client Alpha)" })).toBeNull();
    expect(first.container.querySelector(".workspace-group")?.textContent).toContain("Client Alpha");
    expect(screen.getByText("Running task")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hidden projects (0)" })).toBeTruthy();
    expect(onDeleteWorkspace).not.toHaveBeenCalled();
    expect(onSelectWorkspace).not.toHaveBeenCalled();
    first.unmount();
    const second = render(<Sidebar {...props} />);
    expect(screen.queryByRole("button", { name: "Open thread: Running task (Client Alpha)" })).toBeNull();
    second.rerender(<Sidebar {...props} threadsByWorkspace={{ tree: [{ id: "task", name: "Running task", updatedAt: updatedAt + 1 }] }} />);
    expect(screen.getByRole("button", { name: "Open thread: Running task (Client Alpha)" })).toBeTruthy();
  });

  it("keeps a waiting thread under its project while also showing it in Active Threads", () => {
    const project: WorkspaceInfo = {
      id: "client",
      name: "Client Alpha",
      path: "/tmp/client",
      connected: true,
      settings: { sidebarCollapsed: false },
    };
    const thread = { id: "task", name: "Waiting task", updatedAt: Date.now() };
    const view = render(
      <Sidebar
        {...baseProps}
        workspaces={[project]}
        groupedWorkspaces={[{ id: "clients", name: "Clients", workspaces: [project] }]}
        threadsByWorkspace={{ client: [thread] }}
        threadStatusById={{ task: { isProcessing: true } }}
        userInputRequests={[{
          workspace_id: "client",
          request_id: 1,
          params: {
            thread_id: "task",
            turn_id: "turn-1",
            item_id: "item-1",
            questions: [],
          },
        }]}
      />,
    );

    const activeThreads = screen.getByRole("region", { name: "Active Threads" });
    expect(within(activeThreads).getByText("Waiting task")).toBeTruthy();
    expect(within(activeThreads).getByText("Waiting")).toBeTruthy();
    const projectGroup = view.container.querySelector(".workspace-group");
    expect(projectGroup).not.toBeNull();
    expect(within(projectGroup as HTMLElement).getByText("Waiting task")).toBeTruthy();
    expect(within(projectGroup as HTMLElement).getByText("Waiting")).toBeTruthy();
  });

  it("toggles the search bar from the header icon", () => {
    render(<Sidebar {...baseProps} />);

    const toggleButton = screen.getByRole("button", { name: "Toggle search" });
    expect(screen.queryByLabelText("Search conversations")).toBeNull();

    fireEvent.click(toggleButton);
    const input = screen.getByLabelText("Search conversations") as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "alpha" } });
    expect(input.value).toBe("alpha");

    fireEvent.click(toggleButton);
    expect(screen.queryByLabelText("Search conversations")).toBeNull();

    fireEvent.click(toggleButton);
    const reopened = screen.getByLabelText("Search conversations") as HTMLInputElement;
    expect(reopened.value).toBe("");
  });

  it("opens thread sort menu from the header filter button", () => {
    const onSetThreadListSortKey = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        threadListSortKey="updated_at"
        onSetThreadListSortKey={onSetThreadListSortKey}
      />,
    );

    const button = screen.getByRole("button", { name: "Organize and sort threads" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(button);
    const option = screen.getByRole("menuitemradio", { name: "Created" });
    fireEvent.click(option);

    expect(onSetThreadListSortKey).toHaveBeenCalledWith("created_at");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("changes organize mode from the header filter menu", () => {
    const onSetThreadListOrganizeMode = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="by_project"
        onSetThreadListOrganizeMode={onSetThreadListOrganizeMode}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Organize and sort threads" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Thread list" }));

    expect(onSetThreadListOrganizeMode).toHaveBeenCalledWith("threads_only");
  });

  it("renders available credits in the footer when present", () => {
    render(
      <Sidebar
        {...baseProps}
        accountRateLimits={{
          primary: {
            usedPercent: 62,
            windowDurationMins: 300,
            resetsAt: Math.round(Date.now() / 1000) + 3600,
          },
          secondary: null,
          credits: {
            hasCredits: true,
            unlimited: false,
            balance: "120",
          },
          planType: "pro",
        }}
      />,
    );

    const creditsLabel = screen.getByText(/^Available credits:/);
    expect(creditsLabel.textContent ?? "").toContain("120");
  });

  it("opens the account menu from the bottom rail", () => {
    render(
      <Sidebar
        {...baseProps}
        activeWorkspaceId="ws-1"
        accountInfo={{
          email: "dimillian@example.com",
          type: "chatgpt",
          planType: "pro",
          requiresOpenaiAuth: false,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Account" }));

    expect(screen.getByText("dimillian@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch account" })).toBeTruthy();
  });

  it("renders threads-only mode as a global chronological list", () => {
    const older = Date.now() - 10_000;
    const newer = Date.now();
    const { container } = render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="threads_only"
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [{ id: "thread-1", name: "Older thread", updatedAt: older }],
          "ws-2": [{ id: "thread-2", name: "Newer thread", updatedAt: newer }],
        }}
      />,
    );

    const renderedNames = Array.from(container.querySelectorAll(".thread-row .thread-name")).map(
      (node) => node.textContent?.trim(),
    );
    expect(screen.getByText("Recent conversations")).toBeTruthy();
    expect(renderedNames[0]).toBe("Newer thread");
    expect(renderedNames[1]).toBe("Older thread");
    expect(screen.getByText("Alpha Project")).toBeTruthy();
    expect(screen.getByText("Beta Project")).toBeTruthy();
  });

  it("keeps a project visible when its thread matches the search query", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [{ id: "thread-1", name: "Fix workspace restore", updatedAt: 1000 }],
          "ws-2": [{ id: "thread-2", name: "Unrelated thread", updatedAt: 900 }],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "restore" },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeTruthy();
      expect(screen.getByText("Fix workspace restore")).toBeTruthy();
      expect(screen.queryByText("Beta Project")).toBeNull();
      expect(screen.queryByText("Unrelated thread")).toBeNull();
      const titleHeader = screen.getByText("Titles");
      const contentHeader = screen.getByText("Inside conversations");
      expect(titleHeader.compareDocumentPosition(contentHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it("searches across loaded root threads before collapsed truncation", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [
            { id: "thread-1", name: "Alpha thread", updatedAt: 1000 },
            { id: "thread-2", name: "Beta thread", updatedAt: 900 },
            { id: "thread-3", name: "Gamma thread", updatedAt: 800 },
            { id: "thread-4", name: "Delta thread", updatedAt: 700 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "delta" },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeTruthy();
      expect(screen.getByText("Delta thread")).toBeTruthy();
      expect(screen.queryByText("Alpha thread")).toBeNull();
      expect(screen.queryByText("More...")).toBeNull();
    });
  });

  it("keeps a project visible during search when only older pages may contain matches", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [{ id: "thread-1", name: "Current page thread", updatedAt: 1000 }],
        }}
        threadListCursorByWorkspace={{ "ws-1": "cursor-1" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "historical" },
    });

    await waitFor(() => {
      expect(screen.getByText("Alpha Project")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Search older..." })).toBeTruthy();
      expect(screen.queryByText("Current page thread")).toBeNull();
    });
  });

  it("keeps the parent project visible when only a worktree thread matches search", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-root",
            name: "Main Project",
            path: "/tmp/main",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-worktree",
            name: "Feature Worktree",
            path: "/tmp/main-feature",
            connected: true,
            kind: "worktree",
            parentId: "ws-root",
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-root",
                name: "Main Project",
                path: "/tmp/main",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-worktree": [
            { id: "thread-worktree", name: "Feature thread routing fix", updatedAt: 1000 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "routing fix" },
    });

    await waitFor(() => {
      expect(screen.getByText("Main Project")).toBeTruthy();
      expect(screen.getByText("Worktrees")).toBeTruthy();
      expect(screen.getByText("Feature Worktree")).toBeTruthy();
      expect(screen.getByText("Feature thread routing fix")).toBeTruthy();
    });
  });

  it("keeps clone agents visible when their thread matches search", async () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-root",
            name: "Main Project",
            path: "/tmp/main",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-clone",
            name: "Clone Agent",
            path: "/tmp/main-clone",
            connected: true,
            settings: {
              sidebarCollapsed: false,
              cloneSourceWorkspaceId: "ws-root",
            },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-root",
                name: "Main Project",
                path: "/tmp/main",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-clone",
                name: "Clone Agent",
                path: "/tmp/main-clone",
                connected: true,
                settings: {
                  sidebarCollapsed: false,
                  cloneSourceWorkspaceId: "ws-root",
                },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-clone": [
            { id: "thread-clone", name: "Investigate clone search bug", updatedAt: 1000 },
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle search" }));
    fireEvent.change(screen.getByLabelText("Search conversations"), {
      target: { value: "clone search bug" },
    });

    await waitFor(() => {
      expect(screen.getByText("Main Project")).toBeTruthy();
      expect(screen.getByText("Clone agents")).toBeTruthy();
      expect(screen.getByText("Clone Agent")).toBeTruthy();
      expect(screen.getByText("Investigate clone search bug")).toBeTruthy();
    });
  });

  it("creates a new thread from the all-threads project picker", () => {
    const onAddAgent = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="threads_only"
        onAddAgent={onAddAgent}
        workspaces={[
          {
            id: "ws-1",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New thread in project" }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha Project" }));

    expect(onAddAgent).toHaveBeenCalledTimes(1);
    expect(onAddAgent).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-1" }));
  });

  it("refreshes all workspace threads from the header button", () => {
    const onRefreshAllThreads = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        onRefreshAllThreads={onRefreshAllThreads}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh all workspace threads" }));
    expect(onRefreshAllThreads).toHaveBeenCalledTimes(1);
  });

  it("spins the refresh icon while workspace threads are refreshing", () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadListLoadingByWorkspace={{ "ws-1": true }}
      />,
    );

    const refreshButton = screen.getByRole("button", { name: "Refresh all workspace threads" });
    expect(refreshButton.getAttribute("aria-busy")).toBe("true");
    const icon = refreshButton.querySelector("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("spinning");
  });

  it("shows a top New Agent draft row and selects workspace when clicked", () => {
    const onSelectWorkspace = vi.fn();
    const props = {
      ...baseProps,
      workspaces: [
        {
          id: "ws-1",
          name: "Workspace",
          path: "/tmp/workspace",
          connected: true,
          settings: { sidebarCollapsed: false },
        },
      ],
      groupedWorkspaces: [
        {
          id: null,
          name: "Workspaces",
          workspaces: [
            {
              id: "ws-1",
              name: "Workspace",
              path: "/tmp/workspace",
              connected: true,
              settings: { sidebarCollapsed: false },
            },
          ],
        },
      ],
      newAgentDraftWorkspaceId: "ws-1",
      activeWorkspaceId: "ws-1",
      activeThreadId: null,
      onSelectWorkspace,
    };

    render(<Sidebar {...props} />);

    const draftRow = screen.getByRole("button", { name: /new agent/i });
    expect(draftRow).toBeTruthy();
    expect(draftRow.className).toContain("thread-row-draft");
    expect(draftRow.className).toContain("active");

    fireEvent.click(draftRow);
    expect(onSelectWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("renders clone agents nested under their source project", () => {
    const { container } = render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Main Project",
            path: "/tmp/main",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-2",
            name: "Clone Agent",
            path: "/tmp/main-copy",
            connected: true,
            settings: {
              sidebarCollapsed: false,
              cloneSourceWorkspaceId: "ws-1",
            },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Main Project",
                path: "/tmp/main",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-2",
                name: "Clone Agent",
                path: "/tmp/main-copy",
                connected: true,
                settings: {
                  sidebarCollapsed: false,
                  cloneSourceWorkspaceId: "ws-1",
                },
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Clone agents")).toBeTruthy();
    expect(screen.getByText("Clone Agent")).toBeTruthy();
    expect(container.querySelectorAll(".workspace-row")).toHaveLength(1);
    expect(container.querySelectorAll(".worktree-row")).toHaveLength(1);
  });

  it("sorts by project activity using clone-thread activity for the source project", () => {
    const { container } = render(
      <Sidebar
        {...baseProps}
        threadListOrganizeMode="by_project_activity"
        workspaces={[
          {
            id: "ws-a",
            name: "Alpha Project",
            path: "/tmp/alpha",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
          {
            id: "ws-a-clone",
            name: "Alpha Clone",
            path: "/tmp/alpha-clone",
            connected: true,
            settings: {
              sidebarCollapsed: false,
              cloneSourceWorkspaceId: "ws-a",
            },
          },
          {
            id: "ws-b",
            name: "Beta Project",
            path: "/tmp/beta",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-a",
                name: "Alpha Project",
                path: "/tmp/alpha",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
              {
                id: "ws-a-clone",
                name: "Alpha Clone",
                path: "/tmp/alpha-clone",
                connected: true,
                settings: {
                  sidebarCollapsed: false,
                  cloneSourceWorkspaceId: "ws-a",
                },
              },
              {
                id: "ws-b",
                name: "Beta Project",
                path: "/tmp/beta",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-a": [{ id: "thread-a", name: "Alpha root", updatedAt: 100 }],
          "ws-a-clone": [
            { id: "thread-a-clone", name: "Alpha clone thread", updatedAt: 300 },
          ],
          "ws-b": [{ id: "thread-b", name: "Beta root", updatedAt: 200 }],
        }}
      />,
    );

    const workspaceNames = Array.from(
      container.querySelectorAll(".workspace-row .workspace-name"),
    ).map((node) => node.textContent?.trim());
    expect(workspaceNames[0]).toBe("Alpha Project");
    expect(workspaceNames[1]).toBe("Beta Project");
  });

  it("does not show a workspace activity indicator when a thread is processing", () => {
    render(
      <Sidebar
        {...baseProps}
        workspaces={[
          {
            id: "ws-1",
            name: "Workspace",
            path: "/tmp/workspace",
            connected: true,
            settings: { sidebarCollapsed: false },
          },
        ]}
        groupedWorkspaces={[
          {
            id: null,
            name: "Workspaces",
            workspaces: [
              {
                id: "ws-1",
                name: "Workspace",
                path: "/tmp/workspace",
                connected: true,
                settings: { sidebarCollapsed: false },
              },
            ],
          },
        ]}
        threadsByWorkspace={{
          "ws-1": [
            {
              id: "thread-1",
              name: "Thread 1",
              updated_at: new Date().toISOString(),
            } as never,
          ],
        }}
        threadStatusById={{
          "thread-1": { isProcessing: true, hasUnread: false, isReviewing: false },
        }}
      />,
    );

    const indicator = screen.queryByTitle("Streaming updates in progress");
    expect(indicator).toBeNull();
  });
});
