# 智能问数演进回路 P1 实施计划（阶段二：T1–T4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 T0 证明「拿得到」的两路数据（会话库的**思考+对话序列**、OO 的**运行面**）变成可查询的轨迹，在其上实现「撞墙判据 → 归因到层 → 统计面」。

**Architecture:** **双通道**（T0 裁决）：主力是**会话库** `/home/node/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite` 的 `transcript_events`（思考逐字、按 `seq` 有序、不含运行面），辅以 **OO traces**（耗时/token/错误分类）。两者都以 **OO 为落脚**（不建平台表、不做迁移）——思考正文进 OO 已由用户 R1 裁决认下；**归因在同一处读**，避免跨系统 join。

**Tech Stack:** 宿主 `/etc/openobserve-ingest.env`（ingestion token）+ python3（**宿主没有 node**，实测）；OpenObserve v1.0.4（`_json` 摄取 + SearchSQL/MCP 读）；openship MCP（job/exec，唯一通道）；OpenClaw 2026.9.9。

## Global Constraints

逐字取自 spec（`docs/superpowers/specs/2026-10-16-askdata-evolution-loop-design.md`）与 T0 交付物（`docs/superpowers/notes/2026-10-16-t0-span-inventory.md`）：

- **通道形态（T0 后裁决）**：**会话库主 + OO 辅**。思考正文**不在** OO traces 里（`redacted:true`，实测），必须走会话库。
- **OO 摄取**：`POST {OO_BASE}/api/{OO_ORG}/<stream>/_json`，头 `Authorization: Basic $OO_AUTH`（`OO_AUTH` 是**裸 base64、空用户名**；漏 `Basic ` 前缀会 401）。
- **凭据**：只在**宿主 shell** 内 `source /etc/openobserve-ingest.env` 后使用；**不许进容器、不进 exec 输出、不进仓、不进 PR**。
- **会话库是容器状态卷**：宿主路径 `/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/agents/<agent>/agent/openclaw-agent.sqlite`。**只读打开**（容器在跑，有 WAL）。
- **宿主没有 node**（实测 `node: command not found`）⇒ 宿主侧脚本一律 **python3**。
- **一切运维走 openship MCP**，不裸 SSH。exec 的 `id`/`serviceId`/`serverId` 是**顶层参数**。
- **P1 非目标**：不建平台表/迁移、不改 `SKILL.md`、不自动改任何东西、不建回放集。
- 提交 Conventional Commits；PR **`Refs #741`**。

**关键坐标（T0 已实测，直接用）：**

| 项 | 值 |
|---|---|
| openclaw 宿主 serverId | `8281d598-af73-4d0b-99dd-bc8681fcc8bb` |
| openclaw 容器 | project `proj_GLXUtN2bJ92DpPrS` / serviceId `svc_3R9wVrQSz__9nwgc` |
| OO_BASE / OO_ORG | `https://observe.hookflow.cn` / `3IJ5tM4en3A06FzcJQhoHMTl4Xe` |
| 状态卷根（宿主） | `/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data` |
| 会话库（宿主） | `<卷根>/agents/<agent>/agent/openclaw-agent.sqlite` |
| OO traces 流 | `default`（type=traces，已在收 `service_name=openclaw-askdata`） |

---

## File Structure

| 文件 | 责任 |
|---|---|
| `scripts/askdata/export-transcript.py` | **读**会话库 `transcript_events` → 规范化 → **投** OO 日志流（增量、幂等） |
| `scripts/askdata/attribute.py` | 读 OO 轨迹 → 跑撞墙判据 → 归因到层 → 投 OO 撞墙事件流 |
| `scripts/askdata/sync-and-run.sh` | 宿主侧入口：`source` 凭据 → 把两个 py 同步到宿主 → 依次跑（openship job 的 command） |
| `docs/superpowers/notes/2026-10-16-t0-span-inventory.md` | 追加「轨迹字典」段（字段→含义），供后续判据引用 |
| openship job（控制面，无仓内文件） | 定时跑 `sync-and-run.sh` |

**为什么脚本落在宿主而不是容器**：凭据在宿主、会话库卷在宿主可直接只读、宿主有 python3；
放容器则要把凭据注进容器且要改镜像。

---

### Task 1: 轨迹导出（会话库 → OO）

**Files:**
- Create: `scripts/askdata/export-transcript.py`
- Create: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`（追加「轨迹字典」段）

**Interfaces:**
- Consumes: T0 的卷路径与凭据取法（见 Global Constraints）
- Produces: OO 日志流 **`askdata_trace`**，每行 = 一个规范化事件
  `{session_id, seq, ts, kind, role, tool_name, tool_args, tool_result, thinking, text}`
  （`kind ∈ {user, assistant_text, assistant_thinking, tool_call, tool_result, other}`；**只出现该行有的字段**）

- [ ] **Step 1: 先落「轨迹字典」——把真实字段写下来，别猜**

在宿主只读打开一个库，导出**前 3 个 session 的全部事件**，逐字段清点，把结果写进笔记：

```sh
V=/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data
python3 - "$V/agents/main/agent/openclaw-agent.sqlite" <<'PY'
import sqlite3, json, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro&immutable=0", uri=True)
rows = c.execute("select session_id, seq, event_json from transcript_events order by seq limit 400").fetchall()
kinds, ctypes, extra = {}, {}, set()
for sid, seq, ej in rows:
    if not ej: continue
    j = json.loads(ej)
    kinds[j.get('type')] = kinds.get(j.get('type'), 0) + 1
    extra |= set(j.keys())
    m = j.get('message') or {}
    if isinstance(m, dict) and isinstance(m.get('content'), list):
        for p in m['content']:
            k = f"{m.get('role')}/{p.get('type')}"
            ctypes[k] = ctypes.get(k, 0) + 1
print('event types:', kinds)
print('message content types:', ctypes)
print('event_json top keys:', sorted(extra))
PY
```

预期：`event types` 含 `message`；`message content types` 含 **`assistant/thinking`**、`assistant/toolCall`、`toolResult/text`；
`event_json top keys` 含 `type` / `message` / `timestamp` / `id`（**以你实测到的为准**）。
把**实测输出逐字**写进笔记的「轨迹字典」段——后续判据一律引用这份字典，**不许再猜字段名**。

- [ ] **Step 2: 写导出脚本（增量 + 幂等）**

`scripts/askdata/export-transcript.py`：

```python
#!/usr/bin/env python3
"""askdata 轨迹导出：openclaw 会话库 transcript_events → OO 日志流 askdata_trace。
宿主侧运行（凭据由外层 shell source /etc/openobserve-ingest.env 注入）。
增量靠 watermark 文件；幂等靠 _timestamp = 事件自身的 created_at（同 seq 重投不产生新语义）。"""
import json, os, sqlite3, sys, urllib.request, base64

STREAM = os.environ.get("ASK_TRACE_STREAM", "askdata_trace")
WM = os.environ.get("ASK_TRACE_WM", "/var/lib/askdata/export.watermark")
DB = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage: export-transcript.py <sqlite>")

base, org, auth = os.environ["OO_BASE"], os.environ["OO_ORG"], os.environ["OO_AUTH"]
url = f"{base}/api/{org}/{STREAM}/_json"

def norm(session_id, seq, ts, j):
    t = j.get("type")
    out = {"session_id": session_id, "seq": seq, "ts": ts, "kind": "other"}
    if t == "custom":
        out["kind"] = "custom"
        out["custom_type"] = j.get("customType")
        return out
    m = j.get("message")
    if not isinstance(m, dict):
        return out
    role = m.get("role")
    parts = m.get("content") if isinstance(m.get("content"), list) else []
    for p in parts:
        pt = p.get("type")
        if pt == "thinking":
            out["kind"], out["role"], out["thinking"] = "assistant_thinking", role, p.get("thinking")
        elif pt == "text":
            out["kind"], out["role"], out["text"] = "assistant_text", role, p.get("text")
        elif pt in ("toolCall", "tool_call"):
            out["kind"], out["role"] = "tool_call", role
            out["tool_name"] = p.get("name")
            out["tool_args"] = json.dumps(p.get("arguments"), ensure_ascii=False)
            out["tool_call_id"] = p.get("id")
        elif pt in ("toolResult", "tool_result"):
            out["kind"], out["role"] = "tool_result", role
            out["tool_result"] = json.dumps(p.get("content") or p.get("result"), ensure_ascii=False)
        else:
            out["kind"], out["role"] = "other", role
            out["raw_type"] = pt
        return out          # 一行事件只取第一个 part（多 part 各占一个 seq 时天然分开）
    if role == "user":
        out["kind"], out["role"], out["text"] = "user", role, json.dumps(parts, ensure_ascii=False)
    return out

os.makedirs(os.path.dirname(WM), exist_ok=True)
since = int(open(WM).read().strip()) if os.path.exists(WM) else 0
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
rows = c.execute(
    "select s.session_id, s.seq, s.created_at, s.event_json "
    "from transcript_events s where s.seq > ? order by s.seq limit 2000", (since,)).fetchall()
if not rows:
    print("EXPORT_OK rows=0 watermark=" + str(since)); sys.exit(0)

batch, maxseq = [], since
for sid, seq, ts, ej in rows:
    maxseq = max(maxseq, seq)
    if not ej: continue
    try: j = json.loads(ej)
    except Exception: continue
    batch.append(norm(sid, seq, ts, j))
if not batch:
    print("EXPORT_OK rows=0(parsed) watermark=" + str(maxseq)); sys.exit(0)

req = urllib.request.Request(url, data=json.dumps(batch, ensure_ascii=False).encode(),
                            headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read().decode()
    print(f"EXPORT_OK rows={len(batch)} watermark={maxseq} resp={body[:200]}")
except Exception as e:
    print(f"EXPORT_FAIL rows={len(batch)} err={e}"); sys.exit(1)
open(WM, "w").write(str(maxseq))
```

- [ ] **Step 3: 在宿主上跑一次，验「行真进了 OO」（不是「脚本说成功」）**

```sh
V=/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data
set -a; . /etc/openobserve-ingest.env; set +a
mkdir -p /var/lib/askdata
python3 /var/lib/askdata/export-transcript.py "$V/agents/main/agent/openclaw-agent.sqlite"
# 回读（用同一个 token 打 SearchSQL 或 MCP 的 SearchSQL 工具）
```

预期：`EXPORT_OK rows=N watermark=M`，且**回读 OO `askdata_trace` 流能查到刚投的行**（行数对得上）。
⚠️ **判据是「OO 里查得到」，不是脚本 print 的 OK。**

- [ ] **Step 4: 断点续跑验证（幂等 + 增量）**

再跑一次同一条命令。预期：`rows=0`（watermark 已推进），且 OO 里**行数不翻倍**。

- [ ] **Step 5: 提交脚本 + 笔记**

```bash
git add scripts/askdata/export-transcript.py docs/superpowers/notes/2026-10-16-t0-span-inventory.md
git commit -m "feat(askdata): #741 轨迹导出——会话库 transcript_events → OO askdata_trace（增量+幂等）"
```

---

### Task 2: 撞墙判据（轨迹 → 撞墙事件）

**Files:**
- Create: `scripts/askdata/attribute.py`
- Modify: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`（追加「判据」段）

**Interfaces:**
- Consumes: Task 1 的 `askdata_trace` 流（字段见 Task 1 Step 1 的字典）
- Produces: OO 流 **`askdata_stuck`**，每行 = 一条撞墙事件
  `{session_id, seq, rule, layer_hint, evidence, ts}`

- [ ] **Step 1: 落地判据（先跑「不依赖数值」的三条）**

只实现**判据本身不需要阈值**的三条（其余待真实数据标定）：

| rule | 判据（纯结构） | layer_hint |
|---|---|---|
| `same_tool_retry` | 同 `session_id` 内**相邻**两条 `tool_call` 的 `tool_name` 与 `tool_args` **完全相同** | 指令面（纪律「别原样重试」没生效） |
| `same_error_twice` | 同 `session_id` 内**相邻**两条 `tool_result` 文本**完全相同**且含 `error` | 指令面 / 回包面 |
| `truncated_unhandled` | `tool_result` 含 `truncated` 且其后**无**收窄迹象（下一条 tool_call 的 args 在同一 metric 上参数集**未变小**） | 指令面 |

写进 `scripts/askdata/attribute.py`：从 OO **读** `askdata_trace`（按 `session_id` 分组、按 `seq` 排序），
逐组滑窗判三条 rule，命中的写成 `askdata_stuck` 行（`evidence` 放命中那两行的 `seq` + 截断文本 200 字）。

- [ ] **Step 2: 跑一次，人工核对命中**

```sh
set -a; . /etc/openobserve-ingest.env; set +a
python3 /var/lib/askdata/attribute.py
```

预期：`ATTRIBUTE_OK stuck=N`。
**必做的人工核对**：把 N 条 `evidence` 逐条看一遍，**误判/漏判各记几条**进笔记「判据」段。
⚠️ T0 那条现成的撞墙轨迹（两次 `query_data` 同样失败于 `requesterSenderId 缺失`）**应当被 `same_tool_retry` 或 `same_error_twice` 命中**——
**没命中就说明判据写错了**，先修判据再往下。

- [ ] **Step 3: 提交**

```bash
git add scripts/askdata/attribute.py docs/superpowers/notes/2026-10-16-t0-span-inventory.md
git commit -m "feat(askdata): #741 撞墙判据三条（结构型）+ 命中人工核对记录"
```

---

### Task 3: 归因到层 + 统计面

**Files:**
- Create: `scripts/askdata/stats.py`
- Modify: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`（追加「归因与统计」段）

**Interfaces:**
- Consumes: `askdata_stuck`（Task 2）+ OO traces `default`（T0 已在收，`openclaw_errorcategory` / `openclaw_outcome` / `gen_ai_usage_*`）
- Produces: OO 流 **`askdata_stuck_attributed`** + 一份统计输出

- [ ] **Step 1: 定归因映射（规则表落进脚本常量，别散在 if 里）**

按 spec §4 T3 的映射表实现：`BAD_PARAM`→指令面/回包面；词表外/权限→数据面/人的面；
`truncated` 未收窄 / 超预算 / 原样重试→指令面；新鲜度误用→回包面；502/`warehouse_transient`→数据面。
**每条撞墙事件必须落到恰好一层**；落不下的写 `layer_hint='unknown'` 并**在笔记里记下来**（不认识就说不认识）。

- [ ] **Step 2: 统计面**

`stats.py` 输出四个数（按 `session_id` 与按指标分组）：同轮重试次数、撞墙事件数、按层分布、触顶/超预算计数。
同时把结果**投进 OO 流 `askdata_stats`**（这样后面能直接建看板，不用再跑脚本）。

- [ ] **Step 3: 跑一次并留证据**

```sh
set -a; . /etc/openobserve-ingest.env; set +a
python3 /var/lib/askdata/stats.py
```

预期：打印四组数字 + `STATS_OK`。把**逐字输出**贴进笔记。

- [ ] **Step 4: 提交**

```bash
git add scripts/askdata/stats.py docs/superpowers/notes/2026-10-16-t0-span-inventory.md
git commit -m "feat(askdata): #741 归因到层 + 真实统计面（含未知层的诚实记录）"
```

---

### Task 4: 定时化 + 收口

**Files:**
- Create: `scripts/askdata/sync-and-run.sh`
- Modify: `docs/superpowers/notes/2026-10-16-t0-span-inventory.md`

**Interfaces:**
- Consumes: Task 1–3 的三个脚本
- Produces: 一个 openship 定时 job

- [ ] **Step 1: 写宿主侧入口（含脚本同步）**

`sync-and-run.sh`：`source /etc/openobserve-ingest.env` → 把三个 py 从**仓内副本**写进 `/var/lib/askdata/`
（用 `cat > ... <<'EOF'` 内联，**别依赖宿主有 git**）→ 依次跑 export / attribute / stats。
**任一步非 0 退出即整体红**（fail-fast，别用 `|| true` 吞掉）。

- [ ] **Step 2: 注册 openship job（控制面，走 MCP）**

`post_jobs`：label `askdata-loop-t1t4`，`scheduleType=recurring`，cron 建议 **每小时一次、取非整点分钟**
（避开 tick 与其它 job 的同分钟点火），`serverId=8281d598-…`，command = `sh /var/lib/askdata/sync-and-run.sh`，
`notifyConfig` 挂失败告警。注册后**回读** `get_jobs_by_key` 确认 cron/enabled/retry 与预期一致（**改了什么验什么**）。

- [ ] **Step 3: 手动触发一次，验「job 跑通 + 数据进 OO」**

用 `post_jobs_by_key_run` 手动跑一次，读 run 日志确认三步都跑；再回读 OO 三个流确认有新行。
⚠️ **判据是两处都对**：job 记录绿 **且** OO 有新行。

- [ ] **Step 4: 收口登记**

- 笔记补「定时与运维」段：job key、cron、三个流名、失败时的排查顺序；
- **WeKnora 沉淀**（先 hybrid-search 查重，命中则更新原条目）：本轮回路的**两个反直觉事实**——
  ① `diagnostics-otel` 是独立插件、默认 disabled，只写配置会**静默零导出**；
  ② 思考在 span 里被 `redacted:true` 抹掉，而会话库里有正文。

- [ ] **Step 5: 提交 + 开 PR**

```bash
git add scripts/askdata/sync-and-run.sh docs/superpowers/notes/2026-10-16-t0-span-inventory.md
git commit -m "feat(askdata): #741 定时化（openship job）+ 运维收口 + 经验沉淀"
git push -u origin feat/741-t1-t4
gh pr create --base main --title "feat(askdata): #741 P1 阶段二——轨迹导出/撞墙判据/归因/统计面" \
  --body "Refs #741。**本 PR 的 code 完成不等于 T1–T4 完成**——按 spec §4，销账要等判据在真实数据上跑够量。"
```

CI CLEAN 后合并。

---

## 本阶段不做

- 不建平台表 / 不迁移 / 不改 `SKILL.md` / 不自动改任何东西 / 不建回放集（P2）；
- **不做判据的数值标定**——「超预算 / 触顶」这类需要阈值的，等 Task 2 Step 2 的真实分布出来再定（**不预先编数值**）。

## Self-Review

- **spec 覆盖**：对应 spec §4 的 T1（Task 1）/ T2（Task 2）/ T3（Task 3）/ T4（Task 3 Step 2）+ 定时化收口（Task 4）。
- **占位符扫描**：Task 1 Step 1 明写「以你实测到的为准」并给了**取字典的命令**——这是**必须现场取**的事实，不是 TBD。
  其余步骤均含可直接执行的具体值。
- **类型一致性**：Task 1 定义的轨迹字段（`kind`/`thinking`/`tool_args`/`tool_result`…）在 Task 2 的判据里**逐字复用**；
  流名 `askdata_trace` / `askdata_stuck` / `askdata_stats` 在各 task 间一致。
