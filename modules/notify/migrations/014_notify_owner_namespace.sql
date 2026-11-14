-- 014_notify_owner_namespace.sql — 模板/规则的 agent 命名空间归属（N2）
--
-- null = 平台/租户人管（builtin、derived、manual、人工建的 tenant 模板）；
-- 非空 = 该 agent namespace 所有，agent 自助面只能改自己的。
-- FK 指向 notify.agent_namespace(org, namespace)；null 不受 FK 约束。
-- 幂等：add column if not exists / DO 块检查约束。
alter table notify.template
  add column if not exists owner_namespace text;
alter table notify.rule
  add column if not exists owner_namespace text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'notify_template_owner_namespace_fk'
       and conrelid = 'notify.template'::regclass
  ) then
    alter table notify.template
      add constraint notify_template_owner_namespace_fk
      foreign key (org, owner_namespace)
      references notify.agent_namespace(org, namespace);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conname = 'notify_rule_owner_namespace_fk'
       and conrelid = 'notify.rule'::regclass
  ) then
    alter table notify.rule
      add constraint notify_rule_owner_namespace_fk
      foreign key (org, owner_namespace)
      references notify.agent_namespace(org, namespace);
  end if;
end $$;

create index if not exists idx_notify_template_owner_namespace
  on notify.template(org, owner_namespace) where owner_namespace is not null;
create index if not exists idx_notify_rule_owner_namespace
  on notify.rule(org, owner_namespace) where owner_namespace is not null;
