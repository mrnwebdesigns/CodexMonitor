// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { searchMessages } from "@services/tauri";
import { MessageSearchResults } from "./MessageSearchResults";

vi.mock("@services/tauri", () => ({ searchMessages: vi.fn() }));
const workspaces = [{ id: "client", name: "Client Ops" }] as WorkspaceInfo[];
const result = { threadId: "older-chat", workspaceId: "client", title: "Migration planning", excerpt: "Please check achelios.com", category: "message" as const };
beforeEach(() => { vi.mocked(searchMessages).mockResolvedValue({ results: [result], elapsedMs: 5, status: null }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Message search results", () => {
  it("opens a matching older chat even when it is absent from loaded sidebar summaries", async () => {
    const onSelectThread = vi.fn();
    render(<MessageSearchResults query="achelios.com" workspaces={workspaces} onSelectThread={onSelectThread} />);
    fireEvent.click(await screen.findByRole("button", { name: /Migration planning/ }));
    expect(onSelectThread).toHaveBeenCalledWith("client", "older-chat");
    expect(searchMessages).toHaveBeenCalledWith("achelios.com", ["client"], false);
  });

  it("filters hidden chats and results outside visible projects", async () => {
    vi.mocked(searchMessages).mockResolvedValue({ results: [result, { ...result, threadId: "private", workspaceId: "hidden" }], elapsedMs: 1, status: null });
    render(<MessageSearchResults query="achelios.com" workspaces={workspaces} isThreadHidden={() => true} onSelectThread={vi.fn()} />);
    await screen.findByText("No indexed messages match.");
    expect(screen.queryByRole("button", { name: /Migration planning/ })).toBeNull();
  });

  it("waits for three characters and debounces typing", async () => {
    const { rerender } = render(<MessageSearchResults query="ac" workspaces={workspaces} onSelectThread={vi.fn()} />);
    expect(searchMessages).not.toHaveBeenCalled();
    rerender(<MessageSearchResults query="achelios.com" workspaces={workspaces} onSelectThread={vi.fn()} />);
    expect(searchMessages).not.toHaveBeenCalled();
    await screen.findByText("Please check achelios.com");
    expect(searchMessages).toHaveBeenCalledTimes(1);
  });

  it("ignores an old query response after the user changes the search", async () => {
    let finish: (value: Awaited<ReturnType<typeof searchMessages>>) => void = () => {};
    vi.mocked(searchMessages).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { rerender } = render(<MessageSearchResults query="achelios.com" workspaces={workspaces} onSelectThread={vi.fn()} />);
    await waitFor(() => expect(searchMessages).toHaveBeenCalledTimes(1));
    rerender(<MessageSearchResults query="another.example" workspaces={workspaces} onSelectThread={vi.fn()} />);
    await act(async () => { finish({ results: [result], elapsedMs: 2, status: null }); });
    expect(screen.queryByText("Please check achelios.com")).toBeNull();
  });
});
