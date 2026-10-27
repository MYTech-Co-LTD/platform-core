-- 024_report_narratives_gc.sql — AI 文本缓存的保留期清理（GC）索引。
--
-- 表见 023。缓存按内容寻址，数据每天物化后 factsHash 变化会产生新行；没有 TTL 时表会
-- 单调增长。domain/report-narrative-store.ts 的 `pruneNarratives` 按 created_at 删除
-- 超过保留期的行（默认 90 天），这里补一条单列索引让全表 GC 走索引扫描。
--
-- 幂等：DDL 全 if not exists（db-migration 纪律 §1，部署脚本会全量重跑）。

create index if not exists report_narratives_created_at_idx
  on data.report_narratives(created_at);
