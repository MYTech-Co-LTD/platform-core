{{
    config(materialized='table')
}}
-- stg_lemeng_branch.sql — 乐檬门店维 staging（新湖；一对一、只规范化不改义）
-- 分区键推断类型不合约 ⇒ 三列显式 cast；取列必须 `from read_parquet(...) r` 函数别名形态
-- （CTE 形态在 pg_duckdb 上取列即报错，见 stg_lemeng_retail_order_line.sql 头注【二】）。
--
-- 【前缀单点】`lemeng/dim_branch` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_branch_prefix`（出处：contracts/common/lemeng.branch.json 的 `layout.prefix`）。
--   分区键顺序 `["system_book","snapshot"]` 与管线的 sink `key` 逐段一致（见
--   duckle/common/lemeng.branch.json 的 sink 节点）。
--
-- 【覆盖双账套】路径段写 `*/snapshot=**/` 而不是钉单账套 —— 门店维在 dbt 侧是**一个模型读两个
--   账套分区**（`system_book` 是**列**、不是 var）；`account_book` var 只服务旧湖 retail_detail
--   那条非 hive 路径（它账套只能由 var 供值）。
--
-- 列与空值性以 `contracts/common/lemeng.branch.json` 为准（16 列全带，本层不加语义）。
select
  r['batch_id']              as batch_id,
  r['system_book']::varchar  as system_book,
  r['snapshot']::date        as snapshot,
  r['branch_num']            as branch_num,
  r['code']                  as code,
  r['name']                  as name,
  r['pinyin']                as pinyin,
  r['type']                  as type,
  r['enable']                as enable,
  r['region_id']             as region_id,
  r['province']              as province,
  r['city']                  as city,
  r['district']              as district,
  r['contact']               as contact,
  r['phone']                 as phone,
  r['address']               as address
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_prefix") }}/*/snapshot=**/all.parquet'
) r
