-- 粒度唯一性断言（W7 Task 1）：(system_book, bizday, branch_num, item_num) 必须唯一。
-- 粒度漂移会让按商品聚合的分析静默偏大，且没有任何单列约束抓得住（各单键都不唯一）。
select system_book, bizday, branch_num, item_num, count(*) as n
from {{ ref('fct_retail_item_sale') }}
group by 1, 2, 3, 4
having count(*) > 1
