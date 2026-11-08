// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings, WorkspaceGroup } from "@/types";
import { sortWorkspaceGroups } from "../domain/workspaceGroups";
import { useWorkspaceGroupOps } from "./useWorkspaceGroupOps";

const groups: WorkspaceGroup[] = [
  { id: "last", name: "Last", sortOrder: 30, copiesFolder: "/tmp/copies" },
  { id: "first", name: "First", sortOrder: 0 },
  { id: "empty", name: "Empty", sortOrder: 10 },
  { id: "middle", name: "Middle", sortOrder: 20 },
];

function setup() {
  const appSettings = { theme: "dark", workspaceGroups: groups } as AppSettings;
  const save = vi.fn(async (next: AppSettings) => next);
  const updateWorkspaceSettings = vi.fn();
  const { result } = renderHook(() => useWorkspaceGroupOps({
    appSettings,
    onUpdateAppSettings: save,
    workspaceGroups: sortWorkspaceGroups(groups),
    workspaceGroupById: new Map(groups.map((group) => [group.id, group])),
    workspaces: [],
    updateWorkspaceSettings,
  }));
  return { result, save, updateWorkspaceSettings };
}

describe("useWorkspaceGroupOps reordering", () => {
  it.each([
    ["last", "first", "before", ["last", "first", "empty", "middle"]],
    ["first", "last", "after", ["empty", "middle", "last", "first"]],
  ] as const)("persists a move of %s %s %s while retaining empty groups and metadata", async (id, target, position, expected) => {
    const { result, save, updateWorkspaceSettings } = setup();
    await act(async () => {
      expect(await result.current.reorderWorkspaceGroup(id, target, position)).toBe(true);
    });
    const saved = save.mock.calls[0][0];
    expect(sortWorkspaceGroups(saved.workspaceGroups).map((group) => group.id)).toEqual(expected);
    expect(sortWorkspaceGroups(saved.workspaceGroups).map((group) => group.sortOrder)).toEqual([0, 1, 2, 3]);
    expect(saved.theme).toBe("dark");
    expect(saved.workspaceGroups.find((group) => group.id === "last")?.copiesFolder).toBe("/tmp/copies");
    expect(groups[0].sortOrder).toBe(30);
    expect(updateWorkspaceSettings).not.toHaveBeenCalled();
  });

  it.each([
    ["first", "first", "after"],
    ["first", "empty", "before"],
    ["last", "middle", "after"],
    ["missing", "first", "before"],
    ["first", "missing", "before"],
  ] as const)("ignores an unchanged or stale move: %s %s %s", async (id, target, position) => {
    const { result, save } = setup();
    expect(await result.current.reorderWorkspaceGroup(id, target, position)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("uses the same saved ordering for the settings up/down controls", async () => {
    const { result, save } = setup();
    await result.current.moveWorkspaceGroup("last", "up");
    expect(sortWorkspaceGroups(save.mock.calls[0][0].workspaceGroups).map((group) => group.id))
      .toEqual(["first", "empty", "last", "middle"]);
  });
});
