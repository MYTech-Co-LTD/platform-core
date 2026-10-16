#!/usr/bin/env python3
"""askdata 轨迹导出：openclaw 会话库 transcript_events → OO 日志流 askdata_trace。
宿主跑（凭据 /etc/openobserve-ingest.env；卷在宿主可只读；宿主无 node 只有 python3）。
增量靠 watermark；幂等靠事件自身 created_at。
字段形状实测 2026-10-16：
  assistant/thinking {thinking, thinkingSignature} / text {text} / toolCall {id,name,arguments}
  toolResult 的 part type 是 text、角色才是 toolResult；消息层带 toolCallId/toolName/isError
一条 message 的 content 可能是**字符串**（user 消息）也可能是**数组** ⇒ 字符串整体一行，数组每 part 一行。
"""
import json, os, sqlite3, sys, urllib.error, urllib.request

STREAM = os.environ.get("ASK_TRACE_STREAM", "askdata_trace")
WM_DEFAULT = "/var/lib/askdata/export.watermark"
BATCH_LIMIT = int(os.environ.get("ASK_TRACE_BATCH", "2000"))


def _norm_parts(session_id, seq, ts, msg, event_type, custom_type=None):
    base = {"session_id": session_id, "seq": seq, "ts": ts, "event_type": event_type}
    if event_type == "custom":
        row = dict(base)
        row.update({"kind": "custom", "custom_type": custom_type})
        return [row]
    if not isinstance(msg, dict):
        row = dict(base)
        row["kind"] = "other"
        return [row]

    role = msg.get("role")
    content = msg.get("content")

    # 坑1：字符串 content —— 整体一行，绝不迭代（迭代会逐字符摊成上万行）
    if isinstance(content, str):
        row = dict(base)
        row["role"] = role
        if role == "toolResult":
            row["kind"] = "tool_result"
            row["tool_name"] = msg.get("toolName")
            row["tool_call_id"] = msg.get("toolCallId")
            row["tool_result"] = content[:20000]
            row["is_error"] = bool(msg.get("isError"))
        elif role == "user":
            row["kind"] = "user"
            row["text"] = content[:20000]
        else:
            row["kind"] = "text"
            row["text"] = content[:20000]
        return [row]

    rows = []
    for part in (content or []):
        row = dict(base)
        row["role"] = role
        if isinstance(part, str):
            row["kind"] = "other"
            row["text"] = part[:20000]
        elif isinstance(part, dict):
            pt = part.get("type")
            if pt == "thinking":
                row["kind"] = "thinking"
                row["thinking"] = part.get("thinking")
                row["thinking_signature"] = part.get("thinkingSignature")
            elif pt == "text":
                # 坑2：角色优先 —— toolResult 的正文也是 type=text
                if role == "toolResult":
                    row["kind"] = "tool_result"
                    row["tool_name"] = msg.get("toolName")
                    row["tool_call_id"] = msg.get("toolCallId")
                    row["tool_result"] = (part.get("text") or "")[:20000]
                    row["is_error"] = bool(msg.get("isError"))
                elif role == "user":
                    row["kind"] = "user"
                    row["text"] = (part.get("text") or "")[:20000]
                else:
                    row["kind"] = "text"
                    row["text"] = (part.get("text") or "")[:20000]
            elif pt in ("toolCall", "tool_call"):
                row["kind"] = "tool_call"
                row["tool_name"] = part.get("name")
                row["tool_call_id"] = part.get("id")
                row["tool_args"] = json.dumps(part.get("arguments"), ensure_ascii=False)
            else:
                row["kind"] = "other"
                row["raw_type"] = str(pt)
        else:
            row["kind"] = "other"
        rows.append(row)
    if not rows:
        row = dict(base)
        row["kind"] = "other"
        row["role"] = role
        rows.append(row)
    return rows


def norm_parts(*a, **kw):
    # 丢掉值为 None 的键：OO 的 _json 批量端点遇 null 会整批 400（实测）
    return [{k: v for k, v in r.items() if v is not None} for r in _norm_parts(*a, **kw)]


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: export-transcript.py <openclaw-agent.sqlite>")
    db = sys.argv[1]
    wm_path = os.environ.get("ASK_TRACE_WM", WM_DEFAULT)
    base, org, auth = os.environ["OO_BASE"], os.environ["OO_ORG"], os.environ["OO_AUTH"]
    url = "%s/api/%s/%s/_json" % (base, org, STREAM)

    os.makedirs(os.path.dirname(wm_path), exist_ok=True)
    since = 0
    if os.path.exists(wm_path):
        txt = open(wm_path).read().strip()
        since = int(txt) if txt else 0

    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    rows = con.execute(
        "select session_id, seq, created_at, event_json from transcript_events "
        "where seq > ? order by seq limit ?", (since, BATCH_LIMIT)).fetchall()
    if not rows:
        print("EXPORT_OK rows=0 watermark=%d (no new events)" % since)
        return

    batch, maxseq, skipped = [], since, 0
    for sid, seq, ts, ej in rows:
        maxseq = max(maxseq, seq)
        if not ej:
            continue
        try:
            ev = json.loads(ej)
        except Exception:
            skipped += 1
            continue
        batch.extend(norm_parts(sid, seq, ts, ev.get("message"), ev.get("type"), ev.get("customType")))
    if not batch:
        print("EXPORT_OK rows=0 watermark=%d skipped=%d" % (maxseq, skipped))
        open(wm_path, "w").write(str(maxseq))
        return

    req = urllib.request.Request(url, data=json.dumps(batch, ensure_ascii=False).encode(),
                                 headers={"Authorization": "Basic " + auth,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            out = resp.read().decode()
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode()[:600]
        except Exception:
            detail = "<no body>"
        print("EXPORT_FAIL rows=%d watermark=%d http=%s body=%s"
              % (len(batch), maxseq, exc.code, detail))
        sys.exit(1)
    except Exception as exc:
        print("EXPORT_FAIL rows=%d watermark=%d err=%s" % (len(batch), maxseq, exc))
        sys.exit(1)
    open(wm_path, "w").write(str(maxseq))
    print("EXPORT_OK rows=%d watermark=%d skipped=%d resp=%s"
          % (len(batch), maxseq, skipped, out[:200]))


if __name__ == "__main__":
    main()
