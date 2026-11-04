#!/usr/bin/env python3
"""verify.py 的纯函数测试（不连 sqlite、不连 OO）。

fixture 是构造好的归一化事件列表（形状同 export-transcript.py 的 norm_parts 输出）：
  {session_id, seq, ts, kind, ...}
本机无 pytest，且 askdata 目录约定零依赖 ⇒ 只用标准库 unittest。
"""
import json
import os
import sys
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
        self.assertEqual(ev["params"], net_sales()["args"])
        self.assertEqual(ev["slicing"], {})
        self.assertEqual(ev["sessionId"], "s1")
        self.assertEqual(ev["seq"], 2)
        self.assertIn("userId", ev)
        self.assertTrue(ev["at"].endswith("Z"), ev["at"])
        # 平台侧消费的字段契约（多一列都要显式讨论，别悄悄漂移）
        self.assertEqual(set(ev), {"org", "question", "metricId", "params", "slicing",
                                   "signal", "sessionId", "seq", "userId", "at"})
        self.assertEqual(stats["strong"], 1)
        self.assertEqual(wm, 6)

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

    def test_query_detail_extracts_slicing(self):
        """query_detail 的 dimensions/limit 等进 slicing，args 进 params。"""
        rows = [
            user("s1", 1, "哪几单最大"),
            call("s1", 2, "query_detail",
                 {"metricId": "lemeng:retail:sales",
                  "args": {"bizday": {"from": "2026-05-01", "to": "2026-05-01"}},
                  "dimensions": ["order_id"], "limit": 10}, "c1"),
            result("s1", 3, "query_detail", "c1"),
            user("s1", 4, "谢谢"),
        ]
        events, _, _ = verify.extract_events(rows, "org1", now_ms=IDLE_LATER)
        self.assertEqual(events[0]["slicing"], {"dimensions": ["order_id"], "limit": 10})
        self.assertEqual(events[0]["params"],
                         {"bizday": {"from": "2026-05-01", "to": "2026-05-01"}})

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


if __name__ == "__main__":
    unittest.main()
