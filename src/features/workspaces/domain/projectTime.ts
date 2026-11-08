import type { ProjectTimeDay, ProjectTimeThread } from "@/types";

export function formatTrackedTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

export function weekStart(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateKey(date);
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export type ProjectTimeRow = ProjectTimeDay & { threadCount: number };

export function groupProjectTime(
  threads: ProjectTimeThread[],
  weekly: boolean,
): ProjectTimeRow[] {
  const rows = new Map<string, ProjectTimeRow & { threadIds: Set<string> }>();
  for (const thread of threads) {
    for (const day of thread.days) {
      const key = weekly ? weekStart(day.day) : day.day;
      const row = rows.get(key) ?? {
        day: key,
        agentTimeMs: 0,
        estimatedTimeMs: 0,
        threadCount: 0,
        threadIds: new Set<string>(),
      };
      row.agentTimeMs += day.agentTimeMs;
      row.estimatedTimeMs += day.estimatedTimeMs;
      row.threadIds.add(`${thread.workspaceId}:${thread.threadId}`);
      row.threadCount = row.threadIds.size;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export function validHumanMultiplier(value: number): boolean {
  return Number.isFinite(value) && value >= 0.1 && value <= 100;
}
