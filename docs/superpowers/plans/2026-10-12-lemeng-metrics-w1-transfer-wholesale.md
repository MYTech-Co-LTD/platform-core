# 乐檬指标 W1（transfer/wholesale 骨架）· 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec《2026-10-12-lemeng-metrics-sources-semantics-design.md》W1（2026-10-12 修订版）：接 D03 wholesale_return、建 transfer/wholesale 出库构件（fct_hq_outbound / fct_transfer_item）、首批 ratio 率类声明、X01 seed 结构——解锁 R/C 骨架 11 项中的 L1 面。

**Architecture:** 口径唯一事实源 `dbt/semantics/l1_metrics.yml`（ratio 已支持，W0 落）；口径只在 marts 定义一次；跨模型聚合（D01+D02−D03）落 marts 长表 `fct_hq_outbound`（单表才能进 L1 的单 FROM 约束）；对账走独立复算 singular test；D03 走 collect-source A→I，登记正典 §1.7/§2。

**Tech Stack:** duckle 管线（console l0 形态）+ dbt 1.9（真机跑）+ pg_duckdb + vitest + openship MCP。

## Global Constraints

- spec 三条 2026-10-12 裁决（已落 spec §3/§4 修订）：**D15 挪 W3**（本计划不碰）；**历史不回填**（指标从 10-08 增量起算，回填跟随 10-10「全管线补采」裁决）；**X01 = git 受控 CSV（dbt seed）**。
- D03 探针已验（2026-10-12 round-1 空集 code:0）；采集窗口形态**以 D02 同族实测为准**：`date_type` 传字面值「制单时间」（#513：短词被静默忽略返回全史）、日期完整 `yyyy-MM-dd HH:mm:ss`（whs 族 2026-10-12 实测）、报告期靠 `*_audit_time` 后过滤。
- 客户公共定义 R 的 D01 侧构件**暂用行级 `out_money`**（总部结算口径；`total_money` 是单头随行冗余、行级相加会重复计）——**此为裁8，随 PR 给用户/客户确认**，确认前相关指标 experimental。
- 首载日 ≠ 首个日常 run 日（案例 20）：D03 首跑写昨日分区后，**当天别手动再触发**（同 bizday 同 key 覆盖写）。
- audit 四铁律照 W0 已合入实体：复算侧直接打 parquet、只比已闭窗日、`::numeric(20,2)`、空转自检——骨架从 `dbt/tests/audit_lemeng__retail__net_sales.sql` **逐字复制后改聚合面**。
- 检出台同步：merge 后 `sh /opt/lemeng-sync.sh <main全SHA>` → materialize → （l1 变了）主项目部署 → 词表 job（四步链，见 memory shanhai-data-plane-delivery-chain）。
- 本机验证面 = `pnpm exec tsx scripts/check-data-models.mjs` + `pnpm typecheck:scripts` + `pnpm test:guard` + `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（改 dbt 工件后必跑）。
- 提交纪律：issue 先行；`type(scope): subject`；波末全量门禁。

## W1 指标归属定稿（11 项逐项过 §5.1 判据）

| 客户编号 | L1 处置 | 说明 |
|---|---|---|
| 01-01 / 02-01 出库净额（总仓/战区） | `lemeng:outbound:net_amount`，grain [system_book, bizday, domain, branch_num, region_id] | 一条指标双视角：domain 分 transfer/wholesale（不混加），branch+region 下钻（region=X01 种子回落 dim_branch） |
| 01-02 / 08-01 毛利与勾稽 | `lemeng:outbound:gross_profit` + `lemeng:outbound:gross_margin_rate`（**首条 ratio**） | 08-01 的 D10 系统对照列 W3（D10 未接），对照注记在 definition |
| 02-02 战区毛利率 | 同上（grain 已含 region_id，不另声明） | |
| 04-01 单数与行数 | `lemeng:transfer:order_count` + `lemeng:transfer:line_count` | audit_time 截日的「代理指标」边界写 definition |
| 04-02 峰值负荷倍数 | **L2**（max/avg 期间窗口，非声明粒度可复算） | 消费面 spec 承接 |
| 04-05 批号填写率 | `lemeng:transfer:batch_fill_rate`（ratio；**全量版**——X08 需批号清单未批，考核版待 X08） | |
| 04-06 零成本暴露 | `lemeng:transfer:zero_cost_exposure_amount`（金额面；行数面 L2） | |
| 04-07 负金额调整 | `lemeng:transfer:negative_order_count` | |
| 06-03 商品出库毛利率 | `lemeng:transfer:item_gross_margin_rate`（ratio，fct_transfer_item 粒度） | 批发明细成本先与单头勾稽（差额单列）——fct 内处理 |

---

### Task 1: D03 wholesale_return 契约（collect-source B）

**Files:**
- Create: `contracts/common/lemeng.wholesale_return.json`

**Interfaces:**
- Consumes: `contracts/common/_schema.schema.json`（元 schema v2）、`contracts/common/lemeng.wholesale_out.json`（同族形态参照）。
- Produces: 湖表 `lemeng/wholesale_return`，分区 [system_book, bizday]（制单日），行=退货单商品行。

- [ ] **Step 1: 写契约**（列集照客户文档 D03 已核字段 + D02 同族工程列；`expr` 形态逐字照 `lemeng.wholesale_out.json` 的同位列）

列清单：`batch_id`（模板同 wholesale_out）、`system_book`（ENV 注入）、`bizday`（`${date-1d}` 制单日）、`wholesale_return_fid`、`order_no`（=关联批发单号 `wholesale_order_fid`，**列名取 order_no 保持与 wholesale_out 可 join**；若接口返回键名确为 wholesale_order_fid 则 expr 里 CAST 它、description 注明）、`branch_num`、`client_fid`、`wholesale_return_audit_time`、`wholesale_return_total_money`（单头随行冗余）、`wholesale_return_cost_money`（单头随行冗余）、明细行：`item_num`、`order_detail_num`、`return_detail_money`、`return_detail_cost_money`。首行 `description` 必写：接口名、窗口形态（制单日 `${date-1d}`、#513 字面值坑）、单头冗余警示（**行级 sum 会重复计，聚合前 per_order 取 max**）、仅 3120。

- [ ] **Step 2: 契约门禁**

Run: `pnpm exec tsx scripts/check-data-contract.mjs && pnpm exec tsx scripts/check-duckle-catalog.mjs`
Expected: PASS（契约 schema/目录命名合规）。

- [ ] **Step 3: 提交**

```bash
git add contracts/common/lemeng.wholesale_return.json
git commit -m "feat(data): 乐檬批发退货（D03）采集契约"
```

### Task 2: D03 管线 + 调度（collect-source C/D/E）

**Files:**
- Create: `deploy/duckle/console/pipelines/lemeng.wholesale.return.l0.3120.json`
- Modify: `deploy/duckle/console/pipelines/FLOW.lemeng.md`（一行：新管线在流里的位置）
- Modify: `deploy/duckle/console/schedules/`（错峰登记，见下）

**Interfaces:**
- Consumes: `lemeng.wholesale.out.l0.3120.json`（同族管线——**逐字复制后只改差异点**）。
- Produces: 湖前缀 `lemeng/wholesale_return/system_book=3120/bizday=<昨日>/all.parquet`；console 调度条目（UTC `55 15`，与 wholesale 的 `45 15`、transfer 的 `35 15` 错峰，同日批序列尾部）。

- [ ] **Step 1: 复制 wholesale.out.l0.3120.json 并改差异点**

差异清单（逐项核对）：① 接口名 → `nhsoft.whs.ai.wholesalereturn.find`；② with_details/翻页参数与 wholesale.find 同形（offset/limit 翻页）；③ 日期参数字面值「制单时间」+ `${date-1d}` 单日窗（照 wholesale_out 的 bizday 表达式形态）；④ sink 前缀 → `lemeng/wholesale_return`；⑤ 投影 SQL 与契约 30 列对齐（用 Task 1 的列）；⑥ 哨兵守卫（末页容量）参数照 D02 同族值。改完跑管线静态校验：`pnpm exec tsx scripts/check-console-schedules.mjs`。

- [ ] **Step 2: seed 进 console + 真机首跑（collect-source E/F）**

1. `sh /opt/lemeng-seed-console.sh <main全SHA>`（检出台已 sync 的前提下）——或按 `deploy/duckle/console/README.md` 的 seed 程序。
2. 重建 `lemeng-console-3120` 容器（openship `post_deployments` + `serviceIds: [lemeng-console-3120]`——**别单传 refreshServiceIds**，SOP §E 表第三类）。
3. console `POST /api/run` 触发该管线一次（零影响面首跑），读 run 日志：翻页耗尽、行数、末哨兵无红。
4. **对数**（独立通道验收）：duckdb/pg_duckdb 读湖分区行数 vs 管线日志行数一致；抽 1 单接口重放比对金额列。

- [ ] **Step 3: 提交**

```bash
git add deploy/duckle/console/pipelines/lemeng.wholesale.return.l0.3120.json deploy/duckle/console/pipelines/FLOW.lemeng.md deploy/duckle/console/schedules/
git commit -m "feat(data): 乐檬批发退货 l0 采集管线（3120，昨日制单日窗）"
```

### Task 3: D03 staging + 台账（collect-source F/I）

**Files:**
- Create: `dbt/models/common/staging/stg_lemeng_wholesale_return.sql`
- Modify: `dbt/models/common/staging/schema.yml`（模型描述 + not_null tests）
- Modify: `dbt/models/common/staging/sources.yml`（新表条目）
- Modify: `docs/data-platform-handbook.md`（§1.7 台账行 + §2 清单行）

**Interfaces:**
- Produces: `stg_lemeng_wholesale_return`（25→按契约列数全投影 + org 注入 + 封版断言 `_SCHEMA/v1.parquet`）。

- [ ] **Step 1: 生成投影**——改契约后跑 `pnpm exec tsx scripts/gen-data-projection.mjs` 生成选列区；文件骨架（config 块/头注形态/org 注入/封版断言）照 `stg_lemeng_wholesale_out.sql` 同款手写，注意头注写清「单头列随行冗余、聚合前 per_order 取 max」。
- [ ] **Step 2: 键唯一断言** `dbt/tests/assert_stg_lemeng_wholesale_return_key_unique.sql`（照同族：自然键 = system_book+bizday+wholesale_return_fid+order_detail_num+item_num）。
- [ ] **Step 3: 真机跑一轮 staging**（merge 后统一在 Task 7 验，本步只过本机门禁）：

```bash
pnpm exec tsx scripts/gen-data-projection.mjs --check && pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm exec tsx scripts/check-data-models.mjs && pnpm typecheck:scripts && pnpm test:guard
git add -A && git commit -m "feat(data): 乐檬批发退货 staging + 台账登记（D03 落地）"
```

### Task 4: fct_hq_outbound（总仓出库构件长表）+ 结构断言

**Files:**
- Create: `dbt/models/common/marts/fct_hq_outbound.sql`
- Modify: `dbt/models/common/marts/schema.yml`（模型 + 列描述）
- Create: `dbt/tests/assert_fct_hq_outbound_grain_unique.sql`

**Interfaces:**
- Consumes: `stg_lemeng_transfer_out`（行级 out_money/subtotal=成本小计/state_code/out_branch_num）、`stg_lemeng_wholesale_out`（单头 total_money/cost_money 随行冗余 → per_order max）、`stg_lemeng_wholesale_return`（同 D02 形态）、`stg_lemeng_branch`（region_id 回落）。
- Produces: 粒度 `(system_book, bizday, domain, branch_num, region_id)`；列 `r_net/c_cost/g_gross ::numeric(20,2)`、`order_count/line_count bigint`、`org`。L1 的 `lemeng:outbound:*` 三条都指向它。

- [ ] **Step 1: 写模型**（口径在模型内定死；核心形状如下，头注按 fct_retail_sale 同款写全）

```sql
{{ config(materialized='table') }}
-- 基面（口径）：transfer = state_code=3 且 out_branch_num=99（总仓发货；店间直调 branch_num=out_branch_num 的行排除：
--   where branch_num <> out_branch_num）；wholesale = 全部审核单。退货只在 wholesale 侧扣（D03）。
-- R 构件 = transfer: Σ行 out_money；wholesale: Σ per_order max(total_money) − Σ per_order_return max(total_money)。
-- C 构件 = transfer: Σ subtotal；wholesale: Σ per_order max(cost_money) − Σ per_order_return max(cost_money)。
-- 除法/精度形态与 fct_retail_sale 同款（::numeric(20,2)）。
with transfer_lines as (
    select system_book, bizday, branch_num, order_no,
           sum(out_money)  as r_money,
           sum(subtotal)   as c_money,
           count(*)        as line_count
    from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3
      and out_branch_num = 99
      and branch_num <> out_branch_num
    group by 1, 2, 3, 4
),
transfer_dom as (
    select system_book, bizday, branch_num,
           sum(r_money)::numeric(20,2)   as r_net,
           sum(c_money)::numeric(20,2)   as c_cost,
           count(distinct order_no)      as order_count,
           sum(line_count)               as line_count
    from transfer_lines group by 1, 2, 3
),
wholesale_orders as (
    -- per_order 取单头（随行冗余列用 max 去冗余）
    select system_book, bizday, branch_num, order_no,
           max(total_money) as total_money, max(cost_money) as cost_money
    from {{ ref('stg_lemeng_wholesale_out') }}
    group by 1, 2, 3, 4
),
return_orders as (
    select system_book, bizday, branch_num, order_no,
           max(total_money) as total_money, max(cost_money) as cost_money
    from {{ ref('stg_lemeng_wholesale_return') }}
    group by 1, 2, 3, 4
),
wholesale_dom as (
    select w.system_book, w.bizday, w.branch_num,
           (sum(w.total_money) - coalesce(sum(r.total_money), 0))::numeric(20,2) as r_net,
           (sum(w.cost_money)  - coalesce(sum(r.cost_money), 0))::numeric(20,2) as c_cost,
           count(distinct w.order_no) as order_count,
           0::bigint                  as line_count
    from wholesale_orders w
    left join return_orders r using (system_book, bizday, branch_num, order_no)
    group by 1, 2, 3
)
select
    u.system_book,
    {{ subject_org() }} as org,
    u.bizday,
    u.domain,
    u.branch_num,
    coalesce(b.region_id, 0) as region_id,   -- X01 未填前回落 dim_branch 当前档案（种子语义，见头注）
    u.r_net,
    u.c_cost,
    (u.r_net - u.c_cost)::numeric(20,2) as g_gross,
    u.order_count,
    u.line_count
from (
    select system_book, bizday, branch_num, 'transfer' as domain, r_net, c_cost, order_count, line_count from transfer_dom
    union all
    select system_book, bizday, branch_num, 'wholesale' as domain, r_net, c_cost, order_count, line_count from wholesale_dom
) u
left join {{ ref('stg_lemeng_branch') }} b using (system_book, branch_num)
```

（写实体时把三段头注要点展开成文件头注；`coalesce(b.region_id, 0)` 的 0 = 「未映射」哨兵，与客户文档「未映射单列」一致。）

- [ ] **Step 2: 粒度断言**（五键 unique，照 `assert_fct_retail_sale_grain_unique.sql` 同款）。
- [ ] **Step 3: 门禁 + lock**：

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm exec tsx scripts/check-data-models.mjs && pnpm typecheck:scripts && pnpm test:guard
git add -A && git commit -m "feat(data): 总仓出库构件 fct_hq_outbound（transfer/wholesale 双域长表 + 战区回落）"
```

### Task 5: fct_transfer_item（商品粒度，服务 06-03）

**Files:**
- Create: `dbt/models/common/marts/fct_transfer_item.sql`（粒度 `(system_book, bizday, item_num)`；r/c/g 同构件口径、只 transfer 域；per_order 不需要——行级 out_money/subtotal 直聚）
- Create: `dbt/tests/assert_fct_transfer_item_grain_unique.sql`
- Modify: `dbt/models/common/marts/schema.yml`

- [ ] **Step 1:** 模型（transfer_lines 同 Task 4 基面，按 item_num 聚合）+ 粒度断言。
- [ ] **Step 2:** lock + 门禁 + 提交 `feat(data): 商品出库构件 fct_transfer_item`。

### Task 6: L1 声明 8 条（含 3 条 ratio 首用）+ 对账 8 条

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（声明先行，一次 PR 内实现跟上）
- Create: `dbt/tests/audit_lemeng__outbound__*.sql` ×3、`dbt/tests/audit_lemeng__transfer__*.sql` ×5

**Interfaces:**
- 命名/映射：`metricToAuditFileName`（既有函数）；文件名如 `audit_lemeng__outbound__net_sales.sql`。
- ratio 形态（W0 机制首用）：

```yaml
  - name: 'lemeng:outbound:gross_margin_rate'
    label: 总仓出库毛利率
    definition: >-
      总仓出库毛利率（不可加；上滚=重算/另声明，粒度 = 账套×业务日×域×门店×战区）。
      G＝R−C；R 的 D01 侧用行级 out_money（总部结算口径，裁8 待客户确认），
      wholesale 侧 = 单头 total_money − 退货单头 total_money（per_order 去冗余）。
      D10 系统对照（08-01/01-02 的勾稽差）W3 接 D10 后补。experimental：裁8/裁1 未回。
    ratio:
      numerator: 'sum(fct_hq_outbound.g_gross)'
      denominator: 'sum(fct_hq_outbound.r_net)'
    grain: [system_book, bizday, domain, branch_num, region_id]
    owner: data-platform
    tier: experimental
    source: lemeng
```

其余 7 条（net_amount / gross_profit / transfer:order_count / transfer:line_count / transfer:batch_fill_rate[ratio，分子 `sum(case when lot_number is not null and lot_number <> '' then 1 else 0 end)` 型表达式写进 numerator、分母 `count(...)`] / transfer:zero_cost_exposure_amount / transfer:negative_order_count / transfer:item_gross_margin_rate[ratio @ fct_transfer_item]）的 definition 逐条照客户文档「数据条件」条款改写（04-01 写「审核日工作量是代理指标」；04-06 写「零成本不等于全部利润可实现」；04-07 写「不按绝对值变正收入，也不一律称退货」）。

- [ ] **Step 1: 写 8 条声明**（definition 逐字、grain、owner/tier/source 齐全；3 条 ratio 走 ratio 字段）。
- [ ] **Step 2: 写 8 条对账**（骨架逐字复制 `audit_lemeng__retail__net_sales.sql`，只换：读路径（transfer/wholesale/wholesale_return 三份 parquet 按模型基面）、recheck 聚合面（与 fct 逐字同构，**含逐单除的 rate 分子分母两侧同构**）、materialized 侧粒度与列、空转自检条件）。8 条的 recheck 核心：
  - net_amount/gross_profit：三段 parquet → transfer_lines/wholesale_dom 同构 → sum
  - gross_margin_rate：recheck 出 r/g 两列、materialized 出 r_net/g_gross，比较 `g/r`（分母 0 行跳过并在 note 计数）
  - batch_fill_rate：`sum(case when lot …)/nullif(count(*),0)` 两测同构
  - zero_cost_exposure：`sum(case when out_money <> 0 and coalesce(subtotal,0) = 0 then out_money else 0 end)`
  - negative_order_count：per_order max(total_money) < 0 计数（wholesale 侧；transfer 侧单头负值同型）
  - item_gross_margin_rate：fct_transfer_item 同构 @ 商品粒度
- [ ] **Step 3:** 门禁（规则 ⑤⑥⑦ 会机检 ratio 形状/同名唯一/audit 存在）+ lock + 提交：

```bash
pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/lemeng/data-plane-lock.mjs && pnpm typecheck:scripts && pnpm test:guard
git add -A && git commit -m "feat(data): transfer/wholesale 出域 8 条 L1 声明与对账（ratio 首用）"
```

### Task 7: X01 seed 结构（git 受控 CSV）

**Files:**
- Create: `dbt/seeds/x01_branch_region.csv`（header：`system_book,branch_num,region_id,effective_from,effective_to,source_note`——**仅 header，数据等客户**）
- Create: `dbt/seeds/x01_branch_calendar.csv`（header：`system_book,branch_num,bizday,is_open`——同上）
- Modify: `dbt/models/common/staging/schema.yml` 或 `dbt/seeds/` 下新增 seed 属性块（column tests：not_null 关键列）
- Modify: `dbt/dbt_project.yml`（seeds 配置：column types 显式钉 date/varchar）
- Modify: `dbt/README.md`（§5.1 构件表 X01 行补「落点 = seeds 两 CSV；fct 回落语义」）

**Interfaces:**
- Produces: seed 关系 `x01_branch_region` / `x01_branch_calendar`；fct 的回落语义（Task 4 已实现 coalesce）与它解耦——X01 有数后由**后续任务**把 fct 的回落 join 换成生效期匹配（不在 W1，因为无数据可验——YAGNI，登记 §11 待议）。

- [ ] **Step 1:** 建 CSV + seed 属性 + dbt_project.yml column_types；README 补注。
- [ ] **Step 2:** lock + 门禁 + 提交 `feat(data): X01 组织生效期/营业日历 seed 结构（数据待客户）`。

### Task 8: issue + PR + CI

- [ ] `gh issue create`（标题 `feat(data): 乐檬指标 W1 transfer/wholesale 骨架`，正文引 spec W1 修订 + 本计划；含**裁8**：R 的 D01 侧用行级 out_money 的口径说明）
- [ ] push 分支 `ylwzzs/lemeng-metrics-w1`、`gh pr create`（Closes #N）
- [ ] `gh pr checks --watch` → 全 CLEAN → `gh pr merge --squash`

### Task 9: 真机验收（四步链）

- [ ] ① `sh /opt/lemeng-sync.sh <main全SHA>`（SYNC_OK n/n）
- [ ] ② materialize job → PASS=TOTAL（新增模型/测试数对上）；D03 管线当日**别手动重跑**（首载日规则）
- [ ] ③ 主项目部署（词表吃新声明）→ 词表 job「新增 8」→ data.metrics 复查 group_by/ratio 形态
- [ ] ④ 抽查：fct_hq_outbound 按 domain 分别 sum 与 console recon/preagg 或接口侧定点对拍（wholesale 侧 r 与 wholesale_out 发布维表对得上；transfer 侧 r 与工单样例单金额一致）
- [ ] ⑤ 正典登记核验：§1.7 两行（D03 行、fct 构件行）+ §2 清单行 + §5 验收记录行
- [ ] ⑥ issue 收尾评论（证据 + 裁8 待回签提醒）

## Self-Review 备忘

- 11 项中 04-02（峰值倍数）走 L2、08-01 复用 outbound 三条——声明数 8 条有据（§5.1 判据逐项过，见头表）。
- fct_hq_outbound 的 transfer 基面排除店间直调（branch_num <> out_branch_num）与客户文档 01-01「不得混入店间调拨」一致。
- 已知开放点：裁8（out_money vs total_money）——experimental 兜底，PR 向用户/客户提出；X01 生效期匹配逻辑等数据（W1 只建结构 + 回落）。
