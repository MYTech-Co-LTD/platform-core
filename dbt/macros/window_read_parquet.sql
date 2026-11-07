{#
  window_read_parquet(path_pattern) —— audit 湖读取的窗口/全史双模（#1614/#1619）。
  env AUDIT_WINDOW_PATTERNS 未设 = 原样全史 glob；设了 = 把 bizday=* / bizday=** 段换成
  恰好一个融合月段 glob（如 2026-1[01]-*）。行级精度由两侧 WHERE（AUDIT_WINDOW_START /
  window_start_date）负责。
  ⚠️ 窗口起点必须对齐**增量 lookback**（today−7），不是月初：增量 mart 只重建最近 7 天，
  更老分区是建表时快照，源头重述后必然「湖新 mart 旧」⇒ 窗口放宽就假红（2026-11-07 实测
  transfer 2260 条差异全部落在 10-01..10-27，无一在 7 天内）。
  为什么必须是单 glob 裸函数调用、tag 语义、实测数字：
  见 PR #1618 描述与 scripts/lemeng/materialize.sh hourly 档注释。
  ⚠️ 本文件刻意**不用 if/endif 控制流块**（用条件表达式）：dbt 1.9 解析器对宏体内
  控制流 + 后续宏定义的组合报「block definition inside control flow」（2026-11-07
  真机三轮实证，与注释内容/长短无关）；宏体零控制流块后解析通过。
#}

{% macro window_start_date() %}
  {%- set s = env_var('AUDIT_WINDOW_START', '') -%}
  {{- s if s != '' else '1900-01-01' -}}
{% endmacro %}

{% macro window_read_parquet(path_pattern) %}
  {%- set raw = env_var('AUDIT_WINDOW_PATTERNS', '') -%}
  {%- set windowed = path_pattern if raw == '' else (path_pattern | replace('bizday=**', 'bizday=' ~ raw) | replace('bizday=*', 'bizday=' ~ raw)) -%}
  {{- "read_parquet('" ~ windowed ~ "')" -}}
{% endmacro %}
