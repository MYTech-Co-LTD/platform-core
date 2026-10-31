-- assert_vw_lemeng_wholesale_out_matches_stg — 直读湖视图与 staging 在**闭窗日**必须同源（#1182）。
-- 两者的 FROM 块是**两份手写**（视图直读湖、staging 物化），抄错会静默多算/双算。
-- 判据取闭窗日（bizday < 上海今天）：当天文件被管线重写，两侧时点不同不可比。
with a as (
    select count(*)::bigint as n
    from {{ ref('vw_lemeng_wholesale_out') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
b as (
    select count(*)::bigint as n
    from {{ ref('stg_lemeng_wholesale_out') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
)
select a.n as vw_rows, b.n as stg_rows,
       '视图与 staging 行数不一致（FROM 路径 / 列区抄错）' as note
from a, b
where a.n is distinct from b.n
union all
select a.n, b.n, '两侧都为空：对账在空集上「通过」是空转绿'
from a, b
where a.n = 0 and b.n = 0
