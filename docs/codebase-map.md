# Codebase Map (Task-Oriented)

Canonical navigation guide for CodexMonitor. Use this as: "if you need X, edit Y".

## Message search and storage dashboard

- Shared app/daemon search core: `src-tauri/src/shared/message_search_core.rs`; embedded indexer and fixtures: `scripts/message_search.py`, `scripts/test_message_search.py`.
- Additive IPC/RPC methods: `search_messages`, `message_search_status`, `message_search_control`. App adapter: `src-tauri/src/message_search.rs`; daemon route: `rpc/workspace.rs`; frontend wrapper: `src/services/tauri.ts`.
- Search result hooks/components and Home storage controls: `src/features/search/`, styled by `src/styles/message-search.css`. Sidebar results respect project visibility and `useThreads`' hidden-chat predicate passed through the layout wiring.
- Scope, runtime requirements, storage metrics, and safe cache maintenance: `docs/message-search.md`.

Related docs:

- Setup/build/release: `README.md`
- iOS remote over Tailscale (TCP): `docs/mobile-ios-tailscale-blueprint.md`

## Start Here: How Changes Flow

For backend behavior, follow this path in order:

1. Frontend callsite: `src/features/**` hooks/components
2. Frontend IPC API: `src/services/tauri.ts`
3. Tauri command registration: `src-tauri/src/lib.rs` (`invoke_handler`)
4. App adapter: `src-tauri/src/{codex,workspaces,git,files,settings,prompts}/*`
5. Shared core source of truth: `src-tauri/src/shared/*`
6. Daemon RPC method parity: `src-tauri/src/bin/codex_monitor_daemon/rpc.rs`
7. Daemon state/wiring implementation: `src-tauri/src/bin/codex_monitor_daemon.rs`
8. Standalone daemon lifecycle CLI: `src-tauri/src/bin/codex_monitor_daemonctl.rs`

If a behavior must work in both app and daemon, implement it in `src-tauri/src/shared/*` first.

## If You Need X, Edit Y

| Need | Primary files to edit |
| --- | --- |
| App-level UI composition/layout wiring | `src/App.tsx`, `src/features/app/components/AppLayout.tsx`, `src/features/app/bootstrap/*`, `src/features/app/orchestration/*`, `src/features/app/hooks/*` |
| Add/change Tauri IPC methods used by frontend | `src/services/tauri.ts`, `src-tauri/src/lib.rs`, matching backend adapter module |
| Add/change app-server event handling in UI | `src/services/events.ts`, `src/features/app/hooks/useAppServerEvents.ts`, `src/utils/appServerEvents.ts`, `src/features/threads/utils/threadNormalize.ts` |
| Change thread state transitions | `src/features/threads/hooks/useThreadsReducer.ts`, `src/features/threads/hooks/threadReducer/*`, `src/features/threads/hooks/useThreads.ts`, focused thread hooks under `src/features/threads/hooks/*` |
| Change workspace lifecycle/worktree behavior | `src/features/workspaces/hooks/useWorkspaces.ts`, `src-tauri/src/workspaces/commands.rs`, `src-tauri/src/shared/workspaces_core.rs`, `src-tauri/src/shared/workspaces_core/*`, `src-tauri/src/shared/worktree_core.rs` |
| Change settings model/load/update | `src/features/settings/components/SettingsView.tsx`, `src/features/settings/hooks/useAppSettings.ts`, `src/services/tauri.ts`, `src-tauri/src/settings/mod.rs`, `src-tauri/src/shared/settings_core.rs`, `src-tauri/src/types.rs`, `src/types.ts` |
| Change Git/GitHub backend behavior | `src/features/git/hooks/*`, `src/services/tauri.ts`, `src-tauri/src/git/mod.rs`, `src-tauri/src/shared/git_ui_core.rs`, `src-tauri/src/shared/git_ui_core/*`, `src-tauri/src/shared/git_core.rs`, `src-tauri/src/bin/codex_monitor_daemon/rpc.rs`, `src-tauri/src/bin/codex_monitor_daemon/rpc/git.rs` |
| Change prompts CRUD/listing behavior | `src/features/prompts/hooks/useCustomPrompts.ts`, `src/features/prompts/components/PromptPanel.tsx`, `src/services/tauri.ts`, `src-tauri/src/prompts.rs`, `src-tauri/src/shared/prompts_core.rs`, `src-tauri/src/bin/codex_monitor_daemon/rpc.rs` |
| Change file read/write for Agents/config | `src/services/tauri.ts`, `src-tauri/src/files/mod.rs`, `src-tauri/src/shared/files_core.rs`, `src-tauri/src/bin/codex_monitor_daemon/rpc.rs` |
| Add/change daemon JSON-RPC surface | `src-tauri/src/bin/codex_monitor_daemon/rpc.rs`, `src-tauri/src/bin/codex_monitor_daemon/rpc/*`, `src-tauri/src/bin/codex_monitor_daemon.rs`, matching shared core |

## Frontend Navigation

- Composition root: `src/App.tsx`
- App bootstrap orchestration: `src/features/app/bootstrap/*`
- App layout/thread/workspace orchestration: `src/features/app/orchestration/*`
- Tauri IPC wrapper: `src/services/tauri.ts`
- Tauri event hub (single-listener fanout): `src/services/events.ts`
- Event subscription hook: `src/features/app/hooks/useTauriEvent.ts`
- App-server event router: `src/features/app/hooks/useAppServerEvents.ts`
- Shared frontend types: `src/types.ts`

### Import Aliases

Use TS/Vite aliases for refactor-safe imports:

- `@/*` -> `src/*`
- `@app/*` -> `src/features/app/*`
- `@settings/*` -> `src/features/settings/*`
- `@threads/*` -> `src/features/threads/*`
- `@services/*` -> `src/services/*`
- `@utils/*` -> `src/utils/*`

### Threads

- Orchestrator: `src/features/threads/hooks/useThreads.ts`
- Reducer composition entrypoint: `src/features/threads/hooks/useThreadsReducer.ts`
- Reducer slices: `src/features/threads/hooks/threadReducer/*`
- Event-focused handlers: `src/features/threads/hooks/useThreadEventHandlers.ts`, `src/features/threads/hooks/useThreadTurnEvents.ts`, `src/features/threads/hooks/useThreadItemEvents.ts`, `src/features/threads/hooks/useThreadApprovalEvents.ts`, `src/features/threads/hooks/useThreadUserInputEvents.ts`
- Message send/steer/interrupt: `src/features/threads/hooks/useThreadMessaging.ts`
- Persistence/local thread metadata: `src/features/threads/hooks/useThreadStorage.ts`, `src/features/threads/utils/threadStorage.ts`

### Workspaces

- Workspace state and lifecycle: `src/features/workspaces/hooks/useWorkspaces.ts`
- Workspace home behavior: `src/features/workspaces/hooks/useWorkspaceHome.ts`
- Workspace file list and reads in app layer: `src/features/app/hooks/useWorkspaceFileListing.ts`, `src/features/workspaces/hooks/useWorkspaceFiles.ts`

### Settings

- Main settings surface: `src/features/settings/components/SettingsView.tsx`
- Settings state + persistence flow: `src/features/settings/hooks/useAppSettings.ts`, `src/features/app/hooks/useAppSettingsController.ts`
- Typed settings contracts: `src/types.ts`

### Git

- Git UI hooks: `src/features/git/hooks/*`
- Git panel components: `src/features/git/components/*`
- Branch workflows: `src/features/git/hooks/useGitBranches.ts`, `src/features/git/hooks/useBranchSwitcher.ts`

### Prompts

- Prompt UI and workflow: `src/features/prompts/components/PromptPanel.tsx`, `src/features/prompts/hooks/useCustomPrompts.ts`

### Image attachment drops

- Native event fanout: `src/services/dragDrop.ts`. The `WebviewWindow` event target accepts both window and webview routes where native drops are enabled. On macOS, `src-tauri/tauri.macos.conf.json` delegates file drops to WebKit so screenshot promises can arrive as HTML files. `src/services/dragDrop.test.ts` checks event routing and preservation of the other window defaults.
- Conversation targeting, paste, and import state: `src/features/composer/hooks/useComposerImageDrop.ts`; `ChatPane.tsx` declares the drop boundary. `ComposerInput.tsx` shows progress/errors and prevents sending before an import finishes.
- macOS sidebar directory paths: `src-tauri/src/image_drop.rs`, registered in `src-tauri/src/lib.rs` and wrapped by `resolveDroppedDirectories` in `src/services/tauri.ts`. This app-only command matches existing directories from the drag pasteboard to the current HTML drop's filenames; it excludes the general clipboard and remote browser. `useWorkspaceDropZone.ts` supports both native paths and HTML directory entries. Images and file-promise export are handled by WebKit and the composer, with no native image-import IPC or daemon RPC equivalent.

## Backend App (Tauri) Navigation

- Command registry (what frontend can invoke): `src-tauri/src/lib.rs`
- Codex adapters: `src-tauri/src/codex/mod.rs`
- Workspace/worktree adapters: `src-tauri/src/workspaces/commands.rs`
- Git adapters: `src-tauri/src/git/mod.rs`
- Settings adapters: `src-tauri/src/settings/mod.rs`
- Prompts adapters: `src-tauri/src/prompts.rs`
- File adapters: `src-tauri/src/files/mod.rs`
- Event emission implementation: `src-tauri/src/event_sink.rs`
- Event payload definitions: `src-tauri/src/backend/events.rs`

## Daemon Navigation

- Daemon entrypoint and state/wiring: `src-tauri/src/bin/codex_monitor_daemon.rs`
- Daemon lifecycle CLI (headless start/stop/status): `src-tauri/src/bin/codex_monitor_daemonctl.rs`
- Daemon JSON-RPC dispatcher/router: `src-tauri/src/bin/codex_monitor_daemon/rpc.rs`
- Daemon domain handlers: `src-tauri/src/bin/codex_monitor_daemon/rpc/*`
- Daemon transport: `src-tauri/src/bin/codex_monitor_daemon/transport.rs`

When adding a new method, keep method names and payload shape aligned with `src/services/tauri.ts` and app commands in `src-tauri/src/lib.rs`.

## Shared Cores (Source of Truth)

All cross-runtime domain behavior belongs in `src-tauri/src/shared/*`:

- Codex threads/approvals/account/skills/config: `src-tauri/src/shared/codex_core.rs`
- Codex helper commands: `src-tauri/src/shared/codex_aux_core.rs`
- Codex update/version helpers: `src-tauri/src/shared/codex_update_core.rs`
- Workspaces/worktrees: `src-tauri/src/shared/workspaces_core.rs`, `src-tauri/src/shared/workspaces_core/*`, `src-tauri/src/shared/worktree_core.rs`
- Settings model/update: `src-tauri/src/shared/settings_core.rs`
- Files read/write: `src-tauri/src/shared/files_core.rs`
- Git and GitHub logic: `src-tauri/src/shared/git_core.rs`, `src-tauri/src/shared/git_ui_core.rs`, `src-tauri/src/shared/git_ui_core/*`
- Prompts CRUD/listing: `src-tauri/src/shared/prompts_core.rs`
- Usage snapshot and aggregation: `src-tauri/src/shared/local_usage_core.rs`
- Process helpers: `src-tauri/src/shared/process_core.rs`

## Events Map (Backend -> Frontend)

- Backend emits through sink: `src-tauri/src/event_sink.rs`
- App-server event name: `app-server-event`
- Terminal event names: `terminal-output`, `terminal-exit`
- Frontend fanout hubs: `src/services/events.ts`
- Frontend routing into thread state: `src/features/app/hooks/useAppServerEvents.ts` -> thread hooks/reducer under `src/features/threads/hooks/*`

If event payload format changes, update parser/guards first in `src/utils/appServerEvents.ts`.

## Type Contract Files

Keep Rust and TypeScript contracts in sync:

- Rust backend types: `src-tauri/src/types.rs`
- Frontend types: `src/types.ts`

This is required for settings, workspace metadata, app-server payload handling, and RPC response decoding.


## Embedded desktop browser

- UI, annotation state and formatting: `src/features/browser/*`.
- Website navigation and snapshots: `src-tauri/src/browser/*`. Apple Silicon builds with `chromium-browser` use Chromium for website content and WKWebView for the app UI. Other builds use the system webview for both.
- MRN Local Chromium packaging: `python3 scripts/build-mrn-local-chromium.py` uses the local Tauri configuration and Codex home. The packaged framework and sandboxed helpers must accompany the app. The build command produces a signed bundle in `src-tauri/target/debug/bundle/macos/`.
- IPC wrappers and events: `src/services/tauri.ts`, `src/services/events.ts`.
- Desktop split view: `src/features/layout/components/DesktopLayout.tsx`.
- Browser web content has no Tauri capability grants; its bounded selection bridge only accepts an annotation after the user enables selection. Feedback is added to the composer draft by an explicit user action.
- Browser commands run in the local desktop app, including when Codex uses a remote daemon. They intentionally have no daemon RPC equivalent.
- Each browser engine keeps its own website sessions. Chromium stores encrypted cookies in its app-specific profile and uses a dedicated macOS Keychain entry. Browser extension hosting and verified 1Password autofill are unavailable.

- Native window actions use `get_window("main")`; `get_webview_window("main")` stops matching after the embedded browser is added. Dock reopen, tray, and menu actions must work with multiple webviews.


## Project directory and project home

- Project sorting and activity rollups: `src/features/workspaces/domain/projectActivity.ts`. Clone and worktree activity rolls up to the parent project for project order and hidden-project summaries.
- Automatic Active Threads selection: `src/features/workspaces/domain/activeThreads.ts`. Running/reviewing chats appear first; up to six other chats updated in the last seven days follow them. `ActiveThreads.tsx` shows the thread title above a smaller owning-project label and opens the chat in its actual workspace. The area appears in every organization mode and excludes hidden projects/chats.
- Active Threads unread indicator: idle chats with unread results show an accent dot and **Finished · unread**. `useThreadReadState.ts` under `src/features/threads/hooks/` persists unread flags locally, marks unseen turn completions, and acknowledges the selected chat when the window is visible and focused. Selecting or continuing a chat clears its unread flag. Imported turn snapshots arrive through `useHistorySyncEvents.ts`; completed-turn identities persist to prevent renames or repeated snapshots from restoring a read badge. Locally resumed chats retain runtime ownership. Running/reviewing states take precedence; recent-list limits and dismissals are unchanged.
- Sidebar clock, saved project order, and active-thread dismissals: `src/features/app/hooks/useSidebarProjects.ts`. Group membership is independent of the active list and sorting. The existing collapse preference for the active area is retained.
- Project colors: `useProjectColors.ts` stores local project assignments and named custom colors, synchronizing mounted consumers and window storage events through a shared external store. `SettingsProjectColors.tsx` under `src/features/settings/components/sections/` provides palette creation/removal; `SettingsProjectsSection.tsx` provides per-project color selectors. `useSidebarMenus.ts` exposes the same palette under **Project color**. `utils/sidebarColors.ts` validates hex colors and supplies styles to `WorkspaceCard.tsx` and `ActiveThreads.tsx`; existing preset IDs remain valid. Tints in `src/styles/sidebar.css` use the theme surface, tone down arbitrary custom colors to preserve contrast, and switch to an opaque base with reduced transparency. Removing a custom color clears only assignments of that color.
- Active Threads removal uses the row's remove button or its thread context menu in `useSidebarMenus.ts`. `useSidebarProjects.ts` stores the removed chat's latest timestamp with its workspace/thread key and excludes it before selecting the six recent entries. Newer activity in that chat makes it eligible again; sibling chats, normal groups, and agents are unaffected. Existing project dismissals remain honored until a chat receives newer activity.
- Sidebar group drag/keyboard sorting: `src/features/app/hooks/useWorkspaceGroupSort.ts`, `SidebarWorkspaceGroups.tsx`, and `WorkspaceGroup.tsx`. Reorders save existing `WorkspaceGroup.sortOrder` through `useWorkspaceGroupOps.ts`; all configured groups, including empty/hidden groups, retain their metadata. The same ordering serves the Settings up/down controls.
- Project information UI and unsaved drafts: `src/features/workspaces/components/ProjectInfoCard.tsx`, `src/features/workspaces/hooks/useProjectInfo.ts`. Saved details use optional `WorkspaceSettings.projectInfo` in the shared Rust/TypeScript model and existing settings IPC/daemon routes. Notes are reference material; agent instructions remain in AGENTS.md.
- Project connection discovery: `src-tauri/src/shared/workspaces_core/project_discovery.rs` and `project_discovery/mainwp.rs`. The `discover_project` app/daemon command returns only selected evidence fields; it never returns raw manifests, SSH configuration, or downstream credential errors. Discovery snapshots and manual overrides persist with project information. WordPress hosting suggestions reflect configured providers; SSH is not logged into. MainWP discovery uses the global MCP configuration and a nonempty exact-site sync, with no credential or lower-level access fallback.
- Project website actions use one-time navigation requests through `useBrowserPanel` and `BrowserPanel`; links open in the embedded desktop browser.
- Hosting discovery prefers recognized live provider headers over manifest suggestions. Public probes use an origin-only HEAD request, verified TLS, pinned public DNS, no proxy, no credentials, and no redirects. Generic CDN headers alone do not identify the origin host.
- Project time reports: `ProjectTimeCard.tsx`, `useProjectTime.ts`, and `domain/projectTime.ts` under `src/features/workspaces/`, styled by `src/styles/project-time.css`. The additive `project_time_snapshot` IPC/daemon method requires a workspace ID and uses `src-tauri/src/shared/project_time_core.rs`. It reads plain/zstd local rollouts, includes archived and older resumed sessions, unions duplicate intervals within each thread, splits durations at local midnight, and clips totals to the requested range. Recorded task/abort timing takes priority over legacy activity estimates; unfinished turns stop at their last logged agent activity. Project families include clones/worktrees; the most specific configured workspace path owns a transcript. Human-time multipliers persist per workspace in frontend local storage.


## Reviewed Git project setup

- Shared inspection and initialization: `src-tauri/src/shared/git_ui_core/setup.rs`; fixture-based coverage: `setup_tests.rs`. Preview writes only to an owned temporary Git directory. Initialization requires the current review fingerprint, appends proposed rules to the existing `.gitignore`, stages only the reviewed paths, and verifies the resulting initial commit.
- Whole WordPress installations require selecting a source folder; source-folder suggestions cover themes and plugins. Existing repositories, paths outside the workspace, stale reviews, missing Git identity, and unresolved credential findings prevent initialization. Common credential checks return paths/reasons without matching values; they are not an exhaustive secrets audit.
- App and daemon expose `preview_git_init` and the additive `setup` selection on `init_git_repo` through shared `git_rpc` request types. Legacy `force` does not bypass review.
- UI: `useInitGitRepoPrompt`, `InitGitRepoPrompt`, and `useGitActions`. Setup defaults to local-only. GitHub creation/push is an explicit option; failed initialization prevents publishing, and a remote retry does not repeat local initialization.


## Sidebar project visibility

- Local sidebar visibility preference and project-family filtering: `src/features/app/hooks/useProjectVisibility.ts`. Hidden project IDs persist in app-local storage; saved workspace metadata, chats, connections, and running agents are unchanged.
- Shared project ownership traversal for clones/worktrees and activity: `src/features/workspaces/domain/projectHierarchy.ts`.
- Right-click a project in its regular group to hide it. `HiddenProjects.tsx` restores individual projects or all projects through the always-visible Hidden projects control.
- Hidden rows are grouped from the same project inventory used by the badge, with an Ungrouped fallback when group metadata is unavailable. Hidden search is independent of conversation search and starts empty whenever the view opens.
- `Sidebar.tsx` filters hidden project families before building group rows, Active Threads, pinned chats, search results, thread-only views, and project choices for new chats. Global project data remains available outside the sidebar.

## Automatic local Codex history imports

- Shared native worker, request protection, and change-event routing: `src-tauri/src/shared/history_sync_core.rs`.
- Embedded SQLite/rollout importer and durable recovery journal: `scripts/codex_history_sync.py`; fixture tests: `scripts/test_codex_history_sync.py`.
- App/daemon startup adapters: `src-tauri/src/lib.rs` and `src-tauri/src/bin/codex_monitor_daemon.rs`.
- Protect chats before runtime resume or mutation: `src-tauri/src/backend/app_server.rs`.
- Refresh affected sidebar lists without replacing local UI state: `src/features/app/hooks/useHistorySyncEvents.ts`, wired in `MainApp.tsx`.
- Runtime configuration and ownership rules: `docs/codex-history-import.md`.
