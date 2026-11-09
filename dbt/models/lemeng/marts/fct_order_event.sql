{{
    config(
        materialized='incremental',
        unique_key=['system_book', 'bizday', 'order_no', 'order_detail_num'],
        incremental_strategy='delete+insert',
        on_schema_change='sync_all_columns'
    )
}}
-- fct_order_event.sql — 订单事件（**降级版：类型 + 时间 + 关联单号，不做状态迁移**）（W7 Task 4）。
--
-- 【为什么是降级版】真机验证（2026-11-07）：单日 9,361 单中 **0 单**有多状态 ⇒ 状态迁移
--   不可重建（没有中间态流水可回放）。所以本表只回答「**什么时候发生了什么类型的单**」，
--   不推断因果、不做状态机。需要状态分布时读 `state` 列（SALE 含 CANCELED，见下）。
--
-- 【粒度】`(system_book, bizday, order_no, order_detail_num)` —— **行级事件**（源即行级；
--   2026-10-20 实测 15,267 行 = SALE 15,157 + FULL_RETURN 69 + PARTIAL_RETURN 9 + REPAID_RETURN 32）。
--   唯一性由 `assert_fct_order_event_grain_unique` 钉住。
--
-- 【调度】hourly 档按 `config.materialized:incremental` 自动纳入（每小时重算最近 7 天）；
--   三条表级审计属**全史档**（`tag:audit`，含固定日 2026-10-20 的锁），随 full 档跑。
--
-- 【范围（降级边界）】**首建只回填最近 30 天**（`current_date` 按 Asia/Shanghai 业务日）；
--   之后每次增量只重算最近 7 天（`delete+insert`，同 fct_retail_sale 的 #1520 形态）。
--   **更早历史不在本表**——2026-11-07 真机实测：全历史 CTAS 会与同机全量物化抢内存把仓库打
--   进 recovery（40s 崩）；行级事件 7.4M 行不宜单语句全量。需要更早历史时按天分段回填另议。
--
-- 【类型映射】按 `order_transaction_type`（订单级字段，逐行冗余）：
--   SALE_ORDER → SALE（**含 CANCELED 的销售单**；取消状态留在 `state` 列，不另立事件类型，
--                      与实测分布一致）；FULL_ORDER_RETURN → FULL_RETURN；
--   PARTIAL_ORDER_RETURN → PARTIAL_RETURN；REPAID_RETURN → REPAID_RETURN；其余 → OTHER。
--   `OTHER` 由 `audit_order_event_type_counts_20261020` 的分布断言兜底（真机当日为 0）。
--
-- 【时间】`event_time` = `order_time`（成交时间）；`operate_time` = `order_operate_time`（操作时间）。
--   **不做 as-of 或状态迁移**；两列都保留是为「按发生时刻排序」与「按操作时刻对账」。
--
-- 【关联单号】`ref_order_no` = `order_ref_billno`（退货关联原单号）。
--   2026-10-20 实测覆盖率：**201/15,267 ≈ 1.3%**（有原单号的**全部行**；其中退货行 78/110 带原单号）。
--   ⚠️ 对账自 2026-10-05 起**不再依赖**它（见 `contracts/common/lemeng.retail_order_line.json`）；
--   本表只如实提供，不把它当因果链。
select
    r.system_book,
    {{ subject_org() }} as org,
    r.bizday,
    r.order_no,
    r.order_detail_num,
    case r.order_transaction_type
        when 'SALE_ORDER'           then 'SALE'
        when 'FULL_ORDER_RETURN'    then 'FULL_RETURN'
        when 'PARTIAL_ORDER_RETURN' then 'PARTIAL_RETURN'
        when 'REPAID_RETURN'        then 'REPAID_RETURN'
        else 'OTHER'
    end                          as event_type,
    r.order_transaction_type,
    r.state,
    r.order_time                  as event_time,
    r.order_operate_time          as operate_time,
    r.order_ref_billno            as ref_order_no,
    r.branch_num,
    r.branch_name,
    r.item_num,
    r.sale_money,
    r.quantity
from {{ ref('stg_lemeng_retail_order_line') }} r
{% if is_incremental() %}
-- 增量窗口：只重算最近 7 天（首建走 else 的 30 天，不回看全史）。
where r.bizday >= (select max(bizday) - interval '7 days' from {{ this }})
{% else %}
where r.bizday >= (cast(now() at time zone 'Asia/Shanghai' as date) - interval '30 days')
{% endif %}
{% if env_var('MAT_CLOSED_BEFORE', 'false') == 'true' %}
-- 物化闭窗读（2026-11-09）：tick 采集每 10 分钟重写**当前小时**的分区，物化若同时读它就会撞
-- `HTTP Error: ETag ... was initially X and now returned Y` ⇒ 整轮 hourly 判红（实测 06:30 那轮
-- 读 `bizday=2026-11-09/hour=14`）。与 fct_retail_sale / fct_retail_quantity / fct_retail_item_sale
-- 同一口径：闭窗读只取「今天已过去的小时」，当前小时留给下一档。
and not (r.bizday = current_date and r.hour >= extract(hour from current_timestamp))
{% endif %}
