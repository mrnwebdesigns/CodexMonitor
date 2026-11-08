"""One-way local history import. Source SQLite connections are always read-only.

Embedded by the native app/daemon; also runnable for inspection and fixture tests.
Only session metadata, history tables, and rollout files are copied. No config,
authentication, projects, credentials, or source files are modified.
"""

import argparse
import contextlib
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import time
import uuid

HISTORY_TABLES = (
    "thread_turns", "thread_items", "thread_history_projection_state",
    "thread_realtime_items",
)
LOCAL_COLUMNS = {
    "project_id", "thread_section_id", "is_pinned", "section_position",
    "section_entered_at_ms",
}
DERIVED_METADATA = {
    "created_at", "updated_at", "created_at_ms", "updated_at_ms", "recency_at",
    "recency_at_ms", "title", "first_user_message", "preview", "originator",
}
INTERACTIVE_SOURCES = {"cli", "vscode", "appServer", "unknown"}


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def digest(value):
    result = hashlib.sha256()
    for chunk in json.JSONEncoder(sort_keys=True, separators=(",", ":")).iterencode(value):
        result.update(chunk.encode())
    return result.hexdigest()


def read_only(path):
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=3)
    db.row_factory = sqlite3.Row
    db.execute("pragma query_only=on")
    return db


def columns(db, table, schema="main"):
    return [row[1] for row in db.execute(f"pragma {schema}.table_info({quoted(table)})")]


def rows_for(db, table, thread_id, schema="main"):
    return [dict(row) for row in db.execute(
        f"select * from {schema}.{quoted(table)} where thread_id=? order by rowid", (thread_id,)
    )]


def history_for(db, thread_id, schema="main"):
    return {table: rows_for(db, table, thread_id, schema) for table in HISTORY_TABLES}


def fingerprint(row, history):
    # Projection offsets are a cache and can advance on a read. Organization is
    # Monitor-owned. Message content, names, archive state and turns are not caches.
    metadata = {k: v for k, v in row.items() if k not in LOCAL_COLUMNS}
    return digest([metadata, {k: v for k, v in history.items()
                             if k != "thread_history_projection_state"}])


def parts(row, history):
    return [digest({k: v for k, v in row.items() if k not in LOCAL_COLUMNS}) if row else None,
            digest({k: v for k, v in history.items() if k != "thread_history_projection_state"})]


def stable_metadata(row):
    return digest({k: v for k, v in row.items() if k not in LOCAL_COLUMNS | DERIVED_METADATA})


def replace_thread(db, row, history, key, cache_id=None, source_cache_id=None):
    cache_id = cache_id or row["id"]
    names = list(row)
    updates = ",".join(f"{quoted(k)}=excluded.{quoted(k)}" for k in names if k != "id")
    db.execute(f"insert into target_state.threads({','.join(map(quoted, names))}) values ({','.join('?' for _ in names)}) on conflict(id) do update set {updates}", [row[k] for k in names])
    for table, values in history.items():
        db.execute(f"delete from target_history.{quoted(table)} where thread_id=?", (cache_id,))
        for item in values:
            keys = list(item)
            db.execute(f"insert into target_history.{quoted(table)}({','.join(map(quoted, keys))}) values ({','.join('?' for _ in keys)})", [item[k] for k in keys])
    db.execute("insert into imports(id,source_key,target_hash,owned,cache_id,source_cache_id,row_hash,stable_row_hash,cache_hash) values (?,?,?,0,?,?,?,?,?) on conflict(id) do update set source_key=excluded.source_key,target_hash=excluded.target_hash,cache_id=excluded.cache_id,source_cache_id=excluded.source_cache_id,row_hash=excluded.row_hash,stable_row_hash=excluded.stable_row_hash,cache_hash=excluded.cache_hash", (row["id"], key, fingerprint(row, history), cache_id, source_cache_id or row["id"], parts(row, history)[0], stable_metadata(row), parts(None, history)[1]))


def write_intent(target, row, history, key, old, old_history, cache_id=None, source_cache_id=None, old_cache_id=None):
    directory = target / "monitor-history-pending"
    if directory.is_symlink():
        raise ValueError("History recovery directory must not be a symlink")
    directory.mkdir(mode=0o700, exist_ok=True)
    path = directory / (row["id"] + ".json")
    temporary = directory / (uuid.uuid4().hex + ".tmp")
    payload = dict(row=row, history=history, key=key, before=parts(old, old_history),
                   after=parts(row, history), previousCwd=old["cwd"] if old else None,
                   cacheId=cache_id or row["id"], sourceCacheId=source_cache_id or row["id"],
                   oldCacheId=old_cache_id or row["id"])
    with temporary.open("x") as f:
        os.chmod(temporary, 0o600)
        json.dump(payload, f)
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(path)
    return path


def recover_pending(target, db, report):
    # Attached databases can each use WAL; SQLite cannot promise cross-database
    # crash atomicity in that mode. Replay a durable intent only if BOTH stores
    # still match their recorded before/after state. Any local edit wins instead.
    for path in (target / "monitor-history-pending").glob("*.json"):
        if path.is_symlink():
            raise ValueError("History recovery entry must not be a symlink")
        payload = json.loads(path.read_text())
        row, history = payload["row"], payload["history"]
        tid = str(uuid.UUID(row["id"]))
        cache_id = str(uuid.UUID(payload.get("cacheId", tid)))
        old_cache_id = str(uuid.UUID(payload.get("oldCacheId", tid)))
        if db.execute("select 1 from leases where id=?", (tid,)).fetchone():
            report["deferred"] += 1
            continue
        if path.stem != tid or set(history) != set(HISTORY_TABLES):
            raise ValueError("Invalid history recovery entry")
        if any(item["thread_id"] != cache_id for values in history.values() for item in values):
            raise ValueError("Mismatched thread in history recovery entry")
        rollout = Path(row["rollout_path"]).resolve(strict=True)
        if target not in rollout.parents or "monitor-imports" not in rollout.parts:
            raise ValueError("Unsafe history recovery rollout")
        db.execute("begin immediate")
        try:
            raw = db.execute("select * from target_state.threads where id=?", (tid,)).fetchone()
            current = dict(raw) if raw else None
            current_history = history_for(db, cache_id, "target_history")
            actual = parts(current, current_history)
            empty_hash = parts(None, {table: [] for table in HISTORY_TABLES})[1]
            before_new = payload["before"][1] if cache_id == old_cache_id else empty_hash
            old_untouched = cache_id == old_cache_id or parts(None, history_for(db, old_cache_id, "target_history"))[1] == payload["before"][1]
            owned = db.execute("select owned from imports where id=?", (tid,)).fetchone()
            if (owned and owned[0]) or not old_untouched or actual[0] not in (payload["before"][0], payload["after"][0]) or actual[1] not in (before_new, payload["after"][1]):
                db.execute("insert into imports(id,owned) values (?,1) on conflict(id) do update set owned=1", (tid,))
                db.commit()
                path.replace(path.with_suffix(".conflict"))
                report["conflicts"] += 1
                continue
            if current:
                for key in LOCAL_COLUMNS:
                    if key in row:
                        row[key] = current[key]
            replace_thread(db, row, history, payload["key"], cache_id, payload.get("sourceCacheId", tid))
            db.commit()
            path.unlink()
            report["recovered"] += 1
            report["changed"].append(dict(id=tid, cwd=row["cwd"], previousCwd=payload.get("previousCwd")))
        except BaseException:
            db.rollback()
            raise


def validate_profiles(source, target):
    source, target = Path(source).resolve(strict=True), Path(target).resolve(strict=True)
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("History profiles must be separate, non-overlapping directories")
    for root in (source, target):
        for prefix, supported in (("state_", 5), ("thread_history_", 1)):
            for candidate in root.glob(prefix + "*.sqlite"):
                number = candidate.stem.removeprefix(prefix)
                if number.isdigit() and int(number) > supported:
                    raise ValueError("A newer history database version needs compatibility review; import paused")
    for name in ("state_5.sqlite", "thread_history_1.sqlite"):
        for root in (source, target):
            p = root / name
            if not p.is_file() or p.is_symlink() or p.resolve().parent != root:
                raise ValueError("A supported, independent history database is required")
        if os.path.samefile(source / name, target / name):
            raise ValueError("History databases must not be shared or hard-linked")
    return source, target


@contextlib.contextmanager
def profile_lock(target):
    # All import, lease, and local-ownership operations use the same OS lock,
    # including when the desktop and daemon share a profile.
    path = target / "monitor-history-sync.lock"
    if path.is_symlink():
        raise ValueError("History lock must not be a symlink")
    with path.open("a+b") as f:
        os.chmod(path, 0o600)
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                f.write(b"0")
                f.flush()
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def ledger_open(target):
    path = target / "monitor-history-sync.sqlite"
    if path.is_symlink():
        raise ValueError("History ledger must not be a symlink")
    db = sqlite3.connect(path, timeout=3)
    db.row_factory = sqlite3.Row
    os.chmod(path, 0o600)
    db.execute("create table if not exists imports (id text primary key, source_key text, target_hash text, owned integer not null default 0)")
    for column in ("cache_id", "source_cache_id", "row_hash", "stable_row_hash", "cache_hash"):
        if column not in columns(db, "imports"):
            db.execute(f"alter table imports add column {column} text")
    db.execute("create table if not exists leases (id text, pid integer, started text, primary key(id,pid))")
    if "started" not in columns(db, "leases"):
        db.execute("alter table leases add column started text")
    db.execute("create table if not exists settings (key text primary key,value text)")
    db.commit()
    return db


def protect(target, thread_id, owner_pid=None):
    if not thread_id or len(thread_id) > 200:
        raise ValueError("A valid thread id is required")
    target = Path(target).resolve(strict=True)
    with profile_lock(target), contextlib.closing(ledger_open(target)) as db:
        if owner_pid is not None:
            if owner_pid < 1:
                raise ValueError("A valid runtime PID is required")
            db.execute("insert or replace into leases(id,pid,started) values (?,?,?)", (thread_id, owner_pid, process_token(owner_pid)))
        else:
            db.execute("insert into imports(id,owned) values (?,1) on conflict(id) do update set owned=1", (thread_id,))
        db.commit()


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def process_token(pid):
    # Prevent an unrelated process reusing a former runtime PID from retaining a
    # chat lease indefinitely. Only the start time is read, never process args.
    if os.name == "nt":
        return ""
    result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    return result.stdout.strip()


def rollout_index(source):
    indexed = {}
    for folder in ("sessions", "archived_sessions"):
        for file in (source / folder).rglob("rollout-*.jsonl*"):
            name = file.name.removesuffix(".zst").removesuffix(".jsonl")
            tid = name[-36:]
            try:
                uuid.UUID(tid)
            except ValueError:
                continue
            indexed.setdefault(tid, []).append(file)
    return indexed


def safe_rollout(source, row, indexed=None):
    raw = Path(row["rollout_path"])
    if raw.is_symlink() or source not in raw.resolve().parents:
        raise ValueError("Rollout must stay within the source profile")
    if not raw.is_file():
        compressed = Path(str(raw) + ".zst")
        if compressed.is_file():
            raw = compressed
        elif indexed:
            candidates = indexed.get(row["id"], [])
            preferred = "archived_sessions" if row["archived"] else "sessions"
            candidates = sorted(candidates, key=lambda p: (p.relative_to(source).parts[0] != preferred, p.name.endswith(".zst")))
            if candidates:
                raw = candidates[0]
    path = raw.resolve(strict=True)
    if raw.is_symlink() or source not in path.parents or not path.is_file():
        raise ValueError("Rollout must be a regular file within the source profile")
    relative = path.relative_to(source)
    if relative.parts[0] not in {"sessions", "archived_sessions"}:
        raise ValueError("Rollout is outside the session directories")
    if not (path.name.endswith(".jsonl") or path.name.endswith(".jsonl.zst")):
        raise ValueError("Unsupported rollout format")
    return path


def copy_rollout(source_file, target, row):
    # A new immutable version is published first; database pointers switch only
    # inside the transaction. A crash cannot overwrite the previous rollout.
    folder = "archived_sessions" if row["archived"] else "sessions"
    directory = target / folder / "monitor-imports" / row["id"] / uuid.uuid4().hex
    if directory.resolve().is_relative_to(target) is False:
        raise ValueError("Unsafe rollout destination")
    directory.mkdir(mode=0o700, parents=True)
    destination = directory / source_file.name
    before = source_file.stat()
    if sys.platform == "darwin":
        result = subprocess.run(["/bin/cp", "-c", str(source_file), str(destination)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if result.returncode:
            shutil.copyfile(source_file, destination)
    else:
        shutil.copyfile(source_file, destination)
    os.chmod(destination, 0o600)
    after = source_file.stat()
    if source_file.name.endswith(".zst") and (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        destination.unlink()
        raise ValueError("Compressed rollout changed during import; retry on next pass")
    if source_file.name.endswith(".jsonl"):
        # Ignore an unfinished writer's final line; never publish broken JSONL.
        with destination.open("r+b") as f:
            end = min(before.st_size, destination.stat().st_size)
            while end:
                start = max(0, end - 65536)
                f.seek(start)
                chunk = f.read(end - start)
                found = chunk.rfind(b"\n")
                if found >= 0:
                    end = start + found + 1
                    break
                end = start
            f.truncate(end)
            f.flush()
            os.fsync(f.fileno())
    return destination


def legacy_is_prefix(old, new):
    if not old.is_file() or old.is_symlink():
        return False
    with old.open("rb") as a, new.open("rb") as b:
        while True:
            chunk = a.read(65536)
            if not chunk:
                return True
            if chunk != b.read(len(chunk)):
                return False


def can_adopt(row, old, source_history, target_history, source_file):
    # Existing snapshot imports have no ledger. Adopt only demonstrably shared
    # history; never resolve a content conflict by choosing a newer timestamp.
    if row["history_mode"] != old["history_mode"]:
        return False
    for table in ("thread_items", "thread_realtime_items"):
        source_items = {digest(item) for item in source_history[table]}
        if any(digest(item) not in source_items for item in target_history[table]):
            return False
    old_turns = {turn["turn_id"] for turn in target_history["thread_turns"]}
    new_turns = {turn["turn_id"] for turn in source_history["thread_turns"]}
    if not old_turns.issubset(new_turns):
        return False
    if row["history_mode"] == "legacy":
        return legacy_is_prefix(Path(old["rollout_path"]), source_file)
    return bool(target_history["thread_items"] or target_history["thread_turns"])


def source_key(row, db, file, cache_id=None):
    signatures = []
    for table in HISTORY_TABLES:
        cols = columns(db, table)
        ordinal = "updated_at_ordinal" if "updated_at_ordinal" in cols else "rollout_ordinal"
        if ordinal not in cols:
            ordinal = "next_rollout_ordinal"
        signatures.append(tuple(db.execute(
            f"select count(*),max({quoted(ordinal)}) from {quoted(table)} where thread_id=?", (cache_id or row["id"],)
        ).fetchone()))
    stat = file.stat()
    return digest(["lineage-v2", row, signatures, stat.st_size, stat.st_mtime_ns])


def open_rollout(path):
    if path.name.endswith(".zst"):
        try:
            from compression import zstd
        except ImportError as error:
            raise ValueError("Compressed lineage imports require Python 3.14 zstd support") from error
        return zstd.open(path, "rb")
    return path.open("rb")


def rollout_meta(path):
    try:
        with open_rollout(path) as stream:
            first = stream.readline(8 * 1024 * 1024)
        record = json.loads(first)
        return first, record.get("payload", {}) if record.get("type") == "session_meta" else {}
    except Exception as error:
        raise ValueError("Source rollout metadata could not be read") from error


def physical_id(path, fallback):
    name = path.name.removesuffix(".zst").removesuffix(".jsonl")
    candidate = name[-36:]
    try:
        return str(uuid.UUID(candidate))
    except ValueError:
        return fallback


def lineage_nodes(source, primary, indexed, tid):
    result, seen = [], set()
    file, cutoff = primary, None
    for _ in range(256):
        first, meta = rollout_meta(file)
        pid = physical_id(file, tid)
        if pid in seen:
            raise ValueError("Cycle in source history lineage")
        seen.add(pid)
        result.append(dict(file=file, first=first, meta=meta, physical=pid, cutoff=cutoff))
        base = meta.get("history_base")
        if not base:
            return result
        parent = str(uuid.UUID(base["thread_id"]))
        candidates = sorted(indexed.get(parent, []), key=lambda p: p.name.endswith(".zst"))
        if not candidates:
            raise ValueError("A source history ancestor is missing")
        file = safe_rollout(source, {"rollout_path": str(candidates[0]), "id": parent, "archived": 0}, indexed)
        cutoff = base
    raise ValueError("Source history lineage is too deep")


def remap_header(first, alias, parent_alias):
    # UUID substitutions are exactly 36 ASCII bytes, retaining every source byte
    # offset and ordinal. Logical chat IDs and all message bodies are unchanged.
    result = re.sub(rb'("session_id"\s*:\s*")[0-9a-fA-F-]{36}(\")',
                    lambda match: match[1] + alias.encode() + match[2], first, count=1)
    if parent_alias:
        result, count = re.subn(rb'("history_base"\s*:\s*\{[^}]*"thread_id"\s*:\s*")[0-9a-fA-F-]{36}(\")',
                               lambda match: match[1] + parent_alias.encode() + match[2], result, count=1)
        if count != 1:
            raise ValueError("Cannot preserve the source lineage header layout")
    if len(result) != len(first):
        raise ValueError("Lineage header byte offsets would change")
    return result


def copy_lineage_node(node, destination, alias, parent_alias, limit=None):
    if destination.exists():
        if destination.is_symlink() or not destination.is_file():
            raise ValueError("Imported lineage must be a regular file")
        if limit is not None and destination.stat().st_size != limit:
            raise ValueError("An independent history ancestor has changed")
        return
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    header = remap_header(node["first"], alias, parent_alias)
    if limit is not None and limit < len(header):
        raise ValueError("Invalid history lineage cutoff")
    temporary = destination.with_name(uuid.uuid4().hex + ".tmp")
    try:
        if node["file"].name.endswith(".zst"):
            with open_rollout(node["file"]) as source, temporary.open("xb") as out:
                original = source.readline(8 * 1024 * 1024)
                if original != node["first"]:
                    raise ValueError("Source lineage header changed during import")
                out.write(header)
                remaining = None if limit is None else limit - len(header)
                while remaining is None or remaining > 0:
                    chunk = source.read(1024 * 1024 if remaining is None else min(remaining, 1024 * 1024))
                    if not chunk:
                        if remaining:
                            raise ValueError("Source history cutoff exceeds the available rollout")
                        break
                    out.write(chunk)
                    if remaining is not None:
                        remaining -= len(chunk)
                out.flush(); os.fsync(out.fileno())
        else:
            copied = False
            if sys.platform == "darwin":
                copied = subprocess.run(["/bin/cp", "-c", str(node["file"]), str(temporary)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            if not copied:
                shutil.copyfile(node["file"], temporary)
            with temporary.open("r+b") as out:
                if limit is not None and limit > temporary.stat().st_size:
                    raise ValueError("Source history cutoff exceeds the available rollout")
                out.write(header)
                if limit is not None:
                    out.truncate(limit)
                out.flush(); os.fsync(out.fileno())
        os.chmod(temporary, 0o600)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def copy_lineage(source, target, row, nodes, history):
    primary_alias = str(uuid.uuid4())
    aliases = {}
    for index, node in enumerate(nodes):
        aliases[node["physical"]] = primary_alias if index == 0 else str(uuid.uuid5(
            uuid.NAMESPACE_URL, str(source) + ":" + node["physical"] + ":" + json.dumps(node["cutoff"], sort_keys=True)))
    primary = None
    for index in range(len(nodes) - 1, -1, -1):
        node = nodes[index]
        alias = aliases[node["physical"]]
        parent = node["meta"].get("history_base")
        parent_alias = aliases[parent["thread_id"]] if parent else None
        stem = node["file"].name.removesuffix(".zst").removesuffix(".jsonl")
        # Canonical timestamp and logical owner stay intact; only physical IDs
        # change. The engine resolves ancestors by their unique physical ID.
        owner_stem = stem.rsplit("_", 1)[0] if "_" in stem else stem
        filename = owner_stem + "_" + alias + ".jsonl"
        if index == 0:
            folder = "archived_sessions" if row["archived"] else "sessions"
            destination = target / folder / "monitor-imports" / row["id"] / primary_alias / filename
            projection = history["thread_history_projection_state"]
            limit = projection[0]["next_rollout_byte_offset"] if projection and projection[0]["next_rollout_byte_offset"] else None
            primary = destination
        else:
            destination = target / "sessions/monitor-lineage" / alias / filename
            limit = node["cutoff"]["end_byte_offset"]
        if not destination.resolve().is_relative_to(target):
            raise ValueError("Unsafe independent lineage destination")
        copy_lineage_node(node, destination, alias, parent_alias, limit)
    mapped = {table: [dict(item, thread_id=primary_alias) for item in values] for table, values in history.items()}
    return primary, mapped, primary_alias


def backup_once(target, db):
    if db.execute("select 1 from settings where key='backup'").fetchone():
        return
    backup = target / "monitor-history-backups" / time.strftime("%Y%m%d-%H%M%S")
    backup.mkdir(mode=0o700, parents=True)
    for name in ("state_5.sqlite", "thread_history_1.sqlite"):
        with contextlib.closing(read_only(target / name)) as original:
            with contextlib.closing(sqlite3.connect(backup / name)) as saved:
                original.backup(saved, pages=4096)
        os.chmod(backup / name, 0o600)
    db.execute("insert into settings values ('backup',?)", (str(backup),))
    db.commit()


def sync(source, target, apply=False, thread_ids=None):
    source, target = validate_profiles(source, target)
    report = dict(mode="one_way", imported=0, updated=0, unchanged=0, protected=0,
                  deferred=0, conflicts=0, recovered=0, changed=[], checkedAtMs=int(time.time() * 1000))
    if not apply:
        with contextlib.closing(read_only(source / "state_5.sqlite")) as db:
            report["available"] = db.execute("select count(*) from threads where source in ('cli','vscode','appServer','unknown')").fetchone()[0]
        return report
    with profile_lock(target), contextlib.closing(ledger_open(target)) as db, \
            contextlib.closing(read_only(source / "state_5.sqlite")) as src, \
            contextlib.closing(read_only(source / "thread_history_1.sqlite")) as history:
        expected = str(source)
        recorded = db.execute("select value from settings where key='source'").fetchone()
        if recorded and recorded[0] != expected:
            raise ValueError("History ledger belongs to a different source profile")
        for connection in (src, history):
            connection.execute("begin")
        # No silent write across incompatible migrations.
        for name, connection in (("state_5.sqlite", src), ("thread_history_1.sqlite", history)):
            with contextlib.closing(read_only(target / name)) as dest:
                tables = ("threads",) if name.startswith("state") else HISTORY_TABLES
                for table in tables:
                    if columns(connection, table) != columns(dest, table) or not columns(dest, table):
                        raise ValueError("Source and target history schemas differ; import paused")
        backup_once(target, db)
        db.execute("insert or ignore into settings values ('source',?)", (expected,))
        for lease in list(db.execute("select id,pid,started from leases")):
            if not alive(lease["pid"]) or (lease["started"] and process_token(lease["pid"]) != lease["started"]):
                db.execute("delete from leases where id=? and pid=?", (lease["id"], lease["pid"]))
        db.commit()
        leased = {r[0] for r in db.execute("select distinct id from leases")}
        db.execute("attach database ? as target_state", (str(target / "state_5.sqlite"),))
        db.execute("attach database ? as target_history", (str(target / "thread_history_1.sqlite"),))
        recover_pending(target, db, report)
        indexed = rollout_index(source)
        for raw in src.execute("select * from threads order by created_at,id"):
            row = dict(raw)
            if row["source"] not in INTERACTIVE_SOURCES:
                continue
            tid = row["id"]
            if thread_ids and tid not in thread_ids:
                continue
            # UUIDs are used in paths. Source metadata cannot escape the profile.
            try:
                uuid.UUID(tid)
            except ValueError:
                report["conflicts"] += 1
                continue
            entry = db.execute("select * from imports where id=?", (tid,)).fetchone()
            if entry and entry["owned"]:
                report["protected"] += 1
                continue
            if tid in leased:
                report["deferred"] += 1
                continue
            try:
                file = safe_rollout(source, row, indexed)
                source_cache_id = physical_id(file, tid)
                key = source_key(row, history, file, source_cache_id)
            except (ValueError, FileNotFoundError):
                report["deferred"] += 1
                continue
            if entry and entry["source_key"] == key:
                report["unchanged"] += 1
                continue
            source_history = history_for(history, source_cache_id)
            try:
                nodes = lineage_nodes(source, file, indexed, tid)
            except (ValueError, FileNotFoundError):
                report["deferred"] += 1
                continue
            modern = nodes[0]["meta"].get("history_mode") == "paginated"
            old_cache_id = entry["cache_id"] if entry and entry["cache_id"] else tid
            old_path = None
            new_path = None
            try:
                # Lock the ledger and both target DBs before inspecting target
                # content; external writers cannot race the ownership check.
                db.execute("begin immediate")
                raw_old = db.execute("select * from target_state.threads where id=?", (tid,)).fetchone()
                old = dict(raw_old) if raw_old else None
                target_history = history_for(db, old_cache_id, "target_history")
                if old:
                    old_hash = fingerprint(old, target_history)
                    candidate = dict(row)
                    candidate["rollout_path"] = old["rollout_path"]
                    candidate["cwd"] = str(Path(row["cwd"]).resolve())
                    for column in LOCAL_COLUMNS:
                        if column in candidate:
                            candidate[column] = old[column]
                    comparable = {table: [dict(item, thread_id=old_cache_id) for item in values] for table, values in source_history.items()}
                    same_history = all(comparable[table] == target_history[table] for table in HISTORY_TABLES if table != "thread_history_projection_state")
                    already_independent = not modern or (entry and entry["cache_id"] and entry["cache_id"] != tid)
                    same_source_segment = not entry or (entry["source_cache_id"] or tid) == source_cache_id
                    if already_independent and same_source_segment and candidate == old and same_history:
                        db.execute("insert into imports(id,source_key,target_hash,cache_id,source_cache_id,row_hash,stable_row_hash,cache_hash) values (?,?,?,?,?,?,?,?) on conflict(id) do update set source_key=excluded.source_key,target_hash=excluded.target_hash,row_hash=excluded.row_hash,stable_row_hash=excluded.stable_row_hash,cache_hash=excluded.cache_hash", (tid, key, old_hash, old_cache_id, source_cache_id, parts(old, target_history)[0], stable_metadata(old), parts(None, target_history)[1]))
                        db.commit()
                        report["unchanged"] += 1
                        continue
                    safe = old_hash == entry["target_hash"] if entry else can_adopt(row, old, source_history, target_history, file)
                    if entry and not safe and entry["stable_row_hash"] == stable_metadata(old) and entry["cache_hash"] == parts(None, target_history)[1]:
                        # Codex can normalize timestamps/previews when indexing a
                        # copy. Those derived changes are not a local continuation.
                        safe = True
                    if entry and not safe and not entry["stable_row_hash"] and stable_metadata(candidate) == stable_metadata(old):
                        previous_source = entry["source_cache_id"] or tid
                        normalized = {table: [dict(item, thread_id=previous_source) for item in values] for table, values in target_history.items()}
                        safe = can_adopt(row, old, history_for(history, previous_source), normalized, file)
                    if entry and not safe and entry["row_hash"] == parts(old, target_history)[0]:
                        previous_source = entry["source_cache_id"] or tid
                        normalized = {table: [dict(item, thread_id=previous_source) for item in values] for table, values in target_history.items()}
                        safe = can_adopt(row, old, history_for(history, previous_source), normalized, file)
                    if not safe:
                        db.execute("insert into imports(id,owned) values (?,1) on conflict(id) do update set owned=1", (tid,))
                        db.commit()
                        report["conflicts"] += 1
                        continue
                    old_path = Path(old["rollout_path"])
                if modern:
                    new_path, source_history, cache_id = copy_lineage(source, target, row, nodes, source_history)
                else:
                    new_path = copy_rollout(file, target, row)
                    cache_id = tid
                row["rollout_path"] = str(new_path)
                row["cwd"] = str(Path(row["cwd"]).resolve())
                for column in LOCAL_COLUMNS:
                    if column in row:
                        row[column] = old[column] if old else (0 if column == "is_pinned" else None)
                intent = write_intent(target, row, source_history, key, old, target_history, cache_id, source_cache_id, old_cache_id)
                replace_thread(db, row, source_history, key, cache_id, source_cache_id)
                db.commit()
                intent.unlink()
                report["updated" if old else "imported"] += 1
                report["changed"].append(dict(id=tid, cwd=row["cwd"], previousCwd=old["cwd"] if old else None))
                # Older independent segments can be referenced by a local fork.
                # Retain them; never garbage-collect by age or filename alone.
            except BaseException:
                db.rollback()
                # Keep a staged rollout and its intent for restart recovery.
                raise
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--claim")
    parser.add_argument("--lease")
    parser.add_argument("--owner-pid", type=int)
    parser.add_argument("--thread", action="append", dest="thread_ids")
    args = parser.parse_args()
    try:
        if args.claim or args.lease:
            if args.lease and args.owner_pid is None:
                raise ValueError("A runtime PID is required for a lease")
            protect(args.target, args.claim or args.lease, args.owner_pid if args.lease else None)
            print(json.dumps({"protected": True}))
            return
        if args.source is None:
            raise ValueError("A source profile is required")
        report = sync(args.source, args.target, args.apply, args.thread_ids)
        if args.apply:
            path = args.target / "monitor-history-sync-status.json"
            temporary = path.with_name(uuid.uuid4().hex + ".tmp")
            with temporary.open("x") as f:
                f.write(json.dumps(report) + "\n")
            temporary.replace(path)
        print(json.dumps(report))
    except (OSError, ValueError, sqlite3.Error) as error:
        # Never emit SQL rows or message contents to native logs.
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
