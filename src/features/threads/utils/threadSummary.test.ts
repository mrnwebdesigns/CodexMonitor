import { describe, expect, it } from "vitest";
import { buildThreadSummaryFromThread } from "./threadSummary";
describe("imported chat names", () => {
  const thread = { id: "history-1", name: "Client website review", preview: "First message text", source: "vscode" };
  it("uses the existing server-provided chat name", () => {
    expect(buildThreadSummaryFromThread({ workspaceId: "client-1", thread, fallbackIndex: 0 })?.name).toBe("Client website review");
  });
  it("keeps Monitor's explicit rename and falls back to preview for unnamed chats", () => {
    expect(buildThreadSummaryFromThread({ workspaceId: "client-1", thread, fallbackIndex: 0, getCustomName: () => "My name" })?.name).toBe("My name");
    expect(buildThreadSummaryFromThread({ workspaceId: "client-1", thread: { ...thread, name: null }, fallbackIndex: 0 })?.name).toBe("First message text");
  });
});
