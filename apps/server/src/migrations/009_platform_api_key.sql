-- 009_platform_api_key.sql — 个人 Key（通道 B，PAT）密钥表：**从 modules/data 上移宿主**（issue #894，正典 §1.5）。
-- 上移理由：token 是**平台级身份能力**（「每个账号生成 token」），不该长在首个消费者（问数）的模块 schema 里——
--   旧位置逼出一条 `runtime.port('data','resolvePatKey')` 间接层（宿主绕 B1 去模块取凭据），本表落地后该层退役。
-- 形状照搬 data.query_keys（DDL/列语义/唯一约束逐条对齐），**唯一差别 = 隔离键留 org text**：
--   宿主其它表用 tenant_id int 是它们的事；本表必须能与 pat-auth 的 `key.org !== tenant.casdoor_org`
--   直接比较（跨租户判定口径是 text org，见 apps/server/src/pat-auth.ts）。
-- 纪律：幂等（create ... if not exists）；哈希实现只有一份（宿主侧 api-key-store.ts）。
create table if not exists platform.api_key(
  id           bigserial   primary key,
  org          text        not null,           -- = 租户 casdoor_org，pat-auth 直接比它做跨租户判定
  casdoor_user text        not null,           -- Casdoor **用户名**（不是 sub）
  name         text        not null,
  token_hash   text        not null unique,    -- sha256(token) hex；明文永不落库
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz                     -- 软删：吊销即置此列，解析侧 where revoked_at is null
);
create index if not exists platform_api_key_org_user_idx on platform.api_key (org, casdoor_user);
