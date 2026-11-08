// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectTimeSnapshot } from "@/types";
import { projectTimeSnapshot } from "@services/tauri";
import { useProjectTime } from "./useProjectTime";

vi.mock("@services/tauri", () => ({ projectTimeSnapshot: vi.fn() }));
const snapshot: ProjectTimeSnapshot = {
  updatedAt: 1,
  rangeStart: "2026-11-01",
  rangeEnd: "2026-11-07",
  timeZone: "-05:00",
  threads: [],
  warnings: [],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useProjectTime", () => {
  it("discards late responses after project and range changes", async () => {
    let resolveFirst!: (snapshot: ProjectTimeSnapshot) => void;
    vi.mocked(projectTimeSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(snapshot);
    const { result, rerender } = renderHook(
      ({ id, days }) => useProjectTime(id, days),
      { initialProps: { id: "one", days: 30 } },
    );
    rerender({ id: "two", days: 7 });
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
    await act(async () =>
      resolveFirst({ ...snapshot, rangeStart: "2020-01-01" }),
    );
    expect(result.current.snapshot?.rangeStart).toBe("2026-11-01");
    expect(projectTimeSnapshot).toHaveBeenLastCalledWith("two", 7);
  });

  it("retains the last report on refresh failure and recovers on retry", async () => {
    vi.mocked(projectTimeSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("Daemon offline"))
      .mockResolvedValueOnce({ ...snapshot, updatedAt: 2 });
    const { result } = renderHook(() => useProjectTime("one", 30));
    await waitFor(() => expect(result.current.snapshot).toEqual(snapshot));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe("Daemon offline");
    expect(result.current.snapshot).toEqual(snapshot);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.snapshot?.updatedAt).toBe(2);
  });
});
