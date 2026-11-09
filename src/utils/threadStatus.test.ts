import { describe, expect, it } from "vitest";

import {
  getThreadActivityState,
  getThreadStatusClass,
  getWorkspaceHomeThreadState,
} from "./threadStatus";

describe("threadStatus", () => {
  it("prioritizes pending user input over processing state", () => {
    expect(
      getThreadStatusClass(
        { isProcessing: true, hasUnread: false, isReviewing: false },
        true,
      ),
    ).toBe("unread");
    expect(
      getThreadActivityState(
        { isProcessing: true, hasUnread: false, isReviewing: false },
        true,
      ),
    ).toBe("waiting");
  });

  it("maps normal-list activity independently from review and unread state", () => {
    expect(getThreadActivityState({ isProcessing: true, isReviewing: true }, false)).toBe("running");
    expect(getThreadActivityState({ hasUnread: true }, false)).toBe("idle");
    expect(getThreadActivityState(undefined, false)).toBe("idle");
  });

  it("maps thread status to workspace home labels and classes", () => {
    expect(
      getWorkspaceHomeThreadState({
        isProcessing: true,
        hasUnread: false,
        isReviewing: false,
      }),
    ).toEqual({
      statusLabel: "Running",
      stateClass: "is-running",
      isRunning: true,
    });

    expect(
      getWorkspaceHomeThreadState({
        isProcessing: false,
        hasUnread: false,
        isReviewing: true,
      }),
    ).toEqual({
      statusLabel: "Reviewing",
      stateClass: "is-reviewing",
      isRunning: false,
    });

    expect(
      getWorkspaceHomeThreadState({
        isProcessing: false,
        hasUnread: false,
        isReviewing: false,
      }),
    ).toEqual({
      statusLabel: "Idle",
      stateClass: "is-idle",
      isRunning: false,
    });
  });

  it("keeps running state when processing and reviewing are both true", () => {
    expect(
      getWorkspaceHomeThreadState({
        isProcessing: true,
        hasUnread: false,
        isReviewing: true,
      }),
    ).toEqual({
      statusLabel: "Running",
      stateClass: "is-running",
      isRunning: true,
    });
  });
});
