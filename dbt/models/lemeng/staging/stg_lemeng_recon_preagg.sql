{{
    config(materialized='table')
}}
-- stg_lemeng_recon_preagg.sql — 乐檬**口径对账逐店事实** staging（消费面 spec §12.4 缺口①；W 2026-10-18）
--
-- 【它是什么】湖侧自算 vs 乐檬报表引擎（`nhsoft.report.ai.itemsales.find`）的**逐店两侧金额**。
--   生产者：父管线 `lemeng.recon.preagg`（切块 ≤100 家/块）→ 子管线 `lemeng.recon.preagg.item`
--   （`sinkprep` → `lakeout`）。契约：`contracts/common/lemeng.recon_preagg.json`。
--
-- 【分区三级】`system_book=` / `bizday=` / **`chunk=`**——`chunk` 是为了绕开端点
--   「`branch_nums` 单次 ≤100 家、超出 `code=10001`」的硬限（64188 有 129 家、3120 有 271 家）。
--   块之间互不覆盖（各写各的分区）；同 (日, 块) 重跑覆盖同 key。
--
-- 【只有事实】本表**没有**容差 / 判定 / 原因：那些是**判定配置**（`dbt/seeds/recon_reason_codes.csv`）
--   与**派生物**（`recon_run` / `recon_break`）。落湖会把配置冻进事实，改一次要重采一遍。
--
-- 【读法】`*` 通配账套、`bizday=**` 通配任意日期（hive 键由路径段自动推断，`chunk` 同理）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['chunk_no']::int as chunk_no,
  r['branch_num']::bigint as branch_num,
  r['platform_sale']::decimal(20,2) as platform_sale,
  r['source_sale']::decimal(20,2) as source_sale,
  r['platform_net']::decimal(20,2) as platform_net,
  r['source_net']::decimal(20,2) as source_net,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_recon_preagg_prefix") }}/*/bizday=**/chunk=*/all.parquet'
) r
