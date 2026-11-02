#!/usr/bin/env python3
"""askdata 轨迹导出：openclaw 会话库 transcript_events → OO 日志流 askdata_trace。
宿主跑（凭据 /etc/openobserve-ingest.env；卷在宿主可只读；宿主无 node 只有 python3）。
增量靠 watermark；幂等靠事件自身 created_at。
#969（2026-11-03）：大事件只存 `event_zstd`（event_json 为空）——旧版只读 event_json 且先前进
watermark，大事件**永久丢失且静默**。现读两列（json 优先、空则解 zstd；后端=zstandard 包或
zstd CLI，均缺则响亮失败）；**解不出来的事件钉住水位**（停在它之前、exit 1），下一轮重试，
绝不越过未导出事件。`--self-test` 自检后端与两种解码形态。
字段形状实测 2026-10-16：
  assistant/thinking {thinking, thinkingSignature} / text {text} / toolCall {id,name,arguments}
  toolResult 的 part type 是 text、角色才是 toolResult；消息层带 toolCallId/toolName/isError
一条 message 的 content 可能是**字符串**（user 消息）也可能是**数组** ⇒ 字符串整体一行，数组每 part 一行。
"""
import json, os, shutil, sqlite3, subprocess, sys, urllib.error, urllib.request

STREAM = os.environ.get("ASK_TRACE_STREAM", "askdata_trace")
WM_DEFAULT = "/var/lib/askdata/export.watermark"
BATCH_LIMIT = int(os.environ.get("ASK_TRACE_BATCH", "2000"))


class DecodeError(Exception):
    """事件载荷解不出来（zstd 后端缺失 / 解压失败）。**绝不静默跳过**——见 main 的水位纪律。"""


def _zstd_decompress(blob):
    # 后端优先级：python zstandard 包（pip 装了就用）→ zstd CLI（宿主一般都装）。
    # 两个都没有 ⇒ 响亮失败：宁可停摆，也不把「读不出来的事件」当不存在（#969 的静默丢失前车）。
    try:
        import zstandard  # type: ignore
        return zstandard.ZstdDecompressor().decompress(bytes(blob))
    except ImportError:
        pass
    zstd = shutil.which("zstd")
    if zstd is None:
        raise DecodeError("需要 zstd 后端：python zstandard 包与 zstd CLI 均不可用")
    p = subprocess.run([zstd, "-d", "-c"], input=bytes(blob), capture_output=True)
    if p.returncode != 0:
        raise DecodeError("zstd 解压失败: %s" % p.stderr.decode("utf-8", "replace")[:200])
    return p.stdout


def decode_event(event_json, event_zstd):
    # #969：openclaw 对大事件写 event_zstd（event_json 为空）。只读 event_json ⇒ 大事件永久丢失。
    # 两者都空 = 该事件确实无载荷（返回 None，不是丢数据）。
    if event_json:
        raw = event_json
    elif event_zstd:
        raw = _zstd_decompress(event_zstd)
    else:
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    return json.loads(raw)


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
        "select session_id, seq, created_at, event_json, event_zstd from transcript_events "
        "where seq > ? order by seq limit ?", (since, BATCH_LIMIT)).fetchall()
    if not rows:
        print("EXPORT_OK rows=0 watermark=%d (no new events)" % since)
        return

    batch, maxseq, failed, stall = [], since, 0, None
    for sid, seq, ts, ej, ez in rows:
        try:
            # #969：event_json 优先、空则解 event_zstd（大事件只存压缩态）。
            ev = decode_event(ej, ez)
        except (DecodeError, ValueError) as exc:
            # 水位纪律：**绝不越过解不出来的事件**——否则它永久丢失且不重试（旧的静默跳过正是这样）。
            # 钉住水位 = 停在这个事件之前、exit 非零（响亮）；下一轮重读同一行，运维修好后再前进。
            failed += 1
            stall = seq if stall is None else stall
            print("EXPORT_DECODE_FAIL seq=%d err=%s" % (seq, exc))
            continue
        if stall is not None:
            # 已确定要停在失败点：其后的行本轮不处理（保持严格顺序、不跳洞）
            continue
        if ev is None:
            maxseq = max(maxseq, seq)   # 库里确实无载荷（非丢数据），照常前进
            continue
        maxseq = max(maxseq, seq)
        batch.extend(norm_parts(sid, seq, ts, ev.get("message"), ev.get("type"), ev.get("customType")))
    if stall is not None:
        maxseq = min(maxseq, stall - 1)
    if not batch:
        print("EXPORT_OK rows=0 watermark=%d failed=%d" % (maxseq, failed))
        open(wm_path, "w").write(str(maxseq))
        sys.exit(1 if failed else 0)

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
    # 发出去的部分已落流、水位也钉在失败点前 ⇒ 本轮以非零退出提示「有事件没导出、等人处理」，
    # 但已发数据不丢（created_at 幂等，下一轮从失败点重读）。
    print("EXPORT_OK rows=%d watermark=%d failed=%d resp=%s"
          % (len(batch), maxseq, failed, out[:200]))
    if failed:
        sys.exit(1)


def self_test():
    """能力自检（--self-test）：zstd 后端在不在 + 解码两种形态对不对。C1 失败即响亮。"""
    payload = json.dumps({"type": "message", "message": {"role": "assistant", "content": "hi"}}).encode()
    zstd = shutil.which("zstd")
    blob = None
    if zstd is not None:
        blob = subprocess.run([zstd, "-q", "-c"], input=payload, capture_output=True).stdout
        ev = decode_event(None, blob)
        assert ev["message"]["content"] == "hi", "zstd 解压后内容不一致"
    ev2 = decode_event('{"type":"custom"}', None)
    assert ev2["type"] == "custom", "event_json 路径异常"
    assert decode_event(None, None) is None, "空载荷应返回 None"
    if blob is None:
        print("SELF_TEST_FAIL 缺 zstd CLI（也可 pip install zstandard）")
        sys.exit(1)
    print("SELF_TEST_OK zstd 后端=CLI decode=ok")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--self-test":
        self_test()
    else:
        main()
