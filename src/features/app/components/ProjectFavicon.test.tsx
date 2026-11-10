// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProjectFavicon, projectFaviconUrl } from "./ProjectFavicon";

describe("ProjectFavicon", () => {
  it("uses the website root favicon without carrying a page path or query", () => {
    expect(projectFaviconUrl("https://example.com/work?view=preview")).toBe(
      "https://example.com/favicon.ico",
    );
  });

  it("only permits credential-free HTTP(S) websites", () => {
    expect(projectFaviconUrl("example.com")).toBeNull();
    expect(projectFaviconUrl("file:///private/favicon.ico")).toBeNull();
    expect(projectFaviconUrl("https://user:secret@example.com")).toBeNull();
  });

  it("removes itself when the favicon cannot be loaded", () => {
    const view = render(<ProjectFavicon website="https://example.com" />);
    const favicon = view.container.querySelector(".project-favicon");

    expect(favicon?.getAttribute("src")).toBe("https://example.com/favicon.ico");
    fireEvent.error(favicon!);
    expect(view.container.querySelector(".project-favicon")).toBeNull();
  });
});
