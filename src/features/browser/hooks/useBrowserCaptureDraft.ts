import { useCallback, useEffect, useRef, useState } from "react";
import { browserCapture, browserFinishCapture } from "@services/tauri";

function releaseCapture(path: string) {
  void browserFinishCapture(path, false).catch(() => {});
}

export function useBrowserCaptureDraft(threadId: string, onError: (message: string) => void) {
  const current = useRef<{ path: string | null } | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  const releaseDraft = useCallback(() => {
    const path = current.current?.path;
    current.current = null;
    if (path) releaseCapture(path);
  }, []);

  useEffect(() => releaseDraft, [releaseDraft]);

  const discard = useCallback(() => {
    releaseDraft();
    setScreenshot(null);
    setCapturing(false);
  }, [releaseDraft]);

  const capture = useCallback(() => {
    discard();
    const draft = { path: null as string | null };
    current.current = draft;
    setCapturing(true);
    void browserCapture(threadId).then((path) => {
      if (current.current !== draft) {
        releaseCapture(path);
        return;
      }
      draft.path = path;
      setScreenshot(path);
    }).catch(() => {
      if (current.current === draft) {
        onError("Screenshot unavailable. You can still save the element and your feedback.");
      }
    }).finally(() => {
      if (current.current === draft) setCapturing(false);
    });
  }, [discard, onError, threadId]);

  const keep = async () => {
    const path = current.current?.path;
    current.current = null;
    setScreenshot(null);
    if (!path) return null;
    try {
      return await browserFinishCapture(path, true);
    } catch {
      releaseCapture(path);
      onError("Screenshot unavailable. The annotation was saved without it.");
      return null;
    }
  };

  return { screenshot, capturing, capture, discard, keep };
}
