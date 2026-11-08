// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitInitReview } from "@services/tauri";
import { InitGitRepoPrompt } from "./InitGitRepoPrompt";
afterEach(cleanup);
const review: GitInitReview = { root: "/tmp/repo", relativeRoot: ".", profile: "Node / web app", suggestedRoots: [".", "src"], existingRepo: null, author: "Test <test@example.invalid>", included: [{ path: "source.txt", bytes: 42, reason: null }, { path: ".gitignore", bytes: 30, reason: null }], excluded: [{ path: ".env", bytes: 0, reason: "Existing or proposed ignore rule." }], ignoreContent: ".env\nnode_modules/\n", blockers: [], fingerprint: "review-v1" };
function props() { return { workspaceName: "Fixture", branch: "main", root: ".", review, reviewLoading: false, localInitialized: false, createRemote: false, repoName: "repo", isPrivate: true, onBranchChange: vi.fn(), onReviewChange: vi.fn(), onCreateRemoteChange: vi.fn(), onRepoNameChange: vi.fn(), onPrivateChange: vi.fn(), onCancel: vi.fn(), onConfirm: vi.fn() }; }
describe("Git setup review dialog", () => {
 it("shows the file review and local-only confirmation, with editable exclusions", () => {
  const p=props();render(<InitGitRepoPrompt {...p} />);
  expect(screen.getByRole("button", { name: "Initialize locally" }).hasAttribute("disabled")).toBe(false);
  expect((screen.getByLabelText("Create a GitHub repository and push this first commit") as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText("Include source.txt"));expect(p.onReviewChange).toHaveBeenCalledWith({ excludePath: "source.txt" });
  expect((screen.getByLabelText("Include .gitignore") as HTMLInputElement).disabled).toBe(true);
 });
 it("blocks confirmation while reviewing or when a scope blocker is present", () => {
  const p=props();const view=render(<InitGitRepoPrompt {...p} reviewLoading />);
  expect((screen.getByRole("button", { name: "Initialize locally" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<InitGitRepoPrompt {...p} review={{ ...review, blockers: ["Choose the custom theme folder"] }} />);
  expect(screen.getByRole("alert").textContent).toContain("custom theme");
  expect((screen.getByRole("button", { name: "Initialize locally" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "src" }));expect(p.onReviewChange).toHaveBeenCalledWith({ root: "src" });
 });
});
