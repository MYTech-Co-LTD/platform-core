# #481 乐檬价格批（门店商品应用价）接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 采集乐檬价格批（`nhsoft.retail.ai.branchitem.realprice.find`）进湖 → 发布 `data.dim_item_price` → ticket 建单金额快照恢复有源（`Closes #481`）。

**Architecture:** L0 直连管线（镜像 `lemeng.dim.item.l0`：身份门 → 批量扇出 → merge → shape → qa.contract → 单文件覆盖写）落湖 `lemeng/dim_item_price/`；dbt staging `stg_lemeng_item_price`；`publish-dims.mjs` 扩展发布 `data.dim_item_price`（跨账套去重，3120 优先 + source_book）；ticket 建单改读 dim 自然键 + 价格 join。流程执法：`.claude/skills/collect-source`（A→I）；探针报告 `.superpowers/sdd/2026-10-08-481-lemeng-price-batch/probe-report.md`（判据数值的唯一家，本计划只引用）。

**Tech Stack:** duckle L0 管线（src.rest/connectionRef/snk.minio）· dbt (pg_duckdb) · Hono 模块迁移 · vitest。

## Global Constraints（全部来自正典/纪律，逐任务隐含生效）

1. **迁移幂等**：`create table if not exists` / `drop ... if exists`；全量重跑安全（005 的教训：别 drop 会连带删索引的列）。
2. **湖列集唯一事实源 = contracts 的 expr**；`data.schema` 申报与投影 SQL 一致，空响应按申报构造（改两处、一处不改 = 空页才炸）。
3. **管线 JSON 由生成器产出 + validate_pipeline 过后提交**；不手编节点；仓内文件 = 引擎验过的。
4. **敏感值零明文**：LEMENG_TOKEN 只住 console env / connections；计划、代码、提交里只写「在哪」。
5. **compose 仍只两份**；管线/调度/告警走 console 卷（seed 工具 + 服务级 restart，E 段两步：卷内定义 seed+重启即生效）。
6. **无新 env 键**（复用 `ZOS_*` / `SYSTEM_BOOK` / 既有 `lemeng` / `zos` connectionRef）→ B9 门禁零新增。
7. **判据数值只在正典与 spec**（本计划引用探针报告实测值时标注出处）；未验环节（drift 远端形态 / spec_rate 换算）**当场最小验证**，不许引用乐檬旧结论代替。
8. **测试**：ticket 域测试需 `DATABASE_URL`（本地 rt_dev）；dim 夹具自愈走 #480 已落的 `ensureDimTables` 模式。
9. **discipline**：一个 commit 一个 scope；PR body `Closes #481`；CHANGELOG 由 release.mjs 生成（禁手写）。

## 探针结论（B/C/D 直接引用；全文见探针报告）

- 接口：`POST https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.branchitem.realprice.find`；必填 `branch_nums[]` + `last_edit_time`（≥，`yyyy-MM-dd HH:mm:ss`）；可选 `item_nums[]`。
- **无分页**（全量单发）；`last_edit_time` 真过滤已证；`item_nums` 真过滤已证。
- **跨度上限：滚动 2 年**（`code 10310217`，双账套同）；⇒ `last_edit_time` 固定传「2 年前当天」即全量当前价。
- **REST 门**通大载荷（336MB/205,764 行实测）；MCP 门大载荷断流 ⇒ 管线走 REST 门。
- 行形状：`branch.branch_code`（= dim_branch.code 同源）/ `branch_matrix_price_actived` / `item_num` / `item_grade_num`（主商品行 null）/ `pos_variant.*`（内嵌 item_code/barCode/name/unit/spec_unit/**spec_rate** 等）/ `last_edit_time` / 六档门店设定价 / 六档**最终应用价**（`*_real_price`；`regular_real_price` 是 ticket 语义的「实际标准售价」）。
- 边界：`regular_real_price` 0/空行实测存在（64188 全量 2,192 行，1.07%）⇒ 契约 nullable + 发布面过滤/标记。
- 双账套均可用（3120 价格族**不受** report.ai.* 10006 回归影响，实测）。

---

### Task 1: B 段定案登记 + 契约（contracts/common/lemeng.item_price.json）

**Files:**
- Modify: `docs/data-platform-handbook.md`（§1.7 逐源决策登记 + §2 数据源清单行——B 判停的机检落点）
- Create: `contracts/common/lemeng.item_price.json`

**Interfaces:**
- Produces: 契约 `domain: lemeng, table: item_price`，`layout.prefix = lemeng/dim_item_price`；列集（供 Task 2 管线 schema 申报与 Task 3 staging 同源引用）。

- [ ] **Step 1: §1.7 登记行**（照 lemeng.dim 行格式；要点：duckle 原生 L0 标准形态、无例外路线 ⇒ 无例外登记；引用探针报告）
- [ ] **Step 2: 契约文件**。`contractVersion: 2`；`description` 记：行粒度 = `(system_book, snapshot, branch_num, item_num, item_grade_num)`（一行 = 账套×快照日×门店×商品×分级）；列集（name/type/nullable/expr 全带）：

```json
{
  "$schema": "./_schema.schema.json",
  "contractVersion": 2,
  "schemaVersion": 1,
  "consumerVersion": 1,
  "domain": "lemeng",
  "table": "item_price",
  "owner": "data-platform",
  "layout": { "prefix": "lemeng/dim_item_price", "partitionKeys": ["system_book", "snapshot"] },
  "description": "乐檬门店商品应用价（nhsoft.retail.ai.branchitem.realprice.find 全量快照；探针 2026-10-08）。一行 = 账套×快照日×门店×商品(×分级)。last_edit_time 固定传滚动 2 年窗起点（10310217 上限）= 全量当前价。span 分区键 (system_book, snapshot) 与 sink key 逐段一致。",
  "columns": [ /* 见 Step 2 明细 */ ]
}
```

列明细（expr 与 Task 2 shape SQL 逐字同源；类型即湖上定型——「落盘即定型」）：
`batch_id varchar not null`；`system_book varchar not null`；`snapshot date not null`；`branch_num int not null`；`branch_code varchar not null`（expr `o.branch_code`，源自 `branch.branch_code`）；`branch_name varchar`；`branch_matrix_price_actived boolean`；`item_num bigint not null`；`item_grade_num bigint`（null = 主商品行）；`item_code varchar not null`（expr `o.item_code`，源自 `pos_variant.item_code`）；`bar_code varchar`；`item_name varchar`；`spec_num varchar`；`spec_unit varchar`；`spec_rate decimal(18,8)`；`item_unit varchar`；`item_category varchar`；`item_department varchar`；`last_edit_time varchar`；`regular_price decimal(18,8)`；`level2_price decimal(18,8)`；`level3_price decimal(18,8)`；`level4_price decimal(18,8)`；`max_price decimal(18,8)`；`min_price decimal(18,8)`；`regular_real_price decimal(18,8)`；`level2_real_price decimal(18,8)`；`level3_real_price decimal(18,8)`；`level4_real_price decimal(18,8)`；`max_real_price decimal(18,8)`；`min_real_price decimal(18,8)`（后 12 列全部 nullable——源侧 0=未单独设置、`*_real_price` 有 null 实测）。
- [ ] **Step 3: 门禁**：`pnpm exec tsx scripts/check-data-contract.mjs` 过（契约 schema 校验）；提交 `docs(data): #481 B 段定案——价格批契约 + §1.7 登记`。

### Task 2: L0 管线（生成器 + 双账套 JSON 提交进仓）

**Files:**
- Create: `scripts/lemeng/gen-item-price-pipeline.mjs`（生成器；写管线 JSON 到 `deploy/duckle/console/pipelines/`）
- Create: `deploy/duckle/console/pipelines/lemeng.dim.item_price.l0.json`（64188，15 店/批 ≈ 9 节点）
- Create: `deploy/duckle/console/pipelines/lemeng.dim.item_price.l0.3120.json`（3120，15 店/批 ≈ 19 节点）
- Modify: `deploy/duckle/console/pipelines/FLOW.lemeng.md`（新管线行 + 「门店增减需重跑生成器」的维护注记）

**Interfaces:**
- Consumes: Task 1 契约列集（shape SQL 与 schema 申报）；`connectionRef: lemeng`（凭据）/ `zos`（sink）。
- Produces: 引擎可 validate/run 的两条管线；节点形状与 `lemeng.dim.item.l0` 同构。

- [ ] **Step 1: 生成器**。输入：SYSTEM_BOOK + 门店号数组（作者当时从 whoami 取）。结构照抄 `lemeng.dim.item.l0`：
  - `w0` 身份门（MCP whoami，SSE，`rawResponseDestination`，retry 3×2000ms）+ `g0/g1/g2/d0/g3/d1` 断言（company/book 断言 die）——**逐字照抄 dim.item 对应节点**，只改 batch_id 前缀；
  - 批量扇出 `p1..pN`（**15 店/批**：`branch_nums` 分块；单批载荷估算 ≤100MB，低于 REST 门实测 336MB；新店 = 重跑生成器）：

```js
// 每批一个 src.rest 节点（节选；完整生成器见本任务产出）
{
  connectionRef: 'lemeng',
  url: 'https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.branchitem.realprice.find',
  method: 'POST',
  body: JSON.stringify({ branch_nums: chunk, last_edit_time: TWO_YEARS_AGO }),
  paginationType: 'none',
  responsePath: '/result',
  retryAttempts: 3, retryBackoffMs: 2000,
}
```

  - `merge (ctl.merge)` → `shape (code.sql)`：列 expr 与契约逐字同源（`o.value.branch_code` 等——REST 门直回 JSON，`responsePath /result` 后每行即 VO，无 MCP SSE 解包层）；`batch_id`/`system_book`/`snapshot=CAST('${date+8h}' AS DATE)` 与 dim.item 同款；
  - `gate (qa.contract)`：`not_null` 于 `batch_id/system_book/snapshot/branch_num/item_num/item_code`；
  - `sink (snk.minio)`：`key: lemeng/item_price/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date+8h}/all.parquet`，`mode: overwrite`，zstd，`connectionRef: zos`，**bucket 必填**（#镜 snk.minio bucket 缺失 = 新鲜度锚静默死的教训）。
- [ ] **Step 2: validate**：duckle MCP `validate_pipeline` 各跑两条（file 路径）；报错修到过。
- [ ] **Step 3: 提交**：`feat(data): #481 价格批 L0 管线（双账套，生成器产出）`。

### Task 3: dbt staging 模型

**Files:**
- Create: `dbt/models/common/staging/stg_lemeng_item_price.sql`
- Create: `dbt/tests/assert_stg_lemeng_item_price_key_unique.sql`
- Modify: `dbt/dbt_project.yml`（var `lemeng_item_price_prefix: lemeng/dim_item_price`，与契约 `layout.prefix` 同源）

**Interfaces:**
- Produces: `staging.stg_lemeng_item_price`（Task 4 发布读它）。

- [ ] **Step 1: 模型**。逐字镜像 `stg_lemeng_branch.sql` 的三条已证形态：分区键显式 cast；取列 `from read_parquet(...) r` 函数别名形态（CTE 在 pg_duckdb 报错）；前缀走 var 不写死。双账套一把读（`system_book` 是列）：路径 `{{ var("lemeng_item_price_prefix") }}/*/snapshot=**/all.parquet`。列 = 契约列集 + `subject_org()` 注入 `org`。
- [ ] **Step 2: dbt test**：`(system_book, snapshot, branch_num, item_num, item_grade_num)` 键唯一断言（镜像 assert_stg_lemeng_branch_key_unique）。
- [ ] **Step 3: 本地 dbt build 过**（rt/warehouse 本地栈），提交 `feat(data): #481 价格批 staging 模型`。

### Task 4: 发布表迁移 + publish-dims 扩展

**Files:**
- Create: `modules/data/migrations/010_dim_item_price.sql`（编号以仓内现状顺延）
- Modify: `scripts/lemeng/publish-dims.mjs`（第三段：dim_item_price）
- Modify: `scripts/lemeng/publish-dims.test.mjs`（若有既有测试文件；无则本任务补最小断言）

**Interfaces:**
- Consumes: `staging.stg_lemeng_item_price`（warehouse 侧）。
- Produces: `data.dim_item_price (org, store_code, item_code, grade_item_num, price_minor, price_raw, source_book, snapshot)`——ticket 建单的价格源。

- [ ] **Step 1: 迁移**（幂等；**外部编码一律 TEXT**）：

```sql
create table if not exists data.dim_item_price (
  org            text not null,
  store_code     text not null,
  item_code      text not null,
  grade_item_num bigint,
  price_minor    bigint not null default 0,
  price_raw      decimal(18,8),
  source_book    text not null default '',
  snapshot       date,
  created_at     timestamptz not null default now()
);
create unique index if not exists data_dim_item_price_key_idx
  on data.dim_item_price (org, store_code, item_code, coalesce(grade_item_num, 0));
```

- [ ] **Step 2: publish-dims 第三段**。staging 读 `stg_lemeng_item_price`（snapshot 独立取 max，别并 scope——dim_branch/item 首跑踩过）；行筛选：`regular_real_price is not null and > 0`（0/空 = 源侧未单独设置，无诚实价可发；过滤行数打日志）；换算 `price_minor = round(regular_real_price * 100 / nullif(spec_rate, 0))`（**spec_rate 口径验证见 Task 7 Step 2，若证伪在此改**）；跨账套去重 `distinct on (org, store_code, item_code, coalesce(grade_item_num,0))`，排序 `grade is null 行优先 → source_book 字典序`（3120 优先，与 dim_branch/item 同规）；写入走 dim_item 同款分批（65 万行级逐行 insert 太慢）。
- [ ] **Step 3: 门禁 + 提交**：`check-data-models` / `check-env-example` / data 模块 typecheck 过；提交 `feat(data): #481 dim_item_price 发布表 + 发布 job 扩展`。

### Task 5: ticket 建单接价格源【🔴 已拆出 → issue #500（拍板 2026-10-08）】

> 执行时实查发现：价格 join 必须先切 ticket 自然键（SubmitBody 数字合约 → string、ticket 表加 code 列、mobile 提交链、api-types、读侧投影，约 10+ 文件）——即 005 预告的「随价格项一起」批次。拍板拆两段 PR：本 PR 只交数据面（→ #499），工单侧 = #500。以下原步骤保留作 #500 的底稿。

**Files:**
- Modify: `modules/aftersales/routes/ticket-guest.ts`（访客建单）
- Modify: `modules/aftersales/routes/ticket-manage.ts`（管理建单，同款）
- Modify: 两者测试（夹具从 `aftersales.product` 换 `data.dim_item` + `data.dim_item_price`，走 ensureDimTables 模式）

**Interfaces:**
- Consumes: `data.dim_item`（#480 已有）、`data.dim_item_price`（Task 4）。
- Produces: 建单快照 `basic_unit_price_minor` 有源；新错误码 `PRICE_NOT_FOUND`（400）。

- [ ] **Step 1: 查找改写**（两处建单路径同改）：
  ① product：`select item_code, name from data.dim_item where org = $1 and item_code = $2 and sale_cease = false`（body.productId 语义 = dim_item.item_code——#480 清单端点已发这个键）⇒ 缺 = `PRODUCT_NOT_FOUND`（沿用）；
  ② price：`select price_minor from data.dim_item_price where org = $1 and store_code = $2 and item_code = $3 and grade_item_num is null`（body.storeId 语义 = dim_branch.code；**缺 = `PRICE_NOT_FOUND` 400**——金额依据缺源不建单，镜像 PRODUCT_NOT_FOUND 的 fail-closed，不 fallback、不取 0）；store 名照旧走 dim_branch（若该路径还在查旧 store 表则一并切）。
- [ ] **Step 2: 测试**：happy（dim 行在 ⇒ 快照落 price_minor）；`PRICE_NOT_FOUND`（价行缺/0 过滤后无行）；`PRODUCT_NOT_FOUND` 沿用；跨租户 store_code ⇒ STORE_NOT_FOUND（#480 的门店归属校验先例）。
- [ ] **Step 3: 全套**：`cd modules/aftersales && pnpm test` + data 套件 + typecheck；提交 `feat(aftersales): #481 建单金额快照切 dim 自然键 + 价格 join`。

### Task 6: 调度 + 告警 + 探活（G 段，双账套 console）

**Files:**
- Modify: `deploy/duckle/console/schedules/64188.json`、`schedules/3120.json`（新管线日批条目，与各自 dim 条目错峰 15 分钟）
- Modify: `deploy/duckle/console/alerts.lemeng.json`（新前缀新鲜度锚）

- [ ] **Step 1: 调度条目**（cron 对齐各 console 现行 dim 槽位，错峰；⚠️ 判漂移看条目集合与 enabled，不看文件哈希——引擎会回写 run 状态）。
- [ ] **Step 2: 新鲜度锚**：锚在 `lemeng/item_price` 前缀；**验锚必须跑 catalog lint 确认「匹配到」**（snk.minio bucket 名对得上才命名得到）。
- [ ] **Step 3: 投递两步**（卷内定义类）：`seed-console.sh` seed 双 console 卷 + openship **服务级 restart**（不是全量部署）；重启后 `schedules.json` 条目集合核对。
- [ ] **Step 4: 提交** `feat(data): #481 价格批调度 + 新鲜度锚（双账套）`。

### Task 7: 首跑 + F 四层验收 + 两个未验环节当场验

- [ ] **Step 1: 首跑**（console 触发，双账套）：记录 3120 全量行数/体积（探针未测项）；自证 = 写后回读湖行数 vs 网关当刻全量行数（容差按正典 §1.4 口径记录）。
- [ ] **Step 2: ★ 未验环节①——spec_rate 换算口径**（当场最小验证，不许跳）：湖里取 `spec_rate <> 1` 真实行样本，对 1–2 个商品用 `item_nums` 定点反查网关 + 与 POS 实际售价比对（若有真机价可对照）；结论写进探针报告并回填正典。**证伪 ⇒ 改 Task 4 的换算 expr 再重发**。若真机无法判定「基本单位」语义 ⇒ 停下问人（口径不猜）。
- [ ] **Step 3: ★ 未验环节②——drift 远端形态**：对本源管线开 `qa.drift` 跑一次，制造/等待一次真实字段级漂移验证结论会变（正典 §1.3 C 行的最小验证动作；若当轮无真实漂移，按正典口径登记「已接线、待首次真实漂移回填」）。
- [ ] **Step 4: 幂等**：同 snapshot 重跑 ⇒ 湖对象覆盖写（key 同 ⇒ 幂等强判）；发布 job 重跑 ⇒ dim 行数不变。
- [ ] **Step 5: 独立通道**：全量湖 vs 逐店 `item_nums` 定点抽查（≥3 店 × ≥3 商品）逐分对平。
- [ ] **Step 6: 跨系统**：按正典「待回填」口径登记。
- [ ] **Step 7: §5 验收记录行**入正典。

### Task 8: 端到端 + 收尾三登记

- [ ] **Step 1: 端到端**（本地 dev-stack 先行）：建单 → 快照含 price_minor → 退款计算出数；真机（shanhai）在 Task 6/7 部署后用测试租户走一遍（**不在生产租户上造单**）。
- [ ] **Step 2: H 段结论**：首跑即全量（last_edit_time=2 年窗起点），无额外回填；正典 §1.3 H 行记「本源回填 = 首跑全量，滚动 2 年」。
- [ ] **Step 3: 收尾三登记**：§1.7（Task 1 已落，复核）、§2 数据源清单行、§5 验收行；新坑进 §1.6 案例库（只增不改）。
- [ ] **Step 4: WeKnora 沉淀**（先查重：探针报告的接口事实若已有条目则更新原条目）：`乐檬价格批接口实测（realprice.find）`——门大小边界、10310217 滚动 2 年、双账套可用性、spec_rate 口径结论。
- [ ] **Step 5: PR**（`Closes #481`）→ CI CLEAN → squash 合并 → mytech 自动部署 + 山海例行推送（等 main 更版 → webhook → 验产物与迁移）。

## Self-Review

- 覆盖：issue 三条验收——①发布契约含价格（Task 1/4，走「工单侧等价来源」= dim_item_price，粒度依据在探针报告 §0）；②建单恢复有源 + 退款端到端（Task 5/8）；③为自然键化+退役清障（建单已读 dim 自然键，旧表零新写入）。✔
- 占位符：Task 1 列集/Task 2 节点结构/Task 4 SQL 均给了实文；「编号以仓内现状顺延」是事实引用非占位。✔
- 类型一致性：`store_code`（Task 4/5）、`item_code`、`grade_item_num` 跨任务同名；`price_minor bigint` 与 ticket `basic_unit_price_minor bigint` 对齐。✔

---

## 修订 R1（2026-10-08，拍板：写模型改增量——首跑实测三堵墙后的架构裁决）

> 首跑实测（探针报告 §5）：引擎 src.rest 响应体上限 **12.3MB 过 / 32.9MB 炸、不可配**；**单店即可越限**
> （64188 branch 13 = 20,213 行 / 32.9MB）⇒ 全量快照直采不可行。拍板改**增量化**（方案①）：

- **湖布局**：`lemeng/item_price/system_book=<book>/bizday=<采集日>/branch=<branch_num>/all.parquet`
  （每店每日一文件；覆盖写 = 天然幂等；大店小店互不拖累；单店重采不碰别店）。
- **行语义**：行 = **价格变更事件**（`last_edit_time` 是事件时间）；staging 按
  `(system_book, branch_num, item_num, item_grade_num)` 取 `last_edit_time` 最新物化「现价」
  （全史合并，年 ~15 万行量级，pg_duckdb 无压力）。**发布表 `data.dim_item_price` 与 ticket 侧不变**。
- **日常管线**（原 Task 2 形状改）：逐店扇出保留；src.rest 加 `incrementalField=last_edit_time` +
  body `{incremental}` + `incrementalInitial`（首跑水位）——响应 KB 级，上限墙消失。
- **首载（backfill）**：单独一条 backfill 管线（生成器产）：正常店逐店直采（2 年窗，<12MB）+
  **大店（实测 >12MB 者）item_nums 段节点**（段清单由生成器当场从 item dim 取，一次性产物）；
  写 `bizday=<首载日>` 分区。水位首跑值设为「首载日」⇒ 日常增量从首载日续起，无缝衔接。
- **契约**（schemaVersion 2）：分区键 `[system_book, bizday, branch]`；列 `snapshot` 改名 `bizday`；
  行粒度 = `(system_book, bizday, branch_num, item_num, item_grade_num, last_edit_time)`。
- **staging**（原 Task 3 改）：读 `*/bizday=**/branch=**/all.parquet`，drop 分区列 branch，
  全史合并取最新现价（`qualify row_number() over (partition by key order by last_edit_time desc) = 1`）。
- **调度**：日批不变（15 11 错峰）；`/api/watermarks` 指针式回填不在本任务（首载走 backfill 管线）。

---

## 修订 R2（2026-10-08，业务拍板：售后=总部↔门店 B2B，金额依据改配送单行价）

> 业务澄清（用户）：售后是**总部给门店配送、门店对货物异议**的 B2B 流程；64188（品品甜）是 3120（主账号）的
> **外部批发客户**。实测三连：① WO（批发单）收货方全是品品甜门店（64188=批发客户实锤）；
> ② 同单双侧对照（MO3120992607050085）：无极副本与乐檬 API **逐分对平**（27=172.8÷6.4）；
> ③ **配送单实际价 27 ≠ 档案批发价 25**（差 8%）⇒ 结算按单，不按档案价。零售价管线（R1）与工单用途
> 无关 ⇒ 挂起（成本 KB/天，去留后议）。**采集范围改为 3120 单账套的调出单**（64188 的 MO 是其内部业务，
> 不在售后范围；无极副本只有 3120 也与此吻合）。

- **新源**：`nhsoft.ama.ai.transfer.out.order.find`（配送-调出单查询；行粒度 = 单 × 商品行）。
  接口约束：查询窗 ≤3 个自然月；`page_size` ≤100、`page_number` ≤10000；无 total ⇒ 空页耗尽；
  `start_date=end_date=${date-1d+8h}`（昨日制单窗，日期算术引擎原生 `date-1d` 有源码测试覆盖）。
- **湖**：`lemeng/transfer_out/system_book=3120/bizday=<制单日>/all.parquet`（行 = 配送单商品行；
  每分区写一次不重写，晚审边缘 ~秒级自愈）。**单账套**（3120 console），品品甜不采。
- **管线**（L0）：身份门 + gv/dv + **静态页扇出 p1..p8 + p9 哨兵**（>800 单/日即大声红——实测 472 单/3 天，
  15 倍余量）+ merge + flatten（`UNNEST(from_json(o.items))` 行展开，销售明细子管线同款）+ gate + sink。
- **staging**：`stg_lemeng_transfer_out`（1:1 行透传，glob `*/bizday=**/all.parquet`）。
- **发布**：迁移 012 `data.dim_transfer_out`（order_no 行粒度，含 `price_minor = round(out_money/quantity×100)`）
  → 工单 #500 按 order_no 关联取价。
- **批发（WO）外部前置**：`wholesaleorder` 门对 PAT 静默空（缺「批发销售单-查询」权限 + 门店绑定；
  64188 视角 WHS 整体未开 = 上游已给 3120 开了应用、只差用户级权限）。已给精确开通清单，授权后补采。
- **调度**：3120 console 日批（与既有槽位错峰）。
