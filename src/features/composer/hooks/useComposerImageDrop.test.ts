/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerImageDrop } from "./useComposerImageDrop";

let mockOnDragDropEvent:
  | ((event: {
      payload: {
        type: "enter" | "over" | "leave" | "drop";
        position: { x: number; y: number };
        paths?: string[];
      };
    }) => void)
  | null = null;

vi.mock("../../../services/dragDrop", () => ({
  subscribeWindowDragDrop: (handler: typeof mockOnDragDropEvent) => {
    mockOnDragDropEvent = handler;
    return () => {};
  },
}));

type HookResult = ReturnType<typeof useComposerImageDrop>;

type RenderedHook = {
  result: HookResult;
  unmount: () => void;
};

function renderImageDropHook(options: { disabled: boolean; onAttachImages?: (paths: string[]) => void }): RenderedHook {
  let result: HookResult | undefined;

  function Test() {
    result = useComposerImageDrop(options);
    return null;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(React.createElement(Test));
  });

  return {
    get result() {
      if (!result) {
        throw new Error("Hook not rendered");
      }
      return result;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function setMockFileReader() {
  const OriginalFileReader = window.FileReader;
  class MockFileReader {
    result: string | ArrayBuffer | null = null;
    onload: ((ev: ProgressEvent<FileReader>) => unknown) | null = null;
    onerror: ((ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(file: File) {
      this.result = `data:${file.type};base64,MOCK`;
      this.onload?.({} as ProgressEvent<FileReader>);
    }
  }
  window.FileReader = MockFileReader as typeof FileReader;
  return () => {
    window.FileReader = OriginalFileReader;
  };
}

describe("useComposerImageDrop", () => {
  beforeEach(() => {
    mockOnDragDropEvent = null;
    vi.stubGlobal("devicePixelRatio", 1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["drop", "paste"])("tracks a %s image until WebKit's file has finished reading", async (method) => {
    let finish!: () => void;
    class DelayedReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      readAsDataURL() { finish = () => { this.result = "data:image/png;base64,AA=="; this.onload?.(); }; }
    }
    vi.stubGlobal("FileReader", DelayedReader);
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const file = new File(["image"], "screenshot.png", { type: "image/png" });
    let drop!: Promise<void>;
    act(() => {
      drop = method === "drop" ? hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>) : hook.result.handlePaste({
        clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] },
        preventDefault: vi.fn(),
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });
    expect(hook.result.isImportingImages).toBe(true);
    expect(onAttachImages).not.toHaveBeenCalled();
    await act(async () => { finish(); await drop; });
    expect(hook.result.isImportingImages).toBe(false);
    expect(onAttachImages).toHaveBeenCalledWith(["data:image/png;base64,AA=="]);
    hook.unmount();
  });

  it("reports an unreadable dropped image and finishes its import state", async () => {
    class FailedReader {
      onerror: (() => void) | null = null;
      readAsDataURL() { this.onerror?.(); }
    }
    vi.stubGlobal("FileReader", FailedReader);
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [new File(["image"], "screenshot.png", { type: "image/png" })], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();
    expect(hook.result.isImportingImages).toBe(false);
    expect(hook.result.imageDropError).toContain("could not be read");
    hook.unmount();
  });

  it("accepts a native image drop over the conversation above the composer", () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const pane = document.createElement("div");
    pane.setAttribute("data-composer-drop-scope", "");
    pane.getBoundingClientRect = () =>
      ({ left: 200, top: 50, right: 800, bottom: 700 } as DOMRect);
    const input = document.createElement("div");
    input.getBoundingClientRect = () =>
      ({ left: 200, top: 600, right: 800, bottom: 700 } as DOMRect);
    pane.appendChild(input);
    hook.result.dropTargetRef.current = input;

    act(() => {
      mockOnDragDropEvent?.({
        payload: { type: "drop", position: { x: 400, y: 250 }, paths: ["/tmp/photo.png"] },
      });
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/photo.png"]);
    hook.unmount();
  });

  it("normalizes native physical positions without waiting for a DOM drag event", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const input = document.createElement("div");
    input.getBoundingClientRect = () =>
      ({ left: 200, top: 400, right: 600, bottom: 600 } as DOMRect);
    hook.result.dropTargetRef.current = input;

    act(() => {
      mockOnDragDropEvent?.({
        payload: { type: "drop", position: { x: 800, y: 1000 }, paths: ["/tmp/photo.png"] },
      });
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/photo.png"]);
    hook.unmount();
  });

  it("keeps macOS Retina drops in logical points and ignores sidebar drops", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const input = document.createElement("div");
    input.getBoundingClientRect = () =>
      ({ left: 200, top: 400, right: 600, bottom: 600 } as DOMRect);
    hook.result.dropTargetRef.current = input;

    act(() => {
      mockOnDragDropEvent?.({
        payload: { type: "drop", position: { x: 400, y: 500 }, paths: ["/tmp/photo.png"] },
      });
      mockOnDragDropEvent?.({
        payload: { type: "drop", position: { x: 100, y: 500 }, paths: ["/tmp/sidebar.png"] },
      });
    });

    expect(onAttachImages).toHaveBeenCalledExactlyOnceWith(["/tmp/photo.png"]);
    hook.unmount();
  });

  it("does not attach to a hidden conversation", () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const hidden = document.createElement("div");
    hidden.setAttribute("inert", "");
    const input = document.createElement("div");
    input.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 600, bottom: 600 } as DOMRect);
    hidden.appendChild(input);
    hook.result.dropTargetRef.current = input;

    act(() => {
      mockOnDragDropEvent?.({
        payload: { type: "drop", position: { x: 300, y: 300 }, paths: ["/tmp/photo.png"] },
      });
    });

    expect(onAttachImages).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("tracks drag over state for file transfers", () => {
    const hook = renderImageDropHook({ disabled: false });
    const preventDefault = vi.fn();

    act(() => {
      hook.result.handleDragOver({
        dataTransfer: { types: ["Files"] },
        preventDefault,
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(hook.result.isDragOver).toBe(true);

    act(() => {
      hook.result.handleDragLeave();
    });

    expect(hook.result.isDragOver).toBe(false);

    hook.unmount();
  });

  it("uses file paths on drop when available", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const file = new File(["data"], "photo.png", { type: "image/png" });
    (file as File & { path?: string }).path = "/tmp/photo.png";

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/photo.png"]);

    hook.unmount();
  });

  it("reads image data URLs when paths are missing", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const file = new File(["data"], "photo.jpg", { type: "image/jpeg" });

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [file], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });

    expect(onAttachImages).toHaveBeenCalledWith([
      "data:image/jpeg;base64,MOCK",
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("accepts a PNG filename when a drag source omits its MIME type", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [new File(["image"], "screenshot.png")], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(onAttachImages).toHaveBeenCalledWith(["data:image/png;base64,MOCK"]);
    hook.unmount();
    restoreFileReader();
  });

  it("handles pasted image items", async () => {
    const restoreFileReader = setMockFileReader();
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });
    const preventDefault = vi.fn();

    const file = new File(["data"], "paste.png", { type: "image/png" });
    const item = {
      type: "image/png",
      getAsFile: () => file,
    };

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [item] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });

    expect(preventDefault).toHaveBeenCalled();
    expect(onAttachImages).toHaveBeenCalledWith([
      "data:image/png;base64,MOCK",
    ]);

    hook.unmount();
    restoreFileReader();
  });

  it("filters tauri drag-drop paths and respects drop target", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const target = document.createElement("div");
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
    hook.result.dropTargetRef.current = target;

    Object.defineProperty(window, "devicePixelRatio", {
      value: 2,
      configurable: true,
    });

    await act(async () => {
      await Promise.resolve();
    });

    if (!mockOnDragDropEvent) {
      throw new Error("Drag drop handler not registered");
    }

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "over",
          position: { x: 40, y: 40 },
          paths: [],
        },
      });
    });

    expect(hook.result.isDragOver).toBe(true);

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "drop",
          position: { x: 40, y: 40 },
          paths: [" /tmp/photo.png ", "/tmp/note.txt"],
        },
      });
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/photo.png"]);

    hook.unmount();
  });

  it("accepts heic paths from tauri drag-drop", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: false, onAttachImages });

    const target = document.createElement("div");
    target.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100 } as DOMRect);
    hook.result.dropTargetRef.current = target;

    await act(async () => {
      await Promise.resolve();
    });

    if (!mockOnDragDropEvent) {
      throw new Error("Drag drop handler not registered");
    }

    act(() => {
      mockOnDragDropEvent?.({
        payload: {
          type: "drop",
          position: { x: 40, y: 40 },
          paths: ["/tmp/screenshot.heic"],
        },
      });
    });

    expect(onAttachImages).toHaveBeenCalledWith(["/tmp/screenshot.heic"]);

    hook.unmount();
  });

  it("ignores drag/drop and paste when disabled", async () => {
    const onAttachImages = vi.fn();
    const hook = renderImageDropHook({ disabled: true, onAttachImages });
    const preventDefault = vi.fn();

    act(() => {
      hook.result.handleDragOver({
        dataTransfer: { types: ["Files"] },
        preventDefault,
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(hook.result.isDragOver).toBe(false);

    await act(async () => {
      await hook.result.handleDrop({
        dataTransfer: { files: [], items: [] },
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent<HTMLElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();

    await act(async () => {
      await hook.result.handlePaste({
        clipboardData: { items: [] },
        preventDefault,
      } as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
    });
    expect(onAttachImages).not.toHaveBeenCalled();

    hook.unmount();
  });
});
