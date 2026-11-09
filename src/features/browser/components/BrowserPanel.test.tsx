// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPageEvent, BrowserSelection } from "../browserTypes";
import { BrowserPanel } from "./BrowserPanel";

const native = vi.hoisted(() => ({
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserGetUrl: vi.fn().mockResolvedValue(null),
  browserCapture: vi.fn().mockResolvedValue("/tmp/pending/browser-capture.png"),
  browserClose: vi.fn().mockResolvedValue(undefined),
  browserFinishCapture: vi.fn((_path: string, keep: boolean) =>
    Promise.resolve(keep ? "/tmp/browser-capture.png" : null),
  ),
  browserRuntimeInfo: vi.fn().mockResolvedValue({ engine: "Chromium", version: "156.0.8078.80" }),
  browserAction: vi.fn().mockResolvedValue(undefined),
  browserSetBounds: vi.fn().mockResolvedValue(undefined),
  browserSetVisible: vi.fn().mockResolvedValue(undefined),
}));
const events = vi.hoisted(() => ({ page: null as null | ((event: BrowserPageEvent) => void), selection: null as null | ((event: BrowserSelection) => void) }));
vi.mock("@services/tauri", () => native);
vi.mock("@services/events", () => ({
  subscribeBrowserPage: (callback: (event: BrowserPageEvent) => void) => { events.page = callback; return () => { events.page = null; }; },
  subscribeBrowserSelection: (callback: (event: BrowserSelection) => void) => { events.selection = callback; return () => { events.selection = null; }; },
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => { cleanup(); });

const selection: BrowserSelection = { url: "https://example.com/", title: "Example", selector: "#hero", tag: "h1", text: "Welcome", rect: { x: 0, y: 0, width: 100, height: 40 } };
const props = () => ({ workspaceId: "client-one", visible: true, canInsert: true, annotations: [], onAddAnnotation: vi.fn(), onRemoveAnnotation: vi.fn(), onInsert: vi.fn(), onClose: vi.fn() });

describe("browser feedback workflow", () => {
  it("identifies the actual engine and displays native page failures without leaving loading active", async () => {
    render(<BrowserPanel {...props()} />);
    await waitFor(() => expect(screen.getByLabelText("Browser engine").textContent).toBe("Chromium"));
    expect(screen.getByLabelText("Browser engine").getAttribute("title")).toBe("156.0.8078.80");
    act(() => events.page?.({ url: "https://example.com/", loading: true }));
    expect(screen.getByRole("button", { name: "Stop loading" })).toBeTruthy();
    act(() => events.page?.({ url: "https://example.com/", loading: true, error: "The Chromium page stopped. Use Reload to reopen it." }));
    expect(screen.getByRole("alert").textContent).toContain("Chromium page stopped");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(native.browserAction).toHaveBeenCalledWith("reload"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("handles a project website request once and preserves later browser navigation", async () => {
    const p = props(); const onNavigationHandled = vi.fn();
    const request = { id: "project-link-1", url: "https://example.com/project" };
    const view = render(<BrowserPanel {...p} navigationRequest={request} onNavigationHandled={onNavigationHandled} />);
    await waitFor(() => expect(native.browserNavigate).toHaveBeenCalledWith("https://example.com/project", expect.any(Object)));
    expect(onNavigationHandled).toHaveBeenCalledWith("project-link-1");
    view.rerender(<BrowserPanel {...p} navigationRequest={null} onNavigationHandled={onNavigationHandled} />);
    act(() => events.page?.({ url: "https://example.com/other", loading: false }));
    expect((screen.getByLabelText("Website address") as HTMLInputElement).value).toBe("https://example.com/other");
    expect(native.browserNavigate).toHaveBeenCalledTimes(1);
  });

  it("normalizes an address before opening the embedded native view", async () => {
    render(<BrowserPanel {...props()} />);
    fireEvent.change(screen.getByLabelText("Website address"), { target: { value: "localhost:3000" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(native.browserNavigate).toHaveBeenCalledWith("http://localhost:3000/", expect.any(Object)));
  });

  it("captures a selection and saves feedback without sending it, then explicitly inserts a draft", async () => {
    const p = props(); const view = render(<BrowserPanel {...p} />);
    act(() => events.selection?.(selection));
    expect(document.activeElement).toBe(screen.getByLabelText("Annotation feedback"));
    await waitFor(() => expect(screen.getByText("Screenshot captured")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Annotation feedback"), { target: { value: "Make this title smaller" } });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() => expect(p.onAddAnnotation).toHaveBeenCalledWith(expect.objectContaining({ selector: "#hero", comment: "Make this title smaller", screenshot: "/tmp/browser-capture.png" })));
    expect(native.browserFinishCapture).toHaveBeenCalledWith("/tmp/pending/browser-capture.png", true);
    expect(p.onInsert).not.toHaveBeenCalled();
    view.rerender(<BrowserPanel {...p} annotations={[p.onAddAnnotation.mock.calls[0][0]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add feedback to chat" }));
    expect(p.onInsert).toHaveBeenCalledWith(expect.stringContaining("My requested change: Make this title smaller"), ["/tmp/browser-capture.png"]);
    view.unmount();
    expect(native.browserFinishCapture).toHaveBeenCalledTimes(1);
  });

  it("releases a completed discard and a capture that finishes after the panel closes", async () => {
    const view = render(<BrowserPanel {...props()} />);
    act(() => events.selection?.(selection));
    await screen.findByText("Screenshot captured");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(native.browserFinishCapture).toHaveBeenCalledWith("/tmp/pending/browser-capture.png", false);

    let finishCapture: (path: string) => void = () => {};
    native.browserCapture.mockImplementationOnce(() => new Promise((resolve) => { finishCapture = resolve; }));
    act(() => events.selection?.(selection));
    view.unmount();
    expect(native.browserClose).toHaveBeenCalledTimes(1);
    await act(async () => { finishCapture("/tmp/pending/late.png"); });
    expect(native.browserFinishCapture).toHaveBeenLastCalledWith("/tmp/pending/late.png", false);
  });

  it("restores the last address after reopening", async () => {
    native.browserGetUrl.mockResolvedValueOnce("https://example.com/last-page");
    render(<BrowserPanel {...props()} />);
    await waitFor(() => expect(native.browserNavigate).toHaveBeenCalledWith(
      "https://example.com/last-page",
      expect.any(Object),
    ));
  });

  it("applies responsive sizes, device presets, and rotation before restoring the full viewport", async () => {
    const view = render(<BrowserPanel {...props()} />);
    const viewport = view.container.querySelector(".browser-viewport") as HTMLElement;
    const rectangle = vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 100, 600, 400));
    act(() => events.page?.({ url: "https://example.com/", loading: false }));
    fireEvent.click(await screen.findByRole("button", { name: "DevTools" }));
    expect(native.browserAction).toHaveBeenCalledWith("devtools");
    const device = screen.getByRole("button", { name: "Device" });
    fireEvent.click(device);
    const preset = screen.getByRole("combobox", { name: "Device preset" });
    const grip = screen.getByRole("button", { name: "Resize responsive viewport" });
    expect((preset as HTMLSelectElement).value).toBe("Responsive");
    fireEvent.keyDown(grip, { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(native.browserSetBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 400, y: 100, height: 380 }),
      { width: 440, height: 844, scale: 380 / 844 },
    ));
    fireEvent.change(preset, { target: { value: "Pixel 7" } });
    expect(screen.queryByRole("button", { name: "Resize responsive viewport" })).toBeNull();
    await waitFor(() => expect(native.browserSetBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 400 }),
      { width: 412, height: 915, scale: 400 / 915 },
    ));
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(native.browserSetBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 600 }),
      { width: 915, height: 412, scale: 600 / 915 },
    ));
    const width = screen.getByRole("spinbutton", { name: "Viewport width in pixels" });
    fireEvent.change(width, { target: { value: "720" } });
    fireEvent.blur(width);
    expect((preset as HTMLSelectElement).value).toBe("Responsive");
    await waitFor(() => expect(native.browserSetBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 580 }),
      { width: 720, height: 412, scale: 580 / 720 },
    ));
    fireEvent.click(device);
    await waitFor(() => expect(native.browserSetBounds).toHaveBeenLastCalledWith({ x: 400, y: 100, width: 600, height: 400 }));
    rectangle.mockRestore();
  });

  it("hides native page content when a dialog covers the panel", async () => {
    const p = props(); const view = render(<BrowserPanel {...p} />);
    act(() => events.page?.({ url: "https://example.com", loading: false }));
    view.rerender(<BrowserPanel {...p} visible={false} />);
    await waitFor(() => expect(native.browserSetVisible).toHaveBeenCalledWith(false));
    expect(native.browserClose).not.toHaveBeenCalled();
    const before = native.browserCapture.mock.calls.length;
    act(() => events.selection?.(selection));
    expect(native.browserCapture).toHaveBeenCalledTimes(before);
  });

  it("does not show the native page when a pending resize finishes after a dialog opens", async () => {
    let finishBounds: (() => void) | undefined;
    native.browserSetBounds.mockImplementationOnce(() => new Promise<void>((resolve) => { finishBounds = resolve; }));
    const p = props(); const view = render(<BrowserPanel {...p} />);
    const viewport = view.container.querySelector(".browser-viewport") as HTMLElement;
    const rectangle = vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(new DOMRect(400, 100, 600, 400));
    act(() => events.page?.({ url: "https://example.com/", loading: false }));
    await waitFor(() => expect(finishBounds).toBeDefined());
    view.rerender(<BrowserPanel {...p} visible={false} />);
    await waitFor(() => expect(native.browserSetVisible).toHaveBeenLastCalledWith(false));
    await act(async () => { finishBounds?.(); await Promise.resolve(); });
    expect(native.browserSetVisible.mock.calls.some(([visible]) => visible === true)).toBe(false);
    rectangle.mockRestore();
  });
});
