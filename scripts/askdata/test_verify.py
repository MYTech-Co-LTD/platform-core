#!/usr/bin/env python3
"""verify.py 的纯函数测试（不连 sqlite、不连 OO）。

fixture 是构造好的归一化事件列表（形状同 export-transcript.py 的 norm_parts 输出）：
  {session_id, seq, ts, kind, ...}
本机无 pytest，且 askdata 目录约定零依赖 ⇒ 只用标准库 unittest。
"""
import json
import os
import sqlite3
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import verify  # noqa: E402

BASE_TS = 1_700_000_000_000          # epoch 毫秒（与 created_at 同形）
IDLE_LATER = BASE_TS + 24 * 3600 * 1000


def user(sid, seq, text, **kw):
    row = {"session_id": sid, "seq": seq, "ts": BASE_TS + seq * 1000,
           "kind": "user", "text": text}
    row.update(kw)
    return row


def call(sid, seq, name, args, call_id, **kw):
    row = {"session_id": sid, "seq": seq, "ts": BASE_TS + seq * 1000,
           "kind": "tool_call", "tool_name": name,
           "tool_args": json.dumps(args, ensure_ascii=False), "tool_call_id": call_id}
    row.update(kw)
    return row


def result(sid, seq, name, call_id, text='{"status":"ok"}', is_error=False):
    return {"session_id": sid, "seq": seq, "ts": BASE_TS + seq * 1000,
            "kind": "tool_result", "tool_name": name, "tool_call_id": call_id,
            "tool_result": text, "is_error": is_error}


def text(sid, seq, body):
    return {"session_id": sid, "seq": seq, "ts": BASE_TS + seq * 1000,
            "kind": "text", "text": body}


def net_sales(day_from="2026-05-01", day_to="2026-05-31", total=True):
    return {"metricId": "lemeng:retail:net_sales",
            "args": {"bizday": {"from": day_from, "to": day_to}, "total": total}}


class SignalTest(unittest.TestCase):
    def test_strong_signal(self):
        """回答后 ≤2 个用户回合内出现肯定词 ⇒ strong，question 取用户原文。"""
        rows = [
            user("s1", 1, "5月销售额多少"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1", '{"status":"ok","total":"100"}'),
            text("s1", 4, "5月销售额为 100"),
            user("s1", 5, "对了，就是这个数"),
            user("s1", 6, "谢谢"),
        ]
        events, wm, stats = verify.extract_events(rows, "shanhaiyiguo-org", now_ms=IDLE_LATER)

        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev["signal"], "strong")
        self.assertEqual(ev["org"], "shanhaiyiguo-org")
        self.assertEqual(ev["question"], "5月销售额多少")
        self.assertEqual(ev["metricId"], "lemeng:retail:net_sales")
        # 嵌套对象按 attribute.py 同口径序列化成 JSON 字符串（Task 5 侧解析）
        self.assertEqual(json.loads(ev["params"]), net_sales()["args"])
        self.assertEqual(json.loads(ev["slicing"]), {})
        self.assertEqual(ev["sessionId"], "s1")
        self.assertEqual(ev["seq"], 2)
        self.assertIn("userId", ev)
        self.assertTrue(ev["at"].endswith("Z"), ev["at"])
        # 平台侧消费的字段契约（多一列都要显式讨论，别悄悄漂移）
        self.assertEqual(set(ev), {"org", "question", "metricId", "params", "slicing",
                                   "signal", "sessionId", "seq", "userId", "at"})
        self.assertEqual(stats["strong"], 1)
        self.assertEqual(wm, 6)

    def test_non_question_with_affirm_downgrades_to_weak(self):
        """肯定词在场、但用户消息不是指标问题（指令/纠错）⇒ 降级 weak，不自动 verified。"""
        for q in ("/resume", "根据历史记录，能写入的先做写入", "你的是402,866.47，应该是402,735.68"):
            rows = [
                user("s1", 1, q),
                call("s1", 2, "query_data", net_sales(), "c1"),
                result("s1", 3, "query_data", "c1", '{"status":"ok","total":"100"}'),
                text("s1", 4, "好"),
                user("s1", 5, "对了，谢谢"),
            ]
            events, _wm, stats = verify.extract_events(rows, "shanhaiyiguo-org", now_ms=IDLE_LATER)
            self.assertEqual(len(events), 1, q)
            self.assertEqual(events[0]["signal"], "weak", q)
            self.assertEqual(stats["strong"], 0, q)
            self.assertEqual(stats.get("downgraded_non_question"), 1, q)

    def test_attachment_or_overlong_question_downgrades(self):
        """附件/超长粘贴不是问题 ⇒ weak。"""
        for q in ('<media:document>\n<file name="x.md">ok</file>', "长" * 201):
            rows = [
                user("s1", 1, q),
                call("s1", 2, "query_data", net_sales(), "c1"),
                result("s1", 3, "query_data", "c1", '{"status":"ok","total":"100"}'),
                text("s1", 4, "好的"),
                user("s1", 5, "对的"),
            ]
            events, _wm, _stats = verify.extract_events(rows, "shanhaiyiguo-org", now_ms=IDLE_LATER)
            self.assertEqual(len(events), 1, q[:20])
            self.assertEqual(events[0]["signal"], "weak", q[:20])

    def test_weak_when_session_ends_without_feedback(self):
        """无肯定/否定且会话结束 ⇒ weak。"""
        rows = [
            user("s1", 1, "5月订单数"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            text("s1", 4, "共 12 单"),
        ]
        events, wm, stats = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["signal"], "weak")
        self.assertEqual(stats["weak"], 1)
        self.assertEqual(wm, 4)

    def test_negative_word(self):
        """出现否定词 ⇒ negative（负信号优先，不产生 verified/candidate）。"""
        rows = [
            user("s1", 1, "5月销售额多少"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "不对，我要的是净销售额"),
        ]
        events, _, stats = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["signal"], "negative")
        self.assertEqual(stats["negative"], 1)

    def test_affirmation_then_negation_is_negative(self):
        """同一窗口先肯定后否定 ⇒ negative（之后有否定词就不算强）。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "对，但是金额算错了"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events[0]["signal"], "negative")

    def test_reask_same_metric_with_different_params_is_negative(self):
        """同一指标在会话内被不同参数重问 ⇒ 前一轮 negative（brief 判据）。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "那6月的呢"),
            call("s1", 5, "query_data", net_sales("2026-06-01", "2026-06-30"), "c2"),
            result("s1", 6, "query_data", "c2"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0]["signal"], "negative")
        self.assertEqual(events[1]["signal"], "weak")

    def test_last_successful_query_wins(self):
        """一轮多次查询：取最后一次成功的身份；失败的那次不作数。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", {"metricId": "metric:bad", "args": {}}, "c1"),
            result("s1", 3, "query_data", "c1", '{"error":"BAD_PARAM"}', is_error=True),
            call("s1", 4, "query_data", net_sales(), "c2"),
            result("s1", 5, "query_data", "c2"),
            user("s1", 6, "不对"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["metricId"], "lemeng:retail:net_sales")
        self.assertEqual(events[0]["seq"], 4)
        self.assertEqual(events[0]["signal"], "negative")

    def test_no_successful_query_skipped(self):
        """只有失败查询（无成功回包）⇒ 跳过并计数，不编身份。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1", '{"error":"denied"}', is_error=True),
            user("s1", 4, "不对"),
        ]
        events, _, stats = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events, [])
        self.assertEqual(stats["skipped_no_success"], 1)

    def test_missing_metric_id_skipped(self):
        """查数调用里取不到 metricId ⇒ 跳过并计数（不猜）。"""
        rows = [
            user("s1", 1, "查一下"),
            call("s1", 2, "query_data", {"args": {"bizday": {"from": "x", "to": "y"}}}, "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "不对"),
        ]
        events, _, stats = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events, [])
        self.assertEqual(stats["skipped_no_metric"], 1)

    def test_scheduler_wrapper_unwrapped(self):
        """openclaw 通用调度器 tool_call 的内层真工具/参数要解开（同 attribute.py 口径）。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "tool_call",
                 {"id": "query_data", "args": net_sales()}, "c1"),
            result("s1", 3, "tool_call", "c1"),
            user("s1", 4, "谢谢"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["metricId"], "lemeng:retail:net_sales")
        self.assertEqual(events[0]["signal"], "strong")

    def test_query_detail_not_emitted_in_w1(self):
        """W1 不把 query_detail 当查数工具：drill 重放要独立执行器（W2 再接通）。

        聚合执行器重放 drill 参数恒错（orderBy 字符串 vs 数组）⇒ 产出的事件只会把回归集
        每条 drill 都落成 candidate/error。宁可不出，也不出假覆盖。
        """
        rows = [
            user("s1", 1, "哪几单最大"),
            call("s1", 2, "query_detail",
                 {"metricId": "lemeng:retail:sales",
                  "args": {"bizday": {"from": "2026-05-01", "to": "2026-05-01"}},
                  "dimensions": ["order_id"], "limit": 10}, "c1"),
            result("s1", 3, "query_detail", "c1"),
            user("s1", 4, "谢谢"),
        ]
        events, _, stats = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events, [])
        self.assertEqual(stats["emitted"], 0)
        self.assertEqual(stats["orphan_queries"], 0)

    def test_unsettled_turn_holds_watermark(self):
        """回答后还没等到后续用户消息（未静默）⇒ 本轮不判、水位不前移。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
        ]
        now = BASE_TS + 3 * 1000 + 60 * 1000     # 1 分钟后，远小于静默阈值
        events, wm, stats = verify.extract_events(rows, "org1", now_ms=now, since=0)
        self.assertEqual(events, [])
        self.assertEqual(stats["held_unsettled"], 1)
        self.assertEqual(wm, 0)                  # round 从 seq 1 开始 ⇒ 水位停在 0

    def test_context_before_since_is_not_reemitted(self):
        """水位前的旧轮只作上下文（取 question），不重复产出事件。"""
        rows = [
            user("s1", 1, "旧问题"),
            call("s1", 2, "query_data", net_sales(), "c0"),
            result("s1", 3, "query_data", "c0"),
            user("s1", 4, "新问题"),
            call("s1", 5, "query_data", {"metricId": "m:new", "args": {}}, "c1"),
            result("s1", 6, "query_data", "c1"),
            user("s1", 7, "对"),
            user("s1", 8, "谢谢"),
        ]
        events, wm, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER, since=4)
        self.assertEqual([e["question"] for e in events], ["新问题"])
        self.assertEqual(events[0]["metricId"], "m:new")
        self.assertEqual(wm, 8)

    def test_user_id_picked_up_when_present(self):
        """事件里带 userId 就带上（生产侧取不到时写空串，不猜）。"""
        rows = [
            user("s1", 1, "5月销售额", user_id="u-42"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "谢谢"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events[0]["userId"], "u-42")

    def test_main_fails_closed_without_org(self):
        """ASK_VERIFY_ORG 缺失 ⇒ 立即退出，不读库、不猜 org。"""
        with self.assertRaises(SystemExit) as cm:
            verify.main(["x.sqlite"], env={})
        self.assertIn("ASK_VERIFY_ORG", str(cm.exception))

    def test_main_fails_closed_without_oo_env(self):
        with self.assertRaises(SystemExit) as cm:
            verify.main(["x.sqlite"], env={"ASK_VERIFY_ORG": "org1"})
        self.assertIn("OO_BASE", str(cm.exception))

    # ── 评审 fix round 1 补齐 ────────────────────────────────────────────────
    def test_trailing_unpaired_call_holds_watermark(self):
        """窗口末行是 tool_call（回包还在下一批）⇒ 不判、水位不前移，绝不整轮丢掉。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),   # 无 result
        ]
        now = BASE_TS + 2 * 1000 + 60 * 1000                 # 未静默
        events, wm, stats = verify.extract_events(rows, "org1", now_ms=now, since=0)
        self.assertEqual(events, [])
        self.assertEqual(stats["held_incomplete"], 1)
        self.assertEqual(wm, 0)                              # 下一轮重读同一批

    def test_unpaired_call_settles_when_idle(self):
        """静默后仍无回包 ⇒ 按失败跳过并前进（不无限 hold）。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
        ]
        events, wm, stats = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events, [])
        self.assertEqual(stats["skipped_no_success"], 1)
        self.assertEqual(stats["held_incomplete"], 0)
        self.assertEqual(wm, 2)

    def test_old_stuck_call_settles_when_session_active(self):
        """会话仍活跃（有新事件）但卡死调用所在轮已过静默阈值 ⇒ 不再 hold（水位不永久卡住）。"""
        rows = [
            user("s1", 1, "5月销售额", ts=BASE_TS),
            call("s1", 2, "query_data", net_sales(), "c1", ts=BASE_TS + 1000),  # 无 result
            # 会话后续还有动静（用户换了话题）⇒ 会话本身未静默
            user("s1", 3, "换个问题", ts=BASE_TS + 3600 * 1000),
        ]
        now = BASE_TS + 3600 * 1000 + 60 * 1000   # 距最后事件 1 分钟；距第一轮已 1 小时+
        events, wm, stats = verify.extract_events(rows, "org1", now_ms=now, since=0)
        self.assertEqual(events, [])
        self.assertEqual(stats["held_incomplete"], 0)
        self.assertEqual(stats["skipped_no_success"], 1)
        self.assertEqual(wm, 3)                   # 水位越过卡死的轮

    def test_unpaired_call_recovered_in_next_batch(self):
        """本轮先按失败前进也无妨：回包到货的下一批按「整轮任一行新」重新评估并产出。"""
        first = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
        ]
        events1, wm1, stats1 = verify.extract_events(first, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events1, [])
        self.assertEqual(wm1, 2)
        self.assertEqual(stats1["skipped_no_success"], 1)

        # 下一批：前置上下文的 user/call + 新到的 result（seq 3 > 水位 2）
        second = first + [result("s1", 3, "query_data", "c1")]
        events2, wm2, _ = verify.extract_events(second, "org1", now_ms=IDLE_LATER, since=2)
        self.assertEqual(len(events2), 1)
        self.assertEqual(events2[0]["seq"], 2)
        self.assertEqual(events2[0]["signal"], "weak")
        self.assertEqual(wm2, 3)

    def test_words_outside_window_are_ignored(self):
        """肯定/否定词都只认回答后 ≤2 个用户回合；窗口外不判 strong/negative。"""
        base = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "嗯"),
            user("s1", 5, "好的"),
        ]
        for outside, label in (("谢谢", "strong"), ("不对", "negative")):
            rows = base + [user("s1", 6, outside)]
            events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
            first = [e for e in events if e["seq"] == 2][0]
            self.assertEqual(first["signal"], "weak", "%s 在窗口外不该判 %s" % (outside, label))

    def test_reask_across_sessions_not_negative(self):
        """重问判据只在会话内 —— 另一个会话问同指标不算负。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s2", 1, "6月销售额"),
            call("s2", 2, "query_data", net_sales("2026-06-01", "2026-06-30"), "c1"),
            result("s2", 3, "query_data", "c1"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual([e["signal"] for e in events], ["weak", "weak"])

    def test_reask_beyond_window_not_negative(self):
        """重问判据只看 ≤FOLLOW_USER_TURNS 轮；更远的追问不把前面判负。"""
        rows = [
            user("s1", 1, "5月销售额"),
            call("s1", 2, "query_data", net_sales(), "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "嗯"),
            user("s1", 5, "好的"),
            user("s1", 6, "还有吗"),
            call("s1", 7, "query_data", net_sales("2026-06-01", "2026-06-30"), "c2"),
            result("s1", 8, "query_data", "c2"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual([e["signal"] for e in events], ["weak", "weak"])
        self.assertEqual(events[0]["seq"], 2)

    def test_reask_with_different_slicing_is_negative(self):
        """「不同参」包含 slicing：同指标同参数换维度也是重问（用 query_data 的维度）。"""
        rows = [
            user("s1", 1, "按订单看销售额"),
            call("s1", 2, "query_data",
                 {"metricId": "lemeng:retail:sales", "args": {"bizday": "2026-05-01"},
                  "dimensions": ["order_id"]}, "c1"),
            result("s1", 3, "query_data", "c1"),
            user("s1", 4, "那按门店呢"),
            call("s1", 5, "query_data",
                 {"metricId": "lemeng:retail:sales", "args": {"bizday": "2026-05-01"},
                  "dimensions": ["branch"]}, "c2"),
            result("s1", 6, "query_data", "c2"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events[0]["signal"], "negative")

    def test_find_user_id_does_not_recurse_into_tool_results(self):
        """身份只认消息层/会话层，绝不进回包内容捞（群成员列表里有别人的 id）。"""
        self.assertEqual(
            verify._find_user_id({"type": "message",
                                  "message": {"role": "user", "senderId": "u1"}}), "u1")
        self.assertEqual(
            verify._find_user_id({"type": "session", "session": {"userId": "u2"}}), "u2")
        self.assertEqual(
            verify._find_user_id({"type": "message",
                                  "message": {"role": "toolResult",
                                              "content": [{"type": "text", "text": "..."}],
                                              "members": [{"senderId": "someone-else"}]}}), "")


def _fake_norm(sid, seq, ts, msg, etype, ctype=None):
    return [{"session_id": sid, "seq": seq, "ts": ts, "kind": (msg or {}).get("kind")}]


def _fake_decode(event_json, event_zstd):
    return {"message": json.loads(event_json)}


class ReadRowsTest(unittest.TestCase):
    """read_rows 的水位/窗口行为（临时 sqlite，不碰真库）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "t.sqlite")
        con = sqlite3.connect(self.db)
        con.execute("create table transcript_events "
                    "(session_id text, seq integer, created_at integer, "
                    "event_json text, event_zstd blob)")
        for seq in range(1, 11):
            con.execute("insert into transcript_events values (?,?,?,?,NULL)",
                        ("s1", seq, BASE_TS + seq, json.dumps({"kind": "event"})))
        con.commit()
        con.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_first_run_reads_tail_not_oldest(self):
        """首跑取库尾部（最新方向），不是最旧的 5000 条。"""
        rows, _, base = verify.read_rows(self.db, _fake_norm, _fake_decode,
                                         since=0, fetch=4, pre=2)
        self.assertEqual([r["seq"] for r in rows], [5, 6, 7, 8, 9, 10])
        self.assertEqual(base, 6)                  # 6 及以前只作上下文
        self.assertEqual([r["seq"] for r in rows if r["seq"] > base], [7, 8, 9, 10])

    def test_forward_read_uses_since_plus_context(self):
        rows, _, base = verify.read_rows(self.db, _fake_norm, _fake_decode,
                                         since=6, fetch=3, pre=2, tail=False)
        self.assertEqual([r["seq"] for r in rows], [5, 6, 7, 8, 9])
        self.assertEqual(base, 6)


class WatermarkTest(unittest.TestCase):
    """水位文件的原子写与「空文件 = 没有水位」语义（不碰真 OO）。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "sub", "wm")

    def tearDown(self):
        self.tmp.cleanup()

    def test_missing_and_empty_are_no_watermark(self):
        """不存在 / 空 / 纯空白 ⇒ None（首跑口径），不能读成 0 翻转模式。"""
        self.assertIsNone(verify._read_watermark(self.path))
        os.makedirs(os.path.dirname(self.path))
        for body in ("", "   \n\t"):
            with open(self.path, "w") as fh:
                fh.write(body)
            self.assertIsNone(verify._read_watermark(self.path))

    def test_write_is_atomic_and_explicit_zero_survives(self):
        """写入走临时文件 + rename（不留 tmp）；显式 0 与空文件语义不同。"""
        verify._write_watermark(self.path, 42)
        self.assertEqual(verify._read_watermark(self.path), 42)
        self.assertEqual(sorted(os.listdir(os.path.dirname(self.path))), ["wm"])

        verify._write_watermark(self.path, 0)
        self.assertEqual(verify._read_watermark(self.path), 0)


if __name__ == "__main__":
    unittest.main()
