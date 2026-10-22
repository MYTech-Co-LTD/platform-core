-- 010_platform_api_key_backfill.sql — 上移补课：把 data.query_keys 的存量 key 搬进 platform.api_key。
--
-- 背景：上移（issue #894）只建了新表、没搬数据：上移前签发的 PAT 全部留在旧表，而 resolvePat
-- 只查新表 ⇒ 全部 401 INVALID_KEY（shanhai 生产 2026-10-22 实测；「手工 SQL 命中 / 应用 401」
-- 的排障矛盾即两张表分叉——查的表不一样）。本迁移补**数据**这一半。
--
-- ⚠️ 两个战场的教训，落位与守卫都是它们定的：
--   ① **必须住宿主侧**（不能放 data 模块 migrations/）：宿主迁移在**每个部署无条件必跑**；
--      模块迁移依赖模块被装载（模块退役即不再跑，回填就被跳过）。且模块迁移不保证 platform
--      表存在（aftersales 的测试夹具只跑模块迁移——放模块侧在那类库上写宿主表即炸，CI unit
--      2026-10-22 实测）。目标表归宿主所有，回填就是宿主的事。
--   ② **对旧表存在性加守卫**：宿主迁移序先于模块迁移（app.ts 先 runMigrations(platform) 再
--      loadModules），全新空库上跑到本文件时 data.query_keys 还不存在——无守卫装载即炸（CI
--      smoke 2026-10-22 实测）。守卫跳过的库只可能是全新库：旧代码已死，存量行只会存在于
--      上移前的库，而那种库表必然已在 ⇒ 跳过永不漏搬。
--   · **on conflict (token_hash) do nothing** ⇒ 重跑幂等，且**不复活已吊销 key**：上移后吊销
--     只发生在新表（旧表 revoked_at 恒 null），写成 do update 会在重跑时用旧表状态盖回新表
--     ⇒ 复活已吊销的 key（安全回退），故此处刻意不用 do update（迁移纪律要求的是「可重复」，
--     do nothing 满足）；新签发只走新表（api-key-store.ts createPatKey），本迁移跑一次即记账。
--   · 旧表**保留不删**（回滚兜底，同 tenant_module 先例）。
do $$
begin
  if to_regclass('data.query_keys') is not null then
    insert into platform.api_key (org, casdoor_user, name, token_hash, created_at, last_used_at, revoked_at)
    select org, casdoor_user, name, token_hash, created_at, last_used_at, revoked_at
      from data.query_keys
    on conflict (token_hash) do nothing;
  end if;
end
$$;
