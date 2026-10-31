-- 007_channel_credential.sql — 出站渠道凭据（spec 2026-10-31-multi-channel-im-provider-design.md §3.2）
--
-- 为什么要有它：`wecom_chat` 现在走共享桥，而桥的租户表是**文件**（`tenants.local.json`，不入库、
-- 无审计、租户级健康探不出来）。直连某渠道需要 app 凭据，凭据不能进 repo/日志，也不该散落在
-- 别人的配置文件里 ⇒ 落本模块自己的表、**加密存储**。
--
-- 与 `platform.tenant.wecom_*` 的关系（**刻意不合并**）：那份服务**登录**（SSO），本表服务**出站**；
-- 两者今天是同一个企微应用，但生命周期与读取方不同（登录链路不能等本模块迁移）。运维不必重录——
-- `scripts/notify-import-wecom-cred.mjs` 从 platform 那份**一次性导入**并加密。
--
-- 加密：`secret_enc = base64(iv || ciphertext || tag)`，AES-256-GCM；KEK 来自 env `NOTIFY_CRED_KEK`
-- （64 个 hex 字符 = 32 字节）。`key_version` 只为将来轮换留位（本期只写 1）。
-- **fail-closed**：KEK 缺失 ⇒ 不加密、不解密、该通道发不出去（绝不降级成明文）。
--
-- 幂等：create table if not exists。
create table if not exists notify.channel_credential (
  org         text        not null,
  provider    text        not null,
  -- 渠道内的应用标识：企微 corpId / 飞书 app_id / 钉钉 appkey（明文，用于展示与去重）
  app_key     text        not null,
  agent_id    text,
  secret_enc  text        not null,
  key_version integer     not null default 1,
  extra       jsonb       not null default '{}'::jsonb,
  created_by  text        not null,
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz,
  primary key (org, provider)
);
