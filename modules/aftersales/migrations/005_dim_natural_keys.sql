-- 005_dim_natural_keys.sql — 员工域的门店引用切**自然键**（#476；ADR 2026-10-07 形状②）。
--
-- 门店清单的消费源已切 `data.dim_branch`（发布快照，键 = (org, code) 自然键）⇒ 员工域
-- （employee / employee_store）对门店的引用从「本地 bigint id」改存「dim_branch.code」。
--
-- ⚠️ **死列保留，不 drop**（两行 store_id 列留在这两张表上）——原因：
--   001 建了 `employee(org, store_id)` 上的索引与 `employee_store(org, employee_id, store_id)`
--   唯一索引；本迁移若 drop 列，索引被连带删 ⇒ 「迁移 SQL 本身幂等：不记账、直接连跑两遍」
--   的全量重跑会在**第二遍 001** 的 `create index` 上炸（`column "store_id" does not exist`，
--   实测）。列保留（摘掉 FK 与 not null 后成死列，无写入方）⇒ 全量重跑安全。
--   退役随 ticket 自然键化那次迁移一起做（issue #476 的价格阻塞项解决时）。
--
-- ⚠️ 两张旧维表（aftersales.store / aftersales.product / aftersales.region）同样**不 drop**：
--   `ticket.product_id/store_id` 的 FK 还指着它们（同上，随价格项一起退役）。空表，留着无害。
--
-- 幂等：约束/属性操作全部 if exists / drop default 语义，重复执行零效果。
-- 空表前提：两表行数为 0（2026-10-07 实测，shanhai 生产）⇒ 不涉及数据迁移。
-- 若未来在有数据的库上重放本迁移：先迁移数据再切读侧——那是那次部署的前置步骤，不在本文件里猜。

-- ① 摘掉两列上的 FK（FK 名是 001 inline references 的默认名；用 plpgsql 动态摘，
--    不猜具体名字——不同 PG 版本/导入路径生成的名字可能不同）
do $$
declare r record;
begin
  for r in
    select conrelid::regclass::text as tbl, conname
      from pg_constraint
     where contype = 'f'
       and conrelid in ('aftersales.employee'::regclass, 'aftersales.employee_store'::regclass)
       and pg_get_constraintdef(oid) like '%store_id%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;
end $$;

-- ② 摘掉 not null（employee_store.store_id 原为 not null）⇒ 死列可空，新代码不再写它
alter table aftersales.employee_store alter column store_id drop not null;
alter table aftersales.employee alter column store_id drop default;

-- ③ 新引用列（dim_branch.code 自然键；not null default '' 与模块内其余 text 列口径一致）
alter table aftersales.employee add column if not exists store_code text not null default '';
alter table aftersales.employee_store add column if not exists store_code text not null default '';

-- ④ 去重唯一索引随引用列切到 store_code（import 的 on conflict 与「同一员工同一门店只一次」
--    都押在它上面）。旧索引保留（其列是死列，重建无害）——drop 会破坏 001 全量重跑。
drop index if exists aftersales_employee_store_org_emp_store_idx;
create unique index if not exists aftersales_employee_store_org_emp_code_idx
  on aftersales.employee_store (org, employee_id, store_code);
