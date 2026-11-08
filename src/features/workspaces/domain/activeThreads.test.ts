import { describe, expect, it } from "vitest";
import type { ThreadSummary, WorkspaceInfo } from "@/types";
import { ACTIVE_THREAD_WINDOW_MS, activeThreadKey, buildActiveThreads, getActiveThreads } from "./activeThreads";

const now = 2_000_000_000_000;
const project = (id: string, extra: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  id, name: id, path: `/tmp/${id}`, connected: true, settings: { sidebarCollapsed: false }, ...extra,
});
const root = project("client");
const select = (threads: ThreadSummary[], statuses = {}) => getActiveThreads(
  buildActiveThreads([root], [root], { client: threads }, statuses), now, new Map(), new Map(),
);

describe("active threads", () => {
  it("carries unread state without treating a finished thread as running or bypassing recent limits", () => {
    const chats = Array.from({ length: 8 }, (_, i) => ({ id: `chat-${i}`, name: `Chat ${i}`, updatedAt: now - i }));
    const rows = select(chats, { "chat-0": { hasUnread: true }, "chat-7": { hasUnread: true } });
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ status: "Recent", hasUnread: true });
    expect(rows[1].hasUnread).toBe(false);
  });

  it("shows every running/reviewing chat before six recent chats, including multiple chats in one project", () => {
    const chats = Array.from({ length: 10 }, (_, i) => ({ id: `chat-${i}`, name: `Chat ${i}`, updatedAt: now - i }));
    chats[8].updatedAt = now - ACTIVE_THREAD_WINDOW_MS - 1;
    chats[9].updatedAt = 1;
    const rows = select(chats, { "chat-8": { isReviewing: true }, "chat-9": { isProcessing: true } });
    expect(rows.map((row) => row.thread.id)).toEqual(["chat-8", "chat-9", ...chats.slice(0, 6).map((chat) => chat.id)]);
    expect(rows.map((row) => row.status).slice(0, 2)).toEqual(["Reviewing", "Running"]);
    expect(rows.every((row) => row.projectName === "client")).toBe(true);
    expect(chats[0].id).toBe("chat-0");
  });

  it("uses the owning project label and actual worktree/clone for navigation, without duplicate imported threads", () => {
    const clone = project("clone", { path: "/tmp/client/clone", settings: { sidebarCollapsed: false, cloneSourceWorkspaceId: root.id } });
    const tree = project("tree", { path: "/tmp/client/clone/tree", kind: "worktree", parentId: clone.id });
    const chat = { id: "task", name: "Task", updatedAt: now };
    const rows = buildActiveThreads([root, clone, tree], [root], { client: [chat], tree: [chat, chat] }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: "tree", projectId: "client", projectName: "client", thread: chat });
  });

  it("excludes hidden project families and hidden chats even when they are running", () => {
    const hidden = project("hidden");
    const tree = project("tree", { kind: "worktree", parentId: hidden.id });
    const rows = buildActiveThreads([root, hidden, tree], [root], {
      tree: [{ id: "private-task", name: "Private", updatedAt: now }],
      client: [{ id: "archived", name: "Archived", updatedAt: now }],
    }, { "private-task": { isProcessing: true }, archived: { isProcessing: true } }, (_, id) => id === "archived");
    expect(rows).toEqual([]);
  });

  it("expires idle chats after seven days while keeping running chats with old or missing timestamps", () => {
    const chats = [
      { id: "boundary", name: "Boundary", updatedAt: now - ACTIVE_THREAD_WINDOW_MS },
      { id: "stale", name: "Stale", updatedAt: now - ACTIVE_THREAD_WINDOW_MS - 1 },
      { id: "invalid", name: "Invalid", updatedAt: Number.NaN },
      { id: "running", name: "Running", updatedAt: 0 },
    ];
    expect(select(chats, { running: { isProcessing: true } }).map((row) => row.thread.id)).toEqual(["running", "boundary"]);
  });

  it("dismisses only the matching chat, fills recent slots, and honors existing project dismissals", () => {
    const chats = Array.from({ length: 8 }, (_, i) => ({ id: `chat-${i}`, name: `Chat ${i}`, updatedAt: now - i }));
    const rows = buildActiveThreads([root], [root], { client: chats }, {});
    const removed = new Map([[activeThreadKey("client", "chat-0"), now]]);
    expect(getActiveThreads(rows, now, removed, new Map()).map((row) => row.thread.id)).toEqual(chats.slice(1, 7).map((chat) => chat.id));
    expect(getActiveThreads(rows, now, new Map(), new Map([["client", now - 1]])).map((row) => row.thread.id)).toEqual(["chat-0"]);
  });
});
