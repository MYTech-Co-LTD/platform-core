-- audit_lemeng__expense__subsidy_rate.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 比较的是「分子 S / 分母 R / 商」三样，不只是商（W1 `return_rate` 的教训：两侧同为 0 时
-- 比较 0 vs 0 等于没验）。本指标真机上 S≈6 千、R≈百万级，都有区分度。两侧各自算商。
--
-- 口径：S = 补贴类费用净额。⚠️ **筛选字面量按真机实测取值**（2026-10-16 全量分组：
-- 只有 `抖音直播补贴`；客户文档 03-04 另提的「小程序或线下补贴」**在数据里不存在**）。
-- 若将来出现新字面量，本文件与 l1_metrics.yml 的 definition、以及构件里的筛选**三处都要改**。
with transfer_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['out_money']::numeric   as out_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
transfer_branch as (
    select system_book, bizday, branch_num, sum(out_money)::numeric(20, 2) as r_store
    from transfer_lines group by 1, 2, 3
),
subsidy_branch as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['branch_num']::int      as branch_num,
           (sum(case when r['direction']::varchar = '应付' then coalesce(r['amount']::numeric, 0) else 0 end)
          - sum(case when r['direction']::varchar = '应收' then coalesce(r['amount']::numeric, 0) else 0 end))::numeric(20, 2) as s
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['expense_type']::varchar = '抖音直播补贴'
    group by 1, 2, 3
),
recheck as (
    select
        coalesce(l.system_book, t.system_book) as system_book,
        coalesce(l.bizday, t.bizday)           as bizday,
        coalesce(l.branch_num, t.branch_num)   as branch_num,
        coalesce(l.s, 0)::numeric(20, 2)       as s,
        coalesce(t.r_store, 0)::numeric(20, 2) as r_store
    from subsidy_branch l
    full join transfer_branch t
           on l.system_book = t.system_book and l.bizday = t.bizday and l.branch_num = t.branch_num
),
materialized as (
    select system_book, bizday, branch_num,
           sum(q_subsidy)::numeric(20, 2)   as s,
           sum(r_net_store)::numeric(20, 2) as r_store
    from {{ ref('fct_contribution') }}
    group by 1, 2, 3
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.s as recheck_s, b.s as materialized_s,
    a.r_store as recheck_r, b.r_store as materialized_r,
    a.s / nullif(a.r_store, 0) as recheck_rate,
    b.s / nullif(b.r_store, 0) as materialized_rate,
    '门店补贴率：复算与物化不一致（分子/分母/商各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
-- ⚠️ **缺行 = 零贡献**（2026-10-17 真机实测后修正）：物化侧有复算侧不产生的零值行
--   （批发行 branch_num=99、以及门店域合计为 0 的门店日）。直接 `is distinct from`
--   会把「缺行 vs 0」判成不一致（首跑因此假红 41 行）。非零差异仍会被抓住。
where coalesce(a.s, 0) is distinct from coalesce(b.s, 0)
   or coalesce(a.r_store, 0) is distinct from coalesce(b.r_store, 0)
   or coalesce(a.s, 0) / nullif(coalesce(a.r_store, 0), 0)
      is distinct from coalesce(b.s, 0) / nullif(coalesce(b.r_store, 0), 0)

union all

select null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null, null,
    '物化侧分子分母全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where s <> 0 or r_store <> 0)
