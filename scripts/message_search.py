"""Private, rebuildable message index. Source databases and rollouts are read-only.

The native app embeds this stdlib-only helper. A low-priority worker streams
bounded batches; independent query processes read its SQLite WAL index.
"""
import argparse
import contextlib
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import time

VERSION = 1
BATCH_BYTES = 8 * 1024 * 1024
MAX_RECORD = 8 * 1024 * 1024
MIN_FREE = 2 * 1024**3
SOURCES = {"cli", "vscode", "appServer", "unknown", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn"}


def readonly(path):
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    db.execute("pragma query_only=on")
    return db


def physical_id(path):
    return path.name.removesuffix(".zst").removesuffix(".jsonl")[-36:]


def open_rollout(path):
    if path.name.endswith(".zst"):
        from compression import zstd
        return zstd.open(path, "rb")
    return path.open("rb")


def safe_file(home, path):
    resolved = path.resolve(strict=True)
    if path.is_symlink() or not resolved.is_relative_to(home) or not resolved.is_file():
        raise ValueError("Unsafe transcript path")
    if not any(resolved.is_relative_to(home / folder) for folder in ("sessions", "archived_sessions")):
        raise ValueError("Transcript is outside the history directories")
    return resolved


@contextlib.contextmanager
def writer_lock(directory):
    # POSIX app/daemon workers share a lock. SQLite still serializes writes on Windows.
    with (directory / "writer.lock").open("a+b") as lock:
        if os.name == "posix":
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "posix":
                fcntl.flock(lock, fcntl.LOCK_UN)


class Index:
    def __init__(self, home):
        self.home = pathlib.Path(home).resolve(strict=True)
        self.directory = self.home / "monitor-message-search"
        if self.directory.is_symlink():
            raise ValueError("Unsafe search directory")
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.path = self.directory / "index.sqlite"
        for name in ("index.sqlite", "index.sqlite-wal", "index.sqlite-shm", "writer.lock", "worker.lock"):
            if (self.directory / name).is_symlink():
                raise ValueError("Unsafe search cache file")
        self.db = sqlite3.connect(self.path, timeout=3)
        self.db.row_factory = sqlite3.Row
        self.db.execute("pragma journal_mode=wal")
        self.db.execute("pragma cache_size=-8192")
        self.db.execute("pragma synchronous=normal")
        with writer_lock(self.directory):
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),
                  version INTEGER, paused INTEGER DEFAULT 0, tools INTEGER DEFAULT 0, generation INTEGER DEFAULT 0);
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, title TEXT, cwd TEXT,
                  archived INTEGER, updated_at INTEGER);
                CREATE TABLE IF NOT EXISTS segments(id TEXT PRIMARY KEY, path TEXT, signature TEXT,
                  size INTEGER, mtime INTEGER, offset INTEGER DEFAULT 0, ordinal INTEGER DEFAULT 0,
                  complete INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, error INTEGER DEFAULT 0);
                CREATE TABLE IF NOT EXISTS links(thread_id TEXT, segment_id TEXT, cutoff INTEGER,
                  PRIMARY KEY(thread_id, segment_id));
                CREATE INDEX IF NOT EXISTS links_segment ON links(segment_id);
                CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY, segment_id TEXT,
                  ordinal INTEGER, end_offset INTEGER, category TEXT, body TEXT,
                  UNIQUE(segment_id,ordinal,category));
                CREATE INDEX IF NOT EXISTS documents_category ON documents(category);
                CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(body, content=documents,
                  content_rowid=id, tokenize='trigram');
                CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
                  INSERT INTO search(rowid,body) VALUES(new.id,new.body); END;
                CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
                  INSERT INTO search(search,rowid,body) VALUES('delete',old.id,old.body); END;
            """)
            self.db.execute("insert or ignore into settings(id,version) values(1,?)", (VERSION,))
            if self.db.execute("select version from settings").fetchone()[0] != VERSION:
                raise ValueError("Search index version requires a rebuild")
            self.db.commit()
        os.chmod(self.path, 0o600)
        self.readers = {}
        self.headers = {}
        self.header_stats = {}
        self.last_inventory = 0
        self.generation = self.settings()["generation"]

    def close(self):
        for reader in self.readers.values():
            reader.close()
        self.readers.clear()
        self.db.close()

    def settings(self):
        return self.db.execute("select * from settings where id=1").fetchone()

    def meta(self, key, value):
        self.db.execute("insert or replace into metadata values(?,?)", (key, json.dumps(value)))

    def header(self, path):
        # Imported versions are immutable; native paths retain their header on append.
        key = str(path)
        stat = path.stat()
        previous = self.header_stats.get(key)
        current = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
        if previous and (previous[0] != current[0] or current[1] < previous[1] or
                         (current[1] == previous[1] and current[2] != previous[2])):
            self.headers.pop(key, None)
        self.header_stats[key] = current
        if key not in self.headers:
            with open_rollout(path) as stream:
                line = stream.readline(MAX_RECORD + 1)
            if len(line) > MAX_RECORD:
                raise ValueError("Oversized transcript header")
            record = json.loads(line)
            if record.get("type") != "session_meta":
                raise ValueError("Missing transcript header")
            self.headers[key] = {key: value for key, value in record["payload"].items()
                                 if key in {"id", "session_id", "cwd", "history_mode", "history_base", "source"}}
        return self.headers[key]

    def inventory(self):
        state_path = self.home / "state_5.sqlite"
        if not state_path.exists():
            raise ValueError("No supported local chat database")
        with contextlib.closing(readonly(state_path)) as state:
            cols = {r[1] for r in state.execute("pragma table_info(threads)")}
            title = "coalesce(nullif(name,''),title)" if "name" in cols else "title"
            rows = state.execute(f"select id,{title} as title,cwd,archived,updated_at,source,rollout_path from threads").fetchall()
        aliases = {}
        ledger = self.home / "monitor-history-sync.sqlite"
        if ledger.exists():
            with contextlib.closing(readonly(ledger)) as db:
                cols = {r[1] for r in db.execute("pragma table_info(imports)")}
                if "source_cache_id" in cols:
                    aliases = {r[0]: (r[1], r[2]) for r in db.execute("select id,cache_id,source_cache_id from imports") if r[2]}
        files = {}
        transcript_bytes = 0
        for folder in ("sessions", "archived_sessions"):
            for root, dirs, names in os.walk(self.home / folder, followlinks=False):
                dirs[:] = [d for d in dirs if not pathlib.Path(root, d).is_symlink()]
                for name in names:
                    if not (name.endswith(".jsonl") or name.endswith(".jsonl.zst")):
                        continue
                    path = pathlib.Path(root, name)
                    if path.is_symlink():
                        continue
                    transcript_bytes += path.stat().st_size
                    pid = physical_id(path)
                    if pid not in files or not name.endswith(".zst"):
                        files[pid] = path
        active_ids = set()
        active_segments = set()
        errors = 0
        referenced = {}
        for row in rows:
            if row["source"] not in SOURCES:
                continue
            tid = row["id"]
            active_ids.add(tid)
            self.db.execute("insert or replace into threads values(?,?,?,?,?)",
                            (tid, row["title"], row["cwd"], row["archived"], row["updated_at"]))
            self.db.execute("delete from links where thread_id=?", (tid,))
            try:
                path = safe_file(self.home, pathlib.Path(row["rollout_path"]))
                cutoff = None
                seen = set()
                for depth in range(256):
                    header = self.header(path)
                    pid = physical_id(path)
                    if pid in seen:
                        raise ValueError("Cyclic history")
                    seen.add(pid)
                    imported = depth == 0 and tid in aliases and aliases[tid][0] == pid
                    key = aliases[tid][1] if imported else pid
                    # Alias namespaces are separate from native physical IDs.
                    key = ("import:" if imported else "physical:") + key
                    stat = path.stat()
                    signature = dict(header)
                    signature.pop("session_id", None)
                    signature = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
                    old = self.db.execute("select * from segments where id=?", (key,)).fetchone()
                    reset = old and (old["signature"] != signature or
                        (not path.name.endswith(".zst") and stat.st_size < old["offset"]) or
                        (old["path"] == str(path) and old["size"] == stat.st_size and old["mtime"] != stat.st_mtime_ns))
                    if reset:
                        self.db.execute("delete from documents where segment_id=?", (key,))
                        self.db.execute("delete from segments where id=?", (key,))
                        old = None
                    if old is None:
                        self.db.execute("insert into segments(id,path,signature,size,mtime) values(?,?,?,?,?)",
                                        (key, str(path), signature, stat.st_size, stat.st_mtime_ns))
                    else:
                        changed = old["path"] != str(path) or old["size"] != stat.st_size
                        self.db.execute("update segments set path=?,size=?,mtime=?,complete=case when ? then 0 else complete end,error=0 where id=?",
                                        (str(path), stat.st_size, stat.st_mtime_ns, changed, key))
                    self.db.execute("insert or replace into links values(?,?,?)", (tid, key, cutoff))
                    active_segments.add(key)
                    referenced[str(path)] = stat.st_size
                    base = header.get("history_base")
                    if not base:
                        break
                    cutoff = int(base["end_byte_offset"])
                    path = safe_file(self.home, files[base["thread_id"]])
                else:
                    raise ValueError("History too deep")
            except (OSError, ValueError, KeyError, ImportError):
                errors += 1
        for row in self.db.execute("select id from threads").fetchall():
            if row[0] not in active_ids:
                self.db.execute("delete from links where thread_id=?", (row[0],))
                self.db.execute("delete from threads where id=?", (row[0],))
        # Remove only unreferenced search records, never source files.
        for row in self.db.execute("select id from segments").fetchall():
            if row[0] not in active_segments:
                self.db.execute("delete from documents where segment_id=?", (row[0],))
                self.db.execute("delete from segments where id=?", (row[0],))
        self.meta("inventoryErrors", errors)
        self.meta("transcriptBytes", transcript_bytes)
        self.meta("referencedTranscriptBytes", sum(referenced.values()))
        self.meta("historyDatabaseBytes", sum(p.stat().st_size for p in self.home.glob("*sqlite*") if p.is_file()))
        self.meta("lastInventoryMs", int(time.time() * 1000))
        self.db.commit()
        self.last_inventory = time.monotonic()
        self.headers = {str(path): self.headers[str(path)] for path in files.values() if str(path) in self.headers}
        self.header_stats = {key: self.header_stats[key] for key in self.headers}

    @staticmethod
    def extract(record, tools):
        kind, payload = record.get("type"), record.get("payload", {})
        if kind == "response_item":
            if payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
                text = "\n".join(part.get("text", "") for part in payload.get("content", [])
                                 if isinstance(part, dict) and part.get("type") in ("input_text", "output_text", "text"))
                if payload["role"] == "user" and text.lstrip().startswith(("# AGENTS.md", "<environment_context>", "<permissions instructions>", "<turn_aborted>")):
                    return None
                return "message", text
            if tools and payload.get("type") in ("function_call_output", "custom_tool_call_output"):
                output = payload.get("output", "")
                return "tool", output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        # Older event-only transcripts also remain searchable. Results group by chat.
        if kind == "event_msg" and payload.get("type") in ("user_message", "agent_message"):
            text = payload.get("message", "")
            if isinstance(text, str) and not text.lstrip().startswith(("# AGENTS.md", "<environment_context>")):
                return "message", text
        return None

    @staticmethod
    def relevant_prefix(prefix, tools):
        """Do not report intentionally excluded giant tool/image records as missing messages."""
        head, separator, payload = prefix.partition(b'"payload"')
        if not separator:
            return True  # Unknown layout: retain the coverage warning.
        if re.search(rb'"type"\s*:\s*"response_item"', head):
            kind = re.search(rb'^\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"', payload)
            if not kind:
                return True
            if kind[1] == b"message":
                return bool(re.search(rb'"role"\s*:\s*"(?:user|assistant)"', payload[:2048]))
            return bool(tools and kind[1] in (b"function_call_output", b"custom_tool_call_output"))
        if re.search(rb'"type"\s*:\s*"event_msg"', head):
            return bool(re.search(rb'^\s*:\s*\{\s*"type"\s*:\s*"(?:user_message|agent_message)"', payload))
        return False

    def batch(self, budget=BATCH_BYTES):
        settings = self.settings()
        if settings["paused"]:
            return False
        if settings["generation"] != self.generation:
            for stream in self.readers.values():
                stream.close()
            self.readers.clear()
            self.headers.clear()
            self.generation = settings["generation"]
            self.last_inventory = 0
        if time.monotonic() - self.last_inventory > 30:
            self.inventory()
        self.meta("workerError", False)
        if shutil.disk_usage(self.directory).free < MIN_FREE:
            self.meta("lowDisk", True)
            self.db.commit()
            return False
        self.meta("lowDisk", False)
        segment = self.db.execute("""select s.* from segments s where complete=0 and error=0
            order by (select max(t.updated_at) from threads t join links l on t.id=l.thread_id
                      where l.segment_id=s.id) desc, s.offset limit 1""").fetchone()
        if segment is None:
            self.meta("lastIndexedMs", int(time.time() * 1000))
            self.db.commit()
            return False
        key = segment["id"]
        reader_key = (key, segment["path"], settings["generation"])
        offset, ordinal = segment["offset"], segment["ordinal"]
        start_offset = offset
        skipped = segment["skipped"]
        start = time.monotonic()
        try:
            if reader_key not in self.readers:
                # Keep just one stream open. Zstd seeks decompress on resume, but
                # steady-state batches reuse the decoder rather than restarting it.
                for stream in self.readers.values():
                    stream.close()
                self.readers.clear()
                stream = open_rollout(safe_file(self.home, pathlib.Path(segment["path"])))
                stream.seek(offset)
                self.readers[reader_key] = stream
            stream = self.readers[reader_key]
            complete = False
            while offset - start_offset < budget and time.monotonic() - start < 0.6:
                line_start = offset
                line = stream.readline(MAX_RECORD + 1)
                if not line:
                    complete = True
                    break
                if not line.endswith(b"\n"):
                    if len(line) <= MAX_RECORD:
                        # The writer has not finished this record; retry on a later inventory.
                        stream.seek(line_start)
                        complete = True
                        break
                    # Oversized records are skipped with a visible incomplete-coverage warning.
                    relevant = self.relevant_prefix(line[:4096], settings["tools"])
                    while line and not line.endswith(b"\n"):
                        line = stream.readline(256 * 1024)
                    skipped += int(relevant)
                    offset = stream.tell()
                    ordinal += 1
                    continue
                offset = stream.tell()
                ordinal += 1
                try:
                    extracted = self.extract(json.loads(line), settings["tools"])
                except (ValueError, TypeError, AttributeError):
                    skipped += 1
                    continue
                if extracted and extracted[1].strip():
                    self.db.execute("insert or ignore into documents(segment_id,ordinal,end_offset,category,body) values(?,?,?,?,?)",
                                    (key, ordinal, offset, *extracted))
            self.db.execute("update segments set offset=?,ordinal=?,complete=?,skipped=? where id=?",
                            (offset, ordinal, complete, skipped, key))
            self.meta("workerHeartbeatMs", int(time.time() * 1000))
            self.meta("lastBatchMs", round((time.monotonic() - start) * 1000))
            self.db.commit()
            if complete:
                self.readers.pop(reader_key).close()
            # Finishing one small chat is still busy work while other chats remain.
            return not complete or bool(self.db.execute("select 1 from segments where complete=0 and error=0 limit 1").fetchone())
        except (OSError, ValueError, ImportError):
            self.db.rollback()
            if reader_key in self.readers:
                self.readers.pop(reader_key).close()
            self.db.execute("update segments set error=1 where id=?", (key,))
            self.db.commit()
            return True

    def status(self):
        s = self.settings()
        meta = {r[0]: json.loads(r[1]) for r in self.db.execute("select * from metadata")}
        total = self.db.execute("select count(*) from threads").fetchone()[0]
        ready = self.db.execute("""select count(*) from threads t where exists(select 1 from links where thread_id=t.id)
            and not exists(select 1 from links l join segments s on s.id=l.segment_id where l.thread_id=t.id and (s.complete=0 or s.error=1))""").fetchone()[0]
        skipped, unreadable, pending = self.db.execute("select coalesce(sum(skipped),0),coalesce(sum(error),0),coalesce(sum(complete=0),0) from segments").fetchone()
        index_bytes = sum(p.stat().st_size for p in self.directory.glob("index.sqlite*") if p.is_file())
        free = shutil.disk_usage(self.directory).free
        warnings = []
        if skipped:
            warnings.append(f"{skipped} oversized or malformed records were skipped; search coverage is incomplete.")
        if unreadable or meta.get("inventoryErrors"):
            warnings.append("Some transcript files or history ancestors could not be read; search coverage is incomplete.")
        if meta.get("workerError"):
            warnings.append("The indexer could not read the supported local history or update its cache. Check the runtime and available disk space.")
        heartbeat = meta.get("workerHeartbeatMs", meta.get("lastInventoryMs", 0))
        phase = "paused" if s["paused"] else "lowDisk" if free < MIN_FREE else "starting" if not total else "indexing" if pending or ready < total else "ready"
        if meta.get("workerError") and not s["paused"]:
            phase = "stalled"
        if not s["paused"] and pending and time.time() * 1000 - heartbeat > 90_000:
            phase = "stalled"
        return dict(phase=phase, paused=bool(s["paused"]), includeTools=bool(s["tools"]),
                    threadsTotal=total, threadsIndexed=ready,
                    messageCount=self.db.execute("select count(*) from documents where category='message'").fetchone()[0],
                    toolCount=self.db.execute("select count(*) from documents where category='tool'").fetchone()[0],
                    indexBytes=index_bytes,
                    reclaimableBytes=self.db.execute("pragma freelist_count").fetchone()[0] * self.db.execute("pragma page_size").fetchone()[0],
                    transcriptBytes=meta.get("transcriptBytes", 0),
                    referencedTranscriptBytes=meta.get("referencedTranscriptBytes", 0),
                    historyDatabaseBytes=meta.get("historyDatabaseBytes", 0), diskFreeBytes=free,
                    lastIndexedMs=meta.get("lastIndexedMs"), lastInventoryMs=meta.get("lastInventoryMs"),
                    lastBatchMs=meta.get("lastBatchMs"), warnings=warnings)

    def search(self, query, roots, include_tools=False, limit=50):
        query = query.strip()
        if len(query) < 3 or len(query) > 256 or not roots:
            return dict(results=[], elapsedMs=0, status=self.status())
        started = time.monotonic()
        self.db.set_progress_handler(lambda: int(time.monotonic() - started > 2), 1000)
        try:
            ownership = {}
            normalized = [(root, os.path.normpath(root["path"])) for root in roots]
            def owner_id(cwd):
                if cwd not in ownership:
                    candidates = [(root, path) for root, path in normalized
                                  if cwd == path or cwd.startswith(path.rstrip(os.sep) + os.sep)]
                    owner = max(candidates, key=lambda pair: len(pair[1]))[0] if candidates else None
                    ownership[cwd] = owner["id"] if owner and owner.get("allowed", True) else None
                return ownership[cwd]
            self.db.create_function("search_workspace", 1, owner_id, deterministic=True)
            params = ['"' + query.replace('"', '""') + '"', int(include_tools), max(1, min(int(limit), 100))]
            rows = self.db.execute("""WITH hits AS MATERIALIZED (
                select rowid, bm25(search) as score from search where search match ?)
                , eligible AS MATERIALIZED (select *,search_workspace(cwd) as workspace_id from threads where archived=0)
                select t.id,t.title,t.cwd,t.workspace_id,t.updated_at,d.category,d.body,min(h.score) as score
                from hits h join documents d on d.id=h.rowid join links l on l.segment_id=d.segment_id
                join eligible t on t.id=l.thread_id
                where (l.cutoff is null or d.end_offset<=l.cutoff) and t.workspace_id is not null
                and (?=1 or d.category='message')
                group by t.id order by score,t.updated_at desc limit ?""", params).fetchall()
            results = []
            for row in rows:
                body = row["body"]
                position = max(0, body.lower().find(query.lower()))
                start = max(0, position - 70)
                excerpt = re.sub(r"\s+", " ", body[start:start + 260])
                results.append(dict(threadId=row["id"], workspaceId=row["workspace_id"], title=row["title"],
                                    excerpt=("…" if start else "") + excerpt + ("…" if start + 260 < len(body) else ""),
                                    category=row["category"]))
        finally:
            self.db.set_progress_handler(None, 0)
        return dict(results=results, elapsedMs=round((time.monotonic() - started) * 1000, 1), status=self.status())

    def control(self, action):
        if action not in {"pause", "resume", "clear", "rebuild", "compact", "enableTools", "disableTools"}:
            raise ValueError("Unknown search index action")
        with writer_lock(self.directory):
            if action in {"clear", "rebuild", "enableTools", "disableTools"}:
                # Drop the derived FTS tables before truncating content. Deleting
                # every indexed token through triggers can grow the WAL by the
                # size of the old index, precisely when the user needs free space.
                # This is cache reclamation, not a secure-erasure promise.
                self.db.execute("pragma secure_delete=off")
                self.db.executescript("""BEGIN IMMEDIATE;
                    DROP TRIGGER documents_ai;
                    DROP TRIGGER documents_ad;
                    DROP TABLE search;
                    DELETE FROM documents;
                    DELETE FROM links;
                    DELETE FROM segments;
                    DELETE FROM metadata WHERE key NOT IN
                        ('transcriptBytes','referencedTranscriptBytes','historyDatabaseBytes','lastInventoryMs');
                    CREATE VIRTUAL TABLE search USING fts5(body, content=documents,
                        content_rowid=id, tokenize='trigram');
                    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
                        INSERT INTO search(rowid,body) VALUES(new.id,new.body); END;
                    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
                        INSERT INTO search(search,rowid,body) VALUES('delete',old.id,old.body); END;
                """)
                self.db.execute("update settings set generation=generation+1,paused=? where id=1", (action == "clear",))
                if action in {"enableTools", "disableTools"}:
                    self.db.execute("update settings set tools=? where id=1", (action == "enableTools",))
            elif action in {"pause", "resume"}:
                self.db.execute("update settings set paused=? where id=1", (action == "pause",))
            self.db.commit()
            if action in {"clear", "compact", "disableTools"}:
                self.db.execute("pragma wal_checkpoint(truncate)")
                self.db.execute("vacuum")
                self.db.execute("pragma wal_checkpoint(truncate)")
        return self.status()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True, type=pathlib.Path)
    parser.add_argument("--worker", action="store_true")
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    os.umask(0o077)
    index = Index(args.home)
    try:
        if args.worker:
            if hasattr(os, "nice"):
                os.nice(10)
            # One worker per profile even when app and daemon both request it.
            with (index.directory / "worker.lock").open("a+b") as lock:
                if os.name == "posix":
                    import fcntl
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        return
                while True:
                    if args.parent_pid and os.getppid() != args.parent_pid:
                        return
                    started = time.monotonic()
                    try:
                        with writer_lock(index.directory):
                            busy = index.batch()
                    except (OSError, ValueError, sqlite3.Error):
                        index.db.rollback()
                        index.meta("workerError", True)
                        index.db.commit()
                        busy = False
                    # Approximate a 25% single-core duty cycle, with a short floor
                    # between batches and low OS priority; no UI thread does this work.
                    time.sleep(max(0.1, min(2, (time.monotonic() - started) * 3)) if busy else 2)
        else:
            request = json.load(sys.stdin)
            operation = request.get("operation")
            if operation == "status":
                result = index.status()
            elif operation == "search":
                result = index.search(request.get("query", ""), request.get("roots", []), request.get("includeTools", False))
            elif operation == "control":
                result = index.control(request.get("action"))
            else:
                raise ValueError("Unknown search operation")
            print(json.dumps(result, ensure_ascii=False))
    finally:
        index.close()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Source rows, queries, and message bodies must never enter native diagnostics.
        print(json.dumps({"error": "Local message search is unavailable. Check the Python runtime, disk space, and index status."}), file=sys.stderr)
        sys.exit(1)
