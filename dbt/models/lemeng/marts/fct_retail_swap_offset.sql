{{
    config(materialized='table')
}}
-- fct_retail_swap_offset.sql — **差额换货的抵扣额**（描述性指标，2026-11-21，issue #2630）
--
-- 【它是什么】per(账套, 营业日, 门店) 的 `swap_offset = Σ(明细合计 − order_total_money)`，
--   只统计 **`0 < order_total_money < 明细合计`** 的 FINISHED SALE_ORDER —— 即「顾客带回商品抵扣
--   一部分货款、再补差价」的**差额换货单**（等价换货 `total = 0` 不在此列，那类已由退货侧
--   `return_amount` 的换货半边处理）。
--
-- 【它不是什么】**不参与任何口径**——不改 `sale_amount` / `return_amount` / `net_amount`。
--   报表能从单据里认出「哪几行是退回的」，而**接口不暴露这个标记**（`order_detail_type` 一律
--   「商品项目」，`present_flag` / `policy_*` 全空，2026-11-21 实测）。若在此处猜映射，
--   就是给同一条业务规则造第二份实现（违反 architecture §4.1 B11）。故只出**量**，不出判定。
--
-- 【它解决什么】对账侧用它给「超容差但 ≤ 抵扣额」的差**归因**（`swap_split_unrecognized`），
--   把「疑似换货拆分不可识别」与「采集缺口」分开——后者不该被前者掩护。
--   上界用法（2026-11-14 实测）：店12 offset 34.00 / 实测差 17.00；店21 offset 62.42 / 实测差 0
--   ⇒ **`|diff| ≤ swap_offset` 成立（上界），但「diff ≈ offset」不成立**，别当等式。
--
-- 【粒度】账套 × 营业日 × 门店；只出有混合单的店日（无该形态的店日不出行，join 时 coalesce 0）。
--
-- 【闭窗读（#2674，2026-11-22）】只读**已封版日**（`bizday < 上海今天`）：本模型是无窗口的
--   全史 CTAS，而 staging 会把**今天的活 hour 分区**一并 glob 进来 —— 建表期间采集正在重写
--   那个分区，DuckDB 的 ETag 校验一旦发现文件换版就整段失败（实测 668s 后撞
--   `bizday=2026-11-22/hour=14`，白跑）。排除今天 ⇒ 不读活分区 ⇒ 与采集解耦。
--   代价：当天数据不在表里，**次日 tables 档重建时补齐**——本表是日终对账的归因上界，
--   消费方（recon_*）只在 T-3 之后使用，当天缺失不影响判定（⑳ 为月度累计 WARN，同理）。
with per_order as (
    select
        system_book,
        bizday,
        branch_num,
        order_no,
        max(order_total_money) as order_total_money,
        sum(sale_money)        as detail_sum
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_transaction_type = 'SALE_ORDER'
      -- ⚠️ 日期必须是**编译期字面量**（Jinja 求值）：`now()` 形态 pg_duckdb 放弃文件裁剪，
      --    今天的活分区照样被打开、ETag 照样撞（⑰ 断言实测过同一坑）。run_started_at 是 UTC，
      --    +8h 得沪时钟，跨 CST 零点也正确。
      and bizday < date '{{ (run_started_at + modules.datetime.timedelta(hours=8)).strftime('%Y-%m-%d') }}'
    group by 1, 2, 3, 4
)
select
    system_book,
    {{ subject_org() }} as org,
    bizday,
    branch_num,
    round(sum(detail_sum - order_total_money), 2) as swap_offset,
    count(*)                                     as swap_orders
from per_order
where order_total_money > 0.01
  and order_total_money < detail_sum - 0.01
group by 1, 2, 3, 4
