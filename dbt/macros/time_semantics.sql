{#
  time_semantics.sql —— **数据面时间语义的单一事实源**（dbt 侧原语，2026-11-22，#2674 后续）。

  ## 为什么要有这个文件

  2026-11-22 一天修掉的四个缺陷（#2665 读面时钟 / #2666 清单失真 / #2636 月裁剪 / 审计 T-3 移动靶）
  **全部**是时间语义的分歧：谁算「今天」、什么算「已冻结」、闭窗边界在哪、审计能看多近。
  当时仓里散着 7 个宏 + 20 处 `Asia/Shanghai` 字面量，各写各的。

  **规则**：`dbt/models/**` 里**禁止**直接写 `Asia/Shanghai` / `current_date` 做业务日期运算——
  一律用本文件的宏（守卫测试 `scripts/lib/time-semantics.test.ts` 扫描判红）。

  ## 时区的两个坑（都是实测过的）

  1. **DB 会话时钟是 UTC**（`current_date` / `current_timestamp`）——直接用会在北京 00:00–08:00
     把「今天」算成昨天（#2422 实测：昨 18–23 点整段被剔、窗口审计假红）。
  2. **上海无夏令时**，但「先 UTC 减天数再格式化」会跨日错位 ⇒ 平移必须锚在「上海正午」。

  ## 原语一览

  | 宏 | 语义 | 典型用法 |
  |---|---|---|
  | `shanghai_today()` | 上海当前日期 | 需运行时求值的谓词（会放弃文件裁剪，仅当无法编译期定值时用） |
  | `shanghai_days_ago(n)` | 上海今天 − n 天 | 审计上界、窗口下界 |
  | `shanghai_hour_now()` | 上海当前小时（0–23） | 闭窗边界 |
  | `compile_time_date(offset)` | **编译期**求值的 `date 'YYYY-MM-DD'`（offset 相对上海今天） | 全史 CTAS 的闭窗谓词（**必须编译期**才能触发 parquet 分区裁剪） |
  | `compile_time_month(offset_days)` | **编译期**求值的月份字面量 `'YYYY-MM'`（上海时钟） | 走 DuckDB 路由的 SQL 里做「period < 当前月」（DuckDB 无 `to_char`，#2750） |
#}

{% macro shanghai_today() -%}
(now() AT TIME ZONE 'Asia/Shanghai')::date
{%- endmacro %}

{% macro shanghai_days_ago(n) -%}
((now() AT TIME ZONE 'Asia/Shanghai')::date - {{ n }})
{%- endmacro %}

{% macro shanghai_hour_now() -%}
extract(hour from (now() AT TIME ZONE 'Asia/Shanghai'))
{%- endmacro %}

{#
  compile_time_date(offset=0) —— 编译期算好的日期字面量。

  ⚠️ 为什么必须是**字面量**：`now()` / 子查询形态会让 pg_duckdb 放弃 parquet 文件裁剪，
  全史 glob 会把当天的活分区一并打开 ⇒ 采集期的 ETag 竞态照撞（#2675 实测 668s 白跑）。
  编译期求值 ⇒ 渲染成 `date '2026-11-22'`，DuckDB 才能下推到文件级。

  `run_started_at` 是 **UTC**；+8h 得沪时钟（跨 CST 零点也正确）。
#}
{#-
  compile_time_month() —— 编译期算好的**月份字符串字面量** `'YYYY-MM'`（上海时钟）。

  为什么单独一个宏（#2750）：对账 SQL 里要做「period < 当前月」的判据，而含 `read_parquet`
  的语句整条被 pg_duckdb 路由进 **DuckDB**——DuckDB **没有 `to_char`**（求值期 Catalog Error，
  0 行也一样炸）。故把截止月做成**编译期字面量**，SQL 里只剩字符串比较。

  +8h 的约定与 compile_time_date 同源（run_started_at 是 UTC，+8h 得沪时钟）。
-#}
{% macro compile_time_month(offset_days=0) -%}
{%- set base = (run_started_at + modules.datetime.timedelta(hours=8)).date() + modules.datetime.timedelta(days=offset_days) -%}
'{{ base.strftime('%Y-%m') }}'
{%- endmacro %}

{% macro compile_time_date(offset=0) -%}
{%- set base = (run_started_at + modules.datetime.timedelta(hours=8)).date() -%}
{%- set d = base + modules.datetime.timedelta(days=offset) -%}
date '{{ d.strftime('%Y-%m-%d') }}'
{%- endmacro %}
