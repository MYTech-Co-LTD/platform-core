{{
    config(materialized='table')
}}
-- stg_lemeng_item_price.sql — 乐檬**门店商品应用价** staging（新湖；#481 价格批；一对一、只规范化不改义）
-- 分区键推断类型不合约 ⇒ 两列显式 cast（system_book::varchar / snapshot::date）；取列必须 `from read_parquet(...) r`
-- 函数别名形态（CTE 形态在 pg_duckdb 上取列即报错，同 stg_lemeng_branch.sql 头注）。
--
-- 【前缀单点】`lemeng/item_price` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_item_price_prefix`（出处：contracts/common/lemeng.item_price.json 的 `layout.prefix`；
--   ⚠️ 刻意不叫 `dim_item_price`——生产者判定按子串匹配，会撞 `dim_item` 契约，见 var 注）。
--   分区键顺序 `["system_book","snapshot"]` 与管线的 sink `key` 逐段一致（见
--   `deploy/duckle/console/pipelines/lemeng.dim.item_price.l0*.json` 的 sink 节点）。
--
-- 【覆盖双账套】路径段写 `*/snapshot=**/` 而不是钉单账套 —— 与 branch/item 同款：一个模型读两个
--   账套分区（`system_book` 是**列**、不是 var）。
--
-- 列与空值性以 `contracts/common/lemeng.item_price.json` 为准（31 列全带，本层不加语义；
-- **另加 dbt 注入列 `org`**）。行粒度 = 账套 × 快照日 × 门店 × 商品(×分级)；
-- `item_grade_num is null` = 主商品行。`regular_real_price` 可空（0/空 = 源侧未单独设置，
-- 发布面 Task 4 过滤，本层照透传）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['snapshot']::date as snapshot,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['branch_matrix_price_actived']::boolean as branch_matrix_price_actived,
  r['item_num']::bigint as item_num,
  r['item_grade_num']::bigint as item_grade_num,
  r['item_code']::varchar as item_code,
  r['bar_code']::varchar as bar_code,
  r['item_name']::varchar as item_name,
  r['spec_num']::varchar as spec_num,
  r['spec_unit']::varchar as spec_unit,
  r['spec_rate']::decimal(18,8) as spec_rate,
  r['item_unit']::varchar as item_unit,
  r['item_category']::varchar as item_category,
  r['item_department']::varchar as item_department,
  r['last_edit_time']::varchar as last_edit_time,
  r['regular_price']::decimal(18,8) as regular_price,
  r['level2_price']::decimal(18,8) as level2_price,
  r['level3_price']::decimal(18,8) as level3_price,
  r['level4_price']::decimal(18,8) as level4_price,
  r['max_price']::decimal(18,8) as max_price,
  r['min_price']::decimal(18,8) as min_price,
  r['regular_real_price']::decimal(18,8) as regular_real_price,
  r['level2_real_price']::decimal(18,8) as level2_real_price,
  r['level3_real_price']::decimal(18,8) as level3_real_price,
  r['level4_real_price']::decimal(18,8) as level4_real_price,
  r['max_real_price']::decimal(18,8) as max_real_price,
  r['min_real_price']::decimal(18,8) as min_real_price
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_price_prefix") }}/*/snapshot=**/all.parquet'
) r
