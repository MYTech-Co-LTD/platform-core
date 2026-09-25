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
--
-- 指标口径（逐字，与 l1_metrics.yml 的 `definition` 同源）：
--   · 净销售额 = 有效零售订单的成交金额合计（当前实现 = `sum(sale_money)`）
--   · 订单数   = 按单号去重的订单笔数（当前实现 = `count(distinct order_no)`）
--   ⚠️ 「有效」的判定条件（退货/赠品/作废是否剔除）**未在本模型实现** —— 这是**暂定**：
--      真实口径需要业务确认 + 样本核对。当前实现是「全部行的金额合计」，
--      **不许**把 l1_metrics.yml 里的 definition 改写成「全部行」来迁就实现（那是口径追着实现跑）。
--
-- ── 换源（2026-09-24 / issue #150 的 S1 Task 9）：旧湖 → 新湖 ─────────────────────────────
--   输入从 `ref('stg_lemeng_retail_detail')` 换成 `ref('stg_lemeng_retail_order_line')`。
--   **列名与语义零改动**（`net_amount` / `order_count` / `system_book` / `bizday`）⇒ 本模型对外的
--   列契约不变：`dbt/models/common/marts/schema.yml` 的 `fct_retail_sale` 段、L1 声明的
--   `expression`（`sum(fct_retail_sale.net_amount)` 等）、两个 audit 的口径面**都不需要动**。
--   旧湖那两处手写 cast（VARCHAR → numeric / try_strptime）已删：新湖**落盘即定型**。
--
-- ════════════════════════════════════════════════════════════════════════════════════════
-- 🔒【明确不过滤 state —— 这是口径决定，不是漏写 where】
-- ════════════════════════════════════════════════════════════════════════════════════════
-- `net_amount` = **全部明细行**的 `sale_money` 合计：FINISHED / CANCELED / REPAID **一视同仁**，
-- 与旧湖实现（全行 `sum(amount)`）**逐字同口径**。新湖里这三类**确实都有行**
-- （2026-09-23 真机实测：FINISHED 18566 行 / CANCELED 1002 行 / REPAID 110 行）。故：
--   · **不许**加 `where state = 'FINISHED'`（或任何 state 过滤）——一加 `net_amount` 就掉数
--     （掉到 1,522,801.61 而不是 1,622,276.08），两个 audit 立刻红；而且那是**改口径**，不是修 bug。
--   · 这是**下一个人最容易「顺手优化」的地方**：剔掉作废/退货看起来天经地义、而且会让某些
--     人工报表更「好看」，但它是**口径变更**，必须走声明（spec §11 的 S5），必须先改
--     `l1_metrics.yml` 的 `definition` 并让人看见。故本条写在头注最前面。
--   · 澄清一条边界：**不过滤 state 不等于不用 state** —— 将来「有效订单」口径落地时，state 的
--     处理就在这里写一次（本模型是它的唯一落点），而不是在下游各拼一遍。
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
-- 为什么不用提示里那条 `convert_unsupported_numeric_to_double`：金额对账要**精确十进制**，
-- 把两侧都转成 DOUBLE 等于把「对账」降级成「差不多对账」——那正是这两个 audit 文件存在的理由
-- （cast 错要能被抓）。精度取 20 位足够（当日合计 1,622,276.08；真要溢出会**响亮报错**，
-- 不会静默截断）。
select
    system_book,
    bizday,
    sum(sale_money)::numeric(20,2) as net_amount,
    count(distinct order_no)       as order_count
from {{ ref('stg_lemeng_retail_order_line') }}
group by
    system_book,
    bizday
