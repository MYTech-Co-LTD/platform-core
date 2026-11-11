{{
    config(materialized='table')
}}
-- stg_lemeng_item_category.sql — 乐檬商品类别树 staging（#1913；一对一、只规范化不改义）
-- 分区键推断类型不合约 ⇒ 两列显式 cast（system_book::varchar / snapshot::date）；取列必须
-- `from read_parquet(...) r` 函数别名形态（CTE 形态在 pg_duckdb 上取列即报错，见
-- stg_lemeng_retail_order_line.sql 头注【二】）。
--
-- 【前缀单点】`lemeng/dim_item_category` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_item_category_prefix`（出处：contracts/common/lemeng.item_category.json 的 layout.prefix）。
--   消费者 = 本模型（唯一）。
--
-- 【覆盖双账套】路径段写 `*/snapshot=**/` —— 类别树在 dbt 侧是一个模型读两个账套分区
--   （`system_book` 是列、不是 var），与门店维/商品维同形。
--
-- 列与空值性以 `contracts/common/lemeng.item_category.json` 为准（9 列全带，本层不加语义；
-- **另加 dbt 注入列 `org`**）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['snapshot']::date as snapshot,
  r['category_id']::bigint as category_id,
  r['parent_id']::bigint as parent_id,
  r['level']::integer as level,
  r['category_name']::varchar as category_name,
  r['category_code']::varchar as category_code,
  r['deleted_flag']::boolean as deleted_flag
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_item_category_prefix") }}/*/snapshot=**/*.parquet'
) r
