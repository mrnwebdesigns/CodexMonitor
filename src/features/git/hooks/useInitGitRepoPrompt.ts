import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceInfo } from "@/types";
import { previewGitInit, type GitInitReview, type GitInitSelection } from "@services/tauri";
import { validateBranchName } from "../utils/branchValidation";
import type { InitGitRepoOutcome } from "./useGitActions";

export type GitSetupReviewChange = { root?: string; excludePath?: string };
export type InitGitRepoPromptState = {
  workspaceId: string;
  workspaceName: string;
  branch: string;
  root: string;
  excludedPaths: string[];
  review: GitInitReview | null;
  reviewLoading: boolean;
  localInitialized: boolean;
  createRemote: boolean;
  repoName: string;
  isPrivate: boolean;
  error: string | null;
};

type Options = {
  activeWorkspace: WorkspaceInfo | null;
  initGitRepo: (branch: string, setup?: GitInitSelection) => Promise<InitGitRepoOutcome>;
  createGitHubRepo: (repo: string, visibility: "private" | "public", branch: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  refreshGitRemote: () => void;
  isBusy: boolean;
};

export function useInitGitRepoPrompt({ activeWorkspace, initGitRepo, createGitHubRepo, refreshGitRemote, isBusy }: Options) {
  const [initGitRepoPrompt, setPrompt] = useState<InitGitRepoPromptState | null>(null);
  const activeId = activeWorkspace?.id ?? null;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const confirming = useRef(false);
  useEffect(() => { setPrompt((current) => current && current.workspaceId !== activeId ? null : current); }, [activeId]);
  const reviewKey = initGitRepoPrompt ? JSON.stringify([initGitRepoPrompt.workspaceId, initGitRepoPrompt.root, initGitRepoPrompt.branch, initGitRepoPrompt.excludedPaths]) : null;
  useEffect(() => {
    if (!reviewKey) return;
    const [workspaceId, root, branch, excludedPaths] = JSON.parse(reviewKey) as [string, string, string, string[]];
    let live = true;
    const timer = window.setTimeout(() => {
      void previewGitInit(workspaceId, root, branch, excludedPaths).then((review) => {
        if (live) setPrompt((current) => current?.workspaceId === workspaceId ? { ...current, review, reviewLoading: false, error: null } : current);
      }).catch((reason) => {
        if (live) setPrompt((current) => current?.workspaceId === workspaceId ? { ...current, review: null, reviewLoading: false, error: `Could not review Git setup: ${reason instanceof Error ? reason.message : String(reason)}` } : current);
      });
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [reviewKey]);

  const openInitGitRepoPrompt = useCallback(() => {
    if (!activeWorkspace) return;
    const path = activeWorkspace.path.replace(/\\/g, "/").replace(/\/+$/, "");
    const storedRoot = activeWorkspace.settings.gitRoot?.replace(/\\/g, "/") || ".";
    const root = storedRoot === path ? "." : storedRoot.startsWith(`${path}/`) ? storedRoot.slice(path.length + 1) : storedRoot;
    setPrompt({ workspaceId: activeWorkspace.id, workspaceName: activeWorkspace.name, branch: "main", root,
      excludedPaths: [], review: null, reviewLoading: true, localInitialized: false,
      createRemote: false, repoName: path.split("/").slice(-1)[0] || "", isPrivate: true, error: null });
  }, [activeWorkspace]);

  const handleInitGitRepoPromptBranchChange = useCallback((branch: string) => {
    setPrompt((current) => current && !current.localInitialized ? { ...current, branch, review: null, reviewLoading: true, error: null } : current);
  }, []);
  const handleInitGitRepoPromptReviewChange = useCallback((change: GitSetupReviewChange) => {
    setPrompt((current) => {
      if (!current || current.localInitialized) return current;
      if (change.root !== undefined) return { ...current, root: change.root, excludedPaths: [], review: null, reviewLoading: true, error: null };
      const path = change.excludePath;
      if (!path || path === ".gitignore") return current;
      const excludedPaths = current.excludedPaths.includes(path) ? current.excludedPaths.filter((value) => value !== path) : [...current.excludedPaths, path];
      return { ...current, excludedPaths, review: null, reviewLoading: true, error: null };
    });
  }, []);
  const handleInitGitRepoPromptCreateRemoteChange = useCallback((createRemote: boolean) => setPrompt((current) => current ? { ...current, createRemote, error: null } : current), []);
  const handleInitGitRepoPromptRepoNameChange = useCallback((repoName: string) => setPrompt((current) => current ? { ...current, repoName, error: null } : current), []);
  const handleInitGitRepoPromptPrivateChange = useCallback((isPrivate: boolean) => setPrompt((current) => current ? { ...current, isPrivate, error: null } : current), []);
  const handleInitGitRepoPromptCancel = useCallback(() => { if (!isBusy && !confirming.current) setPrompt(null); }, [isBusy]);

  const handleInitGitRepoPromptConfirm = useCallback(async () => {
    const prompt = initGitRepoPrompt;
    if (isBusy || confirming.current || !prompt || prompt.workspaceId !== activeId || prompt.reviewLoading || !prompt.review || prompt.review.blockers.length || !prompt.review.fingerprint) return;
    const validationError = !prompt.branch.trim() ? "Branch name is required." : validateBranchName(prompt.branch);
    if (validationError) { setPrompt((current) => current ? { ...current, error: validationError } : current); return; }
    if (prompt.createRemote && (!prompt.repoName.trim() || /\s/.test(prompt.repoName.trim()))) {
      setPrompt((current) => current ? { ...current, error: "Use a repository name without spaces." } : current); return;
    }
    confirming.current = true;
    try {
    if (!prompt.localInitialized) {
      const outcome = await initGitRepo(prompt.branch.trim(), { root: prompt.root, excludedPaths: prompt.excludedPaths, fingerprint: prompt.review.fingerprint });
      if (outcome === "cancelled") return;
      if (outcome !== "initialized") {
        setPrompt((current) => current ? { ...current, error: "Setup did not complete. Review the reported error; close and reopen this dialog for a fresh review." } : current); return;
      }
      setPrompt((current) => current?.workspaceId === prompt.workspaceId ? { ...current, localInitialized: true } : current);
    }
    if (activeIdRef.current !== prompt.workspaceId) return;
    if (prompt.createRemote) {
      const result = await createGitHubRepo(prompt.repoName.trim(), prompt.isPrivate ? "private" : "public", prompt.branch.trim());
      if (!result.ok) { setPrompt((current) => current?.workspaceId === prompt.workspaceId ? { ...current, localInitialized: true, error: `Local Git is ready. GitHub setup did not finish: ${result.error}` } : current); return; }
      refreshGitRemote();
    }
    setPrompt((current) => current?.workspaceId === prompt.workspaceId ? null : current);
    } finally { confirming.current = false; }
  }, [activeId, createGitHubRepo, initGitRepo, initGitRepoPrompt, isBusy, refreshGitRemote]);

  return { initGitRepoPrompt, openInitGitRepoPrompt, handleInitGitRepoPromptBranchChange, handleInitGitRepoPromptReviewChange,
    handleInitGitRepoPromptCreateRemoteChange, handleInitGitRepoPromptRepoNameChange, handleInitGitRepoPromptPrivateChange,
    handleInitGitRepoPromptCancel, handleInitGitRepoPromptConfirm };
}
