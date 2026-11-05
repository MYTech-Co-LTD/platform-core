#!/usr/bin/env python3
"""askdata 轨迹导出：openclaw 会话库 transcript_events → OO 日志流 askdata_trace。
宿主跑（凭据 /etc/openobserve-ingest.env；卷在宿主可只读；宿主无 node 只有 python3）。
增量靠 watermark；幂等靠事件自身 created_at。
#1419（2026-11-05）：水位是**复合游标 (created_at, seq)**，不是全局 seq——`seq` 按 session 从 0
自增，全局 seq 水位会永久跳过之后的新会话。旧整数水位文件就地迁移（取该 seq 事件的 created_at）。
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

# 水位 = **复合游标** (created_at, seq)，不是全局 seq（#1419）。
# transcript_events.seq 按 session 从 0 自增 ⇒ 全局 seq 水位一旦越过大会话末尾，
# 之后每个新会话（seq 从 0 起）都永久低于水位、被静默跳过。用 created_at 先比、同 ts 再比 seq，
# 跨会话安全；不用 per-session map，是因为三个脚本的 tail/held/「水位不越过解不开的事件」
# 都建立在**单调整体游标**上，复合游标改动最小、语义最接近。
WM_EMPTY = (0, 0)
WM_COLS = "session_id, seq, created_at, event_json, event_zstd"
WM_AFTER = "(created_at > ?) or (created_at = ? and seq > ?)"


class DecodeError(Exception):
    """事件载荷解不出来（zstd 后端缺失 / 解压失败）。**绝不静默跳过**——见 main 的水位纪律。"""


def legacy_seq_to_cursor(db, old_seq):
    """旧版「全局 seq」水位 → 复合游标 (created_at, seq)。

    取 `seq <= old_seq` 里最大的那行（同一 seq 多会话时取**最大 created_at**；见 #1419）的
    created_at 作 ts。**绝不用「当前时间」当迁移 ts**——那会把 created_at 更早、尚未采集的
    会话永久丢掉。old_seq <= 0 = 还没采过 ⇒ (0,0)（等价于从最旧读起）。
    """
    old_seq = int(old_seq)
    if old_seq <= 0:
        return WM_EMPTY
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    try:
        row = con.execute(
            "select created_at from transcript_events where seq <= ? "
            "order by seq desc, created_at desc limit 1", (old_seq,)).fetchone()
    finally:
        con.close()
    ts = row[0] if row and isinstance(row[0], (int, float)) else 0
    return (int(ts), old_seq)


def read_watermark(path, db=None):
    """读水位 → (created_at, seq)；文件不存在 / 空 / 纯空白 ⇒ None（= 没有水位，首跑口径）。

    **格式兼容**：旧文件是纯整数（全局 seq）⇒ 就地迁移成该 seq 对应事件的 created_at。
    迁移需要库；`db=None` 时退化成 (0, old_seq)（从最旧重读，靠 created_at 幂等——
    宁可重读，也绝不跳过后来的新会话）。
    """
    if not os.path.exists(path):
        return None
    try:
        with open(path) as fh:
            raw = fh.read().strip()
    except OSError:
        return None
    if raw == "":
        return None
    try:
        val = json.loads(raw)
    except ValueError:
        val = None
    if isinstance(val, dict) and "ts" in val and "seq" in val:
        return (int(val["ts"]), int(val["seq"]))
    try:
        old_seq = int(raw)
    except ValueError:
        return None
    return legacy_seq_to_cursor(db, old_seq) if db else (0, old_seq)


def write_watermark(path, cursor):
    """原子写 JSON `{"ts": ..., "seq": ...}`：临时文件 + os.replace，不留半截水位。"""
    ts, seq = cursor
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = "%s.tmp-%d" % (path, os.getpid())
    with open(tmp, "w") as fh:
        json.dump({"ts": int(ts), "seq": int(seq)}, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def fmt_cursor(cursor):
    return "%d/%d" % (int(cursor[0]), int(cursor[1]))


def fetch_new_rows(con, cursor, limit):
    """按复合游标取新事件（created_at asc, seq asc）——与 main 用同一条 SQL，供回归测试复用。"""
    return con.execute(
        "select %s from transcript_events where %s "
        "order by created_at asc, seq asc limit ?" % (WM_COLS, WM_AFTER),
        (cursor[0], cursor[0], cursor[1], limit)).fetchall()


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

    os.makedirs(os.path.dirname(wm_path) or ".", exist_ok=True)
    con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    stored = read_watermark(wm_path, db)          # 旧整数格式在这里就地迁移（#1419）
    since = WM_EMPTY if stored is None else stored
    rows = fetch_new_rows(con, since, BATCH_LIMIT)
    if not rows:
        write_watermark(wm_path, since)           # 迁移后的游标落盘，别每轮重算
        print("EXPORT_OK rows=0 watermark=%s (no new events)" % fmt_cursor(since))
        return

    batch, watermark, failed, stall = [], since, 0, None
    for sid, seq, ts, ej, ez in rows:
        try:
            # #969：event_json 优先、空则解 event_zstd（大事件只存压缩态）。
            ev = decode_event(ej, ez)
        except (DecodeError, ValueError) as exc:
            # 水位纪律：**绝不越过解不出来的事件**——否则它永久丢失且不重试（旧的静默跳过正是这样）。
            # 钉住水位 = 停在这个事件之前、exit 非零（响亮）；下一轮重读同一行，运维修好后再前进。
            failed += 1
            stall = (ts, seq) if stall is None else stall
            print("EXPORT_DECODE_FAIL seq=%d ts=%d err=%s" % (seq, ts, exc))
            continue
        if stall is not None:
            # 已确定要停在失败点：其后的行本轮不处理（保持 (created_at,seq) 严格顺序、不跳洞）
            continue
        watermark = max(watermark, (ts, seq))
        if ev is None:
            continue                    # 库里确实无载荷（非丢数据），照常前进
        batch.extend(norm_parts(sid, seq, ts, ev.get("message"), ev.get("type"), ev.get("customType")))
    if stall is not None:
        # 停在失败事件**之前**（同一 ts 内回退一格；下一轮重新读到它）。
        watermark = min(watermark, (stall[0], stall[1] - 1))
    if not batch:
        print("EXPORT_OK rows=0 watermark=%s failed=%d" % (fmt_cursor(watermark), failed))
        write_watermark(wm_path, watermark)
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
        print("EXPORT_FAIL rows=%d watermark=%s http=%s body=%s"
              % (len(batch), fmt_cursor(watermark), exc.code, detail))
        sys.exit(1)
    except Exception as exc:
        print("EXPORT_FAIL rows=%d watermark=%s err=%s" % (len(batch), fmt_cursor(watermark), exc))
        sys.exit(1)
    write_watermark(wm_path, watermark)
    # 发出去的部分已落流、水位也钉在失败点前 ⇒ 本轮以非零退出提示「有事件没导出、等人处理」，
    # 但已发数据不丢（created_at 幂等，下一轮从失败点重读）。
    print("EXPORT_OK rows=%d watermark=%s failed=%d resp=%s"
          % (len(batch), fmt_cursor(watermark), failed, out[:200]))
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
