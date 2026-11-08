// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserPageEvent, BrowserSelection } from "../browserTypes";
import { BrowserPanel } from "./BrowserPanel";

const native = vi.hoisted(() => ({
  browserNavigate: vi.fn().mockResolvedValue(undefined),
  browserGetUrl: vi.fn().mockResolvedValue(null),
  browserCapture: vi.fn().mockResolvedValue("/tmp/browser-capture.png"),
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
    await waitFor(() => expect(screen.getByText("Screenshot captured")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Annotation feedback"), { target: { value: "Make this title smaller" } });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    expect(p.onAddAnnotation).toHaveBeenCalledWith(expect.objectContaining({ selector: "#hero", comment: "Make this title smaller", screenshot: "/tmp/browser-capture.png" }));
    expect(p.onInsert).not.toHaveBeenCalled();
    view.rerender(<BrowserPanel {...p} annotations={[p.onAddAnnotation.mock.calls[0][0]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Add feedback to chat" }));
    expect(p.onInsert).toHaveBeenCalledWith(expect.stringContaining("My requested change: Make this title smaller"), ["/tmp/browser-capture.png"]);
  });

  it("hides native page content when a dialog covers the panel", async () => {
    const p = props(); const view = render(<BrowserPanel {...p} />);
    act(() => events.page?.({ url: "https://example.com", loading: false }));
    view.rerender(<BrowserPanel {...p} visible={false} />);
    await waitFor(() => expect(native.browserSetVisible).toHaveBeenCalledWith(false));
    const before = native.browserCapture.mock.calls.length;
    act(() => events.selection?.(selection));
    expect(native.browserCapture).toHaveBeenCalledTimes(before);
  });
});
