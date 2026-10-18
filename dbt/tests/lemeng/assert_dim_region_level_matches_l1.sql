-- assert_dim_region_level_matches_l1.sql — 结构断言：`dim_region.level` 必须与 `region_l1` 自洽。
--
-- 契约同族测试：**返回任何行即失败**（dbt singular test）。
--
-- 为什么值得一条：`level` **完全由 `region_l1` 决定**（见 seeds/schema.yml 的定义），它存在的
-- 唯一理由是「让消费方不必自己重推这条规则」。所以它**必须**与那条规则逐行一致——不一致时，
-- 消费方拿到的层级是错的，而**每一列看上去都合法**（`level` 是合法整数、`region_l1` 也是合法名）。
-- 本表是手工维护的（枚举 + UI 树读取），**加一行时最容易只填 `region_l1` 忘了 `level`**。
--
-- 判据（与 schema.yml 的定义逐条对应）：
--   · `level = 0` ⟺ `region_l1` 为空（根）
--   · `level = 1` ⟺ `region_l1 = region_name`（一级节点本身）
--   · `level = 2` ⟺ `region_l1` 非空且 ≠ `region_name`（二级）
--   · 以及 `level` 必须落在 {0,1,2}
--
-- ⚠️ 空表边界：表为空时返回 0 行 = 通过（seed 恒有 27 行，不会为空；此注只为与同族文件口径一致）。
select
    system_book,
    region_id,
    region_name,
    region_l1,
    level
from {{ ref('dim_region') }}
where level not in (0, 1, 2)
   or (level = 0 and region_l1 is not null)
   or (level = 1 and (region_l1 is null or region_l1 <> region_name))
   or (level = 2 and (region_l1 is null or region_l1 = region_name))
