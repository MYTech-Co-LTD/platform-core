# Wave C — `lemeng.retail.tick` / `lemeng.retail.close` 以 L1 tick 形首建

> **worker**: term_5b5857ee-a1fa-4b7c-9ad4-e05534e45231 ／ task_0365b8e104d3 ／ dispatch ctx_5865dff5b9bf
> **worktree**: `/Users/duo/orca/workspaces/platform-core/wavec-tick`（分支 `ylwzzs/wavec-tick`，基线 `7e5e48b`）
> **issue**: #332（`Refs #318`）
> **活动范围**: 纯仓内改动 + 本机 lab（mock 网关 127.0.0.1:8899 / MinIO 容器 `waveB-lab-minio`）。
> **零生产**：不 seed、不碰任何容器/调度/64188、不调 openship、不激活任何调度条目。
> 本批所有 JSON 均为**声明态**（`enabled:false`），落仓≠生效。

---

## 0. 一句话结论

`lemeng.retail.tick` / `lemeng.retail.close` 两条**从未在任何环境运行过**的管线，以 L1 tick 形
（父 = 窗口表 + `ctl.foreach`，子 = 逐窗采集）**首建**落仓：父管线两条各 19 节点/22 边、子管线
一条 20 节点/20 边，全部 `validate_pipeline` 通过；lab 上正反向场景全跑通（窗口形状、跨子管线隔离、
checkpoint 语义、判红路径、重试标定、覆盖幂等）；**tick 取 `misfire: skip`**（理由见 §4，结论是
catchup 对这两条管线**结构上补不回任何窗**，skip 已足够且不会与实时调度争抢同一 sink 对象）。
同时发现一处 **Wave B 遗留缺陷**：retail 两个子管线缺 `snk.minio` 的 `bucket` 必需属性 ⇒ Wave B
投递的 owners 新鲜度锚实际是**死规则**（§6）。

---

## 1. 方法与环境

### 1.1 被验对象与判据

| 被验对象 | 判据 |
|---|---|
| `pipelines/lemeng.retail.tick.l1.json` | 编译通过；h≥1 取 2 窗（cur 先 / prev 后）、h=0 仅 prev 1 窗；子管线 `checkpoint=false`；身份门未证时业务请求数 = 0；判红可复现 |
| `pipelines/lemeng.retail.close.l1.json` | 编译通过；恰 1 窗（prev）；复用 `.window` 子管线且 `checkpoint=true` 生效；与 tick 不串味 |
| `pipelines/lemeng.retail_order_line.tick.json` | 与 `.window` 仅 3 处差异（12× `checkpoint:false`、回执路径、`_note`）；不产生任何 `state/` 目录 |
| `schedules/3120.json` | 两条新条目 `enabled:false` + lock 重生成 |
| `alerts.json` | tick L1 冷却 60（高频档）/ close L1 冷却 15（日批档），按 ⑨ 分档判据 |

判据全部落在 **lab 实测**上，不用「读代码觉得对」代替。

### 1.2 时间钉法

两条父管线的窗口**由执行时刻的墙钟推导**：`w0` 的 `FROM (SELECT now() AT TIME ZONE 'Asia/Shanghai' AS ts) z`，
`run_token` 由 `${datetime}` 变形而来。所以 lab 必须把 `now()` 替换成固定 `TIMESTAMPTZ` 才能钉住场景：

| pin | 上海本地 | 期望 |
|---|---|---|
| A | `2026-09-28 23:05` | h=23 ⇒ 2 窗：`(2026-09-28, 23)` 为 cur、`(2026-09-28, 22)` 为 prev |
| B | `2026-09-29 00:05` | h=0 ⇒ tick 仅 1 窗 `(2026-09-28, 23)`；close 亦取该窗 |
| D | `2026-09-28 01:05` | h=1 ⇒ 2 窗：`(2026-09-28, 01)` 先、`(2026-09-28, 00)` 后 |

### 1.3 沙箱替换清单（`lab.py derive` 只改这五处，不含行为）

1. `https://cloud.nhsoft.cn/agi` → `http://127.0.0.1:8899/agi`（mock 网关）
2. `/workspace/` → lab 工作区根（**路径形状逐字不变**，只是换根）
3. `now()` → `TIMESTAMPTZ '<pin>'`（仅钉窗场景）
4. `"retryBackoffMs": 60000` → `200`（只影响 lab 墙钟，不改语义；`retryAttempts` 不动）
5. `--retry N` 覆盖 `fe.retryAttempts`（**仅用于标定**，默认不传）

除这五处，仓内文件与 lab 跑的文件逐字节相同。

### 1.4 本批实测踩到的坑（复现时先看）

- **凭据解不开时连接加载是 fail-open**：干掉 `.duckle/keys/secret.key` ⇒ 密文解不开 ⇒
  请求**不带 Authorization 头**出去（不是报错），mock 回 `401 {"error":"mock: bearer token required"}`。
  真正把这一轮判红的是**父管线的 v0 身份门**（exit=1），不是连接层。详见 §7。
- **`snk.minio` 的 `useSsl` 要写字符串 `"false"`**，写 JSON/Python 布尔 `False` 会被当成真值以外的
  东西 ⇒ `IO Error: SSL connect error … HTTP PUT to 'https://127.0.0.1:9900/…'`。dim L0 用的是
  `"useSsl": "true"`，同一约定。
- **`counts` 类统计要按 kind 过滤**：mock 的访问日志里每个 run 都有一行 `whoami` 身份探针，
  按裸行数统计会把身份探针算进业务请求数（曾把「重采 12 页」误报成「重采 1 页」）。
- **`rc=$?` 在管道后取的是管道末命令的退出码**，要读真退出码就得单独跑一次、别接管道。

---

## 2. 交付面（改了什么）

### 2.1 文件清单

| 文件 | 状态 | 形状 |
|---|---|---|
| `deploy/duckle/console/pipelines/lemeng.retail.tick.l1.json` | **新增** | 19 节点 / 22 边（`ok (19 stages)`） |
| `deploy/duckle/console/pipelines/lemeng.retail.close.l1.json` | **新增** | 19 节点 / 22 边（`ok (19 stages)`） |
| `deploy/duckle/console/pipelines/lemeng.retail_order_line.tick.json` | **新增** | 20 节点 / 20 边（`ok (20 stages)`） |
| `deploy/duckle/console/schedules/3120.json` | 改 | 10 → 12 条目，新增两条 **`enabled:false`** |
| `deploy/duckle/console/alerts.json` | 改 | 9 条规则（新增 tick.l1 / close.l1 两条）+ `_note` ⑪ |
| `deploy/data-plane.lock` | 改 | 重生成 |

### 2.2 三条管线的形状

父管线（tick / close **同构**，19/22）节点序：

```
v0 身份探针（whoami 形状闸 + retryAttempts=3 / backoff 2000）
  → d0 形状闸 → g3 两条身份断言 → d1 → gv 期望值形状闸 → dv
  → w0 窗口表（唯一事实源）
  → su 摘要表骨架 → wm/wsink 落 _windows-pending.csv → fe ctl.foreach → a2 → dz 判红收口
```

`dv → w0` 走 on-subjob-ok：**身份未证时窗口表不生成 ⇒ 业务请求数 0**（lab 已验）。

`fe`（`ctl.foreach`）属性逐字：

| 管线 | `pipelineRef` | `itemKey` | `concurrency` | `retryAttempts` | `retryBackoffMs` | `continueOnFailure` |
|---|---|---|---|---|---|---|
| tick.l1 | `${workspace}/pipelines/lemeng.retail_order_line.tick.json` | `hour` | 1 | **2** | 60000 | true |
| close.l1 | `${workspace}/pipelines/lemeng.retail_order_line.window.json` | `hour` | 1 | **4** | 60000 | true |

### 2.3 子管线：复用 vs 新建（这是本批最需要交代的裁量）

| 父 | 子管线 | 决定 | 理由 |
|---|---|---|---|
| `close` | `lemeng.retail_order_line.window.json`（Wave B 已交付） | **复用** | close 每天只跑一次、**闭窗**（那一个小时已经走完、内容不再变），`checkpoint=true` 的「同键跳过」正是想要的：`S3` 实测重跑 **0 次 posorder 请求**。且 `S2` 实测 close 取 `(2026-09-28, 23)` 时**不复用 tick 刚写的状态**（12 次全新请求）⇒ 两条父共用一条子管线**不串味**。 |
| `tick` | `lemeng.retail_order_line.tick.json`（**新建**，checkpoint=false 变体） | **不复用** | tick 采的是**还没走完的小时**（累积窗）。checkpoint 的复用键 = 子节点配置指纹（url/method/body/responsePath）+ 父行；h=10 那次在 10:05 与 10:10 的父行**逐字节相同** ⇒ 若 `checkpoint=true`，10:10 会直接吃 10:05 的首快照，**把累积窗冻住**。`S1b` 实测 checkpotion=false 时同 pin 重跑**再发 24 次**（2 窗 × 12 页），证明确实每次都真采。 |

差异只有 3 处，便于审阅：12 处 `"checkpoint": false`、回执路径
`/workspace/logs/retail-tick/${ITER_ITEM_BIZDAY}-${ITER_ITEM_HOUR}.csv`、`_note`。

> **附带结论（写进 close 的 `_note` ④）**：checkpoint 状态目录名 = 子管线**文件名**参与构成
> （实测 `state/lemeng_retail_order_line_window_23/checkpoints/p1..p12.ndjson`，引擎用 `_` 连接）。
> 推论：**重命名子管线文件 = 该子管线的状态全部失效**——失效会导致**重采**，不会**错采**，
> 是安全方向。另：**同一窗不要并行两条路径**（两条父同时打同一窗会各写各的、互相覆盖）。

### 2.4 对计划字面的一处订正：窗口表必须走**行值**，不能走 `ctl.setvar`

计划原文把「cur/prev 日期」描述成可经变量传递的值。实测不行：`ctl.setvar` 的值会被 runner
改写为 `'…' || (SELECT …)` 形态注入，而**进不了 sink key/路径**（会撞
`Parser Error: syntax error at or near "||"`）。本批一律把窗口值作为**行值**流进 foreach 的
item（`w0` 直接 `SELECT … FROM (SELECT now() …) z` 产出 `hour_from`/`hour_to`/`bizday`/`system_book`/
`branch_nums`/`batch_id` 等列），由 foreach 的 `itemKey` 取值 —— 这是本批与计划字面唯一的一处
有意偏离，依据是实测。

### 2.5 任务书路径订正

任务书给的 lab 配方路径 `docs/superpowers/specs/2026-09-28-duckle-l1-retail-waveB-verify.md`
**不存在**；实际文件是 `docs/superpowers/specs/2026-09-29-duckle-l1-retail-waveB-verify.md`
（差一天）。任务书里 `wave1-prep` 的路径是对的。已按实际文件读。

---

## 3. cron 选值依据（逐字）

`deploy/duckle/console/schedules/3120.json` 是一个**列表**（10 条目 → 本批后 12 条）。两条新条目逐字：

```json
{"id": "panel-lemeng.retail.tick.l1", "pipeline_id": "lemeng.retail.tick.l1", "name": "lemeng.retail.tick.l1",
 "enabled": false, "kind": {"type": "cron", "expr": "*/5 0-15 * * *"},
 "timezone": "UTC", "misfire": "skip",
 "catchup": {"maxCatchupRuns": 31, "maxCatchupAgeDays": 45}}

{"id": "panel-lemeng.retail.close.l1", "pipeline_id": "lemeng.retail.close.l1", "name": "lemeng.retail.close.l1",
 "enabled": false, "kind": {"type": "cron", "expr": "0 16 * * *"},
 "timezone": "UTC", "misfire": "all",
 "catchup": {"maxCatchupRuns": 31, "maxCatchupAgeDays": 45}}
```

**选值依据**：同文件里**仍在生效**的薄壳条目是现成先例，cron 表达式**逐字沿用**：

- `panel-lemeng.retail.tick.run`：`*/5 0-15 * * *`，`enabled: true`
- `panel-lemeng.retail.close.run`：`0 16 * * *`，`enabled: true`

即 `*/5 0-15 * * *` **UTC** = 上海 **08:00–23:55**，每 5 分钟一次 ⇒ **192 次/营业日**；
`0 16 * * *` **UTC** = 上海 **00:00** 次日 ⇒ h=0 ⇒ **仅 prev 一窗**（正是日批兜底要的）。

两处与薄壳条目**不同**、且是有意的：

1. **显式 `"timezone": "UTC"`**。薄壳条目没写 tz（依赖系统默认），新条目补齐——与 Wave B 的
   `panel-lemeng.retail.windows.l1`（`"timezone": "UTC"`）保持同一风格。
2. **`misfire` / `catchup` 显式声明**。薄壳条目两项皆无；新条目按 §4 的论证写死（tick `skip`、
   close `all`），`catchup` 逐字对齐同文件既有条目（`maxCatchupRuns: 31, maxCatchupAgeDays: 45`）。

> `enabled:false` 是**声明态**：本批只落「就绪」，激活是投递批次的独立决定（见 §8）。

---

## 4. tick 的 misfire 论证（结论 + 理由）

### 4.1 前提：窗口是**执行时刻**算出来的，不是「这次该采哪窗」算出来的

`w0` 的 SQL 是 `SELECT … FROM (SELECT now() AT TIME ZONE 'Asia/Shanghai' AS ts) z`。这意味着
**一次补跑（catchup）在 02:00 执行时，算出来的是「02:00 这一刻该采的窗」，而不是「00:00 那次没跑成的窗」**。
对 tick 就是 h=2 ⇒ 采 `(今天,01)` 与 `(今天,00)`；对 close 更直接——它只认 prev，02:00 补跑
仍然是取 `(今天,01)`。

**推论（本论证的关键）**：catchup **结构上就补不回任何错过的窗**。`misfire: all` 对这两条
管线**不是**「补采机制」，它只会产生**重复采集**（重算出来的窗通常已经被实时调度采过）。

### 4.2 tick 的自愈窗口恰好是 1 个 tick —— 这是它比 close 强的地方

tick 每个小时天然被采两次：作为 `cur` 被 H 时刻的 tick 采一次，作为 `prev` 被 H+1 时刻的 tick 再采一次。
⇒ **漏掉一次 tick（5 分钟），那个小时总还会被下一次 tick 以 prev 身份采到**；
**缺口 ≥ 2 个 tick（≥10 分钟）时，最早漏掉的那个小时不会再被任何后续 tick 采到**
（后续 tick 的 prev 只回看 1 小时）。

### 4.3 192 次/日 vs `maxCatchupRuns: 31`

- 停机 2 小时 = **24 个逾期界**（24 ≤ 31，还没触发截断）；
- 停机 > 2.6 小时即超 31 ⇒ `maxCatchupRuns` **保新弃旧**，把最早的那批逾期界丢掉。

也就是说：**catchup 既补不回正确的窗（§4.1），真要补出量来又会被上限截断**，且 24 个补跑是
**串行**的（单个 run 墙钟 × 24），会跟实时调度抢同一批 sink 对象。

### 4.4 幂等性：sink 是 overwrite，所以「重复采」不是灾难——但也不是收益

sink key `lemeng/retail_order_line/system_book=…/bizday=…/hour=…/all.parquet`、`mode: overwrite`、
key 里**不含 run_token** ⇒ 同窗重采是**覆盖同一对象**。`E3` 实测：仓形状跑一次后，MinIO 里
`hour=22`/`hour=23` 的 mtime = 本次 run 时间，而 `hour=00–21` 仍是 Wave B 那次的 01:0x
⇒ 覆盖幂等成立、且不会污染其它窗。

所以：**重复采集不会坏数据**（这是 `skip` 安全的底层理由），但也**不带来任何补偿**——
它只是把已经有的对象再写一遍（还多打一轮网关）。

### 4.5 close 的 `all` 不是「补窗」，是「日批兜底」

close 的窗（`(bizday, 23)`）**只在紧邻那天的凌晨可重建**（过了那个点 `now()` 推导出的就是新一天）。
`all` 补一次 = 1 窗 12 页，代价很小，且与同文件既有先例（`windows.l1` = `all`、dim L0 = `skip`）
一致。但按 §4.1，**它同样补不回错过的那个窗**。close 真正的价值在别处：它是**日批兜底层**——
canon 里 `count(DISTINCT batch_id)` 按 hour = 1 的那条锚**只对日批兜底层成立**
（tick 的累积窗里同一 hour 分区只有一个 batch_id，但那是另一回事）。

### 4.6 结论

> **tick 取 `misfire: skip` 已足够。** 理由三条：
> ① catchup 用执行时刻重算窗口 ⇒ **补不回正确的窗**（§4.1），`all` 只会造重复；
> ② tick 漏 1 次可由下一次 tick 的 prev 自愈（§4.2），真正需要干预的是 **≥2 个 tick 的缺口**，
>    而那种缺口 catchup 也无能为力；
> ③ 重复采集虽幂等安全（§4.4），但要在 5 分钟节奏的夹缝里串行跑最多 24 次补跑，**净收益为负**。
>
> **close 取 `all`**：代价小（1 窗）、与先例一致，但**必须写清楚它不是补窗机制**。
>
> **⚠️ 缺口的真实补法不在 misfire**：≥2 tick 的漏采必须走**投递批次的补采 SOP**
> （canon #260：`run-retail-day.sh recon <H>` 对照 + 定点重跑）。本报告把它列为**待定项**（§9），
> 因为「怎么定点补一个已过去的小时」目前没有现成工具——`run-retail-day.sh` 是否支持指定小时
> 重跑，本批**未验**（零生产约束下不去碰 64188）。

---

## 5. lab 证据

证据目录 `/tmp/waveC-lab/evidence/`（lab-only，不进仓）。lab 配方与驱动器 `/tmp/waveC-lab/lab.py`
（沙箱替换见 §1.3）。

### 5.1 窗口形状（正向）

| 场景 | pin（上海） | 结果 |
|---|---|---|
| `S1-tick-h23` | 23:05 | **24 次 posorder 请求** = 2 窗 × 12 页；顺序 hour 23(cur) 先、hour 22(prev) 后；exit 0、19 stages ok、9055 ms |
| `S1b` 同 pin 重跑（保留 state） | 23:05 | **又是 24 次** ⇒ checkpoint=false 无「首快照冻结」；且**不生成任何 `state/` 目录** |
| `S4-tick-h0` | 00:05 | **12 次**，仅 1 窗 `(2026-09-28, 23)` ⇒ **h=0 仅 prev** 成立 |
| `S5-tick-h1` | 01:05 | **24 次**：`(…,01)` 先、`(…,00)` 后 |

### 5.2 跨子管线不串味 + 复用生效（S2 / S3）

| 场景 | 结果 |
|---|---|
| `S2-close-h0` | pin 00:05 取 `(2026-09-28, 23)`——**正是 tick 刚写过的同一窗** ⇒ **12 次全新请求 = 0 复用 = 不串味** |
| `S3-close-h0-rerun` | 同 pin 重跑 ⇒ **0 次 posorder 请求** ⇒ `checkpoint=true` 复用生效 |

状态目录实测拼写：`state/lemeng_retail_order_line_window_23/checkpoints/p1..p12.ndjson`。

### 5.3 判红路径 + `fe.retryAttempts` 标定

故障注入 = mock 的 `(hour=23, page=1)` 恒 500。**实测规律：`retryAttempts = N` ⇒ 实际尝试 `N−1` 次。**

| 场景 | `retryAttempts` | page1 尝试次数 | 备注 |
|---|---|---|---|
| `S7-tick-fail-retry1` | 1 | **0** | ⇒ 必然判红（等同「不重试」） |
| `S7-tick-fail-retrydefault2` | 2 | **1** | 整轮 12 页重采 1 次 |
| `S7-tick-fail-retry3` | 3 | **2** | |
| `S8-tick-fail-retry4` | 4 | **3** | |
| `S9-close-fail` | 4 | page1 ×3 + 其余 11 页 ×1 = **14** | close 是 `checkpoint=true` ⇒ **只重发失败的那一页** |

> `N` vs `N−1` 的**语义差未定位**（引擎侧），本批只标定取值、不改口径。tick 最终取 **2**（= 1 次
> 尝试，对齐薄壳 tick 的语义）；close 取 **4**（= 3 次尝试，对齐薄壳的「1 次首跑 + 2 轮重试 + 60s 退避」）。
> tick 之所以不取 4：重试是**整轮 12 页**，3 次退避 × 60s 会顶穿 5 分钟节奏；且累积窗的下一 tick
> 本身就是更全的天然重试。

**截尾（实测，`S8`）**：某窗永久失败时，**item 循环被中止**——window 23 失败 ⇒ window 22
**从未被请求**（`child-runs.txt` 只列 `lemeng.retail_order_line.tick_23`）；但摘要台账把两窗
**都标记为 `missing`** ⇒ 失败**可见**，不是静默。

### 5.4 覆盖幂等（`E3`）

按**仓形状**（回环 mock + lab MinIO）跑 tick：exit 0；摘要台账 22/23 两行 `ok`；
MinIO 里 `hour=22`/`hour=23` 的 mtime = 本次 run 时间，`hour=00–21` 保持 Wave B 那次的时间
⇒ **overwrite 幂等成立**，且缺 `bucket` 属性**不阻断写路径**（见 §6）。

### 5.5 重试吸收瞬态失败（`E2b`）

一次**瞬时**失败（page 9 秒回 html 400、`duration_ms: 0`）被 `retryAttempts=2` 吸收：
attempt 1 失败 → attempt 2 全 12 页 200 → 下游全部 ok。⇒ `retryAttempts=2` 对瞬态抖动是够用的。

---

## 6. ⚠️ 发现：retail 两个子管线缺 `snk.minio` 的 `bucket` ⇒ Wave B 的新鲜度锚是**死规则**

### 6.1 证据（`catalog` lab 实测，逐字）

用 `catalog build` / `catalog lint` / `catalog owners` 在**仓形状**（未打补丁）上跑：

- `catalog build` exit 0：`4 pipelines, 8 assets, 32 links`，同时 stderr **`2 source/sink node(s) could not be named`**。
- `catalog lint` **exit 1**，逐字：
  `owners.json: asset rule 'minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet' (data-eng) matches nothing in this workspace`
  以及 `8 asset(s) have no owner`。
- `catalog owners`：`0 of 8 assets have an owner.`

补上 `"bucket": "${ENV:ZOS_BUCKET}"` 后（仅 2 处，两个子管线的 sink 节点）：

- `catalog build`：`4 pipelines, 9 assets, 34 links`（多出 1 个 asset ⇒ 之前那个 sink 节点**根本没被命名**）
- `catalog lint` **exit 0**：`catalog lint: nothing to report.`
- `catalog owners`：`1 of 9 assets have an owner.`
- asset id = `minio://${ENV:ZOS_BUCKET}/lemeng/…/all.parquet`（**占位符未解析**）

### 6.2 影响

`snk.minio` 的 schema 里 **`bucket` 是 `required: true`**；dim L0 两条 sink 都带
`bucket/region/urlStyle/useSsl`，而 retail 的两个子管线只有 `connectionRef` + `key`
⇒ **catalog 无法命名这两个 sink 节点** ⇒ `owners.json` 里那条 retail 资产规则
（`match: "minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet"`，
owner `data-eng`，`maximumAge: 36h`）**匹配不到任何东西**。

后果：**零售数据的陈旧告警（36h 无更新）根本不会响**——而 CI 里**没有 catalog-lint 守卫**
（六条静态守卫不含它）⇒ 这是**只有手工跑 `catalog lint` 才能看见**的缺陷。

### 6.3 修法与安全性（F1）

修 = 给两个子管线的 sink 节点各补一行 `"bucket"`（2 处）。

**安全性已实证**：`F1` 指纹测试——加/删 sink 属性**不影响**子管线的 checkpoint 状态
（跑三次：12 → **0** → **0** 次 posorder 请求）。⇒ **checkpoint 指纹覆盖的是 fetch/API 节点，
不含 sink** ⇒ 补 `bucket` 是**状态中性**的，不会让已交付的 Wave B 状态失效。

> 但要诚实标注：asset id 里是 `${ENV:ZOS_BUCKET}` **模板字符串**（占位符不解析），
> 所以**新鲜度探测能否真的打到一个具体对象上，本批未验**——补 `bucket` 解决了「能否命名」，
> 没证明「探测能否命中」。

### 6.4 处置

这是一处**越界**：`lemeng.retail_order_line.window.json` 是 **Wave B 已交付**的文件，
本批 TASK 未授权改它。已向协调者发 `ask` 请示 A/B 两方案：

- **A**（推荐）：本 PR 一并修（2 行 + 重生成 lock），因为 `checkpoint=false` 的 `.tick` 是我新建的、
  `.window` 那处是 Wave B 遗留，一处不修则 owners 规则仍然死。
- **B**：本 PR 不动，只记为**投递前必办项**。

**`ask` 已超时（`timedOut: true`、`answer: null`，600 s 上限）⇒ 按预先声明的默认执行 B：
本 PR 不动 Wave B 已交付的 `.window`**（绝不擅改他人已交付文件）。
若后续协调者答 A，则另开一个 PR 补这两行并重生成 lock，本节随之更新。

> 为什么不做「只修我新建的 `.tick`」这种折中：`owners.json` 那条规则的 glob 是
> `minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet`，
> **两条子管线写的是同一个资产**。只让 `.tick` 能命名、`.window` 仍不能 ⇒ 规则**照样是死的**，
> 却额外制造了两条子管线的不一致。**要么两条都补，要么都不补**。

无论 A/B：`owners.json` 那条规则的**生效前提**（asset 能被命名）**必须在投递批次里复核**
（§8 必办项）。

---

## 7. 凭据事件：删 `.duckle/` ⇒ fail-open ⇒ 401 ⇒ 父管线身份门判红

实验期间为了强制重建 catalog，脚本 `shutil.rmtree(WS/.duckle)` 把 `.duckle/keys/secret.key`
（32 bytes，0600）一起删了 ⇒ 连接文件里的密文（`enc:v2:` 的 `authToken`/`accessKey`/`secretKey`）
**解不开**。

**实测行为（值得沉淀）**：连接加载失败**不报错**（fail-open），请求**不带 Authorization 头**出去
（mock 访问日志里 kind = `noauth`），mock 返回 `401 {"error":"mock: bearer token required"}`。
最终把整个 run 判红的是**父管线的 v0 身份门**（exit=1）。

⇒ **「连接加载失败要单独探活」这条已经写在 `docs/superpowers/specs/2026-09-28-duckle-child-value-paths.md:392`**；
本批实测**再次印证**：fail-open 下唯一的兜底就是**管线自己的身份门**，这条门不能省。

**修复**：`/tmp/waveC-lab/mkconn.py` 重新生成密钥（32 bytes、mode 600）并**在进程内**取
MinIO root 凭据（`docker inspect waveB-lab-minio`）与 mock bearer 重新封装两条连接——
**不经 argv、不回显**。

> 另注：生产 workspace 的 `.duckle/keys/` 生命周期（换机/重建后谁分发密钥）是
> Wave B spec 已列的**人确认项**（`2026-09-29-duckle-l1-retail-waveB-verify.md` §330/§523），
> 本批把它如实保留为未决，不擅自定方案。

---

## 8. 投递清单草案（**本 PR 之外**，属投递批次）

> 本批只落**声明态**（`enabled:false`）。下面是「真正切换」时要办的事，写进投递 PR 的清单。

### 8.1 必办（阻塞生效）

1. **成对启停（一条 pipeline 只在一侧跑）**：
   启用 `panel-lemeng.retail.tick.l1` / `panel-lemeng.retail.close.l1` 的**同一次变更**里，
   必须处置**仍在 `enabled:true`** 的薄壳条目 `panel-lemeng.retail.tick.run` /
   `panel-lemeng.retail.close.run`。**两侧同时跑 = 同一窗两条路径互相覆盖**（见 §2.3 的
   「同一窗不要并行两条路径」）。
2. **重建 catalog**：`catalog build` 必须在投递后跑一次，并**人工确认**
   `2 source/sink node(s) could not be named` 这类 stderr **归零**（否则 §6 的死规则依旧）。
3. **§6 的 `bucket` 修复**（若 §6.4 落 B，则这里是它的落地处）+ 复核
   `catalog owners` 里 retail 资产**确实有 owner**、`catalog lint` exit 0。
4. **告警规则同批 seed 进卷**：`alerts.json` 的两条新规则（tick.l1 / close.l1）要与管线**同批**
   生效，否则父 run 判红不会告警。
5. **回滚点**：切换前记录当刻的 `alerts.json` / `schedules/3120.json`（以及被停的薄壳条目的
   启用状态），回滚 = 把两侧**成对**还原。

### 8.2 对照验收（计划 Wave C step 3 要求）

- **并行对照**：L1 tick 与薄壳 `run-retail-day.sh tick` **并行跑一段**，逐小时比对
  `hour` 分区对象的内容（batch_id / 行数）。
- **canon #260 对账**：闭窗小时后跑 `run-retail-day.sh recon <H>`，**容差 0**。

### 8.3 激活后自查

- owner 自检：`catalog lint`（含 `--strict`）+ `catalog owners`。
- 告警自检：确认 `alerts ⑨` 分档判据下两条规则的冷却值没被「顺手对齐」（见下）。
- **不要**把 `lemeng.retail.*.l1` 合并成一条宽 glob 规则（alerts `_note` ⑩ 已定案）。

### 8.4 告警分档的**有意不一致**（别顺手「对齐」）

`alerts.json` `_note` ⑪ 已写明：

| 规则 | 冷却 | 档 |
|---|---|---|
| `lemeng.retail.tick.l1` | **60** | 高频档（5 分钟节奏 ⇒ 同档冷却） |
| `lemeng.retail.close.l1` | **15** | 日批档 |
| `lemeng.retail.tick.run`（薄壳） | 60 | 既有 |
| `lemeng.retail.close.run`（薄壳） | **60** | 既有——**这是 ⑧ 口径过宽**（close 一直是日批一次） |

⇒ 新 close L1 用 **15**、薄壳 close 用 **60**，是**有意不一致**。且子管线**逐窗 run 有意不配规则**
（父 run 红会汇聚）。

> `_note` ⑪ 末行已写：「📌 生效前提同 ⑨⑩：seed 进卷；且**调度仍 `enabled:false`**
> （声明就绪、不激活，激活是投递批次的独立决定）⇒ 现在不会产出任何 run 事件。」

---

## 9. 未验 / 边界说明

诚实列出本批**没有**验证的东西：

1. **生产从未运行**：两条 L1 管线**一次都没在真实环境跑过**（零生产约束）。网关的真机响应形状、
   真机吞吐、真机 `now()` 时区行为均未验。
2. **misfire 从未在真实停机中演练**：§4 的论证是**从 `w0` 的 SQL 结构性推导**出来的（配 lab 的
   钉窗实验佐证窗口确由执行时刻算），但**没有真的把调度停 2 小时再看**。
3. **192 次/营业日的墙钟预算未测**：单 run lab 墙钟 ~9 s（钉窗、mock），真实网关下的单次耗时
   与「5 分钟节奏能否稳定容下」**未验**。
4. **`retryAttempts` 的 `N` vs `N−1` 语义未定位**（§5.3）：只标定了取值→次数，没找到引擎侧成因。
5. **asset id 是 `${...}` 模板**（§6.3）：补 `bucket` 后 `catalog` 能命名资产了，但
   **新鲜度探测能否命中具体对象未验**。
6. **owners 36h 锚能否触发未验**：该规则的 glob 跨**全部 hour 分区**，`maximumAge: 36h` 是以哪个
   对象为基准、能否真的变红，未验。
7. **生产 `.duckle/keys/` 生命周期未决**（§7）：换机/重建后密钥由谁分发，仍是人确认项。
8. **≥2 tick 缺口的补采工具未验**（§4.6）：`run-retail-day.sh` 能否定点重跑指定小时，零生产约束下
   没去碰 64188；本报告列为**待定 SOP**。
9. **`catalog lint` 不在 CI 守卫里**（§6.2）：本批**没有**顺手加守卫（超出 TASK 授权）；
   §6 那类缺陷在 CI 仍然不可见——建议作为独立 issue。
10. **lab 与生产的路径差异**：lab 把 `/workspace/` 换成 lab ws（形状不变），但真实 workspace 的
    挂载、权限、磁盘布局未验。

---

## 附：本批命令与证据索引

- **lab 驱动器**：`/tmp/waveC-lab/lab.py`（`derive [--now] [--retry]` / `run <scene> [--pipeline]` /
  `reset` / `access` / `counts`）
- **场景脚本**：`/tmp/waveC-lab/exp.py`（`main` = S1..S6、`neg` = S7..）、`neg2.py`（S8/S9）、
  `cat_exp.py`（E1/E2/E1b）、`finger.py`（F1）、`mkconn.py`（重新封装连接）
- **证据**：`/tmp/waveC-lab/evidence/`（`S1*`/`S2`/`S3`/`S4`/`S5*`、`S7-*`/`S8-*`/`S9-*`、
  `E1-catalog-nobucket.txt`、`E2-catalog-withbucket.txt`、`E1b-catalog-nobucket-restored.txt`、
  `E2b.out`、`E3.out`、`F1-fingerprint-vs-sinkprops.txt`、`state-tree.txt`、台账/回执快照）
- **门禁**：`validate_pipeline`（三条管线）+ 六条静态守卫 + `typecheck`；lock 重生成
  `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`
