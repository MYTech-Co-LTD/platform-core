-- 048_metric_change_declaration_kind.sql —— 变更单恢复 declaration 档（P5 Task 1，2026-11-13）。
-- 背景：P4 写面收口退役了 `POST /metrics/declarations`（410），但变更单 kind 集漏了该值 ⇒
-- 「新租户全额声明」失去提案通路（只能改不能建）。本迁移把 declaration 补进 CHECK，
-- 让 declaration 档重新可达（提交/试算/人工采纳全链复用既有写路径）。
--
-- 幂等：迁移器按文件名记账只跑一次；手工重跑也安全（drop if exists + add）。
alter table data.metric_change drop constraint if exists metric_change_kind_check;
alter table data.metric_change add constraint metric_change_kind_check
  check (kind in ('create','update','meta','override','delete','declaration'));
