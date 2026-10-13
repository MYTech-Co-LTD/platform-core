# 乐檬指标 W3（采购/库存/要货调入族）· 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec W3（修订版）：接 D15 要货单 / D16 调入单 / D17 库存快照 / D11 采购分析 / D10 指标校验五源，建采购与库存构件，声明采购/库存族 L1 指标——解锁 W3 面的 20 项。

**Architecture:** 同 W1/W2 形态。**D11 是 summary 型接口**（非单据级）：按 `summary_types`（branch/item/supplier，最多 2 个）+ `branch_nums`（≤100 家/批）聚合查询——采集形态为「分批遍历」，与 D01-D05 的单据翻页**不同构**。**D10 是对照源**（branchindicator，仅作系统指标对照不覆盖单据口径）。

**Tech Stack:** 同 W1/W2。

## Global Constraints（A 阶段 2026-10-13 探针实证）

- **D11 分页三连不支持**：`page_number`/`offset`/`limit` 全部报 `不支持`——接口**单次返回全量**（无翻页）；`summary_types` 必传（supplier/branch/item，至少一个）；`branch_nums` 必传（≤100 家/批，长清单需分批）。**7 天窗（10-06..10-12）+ 前 100 家分支查询返回空集**——空集原因待扩窗排查（采购可能只发生在部分门店/总仓，或 audit_date 语义需再核）。
- **D17 库存快照回溯有限**：bizday=10-12 有数据、10-11 返回空集——**快照天数窗口待摸**（接源时先探可回溯天数）；行粒度 = 仓库×商品（`storehouse_num`+`item_num`），含 `inventory_quantity/assist/use_quantity`。
- **D15/D16 真样本键已锁**（2026-10-13 探针）：D15 单头 `order_no(YH…)/order_type/branch_num/out_branch_num/transfer_state(部分发货)/purchase_date` + `items[]`（item_num/code/name/spec/unit/quantity/use_quantity/use_unit/subtotal/use_rate/present_quantity/present_use_quantity…）；D16 单头 `order_no(MI…)/branch_num/out_branch_num/storehouse_num/related_order_no(MO… 关联调出单)` + `items[]`（同族）。**无 200 行截断实测**（要货单单量小）。
- **D15/D16 采集窗**：ama 族 `start_date/end_date`（制单日）+ `state_codes=[3]` + `page_number/page_size` 分页——**制单窗 D-7 补跨期**（同 D01 族）。
- 真机四步链 + skip-issue 标签 + merge 后 `git diff --check` 全部沿用 W1/W2 教训。
- 裁9（净费用符号）已回签 ✅；裁1/裁8 已 certified；裁4/裁5 数据待客户（seed 已就位）。

## 采集形态分野（W3 五源三种形态）

| 源 | 形态 | 分页 | 窗口 |
|---|---|---|---|
| D15 要货 / D16 调入 | 单据级（ama 族） | page_number/page_size | 制单日 D-1（D-7 补跨期） |
| D17 库存快照 | 快照级（ama 族） | page_number/page_size | bizday 单日（**可回溯天数待探**） |
| D11 采购分析 | **summary 聚合** | **无翻页**（单次全量） | audit_date 区间 ≤7 天？+ branch_nums ≤100/批 |
| D10 指标校验 | 对照（月频） | date_type=month | 月粒度 |

---

### Task 1: A 阶段遗留探针（D11 空集排查 + D17 回溯天数）

- [ ] 扩 audit_date 窗（9 月 / 8 月）+ 有采购的门店（从 transfer_out 收货店反推）重查 D11——确认空集是「无采购」还是「参数组合错」
- [ ] D17 逐日回探（10-12/11/10/09/08…）找最早可回溯 bizday——确定快照窗口深度
- [ ] 结果写进计划附录（本文件末尾追加「探针补记」节），空集/短窗结论直接进契约 description

### Task 2: D15/D16/D17 三契约

**Files:**
- Create: `contracts/common/lemeng.request_order.json` / `lemeng.transfer_in.json` / `lemeng.inventory_snapshot.json`

- [ ] **Step 1:** 三契约（列集=探针真样本键名逐字；D15/D16 行=单头+items[] 展开成行、自然键含 item_num+lot?/序号；D17 行=仓库×商品、粒度键 (bizday, branch_num, storehouse_num, item_num)）。description 必写各源 A 阶段边界（D11 空集/D17 短窗在 Task 1 后补）。
- [ ] **Step 2:** `check-data-contract` 回绿（管线 Task 3 后）→ 提交 `feat(data): 乐檬要货/调入/库存快照采集契约（D15/D16/D17）`。

### Task 3: 三管线（同构派生）

**Files:**
- Create: `deploy/duckle/console/pipelines/lemeng.request.order.l0.3120.json`（D01 族派生，哨兵文案改）/ `lemeng.transfer.in.l0.3120.json`（同）/ `lemeng.inventory.snapshot.l0.3120.json`（D17：**bizday=T-1 单日** + 哨兵页 >N 行大声红，N 待首跑定）
- Modify: `deploy/duckle/console/pipelines/FLOW.lemeng.md`（三行）

- [ ] **Step 1:** python 派生三管线（schema type 枚举校验 + gate rules + sink key 对齐契约 prefix + `pipelines/` 前缀的 file 参数——console API 实测形态）。
- [ ] **Step 2:** check-console-schedules → 提交 `feat(data): 乐檬要货/调入/库存快照 l0 采集管线（3120）`。

### Task 4: 三 staging + 台账

- [ ] **Step 1:** 三 staging + 三键断言 + sources.yml 三条目 + dbt_project 三 vars + 台账三行（§1.7/§2）。
- [ ] **Step 2:** 真机：sync → seed → 重启 console → **手动触发三管线各一次**（分区落文件，D17 先跑 Task 1 确认的可回溯日）→ materialize → 提交 `feat(data): 乐檬要货/调入/库存 staging + 台账`。

### Task 5: 采购/库存构件 + L1 + 对账

**Files:**
- Create: `dbt/models/common/marts/fct_purchase.sql`（D11 summary 直落：粒度 = (system_book, audit_date, branch_num, item_num)；列 = purchase_item_amount/money/present_*/return_* 原样透传——summary 表无"口径再加工"，**构件=原样列别名**）
- Create: `dbt/models/common/marts/fct_inventory_snapshot.sql`（粒度 (system_book, bizday, branch_num, storehouse_num, item_num)；inventory_quantity/inventory_money 原样）
- Create: D15/D16 staging 到 fct 的**要货满足率构件**（D15 要货 vs D16 调入 的店×商品×日 对照——04-03/03-06 的 L1 面；涉及 X06 承诺时间缺失 ⇒ 只出「截止日满足率」边界写 definition）
- Create: 各 grain 断言
- Modify: `dbt/semantics/l1_metrics.yml`（**采购族 6 条 + 库存族 2-3 条**，全 experimental）：
  - `lemeng:purchase:net_amount`（Σ money_total，可加）
  - `lemeng:purchase:return_amount` / `return_rate`(ratio)
  - `lemeng:purchase:supplier_count`（count distinct supplier，上滚=另声明的边界写 definition）
  - `lemeng:purchase:zero_amount_rows`（05-08 零金额采购行）
  - `lemeng:inventory:quantity` / `inventory:coverage_days`(ratio 或派生)
- Create: 各对账（D11/D17 单源 parquet 直读，同构模式）

- [ ] **Step 1-3:** 构件 → L1 → 对账 → 门禁全链 → 提交。
- [ ] **Step 4:** X08/费用率类不动（L2 待消费面 spec）。

### Task 6: 真机四步链 + 收尾

- [ ] issue `feat(data): 乐檬指标 W3 采购/库存/要货调入族` → push → PR（skip-issue）→ CI → merge
- [ ] 真机：sync → materialize → 主项目部署 → 词表「新增 N」→ 抽查
- [ ] issue 收尾 + 台账验收行

## 探针补记（Task 1 执行后追加）

（待 Task 1 填写：D11 空集根因、D17 可回溯深度）
