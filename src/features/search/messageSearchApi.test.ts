import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { controlMessageSearch, getMessageSearchStatus, searchMessages } from "@services/tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("Message search IPC contracts", () => {
  it("uses explicit visible workspaces and excludes tools by default", async () => {
    await searchMessages("achelios.com", ["client"]);
    expect(invoke).toHaveBeenCalledWith("search_messages", { query: "achelios.com", workspaceIds: ["client"], includeTools: false });
  });
  it("has a separate status endpoint", async () => {
    await getMessageSearchStatus();
    expect(invoke).toHaveBeenCalledWith("message_search_status");
  });
  it("scopes clear to the search index action", async () => {
    await controlMessageSearch("clear");
    expect(invoke).toHaveBeenCalledWith("message_search_control", { action: "clear" });
  });
});
