#!/usr/bin/env python3
"""askdata 撞墙判据：读**本机会话库** → 三条结构型规则 → 写 OO 的 askdata_stuck。

⚠️ 为什么不从 OO 读：宿主那份凭据是 **ingestion token（只写）**，打 `_search` 会 401（实测）。
   思考的事实源本来就在本机 sqlite，读它反而更直接，且宿主凭据保持只写（合最小权限）。

只做「判据本身不需要阈值」的三条；需要数值的（超预算/触顶）等真实分布出来再定，不在这里编。
复用 export-transcript.py 的 normalizer（同一套字段口径，避免两处漂移）。
"""
import importlib.util, json, os, sqlite3, sys, time, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.environ.get("ASK_STUCK_STREAM", "askdata_stuck")
FETCH = int(os.environ.get("ASK_FETCH", "5000"))
BASE, ORG, AUTH = os.environ["OO_BASE"], os.environ["OO_ORG"], os.environ["OO_AUTH"]


def load_normalizer():
    spec = importlib.util.spec_from_file_location("askdata_export", os.path.join(HERE, "export-transcript.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.norm_parts


def read_rows(db, norm_parts):
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    rows = con.execute(
        "select session_id, seq, created_at, event_json from transcript_events "
        "order by seq desc limit ?", (FETCH,)).fetchall()
    out = []
    for sid, seq, ts, ej in rows[::-1]:          # 反转回升序
        if not ej:
            continue
        try:
            ev = json.loads(ej)
        except Exception:
            continue
        out.extend(norm_parts(sid, seq, ts, ev.get("message"), ev.get("type"), ev.get("customType")))
    return out


def detect(rows):
    """按 session 分组、按 seq 排序，滑窗判三条。返回 [(rule, layer, row, evidence)]"""
    bys = {}
    for r in rows:
        bys.setdefault(r.get("session_id") or "", []).append(r)
    hits = []
    for sid, rs in bys.items():
        rs.sort(key=lambda x: (x.get("seq") or 0))
        prev_call = prev_call_seq = None
        prev_res = prev_res_seq = None
        for r in rs:
            k = r.get("kind")
            if k == "tool_call":
                cur = (r.get("tool_name") or "", r.get("tool_args") or "")
                if prev_call is not None and cur == prev_call:
                    ev = {"a_seq": prev_call_seq, "b_seq": r.get("seq"),
                          "tool": cur[0], "args": cur[1][:200]}
                    if cur[0] == "tool_call":      # 调度器行：解出内层真工具
                        ev.update(inner_of(cur[1]))
                    hits.append(("same_tool_retry", "指令面", r, ev))
                prev_call, prev_call_seq = cur, r.get("seq")
            elif k == "tool_result":
                cur = (r.get("tool_result") or "", bool(r.get("is_error")))
                # ⚠️ 必须要求 is_error —— 否则「两条相同的**成功**回包」会被误判成同错两次（实测误判）
                if prev_res is not None and cur[0] and cur[1] and cur == prev_res:
                    hits.append(("same_error_twice", "指令面/回包面", r,
                                 {"a_seq": prev_res_seq, "b_seq": r.get("seq"), "text": cur[0][:200]}))
                prev_res, prev_res_seq = cur, r.get("seq")
        trunc_at = None
        for r in rs:
            tr = r.get("tool_result") or ""
            # ⚠️ 只认 `"truncated": true` —— 成功回包里那句 `"truncated":false` 会被裸词匹配误命中（实测误判）
            is_trunc = ('"truncated":true' in tr.replace(" ", "")) or ('"truncated": true' in tr)
            if r.get("kind") == "tool_result" and is_trunc:
                trunc_at = r
            elif r.get("kind") == "tool_call" and trunc_at is not None:
                hits.append(("truncated_then_recall", "指令面", r,
                             {"truncated_seq": trunc_at.get("seq"), "seq": r.get("seq"),
                              "tool": r.get("tool_name")}))
                trunc_at = None
    return hits


def inner_of(args_json):
    """openclaw 的**通用调度器**把真工具放在 `args.id` 里；解出来便于分开统计。"""
    try:
        j = json.loads(args_json or "{}")
    except Exception:
        return {}
    if not isinstance(j, dict):
        return {}
    out = {}
    if isinstance(j.get("id"), str):
        out["inner_tool"] = j["id"]
    if "args" in j:
        out["inner_args"] = json.dumps(j["args"], ensure_ascii=False)[:200]
    return out


def layer_of(rule, evidence_text):
    """归因到层。**先判内层调度**（那不是我们指令面能修的）；落不下层返回 `unknown`，
    **不默认归指令面**——不认识就说不认识，统计里能看见（#749）。"""
    t = evidence_text or ""
    # openclaw 内层调度：通用调度器本体，与它的内部报错
    if '"tool": "tool_call"' in t or '"tool":"tool_call"' in t:
        return "运行面（openclaw 内层调度）"
    if "Tool " in t and " not found" in t:
        return "运行面（openclaw 内层调度）"
    if '"expected"' in t and '"array"' in t:
        return "运行面（openclaw 内层调度）"
    if "requesterSenderId" in t or "无法识别请求者身份" in t:
        return "数据面（身份链路）"
    if "BAD_PARAM" in t or "参数" in t or "invalid" in t.lower():
        return "指令面/回包面"
    if '"truncated":true' in t.replace(" ", ""):
        return "指令面"
    if "warehouse_transient" in t or "502" in t:
        return "数据面（基础设施）"
    return "unknown"


def post(stream, batch):
    req = urllib.request.Request(
        "%s/api/%s/%s/_json" % (BASE, ORG, stream),
        data=json.dumps(batch, ensure_ascii=False).encode(),
        headers={"Authorization": "Basic " + AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:500]
        except Exception:
            detail = "<no body>"
        print("POST_FAIL stream=%s n=%d http=%s body=%s" % (stream, len(batch), exc.code, detail))
        sys.exit(1)


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: attribute.py <openclaw-agent.sqlite>")
    rows = read_rows(sys.argv[1], load_normalizer())
    hits = detect(rows)
    if not hits:
        print("ATTRIBUTE_OK stuck=0 (rows=%d)" % len(rows))
        return

    stuck, attributed, by_rule, by_layer = [], [], {}, {}
    for rule, hint, r, ev in hits:
        evs = json.dumps(ev, ensure_ascii=False)
        layer = layer_of(rule, evs)
        base = {"session_id": r.get("session_id"), "seq": r.get("seq"), "ts": r.get("ts"),
                "rule_ver": 3, "rule": rule, "evidence": evs}
        stuck.append(dict(base, layer_hint=hint))
        attributed.append(dict(base, layer=layer))
        by_rule[rule] = by_rule.get(rule, 0) + 1
        by_layer[layer] = by_layer.get(layer, 0) + 1

    r1 = post(DST, stuck)
    r2 = post(os.environ.get("ASK_ATTR_STREAM", "askdata_stuck_attr"), attributed)
    stats = [{"rule": k, "n": v} for k, v in by_rule.items()] + \
            [{"layer": k, "n": v} for k, v in by_layer.items()] + \
            [{"metric": "total", "n": len(hits)}, {"metric": "sessions", "n": len(set(
                h[2].get("session_id") for h in hits))}, {"metric": "rows_scanned", "n": len(rows)}]
    r3 = post(os.environ.get("ASK_STATS_STREAM", "askdata_stats"), stats)
    print("ATTRIBUTE_OK stuck=%d rows=%d by_rule=%s by_layer=%s"
          % (len(hits), len(rows), json.dumps(by_rule, ensure_ascii=False),
             json.dumps(by_layer, ensure_ascii=False)))
    print("  resp: stuck=%s attr=%s stats=%s" % (r1[:80], r2[:80], r3[:80]))


if __name__ == "__main__":
    main()
