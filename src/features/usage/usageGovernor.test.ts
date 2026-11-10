import { describe, expect, it } from "vitest";
import type { RateLimitSnapshot, UsageGovernorSettings } from "@/types";
import {
  appendUsageRateSample,
  buildUsageGovernorSnapshot,
  classifyRateLimitWindows,
  selectWeeklyRateLimit,
} from "./usageGovernor";

const settings: UsageGovernorSettings = {
  mode: "adaptive",
  maxConcurrentTurns: 2,
  weeklyReservePercent: 10,
  waitForWeeklyReset: false,
  autoCompactEnabled: true,
  compactContextPercent: 60,
  autoInterruptRunaways: true,
  runawayTokenBudget: 5_000_000,
  runawayMinutes: 30,
};

function snapshot(usedPercent: number, resetsAt = 2_000_000_000): RateLimitSnapshot {
  return {
    primary: { usedPercent, windowDurationMins: 10_080, resetsAt },
    secondary: null,
    credits: null,
    planType: "pro",
  };
}

describe("usage governor", () => {
  it("recognizes a weekly primary window and keeps the highest current value", () => {
    expect(selectWeeklyRateLimit([snapshot(9), snapshot(10)])?.usedPercent).toBe(10);
  });

  it("classifies windows by duration instead of primary/secondary position", () => {
    const rateLimits = snapshot(42);
    expect(classifyRateLimitWindows(rateLimits)).toEqual({
      session: null,
      weekly: rateLimits.primary,
    });
  });

  it("ignores stale decreasing samples in the same reset window", () => {
    const first = appendUsageRateSample([], snapshot(10).primary, 1_000);
    const stale = appendUsageRateSample(first, snapshot(9).primary, 2_000);
    expect(stale).toEqual(first);
  });

  it("throttles concurrency when recent burn projects exhaustion before reset", () => {
    const now = 1_000_000;
    const rateLimits = [snapshot(10, Math.floor((now + 6 * 86_400_000) / 1000))];
    const result = buildUsageGovernorSnapshot({
      settings,
      rateLimits,
      history: [
        { at: now - 30 * 60_000, usedPercent: 8, resetsAt: now + 6 * 86_400_000, windowDurationMins: 10_080 },
        { at: now, usedPercent: 10, resetsAt: now + 6 * 86_400_000, windowDurationMins: 10_080 },
      ],
      activeTurns: 4,
      queuedTurns: 0,
      now,
    });
    expect(result.state).toBe("throttled");
    expect(result.effectiveConcurrency).toBe(1);
    expect(result.projectedExhaustionAt).not.toBeNull();
  });

  it("holds queued work until the weekly reset when enabled", () => {
    const now = 1_000_000;
    const result = buildUsageGovernorSnapshot({
      settings: { ...settings, waitForWeeklyReset: true },
      rateLimits: [snapshot(90, Math.floor((now + 60_000) / 1000))],
      history: [],
      activeTurns: 0,
      queuedTurns: 1,
      now,
    });
    expect(result.state).toBe("waiting_for_reset");
    expect(result.effectiveConcurrency).toBe(0);
  });
});
