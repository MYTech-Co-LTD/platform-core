{{
    config(materialized='table')
}}
-- stg_lemeng_branch.sql — 乐檬门店维 staging（新湖；一对一、只规范化不改义）
-- 分区键推断类型不合约 ⇒ 两列显式 cast（system_book::varchar / snapshot::date）；取列必须 `from read_parquet(...) r` 函数别名形态
-- （CTE 形态在 pg_duckdb 上取列即报错，见 stg_lemeng_retail_order_line.sql 头注【二】）。
--
-- 【前缀单点】`lemeng/dim_branch` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_branch_prefix`（出处：contracts/common/lemeng.branch.json 的 `layout.prefix`）。
--   分区键顺序 `["system_book","snapshot"]` 与管线的 sink `key` 逐段一致（见
--   **在用的** L0 管线 `deploy/duckle/console/pipelines/lemeng.dim.branch.l0.json` 的 sink 节点；🔴 2026-09-29 改向，原指已退役的 `duckle/common/lemeng.branch.json`）。
--
-- 【覆盖双账套】路径段写 `*/snapshot=**/` 而不是钉单账套 —— 门店维在 dbt 侧是**一个模型读两个
--   账套分区**（`system_book` 是**列**、不是 var）；`account_book` var 只服务旧湖 retail_detail
--   那条非 hive 路径（它账套只能由 var 供值）。
--
-- 列与空值性以 `contracts/common/lemeng.branch.json` 为准（16 列全带，本层不加语义；**另加 dbt 注入列 `org`**）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['snapshot']::date as snapshot,
  r['branch_num']::int as branch_num,
  r['code']::varchar as code,
  r['name']::varchar as name,
  r['pinyin']::varchar as pinyin,
  r['type']::varchar as type,
  r['enable']::boolean as enable,
  r['region_id']::int as region_id,
  r['province']::varchar as province,
  r['city']::varchar as city,
  r['district']::varchar as district,
  r['contact']::varchar as contact,
  r['phone']::varchar as phone,
  r['address']::varchar as address
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_prefix") }}/*/snapshot=**/all.parquet'
) r
