-- 048_narrative_runs.sql — 叙事生成运行台账（R5 信任闭环）。
--
-- 为什么：`report_narratives` 只存**成功结果**（且模型可用时回退模板不缓存），
-- 所以「回退率/越界率/生成时长」无法从结果表算出来。这里按**每次生成尝试**落一行，
-- 只用于运营观测（不计费、不参与业务判断）；写入 best-effort，失败不反噬生成。
create table if not exists data.narrative_runs (
  id            bigserial primary key,
  org           text not null,
  report_id     text not null,
  focus         text not null,
  mode          text not null,                 -- day | range
  model         text,                          -- null = 未配置模型
  prompt_version text not null,
  outcome       text not null,                 -- ok | fallback | cached | error
  reason        text,                          -- 失败/回退原因（number_check / llm_failed / stream_failed ...）
  duration_ms   integer,
  created_at    timestamptz not null default now()
);

create index if not exists narrative_runs_org_created_idx
  on data.narrative_runs (org, created_at desc);
