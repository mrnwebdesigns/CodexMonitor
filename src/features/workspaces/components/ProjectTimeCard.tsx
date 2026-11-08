import { useMemo, useState } from "react";
import Clock from "lucide-react/dist/esm/icons/clock";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { ProjectTimeThread, ThreadSummary } from "@/types";
import { PanelHeader } from "@/features/design-system/components/panel/PanelPrimitives";
import {
  formatTrackedTime,
  groupProjectTime,
  validHumanMultiplier,
} from "../domain/projectTime";
import { useProjectTime } from "../hooks/useProjectTime";
import "@/styles/project-time.css";

type Props = {
  workspaceId: string;
  threadsByWorkspace?: Record<string, ThreadSummary[]>;
  onOpenThread: (workspaceId: string, threadId: string) => void;
};

function readMultiplier(key: string): number {
  try {
    const saved = Number(localStorage.getItem(key));
    return validHumanMultiplier(saved) ? saved : 4;
  } catch {
    return 4;
  }
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function totalTime(thread: ProjectTimeThread): number {
  return thread.days.reduce((sum, day) => sum + day.agentTimeMs, 0);
}

// A keyed child keeps project filters and saved estimation preferences isolated on navigation.
export function ProjectTimeCard(props: Props) {
  return <ProjectTimeContent key={props.workspaceId} {...props} />;
}

function ProjectTimeContent({
  workspaceId,
  threadsByWorkspace,
  onOpenThread,
}: Props) {
  const [days, setDays] = useState(30);
  const [view, setView] = useState<"day" | "week" | "thread">("day");
  const [threadFilter, setThreadFilter] = useState("");
  const preferenceKey = `codexmonitor.projectHumanTime.${workspaceId}`;
  const [multiplier, setMultiplier] = useState(() =>
    readMultiplier(preferenceKey),
  );
  const [multiplierDraft, setMultiplierDraft] = useState(String(multiplier));
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const { snapshot, loading, error, refresh } = useProjectTime(
    workspaceId,
    days,
  );
  const threads = useMemo(
    () =>
      [...(snapshot?.threads ?? [])].sort(
        (a, b) =>
          totalTime(b) - totalTime(a) || a.threadId.localeCompare(b.threadId),
      ),
    [snapshot],
  );
  const effectiveFilter = threads.some(
    (thread) => `${thread.workspaceId}:${thread.threadId}` === threadFilter,
  )
    ? threadFilter
    : "";
  const selectedThreads = useMemo(
    () =>
      threads.filter(
        (thread) =>
          !effectiveFilter ||
          `${thread.workspaceId}:${thread.threadId}` === effectiveFilter,
      ),
    [threads, effectiveFilter],
  );
  const rows = useMemo(
    () => groupProjectTime(selectedThreads, view === "week"),
    [selectedThreads, view],
  );
  const agentTime = rows.reduce((sum, row) => sum + row.agentTimeMs, 0);
  const estimatedTime = rows.reduce((sum, row) => sum + row.estimatedTimeMs, 0);
  const peak = Math.max(1, ...rows.map((row) => row.agentTimeMs));
  const title = (thread: ProjectTimeThread) =>
    threadsByWorkspace?.[thread.workspaceId]?.find(
      (summary) => summary.id === thread.threadId,
    )?.name ||
    thread.title ||
    `Thread ${thread.threadId.slice(0, 8)}`;
  const updateMultiplier = (draft: string) => {
    setMultiplierDraft(draft);
    const value = Number(draft);
    if (!validHumanMultiplier(value)) return;
    setMultiplier(value);
    try {
      localStorage.setItem(preferenceKey, String(value));
      setPreferenceError(null);
    } catch {
      setPreferenceError(
        "The multiplier applies for this visit, but could not be saved.",
      );
    }
  };
  const multiplierInvalid = !validHumanMultiplier(Number(multiplierDraft));

  return (
    <section
      className="project-info project-time"
      aria-label="Project time tracking"
    >
      <PanelHeader className="project-info-header">
        <div>
          <h2>
            <Clock aria-hidden />
            Time tracking
          </h2>
          <p>
            Agent time and estimated human work across this project, clones, and
            worktrees.
          </p>
        </div>
        <button
          type="button"
          className="ghost project-info-edit"
          onClick={() => {
            void refresh();
          }}
          disabled={loading}
          aria-label="Refresh project time"
        >
          <RefreshCw aria-hidden />
          {loading ? "Updating…" : "Refresh"}
        </button>
      </PanelHeader>
      <div className="project-time-content" aria-busy={loading}>
        <div className="project-time-toolbar">
          <label>
            Report range
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </label>
          <label>
            Thread
            <select
              value={effectiveFilter}
              onChange={(event) => setThreadFilter(event.target.value)}
            >
              <option value="">All threads</option>
              {threads.map((thread) => (
                <option
                  key={`${thread.workspaceId}:${thread.threadId}`}
                  value={`${thread.workspaceId}:${thread.threadId}`}
                >
                  {title(thread)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p className="workspace-home-error" role="alert">
            Could not load project time: {error}
          </p>
        )}
        {snapshot?.warnings.map((warning) => (
          <p key={warning} className="workspace-home-error" role="status">
            {warning}
          </p>
        ))}
        {snapshot ? (
          <>
            <div className="project-time-stats">
              <div>
                <span>Agent time</span>
                <strong>{formatTrackedTime(agentTime)}</strong>
                <small>
                {selectedThreads.length} thread
                {selectedThreads.length === 1 ? "" : "s"} in range
                </small>
              </div>
              <div>
                <span>Estimated human work</span>
                <strong>≈ {formatTrackedTime(agentTime * multiplier)}</strong>
                <small>Agent time × {multiplier}</small>
              </div>
            </div>
            <div className="project-time-estimate">
              <label>
                Human-time multiplier
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={multiplierDraft}
                  aria-invalid={multiplierInvalid}
                  aria-describedby="project-time-estimate-help"
                  onChange={(event) => updateMultiplier(event.target.value)}
                  onBlur={() => {
                    if (multiplierInvalid)
                      setMultiplierDraft(String(multiplier));
                  }}
                />
              </label>
              <p id="project-time-estimate-help">
                Assumption: 1 hour of agent work ≈ {multiplier} human hours.
                Adjust for your workflow; this estimate does not measure actual
                human effort or time saved.
              </p>
              {multiplierInvalid && (
                <p role="status">
                  Enter a multiplier from 0.1 to 100. The estimate still uses{" "}
                  {multiplier}×.
                </p>
              )}
              {preferenceError && <p role="status">{preferenceError}</p>}
            </div>
            <details className="project-time-details">
              <summary>
                Detailed time report{" "}
                <span>
                  {dayLabel(snapshot.rangeStart)} –{" "}
                  {dayLabel(snapshot.rangeEnd)}
                </span>
              </summary>
              <div
                className="project-time-views"
                role="group"
                aria-label="Time report grouping"
              >
                {(
                  [
                    ["day", "By day"],
                    ["week", "By week"],
                    ["thread", "By thread"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    type="button"
                    className="ghost"
                    key={value}
                    aria-pressed={view === value}
                    onClick={() => setView(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {rows.length ? (
                <div className="project-time-table-scroll">
                  <table className="project-time-table">
                    <caption className="project-time-caption">
                      Project time{" "}
                      {view === "thread"
                        ? "by thread"
                        : view === "week"
                          ? "by week, starting Monday"
                          : "by day"}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">
                          {view === "thread"
                            ? "Thread"
                            : view === "week"
                              ? "Week starting Monday"
                              : "Day"}
                        </th>
                        <th scope="col">Agent time</th>
                        <th scope="col">Human estimate</th>
                        {view !== "thread" && <th scope="col">Threads</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {view === "thread"
                        ? selectedThreads.map((thread) => (
                            <tr
                              key={`${thread.workspaceId}:${thread.threadId}`}
                            >
                              <th scope="row">
                                <button
                                  type="button"
                                  className="ghost project-time-thread"
                                  onClick={() =>
                                    onOpenThread(
                                      thread.workspaceId,
                                      thread.threadId,
                                    )
                                  }
                                  title={thread.threadId}
                                >
                                  {title(thread)}
                                </button>
                              </th>
                              <td>{formatTrackedTime(totalTime(thread))}</td>
                              <td>
                                ≈{" "}
                                {formatTrackedTime(
                                  totalTime(thread) * multiplier,
                                )}
                              </td>
                            </tr>
                          ))
                        : rows.map((row) => (
                            <tr key={row.day}>
                              <th scope="row">
                                {dayLabel(row.day)}
                                <span className="project-time-bar" aria-hidden>
                                  <i
                                    style={{
                                      width: `${(row.agentTimeMs / peak) * 100}%`,
                                    }}
                                  />
                                </span>
                              </th>
                              <td>{formatTrackedTime(row.agentTimeMs)}</td>
                              <td>
                                ≈{" "}
                                {formatTrackedTime(
                                  row.agentTimeMs * multiplier,
                                )}
                              </td>
                              <td>{row.threadCount}</td>
                            </tr>
                          ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">Total in range</th>
                        <td>{formatTrackedTime(agentTime)}</td>
                        <td>≈ {formatTrackedTime(agentTime * multiplier)}</td>
                        {view !== "thread" && <td>{selectedThreads.length}</td>}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="project-info-empty">
                  No timed activity found in this range. Run a chat or choose a
                  longer report range.
                </p>
              )}
            </details>
            <p className="project-time-method">
              Recorded turn durations exclude idle time between turns. Parallel
              threads add together. Older logs and unfinished turns use
              estimated activity time
              {estimatedTime > 0
                ? ` (${formatTrackedTime(estimatedTime)} of this total)`
                : ""}
              . Legacy gaps over 2 minutes are excluded. Only available local
              transcripts are included.
            </p>
            <p className="project-time-updated">
              Updated {new Date(snapshot.updatedAt).toLocaleTimeString()} ·
              Dates use the report host’s local timezone (current UTC
              {snapshot.timeZone}). Refreshes every minute.
              {loading ? " Updating totals…" : ""}
              {error ? " Showing the last successful report." : ""}
            </p>
          </>
        ) : (
          !error && (
            <p className="project-info-empty" role="status">
              Loading project time…
            </p>
          )
        )}
      </div>
    </section>
  );
}
