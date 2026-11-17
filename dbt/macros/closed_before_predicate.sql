{#
  closed_before_predicate(prefix='') —— 物化闭窗读（MAT_CLOSED_BEFORE=true 时启用，2026-11-08 P0）。

  目的：物化读湖时**不读正在被 tick 改写的分区**（DuckDB ETag 竞态）。tick 形一次重写
  「当前小时 + 前一小时」两窗（见 lemeng.retail.tick.l1），所以闭窗边界 = 北京当前小时 − 1。

  ⚠️ 历史缺陷（#2422）：旧实现是
    `not (bizday = current_date and hour >= extract(hour from current_timestamp))`
  —— `current_date/current_timestamp` 是 DB 会话时钟（**UTC**），而湖里的 `hour` 是**北京小时**。
  UTC 16:00–24:00（北京 00:00–08:00）时 `current_date` 还是北京**昨天** ⇒ 把刚封版的昨天
  18–23 点整段剔掉（窗口审计必假红）；白天则只保留 `hour < UTC 小时`，当日 mart 滞后约 8 小时。

  本宏按北京时间取「今天」与「当前小时」，闭窗边界 = 北京当前小时 − 1（tick 一次重写 cur+prev）。

  ⚠️ **不要**再加「跨 00 点也排除昨日 23 点」的条款（2026-11-18 run 5930 实测反例）：
  tick 的 cron 是 `*/10 9-23`，**00 点没有 tick**（23:50 那次覆盖 23/22），所以 00:xx 时
  昨日 23 点早已闭窗、不会再被改写；排除它只会让 mart 缺 11-17 的 h23，窗口审计随即报 41 行差异。
  只影响「今天」这一天的分区；审计只看 `bizday < 今天`，不受影响。
#}
{% macro closed_before_predicate(prefix='') %}
not (
  {{ prefix }}bizday = (now() AT TIME ZONE 'Asia/Shanghai')::date
  and {{ prefix }}hour >= extract(hour from (now() AT TIME ZONE 'Asia/Shanghai')) - 1
)
{% endmacro %}
