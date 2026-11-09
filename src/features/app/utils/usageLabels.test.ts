import { describe, expect, it } from "vitest";
import { getUsageLabels } from "./usageLabels";

describe("getUsageLabels", () => {
  it("labels a weekly primary window as weekly", () => {
    const labels = getUsageLabels(
      {
        primary: {
          usedPercent: 42,
          windowDurationMins: 10_080,
          resetsAt: 2_000_000_000,
        },
        secondary: null,
        credits: null,
        planType: "pro",
      },
      false,
    );

    expect(labels.sessionPercent).toBeNull();
    expect(labels.weeklyPercent).toBe(42);
    expect(labels.showWeekly).toBe(true);
  });

  it("handles session and weekly windows in either position", () => {
    const labels = getUsageLabels(
      {
        primary: {
          usedPercent: 40,
          windowDurationMins: 10_080,
          resetsAt: 2_000_000_000,
        },
        secondary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_900_000_000,
        },
        credits: null,
        planType: "pro",
      },
      true,
    );

    expect(labels.sessionPercent).toBe(80);
    expect(labels.weeklyPercent).toBe(60);
  });
});
