// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrowserPanel } from "./useBrowserPanel";

const events = vi.hoisted(() => ({
  activated: null as null | ((event: { threadId: string }) => void),
}));

vi.mock("@services/events", () => ({
  subscribeBrowserSessionActivated: (callback: (event: { threadId: string }) => void) => {
    events.activated = callback;
    return () => {
      if (events.activated === callback) events.activated = null;
    };
  },
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("useBrowserPanel", () => {
  it("keeps explicit visibility scoped to each thread", () => {
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useBrowserPanel(threadId),
      { initialProps: { threadId: "thread-one" as string | null } },
    );

    expect(result.current.open).toBe(false);
    act(() => result.current.setOpen(true));
    expect(result.current.open).toBe(true);

    rerender({ threadId: "thread-two" });
    expect(result.current.open).toBe(false);

    rerender({ threadId: "thread-one" });
    expect(result.current.open).toBe(true);
    act(() => result.current.setOpen(false));
    expect(result.current.open).toBe(false);

    rerender({ threadId: "thread-two" });
    rerender({ threadId: "thread-one" });
    expect(result.current.open).toBe(false);
  });

  it("opens only when an activation belongs to the active thread", () => {
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useBrowserPanel(threadId),
      { initialProps: { threadId: "thread-one" as string | null } },
    );

    act(() => events.activated?.({ threadId: "thread-two" }));
    expect(result.current.open).toBe(false);

    act(() => events.activated?.({ threadId: "thread-one" }));
    expect(result.current.open).toBe(true);

    rerender({ threadId: "thread-two" });
    expect(result.current.open).toBe(false);
    act(() => events.activated?.({ threadId: "thread-two" }));
    expect(result.current.open).toBe(true);
  });

  it("opens a project website only for its target thread", () => {
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useBrowserPanel(threadId),
      { initialProps: { threadId: "thread-one" as string | null } },
    );

    act(() => result.current.openWebsite("workspace-one", "thread-two", "https://example.com"));
    expect(result.current.open).toBe(false);
    expect(result.current.navigationRequest).toMatchObject({
      workspaceId: "workspace-one",
      threadId: "thread-two",
      url: "https://example.com",
    });

    rerender({ threadId: "thread-two" });
    expect(result.current.open).toBe(true);
  });
});
