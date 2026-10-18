-- assert_stg_lemeng_retail_order_line_key_unique.sql — 结构断言：staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 为什么单列的 dbt `unique` test 判不了：自然键是 **复合键 (order_no, order_detail_num)**，
-- 两列**各自都不唯一**（同一单号有多条明细行；明细行号在每个订单里从 1 开始重排）
-- ⇒ 给任一个单列挂 `unique` 必红。不引 `dbt_utils.unique_combination_of_columns` 的理由同
-- `assert_fct_retail_sale_grain_unique.sql`：那要加 `packages.yml`（多一层依赖、解析期还要联网），
-- 而这条判据本身就是一句 group by —— 手写比引包便宜。
--
-- 为什么这条值得有（它是**覆盖写幂等**的护栏）：新湖的写模型是**整分区覆盖写**
-- （`batch_id` 是载荷列、`batch.unique=false`，同窗重跑换 run id 但**不追加**），
-- 而「覆盖」一旦退化成「追加」（或管线把一页重放一次），行就会**成倍**出现，
-- 净销售额与订单数随之偏大 —— 而**没有任何单列约束抓得住**（两列各自都合法、非空）。
-- 同一份数据在**同一天重跑**下这条断言必须恒绿：红 = 写侧幂等破了，不是数据脏。
--
-- ⚠️ 与对账（`audit_*.sql`）的分工：`audit_*` 是**指标口径**的独立复算（每个声明指标一条，
--    机检规则 ⑦ 逐个查在不在）；`assert_*` 是**结构断言**（不按指标数，故没有机检查条数 ——
--    靠 dbt test 真跑）。
--
-- ⚠️ 空表边界：表为空时本查询返回 0 行 = 通过，而那个「通过」没有信息量。
--    staging 层的非空保证不在这里（它落在 fct 与 audit 的空转自检上：`audit_*.sql` 末尾那条
--    「物化侧一行都没有 ⇒ 出行」）。本文件只判**唯一性**这一件事，不重复判空。
select
    order_no,
    order_detail_num,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_retail_order_line') }}
group by
    order_no,
    order_detail_num
having count(*) > 1
