{{
    config(materialized='table')
}}
-- fct_client_expense.sql — 客户费用构件（W2 2026-10-13）。粒度 (system_book, bizday, client_fid, other_inout_kind)。
-- 【构件列（E 的客户面）】ep = Σ amount where flag=false（应付）；er = Σ where flag=true（应收）；
--   e_net = ep − er（符号语义待裁9）。金额保留红字。其余同 fct_branch_expense。
with agg as (
    select
        system_book,
        bizday,
        client_fid,
        other_inout_kind,
        sum(case when other_inout_flag = false then coalesce(other_inout_money, 0) else 0 end)::numeric(20,2) as ep_payable,
        sum(case when other_inout_flag = true then coalesce(other_inout_money, 0) else 0 end)::numeric(20,2) as er_receivable,
        count(distinct other_inout_bill_no) as bill_count
    from {{ ref('stg_lemeng_client_expense') }}
    group by 1, 2, 3, 4
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    client_fid,
    other_inout_kind,
    ep_payable,
    er_receivable,
    (ep_payable - er_receivable)::numeric(20,2) as e_net,
    bill_count
from agg
