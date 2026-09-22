-- 003_metrics_source.sql — 指标行的**来源分层**（L1 平台声明 / L2 租户声明，modules/data T8）。
--
-- 纪律（与 001/002 同源，别按口味改）：
--   · 幂等：全部 if not exists / add column if not exists——部署脚本会每次全量重跑全部迁移
--     （团队规则 db-migration §1）。本文件**不含** create table，故无租户隔离面新增
--     （data.metrics 的 org not null 由 001 建立，check-tenant-isolation 的判据面不变）。
--   · 外部系统来的字段一律 text（团队规则 §2）——`source` 是**自己控制的枚举**（l1/l2），
--     不是外部输入，故 text + check 约束而非 varchar。
--
-- ── 这一列解决什么（全局约束 12：禁任意 SQL 的定义面）────────────────────────────────
-- `data.metrics.select_sql` 是唯一被授权核心拼进 SQL 的字符串（domain/authz.ts 的 authorize）。
-- 它**只能**有两个来源：
--   · `source='l1'` —— 由 `scripts/sync-data-semantics.mjs` 从仓内 dbt YAML 物化写入
--     （L1 事实源是 dbt 声明，见 dbt/semantics/l1_metrics.yml）；管理 API **只读**。
--   · `source='l2'` —— 由 `domain/semantic-compiler.ts`（**唯一编译点**）从结构化声明编译
--     （L2Declaration），管理 API 只收结构化声明、**拒收自由 SQL**。
-- 没有这一列，两种来源在库里长得一模一样 ⇒「这行 select_sql 到底谁写的、谁可以改」无从判断，
-- 「L1 只读」这条纪律就只能靠人记得（而靠人记得的纪律失效时是静默的）。
--
-- ── ⚠️ default 'l2' 的语义（合并前置 gate，见计划 Task 8 Step 3）──────────────────────
-- `not null default 'l2'` 只对**届时已清零 / 已处置**的表安全：
--   · 存量行会被它**静默改标为 l2**——而存量行可能是山海试点期经 #146 的 console 指标页
--     用**自由 selectSql** 写进去的（那时还没有唯一编译点）⇒ 它们会变成不受唯一编译点管辖的
--     「L2 祖父级行」，违反全局约束 12，且**从库里看不出它们是祖父级**。
--   · 故本迁移落生产前必须**先核对存量行数并逐行处置**（迁入 dbt YAML 成为 L1，或删除；
--     自由 SQL 行不迁 YAML 就只能删，没有第三种去向）。核对着落见任务报告。
--   · 反向也说明为什么 default **不能**写成 'l1'：那会把自由 SQL 的存量行标成「平台声明」，
--     等于给未治理的 SQL 盖一个「已治理」的章——比标成 l2 更坏。
-- 幂等重跑说明：`add column if not exists` 在列已存在时**整句 no-op**（含 default 与 not null
-- 子句），不会重新求值 default、也不会重写既有行的值 ⇒ 重跑安全。
--
-- 加上 check 约束（而不是只在应用层校验）的理由：值是**枚举**，而这两行的差别是
-- 「谁能改这行 SQL」——写错一个字母（'L1' / 'platform'）会让该行走**另一条**授权路径。
-- 让库来兜这个枚举，是「判据写在唯一能被机检的地方」。
-- PG 没有 `add constraint if not exists`，故用 DO 块吞 duplicate_object（幂等，非静默 swallowing：
-- 只吞「已存在」这一种）。

alter table data.metrics
  add column if not exists source text not null default 'l2';

do $$
begin
  alter table data.metrics
    add constraint data_metrics_source_check check (source in ('l1', 'l2'));
exception
  when duplicate_object then null;
end $$;

-- 索引：sync 脚本按 `source = 'l1'` 求「本仓声明集 ↔ 已物化集」的双向差集（删除不再存在的 L1 行），
-- 对账/troubleshooting 也按来源筛。
create index if not exists data_metrics_source_idx on data.metrics(source);
