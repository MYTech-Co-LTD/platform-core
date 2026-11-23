# Runbook：在山海数据面为山海租户启用 forms 采集（目标件 E2E 前置）

> 依据：协调者 2026-11-23 裁决（人已同意）——「为山海租户在山海数据面建它自己的 forms 采集管线
> （同面 join 是唯一正路）」。本文只写**生产变更步骤与回读判据**；写者（worker）**未执行**任何
> 启停/部署动作（按分工：合并、部署、启停生产服务由协调者执行并留档）。
>
> 涉及对象（openship，org `feg7gkRtboPDOBVYUSV3Cagll2tf59Fw`）：
> - 项目 `platform-core-shanhai-data` = `proj_AFbJvyb0onaX7LVr`（serverId `8281d598`，数据单元）
> - 服务 `forms-console` = `svc_nQaReL0EvSBqK9gW`（当前 `enabled:false`，端口 18082，卷 `forms-console-ws`）
> - 项目 `platform-core-shanhai` = `proj_GLXUtN2bJ92DpPrS`（应用单元，`platform.shanhaiyiguo.com`）

## 0 硬前置（不满足就停，不要变通）

1. **山海租户自己的 PAT**：`org = shanhaiyiguo-org`（Casdoor org），scope 至少 `forms:view`
   （导出面 `GET /api/modules/forms/export/submissions` 用它）；若要经 API 录目标，再加 `forms:fill`。
   **严禁复用旧 mytech token**——R7 的错误归属正是这么来的（湖上的 org 与采集凭据归属不一致）。
   取法：平台控制台个人 Key 页（`https://platform.shanhaiyiguo.com`）；**不写值、不进仓**。
2. 平台库 `forms.asset_version` 里 `goal-monthly-store` v1 为 `published` 且
   `body->'dataPlane'->>'enabled' = 'true'`（**已由本 PR 完成**，2026-11-23 走真实发布门落库）。

## 1 需要协调者执行的步骤（逐条带回读判据）

| # | 动作（openship 操作） | 预期回读（判据） |
|---|---|---|
| 1 | 把 PAT 写进 `platform-core-shanhai-data` 的 **项目/服务 env**：`forms-console` 的 `FORMS_TOKEN`（isSecret，值 = §0-1 的 PAT）；确认 `FORMS_API_BASE=https://platform.shanhaiyiguo.com` | `get_projects_by_id_services` 里该服务 env 有 `FORMS_TOKEN` 键（值脱敏）；容器内 `printenv FORMS_TOKEN` 非空 |
| 2 | 启用服务：`POST/PATCH …/services/svc_nQaReL0EvSBqK9gW` `enabled:true`，并让容器起来（start 或数据单元部署） | 服务 `enabled:true`；容器 `Status=running`；`curl -s -H "Authorization: Bearer $DUCKLE_TOKEN" http://127.0.0.1:18082/api/schedules` 返回 JSON（容器内执行） |
| 3 | **更新 workspace 里的 `forms` 连接凭据为山海 PAT**（连接是密文，见 §3 现状） | 首跑时 `src 1 rows`（而非 401）；失败则看容器日志里 HTTP 状态 |
| 4 | 首跑管线 `forms.submission.l0`（console API `POST /api/run`，params 见 duckle-console-run-api） | 容器日志 `sink Success`；湖对象出现：`s3://shanhai-data/forms/submission/bizday=<上海今日>/batch_id=<ts>/all.parquet` |
| 5 | 湖对象独立回读：用 pg_duckdb 直读（role `platform` 已有 ZOS USER MAPPING）或 S3 LIST | `select count(*)` ≥ 1；列集 = 契约 6 列（batch_id/bizday/submission_id/form_def_id/submitted_at/payload，**无 org**）；`form_def_id='goal-monthly-store'` |
| 6 | 开闸 `data.dbt_goals`（`platform.job_schedule`：`update … set enabled=true where key='data.dbt_goals'`）或先手动跑一轮 `MATERIALIZE_SCOPE=tables MATERIALIZE_TABLES_DOMAIN=lemeng,goals MATERIALIZE_TABLES_SELECT=path:models/goals` | 日志 `PASS≥2 ERROR=0` + `MATERIALIZE_OK scope=tables`；`select * from staging.stg_goal_values__monthly_store_sale` 有行；`select * from staging.mart_goal_achievement__monthly_store_sale` 有行且 `actual_*` = 该店实际值合计 |
| 7 | 词表物化：`node scripts/sync-data-semantics.mjs`（应用单元，`DATABASE_URL`=山海平台库） | `data.metrics` 出现 4 条 `lemeng:goal:monthly_store_sale_*`；`select_sql` 的 FROM 是 mart |
| 8 | 报表/日报：用内置模板 `goal_achievement` 建一张报表；`goal.daily_push` 手动跑一轮（app 单元） | 报表能渲染；`notify.event` 出现 `forms.goal.daily`；持 `data:query` 的收件箱有消息 |

## 2 回滚（任一步失败）

1. `update platform.job_schedule set enabled=false where key in ('data.dbt_goals','data.dbt_audit_goal')`；
2. `forms-console` 服务 `enabled:false`（并在 workspace 卷里把排班 `enabled:false`，防部署重建复活——
   R7 的既有纪律）；
3. 湖对象可保留（无害），但要**记录删/留决定**；
4. 不回滚已发布表单（它是业务数据；退役走 forms 的 retire 生命周期）。

## 3 现状与未验证点（如实登记）

- `forms-console-ws` 卷自 2026-10-18 停用后**未重建**，假设仍保留当时的 workspace（两枚密文连接
  `zos` / `forms`、工作区钥匙、`forms.submission.l0` 管线与排班）。**未验证**（服务停止，无法只读
  容器内卷内容）；若卷已亡，需按 M1.4 R5 的方式重建 workspace（连接 + 钥匙 + seed 管线/排班/告警/owners）。
- 当时 `forms` 连接里存的是 **mytech 租户的 token** ⇒ §1-3 必须换掉；该连接是**密文**，
  更新路径二选一：(a) duckle console UI（18082）→ Connections → `forms` → 更新 token（需工作区钥匙）；
  (b) 若 UI 不可用，按 M1.4 的重建法重造连接。**不要**把新 token 写进管线 JSON 明文。
- 旧 token 复用 = 违反本次裁决（湖上 org 与凭据归属必须同为山海）。

## 4 开闸后必须补跑的对账 / 已知边界

- `data.dbt_audit_goal`（4 条）同样四步开闸；它只比**已封版月份**且收集日 T-3 之前的目标提交，
  当月红绿不参与（详见各 audit 头注）。
- **封版最小版未实现（协调者裁决 4 的「成本超预期」出口）**：`goal_period(org, goal, period, state,
  closed_at)` + 目标行 `effective_at/supersedes_id` + mart 按封版时刻 as-of 读 + reopen 审计。技术原因：
  分析面**只读湖**（数据宪法 I1），封版状态在 PG；要让 mart 做 as-of，必须先把 `goal_period` 与
  `supersedes_id` **出湖**（新采集数据集 + 契约/管线/staging 三处 + 应用侧 close/reopen 路由），
  属新的采集物而非本波最小改动。⇒ 当前行为：mart 取**最新提交**，封版后更正会改写历史月达成率，
  **无 as-of**。已登记为已知边界（见验收记录 §7）。
