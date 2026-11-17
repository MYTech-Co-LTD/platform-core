{#
  closed_before_predicate(prefix='') —— 物化闭窗读（MAT_CLOSED_BEFORE=true 时启用，2026-11-08 P0）。

  目的：物化读湖时**不读正在被 tick 改写的分区**（DuckDB ETag 竞态）。tick 形一次重写
  「当前小时 + 前一小时」两窗（见 lemeng.retail.tick.l1），所以闭窗边界 = 北京当前小时 − 1。

  ⚠️ 历史缺陷（#2422）：旧实现是
    `not (bizday = current_date and hour >= extract(hour from current_timestamp))`
  —— `current_date/current_timestamp` 是 DB 会话时钟（**UTC**），而湖里的 `hour` 是**北京小时**。
  UTC 16:00–24:00（北京 00:00–08:00）时 `current_date` 还是北京**昨天** ⇒ 把刚封版的昨天
  18–23 点整段剔掉（窗口审计必假红）；白天则只保留 `hour < UTC 小时`，当日 mart 滞后约 8 小时。

  本宏按北京时间取「今天」与「当前小时」，并覆盖跨 00 点时 prev 窗口落在**昨日 23 点**的情形。
  只影响「今天」这一天的分区；审计只看 `bizday < 今天`，不受影响。
#}
{% macro closed_before_predicate(prefix='') %}
not (
  {{ prefix }}bizday = (now() AT TIME ZONE 'Asia/Shanghai')::date
  and {{ prefix }}hour >= extract(hour from (now() AT TIME ZONE 'Asia/Shanghai')) - 1
)
and not (
  extract(hour from (now() AT TIME ZONE 'Asia/Shanghai')) = 0
  and {{ prefix }}bizday = ((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)
  and {{ prefix }}hour = 23
)
{% endmacro %}
