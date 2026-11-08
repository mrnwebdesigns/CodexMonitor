import { useEffect, useRef, useState } from "react";
import type { ProjectDiscovery, ProjectInfo, ProjectType, WorkspaceInfo } from "@/types";
import { normalizeBrowserUrl } from "@/features/browser/utils/browserAnnotations";
import { discoverProject } from "@services/tauri";

const STORAGE_KEY = "codexmonitor.projectInfoDrafts.v1";
type EditableInfo = Required<Omit<ProjectInfo, "discovery">> & Pick<ProjectInfo, "discovery">;
const emptyInfo: EditableInfo = { client: "", summary: "", website: "", notes: "", projectType: "", hosting: "", ssh: "", localHub: "", mainwp: "" };
export const projectTypeLabels: Record<ProjectType, string> = { "": "Unknown", wordpress: "WordPress", "mac-app": "Mac app", "web-app": "Web app", other: "Other" };
function normalizeInfo(value: unknown): EditableInfo {
  const info = { ...emptyInfo };
  if (!value || typeof value !== "object") return info;
  const source = value as Record<string, unknown>;
  for (const key of ["client", "summary", "website", "notes", "hosting", "ssh", "localHub", "mainwp"] as const) {
    if (typeof source[key] === "string") info[key] = source[key];
  }
  if (typeof source.projectType === "string" && Object.prototype.hasOwnProperty.call(projectTypeLabels, source.projectType)) info.projectType = source.projectType as ProjectType;
  const discovery = source.discovery as ProjectDiscovery | undefined;
  if (discovery && typeof discovery.checkedAt === "number" && typeof discovery.website === "string" &&
    (["projectType", "hosting", "ssh", "localHub", "mainwp"] as const).every((key) => typeof discovery[key]?.value === "string" && typeof discovery[key]?.detail === "string")) info.discovery = discovery;
  return info;
}
function readDrafts(): Record<string, EditableInfo> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value)).map(([id, value]) => [id, normalizeInfo(value)]));
  } catch { return {}; }
}

export function useProjectInfo(workspace: WorkspaceInfo, onSave: (id: string, info: ProjectInfo) => Promise<unknown>) {
  const [drafts, setDrafts] = useState<Record<string, EditableInfo>>(readDrafts);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [discoveringIds, setDiscoveringIds] = useState<Set<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const saved = normalizeInfo(workspace.settings.projectInfo);
  const draft = drafts[workspace.id];
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts)); } catch { /* Keep drafts in memory if storage is unavailable. */ }
  }, [drafts]);
  const cancel = (id = workspace.id) => {
    setDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
    setErrors((current) => ({ ...current, [id]: null }));
  };
  const save = async () => {
    if (!draft || savingIds.has(workspace.id) || inFlight.current.has(workspace.id)) return;
    const id = workspace.id;
    setSavingIds((current) => new Set(current).add(id));
    setErrors((current) => ({ ...current, [id]: null }));
    try {
      const info: ProjectInfo = { ...draft, client: draft.client.trim(), summary: draft.summary.trim(), website: draft.website.trim() ? normalizeBrowserUrl(draft.website) : "", notes: draft.notes.trim(), hosting: draft.hosting.trim(), ssh: draft.ssh.trim(), localHub: draft.localHub.trim(), mainwp: draft.mainwp.trim() };
      await onSave(id, info);
      cancel(id);
    } catch (reason) {
      setErrors((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setSavingIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  };
  const discover = async () => {
    const id = workspace.id;
    if (inFlight.current.has(id) || savingIds.has(id)) return;
    inFlight.current.add(id);
    setDiscoveringIds((current) => new Set(current).add(id));
    setErrors((current) => ({ ...current, [id]: null }));
    const info = draft ?? saved;
    setDrafts((current) => ({ ...current, [id]: current[id] ?? info }));
    try {
      const website = info.website.trim() ? normalizeBrowserUrl(info.website) : "";
      const discovery = await discoverProject(id, website, info.projectType);
      setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? info), discovery, website: (current[id] ?? info).website || discovery.website } }));
    } catch (reason) {
      setErrors((current) => ({ ...current, [id]: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      inFlight.current.delete(id);
      setDiscoveringIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  };
  return {
    info: draft ?? saved,
    editing: Boolean(draft),
    saving: savingIds.has(workspace.id),
    discovering: discoveringIds.has(workspace.id),
    error: errors[workspace.id] ?? null,
    edit: () => setDrafts((current) => ({ ...current, [workspace.id]: { ...saved } })),
    change: (key: Exclude<keyof ProjectInfo, "discovery">, value: string) => setDrafts((current) => ({ ...current, [workspace.id]: { ...(current[workspace.id] ?? saved), [key]: value, ...((key === "website" || key === "projectType") ? { discovery: null } : {}) } })),
    cancel: () => cancel(),
    save,
    discover,
  };
}
