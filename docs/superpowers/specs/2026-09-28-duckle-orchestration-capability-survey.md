# duckle 编排能力全面盘点：薄壳能否拆掉、差什么（#276 缺口②收口件）

> 实验室日期 2026-09-28 · 引擎源码 `source-analysis/duckle-latest`（git `v0.7.4`，commit b62e8ce）·
> 隔离实测 **duckle 0.7.4**（`/tmp/aw-lab-074/venv`）· mock 网关 127.0.0.1:8795 · **零生产、零外发**
> 实验件与证据：`/tmp/aw-lab-orch/`（pipelines/ · out/*.out · mockstate/access.log · state/）；昨日 0.7.3 证据 `/tmp/aw-lab-foreach/`（只读复用）
> 所有源码锚写作 `文件:行号`，均对 v0.7.4 源码树；所有行为断言带实测回执文件名。

## 0. 一句话结论

**薄壳的 8 项职责里 7 项在 0.7.4 已有原生表达（多数已隔离实测），唯一真正缺的是「连败 ≥N 中止」（上游无此概念）；「同 run 内失败窗定向重试」这个昨日判为真缺口的能力，用 `foreach 子管线 checkpoint + foreach 节点 retryAttempts` 的组合方言已实测补上。** 拆壳技术上可行；建议按 §7 的 foreach 父管线形态合并（重管线逐字保留为子管线），连败中止作为已知代价接受或回喂上游。

三个必须带走的硬约束（均有实测）：checkpoint 复用**不感知上游内容变化**（tick 形禁用）；reject 形 checkpoint 存储**跟 run 名走**（自定义 `--name` 会断档）；queue 形收尾 pass **退出码恒 0**（判红读 status）。

---

## 1. 范围与方法

- 源码级盘点：`crates/duckdb-engine/src/plan/mod.rs`（组件构建）、`lib.rs`（执行器）、`connectors.rs`（src.rest 父模式/checkpoint）、`checkpoint.rs`（存储）、`batch.rs`（queue）、`plan/builders.rs`（qa.contract/switch/merge）。
- 版本差异：catalog 逐键 diff（`/tmp/aw-lab-074/components-body.diff`）+ 双版本 runner 二进制 strings 比对（0.7.3 vs 0.7.4）。
- 隔离实测 14 组（A1–A5 / B1–B7 / C / D2–D6 / E1–E3 / Q），全部 mock、全部 `/tmp`。
- wrapper 现状：`scripts/lemeng/run-retail-day.sh` 实测 **1021 行**（任务书写 787 行系旧数；tick/recon/notify 等为后续增量）。

---

## 2. ctl.* 全家族语义表（21 个，catalog 0.7.3 = 0.7.4 逐键相同）

| 组件 | 语义（源码为准） | 失败行为 | 源码锚 |
|---|---|---|---|
| `ctl.foreach` | 按上游每行跑一次子管线；`itemKey` 给每行命名（决定子 run 名/state 目录与增量水位）；`concurrency>1` 线程波次并发（各子 run 独立 temp DB）；`dispatch=queue` 只落批次文件不执行，交 worker 认领 | 顺序形**首个失败行即中止**（余行不跑）→ stage 失败；并发形首个错误终止当轮波次；queue 形入队即绿 | 构建 `plan/mod.rs:3793-3849`；执行 `lib.rs:2200-2339`（顺序 break `lib.rs:2279-2289`） |
| `ctl.iterate` | 固定次数跑子管线，`${ITER_INDEX}`=0..N-1 | 任一次失败即 stage 失败（后续迭代不再跑） | `mod.rs:3765-3792`；`lib.rs:2177-2199` |
| `ctl.runjob`（=`ctl.runpipeline`/`ctl.trigger` 同执行臂） | 以副作用调用子管线：`contextVariables` 以 `${VAR}` 注入子管线 JSON 文本；**`passesRows`**（0.7.4 新增）上游快照成 parquet 以 `${DUCKLE_INPUT}` 交给子管线；**`returnsRows`** 子管线写 `${DUCKLE_RETURN}` 交接文件、父侧节点视图=read_parquet(该文件) ⇒ **子管线成为可复用的行变换** | 子失败 ⇒ stage 失败（错误带 `ctl.runjob(path):` 前缀）；**stage 级 retryAttempts 会连带重跑子管线**（「子管线+SQL 一起重试」） | 构建 `mod.rs:3991-4069`（passesRows 4048-4057，returnsRows 4017-4043）；执行 `lib.rs:2135-2174` |
| `ctl.try` | 安装兜底子管线：**其后任一 stage 失败时**在原错误浮出前跑一次兜底（Take() 只触发一次）；兜底成功**原错误照样传播**（run 仍红）；兜底也失败则两条错误合并 | 作用域=安装点之后的整个执行，不是块级 try（块级需 DAG 重构，见源码注释） | `mod.rs:3974-3990`；`lib.rs:3044-3058, 3071-3075` |
| `ctl.die` | 按上游行数条件杀 run：`always`/`has-rows`/`no-rows`；消息支持 `{rows}` 模板；上游可无输入 | 触发即 stage 失败 ⇒ run 红、退出码 1 | `mod.rs:4098-4116`；`lib.rs:2414-2433` |
| `ctl.deadletter` | reject 行的终端 sink：`format` json/csv/parquet（**json 恒 NDJSON**，扩展名不改格式）；挂在某节点的 reject 口 | 落盘失败即 stage 失败 | `mod.rs:4292-4321` |
| `ctl.checkpoint` | 透传 + 把上游 COPY 成 parquet 快照（**与 src.rest 的 checkpoint 是两回事**，后者见 §4） | 写失败即 stage 失败 | `mod.rs:4272-4291` |
| `ctl.setvar` | run 中算一个值存**run 自己的 DB**（非 session），后续步骤 `${name}` 取；接上游时表达式按第一行求值 | 求值失败即 stage 失败 | `mod.rs:3919-3973` |
| `ctl.switch` | 按 case_1..N 条件路由（首个命中胜），有 default 口 | 无命中且无 default ⇒ 行丢失（构建错误仅限非法条件） | `mod.rs:6372-6379`（build_switch） |
| `ctl.merge` | 多输入 UNION ALL | — | `builders.rs:430` |
| `ctl.replicate` | 同一数据发多路下游 | — | `builders.rs:426-429` |
| `ctl.parallelize` | 上游快照一次，各独立分支子管线并发跑（各自 temp DB），分支节点状态**折回父 run 报表** | 任一分支失败 ⇒ stage 失败 | `mod.rs:4070-4077, 1226`；`lib.rs:2343-2402` |
| `ctl.anchor` | 零工作纯锚点，**专门挂 trigger 边定序**（「先 A 后 B」） | — | `mod.rs:3901-3918` |
| `ctl.log` / `ctl.warn` | 打一行日志（`{rows}` 模板）再透传；warn 不判红 | — | `mod.rs:4078-4097`；`lib.rs:2405-2413` |
| `ctl.wait` / `ctl.throttle` | 定长睡眠 / 按 rows-per-second 推导的级间延迟 | — | `mod.rs:4239-4271` |
| `ctl.file` | 类型化文件操作 copy/move/delete/archive（`failOnError` 默认 false） | 默认失败不判红 | `mod.rs:3861-3900` |
| `ctl.retry` | **不是组件**：目录项指路「每节点的 Advanced 页 retryAttempts/retryBackoffMs」 | 见 §4 重试语义 | catalog；`props.rs:804-805` |

**订正 #276 事实基础**：ctl 家族是 **21 个不是 22 个**；`ctl.schedule` 在 0.7.3/0.7.4 catalog 都**不存在**（两份 catalog 逐键 diff 为空集）——调度是 console 侧 `crates/scheduler`（cron/interval 触发管线、`<workspace>/schedules.json` 持久化、15s tick；`crates/scheduler/src/lib.rs:1-16`），不是管线组件。

**每个节点都有的 Advanced 开关**（`mod.rs:2063-2085` 解析）：`retryAttempts`（默认 1=不重试）、`retryBackoffMs`（线性×尝试序号）、`continueOnFailure`（软 stage）、`memoryLimitMb`。

---

## 3. foreach 的 checkpoint / 重试 / 连败语义（源码 + 实测双锚）

### 3.1 checkpoint 到底存在哪、键是什么

- 存储：`workspace/state/<run名>/checkpoints/<node>.ndjson`，**append-only**，逐条「key + at + output(整行结果内联)」（`checkpoint.rs:66-136`）。
- 键 = `hash(逻辑键 + 输入指纹 + 配置指纹)`（`checkpoint.rs:208-254`）；src.rest 父模式的配置指纹 = url/urlTemplate/method/body/responsePath/parentKeyColumn/responseMetadata（**+ 已代入的增量游标**）（`connectors.rs:16411-16448`）。
- 读取时机：**每个 parent 的 walk 一结束就落一条**——下一个 parent 失败也不会丢已完成的（`connectors.rs:16457-16474`）。
- 子管线（foreach/runjob/iterate 共用）按 **child 文件名+item** 命名 run（`child_run_name`，`connectors.rs:16924-16937`：名字来自子管线自己的文件而非调用者），所以 foreach 每窗的 checkpoint 目录**天生稳定**（实测 `state/d-child_w01/`…）。
- 裁剪：`duckle` 有 prune（按天/按字节，最旧先删；`checkpoint.rs:301-381`）。

### 3.2 失败窗怎么重挑（三种形态，全部实测）

| 形态 | 重试时点 | 只补失败窗？ | 实测回执 |
|---|---|---|---|
| **reject+checkpoint**（src.rest 父模式） | **跨 run**：重跑同一名的管线，已成功窗 0 HTTP 复用，只发失败窗 | ✔（B4：`5 parent(s) reused…0 page(s)`，access 仅 `04\|504`；网关恢复后 B5 只采 w04 即转绿） | `out/b4.out` `out/b5.out` |
| **foreach+子checkpoint+节点 retryAttempts** | **同 run**：子窗失败→foreach stage 失败→整个 stage 重试，**成功窗从 checkpoint 复用（0 HTTP）、只重发失败窗** | ✔（D2：access `w01×1, w02 504→200, w03×1`，run 绿） | `out/d2.out`；对照 D3 无 checkpoint 时 `w01×2`（`out/d3.out`） |
| 同上（跨 run 视角） | 持久失败窗重跑时也只补缺口：run X（fail_always w02）红、w01 已 checkpoint；run Y（恢复）**只发 w02+w03**（w03 是 X 里没采到的，正确地补采），绿 | ✔ | `out/d7.out` `out/d8.out` + access |
| **foreach dispatch=queue** | **跨 worker pass**：失败 item 保持可认领，下一 pass 只取它 | ✔（Q：pass1 `ran 5, failed 1` 退出码 1；pass2 只跑 item 03 `ran 1, failed 0`） | `out/q1w1.out` `out/q1w2.out` |

**昨日「重试时点是方言」的结论在 0.7.4 逐条复现成立，且新增了同 run 方言（D2）——昨报清单 1 的「同 run 内自动重试=真缺口」判定就此证伪**（前提：接受「重试=stage 级整体重跑+checkpoint 让它只花在失败窗上」这一方言）。

### 3.3 连败中止的确切行为（仍是缺口）

- 引擎全库无 consecutive 概念（grep `consecutive` 仅命中注释；`connectors.rs` 的 `maxRequests` 是**发请求前**的父行总数帽 `connectors.rs:16045-16052`，不是运行中连败帽）。
- inline foreach：**连败 1 即中止**（顺序形首个失败行 break，`lib.rs:2279-2289`）——比阈值更激进且丢尽力采（昨日 a3 + 源码双锚）。
- reject 形：永不提前停（所有窗都请求完），可事后窗口函数判连败再 die，但请求已全部发出，不满足「不空转」动机。
- `continueOnFailure`（软 stage，**0.7.4 实测有效**，C 证据）只让**后续 stage** 继续，不会让 foreach 的**剩余行**继续——帮不上连败语义。

---

## 4. ctl.try / ctl.die 的作用域与错误传播（源码锚）

- **die**：`lib.rs:2416-2432`——对**自己节点的上游行数**判 has-rows/no-rows/always；触发 ⇒ `EngineError::Query("ctl.die: …")` ⇒ run 红（退出码 1）。它**只看本节点上游**，不做全局判定；要「末尾统一判红」需让它排在最后（anchor trigger 边定序，B1 实测：r5 deadletter 先落盘、r6 die 后红；无 anchor 时 die 先杀、落盘全丢——昨日 r2d 反例）。
- **try**：`lib.rs:3044-3058`——安装点**之后**的**任何** stage 失败触发一次兜底（`Option::take()` 只一次）；兜底跑成功**原错误仍传播**（run 红）；兜底失败则「原错 + 兜底也错」合并。不是块级作用域、不能恢复继续（源码注释明说等 DAG 重构）。
- **stage 错误的统一出口**（`lib.rs:3020-3068`）：记录该 stage 为 error → try 兜底（若有）→ `continueOnFailure`? 是则继续下一 stage 否则 break → 收尾时未跑 stage 记 skipped。**软 stage ≠ 装没失败**：run 仍红（C 实测：f1 error、f2/sinkB 照跑、退出码 1、`out/c1.out`）。
- **`src.runevents`**（`mod.rs:3850-3860`）：把本 run 已发生的 stage 失败作为**错误行源**吐出（配软 stage 才有内容）——错误面的数据化出口。

---

## 5. 0.7.4 新增编排能力：passesRows 全解 + 其余 diff

### 5.1 ctl.runjob/trigger/runpipeline 的 passesRows（0.7.3→0.7.4 编排面**唯一**新增）

catalog diff（`/tmp/aw-lab-074/components-body.diff`）里 ctl.* 的变化只有三处 param 列表各加 `passesRows`；双版本 runner strings 比对：0.7.3 `passesRows` 0 处、0.7.4 有 5 处。其余 0.7.4 diff 全是连接器（access/manticore/sharepoint/delta/pg-cdc/iceberg catalog/cloudAuth），与编排无关。

| 问题 | 答案 | 证据 |
|---|---|---|
| 参数怎么传 | **父→子**：上游快照成 parquet，路径以 `${DUCKLE_INPUT}` 注入（`lib.rs:2144-2169`，用后即删）；**子→父**：`returnsRows` 走 `${DUCKLE_RETURN}` 交接文件（temp 目录、pid+计数器防撞，`mod.rs:4017-4043`）。标量仍走 `contextVariables`；替换优先级：run 变量 < 调用点变量 < 行值（`lib.rs:2136-2143`） | A1：3 行进 3 行出、子内 `val*2` 回到父 sink（`out/a1.out` + `a1-parent-got.csv`） |
| 失败怎么传播 | 子管线任何失败 ⇒ 父 stage 失败（错误带 `ctl.runjob(path):` 链），父 run 退出码 1，下游不写 | A2：子 ctl.die ⇒ `error: ctl.runjob(…): ctl.die: A2_CHILD_FAIL`（`out/a2.out`） |
| 能否递归 | 能：child 里再挂 runjob+passesRows 往下传（DUCKLE_INPUT 每层各自快照） | A4：top→mid→grand 两层，grand 拿到全部行（`out/a4-grand-output.csv`） |
| 能否与 foreach 组合 | 能：foreach 出 `${ITER_ITEM_*}`，子管线内以 `contextVariables` 把它继续传给块；块按行处理并可用 `${W}` 落每窗文件——**「foreach 管迭代 + runjob 块管复用」的分层成立** | A5：`a5-block-w01..w03.csv` 三个每窗产物全在（`out/a5.out`） |
| 同 run 重试 | runjob 节点的 `retryAttempts` 连子管线一起重试（源码注释「sub-pipeline + SQL together」） | A3：子第 1 次故意红、第 2 次绿，父 run 绿（`out/a3.out`，counter=2） |
| 并行 | 未单测；foreach `concurrency` 与 ctl.parallelize 与 runjob 组合在源码上无互斥（各自独立 temp DB），标「待沉淀」 | — |

### 5.2 其余 0.7.3→0.7.4 与编排相关的核对

- ctl 组件集合**零变化**（两版 catalog ctl 键差集为空）。
- `src.rest.maxRetries`（请求级 429/5xx 重试）**仍是广告未实现**：catalog params 列出，但 plan 构建只给 `xf.ai.classify/llm/embed` 解析 maxRetries（`mod.rs:6648/6708/6792`），RestSourceSpec 无该字段（`mod.rs:6223-6272`）——**上游缺陷，0.7.4 未修**（昨报清单 5 在 0.7.4 继续成立）。
- `continueOnFailure`：**0.7.4 实测有效**（C 证据）——昨报「两种放法实测无效」系 0.7.3 现象/放置问题；正确放法 = 节点 `data.properties.continueOnFailure: true`（Advanced 页）。0.7.3 二进制含该字符串但行为未复测，按「0.7.3 待复测、0.7.4 已证」记录。
- queue 形在 0.7.4 复测与 0.7.3 行为一致（Q 证据：失败 item 跨 pass 只重它；`maxAttempts` 耗尽转 DEAD 的行为沿用昨报 q3 + `batch.rs:329`）。

---

## 6. 能力 × wrapper 职责矩阵（逐行判定）

wrapper 职责清单取自任务书 + 通读 `run-retail-day.sh`（1021 行）补 6 行。判定三档：**原生替代**（含方言）/ **部分替代** / **无对应**。

| # | wrapper 职责（行号） | 引擎原生物 | 判定 | 证据锚 |
|---|---|---|---|---|
| 1 | 24 时窗循环（L465-481, L750-758；每窗起新容器跑重管线） | 窗口集=数据：`src.rest` 拉窗口表 → 父模式 urlTemplate 逐窗扇出（reject 形）；或 foreach 逐窗调子管线（foreach 形） | **原生替代**（reject 形昨日 eb 24/24/0；foreach 形 A5/D2） | `connectors.rs:16024-16027`；B/D/A5 回执 |
| 2 | 单窗失败登记不拖垮整批（w_failed 登记+继续，末尾 `WINDOWS_FAILED` 判红 L754-757） | reject 形：`onParentError=reject` → `__reject` 关系（恒建表，空也能绑）→ `ctl.deadletter` NDJSON 登记 → anchor 定序 → 末尾 `ctl.die has-rows` 判红退出码 1 | **原生替代**（B1：5 窗采到、w04 登记、run 红；deadletter 行含 parent_key/url/error/error_code） | `connectors.rs:16487-16522, 16618-16637`；`mod.rs:4292-4321`；`out/b1.out` |
| 3 | 失败窗定向重试（同 run 2 轮 60s 退避只重失败集 L483-502） | 三方言任选：跨 run（reject+checkpoint B4/B5；foreach 形 D7/D8）/ **同 run（foreach+子checkpoint+节点 retryAttempts，D2——昨日缺口已闭）** / 跨 pass（queue，Q） | **原生替代（方言）**——退避节奏从「run 内 sleep 60s」变为「stage 重试线性退避 / 调度重跑 / 下一 pass」，见 §8 取舍 | `mod.rs:3836-3847`（queue RetryPolicy）；`lib.rs:2115-2125`（stage 重试）；D2/D3/D7/D8/B4/B5/Q 回执 |
| 4 | 连败 ≥3 中止 `WINDOWS_ABORT`（L136-137, L466-479） | **无**：无 consecutive 概念；inline=连败 1 即中止（更激进丢尽力采）；maxRequests 是发前总量帽 | **无对应（上游缺席）**——回喂上游（parent 模式连败阈值）或接受代价（网关全挂=24 次快速失败） | §3.3 grep 证据；`connectors.rs:16045-16052`；昨日 evidence-check3 |
| 5 | 幂等覆盖写：同窗重跑覆盖 `hour=` 分区 + BATCH_ID 铸造（重管线 sink `mode=overwrite`；L514） | sink 覆盖写在重管线里（不动）；BATCH_ID 时间戳可 `ctl.setvar` run 内一次铸造、随 run 变量传子（`lib.rs:2136-2143`） | **原生替代**（foreach 形子管线逐字保留即继承；reject 形需验 sink partitionBy 覆盖语义，见 §8） | `mod.rs:3919-3973`；昨日 ec（setvar 推 tick 窗口实测） |
| 6 | 身份自证：whoami×3 传输重试 + 凭据账套相等 + 配置门店⊆可见 + 未证不写湖（L341-420；IDENTITY_CHECKED export L716-749） | **表达力已证**：`src.rest`(whoami, retryAttempts=3) → code.sql 集合比对（list_intersect/from_json）出 mismatch 行 → `ctl.die has-rows` 红 + anchor 定序把采集排在门后 | **原生替代（技术面 1:1）**；治理面建议双保险（§7），配置对不对属部署面校验不该下沉 | E1/E2/E3：匹配绿 / 错配 2 行登记+die 红 / 仅 die 形也判得动（`out/e*.out` + `e-mismatch.csv`） |
| 7a | 末页守卫（容量闸 12 页×200） | 已在重管线内（guard=ctl.die has-rows on p12）；引擎另有 src.rest `maxPages` 硬帽→pagination_capped_err stage 失败（双保险） | **原生替代（现状即原生）** | `connectors.rs:16386-16396`；重管线 guard 节点 |
| 7b | ETag 核对（idem3 字节级幂等验收：同 batch_id 三跑 ETag/Size 全等 + 换 batch_id 因果对照 L220-244, L962-977） | **无对应**：引擎无 S3 对象 ETag 比对节点；checkpoint 证的是「引擎不会重复请求」，不是「湖上字节没变」 | **无对应——不该下沉**（验收工具非日常采集职责，保留薄诊断入口） | idem3 分支；无引擎锚（这正是判定） |
| 8 | 退出码语义（0=全过 非0=有失败；字面量可 grep；qa.contract 判 thin 管线 L27-47） | 引擎退出码契约 0/1/2（`duckle --help` EXIT CODES 节：1=「跑了且报告失败」）；合并形判红=run 状态本身（die/contract→红），不再 shell 正则抠行 | **原生替代（更干净）** | CLI help；B1/E2 退出码 1、B5 退出码 0 |
| 9 | TZ 钉死的 BIZDAY/SNAPSHOT 推导 + YYYY-MM-DD 断言（L99-129, L835-843） | `ctl.setvar` 运行时 SQL（`strftime(now()…)` 带 TZ）或内建 `${date}` 系替换；形状断言=qa.contract regex | **原生替代** | `mod.rs:3919-3973`；昨日 ec |
| 10 | tick 窗口推导（cur+prev/close、跨零点纯函数 L540-575） | 窗口集=数据：mock `/windows` tick 模式直接 `[23,00]` 同一管线跑通（昨日 ec） | **原生替代** | 昨日 ec 回执 |
| 11 | _ops 观测行（sink 行正则解析 rows + OO 投递；不影响退出码 L255-339, L520-535） | **部分替代**：行数=节点原生 rows（正则解析消失；OPS_ROWS_UNPARSED 整类问题消失）；OO 投递可用管线内 snk.webhook 分支发 `_json`，或引擎 metrics（logs/duckle_metrics.prom 实存）——**OO 通道接线未实测，标待沉淀** | **部分替代（差投递通道验证）** | `out/` 各回执节点行；`logs/duckle_metrics.prom` |
| 12 | 失败告警（EXIT trap + WeCom webhook，LEMENG_NOTIFY 门 L422-456, L683-684） | **部分替代（设计已通未实测）**：`ctl.try` 兜底子管线（snk.webhook POST WeCom）恰是「失败时跑一次」的语义；trap 的「任何退出路径都覆盖」= try 作用域「其后任何 stage 失败」（装配点之后全管——放管线头即全管） | **部分替代（待实测）** | `lib.rs:3044-3058`；§8 设计 |
| 13 | 容器/进程编排（$COMPOSE run 每窗新容器 + shim L83-196） | 合并形一个进程跑整管线，**这层整体消失**（这正是拆壳的收益本体） | **原生替代（消失）** | — |
| 14 | 诊断/验收模式（probe/listing/idem3/drift/recon/agg/rb/envfile） | drift 已是引擎子命令（thin 管线在用）；recon 可管线化（duckdb s3 回读+翻页比对+die）但属独立只读流程；listing/idem3 是验收工具 | **部分保留**：诊断入口保留薄壳（或独立诊断管线），不进采集主管线 | wrapper 各分支；`duckle drift` 实存 |

---

## 7. 三档判定

### 7.1 现在就能拆（0.7.4，表达力已实测）

职责 #1 循环、#2 登记不拖垮、#3 定向重试（三方言任选其一）、#5 幂等覆盖写+BATCH_ID、#6 身份自证（技术面）、#7a 末页守卫、#8 退出码、#9 时区推导、#10 tick 推导、#13 容器编排消失。

### 7.2 还差什么（每条注明：上游缺陷 / 文档盲区 / 我方待沉淀）

| 缺口 | 性质 | 处置 |
|---|---|---|
| 连败 ≥N 中止（职责 #4） | **上游缺席**（引擎无 consecutive 概念；inline 形反而是连败 1 即中止） | **处置已定（2026-09-28 拍板）：不回喂上游、按已知代价接受**——跨 run 补采已保证正确性，缺的只是止损（代价有界：网关全挂时 24 窗快速失败，每窗≤页数个请求）。真出事故（压力/告警风暴）且上游无方案 → `ext.*` 自定义组件兜底（判定表见手册 §1.1.7） |
| src.rest `maxRetries` 请求级重试 | **上游缺陷**（catalog 广告、plan/connector 不解析不执行，0.7.4 仍在） | 已有 stage-retry+checkpoint 方言顶替（D2）；仍应回喂（429/5xx 自愈本该在请求层） |
| checkpoint 复用不感知上游内容变化 | **文档盲区**（键=配置+父行，无内容指纹；docs/current 对 checkpoint 只字未提） | 设计约束自带：**windows 形开（闭窗数据不变）、tick 形禁**（累积窗会被冻结在首快照，B7 实测） |
| reject 形 checkpoint 存储跟 run 名走 | **文档盲区**（`state/<run名>/checkpoints/`；`--name` 每次变 ⇒ 断档，b1/b2 实测反例；默认 stem 名稳定） | 合并形用默认名或钉死名；**foreach 形无此问题**（child+item 天生稳定，D5/D6 跨进程零 HTTP 复用） |
| queue 形收尾 pass 退出码恒 0 | **文档盲区**（昨报清单 4；0.7.4 复测仍在） | 若走 queue 形，判红读 `work status`；或不用 queue 形 |
| reject 形单 sink 多时窗分区写的覆盖语义 | **我方待沉淀**（snk.minio 有 partitionBy 参数，但「覆盖写按分区还是按整路径」未验证） | 实施前实验；或直接选 foreach 形（子管线=现重管线，sink 语义零改动） |
| _ops 的 OO 投递通道、WeCom 告警的 try+webhook 形 | **我方待沉淀**（表达通路存在，未实测） | 实施期最小实验后收编 |

### 7.3 永远不该下沉（保留在壳/平台层）

| 职责 | 理由 |
|---|---|
| ETag 字节级幂等验收（idem3） | 它验收的是**湖上对象**（引擎外部世界），引擎无视角；且是验收工具非日常采集——保留薄诊断入口 |
| envfile/密钥物化、宿主-容器编排、shim | 平台层（openship/env 注入）职责，管线不该碰密钥落盘 |
| 凭据↔账套的**配置治理**（确保 3120 的管线带 EXPECTED_BOOK=3120） | 管线内断言只是第二道闸；「配置对不对」是部署面校验（发布物里账套常量与凭据同源检查），下沉了反而把治理面藏进画布 |
| recon 对账、probe/listing/drift 诊断族 | 独立只读/验收流程，与采集主管线生命周期不同，合并只增耦合 |

---

## 8. 合并后管线形态草案（设计，不实施）

**推荐形态：foreach 父管线 + 现重管线(加 checkpoint)作子**——重管线逐字保留（战场验证的 flatten/contract/sink 语义零改动），只把 shell 循环翻成管线；**备选：reject 单管线形**（少一层子管线，但欠 sink 分区覆盖语义验证）。

```
lemeng.retail_order_line.day.json（父管线，windows 形）
  v0  src.rest   POST whoami（retryAttempts=3）            ← #205 身份探针
  v1  code.sql   集合比对出 mismatch 行（company/branches⊆）  ← E2 形
  g0  ctl.die    has-rows "IDENTITY_ASSERT_FAIL …"           ← 身份门（红=后文全不跑）
  a0  ctl.anchor ← trigger: g0→a0；a0→w0（强制「先证后采」）
  w0  src.json / src.rest   窗口表（00..23 或 setvar 推导）
  fe  ctl.foreach pipelineRef=lemeng.retail_order_line.json（现重管线）
      ├ itemKey=hour
      ├ retryAttempts=2          ← 同 run 定向重试（D2 方言：子 src.rest checkpoint=true）
      └ （重管线内：src.rest 加 checkpoint=true；guard/gate/sink 原样）
  su  code.sql   汇总每窗 summary（read_csv glob，昨日 a1c 形；或 runjob+returnsRows，A1 形）
  a1  ctl.anchor ← trigger: 各 sink→a1；a1→g1（先落盘后判红，B1 教训）
  g1  ctl.die    has-rows（deadletter/失败 summary 行数>0）"WINDOWS_FAILED hours:…"

调度：console scheduler 直接挂本管线（cron/interval；crates/scheduler）。
重试语义对照 wrapper：
  · 同 run 自愈：foreach 节点 retryAttempts（替代 retry_failed_windows 的当轮补采）
  · 跨 run 补采：调度重跑（子管线 per-item checkpoint 保证只补失败/未采窗，D7/D8）
  · 放弃：连败中止（§7.2 代价已知）
tick 形：同骨架，但 (a) 子管线 src.rest checkpoint=false（防陈旧快照，B7）；
  (b) 窗口表=setvar 推导 [cur,prev]（昨日 ec）；(c) 不需要 g1 判红之外的新逻辑。
观测：su 汇总表 → snk.webhook POST OO `_json`（每窗一行，字段对齐现 _ops 行）——待最小实测。
告警：管线头 ctl.try fallback=告警子管线（snk.webhook→WeCom）——待最小实测。
```

该形态对 wrapper 的处置：`windows/tick/window` 三模式被父管线+调度吸收（约 -400 行）；`identity` 被管线内身份门吸收；`idem3/listing/drift/recon/probe/rb/agg/envfile` 保留为诊断薄入口（这些本就不是日常采集路径）。

---

## 9. #276 可行性段落的更新素材点

1. **事实基础订正**：ctl 家族 21 个（非 22），`ctl.schedule` 不存在；调度在 console 侧 `crates/scheduler`。
2. **缺口②（foreach 只重试失败窗表达力）可以销**：三方言全实测（跨 run B4/B5、同 run D2、跨 pass Q）；昨报「同 run 内自动重试=真缺口」的判定**作废**（0.7.4 foreach+子checkpoint+retryAttempts 组合）。
3. **缺口①（身份自证表达力）可以销**：E 系实测 HTTP 探针+集合比对+die+定序 1:1 成立；余下是治理问题（§7.3）不是表达力问题。
4. **真缺口只剩连败中止**：上游缺席，处置=回喂或接受代价。
5. **0.7.4 升级评估**：编排面增量=passesRows（A1-A5 全实测通过），其余 diff 与编排无关；`src.rest maxRetries` 仍未实现（升级后依旧不能指望请求级自愈）。
6. **新知识**：checkpoint 三条硬约束（陈旧复用 / run 名敏感 / tick 禁用）与 continueOnFailure 在 0.7.4 有效——都应写进 #276 的「方言坑」附录。

---

## 10. 方言坑清单（合并实施时带走）

1. **checkpoint 冻结首快照**：复用键不含上游内容（B7：上游改 3 行、重跑 0 HTTP、summary 仍 2 行）——闭窗开、tick 禁。
2. **reject 形 checkpoint 跟 `--name` 走**：自定义名每次变=断档（b1/b2）；默认 stem 稳定；foreach 形按 child+item 天生免疫（D5/D6）。
3. DuckDB 保留字列名（`window`/`rows`）必须引号——同一 SQL 包进 CREATE VIEW 后命运不同（昨报 #1，0.7.4 依旧）。
4. `ctl.deadletter` 恒 NDJSON，扩展名不算数（昨报 #2）。
5. `ctl.die` 接 reject 支路必须 anchor trigger 边定序「sink 先落盘、die 最后判」（B1 正例 / 昨日 r2d 反例）。
6. src.rest 的 JSON 数组列到手已是 **LIST 类型**：`CAST(col AS VARCHAR)` 再 `from_json` 会因前导零炸 `Malformed JSON`（E 系三迭代的实测教训）；直接当 list 用。
7. `code.sql` 里 `${ENV:…}` 替换有效（E 系日志里 3120/9999 已代入）；但开头不能再用 `WITH`（被包一层 `WITH input AS`），子查询写法。
8. queue 形「一次 run」=一个 batch+N 个 pass，收尾 pass 退出码恒 0，判红读 `work status`（昨报 #4，Q 复测）。
9. `src.rest.maxRetries` 广告未实现（0.7.4 仍在）——请求级自愈用 stage retry 方言，别配它。
10. inline foreach 顺序形**连败 1 即中止**（`lib.rs:2279-2289`）——尽力采场景别用 inline 裸跑。
11. 变量替换优先级：run 变量(setvar) < 调用点 contextVariables < foreach 行值（ITER_ITEM_*）——同名时「更具体的赢」（`lib.rs:2136-2143, 2238-2260`）。
12. `ctl.die` 三态条件与 `{rows}` 模板：`always/has-rows/no-rows`（`lib.rs:2416-2432`）；「末尾统一判红」用 has-rows。

---

## 11. 证据索引（全部 `/tmp/aw-lab-orch/`，零生产）

| 回执 | 证明 |
|---|---|
| `out/a1.out` + `out/a1-parent-got.csv` | passesRows+returnsRows：3 行进、子内翻倍、3 行回父（A1） |
| `out/a2.out` | 子 die ⇒ 父 `ctl.runjob(...): ctl.die` 红、下游不写（A2） |
| `out/a3.out`（counter=2） | runjob 节点 retryAttempts=2 同 run 重试子管线（A3） |
| `out/a4-grand-output.csv` | passesRows 递归两层（A4） |
| `out/a5-block-w0*.csv` | foreach×可复用块、contextVariables 传窗号（A5） |
| `out/b1.out` `out/b3.out` | reject 形尽力采+NDJSON 登记+anchor 定序+die 判红（B1/B3；`out/deadletter.parquet` 为 NDJSON） |
| `out/b4.out` + access | 跨 run 定向重试：`5 parent(s) reused…0 page(s)`、只发 04（B4） |
| `out/b5.out` + access | 网关恢复→只补 04→转绿（B5） |
| `out/b6.out` `out/b7.out` + summary | checkpoint 陈旧性：上游已改、重跑 0 HTTP、旧快照胜（B6/B7） |
| `state/b1..b2 与 b-reject` 对照 | reject 形 checkpoint 存储=run 名（b1/b2 断档反例） |
| `out/c1.out` + `out/c-sinkB.csv` | continueOnFailure 0.7.4 有效：软 stage 红、后续分支照跑、run 红（C） |
| `out/d2.out` + access | **同 run 定向重试**：w01×1、w02 504→200、w03×1、绿（D2） |
| `out/d3.out` + access | 无 checkpoint 对照：重试把 w01 也重发（D3 ⇒ 靶心确系 checkpoint） |
| `out/d5.out` `out/d6.out` + access | foreach per-item checkpoint 跨进程复用：0 HTTP（D5/D6） |
| `out/d7.out` `out/d8.out` + access | **foreach 形跨 run 只补缺口**：X 持久失败红（w02×2 504）→ Y 恢复后只发 `w02\|200`+`w03\|200`（w01 复用），绿 |
| `out/e1/e2/e3.out` + `out/e-mismatch.csv` | 身份断言管线化：匹配绿 / 错配登记+die 红 / 仅 die 形可判（E） |
| `out/q1*.out` + access | queue 形 0.7.4 复测：pass 只补失败 item（Q） |
| `mockstate/access.log` | 全程逐请求 `序号\|时刻\|窗\|状态`（请求数/顺序的最终事实源） |

昨日 0.7.3 证据（`/tmp/aw-lab-foreach/`，只读）：a3 inline 连败 1 中止、eb 24 窗全请求恰一遍、ec tick `[23,00]`、q3 attempts 耗尽 DEAD+收尾 pass 退出码 0、r2d anchor 定序正反例、r3 跨 run 复用。

## 12. 边界与未覆盖

- 未触真网关/真桶/真服务器；mock 每窗单页（分页/游标行为沿用引擎源码+昨日结论，未再压）。
- passesRows 与 concurrency>1 / ctl.parallelize 的组合未实测（标 §5 待沉淀）。
- snk.minio partitionBy 覆盖语义、snk.webhook→OO、ctl.try→WeCom 三项待实施期最小实验（§7.2）。
- 0.7.3 的 continueOnFailure 行为未复测（0.7.4 已证有效；0.7.3 二进制含该字符串）。
