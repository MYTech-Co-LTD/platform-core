# Wave B：`lemeng.retail.windows` → L1（foreach 首飞）—— 仓内编写 + 实验室验证报告

> 2026-09-28 ｜ worker `task_5feb7c996d0d`（Orca dispatch `ctx_95c6db888dab`）｜ 分支 `feat/waveB-retail-l1`（从 `origin/main` @ `4f213f7` 切，**未开 PR**）
> 依据：`docs/superpowers/plans/2026-09-28-all-pipelines-migration.md` Wave B + Global Constraints；
> `deploy/duckle/console/pipelines/lemeng.dim.branch.l0.json`（身份门模板）；
> `docs/superpowers/specs/2026-09-28-duckle-l1-wave1-prep.md`（§4.1/§4.2/§8）；
> `...-duckle-l1-secret-path-d1.md` + `...-duckle-child-value-paths.md`（凭据通路）；
> `...-duckle-orchestration-capability-survey.md`（§3 checkpoint / §4 die-try / §10 方言坑）。
>
> **本报告全部活动**：本机 `/tmp/waveB-lab/`（本地 workspace + 回环 mock 网关 `127.0.0.1:8899` + 回环 MinIO `127.0.0.1:9900`，桶 `lemeng-lab`）
> ＋ 生产侧 **只读**（openship MCP 在 pg_duckdb 容器内 `duckdb.query` 回读湖、读 job 定义）。
> **零生产写入**：未投递、未切流、未进 console 容器、未上机裸敲、未动调度/tick/close、未外发。
> 实验件与原始回执：`/tmp/waveB-lab/evidence/*.out`、`/tmp/waveB-lab/mockstate/access.log`（逐请求事实源）。

---

## 0. 一句话结论

两条管线已写完并 `duckle validate` 通过，实验室 7 项验收里 **6 项全绿、1 项有条件成立**：
`24 窗逐窗执行` / `跨 run 只补失败窗（含页粒度）` / `末尾判红且先落盘` / `身份不符 ⇒ 业务请求数 0` /
`bizday = 上海昨天且跨零点两侧正确` / `产物形状与老路径逐列全等` 全部实测成立；
**「单窗失败不拖批」只对瞬时失败成立**——持续失败会被引擎的 foreach 中止语义**截尾**（该窗之后的窗当轮一次都不采），
这是本形态相对 shell 基线**唯一的实质性回退**。已按流程向协调者发起决策（见 §5），
并额外实测到一条可彻底消除截尾的原生通路（`src.rest` 的 `onParentError=reject`，见 §5.2）。

---

## 1. 产出

| 文件 | 角色 | 规模 | validate |
|---|---|---|---|
| `deploy/duckle/console/pipelines/lemeng.retail.windows.l1.json` | **父管线**（L1 顶层） | 19 节点 / 22 边 | `ok (19 stages)` |
| `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json` | **子管线**（现重管线的逐窗版） | 20 节点 / 20 边 | `ok (20 stages)` |

命名沿用现有约定（`lemeng.dim.branch.l0` / `lemeng.dim.item.l0` ⇒ `.l1`；子管线在其上带 `.window`）。
**未动**：`schedules/`、`alerts.json`、`owners.json`、`deploy/*.yml`、`scripts/lemeng/run-retail-day.sh`、
`duckle/common/lemeng.retail_order_line.json`（老路径的源，照读不改）。

```
lemeng.retail.windows.l1.json（父，顶层 —— 唯一被 ${ENV:} 解析的文档）
  v0 src.rest      whoami 身份探针（SSE 原件落盘）
  g0 g1 g2         SSE data: 行 → 末条拆 JSON-RPC 壳 → 身份事实
  d0 ctl.die       no-rows：抠不出身份 ⇒ 红（挡网关形状漂移）
  g3 code.sql      两条断言：凭据账套 == SYSTEM_BOOK；配置门店 ⊆ 可见门店
  d1 ctl.die       has-rows ⇒ 红          ─── 身份门到此为止（照 branch L0 的 9 节点）
  gv code.sql      期望值形状闸（BRANCH_NUMS / SYSTEM_BOOK / BIZDAY / RUN_TOKEN / BATCH_ID / HOUR_SET）
  dv ctl.die       has-rows ⇒ 红（形状非法即拒采）
     │ on-subjob-ok（先证后采：身份未证 ⇒ 下面整段不跑）
  w0 code.sql      **窗口表**：24 行，每行 bizday + hour + hour_from/to + run_token + batch_id
  fe ctl.foreach   pipelineRef=<子管线> itemKey=hour concurrency=1 retryAttempts=4 continueOnFailure=true
  wm / wsink       窗口表按收据形状落盘（status=pending）—— 收据目录的 schema 锚
  a1 ctl.anchor    fe 与 wsink 都完成才汇总
  su code.sql      收据 × 窗口表 → 每窗一行 hour/rows/status
  rep snk.csv      汇总表落盘（/workspace/logs/retail-windows-summary.csv）
  sr code.sql      缺口窗（status<>ok）
  a2 ctl.anchor    先落盘后判红
  dz ctl.die       has-rows ⇒ 红（WINDOWS_FAILED {rows} 窗未采到…）

lemeng.retail_order_line.window.json（子 = 现重管线，6 处机械改写，见 §3.4）
  p1..p12 src.rest（connectionRef=lemeng, checkpoint=true, body 用 ${ITER_ITEM_*}）
  guard ctl.die(has-rows) → merge(main_1..12) → flatten → qa.contract gate → sink(snk.minio, connectionRef=zos)
  sink → ordered(ctl.anchor) → summ(code.sql) → receipt(snk.csv)      ← 湖对象先落盘，再写收据
```

---

## 2. 环境（可复现）

| 件 | 值 |
|---|---|
| duckle | **0.7.4**（`/private/tmp/duckle-lab-p1/.venv074/bin/duckle`，与 `deploy/duckle/Dockerfile` 的 `ARG DUCKLE_VERSION=0.7.4` 一致） |
| DuckDB | **1.5.5**（同 venv） |
| mock 网关 | `/tmp/waveB-lab/mock/mock_gateway.py`，仅绑 `127.0.0.1:8899`；whoami 按真网关的 SSE 帧复现，posorder 按 `result` 是数组复现；**只记 `sha256(token)[:12]`，不落明文** |
| 对象存储 | `minio/minio:latest` 容器，仅绑回环 `127.0.0.1:9900`，桶 `lemeng-lab` |
| workspace | `/tmp/waveB-lab/ws/`（`pipelines/` `connections/` `logs/` `state/`） |
| 凭据 | 自造假值；`connections/lemeng.json`（kind=rest, bearer）与 `connections/zos.json`（kind=s3）用 **AES-256-GCM 加密写入方**（`mkenc.py`，方案与 `duckle-secrets` 源码逐条对齐） |
| 跑法 | `python3 lab.py derive [--now '<ts>']` → `python3 lab.py reset` → `python3 lab.py run <scene>` |
| **lab 变体只改 4 处（全部沙箱适配，无行为改动）** | ① `cloud.nhsoft.cn` → `127.0.0.1:8899`；② `/workspace/` → lab workspace（生产里 console 容器的挂载点就是 `/workspace`，路径形状逐字不变）；③ `retryBackoffMs 60000 → 200`（只影响墙钟）；④ 跨零点场景才把 `now()` 钉成固定 `TIMESTAMPTZ` |

---

## 3. 关键设计决策

### 3.1 分层：父**也**吃身份门，子**只**吃行值 + 连接

- 身份门 9 节点**逐条照抄** `lemeng.dim.branch.l0.json`（只把探针节点 `w0`→`v0` 更名，给窗口表腾出 `w0`；
  原件名加 `retail-windows-` 前缀防同秒互覆）。**四条护栏一条不少**：`v0` 声明 `data.schema`（探针恒 0 行）、
  `d0` 形状反闸、`gv`+`dv` 期望值闸（置 `d1` 之后、触发边之前）、`v0` 的 `retryAttempts: 3 + retryBackoffMs: 2000`。
- **先证后采**用 `dv → w0` 的 `on-subjob-ok` 触发边（只定序不接线）⇒ 身份未证时**窗口表根本不跑**，
  零采集请求（实测见 §4.5）。
- 子管线**读不到 `${ENV:}`**（wave1-prep §4.2 差异 1）⇒ 一切运行参数化走**窗口表行值** `${ITER_ITEM_*}`，
  一切凭据走 **`connectionRef`**（`lemeng` / `zos`，加密连接）。
  ⇒ **子管线里零 `${ENV:}`、零明文、零 context 文件**（满足 child-value-paths §6 的 8 条红线）。

### 3.2 `bizday` 的推导表达式（本 Wave 的重点）

**采用（父管线窗口表，SQL 现算一次）：**

```sql
strftime((now() AT TIME ZONE 'Asia/Shanghai') - INTERVAL 1 DAY, '%Y-%m-%d')
```

**证据（逐条实测）：**

| 项 | 结果 |
|---|---|
| ICU 可用 | ✅ `AT TIME ZONE 'Asia/Shanghai'` 在 0.7.4 的 DuckDB 1.5.5 上直接可用（无需 `LOAD icu`）——S1 首跑即得到正确 bizday |
| 与 shell 同解（跨零点两侧各一次） | UTC `2026-09-28T15:59Z` ⇒ 上海 `23:59`（同日）⇒ 管线算出 **2026-09-27**；UTC `2026-09-28T16:01Z` ⇒ 上海 `00:01`（次日）⇒ 管线算出 **2026-09-28**。同一瞬间的 shell 口径（`TZ=Asia/Shanghai date -v-1d +%Y-%m-%d`，BSD 形态，把「现在」钉到对应墙钟）给出 **2026-09-27 / 2026-09-28**，**逐格相等** |
| 落湖与落请求面 | 两次跑中 mock 收到的 `date_from` 分别是 `2026-09-27` / `2026-09-28`（各 24 窗一致）；汇总表 `bizday` 列同值；湖上分区也分别落在 `bizday=2026-09-27/` 与 `bizday=2026-09-28/`（各 24 对象） |
| 与 `gv` 的同源 | `gv` 用**同一表达式**再算一遍并做 `YYYY-MM-DD` 正则断言 ⇒ 表达式写坏时在采集**之前**判红（不读 input，符合 branch 护栏 ③） |

**「时间占位符能否做减一天」——能验则验，结论如下（未作为主选）：**
`${date+8h}` 是**编译期字符串替换**，它给的是「上海日历日的**今天**」，做减一天必须进 SQL 表达式：
`CAST('${date+8h}' AS DATE) - INTERVAL 1 DAY` **可以编译**（本 lab 验证），但它把 `+8h` 写死在文本里、
依赖「Asia/Shanghai = UTC+8 且无 DST」这条**时区编码知识**，而 `now() AT TIME ZONE 'Asia/Shanghai'`
把时区**写成了字面量**、可读可审、不受进程 TZ 影响。⇒ **主选 TZ 感知式**；`${date+8h}` 减一天法**不作为**实现，
只在 `gv` 之外留作备选（若将来 ICU 缺失才启用，且必须同步换掉 `gv` 里的那份）。

**为什么这条重要（相对 shell 的净收益）**：shell 的 `windows` 是「父进程推一次 BIZDAY 再 export 给 24 个子进程」
（`run-retail-day.sh:104-129`，注释明写不导出会让跨上海 00:00 的跑把 0..k 窗写进 D、其余写进 D+1）；
L1 里 bizday 是**窗口表的一列、run 内算一次**，结构上不可能分叉，也不再需要 `export` 这个补丁。

### 3.3 `batch_id` 形状（湖上取证，逐字节同形）

- **生产取证**（只读，shanhai `pg_duckdb` → `duckdb.query`，bizday=2026-09-27）：
  `retail-3120-20260928T023009Z-00` / `…-01` / `…-08` … `…-23`，**每窗一个不同时间戳**。
- **本形态**：`'retail-' || ${ENV:SYSTEM_BOOK} || '-' || <run_token> || 'Z-' || <hour>`，
  其中 `run_token = replace(replace('${datetime}','-',''),'_','T')`（实测 `${datetime}` 形如 `2026-09-28_15-05-12`
  ⇒ 替换后正好是 `%Y%m%dT%H%M%S`）。
- **形状判据**：`^retail-[0-9]+-[0-9]{8}T[0-9]{6}Z-[0-9]{2}$` —— 生产样本 2 条、lab 样本 2 条 **全部 MATCH**。
- **一处有意差异（必须知情）**：老路径每窗**各铸**一个时间戳（每窗起一个新容器），L1 是**一次 run 一个 run_token**
  （24 窗共享时间戳，只有 hour 段不同）。形状逐字节同形、每 (run,hour) 仍唯一、
  `count(DISTINCT batch_id) 按 hour` 仍恒 = 1（recon 的判据不变），且「哪一次 run 采的这个窗」变成**可直接读出**。

### 3.4 子管线的 6 处机械改写（逐条可核，`git diff` 之外的对照表）

| # | 改写 | 逐节点证据 |
|---|---|---|
| R1 | `${ENV:BRANCH_NUMS\|BIZDAY\|HOUR_FROM\|HOUR_TO}` → `${ITER_ITEM_*}` | p1..p12 全部；占位符清单见下 |
| R2 | 删 `headers.Authorization: Bearer ${ENV:LEMENG_TOKEN}`，加 `connectionRef: "lemeng"` | p1..p12 |
| R3 | 12 个 `src.rest` 加 `checkpoint: true` | p1..p12（**本形态的核心收益**） |
| R4 | `guard` 消息 / `flatten` SQL / `sink` key 的 `${ENV:SYSTEM_BOOK\|BIZDAY\|HOUR\|BATCH_ID\|HOUR_FROM\|HOUR_TO}` → `${ITER_ITEM_*}` | guard / flatten / sink |
| R5 | sink 的 `bucket/endpoint/region/accessKey/secretKey` 收敛进 `connectionRef: "zos"`；`key/format/mode/compression` 留节点 | sink |
| R6 | 末尾追加 `summ`(code.sql) + `ordered`(ctl.anchor) + `receipt`(snk.csv) | 新增 3 节点（17→20） |

**未改动**：12 页节点的 `page_number`/`page_size`/`responsePath`/`schema`、`guard` 的容量闸语义、
`merge` 的 `main_1..main_12`、`flatten` 的 UNNEST 与列定型、`qa.contract` 的 7 条规则、
sink 的一对象覆盖 + 分区写进 key + **不开 `partitionBy`**。

**checkpoint 的适用边界（硬约束，写进文件 `_note`）**：复用键 = 配置指纹（url/method/body/responsePath）+ 父行，
**不含上游内容指纹** ⇒ 闭窗（windows 形）开、累积窗（tick 形）**必须关**，否则首快照会被冻住
（survey §10.1 的 B7 实测）。本管线是 windows 形，开它正确。

### 3.5 汇总与末尾判红（照 wave1-prep §4.2 差异 4 的改法）

三条要点，全部有实测背书：

1. **`su` 的主输入接窗口表 `w0`，不接 foreach 的透传行** —— `fe` 软失败时它的 view 不存在；
   定序靠 `a1` 的 trigger 边（`fe` 与 `wsink` 都完成才跑）。
   `fe` 置 `continueOnFailure: true` ⇒ `fe` 失败后 `su/rep/sr/dz` 照跑（**软 stage 不会把 run 变绿**：
   run 仍红、退出码 1，实测 S4）。
2. **每窗成色的唯一事实源 = 子管线写的收据 CSV** `/workspace/logs/retail-windows/<bizday>-<hour>.csv`
   （子管线在**湖对象落盘之后**写它，靠 `ordered` 锚点定序）。
   `su` 用收据里的 `run_token` 列把结果**限定到本次 run** ⇒ 上一次 run 的收据不会被误读成这次的成功。
3. **`wm`/`wsink` 把窗口表按收据形状落成 `_windows-pending.csv`（status=pending）**：
   ① 保证 `read_csv` 的 glob **恒非空**（DuckDB 匹配 0 个文件会报错，而「全窗都失败」正是那个形状）；
   ② 它是本 run 的窗口清单留档。
   ⚠️ 第一版曾用「窗口表原样落盘」当锚，**实测 `Binder Error: Referenced column "status" not found`**
   —— `union_by_name` 只在**实际读到的文件之间**取并集，单文件缺列直接报错。这条已写进 `_note` 防回归。

`dz` 排在 `rep`（落盘）之后：**先落盘后判红**（survey §4 的 B1 教训：反了会丢落盘）。实测 S4 里
`rep ok (24 rows)` 先于 `dz error`。

### 3.6 `retryAttempts` 的取数（**实测标定，非套用**）

- 实测（本管线）：`retryAttempts: N` ⇒ 失败窗被尝试 **N−1** 次（N=3/4/5 → 2/3/4 次子管线 run，可复现）。
- 故取 **4**，让失败窗拿到 **3 次**（对齐 shell 的「1 次首跑 + `WINDOWS_RETRY_ATTEMPTS=2` 轮」）；
  `retryBackoffMs: 60000` 对齐 shell 的 60s 退避。
- ⚠️ **未解**：单节点子管线实测是 `N ⇒ N` 次。这个 N/N−1 的差异**未定位**（见 §6），
  换子管线形状后**必须重测**，别把 4 当稳定常量。

---

## 4. 实验室逐条回执（7 项）

### 4.1 逐窗执行（24 窗各一次请求，窗号代入正确）—— ✅

`S1-green`：`status: ok`、`exit 0`、`fe ok (24 rows)`、`w0/sent/su/rep` 各 24 行。
mock 访问日志 **289 条**：`whoami × 1` + `posorder × 288 = 24 窗 × 12 页`，
窗集合 = `00..23` 全覆盖，页集合 = `page1..page12` 各 24 次，状态全 200。

### 4.2 单窗失败不拖批 —— ⚠️ **瞬时成立、持续不成立（本 Wave 唯一的回退）**

**2a 瞬时失败（只失败一次）—— ✅**
`S2-transient-500`（注入 `hour=05 page=1` 首次 500）：
`status: ok`、`exit 0`、24/24 窗齐；访问日志 **290 条** = 289 + 1 次重试；
hour 05 的逐页事实：attempt1 先采 `page9…page2, page12…page10`，`page1` 得 500，
**stage 重试后只重发 `page1`（1 条）即转 200** —— 因为 `checkpoint` 是**页粒度**的，
同窗已成功的 11 页在重试里零请求。⇒ 重试把成本收敛到「失败的那一页」。

**2b 持续失败 —— ❌ 截尾（该窗之后的窗当轮一次都不采）**
`S4-final-persistent-500`（注入 `hour=07 page=1` 恒 500，用最终文件 `retryAttempts=4`）：

```
fe  stage_started  2026-09-28T15:24:02.004Z
fe  stage_finished 2026-09-28T15:25:17.497Z   (error)
error: ctl.foreach(...)[row 7]: page 1: REST HTTP 500 ...
```
| 事实 | 值 |
|---|---|
| 失败窗 07 的子管线 run 次数 | **3**（= shell 的 3 次尝试，标定生效） |
| 请求分布 | `00..06` 各 12 条、`07` 14 条、**`08..23` 0 条** |
| 汇总 | 24 行，`00..06` = ok(6 行)，**`07..23` = missing（17 窗）** |
| 判红 | `dz` 报 `ctl.die: WINDOWS_FAILED 17 窗未采到（system_book=3120）⇒ 整批判红。⚠️ windows 形只采「上海昨天」、无回溯重放 ⇒ 被截掉的尾窗**必须当日补跑**（本 run 的 checkpoint 会让补跑只发缺页数个请求）；缺口明细见 …/retail-windows-summary.csv`，`exit 1`，且 `rep ok (24 rows)` 先落盘 |

**与 shell 基线的差**：`collect_windows` 是「失败窗登记后**继续采后续窗**」+ 连败 3 才 `WINDOWS_ABORT`
（`run-retail-day.sh:465-481`）⇒ 同一个持续失败在 shell 下**只丢那一个窗**，在 L1 下**丢该窗及其后全部**。
**这一条的补偿与决策见 §5。**

### 4.3 跨 run 只补失败窗（`checkpoint` 生效）—— ✅（连页粒度都成立）

`S5-crossrun-fill-gap`（**保留** S4 的 `state/`，清掉网关切点注入后重跑）：

| 事实 | 值 |
|---|---|
| 访问日志 | **194 条** = `whoami × 1` + `hour07 × 1` + `hour08..23 × 12` |
| `hour00..06` | **0 条请求**（全部按 checkpoint 复用） |
| `hour07` | **只有 1 条**（`page1`）——S4 里已经成功的 `page2..12` 由 checkpoint 复用 |
| 结果 | `status: ok`、`exit 0`、汇总 24 窗全 ok、湖上 24 对象 |
| 另一次纯复用对照 | `S3-crossrun-reuse`（网关上无故障、state 全热）⇒ **`whoami × 1` + `posorder × 0`**，24 窗全复用 |

⇒ 「跨 run 补采」不仅成立，而且**补采粒度细到页**。这也解释了 shell 与 L1 的成本差：
shell 的人工补救要**整轮重跑 24 窗**（288 个请求），L1 的补救只发**缺页数**个请求。

### 4.4 末尾判红（有失败窗 ⇒ 整条 run 红，`ctl.die has-rows`）—— ✅

见 §4.2 的 `S4-final` 表：`dz` 触发 `ctl.die: WINDOWS_FAILED 17 …`、run `status: error`、`exit 1`，
且**收据/汇总先落盘再由 `dz` 判红**（`rep ok` 的 `stage_finished` 时间戳早于 `dz`）。
`dz` 的消息里带 `{rows}` 实参（17）与 `${ENV:SYSTEM_BOOK}`，缺口明细另有文件面
（`/workspace/logs/retail-windows-summary.csv`）。

### 4.5 先证后采（身份不符 ⇒ 业务请求数 0）—— ✅（两个反面各测一次）

| 场景 | mock 的 whoami | 结果 | 业务请求数 |
|---|---|---|---|
| `S6a-identity-book-mismatch` | `company_id=9999` | `d1` 判红、`exit 1`、run error | **0**（日志只有 1 条 whoami） |
| `S6b-identity-branch-not-visible` | `company_id=3120`、`branch_nums=[1001]`（配置 1001/1002/1003） | `d1` 判红、`exit 1`、run error | **0**（日志只有 1 条 whoami） |
| 对照 `S1-green` | 匹配 | 正常采集 288 条 | 288 |

⇒ 「配置门店 ⊆ 可见门店」的方向没写反（多余可见门店不误报，不可见即红）。

### 4.6 `bizday` 正确（= 上海昨天，跨零点两侧各验一次）—— ✅

见 §3.2 的表：UTC `15:59` → `2026-09-27`；UTC `16:01` → `2026-09-28`；
**mock 收到的 `date_from`、汇总表 `bizday` 列、湖上分区目录**三处同时验证，与 shell 口径逐格相等。

### 4.7 产物形状与老路径对照 —— ✅

| 维度 | 老路径（生产湖，只读取证） | 本形态（lab 湖） | 判据 |
|---|---|---|---|
| 对象 key | `lemeng/retail_order_line/system_book=3120/bizday=2026-09-27/hour=09/all.parquet` | 逐字同形（24 个对象） | 字符串全等 |
| 列（名称 + 类型） | 18 列（`batch_id VARCHAR` … `quantity DECIMAL(14,3)`） | **18 列逐行全等**（`diff` 空） | `DESCRIBE` 输出逐行比 |
| `batch_id` 形状 | `retail-3120-20260928T023009Z-00` | `retail-3120-20260928T151023Z-07` | 正则 `^retail-[0-9]+-[0-9]{8}T[0-9]{6}Z-[0-9]{2}$` 双方 MATCH |
| 每 hour 的 `batch_id` 数 | 1 | 1（24 个 hour 各 1） | `count(DISTINCT batch_id) per hour = 1` |
| 分区列与分区目录一致 | `hour` 列 == `hour=` 目录 | 同（24/24 一致） | 逐 hour 比 |

证据文件：`evidence/prod-schema.txt` / `evidence/lab-schema.txt`（`diff` 空）。

---

## 5. ⚠️ 需要决策的一件事：持续失败时的「截尾」

### 5.1 事实与影响

- **回退是真实的**：shell 只丢失败窗，L1 丢「失败窗 + 其后全部窗」（§4.2）。
- **不会自动补**：`windows` 只采「上海昨天」、无回溯重放 ⇒ 下一次调度是**次日**、目标是**另一个 bizday**，
  被截掉的尾窗不会自己回来。除非**当天**再跑一次。
- **生产现状（只读取证）**：openship job `lemeng-retail-3120-runner`（cron `30 2 * * *`）**`enabled: false`、`retry: null`**，
  最后两次 schedule 触发是 2026-09-26 / 2026-09-27 的 02:30Z，**2026-09-28 无该 job 的 run**；
  而仓内 `schedules/3120.json` 里 `lemeng.retail.windows.run` 声明为 `enabled: true`、`30 2 * * *`，
  且湖上 2026-09-28 的批次 token 正是 `…T0230…Z` ⇒ **推断**当日的 run 来自 console 调度而非该 job
  （推断，未进 console 容器核对）。无论哪条，形态都是**单条日频、无自动重试**。
- **湖上已经出现同类缺口**（只读，2026-09-28 观测）：`bizday=2026-09-27` 只有 `hour=00,01,08..23`，
  **`02..07` 无对象**。成因未查（不属本任务），但它说明「部分窗失败」在本生产链上是**已经发生过的事实**；
  同一情形在 L1 下会从「丢 6 个窗」变成「丢 22 个窗」。
- **生产本来就靠人工补跑**：`run-retail-day.sh:734-735` 自己记着
  「2026-09-25 02:30Z 的 schedule 轮失败（靠 03:10Z 人工重跑才补上）」；job 的 recentRuns 里也确有
  `trigger: manual` 的补救轮。⇒ 「run 红 → 人工/调度补跑」在本链上是**既有且被接受**的运维动作。

### 5.2 已实测的另一条原生通路（可彻底消除截尾，但有未验风险）

给 `src.rest` 加 **`onParentError: "reject"`** 并声明 **`data.schema`**（后者是必须的，
否则 0 行结果会以 `query returned 0 records and no schema is declared` 报错）：

- **实测（RT-lab `rej.json`）**：`hour07` 恒 500 时，500 **变成 reject 行**
  （列：`parent_key,url,error,failed_at,__node_id,__error_code,__rejected_at`，`__error_code=request_failed`），
  主口 0 行、**批不中断** —— 4/4 窗全部照采、run `status: ok`、其余窗的主口数据正常。
- **它的缺陷（未解，必须知情）**：子管线会在「某页失败、其余页成功」时把**残缺结果写进湖**
  （`mode: overwrite` ⇒ 覆盖掉原本完整的对象），且这段残窗**看起来是完整的**。
  要堵住它需要再加「条件 sink」把该窗挡在湖外（`ctl.switch` 存在且有 `branches`/`default` 口），
  但 **reject 行与 `checkpoint` 的交互未验**：若被 reject 的那一页仍被 checkpoint 记为「已完成」，
  该窗将**永不补采**（正是 survey §10.1「checkpoint 冻结首快照」的同族风险）。

### 5.3 已发起的决策（options：A/B/C/D）

已通过 `orca orchestration ask` 向协调者发起（含上述全部事实与选项）：

- **A（推荐）**：接受截尾，靠「run 红 → 告警 → 当日补跑」兜底。理由是**代价已被 checkpoint 压到极小**
  （补跑只发缺页数个请求，而 shell 的补跑要整轮 288 个），且生产本来就在这么做；
  首飞改动面最小。可选的加固：为同一管线再加一条**傍晚的日调度**
  （bizday 仍推同一个「昨天」，checkpoint 让第二跑近乎免费）——**但「console 能否给同一管线挂第二条调度」需先核实**。
- **B**：改 `dispatch: "queue"` + 常驻 worker（每窗独立认领，**彻底不截尾**）。代价：新增 worker 进程（编排变更）、
  判红改读 `work status`（queue 收尾 pass 退出码恒 0）。
- **C**：改 survey §8 的 **reject 形单管线**（少一层子管线，但 sink 分区覆盖语义未验）。
- **D**：把 §5.2 的 reject 容错版子管线**做完**（含条件 sink + checkpoint 交互实验），交付时间 +1~2 小时。

> **本报告交付时该决策尚未收到答复**（`ask` 在超时窗口内未回）。上述两个文件是**形态 A 的实现**；
> 若选 B/C/D，改动面分别是「编排 + 判红面」/「整体换形」/「子管线再加 3~4 节点」。

---

## 6. 未验 / 未解（不冒充）

| # | 项 | 性质 | 处置建议 |
|---|---|---|---|
| 1 | `retryAttempts: N` ⇒ N−1 次（本管线）vs N 次（单节点子管线） | **引擎行为未解**（已复现 3 次） | 换子管线形状必须重测；值得回喂上游 |
| 2 | reject 行是否被 `checkpoint` 记为已完成 | 未验（决定 §5.2 的 D 是否安全） | 做 D 时第一件事就验它 |
| 3 | `continueOnFailure` 在 `fe` 上对**子管线内**失败是否也软（本 lab 只验了 foreach 层） | 已验到「软 stage 继续跑 su/rep/sr/dz」，更深一层未测 | 低风险 |
| 4 | 连接加载失败 fail-open（凭据空 ⇒ 静默 401） | 已由 survey/D1 结论覆盖，**本 lab 未构造** | 切流清单里必须有**连接自检**（廉价值探测） |
| 5 | 生产 workspace 的 `.duckle/keys/` 生命周期（进不进备份/快照） | 部署面，lab 覆盖不到 | 决定「加密连接」的零明文是否成立，须人确认 |
| 6 | console 能否给同一管线挂**第二条**调度（§5.3 选项 A 的加固） | 未验 | 若选 A，先核实 |
| 7 | OO `_ops` 投递通道 / WeCom 告警（survey §7.2 的两项待沉淀） | 本次仍未验 | 不在 Wave B 的文件面内；汇总表已可作 snk.webhook 的输入 |
| 8 | mock 每窗只回 1 个非空页（页数/游标行为沿用 survey §3 的真网关实测结论） | 未再压真网关 | 分页语义**零改动**，风险低 |

---

## 7. 切流对照方案（写同一个湖分区时怎么比；**本报告不执行**）

**前提**：L1 与老路径写**同一个 key**（`…/system_book=<book>/bizday=<D>/hour=<HH>/all.parquet`），
单对象覆盖 ⇒ **两条路径不能同时写同一天**；`checkpoint` 又保证同一 bizday 的重复跑只补缺口。
⇒ 对照必须按「**先备份 → 跑新 → 逐列比 → 有差异回写**」的顺序做（计划 Wave B 第 2 条点名的就是这个手法）。

**操作约束（重要，先看）**：L1 的 `bizday` 由 `now()` 现算、**不可指定**；老路径可用 `BIZDAY=D` 显式指定。
⇒ **对照只能在「D 恰好是上海昨天」的那一天做**（即正常日批的时点），不能事后补某一天。

**逐日一轮的步骤（建议 ≥3 天）**

1. **选 D** = 当天上海昨天；确认老路径当日已跑完且 24 窗齐全（从湖上列 24 个 key 自查）。
2. **备份**：把 `…/bizday=D/` 下 24 个对象逐对象 **copy**（不是 move）到 `_backup/retail_order_line/bizday=D/`，
   并记下每个对象的 **ETag + Size** 作为基线（`mc ls --json` / `mc stat`）。
3. **停老路径**：薄管线 `lemeng.retail.windows.run` 的调度置停（**切流前不动它，这里只是对照需要**）。
4. **跑 L1**：手动触发父管线（`POST /api/pipelines/<id>/run` 或 console 面板）。确认 run `status: ok`。
5. **逐列比**（每个 hour 各比一次）：

   ```sql
   -- 排除 batch_id：它必然不同（时间戳不同），只比形状
   SELECT count(*) FROM (
     (SELECT * EXCLUDE (batch_id) FROM read_parquet('<备份>/bizday=D/hour=HH/all.parquet'))
     EXCEPT ALL
     (SELECT * EXCLUDE (batch_id) FROM read_parquet('<新>/bizday=D/hour=HH/all.parquet'))
   );
   -- 以及与上面对称的一条（双向 EXCEPT ALL ⇒ 真集合相等）
   ```
   外加三条形状判据：
   - 行数相等；`count(DISTINCT batch_id) per hour = 1`；
   - 新对象的 `batch_id` 命中 `^retail-[0-9]+-[0-9]{8}T[0-9]{6}Z-[0-9]{2}$`；
   - 新对象的**列名 + 类型**与备份对象逐行全等（`DESCRIBE` 两两比）。
6. **判据**：**双向 `EXCEPT ALL` 均为 0 行** ⇒ 通过。
   ⚠️ **不要拿 ETag 相等当判据**（batch_id 不同 ⇒ 内容不同 ⇒ ETag 必然不同）。
7. **有差异 ⇒ 回写**：对该 hour 把备份对象 `mc cp` 回原 key，把差异样本（行数/首个不同行）写进报告，
   **不切流**，回查差异来源。
8. **反向对照（可选、更强）**：在第 5 步之后让老路径对同一个 D 再跑一次（它也会覆盖写），
   再用同一条 SQL 比「老路径第二跑 vs L1 产物」——顺序反过来做一次，排除「谁后写谁赢」的伪相等。
9. **切流同批清单**（协调者做，本报告不执行）：
   ① 投递两文件（push → 机器 sync 按全 SHA → **只 seed 改动的文件**）→ ② **重建 catalog**
   （`POST /api/catalog`；否则新管线 run record 无 `assets` ⇒ 新鲜度永久 Stale）→ ③ `alerts.json` 加
   `lemeng.retail.*.l1`（**否则失败静默**：现有规则 `lemeng.retail.windows.run` 匹配不到 `.l1`）
   → ④ `owners.json` 的新鲜度锚改指新管线的湖对象 → ⑤ 调度切到父管线（薄管线停）→ ⑥ 观察 ≥3 运行日。

---

## 8. 证据索引

**仓内**：`deploy/duckle/console/pipelines/lemeng.retail.windows.l1.json`（父）、
`.../lemeng.retail_order_line.window.json`（子）。

**实验室（`/tmp/waveB-lab/`，零生产写入）**

| 回执 | 证明 |
|---|---|
| `evidence/S1-green.out` | 24 窗逐窗执行、run ok、exit 0（§4.1） |
| `evidence/S2-transient-500.out` + `mockstate/access.log` | 瞬时 500 被重试吸收、只重发失败页（§4.2-2a） |
| `evidence/S4-final-persistent-500.out` | 持续 500 ⇒ 截尾（08..23 零请求）+ 3 次尝试 + 末尾判红 + 先落盘（§4.2-2b、§4.4） |
| `evidence/S5-crossrun-fill-gap.out` + access | 跨 run 只补缺口，hour00-06 零请求、hour07 仅 1 页（§4.3） |
| `evidence/S3-crossrun-reuse.out` + access | 全热 checkpoint ⇒ posorder 请求数 0（§4.3） |
| `evidence/S6a-*.out` / `S6b-*.out` + access | 身份不符 ⇒ 业务请求数 0（账套 / 门店两个反面）（§4.5） |
| `evidence/S7-bizday-*.out` + access + 汇总表 | UTC 15:59 / 16:01 两侧 bizday 正确（§4.6） |
| `evidence/prod-schema.txt` / `evidence/lab-schema.txt` | 生产 vs lab 产物 18 列逐行全等（§4.7） |
| `mock/mock_gateway.py` `lab.py` `gen_pipelines.py` `mkenc.py` | 可复现入口 |
| `/tmp/waveB-lab/rt-lab/` | 机制级微实验（`retryAttempts` 标定、`onParentError=reject` 通路、checkpoint 对照） |

**生产侧只读取证**（openship MCP → `platform-core-shanhai-data` 的 `pg_duckdb` 容器
`duckdb.query(read_parquet('s3://shanhai-data/lemeng/retail_order_line/…'))`；未进 console 容器）：
batch_id 形状样本、bizday=2026-09-27 的 hour 覆盖（缺 02..07）、产物列定义。
job 定义与 recentRuns 取自 openship jobs API（只读）。
