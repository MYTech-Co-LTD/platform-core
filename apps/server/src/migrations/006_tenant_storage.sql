-- 006_tenant_storage.sql — 租户级存储配置（M3c，售后 spec §2.3 目标形态 / 正典「租户级配置注入」）
--
-- 与 wecom 三参（003/004）、公众号两键（005）同桶：multi 下每个租户自己的桶。
-- 语义（裁定 4，fail-explicit）：
--   五列**全空**   ⇒ 该租户未配 ⇒ 宿主注入**平台默认**（进程 env 五键；env 缺任一 ⇒ 不注入）
--   **部分填写**   ⇒ 视为「配置存在但无效」⇒ **不注入**（绝不回落平台桶 —— 回落 = 数据位置误述 + 成本事故）
--   五列全填     ⇒ 注入该租户自己的配置
-- 允许 NULL（而不是 not null default ''）：`select *` 带出的 null 与「没配」是同一件事，
-- 且与 005 的既有时态一致。判定「全空 / 部分 / 全填」的实现只有一处（tenant-storage.ts）。
--
-- ⚠️ `storage_secret` 与 AK 是**密钥型**：绝不回显、绝不进日志 / audit / CHANGELOG。
-- ⚠️ 改了这五列**不会**自动让配置生效于 single 部署：single 的租户行有 60s 进程内缓存
--    （apps/server/src/tenant.ts 的 ORG_CACHE_TTL_MS），生效窗口最长 60s。
--
-- 幂等：本仓部署每次全量重跑迁移（migrate.ts 按 platform.schema_migrations 记账去重，
-- 重复执行同一文件不会再来一次；但文件本身仍按 `if not exists` 写成可重复的）。
alter table platform.tenant add column if not exists storage_endpoint     text;
alter table platform.tenant add column if not exists storage_region       text;
alter table platform.tenant add column if not exists storage_bucket       text;
alter table platform.tenant add column if not exists storage_access_key   text;
alter table platform.tenant add column if not exists storage_secret       text;
