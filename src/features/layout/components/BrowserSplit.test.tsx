// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSplit } from "./BrowserSplit";

const storageKey = "codexmonitor.browserThreadPercent";
const renderSplit = () => render(<BrowserSplit chatPane="Thread" browserPanel="Browser" />);
const getDivider = () => screen.getByRole("separator", { name: "Resize thread and browser panels" });

describe("BrowserSplit", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1008);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(8);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("moves the divider in both directions and saves its position after release", () => {
    renderSplit();
    const divider = getDivider();
    divider.setPointerCapture = vi.fn();

    fireEvent.pointerDown(divider, { pointerId: 1, clientX: 429, button: 0 });
    expect(divider.setPointerCapture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 529 });
    expect(divider.getAttribute("aria-valuenow")).toBe("53");
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 10 });
    expect(divider.getAttribute("aria-valuenow")).toBe("28");
    expect(window.localStorage.getItem(storageKey)).toBe("42.5");

    fireEvent.lostPointerCapture(divider, { pointerId: 1 });
    expect(window.localStorage.getItem(storageKey)).toBe("28");
  });

  it("supports keyboard resizing and restores the saved split when reopened", () => {
    const view = renderSplit();
    const divider = getDivider();

    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("64");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("59");
    view.unmount();

    renderSplit();
    expect(getDivider().getAttribute("aria-valuenow")).toBe("59");
    fireEvent.keyDown(getDivider(), { key: "Home" });
    expect(getDivider().getAttribute("aria-valuenow")).toBe("28");
  });
});
