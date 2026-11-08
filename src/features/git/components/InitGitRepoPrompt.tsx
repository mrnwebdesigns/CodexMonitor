import { useMemo, useState } from "react";
import type { GitInitReview } from "@services/tauri";
import type { GitSetupReviewChange } from "../hooks/useInitGitRepoPrompt";
import { ModalShell } from "../../design-system/components/modal/ModalShell";
import { validateBranchName } from "../utils/branchValidation";

type Props = {
  workspaceName: string;
  branch: string;
  root: string;
  review: GitInitReview | null;
  reviewLoading: boolean;
  localInitialized: boolean;
  createRemote: boolean;
  repoName: string;
  isPrivate: boolean;
  error?: string | null;
  isBusy?: boolean;
  onBranchChange: (value: string) => void;
  onReviewChange: (change: GitSetupReviewChange) => void;
  onCreateRemoteChange: (value: boolean) => void;
  onRepoNameChange: (value: string) => void;
  onPrivateChange: (value: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function InitGitRepoPrompt({ workspaceName, branch, root, review, reviewLoading, localInitialized,
  createRemote, repoName, isPrivate, error = null, isBusy = false, onBranchChange, onReviewChange,
  onCreateRemoteChange, onRepoNameChange, onPrivateChange, onCancel, onConfirm }: Props) {
  const [fileQuery, setFileQuery] = useState("");
  const [fileLimit, setFileLimit] = useState(100);
  const validationError = useMemo(() => !branch.trim() ? "Branch name is required." : validateBranchName(branch), [branch]);
  const remoteError = createRemote && (!repoName.trim() || /\s/.test(repoName)) ? "Use a GitHub repository name without spaces." : null;
  const canSubmit = !isBusy && !validationError && !remoteError && !reviewLoading && review && review.blockers.length === 0 && Boolean(review.fingerprint);
  const filteredFiles = review?.included.filter((file) => file.path.toLowerCase().includes(fileQuery.toLowerCase())) ?? [];
  const disabled = isBusy || localInitialized;

  return <ModalShell className="git-init-modal" ariaLabel="Initialize Git" onBackdropClick={() => { if (!isBusy) onCancel(); }}>
    <div className="ds-modal-title git-init-modal-title">Set up Git for {workspaceName}</div>
    <div className="ds-modal-subtitle git-init-modal-subtitle">Choose the source folder and review the first commit. Files stay on this Mac unless you select GitHub below.</div>
    <div className="git-setup-options">
      <label className="ds-modal-label" htmlFor="git-init-root">Repository folder</label>
      <input id="git-init-root" className="ds-modal-input" value={root} disabled={disabled} onChange={(event) => onReviewChange({ root: event.target.value })} placeholder=". or a folder inside this project" />
      <label className="ds-modal-label" htmlFor="git-init-branch">Initial branch</label>
      <input id="git-init-branch" className="ds-modal-input" value={branch} disabled={disabled} onChange={(event) => onBranchChange(event.target.value)} placeholder="main" />
    </div>
    {reviewLoading && <p className="git-setup-status" role="status">Reviewing files and ignore rules… No project files have been changed.</p>}
    {review && <>
      <div className="git-setup-summary"><strong>{review.profile}</strong><span>{review.root}</span>{review.author && <small>Commit author: {review.author}</small>}</div>
      {review.blockers.length > 0 && <div className="ds-modal-error" role="alert">{review.blockers.map((message) => <p key={message}>{message}</p>)}</div>}
      {review.suggestedRoots.length > 1 && !localInitialized && <div className="git-setup-folders"><span>Source folders</span>{review.suggestedRoots.filter((path) => path !== root).map((path) => <button type="button" className="ghost" key={path} disabled={isBusy} onClick={() => onReviewChange({ root: path })}>{path}</button>)}</div>}
      {!review.existingRepo && <>
        <details className="git-setup-review" open><summary>First commit · {review.included.length} files</summary>
          <p>Only the files listed here will be staged. Existing ignore rules are preserved.</p>
          {review.included.length > 0 && <input className="ds-modal-input" aria-label="Filter first-commit files" placeholder="Find a file…" value={fileQuery} onChange={(event) => { setFileQuery(event.target.value); setFileLimit(100); }} />}
          <div className="git-setup-files">{filteredFiles.slice(0, fileLimit).map((file) => <label key={file.path}><input type="checkbox" checked disabled={disabled || reviewLoading || file.path === ".gitignore"} onChange={() => onReviewChange({ excludePath: file.path })} aria-label={`Include ${file.path}`} /><code>{file.path}</code><small>{Math.ceil(file.bytes / 1024)} KB</small></label>)}</div>
          {filteredFiles.length > fileLimit && <button type="button" className="ghost" onClick={() => setFileLimit((limit) => limit + 100)}>Show more files ({filteredFiles.length - fileLimit} remaining)</button>}
        </details>
        <details className="git-setup-review" open={review.excluded.some((file) => file.reason?.startsWith("Possible embedded")) || undefined}><summary>Excluded · {review.excluded.length} entries</summary>
          <div className="git-setup-excluded">{review.excluded.map((file) => <div key={file.path}><code>{file.path}</code><small>{file.reason}</small>
            {!disabled && !reviewLoading && (file.reason === "Excluded by you." || file.reason?.startsWith("Possible embedded")) && <button type="button" className="ghost" onClick={() => onReviewChange({ excludePath: file.path })}>{file.reason === "Excluded by you." ? "Restore file" : "Exclude this file"}</button>}
          </div>)}</div>
        </details>
        <details className="git-setup-review"><summary>Proposed .gitignore</summary><pre>{review.ignoreContent}</pre></details>
        <p className="git-setup-note">Checks cover common credential patterns and filenames. Review the file list; this is not a complete secrets audit.</p>
      </>}
    </>}
    {localInitialized && <p className="git-setup-status">Local Git and the first commit are ready.</p>}
    <label className="git-init-modal-checkbox-row"><input type="checkbox" className="git-init-modal-checkbox" checked={createRemote} disabled={isBusy} onChange={(event) => onCreateRemoteChange(event.target.checked)} /><span>Create a GitHub repository and push this first commit</span></label>
    {createRemote && <div className="git-init-modal-remote">
      <label className="ds-modal-label" htmlFor="git-init-repo-name">GitHub repository</label>
      <input id="git-init-repo-name" className="ds-modal-input" value={repoName} disabled={isBusy} placeholder="owner/repo or repo" onChange={(event) => onRepoNameChange(event.target.value)} />
      <label className="git-init-modal-checkbox-row"><input type="checkbox" checked={isPrivate} disabled={isBusy} onChange={(event) => onPrivateChange(event.target.checked)} /><span>Private repository</span></label>
    </div>}
    {(error || validationError || remoteError) && <div className="ds-modal-error" role="alert">{error || validationError || remoteError}</div>}
    <div className="ds-modal-actions git-init-modal-actions">
      <button type="button" className="ghost ds-modal-button" onClick={onCancel} disabled={isBusy}>{localInitialized ? "Close" : "Cancel"}</button>
      <button type="button" className="primary ds-modal-button" onClick={onConfirm} disabled={!canSubmit}>{isBusy ? "Setting up…" : localInitialized && createRemote ? "Retry GitHub setup" : createRemote ? "Initialize and publish" : "Initialize locally"}</button>
    </div>
  </ModalShell>;
}
