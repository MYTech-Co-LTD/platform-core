{{
    config(materialized='table')
}}
-- recon_break.sql — 口径对账的**差异台账（逐笔）**（消费面 spec §12.4；control totals + break management）
--
-- 【它是什么】湖侧自算 vs 乐檬报表引擎（`itemsales`）的逐店差，按 **control** 拆两侧：
--   · `caliber_sale` 销售侧：平台换货三半边公式 vs 源 `sale_money`
--   · `caliber_net`  净额侧：平台（#813 起冲退货）vs 源 `sale_money − return_money`
-- 粒度 = 账套 × 对账业务日 × control × 门店。
--
-- 【与 recon_run 的分工】本表回答「**这笔差多少、为什么、谁认领、何时到期**」；
--   `recon_run` 回答「**这次跑成了吗、几笔不平、最大一笔多大**」。分开的理由：
--   `not_evaluated`（源不可用）与 `break_count=0`（真对了）在明细粒度上**长得一样**（都是零行）。
--
-- 【容差不在这里定义】它来自 `dbt/seeds/recon_tolerances.csv`（**配置不是数据**）：
--   `tol = max(abs_tol, pct_tol% × |源侧值|)`，并记 `bound_by` 是哪一档生效。
--   ⚠️ **到期语义**：`expires_on < bizday` ⇒ 该 control 的 `abs_tol` **视为 0**
--   ⇒ 任何非零差自动转 `over_tol`。这是把 `NET_ABS_TOL=200` 这个**匿名活口**
--   （#814 退货晚到的过渡容差）变成**具名、会到期**的东西——到期自动转红，不靠人记得。
--
-- 【missing_side】源侧/平台侧任一为空都记账（源没返回这家店 = 真实的覆盖缺口，
--   不是「差 0」）——2026-10-18 实测 64188 有 23 家「湖有源无」贡献 −48,650.80，
--   而**每一行都有值的那些店只差 −19.8**：合计不平、每行都平的典型样本。
with src as (
    select * from {{ ref('recon_fact') }}
),
tol as (
    select
        control,
        abs_tol,
        pct_tol,
        nullif(reason_code, '') as reason_code,
        expires_on,
        nullif(disposition, '') as disposition,
        nullif(disposition_by, '') as disposition_by
    from {{ ref('recon_tolerances') }}
),
unpivot as (
    select
        system_book, org, bizday, branch_num, computed_at,
        'caliber_sale' as control,
        platform_sale  as platform_value,
        source_sale    as source_value
    from src
    union all
    select
        system_book, org, bizday, branch_num, computed_at,
        'caliber_net'  as control,
        platform_net   as platform_value,
        source_net     as source_value
    from src
),
calc as (
    select
        u.*,
        t.abs_tol,
        t.pct_tol,
        -- 到期 ⇒ 绝对容差作废（视为 0）
        case
            when t.expires_on is not null and t.expires_on < u.bizday then 0
            else t.abs_tol
        end as abs_tol_eff,
        t.reason_code,
        t.expires_on,
        t.disposition,
        t.disposition_by,
        round(coalesce(u.source_value, 0) - coalesce(u.platform_value, 0), 2) as diff
    from unpivot u
    join tol t on t.control = u.control
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    control,
    branch_num,
    platform_value,
    source_value,
    diff,
    round(greatest(abs_tol_eff, abs(coalesce(source_value, 0)) * pct_tol / 100.0), 2) as tol_applied,
    case
        when abs_tol_eff >= abs(coalesce(source_value, 0)) * pct_tol / 100.0 then 'abs'
        else 'pct'
    end as bound_by,
    case
        when abs(diff) <= greatest(abs_tol_eff, abs(coalesce(source_value, 0)) * pct_tol / 100.0)
            then 'within_tol'
        else 'over_tol'
    end as verdict,
    case
        when source_value is null and platform_value is not null then 'source'
        when platform_value is null and source_value is not null then 'platform'
    end as missing_side,
    reason_code,
    -- 已到期的到期日不再回显（它已经生效过一次，留着会误导成「仍被接受」）
    case when expires_on is not null and expires_on < bizday then null else expires_on end as expires_on,
    disposition,
    disposition_by,
    computed_at
from calc
