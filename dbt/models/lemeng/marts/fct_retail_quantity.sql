{{
    config(materialized='table')
}}
-- fct_retail_quantity.sql — **零售净销量**构件（#769，2026-10-17）。
--
-- 【它为谁服务】客户项 `03-07` 库存覆盖天数的**分母**：
--   日均净销量＝ΣN日(sale_num−return_num)/可比营业日数；覆盖天数＝可售库存/日均净销量。
--   ⚠️ 「N」先按裁5 **只出分子/分母**（2026-10-17 首次交付）；此后用户裁决 **N = 月日均**
--   （当月至今的日均），覆盖天数由 `fct_inventory_coverage` + `inventory:coverage_days` 交付。
--
-- 【粒度 (system_book, bizday, branch_num, item_num)】—— 2026-10-17 由门店级**扩到商品级**：
--   覆盖天数的客户粒度是「门店×商品×单位」，分母必须同粒度。门店级汇总照常可用（对表达式求和）。
--
-- 【为什么单开一张 mart，而不并进 fct_retail_sale】两者的**基面不同**：
--   · `fct_retail_sale` 的**销售侧**是「FINISHED + SALE_ORDER」，**不冲退货单**（平台 sale_money 语义）；
--     其**净额**自 2026-10-17 起已减退货侧（#813），退货谓词 = `like '%RETURN%' AND state='FINISHED'`
--     （**不含** REPAID_RETURN）——与本构件的 `state in ('FINISHED','REPAID')` **刻意不同**；
--   · 本构件的净销量按客户原文 `sale_num − return_num`，**必须把退货行减掉**。
--   同一个模型里塞两种基面，会让「口径只定义一次」变成「一个模型两套口径」——那是歧义温床。
--
-- 【⚠️ quantity 对退货行也是正数（真机实证 2026-10-17，3120 全量）】
--   所以净销量**只能按单据类型分类，不能靠符号**：
--     SALE_ORDER            FINISHED  416,516 行  713,804.49
--     SALE_ORDER            CANCELED    9,875 行   23,394.69   ← 作废销售，不计
--     FULL_ORDER_RETURN     FINISHED    1,569 行    5,240.70
--     PARTIAL_ORDER_RETURN  FINISHED      268 行      495.40
--     NO_ORDER_RETURN       FINISHED       49 行      131.51
--     REPAID_RETURN         REPAID      1,601 行    3,929.69
--     REPAID_RETURN         CANCELED       41 行      113.31   ← 作废退货，不计
--
-- 【两处解释性落地（客户原文没细到这一层，L1 标 experimental）】
--   ① `REPAID_RETURN`（已退款退货）**计入退货**；
--   ② `state=CANCELED` 的销售与退货**都不计**。
--   用 `like '%RETURN%'` 而不是枚举 IN：单据类型是**外部系统**的枚举，新增退货类型时
--   宁可自动纳入，也不要静默漏减（漏减 = 净销量虚高 = 覆盖天数虚高 = 补货决策偏保守）。
--
-- 【粒度】(system_book, bizday, branch_num) —— 与 fct_retail_sale 同粒度，便于消费面并排取用。
--
-- ── 影子列（聚合面组件化 P3.3 影子波 Task 5，issue #1031）────────────────────────────────
-- `sale_quantity` / `return_quantity` 是**旧实现**（手写 case-when 判别式，逐字未动）；生成区里的
-- `sale_quantity__gen` / `return_quantity__gen` 是同一口径的 measure 编译版（expr =
-- `sum(quantity)`，单据类型/状态过滤上移到基面 domain，由 `scripts/gen-fct-measures.mjs`
-- 生成——改声明后重跑生成器）。本阶段只**并行输出**、任何消费方都不许读；切换要等影子对账
-- `dbt/tests/lemeng/assert_fct_retail_quantity_measure_shadow_parity.sql` 稳定后另开笔
-- （本表指标 experimental ⇒ 对账窗口 7 天，certified 族的 14 天惯例不适用）。
-- 单侧缺行（该商品当日只有销售 / 只有退货）⇒ 该侧 `coalesce(…, 0)` 归零，与旧列同形。
-- `net_quantity` **无影子**：净销量不属任何单一 measure（与 retail 的 net_amount、expense 的
-- e_net 同款判例），仍由旧两列相减。
with base as (
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        case when order_transaction_type = 'SALE_ORDER' and state = 'FINISHED'
             then quantity else 0 end as sale_quantity,
        case when order_transaction_type like '%RETURN%' and state in ('FINISHED', 'REPAID')
             then quantity else 0 end as return_quantity
    from {{ ref('stg_lemeng_retail_order_line') }}
)
-- ⚠️ 逗号只能落在标记区**外**（区内逐字节受 `--check` 管），故单独起一行。
,
-- BEGIN GENERATED MEASURES
-- ⚠️ 本区由 scripts/gen-fct-measures.mjs 从 dbt/semantics/l1_metrics.yml 生成，**别手改**：
--    基面的 where 由组件 domain 派生、两阶段聚合由 measure 编译而来。改声明 → 重跑生成器 → 一并提交；
--    CI 的 `pnpm exec tsx scripts/gen-fct-measures.mjs --check` 逐字节比对本区，手改即红。
base_rq_sale as (
    select * from {{ ref('stg_lemeng_retail_order_line') }}
    where order_transaction_type = 'SALE_ORDER' and state = 'FINISHED'
),
sale_quantity__gen as (
    select system_book, bizday, branch_num, item_num, sum(quantity)::numeric(20,3) as sale_quantity__gen from base_rq_sale group by 1, 2, 3, 4
),
base_rq_return as (
    select * from {{ ref('stg_lemeng_retail_order_line') }}
    where order_transaction_type like '%RETURN%' and state in ('FINISHED', 'REPAID')
),
return_quantity__gen as (
    select system_book, bizday, branch_num, item_num, sum(quantity)::numeric(20,3) as return_quantity__gen from base_rq_return group by 1, 2, 3, 4
),
gen_agg as (
    select
        coalesce(sale_quantity__gen.system_book, return_quantity__gen.system_book) as system_book,
        coalesce(sale_quantity__gen.bizday, return_quantity__gen.bizday) as bizday,
        coalesce(sale_quantity__gen.branch_num, return_quantity__gen.branch_num) as branch_num,
        coalesce(sale_quantity__gen.item_num, return_quantity__gen.item_num) as item_num,
        sale_quantity__gen.sale_quantity__gen,
        return_quantity__gen.return_quantity__gen
    from sale_quantity__gen
    full join return_quantity__gen
        on  sale_quantity__gen.system_book = return_quantity__gen.system_book
        and sale_quantity__gen.bizday = return_quantity__gen.bizday
        and sale_quantity__gen.branch_num = return_quantity__gen.branch_num
        and sale_quantity__gen.item_num = return_quantity__gen.item_num
)
-- END GENERATED MEASURES
select
    base.system_book,
    {{ subject_org() }} as org,
    base.bizday,
    base.branch_num,
    base.item_num,
    sum(base.sale_quantity)::numeric(20, 3)                               as sale_quantity,
    sum(base.return_quantity)::numeric(20, 3)                             as return_quantity,
    (sum(base.sale_quantity) - sum(base.return_quantity))::numeric(20, 3) as net_quantity,
    -- 影子列 = sale_quantity / return_quantity 的 measure 编译版（P3.3 期不许被消费）。本表
    -- final SELECT 自带 group by（不像 Task 2/3 的 CTE 已聚合形态）⇒ gen_agg 列必须包聚合才能
    -- 进；gen_agg 按 fct 粒度唯一（两个 flat 聚合各 group by 同 4 键再 full join）⇒ left join
    -- 全键至多 1:1，组内恒单值，max 取常量/NULL，与裸 `coalesce(…, 0)` 语义逐行等价。
    -- gen_agg 行域是 base 全分组域的**子集**：两个行域都不命中的组（纯 CANCELED 单）在 gen_agg
    -- 无行——缺的恰是旧列两侧都为 0 的组，coalesce(…, 0) 补上；其余组恰 1 行匹配 ⇒ left join
    -- 不增删行（行集由 assert_fct_retail_quantity_grain_unique.sql 钉住）。
    coalesce(max(gen_agg.sale_quantity__gen), 0)::numeric(20, 3)          as sale_quantity__gen,
    coalesce(max(gen_agg.return_quantity__gen), 0)::numeric(20, 3)        as return_quantity__gen
from base
left join gen_agg
    on  base.system_book = gen_agg.system_book
    and base.bizday = gen_agg.bizday
    and base.branch_num = gen_agg.branch_num
    and base.item_num = gen_agg.item_num
group by base.system_book, base.bizday, base.branch_num, base.item_num
