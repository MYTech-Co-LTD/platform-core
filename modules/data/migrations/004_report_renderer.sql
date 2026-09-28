-- 004_report_renderer.sql — 报表的**渲染器**维度（modules/data，spec §2 / §4）。
--
-- 纪律（与 001/002/003 同源，别按口味改）：
--   · 幂等：add column if not exists（整句在列已存在时 no-op，含 default 与 not null 子句）
--     —— 部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 值是**自己控制的枚举**（不是外部输入）⇒ text + check 约束，不用 varchar
--   · 隔离面无新增：本文件不含 create table，data.reports 的 org not null 由 002 建立
--
-- ── 这一列解决什么（spec §2）────────────────────────────────────────────────────
-- 报表可以有两类渲染器：Metabase 标准图（`metabase`）/ 平台自绘（`platform`）。
-- 它**只影响「点开时谁渲染」**，不影响任何管理动作（页门 / 发布 / 回收对两类语义相同）
-- ⇒ 所以它不能改变主键、也不能成为第二个管理面（spec §2 的裁决）。
--
-- ── 为什么 default 是 'metabase' ────────────────────────────────────────────────
-- 存量行（002/003 时期登记的）全部是 Metabase 报表 ⇒ default 必须与事实一致。
-- 若写成 'platform'，存量行会被静默改标成"平台自绘"，而没有渲染器实现 ⇒ 点开是空白，
-- 且**从库里看不出它们标错了**。
--
-- ⚠️ 与 003 的 `default 'l2'` 不同，本列 default **不会**造成「未治理的行被盖章」：
--    'metabase' 是**存量事实**，不是"最宽松的选项"（两类渲染器在管理面上等权）。

alter table data.reports
  add column if not exists renderer text not null default 'metabase';

do $$
begin
  alter table data.reports
    add constraint data_reports_renderer_check check (renderer in ('metabase', 'platform'));
exception
  when duplicate_object then null;
end $$;

-- 管理面按渲染器筛（"哪些报表是平台自绘的"）
create index if not exists data_reports_renderer_idx on data.reports(renderer);
