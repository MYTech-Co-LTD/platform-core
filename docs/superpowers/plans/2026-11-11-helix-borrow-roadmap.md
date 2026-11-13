# 平台开发地图（v2）：全系统体检 + 波次

> **本文件是当前开发主线的唯一导航面。** 开工前先读 §3 台账；AMD 指标路线见图
> `2026-11-04-auto-metric-derivation-roadmap.md`（W0–W8 已完成/观察中），不在此。
>
> v1（2026-11-11 上午）只按 Helix 借鉴清单排期；v2 基于**全系统四路盘点**
> （数据面 / 应用权限 / 信任治理 / 运行观测）重排：**按「上线风险 × 不可逆性」排序**，
> Helix 清单只是输入之一。
>
> ✅ **2026-11-12：Wave 0–3 主线全部收口。** §1 列的四个「以为有其实没有」都已修（连接池上限、
> 缓存数据版本、数据范围绕过面、血缘/证据恒 unknown）。本文件转为**存量台账**：
> 新工作按 §5 规则先改这里再动手；剩余的只有 §3 待办表里的「触发式」与「观察项」。

---

## §1 定位

- 我们当前的主要矛盾不是「缺新能力」，而是**「以为有的东西其实没有 / 有了但不安全」**：
  血缘生产恒 unknown、evidence 三字段写死 unknown、数据范围有绕过面、连接池无上限、缓存可能返回旧数。
- 所以 v2 的优先级：**先让系统「说的和做的一致」，再谈新能力。**

---

## §2 系统实况（2026-11-11 盘点，证据为文件:行号）

| 层 | 规模 | 关键事实 |
|---|---|---|
| 应用 | 5 模块 / 43 宿主路由 / 148 模块路由 / 20 权限码 | 「声明即授权」fail-closed 扎实；**路由集合双向核对只在启动时**（`loader.ts:289-333`），CI 不查 |
| 权限 | 部门门 + 数据范围 RBAC | 部门门只覆盖报表资产（`asset-auth.ts`）；`DATA_SCOPE_MODE` 默认 off（`scope.ts:39-45`）；**detail/explore 不裁**（`drill.ts:185-186`） |
| 数据面 | 62 模型（table18/inc18/view26）、131 测试、118 管线、66 排班、56 指标 | 仅 16 certified；12/26 staging 无键唯一测试；6/31 marts 无测试；forms 域 0 测试 0 指标 |
| 契约 | 27 份（24×v1） | `consumerVersion` CI 有；**元 schema 无人校验**；README 与门禁漂移 |
| 信任 | provenance/evidence/verified/candidates | detail provenance 可用；query_metric 无 provenance；explore/recipe 无 auditId；evidence 的 dataAsOf/freshness/reconcile **写死 unknown**（`recipes.ts:130-138`） |
| 血缘 | get_lineage / get_quality | **生产恒 unknown**：`DATA_DBT_MANIFEST_PATH` 未设、容器未挂载（实测） |
| 运行 | 3 池 / 18 探针 / 13 规则 | **池无 max**（默认 10 × 1.5GB vs 4g）；审计无 latency/path/cache；advisory 不翻 rc；桥 12h 冷却 |

---

## §3 台账（每完成一项更新：状态 / 证据 / PR / 实测）

### 已完成（含证据，别重做）

| 项 | 证据 |
|---|---|
| 明细执行层：封版 manifest / 监控 ⑯⑰ / 月文件 / 月感知视图 / 历史视图 / 结果缓存 | 30 天明细 7.8s→0.7s（热），重复查询 <10ms；两实例已上线 |
| 行级证据链 S0–S3（detail/explore/recipe provenance、detailAvailable、锚点语义、共享类型） | `provenance.ts`、`drill.ts`、`toolbox/*` |
| 数据范围 RBAC 表/端点/UI/预检 | `042/043` 迁移、`routes/scopes.ts`、`scripts/scope-preflight.mjs` |
| Helix 借鉴线 v1 地图 | PR #1949 |
| **Wave 0.1 资源准入** | PR #1952：`warehousePoolConfig`（max 默认 3）+ `detail-gate`（2 名额/15s）+ 6 env + 8 单测 |
| **Wave 0.2 缓存正确性** | PR #1956：缓存键含数据版本（封版水位 + 月文件构建时刻，5s 进程缓存）；`TTL=0` 真关闭 |
| **Wave 0.3 权限收口** | PR #1958：明细接 `scopePlan`（audit 写 scope_plan/denial）；explore enforce 下仅管理员放行 |
| **Wave 0.4 告警有效性** | PR #1961：桥 v5 `PROBE_NO_COOLDOWN=sealed_manifest`（冷却已存在时仍推送，反向测试 `probes=1`）；正典 OO 口径订正为 14 ALERT/13 enabled |
| **Wave 1.1 manifest 投递** | 生产 server 服务加 `/opt/platform-core-data/platform-core/dbt/target:/app/dbt-target:ro` + `DATA_DBT_MANIFEST_PATH`；部署 `dep_ejqOe_l_7Z-Sc6rc`（v267）容器内实测：nodes 427 / child_map 454 / schema v12，`dependsOnOf('fct_retail_sale')=['stg_lemeng_retail_order_line']`、`testCountOf('vw_lemeng_retail_order_line')=6` ⇒ lineage/quality 不再 `dbt_manifest_unavailable` |
| **Wave 1.2 证据真值** | PR #1967：`dataAsOf`/`freshness` 走 `freshnessFaceFor`（与问数面同一判据）；`reconcile` 读物化 job 的 `run_results.json`（mtime 缓存），状态扩 `ok|failed|missing|unknown`——「没跑」≠「通过」。**已知边界**：`run_results.json` 只记**最近一次 dbt 调用**；小时级增量跑只覆盖少数模型（实测 14:25 一轮 9 节点 / 0 条对账测试 ⇒ `unknown`，13:42 全量一轮 103 条测试 ⇒ 有结论）。`executedAt` 如实给出那次调用时刻，读侧据此判断新鲜度 |
| **Wave 1.3 来源补齐** | PR #1967：`query_metric.provenance`（source=metric/relation/executedAt/auditId）+ `callTool` 单点回填 `auditId`（不新建、不覆盖） |
| **Wave 1.4 回归/候选接线** | PR #1971：`GET /metrics/candidates`（status/origin/relation/limit）+ `POST :id/reject`（CAS 只认 pending，其余 409）；`scripts/metric-candidates-job.mjs`（画像表驱动 org 清单，rc 0/1/2，域名层 `orgsWithProfiles`）；`deploy/metric-candidates-job.md` + `deploy/verify-regression-job.md` 入仓。实测：部署 `dep_WLs9IiueWMqmI9d6`（v268）后建 job `custom:tB6ulrsKtgW852WL`（cron `40 6 * * *` UTC），手动首跑 `jrun_x0nb662U3mApMrID` exit 0 / 1.96s：`orgs=1 failed=0 added=104 refreshed=167 expired=111 pendingAfter=269`（退役路径确实在跑；池级上限 21×20 成立）；新端点未鉴权访问返回 401（路由已注册、门卫生效）。数据模块服务端 1499 passed |
| **Wave 2.2a skill contract 版本门** | PR #1974：`SUPPORTED_CONTRACT_VERSION` + `contractViolations()`，装载期不一致 ⇒ 抛错 ⇒ 模块装载失败；**变异确认**：version 改 2 ⇒ `check-mcp-toolface` exit 1 并指名该常量 |
| **Wave 2.2b 契约跨字段六条** | PR #1976：`check-data-contract.mjs` 新增 `crossFieldViolations()`（README §4.2 ①–⑥）；`readContractDoc()` 补 `partitionBy`/`markerColumn`；例外收敛成显式表 `PARTITION_KEY_ALIASES`（recon_source 的 chunk↔chunk_no）；实测 30 份契约里 recon_source 是唯一命中，经别名判过；门禁单测 29 条 |
| **Wave 2.3 通知链补通** | PR #1980：forms 两个事件此前**只有声明**（模板/规则/默认都没有，dispatch 恒 `no_rules`）；现补两条内置文案 + 两条 derived 规则（`recipient_key=assignee`）+ manifest `defaults`；新增 `templates/builtin.test.ts` 静态护栏（声明⇔模板双向一致）；OO org 显示名文档订正（miyuan→mytech）。**生产实测**：mytech 的 seed job（`custom:NWK_D7nKpsC7hdhe`）自动跑出 `templates=2 rules=5` 并查到两条 `derived:forms:*` 规则；**shanhai 手动 seed 后**同样补齐（`templates=3`：此前连 `data.metric.definition.changed` 的文案都没有）。⚠️ 发现的新缺口：**notify 四个作业只挂 mytech（serverId 23a1091e）**，shanhai 无 seed/reconcile/health/retention —— 已入待办 |
| **Wave 3 卫生（第一批）** | PR #1984：history view 双 config/错头注清理；`materialize.sh` 档位白名单（未知档 exit 2，此前会静默落全史物化）；明细四处池调用改 `analystPool()`（只读）；`data-plane-manifest.txt` 登记「刻意不投递」脚本。验证：1499 tests / materialize.test.sh 104 项 / gates 全绿；数据面 sync 到 `38cdb1d`：`SYNC_OK 429/429`（revision 已推进；`outside-scope 1136` 是清单头部登记过的已知边界） |
| **通知健康判据（2.3 残项①）** | PR #1987：`dead` 从全表改成 **7 天时间窗**（`DEAD_WINDOW_DAYS`）。dead 是终态、不会自愈，全表计数会让一条历史失败永久按红（shanghai 10-31 的 4 条就是这样）。单测钉住窗口语义（窗口外不变 / 窗口内 +1）；**不加 retention**（删行需点名） |
| **Wave 2.1 第一批（marts）** | PR #1989：仅存的 2 个零测试 marts（`recon_fact` 账套×日×门店、`fct_transfer_zero_cost_item` 账套×日×商品）补粒度唯一断言。staging 那 14 个**不批量补**：read_parquet 视图全表扫要整片湖（分析池实测超时），猜错一条 = 每晚 tables 档变红 |
| **候选池 console 页** | PR #1991：新页签「候选池」（data:manage）——列表/过滤/采用（弹窗填指标 id）/拒绝；判定全委托服务端；`index.test.tsx` 补「普通用户不可见 + 管理员深链请求 /metrics/candidates」 |
| **契约元 schema 校验器（2.2 残项）** | PR #1993：`scripts/lib/json-schema-lite.mjs`（零依赖，只实现元 schema 用到的关键字子集，**不认识的关键字抛错**）接进 `check-data-contract`。第一轮抓出 **190 处漂移**（154 `decimal(p,s)` 当 type、29 非枚举拼写、1 个 `contractVersion:1`）并归一；投射与 lock 重生成；README §4.3/§5 改为「已在 CI 跑」 |
| **Wave 2.1 第二批（staging）** | PR #1996：13 个 staging 补粒度唯一断言，**每个先在生产取证**（`count(*)` vs `count(distinct 键)`，2026-11-01..11-12 窗口；13/13 n=d）。取证还证伪了两个「看起来该进键」的列：`loss_adjustment.direction`、`inventory_movement.item_num`（加进去不改变唯一性）。`stg_forms_submission` 留空：本实例未物化 forms 域，无法取证 |
| **Wave 2.1 第三批（列级非空面）** | PR #1999：契约 `nullable=false` ⇔ `schema.yml` 的 `not_null` 绑成门禁；补 36 个漏配（11 个已登记模型，5 列连列条目都补上）。补前先在生产取证：11 模型 × 窗口 `count(*) filter (where col is null)` 全 0。14 个整体未登记的 staging 模型**跳过而不假装覆盖** |
| **Wave 2.1 第四批（schema.yml 全覆盖）** | PR #2002：16 个此前**整体未登记**的 staging 模型补 schema.yml，89 列 not_null（只写契约 nullable=false 的列，不复制契约描述）；补前逐模型生产取证 16 模型 89 列全 0。非空面门禁现在覆盖**全部 28 个** staging 模型，`missing: []` |
| **cron 文档逐条核对** | PR #2004：按控制面导出 + `schedules/*.json` 核对，纠四处漂移——`lemeng-dbt-materialize` 文档当现役其实 **2026-11-07 已停用**（OOM），现役是 tick/hourly/tables/audit×2 分档；notify-reconcile 补实际 `7 * * * *`；维度面排班与 item_price 分钟按排班文件订正 |
| **stg_forms_submission 粒度断言** | PR #2007：取证渠道补上——mytech 数据面（project `platform-core-data` 的 pg_duckdb）有该域，实测 `count(*) = count(distinct (org, submission_id)) = 1`（样本 1 行，头注如实记录；shanhai 无该域）。至此 **14/14** 个此前无测试的 staging 都有粒度断言 |
| **产品面 4.1（站内问数退役）** | PR #2013：console 问数页 + 移动 AskView 删除；默认页签改 metrics；manifest 模块名「数据问数」→「数据」、权限显示名→「数据查询」（码不变）；`/chat` 保留并加注无一等消费方；architecture §2 同步 |
| **产品面 4.2（单页双层基件 + 候选池改造）** | PR #2011：`<TechDetails>` + `lib/explain.ts`（表外码回落但原码必留）；候选池默认层改人话、采用预填名称/标识、细节收进展开层；explain 单测 5 条 |
| **产品面 4.3（指标页 / 报表页接双层）** | PR #2022：指标页新增「口径」列（默认层业务说法 → 展开层表达式/维度/权限码/版本/覆盖来源/原始 SQL，既有工程列保留）；报表页每行「这个数怎么来的」抽屉（用到的指标 / 时间范围人话 / 谁看得到 + published-spec 原文折叠）；共享名单读不到时如实说「仅所有者或管理员能查」 |
| **产品面 4.4（术语词典）** | PR #2025：`lib/explain.ts` 增 `TERMS`（口径/已认证/覆盖/置信度/谁看得到/部门门/数据截至/所需权限）+ `<Explain term>` 问号组件（未登记 term 不渲染）；接指标页/候选池/报表三处。单测钉「解释里不出现工程词」|
| **产品面 4.5（指标创建收口）** | PR #2030：删人工「新建」入口——PC「新建派生指标 / 新建声明（全额口径）」、移动端「新建指标（表达式）」；页面改为指向 agent（企微 / MCP）。**保留**源码 API/MCP 写面与应用内编辑（既有 L2 恒 PUT）；决策面全留（草稿确认 / 元数据 / 认证 / 覆盖口径 / 候选采用）。用户定档「删实现面、留决策面」。测试先红后绿：PC 编辑 body 仍无自由 SQL 字段、移动端 admin 也无新建入口；`modules/data` 1687 / scripts guard 911 / 全仓 typecheck 绿 |
| **OO 机 `/opt` 副本核对** | 2026-11-12 实测：`/opt/lemeng-oo-{notify-bridge,watchdog,config-audit}.sh` + `lemeng-emit-probe.py` 四个 sha256 与仓内**逐字节一致**（bridge `7a81135e…` / watchdog `bc36151a…` / audit `98074d99…` / probe `465fee98…`），当前无漂移、无需投递；SOP §E.5 的手工投递形态与版本握手仍然有效 |
| **retention 处置（证据化关闭）** | 2026-11-12 实测 shanhai `notify` 表极小（inbox 4 / delivery 10 / event 6 / attempt 20），且 health 已改 7 天窗口（PR #1987）⇒ **当前不需要**。留作观察项：任一表破 10 万行或 health 因积压变红时再议（届时删行需点名） |
| **Wave 5 P0（变更单 + 试算硬门）** | PR #2046（squash `0c415f84`，issue #2038，15 提交逐任务评审+终审+修复波）：`data.metric_change`（迁移 046，同指标仅一张未决单）+ 状态机（supersede/withdraw）+ 试算（compileL2 编译不生效 → 只读池 → 快照含 baseline Δ；**未试算不可采纳**）+ 7 端点（**采纳/驳回只认会话**，PAT/企微 ⇒ 403 `DECISION_REQUIRES_SESSION`，结构性反自审经终审确认）+ MCP `submit_metric_change`（提交即试算）/`list_metric_changes`（含驳回原因；无采纳工具）+ console「待核对」页（人话默认层 + TechDetails；采纳/驳回/跑试算）。验证：本地全仓测试+guard 927+typecheck+双门禁绿，modules/data 1720 用例；CI 全绿；部署 `dep_guN95NvCpBmRJAnb`（v289）容器实测：046 在位、生产库表+三索引+14 列+2 check、未鉴权 401、产物含「待核对」。终审缓办 6 条见待办表 |
| **Wave 5 P1（概念归属 + 缓办销账 + override 档）** | PR #2058（squash `f27240d7`，issue #2049）：迁移 047（owner_dept/visible_depts/variant_note/reveal `not null default 'panel'` + `metrics_title_per_dept_uq`（生产同名冲突组=0 取证后直建）+ `metric_concept` 表 + `preview_history`）；概念校验与同名判据（与索引逐字同构）；变更单带归属（UNKNOWN_CONCEPT/TITLE_EXISTS_IN_DEPT/METRIC_ID_EXISTS）；**P0 缓办 6 条全销**（快照历史 FIFO5/撞 id 拒收/delete 通知+采纳前快照/meta 三键全缺/**toolface 门禁真测合并 20 面纯文件单源**/决策 advisory lock+applyPreview 钉态+23505→409）；override 档端到端（复用 createOverrideDeclaration 零复制；同名判据桶恒 null 与落库同构）；读面归属进 TechDetails（默认层零新词机检）。验证：全仓测试+guard+typecheck+双门禁绿（modules/data 1763）；CI 全绿（rebase 适配 #2050-2057 指标页返工）；部署 `dep_D7iKOIq7e6X0KozD`（v293）容器实测：047 在位、title_uq/概念表/preview_history 在、reveal 57 行全 panel、产物含「归属部门」、未鉴权 401。⚠️ 部署遇平台取消 worker 挂死互斥（用户授权 SSH 重启 openship-api-1 解锁，留档 openship-platform PR #34） |
| **Wave 5 P2（指标可见性）** | PR #2062（squash `f9a3f1b7`，issue #2061）：组织树一致性检查（五判据+脚本；**生产取证 errors=0**：1 租户/280 节点/522 挂载/13 空分支告警——前置门过）；部门上下文（CTE 单往返 直属∪祖先∪后代）+ 纯谓词（fail-closed；显式共享只认直属；''→null 单点归一）；`visibleMetrics` 扩可选参（缺省 fail-closed，双回归锁）；**13/13 调用点接线**（集中式 `deptContextIfOwned` 懒守卫；含词表/list_metrics/custom 分支）；visible_depts 读侧零投影。验证：全仓测试+guard+typecheck+双门禁绿（modules/data 1810+）；终审（opus）**merge-ready 零 MUST-FIX**（跨面接缝全走通：fail-closed×懒守卫三态、无绕过、性能零增）；修复波 3/3 复核 clean。部署 `dep_0NzD63UvVngmEJbT`（v294）容器实测：新代码在位、**owned/total=0/57（零变化证明）**、/query 与 /metrics 401 正常、healthz 200。部门可见性自第一条归属指标出现时自动生效 |

### 待办（Wave 见 §4）

| 项 | 现状证据 | 波次 |
|---|---|---|
| **P1 终审缓办（转 P2+）** | ① L1 label 撞名预检进 check-semantics（今天零冲突；sync catch 已带 pg detail）② 旧直写面（PUT/POST /metrics、override 直写、customize_metric——P4 退役）撞 title 索引=裸 500 无映射 ③ override 行 owner_dept 恒 null：接进 insertTenantDeclaration 归 P2 可见性波 ④ report 工具 mutating:false 不对称（若总闸应管报表提案需裁决）⑤ notify eventId 去重吞重建事件（修法：eventId 拼变更单 id）⑥ preview_failed 回包不带 issues 明细 | Wave 5 P2（接手逐条销） |
| **P3 解析与澄清** | `search_catalog` 无 tie 检测（`toolbox/discovery.ts:77-91`）；信封无 dept/variantNote | **Wave 5 P3（计划：`2026-11-13-metric-ambiguity-p3.md`，4 任务）** |
| **P4 写面收口** | `customize_metric` 仍直接写生效行（`mcp-metric-tools.ts:80`）；PC 指标页仍有编辑/元数据/覆盖/删除 | Wave 5 P4 |
| **P5 报表 × 指标** | 发布无「受众 ⊆ 面板指标可见范围」校验；Metabase 只能整表级 | Wave 5 P5 |
| **P6 证据与治理** | 声明类无对账证据接入；下线候选已有面（/metrics/usage）未接评审 | Wave 5 P6 |
| 列级血缘 | dbt core manifest 无列级边（dbt core 不产出列级 edge） | 2.4（**触发式**：等真的有「按列追影响」的需求再做） |


| retention（可选） | 当前各表极小、health 已按 7 天窗口判；破 10 万行或积压变红时再议（删行需点名） | 观察项（无动作） |

> **Wave 0–3 主线已全部收口（2026-11-12）**：待办表只剩一个「触发式」与一个「观察项」。

---

## §4 波次（按「上线风险 × 不可逆性」）

### Wave 0 · 上线前（必须）
- **0.1 资源与准入**：`pool.max` 按内存预算 + 明细并发闸/排队 + 超时可配；验收：3 并发明细 0 reset。
- **0.2 缓存正确性**：键含数据版本（`max(sealed_at)` + `month.built_at`）；`TTL=0` 真关闭；审计记 `cached`。
- **0.3 权限收口**：detail/explore 接 `scopePlan`；做不到就明确「enforce 只覆盖聚合」并在 UI/契约标注。
- **0.4 告警有效性**：⑯ 升 hard 或独立规则；取消 ⑯ 的 12h 冷却；OO registry 与文档对齐。

### Wave 1 · 信任链补真（不补就是「看起来有」）
- **1.1 manifest 投递** → lineage/quality/query_metric.lineage 可用。
- **1.2 evidence 真值**（接不上就删字段，不留假证据）。
- **1.3 provenance 补齐**（query_metric + auditId）。
- **1.4 回归/候选接线**（job 入仓、候选 list/reject、生成调度）。

### Wave 2 · 质量与治理
- 2.1 测试补齐；2.2 契约元 schema + 版本门 + 文档漂移；2.3 OO/forms 事件；2.4 列级血缘（触发式）。

### Wave 3 · 工程卫生
- history view 双 config、materialize 档位校验、cron 文档、lock 覆盖、detail 只读池。

### Wave 5 · 指标语义治理（2026-11-12 定案，**现行主线**）

> spec（唯一事实源）：`docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md`。
> 三条拍板：① agent 只提案、人只采纳（**未试算不可采纳**，决策端点只认会话）；
> ② 同名不同义 = 不同 id + 部门内同名互斥 + 歧义必须澄清；③ 指标接入权限体系
> （归属部门决定可见范围，**按 id 查询也拦**）。

- **P0 变更单 + 试算硬门**：✅ 已落地（PR #2046，部署 v289 实测）——`data.metric_change` + 提交即试算（快照含参照值 Δ）+
  采纳/驳回（会话限定）+ MCP `submit_metric_change` / `list_metric_changes` + console「待核对」页。
  P0 的 kind 范围：`create | update | meta | delete`（override/declared 档随 P1 接入）；终审缓办 6 条在待办表。
- **P1 概念与归属**：✅ 已落地（PR #2058，部署 v293 实测）——归属四列+同名唯一索引+概念表+变更单带归属；P0 缓办 6 条全销；override 档接入；toolface 门禁测合并面
- **P2 指标可见性**：✅ 已落地（PR #2062，部署 v294 实测）——组织树检查（前置门过）+ 部门上下文/纯谓词 + visibleMetrics 扩参（唯一咽喉，13/13 点接线，fail-closed 缺省）；reveal 消费归 P5 渲染闸
- **P3 解析与澄清**：`search_catalog` tie 检测 + 答案 `caliber` 标注。
- **P4 写面收口**：`customize_metric` 改为落变更单；人面写入口全删（含回滚开关 `DATA_METRIC_REVIEW_MODE` 退役旧路径）。
- **P5 报表 × 指标**：发布门 + 渲染闸 + 每日一致性巡检（Metabase 整表级）。
- **P6 证据与治理**：声明类对账证据接入采纳 + 使用统计→下线候选。

### Wave 4 · 产品面：单页双层（2026-11-12 定案）

> **两条约束（用户拍板，别再讨论）**：① **本系统不做问数**——问数只经 MCP 给 openclaw 与三方 agent；
> ② **不做按角色的多页面**——同一页两层：默认层人话、展开层全量细节。

- **4.1 站内问数退役**：console 问数页 + 移动 AskView 删除；`POST /chat` 保留但注明无一等消费方。
- **4.2 双层基件**：`<TechDetails>`（只折叠不隐藏）+ `lib/explain.ts`（错误码→人话，原码必留）；
  候选池改成「可能的指标」——默认层一句人话 + 「加进我的指标 / 不要」，细节进展开层。
- **4.3 指标页 / 报表页接双层**：✅ 已落地（PR #2022）——指标页「口径」列 + 报表页「这个数怎么来的」抽屉。
- **4.4 术语词典**：✅ 已落地（PR #2025）——`TERMS` + `<Explain term>`，新增页面只准用 `TechDetails` / `Explain` 这两个组件写专业信息。
- **4.5 指标创建收口**：✅ 已落地（PR #2030）——**实现面交给 agent，人只做决策**：删 PC「新建派生指标 / 新建声明」与移动端「新建指标（表达式）」；API/MCP 写面不动，草稿确认 / 元数据 / 认证 / 覆盖口径 / 候选采用全部保留。三档选项与取舍见 §7 当日行。

---

## §5 防漂移规则

1. 开工前读 §3；台账说已完成的，回去看证据再决定要不要动。
2. 完成一项才更新台账（状态/证据/PR/实测）；**没证据不翻绿**。
3. 新想法进 §6 候选池；插队必须改本文件并说明理由。
4. 排序规则：**上线风险 × 不可逆性**，不按任何参考产品的清单顺序。
5. 不做：图数据库当主存储、LLM ontology 替代指标层、拆 8 服务、为多版本给每条明细打 load id、单写者模型。

---

## §6 候选池

- （空）

---

## §7 变更记录（append-only）

| 日期 | 变更 | 理由 |
|---|---|---|
| 2026-11-11 | v1：Helix 借鉴线地图（六项 P0/P1/P2） | 回顾 2026-11-06 方案 |
| 2026-11-11 | **v2：改为全系统开发地图**，Wave 0 新增资源准入/缓存正确性/权限收口/告警有效性；Helix 六项映射进 Wave 1–2 | 四路盘点发现「以为有其实没有 / 有了但不安全」，按上线风险重排 |
| 2026-11-11 | Wave 1.1/1.2/1.3 完成入账；待办表清掉 0.2 残留行 | 证据：PR #1967 + 部署 `dep_ejqOe_l_7Z-Sc6rc` 容器内实测（见 §3） |
| 2026-11-11 | Wave 1.4 完成入账（含 job 首跑）；新增候选池 console 页缺口行 | 证据：PR #1971 + 部署 `dep_WLs9IiueWMqmI9d6` + job `custom:tB6ulrsKtgW852WL` 首跑 exit 0（见 §3） |
| 2026-11-11 | Wave 2.2a/2.2b 完成入账；2.2 残项收敛为「元 schema 本体未执行」 | 证据：PR #1974（变异确认 exit 1）+ PR #1976（30 份契约实跑，29 条门禁单测） |
| 2026-11-11 | Wave 2.3 完成入账 | 证据：PR #1980 + 服务端 notify 120 passed + seed 规则 4→6 / 模板 3→5 落库断言 |
| 2026-11-12 | Wave 3 第一批入账（4 项）；余项收敛为 cron 文档核对与多机副本手工投递 | 证据：PR #1984 + 1499 tests + materialize.test.sh 104 项 |
| 2026-11-12 | 四个残项收口：health 时间窗、marts 断言、候选池页、元 schema 校验器 | PR #1987 / #1989 / #1991 / #1993；元 schema 一轮抓出 190 处漂移并归一 |
| 2026-11-12 | Wave 2.1 第二批：13 个 staging 粒度断言（逐个取证后落地） | PR #1996；13/13 n=d，样本 3–191,679 行 |
| 2026-11-12 | Wave 2.1 第三批：契约 nullable=false ⇔ not_null 门禁 + 补 36 列 | PR #1999；补前生产取证全 0 |
| 2026-11-12 | Wave 2.1 第四批：16 个 staging 补 schema.yml（89 列），非空面覆盖 28/28 | PR #2002；16 模型 89 列取证全 0 |
| 2026-11-12 | cron 文档逐条核对完成 | PR #2004；四处漂移（含停用作业被当现役） |
| 2026-11-12 | **Wave 0–3 主线全部收口**；最后三项（forms 断言 / OO 副本核对 / retention 证据化关闭）入账 | PR #2007 + 控制面实测（OO 四脚本 sha256 一致；notify 表 4/10/6/20 行） |
| 2026-11-12 | **新增 Wave 4：产品面单页双层**；4.1/4.2 已完成，4.3/4.4 待办 | 用户定案：不做问数（只走 MCP）、不做多页面（同页两层）；PR #2011 / #2013 |
| 2026-11-12 | Wave 4.3 完成入账（指标页口径列 + 报表来源抽屉） | PR #2022；只余 4.4 术语词典 |
| 2026-11-12 | **Wave 4 全部完成**（4.4 术语词典） | PR #2025；产品面四批 4.1–4.4 均已上线 |
| 2026-11-12 | **新增 4.5 指标创建收口**：删人工新建入口，实现面交给 agent | 用户拍板「删实现面、留决策面」（三档选项见 issue #2029）：删 PC 两个新建按钮与移动端表达式新建；API/MCP 写面与决策动作全留。PR #2030 |
| 2026-11-12 | 新增候选：**指标语义治理**（P0–P6，含试算硬门/变更单/部门归属/同名解析/报表交集） | 用户定案三点（agent 只提案、人只采纳；同名必须可区分；指标接入部门权限）；spec 已出，待拆实施计划 |
| 2026-11-12 | **候选池升格为 Wave 5（现行主线）**；待办表按 P0–P6 重排 | 用户认可 spec（含部门链=自身∪祖先∪后代、认证并入采纳两处代决）；P0 计划另出 |
| 2026-11-12 | **Wave 5 P0 完成入账**（变更单+试算硬门+采纳驳回+会话闸+MCP 工具+待核对页） | PR #2046 + 部署 v289 容器实测；终审缓办 6 条转 P1 接手清单 |
| 2026-11-12 | P1 计划出台（概念归属+同名互斥+缓办销账+override 档，8 任务） | 生产取证：同名冲突组 0、镜像内 semantics YAML 在；计划 `2026-11-12-metric-ownership-p1.md` |
| 2026-11-13 | **Wave 5 P1 完成入账**（概念归属+同名互斥+缓办 6 条全销+override 档）；P1 终审缓办（L1 label 预检/旧直写面 500 边界/report 工具 mutating 不对称等）按裁决入 P2+ | PR #2058 + 部署 v293 容器实测；openship 取消 worker 挂死事故留档 openship-platform #34 |
| 2026-11-13 | P2 计划出台（部门上下文+纯谓词+咽喉扩参+六面接线；组织树检查为前置门） | 取证：visibleMetrics 唯一咽喉、现网 57 行 owner_dept 全空 ⇒ 上线零行为变化 | 支 PR 见下 |
| 2026-11-13 | **Wave 5 P2 完成入账**（指标可见性：前置门+纯谓词+咽喉扩参+13 点接线）；P2 终审缓办按裁决转 P3+ | PR #2062 + 部署 v294 容器实测（owned=0/57 零变化证明） |
| 2026-11-13 | P3 计划出台（tie 检测+caliber 补全+第 5 条硬约束） | 取证：scoreOf 有序无名检测；envelope metric 段已在；shared.md 恰 4 行有行数断言；预算余量 192B 禁加描述 | 支 PR 见下 |
