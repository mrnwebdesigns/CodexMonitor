// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectTimeSnapshot } from "@/types";
import { useProjectTime } from "../hooks/useProjectTime";
import { ProjectTimeCard } from "./ProjectTimeCard";

vi.mock("../hooks/useProjectTime", () => ({ useProjectTime: vi.fn() }));
const snapshot: ProjectTimeSnapshot = {
  updatedAt: Date.parse("2026-11-07T12:00:00Z"),
  rangeStart: "2026-10-09",
  rangeEnd: "2026-11-07",
  timeZone: "-05:00",
  warnings: [],
  threads: [
    {
      threadId: "one",
      workspaceId: "project",
      title: "Homepage update",
      days: [
        { day: "2026-11-05", agentTimeMs: 3_600_000, estimatedTimeMs: 0 },
        {
          day: "2026-11-06",
          agentTimeMs: 1_800_000,
          estimatedTimeMs: 1_800_000,
        },
      ],
    },
    {
      threadId: "two",
      workspaceId: "tree",
      title: "Contact form",
      days: [{ day: "2026-11-05", agentTimeMs: 1_800_000, estimatedTimeMs: 0 }],
    },
  ],
};
const refresh = vi.fn();
beforeEach(() => {
  localStorage.clear();
  vi.mocked(useProjectTime).mockReturnValue({
    snapshot,
    loading: false,
    error: null,
    refresh,
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function openDetails() {
  fireEvent.click(screen.getByText("Detailed time report"));
}

describe("ProjectTimeCard", () => {
  it("shows day/week/thread totals and opens the owning worktree's thread", () => {
    const open = vi.fn();
    render(<ProjectTimeCard workspaceId="project" onOpenThread={open} />);
    expect(screen.getByText("2h 0m", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("≈ 8h 0m", { selector: "strong" })).toBeTruthy();
    openDetails();
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      4,
    );
    fireEvent.click(screen.getByRole("button", { name: "By week" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(
      3,
    );
    fireEvent.click(screen.getByRole("button", { name: "By thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Contact form" }));
    expect(open).toHaveBeenCalledWith("tree", "two");
    fireEvent.change(screen.getByLabelText("Thread", { selector: "select" }), {
      target: { value: "project:one" },
    });
    expect(screen.getByText("1 thread in range")).toBeTruthy();
    expect(screen.getAllByText("≈ 6h 0m").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Contact form" })).toBeNull();
  });

  it("persists valid human estimates, rejects invalid values, and isolates projects", () => {
    const view = render(
      <ProjectTimeCard workspaceId="project" onOpenThread={vi.fn()} />,
    );
    const input = screen.getByLabelText("Human-time multiplier");
    fireEvent.change(input, { target: { value: "2.5" } });
    expect(screen.getByText("≈ 5h 0m", { selector: "strong" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "0" } });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("≈ 5h 0m", { selector: "strong" })).toBeTruthy();
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toBe("2.5");
    view.rerender(
      <ProjectTimeCard workspaceId="another" onOpenThread={vi.fn()} />,
    );
    expect(
      (screen.getByLabelText("Human-time multiplier") as HTMLInputElement)
        .value,
    ).toBe("4");
    view.rerender(
      <ProjectTimeCard workspaceId="project" onOpenThread={vi.fn()} />,
    );
    expect(
      (screen.getByLabelText("Human-time multiplier") as HTMLInputElement)
        .value,
    ).toBe("2.5");
  });

  it("requests another date range and presents empty/error states without invented time", () => {
    const view = render(
      <ProjectTimeCard workspaceId="project" onOpenThread={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Report range"), {
      target: { value: "90" },
    });
    expect(useProjectTime).toHaveBeenLastCalledWith("project", 90);
    vi.mocked(useProjectTime).mockReturnValue({
      snapshot: { ...snapshot, threads: [] },
      loading: false,
      error: null,
      refresh,
    });
    view.rerender(
      <ProjectTimeCard workspaceId="project" onOpenThread={vi.fn()} />,
    );
    openDetails();
    expect(screen.getByText(/No timed activity found/)).toBeTruthy();
    vi.mocked(useProjectTime).mockReturnValue({
      snapshot: null,
      loading: false,
      error: "Unavailable",
      refresh,
    });
    view.rerender(
      <ProjectTimeCard workspaceId="project" onOpenThread={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Unavailable");
    expect(screen.queryByText("≈ 0s")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh project time" }),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
