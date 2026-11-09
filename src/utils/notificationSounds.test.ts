// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockAudioContextState = "running" | "suspended" | "closed";

describe("playNotificationSound", () => {
  const originalAudioContext = window.AudioContext;
  const originalWebkitAudioContext = (
    window as typeof window & { webkitAudioContext?: typeof AudioContext }
  ).webkitAudioContext;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    window.AudioContext = originalAudioContext;
    (
      window as typeof window & { webkitAudioContext?: typeof AudioContext }
    ).webkitAudioContext = originalWebkitAudioContext;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function installAudioMocks(state: MockAudioContextState = "running") {
    const contexts: MockAudioContext[] = [];
    const source = {
      buffer: null as AudioBuffer | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      onended: null as (() => void) | null,
    };
    const gainNode = {
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
    const resume = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockImplementation(async function (this: {
      state: MockAudioContextState;
    }) {
      this.state = "closed";
    });

    class MockAudioContext {
      state = state;
      destination = {} as AudioNode;
      decodeAudioData = decodeAudioData;
      createBufferSource = vi.fn(() => source);
      createGain = vi.fn(() => gainNode);
      resume = resume;
      close = close;

      constructor() {
        contexts.push(this);
      }
    }

    window.AudioContext = MockAudioContext as unknown as typeof AudioContext;

    return { close, contexts, decodeAudioData, gainNode, source, resume };
  }

  it("plays notification audio via Web Audio API", async () => {
    const { close, decodeAudioData, gainNode, source } = installAudioMocks("running");
    const arrayBuffer = new ArrayBuffer(8);
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(arrayBuffer),
    } as unknown as Response);

    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/success.mp3", "success");
    await vi.waitFor(() => {
      expect(source.start).toHaveBeenCalledTimes(1);
    });

    expect(globalThis.fetch).toHaveBeenCalledWith("https://example.com/success.mp3");
    expect(decodeAudioData).toHaveBeenCalledWith(arrayBuffer);
    expect(gainNode.gain.value).toBe(0.05);
    expect(close).not.toHaveBeenCalled();

    source.onended?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(source.disconnect).toHaveBeenCalledTimes(1);
    expect(gainNode.disconnect).toHaveBeenCalledTimes(1);
  });

  it("logs debug information when fetch fails", async () => {
    const { close } = installAudioMocks("running");
    const onDebug = vi.fn();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network"));
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/fail.mp3", "error", onDebug);

    await vi.waitFor(() => {
      expect(onDebug).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "audio/error load/play error",
          payload: "network",
        }),
      );
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("attempts to resume suspended contexts before playback", async () => {
    const { close, resume, source } = installAudioMocks("suspended");
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    } as unknown as Response);
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/test.mp3", "test");

    expect(resume).toHaveBeenCalledTimes(1);
    expect(source.start).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(source.start).toHaveBeenCalledTimes(1);
    });
    source.onended?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  it("closes the audio context when decoding fails", async () => {
    const { close, decodeAudioData } = installAudioMocks("running");
    const onDebug = vi.fn();
    decodeAudioData.mockRejectedValue(new Error("decode"));
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    } as unknown as Response);
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/test.mp3", "test", onDebug);

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "audio/test load/play error",
        payload: "decode",
      }),
    );
  });

  it("closes the audio context when resume fails", async () => {
    const { close, resume, source } = installAudioMocks("suspended");
    const onDebug = vi.fn();
    resume.mockRejectedValue(new Error("resume"));
    globalThis.fetch = vi.fn();
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/test.mp3", "test", onDebug);

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(source.start).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "audio/test load/play error",
        payload: "resume",
      }),
    );
  });

  it("closes the audio context when playback cannot start", async () => {
    const { close, source } = installAudioMocks("running");
    const onDebug = vi.fn();
    source.start.mockImplementation(() => {
      throw new Error("start");
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    } as unknown as Response);
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/test.mp3", "test", onDebug);

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(onDebug).toHaveBeenCalledWith(
      expect.objectContaining({
        label: "audio/test load/play error",
        payload: "start",
      }),
    );
  });

  it("uses a fresh context after a completed notification", async () => {
    const { close, contexts, source } = installAudioMocks("running");
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    } as unknown as Response);
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/success.mp3", "success");
    await vi.waitFor(() => {
      expect(source.start).toHaveBeenCalledTimes(1);
    });
    source.onended?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });

    playNotificationSound("https://example.com/error.mp3", "error");
    await vi.waitFor(() => {
      expect(source.start).toHaveBeenCalledTimes(2);
    });
    source.onended?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(2);
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).not.toBe(contexts[1]);
  });

  it("cleans up overlapping notifications independently", async () => {
    const sources: Array<{
      buffer: AudioBuffer | null;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      onended: (() => void) | null;
    }> = [];
    const close = vi.fn().mockResolvedValue(undefined);

    class MockAudioContext {
      state: MockAudioContextState = "running";
      destination = {} as AudioNode;
      close = close;
      resume = vi.fn().mockResolvedValue(undefined);
      decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
      createGain = vi.fn(() => ({
        gain: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }));
      createBufferSource = vi.fn(() => {
        const source = {
          buffer: null as AudioBuffer | null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(source);
        return source;
      });
    }

    window.AudioContext = MockAudioContext as unknown as typeof AudioContext;
    globalThis.fetch = vi.fn().mockResolvedValue({
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
    } as unknown as Response);
    const { playNotificationSound } = await import("./notificationSounds");

    playNotificationSound("https://example.com/success.mp3", "success");
    playNotificationSound("https://example.com/error.mp3", "error");
    await vi.waitFor(() => {
      expect(sources).toHaveLength(2);
      expect(sources[0].start).toHaveBeenCalledTimes(1);
      expect(sources[1].start).toHaveBeenCalledTimes(1);
    });

    sources[0].onended?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    sources[1].onended?.();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(2);
    });
    expect(sources[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sources[1].disconnect).toHaveBeenCalledTimes(1);
  });
});
