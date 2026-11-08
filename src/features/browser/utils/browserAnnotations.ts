import type { BrowserAnnotation } from "../browserTypes";

export function normalizeBrowserUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a website address.");
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^(localhost|[\w.-]+\.[a-z]+):\d+/i.test(trimmed);
  const url = new URL(hasScheme ? trimmed : `${/^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(trimmed) ? "http" : "https"}://${trimmed}`);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Use an http or https website address.");
  }
  if (["tauri.localhost", "asset.localhost", "ipc.localhost"].includes(url.hostname)) throw new Error("This address belongs to the app interface.");
  if (url.username || url.password) throw new Error("Sign in on the page instead of putting credentials in the address.");
  return url.href;
}

export function formatBrowserAnnotations(annotations: BrowserAnnotation[]): string {
  return annotations.map((annotation, index) => [
    `Website feedback ${index + 1}`,
    `Page: ${annotation.title || "Untitled page"}`,
    `URL: ${annotation.url}`,
    `Element: ${annotation.selector || annotation.tag}`,
    `Visible text: ${JSON.stringify(annotation.text)}`,
    `Viewport position: ${Math.round(annotation.rect.x)}, ${Math.round(annotation.rect.y)}; size: ${Math.round(annotation.rect.width)} × ${Math.round(annotation.rect.height)}`,
    `My requested change: ${annotation.comment.trim()}`,
    annotation.screenshot ? "A screenshot of this page is attached." : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}
