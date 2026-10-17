# 零售净销售额改「冲退货」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `lemeng:retail:net_sales` 从「不冲退货」改成「销售侧 − 退货侧」，并把 `fct_retail_sale`
拆成 `sale_amount` / `return_amount` / `net_amount` 三列，消除「一个指标名扛两个语义」这个事故根因。

**Architecture:** 口径只在 `dbt/models/common/marts/fct_retail_sale.sql` 定义一次；L1 声明
（`dbt/semantics/l1_metrics.yml`）指向它的列，词表 / Metabase / 问数从声明派生、零改动。
独立通道对账（`scripts/lemeng/recon-preagg.sh` + console 管线）的锚从 `sale_money` 换成
`sale_money − return_money`。退货侧缺口（issue #814）不改采集，只登记过渡容差。

**Tech Stack:** dbt 1.9.1（pg_duckdb 执行）、Postgres `warehouse` 库、duckle console 管线、
POSIX sh（`/bin/sh` = bash 3.2）、pnpm + tsx 静态门禁。

**Spec:** `docs/superpowers/specs/2026-10-17-retail-net-sales-return-offset-design.md`
**Issues:** #813（本计划）／ #814（退货侧缺口治本）
**分支:** `fix/813-retail-net-sales-return-offset`（已从 `origin/main` 80a3a7a 新建）

## Global Constraints

- **口径（逐字，不得改动）**：
  - `sale_amount` = `Σ_订单[ (Σ非赠品行额 + order_total_money) / 2 − Σ分摊折扣 ]`，
    条件 `state='FINISHED' AND order_transaction_type='SALE_ORDER'`
  - `return_amount` = `Σ_行[ sale_money + order_detail_share_discount ]`（**正数量级**），
    条件 `order_transaction_type like '%RETURN%' AND state='FINISHED'`
  - `net_amount` = `sale_amount − return_amount`
- **除法形态不得改**：逐单除、逐单减（`sum((ng + tot)/2 − sd)`），**不是**先和后除。
  2026-10-05 的逐分归零是按这个形状验的。
- **退货侧不套折半**：整单退货 `order_total_money = −Σsale_money`，套折半恒得 0。
- **退货按退货单自身 bizday 归属**，不是原单销售日（2026-10-05 已订正）。
- **`REPAID_RETURN` 不计**（state=REPAID）。用 `state='FINISHED'` 表达，**不要**改成类型枚举。
- **相邻中文一律 `${VAR}`**：本机 `/bin/sh` 是 bash 3.2，会把全角字符吃进变量名
  （全仓纪律，issue #212；门禁 `check-shell-cjk-vars.mjs`）。
- **提交格式** `<type>(<scope>): <一句话>`；本 PR 用 `fix(data)`；**提交只写一个 scope**。
- **CHANGELOG 禁止手写**（`release.mjs` 独占）。
- **敏感值只写「在哪、怎么取」**，不写明文。

## 静态门禁（本地可跑，无库无凭据）

推前必跑，全绿才推：

```bash
pnpm typecheck
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-data-contract.mjs
pnpm exec tsx scripts/gen-data-projection.mjs --check
pnpm exec tsx scripts/check-data-plane-lock.mjs
pnpm exec tsx scripts/check-shell-cjk-vars.mjs
pnpm exec tsx scripts/check-doc-citations.mjs origin/main
sh scripts/lemeng/recon-preagg.test.sh
bash scripts/check-dev-discipline.sh origin/main HEAD
```

> ⚠️ 本仓多工作树：跑 `check-doc-citations` / `check-dev-discipline` 前先 `git fetch origin`，
> 否则 `origin/main` 是旧 ref，脚本会走「无提交需要检查」而**静默通过**。

---

### Task 1: `fct_retail_sale` 拆三列

**Files:**
- Modify: `dbt/models/common/marts/fct_retail_sale.sql`（整体重写）
- Modify: `dbt/models/common/marts/schema.yml:16-58`（`fct_retail_sale` 块）
- Modify: `dbt/models/common/marts/schema.yml:415`（`fct_retail_quantity` 描述）
- Modify: `dbt/models/common/marts/fct_retail_quantity.sql:15`（头注）
- Delete: `dbt/tests/assert_fct_retail_sale_net_amount_nonnegative.sql`
- Create: `dbt/tests/assert_fct_retail_sale_sale_amount_nonnegative.sql`

**Interfaces:**
- Produces: `fct_retail_sale` 的列 `(system_book, org, bizday, branch_num, sale_amount, return_amount, net_amount, order_count)`，
  全部 `not_null`；粒度仍 `(system_book, bizday, branch_num)` 唯一。
- Consumes: `stg_lemeng_retail_order_line`（列：`system_book, bizday, branch_num, order_no, sale_money,
  order_total_money, order_detail_share_discount, order_detail_std_price, quantity, discount_money, state,
  order_transaction_type`）；宏 `subject_org()`。

- [ ] **Step 1: 改写模型 SQL**

把 `dbt/models/common/marts/fct_retail_sale.sql` 的 **`with base as (...)` 起至文件末** 整段替换为：

```sql
with sale_base as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sale_money,
        order_total_money,
        order_detail_share_discount,
        -- 赠品判别式（**逐字照抄正典**，与 audit_lemeng__retail__recon_gift_hit.sql 同一句）：
        -- 折让 = 标准价全额 × 数量 ⇒ 该行分文未收（白送）；护栏三条件排除退化命中。
        (order_detail_std_price > 0 and sale_money > 0 and quantity > 0
         and abs(discount_money - order_detail_std_price * quantity) <= 0.02) as is_gift
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_transaction_type = 'SALE_ORDER'
),
per_order as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sum(case when is_gift then 0 else sale_money end) as non_gift_amount,
        max(order_total_money)                            as order_total_money,
        sum(order_detail_share_discount)                  as share_discount
    from sale_base
    group by 1, 2, 3, 4
),
sale_side as (
    select
        system_book,
        bizday,
        branch_num,
        -- 除法形态逐字同构 recon-preagg（见头注）：sum 的参数表达式里**逐单**除 2、逐单减 sd，
        -- 不是先和后除（decimal 除法的舍入位置是口径的一部分）
        (sum((non_gift_amount + order_total_money) / 2 - share_discount))::numeric(20,2) as sale_amount,
        count(distinct order_no)                                                          as order_count
    from per_order
    group by 1, 2, 3
),
return_side as (
    -- 退货侧：**全额冲减，不套折半**（整单退货 order_total_money = −Σsale_money，套折半恒得 0）。
    -- 只收 state='FINISHED' ⇒ 排除 REPAID_RETURN（state=REPAID）——2026-10-17 四个 book-day 真机逐分验证。
    select
        system_book,
        bizday,
        branch_num,
        (sum(sale_money + order_detail_share_discount))::numeric(20,2) as return_amount
    from {{ ref('stg_lemeng_retail_order_line') }}
    where order_transaction_type like '%RETURN%'
      and state = 'FINISHED'
    group by 1, 2, 3
)
select
    coalesce(sale_side.system_book, return_side.system_book) as system_book,
    {{ subject_org() }}                                      as org,
    coalesce(sale_side.bizday, return_side.bizday)           as bizday,
    coalesce(sale_side.branch_num, return_side.branch_num)   as branch_num,
    coalesce(sale_side.sale_amount, 0)::numeric(20,2)        as sale_amount,
    coalesce(return_side.return_amount, 0)::numeric(20,2)    as return_amount,
    (coalesce(sale_side.sale_amount, 0)
     - coalesce(return_side.return_amount, 0))::numeric(20,2) as net_amount,
    coalesce(sale_side.order_count, 0)                       as order_count
from sale_side
full join return_side
    on  sale_side.system_book = return_side.system_book
    and sale_side.bizday      = return_side.bizday
    and sale_side.branch_num  = return_side.branch_num
```

- [ ] **Step 2: 改头注的口径块**

把文件头注里这两行：

```
--   · 净销售额 = state=FINISHED 且 order_transaction_type=SALE_ORDER 的订单（**退货单不进
--     gross**——平台 sale_money 不冲退货单），逐订单取「(Σ非赠品行额 + order_total_money)/2」，
```

替换为：

```
--   · 净销售额 = **销售侧 − 退货侧**（2026-10-17 起，issue #813；口径依据 = 客户裁1 的净额
--     L = Σsale − Σreturn 叠加「换货扣送出半边」）。销售侧 = state=FINISHED 且
--     order_transaction_type=SALE_ORDER 的订单（**退货单不进销售侧**），逐订单取
--     「(Σ非赠品行额 + order_total_money)/2」；退货侧 = **全额冲减**（不套折半）
--     Σ(sale_money + order_detail_share_discount)，条件 order_transaction_type like '%RETURN%'
--     AND state='FINISHED'（REPAID_RETURN 不计）。
```

并在头注末尾追加一行：

```
--   · 口径 spec：docs/superpowers/specs/2026-10-17-retail-net-sales-return-offset-design.md
```

- [ ] **Step 3: 改 schema.yml**

`dbt/models/common/marts/schema.yml` 的 `fct_retail_sale` 块里，`columns:` 下把 `net_amount` 那一段
（第 48-54 行）替换为三段：

```yaml
      - name: sale_amount
        description: 销售侧金额（**不冲退货**；= 2026-10-17 之前 `net_amount` 的原值）。#430 口径：FINISHED+SALE_ORDER 基面 + 换货「送出半边」公式 + 赠品判别式排除，详见模型头注。**与 l1_metrics.yml 的 `lemeng:retail:sales` 同源**。
        tests:
          - not_null
      - name: return_amount
        description: 退货侧金额（**正数量级**）= Σ(sale_money + order_detail_share_discount)，条件 `order_transaction_type like '%RETURN%' AND state='FINISHED'`（REPAID_RETURN 不计）。**全额冲减，不套折半**。见 spec 2026-10-17 §4。
        tests:
          - not_null
      - name: net_amount
        description: 净销售额 = `sale_amount − return_amount`。**与 l1_metrics.yml 的 `lemeng:retail:net_sales` 同源**。
        tests:
          # 金额范围是结构断言（singular test）而不是列级 test：dbt 原生的 accepted_values 只判等值
          # 集合，判不了「≥ 0」这种区间；引 dbt_utils 又要加 packages.yml（多一层依赖 + 解析期要联网）。
          # ⚠️ net_amount **可负**（退货 > 销售的店日），故断言挂在 sale_amount 上：
          # 见 dbt/tests/assert_fct_retail_sale_sale_amount_nonnegative.sql
          - not_null
```

同时把 `order_count` 的描述改成：

```yaml
        description: 有效订单数 = 销售侧基面（FINISHED+SALE_ORDER）count(distinct 单号)。**与 l1_metrics.yml 的 `lemeng:retail:order_count` 同源**；基面 = 销售单，**不含退货单**（退货不是「订单」）。
```

- [ ] **Step 4: 换断言文件**

```bash
git rm dbt/tests/assert_fct_retail_sale_net_amount_nonnegative.sql
```

新建 `dbt/tests/assert_fct_retail_sale_sale_amount_nonnegative.sql`：

```sql
-- assert_fct_retail_sale_sale_amount_nonnegative.sql — 结构断言：**销售侧**金额不得为负。
--
-- 契约同对账测试：**返回任何行即失败**。
--
-- ⚠️ 2026-10-17（issue #813）**断言对象从 `net_amount` 换成 `sale_amount`**：口径改为
--    「销售侧 − 退货侧」后，`net_amount` **可以**为负（某店某日退货 > 销售是合法形态），
--    再拿它判非负就是假红。销售侧本身仍不该为负（那是数据形态理解出缺口的信号）。
--    这正是旧文件头注预告过的放宽（「本断言将来可能要按业务确认后放宽或改写」）。
--
-- 为什么手写而不挂列级 test：dbt 原生的 `accepted_values` 判的是**等值集合**，判不了「≥ 0」
-- 这种区间；`dbt_utils` 有 range 类测试但要加 `packages.yml`（同 grain 那条测试的理由，不引包）。
select
    system_book,
    bizday,
    sale_amount
from {{ ref('fct_retail_sale') }}
where sale_amount < 0
```

- [ ] **Step 5: 订正 `fct_retail_quantity` 那两处「净额不冲退货」表述**

`schema.yml:415` 那句：

```
      ⚠️ 与本族净**额**指标**不同基面**：净额按裁1 不冲退货单；本构件按客户原文 `sale_num − return_num`
```

改成：

```
      ⚠️ 与本族净**额**指标**基面不同**：净额自 2026-10-17 起**已减退货**（#813，按退货单自身 bizday，
      且只收 state='FINISHED' ⇒ REPAID_RETURN 不计）；本构件按客户原文 `sale_num − return_num`，
      退货谓词是 `like '%RETURN%' AND state in ('FINISHED','REPAID')` ⇒ **含 REPAID_RETURN**。
      两个谓词**刻意不同**，别合并（净额复现乐檬 return_money，净销量复现乐檬 return_num）。
```

`fct_retail_quantity.sql:15` 那句：

```
--   · `fct_retail_sale` 的净额口径是「FINISHED + SALE_ORDER」，且按裁1 **不冲退货单**（平台 sale_money 语义）；
```

改成：

```
--   · `fct_retail_sale` 的**销售侧**是「FINISHED + SALE_ORDER」，**不冲退货单**（平台 sale_money 语义）；
--     其**净额**自 2026-10-17 起已减退货侧（#813），退货谓词 = `like '%RETURN%' AND state='FINISHED'`
--     （**不含** REPAID_RETURN）——与本构件的 `state in ('FINISHED','REPAID')` **刻意不同**；
```

- [ ] **Step 6: 跑静态门禁，确认没有引用旧断言名**

```bash
grep -rn "net_amount_nonnegative" --exclude-dir=.git --exclude-dir=node_modules . || echo "无残留引用"
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-data-contract.mjs
```

Expected: `无残留引用`；两条门禁 exit 0。

- [ ] **Step 7: Commit**

```bash
git add dbt/models/common/marts/fct_retail_sale.sql dbt/models/common/marts/schema.yml \
        dbt/models/common/marts/fct_retail_quantity.sql \
        dbt/tests/assert_fct_retail_sale_sale_amount_nonnegative.sql
git commit -m "fix(data): fct_retail_sale 拆 sale_amount/return_amount/net_amount 三列（#813）"
```

---

### Task 2: 语义声明与两条对账

**Files:**
- Modify: `dbt/semantics/l1_metrics.yml:53-95`（`net_sales` 与 `order_count` 两条）
- Modify: `dbt/semantics/l1_metrics.yml:103`（`net_quantity` 定义里那句「净额按裁1 不冲退货单」）
- Create: `dbt/tests/audit_lemeng__retail__sales.sql`
- Modify: `dbt/tests/audit_lemeng__retail__net_sales.sql`
- Modify: `dbt/tests/audit_lemeng__retail__order_count.sql:64`（**T1 review 补入的真缺口**）

**Interfaces:**
- Consumes: Task 1 的 `fct_retail_sale.sale_amount` / `.net_amount`。
- Produces: 指标 `lemeng:retail:net_sales`（expression `sum(fct_retail_sale.net_amount)`）、
  `lemeng:retail:sales`（expression `sum(fct_retail_sale.sale_amount)`）；对账文件名由
  `metricToAuditFileName()` 决定：`audit_lemeng__retail__net_sales.sql` / `audit_lemeng__retail__sales.sql`。

- [ ] **Step 1: 先改声明 —— 让门禁红给你看（TDD 红）**

在 `dbt/semantics/l1_metrics.yml` 的 `metrics:` 列表里，`lemeng:retail:net_sales` 条目**之前**插入：

```yaml
  - name: 'lemeng:retail:sales'
    label: 销售额（不冲退货）
    definition: >-
      零售销售侧金额（**不冲退货**）= 2026-10-17 之前 `lemeng:retail:net_sales` 的原值。
      取 state=FINISHED 且 order_transaction_type=SALE_ORDER 的订单（**退货单不进本口径**），
      逐订单取「(Σ非赠品行额 + order_total_money) / 2」，按门店×日合计后再减 Σ分摊折扣；
      赠品行按判别式排除（std_price>0 且 sale_money>0 且 quantity>0 且
      |discount_money − std_price×quantity| ≤ 0.02，容差标定见判别式正典
      docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md）。
      ⚠️ 会计上这个量叫 **gross sales**，不是 net sales —— 本指标存在的意义正是把「毛」与「净」
      在语义层**同时可见**，防「净销售额」被当成会计净收入用（2026-10-17 事故根因，issue #813）。
      粒度 = 账套 × 业务日 × 门店（口径模型 fct_retail_sale）。
      ✅ tier=certified（沿用旧 `net_sales` 的 2026-10-05 双账套 5 天 × 63 店逐分归零验证，公式未变）。
    expression: 'sum(fct_retail_sale.sale_amount)'
    grain: [system_book, bizday, branch_num]
    owner: data-platform
    tier: certified
    source: lemeng
    freshness_sla_days: 1
    sources:
      - 's3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/hour=<时>/all.parquet'

```

同时把 `lemeng:retail:net_sales` 的 `definition` 整段替换为：

```yaml
    definition: >-
      零售净销售额 = **销售侧 − 退货侧**（2026-10-17 起，issue #813；口径依据 = 客户裁1 的净额
      L = Σsale − Σreturn 叠加「换货扣送出半边」）。**销售侧** = state=FINISHED 且
      order_transaction_type=SALE_ORDER 的订单（退货单不进销售侧），逐订单取
      「(Σ非赠品行额 + order_total_money) / 2」，按门店×日合计后再减 Σ分摊折扣；赠品行按判别式排除
      （std_price>0 且 sale_money>0 且 quantity>0 且 |discount_money − std_price×quantity| ≤ 0.02，
      容差标定见判别式正典 docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md）。
      **退货侧** = 退货单**全额冲减**（不套折半）：Σ(sale_money + order_detail_share_discount)，
      条件 order_transaction_type like '%RETURN%' AND state='FINISHED'（**REPAID_RETURN 不计**
      —— 它们 state=REPAID；2026-10-17 四个 book-day 真机逐分验证）。
      退货按**退货单自身 bizday** 归属，不是原单销售日。
      粒度 = 账套 × 业务日 × 门店（口径模型 fct_retail_sale）。
      ⚠️ 本口径实为**乐檬报表复现口径**（销售侧折半式是反推式），**不是会计口径的净收入**。
      ⚠️ tier=experimental：退货侧存在逐店缺口（issue #814），缺口清零前不转 certified。
      spec：docs/superpowers/specs/2026-10-17-retail-net-sales-return-offset-design.md
```

再把 `lemeng:retail:order_count` 的 `definition` 里这句：

```
      （与净销售额同基面，换货单算一单；口径模型 fct_retail_sale）。
```

替换为：

```
      （基面 = 销售单，与 `lemeng:retail:sales` 同基面，**不含退货单**——退货不是「订单」；
      换货单算一单；口径模型 fct_retail_sale）。
```

并把 `order_count` 的 definition 末尾 `✅ certified（2026-10-13 裁1 回签：与净销售额同基面转正）`
改成 `✅ certified（2026-10-13 裁1 回签；基面 = 销售单，未随 #813 的净额口径变更而变）`。

最后把 `lemeng:retail:net_quantity` 的 `definition` 里这句：

```
      指标**不同**（净额按裁1 不冲退货单，净销量必须减退货），故单开构件而不是共用 fct_retail_sale。
```

替换为：

```
      指标**不同**（净额自 2026-10-17 起也减退货，但退货谓词是 `like '%RETURN%' AND
      state='FINISHED'`（**不含** REPAID_RETURN）；本指标是 `state in ('FINISHED','REPAID')`
      —— 两者**刻意不同**，别合并），故单开构件而不是共用 fct_retail_sale。
```

- [ ] **Step 2: 跑门禁确认它红（缺 audit 文件）**

```bash
pnpm exec tsx scripts/check-data-models.mjs; echo "exit=$?"
```

Expected: **非 0**，报 `指标 \`lemeng:retail:sales\` 声明了却没有对账查询 ... audit_lemeng__retail__sales.sql`。

- [ ] **Step 3: 建 `audit_lemeng__retail__sales.sql`（销售侧复算）**

把**当前** `dbt/tests/audit_lemeng__retail__net_sales.sql` 的内容整份拷到新文件
`dbt/tests/audit_lemeng__retail__sales.sql`，然后改这四处（其余逐字保留，**包括**「不 ref staging、
直接打 parquet」的方法论头注）：

1. 第 2 行头注：`指标 \`lemeng:retail:net_sales\` 的**独立复算**（对账）` →
   `指标 \`lemeng:retail:sales\` 的**独立复算**（对账；销售侧，不冲退货）`
2. `recheck` CTE 的输出列名 `net_sales` → `sale_amount`：

```sql
recheck as (
    select
        system_book,
        bizday,
        branch_num,
        -- 除法形态与 fct 逐字同构（逐单除、逐单减，见头注）
        (sum((non_gift_amount + order_total_money) / 2 - share_discount))::numeric(20,2) as sale_amount
    from per_order
    group by 1, 2, 3
),
```

3. `materialized` CTE 换成取 `sale_amount` 列：

```sql
materialized as (
    select
        system_book,
        bizday,
        branch_num,
        sale_amount
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
```

4. 末尾 union all 的 note 文案：

```sql
    '复算与物化结果不一致（销售额·销售侧，#430 换货半边口径）' as note
```

（`from recheck a full join materialized b using (system_book, bizday, branch_num)` 与
`a.sale_amount` / `b.sale_amount` 三处别名随列名一并改 —— 两侧列名必须一致。）

- [ ] **Step 4: 改 `audit_lemeng__retail__net_sales.sql` 加退货侧**

在该文件的 `with base as (...)` **之后**插入退货 CTE（与销售侧**各自独立**读 parquet，
不 ref staging —— 保持「复算独立」的方法论）：

```sql
, ret_base as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        (r['sale_money']::numeric + r['order_detail_share_discount']::numeric) as return_amount
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['order_transaction_type'] like '%RETURN%'
      and r['state'] = 'FINISHED'
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
ret_side as (
    select
        system_book,
        bizday,
        branch_num,
        sum(return_amount)::numeric(20,2) as return_amount
    from ret_base
    group by 1, 2, 3
)
```

`recheck` CTE 改成销售侧减退货侧：

```sql
recheck as (
    select
        coalesce(s.system_book, t.system_book) as system_book,
        coalesce(s.bizday, t.bizday)           as bizday,
        coalesce(s.branch_num, t.branch_num)   as branch_num,
        (coalesce(s.sale_amount, 0) - coalesce(t.return_amount, 0))::numeric(20,2) as net_sales
    from (
        select system_book, bizday, branch_num,
               (sum((non_gift_amount + order_total_money) / 2 - share_discount))::numeric(20,2) as sale_amount
        from per_order group by 1, 2, 3
    ) s
    full join ret_side t
        on  s.system_book = t.system_book
        and s.bizday      = t.bizday
        and s.branch_num  = t.branch_num
),
```

并把 `materialized` CTE 里的 `net_amount as net_sales` 保持不变（列名已对上），
末尾 note 文案改为 `'复算与物化结果不一致（净销售额 = 销售侧 − 退货侧，#813）'`。

> ⚠️ 该文件里**新增的 `ret_side` CTE 必须只被 `recheck` 用，不要动 `base`/`per_order` 的销售侧**——
> 它们是复算的**独立**读路径，与 `fct_retail_sale` 各自写（方法论见文件头注）。

- [ ] **Step 4b: 修 `audit_lemeng__retail__order_count.sql`（T1 review 补入的真缺口）**

**为什么必须改**：T1 的 `full join` 让「只有退货、没有销售」的店日在物化侧**新增一行**
（`order_count = 0`），而本 audit 的复算侧只有销售基面 ⇒ 该行 `a.order_count` 为 NULL、
`b.order_count` 为 0 ⇒ `NULL is distinct from 0` 为真 ⇒ **出红行**。T8「三条 audit 绿」过不了。

把第 64 行：

```sql
where a.order_count is distinct from b.order_count
```

替换为：

```sql
-- ⚠️ 2026-10-17（issue #813）：物化侧自 T1 起含「只有退货、没有销售」的店日（order_count=0），
--    而本复算侧只有销售基面 ⇒ 那些行 a.order_count 为 NULL。coalesce 到 0 再比，
--    既放过这些**结构上正确**的空缺，又不放松销售店日的逐分判据。
where coalesce(a.order_count, 0) is distinct from coalesce(b.order_count, 0)
```

并把第 61 行的 note 文案末尾 `（有效订单数，#430 同基面）` 改为
`（有效订单数，基面=销售单，#430/#813）`。

- [ ] **Step 5: 跑门禁确认绿**

```bash
pnpm exec tsx scripts/check-data-models.mjs; echo "exit=$?"
```

Expected: exit 0，且扫描计数里 `audits` 多 1。

- [ ] **Step 6: Commit**

```bash
git add dbt/semantics/l1_metrics.yml dbt/tests/audit_lemeng__retail__sales.sql \
        dbt/tests/audit_lemeng__retail__net_sales.sql \
        dbt/tests/audit_lemeng__retail__order_count.sql
git commit -m "fix(data): net_sales 改冲退货口径 + 新增 lemeng:retail:sales 保留旧数（#813）"
```

---

### Task 3: 输入形状守卫扩到退货行

**Files:**
- Modify: `dbt/tests/audit_lemeng__retail__recon_exchange_shape.sql:27-111`

**Interfaces:**
- Consumes: 无（独立读 parquet）。
- Produces: 无（断言文件，不挂指标 —— 规则 ⑦ 单向）。

**为什么**：退货侧用 `sale_money + order_detail_share_discount`，**任一为 NULL 则整行被 sum 静默丢掉**
（模型头注预告过这类）。2026-10-17 实测退货行零 NULL，故这是**防回归的守卫**，不是修现状。

- [ ] **Step 1: 加退货行的形状守卫（part1b）**

在该文件最后一个 `union all` **之前**插入：

```sql
union all

-- part1b（退货行形状，2026-10-17 issue #813）：退货侧的加数是 `sale_money + order_detail_share_discount`，
-- 任一为 NULL ⇒ 整行被 sum **静默丢掉**（退货额虚低 ⇒ 净销售额虚高）。
-- ⚠️ **不判符号**：退货行的 order_total_money 合法地为负（= −Σsale_money），与销售侧不同。
select
    system_book,
    bizday,
    'parquet'                                                          as side,
    count(*)                                                           as bad_rows,
    count(*) filter (where sale_money is null)                         as total_null,
    count(*) filter (where share_discount is null)                     as pay_null,
    0::bigint                                                          as total_neg,
    0::bigint                                                          as pay_neg,
    '退货侧公式输入形状违规（FINISHED 退货行：sale_money / order_detail_share_discount 为空）——恒空 ⇒ 该行被 sum 静默丢掉，退货额虚低' as note
from (
    select
        r['system_book']::varchar                 as system_book,
        r['bizday']::date                         as bizday,
        r['sale_money']::numeric                  as sale_money,
        r['order_detail_share_discount']::numeric as share_discount
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['order_transaction_type'] like '%RETURN%'
      and r['state'] = 'FINISHED'
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
) ret
where sale_money is null or share_discount is null
group by 1, 2
```

- [ ] **Step 2: 改头注**

把头注第 4-5 行：

```
--   平台的 sale_money **不冲退货单**（`order_transaction_type <> 'SALE_ORDER'` 的单本来就不进 gross），
--   要扣的是**换货单的「送出半边」**：net(店,日) = Σ_订单[(Σ非赠品行额 + order_total_money)/2] − Σ分摊折扣。
```

替换为：

```
--   平台的 sale_money **不冲退货单**（`order_transaction_type <> 'SALE_ORDER'` 的单本来就不进 gross），
--   要扣的是**换货单的「送出半边」**：sale_amount(店,日) = Σ_订单[(Σ非赠品行额 + order_total_money)/2] − Σ分摊折扣。
--   ⚠️ 2026-10-17（issue #813）起**净销售额 = 销售侧 − 退货侧**，退货侧另有形状前提（part1b）。
```

- [ ] **Step 3: 跑门禁**

```bash
pnpm exec tsx scripts/check-data-models.mjs
```

Expected: exit 0（本文件不挂指标，规则 ⑦ 不管它；主要确认没写出静态门禁禁止的形态
——`::double` / `union_by_name` / 非 `r['列']` 取列）。

- [ ] **Step 4: Commit**

```bash
git add dbt/tests/audit_lemeng__retail__recon_exchange_shape.sql
git commit -m "fix(data): 换货半边形状守卫扩到退货行（#813）"
```

---

### Task 4: 契约描述订正

**Files:**
- Modify: `contracts/common/lemeng.retail_order_line.json:41`

**Interfaces:**
- Consumes: 无。
- Produces: 无（描述文本；**列集不变**）。

- [ ] **Step 1: 改 `order_transaction_type` 的描述**

把该字段 `description` 里的这一段：

```
⚠️ 2026-10-05 订正：旧描述「非 SALE 订单行金额逐分等于平台 return_money」**会误导**——平台的 sale_money **不冲减退货单**（退货单只是不进 gross），且**同一张 SALE_ORDER 内部也可能装着换货的退回行**（靠本列看不出来）。口径正典见 issue #430。
```

替换为：

```
⚠️ 2026-10-05 订正：旧描述「非 SALE 订单行金额逐分等于平台 return_money」**会误导**——平台的 sale_money **不冲减退货单**（退货单只是不进 gross），且**同一张 SALE_ORDER 内部也可能装着换货的退回行**（靠本列看不出来）。口径正典见 issue #430。⚠️ 2026-10-17 补充（issue #813）：平台的**净销售额**已改为「销售侧 − 退货侧」，退货侧取 `like '%RETURN%' AND state='FINISHED'` 的行（**REPAID_RETURN 不计**），按**退货单自身 bizday** 归属。
```

- [ ] **Step 2: 跑契约与投影门禁**

```bash
pnpm exec tsx scripts/check-data-contract.mjs
pnpm exec tsx scripts/gen-data-projection.mjs --check
```

Expected: 两条 exit 0。若 `gen-data-projection --check` 红，说明描述参与了生成物哈希 ⇒
按它输出的指引重跑 `pnpm exec tsx scripts/gen-data-projection.mjs` 并把生成物一并提交。

- [ ] **Step 3: Commit**

```bash
git add contracts/common/lemeng.retail_order_line.json
git commit -m "docs(data): 契约补净销售额冲退货口径（#813）"
```

---

### Task 5: 对账脚本切锚（`scripts/lemeng/recon-preagg.sh`）

**Files:**
- Modify: `scripts/lemeng/recon-preagg.sh`（头注、env 默认、`SQL_LAKE`、python 比较块）
- Modify: `scripts/lemeng/recon-preagg.test.sh`（夹具改三列、断言改两行）

**Interfaces:**
- Produces: 湖侧 CSV 三列 `branch,sale_net,return_amount`；python 块 argv 六参
  `book day abs_tol max_pct settled net_abs_tol`；新增字面量
  `PREAGG_NET_OK` / `PREAGG_NET_UNSETTLED` / `PREAGG_NET_DRIFT` / `PREAGG_FAILED:net_threshold`。
- Consumes: 无（独立读湖 + 端点）。

> ⚠️ **两个硬约束**（实测，别踩）：
> 1. `recon-preagg.test.sh` 用 `awk '/^python3 - /{f=1;next} /^PY$/{f=0} f'` 抽比较块
>    —— **全脚本只能有一个 `python3 - ... <<'PY' ... PY` 块**，加第二个会把两段串进同一个文件。
>    ⇒ 两条判据（销售侧 / 净额侧）写在**同一个** python 块里。
> 2. 脚本跑在 `/bin/sh`（bash 3.2）⇒ **相邻中文一律 `${VAR}`**（第 49 行那条纪律）。

- [ ] **Step 1: 先改测试夹具（TDD 红）**

把 `scripts/lemeng/recon-preagg.test.sh` 的 `run()` / `run2()` 两个函数替换为：

```sh
run() { # $1=湖CSV $2=响应JSON $3=是否定稿(1/0) -> 打印"全部输出|rc"
  rm -f /tmp/_preagg_resp_*.json
  _w "$1" /tmp/_preagg_lake.csv; _w "$2" /tmp/_preagg_resp_1.json
  out=$(python3 /tmp/_rp_blk.py t 2026-10-02 1.00 0.01 "$3" 200.00 2>&1); rc=$?
  printf '%s|%s' "$(printf '%s' "$out" | tr '\n' ' ')" "$rc"
}
run2() { # 分批形态：$1=湖CSV $2=批1响应 $3=批2响应 $4=定稿 -> 打印"全部输出|rc"
  rm -f /tmp/_preagg_resp_*.json
  _w "$1" /tmp/_preagg_lake.csv; _w "$2" /tmp/_preagg_resp_1.json; _w "$3" /tmp/_preagg_resp_2.json
  out=$(python3 /tmp/_rp_blk.py t 2026-10-02 1.00 0.01 "$4" 200.00 2>&1); rc=$?
  printf '%s|%s' "$(printf '%s' "$out" | tr '\n' ' ')" "$rc"
}
```

并把 7 条用例的夹具与断言整段替换为：

```sh
# 1) 两侧都平 ⇒ PREAGG_OK + PREAGG_NET_OK / rc 0
r=$(run '12,100.00,20.00
21,50.00,0.00
' "$(_resp '{"branch_num":12,"sale_money":100.00,"return_money":20.00},{"branch_num":21,"sale_money":50.00,"return_money":0.00}')" 1)
case "$r" in *"PREAGG_OK book=t bizday=2026-10-02 branches=2"*"PREAGG_NET_OK book=t bizday=2026-10-02 branches=2"*"|0") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 两侧应平：$r";; esac

# 2) 湖有源无 ⇒ branch_missing / rc 1
r=$(run '12,100.00,20.00
21,50.00,0.00
' "$(_resp '{"branch_num":12,"sale_money":100.00,"return_money":20.00}')" 1)
case "$r" in *PREAGG_FAILED:branch_missing*"|1") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 漏店未按 branch_missing 判：$r";; esac

# 3) 销售侧超阈值 ⇒ threshold / rc 1
r=$(run '12,100.00,20.00
' "$(_resp '{"branch_num":12,"sale_money":1.00,"return_money":20.00}')" 1)
case "$r" in *PREAGG_FAILED:threshold*"|1") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 超阈值未判：$r";; esac

# 3b) 销售侧平、净额侧差 50（< NET_ABS_TOL 200）⇒ 销售侧 OK + 净额侧 DRIFT / rc 0
r=$(run '12,100.00,20.00
' "$(_resp '{"branch_num":12,"sale_money":100.00,"return_money":70.00}')" 1)
case "$r" in *"PREAGG_OK book=t"*"PREAGG_NET_DRIFT"*"|0") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 净额侧过渡容差内应 DRIFT 不判红：$r";; esac

# 3c) 净额侧超过渡容差 ⇒ net_threshold / rc 1
r=$(run '12,100.00,20.00
' "$(_resp '{"branch_num":12,"sale_money":100.00,"return_money":500.00}')" 1)
case "$r" in *PREAGG_FAILED:net_threshold*"|1") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 净额侧超容差未判：$r";; esac

# 4) 未定稿（第 5 参=0）⇒ 两侧都 UNSETTLED / rc 0（**即便差得很离谱也不判红**）
r=$(run '12,100.00,20.00
' "$(_resp '{"branch_num":12,"sale_money":1.00,"return_money":0.00}')" 0)
case "$r" in *"PREAGG_UNSETTLED"*"PREAGG_NET_UNSETTLED"*"|0") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 未定稿应只报数：$r";; esac

# 5) 端点坏（code!=0）⇒ PREAGG_FAILED:pre_call / rc 3
r=$(run '12,100.00,20.00
' '{"code":10006,"msg":"用户上下文或权限读取失败"}' 1)
case "$r" in *PREAGG_FAILED:pre_call*"|3") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 端点失败未按依赖处理：$r";; esac

# 6) 分批合并（#525：3120 147 家 > 端点单次 100 上限）：两批 rows 合并后逐分平 ⇒ OK / rc 0
r=$(run2 '12,100.00,20.00
21,50.00,0.00
' "$(_resp '{"branch_num":12,"sale_money":100.00,"return_money":20.00}')" "$(_resp '{"branch_num":21,"sale_money":50.00,"return_money":0.00}')" 1)
case "$r" in *"PREAGG_OK book=t bizday=2026-10-02 branches=2"*"PREAGG_NET_OK"*"|0") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 分批合并应平：$r";; esac

# 7) 分批且其中一批端点坏 ⇒ pre_call / rc 3（批级失败不能被合并吞掉）
r=$(run2 '12,100.00,20.00
21,50.00,0.00
' "$(_resp '{"branch_num":12,"sale_money":100.00,"return_money":20.00}')" '{"code":10001,"msg":"branch_nums 最多支持 100 家门店"}' 1)
case "$r" in *PREAGG_FAILED:pre_call*"|3") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 批级端点失败未判：$r";; esac
```

- [ ] **Step 2: 跑测试确认它红**

```bash
sh scripts/lemeng/recon-preagg.test.sh; echo "exit=$?"
```

Expected: **非 0**（`python3 /tmp/_rp_blk.py` 只有 5 个参数、比较块还是两列 ⇒ `IndexError` 或断言全红）。

- [ ] **Step 3: 改脚本 env 默认与头注**

`scripts/lemeng/recon-preagg.sh` 里，`PREAGG_ABS_TOL=${PREAGG_ABS_TOL:-1.00}` 之后追加一行：

```sh
# 净额侧过渡容差（**总量**，元/账套/日）。200.00 ≈ 实测最大退货缺口 123.06（64188/10-14）的 1.6 倍。
# ⚠️ **过渡值，带到期条件**：issue #814（退货侧缺口治本）修完 ⇒ 本值归 0，与销售侧同款逐分。
NET_ABS_TOL=${NET_ABS_TOL:-200.00}
```

头注第 18-19 行那两行：

```
#   ⚠️ **不扣退货单**：`order_transaction_type <> 'SALE_ORDER'` 的单**本来就不进 gross**，
#      平台的 sale_money 也**不冲减**它（2026-09-30 的 spec 把这条理解反了 —— 那版规则已撤）。
```

替换为：

```
#   ⚠️ **销售侧不扣退货单**：`order_transaction_type <> 'SALE_ORDER'` 的单**本来就不进销售侧**，
#      平台的 sale_money 也**不冲减**它（2026-09-30 的 spec 把这条理解反了 —— 那版规则已撤）。
#   ⚠️ 2026-10-17（issue #813）起**另比一条净额侧判据**：净额 = 销售侧 − 退货侧，
#      退货侧 = Σ(sale_money + order_detail_share_discount)，条件
#      `order_transaction_type like '%RETURN%' AND state='FINISHED'`（**REPAID_RETURN 不计**），
#      按**退货单自身 bizday** 归属。源侧对应端点字段 `return_money`。
```

- [ ] **Step 4: 改湖侧 SQL**

把第 119 行的 `SQL_LAKE="..."` 整行替换为：

```sh
# 湖侧两列：销售侧净额 + 退货侧金额（同一 query，避免第二个 python 块 —— 测试只抽一个块）。
SQL_LAKE="WITH per_order AS (SELECT r['branch_num']::int AS b, r['order_no'] AS o, sum(CASE WHEN ${GIFT} THEN 0 ELSE r['sale_money'] END) AS ng, max(r['order_total_money']) AS tot, sum(r['order_detail_share_discount']) AS sd FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/bizday=${BIZDAY}/**/*.parquet') r WHERE r['state']='FINISHED' AND r['order_transaction_type']='SALE_ORDER' GROUP BY 1, 2), sale_side AS (SELECT b, round(sum((ng + tot) / 2 - sd), 2) AS sale_net FROM per_order GROUP BY b), ret_side AS (SELECT r['branch_num']::int AS b, round(sum(r['sale_money'] + r['order_detail_share_discount']), 2) AS ret FROM read_parquet('${LAKE_ROOT}/system_book=${BOOK}/bizday=${BIZDAY}/**/*.parquet') r WHERE r['order_transaction_type'] like '%RETURN%' AND r['state']='FINISHED' GROUP BY 1) SELECT coalesce(s.b, t.b), coalesce(s.sale_net, 0), coalesce(t.ret, 0) FROM sale_side s FULL JOIN ret_side t ON s.b = t.b ORDER BY 1"
```

- [ ] **Step 5: 换比较块**

把第 151-213 行（`python3 - "${BOOK}" ... <<'PY'` 到 `PY`）整段替换为：

```sh
python3 - "${BOOK}" "${BIZDAY}" "${PREAGG_ABS_TOL}" "${PREAGG_MAX_PCT}" "${SETTLED}" "${NET_ABS_TOL}" <<'PY'
import glob
import json
import sys

book, day = sys.argv[1], sys.argv[2]
abs_tol, max_pct = float(sys.argv[3]), float(sys.argv[4])
settled = sys.argv[5] == '1'
net_abs_tol = float(sys.argv[6])


def rd(path):
    """湖侧 CSV：branch,sale_net,return_amount"""
    d = {}
    try:
        f = open(path)
    except OSError:
        return d
    for ln in f:
        ps = ln.strip().split(',')
        if len(ps) != 3 or not ps[0].lstrip('-').isdigit():
            continue
        d[int(ps[0])] = (float(ps[1]), float(ps[2]))
    return d


lake = rd('/tmp/_preagg_lake.csv')
# 分批响应合并（#525：报表端点单次 ≤100 家门店；各批响应文件按批号合并 rows）
chunks = sorted(glob.glob('/tmp/_preagg_resp_*.json'))
rows = []
for path in chunks:
    resp = json.load(open(path))
    if resp.get('code') != 0:
        print('PREAGG_FAILED:pre_call 预聚合端点返回 code=%s msg=%s' % (resp.get('code'), str(resp.get('msg'))[:80]))
        sys.exit(3)
    rows += (resp.get('result') or {}).get('rows') or []

lake_sale = {b: v[0] for b, v in lake.items()}
lake_ret = {b: v[1] for b, v in lake.items()}
pre_sale = {int(x['branch_num']): float(x.get('sale_money') or 0) for x in rows}
pre_ret = {int(x['branch_num']): float(x.get('return_money') or 0) for x in rows}


def compare(tag, fail_tag, lake_map, pre_map, tol_abs, tol_pct):
    """一条判据：打印 verdict 行，返回 0=通过 / 1=判红。"""
    miss = [b for b in lake_map if b not in pre_map]
    extra = [b for b in pre_map if b not in lake_map]
    lt = round(sum(lake_map.values()), 2)
    pt = round(sum(pre_map.values()), 2)
    diff = round(pt - lt, 2)
    pct = (diff / pt * 100.0) if pt else 0.0
    sign = '+' if diff >= 0 else ''
    tol = max(tol_abs, abs(pt) * tol_pct / 100.0)

    print('%s book=%s bizday=%s branches=%d total_lake=%.2f total_pre=%.2f diff=%s%.2f pct=%s%.2f%% tol=%.2f'
          % (tag, book, day, len(lake_map), lt, pt, sign, diff, sign, pct, tol))

    if not settled:
        print('%s_UNSETTLED book=%s bizday=%s（未过定稿线：源还在变，只报数不判红）' % (tag, book, day))
        return 0
    if miss:
        print('PREAGG_FAILED:branch_missing 湖有而源无的门店 %d 家：%s' % (len(miss), sorted(miss)[:20]))
        return 1
    if extra:
        print('  注：源有而湖无的门店 %d 家（当日无销售）：%s' % (len(extra), sorted(extra)[:20]))
    if abs(diff) > tol:
        print('PREAGG_FAILED:%s 差 %s%.2f 超容差 %.2f（total_pre=%.2f，%s%.4f%%）'
              % (fail_tag, sign, diff, tol, pt, sign, pct))
        return 1
    if abs(diff) >= 0.005:
        print('%s_DRIFT book=%s bizday=%s diff=%s%.2f（在容差内）' % (tag, book, day, sign, diff))
    print('%s_OK book=%s bizday=%s branches=%d' % (tag, book, day, len(lake_map)))
    return 0


# 销售侧：口径未变，容差沿用 PREAGG_ABS_TOL / PREAGG_MAX_PCT（恒逐分）。
rc_sale = compare('PREAGG', 'threshold', lake_sale, pre_sale, abs_tol, max_pct)
# 净额侧：新增，过渡容差 NET_ABS_TOL（**带到期条件**，见头注 / issue #814）。
rc_net = compare('PREAGG_NET', 'net_threshold',
                 {b: lake_sale[b] - lake_ret[b] for b in lake_sale},
                 {b: pre_sale[b] - pre_ret.get(b, 0.0) for b in pre_sale},
                 net_abs_tol, max_pct)
sys.exit(1 if (rc_sale or rc_net) else 0)
PY
```

- [ ] **Step 6: 跑测试确认绿**

```bash
sh scripts/lemeng/recon-preagg.test.sh; echo "exit=$?"
```

Expected: `recon-preagg: pass=9 fail=0` + `recon-preagg: OK` + `exit=0`。

- [ ] **Step 7: 跑 CJK 邻接门禁**

```bash
pnpm exec tsx scripts/check-shell-cjk-vars.mjs; echo "exit=$?"
```

Expected: exit 0。

- [ ] **Step 8: Commit**

```bash
git add scripts/lemeng/recon-preagg.sh scripts/lemeng/recon-preagg.test.sh
git commit -m "fix(data): 对账脚本切净额锚（销售侧 + 退货侧两条判据，过渡容差带到期）（#813）"
```

---

### Task 6: 对账管线与 FLOW 切锚

**Files:**
- Modify: `deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json`（`_note` + 两个 `code.sql` 节点）
- Modify: `deploy/duckle/console/pipelines/lemeng.recon.preagg.json:4`（`_note`）
- Modify: `deploy/duckle/console/pipelines/FLOW.lemeng.md:191`

**Interfaces:**
- Consumes: Task 5 的口径（管线与脚本必须逐字同源）。
- Produces: 管线侧 `lagg` 的 lake 分支输出净额、pre 分支输出 `sale_money − return_money`。

- [ ] **Step 1: 改 item.json 的 `_note`（第 11 行）**

把：

```
    "  逐订单归并**不能省**（按行算会把「总额×行数」加进去）；不扣退货单。本文件 lagg 逐字对应该公式。",
```

替换为：

```
    "  逐订单归并**不能省**（按行算会把「总额×行数」加进去）；销售侧不扣退货单。",
    "  ⚠️ 2026-10-17（issue #813）：本管线比的是**净额** = 销售侧 − 退货侧。退货侧 = Σ(sale_money + order_detail_share_discount)，",
    "     条件 order_transaction_type like '%RETURN%' AND state='FINISHED'（REPAID_RETURN 不计）。源侧对应 return_money。",
```

- [ ] **Step 2: 改 lagg 的 lake 分支 SQL（第 85 行那个 `"sql":`）**

把该 `"sql"` 值整段替换为（**注意是 JSON 字符串里的 `\n`**）：

```
WITH per_order AS (\n  SELECT CAST(branch_num AS INTEGER) AS b,\n         CAST(order_no AS VARCHAR) AS o,\n         sum(CASE WHEN CAST(order_detail_std_price AS DOUBLE) > 0\n                    AND CAST(sale_money AS DOUBLE) > 0\n                    AND CAST(quantity AS DOUBLE) > 0\n                    AND abs(CAST(discount_money AS DOUBLE)\n                            - CAST(order_detail_std_price AS DOUBLE) * CAST(quantity AS DOUBLE)) <= 0.02\n                  THEN 0 ELSE CAST(sale_money AS DOUBLE) END) AS ng,\n         max(CAST(order_total_money AS DOUBLE)) AS tot,\n         sum(CAST(order_detail_share_discount AS DOUBLE)) AS sd\n  FROM \"lguard\"\n  WHERE CAST(state AS VARCHAR) = 'FINISHED'\n    AND CAST(order_transaction_type AS VARCHAR) = 'SALE_ORDER'\n  GROUP BY 1, 2),\nsale_side AS (\n  SELECT b, round(sum((ng + tot) / 2 - sd), 2) AS sale_net FROM per_order GROUP BY b),\nret_side AS (\n  SELECT CAST(branch_num AS INTEGER) AS b,\n         round(sum(CAST(sale_money AS DOUBLE) + CAST(order_detail_share_discount AS DOUBLE)), 2) AS ret\n  FROM \"lguard\"\n  WHERE CAST(order_transaction_type AS VARCHAR) like '%RETURN%'\n    AND CAST(state AS VARCHAR) = 'FINISHED'\n  GROUP BY 1)\nSELECT coalesce(s.b, t.b) AS branch_num,\n       coalesce(s.sale_net, 0) - coalesce(t.ret, 0) AS net,\n       'lake' AS side\nFROM sale_side s FULL JOIN ret_side t ON s.b = t.b ORDER BY 1
```

- [ ] **Step 3: 改 pre 分支 SQL（第 118 行那个 `"sql":`）**

把 `CAST(sale_money AS DOUBLE) AS net,` 替换为：

```
CAST(sale_money AS DOUBLE) - CAST(return_money AS DOUBLE) AS net,
```

- [ ] **Step 4: 改 `lemeng.recon.preagg.json` 的 `_note`（第 4 行）**

把 `不扣退货 / 容差 / 定稿线` 替换为 `销售侧不扣退货 + 净额侧减退货 / 容差 / 定稿线`。

- [ ] **Step 5: 改 `FLOW.lemeng.md` 第 191 行**

把：

```
| `lagg` | ③ | SQL 执行壳 | 净额口径逐字对应 `recon-preagg.sh`（赠品判别式 / 逐订单归并 / 不扣退货） |
```

替换为：

```
| `lagg` | ③ | SQL 执行壳 | 净额口径逐字对应 `recon-preagg.sh`（赠品判别式 / 逐订单归并 / 销售侧不扣退货 + 净额侧减退货，issue #813） |
```

- [ ] **Step 6: 跑 lock 门禁**

```bash
pnpm exec tsx scripts/check-data-plane-lock.mjs; echo "exit=$?"
```

Expected: exit 0。若红，按输出指引重跑 `scripts/lemeng/data-plane-lock.mjs` 并把 lock 文件一并提交。

- [ ] **Step 7: Commit**

```bash
git add deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json \
        deploy/duckle/console/pipelines/lemeng.recon.preagg.json \
        deploy/duckle/console/pipelines/FLOW.lemeng.md \
        deploy/data-plane.lock
git commit -m "fix(data): 对账管线切净额锚 + FLOW 口径订正（#813）"
```

---

### Task 7: 正典与问答文档登记

**Files:**
- Modify: `docs/data-platform-handbook.md`（§1.4 独立通道表 ~641 行、§2 台账行 ~826 行、§5 验收记录）
- Modify: `docs/lemeng-recon-questions.md:5`
- Modify: `dbt/README.md:138`（构件列约定表 —— **T1 review 补入的真缺口**）

**Interfaces:**
- Consumes: 无。
- Produces: 无（文档登记）。

- [ ] **Step 1: 改 §1.4 独立通道表（第 641 行那一格）**

把该格里这句：

```
**口径已于 2026-10-05 对齐**（issue #430/#431）。
```

替换为：

```
**口径已于 2026-10-05 对齐**（issue #430/#431；2026-10-17 **净销售额改为冲退货**，issue #813——销售侧公式未变，另减退货侧 Σ(sale_money + order_detail_share_discount)，REPAID_RETURN 不计）。
```

- [ ] **Step 2: 改 §2 台账行（第 826 行那一格）**

把该格末尾的 `2026-10-17 同改 whoami 现算（exclude=\`[]\`，行为不变——#793）` 之后追加：

```
。2026-10-17 净额口径改冲退货（#813）：对账锚从 `sale_money` 换成 `sale_money − return_money`，退货侧另有逐店缺口（#814，过渡容差 NET_ABS_TOL=200 带到期）
```

- [ ] **Step 3: 改 `docs/lemeng-recon-questions.md` 第 5 行**

在该行末尾追加：

```
**2026-10-17 追加（issue #813）**：净销售额已改为「销售侧 − 退货侧」——上文「不冲减退货单」说的是**销售侧**（= 乐檬 `sale_money`），现在净额另减退货侧（= 乐檬 `return_money`）。两者不矛盾。
```

- [ ] **Step 3b: 改 `dbt/README.md` 构件列约定表（T1 review 补入的真缺口）**

该表自称「**新域/新列先改本表再写模型（本表是约定的事实源）**」，retail 行仍是旧列。
把第 138 行：

```
| retail | `fct_retail_sale`（**W0 ✓**） | `net_amount`(L 净额)、`order_count` |
```

替换为：

```
| retail | `fct_retail_sale`（**W0 ✓**；2026-10-17 #813 拆三列） | `sale_amount`(销售侧，不冲退货)、`return_amount`(退货侧)、`net_amount`(L 净额 = 销售侧 − 退货侧)、`order_count` |
```

- [ ] **Step 4: 跑引用门禁**

```bash
git fetch origin
pnpm exec tsx scripts/check-doc-citations.mjs origin/main; echo "exit=$?"
```

Expected: exit 0（新增的 spec/issue 引用可解析）。

- [ ] **Step 5: Commit**

```bash
git add docs/data-platform-handbook.md docs/lemeng-recon-questions.md dbt/README.md
git commit -m "docs(data): 正典与构件列约定登记净销售额冲退货口径（#813）"
```

---

### Task 8: 数据面端到端验收（**merge 后**）

**Files:** 无（只读验证）。

**Interfaces:**
- Consumes: Task 1-7 全部。
- Produces: 验收证据（进正典 §5 验收记录行）。

> ⚠️ 本任务在 PR 合并、CI CLEAN、`/opt` sync 之后跑。走 openship MCP，**不裸 SSH**。
> 数据面机 serverId `8281d598-af73-4d0b-99dd-bc8681fcc8bb`；主项目 `proj_GLXUtN2bJ92DpPrS`（shanhai）。

- [ ] **Step 1: 跑 materialize 并核三条 audit**

```bash
# 数据面机：sh /opt/lemeng-materialize.sh
```

Expected: 末行 `MATERIALIZE_OK`（中间出现 `MATERIALIZE_FAILED:dbt_build` 不算失败 —— 脚本内建 retry），
且 `net_sales` / `sales` / `order_count` 三条 audit 绿。

- [ ] **Step 2: 核 64188/10-16 的净销售额 = 220,217.50**

```sh
docker exec -i openship-platform-core-shanhai-data-pg_duckdb sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U platform -d warehouse -tA -F"|"' <<'EOSQL'
select round(sum(net_amount),2), round(sum(sale_amount),2), round(sum(return_amount),2)
from staging.fct_retail_sale
where system_book = '64188' and bizday = date '2026-10-16';
EOSQL
```

Expected: `220217.50|222021.00|1803.50`（**纯 PG 查询，不要包 `duckdb.query`** ——
`staging.fct_retail_sale` 是 PG 表，包进去会被 DuckDB 解析）。

- [ ] **Step 3: 跑对账脚本，核两条判据（**两个账套都要跑**）**

```bash
for B in 64188 3120; do
  for D in 2026-10-12 2026-10-13 2026-10-14 2026-10-15 2026-10-16; do
    echo "--- $B $D ---"
    BOOK=$B sh /opt/lemeng-recon-preagg.sh "$D" | grep -E '^PREAGG'
  done
done
```

Expected: 每天 `PREAGG` 行 `diff=+0.00`（销售侧恒逐分）；`PREAGG_NET` 行在 64188 的
10-12/10-14/10-15 显示登记缺口、10-13/10-16 为 `diff=+0.00`，且**全部在 `NET_ABS_TOL` 内**
（无 `net_threshold`）。

> ⚠️ **必须专门看一眼 `branch_missing`（T5 review 点名的风险，理由见下）**：T5 把湖侧键集从
> 「有销售的店」扩成「有销售 ∪ 有退货的店」，于是「只有退货、没有销售」的门店会以
> `sale_net=0` 进湖侧 map。若预聚合端点**不返回**这类门店，销售侧 `compare()` 会报
> `PREAGG_FAILED:branch_missing`（改前这种情形最多落一条 `extra` 注释）。
> **3120 是 147 店、且 Task 3 已证明这类店日真实存在**，所以必须跑它 —— 只验 64188 会把这条
> 通路整个漏掉。
>
> 判定：出现 `branch_missing` **不必然是回归**，但它是**新开的硬红通路**，必须当场定性 ——
> 是端点不返回零销售门店（⇒ 记入 issue #813，另议 `miss` 是否该区分维度），还是真的湖源不一致
> （⇒ 交 `recon-day-heal.sh`）。**不许只贴一个红就过。**

- [ ] **Step 4: 业务验收 —— 问数 bot**

在**企微真实渠道**问：`64188 2026-10-16 的净销售额是多少`。
Expected: 回 **220,217.50**（不是 222,021.00）。另问一次「销售额（不冲退货）」应回 222,021.00。

> CLI 轮不能替代渠道轮（缺 `requesterSenderId`）——见 skill `askdata-tuning` 的验收三条件。

- [ ] **Step 5: 补正典 §5 验收记录行**

在 `docs/data-platform-handbook.md` §5 追加一行，记：日期、账套、净销售额 220,217.50、
销售侧恒逐分、净额侧缺口与 `NET_ABS_TOL`、问数 bot 回数。**用 PR 提交，不直推 main。**

---

## 完成后的收尾义务

1. PR body 写 `Closes #813`（**不要**写 `Closes #814` —— 缺口 issue 保持开放到治本完成）。
2. 退货侧缺口治本（#814）不在本 PR 范围；`NET_ABS_TOL` 的清零条件挂在它上面。
3. 合并只等 CI CLEAN。
4. WeKnora 沉淀：先查重（关键词 `乐檬 净销售额 退货`），命中则更新原条目。
