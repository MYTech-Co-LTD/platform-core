-- audit_retail__order_count.sql — 指标 `retail:order_count` 的**独立复算**（对账）。
--
-- 契约与理由同 audit_retail__net_sales.sql（dbt singular test：**返回任何行即失败**；
-- 独立复算的「为什么要刻意重复 cast」那段在那边写透了，这里不复制正文）。
-- 文件名由指标名经 `:` → `__` 映射得出（唯一事实源 = scripts/check-data-models.mjs 的
-- metricToAuditFileName()）。
--
-- ⚠️ 本指标是**暂定**的（见 l1_metrics.yml 的 `retail:order_count` 与 README 的「实证 vs 暂定」表）：
--    依赖 staging 的 `order_no` 列 —— 列名与去重语义待 T6 按实测样本核对。本对账能保证的只是
--    「marts 与 parquet 两边算的是同一件事」，**保证不了**「order_no 就是业务意义上的单号」。
--    这条边界写在这里，免得将来把「对账绿」读成「口径已确认」。
with r as (
    select * from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_prefix") }}/{{ var("account_book") }}/**/*.parquet'
    )
),
recheck as (
    select
        '{{ var("account_book") }}' as system_book,
        try_strptime(r['order_detail_bizday'], '%Y%m%d')::date as bizday,
        count(distinct r['order_no']) as order_count
    from r
    group by 1, 2
),
materialized as (
    select
        system_book,
        bizday,
        order_count
    from {{ ref('fct_retail_sale') }}
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.order_count                          as recheck_value,
    b.order_count                          as materialized_value,
    '复算与物化结果不一致'                  as note
from recheck a
full join materialized b using (system_book, bizday)
where a.order_count is distinct from b.order_count

union all

select
    null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
