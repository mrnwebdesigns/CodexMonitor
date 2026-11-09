import { useCallback, useEffect, useState } from "react";
import { subscribeBrowserSessionActivated } from "@services/events";
import type { BrowserAnnotation } from "../browserTypes";

const STORAGE_KEY = "codex-monitor.browser.annotations.v1";
const MAX_ANNOTATIONS = 40;

function readSaved(): Record<string, BrowserAnnotation[]> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

export function useBrowserPanel(activeThreadId: string | null) {
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeBrowserSessionActivated(({ threadId }) => {
    if (threadId === activeThreadId) setOpen(true);
  }), [activeThreadId]);
  const [navigationRequest, setNavigationRequest] = useState<{ workspaceId: string; threadId: string; id: string; url: string } | null>(null);
  const clearNavigationRequest = useCallback((id: string) => {
    setNavigationRequest((current) => current?.id === id ? null : current);
  }, []);
  const openWebsite = useCallback((workspaceId: string, threadId: string, url: string) => {
    setNavigationRequest({ workspaceId, threadId, url, id: crypto.randomUUID() });
    setOpen(true);
  }, []);
  const [annotationsByThread, setAnnotations] = useState(readSaved);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(annotationsByThread)); }
    catch { /* Keep feedback in memory if local storage is full. */ }
  }, [annotationsByThread]);
  const addAnnotation = useCallback((threadId: string, annotation: BrowserAnnotation) => {
    setAnnotations((current) => ({ ...current, [threadId]: [...(current[threadId] || []), annotation].slice(-MAX_ANNOTATIONS) }));
  }, []);
  const removeAnnotation = useCallback((threadId: string, id: string) => {
    setAnnotations((current) => ({ ...current, [threadId]: (current[threadId] || []).filter((item) => item.id !== id) }));
  }, []);
  return { open, setOpen, navigationRequest, clearNavigationRequest, openWebsite, annotationsByThread, addAnnotation, removeAnnotation };
}
