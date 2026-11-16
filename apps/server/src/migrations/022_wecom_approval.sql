-- 022_wecom_approval.sql — 租户级「审批应用」凭据（OA P2 标准审批镜像，issue #2385）
--
-- 为什么是**另一个**应用：标准审批在企微审批应用内原生执行，平台只做只读镜像；它用于
-- 回调验签解密与 gettoken/getapprovaldetail 拉取，**不复用**登录用的 wecom_corp_id/
-- wecom_agent_id/wecom_secret（那是登入通道的凭据，生命周期与权限面都不同）。
--
-- 五列同桶（缺任一 ⇒ 该租户的回调/对账跳过并告警 config_missing，绝不猜值）：
--   wecom_approval_corp_id / agent_id / secret   —— gettoken、getapprovaldetail 的调用凭据
--   wecom_approval_token / aes_key               —— 回调 URL 的 msg_signature 验签与 EncodingAESKey 解密
--
-- 敏感值规矩：只写「在哪、怎么取」——值存本表（写入面在管理面/env），代码与日志不出现值。
-- 允许 NULL：未配标准审批的部署行为一字不变（这是增量能力，不是必填配置）。
--
-- 幂等：本仓部署每次全量重跑全部迁移，故必须可重复执行。
alter table platform.tenant add column if not exists wecom_approval_corp_id text;
alter table platform.tenant add column if not exists wecom_approval_agent_id text;
alter table platform.tenant add column if not exists wecom_approval_secret text;
alter table platform.tenant add column if not exists wecom_approval_token text;
alter table platform.tenant add column if not exists wecom_approval_aes_key text;
