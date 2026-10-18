{{
    config(materialized='table')
}}
-- recon_run.sql — 口径对账的**运行台账（每次控制执行一行）**（消费面 spec §12.4）
--
-- 【它回答什么】这次对账**跑成了吗**？源可用吗？有几笔不平、最大一笔多大？ —— **设闸 · 看趋势**。
-- 逐笔的「差多少/为什么/谁认领/何时到期」在 `recon_break`。
--
-- 【四态】（spec §2.2）
--   `not_evaluated` — **源侧一个值都没返回**（挂了/不可信）。**绝不能记成 ok**：
--                     否则「源故障」与「真对了」在台账上长得一模一样。
--   `ok`            — 有源侧数据且**每一笔差都是 0**
--   `within_tol`    — 有非零差，但**全部在容差内**（可能正被一个具名 reason_code 接受）
--   `over_tol`      — 至少一笔超容差（含**到期后自动转红**的那些）
--
-- 【健康判据】**不是** `sum(diff) ≈ 0`——正负可抵消（A 店 +100、B 店 −100）。
--   要看 `break_count`（超容差笔数）与 `max_break`（最大单笔差）的**趋势**。
--   2026-10-18 实测反例：64188 某日合计差 −48,650.80，但**每一笔有值门店的差都 ≤19.8**，
--   缺口全在 23 家「源侧未返回」的店上。
--   ⇒ 再加一条**先看 `source_cover_pct`**：<1 时「不平」的成因可能根本不在账上，
--     而在源这一次少返回（同日原样重跑即全返，见下方该列的注释）。
with b as (
    select * from {{ ref('recon_break') }}
),
agg as (
    select
        system_book,
        org,
        bizday,
        control,
        count(*)                                                     as rows_total,
        count(*) filter (where source_value is not null)              as rows_source,
        count(*) filter (where platform_value is not null)            as rows_platform,
        count(*) filter (where missing_side = 'source')               as rows_missing_source,
        count(*) filter (where missing_side = 'platform')             as rows_missing_platform,
        count(*) filter (where diff <> 0)                             as nonzero_count,
        count(*) filter (where verdict = 'over_tol')                  as break_count,
        max(case when verdict = 'over_tol' then abs(diff) end)        as max_break,
        max(abs(diff))                                               as max_abs_diff,
        max(tol_applied)                                             as tol_max,
        min(tol_applied)                                             as tol_min,
        max(reason_code)                                             as reason_code,
        max(expires_on)                                              as expires_on,
        max(computed_at)                                             as evaluated_at
    from b
    group by 1, 2, 3, 4
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    control,
    case
        when rows_source = 0 then 'not_evaluated'
        when break_count > 0 then 'over_tol'
        when nonzero_count > 0 then 'within_tol'
        else 'ok'
    end as status,
    rows_total,
    rows_source,
    rows_platform,
    rows_missing_source,
    rows_missing_platform,
    -- 【源返回率】= rows_source / rows_total：<1 就是「源侧有的店没回数」。
    -- 为什么要单列出来（2026-10-18 实测教训）：那时 64188/10-15 源只返 51/74 家，
    -- 台账记成 23 笔 `missing_side=source` 的 break（= `over_tol`）——**形状与「真不平」一模一样**，
    -- 我据此写成「23 家结构性缺口」并推给客户；**同一条请求原样重跑即返 74 家全部**。
    -- ⇒ 有了这一列，「源少返回」与「账不平」在看板上可分：`source_cover_pct < 1` 先怀疑源，
    --   不要先怀疑账。它不是判据（不改变四态），只是把已算出的两个数摆出来。
    round(rows_source * 1.0 / nullif(rows_total, 0), 4)          as source_cover_pct,
    nonzero_count,
    break_count,
    max_break,
    max_abs_diff,
    tol_max,
    tol_min,
    reason_code,
    expires_on,
    evaluated_at
from agg
