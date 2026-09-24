-- audit_retail__net_sales.sql — 指标 `retail:net_sales` 的**独立复算**（对账）。
--
-- 契约：dbt 的 singular test **返回任何行即失败** ⇒ 本查询只在「复算 ≠ 物化结果」时出行。
-- 文件名由指标名经 `:` → `__` 映射得出（唯一事实源 = scripts/check-data-models.mjs 的
-- metricToAuditFileName()；同名唯一 + 每个指标一条对账由该门禁的规则 ⑥⑦ 机检）。
--
-- 为什么必须**独立复算**（layered §7 硬约束 7 的原话：**cast 错了静默，只有它能抓**）：
--   cast 写错（截断、取整、精度丢了）**不会报任何错**，dbt 的列级 tests（not_null /
--   accepted_values）也一条都不会红 —— 只有另一条**独立读同一份原始数据**的表达式能发现两边对不上。
--
-- ★ 本文件**刻意重复**一次读路径与 cast（不 ref staging、也不 ref marts）。这不是冗余，是方法：
--    若复算走 staging，staging 的 cast 错会**同时**污染两边 ⇒ 对账恒等、永远绿（这正是
--    「对账看着有、其实没用」的形态）。故复算直接打 parquet，与 staging 的 cast 各自独立写。
--    ⚠️ **换源（2026-09-24，S1 Task 9）时依然照此原则**：读路径随 fct 一起换到新湖，但**不**改成
--    `ref('stg_lemeng_retail_order_line')` —— 那样 staging 的错会同时污染两侧、对账恒绿。
--
-- ⚠️ 空集也是坑：两边都为空时本查询返回 0 行 = 通过，而那个「通过」毫无信息量。故末尾有
--    **空转自检**（物化侧一行都没有 ⇒ 出行）。同族先例：check-tenant-isolation 的空转自检。
--
-- ── 形态：与 staging **同一套实测形态**（2026-09-24 数据面真机）──────────────────────────
-- ① 取列：`from read_parquet('…') r` + `r['列名']` —— 别名必须挂在**函数调用**上；
--    `with r as (select * from read_parquet('…'))` 那种 CTE 形态在本栈上取列即报
--    `ERROR: cannot subscript type record because it does not support subscripting`（见 staging 头注）。
-- ② `hive_partitioning=1`（或 `hive_types`）**不能写成 read_parquet 的形参**：pg_duckdb 的
--    read_parquet 是 PG 函数、只认位置参数（实测 `ERROR: column "hive_partitioning" does not exist`）。
--    分区推断本身默认生效（`hive_partitioning=auto`，路径 `key=value` 段自动成列），故无需开关；
--    推断类型不合约（system_book→bigint）⇒ 本文件显式 cast，与 staging 各自写一次。
-- ③ 两侧口径必须**同量**：都按 (system_book, bizday) 聚合，与 l1_metrics.yml 的 `grain` 一致。
with recheck as (
    -- 复算：绕开 staging 与 marts，直接打 parquet，按 marts 的粒度 (system_book, bizday) 聚合。
    -- system_book / bizday / sale_money 都是**湖里的真列**（不再有 var 注入账套、也不再有
    -- try_strptime 解析业务日字符串 —— 那是旧湖的形态）。
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        sum(r['sale_money'])      as net_sales
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book={{ var("account_book") }}/**/*.parquet'
    ) r
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
