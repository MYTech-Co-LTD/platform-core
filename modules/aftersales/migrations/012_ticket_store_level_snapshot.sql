-- 012_ticket_store_level_snapshot.sql — 工单门店等级快照（issue #2924）
-- 正典：docs/superpowers/specs/2026-11-27-store-profile-brand-level-design.md §5
--
-- 为什么快照而不是读侧 join：等级和品牌一样，是工单的分类事实；门店画像以后改了，
-- 历史工单不应被重新分级。快照也让列表/计数/导出不需要 join。
--
-- 三列语义：
--   store_level_code    等级 code（data.store_level_registry.code）
--   store_level_name    提单那一刻的等级名（字典改名不回溯）
--   store_level_source  映射来源：manual | ...；未分级 = 'unavailable'
--
-- 未分级：三列均为空串（store_level_source='unavailable'）。读侧按 store_level_code='' 处理。
-- 幂等：add column if not exists / create index if not exists。
alter table aftersales.ticket
  add column if not exists store_level_code   text not null default '',
  add column if not exists store_level_name   text not null default '',
  add column if not exists store_level_source text not null default '';

-- 等级筛选/计数：与 (org, status, id desc) 互补；store_level_code='' 走同一个索引。
create index if not exists aftersales_ticket_org_level_id_idx
  on aftersales.ticket (org, store_level_code, id desc);
