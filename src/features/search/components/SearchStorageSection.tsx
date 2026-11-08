import { useState } from "react";
import { useSearchStorage } from "../hooks/useSearchStorage";
import type { MessageSearchAction } from "../messageSearchTypes";
import "@/styles/message-search.css";

export function formatStorageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)) - 1);
  return `${(bytes / 1024 ** (exponent + 1)).toFixed(1)} ${units[exponent]}`;
}

const phases = { starting: "Starting", indexing: "Indexing in background", ready: "Up to date", paused: "Paused", lowDisk: "Waiting for disk space", stalled: "Worker needs attention" };
const confirmations: Partial<Record<MessageSearchAction, string>> = {
  clear: "Clear the search index and pause indexing? Chats and transcripts are preserved. Resume later to rebuild it.",
  rebuild: "Rebuild the search index? Message results will be incomplete while history is indexed again. Chats are preserved.",
  enableTools: "Rebuild including tool output? This uses more disk space and indexing time. Tool results can contain sensitive content already present in your local transcripts.",
  disableTools: "Rebuild using messages only and remove indexed tool output? Chats and source logs are preserved.",
};

export function SearchStorageSection() {
  const { status, error, busy, refresh, control } = useSearchStorage();
  const [confirmation, setConfirmation] = useState<MessageSearchAction | null>(null);
  const request = (action: MessageSearchAction) => {
    if (confirmations[action]) setConfirmation(action);
    else void control(action);
  };
  return <section className="home-usage search-storage" aria-label="Search and storage">
    <div className="home-section-header">
      <h2 className="home-section-title">Search &amp; storage</h2>
      <button className="ghost" type="button" onClick={() => void refresh()} disabled={busy}>Refresh storage</button>
    </div>
    {error && <p role="status" className="home-usage-error">{error}</p>}
    {!status && !error && <p className="home-section-meta">Loading local storage…</p>}
    {status && <>
      <div className="search-storage-status" role="status">
        <strong>{phases[status.phase]}</strong>
        <span>{status.threadsIndexed.toLocaleString()} / {status.threadsTotal.toLocaleString()} chats indexed · {status.messageCount.toLocaleString()} message records</span>
      </div>
      <progress aria-label="Chats indexed" max={Math.max(1, status.threadsTotal)} value={status.threadsIndexed} />
      <div className="home-usage-grid">
        {[
          ["Search index", status.indexBytes, "Safe to clear and rebuild"],
          ["Transcript files", status.transcriptBytes, "File sizes, including retained history"],
          ["History databases", status.historyDatabaseBytes, "Chat data; preserved by cleanup"],
          ["Free disk space", status.diskFreeBytes, "Indexing stops below 2 GiB free"],
        ].map(([label, bytes, caption]) => <div className="home-usage-card is-compact" key={label as string}>
          <div className="home-usage-label">{label}</div>
          <div className="home-usage-number">{formatStorageBytes(bytes as number)}</div>
          <div className="home-usage-caption">{caption}</div>
        </div>)}
      </div>
      <p className="home-section-meta">{formatStorageBytes(status.referencedTranscriptBytes)} in currently referenced transcript segments. File sizes are logical sizes; cloned files may share disk blocks.</p>
      <p className="home-section-meta">{status.includeTools ? `Messages and tool output · ${status.toolCount.toLocaleString()} tool records` : "Messages and assistant replies only"}. {formatStorageBytes(status.reclaimableBytes)} in reusable index pages.</p>
      {status.lastInventoryMs && <p className="home-section-meta">Storage checked {new Date(status.lastInventoryMs).toLocaleTimeString()}{status.lastBatchMs !== null ? ` · Last indexing batch ${status.lastBatchMs} ms` : ""}.</p>}
      {status.warnings.map((warning) => <p className="home-usage-error" key={warning}>{warning}</p>)}
      {status.phase === "lowDisk" && <p className="home-usage-error">Indexing will resume automatically when at least 2 GiB is free. Clear the index to recover its space.</p>}
      {status.phase === "stalled" && <p className="home-usage-error">Indexing has stopped reporting progress. Try resuming or restarting Monitor; rebuild if the index needs recovery.</p>}
      <div className="search-storage-actions">
        <button className="secondary" disabled={busy} onClick={() => request(status.paused ? "resume" : "pause")}>{status.paused ? "Resume indexing" : "Pause indexing"}</button>
        <button className="secondary" disabled={busy} onClick={() => request("compact")}>Compact index</button>
        <button className="secondary" disabled={busy} onClick={() => request("rebuild")}>Rebuild index</button>
        <button className="secondary" disabled={busy} onClick={() => request("clear")}>Clear index</button>
        <button className="ghost" disabled={busy} onClick={() => request(status.includeTools ? "disableTools" : "enableTools")}>{status.includeTools ? "Stop indexing tool output" : "Index tool output…"}</button>
      </div>
      {confirmation && <div className="search-storage-confirm" role="group" aria-label="Confirm search maintenance">
        <p>{confirmations[confirmation]}</p>
        <button className="secondary" disabled={busy} onClick={() => { const action = confirmation; setConfirmation(null); void control(action); }}>Confirm</button>
        <button className="ghost" onClick={() => setConfirmation(null)}>Cancel</button>
      </div>}
      {busy && <p role="status" className="home-section-meta">Updating the search index…</p>}
      <p className="home-section-meta">Clear frees the search cache and pauses indexing. Compact reclaims unused index pages. Neither action deletes chats, transcripts, imports, or backups. All search data stays on the connected host.</p>
    </>}
  </section>;
}
