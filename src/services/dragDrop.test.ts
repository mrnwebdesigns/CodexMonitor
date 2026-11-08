/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, EventCallback } from "@tauri-apps/api/event";
import baseWindowConfig from "../../src-tauri/tauri.conf.json?raw";
import macWindowConfig from "../../src-tauri/tauri.macos.conf.json?raw";

type NativeListener = {
  name: string;
  target: { kind: string; label?: string };
  handler: EventCallback<unknown>;
};

it("lets WebKit receive Mac file promises while preserving the other window defaults", () => {
  type Config = { app: { windows: Record<string, unknown>[] } };
  const base = JSON.parse(baseWindowConfig) as Config;
  const mac = JSON.parse(macWindowConfig) as Config;
  expect(mac.app.windows).toEqual(base.app.windows.map((window) => ({ ...window, dragDropEnabled: false })));
  expect(base.app.windows[0].dragDropEnabled).toBe(true);
});

describe("native drag/drop event routing", () => {
  const registered: NativeListener[] = [];
  const unlisten = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    registered.length = 0;
    const callbacks = new Map<number, EventCallback<unknown>>();
    vi.stubGlobal("__TAURI_INTERNALS__", {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: (callback: EventCallback<unknown>) => {
        const id = callbacks.size + 1;
        callbacks.set(id, callback);
        return id;
      },
      invoke: async (command: string, args: { event: string; target: NativeListener["target"]; handler: number }) => {
        if (command === "plugin:event|listen") {
          registered.push({ name: args.event, target: args.target, handler: callbacks.get(args.handler)! });
          return args.handler;
        }
        if (command === "plugin:event|unlisten") {
          unlisten();
          return;
        }
        throw new Error(`Unexpected native command: ${command}`);
      },
    });
    vi.stubGlobal("__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  function emitDrop(source: "Window" | "Webview", label = "main") {
    for (const listener of registered) {
      if (
        listener.name === "tauri://drag-drop" && listener.target.label === label &&
        [source, "WebviewWindow"].includes(listener.target.kind)
      ) {
        listener.handler({ event: listener.name, id: 1, payload: {
          paths: ["/tmp/screenshot.png"], position: { x: 500, y: 300 },
        } } satisfies Event<unknown>);
      }
    }
  }

  it.each(["Window", "Webview"] as const)("receives %s drops for the app UI", async (source) => {
    const { subscribeWindowDragDrop } = await import("./dragDrop");
    const onDrop = vi.fn();
    const cleanup = subscribeWindowDragDrop(onDrop);
    await vi.waitFor(() => expect(registered).toHaveLength(4));
    emitDrop(source);
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payload: expect.objectContaining({
      type: "drop", paths: ["/tmp/screenshot.png"],
    }) }));
    cleanup();
    expect(unlisten).toHaveBeenCalledTimes(4);
  });

  it("shares the subscription and excludes the remote browser webview", async () => {
    const { subscribeWindowDragDrop } = await import("./dragDrop");
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeWindowDragDrop(first);
    const stopSecond = subscribeWindowDragDrop(second);
    await vi.waitFor(() => expect(registered).toHaveLength(4));
    emitDrop("Webview", "workspace-browser");
    expect(first).not.toHaveBeenCalled();
    emitDrop("Webview");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    expect(unlisten).not.toHaveBeenCalled();
    stopSecond();
    expect(unlisten).toHaveBeenCalledTimes(4);
  });
});
