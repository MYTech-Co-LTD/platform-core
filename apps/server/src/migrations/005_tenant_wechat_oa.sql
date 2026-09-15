-- 005_tenant_wechat_oa.sql — 租户级微信公众号 provider（售后 spec §1.3 外部客户身份）
--
-- 与 wecom 三参（003/004 同族）同桶：multi 下每个租户自己的公众号。允许 NULL：
-- 不配 ⇒ wechat-oa 路由对该租户 404 WECHAT_OA_NOT_CONFIGURED（配置存在即启用，非 login_methods）。
-- 幂等：部署每次全量重跑迁移。
alter table platform.tenant add column if not exists wechat_oa_app_id text;
alter table platform.tenant add column if not exists wechat_oa_secret text;
