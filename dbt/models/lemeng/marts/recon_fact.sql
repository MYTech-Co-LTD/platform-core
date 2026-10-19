{{
    config(materialized='table')
}}
-- recon_fact.sql — 口径对账**逐店两侧事实**（平台侧取构件 + 源侧取快照；2026-10-19，issue #920）
--
-- 【它是什么】把两件事拼成一张逐店事实表：
--   · **平台侧** = 构件 `fct_retail_sale`（口径的唯一实现）的 `sale_amount` / `net_amount`；
--   · **源侧**   = `stg_lemeng_recon_source`（乐檬报表端点逐店返回值）。
--   粒度 = 账套 × 对账业务日 × 门店。
--   ⚠️ **不再有 `chunk`**：chunk 只是端点「单次 ≤100 家」的分页手段，**不是事实维度**——
--      2026-10-19 起比较归 dbt，分页细节留在采集侧（旧 `recon_preagg` 的 chunk 分区随之退役）。
--
-- 【为什么平台侧读构件而不自算】见 docs/architecture.md §4.1 B11：对账是**消费者**。
--   自带一份等价算式 = 同一业务规则两个并列实现、靠人手同步 ⇒ 静默漂移
--   （#813 容差地板 / #917 退货侧赠品判别式，两次都是这个形态）。
--
-- 【为什么行集不会丢】`stg_lemeng_recon_source` 里**每个被请求的门店都有一行**（采集侧按父管线的
--   门店清单左连端点返回；端点没返回的店 `source_*` 为 NULL）⇒ 请求集 = 本表行集的下界。
--   反方向用 FULL JOIN 兜：若构件当日有一家店却没进请求集（理论上不该发生，请求集 = 湖侧
--   FINISHED 门店集 ⊇ 构件行集），该行 `source_*` 为 NULL ⇒ `missing_side='platform'`，与旧
--   `lagg`（湖侧自算全集）的语义一致。
--   ⚠️ 构件侧**必须按 (账套, 营业日) 收窄**：`fct_retail_sale` 是全书全历史的表，不收窄会把
--   所有日期都卷进来、并全部记成 `missing_side='source'` 的假缺口。
--
-- ⚠️ 本模型放在 **marts/**（不是 staging/）：`staging/` 下的文件会被 `gen-data-projection.mjs`
--    按契约重写列区，而本模型不读 parquet、不对应任何湖契约。
with src as (
    select * from {{ ref('stg_lemeng_recon_source') }}
),
keys as (
    select distinct system_book, bizday from src
),
mart as (
    select
        cast(f.system_book as varchar) as system_book,
        f.bizday                       as bizday,
        f.branch_num                   as branch_num,
        f.sale_amount                  as sale_amount,
        f.net_amount                   as net_amount
    from {{ ref('fct_retail_sale') }} f
    join keys k
        on  k.system_book = cast(f.system_book as varchar)
        and k.bizday      = f.bizday
)
select
    coalesce(s.system_book, m.system_book) as system_book,
    {{ subject_org() }}                    as org,
    coalesce(s.bizday, m.bizday)           as bizday,
    coalesce(s.branch_num, m.branch_num)   as branch_num,
    m.sale_amount                          as platform_sale,
    s.source_sale                          as source_sale,
    m.net_amount                           as platform_net,
    s.source_net                           as source_net,
    coalesce(s.computed_at, now())         as computed_at
from src s
full join mart m
    on  s.system_book = m.system_book
    and s.bizday      = m.bizday
    and s.branch_num  = m.branch_num
