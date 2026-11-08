// @vitest-environment jsdom
import { useReducer } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, threadReducer } from "./useThreadsReducer";
import { loadUnreadThreadStatuses, UNREAD_THREADS_STORAGE_KEY, useThreadReadState } from "./useThreadReadState";

function useReadState(activeThreadId: string | null) {
  const [state, dispatch] = useReducer(threadReducer, undefined, () => ({
    ...initialState,
    threadStatusById: loadUnreadThreadStatuses(),
  }));
  const complete = useThreadReadState({ activeThreadId, threadStatusById: state.threadStatusById, dispatch });
  return { state, dispatch, complete };
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("thread read state", () => {
  it("persists an unseen completion across restart and clears it on viewing", () => {
    const first = renderHook(() => useReadState("another-thread"));
    act(() => first.result.current.complete("workspace", "finished"));
    expect(first.result.current.state.threadStatusById.finished.hasUnread).toBe(true);
    expect(JSON.parse(localStorage.getItem(UNREAD_THREADS_STORAGE_KEY)!)).toEqual(["finished"]);
    first.unmount();

    const second = renderHook(({ active }) => useReadState(active), { initialProps: { active: "another-thread" } });
    // Loading its summary must preserve restored unread state.
    act(() => second.result.current.dispatch({ type: "ensureThread", workspaceId: "workspace", threadId: "finished" }));
    expect(second.result.current.state.threadStatusById.finished.hasUnread).toBe(true);
    second.rerender({ active: "finished" });
    expect(second.result.current.state.threadStatusById.finished.hasUnread).toBe(false);
    expect(JSON.parse(localStorage.getItem(UNREAD_THREADS_STORAGE_KEY)!)).toEqual([]);
  });

  it("marks a selected thread unread while the app is unfocused, then clears it on return", () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const view = renderHook(() => useReadState("finished"));
    act(() => view.result.current.complete("workspace", "finished"));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(true);
    // A visibility event alone must not acknowledge a window still in the background.
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(true);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(false);
  });

  it("keeps a hidden window unread until its selected thread is visible again", () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const view = renderHook(() => useReadState("finished"));
    act(() => view.result.current.complete("workspace", "finished"));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(true);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(false);
  });

  it("does not mark a completion unread while its thread is being viewed", () => {
    const view = renderHook(() => useReadState("finished"));
    act(() => view.result.current.complete("workspace", "finished"));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(false);
  });

  it("does not restore unread running or reviewing messages as finished after restart", () => {
    const view = renderHook(() => useReadState(null));
    act(() => {
      view.result.current.dispatch({ type: "markProcessing", threadId: "running", isProcessing: true, timestamp: 1 });
      view.result.current.dispatch({ type: "markUnread", threadId: "running", hasUnread: true });
      view.result.current.dispatch({ type: "markReviewing", threadId: "reviewing", isReviewing: true });
      view.result.current.dispatch({ type: "markUnread", threadId: "reviewing", hasUnread: true });
    });
    expect(loadUnreadThreadStatuses()).toEqual({});
    act(() => {
      view.result.current.dispatch({ type: "markProcessing", threadId: "running", isProcessing: false, timestamp: 2 });
      view.result.current.complete("workspace", "running");
    });
    expect(Object.keys(loadUnreadThreadStatuses())).toEqual(["running"]);
  });

  it.each(["{invalid", "null", "{}", '[null,12,""]'])("ignores invalid persisted state: %s", (stored) => {
    localStorage.setItem(UNREAD_THREADS_STORAGE_KEY, stored);
    expect(loadUnreadThreadStatuses()).toEqual({});
  });

  it("continues tracking unread completions when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
    const view = renderHook(() => useReadState(null));
    act(() => view.result.current.complete("workspace", "finished"));
    expect(view.result.current.state.threadStatusById.finished.hasUnread).toBe(true);
  });
});
