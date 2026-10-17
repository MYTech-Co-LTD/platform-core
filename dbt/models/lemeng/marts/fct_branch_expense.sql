{{
    config(materialized='table')
}}
-- fct_branch_expense.sql — 门店费用构件（W2 2026-10-13；口径在 ④ 定义一次）。
-- 【粒度】(system_book, bizday, branch_num, expense_type)——可上卷到店日。
-- 【构件列（客户公共定义 E 的门店面）】
--   ep_payable = Σ amount where direction='应付'；er_receivable = Σ amount where direction='应收'；
--   e_net = ep − er（净费用；**符号语义待裁9 客户回签**）。金额保留红字；null 不当 0（客户统一控制）。
-- 【单据口径】全部采集行（管线请求侧已筛 state_code=3 审核态）；bill_no 去重计数作单数面。
-- 【org / 精度】同 fct_hq_outbound。
with agg as (
    select
        system_book,
        bizday,
        branch_num,
        expense_type,
        sum(case when direction = '应付' then coalesce(amount, 0) else 0 end)::numeric(20,2) as ep_payable,
        sum(case when direction = '应收' then coalesce(amount, 0) else 0 end)::numeric(20,2) as er_receivable,
        count(distinct bill_no) as bill_count
    from {{ ref('stg_lemeng_branch_expense') }}
    group by 1, 2, 3, 4
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    branch_num,
    expense_type,
    ep_payable,
    er_receivable,
    (ep_payable - er_receivable)::numeric(20,2) as e_net,
    bill_count
from agg
