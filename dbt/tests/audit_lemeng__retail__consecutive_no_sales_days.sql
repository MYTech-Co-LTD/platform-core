-- audit_lemeng__retail__consecutive_no_sales_days.sql — 骨架与 streak 的**不变量断言**
-- （刻意**不**复刻物化实现：复刻只能抓 cast/join，抓不到口径错——`zero_cost` 两边同错恒绿是已证教训。
--   这里断言的是**律**，任何实现只要违反就红。）
--
-- 四条律：
--   ① **骨架完整性**：每个门店在其窗口内的店日数 == 窗口自然日数（**不许有洞**）——
--      这是「真零天被补上」的直接判据；无骨架的实现（只取事实行）在这里必红。
--   ② **分类自洽**：`data_status='zero_sales'` ⇔ `sale_money=0 ∧ 门店当日营业 ∧ 当日有采集`。
--   ③ **streak 转移律**：`>0` ⇔ `zero_sales`；连续两个 zero_sales 必须 +1；段首必须 =1。
--   ④ **空转自检**：一行 `zero_sales` 都没有 ⇒ 骨架没起作用（不是「没有零销售」，是**没建骨架**）。

-- ① 骨架完整性
select
    p.system_book,
    null::date as bizday,
    p.branch_num,
    '骨架有洞：该门店的店日数 < 窗口自然日数（真零天没被补上）' as note
from (
    select system_book, branch_num, count(distinct bizday) as n_days
    from {{ ref('fct_branch_day_activity') }}
    group by 1, 2
) p
cross join (
    select count(distinct bizday) as span_days
    from {{ ref('fct_branch_day_activity') }}
) s
where p.n_days <> s.span_days

union all

-- ② 分类自洽
select
    system_book,
    bizday,
    branch_num,
    'data_status 与事实不一致：zero_sales 必须恰是「零金额 ∧ 营业 ∧ 有采集」'
from {{ ref('fct_branch_day_activity') }}
where (data_status = 'zero_sales')
      is distinct from (sale_money = 0 and branch_enabled and collection_covered)

union all

-- ③ streak 转移律
select
    system_book,
    bizday,
    branch_num,
    'streak 违反转移律：>0 必须⇔zero_sales；连续零天必须+1；段首必须=1'
from (
    select
        a.*,
        lag(a.data_status) over w                       as prev_status,
        lag(a.consecutive_no_sales_days) over w         as prev_cns
    from {{ ref('fct_branch_day_activity') }} a
    window w as (partition by a.system_book, a.branch_num order by a.bizday)
) t
where (consecutive_no_sales_days > 0) is distinct from (data_status = 'zero_sales')
   or (data_status = 'zero_sales' and prev_status = 'zero_sales'
       and consecutive_no_sales_days <> prev_cns + 1)
   or (data_status = 'zero_sales' and (prev_status is distinct from 'zero_sales')
       and consecutive_no_sales_days <> 1)

union all

-- ④ 空转自检
select
    null::varchar,
    null::date,
    null::int,
    '物化侧一行 zero_sales 都没有：骨架没起作用（空转过绿，不是「没有零销售」）'
where not exists (
    select 1 from {{ ref('fct_branch_day_activity') }} where data_status = 'zero_sales'
)
