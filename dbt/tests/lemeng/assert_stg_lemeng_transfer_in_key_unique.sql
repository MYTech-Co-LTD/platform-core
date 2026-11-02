-- assert_stg_lemeng_transfer_in_key_unique.sql — 复合粒度唯一。
--
-- ⚠️ **`use_unit` 入键**（2026-11-02，理由与 assert_stg_lemeng_transfer_out_key_unique.sql
--   同段注释同源）：源侧会把同一 (单号, 商品, 批次) 按两种计量单位各记一行（实测
--   2026-01-30、商品 997，金额均 0.00，重采复现）。不同单位 = 不同行，故纳入自然键；
--   同键同单位的值冲突仍会红。
select
    system_book,
    bizday,
    order_no,
    item_num,
    lot_number,
    use_unit,
    count(*) as rows_in_grain
from {{ ref('stg_lemeng_transfer_in') }}
group by
    system_book,
    bizday,
    order_no,
    item_num,
    lot_number,
    use_unit
having count(*) > 1
