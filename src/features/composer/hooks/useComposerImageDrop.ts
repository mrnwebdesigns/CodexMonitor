import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeWindowDragDrop } from "@services/dragDrop";
import { isWindowsPlatform } from "@utils/platformPaths";

const imageExtensions = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
];

function isImagePath(path: string) {
  const lower = path.toLowerCase();
  return imageExtensions.some((ext) => lower.endsWith(ext));
}

function imageMime(file: File) {
  if (file.type.startsWith("image/")) return file.type.toLowerCase();
  const extensions: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
    heic: "image/heic", heif: "image/heif",
  };
  return extensions[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
}

async function normalizeImageData(dataUrl: string, mime: string) {
  const normalized = dataUrl.replace(/^data:[^;]*;/, `data:${mime};`);
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) return normalized;
  // Match the existing local-image path behavior: send a model-supported raster
  // even when macOS supplied HEIC, TIFF, BMP, or another decodable image format.
  const source = new Image();
  source.src = normalized;
  await source.decode();
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth;
  canvas.height = source.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.drawImage(source, 0, 0);
  const png = canvas.toDataURL("image/png");
  return png.startsWith("data:image/png;") ? png : "";
}

function isDragFileTransfer(types: readonly string[] | undefined) {
  if (!types || types.length === 0) {
    return false;
  }
  return (
    types.includes("Files") ||
    types.includes("public.file-url") ||
    types.includes("application/x-moz-file")
  );
}

function readFilesAsDataUrls(files: File[]) {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const data = typeof reader.result === "string" ? reader.result : "";
            if (!data) { resolve(""); return; }
            void normalizeImageData(data, imageMime(file)).then(resolve, () => resolve(""));
          };
          reader.onerror = () => resolve("");
          reader.onabort = () => resolve("");
          try { reader.readAsDataURL(file); } catch { resolve(""); }
        }),
    ),
  ).then((items) => items.filter(Boolean));
}

function getDropTarget(input: HTMLDivElement | null) {
  return input?.closest<HTMLElement>("[data-composer-drop-scope]") ?? input;
}

function isHidden(target: HTMLElement | null) {
  return Boolean(target?.closest("[inert], [hidden], [aria-hidden='true']"));
}

function normalizeDragPosition(
  position: { x: number; y: number },
  lastClientPosition: { x: number; y: number } | null,
) {
  const scale = window.devicePixelRatio || 1;
  const scaled = { x: position.x / scale, y: position.y / scale };
  if (scale === 1 || !lastClientPosition) {
    // Wry uses physical pixels on Windows and logical points on macOS/Linux.
    // Native file drags need not emit DOM drag events to provide a position hint.
    return isWindowsPlatform() ? scaled : position;
  }
  const logicalDistance = Math.hypot(
    position.x - lastClientPosition.x,
    position.y - lastClientPosition.y,
  );
  const scaledDistance = Math.hypot(
    scaled.x - lastClientPosition.x,
    scaled.y - lastClientPosition.y,
  );
  return scaledDistance < logicalDistance ? scaled : position;
}

type UseComposerImageDropArgs = {
  disabled: boolean;
  onAttachImages?: (paths: string[]) => void;
};

type FileDragEvent = Pick<
  DragEvent,
  "dataTransfer" | "preventDefault" | "clientX" | "clientY"
>;

export function useComposerImageDrop({
  disabled,
  onAttachImages,
}: UseComposerImageDropArgs) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [imageDropError, setImageDropError] = useState<string | null>(null);
  const [pendingImports, setPendingImports] = useState(0);
  const dropTargetRef = useRef<HTMLDivElement | null>(null);
  const lastClientPositionRef = useRef<{ x: number; y: number } | null>(null);

  const handleDragOver = useCallback((event: FileDragEvent) => {
    if (disabled || isHidden(getDropTarget(dropTargetRef.current))) {
      return;
    }
    if (isDragFileTransfer(event.dataTransfer?.types)) {
      lastClientPositionRef.current = { x: event.clientX, y: event.clientY };
      event.preventDefault();
      setIsDragOver(true);
    }
  }, [disabled]);

  const handleDragEnter = handleDragOver;

  const handleDragLeave = useCallback((event?: Pick<DragEvent, "relatedTarget">) => {
    const target = getDropTarget(dropTargetRef.current);
    if (
      event?.relatedTarget instanceof Node &&
      target?.contains(event.relatedTarget)
    ) {
      return;
    }
    setIsDragOver(false);
    lastClientPositionRef.current = null;
  }, []);

  const handleDrop = useCallback(async (event: Pick<DragEvent, "dataTransfer" | "preventDefault">) => {
    if (disabled || isHidden(getDropTarget(dropTargetRef.current))) {
      return;
    }
    setIsDragOver(false);
    lastClientPositionRef.current = null;
    const files = Array.from(event.dataTransfer?.files ?? []);
    const items = Array.from(event.dataTransfer?.items ?? []);
    const itemFiles = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    // FileList and DataTransferItemList describe the same dropped files.
    const droppedFiles = files.length > 0 ? files : itemFiles;
    if (
      droppedFiles.length === 0 &&
      !isDragFileTransfer(event.dataTransfer?.types)
    ) {
      return;
    }
    event.preventDefault();
    setImageDropError(null);
    setPendingImports((count) => count + 1);
    const images = await Promise.all(
      droppedFiles.map(async (file) => {
        const path = (file as File & { path?: string }).path;
        if (path && isImagePath(path)) {
          return path;
        }
        if (imageMime(file)) {
          return (await readFilesAsDataUrls([file]))[0] ?? "";
        }
        return "";
      }),
    ).finally(() => setPendingImports((count) => Math.max(0, count - 1)));
    const valid = Array.from(new Set(images.filter(Boolean)));
    if (valid.length > 0) {
      onAttachImages?.(valid);
    } else if (droppedFiles.some((file) => imageMime(file))) {
      setImageDropError("The image could not be read from the drag source.");
    }
  }, [disabled, onAttachImages]);

  useEffect(() => {
    if (disabled) {
      setIsDragOver(false);
      return;
    }
    const target = getDropTarget(dropTargetRef.current);
    // Listen once on the conversation (or standalone composer), so drops on
    // messages and bubbled textarea drops follow the same attachment path.
    target?.addEventListener("dragover", handleDragOver);
    target?.addEventListener("dragenter", handleDragEnter);
    target?.addEventListener("dragleave", handleDragLeave);
    target?.addEventListener("drop", handleDrop);
    const unlisten = subscribeWindowDragDrop((event) => {
      const scope = getDropTarget(dropTargetRef.current);
      if (event.payload.type === "leave") {
        handleDragLeave();
        return;
      }
      if (!scope || isHidden(scope)) {
        setIsDragOver(false);
        return;
      }
      const position = normalizeDragPosition(
        event.payload.position,
        lastClientPositionRef.current,
      );
      const rect = scope.getBoundingClientRect();
      const hit = document.elementFromPoint?.(position.x, position.y);
      const isInside =
        position.x >= rect.left && position.x <= rect.right &&
        position.y >= rect.top && position.y <= rect.bottom &&
        (!hit || scope.contains(hit));
      if (event.payload.type === "over" || event.payload.type === "enter") {
        const paths = event.payload.paths;
        setIsDragOver(isInside && (!paths?.length || paths.some(isImagePath)));
        return;
      }
      if (event.payload.type === "drop") {
        setIsDragOver(false);
        setImageDropError(null);
        lastClientPositionRef.current = null;
        if (isInside) {
          const paths = Array.from(new Set(
            (event.payload.paths ?? []).map((path) => path.trim()).filter(isImagePath),
          ));
          if (paths.length > 0) {
            onAttachImages?.(paths);
          }
        }
      }
    });
    return () => {
      target?.removeEventListener("dragover", handleDragOver);
      target?.removeEventListener("dragenter", handleDragEnter);
      target?.removeEventListener("dragleave", handleDragLeave);
      target?.removeEventListener("drop", handleDrop);
      lastClientPositionRef.current = null;
      unlisten();
    };
  }, [disabled, onAttachImages, handleDragOver, handleDragEnter, handleDragLeave, handleDrop]);

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) {
      return;
    }
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) {
      return;
    }
    event.preventDefault();
    const files = imageItems
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) {
      return;
    }
    setImageDropError(null);
    setPendingImports((count) => count + 1);
    const valid = await readFilesAsDataUrls(files)
      .finally(() => setPendingImports((count) => Math.max(0, count - 1)));
    if (valid.length > 0) {
      onAttachImages?.(valid);
    } else {
      setImageDropError("The image could not be read from the clipboard.");
    }
  };

  return {
    dropTargetRef,
    isDragOver,
    imageDropError,
    isImportingImages: pendingImports > 0,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handlePaste,
  };
}
