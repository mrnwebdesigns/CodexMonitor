import { describe, expect, it } from "vitest";
import type { ProjectTimeThread } from "@/types";
import {
  formatTrackedTime,
  groupProjectTime,
  weekStart,
  validHumanMultiplier,
} from "./projectTime";

describe("project time reporting", () => {
  it("formats hours without wrapping at 24 and retains short durations", () => {
    expect(formatTrackedTime(0)).toBe("0s");
    expect(formatTrackedTime(30_000)).toBe("30s");
    expect(formatTrackedTime(90_000)).toBe("1m");
    expect(formatTrackedTime(97 * 3_600_000 + 15 * 60_000)).toBe("97h 15m");
  });
  it("groups Monday weeks across month and year boundaries without double counting threads", () => {
    const threads: ProjectTimeThread[] = [
      {
        threadId: "a",
        workspaceId: "one",
        title: null,
        days: [
          { day: "2025-12-31", agentTimeMs: 10, estimatedTimeMs: 5 },
          { day: "2026-01-01", agentTimeMs: 20, estimatedTimeMs: 0 },
        ],
      },
      {
        threadId: "b",
        workspaceId: "one",
        title: null,
        days: [{ day: "2026-01-04", agentTimeMs: 30, estimatedTimeMs: 10 }],
      },
    ];
    expect(weekStart("2026-01-04")).toBe("2025-12-29");
    expect(weekStart("2026-01-05")).toBe("2026-01-05");
    const grouped = groupProjectTime(threads, true);
    expect(grouped).toMatchObject([
      {
        day: "2025-12-29",
        agentTimeMs: 60,
        estimatedTimeMs: 15,
        threadCount: 2,
      },
    ]);
    expect(groupProjectTime(threads, false)).toHaveLength(3);
  });
  it("rejects invalid human-time assumptions", () => {
    for (const value of [NaN, Infinity, 0, -1, 101])
      expect(validHumanMultiplier(value)).toBe(false);
    for (const value of [0.1, 4, 100])
      expect(validHumanMultiplier(value)).toBe(true);
  });
});
