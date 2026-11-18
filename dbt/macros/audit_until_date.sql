{#
  audit_until_date() —— 对账的**日期上界**（不含）：上海今天 − 2 天。

  为什么不是「今天」（2026-11-18 定案，issue #2481 之外的根因修复）：
  白天 09:00–23:00，**T-1 被 15 个 L0 每小时重采**（`branch.expense` :32、`transfer.*` :36/:42、
  `wholesale.*` :22/:28 …），**T-2 被库存快照每小时重采**（`:12`）。审计的 mart 是「建表那一刻」的湖，
  审计的复算侧是「读的那一刻」的湖 ⇒ 比 T-1/T-2 就是**拿旧 mart 比新湖**，必红且细节随重写漂移
  （2026-11-18 run 6609 库存 T-2 18,100 行、run 6628 费用 T-1 7/59 行两次不同）。

  ⇒ 审计只比**不再被小时级重采的日子**：`bizday < (上海今天 − 2)`，即 T-3 及更老。
  最近两天的新鲜度/缺数由 `data.monitor` 的 `missing`/`stale` 与水印负责，不用审计兜。
#}
{% macro audit_until_date() %}
(now() AT TIME ZONE 'Asia/Shanghai')::date - 2
{% endmacro %}
