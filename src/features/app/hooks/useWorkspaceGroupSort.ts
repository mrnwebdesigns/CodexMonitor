import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, RefCallback } from "react";
import type {
  ReorderWorkspaceGroup,
  WorkspaceGroupSection,
} from "@/features/workspaces/domain/workspaceGroups";

type DropTarget = { id: string; position: "before" | "after" };
type DragSession = {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  handle: HTMLButtonElement;
};

export type WorkspaceGroupSortProps = {
  ref: RefCallback<HTMLDivElement>;
  handleProps: ButtonHTMLAttributes<HTMLButtonElement>;
  isDragging: boolean;
  dropPosition?: "before" | "after";
};

export function useWorkspaceGroupSort(
  groups: WorkspaceGroupSection[],
  onReorder: ReorderWorkspaceGroup | undefined,
) {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const saving = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [session, setSession] = useState<DragSession | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sortableGroups = groups.filter((group) => group.id !== null);
  const enabled = Boolean(onReorder && sortableGroups.length > 1);

  const commit = useCallback(async (id: string, target: DropTarget) => {
    if (!onReorder || saving.current) {
      return;
    }
    saving.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const changed = await onReorder(id, target.id, target.position);
      if (changed) {
        const name = groups.find((group) => group.id === id)?.name ?? "Group";
        const targetName = groups.find((group) => group.id === target.id)?.name ?? "group";
        setAnnouncement(`${name} moved ${target.position} ${targetName}.`);
      }
    } catch {
      setError("Could not save group order. Please try again.");
    } finally {
      saving.current = false;
      setIsSaving(false);
    }
  }, [groups, onReorder]);

  useEffect(() => {
    if (!session || !enabled) {
      return;
    }
    let active = false;
    let pointer = { x: session.x, y: session.y };
    let frame = 0;
    const scrollArea = session.handle.closest<HTMLElement>(".sidebar-body");

    const findTarget = (): DropTarget | null => {
      const bounds = scrollArea?.getBoundingClientRect();
      if (bounds && (pointer.x < bounds.left || pointer.x > bounds.right ||
          pointer.y < bounds.top || pointer.y > bounds.bottom)) {
        return null;
      }
      // Include the spaces between sections so the insertion line is easy to reach.
      for (const group of groups) {
        if (!group.id) {
          continue;
        }
        const rect = nodes.current.get(group.id)?.getBoundingClientRect();
        if (!rect || pointer.x < rect.left || pointer.x > rect.right) {
          continue;
        }
        if (pointer.y <= rect.bottom) {
          if (group.id === session.id) {
            return null;
          }
          const position = pointer.y < rect.top + rect.height / 2 ? "before" : "after";
          const ids = groups.flatMap((entry) => entry.id ? [entry.id] : []);
          const from = ids.indexOf(session.id);
          const to = ids.indexOf(group.id) + (position === "after" ? 1 : 0);
          return to === from || to === from + 1 ? null : { id: group.id, position };
        }
      }
      return null;
    };

    const updateTarget = () => {
      const next = findTarget();
      setDropTarget((previous) => previous?.id === next?.id && previous?.position === next?.position
        ? previous
        : next);
    };

    const clear = () => {
      setSession(null);
      setDraggedId(null);
      setDropTarget(null);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== session.pointerId) {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      if (!active && Math.hypot(pointer.x - session.x, pointer.y - session.y) < 5) {
        return;
      }
      event.preventDefault();
      active = true;
      setDraggedId(session.id);
      updateTarget();
    };
    const finish = (event: PointerEvent) => {
      if (event.pointerId !== session.pointerId) {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      const target = active ? findTarget() : null;
      clear();
      if (target) {
        void commit(session.id, target);
      }
    };
    const cancel = () => clear();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    const autoScroll = () => {
      if (active && scrollArea) {
        const rect = scrollArea.getBoundingClientRect();
        if (pointer.x >= rect.left && pointer.x <= rect.right &&
            pointer.y >= rect.top && pointer.y <= rect.bottom) {
          const edge = 36;
          const delta = pointer.y < rect.top + edge
            ? -Math.min(12, (rect.top + edge - pointer.y) / 3)
            : pointer.y > rect.bottom - edge
              ? Math.min(12, (pointer.y - rect.bottom + edge) / 3)
              : 0;
          if (delta) {
            scrollArea.scrollTop += delta;
            updateTarget();
          }
        }
      }
      frame = requestAnimationFrame(autoScroll);
    };
    frame = requestAnimationFrame(autoScroll);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", keydown);
      if (session.handle.hasPointerCapture?.(session.pointerId)) {
        session.handle.releasePointerCapture(session.pointerId);
      }
    };
  }, [session, enabled, groups, commit]);

  const getSortProps = (id: string | null): WorkspaceGroupSortProps | undefined => {
    if (!enabled || !id) {
      return undefined;
    }
    const name = groups.find((group) => group.id === id)?.name ?? "group";
    return {
      ref: (node) => {
        if (node) {
          nodes.current.set(id, node);
        } else {
          nodes.current.delete(id);
        }
      },
      isDragging: draggedId === id,
      dropPosition: dropTarget?.id === id ? dropTarget.position : undefined,
      handleProps: {
        "aria-label": `Reorder ${name} group`,
        "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
        title: "Drag to reorder, or use Alt + Up/Down",
        "aria-disabled": isSaving,
        onClick: (event) => event.stopPropagation(),
        onPointerDown: (event) => {
          if (event.button !== 0 || saving.current) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setError(null);
          setSession({ id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, handle: event.currentTarget });
        },
        onKeyDown: (event) => {
          // Escape must reach the window listener while the handle owns focus.
          if (event.key === "Escape") {
            return;
          }
          event.stopPropagation();
          if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
            return;
          }
          event.preventDefault();
          const index = sortableGroups.findIndex((group) => group.id === id);
          const target = sortableGroups[index + (event.key === "ArrowUp" ? -1 : 1)];
          if (target?.id) {
            void commit(id, { id: target.id, position: event.key === "ArrowUp" ? "before" : "after" });
          }
        },
      },
    };
  };

  return { getSortProps, announcement, error };
}
