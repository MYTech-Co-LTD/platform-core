-- 020 — OA 引擎映射：平台的唯一登记点；无行 = 该租户 OA 关闭（fail-closed）。
-- 计划文档写作 019_oa_engine.sql，落地时 018/019 已被 platform_jobs / job_schedule_soft_delete
-- 占用（迁移文件名前缀全仓唯一，历史无重号），故顺延为 020；语义与计划逐字一致。
--
-- pat_secret_ref 只存**键名**（env/secret 引用），不存值：敏感值规矩=文档/代码只写「在哪、怎么取」。
create table if not exists platform.oa_engine (
  org            text primary key,
  base_url       text not null,
  pat_secret_ref text not null,
  engine_version text,
  enabled        boolean not null default true,
  updated_at     timestamptz not null default now()
);
