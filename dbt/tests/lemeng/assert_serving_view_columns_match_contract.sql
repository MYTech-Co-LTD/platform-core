-- assert_serving_view_columns_match_contract.sql — 服务视图列集必须 = 主视图列集 + month（#1916 P2）。
--
-- 服务视图手写投影（不经契约生成器），漂移风险由此处兜底：列集与列序任一不符即失败。
-- 用主视图做基准（主视图的列集本身由契约生成器保证），避免在测试里再抄一份 25 列清单。
select 1
where (
    select string_agg(column_name, ',' order by ordinal_position)
    from information_schema.columns
    where table_schema = 'staging' and table_name = 'vw_lemeng_retail_order_line_month'
) <> (
    select string_agg(column_name, ',' order by ordinal_position) || ',month'
    from information_schema.columns
    where table_schema = 'staging' and table_name = 'vw_lemeng_retail_order_line'
)
