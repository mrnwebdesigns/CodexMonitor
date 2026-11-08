// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { controlMessageSearch, getMessageSearchStatus } from "@services/tauri";
import { SearchStorageSection, formatStorageBytes } from "./SearchStorageSection";
import type { MessageSearchStatus } from "../messageSearchTypes";

vi.mock("@services/tauri", () => ({ getMessageSearchStatus: vi.fn(), controlMessageSearch: vi.fn() }));
const status: MessageSearchStatus = {
  phase: "indexing", paused: false, includeTools: false, threadsTotal: 100, threadsIndexed: 20,
  messageCount: 2000, toolCount: 0, indexBytes: 12 * 1024**2, reclaimableBytes: 1024**2,
  transcriptBytes: 18 * 1024**3, referencedTranscriptBytes: 8 * 1024**3, historyDatabaseBytes: 4 * 1024**3,
  diskFreeBytes: 80 * 1024**3, lastIndexedMs: null, lastInventoryMs: 1000, lastBatchMs: 70, warnings: [],
};
beforeEach(() => { vi.mocked(getMessageSearchStatus).mockResolvedValue(status); vi.mocked(controlMessageSearch).mockResolvedValue({ ...status, phase: "paused", paused: true, indexBytes: 8192 }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Search storage", () => {
  it("shows distinct disk categories and progress without implying history is purgeable", async () => {
    render(<SearchStorageSection />);
    await screen.findByText("20 / 100 chats indexed · 2,000 message records");
    expect(screen.getByText("12.0 MiB")).toBeTruthy();
    expect(screen.getByText("18.0 GiB")).toBeTruthy();
    expect(screen.getByText(/Neither action deletes chats/)).toBeTruthy();
    expect((screen.getByRole("progressbar") as HTMLProgressElement).value).toBe(20);
  });

  it("requires concrete confirmation before clearing and then reports paused", async () => {
    render(<SearchStorageSection />);
    await screen.findByText("Indexing in background");
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    expect(controlMessageSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/Clear the search index and pause indexing/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(controlMessageSearch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear index" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByRole("button", { name: "Resume indexing" });
    expect(controlMessageSearch).toHaveBeenCalledWith("clear");
  });

  it("surfaces low-space and coverage warnings", async () => {
    vi.mocked(getMessageSearchStatus).mockResolvedValue({ ...status, phase: "lowDisk", warnings: ["One transcript could not be read."] });
    render(<SearchStorageSection />);
    await screen.findByText("Waiting for disk space");
    expect(screen.getByText("One transcript could not be read.")).toBeTruthy();
    expect(screen.getByText(/resume automatically when at least 2 GiB/)).toBeTruthy();
  });

  it("handles maintenance failures without reporting successful cleanup", async () => {
    vi.mocked(controlMessageSearch).mockRejectedValue(new Error("locked"));
    render(<SearchStorageSection />);
    await screen.findByText("Indexing in background");
    fireEvent.click(screen.getByRole("button", { name: "Compact index" }));
    await waitFor(() => expect(screen.getByText(/Search maintenance failed/)).toBeTruthy());
    expect(screen.getByText("12.0 MiB")).toBeTruthy();
  });

  it("formats zero and large storage values", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(1024)).toBe("1.0 KiB");
    expect(formatStorageBytes(1024**4)).toBe("1.0 TiB");
  });
});
