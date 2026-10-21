-- assert_vw_retail_order_line_matches_stg — 视图与 staging 在**闭窗日**必须同源。
-- 为什么需要：两者的 FROM 块是**两份手写**（视图直读湖、staging 物化），抄错会静默多算/双算。
-- 判据取**闭窗日**（bizday < 上海今天）：今天的文件被 tick 重写，两侧时点不同，不可比。
--
-- ⚠️ **覆盖范围（2026-10-21 真机实测后订正）：只管冷侧 + 列区，盖不住热侧。**
--    封版（_DAILY）之后当天热分区为空 ⇒ 闭窗日行数 100% 来自 `_DAY_DATA`：
--    实测 cold=518429 / hot=0。把视图 UNION ALL 的热侧整段删掉，本测试**仍然相等**。
--    热侧由 `assert_vw_retail_order_line_hot_branch` 单独守（对湖直读，不看 staging）。
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
       '视图与 staging 行数不一致（冷侧 FROM 抄错：路径 / 封版断言 / 列区）' as note
from a, b
where a.n is distinct from b.n
union all
-- ⚠️ 空转绿守卫**必须**写成 `a.n = 0 and b.n = 0`。
--    早先抄的是 `where not exists (select 1 from b)` —— 那是**死分支**：a/b 都是无 group by 的
--    `count(*)`，恒返一行，`not exists` 恒为假，守卫永远不触发（看着有、实则空转）。
--    （既有 audit_*.sql 的同款守卫有效，是因为它那侧是**带 group by 的**子查询，可以为空。）
select a.n, b.n, '两侧都为空：对账在空集上「通过」是空转绿'
from a, b
where a.n = 0 and b.n = 0
