# 乐檬指标「组合族」14 项 L1 补齐 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把客户 65 项里被判据放行、源已齐、但**悬空在「消费面」**的 14 项（跨口径算术 / 排序比率类）落成 L1——新建两张 mart 承担跨域连接与预聚合，声明约 8 条 L1 口径（多组客户项共用同一条口径），补对账，走四步链上线。

**Architecture:** 不改架构。全部落在既有机制内：`dbt/models/common/marts/*`（构件）→ `dbt/semantics/l1_metrics.yml`（声明）→ `scripts/sync-data-semantics.mjs`（物化）→ `data.metrics`（词表）→ openclaw 问数。**无新层、无新机制。**

**Tech Stack:** 同 W1/W2/W3（dbt + pg_duckdb + duckle + openship 四步链）。

**Issue:** #744（本计划的 PR 用 `Closes #744`）。

## Global Constraints（2026-10-16 真机核实，实施不得回退）

### 判据：L1 `select_sql` 的形状

真机 `data.metrics` 抽样（山海生产）实测形态：

```
select sum(fct_hq_outbound.r_net) as value, system_book, bizday, domain, branch_num, region_id from fct_hq_outbound
select sum(g_gross) / nullif(sum(r_net), 0) as value, ... from fct_hq_outbound
```

⇒ **`from` 只能是一个关系**（join / 子查询都不行；`GROUP BY <grain>` 由外层拼）。**任何跨域组合必须先落成一张 mart。** 这就是当年这 14 项被推给消费面的真实原因——不是判据不许，是比写一条声明多一步。

### 声明面

- **可加指标**写 `expression`；**率类**写 `ratio: {numerator, denominator}`（sync 自动包成 `num / nullif(den, 0)`，零分母 → 不适用）。**两者互斥**，同写即报错。
- 门禁规则 ⑤ 必填：`name` / `grain` / `owner` / `tier` / `definition` / `source` / `freshness_sla_days` + (`expression` 或 `ratio`)。
- `totalable` 由 sync **从物化后表达式推导**：含除法 ⇒ `false`（ratio 类天然不可加）。
- **新 mart 必须注入主体列**：`{{ subject_org() }} as org`（门禁规则 ⑩）。
- 指标名 `<源>:<业务域>:<指标>` 三段小写蛇形（规则 ⑥）；新业务域 `contribution` 可用（门禁只判形态，域枚举是文档约定）。

### 对账面

每条 L1 一个 `dbt/tests/audit_<源>__<域>__<指标>.sql`：**parquet 直读独立复算**（不 ref staging——走 staging 会让 cast 错同时污染两边 ⇒ 对账恒绿），`full join` + `is distinct from` 比对物化侧，**并带空转自检**（物化侧零行 = 空转绿，判失败）。

### 交付面

- `dbt/` 一动 ⇒ 必跑 `data-plane-lock.mjs` 重生成 lock（#683 双红实测：连纯文档都计哈希）。
- merge 后走**四步链**：数据面机 sync → materialize → 主项目部署 → 词表 job；然后企微真机问一次。
- 提交纪律：conventional commits；`feat` 带 `Closes #744`；可见变更走 PR。

## 范围：14 项客户指标 → **约 8 条 L1 口径**

⚠️ **重要：14 项 ≠ 14 条口径。** 客户附录里多组指标**公式逐字相同**，是同一口径的不同角色视角：

| 客户项 | 客户公式（逐字） | 归并 |
|---|---|---|
| `01-03` 费用后贡献与贡献率 · `08-05` 费用后贡献率 · `02-04` 战区费用后贡献 | `N＝R－C－E；贡献率＝N/R×100%` | **同一式**，差异只在 grain（战区 vs 总仓） |
| `02-07` 门店补损率 · `07-05` 售后补损率 | `补损率＝Q/同对象同期间R；补损侵蚀率＝Q/G（仅G>0）` | **逐字相同** |
| `05-05` 水果采购退货率 · `06-06` 采购退货率 | `金额退货率＝Σ采购退货金额/Σ采购收货金额` | **同一式**，差异只在部门筛选 |
| `01-07` 供应商集中度 · `05-06` 水果供应商集中度 · `06-04` 供应商集中度 | `CR5＝前5净采购额/全部净采购额，CR10同理` | **同一式**，差异只在部门筛选 |
| `03-04` 门店补损与补贴率 | 各项净发生额/同门店配送出库净额×100% | 独立（含补贴项，非仅补损） |
| `05-08` 零金额采购行 | `COUNT(购入数量>0且购入金额=0)；赠品数量单列` | 独立（计数） |

⇒ 待落 L1 口径（草案名，实施时定稿）：

1. `lemeng:contribution:net_amount`（N，可加）
2. `lemeng:contribution:margin_rate`（N/R，ratio）
3. `lemeng:contribution:region_share`（Nw/ΣNw，ratio，**窗口形态**——见 Task 0）
4. `lemeng:expense:loss_rate`（Q/R，ratio；02-07 与 07-05 共用）
5. `lemeng:expense:subsidy_rate`（补贴项/R，ratio；03-04）
6. `lemeng:purchase:return_rate`（退货额/收货额，ratio；05-05 与 06-06 共用）
7. `lemeng:purchase:cr5`（前5/全部，ratio；01-07/05-06/06-04 共用）
8. `lemeng:purchase:zero_amount_rows`（计数；05-08）

**非目标**：`03-07` 库存覆盖天数（`fct_retail_sale` 缺净销量构件 + 「日均」跨期窗口）——单独挂起，不混进本批。不动 L2/租户面，不立消费面，不改任何采集源。

---

## Task 0: 开工前四项核对（不核完不动手）

前四项都是**会改变设计**的未知，逐项探明再进波次。

- [ ] **① 费用项目取值清单**：真机看 `fct_branch_expense.expense_type` 的**实际取值分布**——「补损类」与「补贴类」（直播补贴/小程序/线下补贴）各有哪些字面值。**没有这份清单，4/5 两条率类的分子筛不出来。** 探法：数据面机 exec 进仓查该列 distinct + 计数。
- [ ] **② 批发出库有无 `client_fid`**：`fct_hq_outbound` 现行列**没有 `client_fid`** ⇒ **客户级**费用后贡献做不了。核实 `stg_lemeng_wholesale_out` / `stg_lemeng_wholesale_return` 里有没有客户号列：
  - 有 ⇒ W2 顺带给 `fct_hq_outbound` 补列（并评估对既有 grain/断言/对账的连带影响）；
  - 无 ⇒ **本批只做门店级/战区级/总仓级**，客户级单独立项（写进 issue 评论）。
- [ ] **③ 采购部门维度**：`fct_purchase` 现行列**无部门**（水果/标品靠部门筛）。核实 `stg_lemeng_item` / dim 侧有无部门列可 join ⇒ 决定 6/7 两条是「一条带部门维度」还是「各声明一条」。
- [ ] **④ `region_share` 的窗口形态**：占比分母是「同完整范围 Nw 之和」。核实 `select sum(sum(x)) over () as value, … from rel group by …` 这一形态能否通过现有编译/执行链（`parseL1Select` 的形状契约、外层 `GROUP BY <grain>` 拼法、`authz.literal`）。
  - 能 ⇒ 按 ratio 声明（分母写窗口形式）；
  - 不能 ⇒ `01-04` 的「占比」部分**降级为不做**（Nw 本身仍可出），并在 issue 里记明原因。
- [ ] **⑤ `05-08` 列语义**：确认 `fct_purchase.purchase_item_amount` 是**数量**（6 位小数）而非金额，`purchase_item_money` 是金额（2 位）。
- [ ] 五项结论追加到本文件末尾「核对补记」节。

## Task 1: W1 —— A 组 3 项（零新构件）

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml`（+2 条：`purchase:return_rate` / `purchase:zero_amount_rows`）
- Create: `dbt/tests/audit_lemeng__purchase__return_rate.sql` / `audit_lemeng__purchase__zero_amount_rows.sql`

- [ ] **Step 1:** 两条声明。`return_rate` 用 `ratio: {numerator: 'sum(fct_purchase.purchase_item_return_money)', denominator: 'sum(fct_purchase.money_total)'}`；`zero_amount_rows` 用 `sum(case when purchase_item_amount > 0 and purchase_item_money = 0 then 1 else 0 end)`（形状以 Task 0 ⑤ 为准）。grain 均 `[system_book, bizday]`（部门维度待 Task 0 ③ 定）。
- [ ] **Step 2:** 两条对账（骨架照 `audit_lemeng__outbound__net_amount.sql`：parquet 直读 D11 前缀 → 独立复算 → full join 比对物化侧 + 空转自检）。
- [ ] **Step 3:** `check-data-models` + `check-data-contract` + `pnpm test` 全绿；`sync-data-semantics --check` 无漂移（本地库）。
- [ ] **Step 4:** 提交 `feat(data): 乐檬采购退货率与零金额采购行 L1 两条 + 对账`。

## Task 2: W2 —— `fct_contribution` 构件 + B1 组 6 条 L1

**Files:**
- Create: `dbt/models/common/marts/fct_contribution.sql`（+ `schema.yml` 条目 + grain 断言 `assert_fct_contribution_grain_unique.sql`）
- Modify: `dbt/semantics/l1_metrics.yml`（+3~4 条：`contribution:net_amount` / `contribution:margin_rate` / `expense:loss_rate` / `expense:subsidy_rate`；`contribution:region_share` 视 Task 0 ④）
- Create: 各对账

**构件设计（草案，实施时以 Task 0 结果定稿）：**

- **粒度** `(system_book, bizday, branch_num, region_id)` —— 出库侧 `fct_hq_outbound` 折叠掉 `domain`（客户 01-01「先分别汇总配送和批发后合并」），费用侧 `fct_branch_expense` 按 (账套,业务日,门店) 汇总。
- **列**：`r_net` / `c_cost` / `g_gross`（出库构件）/ `e_net`（门店费用净额）/ `q_loss`（补损类净额，取值待 Task 0 ①）/ `q_subsidy`（补贴类净额）/ `n_net = r_net − c_cost − e_net`。
- **join 键**：`(system_book, bizday, branch_num)` —— 两侧语义已核对（出库 branch_num = 收货门店；费用 branch_num = 归属门店，客户文档 01-03 明确「按对象ID和期间连接」）。
- ⚠️ **总仓级/战区级 vs 门店级的 E 口径差异**：总仓级可把**客户费用**一并加总；门店级加不进（客户费用按 client 归集）。**这一差异必须写进 `definition`**，否则上卷会算错。

- [ ] **Step 1:** 构件 + 断言；真机 `dbt run` 通过（PASS 计数 = TOTAL + 新增）。
- [ ] **Step 2:** L1 声明（`net_amount` 可加；其余 ratio）。
- [ ] **Step 3:** 各对账（parquet 直读 D01/D02/D03/D04 + dim_branch 最新快照，同构复算）。
- [ ] **Step 4:** `data-plane-lock.mjs` 重生成 + 门禁全链 + 提交 `feat(data): 出库×费用组合构件 fct_contribution + 费用后贡献/补损率 L1`。

## Task 3: W3 —— `fct_purchase_concentration` 构件 + B2 组 2 条 L1

**Files:**
- Create: `dbt/models/common/marts/fct_purchase_concentration.sql`（+ schema 条目 + grain 断言）
- Modify: `dbt/semantics/l1_metrics.yml`（+`purchase:cr5`）
- Create: 对账

**为什么必须预聚合：** CR5 = 前 5 净采购额 / 全部净采购额，含**排序取前 5**——是子查询语义，塞不进 `select <聚合> as value from <单关系>`。故 mart 内先按 (账套, 报告期, 部门) 算好 `total_p` / `top5_p` / `top10_p`，L1 再取 `sum(top5_p)/sum(total_p)`。

- ⚠️ **报告期粒度**：CR5 是**期间**指标（客户原文「月｜A」），不是业务日 ⇒ mart 粒度含**月份**。这是本批唯一一条非日粒度的构件，`definition` 必须写清「月」语义，避免与日粒度指标混用。
- [ ] **Step 1:** 构件 + 断言（含「报告期 × 部门」唯一性）。
- [ ] **Step 2:** L1 `cr5`（ratio，分子分母取 `top5_p` / `total_p`）。
- [ ] **Step 3:** 对账 + lock 重生成 + 门禁全链。
- [ ] **Step 4:** 提交 `feat(data): 采购集中度月度预聚合构件 + CR5 L1`。

## Task 4: 真机四步链 + 收尾

- [ ] issue #744 关联的 PR → push → CI 全绿 → merge（**只等 CI CLEAN**）。
- [ ] 四步链：数据面机 sync → materialize（PASS = TOTAL + 新增）→ 主项目部署 → 词表 job。
- [ ] 词表核对：`data.metrics` 平台桶 l1 档新增条数 = 声明条数（预期 27 → 约 35）。
- [ ] **企微真机问一次**（每族挑一条，如「本月费用后贡献率」「采购退货率」）——出数 + 固定新鲜度行。
- [ ] 台账验收行 + issue 收尾评论（含 Task 0 的裁决结论）。

## Self-Review 备忘

- **计划算例先验算**：本文件所有「项数」与「条数」是**归并后**的推导（14 项 → 约 8 条），实施时以 `l1_metrics.yml` 实际条数为准，**报告里写实际值**。
- **逐字期望值**：Task 0 的五项结论要写进本文件，**不要只留在会话里**——否则后文（声明形状、grain）与结论会自相矛盾。
- **门禁面**：`check-data-models` 规则 ① 只认 staging 的 `r['列']` 取列模式——新 mart 读 `ref(...)` 不受它管，但**新对账脚本**若直读 parquet 必须用该形态。
- **本计划的可行性判断未经运行**：全部依据客户附录公式 + 设计稿波次矩阵 + 真机 `select_sql` 抽样 + mart schema 阅读；实施逐条以真机为准。
