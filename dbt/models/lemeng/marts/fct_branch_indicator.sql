{{
    config(materialized='table')
}}
-- fct_branch_indicator.sql — 门店经营指标日粒度构件（D10 2026-10-26；#1047 P3）。
-- 【粒度】(system_book, bizday, branch_num)——可上卷到店 / 日 / 账套。
-- 【口径】指标值**逐字透传**源 `actual_value`（本构件不改义、不重算；口径的唯一事实源是
--   契约 `contracts/common/lemeng.branch_indicator.json` 与本文件头注）。
-- 【形态】宽表：一行一店日、一指标一列（staging 是长表 metric 续行，本层转列）。
--   新增指标 = staging 多一类 metric 行 + 本文件加一列 + l1_metrics.yml 加一条指标声明。
-- 【缺行语义（必读）】源侧「本月无数据」的门店**不出现在响应里** ⇒ 该店日在湖里无行；
--   本构件按 metric 做 `sum(case … else 0)` ⇒ **无该指标行的店日该列为 0，不是 NULL**。
--   因而本构件**分不出「源侧没报」与「报了 0」**——要这个区分只能读 staging 的行集，
--   不要在消费面拿本列的 0 当「源侧确认为零」。
-- 【门店维】只留键 `branch_num`（与 fct_branch_expense 同形）：店名/战区走
--   `dim_lemeng_branch` join，别在 fct 里冗余维度列。
with agg as (
    select
        system_book,
        bizday,
        branch_num,
        sum(case when metric = 'transfer_money' then coalesce(actual_value, 0) else 0 end)::numeric(20,2) as transfer_money
    from {{ ref('stg_lemeng_branch_indicator') }}
    group by 1, 2, 3
)
select
    agg.system_book,
    {{ subject_org() }} as org,
    agg.bizday,
    agg.branch_num,
    agg.transfer_money
from agg
