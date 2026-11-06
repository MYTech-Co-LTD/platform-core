{#
  incremental_cutoff(days) —— 增量基面下推的**编译期常量**窗口下界（#1524）。

  为什么要有它：模型里写
      bizday >= (select coalesce(max(bizday), date '1900-01-01') - interval '7 days' from {{ this }})
  是**关联子查询**，DuckDB 在计划期拿不到常量 ⇒ 不能按 bizday 做 parquet 分区裁剪，
  tick 档实测 5+ 分钟仍未完成。本宏在**编译期**先查一次 `max(bizday)`，把结果渲染成
  `date 'YYYY-MM-DD'` 字面量，DuckDB 才能下推到 read_parquet。

  非 incremental / 首次运行（表不存在）返回 `date '1900-01-01'`（不裁剪，全量语义不变）。
#}
{% macro incremental_cutoff(days) %}
  {%- if is_incremental() and execute -%}
    {%- set q = "select coalesce(max(bizday), date '1900-01-01') - interval '" ~ days ~ " days' from " ~ this -%}
    {%- set res = run_query(q) -%}
    {%- if res and res.rows and res.rows[0][0] -%}
      {{- "date '" ~ res.rows[0][0] ~ "'" -}}
    {%- else -%}
      {{- "date '1900-01-01'" -}}
    {%- endif -%}
  {%- else -%}
    {{- "date '1900-01-01'" -}}
  {%- endif -%}
{% endmacro %}
