-- 011_ticket_brand_snapshot.sql — 工单品牌快照（issue #2892）
-- 正典：docs/superpowers/specs/2026-11-26-tenant-brand-dimension-design.md §4.2
--
-- 为什么快照而不是读侧 join：工单是理赔记录，品牌是它的分类事实；租户的 brand_assignment
-- 以后改了，历史工单不应被重新分类。快照也让列表/计数/导出不需要 join。
--
-- 四列的语义：
--   brand_code    品牌 code（data.brand_registry.code）
--   brand_name    提单那一刻的品牌名（字典改名不回溯）
--   brand_source  解析层：product | store | unavailable
--   brand_origin  映射来源：source_field | book | mapping | prefix | manual | backfill
--
-- 未分类：四列均为空串（brand_source='unavailable'）。读侧按 brand_code='' 处理。
-- 幂等：add column if not exists / create index if not exists。
alter table aftersales.ticket
  add column if not exists brand_code   text not null default '',
  add column if not exists brand_name   text not null default '',
  add column if not exists brand_source text not null default '',
  add column if not exists brand_origin text not null default '';

-- 品牌筛选/计数：与 (org, status, id desc) 互补；brand_code='' 走同一个索引。
create index if not exists aftersales_ticket_org_brand_id_idx
  on aftersales.ticket (org, brand_code, id desc);
