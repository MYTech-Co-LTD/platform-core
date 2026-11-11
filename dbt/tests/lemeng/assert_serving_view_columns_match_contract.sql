-- assert_serving_view_columns_match_contract.sql — 服务视图列集必须 = 主视图列集 + month（#1916 P2）。
--
-- 两个服务视图（月感知 / 历史月感知）都**手写** 25 列投影（不经契约生成器）⇒ 漂移风险由此处兜底。
-- 用主视图做基准（主视图列集本身由契约生成器保证），避免在测试里再抄一份 25 列清单。
with base as (
    select string_agg(column_name, ',' order by ordinal_position) || ',month' as expected
    from information_schema.columns
    where table_schema = 'staging' and table_name = 'vw_lemeng_retail_order_line'
),
actual as (
    select table_name,
           string_agg(column_name, ',' order by ordinal_position) as cols
    from information_schema.columns
    where table_schema = 'staging'
      and table_name in ('vw_lemeng_retail_order_line_month', 'vw_lemeng_retail_order_line_month_history')
    group by table_name
)
select a.table_name, a.cols, b.expected
from actual a cross join base b
where a.cols <> b.expected
union all
-- 视图缺失也算失败（actual 里没有行 ⇒ 这里补一行）
select v.name, '(missing)', b.expected
from base b
cross join (values ('vw_lemeng_retail_order_line_month'), ('vw_lemeng_retail_order_line_month_history')) as v(name)
where not exists (select 1 from actual a where a.table_name = v.name)
