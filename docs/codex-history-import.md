# Automatic local Codex history imports

The MRN local build imports chat history from the official local Codex profile into Monitor's independent profile. It checks at startup, before starting a workspace runtime, and every 30 seconds while Monitor runs. Work done while Monitor is closed is picked up at the next launch. No background agent, model turn, or inference is started by importing history.

## Direction and ownership

- The source profile is opened through read-only SQLite connections. Its settings, credentials, project registry, transcripts, and chat history are not edited.
- User-facing CLI, VS Code, and app-server chats are imported, including their names, working directories, archive state, paginated messages, and plain or compressed rollout files. Generic internal sub-agent jobs are excluded.
- Monitor-created chats remain local. Monitor's own project membership and pinned state are preserved.
- Resuming or forking a chat in Monitor creates a lease for that Monitor/daemon process. Imports defer that chat until the process exits, preventing replacement of history already loaded in memory. Restarting Monitor clears expired local runtime leases and catches up those chats; a daemon that remains running retains its own leases until it exits.
- Sending messages, renaming, archiving, or otherwise changing a chat in Monitor permanently marks that local copy as Monitor-owned before forwarding the request. Later imports preserve it. This is not bidirectional conversation merging.
- A legacy snapshot is adopted only when its saved history matches the source history. Conflicting local content is preserved and excluded from future imports. Source deletions do not delete local chats.

## Configuration

Imports are opt-in. The native runtime reads `monitor-history-sync.json` within its own `CODEX_HOME`. Missing configuration or `enabled: false` disables both the worker and request protection. The MRN isolated profile uses this configuration:

```json
{
  "enabled": true,
  "sourceProfile": "/Users/khofmeyer/.codex",
  "pythonBin": "/opt/homebrew/opt/python@3.14/bin/python3.14"
}
```

The embedded helper uses Python 3.14 with standard-library SQLite and Zstandard support. No third-party Python packages are needed. The script is embedded in the native binary, so the installed app does not depend on the repository's script path. The configured Python installation must remain available.

The desktop and daemon use the same shared worker and request gateway. A remote daemon imports only from a configured source profile on its own computer. The local desktop event listener does not refresh remote-backend lists from local imports.

## Consistency and recovery

- Source and target must be separate directories with independent database files. Overlapping profiles, shared database inodes, unsafe rollout paths, and incompatible database schemas pause the import.
- Supported databases are `state_5.sqlite` and `thread_history_1.sqlite`. A newer database version pauses importing until compatibility is reviewed.
- The first apply saves independent database backups under `monitor-history-backups/` in the target profile. Later passes reuse that baseline instead of copying the entire history database on every restart.
- A private ledger and OS file lock serialize imports, leases, and ownership claims across the desktop and daemon. Runtime start times prevent reused PIDs from retaining stale leases.
- Rollouts are copied into new independent versions. Database pointers change only after the copy is ready. Incomplete final JSONL records are omitted, and changing compressed files are retried on a later pass.
- Paginated chats retain their complete physical history chain. Independent physical IDs and cache partitions prevent source continuations, local continuations, and inherited prefixes from sharing writable history. Header UUID substitutions retain the original byte lengths, ordinals, and cutoff offsets; logical chat IDs and message bodies remain intact. Compressed ancestry is materialized into private plain files for the engine to read.
- Older independent segments remain available because a Monitor-created fork may still reference them. They are not removed by age or filename alone.
- Each chat has a durable recovery intent. If a restart interrupts commits across attached SQLite WAL databases, recovery replays only when both stores still match the recorded old/new state. Any later local edit wins and leaves a conflict artifact for review.
- The worker publishes affected workspace IDs after changes. Sidebar refresh preserves existing state and refreshes both project roots when a chat's working directory changes.
- Recent imported chats also publish turn ID/status metadata from their copied task lifecycle records or persisted turn rows. The private ledger retains these snapshots so the UI can recover after startup or a missed event without rereading message content or repeatedly refreshing thread lists. Completed results participate in Active Threads' **Finished · unread** indicator; continuing an imported chat clears its previous unread result. Read acknowledgments and imported-turn deduplication stay in Monitor's local UI storage. Leased and Monitor-owned chats retain their runtime state.

## Inspection and validation

The target profile contains `monitor-history-sync-status.json` with the last completed pass's counts, changed chat IDs/paths, and recent imported turn metadata. It contains no message bodies. Worker errors appear in the native diagnostic output. A successful old report is not proof that a later pass succeeded.

Preview without changing either profile:

```sh
python3 scripts/codex_history_sync.py --source /path/to/source --target /path/to/monitor-profile
```

Apply uses the same helper as the native worker. Do not run the older snapshot-import utilities over an active automatic import. An initial migration from an older Monitor build must run while that build is closed, since it does not have the runtime lease gateway.

Meaningful fixture tests cover new chats and continued messages, local divergence, runtime leases/restarts, source immutability, compression/archive moves, schema changes, and interrupted multi-database commits:

```sh
python3 -m unittest discover -s scripts -p test_codex_history_sync.py
npm run test -- src/features/app/hooks/useHistorySyncEvents.test.tsx
```

Use the repository validation matrix for frontend and native changes. Local deployment evidence is stored in `.mrn-local/history-sync-validation.json`.
