-- 008_ticket_store_affiliation.sql — 工单的「提交人门店归属一致性」快照（2026-11-24）
--
-- 背景（docs/superpowers/specs/2026-11-24-affiliation-dual-source.md §3.1）：提售后单**不校验**
-- 提交人是否属于该店（只校验门店在 data.dim_branch 存在）。归属目前是信息性的，不是授权性的。
-- 本列把「提单那一刻档案门店 vs 单据门店」的一致性记为快照，供管理端展示与运营判断。
--
-- 语义（ADR §7 P1-a：纯可见性，无行为变更）：
--   matched      档案存在且单据门店在其门店集合里
--   mismatch     档案存在但单据门店不在集合里（调店未更新 / 填错 / 借用账号）
--   unregistered 无已通过档案（未注册或待审批）——当前目录覆盖 62%，这是**正常状态**
--   null         判定失败（fail-open，绝不阻断提单）
--
-- 快照语义：记录当时事实，档案后续变更不回溯（要回溯就得重算，那是另一个决定）。
-- 幂等：可重复执行（部署脚本每次全量重跑迁移）。
alter table aftersales.ticket
  add column if not exists store_affiliation text;

-- check 用 DO 块加：`add constraint if not exists` 在 PG 里不存在（幂等写法只有这一种）。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'aftersales_ticket_store_affiliation_chk'
       and conrelid = 'aftersales.ticket'::regclass
  ) then
    alter table aftersales.ticket
      add constraint aftersales_ticket_store_affiliation_chk
      check (store_affiliation is null or store_affiliation in ('matched','mismatch','unregistered'));
  end if;
end $$;
