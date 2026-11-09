import type { DebugEntry } from "../types";

type DebugLogger = (entry: DebugEntry) => void;

type SoundLabel = "success" | "error" | "test";

type AudioContextConstructor = new () => AudioContext;

function resolveAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }

  return (window.AudioContext ??
    (
      window as typeof window & {
        webkitAudioContext?: AudioContextConstructor;
      }
    ).webkitAudioContext ??
    null);
}

function createAudioContext(): AudioContext {
  const AudioContextImpl = resolveAudioContextConstructor();
  if (!AudioContextImpl) {
    throw new Error("Web Audio API is not available in this environment");
  }

  return new AudioContextImpl();
}

function reportAudioError(
  label: SoundLabel,
  phase: "init" | "load-or-play",
  error: unknown,
  onDebug?: DebugLogger,
) {
  onDebug?.({
    id: `${Date.now()}-audio-${label}-${phase}-error`,
    timestamp: Date.now(),
    source: "error",
    label: `audio/${label} ${phase === "init" ? "init" : "load/play"} error`,
    payload: error instanceof Error ? error.message : String(error),
  });
}

async function closeAudioContext(ctx: AudioContext) {
  if (ctx.state !== "closed") {
    await ctx.close();
  }
}

export function playNotificationSound(
  url: string,
  label: SoundLabel,
  onDebug?: DebugLogger,
) {
  let ctx: AudioContext;
  try {
    ctx = createAudioContext();
  } catch (error) {
    reportAudioError(label, "init", error, onDebug);
    return;
  }

  void (async () => {
    let source: AudioBufferSourceNode | null = null;
    let gainNode: GainNode | null = null;

    try {
      if (ctx.state === "suspended") {
        await ctx.resume();
      }

      const response = await fetch(url);
      const audioFileBuffer = await response.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(audioFileBuffer);
      source = ctx.createBufferSource();
      gainNode = ctx.createGain();

      gainNode.gain.value = 0.05;
      source.buffer = audioBuffer;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      await new Promise<void>((resolve, reject) => {
        source!.onended = () => resolve();
        try {
          source!.start();
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reportAudioError(label, "load-or-play", error, onDebug);
    } finally {
      try {
        source?.disconnect();
      } catch {}
      try {
        gainNode?.disconnect();
      } catch {}
      await closeAudioContext(ctx).catch(() => {});
    }
  })();
}
