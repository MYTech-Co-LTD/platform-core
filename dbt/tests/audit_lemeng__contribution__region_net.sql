-- audit_lemeng__contribution__region_net.sql — 指标的**独立复算**（对账）。
-- 直接打 parquet、不 ref 任何 mart/staging（走上游会让 cast 错同时污染两边 ⇒ 对账恒绿）。
--
-- ⚠️ 本指标是**门店域（transfer-only）**口径：只覆盖配送出库到门店的部分，**不含批发**——
-- 批发无法按 client_fid 归战区（出库侧无该列），其 region_id 是幻影战区。复算侧同样只算 transfer，
-- 两边口径必须一致，否则对账会因为「口径不同」而红，那是误报。
--
-- ⚠️ 比较的是「分母（R）/ 分子（N）」两列，不只是 N：两侧同为 0 时没有区分度。
with transfer_lines as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        r['out_money']::numeric   as out_money,
        r['subtotal']::numeric    as subtotal
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_transfer_out_prefix") }}/*/bizday=**/*.parquet'
    ) r
    where r['state_code']::int = 3
      and r['out_branch_num']::int = 99
      and r['branch_num']::int <> r['out_branch_num']::int
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
transfer_branch as (
    select system_book, bizday, branch_num,
           sum(out_money)::numeric(20, 2) as r_net,
           sum(subtotal)::numeric(20, 2)  as c_cost
    from transfer_lines group by 1, 2, 3
),
expense_branch as (
    select r['system_book']::varchar as system_book,
           r['bizday']::date         as bizday,
           r['branch_num']::int      as branch_num,
           (sum(case when r['direction']::varchar = '应付' then coalesce(r['amount']::numeric, 0) else 0 end)
          - sum(case when r['direction']::varchar = '应收' then coalesce(r['amount']::numeric, 0) else 0 end))::numeric(20, 2) as e_net
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_expense_prefix") }}/*/bizday=**/*.parquet'
    ) r
    group by 1, 2, 3
),
branch_latest as (
    -- dim_branch 是日更快照（每 snapshot 一份全量）——取最新一份，否则按 snapshot 放大。
    select system_book, branch_num, region_id
    from (
        select r['system_book']::varchar as system_book,
               r['branch_num']::int      as branch_num,
               r['region_id']::bigint    as region_id,
               row_number() over (
                   partition by r['system_book']::varchar, r['branch_num']::int
                   order by r['snapshot'] desc
               ) as rn
        from read_parquet(
            's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_prefix") }}/system_book=*/snapshot=**/*.parquet'
        ) r
    )
    where rn = 1
),
recheck as (
    -- 费用**只挂到有 transfer 的门店日**（与构件同口径）；无 transfer 的门店日费用不进本指标。
    select t.system_book, t.bizday, coalesce(b.region_id, 0)::bigint as region_id,
           sum(t.r_net)::numeric(20, 2) as r_store,
           sum((t.r_net - t.c_cost - coalesce(e.e_net, 0)))::numeric(20, 2) as n_store
    from transfer_branch t
    left join expense_branch e
           on e.system_book = t.system_book and e.bizday = t.bizday and e.branch_num = t.branch_num
    left join branch_latest b
           on b.system_book = t.system_book and b.branch_num = t.branch_num
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, region_id,
           sum(r_net_store)::numeric(20, 2) as r_store,
           sum(n_net_store)::numeric(20, 2) as n_store
    from {{ ref('fct_contribution') }}
    group by 1, 2, 3
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.region_id, b.region_id)     as region_id,
    a.r_store as recheck_r, b.r_store as materialized_r,
    a.n_store as recheck_n, b.n_store as materialized_n,
    '费用后贡献额（战区级/门店域）：复算与物化不一致（分母与分子各自比对）' as note
from recheck a
full join materialized b using (system_book, bizday, region_id)
-- ⚠️ **缺行 = 零贡献**（2026-10-17 真机实测后修正）：物化侧会有**复算侧不产生**的零值行——
--   幻影战区（批发行 region_id=9046，9 行）、expense-only 行（region_id=0，4 行）、
--   以及门店域为 0 的真战区行。它们的 `*_store` 恒为 0，对复算而言等价于「这一格不存在」。
--   直接用 `is distinct from` 会把「缺行 vs 0」判成不一致（首跑因此假红 13 行）。
--   **非零差异仍然会被抓住**：只有两侧都为零/缺失时才归一。
where coalesce(a.r_store, 0) is distinct from coalesce(b.r_store, 0)
   or coalesce(a.n_store, 0) is distinct from coalesce(b.n_store, 0)

union all

select null, null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null, null, null,
    '物化侧门店域合计全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where r_store <> 0 or n_store <> 0)
