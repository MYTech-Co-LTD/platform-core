# duckle serve 调度器停机跨点火界：`misfire: all` 补跑 / `skip` 记 skipped——实测案例

> 2026-09-29 ｜ worker `task_e2654263140f`（Orca dispatch `ctx_83104fe9853d`）
> 出发点：Wave B 投递预检② 此前只有**源码结论**（platform-core #324 评论：
> `catch_up_schedule` / `occurrences.rs:139-143` / `serve.rs:4461/4961`）。
> 本报告把它升级为**实测案例**。
>
> **本报告全部活动**：本机 `/private/tmp/misfire-lab-324/`（本地最小 workspace +
> 本地 `duckle serve` 调度面）＋只读源码阅读。**零生产**：未碰任何生产容器、
> 未 ssh 生产机、未动仓内生产管线、未用真实凭据。console 只绑回环
> （127.0.0.1:8093 / 8094，无 token）。

---

## 0. 结论速览

1. **`misfire: "all"` 补跑成立（实测）**：serve 停机跨过点火界后重启，
   首个调度 tick 从账本锚点（`last_recorded`）枚举错过窗口，对每个错过时刻
   **先记 Fired 再跑**，多界**按时间顺序逐个补跑**（实测一次跨 3 界全部按序补上）。
2. **`misfire: "skip"` 记 skipped 不补成立（实测）**：重启后首个 tick 对错过时刻
   记 `{"decision":"skipped","reason":"overdue, and this schedule's misfire policy is skip"}`，
   **不产生任何 run 记录**。
3. **两个政策都验证了 AC3（不双跑）**：停机窗口外每个点火界恰好一次 run；
   补跑 run 与正常调度 run 在 `runs/*.json` 里**不可区分**（都是 `trigger: "scheduled"`），
   区分证据只在 serve 日志的 `catching up <时刻>` 行和 occurrences 账本的
   `scheduledFor` vs `decidedAt` 落后差。
4. **实测出一处源码注释未覆盖的账本现象（稳态双记）**：serve 正常运行时，
   每个点火界会被**记两条**——catch-up 先把「刚过界的时刻」当 overdue 记一条，
   同一 tick 正常路径再记一条。`all` 政策下是**两条相同 Fired**（无害）；
   `skip` 政策下是 **skipped + fired 同 `occurrenceId` 同 `decidedAt` 的矛盾对**（见 §7）。
   **读生产账本审计「漏跑」时必须以 Fired + run 记录为准，skipped 行会多记。**
5. **首见只布防不点火（实测侧证）**：空账本时 catch-up 无锚不动作，首个界由正常
   路径点火——`catch_up` 的 `last_recorded == None ⇒ 返回空`（occurrences.rs:281-283）。
6. **对生产 `30 2,10 * * *` 的外推边界**：补跑语义与 cron 粒度无关，但生产的
   低频 cron、分钟级长 run、catch-up 期间再崩溃、bounds 截断四点让结论不能照搬，
   逐条见 §8。

---

## 1. 环境与可复现

| 件 | 值 |
|---|---|
| duckle 二进制 | `/private/tmp/duckle-lab-p1/.venv074/bin/duckle`（pip 包 `duckle==0.7.4` 的入口，**即 duckle-runner**）；`duckle serve --help` 可用 |
| DuckDB CLI | `/private/tmp/duckle-lab-p1/.venv074/bin/duckdb`（同 venv，serve `--duckdb` 显式给入） |
| 源码树（只读对照） | `/Users/duo/Documents/mytechcode/source-analysis/duckle-latest`，`b62e8ce release: v0.7.4`，与生产同版本线 |
| lab 根 | `/private/tmp/misfire-lab-324/`，两个 workspace：`ws-skip/`、`ws-all/` |
| serve 参数 | `--workspace <ws> --duckdb <venv>/duckdb --port 8093|8094 --tick-interval 2`（host 缺省即 127.0.0.1；tick 收到 2s 是为压缩实验墙钟，缺省 15s） |
| cron | `*/1 * * * *`，`"timezone": "UTC"`——点火界=每分钟整点，便于精确卡窗口 |

**二进制取得过程**（谁要复现先知道）：`which duckle / duckle-runner` 均无；
`Duckle.app`（`~/Applications/`）是个 4 文件的壳（Edge PWA 快捷方式）无捆绑 runner；
本机无 cargo/rustup。于是复用既有 lab 的 pip venv（`duckle==0.7.4`，与源码树
b62e8ce 同版本）。`cargo build -p duckle-runner` 兜底路线因无工具链未走，不影响结论。

### workspace 文件（两个 ws 除 misfire 外逐字节相同）

`pipelines/trivial.json`（平凡管线，调度语义与管线内容无关，不上真实 Wave B 管线）：

```json
{
  "name": "trivial",
  "nodes": [
    { "id": "sql1", "position": {"x": 0, "y": 0}, "data": { "label": "SQL", "componentId": "code.sql", "properties": { "sql": "SELECT 1 AS n" } } },
    { "id": "out1", "position": {"x": 200, "y": 0}, "data": { "label": "Out", "componentId": "snk.csv", "properties": { "path": "logs/hits.csv" } } }
  ],
  "edges": [ { "id": "e1", "source": "sql1", "target": "out1", "sourceHandle": "main", "targetHandle": "main", "data": { "connectionType": "main" } } ]
}
```

`ws-skip/schedules.json`（`ws-all` 把 `"misfire": "skip"` 换成 `"all"`，其余相同）：

```json
[
  {
    "id": "sched-trivial",
    "pipeline_id": "trivial",
    "name": "trivial",
    "enabled": true,
    "kind": { "type": "cron", "expr": "*/1 * * * *" },
    "timezone": "UTC",
    "misfire": "skip"
  }
]
```

> 账本里的 `scheduleId` 记的是 **pipeline_id（`trivial`）不是 schedule 自己的 id
> （`sched-trivial`）**：tick 循环以 `load_schedules` 投影的 map key（pipeline_id）
> 作 schedule_id 传进 `catch_up_schedule`（serve.rs:4920/4961）。查账本按管线 id grep。

事前校验（两条管线均过）：

```sh
/private/tmp/duckle-lab-p1/.venv074/bin/duckle validate /private/tmp/misfire-lab-324/ws-skip/pipelines/trivial.json
# ok ...(2 stages)
```

---

## 2. 时间线总表（全部 UTC，`date -u` 实录）

### ws-skip（阴性对照）

| 时刻 | 事件 |
|---|---|
| 02:00:38 | serve 启动（8093）；首 tick 只**布防**不点火 |
| 02:01:00→02:01:01.36 | **基线点火**：Fired 记账；run `...7261373` 02:01:01.62 ok |
| 02:01:57 | `kill -9`（下一个界 02:02:00 前 3 秒） |
| 02:02:00 | **界在停机中跨过** |
| 02:02:52 | serve 重启 |
| 02:02:54.53 | 重启后首个 tick：**Skipped 记账（无 run）**——阴性对照成立 |
| 02:03:00.55 | 稳态界：skipped+fired **同 occurrenceId 同 tick 双记**，恰好 1 次 run（02:03:00.77） |
| ~02:03:35 | 停 serve 冻结现场 |

### ws-all（主案例 + 加码）

| 时刻 | 事件 |
|---|---|
| 02:03:32 | serve 启动（8094） |
| 02:04:00.66 | **基线点火**（空账本无锚→正常路径点，单条记录） |
| 02:04:58 | `kill -9`（界 02:05:00 前 2 秒） |
| 02:05:00 | 界在停机中跨过 |
| 02:05:57 | serve 重启 |
| 02:05:59.64 | 重启后首个 tick：**Fired 记账 → `catching up 2026-09-29T02:05:00+00:00` → run `...559659` 02:05:59.89 ok**——补跑成立 |
| 02:06–02:09 | 稳态运行：每界 catch-up 路径点火 1 次、账本每界双条 Fired |
| 02:09:24 | `kill -9`（此时最后记账锚=02:09:00） |
| 02:10 / 02:11 / 02:12 | **三个界在停机中跨过**（原计划跨 2 界，实际停机窗拉长到 3 界，正好加码） |
| 02:12:09 | serve 重启 |
| 02:12:11.68 | 首个 tick：**三条 Fired 同 tick 记账，三 run 顺序执行** 02:12:11.85 / .90 / .96（对应 02:10→02:11→02:12，按序） |
| 02:13:01 | 稳态界再次双条 |
| 02:13:47 | 停 serve 冻结现场 |

---

## 3. 基线与账本条目原文

`<workspace>/.duckle/occurrences.ndjson` 逐字摘录（NDJSON，每行一条）。

**基线 Fired（ws-skip，02:01 界，正常路径）**：

```json
{"occurrenceId":"occ-902f98c378958985","scheduleId":"trivial","scheduledFor":"2026-09-29T02:01:00+00:00","local":"2026-09-29 02:01:00","timezone":"UTC","decision":"fired","decidedAt":"2026-09-29T02:01:01.360248+00:00"}
```

对应 run 记录（`runs/trivial.json` 数组元素，完整原文）：

```json
{
  "run_id": "run-scheduled-trivial-1790647261373",
  "at": "2026-09-29T02:01:01.620480+00:00",
  "status": "ok",
  "duration_ms": 242,
  "rows": 1,
  "node_count": 2,
  "trigger": "scheduled",
  "nodes": [
    { "node": "out1", "component": "snk.csv", "durationMs": 0, "rows": 1 },
    { "node": "sql1", "component": "code.sql", "durationMs": 214, "rows": 1 }
  ]
}
```

决策字段形状（与 occurrences.rs `Decision` 的 serde `tag="decision"` 一致）：
`fired` 无附加字段；`skipped` 带 `reason`；`excluded`（本实验未触发）。
`decidedAt` 与 `scheduledFor` 的差即调度滞后。

---

## 4. 阴性对照：`misfire: "skip"` 跨界重启 ⇒ 记 skipped、无 run

停机窗 02:01:57→02:02:52 跨过 02:02:00 一界。重启后账本新增（逐字）：

```json
{"occurrenceId":"occ-2e8ef46ce549d4a2","scheduleId":"trivial","scheduledFor":"2026-09-29T02:02:00+00:00","local":"2026-09-29 02:02:00","timezone":"UTC","decision":"skipped","reason":"overdue, and this schedule's misfire policy is skip","decidedAt":"2026-09-29T02:02:54.530641+00:00"}
```

- **无对应 run**：`runs/trivial.json` 全程只有 2 条（02:01:01 基线、02:03:00 稳态界），
  02:02:00 缺席；serve 日志无 `catching up`、无 `scheduled trivial -> ok` 落在该窗。
- reason 字符串与源码逐字一致（occurrences.rs:225）。
- serve 日志该阶段无任何报错——skip 是静默决策，只在账本可见。

**skip 稳态界（02:03:00，serve 正常运行）的账本原文**——§7 双记现象的实证：

```json
{"occurrenceId":"occ-4dea121904ad81d4","scheduleId":"trivial","scheduledFor":"2026-09-29T02:03:00+00:00","local":"2026-09-29 02:03:00","timezone":"UTC","decision":"skipped","reason":"overdue, and this schedule's misfire policy is skip","decidedAt":"2026-09-29T02:03:00.554709+00:00"}
{"occurrenceId":"occ-4dea121904ad81d4","scheduleId":"trivial","scheduledFor":"2026-09-29T02:03:00+00:00","local":"2026-09-29 02:03:00","timezone":"UTC","decision":"fired","decidedAt":"2026-09-29T02:03:00.554709+00:00"}
```

同一 `occurrenceId`、同一 tick（decidedAt 逐字节相同）：先 skipped（catch-up 把刚过界
的 02:03:00 当 overdue）后 fired（正常路径）。**run 恰好一次**（02:03:00.77）。

---

## 5. 主案例：`misfire: "all"` 跨一界重启 ⇒ 补跑

停机窗 02:04:58→02:05:57 跨过 02:05:00 一界。重启后账本新增（逐字）：

```json
{"occurrenceId":"occ-5743f5de489b9069","scheduleId":"trivial","scheduledFor":"2026-09-29T02:05:00+00:00","local":"2026-09-29 02:05:00","timezone":"UTC","decision":"fired","decidedAt":"2026-09-29T02:05:59.645634+00:00"}
```

serve 日志（stderr → serve.log）：

```
duckle-runner: trivial: catching up 2026-09-29T02:05:00+00:00
duckle-runner: scheduled trivial -> ok
```

run 记录：`run-scheduled-trivial-1790647559659  at=2026-09-29T02:05:59.896907+00:00 ok rows=1`。

时序细节与源码一致：**先记账（02:05:59.64）后起 run（02:05:59.89）**
（serve.rs:4542-4546 注释：「Recorded BEFORE its run, so a crash mid-catch-up
leaves that occurrence decided」）。

## 6. 加码：跨三界重启 ⇒ 三条按序补跑

停机窗 02:09:24→02:12:09 跨过 02:10:00 / 02:11:00 / 02:12:00 三界
（任务书要 ≥2 界，实际窗拉长到 3 界，证据更足）。重启后**同一 tick**（decidedAt
同为 02:12:11.681253）记三条 Fired，随后**单线程按时间顺序**逐个跑：

```
duckle-runner: trivial: catching up 2026-09-29T02:10:00+00:00
duckle-runner: trivial: catching up 2026-09-29T02:11:00+00:00
duckle-runner: trivial: catching up 2026-09-29T02:12:00+00:00
```

| scheduledFor（错过时刻） | run at（实际执行） | 状态 |
|---|---|---|
| 02:10:00 | 02:12:11.854022 | ok rows=1 |
| 02:11:00 | 02:12:11.905778 | ok rows=1 |
| 02:12:00 | 02:12:11.968004 | ok rows=1 |

三条 run 间隔 ~50ms、顺序与错过时刻严格一致——#329「ONE thread for the whole
catch-up, not one per occurrence」的实测形状（serve.rs:4514-4522）。
全实验 `runs/trivial.json` 共 10 条 = 10 个点火界各恰好一条，无重跑无漏跑（AC3）。

---

## 7. 与源码预期的偏差与补充观察

1. **稳态双记（两政策都有，源码注释未覆盖）**。`catch_up_schedule` 在 tick 里排在
   正常点火判定**之前**（serve.rs:4961 先于 4968），而 `last_recorded` 天然落后
   「最近已过界」一个界（该界要到同一 tick 稍后才被正常路径记账）。于是 serve
   正常运行时每个界都被 catch-up 先看一遍：
   - `all`：catch-up 把它 Fired 并起 run；正常路径随后也记一条 Fired（dispatch 被
     in_flight 拒绝，`still running, not started again`，但 `record_occurrence`
     无条件先记了）⇒ **两条逐字节相同的 Fired**。实测 02:06/02:07/02:08/02:09/02:13
     每界双条。
   - `skip`：catch-up 记 Skipped；正常路径照常点火记 Fired ⇒ **skipped+fired 矛盾对**
     （§4 末尾原文）。
   **影响**：账本不再满足「每个 occurrence 恰好一条结局」的字面预期（occurrences.rs
   模块注释「Every occurrence gets an outcome」）；但**不产生双跑**（run 锁 + in_flight
   双保险），AC3 不破。审计口径：**判「真漏跑」看 skipped 行是否缺同 occurrenceId 的
   Fired 同 tick 行 + 缺 run**；只有 skipped 行才是真漏。这是 tick 交错的确定性后果，
   不是竞态；单测（occurrences.rs 内嵌 tests）只测 catch_up 孤立逻辑，没盖 tick 交错，
   所以源码阅读时看不出来——这正是本 lab 的增量。
2. **补跑 run 在 run 记录里不可辨识**：catch-up 与正常调度同走
   `fire_schedule → run_scheduled → execute_one(…, "scheduled", …)`，
   `runs/*.json` 的 `trigger` 都是 `scheduled`。区分只能靠 serve 日志
   `catching up` 行，或账本 `decidedAt - scheduledFor > tick` 的落后差。
   生产排障时别指望 run 记录自带「这是补跑」标记。
3. **账本 scheduleId = pipeline_id**（§1 已注）：grep 账本别用 schedule 自己的 id。
4. **`misfire` 缺省即 skip**（occurrences.rs:133-139 `#[default] Skip`）：生产
   schedules.json 没写 misfire 的旧调度，跨界即静默 skipped——与升级前行为一致，
   但现在**账本有痕**。
5. 其余全与源码预期吻合：skip reason 逐字、先记账后 run、单线程按序补跑、
   首见布防不点火、（last_recorded, now] 半开窗、bounds 缺省 31 次/45 天。

---

## 8. 对生产 Wave B（cron `30 2,10 * * *`）的外推边界

lab 用 `*/1` 分钟级 UTC cron 验证的是**调度语义机制**（锚点枚举/决策/记账/按序补跑），
对任何 cron 表达式同构。但下述各点 lab **未覆盖或不可照搬**，逐条说清：

1. **停机窗要真压到界上才有意义**。生产一天 2 界（02:30/10:30，按调度自身
   timezone 枚举）。常规发版/重启窗口（分钟级、避开整半点）跨不到界，
   catch-up 枚举为空、什么都不发生——`misfire: all` 不是「每次重启都重跑」，
   是「停机压到界上才补」。反过来：**若重启恰在 02:30 后几分钟内完成，错过的
   02:30 界会被立即补跑**，与当天 10:30 的正常跑叠加成一天两跑——对
   retail.windows 这类全量重算幂等的 L1 管线是安全冗余，对不幂等管线要先想清楚。
2. **补跑是串行长任务，不是 50ms**。lab run 250ms；Wave B foreach 长 run 下，
   N 个错过界 = N 次全量管线**串行**执行（#329 单线程设计），且 in_flight 占用
   期间后续 catch-up 顺延到下个 tick。跨多界补跑的墙钟 = N × 单次 run 时长，
   会顶到资源池/下游窗口，**不是瞬间追平**。
3. **补跑中再崩溃 = 该界丢（不会再来一次）**。「先记 Fired 后起 run」的顺序意味着
   记账与 run 完成之间崩溃，该 occurrence 已是 decided，下次重启**不再补**
   （源码注释明说这是刻意的：serve.rs:4542-4546）。届时要靠定向重试（run 级），
   不是再重启一次调度器。lab 的重启都落在 run 窗外，这条是**源码锚定的告诫，
   未实测**。
4. **bounds 截断**：缺省 `maxCatchupRuns: 31 / maxCatchupAgeDays: 45`
   （occurrences.rs:158-164）。对一天 2 界 = 停机超 ~15.5 天的部分**静默丢最老的**、
   只补最新 31 个。生产停机不可能这么长，但若手改 bounds 要知道方向是「保新弃旧」。
5. **timezone**：lab 钉 UTC；生产调度按其 `timezone` 字段经共享求值器枚举
   （cronzone，occurrences.rs:166-174 注释），机制同构，**未做跨时区实测**
   （如 DST 边界行为）。
6. **kill -9 vs 优雅停机**：lab 全用 SIGKILL 模拟崩溃。账本是 append-only NDJSON
   且读侧容忍撕裂行（occurrences.rs:119-124），崩溃安全性有设计保证；
   优雅停机（SIGTERM）路径未单测，不预期差异。
7. **双记现象会出现在生产账本**（§7.1）：读生产 occurrences.ndjson 做「漏跑审计」
   时，`skip` 政策下的 skipped+fired 同 tick 对是稳态噪音，别误报。

---

## 9. 逐字命令（复现用，路径为本机实录）

```sh
# --- 建 workspace（两个） ---
BASE=/private/tmp/misfire-lab-324
for W in ws-skip ws-all; do mkdir -p ${BASE}/${W}/pipelines; done
# pipelines/trivial.json、schedules.json 内容见 §1（heredoc 写入，cat > file <<'EOF' ... EOF）

# --- 校验 ---
D=/private/tmp/duckle-lab-p1/.venv074/bin
${D}/duckle validate ${BASE}/ws-skip/pipelines/trivial.json

# --- 起 serve（回环；tick 2s） ---
cd ${BASE}/ws-skip
nohup ${D}/duckle serve --workspace ${BASE}/ws-skip --duckdb ${D}/duckdb --port 8093 --tick-interval 2 > ${BASE}/ws-skip/serve.log 2>&1 &
echo $! > ${BASE}/ws-skip/serve.pid

# --- 观测（任意时刻） ---
cat ${BASE}/ws-skip/.duckle/occurrences.ndjson
python3 -c "import json; d=json.load(open('${BASE}/ws-skip/runs/trivial.json')); [print(r['run_id'], r['at'], r['status']) for r in d]"
grep -n "catching up" ${BASE}/ws-skip/serve.log

# --- 卡界杀（看准 date -u 的秒位，界前几秒执行） ---
date -u "+kill at %Y-%m-%dT%H:%M:%SZ"
kill -9 $(cat ${BASE}/ws-skip/serve.pid)

# --- 跨界后重启（同命令再起一次；日志用 >> 续接） ---
nohup ${D}/duckle serve --workspace ${BASE}/ws-skip --duckdb ${D}/duckdb --port 8093 --tick-interval 2 >> ${BASE}/ws-skip/serve.log 2>&1 &
echo $! > ${BASE}/ws-skip/serve.pid2

# --- 冻结 ---
kill -9 $(cat ${BASE}/ws-skip/serve.pid2)
cp ${BASE}/ws-skip/.duckle/occurrences.ndjson ${BASE}/ws-skip/occurrences-final.txt
```

ws-all 同构，仅 `--port 8094`、`--workspace .../ws-all`、`misfire: "all"`。

## 10. 现场留存

- `/private/tmp/misfire-lab-324/ws-skip/`：occurrences-final.txt（4 条）、runs/trivial.json（2 条）、serve.log（两次启动全量）
- `/private/tmp/misfire-lab-324/ws-all/`：occurrences-final.txt（15 条）、runs/trivial.json（10 条）、serve.log
- 两 workspace 的 `.duckle/`、`logs/`（含 hits.csv 落点、`logs/trivial/` 运行日志）原样保留
