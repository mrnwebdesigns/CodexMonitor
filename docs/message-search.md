# Indexed message search and storage

Sidebar search retains title/project matching and adds an **In messages** section. Message search uses a private SQLite FTS5 trigram index on the connected host, with literal, case-insensitive substring queries of 3–256 characters. It returns up to 50 non-archived chats with excerpts and opens chats that are not in the currently loaded sidebar page. Hidden projects, nested project ownership, and locally hidden chats remain excluded.

## Indexing

- The app and daemon use `src-tauri/src/shared/message_search_core.rs` and the embedded, standard-library-only `scripts/message_search.py` helper. No model calls, external search service, or inference are used.
- The worker starts with the runtime and indexes local user messages and assistant replies. System/developer instructions, images, and ordinary tool output are excluded. Tool output is opt-in through the storage dashboard and requires rebuilding the index.
- SQLite source metadata and rollouts are read-only. The index lives under `monitor-message-search/` in the runtime's Codex profile, separately from source databases, transcripts, imports, and backups. It uses the configured history-import Python runtime when present, otherwise `python3`; compressed history requires Python 3.14 Zstandard support. SQLite FTS5 with the trigram tokenizer is required.
- Indexing streams bounded batches at low OS priority, with delays between batches. Queries run in separate helper processes against the WAL index. Native/UI threads do not scan transcripts.
- Native app and daemon workers share a profile lock. Worker processes exit when their owning native process exits. App/daemon requests share the same implementations and payloads.
- Metadata is refreshed about every 30 seconds. Only appended records are processed in unchanged physical history segments. Imported snapshot aliases map back to their source segment identity after checking the ledger's current cache ID, preserving indexing progress across append-only imports.
- Forked/paginated histories retain ancestor byte cutoffs. Unreferenced cache records are removed without deleting source files. Replaced/truncated segments are reindexed. Plain and compressed rollouts are supported.
- Individual records larger than 8 MiB are skipped rather than allocating unbounded memory. Skipped searchable records, malformed records, and unreadable history produce visible coverage warnings. Deliberately excluded large tool/image records do not imply missing message coverage. Results remain usable while indexing is incomplete.
- Indexing waits when the profile's volume has less than 2 GiB free and resumes automatically when space is available. The index is a rebuildable cache; it is not a backup.

## Home dashboard

**Search & storage** shows the default connected profile's index size, reusable index pages, indexed chat/message counts, progress, last inventory time, last batch duration, transcript file sizes, history database sizes, and free volume space. File sizes are logical sizes; filesystem clones can share blocks, so transcript totals are not an estimate of reclaimable physical disk space. A workspace with a separate Codex profile has a separate search index; the Home storage controls describe the default profile.

- **Pause / Resume indexing** persists across restarts. Existing indexed results remain searchable while paused.
- **Compact index** vacuums reusable index pages and checkpoints the WAL.
- **Clear index** requires confirmation, removes indexed content, reclaims cache space, and pauses indexing. It drops the derived full-text tables before clearing records, avoiding a token-by-token deletion WAL proportional to the old index. It does not immediately rebuild the removed cache. Resume to index again. This is cache cleanup, not a secure-erasure guarantee.
- **Rebuild index** requires confirmation and starts indexing from source history again.
- **Index tool output** and **Stop indexing tool output** require confirmation and rebuild with the selected scope.

None of these controls removes chats, source transcripts, retained import versions, or backups. Retained history may be shared with forks and is not labelled as safe to purge.

## Code and validation

- Helper and isolated source-immutability, lineage, incremental-import, compression, query, and cleanup tests: `scripts/message_search.py`, `scripts/test_message_search.py`.
- Shared native core: `src-tauri/src/shared/message_search_core.rs`; app adapter: `src-tauri/src/message_search.rs`; daemon dispatch: `src-tauri/src/bin/codex_monitor_daemon/rpc/workspace.rs`.
- Frontend IPC: `src/services/tauri.ts`; types, hooks, components, and tests: `src/features/search/`; styles: `src/styles/message-search.css`.
- Native wiring: `src-tauri/src/lib.rs`, `src-tauri/src/bin/codex_monitor_daemon.rs`. Sidebar integration: `Sidebar.tsx`; storage dashboard: `Home.tsx`.

Run the repository validation matrix and the helper fixtures:

```sh
python3.14 -m unittest discover -s scripts -p test_message_search.py
npm run test -- src/features/search
```

Local build, measurements, and installation evidence are recorded in `.mrn-local/message-search-validation.json`.
