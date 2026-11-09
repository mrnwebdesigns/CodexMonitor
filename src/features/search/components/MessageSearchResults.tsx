import { useMemo, useState, type ReactNode } from "react";
import type { WorkspaceInfo } from "@/types";
import { useMessageSearch } from "../hooks/useMessageSearch";
import "@/styles/message-search.css";

type Props = {
  query: string;
  workspaces: WorkspaceInfo[];
  isThreadHidden?: (workspaceId: string, threadId: string) => boolean;
  onSelectThread: (workspaceId: string, threadId: string) => void;
};

function highlightSearchTerm(text: string, query: string): ReactNode {
  const term = query.trim();
  if (!term) {
    return text;
  }

  const normalizedText = text.toLocaleLowerCase();
  const normalizedTerm = term.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = normalizedText.indexOf(normalizedTerm);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    parts.push(
      <span className="message-search-match" key={`${matchIndex}-${cursor}`}>
        {text.slice(matchIndex, matchIndex + term.length)}
      </span>,
    );
    cursor = matchIndex + term.length;
    matchIndex = normalizedText.indexOf(normalizedTerm, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.length ? parts : text;
}

export function MessageSearchResults({ query, workspaces, isThreadHidden, onSelectThread }: Props) {
  const [includeTools, setIncludeTools] = useState(false);
  const search = useMessageSearch(query, workspaces.map((workspace) => workspace.id), includeTools);
  const results = search.results.filter((result) => workspaces.some((workspace) => workspace.id === result.workspaceId) && !isThreadHidden?.(result.workspaceId, result.threadId));
  const highlightedResults = useMemo(() => results.map((result) => ({
    ...result,
    highlightedTitle: highlightSearchTerm(result.title, query),
    highlightedExcerpt: highlightSearchTerm(result.excerpt, query),
  })), [query, results]);
  return <section className="message-search" aria-label="Message search results">
    <div className="sidebar-section-header">
      <span className="sidebar-section-title">Inside conversations</span>
      <span className="sidebar-section-count">{search.loading ? "Searching…" : results.length === 50 ? "50+" : results.length}</span>
    </div>
    <label className="message-search-tools">
      <input type="checkbox" checked={includeTools} onChange={(event) => setIncludeTools(event.target.checked)} />
      Include indexed tool output
    </label>
    {query.trim().length < 3 && <p className="message-search-note">Type at least 3 characters to search message text.</p>}
    {query.trim().length > 256 && <p className="message-search-note">Use 256 characters or fewer.</p>}
    {search.error && <p className="message-search-note" role="status">{search.error}</p>}
    {search.status && search.status.phase !== "ready" && <p className="message-search-note" role="status">
      {search.status.paused ? "Indexing is paused." : "Indexing is incomplete."} Results cover {search.status.threadsIndexed.toLocaleString()} of {search.status.threadsTotal.toLocaleString()} chats. Manage on Home.
    </p>}
    {includeTools && search.status && !search.status.includeTools && <p className="message-search-note">Tool output is not indexed. Enable it in Search & storage on Home.</p>}
    {search.status?.warnings.map((warning) => <p className="message-search-note" key={warning}>{warning}</p>)}
    {highlightedResults.map((result) => <button type="button" key={`${result.workspaceId}:${result.threadId}`} className="ghost message-search-result" onClick={() => onSelectThread(result.workspaceId, result.threadId)}>
      <span className="message-search-project">{workspaces.find((workspace) => workspace.id === result.workspaceId)?.name}{result.category === "tool" ? " · Tool output" : ""}</span>
      <span className="message-search-title">{result.highlightedTitle}</span>
      <span className="message-search-excerpt">{result.highlightedExcerpt}</span>
    </button>)}
    {!search.loading && !search.error && query.trim().length >= 3 && query.trim().length <= 256 && results.length === 0 && <p className="message-search-note">No indexed messages match.</p>}
    {search.elapsedMs !== undefined && <p className="message-search-note">Index query: {search.elapsedMs} ms · Up to 50 chats</p>}
  </section>;
}
