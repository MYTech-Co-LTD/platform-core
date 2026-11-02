{{
    config(materialized='view')
}}
-- stg_lemeng_recon_source.sql — 乐檬**口径对账的源侧快照** staging（issue #920；消费面 spec §12.4 缺口①）
--
-- 【它是什么】**只装源侧**：乐檬报表引擎（`nhsoft.report.ai.itemsales.find`）逐店返回的
--   `sale_money` / `return_money`。**不含平台侧、不含口径、不做比较**——那两件事分别由
--   构件 `fct_retail_sale` 与 marts `recon_fact` / `recon_break` 负责。
--   生产者：父管线 `lemeng.recon.preagg`（切块 ≤100 家/块）→ 子管线 `lemeng.recon.preagg.item`
--   （`pre` → `pnormal` → `srcprep` → `lakeout`）。契约：`contracts/common/lemeng.recon_source.json`。
--
-- 【为什么采集侧不实现口径】对账是**外部一致性**控制，对手方是外部系统 ⇒ 采集侧只该负责
--   「把外部那一边拿回来」。让采集管线也实现一遍口径 = 同一业务规则两个并列实现、靠人手同步
--   ⇒ 静默漂移（#813 容差地板 / #917 退货侧赠品判别式）。不变量见 docs/architecture.md §4.1 B11。
--
-- ⚠️ **列区由 `scripts/gen-data-projection.mjs` 生成**（契约 `expr` 的唯一落地）：手改列区会被
--    `--check` 判红。改列 = 改契约一处 + 跑生成器。
-- ⚠️ `source_sale` / `source_net` **可空**：端点这次没返回这家店 ⇒ NULL（≠ 0）——台账据此判
--   `missing_side='source'`（真实的覆盖缺口），`recon_run.source_cover_pct` 也靠它。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['chunk_no']::int as chunk_no,
  r['branch_num']::bigint as branch_num,
  r['source_sale']::decimal(20,2) as source_sale,
  r['source_net']::decimal(20,2) as source_net,
  r['computed_at']::timestamptz as computed_at
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_recon_source_prefix") }}/*/bizday=**/chunk=*/all.parquet'
) r
