{{ config(
    materialized='incremental',
    unique_key=['system_book', 'bizday', 'branch_num', 'item_num'],
    incremental_strategy='delete+insert',
    on_schema_change='sync_all_columns'
) }}

-- fct_retail_item_profit.sql — 零售商品毛利事实（门店×日×商品；来源 item_profit）。
--
-- 用途：日报/根因的**商品级**读面。fct_retail_profit 是 store×day 汇总，无法回答
-- 「哪几个商品造成了今天营业额/毛利下降」；本表把 item_profit 的商品粒度保留下来，
-- 供有界根因探针按 item_num 做单日 variance。
--
-- 口径与 fct_retail_profit 同源：profit_money_no_coupon（不含券主口径），
-- 成本缺失时 costed_item_count < item_count，消费面必须标 unreliable。
-- 粒度：(system_book, bizday, branch_num, item_num)。
with src as (
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        any_value(item_name)                        as item_name,
        sum(sale_num)::numeric(20,4)                as sale_num,
        sum(sale_money)::numeric(20,2)              as sale_money,
        sum(sale_money_no_coupon)::numeric(20,2)    as sale_money_no_coupon,
        sum(sale_cost)::numeric(20,2)               as sale_cost,
        sum(profit_money_no_coupon)::numeric(20,2)  as profit_money_no_coupon,
        count(*)                                    as item_count,
        count(profit_money_no_coupon)               as costed_item_count
    from {{ ref('stg_lemeng_item_profit') }}
    where 1 = 1
    {% if is_incremental() %}
    and bizday >= {{ incremental_cutoff(7) }}
    {% endif %}
    {% if env_var('MAT_CLOSED_BEFORE', 'false') == 'true' %}
    and bizday < current_date
    {% endif %}
    group by 1, 2, 3, 4
)

select
    {{ subject_org() }}                       as org,
    system_book,
    bizday,
    branch_num,
    item_num,
    item_name,
    coalesce(sale_num, 0)                     as sale_num,
    coalesce(sale_money, 0)                   as sale_money,
    coalesce(sale_money_no_coupon, 0)         as sale_money_no_coupon,
    coalesce(sale_cost, 0)                    as sale_cost,
    coalesce(profit_money_no_coupon, 0)       as profit_money_no_coupon,
    coalesce(item_count, 0)::bigint           as item_count,
    coalesce(costed_item_count, 0)::bigint    as costed_item_count
from src
