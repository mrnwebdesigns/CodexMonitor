// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUSTOM_PROJECT_COLORS_STORAGE_KEY, PROJECT_COLORS_STORAGE_KEY, useProjectColors } from "./useProjectColors";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("project color preferences", () => {
  it("persists choices by project ID and clears one without changing another", () => {
    const first = renderHook(useProjectColors);
    act(() => {
      first.result.current.setProjectColor("client", "purple");
      first.result.current.setProjectColor("internal", "green");
    });
    first.unmount();
    const second = renderHook(useProjectColors);
    expect(second.result.current.getProjectColor("client")).toBe("purple");
    expect(second.result.current.getProjectColor("internal")).toBe("green");
    act(() => second.result.current.setProjectColor("client", null));
    expect(second.result.current.getProjectColor("client")).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(PROJECT_COLORS_STORAGE_KEY) || "{}")).toEqual({ internal: "green" });
  });

  it.each(['{invalid', '[]', 'null', '"blue"'])("recovers from malformed preferences: %s", (stored) => {
    localStorage.setItem(PROJECT_COLORS_STORAGE_KEY, stored);
    const view = renderHook(useProjectColors);
    expect(view.result.current.getProjectColor("client")).toBeUndefined();
    act(() => view.result.current.setProjectColor("client", "blue"));
    expect(view.result.current.getProjectColor("client")).toBe("blue");
  });

  it("ignores unsupported colors and inherited object properties", () => {
    localStorage.setItem(PROJECT_COLORS_STORAGE_KEY, JSON.stringify({ client: "blue", invalid: "url(example)", other: 42 }));
    const view = renderHook(useProjectColors);
    expect(view.result.current.getProjectColor("client")).toBe("blue");
    expect(view.result.current.getProjectColor("invalid")).toBeUndefined();
    expect(view.result.current.getProjectColor("toString")).toBeUndefined();
    act(() => view.result.current.setProjectColor("client", "blue"));
    expect(JSON.parse(localStorage.getItem(PROJECT_COLORS_STORAGE_KEY) || "{}")).toEqual({ client: "blue" });
  });

  it("shares custom colors and project assignments immediately across mounted consumers and remounts", () => {
    const sidebar = renderHook(useProjectColors);
    const settings = renderHook(useProjectColors);
    act(() => {
      expect(settings.result.current.addCustomColor("Brand navy", "#123")).toBeNull();
      settings.result.current.setProjectColor("client", "custom:#112233");
      sidebar.result.current.setProjectColor("internal", "green");
    });
    expect(sidebar.result.current.palette[sidebar.result.current.palette.length - 1]).toEqual({ id: "custom:#112233", label: "Brand navy", value: "#112233" });
    expect(sidebar.result.current.getProjectColor("client")).toBe("custom:#112233");
    expect(settings.result.current.getProjectColor("internal")).toBe("green");
    sidebar.unmount(); settings.unmount();
    const next = renderHook(useProjectColors);
    expect(next.result.current.customColors).toHaveLength(1);
    expect(next.result.current.getProjectColor("client")).toBe("custom:#112233");
    act(() => next.result.current.removeCustomColor("custom:#112233"));
    expect(next.result.current.getProjectColor("client")).toBeUndefined();
    expect(next.result.current.getProjectColor("internal")).toBe("green");
    expect(next.result.current.palette).toHaveLength(8);
  });

  it("rejects duplicate, invalid, or unnamed colors and ignores malformed saved palette entries", () => {
    localStorage.setItem(CUSTOM_PROJECT_COLORS_STORAGE_KEY, JSON.stringify([
      { id: "custom:#112233", label: "Navy", value: "#112233" },
      { id: "custom:#112233", label: "Duplicate", value: "#112233" },
      { id: "custom:#ffffff", label: "Bad ID", value: "url(example)" },
      { id: "custom:#222222", label: "Red", value: "#222222" },
      { id: "custom:#ffffff", label: "", value: "#ffffff" },
    ]));
    const view = renderHook(useProjectColors);
    expect(view.result.current.customColors).toEqual([{ id: "custom:#112233", label: "Navy", value: "#112233" }]);
    expect(view.result.current.addCustomColor(" navy ", "#556677")).toMatch(/name already/);
    expect(view.result.current.addCustomColor("Other", "#112233")).toMatch(/already in/);
    expect(view.result.current.addCustomColor("Other", "not-hex")).toMatch(/hex color/);
    expect(view.result.current.addCustomColor("", "#556677")).toMatch(/name/);
  });

  it("receives palette and project changes from another window without resetting preset assignments", () => {
    localStorage.setItem(PROJECT_COLORS_STORAGE_KEY, '{"client":"purple"}');
    const view = renderHook(useProjectColors);
    expect(view.result.current.getProjectColor("client")).toBe("purple");
    act(() => {
      localStorage.setItem(CUSTOM_PROJECT_COLORS_STORAGE_KEY, '[{"id":"custom:#112233","label":"Navy","value":"#112233"}]');
      window.dispatchEvent(new StorageEvent("storage", { key: CUSTOM_PROJECT_COLORS_STORAGE_KEY }));
    });
    expect(view.result.current.customColors).toHaveLength(1);
    expect(view.result.current.getProjectColor("client")).toBe("purple");
    act(() => {
      localStorage.setItem(PROJECT_COLORS_STORAGE_KEY, '{"client":"custom:#112233"}');
      window.dispatchEvent(new StorageEvent("storage", { key: PROJECT_COLORS_STORAGE_KEY }));
    });
    expect(view.result.current.getProjectColor("client")).toBe("custom:#112233");
  });
});
