-- 003_notify_contract.sql — expand/contract 的 contract 阶段（2026-10-27）。
-- 1) drop 旧 rule/delivery（旧 Novu 管道退役）
-- 2) rule_v2 -> rule / delivery_v2 -> delivery；索引改回最终名
-- 幂等：所有动作先判存在。
do $$
begin
  if to_regclass('notify.rule') is not null then
    drop table notify.rule;
  end if;
  if to_regclass('notify.delivery') is not null then
    drop table notify.delivery;
  end if;

  if to_regclass('notify.rule_v2') is not null and to_regclass('notify.rule') is null then
    alter table notify.rule_v2 rename to rule;
  end if;
  if to_regclass('notify.delivery_v2') is not null and to_regclass('notify.delivery') is null then
    alter table notify.delivery_v2 rename to delivery;
  end if;

  if to_regclass('notify.idx_notify_rule_v2_match') is not null then
    alter index notify.idx_notify_rule_v2_match rename to idx_notify_rule_match;
  end if;
  if to_regclass('notify.idx_notify_delivery_v2_due') is not null then
    alter index notify.idx_notify_delivery_v2_due rename to idx_notify_delivery_due;
  end if;
end $$;
