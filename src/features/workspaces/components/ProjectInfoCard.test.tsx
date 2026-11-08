// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDiscovery, WorkspaceInfo } from "@/types";
import { discoverProject } from "@services/tauri";
import { ProjectInfoCard } from "./ProjectInfoCard";
vi.mock("@services/tauri", () => ({ discoverProject: vi.fn() }));
const workspace: WorkspaceInfo = { id: "test-project", name: "Test project", path: "/tmp/test-project", connected: true, settings: { sidebarCollapsed: false } };
const discovery: ProjectDiscovery = {
  checkedAt: 1794056400000, website: "https://example.com/",
  projectType: { value: "wordpress", detail: "Local Hub manifest" },
  hosting: { value: "SiteGround", detail: "Configured provider" },
  ssh: { value: "example-ssh", detail: "Configured alias; access not tested" },
  localHub: { value: "Registered", detail: "Runtime not verified" },
  mainwp: { value: "Connected", detail: "Exact website synced" },
};
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);
describe("project information", () => {
  it("saves project information through workspace settings and normalizes a website without changing agent instructions", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add details" }));
    fireEvent.change(screen.getByLabelText("Client / owner"), { target: { value: " Test client " } });
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "example.com" } });
    fireEvent.change(screen.getByLabelText("Working notes"), { target: { value: "Review the homepage" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("test-project", expect.objectContaining({ client: "Test client", website: "https://example.com/", notes: "Review the homepage", summary: "" })));
  });
  it("retains separate unsaved drafts when switching projects and remounting", () => {
    const onSave = vi.fn();
    const view = render(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add details" }));
    fireEvent.change(screen.getByLabelText("Overview"), { target: { value: "First project draft" } });
    view.rerender(<ProjectInfoCard workspace={{ ...workspace, id: "second-project" }} onSave={onSave} />);
    expect(screen.queryByLabelText("Overview")).toBeNull();
    view.unmount();
    render(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    expect((screen.getByLabelText("Overview") as HTMLTextAreaElement).value).toBe("First project draft");
  });
  it("retains edits and shows errors when persistence fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Save failed"));
    render(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add details" }));
    fireEvent.change(screen.getByLabelText("Overview"), { target: { value: "Keep this note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Save failed"));
    expect((screen.getByLabelText("Overview") as HTMLTextAreaElement).value).toBe("Keep this note");
  });
  it("rejects credential-bearing website URLs and opens a saved website through the supplied internal browser action", async () => {
    const onSave = vi.fn(); const onOpenWebsite = vi.fn();
    const view = render(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add details" }));
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "https://user:secret@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("credentials"));
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    view.rerender(<ProjectInfoCard workspace={{ ...workspace, settings: { sidebarCollapsed: false, projectInfo: { client: "Test", summary: "", notes: "", website: "https://example.com/" } } }} onSave={onSave} onOpenWebsite={onOpenWebsite} />);
    fireEvent.click(screen.getByRole("button", { name: /Open website in Browser/ }));
    expect(onOpenWebsite).toHaveBeenCalledWith("https://example.com/");
  });
  it("discovers into a reviewable draft, preserves overrides, and saves the evidence", async () => {
    vi.mocked(discoverProject).mockResolvedValue(discovery);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<ProjectInfoCard workspace={{ ...workspace, settings: { sidebarCollapsed: false, projectInfo: { client: "", summary: "", notes: "", website: "", hosting: "Kinsta" } } }} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Discover connections" }));
    await waitFor(() => expect((screen.getByLabelText("Website") as HTMLInputElement).value).toBe("https://example.com/"));
    expect(discoverProject).toHaveBeenCalledWith(workspace.id, "", "");
    expect((screen.getByLabelText("Hosted") as HTMLInputElement).value).toBe("Kinsta");
    expect(screen.getByPlaceholderText("example-ssh")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(workspace.id, expect.objectContaining({ hosting: "Kinsta", discovery })));
  });
  it("keeps a discovery response with the originating project when switching projects", async () => {
    let resolve!: (value: ProjectDiscovery) => void;
    vi.mocked(discoverProject).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const onSave = vi.fn();
    const view = render(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Discover connections" }));
    view.rerender(<ProjectInfoCard workspace={{ ...workspace, id: "second-project" }} onSave={onSave} />);
    resolve(discovery);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("codexmonitor.projectInfoDrafts.v1") || "{}")[workspace.id]?.discovery?.hosting.value).toBe("SiteGround"));
    expect(screen.queryByText(/Last discovered/)).toBeNull();
    expect(screen.queryByLabelText("Website")).toBeNull();
    view.rerender(<ProjectInfoCard workspace={workspace} onSave={onSave} />);
    expect(screen.getByPlaceholderText("SiteGround")).toBeTruthy();
  });
  it("restores legacy drafts and clears stale findings when the website changes", () => {
    localStorage.setItem("codexmonitor.projectInfoDrafts.v1", JSON.stringify({ [workspace.id]: { client: "Legacy", website: "example.com", summary: "Keep this", notes: "", discovery } }));
    render(<ProjectInfoCard workspace={workspace} onSave={vi.fn()} />);
    expect((screen.getByLabelText("Overview") as HTMLInputElement).value).toBe("Keep this");
    expect(screen.getByPlaceholderText("SiteGround")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "other.example.com" } });
    expect(screen.queryByPlaceholderText("SiteGround")).toBeNull();
    expect(screen.getByPlaceholderText("Hosting provider, such as SiteGround or Kinsta")).toBeTruthy();
  });
  it("shows all saved project connection fields", () => {
    render(<ProjectInfoCard workspace={{ ...workspace, settings: { sidebarCollapsed: false, projectInfo: { client: "", website: "", summary: "", notes: "", projectType: "mac-app", hosting: "Internal", ssh: "devbox", localHub: "Not applicable", mainwp: "Not applicable" } } }} onSave={vi.fn()} />);
    expect(screen.getByText("Mac app")).toBeTruthy();
    expect(screen.getByText("Internal")).toBeTruthy();
    expect(screen.getByText("devbox")).toBeTruthy();
    expect(screen.getAllByText("Not applicable")).toHaveLength(2);
  });
});
