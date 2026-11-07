{{ config(tags=['audit_window']) }}
-- audit_lemeng__inventory__money.sql — 库存金额指标的独立复算。
-- 契约与形态同 audit_lemeng__inventory__quantity.sql（那边写透了，不复制正文）。
-- 【窗口化 #1614】tags 加 audit_window：每小时档经 window_read_parquet 把湖读取收进
--   `AUDIT_WINDOW_PATTERNS` 月段字符类（路径级裁剪），mart 侧同窗（window_start_date）。
--   env 未设（每日全史 audit job）时宏原样全史 glob，覆盖不变。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['storehouse_num']::bigint as storehouse_num,
        r['item_num']::bigint     as item_num,
        sum(r['inventory_money']::numeric(20,2))::numeric(20,2) as inv_money  -- 裸 ::numeric 默认 3 位小数 ⇒ cast 带显式刻度
    from {{ window_read_parquet(
        's3://' ~ var('zos_bucket') ~ '/' ~ var('lemeng_inventory_snapshot_prefix') ~ '/*/bizday=**/*.parquet'
    ) }} r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    and r['bizday']::date >= date '{{ window_start_date() }}'
    group by 1, 2, 3, 4, 5
),
materialized as (
    select system_book, bizday, branch_num, storehouse_num, item_num, inventory_money
    from {{ ref('fct_inventory_snapshot') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= date '{{ window_start_date() }}'
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    coalesce(a.storehouse_num, b.storehouse_num) as storehouse_num,
    coalesce(a.item_num, b.item_num)       as item_num,
    a.inv_money as recheck_value,
    b.inventory_money as materialized_value,
    '库存金额：复算与物化结果不一致' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num, storehouse_num, item_num)
where a.inv_money is distinct from b.inventory_money

union all

select
    null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
