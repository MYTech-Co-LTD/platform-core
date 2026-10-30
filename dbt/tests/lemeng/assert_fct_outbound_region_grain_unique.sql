-- assert_fct_outbound_region_grain_unique — 战区出库面的粒度唯一性（#1181）。
-- 粒度 = (system_book, bizday, channel_type, region_l1_bucket)。多一行 = 下游按战区汇总时静默翻倍。
select system_book, bizday, channel_type, region_l1_bucket, count(*) as n,
       '粒度不唯一：同一 (账套, 日, 通道, 一级战区) 出现多行' as note
from {{ ref('fct_outbound_region') }}
group by 1, 2, 3, 4
having count(*) > 1
