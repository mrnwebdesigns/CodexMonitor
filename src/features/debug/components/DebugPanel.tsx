import { memo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { DebugEntry } from "../../../types";

type DebugPanelProps = {
  entries: DebugEntry[];
  isOpen: boolean;
  onClear: () => void;
  onCopy: () => void;
  onResizeStart?: (event: ReactMouseEvent) => void;
  variant?: "dock" | "full";
};

const MAX_PAYLOAD_PREVIEW_CHARS = 1200;
const MAX_PAYLOAD_PREVIEW_LINES = 10;

function formatPayloadPreview(payload: unknown) {
  let text: string;
  try {
    text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) ?? "";
  } catch {
    text = String(payload);
  }
  const preview = text
    .slice(0, MAX_PAYLOAD_PREVIEW_CHARS)
    .split("\n", MAX_PAYLOAD_PREVIEW_LINES)
    .join("\n");
  return preview.length < text.length
    ? `${preview}\n… Use Copy for the full log.`
    : preview;
}

const DebugRow = memo(function DebugRow({ entry }: { entry: DebugEntry }) {
  return (
    <div className="debug-row">
      <div className="debug-meta">
        <span className={`debug-source ${entry.source}`}>{entry.source}</span>
        <span className="debug-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
        <span className="debug-label">{entry.label}</span>
      </div>
      {entry.payload !== undefined ? (
        <pre className="debug-payload">{formatPayloadPreview(entry.payload)}</pre>
      ) : null}
    </div>
  );
});

export function DebugPanel({
  entries,
  isOpen,
  onClear,
  onCopy,
  onResizeStart,
  variant = "dock",
}: DebugPanelProps) {
  const isVisible = variant === "full" || isOpen;

  if (!isVisible) {
    return null;
  }

  return (
    <section
      className={`debug-panel ${variant === "full" ? "full" : isOpen ? "open" : ""}`}
    >
      {variant !== "full" && isOpen && onResizeStart ? (
        <div
          className="debug-panel-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize debug panel"
          onMouseDown={onResizeStart}
        />
      ) : null}
      <div className="debug-header">
        <div className="debug-title">Debug</div>
        <div className="debug-actions">
          <button className="ghost" onClick={onCopy}>
            Copy
          </button>
          <button className="ghost" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="debug-list">
          {entries.length === 0 ? (
            <div className="debug-empty">No debug events yet.</div>
          ) : null}
          {entries.map((entry) => <DebugRow key={entry.id} entry={entry} />)}
        </div>
      ) : null}
    </section>
  );
}
