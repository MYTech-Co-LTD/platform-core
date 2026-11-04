-- 033_verified_question_decisions.sql — 记录「谁拒绝/谁确认」的决策痕迹
-- 背景（Task 2 评审 Important）：拒绝也要能回答「谁拒绝的」。`verified_by` 语义收窄为
-- 「谁**确认**过」，不再兼任拒绝记录——从未 verified 的候选行被拒绝后 verified_by 恒 NULL，
-- 拒绝人无处可存。故新增独立的决策列：
--   decided_by / decided_at：最近一次**人工决策**（确认或拒绝）的操作人与时间。
--   verified_by / verified_at：只表示「谁确认过」；拒绝不覆盖它（拒绝一行不会抹掉确认痕迹）。
-- 033 不改已应用过的 032（迁移记账表不会重跑旧文件）；本文件同样幂等。
alter table data.verified_questions
  add column if not exists decided_by text,
  add column if not exists decided_at timestamptz;
