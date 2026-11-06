-- 038_verified_baseline_refresh.sql —— 回归基线刷新留痕（W6 Task 4，#1484）。
--
-- 为什么需要：基线是「某个时点重放出来的数值快照」。数据回填/退货冲减/补采之后，老基线
-- 与当前值必然分叉，回归会报红——**那不是口径错，是基线过期**（2026-11-06 真机：
-- #3「近 7 天净销售额」230.5 万 → 174.0 万）。没有刷新机制，评估集越大假红越多。
--
-- 设计原则：刷新是**有主体的写操作**，必须能回答「谁在什么时候、因为什么刷新了基线」。
-- 因此三列必填语义：`refreshed_by` 空 = 从未刷新（历史行保持 NULL，不伪造）。
--
-- 幂等：`add column if not exists`，重跑无副作用。
alter table data.verified_questions
  add column if not exists baseline_refreshed_by text,
  add column if not exists baseline_refreshed_at timestamptz,
  add column if not exists baseline_refresh_reason text;
