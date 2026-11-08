import hashlib
import json
import pathlib
import sqlite3
import tempfile
import unittest
import uuid
from unittest import mock

from message_search import Index, physical_id


class MessageSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = pathlib.Path(self.temp.name)
        self.source = sqlite3.connect(self.home / "state_5.sqlite")
        self.source.execute("create table threads(id text primary key,title text,cwd text,archived integer,updated_at integer,source text,rollout_path text)")
        self.index = Index(self.home)

    def tearDown(self):
        self.index.close()
        self.source.close()
        self.temp.cleanup()

    def chat(self, messages, cwd="/projects/client", archived=0, base=None, tid=None):
        tid = tid or str(uuid.uuid4())
        path = self.home / "sessions" / f"rollout-{tid}.jsonl"
        path.parent.mkdir(exist_ok=True)
        header = dict(id=tid, cwd=cwd)
        if base:
            header["history_base"] = base
        rows = [dict(type="session_meta", payload=header)] + messages
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        self.source.execute("insert into threads values(?,?,?,?,?,?,?)", (tid, "Migration planning", cwd, archived, 1, "vscode", str(path)))
        self.source.commit()
        return tid, path

    def message(self, text, role="user"):
        return dict(type="response_item", payload=dict(type="message", role=role,
                    content=[dict(type="input_text" if role == "user" else "output_text", text=text)]))

    def drain(self):
        self.index.inventory()
        for _ in range(100):
            if self.index.db.execute("select count(*) from segments where complete=0 and error=0").fetchone()[0] == 0:
                break
            self.index.batch()

    def search(self, query, tools=False, roots=None):
        return self.index.search(query, roots or [dict(id="client", path="/projects/client")], tools)["results"]

    def test_domain_in_late_message_is_found_without_title_match(self):
        tid, _ = self.chat([self.message("initial request"), self.message("Check https://achelios.com/about", "assistant")])
        self.drain()
        result = self.search("ACHELIOS.COM")
        self.assertEqual([r["threadId"] for r in result], [tid])
        self.assertIn("achelios.com", result[0]["excerpt"])
        self.assertEqual(self.index.status()["threadsIndexed"], 1)

    def test_tools_are_excluded_by_default_and_require_explicit_rebuild(self):
        self.chat([self.message("public reply"), dict(type="response_item", payload=dict(type="function_call_output", output="toolonly.example"))])
        self.drain()
        self.assertEqual(self.search("toolonly.example", True), [])
        self.index.control("enableTools")
        self.drain()
        self.assertEqual(self.search("toolonly.example"), [])
        self.assertEqual(len(self.search("toolonly.example", True)), 1)

    def test_source_is_unchanged_and_clearing_only_removes_paused_index(self):
        _, path = self.chat([self.message("achelios.com " + "migration planning and verification " * 4000)])
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in (path, self.home / "state_5.sqlite")}
        self.drain()
        self.assertTrue(self.search("achelios.com"))
        before_status = self.index.status()
        before_size = before_status["indexBytes"]
        status = self.index.control("clear")
        self.assertEqual(status["phase"], "paused")
        self.assertLess(status["indexBytes"], before_size // 2)
        self.assertEqual(status["threadsTotal"], 1)
        self.assertEqual(status["threadsIndexed"], 0)
        self.assertEqual(status["transcriptBytes"], before_status["transcriptBytes"])
        self.assertEqual(status["historyDatabaseBytes"], before_status["historyDatabaseBytes"])
        self.index.batch()
        self.assertEqual(self.search("achelios.com"), [])
        for p, value in before.items():
            self.assertEqual(hashlib.sha256(p.read_bytes()).hexdigest(), value)
        self.index.control("resume")
        self.drain()
        self.assertTrue(self.search("achelios.com"))

    def test_append_and_incomplete_final_record_are_incremental(self):
        _, path = self.chat([self.message("first.example")])
        self.drain()
        offset = self.index.db.execute("select offset from segments").fetchone()[0]
        line = json.dumps(self.message("second.example")).encode()
        with path.open("ab") as f:
            f.write(line[:20])
        self.drain()
        self.assertEqual(self.index.db.execute("select offset from segments").fetchone()[0], offset)
        with path.open("ab") as f:
            f.write(line[20:] + b"\n")
        self.drain()
        self.assertEqual(len(self.search("second.example")), 1)
        self.assertEqual(self.index.status()["messageCount"], 2)

    def test_archived_and_unrequested_workspace_messages_do_not_leak(self):
        self.chat([self.message("achelios.com")], archived=1)
        self.chat([self.message("achelios.com")], cwd="/projects/client-other")
        tid, _ = self.chat([self.message("achelios.com")], cwd="/projects/client/nested")
        self.drain()
        result = self.search("achelios.com", roots=[dict(id="outer", path="/projects/client"), dict(id="inner", path="/projects/client/nested")])
        self.assertEqual([(r["threadId"], r["workspaceId"]) for r in result], [(tid, "inner")])

    def test_lineage_cutoff_prevents_future_parent_content_leaking_to_fork(self):
        parent, path = self.chat([self.message("inherited.example")])
        cutoff = path.stat().st_size
        with path.open("a") as f:
            f.write(json.dumps(self.message("lateronly.example")) + "\n")
        child, _ = self.chat([self.message("own.example")], base=dict(thread_id=physical_id(path), end_byte_offset=cutoff))
        self.drain()
        self.assertEqual({r["threadId"] for r in self.search("inherited.example")}, {parent, child})
        self.assertEqual([r["threadId"] for r in self.search("lateronly.example")], [parent])

    def test_imported_snapshot_path_change_reuses_indexed_prefix(self):
        tid, path = self.chat([self.message("before.example")])
        ledger = sqlite3.connect(self.home / "monitor-history-sync.sqlite")
        ledger.execute("create table imports(id text,cache_id text,source_cache_id text)")
        ledger.execute("insert into imports values(?,?,?)", (tid, physical_id(path), "stable-source-segment"))
        ledger.commit()
        ledger.close()
        self.drain()
        old_id, old_offset = self.index.db.execute("select id,offset from segments").fetchone()
        newer = path.with_name("rollout-" + str(uuid.uuid4()) + ".jsonl")
        newer.write_bytes(path.read_bytes() + (json.dumps(self.message("after.example")) + "\n").encode())
        self.source.execute("update threads set rollout_path=? where id=?", (str(newer), tid))
        self.source.commit()
        ledger = sqlite3.connect(self.home / "monitor-history-sync.sqlite")
        ledger.execute("update imports set cache_id=? where id=?", (physical_id(newer), tid))
        ledger.commit()
        ledger.close()
        self.index.inventory()
        self.assertEqual(tuple(self.index.db.execute("select id,offset from segments").fetchone()), (old_id, old_offset))
        self.drain()
        self.assertEqual(self.index.status()["messageCount"], 2)
        self.assertTrue(self.search("after.example"))

    def test_queries_are_literal_and_short_queries_do_not_scan(self):
        self.chat([self.message('a "quoted" domain achelios.com')])
        self.drain()
        self.assertTrue(self.search('"quoted"'))
        self.assertEqual(self.search("ac"), [])
        self.assertEqual(self.search("achelios.com OR anything"), [])
        self.assertEqual(self.index.search("achelios.com", [])["results"], [])

    def test_deleted_chat_is_removed_from_index(self):
        tid, _ = self.chat([self.message("achelios.com")])
        self.drain()
        self.source.execute("delete from threads where id=?", (tid,))
        self.source.commit()
        self.index.inventory()
        self.assertEqual(self.search("achelios.com"), [])

    def test_hidden_nested_project_is_not_reassigned_to_visible_parent(self):
        self.chat([self.message("achelios.com")], cwd="/projects/client/private")
        self.drain()
        self.assertEqual(self.search("achelios.com", roots=[dict(id="outer", path="/projects/client", allowed=True),
                         dict(id="hidden", path="/projects/client/private", allowed=False)]), [])

    def test_low_disk_space_stops_indexing(self):
        self.chat([self.message("achelios.com")])
        self.index.inventory()
        with mock.patch("message_search.shutil.disk_usage", return_value=shutil_usage(100, 99, 1)):
            self.index.batch()
            self.assertEqual(self.index.status()["phase"], "lowDisk")
        self.assertEqual(self.index.status()["messageCount"], 0)

    def test_oversized_record_does_not_hide_later_messages_or_claim_complete_coverage(self):
        self.chat([self.message("x" * 2000), self.message("achelios.com")])
        self.index.inventory()
        with mock.patch("message_search.MAX_RECORD", 256):
            self.drain()
        self.assertTrue(self.search("achelios.com"))
        self.assertIn("coverage is incomplete", self.index.status()["warnings"][0])

    def test_excluded_giant_tool_output_is_not_a_missing_message(self):
        self.chat([dict(type="response_item", payload=dict(type="function_call_output", output="x" * 2000)), self.message("achelios.com")])
        self.index.inventory()
        with mock.patch("message_search.MAX_RECORD", 256):
            self.drain()
        self.assertTrue(self.search("achelios.com"))
        self.assertEqual(self.index.status()["warnings"], [])

    def test_compressed_transcript_is_searchable(self):
        try:
            from compression import zstd
        except ImportError:
            self.skipTest("Python 3.14 supplies zstd support")
        tid, path = self.chat([self.message("achelios.com")])
        compressed = path.with_suffix(".jsonl.zst")
        with zstd.open(compressed, "wb") as f:
            f.write(path.read_bytes())
        self.source.execute("update threads set rollout_path=? where id=?", (str(compressed), tid))
        self.source.commit()
        path.unlink()
        self.drain()
        self.assertTrue(self.search("achelios.com"))


def shutil_usage(total, used, free):
    from collections import namedtuple
    return namedtuple("Usage", "total used free")(total, used, free)


if __name__ == "__main__":
    unittest.main()
