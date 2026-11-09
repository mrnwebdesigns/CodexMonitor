import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { readStoredWidth } from "../hooks/useResizablePanels";

const STORAGE_KEY = "codexmonitor.browserThreadPercent";
const DEFAULT_PERCENT = 42.5;
const MIN_PERCENT = 20;
const MAX_PERCENT = 80;

export function BrowserSplit({ chatPane, browserPanel }: {
  chatPane: ReactNode;
  browserPanel: ReactNode;
}) {
  const splitRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const threadId = useId();
  const drag = useRef<{ pointerId: number; startX: number; startPercent: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(0);
  const [preferredPercent, setPreferredPercent] = useState(() =>
    readStoredWidth(STORAGE_KEY, DEFAULT_PERCENT, MIN_PERCENT, MAX_PERCENT),
  );

  // Aim for comfortable pane widths while leaving both panes resizable in small windows.
  const availableWidth = Math.max(1, width);
  const min = Math.max(MIN_PERCENT, Math.min(30, (280 * 100) / availableWidth));
  const max = Math.min(MAX_PERCENT, Math.max(60, 100 - (360 * 100) / availableWidth));
  const constrain = (percent: number) => Math.min(max, Math.max(min, percent));
  const threadPercent = constrain(preferredPercent);
  const columns = `minmax(0, ${threadPercent}fr) auto minmax(0, ${100 - threadPercent}fr)`;

  useLayoutEffect(() => {
    const split = splitRef.current;
    const divider = dividerRef.current;
    if (!split || !divider) return;
    const measure = () => setWidth(Math.max(0, split.clientWidth - divider.offsetWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!dragging) {
      window.localStorage.setItem(STORAGE_KEY, String(preferredPercent));
    }
  }, [dragging, preferredPercent]);

  return (
    <div
      className={`content content-browser${dragging ? " is-dragging" : ""}`}
      ref={splitRef}
      style={{ gridTemplateColumns: columns }}
    >
      <div className="browser-chat" id={threadId}>{chatPane}</div>
      <div
        className="browser-split-resizer"
        ref={dividerRef}
        role="separator"
        tabIndex={0}
        aria-label="Resize thread and browser panels"
        aria-orientation="vertical"
        aria-controls={threadId}
        aria-valuemin={Math.round(min)}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(threadPercent)}
        aria-valuetext={`${Math.round(threadPercent)}% thread width`}
        title="Drag to resize or use the arrow keys"
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current || width === 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startPercent: threadPercent,
          };
          setDragging(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.pointerId !== event.pointerId || width === 0) return;
          const deltaPercent = ((event.clientX - start.startX) / width) * 100;
          setPreferredPercent(constrain(start.startPercent + deltaPercent));
        }}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(event) => {
          let next: number;
          switch (event.key) {
            case "ArrowLeft": next = threadPercent - 5; break;
            case "ArrowRight": next = threadPercent + 5; break;
            case "Home": next = min; break;
            case "End": next = max; break;
            default: return;
          }
          event.preventDefault();
          if (!drag.current) setPreferredPercent(constrain(next));
        }}
      />
      {browserPanel}
    </div>
  );
}
