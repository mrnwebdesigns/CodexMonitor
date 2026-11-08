import type { CSSProperties } from "react";

export const SIDEBAR_COLORS = [
  { id: "red", label: "Red", value: "#e86868" },
  { id: "orange", label: "Orange", value: "#e89946" },
  { id: "yellow", label: "Yellow", value: "#d4b83f" },
  { id: "green", label: "Green", value: "#53b982" },
  { id: "teal", label: "Teal", value: "#44b4b4" },
  { id: "blue", label: "Blue", value: "#6199ed" },
  { id: "purple", label: "Purple", value: "#ad83e8" },
  { id: "pink", label: "Pink", value: "#df80b4" },
] as const;

export type SidebarColor = (typeof SIDEBAR_COLORS)[number]["id"] | `custom:#${string}`;

export type SidebarColorOption = { id: SidebarColor; label: string; value: string };

export function normalizeColorHex(value: string): string | null {
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}`;
  return null;
}

export function isCustomSidebarColor(value: unknown): value is `custom:#${string}` {
  return typeof value === "string" && /^custom:#[0-9a-f]{6}$/.test(value);
}

export function isSidebarColor(value: unknown): value is SidebarColor {
  return SIDEBAR_COLORS.some((color) => color.id === value) || isCustomSidebarColor(value);
}

export function sidebarColorStyle(color: SidebarColor | undefined): CSSProperties | undefined {
  const value = isCustomSidebarColor(color) ? color.slice(7) : SIDEBAR_COLORS.find((item) => item.id === color)?.value;
  return value ? { "--sidebar-item-color": value } as CSSProperties : undefined;
}
