// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDebugLog } from "../hooks/useDebugLog";
import { DebugPanel } from "./DebugPanel";

afterEach(() => vi.unstubAllGlobals());

it("shows short diagnostics and previews large payloads while Copy keeps the recorded text", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const { result } = renderHook(() => useDebugLog());
  const longLine = "response ".repeat(250) + "end-of-long-line";
  const manyLines = "trace line\n".repeat(30) + "end-of-trace";

  act(() => {
    for (const [id, payload] of [
      ["short", "Connection refused"],
      ["long", longLine],
      ["trace", manyLines],
    ]) {
      result.current.addDebugEntry({ id, timestamp: 0, source: "error", label: id, payload });
    }
  });
  const { container } = render(
    <DebugPanel
      entries={result.current.debugEntries}
      isOpen
      onClear={result.current.clearDebugEntries}
      onCopy={result.current.handleCopyDebug}
    />,
  );

  const [short, long, trace] = container.querySelectorAll("pre");
  expect(short.textContent).toBe("Connection refused");
  expect(long.textContent).toContain("Use Copy for the full log.");
  expect(long.textContent).not.toContain("end-of-long-line");
  expect(trace.textContent).toContain("Use Copy for the full log.");
  expect(trace.textContent).not.toContain("end-of-trace");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining(longLine));
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining(manyLines));
});
