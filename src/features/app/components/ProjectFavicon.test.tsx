// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectFavicon, projectFaviconUrl } from "./ProjectFavicon";

const resolveProjectFavicon = vi.hoisted(() => vi.fn());
vi.mock("@services/tauri", () => ({ resolveProjectFavicon }));

describe("ProjectFavicon", () => {
  beforeEach(() => {
    resolveProjectFavicon.mockResolvedValue(null);
  });

  it("uses the website root favicon without carrying a page path or query", () => {
    expect(projectFaviconUrl("https://example.com/work?view=preview")).toBe(
      "https://example.com/favicon.ico",
    );
  });

  it("only permits credential-free HTTP(S) websites", () => {
    expect(projectFaviconUrl("example.com")).toBe("https://example.com/favicon.ico");
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

  it("uses a favicon declared by the website when available", async () => {
    resolveProjectFavicon.mockResolvedValue("https://ctwilson.com/wp-content/uploads/favicon.png");
    const view = render(<ProjectFavicon website="https://ctwilson.com" />);

    await waitFor(() => expect(view.container.querySelector(".project-favicon")?.getAttribute("src"))
      .toBe("https://ctwilson.com/wp-content/uploads/favicon.png"));
  });

  it("shows the declared icon even if the default icon fails first", async () => {
    resolveProjectFavicon.mockResolvedValue("https://ctwilson.com/wp-content/uploads/favicon.png");
    const view = render(<ProjectFavicon website="ctwilson.com" />);
    const rootIcon = view.container.querySelector(".project-favicon");
    expect(rootIcon?.getAttribute("src")).toBe("https://ctwilson.com/favicon.ico");
    fireEvent.error(rootIcon!);

    await waitFor(() => expect(view.container.querySelector(".project-favicon")?.getAttribute("src"))
      .toBe("https://ctwilson.com/wp-content/uploads/favicon.png"));
  });
});
