-- assert_lake_month_index_not_stale.sql — 月文件积压不得超过 2 天（#1916 P2）。
--
-- 读视图的「日文件补腿」只回溯 `current_date - 3`。若某月 `built_at < 该月 max(sealed_at)`
-- 且这个缺口**超过 2 天**（重封版后合并一直没跑），小时文件已被 GC 删掉 → 该月数字会静默变旧。
-- 缺口 ≤2 天是合并排班（CST 04:10）的正常窗口，不判红。
--
-- 返回任何行即失败。
with lag as (
    select s.system_book,
           strftime(s.bizday, '%Y-%m') as ym,
           max(s.sealed_at) as last_seal
    from data.lemeng_daily_sealed s
    where s.system_book <> ''
      and s.bizday > date '1970-01-01'
    group by 1, 2
)
select l.system_book, l.ym, i.built_at, l.last_seal
from lag l
join data.lake_month_index i
  on i.system_book = l.system_book and i.ym = l.ym
where i.built_at < l.last_seal
  and l.last_seal < now() - interval '2 days'
