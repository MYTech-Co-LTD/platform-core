{{
    config(materialized='table')
}}
-- fct_request_fulfillment.sql — 要货满足率构件（W3 余项 2026-10-15，#677）。
-- 【粒度】(system_book, bizday, branch_num, item_num)。
-- 【语义】店×商品×日的**总量对照**（W3 计划 Task 5 处方）：D15 要货 vs D16 调入，
--   正典条款 = client-master 03-06（docs/superpowers/specs/2026-10-12-lemeng-metrics-client-master.md）。
-- ⚠️ 行级履约关联在当前湖面**不可构造**（不是没验证，是没字段）：客户 03-06 的三跳链
--   要货单(YH)→调出单(MO)→调入单(MI) 中，D16.related_order_no 指向 **MO 而非 YH**
--   （契约 v2 实测），而 D01（transfer_out）契约**没有采集 related_order_no** ⇒ YH→MO
--   回指环缺失；且湖面无稳定行号（03-06 数据条件「需稳定原行号」不满足）。
--   ⇒ 只做同日聚合对照，不做行级归因；三跳链补采后另批升级。
-- ⚠️ 边界（X06）：源端无承诺时间 ⇒ 只出「截止日满足率」（同日对照），**不标按期**。
-- ⚠️ 两向偏差并存（分子既偏上又偏下，真值在区间内）：
--   · 跨日履约不计入（次日到货的行在本日口径下记未满足）⇒ 分子**下界**；
--   · shipped 侧不筛驱动来源（总仓主动配送也计入「发出」）⇒ 分子**上界**。
-- ⚠️ D15 侧「有效要货行」= quantity > 0（0/负数行非有效要货）；**不按 transfer_state 筛**——
--   那是源端配送状态（真样本「部分发货」），与数量口径未勾稽，不进本构件（可作旁证另批）。
-- ⚠️ shipped 侧 = D16 调入（**到店**口径，计划处方）；客户公式的「发出」若指总仓出库
--   （D01 out_quantity）是另一个对照面，另批。D16 契约无 state 列，不筛审核态。
--   单位：两侧都取基本单位 quantity；同店同品同日的分次调入在日粒度内自然累计
--   （03-06「分次履约先累计」的聚合近似）。
with requested as (
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        sum(quantity)::numeric(20,6) as requested_quantity,
        count(*)                     as requested_line_count
    from {{ ref('stg_lemeng_request_order') }}
    where quantity > 0
    group by 1, 2, 3, 4
),
shipped as (
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        sum(quantity)::numeric(20,6) as shipped_quantity
    from {{ ref('stg_lemeng_transfer_in') }}
    group by 1, 2, 3, 4
)
select
    r.system_book,
    {{ subject_org() }} as org,
    r.bizday,
    r.branch_num,
    r.item_num,
    r.requested_quantity,
    r.requested_line_count,
    coalesce(s.shipped_quantity, 0)::numeric(20,6) as shipped_quantity,
    case
        when coalesce(s.shipped_quantity, 0) >= r.requested_quantity
            then r.requested_line_count
        else 0
    end as fulfilled_line_count
from requested r
left join shipped s
       on r.system_book = s.system_book
      and r.bizday = s.bizday
      and r.branch_num = s.branch_num
      and r.item_num = s.item_num
