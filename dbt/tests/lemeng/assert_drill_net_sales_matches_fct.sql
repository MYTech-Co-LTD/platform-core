-- assert_drill_net_sales_matches_fct — 下钻口径同源不变量（spec 2026-10-21 §4 Phase 1）。
-- 独立复算（与 audit_* 同定位）：从直读湖视图**逐单**求完整 compose（sale − return：销售单 =
-- 折半净贡献，退货单 = 0 − 退货冲减 = 负冲减），按店×日上卷，与 fct_retail_sale.net_amount
-- 逐分对（numeric(20,2)，1 分容差）。
-- ⚠️ atomic_value 必须是**完整 compose**（sale 与 return 两个组件都在）——只算 sale 侧对
-- net_amount 必恒红（退货冲减缺席）。⚠️ 两个组件都必须保持**聚合形态**（sum/max 在 order 粒度
-- 的 GROUP BY 内求值，即 YAML 组件体的原样 body）——裸列引用 = GROUP BY 编译错（42803）。
-- 判别式逐字取自 fct_retail_sale.sql（销售正形态 l.85-86 /
-- 退货绝对值形态 l.129-130，#908），漂移 = 本测试红。只测**闭窗日**（bizday < 上海今天）：
-- 当日分区被 tick 持续重写，两侧时点不同不可比。
-- 生产口径唯一事实源是 dbt/semantics/l1_metrics.yml 的 measures/compose；本文件漂移 ⇒ 本测试红。
with drill as (
    select system_book, bizday, branch_num, sum(atomic_value) as v
    from (
        select system_book, bizday, branch_num, order_no,
               ((case when sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then 1 else 0 end) = 0 then 0
                      else (sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' and
                           (order_detail_std_price > 0 and sale_money > 0 and quantity > 0 and
                            abs(discount_money - order_detail_std_price * quantity) <= 0.02) then 0 else sale_money end)
                           + max(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_total_money end)) / 2
                           - sum(case when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER' then order_detail_share_discount else 0 end)
                 end)
                -
                sum(case when order_transaction_type like '%RETURN%' and state = 'FINISHED' and
                      (order_detail_std_price > 0 and abs(sale_money) > 0 and abs(quantity) > 0 and
                       abs(abs(discount_money) - order_detail_std_price * abs(quantity)) <= 0.02) then 0
                      when order_transaction_type like '%RETURN%' and state = 'FINISHED' then sale_money + order_detail_share_discount
                      else 0 end)) as atomic_value
        from {{ ref('vw_lemeng_retail_order_line') }}
        where state = 'FINISHED'
        group by system_book, bizday, branch_num, order_no
    ) t
    group by system_book, bizday, branch_num
),
fct as (
    select system_book, bizday, branch_num, sum(net_amount) as v
    from {{ ref('fct_retail_sale') }}
    group by system_book, bizday, branch_num
)
select drill.system_book, drill.bizday, drill.branch_num, drill.v as drill_v, fct.v as fct_v,
       '下钻组件上卷与聚合口径不一致（measures/compose 与 fct_retail_sale 漂移：判别式、折半式或退货组件抄错）' as note
from drill
join fct using (system_book, bizday, branch_num)
where drill.bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
  and abs(drill.v - fct.v) > 0.01
union all
select null, null, null, null, null, '空转绿：闭窗日两侧有一侧为空，对账在空集上「通过」是空转绿'
where (select count(*) from drill where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
   or (select count(*) from fct where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)) = 0
