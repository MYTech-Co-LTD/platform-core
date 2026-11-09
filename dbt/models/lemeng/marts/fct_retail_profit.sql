{{ config(
    materialized='incremental',
    unique_key=['system_book', 'bizday', 'branch_num'],
    incremental_strategy='delete+insert',
    on_schema_change='sync_all_columns'
) }}

-- fct_retail_profit.sql — 零售毛利事实（store×day；来源 AMAREPORT 商品毛利分析 item_profit）。
--
-- ★ 口径（B11：只在 dbt 定义一次）：
--   · sale_money              = 销售收入（含券）
--   · sale_money_no_coupon    = 销售收入（不含券，**主口径**）
--   · sale_cost               = 销售成本（源侧需成本查询权限；缺权限时列可能为空/整行缺失）
--   · profit_money            = 毛利（含券）= sale_money − sale_cost
--   · profit_money_no_coupon  = 毛利（不含券）= sale_money_no_coupon − sale_cost
--   · item_count              = 该店日有毛利记录的商品数（覆盖度观察，不是口径）
--   · costed_item_count       = 其中**带成本**的商品数；costed < item 时 profit 不可信
--
-- ★ 对账锚（2026-10-13，店 92）：sale 4,463.29 / cost 2,596.94 / profit 1,866.35；
--   与 fct_retail_sale 同日同店 net_amount 4,463.29 **逐分对平**（退货 0）。
--   ⚠️ 与 net_sales 的关系：item_profit 的 sale_money 当前与净销售额同值；若未来源侧
--   改为「原额」口径，必须回来改 definition 并重跑对账，不许在这里悄悄加减。
--   ⚠️ 成本缺失时 profit 不可信：消费面必须带覆盖率/`unreliable` 标记，不拿成本列当分母。
--
-- ★ 粒度：(system_book, bizday, branch_num)。唯一性由
--   `assert_fct_retail_profit_grain_unique` 钉住；`org` 由 subject_org 宏注入常量，不参与口径。
--
-- ★ 精度：聚合结果显式 `::numeric(20,2)`（pg_duckdb 对无精度 numeric 拒绝跨引擎查询，
--   同 fct_retail_sale 头注的实测原文）。
with src as (
    select
        system_book,
        bizday,
        branch_num,
        sum(sale_money)::numeric(20,2)              as sale_money,
        sum(sale_money_no_coupon)::numeric(20,2)    as sale_money_no_coupon,
        sum(sale_cost)::numeric(20,2)               as sale_cost,
        sum(profit_money)::numeric(20,2)            as profit_money,
        sum(profit_money_no_coupon)::numeric(20,2)  as profit_money_no_coupon,
        count(*)                                    as item_count,
        count(profit_money_no_coupon)               as costed_item_count
    from {{ ref('stg_lemeng_item_profit') }}
    where 1 = 1
    {% if is_incremental() %}
    and bizday >= {{ incremental_cutoff(7) }}
    {% endif %}
    {% if env_var('MAT_CLOSED_BEFORE', 'false') == 'true' %}
    -- 物化闭窗读：当天分区可能尚未完整落地；与零售 tick 模型同一纪律。
    and bizday < current_date
    {% endif %}
    group by 1, 2, 3
)

select
    {{ subject_org() }}                       as org,
    system_book,
    bizday,
    branch_num,
    coalesce(sale_money, 0)                   as sale_money,
    coalesce(sale_money_no_coupon, 0)         as sale_money_no_coupon,
    coalesce(sale_cost, 0)                    as sale_cost,
    coalesce(profit_money, 0)                 as profit_money,
    coalesce(profit_money_no_coupon, 0)       as profit_money_no_coupon,
    coalesce(item_count, 0)::bigint           as item_count,
    coalesce(costed_item_count, 0)::bigint    as costed_item_count
from src
