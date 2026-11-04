#!/usr/bin/env python3
"""askdata 已验问答信号：读**本机会话库** → 强/弱/负三档 → 写 OO 的 askdata_verified。

用途：W1 可信度地基的 bot 侧半环（平台侧摄入见 Task 5）。本脚本**不连平台、不读 OO**：
宿主那份凭据是 ingestion token（只写），且思考/对话的事实源本来就在本机 sqlite。

信号判据（**初始值，待真实会话标定**——词表与回合窗口都是经验值，不是实测结论）：
  · 强（strong）：bot 回答后 ≤ FOLLOW_USER_TURNS 个用户回合内出现肯定词，且该窗口内无否定词。
  · 弱（weak）  ：无肯定词、无否定词（会话结束或用户转向别的题目都落这里）。
  · 负（negative）：窗口内出现否定词；或同一指标在会话内被**不同参数**重问。
  负信号优先（同一窗口里「对，但是算错了」按负判）；负信号只进统计，平台侧不入回归集。

身份提取：只认真正的查数工具（`QUERY_TOOLS`，名字以仓内实际为准，不猜）：
  · chat 插件 `deploy/openclaw/data-query-plugin/index.js`：query_data / query_detail；
  · 直连 MCP 分析师面 `modules/data/domain/toolbox/registry.ts`：query_metric。
  一轮里多次查询 ⇒ 取**最后一次成功**的那次作该轮身份；取不到 metricId 或没有成功回包 ⇒ 跳过并计数。
  legacy 每指标工具（sanitized 名）不进：名字不可逆、参数里也没有 metricId。

水位（ASK_VERIFY_WM，按 agent 一份，同 #963）：只处理新事件、成功后才前进。
  ⚠️ 与撞墙判据不同，信号**依赖未来**（用户下一句才说「对/不对」）⇒ 未尘埃落定的轮
  （后续用户回合不足且会话未静默）**不判、水位不前移**，下一轮重读。重发由平台侧唯一键幂等吸收。

凭据：ASK_VERIFY_ORG **必填**（租户隔离键，缺失 fail-closed）；OO_BASE/OO_ORG/OO_AUTH 沿用宿主
  /etc/openobserve-ingest.env（只写）。

已知边界（初始判据必然有，如实带走，等真实会话标定后改）：
  · 词表是**子串**匹配（无分词/无 NLP）：「对不起」「对不对」这类会被误伤。
  · ≤2 个用户回合的窗口会把「下一个问题的谢谢」算到上一轮头上。
  · 「同题不同参重问」用 **metricId 相同 + params 不同**代理「同一问题」——同一指标跨天追问
    也会被判负；是否关掉见 NEG_ON_REASK_DIFFERENT_PARAMS。
  · userId：会话库事件通常不带身份，取不到就写空串（不猜）。
  · 水位前只回看 PRECONTEXT_ROWS 条；超长轮可能拿不到用户原文 ⇒ 该轮跳过并计数。
"""
import importlib.util
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))

# ── 判据常量（**初始值，待真实会话标定**）─────────────────────────────────────
# 肯定词：brief/计划给定的初始词表，不扩写（扩写要有真实会话依据）。
AFFIRM_WORDS = ("对了", "对", "没错", "就是", "准确", "谢谢")
# 否定词：同上。⚠️ 否定优先于肯定 ⇒ 「不对」不会被「对」误判成 strong。
NEG_WORDS = ("不对", "不是", "错了", "再查", "重新", "算错")
# 回答后看几个用户回合。初始 2（计划给定）。
FOLLOW_USER_TURNS = 2
# 会话静默多久视为「已结束/用户不会再回」⇒ 可判 weak。初始 30 分钟，待标定。
IDLE_SETTLE_SECONDS = 1800
# 同指标不同参数重问是否算负。计划判据；留常量便于标定后关掉。
NEG_ON_REASK_DIFFERENT_PARAMS = True

# 查数工具（不是发现类工具：list_metrics / describe_metric / sample_dimension_values /
# get_freshness / preview_query 都不算「回答了一个数」）。
QUERY_TOOLS = frozenset(("query_data", "query_detail", "query_metric"))

FETCH = int(os.environ.get("ASK_FETCH", "5000"))
# 水位前的回看行数：只是为了让批首那轮能拿到它的用户问题（不重复产出事件）。
# 500 条 ≈ 数十轮（实测一轮几到几十个事件）；仍可能不够长会话，超出时该轮按
# skipped_no_question 计数跳过（不猜问题），见文件头「已知边界」。
PRECONTEXT_ROWS = 500
CHUNK = 1000
USER_ID_KEYS = ("requesterSenderId", "user_id", "userId", "senderId")


# ── 读库 ────────────────────────────────────────────────────────────────────
def load_export_module():
    """复用 export-transcript.py 的 norm_parts / decode_event（同一套字段口径，避免两处漂移）。"""
    spec = importlib.util.spec_from_file_location(
        "askdata_export_verify", os.path.join(HERE, "export-transcript.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _find_user_id(obj, depth=0):
    """事件里能找到用户身份就用（不猜键以外的语义）；找不到返回空串。"""
    if depth > 4:
        return ""
    if isinstance(obj, dict):
        for k in USER_ID_KEYS:
            v = obj.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
        for v in obj.values():
            got = _find_user_id(v, depth + 1)
            if got:
                return got
    elif isinstance(obj, list):
        for v in obj[:20]:
            got = _find_user_id(v, depth + 1)
            if got:
                return got
    return ""


def read_rows(db, norm_parts, decode_event, since=0, fetch=None, pre=None):
    """读 seq > since 的新事件 + 少量前置上下文。返回 (归一化行, {session_id: userId})。

    ⚠️ 解不出来的事件**不许静默跳过**：抛 DecodeError 交给 main 响亮退出、水位不动
    （否则身份/问题会缺一截而无人知道）。常规链路里 export-transcript.py 会先一步停在水位上。
    """
    fetch = FETCH if fetch is None else fetch
    pre = PRECONTEXT_ROWS if pre is None else pre
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    cols = "session_id, seq, created_at, event_json, event_zstd"
    rows = con.execute(
        "select %s from transcript_events where seq > ? order by seq asc limit ?" % cols,
        (since, fetch)).fetchall()
    context = []
    if since > 0 and rows:
        # 批首可能落在一轮中间：回看一点，让该轮能找回自己的用户问题（只作上下文，不产出）。
        context = con.execute(
            "select %s from transcript_events where seq <= ? order by seq desc limit ?" % cols,
            (since, pre)).fetchall()[::-1]
    con.close()

    out, user_ids = [], {}
    for sid, seq, ts, ej, ez in context + rows:
        ev = decode_event(ej, ez)          # DecodeError 由 main 捕获并响亮退出
        if ev is None:
            continue
        uid = _find_user_id(ev)
        if uid and sid not in user_ids:
            user_ids[sid] = uid
        out.extend(norm_parts(sid, seq, ts, ev.get("message"), ev.get("type"), ev.get("customType")))
    return out, user_ids


# ── 纯函数：回合 / 身份 / 信号 ───────────────────────────────────────────────
def _json_obj(raw):
    if isinstance(raw, dict):
        return raw
    try:
        val = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return val if isinstance(val, dict) else {}


def unwrap_tool(name, args):
    """openclaw 通用调度器把真工具放在 args.id / args.args 里（同 attribute.py 的 inner_of）。"""
    if name == "tool_call" and isinstance(args, dict):
        inner = args.get("id") if isinstance(args.get("id"), str) else args.get("name")
        inner_args = args.get("args") if isinstance(args.get("args"), dict) else args.get("arguments")
        if isinstance(inner, str) and inner:
            return inner, inner_args if isinstance(inner_args, dict) else {}
    return name, args


def metric_identity(args):
    """查数参数 → (metricId, params, slicing)。取不到 metricId ⇒ None。"""
    if not isinstance(args, dict):
        return None
    mid = args.get("metricId")
    if not isinstance(mid, str) or not mid.strip():
        return None
    params = args.get("args")
    if not isinstance(params, dict):
        params = {}
    slicing = {k: v for k, v in args.items()
               if k not in ("metricId", "args") and v is not None}
    return mid.strip(), params, slicing


def build_rounds(rows):
    """按用户消息切回合：一条 user 消息 + 其后的 bot 动作 = 一轮。

    返回 (rounds, orphan_queries)：首个用户消息之前的查数调用无法归属问题，计 orphan。
    """
    rounds, cur, orphan = [], None, 0
    for r in rows:
        kind = r.get("kind")
        if kind == "user":
            cur = {"user_seq": r.get("seq") or 0,
                   "question": (r.get("text") or "").strip(),
                   "ts": r.get("ts"),
                   "rows": []}
            rounds.append(cur)
        elif cur is not None:
            cur["rows"].append(r)
        elif kind == "tool_call":
            name, _ = unwrap_tool(r.get("tool_name"), _json_obj(r.get("tool_args")))
            if name in QUERY_TOOLS:
                orphan += 1
    return rounds, orphan


def _round_calls(round_rows):
    """回合内的查数调用 + 各自回包。按 tool_call_id 配对；缺 id 时按同名最近一次兜底。"""
    calls, by_id = [], {}
    for r in round_rows:
        kind = r.get("kind")
        if kind == "tool_call":
            name, args = unwrap_tool(r.get("tool_name"), _json_obj(r.get("tool_args")))
            item = {"row": r, "name": name, "args": args, "results": []}
            calls.append(item)
            cid = r.get("tool_call_id")
            if cid:
                by_id[cid] = item
        elif kind == "tool_result":
            item = by_id.get(r.get("tool_call_id") or "")
            if item is None:
                for cand in reversed(calls):
                    if cand["name"] == r.get("tool_name") and not cand["results"]:
                        item = cand
                        break
            if item is not None:
                item["results"].append(r)
    out = []
    for c in calls:
        if c["name"] not in QUERY_TOOLS:
            continue
        # 「成功」= 有回包且回包不是 is_error（denied/BAD_PARAM 都不算回答了一个数）。
        ok = bool(c["results"]) and not any(x.get("is_error") for x in c["results"])
        out.append({"name": c["name"], "args": c["args"], "seq": c["row"].get("seq"),
                    "ts": c["row"].get("ts"), "ok": ok})
    return out


def _pick_identity(round_calls):
    """一轮多次查询 ⇒ 最后一次**成功且可识别**的查询作身份。

    返回 (call, identity) 或 (None, reason)，reason ∈ no_success | no_metric。
    """
    successful = [c for c in round_calls if c["ok"]]
    if not successful:
        return None, "no_success"
    for call in reversed(successful):
        ident = metric_identity(call["args"])
        if ident is not None:
            return call, ident
    return None, "no_metric"


def _has_word(text, words):
    return any(w in (text or "") for w in words)


def _canon(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True)


def _is_reask(metric_id, params, later_round_calls):
    """会话内同指标、不同参数重问（计划判据）。"""
    if not NEG_ON_REASK_DIFFERENT_PARAMS:
        return False
    for calls in later_round_calls:
        for call in calls:
            ident = metric_identity(call["args"])
            if ident is None or ident[0] != metric_id:
                continue
            if _canon(ident[1]) != _canon(params):
                return True
    return False


def _iso_utc(ts):
    """created_at 实测是 epoch 毫秒；输出 RFC3339 UTC（平台侧按时间窗摄入）。"""
    if isinstance(ts, (int, float)):
        sec, ms = divmod(int(ts), 1000)
        return datetime.fromtimestamp(sec, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + \
            ".%03dZ" % ms
    return str(ts or "")


def _session_idle(rows, now_ms):
    """会话最后一条事件是否已静默超过阈值（静默 ⇒ 不再等后续用户回合）。"""
    stamps = [r.get("ts") for r in rows if isinstance(r.get("ts"), (int, float))]
    if not stamps:
        return True
    return now_ms - max(stamps) >= IDLE_SETTLE_SECONDS * 1000


def extract_events(rows, org, since=0, now_ms=None, user_ids=None):
    """纯函数：归一化事件列表 → (events, next_watermark, stats)。

    · 只产出 seq > since 的轮（水位前的行仅作上下文）。
    · 未尘埃落定的轮不产出，并把水位压回该轮起点之前（下一轮重读）。
    """
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    user_ids = user_ids or {}

    by_session = {}
    for r in rows:
        by_session.setdefault(r.get("session_id") or "", []).append(r)

    events, hold_at = [], []
    stats = {"turns": 0, "emitted": 0, "strong": 0, "weak": 0, "negative": 0,
             "skipped_no_metric": 0, "skipped_no_success": 0,
             "skipped_no_question": 0, "held_unsettled": 0, "orphan_queries": 0}
    max_seq = since

    for sid, srows in by_session.items():
        srows.sort(key=lambda x: (x.get("seq") or 0))
        for r in srows:
            if isinstance(r.get("seq"), (int, float)):
                max_seq = max(max_seq, int(r["seq"]))
        rounds, orphan = build_rounds(srows)
        stats["orphan_queries"] += orphan
        idle = _session_idle(srows, now_ms)
        uid = user_ids.get(sid) or ""
        if not uid:
            for r in srows:
                val = r.get("user_id") or r.get("userId")
                if isinstance(val, str) and val:
                    uid = val
                    break
        all_calls = [_round_calls(rd["rows"]) for rd in rounds]

        for i, rd in enumerate(rounds):
            calls = all_calls[i]
            if not calls:
                continue
            # 水位之前的一轮只作上下文（重问判据仍可用它的调用）。
            new_calls = [c for c in calls if (c.get("seq") or 0) > since]
            if not new_calls:
                continue
            stats["turns"] += 1
            call, ident = _pick_identity(calls)
            if call is None:
                stats["skipped_no_" + ("success" if ident == "no_success" else "metric")] += 1
                continue
            if not rd["question"]:
                stats["skipped_no_question"] += 1
                continue

            future = rounds[i + 1:i + 1 + FOLLOW_USER_TURNS]
            settle_needed = len(rounds) - 1 - i
            if settle_needed < FOLLOW_USER_TURNS and not idle:
                # 用户还没回（或回合不足）且会话未静默 ⇒ 现在判会把 strong/negative 判成 weak。
                stats["held_unsettled"] += 1
                hold_at.append(max(since, (rd["user_seq"] or 0) - 1))
                continue

            follow_texts = [x["question"] for x in future]
            neg = any(_has_word(t, NEG_WORDS) for t in follow_texts)
            affirm = any(_has_word(t, AFFIRM_WORDS) for t in follow_texts)
            metric_id, params, slicing = ident
            if not neg and _is_reask(metric_id, params, all_calls[i + 1:]):
                neg = True                 # 同题不同参重问 = 负信号（计划判据）
            signal = "negative" if neg else ("strong" if affirm else "weak")
            stats[signal] += 1

            events.append({
                "org": org,
                "question": rd["question"],
                "metricId": metric_id,
                "params": params,
                "slicing": slicing,
                "signal": signal,
                "sessionId": sid,
                "seq": call.get("seq"),
                "userId": uid,
                "at": _iso_utc(call.get("ts")),
            })

    events.sort(key=lambda e: (e["sessionId"], e["seq"] or 0))
    stats["emitted"] = len(events)
    new_wm = min([max_seq] + hold_at) if hold_at else max_seq
    return events, new_wm, stats


# ── OO 写入 ─────────────────────────────────────────────────────────────────
def post(base, org, auth, stream, batch):
    req = urllib.request.Request(
        "%s/api/%s/%s/_json" % (base, org, stream),
        data=json.dumps(batch, ensure_ascii=False).encode(),
        headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:500]
        except Exception:
            detail = "<no body>"
        print("VERIFY_POST_FAIL stream=%s n=%d http=%s body=%s"
              % (stream, len(batch), exc.code, detail))
        sys.exit(1)
    except Exception as exc:
        print("VERIFY_POST_FAIL stream=%s n=%d err=%s" % (stream, len(batch), exc))
        sys.exit(1)


def _read_watermark(path):
    if not os.path.exists(path):
        return 0
    try:
        return int(open(path).read().strip() or "0")
    except ValueError:
        return 0


def _write_watermark(path, value):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    open(path, "w").write(str(value))


# ── 入口 ────────────────────────────────────────────────────────────────────
def main(argv=None, env=None):
    env = os.environ if env is None else env
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        sys.exit("usage: verify.py <openclaw-agent.sqlite>")
    org = (env.get("ASK_VERIFY_ORG") or "").strip()
    if not org:
        # fail-closed：租户隔离键不猜、不默认。
        sys.exit("SYNC_FAIL missing ASK_VERIFY_ORG")
    missing = [k for k in ("OO_BASE", "OO_ORG", "OO_AUTH") if not env.get(k)]
    if missing:
        sys.exit("SYNC_FAIL missing " + " ".join(missing))

    wm_path = env.get("ASK_VERIFY_WM", "/var/lib/askdata/verify.watermark")
    stream = env.get("ASK_VERIFY_STREAM", "askdata_verified")
    since = _read_watermark(wm_path)

    export_mod = load_export_module()
    try:
        rows, user_ids = read_rows(argv[0], export_mod.norm_parts,
                                   export_mod.decode_event, since)
    except (export_mod.DecodeError, ValueError) as exc:
        # 水位纪律同 #969：绝不越过读不出来的事件。
        sys.exit("VERIFY_DECODE_FAIL watermark=%d err=%s" % (since, exc))

    events, new_wm, stats = extract_events(rows, org, since=since, user_ids=user_ids)
    by_signal = {k: stats[k] for k in ("strong", "weak", "negative")}

    if not events:
        _write_watermark(wm_path, new_wm)
        print("VERIFY_OK events=0 rows=%d watermark=%d held=%d by_signal=%s"
              % (len(rows), new_wm, stats["held_unsettled"], json.dumps(by_signal)))
        return

    resp = ""
    for i in range(0, len(events), CHUNK):
        resp = post(env["OO_BASE"], env["OO_ORG"], env["OO_AUTH"], stream, events[i:i + CHUNK])
    _write_watermark(wm_path, new_wm)   # 全部 post 成功后才前进（失败上面已 exit 1）
    print("VERIFY_OK events=%d rows=%d watermark=%d held=%d by_signal=%s skipped=%s resp=%s"
          % (len(events), len(rows), new_wm, stats["held_unsettled"],
             json.dumps(by_signal),
             json.dumps({k: v for k, v in stats.items()
                         if k.startswith("skipped_") or k == "orphan_queries"}),
             resp[:120]))


if __name__ == "__main__":
    main()
