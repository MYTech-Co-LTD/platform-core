# 乐檬指标 W2（费用两件套）· 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec W2：接 D04 门店费用 / D05 客户费用（探针已硬验证真数据）、建费用构件（fct_branch_expense / fct_client_expense）、声明费用绝对值 L1 指标、X08 seed 结构——解锁 W2 费用面的 L1 层。

**Architecture:** 同 W1 形态（collect-source A→I + 构件 fct + L1 单 FROM 契约）。**费用率类（费用率/补损率/补贴强度）全部 L2**——分子在费用构件、分母在出库构件，跨模型比率违反单 FROM 契约（spec §5.2 的 L1 前提不成立）；率类随消费面 spec 落地。

**Tech Stack:** 同 W1。

## Global Constraints

- **A 阶段真样本已锁**（2026-10-12 探针）：D04 真单 `expense_type=产品售后补损`、`direction=应付`（中文名）、`amount=6.36`、`due_amount=-6.36`（红字）、`settlement_state=5/已核销`、`operate_branch_num=99`（操作结算方≠归属店——客户文档 08-02 边界实证）；D05 真单 `other_inout_flag=false/应付` + `other_inout_flag_name`（翻译字段直接可用）、`other_inout_kind=抖音直播补贴/kind_code=043`、`other_inout_due_money=-10.0`、`state.state_code=3` JSON 形态。
- D04 采集窗 `date_from/date_to` 完整 `yyyy-MM-dd HH:mm:ss` + ama 族 `page_number/page_size` 分页；D05 whs 族 `date_type=审核时间` + `offset/limit` 分页、区间 ≤7 天硬限。**两侧均按审核时间过滤**（费用域审核即入账，客户文档「审核发生」口径）。
- D05 `other_inout_flag`：**true=应收 / false=应付**（真样本 flag=false 配 flag_name=应付 实证）。
- 归属维度：D04 归属店 = `branch_num`（`operate_branch_num` 是结算方，**不作归属**）；D05 归属客户 = `client_fid`（前导零保字符串）。D05 另有 `branch_num`（业务机构）——落契约列但构件聚合按 client。
- 构件粒度：`fct_branch_expense` (system_book, bizday, branch_num, expense_type)、`fct_client_expense` (system_book, bizday, client_fid, other_inout_kind)。构件列 `ep_payable/er_receivable/e_net`（e = 应付 − 应收；金额保留红字不取绝对值）。
- X08 seed = header-only（同 X01 模式，数据待客户批）。
- 每日窗口 `${date-1d}` 单日；每分区写一次；首跑日别手动重跑（案例 20）。
- 真机四步链 + 裁决流程全部同 W1（sync → materialize → 主项目部署 → 词表；skip-issue 标签直接打，勿再走 Closes 循环）。

---

### Task 1: D04/D05 契约

**Files:**
- Create: `contracts/common/lemeng.branch_expense.json`
- Create: `contracts/common/lemeng.client_expense.json`

**Interfaces:**
- Produces: 湖表 `lemeng/branch_expense`（行=费用单，分区 [system_book, bizday=审核日]）与 `lemeng/client_expense`（同形）。

- [ ] **Step 1: D04 契约**（列集=真样本键名逐字）：`batch_id`/`system_book`/`bizday`（审核日 `date_from` 窗口日）/`bill_no`/`branch_num`/`branch_name`/`branch_code`/`operate_branch_num`/`operate_branch_name`/`expense_type`/`direction`/`amount`(14,2)/`due_amount`(14,2)/`paid_amount`(14,2)/`payment_date`/`tax_rate`/`tax_amount`/`audit_time`/`create_time`/`reference_bill`/`memo`/`settlement_state`/`settlement_state_name`/`last_edit_time`。description 必写：审核时间窗、direction 中文枚举（应付/应收）、due_amount 红字语义、operate≠归属。
- [ ] **Step 2: D05 契约**：`batch_id`/`system_book`/`bizday`/`other_inout_bill_no`/`branch_num`/`branch_name`/`client_fid`/`client_code`/`client_name`/`other_inout_flag`(bool)/`other_inout_flag_name`/`other_inout_kind`/`other_inout_kind_code`/`other_inout_date`/`other_inout_money`(14,2)/`other_inout_due_money`(14,2)/`other_inout_ref_bill`/`other_inout_audit_time`/`state_code`(int，从 state JSON 抽)/`other_inout_memo`。description 必写：flag 语义（true 应收/false 应付，真样本实证）、审核时间窗、kind_code 费用项目码。
- [ ] **Step 3:** `pnpm exec tsx scripts/check-data-contract.mjs`（staging 未建时会报配对——Task 3 补齐后必须回绿）→ 先提交 `feat(data): 乐檬门店/客户费用采集契约（D04/D05）`。

### Task 2: D04/D05 管线

**Files:**
- Create: `deploy/duckle/console/pipelines/lemeng.branch.expense.l0.3120.json`（从 `lemeng.wholesale.out.l0.3120.json` 派生：URL→branch.expense.find、body→`{"date_from":"${date-1d} 00:00:00","date_to":"${date-1d} 23:59:59","state_code":3,"page_number":N,"page_size":100}`、schema 申报=契约 o.* 字段（type 按 decimal/string/int64）、shape=契约 14→24 列投影、sink key=`lemeng/branch_expense/...`、哨兵文案）
- Create: `deploy/duckle/console/pipelines/lemeng.client.expense.l0.3120.json`（同派生：URL→otherinout.find、body 用 offset/limit、responsePath=`/result/content`——**注意 D05 返回是 `{count, content}` 结构**、responsePath 需照 wholesale 形态实测调整）
- Modify: `deploy/duckle/console/pipelines/FLOW.lemeng.md`（两行）

- [ ] **Step 1:** 程序化派生两管线（python 复制-替换，模式同 W1）；**schema type 枚举校验**（只许 string/int32/int64/float32/float64/bool/date/timestamp/time/decimal/json/binary/geometry——金额一律 decimal，禁 object）。
- [ ] **Step 2:** `pnpm exec tsx scripts/check-console-schedules.mjs && pnpm exec tsx scripts/check-data-contract.mjs` → 提交 `feat(data): 乐檬门店/客户费用 l0 采集管线（3120）`。

### Task 3: staging + 台账

**Files:**
- Create: `dbt/models/common/staging/stg_lemeng_branch_expense.sql` / `stg_lemeng_client_expense.sql`（骨架照 `stg_lemeng_wholesale_out.sql`；**空湖首跑会响亮失败**——先手动触发两管线各一次让分区落文件，再跑 materialize，同 D03 教训）
- Create: `dbt/tests/assert_stg_lemeng_branch_expense_key_unique.sql`（bill_no 唯一）/ `assert_stg_lemeng_client_expense_key_unique.sql`（other_inout_bill_no 唯一）
- Modify: `dbt/dbt_project.yml`（两 prefix var）、`sources.yml`（两条目）、`staging/schema.yml`（两模型块）、`docs/data-platform-handbook.md`（§1.7/§2 各两行）

- [ ] **Step 1:** 手写 staging（真样本列序）→ gen 校验。
- [ ] **Step 2:** 真机：sync → seed → 重启 console → **手动触发两管线各一次**（分区落文件）→ 门禁全链 → 提交 `feat(data): 乐檬费用 staging + 台账（D04/D05 落地）`。

### Task 4: 费用构件两表 + L1 声明 + 对账

**Files:**
- Create: `dbt/models/common/marts/fct_branch_expense.sql`（粒度 (system_book, bizday, branch_num, expense_type)；`ep_payable`=Σ amount where direction='应付'、`er_receivable`=Σ where direction='应收'、`e_net`=ep−er；::numeric(20,2)；line 级 bill 去重 count(distinct bill_no)）
- Create: `dbt/models/common/marts/fct_client_expense.sql`（粒度 (system_book, bizday, client_fid, other_inout_kind)；同构）
- Create: 2 个 grain 断言
- Modify: `dbt/semantics/l1_metrics.yml`（6 条——**裁9 已回签（2026-10-13）：净费用 = 应付 − 应收**，故已转 certified）
- Create: 6 个对账（骨架照 outbound 系；recheck 直接打两份费用湖表 parquet）

**L1 清单**：`lemeng:expense:branch_payable` / `branch_receivable` / `branch_net` / `client_payable` / `client_receivable` / `client_net`。grain 前三者 [system_book, bizday, branch_num, expense_type]、后三者 [system_book, bizday, client_fid, other_inout_kind]。**费用率类全部 L2**（跨模型比率，消费面 spec 承接——客户 W2 的 16 项里率类在消费面出）。

- [ ] **Step 1:** 构件两表 + 断言；**Step 2:** L1 6 条 + 对账 6 条（空转 null 数=主 select 列数−1，**机检校验脚本再跑一遍**）；**Step 3:** lock + 门禁全链 + `feat(data): 费用构件两表 + 费用 L1 六条与对账`。

### Task 5: X08 seed + 真机验收

**Files:**
- Create: `dbt/seeds/x08_thresholds.csv`（header：`threshold_key,domain,branch_num,item_num,value,effective_from,effective_to,source_note`）+ `dbt/seeds/schema.yml` 追加块 + README 构件表 X08 行

- [ ] **Step 1:** X08 seed 结构（header-only，数据待裁5 客户批）。
- [ ] **Step 2:** issue（`feat(data): 乐檬指标 W2 费用两件套`）→ push → PR（skip-issue）→ CI 全绿 → merge。
- [ ] **Step 3:** 真机四步链：sync → materialize（PASS=TOTAL+新增）→ 主项目部署 → 词表「新增 6」→ 抽查（branch_expense 与接口定点单据比对：挑 memo='到店佳沛少一个' 的真实单核对 amount/due_amount/direction）。
- [x] **Step 4:** 台账验收行 + issue 收尾评论（**裁9 提案** e_net=应付−应收 的符号语义；**2026-10-13 客户回签：保持 应付 − 应收**）。

## Self-Review 备忘

- W2 的 16 项里率类（费用率/补损率/补贴强度）全部 L2——L1 只承载费用绝对值 6 条（跨模型比率不进 L1，spec §5.1/§5.2 判据）。
- D05 的 `other_inout_kind_code`（043）是费用项目**编码**——比 kind 中文名更适合做稳定聚合键，构件粒度用 kind_name 与客户文档对齐、聚合稳定性由 kind_code 校验（对账 sample）。
- 首跑顺序红线：**先手动跑管线落分区，再跑 materialize**（D03 空湖教训）。
