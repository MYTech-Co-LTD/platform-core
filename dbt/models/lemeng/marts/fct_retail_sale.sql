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
-- 粒度（grain）：**(system_book, bizday, branch_num)** —— 账套 × 业务日 × 门店（2026-10-12 W0
--   由两键扩到三键：65 项指标体系的零售侧要下钻到店，见 spec
--   `2026-10-12-lemeng-metrics-sources-semantics-design.md`）。粒度是显式的、被断言钉住的
--   （`dbt/tests/assert_fct_retail_sale_grain_unique.sql`）：粒度漂移（多出来一行）会让所有
--   按它聚合的指标静默偏大，而**没有任何单列约束抓得住**（各单键都不唯一）。
--
-- ⚠️ `org` 是**主体列**（行级授权谓词 `WHERE org = …` 的着力点，见 dbt/macros/subject_org.sql）：
--   本模型用 `{{ subject_org() }}` **直接注入常量**（**不从 staging 透传**）—— 两个理由：
--   ① 规则 ⑩ 的判据是**单一形状** `as org`（scripts/check-data-models.mjs），注入形态才守得住；
--   ② 模型自足：新加 marts 模型时不必先确认上游 staging 有没有那一列。
--   同一轮运行里 macro 取的是同一个 env ⇒ 与 staging 的 org **恒等**，不存在两份值。
--   它是常量、**不参与口径**，故不进 GROUP BY；每个租户物化进自己的 schema
--   （macros/generate_schema_name.sql）⇒ **单个 relation 内 org 恒为单值**，粒度仍写作上三键。
--
-- ── 指标口径（逐字，与 l1_metrics.yml 的 `definition` 同源；2026-10-12 W0 落地）────────────
--   · 净销售额 = state=FINISHED 且 order_transaction_type=SALE_ORDER 的订单（**退货单不进
--     gross**——平台 sale_money 不冲退货单），逐订单取「(Σ非赠品行额 + order_total_money)/2」，
--     按门店日合计 − Σ分摊折扣；赠品行按判别式排除（正典
--     docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md §0）。
--   · 订单数   = 同基面的 count(distinct order_no)。
--   公式出处：issue #430 定案，2026-10-05 双账套真机 5 天 × 63 店与乐檬预聚合端点**逐分归零**
--   （对拍实现 = console 管线 `deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json`）。
--   本文件的除法形态**逐字同构照抄它**：per_order 出 ng/tot/sd 三列，最终
--   `sum((ng + tot) / 2 - sd)`——除法在**逐单层**（sum 的参数表达式里），不是先和后除；
--   别引入第三种除法形态（逐分归零是按这个形状验证的）。
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 🔒【口径变更记录】本文件曾按「全部明细行 sum(sale_money)」实现（暂定口径，FINISHED/CANCELED/
--    REPAID 一视同仁，2026-09-23 真机实测三态都有行）。2026-10-12 起按 #430 定案公式实现——
--    那是**口径定案的落地**（声明先行：l1_metrics.yml 的 definition 同 PR 先改），不是漏写 where；
--    旧头注「不许加 where state=…」随暂定口径一并退役。**再改口径仍必须先改 definition**。
--    ⚠️ 基面行的 `order_total_money` / `order_detail_share_discount` 若为 null，sum 会把该单
--    **静默丢掉**——输入形状守卫在 `audit_lemeng__retail__recon_exchange_shape.sql`
--    （非空/非负违规它会红），本模型不重复设闸（口径模型保持纯口径）。
-- ════════════════════════════════════════════════════════════════════════════════════════
--
-- ── 换源（2026-09-24 / issue #150 的 S1 Task 9）：旧湖 → 新湖 ─────────────────────────────
--   输入从 `ref('stg_lemeng_retail_detail')`（旧湖 staging，该文件已于 2026-10-06 仓内退役）换成 `ref('stg_lemeng_retail_order_line')`。
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 【为什么聚合结果要显式定精度 `::numeric(20,2)`】—— 不是风格偏好，是 pg_duckdb 的硬约束
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 湖里的 `sale_money` 是 `decimal(14,2)`，但 `sum()` 经 pg_duckdb 写回 PG 后落成**无精度**的
-- `numeric`（实测 `information_schema.columns` 的 `numeric_precision` 为空）。无精度 numeric 在
-- **跨引擎**查询里会让 DuckDB 直接拒绝整个计划 —— 2026-09-24 数据面真机实测原文：
--   `ERROR:  (PGDuckDB/CreatePlan) Prepared query returned an error: Not implemented Error:
--    Unsupported PostgreSQL type found in query: DuckDB requires the precision of a NUMERIC to be set.
--    You can choose to convert these NUMERICs to a DOUBLE by using
--    'SET duckdb.convert_unsupported_numeric_to_double = true'`
-- 而**两个 audit 恰恰是跨引擎查询**（复算侧 = DuckDB 直接打 parquet，物化侧 = PG 读本表）⇒
-- 不 cast 的后果不是「数不对」，是**对账根本执行不了**（实测：加 cast 前该查询报上面这条错）。
-- 精度取 20 位足够（真要溢出会**响亮报错**，不会静默截断）。
with base as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sale_money,
        order_total_money,
        order_detail_share_discount,
        -- 赠品判别式（**逐字照抄正典**，与 audit_lemeng__retail__recon_gift_hit.sql 同一句）：
        -- 折让 = 标准价全额 × 数量 ⇒ 该行分文未收（白送）；护栏三条件排除退化命中。
        (order_detail_std_price > 0 and sale_money > 0 and quantity > 0
         and abs(discount_money - order_detail_std_price * quantity) <= 0.02) as is_gift
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_transaction_type = 'SALE_ORDER'
),
per_order as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        sum(case when is_gift then 0 else sale_money end) as non_gift_amount,
        max(order_total_money)                            as order_total_money,
        sum(order_detail_share_discount)                  as share_discount
    from base
    group by 1, 2, 3, 4
)
select
    per_order.system_book,
    {{ subject_org() }} as org,
    per_order.bizday,
    per_order.branch_num,
    -- 除法形态逐字同构 recon-preagg（见头注）：sum 的参数表达式里**逐单**除 2、逐单减 sd，
    -- 不是先和后除（decimal 除法的舍入位置是口径的一部分）
    (sum((per_order.non_gift_amount + per_order.order_total_money) / 2
         - per_order.share_discount))::numeric(20,2) as net_amount,
    count(distinct per_order.order_no)               as order_count
from per_order
group by 1, 3, 4
