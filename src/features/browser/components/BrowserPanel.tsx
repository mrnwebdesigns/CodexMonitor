import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import MoveDiagonal from "lucide-react/dist/esm/icons/move-diagonal";
import { PanelFrame, PanelHeader } from "@/features/design-system/components/panel/PanelPrimitives";
import { browserAction, browserFind, browserGetUrl, browserNavigate, browserRuntimeInfo, browserSetBounds, browserSetVisible, browserStopFind } from "@services/tauri";
import { subscribeBrowserFindOpen, subscribeBrowserFindResult, subscribeBrowserPage, subscribeBrowserSelection } from "@services/events";
import type { BrowserAnnotation, BrowserSelection } from "../browserTypes";
import { useBrowserCaptureDraft } from "../hooks/useBrowserCaptureDraft";
import { formatBrowserAnnotations, normalizeBrowserUrl } from "../utils/browserAnnotations";
import {
  BrowserDeviceControls, MAX_DIMENSION, MIN_DIMENSION, RESPONSIVE,
  type DeviceSettings, type DeviceSize,
} from "./BrowserDeviceControls";

const RESIZE_GRIP_SIZE = 20;

function clampDimension(value: number) {
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(value)));
}

function measureViewport(rect: DOMRect, device: DeviceSettings | null) {
  const { x, y, width, height } = rect;
  if (!device) return { bounds: { x, y, width, height }, device: undefined };
  const { size, preset } = device;
  const responsive = preset === RESPONSIVE;
  const gutter = responsive ? RESIZE_GRIP_SIZE : 0;
  const scale = Math.min(1, (width - gutter) / size.width, (height - gutter) / size.height);
  const viewWidth = size.width * scale;
  const viewHeight = size.height * scale;
  return {
    bounds: {
      x: responsive ? x : x + (width - viewWidth) / 2,
      y: responsive ? y : y + (height - viewHeight) / 2,
      width: viewWidth,
      height: viewHeight,
    },
    device: { ...size, scale },
  };
}

export type BrowserPanelProps = {
  workspaceId: string;
  threadId: string;
  navigationRequest?: { id: string; url: string } | null;
  onNavigationHandled?: (id: string) => void;
  annotations: BrowserAnnotation[];
  visible: boolean;
  canInsert: boolean;
  onAddAnnotation: (annotation: BrowserAnnotation) => void;
  onRemoveAnnotation: (id: string) => void;
  onInsert: (text: string, screenshots: string[]) => void;
  onClose: () => void;
};

export function BrowserPanel({ workspaceId, threadId, navigationRequest, onNavigationHandled, annotations, visible, canInsert, onAddAnnotation, onRemoveAnnotation, onInsert, onClose }: BrowserPanelProps) {
  const [address, setAddress] = useState("");
  const [restoreUrl, setRestoreUrl] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState("Browser");
  const [hasPage, setHasPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResult, setFindResult] = useState<{ active: number; total: number } | null>(null);
  const [selection, setSelection] = useState<BrowserSelection | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { screenshot, capturing, capture, discard, keep } = useBrowserCaptureDraft(threadId, setError);
  const [runtime, setRuntime] = useState<{ engine: string; version: string } | null>(null);
  const [deviceEnabled, setDeviceEnabled] = useState(false);
  const [deviceSettings, setDeviceSettings] = useState<DeviceSettings>({
    preset: RESPONSIVE,
    size: { width: 390, height: 844 },
  });
  const device = deviceEnabled ? deviceSettings : null;
  const responsive = device?.preset === RESPONSIVE;
  const chromiumControls = runtime?.engine.startsWith("Chromium");
  const viewport = useRef<HTMLDivElement>(null);
  const resizeGrip = useRef<HTMLButtonElement>(null);
  const resizeStart = useRef<{ pointerId: number; x: number; y: number; scale: number; size: DeviceSize } | null>(null);
  const deviceRef = useRef(device);
  const scheduleBounds = useRef<(() => void) | null>(null);
  const feedback = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const navigationRequested = useRef(Boolean(navigationRequest));
  const pageUrl = useRef<string | null>(null);
  const annotationWorkspace = useRef(workspaceId);
  const visibleRef = useRef(visible);
  const layoutRevision = useRef(0);
  visibleRef.current = visible;
  // Native web content has its own view; keep its rectangle aligned with this slot.
  const syncBounds = useCallback(async () => {
    const revision = layoutRevision.current;
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || !visibleRef.current || rect.width < 80 || rect.height < 80) {
      await browserSetVisible(threadId, false);
      return;
    }
    const { bounds, device: emulation } = measureViewport(rect, deviceRef.current);
    if (resizeGrip.current) {
      resizeGrip.current.style.transform = `translate(${bounds.width}px, ${bounds.height}px)`;
    }
    if (emulation) await browserSetBounds(threadId, bounds, emulation);
    else await browserSetBounds(threadId, bounds);
    if (revision !== layoutRevision.current || !visibleRef.current) return;
    await browserSetVisible(threadId, true);
  }, [threadId]);

  useLayoutEffect(() => {
    deviceRef.current = device;
    scheduleBounds.current?.();
  }, [device]);

  useLayoutEffect(() => {
    if (selection && visibleRef.current) feedback.current?.focus({ preventScroll: true });
  }, [selection]);

  const openFind = useCallback(() => {
    if (!hasPage || !visibleRef.current) return;
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInput.current?.focus({ preventScroll: true });
      findInput.current?.select();
    });
  }, [hasPage]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindResult(null);
    void browserStopFind(threadId).catch((reason) => setError(String(reason)));
  }, [threadId]);

  const runFind = useCallback((query: string, forward: boolean, findNext: boolean) => {
    void browserFind(threadId, query, forward, findNext).catch((reason) => setError(String(reason)));
  }, [threadId]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!visible || !hasPage || event.key.toLowerCase() !== "f" || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
      event.preventDefault();
      openFind();
    };
    window.addEventListener("keydown", handleShortcut);
    const unsubscribeOpen = subscribeBrowserFindOpen((event) => {
      if (event.threadId === threadId && visibleRef.current) openFind();
    });
    const unsubscribeResult = subscribeBrowserFindResult((event) => {
      if (event.threadId === threadId) setFindResult({ active: event.activeMatch, total: event.totalMatches });
    });
    return () => {
      window.removeEventListener("keydown", handleShortcut);
      unsubscribeOpen();
      unsubscribeResult();
    };
  }, [hasPage, openFind, threadId, visible]);

  useEffect(() => () => { void browserStopFind(threadId).catch(() => {}); }, [threadId]);

  useEffect(() => {
    if (annotationWorkspace.current !== workspaceId) {
      annotationWorkspace.current = workspaceId;
      discard();
      setSelection(null); setComment(""); setAnnotating(false);
      void browserAction(threadId, "browse").catch(() => {});
    }
  }, [discard, workspaceId]);

  useEffect(() => {
    let live = true;
    void browserRuntimeInfo().then((value) => { if (live) setRuntime(value); }).catch(() => {});
    navigationRequested.current = Boolean(navigationRequest);
    pageUrl.current = null;
    setHasPage(false);
    setRestoreUrl(null);
    void browserGetUrl(threadId).then((url) => {
      if (live && url && !navigationRequested.current) setRestoreUrl(url);
    }).catch(() => {});
    const unsubscribePage = subscribeBrowserPage((event) => {
      if (event.threadId !== threadId) return;
      if (event.url !== pageUrl.current) {
        pageUrl.current = event.url;
        discard();
        setSelection(null);
      }
      setAddress(event.url); setHasPage(true); setLoading(event.loading);
      if (event.title) setPageTitle(event.title);
      if (event.error) { setError(event.error); setLoading(false); }
      setAnnotating(false);
    });
    const unsubscribeSelection = subscribeBrowserSelection((event) => {
      if (event.threadId !== threadId || !visibleRef.current) return;
      setSelection(event); setComment(""); setAnnotating(false);
      capture();
    });
    return () => {
      live = false;
      unsubscribePage();
      unsubscribeSelection();
      void browserSetVisible(threadId, false).catch(() => {});
    };
  }, [capture, discard, navigationRequest, threadId]);

  useEffect(() => {
    if (!hasPage || !visible) { void browserSetVisible(threadId, false).catch(() => {}); return; }
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { void syncBounds().catch((reason) => setError(String(reason))); }); };
    scheduleBounds.current = update;
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener("resize", update);
    window.addEventListener("transitionend", update);
    update();
    return () => {
      layoutRevision.current += 1;
      scheduleBounds.current = null;
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("transitionend", update);
      cancelAnimationFrame(frame);
      void browserSetVisible(threadId, false).catch(() => {});
    };
  }, [hasPage, visible, syncBounds, threadId]);

  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => { setLoading(false); setError("This page is taking a while to load. Try Reload or check its address."); }, 30000);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const navigateTo = useCallback(async (value: string) => {
    try {
      const url = normalizeBrowserUrl(value);
      navigationRequested.current = true;
      const rect = viewport.current?.getBoundingClientRect();
      if (!rect) return;
      discard();
      setError(null); setLoading(true); setSelection(null); setAnnotating(false);
      const { bounds, device: emulation } = measureViewport(rect, device);
      if (emulation) await browserNavigate(threadId, url, bounds, emulation);
      else await browserNavigate(threadId, url, bounds);
      setAddress(url); setHasPage(true);
    } catch (reason) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [device, discard, threadId]);
  const handledRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !navigationRequest || handledRequest.current === navigationRequest.id) return;
    handledRequest.current = navigationRequest.id;
    navigationRequested.current = true;
    onNavigationHandled?.(navigationRequest.id);
    void navigateTo(navigationRequest.url);
  }, [navigationRequest, visible, navigateTo, onNavigationHandled]);
  useEffect(() => {
    if (!visible || !restoreUrl || navigationRequested.current) return;
    setRestoreUrl(null);
    void navigateTo(restoreUrl);
  }, [navigateTo, restoreUrl, visible]);

  const act = async (action: Parameters<typeof browserAction>[1]) => {
    try { setError(null); await browserAction(threadId, action); setAnnotating(action === "annotate"); }
    catch (reason) { setError(String(reason)); }
  };

  const resizeDevice = (width: number, height: number) => {
    const size = { width: clampDimension(width), height: clampDimension(height) };
    if (size.width !== deviceSettings.size.width || size.height !== deviceSettings.size.height) {
      setDeviceSettings({ preset: RESPONSIVE, size });
    }
  };

  const startResize = (event: PointerEvent<HTMLButtonElement>) => {
    const rect = viewport.current?.getBoundingClientRect();
    if (event.button !== 0 || !rect) return;
    const { device: emulation } = measureViewport(rect, device);
    if (!emulation || emulation.scale <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      size: deviceSettings.size, scale: emulation.scale,
    };
  };

  const dragResize = (event: PointerEvent<HTMLButtonElement>) => {
    const start = resizeStart.current;
    if (start?.pointerId !== event.pointerId) return;
    resizeDevice(
      start.size.width + (event.clientX - start.x) / start.scale,
      start.size.height + (event.clientY - start.y) / start.scale,
    );
  };

  const saveAnnotation = async () => {
    if (!selection || !comment.trim() || capturing) return;
    setSelection(null); setComment("");
    const savedScreenshot = await keep();
    onAddAnnotation({ ...selection, id: crypto.randomUUID(), comment: comment.trim(), screenshot: savedScreenshot });
  };

  return (
    <PanelFrame className="browser-panel">
      <PanelHeader>
        <strong className="browser-title" title={pageTitle}>{pageTitle}</strong>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close browser">Close</button>
      </PanelHeader>
      <form className="browser-address-bar" onSubmit={(event) => { event.preventDefault(); void navigateTo(address); }}>
        <button type="button" className="ghost" disabled={!hasPage} aria-label="Back" onClick={() => void act("back")}>←</button>
        <button type="button" className="ghost" disabled={!hasPage} aria-label="Forward" onClick={() => void act("forward")}>→</button>
        <button type="button" className="ghost" disabled={!hasPage} aria-label={loading ? "Stop loading" : "Reload"} onClick={() => void act(loading ? "stop" : "reload")}>{loading ? "×" : "↻"}</button>
        <input aria-label="Website address" placeholder="Website or localhost:3000" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} autoComplete="off" />
        <button type="button" className="ghost" disabled={!hasPage} aria-label="Find in page" title="Find in page (⌘F)" onClick={openFind}>⌕</button>
        <button type="submit" className="secondary">Go</button>
      </form>
      {findOpen && <form
        className="browser-find-bar"
        role="search"
        onSubmit={(event) => { event.preventDefault(); if (findQuery) runFind(findQuery, true, true); }}
      >
        <input
          ref={findInput}
          aria-label="Find on page"
          placeholder="Find"
          value={findQuery}
          onChange={(event) => { setFindQuery(event.target.value); setFindResult(null); runFind(event.target.value, true, false); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); closeFind(); }
            else if (event.key === "Enter" && event.shiftKey && findQuery) {
              event.preventDefault();
              runFind(findQuery, false, true);
            }
          }}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="browser-find-count" aria-live="polite">
          {findQuery && findResult ? `${findResult.active} of ${findResult.total}` : ""}
        </span>
        <button type="button" className="ghost" aria-label="Previous match" disabled={!findQuery} onClick={() => runFind(findQuery, false, true)}>↑</button>
        <button type="button" className="ghost" aria-label="Next match" disabled={!findQuery} onClick={() => runFind(findQuery, true, true)}>↓</button>
        <button type="button" className="ghost" aria-label="Close find" onClick={closeFind}>×</button>
      </form>}
      <div className="browser-tools">
        {runtime && <span className="browser-engine" aria-label="Browser engine" title={runtime.version || undefined}>{runtime.engine}</span>}
        {chromiumControls && <>
          <button
            type="button"
            className={`secondary${deviceEnabled ? " is-active" : ""}`}
            aria-pressed={deviceEnabled}
            onClick={() => setDeviceEnabled(!deviceEnabled)}
          >
            Device
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!hasPage}
            onClick={() => {
              setError(null);
              void browserAction(threadId, "devtools").catch((reason) => setError(String(reason)));
            }}
          >
            DevTools
          </button>
        </>}
        <button type="button" className={`secondary${annotating ? " is-active" : ""}`} disabled={!hasPage || loading} aria-pressed={annotating} onClick={() => void act(annotating ? "browse" : "annotate")}>{annotating ? "Cancel selection" : "Annotate"}</button>
        <span>{annotating ? "Click an element on the page. Esc cancels." : "Browse, select an element, then describe the change."}</span>
      </div>
      {device && <BrowserDeviceControls settings={device} onChange={setDeviceSettings} />}
      <div className={`browser-viewport${device ? " browser-viewport-device" : ""}`} ref={viewport}>
        {!hasPage && <div className="browser-empty"><strong>Your website, beside your chat</strong><p>Enter a live, staging, or local address above. Use Annotate to attach precise feedback to your conversation.</p></div>}
        {responsive && hasPage && (
          <button
            ref={resizeGrip}
            type="button"
            className="ghost browser-resize-grip"
            aria-label="Resize responsive viewport"
            title="Drag to resize or use the arrow keys"
            onPointerDown={startResize}
            onPointerMove={dragResize}
            onLostPointerCapture={() => { resizeStart.current = null; }}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 50 : 10;
              const { width, height } = deviceSettings.size;
              switch (event.key) {
                case "ArrowLeft": resizeDevice(width - step, height); break;
                case "ArrowRight": resizeDevice(width + step, height); break;
                case "ArrowUp": resizeDevice(width, height - step); break;
                case "ArrowDown": resizeDevice(width, height + step); break;
                default: return;
              }
              event.preventDefault();
            }}
          >
            <MoveDiagonal size={13} aria-hidden />
          </button>
        )}
      </div>
      {error && <p className="browser-error" role="alert">{error}</p>}
      {selection && <div className="browser-selection">
        <div className="browser-selection-meta"><strong>{selection.selector || selection.tag}</strong><span>{capturing ? "Capturing screenshot…" : screenshot ? "Screenshot captured" : "Element selected"}</span></div>
        {selection.text && <p className="browser-selected-text">{selection.text}</p>}
        <textarea ref={feedback} aria-label="Annotation feedback" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What should change here?" rows={2} maxLength={8000} />
        <div className="browser-feedback-actions"><button type="button" className="secondary" disabled={!comment.trim() || capturing} onClick={() => void saveAnnotation()}>Save annotation</button><button type="button" className="ghost" onClick={() => { discard(); setSelection(null); }}>Discard</button></div>
      </div>}
      {annotations.length > 0 && <div className="browser-annotations">
        <div className="browser-feedback-actions"><strong>Feedback · {annotations.length}</strong><button type="button" className="secondary" disabled={!canInsert} onClick={() => onInsert(formatBrowserAnnotations(annotations), annotations.flatMap((item) => item.screenshot ? [item.screenshot] : []))}>Add feedback to chat</button></div>
        <ol>{annotations.map((item) => <li key={item.id}><div><span className="browser-annotation-comment">{item.comment}</span><small title={item.url}>{item.selector} · {new URL(item.url).hostname}</small></div><button type="button" className="ghost" aria-label={`Remove annotation: ${item.comment}`} onClick={() => onRemoveAnnotation(item.id)}>×</button></li>)}</ol>
        {!canInsert && <p>Select a chat to attach this feedback.</p>}
      </div>}
    </PanelFrame>
  );
}
