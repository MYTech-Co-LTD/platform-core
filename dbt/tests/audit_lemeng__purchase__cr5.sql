-- audit_lemeng__purchase__cr5.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 比较的是「分子 top5_p / 分母 total_p / 商」三样，不只是商（W1 `return_rate` 的教训）。
-- ⚠️ **缺行 = 零贡献**（W2 的教训）：物化侧可能有复算侧不产生的零值行，用 coalesce 归一。
--
-- 口径（构件头注已详述，此处不复制）：净采购额 = Σ(purchase_item_money − purchase_item_return_money)；
-- 分子只取净额 > 0 的前 5 家；分母含全部供应商；**(未映射) 部门的处理两侧必须一致**。
with purchase as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['supplier_num']::bigint as supplier_num,
        r['item_num']::bigint     as item_num,
        (coalesce(r['purchase_item_money']::numeric, 0)
       - coalesce(r['purchase_item_return_money']::numeric, 0)) as net_p
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_purchase_prefix") }}/*/bizday=**/*.parquet'
    ) r
),
item_latest as (
    -- dim_item 是快照表：取最新一份，否则按 snapshot 放大（与构件同范式）。
    select system_book, item_num, item_department_name
    from (
        select
            r['system_book']::varchar as system_book,
            r['item_num']::bigint     as item_num,
            coalesce(nullif(r['item_department_name']::varchar, ''), '(未映射)') as item_department_name,
            row_number() over (
                partition by r['system_book']::varchar, r['item_num']::bigint
                order by r['snapshot'] desc
            ) as rn
        from read_parquet(
            's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_prefix") }}/system_book=*/snapshot=**/*.parquet'
        ) r
    ) t
    where rn = 1
),
supplier_period as (
    select
        p.system_book,
        date_trunc('month', p.bizday)::date as bizday,
        coalesce(i.item_department_name, '(未映射)') as item_department,
        p.supplier_num,
        sum(p.net_p)::numeric(20, 2) as net_p
    from purchase p
    left join item_latest i
           on i.system_book = p.system_book and i.item_num = p.item_num
    group by 1, 2, 3, 4
),
recheck as (
    select
        tot.system_book, tot.bizday, tot.item_department,
        coalesce(top.top5_p, 0)::numeric(20, 2) as top5_p,
        tot.total_p::numeric(20, 2)             as total_p
    from (
        select system_book, bizday, item_department, sum(net_p)::numeric(20, 2) as total_p
        from supplier_period group by 1, 2, 3
    ) tot
    left join (
        select system_book, bizday, item_department,
               sum(case when rn <= 5 then net_p else 0 end)::numeric(20, 2) as top5_p
        from (
            select system_book, bizday, item_department, net_p,
                   row_number() over (
                       partition by system_book, bizday, item_department
                       order by net_p desc
                   ) as rn
            from supplier_period
            where net_p > 0
        ) rk
        group by 1, 2, 3
    ) top
           on top.system_book = tot.system_book
          and top.bizday = tot.bizday
          and top.item_department = tot.item_department
),
materialized as (
    select system_book, bizday, item_department,
           sum(top5_p)::numeric(20, 2)  as top5_p,
           sum(total_p)::numeric(20, 2) as total_p
    from {{ ref('fct_purchase_concentration') }}
    group by 1, 2, 3
)
select
    coalesce(a.system_book, b.system_book)           as system_book,
    coalesce(a.bizday, b.bizday)         as bizday,
    coalesce(a.item_department, b.item_department)   as item_department,
    a.top5_p as recheck_top5, b.top5_p as materialized_top5,
    a.total_p as recheck_total, b.total_p as materialized_total,
    a.top5_p / nullif(a.total_p, 0) as recheck_rate,
    b.top5_p / nullif(b.total_p, 0) as materialized_rate,
    '供应商集中度 CR5：复算与物化不一致（分子/分母/商各自比对）' as note
from recheck a
full join materialized b
       on b.system_book = coalesce(a.system_book, b.system_book)
      and b.bizday = coalesce(a.bizday, b.bizday)
      and b.item_department = coalesce(a.item_department, b.item_department)
-- ⚠️ 缺行 = 零贡献（W2 教训）：物化侧有复算侧不产生的零值行时，直接 is distinct from 会假红。
where coalesce(a.top5_p, 0) is distinct from coalesce(b.top5_p, 0)
   or coalesce(a.total_p, 0) is distinct from coalesce(b.total_p, 0)
   or coalesce(a.top5_p, 0) / nullif(coalesce(a.total_p, 0), 0)
      is distinct from coalesce(b.top5_p, 0) / nullif(coalesce(b.total_p, 0), 0)

union all

select null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null, null,
    '物化侧分子分母全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where top5_p <> 0 or total_p <> 0)
