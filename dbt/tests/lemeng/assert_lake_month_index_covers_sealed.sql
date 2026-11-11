-- assert_lake_month_index_covers_sealed.sql — 每个「已封版」的月必须有月文件清单行（#1916 P2）。
--
-- 为什么必须钉：读视图的冷腿 = `_MONTH` 月文件 + 「构建后才封版」的日文件补腿（只回溯 3 天）。
-- 若某个月**整月**没有 `lake_month_index` 行（合并从没跑过），视图会静默漏掉整月数据——
-- 而且是"看起来有数"的漏（其它月正常），比全空更难发现。
--
-- 返回任何行即失败（dbt singular test 契约）。
with months as (
    select system_book, strftime(bizday, '%Y-%m') as ym
    from data.lemeng_daily_sealed
    where system_book <> ''
      and bizday > date '1970-01-01'
    group by 1, 2
)
select m.system_book, m.ym
from months m
left join data.lake_month_index i
  on i.system_book = m.system_book and i.ym = m.ym
where i.system_book is null
