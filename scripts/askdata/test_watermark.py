#!/usr/bin/env python3
"""#1419 回归测试：askdata 采集水位必须是 (created_at, seq) 复合游标。

bug：`transcript_events.seq` 是**按 session 从 0 自增**，而三个脚本的水位曾是「全局 seq」。
水位一旦越过某个大会话的末尾（实测 2952），之后每个新会话（seq 从 0 起）都永远低于水位
⇒ 被永久静默跳过（`EXPORT_OK rows=0 (no new events)`）。

本文件构造临时 sqlite（两个 session，seq 都从 0 起）验证：
  1. 旧实现（全局 seq）确实读不到新会话 —— 先把 bug 钉成 characterization test；
  2. 新实现按复合游标能读到；
  3. 旧整数水位文件的迁移（ts = 该 seq 事件的 created_at，绝不是当前时间），且迁移后
     后来的新会话仍能被读到；
  4. verify / attribute 的读数游标同样覆盖新会话。

零依赖：只用标准库 unittest（本机无 pytest）。
"""
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# attribute.py 在 import 期读 OO_* 环境变量（模块级常量）⇒ 先给占位值，绝不真发请求。
os.environ.setdefault("OO_BASE", "http://127.0.0.1:1")
os.environ.setdefault("OO_ORG", "test-org")
os.environ.setdefault("OO_AUTH", "test-auth")

import attribute  # noqa: E402
import verify  # noqa: E402


def load_export():
    spec = importlib.util.spec_from_file_location(
        "askdata_export_wm_test", os.path.join(HERE, "export-transcript.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


export = load_export()

OLD_TS = 1_700_000_000_000                 # 老会话事件时间（epoch 毫秒，与 created_at 同形）
NEW_TS = OLD_TS + 3_600_000                # 新会话在老会话之后 1 小时


def _event_json(content, role="assistant"):
    return json.dumps({"type": "message", "message": {"role": role, "content": content}})


def _create_db(path):
    con = sqlite3.connect(path)
    con.execute("create table transcript_events "
                "(session_id text, seq integer, created_at integer, "
                "event_json text, event_zstd blob)")
    return con


def _fake_norm(sid, seq, ts, msg, etype, ctype=None):
    return [{"session_id": sid, "seq": seq, "ts": ts, "kind": (msg or {}).get("kind")}]


def _fake_decode(event_json, event_zstd):
    return {"message": json.loads(event_json)}


class NewSessionReadTest(unittest.TestCase):
    """两个 session、seq 都从 0 起：水位推进到老会话末尾后，新会话仍必须被读出。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "sessions.sqlite")
        con = _create_db(self.db)
        for seq in range(0, 10):                       # 老会话：seq 0..9
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_old", seq, OLD_TS + seq, _event_json("old-%d" % seq)))
        for seq in range(0, 4):                        # 新会话：seq 同样从 0 起
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_new", seq, NEW_TS + seq, _event_json("new-%d" % seq)))
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_old_global_seq_query_would_skip_new_session(self):
        """#1419 的复现：旧实现按 `seq > 全局水位(9)` 读 ⇒ 新会话 4 条一条都读不到。"""
        con = sqlite3.connect(self.db)
        rows = con.execute(
            "select session_id, seq from transcript_events where seq > ? order by seq limit ?",
            (9, 100)).fetchall()
        con.close()
        self.assertEqual(rows, [])                     # 旧实现：永久静默跳过（红）

    def test_new_session_read_after_old_session_tail(self):
        """新实现：复合游标 (老会话末尾 created_at, seq) 之后 = 新会话全部事件。"""
        con = sqlite3.connect(self.db)
        rows = export.fetch_new_rows(con, (OLD_TS + 9, 9), 100)
        con.close()
        self.assertEqual([(r[0], r[1]) for r in rows],
                         [("s_new", seq) for seq in range(4)])

    def test_verify_read_rows_reads_new_session(self):
        """verify.read_rows 的量取游标同样覆盖新会话（不是只看 seq）。"""
        rows, _user_ids, read_since = verify.read_rows(
            self.db, _fake_norm, _fake_decode, since=(OLD_TS + 9, 9), tail=False)
        self.assertEqual(read_since, (OLD_TS + 9, 9))
        got = [(r["session_id"], r["seq"]) for r in rows]
        self.assertEqual([p for p in got if p[0] == "s_new"],
                         [("s_new", seq) for seq in range(4)])

    def test_attribute_read_rows_reads_new_session(self):
        """attribute.read_rows 的量取游标同样覆盖新会话。"""
        rows = attribute.read_rows(self.db, export.norm_parts, export.decode_event,
                                   (OLD_TS + 9, 9))
        got = [(r["session_id"], r["seq"]) for r in rows]
        self.assertEqual([p for p in got if p[0] == "s_new"],
                         [("s_new", seq) for seq in range(4)])


class LegacyWatermarkMigrationTest(unittest.TestCase):
    """旧水位文件是纯整数（全局 seq）⇒ 就地迁移成 (created_at, seq)，绝不跳过后来的新会话。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "sessions.sqlite")
        con = _create_db(self.db)
        for seq in range(0, 10):
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_old", seq, OLD_TS + seq, _event_json("old-%d" % seq)))
        for seq in range(0, 4):
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_new", seq, NEW_TS + seq, _event_json("new-%d" % seq)))
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def _write_legacy(self, value, name="legacy.watermark"):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w") as fh:
            fh.write(str(value))
        return path

    def test_legacy_int_migrates_to_event_created_at(self):
        """迁移 ts = 该 seq 事件的 created_at（不是当前时间），且新会话仍可读。"""
        path = self._write_legacy(9)
        cursor = export.read_watermark(path, self.db)
        self.assertEqual(cursor, (OLD_TS + 9, 9))
        con = sqlite3.connect(self.db)
        rows = export.fetch_new_rows(con, cursor, 100)
        con.close()
        self.assertEqual([r[0] for r in rows], ["s_new"] * 4)

    def test_legacy_zero_migrates_to_empty_cursor(self):
        """显式 0 = 还没采过 ⇒ (0,0)，等价于从最旧读起（不跳任何会话）。"""
        path = self._write_legacy(0)
        self.assertEqual(export.read_watermark(path, self.db), (0, 0))
        con = sqlite3.connect(self.db)
        rows = export.fetch_new_rows(con, (0, 0), 100)
        con.close()
        self.assertEqual(len(rows), 14)

    def test_missing_and_empty_watermark_are_none(self):
        """不存在 / 空文件 ⇒ None（首跑口径），不能被读成「已采到某处」。"""
        self.assertIsNone(export.read_watermark(os.path.join(self.tmp.name, "nope"), self.db))
        path = self._write_legacy("")
        self.assertIsNone(export.read_watermark(path, self.db))


class LegacyMigrationTieTest(unittest.TestCase):
    """同一 seq 出现在多个 session 时，迁移取**最大 created_at**（否则会把较新会话当已读）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "tie.sqlite")
        con = _create_db(self.db)
        t = OLD_TS
        for seq in range(3):                            # s_a: seq 0..2, ts t..t+2
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_a", seq, t + seq, _event_json("a-%d" % seq)))
        for seq in range(3):                            # s_b: 同样有 seq 0..2，但时间更晚
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_b", seq, t + 100 + seq, _event_json("b-%d" % seq)))
        for seq in range(2):                            # s_c: 在 s_b 之后的另一个新会话
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s_c", seq, t + 200 + seq, _event_json("c-%d" % seq)))
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_migration_tie_uses_max_created_at_and_keeps_later_session(self):
        path = os.path.join(self.tmp.name, "tie.watermark")
        with open(path, "w") as fh:
            fh.write("2")                               # 旧全局 seq 水位
        cursor = export.read_watermark(path, self.db)
        self.assertEqual(cursor, (OLD_TS + 102, 2))     # s_b 的 seq=2 更大 created_at

        con = sqlite3.connect(self.db)
        rows = export.fetch_new_rows(con, cursor, 100)
        con.close()
        self.assertEqual([(r[0], r[1]) for r in rows], [("s_c", 0), ("s_c", 1)])


class WatermarkFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_json_format_and_atomic_write(self):
        """新格式是 JSON `{"ts", "seq"}`；临时文件 + os.replace，不留 tmp 残留。"""
        d = os.path.join(self.tmp.name, "wm-dir")
        path = os.path.join(d, "export.watermark")
        export.write_watermark(path, (NEW_TS, 3))
        with open(path) as fh:
            self.assertEqual(json.load(fh), {"ts": NEW_TS, "seq": 3})
        self.assertEqual(os.listdir(d), ["export.watermark"])
        self.assertEqual(export.read_watermark(path), (NEW_TS, 3))


class VerifyEmitAcrossSessionsTest(unittest.TestCase):
    """verify 的「本轮是否新」也必须按复合游标判先生效——这是同一个 bug 的第二现场。"""

    def _user(self, sid, seq, text, ts):
        return {"session_id": sid, "seq": seq, "ts": ts, "kind": "user", "text": text}

    def _call(self, sid, seq, cid, ts):
        return {"session_id": sid, "seq": seq, "ts": ts, "kind": "tool_call",
                "tool_name": "query_data", "tool_call_id": cid,
                "tool_args": json.dumps(
                    {"metricId": "lemeng:retail:net_sales", "args": {"total": True}},
                    ensure_ascii=False)}

    def _result(self, sid, seq, cid, ts):
        return {"session_id": sid, "seq": seq, "ts": ts, "kind": "tool_result",
                "tool_name": "query_data", "tool_call_id": cid,
                "tool_result": '{"status":"ok"}', "is_error": False}

    def test_new_session_round_is_emitted_after_old_seq_watermark(self):
        rows = [
            # 老会话：seq 0..2（水位已越过它的末尾 seq 9）
            self._user("s_old", 0, "旧问题", OLD_TS),
            self._call("s_old", 1, "c0", OLD_TS + 1),
            self._result("s_old", 2, "c0", OLD_TS + 2),
            # 新会话：seq 又从 0 起
            self._user("s_new", 0, "5月销售额", NEW_TS),
            self._call("s_new", 1, "c1", NEW_TS + 1),
            self._result("s_new", 2, "c1", NEW_TS + 2),
        ]
        events, wm, _stats = verify.extract_events(
            rows, "org1", since=(OLD_TS + 9, 9), now_ms=NEW_TS + 24 * 3600 * 1000)
        self.assertEqual([e["sessionId"] for e in events], ["s_new"])
        self.assertEqual(events[0]["metricId"], "lemeng:retail:net_sales")
        self.assertEqual(wm, (NEW_TS + 2, 2))


if __name__ == "__main__":
    unittest.main()
