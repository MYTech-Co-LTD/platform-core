-- audit_retail__net_sales.sql — 指标 `retail:net_sales` 的**独立复算**（对账）。
--
-- 契约：dbt 的 singular test **返回任何行即失败** ⇒ 本查询只在「复算 ≠ 物化结果」时出行。
-- 文件名由指标名经 `:` → `__` 映射得出（唯一事实源 = scripts/check-data-models.mjs 的
-- metricToAuditFileName()；同名唯一 + 每个指标一条对账由该门禁的规则 ⑥⑦ 机检）。
--
-- 为什么必须**独立复算**（layered §7 硬约束 7 的原话：**cast 错了静默，只有它能抓**）：
--   staging 把 VARCHAR 手写 cast 成 numeric，cast 写错（截断、取整、精度丢了）**不会报任何错**，
--   dbt 的列级 tests（not_null / accepted_values）也一条都不会红 —— 只有另一条**独立读同一份
--   原始数据**的表达式能发现两边对不上。
--
-- ★ 本文件**刻意重复**一次读路径与 cast（不 ref staging、也不 ref marts）。这不是冗余，是方法：
--    若复算走 staging，staging 的 cast 错会**同时**污染两边 ⇒ 对账恒等、永远绿（这正是
--    「对账看着有、其实没用」的形态）。故复算直接打 parquet，与 staging 的 cast 各自独立写。
--    （与 staging 的差异面：这里用 `::numeric` 兜精度、按 `order_detail_bizday` 分组 —— 与 marts
--      的 grain 对齐。两边都错成同一个值的概率远低于一边错。）
--
-- ⚠️ 空集也是坑：两边都为空时本查询返回 0 行 = 通过，而那个「通过」毫无信息量。故末尾有
--    **空转自检**（物化侧一行都没有 ⇒ 出行）。同族先例：check-tenant-isolation 的空转自检。
--
-- ⚠️ 形态待 T6 实测（与 staging 同一批 gate）：`r['列名']` 的取列形态、`try_strptime` 是否可在
--    pg_duckdb 会话内用、`::date` 的 cast 目标 —— 三者以真机为准（本机无 pg_duckdb，未验）。
with r as (
    select * from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_prefix") }}/{{ var("account_book") }}/**/*.parquet'
    )
),
recheck as (
    -- 复算：绕开 staging 与 marts，直接打 parquet，按 marts 的粒度 (system_book, bizday) 聚合
    select
        '{{ var("account_book") }}' as system_book,
        try_strptime(r['order_detail_bizday'], '%Y%m%d')::date as bizday,
        sum(r['amount']::numeric) as net_sales
    from r
    group by 1, 2
),
materialized as (
    select
        system_book,
        bizday,
        net_amount as net_sales
    from {{ ref('fct_retail_sale') }}
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.net_sales                            as recheck_value,
    b.net_sales                            as materialized_value,
    '复算与物化结果不一致'                  as note
from recheck a
full join materialized b using (system_book, bizday)
where a.net_sales is distinct from b.net_sales

union all

select
    null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
