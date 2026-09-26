-- assert_stg_lemeng_branch_key_unique.sql — 结构断言：门店维 staging 的**行粒度自然键**必须唯一。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 为什么单列的 dbt `unique` test 判不了：自然键是 **复合键 (system_book, snapshot, branch_num)**，
-- 单列各自都不唯一 —— `branch_num` 在每个账套的快照里都会重排（两账套合读进同一个模型），
-- `snapshot` / `system_book` 更是每行都重复（它们是分区键）⇒ 给任一个单列挂 `unique` 必红。
-- 不引 `dbt_utils.unique_combination_of_columns` 的理由同 `assert_stg_lemeng_retail_order_line_key_unique.sql`：
-- 那要加 `packages.yml`（多一层依赖、解析期还要联网），而这条判据本身就是一句 group by —— 手写比引包便宜。
--
-- 为什么键里**必须带上两个分区键**：本模型是**一个模型读两个账套**（路径 `*/snapshot=**/`，见
-- `staging/stg_lemeng_branch.sql` 头注【覆盖双账套】）⇒ 门店号只在**账套内**唯一，
-- `(snapshot, branch_num)` 漏掉 `system_book` 会把两个账套的同一门店号判成重复（假红）；
-- 反之只判 `branch_num` 又会把每个快照的同一门店判成重复。
--
-- 为什么这条值得有（它是**覆盖写幂等**的护栏）：新湖的写模型是**整分区覆盖写**
-- （`batch_id` 是载荷列、契约 `batch.unique=false`，同快照重跑换 run id 但**不追加**），
-- 而「覆盖」一旦退化成「追加」（或管线把一页重放一次），行就会**成倍**出现，
-- 门店数随之偏大 —— 而**没有任何单列约束抓得住**（三列各自都合法、非空）。
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
    system_book,
    snapshot,
    branch_num,
    count(*) as rows_in_key
from {{ ref('stg_lemeng_branch') }}
group by
    system_book,
    snapshot,
    branch_num
having count(*) > 1
