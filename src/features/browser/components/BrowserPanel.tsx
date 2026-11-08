import { useCallback, useEffect, useRef, useState } from "react";
import { PanelFrame, PanelHeader } from "@/features/design-system/components/panel/PanelPrimitives";
import { browserAction, browserCapture, browserGetUrl, browserNavigate, browserSetBounds, browserSetVisible } from "@services/tauri";
import { subscribeBrowserPage, subscribeBrowserSelection } from "@services/events";
import type { BrowserAnnotation, BrowserSelection } from "../browserTypes";
import { formatBrowserAnnotations, normalizeBrowserUrl } from "../utils/browserAnnotations";

export type BrowserPanelProps = {
  workspaceId: string;
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

export function BrowserPanel({ workspaceId, navigationRequest, onNavigationHandled, annotations, visible, canInsert, onAddAnnotation, onRemoveAnnotation, onInsert, onClose }: BrowserPanelProps) {
  const [address, setAddress] = useState("");
  const [pageTitle, setPageTitle] = useState("Browser");
  const [hasPage, setHasPage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  const [selection, setSelection] = useState<BrowserSelection | null>(null);
  const [comment, setComment] = useState("");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const navigationRequested = useRef(Boolean(navigationRequest));
  const annotationWorkspace = useRef(workspaceId);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Native web content has its own view; keep its rectangle aligned with this slot.
  const syncBounds = useCallback(async () => {
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect || !visibleRef.current || rect.width < 80 || rect.height < 80) {
      await browserSetVisible(false);
      return;
    }
    await browserSetBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
    await browserSetVisible(true);
  }, []);

  useEffect(() => {
    if (annotationWorkspace.current !== workspaceId) {
      annotationWorkspace.current = workspaceId;
      setSelection(null); setComment(""); setScreenshot(null); setAnnotating(false);
      void browserAction("browse").catch(() => {});
    }
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    void browserGetUrl().then((url) => { if (live && url && !navigationRequested.current) { setAddress(url); setHasPage(true); } }).catch(() => {});
    const unsubscribePage = subscribeBrowserPage((event) => {
      setAddress(event.url); setHasPage(true); setLoading(event.loading);
      if (event.title) setPageTitle(event.title);
      setAnnotating(false);
    });
    const unsubscribeSelection = subscribeBrowserSelection((event) => {
      if (!visibleRef.current) return;
      setSelection(event); setComment(""); setScreenshot(null); setAnnotating(false);
      const selectedWorkspace = annotationWorkspace.current;
      setCapturing(true);
      void browserCapture().then((path) => {
        if (selectedWorkspace === annotationWorkspace.current) setScreenshot(path);
      }).catch(() => {
        setError("Screenshot unavailable. You can still save the element and your feedback.");
      }).finally(() => setCapturing(false));
    });
    return () => { live = false; unsubscribePage(); unsubscribeSelection(); };
  }, []);

  useEffect(() => {
    if (!hasPage || !visible) { void browserSetVisible(false).catch(() => {}); return; }
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { void syncBounds().catch((reason) => setError(String(reason))); }); };
    const observer = new ResizeObserver(update);
    if (viewport.current) observer.observe(viewport.current);
    window.addEventListener("resize", update);
    window.addEventListener("transitionend", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("transitionend", update); cancelAnimationFrame(frame); void browserSetVisible(false).catch(() => {}); };
  }, [hasPage, visible, syncBounds]);

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
      setError(null); setLoading(true); setSelection(null); setAnnotating(false);
      await browserNavigate(url, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      setAddress(url); setHasPage(true);
    } catch (reason) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); }
  }, []);
  const handledRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !navigationRequest || handledRequest.current === navigationRequest.id) return;
    handledRequest.current = navigationRequest.id;
    navigationRequested.current = true;
    onNavigationHandled?.(navigationRequest.id);
    void navigateTo(navigationRequest.url);
  }, [navigationRequest, visible, navigateTo, onNavigationHandled]);

  const act = async (action: Parameters<typeof browserAction>[0]) => {
    try { setError(null); await browserAction(action); setAnnotating(action === "annotate"); }
    catch (reason) { setError(String(reason)); }
  };

  const saveAnnotation = () => {
    if (!selection || !comment.trim() || capturing) return;
    onAddAnnotation({ ...selection, id: crypto.randomUUID(), comment: comment.trim(), screenshot });
    setSelection(null); setComment(""); setScreenshot(null);
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
        <button type="submit" className="secondary">Go</button>
      </form>
      <div className="browser-tools">
        <button type="button" className={`secondary${annotating ? " is-active" : ""}`} disabled={!hasPage || loading} aria-pressed={annotating} onClick={() => void act(annotating ? "browse" : "annotate")}>{annotating ? "Cancel selection" : "Annotate"}</button>
        <span>{annotating ? "Click an element on the page. Esc cancels." : "Browse, select an element, then describe the change."}</span>
      </div>
      <div className="browser-viewport" ref={viewport}>
        {!hasPage && <div className="browser-empty"><strong>Your website, beside your chat</strong><p>Enter a live, staging, or local address above. Use Annotate to attach precise feedback to your conversation.</p></div>}
      </div>
      {error && <p className="browser-error" role="alert">{error}</p>}
      {selection && <div className="browser-selection">
        <div className="browser-selection-meta"><strong>{selection.selector || selection.tag}</strong><span>{capturing ? "Capturing screenshot…" : screenshot ? "Screenshot captured" : "Element selected"}</span></div>
        {selection.text && <p className="browser-selected-text">{selection.text}</p>}
        <textarea aria-label="Annotation feedback" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What should change here?" rows={2} maxLength={8000} />
        <div className="browser-feedback-actions"><button type="button" className="secondary" disabled={!comment.trim() || capturing} onClick={saveAnnotation}>Save annotation</button><button type="button" className="ghost" onClick={() => setSelection(null)}>Discard</button></div>
      </div>}
      {annotations.length > 0 && <div className="browser-annotations">
        <div className="browser-feedback-actions"><strong>Feedback · {annotations.length}</strong><button type="button" className="secondary" disabled={!canInsert} onClick={() => onInsert(formatBrowserAnnotations(annotations), annotations.flatMap((item) => item.screenshot ? [item.screenshot] : []))}>Add feedback to chat</button></div>
        <ol>{annotations.map((item) => <li key={item.id}><div><span className="browser-annotation-comment">{item.comment}</span><small title={item.url}>{item.selector} · {new URL(item.url).hostname}</small></div><button type="button" className="ghost" aria-label={`Remove annotation: ${item.comment}`} onClick={() => onRemoveAnnotation(item.id)}>×</button></li>)}</ol>
        {!canInsert && <p>Select a chat to attach this feedback.</p>}
      </div>}
    </PanelFrame>
  );
}
