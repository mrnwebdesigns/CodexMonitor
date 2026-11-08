import hashlib
import contextlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from unittest.mock import patch

import codex_history_sync as sync


@contextlib.contextmanager
def database(path):
    with contextlib.closing(sqlite3.connect(path)) as db:
        with db:
            yield db


def create_profile(root):
    root.mkdir()
    with database(root / "state_5.sqlite") as db:
        db.execute("""create table threads (
            id text primary key, rollout_path text not null, created_at integer not null,
            updated_at integer not null, source text not null, cwd text not null,
            title text not null, name text, archived integer not null default 0,
            history_mode text not null, project_id text, thread_section_id text,
            is_pinned integer not null default 0, section_position integer,
            section_entered_at_ms integer)""")
    with database(root / "thread_history_1.sqlite") as db:
        db.executescript("""
            create table thread_turns(thread_id text,turn_id text,rollout_ordinal integer,status text,primary key(thread_id,turn_id));
            create table thread_items(thread_id text,turn_id text,item_id text,rollout_ordinal integer,updated_at_ordinal integer,item_json text,primary key(thread_id,turn_id,item_id));
            create table thread_realtime_items(thread_id text,item_id text,rollout_ordinal integer,item_json text,primary key(thread_id,item_id));
            create table thread_history_projection_state(thread_id text primary key,next_rollout_ordinal integer,next_rollout_byte_offset integer);
        """)


def add_thread(profile, tid=None, text="Synthetic message", mode="paginated", compressed=False):
    tid = tid or str(uuid.uuid4())
    folder = profile / "sessions/2026/11/07"
    folder.mkdir(parents=True, exist_ok=True)
    file = folder / (f"rollout-test-{tid}.jsonl" + (".zst" if compressed else ""))
    body = (json.dumps({"text": text}) + "\n").encode()
    if compressed:
        from compression import zstd
        body = zstd.compress(body)
    file.write_bytes(body)
    with database(profile / "state_5.sqlite") as db:
        db.execute("insert into threads(id,rollout_path,created_at,updated_at,source,cwd,title,name,history_mode,project_id,is_pinned) values (?,?,1,1,'vscode',?,'Old title','Old name',?,'source-project',1)",
                   (tid, str(file), str(profile / "project"), mode))
    if mode == "paginated":
        append_turn(profile, tid, 1, text)
    return tid


def append_turn(profile, tid, ordinal, text):
    with database(profile / "thread_history_1.sqlite") as db:
        db.execute("insert into thread_turns values (?,?,?,'completed')", (tid, f"turn-{ordinal}", ordinal))
        db.execute("insert into thread_items values (?,?,?,?,?,?)", (tid, f"turn-{ordinal}", f"item-{ordinal}", ordinal, ordinal, json.dumps({"text": text})))
    with database(profile / "state_5.sqlite") as db:
        db.execute("update threads set updated_at=updated_at+1 where id=?", (tid,))


def thread(profile, tid):
    with contextlib.closing(sync.read_only(profile / "state_5.sqlite")) as db:
        row = db.execute("select * from threads where id=?", (tid,)).fetchone()
        return dict(row) if row else None


def messages(profile, tid):
    with contextlib.closing(sync.read_only(profile / "thread_history_1.sqlite")) as db:
        return [r[0] for r in db.execute("select item_json from thread_items where thread_id=? order by rollout_ordinal", (tid,))]


class HistorySyncTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source, self.target = self.root / "source", self.root / "target"
        create_profile(self.source)
        create_profile(self.target)

    def tearDown(self):
        self.temp.cleanup()

    def run_sync(self):
        return sync.sync(self.source, self.target, True)

    def test_new_chats_preserve_monitor_chats_and_never_change_source(self):
        local = add_thread(self.target, text="Monitor-only message")
        tid = add_thread(self.source)
        (self.source / "auth.json").write_text('"dummy auth must not be copied"')
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.source.rglob("*") if p.is_file()}
        report = self.run_sync()
        self.assertEqual(report["imported"], 1)
        self.assertIsNotNone(thread(self.target, local))
        copied = thread(self.target, tid)
        self.assertEqual(messages(self.source, tid), messages(self.target, tid))
        self.assertIsNone(copied["project_id"])
        self.assertEqual(copied["is_pinned"], 0)
        self.assertFalse(os.path.samefile(thread(self.source, tid)["rollout_path"], copied["rollout_path"]))
        self.assertFalse((self.target / "auth.json").exists())
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
        self.assertTrue(list((self.target / "monitor-history-backups").glob("*/state_5.sqlite")))

    def test_new_turns_names_and_workspace_move_update_idempotently(self):
        tid = add_thread(self.source)
        self.run_sync()
        original = Path(thread(self.target, tid)["rollout_path"])
        append_turn(self.source, tid, 2, "New official Codex reply")
        with database(self.source / "state_5.sqlite") as db:
            db.execute("update threads set name='Renamed',cwd=? where id=?", (str(self.root / "new-project"), tid))
        report = self.run_sync()
        self.assertEqual(report["updated"], 1)
        self.assertEqual(len(messages(self.target, tid)), 2)
        self.assertEqual(thread(self.target, tid)["name"], "Renamed")
        self.assertEqual(report["changed"][0]["cwd"], str(self.root / "new-project"))
        self.assertTrue(original.exists())
        self.assertEqual(self.run_sync()["unchanged"], 1)

    def test_a_monitor_continuation_is_never_overwritten(self):
        tid = add_thread(self.source)
        self.run_sync()
        append_turn(self.target, tid, 2, "Keep Monitor's local work")
        append_turn(self.source, tid, 3, "Official branch")
        self.assertEqual(self.run_sync()["conflicts"], 1)
        self.assertIn("Keep Monitor", messages(self.target, tid)[-1])
        self.assertEqual(self.run_sync()["protected"], 1)

    def test_engine_timestamp_and_preview_normalization_is_not_a_local_branch(self):
        tid=add_thread(self.source)
        self.run_sync()
        with database(self.target/'state_5.sqlite') as db:
            db.execute("update threads set updated_at=99,title='Derived preview' where id=?",(tid,))
        append_turn(self.source,tid,2,'Latest official message')
        with database(self.source/'state_5.sqlite') as db:
            db.execute("update threads set name='New official name' where id=?",(tid,))
        self.assertEqual(self.run_sync()['updated'],1)
        self.assertEqual(thread(self.target,tid)['name'],'New official name')

    def test_external_local_name_change_is_preserved(self):
        tid=add_thread(self.source)
        self.run_sync()
        with database(self.target/'state_5.sqlite') as db:
            db.execute("update threads set name='Keep my local name' where id=?",(tid,))
        append_turn(self.source,tid,2,'Official update')
        self.assertEqual(self.run_sync()['conflicts'],1)
        self.assertEqual(thread(self.target,tid)['name'],'Keep my local name')

    def test_explicit_write_claim_protects_even_before_local_message_exists(self):
        tid = add_thread(self.source)
        self.run_sync()
        sync.protect(self.target, tid)
        append_turn(self.source, tid, 2, "Do not overwrite claimed chat")
        self.assertEqual(self.run_sync()["protected"], 1)
        self.assertEqual(len(messages(self.target, tid)), 1)

    def test_open_runtime_lease_defers_then_catches_up_after_restart(self):
        tid = add_thread(self.source)
        self.run_sync()
        sync.protect(self.target, tid, os.getpid())
        append_turn(self.source, tid, 2, "Arrived during the restart")
        self.assertEqual(self.run_sync()["deferred"], 1)
        with patch.object(sync, "alive", return_value=False):
            self.assertEqual(self.run_sync()["updated"], 1)
        self.assertEqual(len(messages(self.target, tid)), 2)

    def test_adopts_existing_snapshot_only_if_message_content_matches(self):
        tid = add_thread(self.source)
        add_thread(self.target, tid)
        append_turn(self.source, tid, 2, "New message after the old snapshot")
        self.assertEqual(self.run_sync()["updated"], 1)
        self.assertEqual(len(messages(self.target, tid)), 2)

    def test_divergent_existing_snapshot_is_preserved(self):
        tid = add_thread(self.source)
        add_thread(self.target, tid, text="Different local content with the same ID")
        self.assertEqual(self.run_sync()["conflicts"], 1)
        self.assertIn("Different local", messages(self.target, tid)[0])

    def test_existing_organization_is_preserved_and_archives_are_imported(self):
        tid = add_thread(self.source)
        self.run_sync()
        with database(self.target / "state_5.sqlite") as db:
            db.execute("update threads set project_id='monitor-project',is_pinned=1 where id=?", (tid,))
        with database(self.source / "state_5.sqlite") as db:
            db.execute("update threads set archived=1 where id=?", (tid,))
        self.assertEqual(self.run_sync()["updated"], 1)
        row = thread(self.target, tid)
        self.assertEqual(row["project_id"], "monitor-project")
        self.assertEqual(row["is_pinned"], 1)
        self.assertEqual(row["archived"], 1)
        self.assertIn("archived_sessions", row["rollout_path"])

    def test_legacy_prefix_is_adopted_and_partial_jsonl_line_is_trimmed(self):
        tid = add_thread(self.source, mode="legacy")
        add_thread(self.target, tid, mode="legacy")
        file = Path(thread(self.source, tid)["rollout_path"])
        with file.open("ab") as f:
            f.write(b'{"next":"complete"}\n{"unfinished":')
        self.assertEqual(self.run_sync()["updated"], 1)
        copied = Path(thread(self.target, tid)["rollout_path"]).read_bytes()
        self.assertTrue(copied.endswith(b'"complete"}\n'))
        self.assertTrue(file.read_bytes().endswith(b'{"unfinished":'))

    def test_compressed_rollouts_are_copied_without_rewriting_bytes(self):
        tid = add_thread(self.source, compressed=True)
        file = Path(thread(self.source, tid)["rollout_path"])
        from compression import zstd
        file.write_bytes(zstd.compress(b'{"synthetic":"compressed fixture"}\n'))
        self.assertEqual(self.run_sync()["imported"], 1)
        self.assertEqual(file.read_bytes(), Path(thread(self.target, tid)["rollout_path"]).read_bytes())

    def test_compression_and_archive_moves_can_leave_the_old_index_path(self):
        tid = add_thread(self.source)
        old = Path(thread(self.source, tid)["rollout_path"])
        archived = self.source / "archived_sessions" / (old.name + ".zst")
        archived.parent.mkdir()
        from compression import zstd
        archived.write_bytes(zstd.compress(old.read_bytes()))
        old.unlink()
        with database(self.source / "state_5.sqlite") as db:
            db.execute("update threads set archived=1 where id=?", (tid,))
        self.assertEqual(self.run_sync()["imported"], 1)
        self.assertEqual(archived.read_bytes(), Path(thread(self.target, tid)["rollout_path"]).read_bytes())

    def test_missing_or_external_rollout_is_deferred(self):
        tid = add_thread(self.source)
        Path(thread(self.source, tid)["rollout_path"]).unlink()
        self.assertEqual(self.run_sync()["deferred"], 1)
        self.assertIsNone(thread(self.target, tid))
        with database(self.source / "state_5.sqlite") as db:
            db.execute("update threads set rollout_path=? where id=?", (str(self.target / "state_5.sqlite"), tid))
        self.assertEqual(self.run_sync()["deferred"], 1)

    def test_shared_database_and_overlapping_profiles_are_rejected(self):
        with self.assertRaises(ValueError):
            sync.sync(self.source, self.source, True)
        (self.target / "state_5.sqlite").unlink()
        os.link(self.source / "state_5.sqlite", self.target / "state_5.sqlite")
        with self.assertRaises(ValueError):
            self.run_sync()

    def test_schema_changes_pause_without_changing_target_history(self):
        tid = add_thread(self.source)
        with database(self.source / "thread_history_1.sqlite") as db:
            db.execute("alter table thread_items add column incompatible text")
        with self.assertRaisesRegex(ValueError, "schemas differ"):
            self.run_sync()
        self.assertIsNone(thread(self.target, tid))

    def test_newer_database_versions_are_not_silently_ignored(self):
        (self.source / "state_6.sqlite").touch()
        with self.assertRaisesRegex(ValueError, "newer history database"):
            self.run_sync()

    def test_reused_runtime_pid_does_not_keep_an_old_lease(self):
        tid = add_thread(self.source)
        self.run_sync()
        with patch.object(sync, "process_token", return_value="old runtime"):
            sync.protect(self.target, tid, os.getpid())
        append_turn(self.source, tid, 2, "New Codex work")
        with patch.object(sync, "process_token", return_value="different process"):
            self.assertEqual(self.run_sync()["updated"], 1)

    def test_failed_history_write_rolls_back_thread_and_keeps_previous_rollout(self):
        tid = add_thread(self.source)
        self.run_sync()
        before = thread(self.target, tid)
        old_path = Path(before["rollout_path"])
        with database(self.target / "thread_history_1.sqlite") as db:
            db.execute("create trigger fail_import before insert on thread_items begin select raise(abort,'fixture failure'); end")
        append_turn(self.source, tid, 2, "Retry this message")
        with self.assertRaises(sqlite3.IntegrityError):
            self.run_sync()
        self.assertEqual(before, thread(self.target, tid))
        self.assertTrue(old_path.exists())
        with database(self.target / "thread_history_1.sqlite") as db:
            db.execute("drop trigger fail_import")
        self.assertEqual(self.run_sync()["recovered"], 1)

    def test_restart_recovers_a_cross_database_partial_commit(self):
        tid = add_thread(self.source)
        self.run_sync()
        append_turn(self.source, tid, 2, "Recover after an interrupted app restart")

        def half_commit(db, row, history, key, *cache_ids):
            db.execute("update target_state.threads set rollout_path=?,updated_at=? where id=?",
                       (row["rollout_path"], row["updated_at"], row["id"]))
            db.commit()
            raise OSError("simulated process death after one database committed")

        with patch.object(sync, "replace_thread", side_effect=half_commit):
            with self.assertRaises(OSError):
                self.run_sync()
        self.assertEqual(len(messages(self.target, tid)), 1)
        self.assertEqual(self.run_sync()["recovered"], 1)
        self.assertEqual(len(messages(self.target, tid)), 2)
        self.assertFalse(list((self.target / "monitor-history-pending").glob("*.json")))

    def test_recovery_preserves_a_later_local_edit(self):
        tid = add_thread(self.source)
        self.run_sync()
        append_turn(self.source, tid, 2, "Official addition")
        with patch.object(sync, "replace_thread", side_effect=OSError("interrupted")):
            with self.assertRaises(OSError):
                self.run_sync()
        append_turn(self.target, tid, 9, "A later local change must win")
        self.assertEqual(self.run_sync()["conflicts"], 1)
        self.assertIn("later local change", messages(self.target, tid)[-1])

    def test_dry_run_has_no_side_effects(self):
        add_thread(self.source)
        before = sorted(str(p.relative_to(self.target)) for p in self.target.rglob("*"))
        self.assertEqual(sync.sync(self.source, self.target)["available"], 1)
        self.assertEqual(before, sorted(str(p.relative_to(self.target)) for p in self.target.rglob("*")))

    def make_lineage(self, compressed=False):
        tid = add_thread(self.source)
        old = Path(thread(self.source, tid)["rollout_path"])
        root = old.with_name(f"rollout-2026-11-07T07-00-00-{tid}.jsonl")
        old.unlink()
        header = dict(type="session_meta", payload=dict(id=tid, session_id=tid, history_mode="paginated", history_base=None))
        root_body = (json.dumps(header) + '\n' + json.dumps({'ordinal': 1, 'synthetic': 'original message'}) + '\n').encode()
        root.write_bytes(root_body)
        if compressed:
            from compression import zstd
            packed = Path(str(root) + '.zst')
            packed.write_bytes(zstd.compress(root_body)); root.unlink(); root = packed
        physical = str(uuid.uuid4())
        head = root.with_name(f"rollout-2026-11-07T08-00-00-{tid}_{physical}.jsonl")
        head_header = dict(type="session_meta", payload=dict(id=tid, session_id=physical, history_mode="paginated", history_base=dict(thread_id=tid,end_ordinal_exclusive=2,end_byte_offset=len(root_body))))
        body = (json.dumps(head_header) + '\n' + json.dumps({'ordinal': 2, 'synthetic': 'new tail'}) + '\n').encode()
        head.write_bytes(body)
        with database(self.source/'state_5.sqlite') as db:
            db.execute('update threads set rollout_path=? where id=?',(str(head),tid))
        append_turn(self.source, physical, 2, 'Tail in its physical cache')
        with database(self.source/'thread_history_1.sqlite') as db:
            db.execute('insert into thread_history_projection_state values (?,?,?)',(physical,3,len(body)))
        return tid, physical, head, root, root_body

    def test_full_lineage_has_independent_physical_ids_and_identical_byte_offsets(self):
        tid, physical, head, root, original = self.make_lineage()
        self.assertEqual(self.run_sync()['imported'],1)
        row = thread(self.target,tid)
        target = Path(row['rollout_path'])
        first = target.read_bytes().splitlines(keepends=True)[0]
        meta = json.loads(first)['payload']
        self.assertEqual(len(first),len(head.read_bytes().splitlines(keepends=True)[0]))
        self.assertEqual(meta['id'],tid)
        self.assertNotEqual(meta['session_id'],physical)
        parent = meta['history_base']['thread_id']
        self.assertNotEqual(parent,tid)
        ancestor = next((self.target/'sessions/monitor-lineage'/parent).glob('*.jsonl'))
        self.assertEqual(ancestor.stat().st_size,meta['history_base']['end_byte_offset'])
        self.assertEqual(root.read_bytes(),original)
        self.assertEqual(messages(self.target,meta['session_id']),messages(self.source,physical))
        self.assertEqual(self.run_sync()['unchanged'],1)

    def test_compressed_lineage_is_materialized_without_changing_source(self):
        tid, _, _, root, original = self.make_lineage(compressed=True)
        packed_before = root.read_bytes()
        self.assertEqual(self.run_sync()['imported'],1)
        first = json.loads(Path(thread(self.target,tid)['rollout_path']).read_bytes().splitlines()[0])
        parent = first['payload']['history_base']['thread_id']
        copied = next((self.target/'sessions/monitor-lineage'/parent).glob('*.jsonl'))
        self.assertEqual(copied.stat().st_size,len(original))
        self.assertEqual(root.read_bytes(),packed_before)

    def test_new_tail_keeps_prior_snapshot_for_local_forks(self):
        tid, physical, head, _, _ = self.make_lineage()
        self.run_sync()
        old = Path(thread(self.target,tid)['rollout_path'])
        before = old.read_bytes()
        append_turn(self.source,physical,3,'More official work')
        with head.open('ab') as f:f.write(b'{"ordinal":3,"synthetic":"later"}\n')
        with database(self.source/'thread_history_1.sqlite') as db:
            db.execute('update thread_history_projection_state set next_rollout_ordinal=4,next_rollout_byte_offset=? where thread_id=?',(head.stat().st_size,physical))
        self.assertEqual(self.run_sync()['updated'],1)
        self.assertNotEqual(Path(thread(self.target,tid)['rollout_path']),old)
        self.assertEqual(old.read_bytes(),before)

    def test_restart_recovers_a_partial_commit_with_new_independent_cache_ids(self):
        tid, physical, head, _, _ = self.make_lineage()
        self.run_sync()
        append_turn(self.source,physical,3,'Later tail')
        with head.open('ab') as f:f.write(b'{"ordinal":3}\n')
        with database(self.source/'thread_history_1.sqlite') as db:
            db.execute('update thread_history_projection_state set next_rollout_byte_offset=? where thread_id=?',(head.stat().st_size,physical))
        def half_commit(db,row,history,key,*ids):
            db.execute('update target_state.threads set rollout_path=? where id=?',(row['rollout_path'],row['id']))
            db.commit()
            raise OSError('simulated partial commit')
        with patch.object(sync,'replace_thread',side_effect=half_commit):
            with self.assertRaises(OSError):self.run_sync()
        self.assertEqual(self.run_sync()['recovered'],1)
        with contextlib.closing(sync.read_only(self.target/'monitor-history-sync.sqlite')) as db:
            alias=db.execute('select cache_id from imports where id=?',(tid,)).fetchone()[0]
        self.assertEqual(len(messages(self.target,alias)),2)


if __name__ == "__main__":
    unittest.main()
