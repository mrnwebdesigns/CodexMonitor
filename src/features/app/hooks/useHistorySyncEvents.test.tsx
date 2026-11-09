// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerEvent, WorkspaceInfo } from "@/types";
import { subscribeAppServerEvents } from "@services/events";
import { useHistorySyncEvents } from "./useHistorySyncEvents";

vi.mock("@services/events", () => ({ subscribeAppServerEvents: vi.fn() }));

const workspace = (id: string, connected = true) => ({ id, connected }) as WorkspaceInfo;
const change = (workspaceId: string) => ({
  workspace_id: workspaceId,
  message: { method: "codex/historySynced", params: { threadIds: ["imported"] } },
}) as AppServerEvent;

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("automatic history sidebar refresh", () => {
  it("forwards imported activity for disconnected projects without resuming chats or accepting unknown or malformed updates", () => {
    let receive!: (event: AppServerEvent) => void;
    vi.mocked(subscribeAppServerEvents).mockImplementation((listener) => { receive = listener; return vi.fn(); });
    const onImportedThreadActivity = vi.fn();
    const refresh = vi.fn();
    const view = renderHook(() => useHistorySyncEvents({
      enabled: true, workspaces: [workspace("a"), workspace("offline", false)],
      listThreadsForWorkspaces: refresh, onImportedThreadActivity,
    }));
    const activity = { threadId: "imported", turnId: "turn-1", status: "completed" };
    const event = (id: string) => ({ ...change(id), message: { method: "codex/historySynced", params: {
      activities: [activity, { ...activity, status: "unknown" }, { ...activity, threadId: "" }, null],
    } } });
    act(() => { receive(event("a")); receive(event("offline")); receive(event("missing")); });
    expect(onImportedThreadActivity.mock.calls).toEqual([["a", activity], ["offline", activity]]);
    expect(refresh).not.toHaveBeenCalled();
    view.unmount();
  });

  it("batches affected connected workspaces and preserves current state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let receive!: (event: AppServerEvent) => void;
    const unsubscribe = vi.fn();
    vi.mocked(subscribeAppServerEvents).mockImplementation((listener) => {
      receive = listener;
      return unsubscribe;
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const a = workspace("a"); const b = workspace("b");
    const { unmount } = renderHook(() => useHistorySyncEvents({
      enabled: true, workspaces: [a, b, workspace("offline", false)],
      listThreadsForWorkspaces: refresh,
    }));
    act(() => { receive(change("a")); receive(change("b")); receive(change("a")); receive(change("offline")); });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith([a, b], { preserveState: true });
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not refresh another backend or process events after unmount", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useHistorySyncEvents({
      enabled: false, workspaces: [workspace("a")], listThreadsForWorkspaces: refresh,
    }));
    expect(subscribeAppServerEvents).not.toHaveBeenCalled();
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("queues changes received during a refresh without overlapping requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let receive!: (event: AppServerEvent) => void;
    vi.mocked(subscribeAppServerEvents).mockImplementation((listener) => {
      receive = listener; return vi.fn();
    });
    let finish!: () => void;
    const refresh = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    renderHook(() => useHistorySyncEvents({ enabled: true, workspaces: [workspace("a")], listThreadsForWorkspaces: refresh }));
    act(() => receive(change("a")));
    await act(() => vi.advanceTimersByTimeAsync(100));
    act(() => receive(change("a")));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
