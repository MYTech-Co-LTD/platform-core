{{
    config(materialized='table')
}}
-- stg_lemeng_client.sql — 乐檬**批发客户档案** staging（新湖；#516 段①；全量快照、一对一、只规范化不改义）
-- 【用途边界】工单取价对照表——publish-dims 只消费 client_fid+client_name 两列；本档案 13 种
--   client_type 大杂烩，**不是门店维**，行不进 dim_branch（spec §5 单源分工铁律）。
-- 【采集形态】GET 零参数固定窗快照（2026-10-10 实测 707 条且窗口跟随活档案；例外路线证据见
--   正典 §1.7 与 .superpowers/sdd/2026-10-10-500-lemeng-client/probe-report.md）——无翻页。
-- 分区键推断类型不合约 ⇒ 两列显式 cast；取列必须 `from read_parquet(...) r` 函数别名形态
--   （同 stg_lemeng_branch.sql 头注）。
--
-- 【前缀单点】`lemeng/client` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `lemeng_client_prefix`（出处：contracts/common/lemeng.client.json 的 layout.prefix）。
-- 【覆盖范围】仅 3120 主账套。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['snapshot']::date as snapshot,
  r['client_fid']::varchar as client_fid,
  r['client_name']::varchar as client_name,
  r['client_code']::varchar as client_code,
  r['client_type']::varchar as client_type,
  r['branch_num']::bigint as branch_num,
  r['client_actived']::boolean as client_actived,
  r['client_del_tag']::boolean as client_del_tag,
  r['client_last_edit_time']::varchar as client_last_edit_time
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_client_prefix") }}/*/snapshot=**/all.parquet'
) r
