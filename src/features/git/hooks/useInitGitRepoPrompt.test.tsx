// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceInfo } from "@/types";
import { previewGitInit, type GitInitReview } from "@services/tauri";
import { useInitGitRepoPrompt } from "./useInitGitRepoPrompt";
vi.mock("@services/tauri", () => ({ previewGitInit: vi.fn() }));
const workspace: WorkspaceInfo = { id: "ws-1", name: "Repo", path: "/tmp/repo", connected: true, settings: { sidebarCollapsed: false } };
const review: GitInitReview = { root: "/tmp/repo", relativeRoot: ".", profile: "Source project", suggestedRoots: ["."], existingRepo: null, author: "Test <test@example.invalid>", included: [{ path: "source.txt", bytes: 10, reason: null }], excluded: [], ignoreContent: ".env\n", blockers: [], fingerprint: "review-v1" };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(previewGitInit).mockResolvedValue(review); });
function options() { return { activeWorkspace: workspace, initGitRepo: vi.fn().mockResolvedValue("initialized"), createGitHubRepo: vi.fn().mockResolvedValue({ ok: true }), refreshGitRemote: vi.fn(), isBusy: false }; }

describe("reviewed Git setup", () => {
  it("defaults to local-only, waits for a review, and passes the reviewed file selection before initialization", async () => {
    const p=options();const { result }=renderHook(() => useInitGitRepoPrompt(p));
    act(() => result.current.openInitGitRepoPrompt());
    expect(result.current.initGitRepoPrompt?.createRemote).toBe(false);
    await act(async () => result.current.handleInitGitRepoPromptConfirm());
    expect(p.initGitRepo).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.initGitRepoPrompt?.review?.fingerprint).toBe("review-v1"));
    await act(async () => result.current.handleInitGitRepoPromptConfirm());
    expect(p.initGitRepo).toHaveBeenCalledWith("main", { root: ".", excludedPaths: [], fingerprint: "review-v1" });
    expect(p.createGitHubRepo).not.toHaveBeenCalled();expect(result.current.initGitRepoPrompt).toBeNull();
  });
  it("invalidates the old review when a file is excluded", async () => {
    const p=options();const { result }=renderHook(() => useInitGitRepoPrompt(p));
    act(() => result.current.openInitGitRepoPrompt());
    await waitFor(() => expect(result.current.initGitRepoPrompt?.reviewLoading).toBe(false));
    act(() => result.current.handleInitGitRepoPromptReviewChange({ excludePath: "source.txt" }));
    expect(result.current.initGitRepoPrompt?.review).toBeNull();
    await act(async () => result.current.handleInitGitRepoPromptConfirm());expect(p.initGitRepo).not.toHaveBeenCalled();
    await waitFor(() => expect(previewGitInit).toHaveBeenLastCalledWith("ws-1", ".", "main", ["source.txt"]));
  });
  it("blocks initialization when preview detects an existing repo or an unsafe broad scope", async () => {
    vi.mocked(previewGitInit).mockResolvedValue({ ...review, blockers: ["Choose a theme folder"], fingerprint: "" });
    const p=options();const { result }=renderHook(() => useInitGitRepoPrompt(p));
    act(() => result.current.openInitGitRepoPrompt());await waitFor(() => expect(result.current.initGitRepoPrompt?.reviewLoading).toBe(false));
    await act(async () => result.current.handleInitGitRepoPromptConfirm());expect(p.initGitRepo).not.toHaveBeenCalled();
  });
  it("never publishes after a failed initial commit", async () => {
    const p=options();p.initGitRepo.mockResolvedValue("failed");const { result }=renderHook(() => useInitGitRepoPrompt(p));
    act(() => result.current.openInitGitRepoPrompt());await waitFor(() => expect(result.current.initGitRepoPrompt?.reviewLoading).toBe(false));
    act(() => result.current.handleInitGitRepoPromptCreateRemoteChange(true));
    await act(async () => result.current.handleInitGitRepoPromptConfirm());expect(p.createGitHubRepo).not.toHaveBeenCalled();
    expect(result.current.initGitRepoPrompt?.error).toContain("Setup did not complete");
  });
  it("requires explicit GitHub selection and retries only remote setup after local success", async () => {
    const p=options();p.createGitHubRepo.mockResolvedValueOnce({ ok: false, error: "Fixture remote error" }).mockResolvedValueOnce({ ok: true });
    const { result }=renderHook(() => useInitGitRepoPrompt(p));
    act(() => result.current.openInitGitRepoPrompt());await waitFor(() => expect(result.current.initGitRepoPrompt?.reviewLoading).toBe(false));
    act(() => result.current.handleInitGitRepoPromptCreateRemoteChange(true));
    await act(async () => result.current.handleInitGitRepoPromptConfirm());expect(result.current.initGitRepoPrompt?.localInitialized).toBe(true);
    await act(async () => result.current.handleInitGitRepoPromptConfirm());
    expect(p.initGitRepo).toHaveBeenCalledTimes(1);expect(p.createGitHubRepo).toHaveBeenCalledTimes(2);
    expect(p.createGitHubRepo).toHaveBeenCalledWith("repo", "private", "main");expect(result.current.initGitRepoPrompt).toBeNull();
  });
});
