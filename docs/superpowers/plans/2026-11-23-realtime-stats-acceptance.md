# 件④ H3 运营实时统计 真机验收记录（D4）

> 计划：`docs/superpowers/plans/2026-11-23-forms-realtime-stats.md`（Task D4；D1+D2+D3 已合入
> main，HEAD `35f301c2` = PR #2764）
> issue：#2757（Closes）/ #2754（epic，Refs）
> 记录时间：**2026-11-24 10:16–10:20 北京时间**（本文件只写实测与边界，不写「应该」）
> 分支：`ylwzzs/oa-h3-stats-accept`（验收纯绿，零代码改动——本 PR 只落本记录）

## 0 一句话结论

**16/16 全 PASS**：正向链（建表单 → 发布 → 提交 3 条 → 具名视图/ad-hoc 聚合 A=170/B=70 →
asOf → 15s 缓存命中 → 提交后失效）、agent 同创（`generate_form_draft` 确定性兜底出
`total`/`by_class` 视图且过发布门）、七组负对照（未声明字段 / string sum / limit 超限 /
in 51 / stats 未开 / 跨租户 / analytics 审批门双身份）全部按声明的机检码与状态码拒绝。

## 1 验收环境（真机口径）

| 项 | 值 |
|---|---|
| 宿主进程 | apps/server 真启动（tsx `src/index.ts`）：迁移装载 + 6 模块挂载，`tenantMode=single`，端口 13400 |
| PG | 独立本地库 `platform_h3stats`（不与共享库混线；迁移由宿主启动期真跑） |
| IdP | MockCasdoor（**真实 HTTP + 真实 CasdoorClient 代码路径**；用户/权限/订阅按 org 分桶种子：admin1=部门管理员 forms 四码、root1=平台数据负责人含 `forms:data-plane`、beta1@beta=跨租户对照） |
| 鉴权 | 通道 B PAT（`dkq_…`）：`platform.api_key` 真表 + sha256 哈希 + 跨租户 org 比对 + 限速窗口，全部真代码路径 |
| LLM | **外部依赖替身**：OpenAI 兼容桩（127.0.0.1:13499），固定回**不带 `dataPlane`** 的契约 JSON——刻意走 `generateDraft` 确定性兜底分支；LLM 本体不在本件验收范围 |
| 夹具脚本 | `.tmp/dev-stack-forms.mjs`、`.tmp/llm-stub.mjs`、`.tmp/h3-accept.mjs`（gitignore，不进仓；原始证据：每笔请求的 method/path/status/耗时/响应体） |

## 2 正向链（全部 ✅）

| # | 步骤 | 实测 |
|---|---|---|
| A1 | 建含 `class(string,groupable)`、`score(number,agg sum/avg)`、`submitted_date(date)` 的表单，`dataPlane.stats.enabled=true` + 视图 `by_class`/`total`，发布 | `POST /defs` 201；`POST /defs/score-form/versions/1/publish` → 200 `{"ok":true}` |
| A2 | 提交 3 条（A 班 80/90、B 班 70） | 3×201（submission id 1/2/3，均钉 head v1） |
| A3 | `POST /stats {assetId, viewId:'by_class'}` | 200：`rows=[{class:'A',sum_score:'170'},{class:'B',sum_score:'70'}]`，`asOf=2026-11-24T02:16:38.932Z`，`viewId` 回显，`truncated:false` |
| A4 | 15s 内重复调用同一查询 | 200 且 `cached:true`，`asOf` 与 A3 **逐字一致**（同一份快照） |
| A5 | ad-hoc `groupBy:['class'] + sum(score)` | 200：A=170/B=70，无 `cached` 标记（独立缓存键） |
| A6 | 附加：提交第 4 条（A 班 +10）后立即再查 | A=**180**、`asOf` 刷新、无 `cached`——**「提交后失效」约束实测成立**，不是等 15s 过期 |

## 3 agent 同创（✅）

| # | 步骤 | 实测 |
|---|---|---|
| B1 | `POST /mcp-manage` `tools/call generate_form_draft`（同一业务场景） | 200：`assetId=score-form-agent`，桩模型未给 `dataPlane` ⇒ **确定性兜底**补上 `dataPlane.stats.enabled=true`、`views=["total","by_class"]`（数值→sum/avg 度量、enum→分组维、至少一条合计） |
| B2 | 该 draft 过发布门 | `POST /defs/score-form-agent/versions/1/publish` → 200 `{"ok":true}`（发布校验与 `/stats` 同一套白名单，views/fields 与 schema 一致性被 compileGate 真拦真放） |

## 4 负对照（7 组，全部按声明拒绝 ✅）

| # | 注入 | 实测 |
|---|---|---|
| C1 | groupBy 未声明字段 `ghost` | 400 `STATS_FIELD_NOT_ALLOWED`（「groupBy 字段 ghost 未在契约中声明」） |
| C2 | `sum` 用在 string 字段 `class` | 400 `STATS_AGG_TYPE_MISMATCH`（「字段 class（string）不能做 sum」） |
| C3 | `limit:10000` | 400 `STATS_LIMIT_TOO_LARGE`（「limit 必须是 1..1000 的整数」） |
| C4 | `in` 51 项 | 400 `STATS_IN_TOO_LARGE`（「in 列表最多 50 项」） |
| C5 | 未开 stats 的 `plain-form`（先真发布） | 403 `STATS_NOT_ENABLED` |
| C6 | beta org 的 PAT 打 acme 租户 `/stats` | 401 `INVALID_KEY`——org 由 identity 钉死，跨租户 key 在 Casdoor 查询**之前**拒绝，acme 数据零暴露 |
| C7a | 部门管理员（admin1，无 `forms:data-plane`）发 `analytics.enabled` 表单 | 403 `DATA_PLANE_APPROVAL_REQUIRED` |
| C7b | 平台数据负责人（root1，含 `forms:data-plane`）发同一 draft | 200 `{"ok":true}`——审批门对**人**收放，不是对表单 |

## 5 边界（照实写）

- **IdP 是替身**：MockCasdoor 走真实 HTTP 与真实 CasdoorClient/effectiveScopes 代码路径，但 IdP 本体不是生产 Casdoor；权限形状（org 分桶、platformOnly 供给）按真机实测形状种子。
- **LLM 是桩**：`generate_form_draft` 的确定性兜底分支是本件断言点（桩已刻意不给 dataPlane 走到它）；模型质量与真供应商行为不在 D4 范围。
- **stats 数值回包是字符串**（pg numeric/int8 语义），与 console（D3，PR #2764）消费同一 API 的既有渲染一致，未做二次转换。
- 单笔 `/stats` 实测延迟 3–6ms（本地库、两条提交量级）；缓存 TTL 用生产缺省 15s（dev-stack 未注入 `statsCacheTtlMs` 覆盖）。

## 6 判据回链

计划 Task D4 checklist 5 项（建表单发布 / 提交 3 条+两类聚合+缓存 / agent 同创 / 负对照 / 本记录）
与协调者 brief 的负对照清单（未声明字段、string sum、limit 超限、in 51、stats 未开、跨租户、
analytics 审批门）**逐项覆盖**，无跳项。
