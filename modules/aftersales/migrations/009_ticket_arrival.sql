-- 009_ticket_arrival.sql — 工单补「到货日期 + 到货时间」（2026-11-25 人裁，对齐 wuji 源交互）
--
-- 背景：wuji 源提交页有两个必填控件「到货日期 / 到货时间」——它们是**售后判责的关键事实**
-- （什么时候到的货、什么时候坏的）。M1 移植时按 spec §0.3 删掉了（当时 SubmitBody 不收），
-- 2026-11-25 要求按源交互恢复。
--
-- 落法：存**一个** `arrival_at timestamptz`，不存两个分列——
--   · 前端仍用两个控件（date + time），提交时拼成 ISO 字符串；
--   · DB 侧一个时间点更利于「到货 → 报损」间隔计算与排序；
--   · 分列会让「只有日期没时间」成为合法中间态，那是没人会用的形状。
--
-- 可空：历史工单（以及未来不经该页面的写入路径）没有这个事实，不能用默认值编造。
alter table aftersales.ticket
  add column if not exists arrival_at timestamptz;
