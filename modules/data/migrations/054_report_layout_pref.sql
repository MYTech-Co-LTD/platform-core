-- 054_report_layout_pref.sql — 个人报表版式（issue #2295）。
--
-- 一条 = 「某人对某张报表的顺序 + 宽度偏好」。默认版式不在这里（落在 data.reports.spec，
-- 走版本/发布语义）；本表只服务观看者的个人微调，**不参与发布**、不进版本台账。
--
-- 为什么存 DB 而不是 localStorage：同一用户在桌面/移动端打开同一张报表应看到同一个版式；
-- 也避免清缓存即丢失。items 形状：{ "items": [{ "key": "1|line|销售额", "span": 12 }] }，
-- 服务端读写都过 validateLayoutItems（见 domain/report-layout.ts）。
create table if not exists data.report_layout_pref (
  org        text        not null,
  report_id  text        not null,
  -- 用户标识与 query_audit.session_id 同口径（宿主注入的 session 身份，不是 Casdoor 密码类凭据）
  viewer     text        not null,
  items      jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (org, report_id, viewer),
  -- 报表删除（生命周期回收）连带清个人版式：与版本表/访问台账同一口径。
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);
