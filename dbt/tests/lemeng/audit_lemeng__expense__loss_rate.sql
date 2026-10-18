-- audit_lemeng__expense__loss_rate.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 比较的是「分子 Q / 分母 R / 商」三样，不只是商——W1 `return_rate` 那条两侧同为 0、
-- 比较 0 vs 0 等于没验。这里分子分母各自比对；本指标真机上 Q≈1.7 万、R≈百万级，都有区分度。
-- 两侧**各自算商**：分母 0 的行两侧同为 null（含「当天有费用、无出库」的 orphan 行），不误报。
--
-- 口径：Q = 补损类费用净额（`产品售后补损`，真机实测字面量）；R = 同门店同期间**配送出库净额**
-- （门店域/transfer-only）。分子含「当天无出库的门店日」的费用行——构件的 orphan 行也带 q_loss，
-- 复算若按门店过滤就会漏掉它们（两侧一起错）。
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
loss_branch as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['branch_num']::int      as branch_num,
           (sum(case when r['direction']::varchar = '应付' then coalesce(r['amount']::numeric, 0) else 0 end)
          - sum(case when r['direction']::varchar = '应收' then coalesce(r['amount']::numeric, 0) else 0 end))::numeric(20, 2) as q
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['expense_type']::varchar = '产品售后补损'
    group by 1, 2, 3
),
recheck as (
    select
        coalesce(l.system_book, t.system_book) as system_book,
        coalesce(l.bizday, t.bizday)           as bizday,
        coalesce(l.branch_num, t.branch_num)   as branch_num,
        coalesce(l.q, 0)::numeric(20, 2)       as q,
        coalesce(t.r_store, 0)::numeric(20, 2) as r_store
    from loss_branch l
    full join transfer_branch t
           on l.system_book = t.system_book and l.bizday = t.bizday and l.branch_num = t.branch_num
),
materialized as (
    select system_book, bizday, branch_num,
           sum(q_loss)::numeric(20, 2)     as q,
           sum(r_net_store)::numeric(20, 2) as r_store
    from {{ ref('fct_contribution') }}
    group by 1, 2, 3
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.q as recheck_q, b.q as materialized_q,
    a.r_store as recheck_r, b.r_store as materialized_r,
    a.q / nullif(a.r_store, 0) as recheck_rate,
    b.q / nullif(b.r_store, 0) as materialized_rate,
    '门店补损率：复算与物化不一致（分子/分母/商各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
-- ⚠️ **缺行 = 零贡献**（2026-10-17 真机实测后修正）：物化侧有复算侧不产生的零值行——
--   批发行（branch_num=99，q=0 且 r_store=0）、以及门店域合计为 0 的门店日。
--   直接 `is distinct from` 会把「缺行 vs 0」判成不一致（首跑因此假红 24 行）。
--   非零差异仍会被抓住。
where coalesce(a.q, 0) is distinct from coalesce(b.q, 0)
   or coalesce(a.r_store, 0) is distinct from coalesce(b.r_store, 0)
   or coalesce(a.q, 0) / nullif(coalesce(a.r_store, 0), 0)
      is distinct from coalesce(b.q, 0) / nullif(coalesce(b.r_store, 0), 0)

union all

select null, null, null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null, null, null,
    '物化侧分子分母全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where q <> 0 or r_store <> 0)
