# W5 治理可回溯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 对应路线图 §3 的 **W5**（终态 G7）：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`。
> 开工前重读路线图 §1（G7）、§3（W5 出口判据）、§5（W4 已完成的证据），并**用命令核实**。

**Goal:** 把「这套体系到底靠不靠得住」变成四个可查的数 + 一张业务人员能自己走通的地图；桌面与手机都能用。

**Architecture:** 一个受权限保护的**体系地图页面**（服务端渲染单文件 HTML，`data:query`），同一份数据源同时喂「健康面板」与「指标/实体/数据源/需求」四视图；桌面侧边栏 + 图谱，手机底部标签 + 步骤条。事实源 = 仓内声明（`l1_metrics.yml` / `dimensions.yml` / `invariants.yml` / `contracts/` / `dbt/models`）+ 运行库（`data.metrics` / `reports` / `query_audit` / `demand_signals` / `metric_audit`）。

**Tech Stack:** Hono 路由 + 纯函数渲染器；原生 CSS/JS（零 CDN、零新依赖）；`antd-mobile` **不引入**（页面是独立 HTML，不塞进 React 壳）。

## Global Constraints

- **只读**：页面零写操作；`GET` 一个路由，scope `data:query`；在 `modules/data/manifest.yaml` 声明（声明即授权 + 装载期双向核对）。
- **事实源单一定义**：所有数字来自仓内声明或运行库查询，**页面不存快照**、不做第二事实源。
- **XSS**：所有来自库/文件的文本渲染前转义（definition / report 名 / target 都可能含 `<script>`）。
- **性能**：单次生成 < 2s；进程内缓存 10 分钟（简单 Map + 时间戳）。HTML 体积 ≤ 400KB（内联数据），移动端首屏 < 2s（模拟 3G）。
- **移动端**：375×667 起可用；**不做图谱**（力导向在手机上不可用），改为可折叠**步骤条**回溯；点击目标 ≥44px；无横向滚动。
- **孤儿归零**：指标无 entity = 0（W4 已达成，需页面持续暴露）；**表无 owner** 要新增到契约/声明并暴露。
- **候选质量闸**：只在**报告**层面统计垃圾候选占比，**不自动删**（删除是人的决定）。

---

### Task 1: 健康指标数据层（纯函数）

**Files:**
- Create: `modules/data/domain/system-map/health.ts`
- Test: `modules/data/domain/system-map/health.test.ts`

**Interfaces:**
- `healthOf(input) → HealthSummary`，`input` 由路由装配：
```ts
interface HealthInput {
  metrics: { id: string; certified: string; entity: string | null; basis: string }[]
  auditTests: string[]                    // dbt/tests/** 文件名
  usage: Record<string, number>           // 近 30 天 query_audit 次数
  demands: { kind: string; dismissedAt: string | null }[]
  incidents: number                       // 近 90 天口径事故（data.metric_audit 里 reason 计数）
}
```
- `HealthSummary`：`metricTotal` / `entityBound` / `entityBoundPct` / `auditCovered` / `auditCoveredPct` / `zeroUse` / `openDemands` / `incidents`。

- [ ] **Step 1: 写失败测试**（3 个用例：全齐、缺 audit 测试、零使用边界）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 `healthOf`**（纯函数；对账测试匹配用 `metricToAuditFileName`）
- [ ] **Step 4: 测试通过 + `tsc --noEmit`**
- [ ] **Step 5: 提交**

---

### Task 2: 体系地图渲染器（桌面）

**Files:**
- Create: `modules/data/domain/system-map/render.ts`（HTML 生成，纯函数）
- Create: `modules/data/domain/system-map/model.ts`（把声明/契约/模型/运行库拼成视图模型）
- Test: `model.test.ts` / `render.test.ts`

**要点：**
- 视图模型：`metrics[]`（含 entity/关系/同义词/口径/对账测试/用量）、`entities[]`（含权威源/绑定指标）、`relations[]`（含上游 ref）、`demands[]`、`health`。
- 渲染：单文件 HTML，内联 JSON + 原生 JS；桌面布局 **左侧栏 + 主区**；四个视图切换用 hash 路由（`#/overview` / `#/metrics` / `#/entities` / `#/sources` / `#/demands`）。
- **回溯**：指标详情里一条「口径 → 实体 → 关系 → 上游模型 → 契约」的**可点击链**，每跳高亮。
- 图谱：桌面用**简单 SVG**（非力导向）：实体—指标二部图，节点数 ≤ 80 时渲染；超过则只给列表（防卡）。

- [ ] **Step 1-6**：测试先行（转义 / 视图模型 / hash 路由存在）→ 实现 → 仓库真实数据生成一次 → 人工看一遍 → 提交

---

### Task 3: 移动端适配（独立任务，不并入 Task 2）

**Files:**
- Modify: `render.ts`（响应式 CSS + 移动态 DOM 结构）
- Test: `render.test.ts`（断言移动端导航与步骤条存在）

**设计（按断点，不按设备猜）**：

| 断点 | 布局 |
|---|---|
| `≥1024px` 桌面 | 左侧栏（五视图）+ 主区；指标表格式列表；实体—指标 SVG 图 |
| `768–1023px` 平板 | 顶部横向标签 + 主区；图保留但缩到 60% 宽 |
| `<768px` 手机 | **底部固定标签栏**（总览/指标/实体/需求）+ 卡片列表 + 全屏详情页；**不渲染 SVG 图** |

**手机端四条硬设计：**
1. **底部标签栏**（`position: sticky; bottom: 0` + `env(safe-area-inset-bottom)`），4 个入口，图标+中文短标；
2. **搜索置顶吸顶**，全宽输入框，输入即过滤（前端过滤，无需请求）；
3. **回溯用步骤条**：`指标 → 实体 → 关系 → 上游模型 → 契约` 五步竖排，每步可展开；**不画连线**（手机上连线不可读）；
4. **详情全屏 + 返回**：点任一卡片推入全屏详情（`history.pushState`），返回键/手势回到列表；深链 `#/metrics/<id>` 可分享。

**移动端验收（写进测试或人工走查清单）：**
- 375×667 无横向滚动（`document.scrollingElement.scrollWidth <= innerWidth`）；
- 所有可点元素 ≥44×44；
- 首屏 HTML（含内联数据）≤400KB，模拟 3G 首屏 <2s；
- 五个视图均可进入、可返回；深链刷新后仍落在同一详情。

- [ ] **Step 1: CSS 断点与移动 DOM 骨架**（先写，断言测试）
- [ ] **Step 2: 底部标签 + 吸顶搜索 + 卡片列表**
- [ ] **Step 3: 步骤条回溯 + 全屏详情 + 深链**
- [ ] **Step 4: 体积/无横向滚动断言（jsdom 可断言 class 与结构；真机走查另记）**
- [ ] **Step 5: 提交**

---

### Task 4: 路由、权限与缓存

**Files:**
- Create: `modules/data/routes/system-map.ts`
- Modify: `modules/data/manifest.yaml`（声明 `GET /system-map`，scope `data:query`）
- Modify: `modules/data/index.ts`（挂载）
- Test: `routes/system-map.test.ts`

- [ ] **Step 1: 路由装配**（读声明 → 查运行库 → `modelOf` → `render`；10 分钟内存缓存；`Content-Type: text/html; charset=utf-8`）
- [ ] **Step 2: 权限**（未登录 403；`data:query` 持有者 200）；manifest 双向核对通过
- [ ] **Step 3: 测试**：未登录 / 正常渲染含标题 / XSS 转义 / 缓存命中（二次调用不重复查库）
- [ ] **Step 4: 提交**

---

### Task 5: 孤儿表与候选质量（只报告，不自动处置）

**Files:**
- Modify: `health.ts` + `render.ts`（新增两块面板）
- Modify: `dbt/semantics/*.yml` 或契约（给 marts 表补 owner —— 仅当能确定负责人时）

**判据：**
- **孤儿表** = `dbt/models/**/marts/*.sql` 里无 owner 的表；owner 来源优先级：契约 `owner` → 声明文件 → 人工登记 `dbt/semantics/table-owners.yml`。
- **候选质量**：`metric_candidates` 里「单列聚合但列名疑似非度量」（`*_num`/`*_id`/`*_flag`/`*_status` 等）占比；只展示数与样例，**不删除**。

- [ ] **Step 1: 两块统计（纯函数 + 测试）**
- [ ] **Step 2: 页面展示**
- [ ] **Step 3: 能确定的表补 owner；不能确定的列「待定」**
- [ ] **Step 4: 提交**

---

## Self-Review

- G7 三条（5 分钟回溯 / 健康四数 / 孤儿 0）与 W5 出口判据逐条对应 ✅
- 移动端是独立任务且有可判定验收（断点表 + 四条硬设计 + 375px 断言）✅
- 不引新依赖、不塞 React 壳、零 CDN、只读 ✅
- 已知边界：SVG 图在手机端**刻意不做**；候选质量只报告不处置（删除是人决）
