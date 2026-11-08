// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { HiddenProjects } from "./HiddenProjects";

afterEach(cleanup);

describe("HiddenProjects", () => {
  it("lists every counted project even when group rows are incomplete or missing", () => {
    const client: WorkspaceInfo = {
      id: "client", name: "Client Alpha", path: "/tmp/client", connected: true,
      settings: { sidebarCollapsed: false, groupId: "clients" },
    };
    const orphan: WorkspaceInfo = {
      ...client, id: "orphan", name: "Orphan project",
      settings: { sidebarCollapsed: false, groupId: "removed-group" },
    };
    const onShow = vi.fn();
    const onShowAll = vi.fn();
    const props = {
      projects: [client, orphan], groups: [{ id: "clients", name: "Clients", workspaces: [] }],
      activity: new Map(), query: "", onShow, onShowAll,
    };
    const view = render(<HiddenProjects {...props} />);
    expect(within(screen.getByRole("heading", { name: "Clients" }).parentElement!).getByRole("button", { name: "Show project: Client Alpha" })).toBeTruthy();
    expect(within(screen.getByRole("heading", { name: "Ungrouped" }).parentElement!).getByRole("button", { name: "Show project: Orphan project" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Show project:/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show project: Client Alpha" }));
    expect(onShow).toHaveBeenCalledWith("client");
    view.rerender(<HiddenProjects {...props} groups={[]} />);
    expect(screen.getAllByRole("button", { name: /^Show project:/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(onShowAll).toHaveBeenCalledOnce();
  });
});
