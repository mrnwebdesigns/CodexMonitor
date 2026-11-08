import Globe from "lucide-react/dist/esm/icons/globe";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import type { ProjectInfo, ProjectType, WorkspaceInfo } from "@/types";
import { PanelHeader } from "@/features/design-system/components/panel/PanelPrimitives";
import { normalizeBrowserUrl } from "@/features/browser/utils/browserAnnotations";
import { projectTypeLabels, useProjectInfo } from "../hooks/useProjectInfo";

const connectionFields = [
  { key: "hosting", label: "Hosted", placeholder: "Hosting provider, such as SiteGround or Kinsta" },
  { key: "ssh", label: "SSH", placeholder: "SSH alias or host" },
  { key: "localHub", label: "Local Hub", placeholder: "Local site or runtime status" },
  { key: "mainwp", label: "MainWP", placeholder: "WordPress connection status" },
] as const;

type Props = {
  workspace: WorkspaceInfo;
  onSave: (id: string, info: ProjectInfo) => Promise<unknown>;
  onOpenWebsite?: (url: string) => void;
};

export function ProjectInfoCard({ workspace, onSave, onOpenWebsite }: Props) {
  const state = useProjectInfo(workspace, onSave);
  let website: string | null = null;
  try { if (state.info.website) website = normalizeBrowserUrl(state.info.website); } catch { /* Invalid draft URLs are validated on save. */ }
  const hasInfo = Object.values(state.info).some((value) => typeof value === "string" && value.trim()) || Boolean(state.info.discovery);
  const busy = state.saving || state.discovering;
  const detectedType = state.info.discovery?.projectType.value as ProjectType | undefined;
  const typeLabel = projectTypeLabels[state.info.projectType || detectedType || ""] || "Unknown";
  const discovery = state.info.discovery;
  return <section className="project-info" aria-label="Project information">
    <PanelHeader className="project-info-header">
      <div><h2>Project information</h2><p>The details you want close at hand.</p></div>
      <div className="project-info-header-actions">
        <button type="button" className="ghost project-info-edit" disabled={busy} onClick={() => void state.discover()}><RefreshCw aria-hidden />{state.discovering ? "Discovering…" : "Discover connections"}</button>
        {!state.editing && <button type="button" className="ghost project-info-edit" onClick={state.edit}><Pencil aria-hidden />{hasInfo ? "Edit details" : "Add details"}</button>}
      </div>
    </PanelHeader>
    <p className="project-info-discovery-status" role="status">{state.discovering ? "Checking project details and connections…" : discovery ? `Last discovered ${new Date(discovery.checkedAt).toLocaleString()}${discovery.website ? ` · ${discovery.website}` : ""}` : "Discover connections checks local configuration and refreshes MainWP status for WordPress sites."}</p>
    {state.editing ? <form className="project-info-form" onSubmit={(event) => { event.preventDefault(); void state.save(); }}>
      <fieldset disabled={busy}>
        <div className="project-info-fields">
          <label>Client / owner<input value={state.info.client} maxLength={200} onChange={(event) => state.change("client", event.target.value)} placeholder="Client or internal team" /></label>
          <label>Website<input value={state.info.website} maxLength={2048} onChange={(event) => state.change("website", event.target.value)} placeholder="example.com or localhost:3000" spellCheck={false} autoCapitalize="none" /></label>
          <label>Project type<select aria-label="Project type" value={state.info.projectType} onChange={(event) => state.change("projectType", event.target.value)}>
            <option value="">{detectedType ? `Automatic (${projectTypeLabels[detectedType] || "Unknown"})` : "Automatic / unknown"}</option>
            <option value="wordpress">WordPress</option><option value="mac-app">Mac app</option><option value="web-app">Web app</option><option value="other">Other</option>
          </select><small>{state.info.projectType ? "Selected project type" : discovery?.projectType.detail}</small></label>
          {connectionFields.map(({ key, label, placeholder }) => <label key={key}>{label}<input aria-label={label} aria-describedby={`project-${workspace.id}-${key}-hint`} value={state.info[key]} maxLength={500} onChange={(event) => state.change(key, event.target.value)} placeholder={discovery?.[key].value || placeholder} spellCheck={false} /><small id={`project-${workspace.id}-${key}-hint`}>{state.info[key] ? "Saved override; clear to use discovery" : discovery?.[key].detail || "Not checked"}</small></label>)}
          <label className="project-info-wide">Overview<textarea rows={2} maxLength={4000} value={state.info.summary} onChange={(event) => state.change("summary", event.target.value)} placeholder="What this project is for and what matters most." /></label>
          <label className="project-info-wide">Working notes<textarea rows={4} maxLength={12000} value={state.info.notes} onChange={(event) => state.change("notes", event.target.value)} placeholder="Next steps, important links, and things to remember." /></label>
        </div>
        {state.error && <p className="workspace-home-error" role="alert">{state.error}</p>}
        <div className="project-info-form-actions"><span>Notes are for your reference; agent instructions are below.</span><button type="button" className="ghost" onClick={state.cancel}>Cancel</button><button type="submit" className="primary">{state.saving ? "Saving…" : "Save details"}</button></div>
      </fieldset>
    </form> : <div className="project-info-content">
      {!hasInfo && <p className="project-info-empty">Add a project overview, website, and working notes so everything is ready when you return.</p>}
      <dl className="project-info-connections">
        <div><dt>Project type</dt><dd>{typeLabel}<p>{state.info.projectType ? "Selected project type" : discovery?.projectType.detail || "Not discovered yet"}</p></dd></div>
        {connectionFields.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{state.info[key] || discovery?.[key].value || "Unknown"}<p>{state.info[key] ? "Saved value" : discovery?.[key].detail || "Not checked"}</p></dd></div>)}
      </dl>
      {state.info.client && <div className="project-info-client"><span>Client / owner</span><strong>{state.info.client}</strong></div>}
      {state.info.summary && <p className="project-info-summary">{state.info.summary}</p>}
      {website && (onOpenWebsite ? <button type="button" className="secondary project-website-link" onClick={() => onOpenWebsite(website)}><Globe aria-hidden />Open website in Browser<span>{new URL(website).host}</span></button> : <p className="project-info-summary">{website}</p>)}
      {state.info.notes && <div className="project-info-notes"><h3>Working notes</h3><p>{state.info.notes}</p></div>}
    </div>}
  </section>;
}
