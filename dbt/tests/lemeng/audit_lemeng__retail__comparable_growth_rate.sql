-- audit_lemeng__retail__comparable_growth_rate.sql — 可比门店增长率的**不变量断言**
-- （刻意**不**复刻实现：同构复算只能抓 cast/join、抓不到口径错——`zero_cost` 两边同错恒绿是已证教训。
--   这里断言的是**律**，任何实现只要违反就红。）
--
-- 三条律：
--   ① **率自洽**：`growth_rate` 必须恰等于 `cur_amount / pri_amount − 1`（重算）。
--   ② **分母为 0 ⇒ 率必须 NULL**：不可比/上期无额时率是「不适用」，**不是 0、不是 −1**
--      （0 会被读成「零增长」，−1 会被读成「跌 100%」——都是错答案）。
--   ③ **空转自检**：没有一行 `comparable_count > 0` ⇒ 构件没起作用；
--      没有一行 `excluded_no_retail > 0` ⇒ **射程收缩没在跑**（400 个「账套×门店」里 173 个零零售，
--      不收缩会把批发客户/仓库混进分母）。

-- ① 率自洽
-- ⚠️ **用容差、不用 `is distinct from`**（2026-10-17 首跑实录）：构件列是 `numeric(12,6)`（已四舍五入），
--    重算走全精度 ⇒ 逐行天然不等（16 行全红）。容差 1e-6 恰好覆盖 6 位小数的舍入误差，
--    仍然能抓住**任何真实公式错**（分子分母错、少减 1、写成 pri/cur 等，偏差量级都 ≥1e-3）。
select
    system_book,
    bizday,
    period_days,
    'growth_rate 与 cur/pri−1 不一致（超出 6 位小数容差 ⇒ 分子分母或公式错）' as note
from {{ ref('fct_retail_comparable_growth') }}
where growth_rate is not null
  and abs(growth_rate - (cur_amount / nullif(pri_amount, 0) - 1)) > 0.000001

union all

-- ①-b 反向：分母非 0 时必须算得出率（不能静默为 NULL）
select
    system_book,
    bizday,
    period_days,
    'pri_amount<>0 但 growth_rate 为 NULL（率该算得出却没算）' as note
from {{ ref('fct_retail_comparable_growth') }}
where pri_amount <> 0 and growth_rate is null

union all

-- ② 分母为 0 ⇒ 率必须 NULL
select
    system_book,
    bizday,
    period_days,
    'pri_amount=0 时 growth_rate 必须是 NULL（率不适用），不能落成 0 或 −1'
from {{ ref('fct_retail_comparable_growth') }}
where pri_amount = 0 and growth_rate is not null

union all

-- ③ 空转自检（两个方向）
select
    null::varchar, null::date, null::int,
    '一行 comparable_count>0 都没有：构件没起作用（空转过绿）'
where not exists (
    select 1 from {{ ref('fct_retail_comparable_growth') }} where comparable_count > 0
)

union all

select
    null::varchar, null::date, null::int,
    '一行 excluded_no_retail>0 都没有：射程收缩没在跑（批发客户/仓库会混进可比分母）'
where not exists (
    select 1 from {{ ref('fct_retail_comparable_growth') }} where excluded_no_retail > 0
)
