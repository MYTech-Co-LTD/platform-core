-- assert_fct_transfer_zero_cost_item_grain_unique.sql — 结构断言：零成本清单的粒度必须唯一。
--
-- 粒度 = (system_book, bizday, item_num)（见模型头注「账套 × 业务日 × 商品」与 group by 1,3,4）。
-- 返回任何行即失败。
--
-- 为什么值得有：这是给采购/门店**按商品定位成本率缺口**的清单。粒度一放大（item_profile
-- 的 left join 漏键、或 group by 少列），同一商品同一天会出现多行、`zero_cost_amount` 被拆散
-- 或重复，业务照着清单去找源系统就会白跑。
select
    system_book,
    bizday,
    item_num,
    count(*) as row_count
from {{ ref('fct_transfer_zero_cost_item') }}
group by system_book, bizday, item_num
having count(*) > 1
