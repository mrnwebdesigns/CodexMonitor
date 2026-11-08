import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  isCustomSidebarColor,
  isSidebarColor,
  normalizeColorHex,
  SIDEBAR_COLORS,
  type SidebarColor,
  type SidebarColorOption,
} from "@app/utils/sidebarColors";

export const PROJECT_COLORS_STORAGE_KEY = "codexmonitor.projectColors.v1";
export const CUSTOM_PROJECT_COLORS_STORAGE_KEY = "codexmonitor.customProjectColors.v1";
const CHANGE_EVENT = "codexmonitor.projectColorsChanged";
const sessionOverrides = new Map<string, string>();

function readStored(key: string, fallback: string): string {
  if (sessionOverrides.has(key)) return sessionOverrides.get(key)!;
  try { return localStorage.getItem(key) || fallback; }
  catch { return fallback; }
}

function publish(updates: Array<[string, unknown]>) {
  for (const [key, value] of updates) {
    const raw = JSON.stringify(value);
    try { localStorage.setItem(key, raw); sessionOverrides.delete(key); }
    catch { sessionOverrides.set(key, raw); }
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== PROJECT_COLORS_STORAGE_KEY && event.key !== CUSTOM_PROJECT_COLORS_STORAGE_KEY) return;
    if (event.key === null) sessionOverrides.clear();
    else sessionOverrides.delete(event.key);
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readColors(raw = readStored(PROJECT_COLORS_STORAGE_KEY, "{}")): Record<string, SidebarColor> {
  try {
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter((entry) => isSidebarColor(entry[1])));
  } catch { return {}; }
}

function readCustomColors(raw = readStored(CUSTOM_PROJECT_COLORS_STORAGE_KEY, "[]")): SidebarColorOption[] {
  try {
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return [];
    const colors: SidebarColorOption[] = [];
    for (const item of stored) {
      if (!item || typeof item !== "object" || typeof item.label !== "string" || typeof item.value !== "string") continue;
      const value = normalizeColorHex(item.value);
      const label = item.label.trim().slice(0, 40);
      if (!value || !label || item.id !== `custom:${value}` || !isCustomSidebarColor(item.id)) continue;
      if ([...SIDEBAR_COLORS, ...colors].some((color) => color.value === value || color.label.toLowerCase() === label.toLowerCase())) continue;
      colors.push({ id: item.id, label, value });
    }
    return colors;
  } catch { return []; }
}

const getColorsSnapshot = () => readStored(PROJECT_COLORS_STORAGE_KEY, "{}");
const getCustomColorsSnapshot = () => readStored(CUSTOM_PROJECT_COLORS_STORAGE_KEY, "[]");

export function useProjectColors() {
  const rawColors = useSyncExternalStore(subscribe, getColorsSnapshot);
  const rawCustomColors = useSyncExternalStore(subscribe, getCustomColorsSnapshot);
  const projectColors = useMemo(() => readColors(rawColors), [rawColors]);
  const customColors = useMemo(() => readCustomColors(rawCustomColors), [rawCustomColors]);
  const palette = useMemo(() => [...SIDEBAR_COLORS, ...customColors], [customColors]);

  const setProjectColor = useCallback((workspaceId: string, color: SidebarColor | null) => {
    const next = { ...readColors() };
    if (color && isSidebarColor(color)) next[workspaceId] = color;
    else delete next[workspaceId];
    publish([[PROJECT_COLORS_STORAGE_KEY, next]]);
  }, []);

  const getProjectColor = useCallback((workspaceId: string) =>
    Object.prototype.hasOwnProperty.call(projectColors, workspaceId) ? projectColors[workspaceId] : undefined,
  [projectColors]);

  const addCustomColor = useCallback((name: string, hex: string): string | null => {
    const label = name.trim();
    const value = normalizeColorHex(hex);
    if (!label || label.length > 40) return "Enter a color name with 1–40 characters.";
    if (!value) return "Enter a hex color such as #8B5CF6.";
    const colors = readCustomColors();
    const allColors = [...SIDEBAR_COLORS, ...colors];
    if (allColors.some((color) => color.label.toLowerCase() === label.toLowerCase())) return "A color with that name already exists.";
    if (allColors.some((color) => color.value === value)) return "That color is already in your palette.";
    publish([[CUSTOM_PROJECT_COLORS_STORAGE_KEY, [...colors, { id: `custom:${value}`, label, value }]]]);
    return null;
  }, []);

  const removeCustomColor = useCallback((id: SidebarColor) => {
    if (!isCustomSidebarColor(id)) return;
    publish([
      [CUSTOM_PROJECT_COLORS_STORAGE_KEY, readCustomColors().filter((color) => color.id !== id)],
      [PROJECT_COLORS_STORAGE_KEY, Object.fromEntries(Object.entries(readColors()).filter(([, color]) => color !== id))],
    ]);
  }, []);

  return { getProjectColor, setProjectColor, palette, customColors, addCustomColor, removeCustomColor };
}
