import type {
  RateLimitSnapshot,
  RateLimitWindow,
  UsageGovernorSettings,
  UsageGovernorSnapshot,
} from "@/types";

export type UsageRateSample = {
  at: number;
  usedPercent: number;
  resetsAt: number;
  windowDurationMins: number;
};

const WEEK_MINUTES = 7 * 24 * 60;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export const DEFAULT_USAGE_GOVERNOR_SETTINGS: UsageGovernorSettings = {
  mode: "adaptive",
  maxConcurrentTurns: 2,
  weeklyReservePercent: 10,
  autoCompactEnabled: true,
  compactContextPercent: 60,
  autoInterruptRunaways: true,
  runawayTokenBudget: 5_000_000,
  runawayMinutes: 30,
};

function normalizeResetMs(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 1_000_000_000_000 ? value : value * 1000;
}

export function isWeeklyRateLimitWindow(window: RateLimitWindow | null) {
  if (!window) return false;
  return (window.windowDurationMins ?? 0) >= WEEK_MINUTES - 60;
}

export function classifyRateLimitWindows(snapshot: RateLimitSnapshot | null) {
  const windows = [snapshot?.primary ?? null, snapshot?.secondary ?? null];
  return {
    session: windows.find(
      (window): window is RateLimitWindow =>
        window !== null && !isWeeklyRateLimitWindow(window),
    ) ?? null,
    weekly: windows.find(
      (window): window is RateLimitWindow => isWeeklyRateLimitWindow(window),
    ) ?? null,
  };
}

export function selectWeeklyRateLimit(
  snapshots: Array<RateLimitSnapshot | null | undefined>,
): RateLimitWindow | null {
  const windows = snapshots.flatMap((snapshot) =>
    [snapshot?.primary ?? null, snapshot?.secondary ?? null].filter(
      (window): window is RateLimitWindow => isWeeklyRateLimitWindow(window),
    ),
  );
  if (windows.length === 0) return null;

  const newestReset = Math.max(
    ...windows.map((window) => normalizeResetMs(window.resetsAt) ?? 0),
  );
  const sameWindow = windows.filter(
    (window) => (normalizeResetMs(window.resetsAt) ?? 0) === newestReset,
  );
  return sameWindow.reduce((best, candidate) =>
    candidate.usedPercent > best.usedPercent ? candidate : best,
  );
}

export function appendUsageRateSample(
  history: UsageRateSample[],
  window: RateLimitWindow | null,
  now: number,
): UsageRateSample[] {
  const resetsAt = normalizeResetMs(window?.resetsAt ?? null);
  const duration = window?.windowDurationMins;
  if (!window || resetsAt === null || !duration) return history;
  const previous = history[history.length - 1];
  if (
    previous &&
    previous.resetsAt === resetsAt &&
    window.usedPercent < previous.usedPercent
  ) {
    return history;
  }
  if (
    previous &&
    previous.resetsAt === resetsAt &&
    previous.usedPercent === window.usedPercent
  ) {
    return history;
  }
  const next = [
    ...history.filter((sample) => sample.resetsAt === resetsAt && now - sample.at <= TWO_HOURS_MS),
    {
      at: now,
      usedPercent: window.usedPercent,
      resetsAt,
      windowDurationMins: duration,
    },
  ];
  return next.slice(-24);
}

function projectedExhaustionAt(
  history: UsageRateSample[],
  usedPercent: number,
  spendablePercent: number,
  now: number,
) {
  const first = history[0];
  const last = history[history.length - 1];
  if (!first || !last || first === last || last.usedPercent <= first.usedPercent) {
    return null;
  }
  const elapsedMs = last.at - first.at;
  if (elapsedMs < 60_000) return null;
  const percentPerMs = (last.usedPercent - first.usedPercent) / elapsedMs;
  if (percentPerMs <= 0) return null;
  const remaining = Math.max(0, spendablePercent - usedPercent);
  return now + remaining / percentPerMs;
}

export function buildUsageGovernorSnapshot({
  settings,
  rateLimits,
  history,
  activeTurns,
  queuedTurns,
  now,
}: {
  settings: UsageGovernorSettings;
  rateLimits: Array<RateLimitSnapshot | null | undefined>;
  history: UsageRateSample[];
  activeTurns: number;
  queuedTurns: number;
  now: number;
}): UsageGovernorSnapshot {
  const weekly = selectWeeklyRateLimit(rateLimits);
  const resetsAt = normalizeResetMs(weekly?.resetsAt ?? null);
  const usedPercent = weekly?.usedPercent ?? null;
  const configuredConcurrency = Math.max(1, settings.maxConcurrentTurns);
  if (settings.mode === "off") {
    return {
      state: "off",
      usedPercent,
      resetsAt,
      projectedExhaustionAt: null,
      activeTurns,
      effectiveConcurrency: configuredConcurrency,
      queuedTurns,
    };
  }

  const spendablePercent = 100 - settings.weeklyReservePercent;
  const projection =
    usedPercent === null
      ? null
      : projectedExhaustionAt(history, usedPercent, spendablePercent, now);
  const exhaustedReserve = usedPercent !== null && usedPercent >= spendablePercent;
  const trendingPastReset =
    projection !== null && resetsAt !== null && projection < resetsAt;
  const state = exhaustedReserve
    ? "critical"
    : trendingPastReset
      ? "throttled"
      : "normal";

  return {
    state,
    usedPercent,
    resetsAt,
    projectedExhaustionAt: projection,
    activeTurns,
    effectiveConcurrency: state === "normal" ? configuredConcurrency : 1,
    queuedTurns,
  };
}

