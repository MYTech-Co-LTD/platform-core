# 乐檬 W3 余项 D11 采购分析接源 · 实施计划

**Goal:** 接 D11（`nhsoft.report.ai.itempurchase.find`），建 `fct_purchase` 构件，声明采购族 L1——
解锁 W3 采购面 7 项（01-07 供应商集中度 / 05-01..05-06）。

**Architecture:** 同 W1/W2/W3 形态（duckle L0 采集 → 契约 → staging → mart → L1 词表）。
**差异点**：D11 是 **summary 型**（非单据级），**无翻页、单次全量**，但**响应带 `total_count`**
⇒ 截断守卫由「哨兵页」改为「`len(rows) == total_count` 断言」（比哨兵页更强：直接对账）。

## A 阶段结论（2026-10-13 真机实证，见 #640）

| 项 | 结论 |
|---|---|
| 接口 | `POST nhsoft.report.ai.itempurchase.find`（report 族，可用） |
| 参数 | `audit_date_start`/`audit_date_end`（**≤31 天硬限**，32 天报 `code:10002`）；`branch_nums=[99]`（**固定**——3120 门店配送制不采购，采购全在管理中心）；`summary_types=[supplier,item]` |
| 无翻页 | page_number/offset/limit 均不支持；单次全量返回 |
| 响应形状 | `{code,msg,result:{total_count,rows[]}}` ⇒ responsePath `/result/rows` |
| 数据滞后 | **无**（10-12 单日 59 行；10-11 60；10-10 65） |
| 列 | 17：supplier_num/supplier_code/supplier_name/item_num/item_code/item_barcode/item_name/item_spec/base_unit/purchase_item_amount/purchase_item_money/purchase_present_amount/purchase_present_money/purchase_item_return_amount/purchase_item_return_money/amount_total/money_total |
| 粒度 | (bizday 取请求参数, supplier_num, item_num)——**响应无 branch_num / audit_date 列** |
| 体量 | 单日 ~60 行 / 31 天 886 行 ⇒ 无响应体风险 |

## B 选型定案

duckle 原生 `src.rest` 单发（`paginationType: none`）+ `qa.contract` 契约闸 +
**总行数断言**（`len(rows)==total_count`，不等则 `ctl.die` 大声红）。无例外，走标准形态。

## Tasks

### Task 1: 契约
- Create `contracts/common/lemeng.item_purchase.json`（17 列，列集=探针真样本逐字；
  layout.prefix `lemeng/item_purchase`，partitionBy `["system_book","bizday"]`；
  bizday expr `CAST('${date-1d}' AS DATE)`；description 载 A 阶段边界：branch_nums=[99]、≤31 天硬限、total_count 守卫）

### Task 2: 管线
- Create `deploy/duckle/console/pipelines/lemeng.purchase.analysis.l0.3120.json`
  （单 `src.rest` → `code.sql` 展开 rows → `gate`（qa.contract）→ **`assert_total`（rows 数 == total_count，不等 die）** → `sink`）
- 排班：`schedules/3120.json` 加 `lemeng.purchase.analysis.l0.3120`（UTC，错峰）

### Task 3: staging + mart + L1
- Create `dbt/models/common/staging/stg_lemeng_item_purchase.sql`（读湖，17 列 + org）
- Create `dbt/models/common/marts/fct_purchase.sql`（summary 直落，粒度同上；**构件=原样列别名**）
- Modify `dbt/semantics/l1_metrics.yml`：采购族 6 条（全 experimental）——
  `lemeng:purchase:net_amount`（净采购额）/ `purchase_amount` / `present_amount`（赠品）/
  `return_amount`（退货）/ `supplier_count` / `item_count`

### Task 4: 物化链 + 真机验收
- materialize job select + 三模型；sync → materialize → 词表
- 独立通道对账：接口直取 vs 湖上分区逐行平（单日窗）

## 验收
- 管线 run：rows == total_count（守卫在位）
- 独立通道：单日窗接口行数 == staging 行数
- 词表：采购族 6 条入 `data.metrics`
