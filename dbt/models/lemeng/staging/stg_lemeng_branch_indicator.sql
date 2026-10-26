{{
    config(materialized='table')
}}
-- stg_lemeng_branch_indicator.sql — 乐檬**门店经营指标日粒度** staging（新湖；D10 2026-10-26；一对一、只规范化不改义）
-- 【行】= 账套×bizday×门店×指标。源按 `date_type=month + group_type=day` 返回整月，管线已裁到单一 bizday。
-- 【指标】metric 是英文键（transfer_money=配送金额…）⇒ 消费面按 metric 过滤/透视，**不按列展开**（后续指标续行不续列）。
-- 【缺口】源侧本月无数据的门店不出现在响应里 ⇒ 当日**缺行**＝无数据，不是零值；消费面求和按「有行即计入」处理。
-- 【前缀单点】var `lemeng_branch_indicator_prefix`（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::int as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['branch_num']::int as branch_num,
  r['branch_code']::varchar as branch_code,
  r['branch_name']::varchar as branch_name,
  r['branch_region_num']::int as branch_region_num,
  r['branch_region_name']::varchar as branch_region_name,
  r['metric']::varchar as metric,
  r['actual_value']::decimal(20,2) as actual_value,
  r['target_value']::decimal(20,2) as target_value,
  r['actual_rate']::decimal(20,6) as actual_rate,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_indicator_prefix") }}/*/bizday=**/*.parquet'
) r
