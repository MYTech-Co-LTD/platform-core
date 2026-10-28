{{ config(materialized='table') }}
-- fct_transfer_zero_cost_item.sql — **零成本出库的可复核清单**（2026-10-28，#816 定案）。
--
-- 【它解决什么】`lemeng:transfer:zero_cost_exposure_amount` 给出一个金额，但业务看完金额
--   没法行动——不知道是哪些商品、多少天、该找谁维护成本率。本表把暴露面摊成
--   （账套 × 业务日 × 商品）粒度，供采购/门店按商品定位**成本率主数据缺口**。
--
-- 【为什么是独立表而不是往 fct_transfer_line_quality 加列】后者粒度是店日（一行一日一店），
--   商品级展开会让它行数 ×商品数；且这是**运维/治理用清单**，不是指标体系的一等构件
--   ⇒ 单独一张小表，专门给人查。
--
-- 【口径】与 fct_transfer_line_quality 的 transfer 域**逐字同款**（state_code=3、
--   out_branch_num=99、排除店间直调）；零成本行的判据同 zero_cost_amount
--   （`coalesce(out_money,0) <> 0 and subtotal = 0`）。
--   ⚠️ **本表不做「未核 vs 真零」的区分**——源端两态不可分（正典 §1.4.2）。
--   表里只给**原始计数**（该商品全期有多少天带成本 / 零成本）与金额，**不下结论**：
--   跨多日持续零成本（如奇异果 9 天）与单日偶发在数据上长得一样，判定要靠业务问源系统，
--   数仓这边只负责把可查的证据摊平（#816 定案，正典 §1.4.2）。
with base as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        item_num,
        item_name,
        out_money,
        subtotal
    from {{ ref('stg_lemeng_transfer_out') }}
    where state_code = 3
      and out_branch_num = 99
      and branch_num <> out_branch_num
),
zero_lines as (
    select *
    from base
    where coalesce(out_money, 0) <> 0
      and subtotal = 0
),
item_profile as (
    -- 该商品在本域**全期**的形态：有多少天带成本、多少天零成本 ⇒ 供人判断「持续未核」还是「偶发」
    select
        system_book,
        item_num,
        count(distinct bizday) filter (where subtotal is not null and subtotal <> 0) as days_with_cost,
        count(distinct bizday) filter (where subtotal = 0)                            as days_zero_cost
    from base
    group by 1, 2
)
select
    z.system_book,
    {{ subject_org() }} as org,
    z.bizday,
    z.item_num,
    max(z.item_name)                                                    as item_name,
    count(*)                                                            as zero_cost_lines,
    count(distinct z.order_no)                                          as zero_cost_orders,
    sum(z.out_money)::numeric(20,2)                                     as zero_cost_amount,
    coalesce(max(p.days_with_cost), 0)                                  as item_days_with_cost,
    coalesce(max(p.days_zero_cost), 0)                                  as item_days_zero_cost
from zero_lines z
left join item_profile p
    on z.system_book = p.system_book
   and z.item_num = p.item_num
group by 1, 3, 4
