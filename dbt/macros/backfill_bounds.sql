{#
  backfill_bounds —— 一次性有界回填的编译期窗口覆写（#2493，计划 2026-11-20-64188-history-backfill.md）。

  为什么不用 full-refresh：全史聚合会打崩 pg_duckdb（publish-dims、全史行级 CTAS 两次实证）；
  增量模型的 `max(bizday)−N` 下界又永远够不到「max 前进后才补采进湖」的旧分区
  （64188 出库域缺 2024-11 → 2026-02-21，#2493 取证）。

  用法（按月块驱动，delete+insert 按 unique_key 精确替换该块）：
    dbt run --select fct_hq_outbound --vars '{"bf_from":"2026-01-01","bf_to":"2026-02-01"}'

  ⚠️ 上界必须与下界成对出现（护栏测试按「成对」断言）：
     只压下界不封上界 = 从 bf_from 一路读到今天 ⇒ 等价全史重跑 = 崩溃路径。
  ⚠️ 不传 vars 时两宏输出为空/原值 ⇒ 模型行为与接入前逐字节一致。
#}
{% macro cutoff_or_backfill(days) %}
  {%- set f = var('bf_from', '') -%}
  {{- ("date '" ~ f ~ "'") if f != '' else incremental_cutoff(days) -}}
{% endmacro %}

{% macro backfill_to() %}
  {%- set t = var('bf_to', '') -%}
  {{- ("and bizday < date '" ~ t ~ "'") if t != '' else '' -}}
{% endmacro %}
