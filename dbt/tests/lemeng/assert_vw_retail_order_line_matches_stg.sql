-- assert_vw_retail_order_line_matches_stg — 视图与 staging 必须同源。
-- 为什么需要：两者的 FROM 块是**两份手写**（视图直读湖、staging 物化）。
-- 抄错一处（漏掉热侧/漏掉「排除已封版日子」的谓词）会**静默**多算或双算。
-- 判据取**闭窗日**（bizday < 上海今天）：今天的文件被 tick 重写，两侧时点不同，不可比。
with a as (
    select count(*)::bigint as n
    from {{ ref('vw_lemeng_retail_order_line') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
b as (
    select count(*)::bigint as n
    from {{ ref('stg_lemeng_retail_order_line') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select a.n as vw_rows, b.n as stg_rows,
       '视图与 staging 行数不一致（FROM 块抄错：漏热侧 / 未排除已封版日子 / 封版断言缺失）' as note
from a, b
where a.n is distinct from b.n
union all
select 0, 0, '两侧都为空：对账在空集上「通过」是空转绿'
where not exists (select 1 from b)
