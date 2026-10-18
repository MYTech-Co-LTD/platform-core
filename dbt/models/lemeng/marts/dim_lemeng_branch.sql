{{
    config(materialized='table')
}}
-- dim_lemeng_branch.sql — **门店维（湖上每日快照 + 战区标签）**（#883，2026-10-18）。
--
-- 【它为什么存在】湖上门店档案（`lemeng/dim_branch`）只有 `region_id`：乐檬 `branch.find`
--   **不回** `region_name`（2026-10-17 实测）。而战区名/一级原先只活在回包层（`dimension-labels.ts`
--   查 `dim_region`）⇒ **marts / 报表 / 任何下游源都拿不到战区属性**，每个源想按战区下钻都得自己接一遍。
--   本模型把战区属性 join 到门店维上，**所有源免 join 即得**。
--
-- 【为什么标签落在维上、不是塞进湖上快照】2026-10-18 用户裁决（#883）：
--   · 湖 `lemeng/dim_branch` 是**契约驱动的采集快照**（列由 `contracts/common/lemeng.branch.json`
--     的 `expr` 生成）——`region_name` **不是源给的**，塞进去 = raw 层混 git 受控配置 +
--     要重生成 data-plane lock + 采集管线得在 dbt 之前读 seed；且每天 ×400 行重复。
--   · 战区名/一级是**战区的属性**，权威在 `dim_region`（受控维，与 `dim_brand` 同形）。
--   · 门店维 join 它 ⇒ 「按一级战区汇总」才成立（**汇总必须发生在聚合处**，回包层贴标签是行级展示，汇不出来）。
--
-- 【为什么不叫 `dim_branch`】`dim_branch` 在本仓**已专指湖上快照路径**（`lemeng/dim_branch`，
--   文档里出现十余处）——复用会让「dim_branch 最新快照」这类句子失去所指。取名对齐父模型 `stg_lemeng_branch`。
--
-- 【粒度】与 `stg_lemeng_branch` **逐行一致**：`(system_book, snapshot, branch_num)`
--   （全量快照日更 ⇒ 含 `snapshot` 分区键；`(system_book, branch_num)` 是实体粒度、不是行粒度）。
--   **刻意保留全部快照**（不塌成"当前"）：fct 侧按 `latest snapshot ≤ bizday` 做 as-of join
--   （见 `fct_hq_outbound` / `fct_branch_day_activity`），塌掉历史就没法还原「那天属哪个战区」。
--   只要"当前值"的消费方自己取 `snapshot = max(snapshot)`。
--
-- 【join 语义】`left join` + 键带 `system_book`：
--   · **left**：`dim_region` 未登记的门店（新区）**照出行**，`region_name`/`region_l1` 为 null
--     ——「名称未知 ≠ 捏造名称」，且**不反噬**门店维本身（同回包层的失败姿态）。
--   · **带 `system_book`**：两账套都有「中部一区」这类同名战区、id 空间不相交 ⇒ 只按 `region_id`
--     关联会串账套（`dimension-labels.ts` 头注同款理由）。
--   · 未登记的新 `region_id` 由 `dbt/tests/lemeng/warn_region_unregistered.sql` **告警**（不阻断，
--     按裁决：新区不影响存量指标的正确性）。
--
-- 【可加性】战区名是**分组属性**，不是"按行重复的量"——本模型是**维**（一行一店一快照），
--   不与事实表按行 join，故不触 `dim_brand` 那条「不要把名称 join 进指标 select_sql」的失真面。
select
    b.system_book,
    {{ subject_org() }} as org,
    b.snapshot,
    b.branch_num,
    b.code,
    b.name,
    b.pinyin,
    b.type,
    b.enable,
    b.region_id,
    r.region_name,
    r.region_l1,
    b.province,
    b.city,
    b.district,
    b.contact,
    b.phone,
    b.address
from {{ ref('stg_lemeng_branch') }} b
left join {{ ref('dim_region') }} r
    on r.system_book = b.system_book
   and r.region_id = b.region_id
