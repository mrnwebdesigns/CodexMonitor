import { useCallback, useEffect, useState } from "react";
import type { BrowserAnnotation } from "../browserTypes";

const STORAGE_KEY = "codex-monitor.browser.annotations.v1";
const MAX_ANNOTATIONS = 40;

function readSaved(): Record<string, BrowserAnnotation[]> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); }
  catch { return {}; }
}

export function useBrowserPanel() {
  const [open, setOpen] = useState(false);
  const [navigationRequest, setNavigationRequest] = useState<{ workspaceId: string; id: string; url: string } | null>(null);
  const clearNavigationRequest = useCallback((id: string) => {
    setNavigationRequest((current) => current?.id === id ? null : current);
  }, []);
  const openWebsite = useCallback((workspaceId: string, url: string) => {
    setNavigationRequest({ workspaceId, url, id: crypto.randomUUID() });
    setOpen(true);
  }, []);
  const [annotationsByWorkspace, setAnnotations] = useState(readSaved);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(annotationsByWorkspace)); }
    catch { /* Keep feedback in memory if local storage is full. */ }
  }, [annotationsByWorkspace]);
  const addAnnotation = useCallback((workspaceId: string, annotation: BrowserAnnotation) => {
    setAnnotations((current) => ({ ...current, [workspaceId]: [...(current[workspaceId] || []), annotation].slice(-MAX_ANNOTATIONS) }));
  }, []);
  const removeAnnotation = useCallback((workspaceId: string, id: string) => {
    setAnnotations((current) => ({ ...current, [workspaceId]: (current[workspaceId] || []).filter((item) => item.id !== id) }));
  }, []);
  return { open, setOpen, navigationRequest, clearNavigationRequest, openWebsite, annotationsByWorkspace, addAnnotation, removeAnnotation };
}
