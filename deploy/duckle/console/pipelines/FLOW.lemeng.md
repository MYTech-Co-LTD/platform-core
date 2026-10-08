# 乐檬（lemeng）采集管线流程图

> **这是「源系统 = 乐檬」的图。** 两个账套（3120 / 64188）**共用同一批管线** —— 客户差异只在
> `env`（账户号 / 门店清单 / 桶）· 保存的连接 · 每账套一份的排班文件 ⇒ **下面两张图对两个账套都成立**，
> 客户既不进图、也不进文件名。
> **图例与通用表**（🟦 引擎替我们干的 / 🟧 语义由我们写）在 [`README.md`](README.md)；
> **形态与选型的正典**在 `docs/data-platform-handbook.md` §1.1.7；**乐檬特有的方言**在各管线自己的
> `_note` 与 handbook §1.6 案例库。**本文件不复制正文。**
> **维护约定**：改了乐檬任何管线的节点/边 ⇒ 改本图，并重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`。

## 乐檬的四形态 × 10 条管线

| 形态 | 文件 | 份数 |
|---|---|---|
| **L0 直连**（单窗/日频，无跨窗编排） | `lemeng.dim.branch.l0.json` · `lemeng.dim.item.l0.json` · `lemeng.dim.item_price.l0.json`(64188) · `lemeng.dim.item_price.l0.3120.json` | 维度面各 1（双账套）；价格批**每账套一份**（#481——批内门店号是生成时字面量，两账套清单不同 ⇒ 不共用文件） |
| **L1 编排**（跨窗循环） | `lemeng.retail.windows.l1.json` · `lemeng.retail.tick.l1.json` · `lemeng.retail.close.l1.json` | 3 |
| **业务子管线**（单窗怎么采，被 L1 复用） | `lemeng.retail_order_line.window.json` · `lemeng.retail_order_line.tick.json` | 2 |
| **回填变体**（只差窗口来源，不进调度） | `lemeng.retail.windows.backfill.json` | 1 |
| **判据/对账**（管线外判据落进管线，不采数不写湖） | `lemeng.recon.preagg.json` · `lemeng.recon.preagg.item.json` | 文件双账套同；**仅 64188 排班** |

---

## 图 1 · L0 直连（维度面：全量快照）

> **价格批（#481，`lemeng.dim.item_price.l0*.json`）与下图同构，两处结构差**（生成器
> `scripts/lemeng/gen-item-price-pipeline.mjs` 产出，**不手编**）：
> ① 扇出基准 = **门店批**（15 店/批；realprice 无分页，item.find 按页）——批内门店号是
> **生成时字面量**，`last_edit_time` 也是（生成日的滚动 2 年窗起点，网关上限 10310217
> 随「今天」滚）⇒ **门店增减或字面量临期 ⇒ 重跑生成器**（约 2 年一次）；
> ② `guard` 换成 `coverage→cg`：merged 门店集合对 `${ENV:BRANCH_NUMS}` **点名**，
> 多/少一家都 die（批字面量过期的 fail-loud 防线，角色同下图哨兵页）。


> 档：**①** 纯 duckle · **②** duckle 组件 + 我们的规则/配置 · **③** 纯手写代码（`code.sql`）
> 每个节点标注 = **档 + 节点 + 组件 + 这个节点干什么**。

```mermaid
flowchart TD
  S["① 调度 console —— 到点点火（补跑语义由 misfire / catchup 定）"]:::e1
  S --> W0["② w0 src.rest 身份探针 —— 先问网关「我是谁」<br/>拿回凭据对应的账套号与可见门店（先证后采第一步）"]:::e2
  W0 --> G0["③ g0/g1/g2 code.sql —— 把身份从响应里挖出来<br/>抠 data: 行 → 取最后一条 → 剥外壳 → 得账套 + 门店清单"]:::e3
  G0 --> D0["② d0 ctl.die 反向闸 —— 抠不出身份就红<br/>挡住网关形状漂移后的「静默采错账套」"]:::e2
  D0 --> G3["③ g3 code.sql 两条断言 —— 凭据账套 == 配置账套？<br/>配置门店 ⊆ 可见门店？越权就列出来"]:::e3
  G3 --> D1["② d1 ctl.die —— 有违规行即红，并阻断下游<br/>身份未证时一次业务调用都不发（先证后采）"]:::e2
  D1 --> GV["③ gv code.sql 形状闸 —— 期望值（批号/账套/快照/页数）形状合法吗<br/>防「env 缺参 ⇒ 断言静默半失效」"]:::e3
  GV --> DV["② dv ctl.die —— 形状不合就红（缺席/畸形一律拒采）"]:::e2
  DV --> P["② p1…pN src.rest 分页 —— 一页一请求把数据抓回来<br/>页数×页容量就是这台网关的容量上限"]:::e2
  P --> GUARD["② guard ctl.die 末页哨兵 —— 最后一页还有数据 ⇒ 容量击穿<br/>立刻红（fail-loud，不静默丢数）"]:::e2
  GUARD --> MG["① merge ctl.merge —— 把 N 页拼成一张表（零逻辑）"]:::e1
  MG --> SH["③ shape code.sql 定型 —— 注入 batch_id / system_book / snapshot<br/>并把列名与类型钉死（落湖即定型）"]:::e3
  SH --> GT["② gate qa.contract 契约闸 —— 必要列非空才算过<br/>不过就直接报错，不写湖"]:::e2
  GT --> SK["② sink snk.minio 写湖 —— 按分区路径落 parquet<br/>单对象覆盖 ⇒ 同批重跑逐字节一致（幂等）"]:::e2
  classDef e1 fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef e2 fill:#fff4e5,stroke:#e8710a,color:#7a3300
  classDef e3 fill:#e6f4ea,stroke:#137333,color:#0d5221
```

| 节点 | 档 | 组件的（引擎给的机制） | 我们的（我们写的内容） |
|---|---|---|---|
| `w0` src.rest | ② | REST 请求 · 重试 · SSE 原件落盘 | 探针请求体 · `data.schema` · raw 落**绝对路径**（不写对象存储） |
| `g0` / `g1` / `g2` | ③ | SQL 执行壳 | 抠 `data:` 行 → 取最后一条 → 剥 JSON-RPC 外壳 → 取出 `company_id` / 门店清单 |
| `d0` ctl.die | ② | 无行即红 | 判据：抠不出身份就红 |
| `g3` | ③ | SQL 执行壳 | 两条断言：账套相符 · 配置门店 ⊆ 可见门店 |
| `d1` ctl.die | ② | 有违规即红 + **阻断下游** | 违规即拒采（先证后采） |
| `gv` | ③ | SQL 执行壳 | 期望值形状（批号 / 账套 / 快照 / 页数） |
| `dv` ctl.die | ② | 有违规即红 | —（判据就是 `gv` 的形状） |
| `p1…pN` src.rest | ② | 分页抓取 · 重试 · 每页落盘 | 页数 / 页容量（阈值 = (页数−1) × 页容量）· 游标形状 |
| `guard` ctl.die | ② | 命中即红 | 容量截断判据（末页非空 ⇒ 击穿） |
| `merge` ctl.merge | ① | 合并多页 | — |
| `shape` | ③ | SQL 执行壳 | 注入 `batch_id` / `system_book` / `snapshot` + 全列定型 |
| `gate` qa.contract | ② | 契约求值（不过即报错） | 哪几列 `not_null` |
| `sink` snk.minio | ② | 写对象存储 | 分区写进 key · 单对象覆盖（幂等） |

> `item.l0` 同形，差别只有：分页到 **150 页**、`shape` 多一步「摊平 3 对象」。

---

## 图 2 · L1 编排（零售跨窗）+ 被它复用的业务子管线

> 每个节点标注 = **档 + 节点 + 组件 + 这个节点干什么**。

```mermaid
flowchart TD
  S["① 调度 console —— 到点点火（含 timezone / misfire / catchup）"]:::e1
  S --> ID["身份门（＝图 1 的 v0/g0/g1/g2/d0/g3/d1/gv/dv 共 9 个节点）<br/>先证凭据与账套相符，未证则整轮不采"]:::e3
  ID --> W0["③ w0 code.sql 窗口表 —— 算「这一轮该采哪些窗」<br/>日批 24 窗 / tick 当前+前一小时 / close 仅前一小时"]:::e3
  W0 --> FE["① fe ctl.foreach —— 按窗口表逐窗跑子管线<br/>同 run 同窗失败自动重试 N 次（循环与重试都是它的）"]:::e1
  W0 --> WM["③ wm code.sql —— 把窗口表落成「收据形状」(status=pending)<br/>当收据目录的 schema 锚（保证读文件恒非空）"]:::e3
  WM --> WS["② wsink snk.csv —— 落本 run 的窗口清单（收据目录第一份文件）"]:::e2
  FE --> CH
  subgraph CH["业务子管线 · 单窗怎么采（window / tick 两个变体，被父复用）"]
    direction TB
    C1["② p1…p12 src.rest 分页 —— 把这一个窗的数据翻页抓全"]:::e2 --> C2["② guard ctl.die 末页哨兵 —— 末页有数据 ⇒ 容量击穿，红"]:::e2
    C2 --> C3["① merge ctl.merge —— 拼成一张表"]:::e1
    C3 --> C4["③ flatten code.sql —— 摊平 pos_order_details 明细 + 定型到契约列"]:::e3
    C4 --> C5["② gate qa.contract —— 契约不过就报错"]:::e2
    C5 --> C6["② sink snk.minio —— 写本窗的湖分区（一窗一 key，覆盖写）"]:::e2
    C6 --> C7["① ordered ctl.anchor —— 定序：湖对象先落盘，再往下走"]:::e1
    C7 --> C8["③ summ code.sql —— 算本窗收据行（行数/状态）"]:::e3
    C8 --> C9["② receipt snk.csv —— 落单窗收据（父管线据此判缺口）"]:::e2
  end
  FE --> A1["① a1 ctl.anchor —— 等「整批跑完」再往下（定序，零逻辑）"]:::e1
  WS --> A1
  A1 --> SU["③ su code.sql 汇总 —— 拿收据 × 窗口表算每窗成色<br/>每窗成色的唯一事实源"]:::e3
  SU --> REP["② rep snk.csv —— 落汇总表（＝运行记录，给人/告警看）"]:::e2
  SU --> OP["③ op code.sql —— 把汇总折成 _ops 行（每窗一行，缺口窗也投）"]:::e3
  OP --> WH["② wh snk.webhook —— 把 _ops 行 POST 到 OO（观测面）"]:::e2
  SU --> SR["③ sr code.sql —— 挑出缺口窗（status ≠ ok）"]:::e3
  REP --> A2["① a2 ctl.anchor —— 定序：先落盘再判红"]:::e1
  SR --> A2
  WH --> A2
  A2 --> DZ["② dz ctl.die 末尾统一判红 —— 有缺口窗就让整轮失败<br/>（文案说明缺口会被后续 tick 自然补齐）"]:::e2
  SR --> DZ
  classDef e1 fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef e2 fill:#fff4e5,stroke:#e8710a,color:#7a3300
  classDef e3 fill:#e6f4ea,stroke:#137333,color:#0d5221
```

| 节点 | 档 | 组件的（引擎给的机制） | 我们的（我们写的内容） |
|---|---|---|---|
| 身份门 9 节点 | ②③ | 同图 1（die 判定 + SQL 执行） | 4 条判定 SQL + 2 条判据 |
| `w0` | ③ | SQL 执行壳 | 窗口表（要采哪些窗 —— 这是三兄弟唯一的差别） |
| `fe` ctl.foreach | ① | 逐窗循环 · 并发 · 同 run 同窗重试 | 只给 `pipelineRef` / `itemKey` / `retryAttempts` |
| `wm` | ③ | SQL 执行壳 | 收据形状（status=pending） |
| `wsink` snk.csv | ② | 写 CSV | 路径 + 覆盖模式 |
| 子管线：`p1…p12` | ② | 分页 · 重试 | 页数 / 游标 |
| 子管线：`guard` | ② | 命中即红 | 容量截断判据 |
| 子管线：`merge` | ① | 合并 | — |
| 子管线：`flatten` | ③ | SQL 执行壳 | UNNEST 明细 + 定型到契约列 |
| 子管线：`gate` | ② | 契约求值 | 契约列 |
| 子管线：`sink` | ② | 写对象存储 | 一窗一 key · 覆盖写 |
| 子管线：`ordered` ctl.anchor | ① | 定序 | — |
| 子管线：`summ` | ③ | SQL 执行壳 | 本窗收据行 |
| 子管线：`receipt` snk.csv | ② | 写 CSV | 单窗收据路径 |
| `a1` / `a2` ctl.anchor | ① | 定序（整批跑完 / 先落盘后判红） | — |
| `su` | ③ | SQL 执行壳 | 汇总（收据 × 窗口表）—— 每窗成色的唯一事实源 |
| `rep` snk.csv | ② | 写 CSV | 汇总表路径（＝运行记录） |
| `op` | ③ | SQL 执行壳 | `_ops` 行形状 |
| `wh` snk.webhook | ② | HTTP POST（一行一请求） | url / 头 / 批次模式 |
| `sr` | ③ | SQL 执行壳 | 缺口窗判据（status ≠ ok） |
| `dz` ctl.die | ② | 有行即红 | 判红文案 |

**三兄弟的差别只在窗口表**：`windows` = 24 窗（日批，零点在 UTC 02:30 / 10:30 双点火）；
`tick` = 当前小时 + 前一小时（每 5 分钟，`misfire:skip`，catchup 结构上补不回错过的窗）；
`close` = 仅前一小时（1 窗）。`backfill` 变体与 `windows` 同形，**只差窗口来源是参数**（`BIZDAY`），且**不含 `op`/`wh`**（手动驱动、不进调度）。

---

## 图 3 · 独立通道对账（判据类，2026-10-06 迁入）

> **判据类管线**：不采数、不写湖 —— 拿湖内明细按**已对齐口径**净化后与网关**预聚合端点**逐店比对
> （正典 §1.4 第三层）。判据与口径的**唯一事实源** = `scripts/lemeng/recon-preagg.sh`（定稿线 T-3、
> 容差、退出码契约都在它头注里）；本图只是它的 console 落法。**3120 不排班**（报表族端点恒 10006
> 回归未修，排上去 = 天天刷依赖红；修好再加 `schedules/3120.json` 条目）。
> gate ↔ 脚本退出码：`lguard`/`gcode` = exit3（依赖不可用），`gbranch`/`gthresh` = exit1（判据破），
> 全静默 = exit0（未定稿日也走这条，只报数）。

```mermaid
flowchart TD
  PD["③ pday code.sql —— 定稿日 T-3（上海日-3）+ 门店清单 + settled<br/>上海日 = CURRENT_TIMESTAMP+8h（引擎 current_date 是 UTC）"]:::e3
  PD --> PG["② pguard ctl.die 依赖闸 —— T-3 分区无行即红（exit3：<br/>分区缺失或零销日，保守判依赖不判账）"]:::e2
  PG --> FE["① pfe ctl.foreach —— 单行派发子管线（itemKey=bizday）"]:::e1
  FE --> LK["② lake src.minio 精确分区（bizday=ITER 占位）"]:::e2
  LK --> LG["② lguard ctl.die 湖空即红（exit3）"]:::e2
  LG --> LA["③ lagg code.sql —— 湖侧净化净额（逐订单归并，口径=脚本）"]:::e3
  FE --> PR["② pre src.rest 预聚合端点（itemsales.find branch 汇总）<br/>原始报文落盘 rawResponseDestination"]:::e2
  PR --> EN["③ envelope code.sql —— 从落盘报文抠网关 code（≠0 的行）"]:::e3
  EN --> GC["② gcode ctl.die 依赖闸 —— code≠0 即红（exit3）<br/>先于判据闸：防「依赖坏」被误诊成「门店缺失」假红"]:::e2
  PR --> PN["③ pnormal code.sql —— 源侧行定型"]:::e3
  LA --> MG["① merge ctl.merge —— 两侧并流（UNION ALL BY NAME）"]:::e1
  PN --> MG
  MG --> DF["③ diff code.sql —— 逐店透视（任一侧缺=NULL）"]:::e3
  DF --> VB["③ vbranch code.sql —— 门店缺失违规行（未定稿恒空）"]:::e3
  VB --> GB["② gbranch ctl.die 判据闸（exit1：湖有源无）"]:::e2
  DF --> VT["③ vthresh code.sql —— 容差违规单行（未定稿恒空）"]:::e3
  VT --> GT["② gthresh ctl.die 判据闸（exit1：差超容差）"]:::e2
  DF --> RP["② report snk.csv —— 逐店明细落盘（覆盖写=幂等；<br/>owners 以 *.csv maximumAge 36h 作停更锚）"]:::e2
  classDef e1 fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef e2 fill:#fff4e5,stroke:#e8710a,color:#7a3300
  classDef e3 fill:#e6f4ea,stroke:#137333,color:#0d5221
```

| 节点 | 档 | 组件的 | 我们的 |
|---|---|---|---|
| `pday` | ③ | SQL 执行壳 | T-3 定稿线（上海日-3）· 门店清单 JSON · settled 两档 |
| `pguard` / `lguard` | ② | 无行即红 | 空分区/零销日 = 依赖不可用（脚本 exit3 同款保守） |
| `lagg` | ③ | SQL 执行壳 | 净额口径逐字对应 `recon-preagg.sh`（赠品判别式 / 逐订单归并 / 不扣退货） |
| `pre` | ② | REST · 重试 · 原始报文落盘 | 请求体（bizday / 门店清单来自 ITER）· `responsePath=/result/rows` |
| `envelope` + `gcode` | ③+② | rawSql 读落盘字节 · 有行即红 | **先看 envelope 再判行**：code≠0 是依赖坏（10006 形状），不判会假红成「门店缺失」 |
| `diff` | ③ | SQL 执行壳 | 逐店透视（两侧 UNION BY NAME，缺侧=NULL） |
| `vbranch`/`gbranch` · `vthresh`/`gthresh` | ③+② | SQL 壳 + 有行即红 | 判据两档：violation SQL 恒带 `settled=1` ⇒ 未定稿日只报数不判红 |
| `report` | ② | CSV 覆盖写 | 逐店明细 = 审计工件 + owners 停更锚（36h） |

**与脚本（`recon-preagg.sh`）的关系**：判据本体已迁入本管线；脚本保留为**免 console 的手工/排障入口**
（防漂移一致性测试见 spec §7，待补）；写动作（回填闭环 `recon-day-heal.sh`）**不进管线**，仍走
openship job —— 切分依据 = spec `docs/superpowers/specs/2026-10-06-console-vs-job-for-judgements.md` §5/§7。

---

---

## 还必须自己写的（引擎给不了的业务语义）

| 自写件 | 解决什么问题 |
|---|---|
| 身份门 4 条 SQL + 2 条判据 | **凭据与账套是否相符** —— 防越权采错账套 |
| 窗口表 SQL（3 形） | 该采哪些窗（24 / cur+prev / prev） |
| 定型 SQL（注入 batch_id / system_book / snapshot + 列类型） | **落湖即定型** —— 防「列全是字符串」「同表两种时间格式」 |
| `qa.contract` 的 not_null 清单 | 契约 |
| 末页哨兵阈值算式 | 容量截断 **fail-loud**，不静默丢数 |
| 汇总 / 缺口 SQL + 判红文案 | 哪窗缺了、读哪份收据 |
| sink key 与分区形状 | 幂等 + 下游可读 |
| `_ops` 行形状 | 观测面对齐 |

---

## 落到「降工作量」的边界

- **新账套**（同渠道）：换连接 + 换账户号/门店清单 + 复核五点验收 —— **自写件一行不用改**。
- **新渠道**：形态与纪律可照抄，但上表「自写件」那一栏要重写一遍（乐檬特有的方言坑在
  `docs/data-platform-handbook.md` §1.6 案例库里，17 条）。
