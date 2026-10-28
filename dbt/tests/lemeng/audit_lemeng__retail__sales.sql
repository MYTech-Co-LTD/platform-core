{{ config(store_failures=true) }}
-- ★ **2026-10-28（issue #761）**：裸 `::numeric` 在 pg_duckdb 里参与除法会被推成 DOUBLE
--   （实测 542.2949999999998 vs 精确 542.295）⇒ 最终 2 位小数会差 1 分、间歇假红。
--   本文件所有裸 `::numeric` 已改 `::decimal(38,10)`；`::numeric(20,2)` 最终 cast 保留。

-- audit_lemeng__retail__sales.sql — 指标 `lemeng:retail:sales` 的**独立复算**（对账；销售侧，不冲退货）。
--
-- ★ `store_failures=true`（2026-10-17 加，issue #761）：本对账出现过**间歇 FAIL 1、重试自愈**，
--   而 dbt 的 singular test 只把行数打进 job 日志（`Got 1 result`），**看不到是哪一格**。
--   开了这个开关后，失败行会落进 `<目标 schema>_dbt_test_failures.audit_lemeng__retail__sales`，
--   可以直接查出 (账套, 业务日, 门店, 复算值, 物化值) 逐列对比。
--   ⚠️ **取证窗口很短**：materialize job 自带 2 次重试，第 2 次若通过，dbt 会用空结果**覆盖**
--   那张表。所以看到 FAIL 要**赶在重试之前**查（或临时把该 job 的 retry 关掉再复现）。
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
--
-- ── 口径（2026-10-12 W0 随 #430 定案更新）───────────────────────────────────────────────
--    销售额（销售侧，不冲退货） = FINISHED+SALE_ORDER 基面 + 换货「送出半边」公式（逐单 (Σ非赠品+total)/2 − sd）
--    + 赠品判别式排除。**除法形态与 fct_retail_sale.sql 及正典对拍实现
--    （console 管线 lemeng.recon.preagg.item.json）逐字同构**：per_order 出 ng/tot/sd，
--    sum 的参数表达式里逐单除——除法的舍入位置是口径的一部分，别改成先和后除。
--
-- ── 形态：与 staging **同一套实测形态**（2026-09-24 数据面真机）──────────────────────────
-- ① 取列：`from read_parquet('…') r` + `r['列名']` —— 别名必须挂在**函数调用**上；
--    CTE 形态在本栈上取列即报 `cannot subscript type record`。
-- ② `hive_partitioning=1` **不能写成 read_parquet 的形参**（pg_duckdb 的 read_parquet 是 PG
--    函数、只认位置参数）；分区推断默认生效，推断类型不合约 ⇒ 本文件显式 cast。
-- ③ `r['列']` 之间的**算术必须先 `::decimal(38,10)`**；FULL JOIN 的键两侧逐个显式 cast。
-- ④ 湖读取走**冷热两腿合流**（#984）：day 天文件 + hour 小时文件**各自单读**，热腿排除已封版日
--    （同 staging 冷热合流，含封版排除语义）——原 day+window 双 glob 一把读**没有封版排除**，
--    封窗日两份并存 ⇒ 复算侧双计。
with base_cold as (
    -- 冷腿：已封版日的**天文件**
    select
        r['system_book']::varchar  as system_book,
        r['bizday']::date          as bizday,
        r['branch_num']::int       as branch_num,
        r['order_no']::varchar     as order_no,
        r['sale_money']::decimal(38,10)   as sale_money,
        r['order_total_money']::decimal(38,10)     as order_total_money,
        r['order_detail_share_discount']::decimal(38,10) as share_discount,
        -- 赠品判别式（**逐字照抄正典**）：护栏三条件排除退化命中，容差 ±0.02 标定见正典
        (r['order_detail_std_price']::decimal(38,10) > 0
         and r['sale_money']::decimal(38,10) > 0
         and r['quantity']::decimal(38,10) > 0
         and abs(r['discount_money']::decimal(38,10) - r['order_detail_std_price']::decimal(38,10) * r['quantity']::decimal(38,10)) <= 0.02
        ) as is_gift
    from read_parquet(
        -- ⚠️ 与 staging **同路径**（通配两账套，含封版排除语义）——对账必须与受测面同口径，否则只对账了 3120（issue #250）。
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAY_DATA/system_book=*/bizday=*/all.parquet'
    ) r
    where r['state'] = 'FINISHED'
      and r['order_transaction_type'] = 'SALE_ORDER'
      -- ⚠️ 只比**已闭窗营业日**（bizday < 上海今天）：今天的文件正被 5 分钟一班的 tick 重写，
      --    与「物化建表 → 本测试读湖」之间构成 ETag 竞态 ⇒ 读到中途被改的文件直接 **ERROR**
      --    （实测 2026-10-06 run `jrun_dtyVWZnnFaQ_pCCN` attempt 1 就红在这，报 ETag 变化）。
      --    今天未定稿、按定稿线本就不判；两侧**都**滤掉今天，才是同量对比。
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
base_hot as (
    -- 热腿：未封版日的小时文件——排除已封版日（同 stg 冷热合流，#984）
    select
        r['system_book']::varchar  as system_book,
        r['bizday']::date          as bizday,
        r['branch_num']::int       as branch_num,
        r['order_no']::varchar     as order_no,
        r['sale_money']::decimal(38,10)   as sale_money,
        r['order_total_money']::decimal(38,10)     as order_total_money,
        r['order_detail_share_discount']::decimal(38,10) as share_discount,
        -- 赠品判别式（**逐字照抄正典**）：护栏三条件排除退化命中，容差 ±0.02 标定见正典
        (r['order_detail_std_price']::decimal(38,10) > 0
         and r['sale_money']::decimal(38,10) > 0
         and r['quantity']::decimal(38,10) > 0
         and abs(r['discount_money']::decimal(38,10) - r['order_detail_std_price']::decimal(38,10) * r['quantity']::decimal(38,10)) <= 0.02
        ) as is_gift
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/bizday=*/hour=*/all.parquet'
    ) r
    where r['state'] = 'FINISHED'
      and r['order_transaction_type'] = 'SALE_ORDER'
      -- ⚠️ 只比**已闭窗营业日**（bizday < 上海今天）：今天的文件正被 5 分钟一班的 tick 重写，
      --    与「物化建表 → 本测试读湖」之间构成 ETag 竞态 ⇒ 读到中途被改的文件直接 **ERROR**
      --    （实测 2026-10-06 run `jrun_dtyVWZnnFaQ_pCCN` attempt 1 就红在这，报 ETag 变化）。
      --    今天未定稿、按定稿线本就不判；两侧**都**滤掉今天，才是同量对比。
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and not exists (select 1 from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAILY/*.parquet') m where cast(m['system_book'] as varchar) = cast(r['system_book'] as varchar) and cast(m['bizday'] as date) = cast(r['bizday'] as date))
),
base as (
    select * from base_cold
    union all
    select * from base_hot
),
per_order as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sum(case when is_gift then 0 else sale_money end) as non_gift_amount,
        max(order_total_money)                            as order_total_money,
        sum(share_discount)                               as share_discount
    from base
    group by 1, 2, 3, 4
),
recheck as (
    select
        system_book,
        bizday,
        branch_num,
        -- 除法形态与 fct 逐字同构（逐单除、逐单减，见头注）
        (sum((non_gift_amount + order_total_money) / 2 - share_discount))::numeric(20,2) as sale_amount
    from per_order
    group by 1, 2, 3
),
materialized as (
    select
        system_book,
        bizday,
        branch_num,
        sale_amount
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.sale_amount                          as recheck_value,
    b.sale_amount                          as materialized_value,
    '复算与物化结果不一致（销售额·销售侧，#430 换货半边口径）' as note
from recheck a
full join materialized b using (system_book, bizday, branch_num)
-- ⚠️ 2026-10-17（issue #813）：物化侧（fct_retail_sale）自 T1 起是销售侧 full join 退货侧
--    （现由生成区的 `sale_amount__rollup full join return_amount__rollup` 落地），含「只有退货、
--    没有销售」的店日（sale_amount=0），而本复算侧只有销售基面
--    ⇒ 那些行 a.sale_amount 为 NULL。coalesce 到 0 再比，既放过这些**结构上正确**的空缺，
--    又不放松销售店日的逐分判据（复算=5/物化=0 与 复算=NULL/物化=5 仍判红）。
-- ⚠️ 2026-10-21：**1 分容差**（原为 `is distinct from` 精确比较）。
--   实测 3120/2026-10-05/门店 15：两侧**逐单输入完全一致**、表达式**逐字相同**，
--   但原始和恰好落在 `2449.795` 这个**半分边界**上——staging 侧是 PG `numeric`（无界精度）
--   进到 2449.80，parquet 侧是 `DECIMAL(14,2)/(14,3)` 运算得 2449.794999… 舍到 2449.79。
--   这是**类型系统的固有差**，不是数据差；精确比较对它必假红（同 `numeric-audit-use-tolerance-not-equality`）。
where abs(coalesce(a.sale_amount, 0) - coalesce(b.sale_amount, 0)) > 0.01

union all

select
    null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
