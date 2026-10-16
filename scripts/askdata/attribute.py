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
                    hits.append(("same_tool_retry", "指令面", r,
                                 {"a_seq": prev_call_seq, "b_seq": r.get("seq"),
                                  "tool": cur[0], "args": cur[1][:200]}))
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


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: attribute.py <openclaw-agent.sqlite>")
    rows = read_rows(sys.argv[1], load_normalizer())
    hits = detect(rows)
    if not hits:
        print("ATTRIBUTE_OK stuck=0 (rows=%d)" % len(rows))
        return
    batch = [{"session_id": r.get("session_id"), "seq": r.get("seq"), "ts": r.get("ts"),
              "rule_ver": 2, "rule": rule, "layer_hint": layer,
              "evidence": json.dumps(ev, ensure_ascii=False)}
             for rule, layer, r, ev in hits]
    req = urllib.request.Request(
        "%s/api/%s/%s/_json" % (BASE, ORG, DST),
        data=json.dumps(batch, ensure_ascii=False).encode(),
        headers={"Authorization": "Basic " + AUTH, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = resp.read().decode()
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:500]
        except Exception:
            detail = "<no body>"
        print("ATTRIBUTE_FAIL stuck=%d http=%s body=%s" % (len(batch), exc.code, detail))
        sys.exit(1)
    by_rule = {}
    for rule, _, _, _ in hits:
        by_rule[rule] = by_rule.get(rule, 0) + 1
    print("ATTRIBUTE_OK stuck=%d rows=%d by_rule=%s resp=%s"
          % (len(batch), len(rows), json.dumps(by_rule, ensure_ascii=False), out[:160]))


if __name__ == "__main__":
    main()
