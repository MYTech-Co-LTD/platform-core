# 体系地图：本体图（ontology）化 + 搬进控制台

> 2026-11-13 与用户定案。两个问题一起解：① 体系地图是独立 HTML 页（新标签打开、另一套样式、没有返回入口）⇒ 割裂；
> ② 现状是「表格 + 五个页签」，看不出实体/指标/源表之间的关系 ⇒ 不像知识图谱。

## 1. 现状（已实测）

- 入口：`apps/web/src/pages/console-menu.ts` 的 `MODULE_EXTERNAL_LINKS` → `/api/modules/data/system-map#/overview`，新标签打开。
- 实现：`modules/data/domain/system-map/map.ts`（1829 行）服务端拼 `SystemMapModel` 并渲染**单文件 HTML**；
  `modules/data/routes/system-map.ts` 只做装配 + 10 分钟进程内缓存。
- 数据已经够：`SystemMapModel` 里有 entities（业务对象 + 其指标）、metrics（含 `entity` / `trace.model` / `trace.upstream`）、
  sources（含 upstream）、dimensions（含 relation）、tables、reports、demands、invariants、health。

## 2. 目标形态（用户已选）

1. **本体图**：节点 = 业务对象 / 指标 / 源表 / 维度，边带类型；点节点看 observations（口径、来源、对账、使用量）。
   参考 memory MCP 的 `entities + relations` 形状：**类型化节点 + 类型化边**，不是自由力导向毛球。
2. **搬进控制台**：新页面 `/console/data/system-map`，复用宿主壳、左侧菜单、页头与 DESIGN.md token；
   菜单里去掉「体系地图 ↗」外链。

## 3. 设计

### 3.1 本体投影（服务端纯函数）

`modules/data/domain/system-map/ontology.ts`：

```ts
type OntologyNodeType = 'entity' | 'metric' | 'source' | 'dimension'
interface OntologyNode { id: string; type: OntologyNodeType; label: string; observations: string[] }
interface OntologyEdge { from: string; to: string; type: OntologyEdgeType }
```

- 节点 id 带类型前缀（`metric:<id>` / `entity:<name>` / `source:<name>` / `dimension:<name>`），避免同名撞车。
- 边（全部有向、全部**只在两端节点都存在时**产出，不留悬空边）：
  | 边 | 语义 | 来源 |
  |---|---|---|
  | `belongs_to` | 指标 → 业务对象 | `metric.entity` |
  | `derives_from` | 指标 → 源表 | `metric.trace.model` |
  | `upstream_of` | 源表 → 上游源表 | `source.upstream` 中能在 sources 里找到的项 |
  | `has_dimension` | 业务对象 → 维度 | 维度的 `relation` ∈ 对象的 `relations` |
- observations 是**给人读的短句**（每条一句）：口径、单位、来源层级、认证状态、近 30 天使用、对账文件、所需权限。

投影是纯函数，独立单测：节点去重、无悬空边、四类节点计数与 model 对得上。

### 3.2 API

`GET /api/modules/data/system-map/graph`，scope `data:query`（与 `/system-map` 同档），返回：

```json
{ "generatedAt": "...", "health": {...}, "ontology": { "nodes": [...], "edges": [...] }, "warnings": [...] }
```

- 与 `/system-map`（HTML）**共用**同一份 `loadSystemMapFacts` 结果与 10 分钟缓存键，不重复扫盘。
- 旧 HTML 页保留（移动端 `#/metrics` 深链与既有书签还在用）；本次只新增 JSON 面。
- `manifest.yaml` 的 `api.internal` 必须同一提交加声明（装载期双向核对）。

### 3.3 页面

`modules/data/console/system-map/index.tsx`（挂在 `console/index.tsx` 的末段分派里）：

- 页头：标题 + 一句说明（≤24 字）+ KPI 条（指标总数 / 实体绑定率 / 对账覆盖率 / 零使用指标，28px tabular）。
- 工具条：胶囊搜索（指标名 / id / 实体 / 源表）+ 图例（点图例按类型显隐）。
- 画布：ECharts `graph` + `layout: 'force'`，`focus: 'adjacency'`（悬停/点击只亮邻域），`roam: true`；
  节点按类型上色（业务对象 #4D6BFE / 指标 #0FA958 / 源表 #E08A00 / 维度 #8B5CF6），边灰色细线，tooltip 显示边类型。
- 点节点 → 右侧 Drawer：标题 + 类型 + observations（逐条）+「关联 N」；指标节点附「去指标页」按钮。
- 搜索非空时只保留命中节点 + 一跳邻居；清空恢复全图。
- 空态 / 加载失败走 `humanError()`，不静默。

### 3.4 菜单

- `modules/data/manifest.yaml` 加 `- { path: /console/data/system-map, title: 体系地图, description: ..., scope: data:query, entry: ./console/index.tsx }`。
- `apps/web/src/pages/console-menu.ts` 删掉 `MODULE_EXTERNAL_LINKS.data` 里的「体系地图 ↗」。
- 移动端不变（仍用 HTML 页）。

## 4. 不做（本轮）

- 报表 → 指标 的边：`SystemMapReportFact` 目前没带面板引用的指标，需要另取 report_versions.spec，留下轮。
- 真·图数据库 / 后端查询语言：本页是观测面，数据量 ~100 节点，前端布局足够。
- 旧 HTML 页下线：等移动端切到图谱 API 后再议。

## 5. 验收

- 单测：ontology 投影（去重/悬空/计数）、路由（鉴权/形状/缓存）、页面（KPI、搜索、点节点开抽屉）。
- 真机：山海实例打开 `/console/data/system-map`，节点数与 `SystemMapModel` 一致，点指标能看到口径与源表。

## 6. 追加（2026-11-14）：链路条 + 管线地图

两个新面（用户定案「b 和 c」）：

### B. 指标链路（体系地图节点抽屉）

`GET /system-map/metrics/:id/trail`（`data:query`）：

- 结构（纯函数 `domain/system-map/trail.ts`）：指标 → marts → staging → 湖前缀 → 管线；
  每一步标 `from: declared|inferred`——staging 来自 dbt 模型图上溯（声明），
  湖前缀来自 `stg_<domain>_<table>` ⇔ `<domain>/<table>` 命名约定（约定，且管线 lakeKeys 命中时才升为声明）。
- 运行态（路由层现查，不进 10 分钟图缓存）：链路管线的最近一次 run（`DATA_RUN_DIRS`）、
  物化钟与水位（仓库库 `data.load_log`）。三个都可能缺席——缺席一律显示「未知」并带 note，
  不显示成「正常/没跑过」。
- UI：指标节点抽屉里多一段「链路」，逐行 kind + label，推断步加「推断」标签。

### C. 管线地图（`/console/data/pipelines`）

`GET /system-map/pipelines`（`data:query`，60 秒缓存）：

- 三层 DAG：资产（湖前缀，来自管线 `snk.minio` key 前两段）→ staging（命名约定 + dbt 模型存在性）
  → marts（`ref('stg_…')` 反查）。
- 管线不占一列：挂在资产节点上（119 条管线挤一列必成毛球），点资产看清单
  （账套 / cron / 是否启用 / 最近一次 run 状态）。
- 账套过滤（全部 / 3120 / 64188 / 共享）+ 搜索（命中节点 + 一跳邻居）。
- 断点判定：`staging === null` 的资产、以及没有管线写对应湖前缀的 staging（`orphanStaging`），
  在 KPI 与告警里显式列出。

已知边界：湖前缀→staging 仍是命名约定（`sources.yml` 文件头写明「声明 ↔ 实际路径」没有机检）；
运行记录未挂载时 `runsWired=false`，前端一律标「运行记录未知」。
