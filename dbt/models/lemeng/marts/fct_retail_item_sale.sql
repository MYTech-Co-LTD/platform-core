{{ config(
    materialized='incremental',
    unique_key=['system_book', 'bizday', 'branch_num', 'item_num'],
    incremental_strategy='delete+insert',
    on_schema_change='sync_all_columns'
) }}

-- fct_retail_item_sale.sql — 零售商品粒度事实（W7 Task 1，issue #1530）。
--
-- ★ 为什么另建一张，而不是给 `fct_retail_sale` 加 `item_num`：
--   后者是**净销售额口径模型**，它的粒度为 (system_book, bizday, branch_num)，且净额是
--   **逐单计算再求和**（`(Σ非赠品行额 + order_total_money)/2 − Σ分摊折扣`）——
--   `order_total_money` / `share_discount` 是**订单级**金额，把商品加进 GROUP BY 就必须先
--   定义「订单级金额怎么摊到商品」，那等于**改了净销售额口径**（B11：口径只在 dbt 定义一次，
--   改口径先改 definition）。⇒ 净销售额继续留在 `fct_retail_sale`，本模型只回答
--   「按商品卖了多少」，是**行级金额**，**不等于**净销售额，别混用。
--
-- 粒度：**(system_book, bizday, branch_num, item_num)** —— 账套 × 业务日 × 门店 × 商品。
--   源侧覆盖实测（2026-10-20）：`stg_lemeng_retail_order_line` 15,267 行 **100% 有 item_num**，
--   当日 1,858 个商品。
--
-- 口径（逐字）：
--   · sale_amount    = 销售侧行金额（state='FINISHED' 且 order_transaction_type='SALE_ORDER'）
--   · return_amount  = 退货侧行金额（state='FINISHED' 且 order_transaction_type like '%RETURN%'，
--                      取**绝对值**——源数据退货行带负号，见 #908 同款陷阱）
--   · net_amount     = sale_amount − return_amount（**行级**；与 `fct_retail_sale.net_amount`
--                      口径不同，不可互相替代）
--   · sale_quantity  = 销售侧数量（同上条件）
--   · order_count    = 该 (店,日,商品) 上出现过的去重订单数
--
-- `org` 是主体列：用 `{{ subject_org() }}` 直接注入常量（同 fct_retail_sale 的理由与形状），
-- 不参与口径、不进 GROUP BY。
--
-- 精度：聚合结果显式 `::numeric(20,2)`（pg_duckdb 对无精度 numeric 会拒绝跨引擎查询，
-- 见 `fct_retail_sale.sql` 头注的实测原文）。

with src as (
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        sum(case
              when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'
              then sale_money else 0
            end)                                              as sale_amount,
        sum(case
              when state = 'FINISHED' and order_transaction_type like '%RETURN%'
              then abs(sale_money) else 0
            end)                                              as return_amount,
        sum(case
              when state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'
              then quantity else 0
            end)                                              as sale_quantity,
        count(distinct order_no)                              as order_count
    from {{ ref('stg_lemeng_retail_order_line') }}
    where item_num is not null
    -- ⚠️ **增量过滤必须下推进 src**（2026-11-07 真机实证，issue #1620）：只在最外层过滤
    --   ⇒ 先聚合**全史**（730 天、全部小时分区）再扔掉，单轮实测 **285s**；而下推成
    --   **编译期日期字面量**后 read_parquet 能按 bizday 分区裁剪（同 #1524 的教训）。
    --   慢的直接后果不只是耗时：285s 的长扫描与 10 分钟一班的采集**必然重叠**，
    --   读到正在被重写的当日小时文件 ⇒ ETag 变化 ⇒ 整轮 ERROR（5 次里 4 次）。
    {% if is_incremental() %}
    and bizday >= {{ incremental_cutoff(7) }}
    {% endif %}
    {% if env_var('MAT_CLOSED_BEFORE', 'false') == 'true' %}
    -- 物化闭窗读（2026-11-08 P0）：tick 采集每 10 分钟重写当前小时，物化读同一分区会撞 ETag。
    and not (bizday = current_date and hour >= extract(hour from current_timestamp))
    {% endif %}
    group by 1, 2, 3, 4
)

select
    {{ subject_org() }}                     as org,
    system_book,
    bizday,
    branch_num,
    item_num,
    coalesce(sale_amount, 0)::numeric(20,2)   as sale_amount,
    coalesce(return_amount, 0)::numeric(20,2) as return_amount,
    (coalesce(sale_amount, 0) - coalesce(return_amount, 0))::numeric(20,2) as net_amount,
    coalesce(sale_quantity, 0)::numeric(20,3) as sale_quantity,
    coalesce(order_count, 0)::bigint          as order_count
from src
