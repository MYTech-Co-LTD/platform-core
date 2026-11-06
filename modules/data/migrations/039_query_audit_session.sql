-- 039_query_audit_session.sql —— 审计补会话关联（W6 出口判据 ④「可辩护答案时长」）。
--
-- 为什么：`query_audit` 只有行级痕迹，没有会话键 ⇒ 无法回答「同一会话里，从首次提问到第一个
-- 成功查询隔了多久」。W6 的价值指标「可辩护答案时长」缺这一列就算不出来（此前面板只能显示「未接入」）。
--
-- 来源：企微通道的 `x-session-id` 头（openclaw 插件用 sessionKey 填）。非企微通道（SaaS 会话/PAT）
-- 暂无会话键 ⇒ 落 NULL，不伪造。
--
-- 幂等：`add column if not exists` + `create index if not exists`。
alter table data.query_audit add column if not exists session_id text;

create index if not exists query_audit_session_idx
  on data.query_audit (org, session_id, created_at)
  where session_id is not null;
