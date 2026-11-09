import { describe, expect, it } from "vitest";
import { formatBrowserAnnotations, normalizeBrowserUrl } from "./browserAnnotations";

describe("browser addresses", () => {
  it("supports local development and normal websites", () => {
    expect(normalizeBrowserUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeBrowserUrl("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserUrl("http://127.0.0.1:4000/test")).toBe("http://127.0.0.1:4000/test");
  });
  it("rejects local-file, script, data and credential URLs", () => {
    for (const value of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "tauri://localhost", "http://tauri.localhost", "https://asset.localhost", "https://user:password@example.com"]) expect(() => normalizeBrowserUrl(value)).toThrow();
  });
});

describe("annotation context", () => {
  it("preserves element, page and owner feedback as reviewable draft text", () => {
    const text = formatBrowserAnnotations([{ id: "1", threadId: "thread-one", url: "https://example.com/", title: "Example", selector: "#hero", tag: "section", text: "Hello <script>", rect: { x: 1, y: 2, width: 300, height: 100 }, comment: "Make the heading smaller", screenshot: "/tmp/capture.png" }]);
    expect(text).toContain("URL: https://example.com/");
    expect(text).toContain("Element: #hero");
    expect(text).toContain('Visible text: "Hello <script>"');
    expect(text).toContain("My requested change: Make the heading smaller");
    expect(text).toContain("screenshot");
  });
});
