-- 物化落点 gate 2（同 staging）：口径模型必须落在 PG 可见关系上，否则 Metabase 看不见（spec §9.4）。
-- ⚠️ 注释必须留在 Jinja config 块外：块内是 Jinja 表达式、不认 SQL 注释行（真 dbt 1.9.1
--   parse 实测报 expected token，2026-09-23 T6 收尾订正）。
{{
    config(materialized='table')
}}

-- fct_retail_sale.sql — 零售销售事实（口径模型；layered ④：join / 粒度 / **口径在这里定义一次**）。
--
-- ★ 分层纪律（最重要的一条）：**口径只能在 ④ 定义一次**。③ 只规范化不改义，⑤ 只声明不计算，
--   ⑦ 只组合不改义。本文件是「净销售额」「订单数」两个已声明指标的**唯一实现**——
--   `dbt/semantics/l1_metrics.yml` 里的 `expression` 指向本模型的列，别处不许再写一份等价的聚合
--   （同名唯一的静态门禁在 scripts/check-data-models.mjs 的规则 ⑥）。
--
-- 粒度（grain）：**(system_book, bizday)** —— 账套 × 业务日。粒度是显式的、被断言钉住的
--   （`dbt/tests/assert_fct_retail_sale_grain_unique.sql`）：粒度漂移（多出来一行）会让所有
--   按它聚合的指标静默偏大，而**没有任何单列约束抓得住**（system_book 与 bizday 各自都不唯一）。
--   T6 若发现真实业务还需要门店/商品维度，**先改这里与语义声明的 grain**，再补维度。
--
-- 指标口径（逐字，与 l1_metrics.yml 的 `definition` 同源）：
--   · 净销售额 = 有效零售订单的成交金额合计（当前实现 = `sum(amount)`）
--   · 订单数   = 按单号去重的订单笔数（当前实现 = `count(distinct order_no)`）
--   ⚠️ 「有效」的判定条件（退货/赠品/作废是否剔除）**未在本模型实现** —— 这是**暂定**：
--      真实口径需要业务确认 + 样本核对（T6）。当前实现是「全部行的金额合计」，
--      **不许**把 l1_metrics.yml 里的 definition 改写成「全部行」来迁就实现（那是口径追着实现跑）。
select
    system_book,
    bizday,
    sum(amount)             as net_amount,
    count(distinct order_no) as order_count
from {{ ref('stg_lemeng_retail_detail') }}
group by
    system_book,
    bizday
