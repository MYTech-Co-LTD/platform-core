-- audit_lemeng__retail__order_line.sql — 指标 `lemeng:retail:order_line` 的**独立复算**（对账）。
--
-- 契约与理由同 audit_lemeng__retail__net_sales.sql（dbt singular test：**返回任何行即失败**；
-- 独立复算的「为什么要刻意重复 cast」那段在那边写透了，这里不复制正文）。
-- 文件名由指标名经 `:` → `__` 映射得出（唯一事实源 = scripts/check-data-models.mjs 的
-- metricToAuditFileName()）。
--
-- ── 本指标的复算面与别的指标**不同**，说清楚 ───────────────────────────────────────────
-- 该指标是**明细透传**（grain 放全 26 列 ⇒ 每个分组恒为一行），它**不承载口径**：销售/退货的
-- 判别式、赠品排除全在 `fct_*` 那族里。所以本对账**不复算口径**，只回答一个问题：
-- **「物化进 PG 的明细表，与湖里的 parquet 是不是同一件事」**——即 staging 这一跳有没有
-- 静默丢行 / 丢列 / cast 错。判据取**行数 + sale_money 合计**按 (账套 × 业务日) 对齐。
--
-- ⚠️ 本对账**保证不了**的事（免得将来把「对账绿」读成「明细口径已确认」）：
--    它逐行比对不了**行内容**（只比每分区的行数与金额合计）——同一分区内「A 行换成 B 行、
--    行数金额恰好不变」这类置换它抓不到。要逐行比对得比全键哈希，成本与收益不成比例，故不做。
--
-- ── 形态：与 staging / 另一条 audit **同一套实测形态**（2026-09-24 数据面真机）────────────
-- 取列用 `from read_parquet(…) r` + `r['列名']`（别名挂函数调用上，不是 CTE：CTE 形态取列报
-- `cannot subscript type record`）；`hive_partitioning=1` / `hive_types` 不能作 read_parquet 形参
-- （pg_duckdb 的 read_parquet 是 PG 函数、只认位置参数），分区推断默认生效。
-- 湖读取走**冷热两腿合流**（#984）：day 天文件 + hour 小时文件**各自单读**，热腿排除已封版日
-- （同 staging 冷热合流，含封版排除语义）——原双 glob 一把读在封窗日双计。
with recheck_raw as (
    -- 冷腿：已封版日的**天文件**
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['sale_money']::numeric  as sale_money
    from read_parquet(
        -- ⚠️ 与 staging **同路径**（通配两账套，含封版排除语义）——对账必须与受测面同口径，否则只对账了 3120（issue #250）。
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAY_DATA/system_book=*/bizday=*/all.parquet'
    ) r
    -- ⚠️ 只比**已闭窗营业日**（bizday < 上海今天）：今天的文件被 tick 重写 ⇒ 与物化建表互撞
    --    ETag 竞态、报 ERROR（实测 2026-10-06 run `jrun_dtyVWZnnFaQ_pCCN` attempt 1）。
    --    今天未定稿不判；两侧都滤，才是同量对比。
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)

    union all

    -- 热腿：未封版日的小时文件——排除已封版日（同 stg 冷热合流，#984）
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['sale_money']::numeric  as sale_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/bizday=*/hour=*/all.parquet'
    ) r
    where r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and not exists (select 1 from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAILY/*.parquet') m where cast(m['system_book'] as varchar) = cast(r['system_book'] as varchar) and cast(m['bizday'] as date) = cast(r['bizday'] as date))
),
recheck as (
    select
        system_book,
        bizday,
        count(*)::bigint              as line_count,
        sum(sale_money)::numeric(20,2) as sale_money_sum
    from recheck_raw
    group by 1, 2
),
materialized as (
    select
        system_book,
        bizday,
        count(*)::bigint              as line_count,
        sum(sale_money)::numeric(20,2) as sale_money_sum
    from {{ ref('stg_lemeng_retail_order_line') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    a.line_count                           as recheck_lines,
    b.line_count                           as materialized_lines,
    a.sale_money_sum                       as recheck_amount,
    b.sale_money_sum                       as materialized_amount,
    '复算与物化不一致（明细透传：湖 parquet vs stg_lemeng_retail_order_line，按账套×业务日对齐行数与金额合计）' as note
from recheck a
full join materialized b using (system_book, bizday)
-- 金额用 numeric(20,2) 双侧对齐（= 1 分容差，同 #957）——全精度直接比必假红。
-- 行数无精度问题，逐行严格比。
where a.line_count     is distinct from b.line_count
   or a.sale_money_sum is distinct from b.sale_money_sum

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
