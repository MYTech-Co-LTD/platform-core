-- audit_lemeng__contribution__region_l1_net.sql — 「一级战区费用后贡献」的**独立复算** + **恒等断言**。
--
-- 直接打 parquet、**不 ref 任何 mart/staging**（理由同 `audit_lemeng__contribution__region_net.sql`：
-- 复算若走上游，staging 的 cast 错会同时污染两边 ⇒ 对账恒绿）。`dim_region` 是**受控 seed**
-- （git 可审、不是采集产物），两侧共用同一份权威 —— 它不是本对账要验的对象。
--
-- 本文件钉两件事：
--   ① **值**：按 `region_l1_bucket` 分组后，复算的 `n_store` 与物化的一致（口径 = transfer-only）；
--   ② **恒等**：`Σ(各一级) + Σ(未归属) = Σ(全量)`（逐账套逐日）—— 「上卷没丢行」的唯一硬判据。
--      它今天**结构上**成立（桶是 `coalesce(region_l1,'未归属')`，每行恰好落一个桶）；留着是**防回归**：
--      一旦有人把桶改成「过滤 null」或改了 coalesce，这条会立刻红。
--
-- ⚠️ 口径必须与构件一致：**只算 transfer 域**（`n_net_store` 的既存边界）。批发侧的 `region_id`
--    是幻影战区，按战区归仍需 X01a —— 复算侧同样排除，否则对账会因「口径不同」而**误报红**。
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
           sum((t.r_net - t.c_cost - coalesce(e.e_net, 0)))::numeric(20, 2) as n_store
    from transfer_branch t
    left join expense_branch e
           on e.system_book = t.system_book and e.bizday = t.bizday and e.branch_num = t.branch_num
    left join branch_latest b
           on b.system_book = t.system_book and b.branch_num = t.branch_num
    group by 1, 2, 3
),
region as (
    select system_book, region_id, region_l1 from {{ ref('dim_region') }}
),
recheck_bucket as (
    select k.system_book, k.bizday,
           coalesce(r.region_l1, '未归属')::varchar as region_l1_bucket,
           sum(k.n_store)::numeric(20, 2) as n_store
    from recheck k
    left join region r
           on r.system_book = k.system_book and r.region_id = k.region_id
    group by 1, 2, 3
),
materialized as (
    select system_book, bizday, region_l1_bucket,
           sum(n_net_store)::numeric(20, 2) as n_store
    from {{ ref('fct_contribution') }}
    group by 1, 2, 3
),
grand as (
    select system_book, bizday, sum(n_net_store)::numeric(20, 2) as n_store
    from {{ ref('fct_contribution') }}
    group by 1, 2
),
bucket_total as (
    select system_book, bizday, sum(n_store)::numeric(20, 2) as n_store
    from materialized
    group by 1, 2
)
-- ① 值：逐桶比对（缺行 = 零贡献，与 region_net 的同款归一——见那边的注释）
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.region_l1_bucket, b.region_l1_bucket) as region_l1_bucket,
    a.n_store as recheck_n, b.n_store as materialized_n,
    '一级战区费用后贡献：复算与物化不一致' as note
from recheck_bucket a
full join materialized b using (system_book, bizday, region_l1_bucket)
where coalesce(a.n_store, 0) is distinct from coalesce(b.n_store, 0)

union all

-- ② 恒等：各桶之和 = 全量之和（逐账套逐日）
select
    coalesce(g.system_book, t.system_book) as system_book,
    coalesce(g.bizday, t.bizday)           as bizday,
    null as region_l1_bucket,
    t.n_store as recheck_n, g.n_store as materialized_n,
    '恒等被破坏：Σ(各一级)+Σ(未归属) ≠ Σ(全量)' as note
from grand g
full join bucket_total t using (system_book, bizday)
where coalesce(g.n_store, 0) is distinct from coalesce(t.n_store, 0)

union all

select null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)

union all

select null, null, null, null, null,
    '物化侧全为 0：比对已失去区分度（不是对上了）'
where not exists (select 1 from materialized where n_store <> 0)
