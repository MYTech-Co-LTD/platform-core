-- audit_lemeng__retail__order_count.sql — 指标 `lemeng:retail:order_count` 的**独立复算**（对账）。
--
-- 契约与理由同 audit_lemeng__retail__net_sales.sql（dbt singular test：**返回任何行即失败**；
-- 独立复算的「为什么要刻意重复 cast」那段在那边写透了，这里不复制正文）。
-- 文件名由指标名经 `:` → `__` 映射得出（唯一事实源 = scripts/check-data-models.mjs 的
-- metricToAuditFileName()）。
--
-- ⚠️ 本指标的「暂定」**收窄到语义面**（2026-09-25 订正；三处同源 = 本头注 /
--    `l1_metrics.yml` 的 `lemeng:retail:order_count` / `dbt/README.md` §8 的 `order_no` 行）：
--    **已证**的只是 `order_no` 列**存在且非空**（新湖契约列 `nullable=false` + 管线 `qa.contract`
--    非空闸 + 2026-09-24 真机 `not_null_stg_lemeng_retail_order_line_order_no` 过，列名与类型合契约）；
--    **未证**的是「该列**就是业务意义上的单号**」与 `count(distinct order_no)` 的**去重语义**，
--    以及 **order_no 的跨门店唯一性**（2026-10-12 W0 粒度扩到门店后，上滚 = 各门店日去重之和，
--    跨门店重号会被重复计入——声明侧已写为已知边界）——这些都属**口径转正**（S5）。本对账能
--    保证的只是「marts 与 parquet 两边算的是同一件事」，**保证不了**「order_no 就是业务意义上
--    的单号」。这条边界写在这里，免得将来把「对账绿」读成「口径已确认」。
--
-- ── 口径（2026-10-12 W0 随 #430 定案更新）───────────────────────────────────────────────
--    有效订单 = state=FINISHED 且 order_transaction_type=SALE_ORDER 的去重订单笔数
--    （与净销售额同基面，换货单算一单）。粒度 = 账套 × 业务日 × 门店。
--
-- ── 形态：与 staging / 另一条 audit **同一套实测形态**（2026-09-24 数据面真机）────────────
-- 取列用 `from read_parquet('…') r` + `r['列名']`（别名挂函数调用上，不是 CTE：CTE 形态取列报
-- `cannot subscript type record`）；`hive_partitioning=1` / `hive_types` 不能作 read_parquet 形参
-- （pg_duckdb 的 read_parquet 是 PG 函数、只认位置参数），分区推断默认生效。详见 staging 头注。
-- `bizday` 是**湖里的真列**（管线已定型为 date）⇒ 不再有 `try_strptime(order_detail_bizday)`。
with recheck as (
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        count(distinct r['order_no']) as order_count
    from read_parquet(
        -- ⚠️ 与 staging **同路径**（通配两账套）——对账必须与受测面同口径，否则只对账了 3120（issue #250）。
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    -- 基面与净销售额同口径（FINISHED+SALE_ORDER，2026-10-12 W0）
    where r['state'] = 'FINISHED'
      and r['order_transaction_type'] = 'SALE_ORDER'
      -- ⚠️ 只比**已闭窗营业日**（bizday < 上海今天）：今天的文件被 tick 重写 ⇒ 与物化建表互撞
      --    ETag 竞态、报 ERROR（实测 2026-10-06 run `jrun_dtyVWZnnFaQ_pCCN` attempt 1）。
      --    今天未定稿不判；两侧都滤，才是同量对比。
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
    group by 1, 2, 3
),
materialized as (
    select
        system_book,
        bizday,
        branch_num,
        order_count
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.order_count                          as recheck_value,
    b.order_count                          as materialized_value,
    '复算与物化结果不一致（有效订单数，基面=销售单，#430/#813）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
-- ⚠️ 2026-10-17（issue #813）：物化侧自 T1 起含「只有退货、没有销售」的店日（order_count=0），
--    而本复算侧只有销售基面 ⇒ 那些行 a.order_count 为 NULL。coalesce 到 0 再比，
--    既放过这些**结构上正确**的空缺，又不放松销售店日的逐分判据。
where coalesce(a.order_count, 0) is distinct from coalesce(b.order_count, 0)

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
