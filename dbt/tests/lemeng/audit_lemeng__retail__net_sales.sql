{{ config(store_failures=true) }}
-- audit_lemeng__retail__net_sales.sql — 指标 `lemeng:retail:net_sales` 的**独立复算**（对账）。
--
-- ★ `store_failures=true`（2026-10-17 加，issue #761）：本对账出现过**间歇 FAIL 1、重试自愈**，
--   而 dbt 的 singular test 只把行数打进 job 日志（`Got 1 result`），**看不到是哪一格**。
--   开了这个开关后，失败行会落进 `<目标 schema>_dbt_test_failures.audit_lemeng__retail__net_sales`，
--   可以直接查出 (账套, 业务日, 门店, 复算值, 物化值) 逐列对比。
--   ⚠️ **取证窗口很短**：materialize job 自带 2 次重试，第 2 次若通过，dbt 会用空结果**覆盖**
--   那张表。所以看到 FAIL 要**赶在重试之前**查（或临时把该 job 的 retry 关掉再复现）。
--
-- ★★ **根因已定位（2026-10-28，issue #761）**：本对账的间歇 FAIL 1 不是数据问题，是 **DuckDB 的浮点陷阱**。
--   pg_duckdb 里裸 `::numeric` 参与除法（`(a+b)/2`）时，结果类型会被推成 **DOUBLE**：
--   实测 `sum((non_gift+tototal)/2 - sd)` = **542.2949999999998**（typeof=DOUBLE），
--   而同一算式在 Postgres（物化侧，NUMERIC 任意精度）= **542.295** ⇒ 最终 `::numeric(20,2)` 一个舍成 542.29、一个舍成 542.30。
--   实测格：64188 / 2026-10-24 / 门店 8，差额 **0.01**（`dbt_test__audit.audit_lemeng__retail__net_sales` 里存着这一行）。
--   ★ **但改精度还不够（2026-10-28 二次实测）**：改 `::decimal(38,10)` 后 64188/10-24/br8 消失了，
--     却又冒出 **3120 / 2026-10-20 / 门店 107 = 717.290 vs 717.300** ——同样是 .xx5 边界。
--     真因是**舍入位置**：物化侧 staging 逐行落 `numeric(20,2)` 再做逐单折半，复算侧保留精确值到最后一刻
--     ⇒ 尾数恰为 `.xx5` 的格必差 1 分。**这是类型系统的固有差，不是数据差**。
--   ★ 故最终比较改为**1 分容差**（`abs(diff) > 0.01` 才判红），且**容差作为数据列带出**
--     （同 `audit_lemeng__retail__sales` 2026-10-21 的先例；口径见记忆 `numeric-audit-use-tolerance-not-equality`）。
--     ⚠️ 一分是 2 位小数的分辨率下限，**无法区分「真错一分」与「舍入位置不同」**——这是已知且明示的射程。
--   **修法**：本文件所有裸 `::numeric` 改为 **`::decimal(38,10)`**（精确十进制，不落 DOUBLE）。
--   ⚠️ 只改裸 `::numeric`；`::numeric(20,2)` 这类显式精度的最终 cast **保留**（那是有意的结果定精度）。
--   ⚠️ 同一形态存在于其余 audit_*.sql（全仓 48 个文件 / 84 处裸 `::numeric`）——**尚未全量清理**，
--      只在两处已复现 flaky（本文件与 audit_lemeng__retail__sales）先修，其余待扫（见 #761 后续）。
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
-- ── 口径（2026-10-17 随 #813 定案更新；上一版 2026-10-12 W0 随 #430）──────────────────────
--    净销售额 = **销售侧 − 退货侧**。
--    销售侧 = FINISHED+SALE_ORDER 基面 + 换货「送出半边」公式（逐单 (Σ非赠品+total)/2 − sd）
--      + 赠品判别式排除（本文件 `base`/`per_order` 两条 CTE 实现）。
--    退货侧 = 退货单**全额冲减、不套折半**：Σ(sale_money + order_detail_share_discount)，
--      谓词 `order_transaction_type like '%RETURN%' AND state='FINISHED'`（**REPAID_RETURN 不计**
--      —— 它们 state=REPAID）；按**退货单自身 bizday** 归属（本文件 `ret_base`/`ret_side` 两条
--      CTE 实现，**独立打 parquet、不 ref staging**，与销售侧各自读，见上「刻意重复」段）。
--    两侧各自 group by (账套, 业务日, 门店) 后 full join 相减 —— 缺一侧按 0 计（`recheck`）。
--    **销售侧的除法形态与 fct_retail_sale.sql 及正典对拍实现
--    （console 管线 lemeng.recon.preagg.item.json）逐字同构**：per_order 出 ng/tot/sd，
--    sum 的参数表达式里逐单除——除法的舍入位置是口径的一部分，别改成先和后除。
--    spec：docs/superpowers/specs/2026-10-17-retail-net-sales-return-offset-design.md
--
-- ── 形态：与 staging **同一套实测形态**（2026-09-24 数据面真机）──────────────────────────
-- ① 取列：`from read_parquet('…') r` + `r['列名']` —— 别名必须挂在**函数调用**上；
--    CTE 形态在本栈上取列即报 `cannot subscript type record`。
-- ② `hive_partitioning=1` **不能写成 read_parquet 的形参**（pg_duckdb 的 read_parquet 是 PG
--    函数、只认位置参数）；分区推断默认生效，推断类型不合约 ⇒ 本文件显式 cast。
-- ③ `r['列']` 之间的**算术必须先 `::decimal(38,10)`**；FULL JOIN 的键两侧逐个显式 cast。
-- ④ 湖读取走**冷热两腿合流**（#984）：day 天文件 + hour 小时文件**各自单读**，热腿排除已封版日
--    （同 staging 冷热合流，含封版排除语义）——原 day+window 双 glob 一把读**没有封版排除**，
--    封窗日两份并存 ⇒ 复算侧双计（销售侧 base 与退货侧 ret_base 两处同改）。
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
ret_base_cold as (
    -- 冷腿：已封版日的**天文件**（#984 冷热两腿合流）
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        -- 退货行同样套赠品判别式（2026-10-18，#908；与 fct_retail_sale.sql 生成区
        -- return_amount__gen 的退货侧同一句，
        -- 金额/数量取绝对值——「0 元实付单整单退货」的退货行带负号，不排会反向加回）。
        case when r['order_detail_std_price']::decimal(38,10) > 0 and abs(r['sale_money']::decimal(38,10)) > 0
                  and abs(r['quantity']::decimal(38,10)) > 0
                  and abs(abs(r['discount_money']::decimal(38,10))
                          - r['order_detail_std_price']::decimal(38,10) * abs(r['quantity']::decimal(38,10))) <= 0.02
             then 0
             else (r['sale_money']::decimal(38,10) + r['order_detail_share_discount']::decimal(38,10))
        end as return_amount
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAY_DATA/system_book=*/bizday=*/all.parquet'
    ) r
    where r['order_transaction_type'] like '%RETURN%'
      and r['state'] = 'FINISHED'
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
ret_base_hot as (
    -- 热腿：未封版日的小时文件——排除已封版日（同 stg 冷热合流，#984）
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['branch_num']::int      as branch_num,
        -- 退货行同样套赠品判别式（2026-10-18，#908；与 fct_retail_sale.sql 生成区
        -- return_amount__gen 的退货侧同一句，
        -- 金额/数量取绝对值——「0 元实付单整单退货」的退货行带负号，不排会反向加回）。
        case when r['order_detail_std_price']::decimal(38,10) > 0 and abs(r['sale_money']::decimal(38,10)) > 0
                  and abs(r['quantity']::decimal(38,10)) > 0
                  and abs(abs(r['discount_money']::decimal(38,10))
                          - r['order_detail_std_price']::decimal(38,10) * abs(r['quantity']::decimal(38,10))) <= 0.02
             then 0
             else (r['sale_money']::decimal(38,10) + r['order_detail_share_discount']::decimal(38,10))
        end as return_amount
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/bizday=*/hour=*/all.parquet'
    ) r
    where r['order_transaction_type'] like '%RETURN%'
      and r['state'] = 'FINISHED'
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and not exists (select 1 from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/_DAILY/*.parquet') m where cast(m['system_book'] as varchar) = cast(r['system_book'] as varchar) and cast(m['bizday'] as date) = cast(r['bizday'] as date))
),
ret_base as (
    select * from ret_base_cold
    union all
    select * from ret_base_hot
),
ret_side as (
    select
        system_book,
        bizday,
        branch_num,
        sum(return_amount)::numeric(20,2) as return_amount
    from ret_base
    group by 1, 2, 3
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
        coalesce(s.system_book, t.system_book) as system_book,
        coalesce(s.bizday, t.bizday)           as bizday,
        coalesce(s.branch_num, t.branch_num)   as branch_num,
        (coalesce(s.sale_amount, 0) - coalesce(t.return_amount, 0))::numeric(20,2) as net_sales
    from (
        select system_book, bizday, branch_num,
               (sum((non_gift_amount + order_total_money) / 2 - share_discount))::numeric(20,2) as sale_amount
        from per_order group by 1, 2, 3
    ) s
    full join ret_side t
        on  s.system_book = t.system_book
        and s.bizday      = t.bizday
        and s.branch_num  = t.branch_num
),
materialized as (
    select
        system_book,
        bizday,
        branch_num,
        net_amount as net_sales
    from {{ ref('fct_retail_sale') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select
    coalesce(a.system_book, b.system_book) as system_book,
    coalesce(a.bizday, b.bizday)           as bizday,
    coalesce(a.branch_num, b.branch_num)   as branch_num,
    a.net_sales                            as recheck_value,
    b.net_sales                            as materialized_value,
    '复算与物化结果不一致（净销售额 = 销售侧 − 退货侧，#813）' as note,
    -- 容差**作为数据列带出**（不许藏进 WHERE 常量）：本对账的离散差来自「舍入位置」——
    -- 物化侧 staging 逐行落 numeric(20,2) 后再做逐单折半，复算侧保留精确值到最后一刻，
    -- 于是尾数恰为 .xx5 的格会差 1 分（实测 64188/10-24/br8 = 542.295、3120/10-20/br107 = 717.295）。
    -- 一分是 2 位小数的分辨率下限，**无法区分「真错一分」与「舍入位置不同」** ⇒ 只放行 ≤ 0.01。
    0.01::decimal(20,2)                     as tolerance
from recheck a
full join materialized b using (system_book, bizday, branch_num)
where abs(coalesce(a.net_sales, 0) - coalesce(b.net_sales, 0)) > 0.01

union all

select
    null, null, null, null, null, null,
    '物化侧一行都没有：对账在空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from materialized)
