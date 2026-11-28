{#
  window_read_parquet(path_pattern) —— audit 湖读取的窗口/全史双模（#1614/#1619）。
  env AUDIT_WINDOW_PATTERNS 未设 = 原样全史 glob；设了 = 把 bizday=* / bizday=** 段换成
  恰好一个融合月段 glob（如 2026-1[01]-*）。行级精度由两侧 WHERE（AUDIT_WINDOW_START /
  window_start_date）负责。
  ⚠️ 窗口起点必须对齐**增量 lookback**（`incremental_cutoff(10)` ⇒ `mart_max−10`；14 个模型用 10、
  1 个用 60——2026-11-28 实测计数，此前这里写的 today−7 是过时值），不是月初：增量 mart 只重建
  最近 10 天，更老分区是建表时快照，源头重述后必然「湖新 mart 旧」⇒ 窗口放宽就假红（2026-11-07 实测
  transfer 2260 条差异全部落在 10-01..10-27，无一在 10 天内）。
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
  {#- 热腿（hour=*/all.parquet）**不套窗口替换**：它的非空由 0 行哨兵
      system_book=0/bizday=1970-01-01/hour=00/all.parquet 兜底，而窗口替换会把
      bizday=* 换成 2026-1[01]-*，等于把哨兵剔出 glob ⇒ 重新变成空 glob
      ⇒ DuckDB 规划期报 `No files found`（不是返回 0 行）。2026-11-17 实测：
      hourly 4 条 retail 审计全红在这个点上。热腿经 GC 后只剩最多两天的对象，
      窗口化收益可忽略；行级窗外裁剪仍由两侧 WHERE（AUDIT_WINDOW_START）负责。 -#}
  {%- set hot = 'hour=*/all.parquet' in path_pattern -%}
  {%- set windowed = path_pattern if (raw == '' or hot) else (path_pattern | replace('bizday=**', 'bizday=' ~ raw) | replace('bizday=*', 'bizday=' ~ raw)) -%}
  {{- "read_parquet('" ~ windowed ~ "')" -}}
{% endmacro %}
