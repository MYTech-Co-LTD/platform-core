# 月度经营报表：时间筛选与自动对比（B+C）设计

> 2026-10-26 · 状态：**设计稿（待评审后转实施计划）**
> 上游：`2026-09-28-report-authoring-design.md`（声明式规格 / 渲染两条路）、
> `2026-10-07-report-agent-toolface-design.md`（能提不能发）、
> `2026-10-25-xiongmao-store92-monthly-report.md`（熊喵店92 数据面）、
> `2026-10-25-p4-mobile-report-page-draft.md`（移动端拼装）。
> 现场取证：2026-10-26 山海生产实例 `platform-core-shanhai` + 湖侧真机读数。

## 0 一句话

把「时间」提升为**报表级参数**（月份 / 近 7 天 / 自定义），让所有面板继承同一窗口；给 KPI 加**自动对比上一期间**、数字卡与文本结论；报表取数改走**服务端分组**，不再用 grain 明细 + 前端求和。历史不足的指标统一显示 `-`，不显示 0 / ∞ / 空白。

## 1 现状与问题（2026-10-26 实测）

### 1.1 线上那张报表

- 报表：`熊喵曲靖沾益2店 · 2026年10月经营月报（10-01..19）`
  （生产 id `a1b2c3d4-xm92-4a10-9c26-report000001`，`renderer=platform`，已发布，version 4）。
- 7 个面板全部 `span=24`：销售额（按日，table）、销售额日趋势（line）、会员销售（按订单类型，bar）、
  会员客单（按订单类型，table）、报损金额（按原因，bar）、应付费用（按项目，table）、应收费用（按项目，table）。

### 1.2 数据是对的

湖侧按同一窗口（账套 3120 / 店 92 / 2026-10-01..19）逐分复算：

| 项 | 实测 |
|---|---|
| 销售额 | 51,273.89 |
| 订单数 | 957 |
| 会员销售 / 会员订单 | 24,284.39 / 455 |
| 报损 | 806.64 |
| 应付 / 应收 | 3,028.42 / 415.00 |

⇒ 问题不在口径与采集，在**信息结构**。

### 1.3 为什么「什么都看不出来」

1. **没有结论层**：7 个面板里没有一个总销售额、订单数、客单价、会员占比、报损率、费用率的 headline。
2. **「按项目」表其实是 grain 明细**：会员 23 行、应付/应收各 22 行，是「日 × 类型」原始行，不是汇总。
3. **重复**：销售额 table 与 line 同一份数据；会员销售与会员订单切法不一致。
4. **折线倒序**：明细计划按 `bizday DESC`，渲染器按到达顺序铺 x 轴、不排序。
5. **标题误导**：「会员客单」实际是 `lemeng:member:branch_vip_nums`（会员订单数 455），不是客单价。
6. **没有对比/异常/行动**：看不出好坏，也看不出下月改什么。
7. **信任信号被丢弃**：`/query` 回传的 `total` / `data_as_of` / `masking` / `freshness_line` 渲染器全部没用。

### 1.4 历史数据边界（决定对比怎么做）

| 数据集 | 最早 | 最新 |
|---|---|---|
| 零售 | 2026-09-23 | 2026-10-26 |
| 会员 | 2026-10-01 | 2026-10-25 |
| 报损 | 2026-10-01 | 2026-10-25 |
| 费用 | 2026-09-20 | 2026-10-25 |

- **去年同比**：没有 2025 数据，结构上不可能。
- **上月同期**：零售只有 9-23 起；会员/报损 10-01 才有 ⇒ 不完整。
- ⇒ 这期的月级环比会显示 `-`；「近 7 天 vs 前 7 天」可算，作为本期的动能信号。

## 2 目标与非目标

**目标（店长/店老板的月度体检，1 分钟读完）**

1. 第一屏给出 8 个 KPI + 2–3 条结论；
2. 顶部可切「月份 / 近 7 天 / 自定义」，所有面板与标题跟随；
3. KPI 自动对比上一期间；历史不足显示 `-`；
4. 柱状/表格走服务端分组，不再摊 grain 明细；
5. 主报表只放结论与汇总，原始明细另做「验收底稿」。

**非目标（本轮不做）**

1. 真·去年同比、完整上月环比（数据不够，先显示 `-`）；
2. 商品 Top10 / 时段分布（需要新 L1；见 §9）；
3. 按值排序的 TopN（`authorize` 的 `orderBy` 目前只接受维度列；见 §9）；
4. L2 派生指标的 query-time 参数（`params: {}` 未修；KPI 比率改用两个可加 L1 相除）；
5. Metabase 渲染器与报表导出/订阅；
6. 动态文本模板（文本结论仍是静态，人/agent 每期更新）。

> 版本管理与发布后独立链接另见 `2026-10-26-report-versioning-and-standalone-design.md`；v2 报表的最终发布依赖那两条。

## 3 决策记录

| 决策 | 结论 |
|---|---|
| 第一读者 | 店长 / 店老板 |
| 要回答的四问 | 卖得怎么样 / 钱花在哪 / 谁在贡献或拖后腿 / 下月改什么 |
| 实施路径 | B（月份/近 7 天预设）+ C（自动对比上一期间），A 先止血 |
| 历史不足 | 统一显示 `-`，不显示 0 / ∞ / 空白 |
| 本期默认窗口 | `custom 2026-10-01..19`（与 docx 对齐）；预设可切 |

## 4 信息架构（五屏）

| 屏 | 面板 | 数据现状 |
|---|---|---|
| **1 本月结论** | 8 张 KPI：销售额、订单数、客单价、会员销售占比、报损金额、报损率、费用合计、费用率；每张带对比 | 全部可算：比率用两个可加指标相除；金额与率拆成两张卡 |
| | 1 个文本块：本月 2–3 条结论 | 新增 `text` 面板 |
| **2 趋势** | 日销售额折线（升序，标最高/最低日）；日订单数 | L1 已有 |
| **3 钱花在哪** | 费用按项目（柱状）；报损按原因（柱状）；会员 vs 非会员 | L1 已有，服务端按维度汇总 |
| **4 贡献/拖累** | 会员按订单类型（柱状）；商品 Top10、时段分布 | 会员可做；商品/时段后置 |
| **5 异常与行动** | 连续无业绩天数；数据完整性（无数据/截断/新鲜度）；2–3 条行动建议 | 连续无业绩天数 L1 已有；业务异常规则后置；行动建议用 `text` |

> 费用合计默认用 `lemeng:expense:branch_net`（门店净费用 = 应付 − 应收，certified）；若业务口径要「应付」，改用 `branch_payable`（§13.9）。

## 5 B：报表级时间参数

### 5.1 规格形状

```ts
period?: {
  mode: 'month' | 'last_7_days' | 'custom'
  month?: string   // YYYY-MM，mode=month 必填
  from?: string    // YYYY-MM-DD，mode=custom 必填
  to?: string      // YYYY-MM-DD，mode=custom 必填
}
```

- 顶层 `.strict()`；`period` 可选 ⇒ 旧规格行为不变。
- `mode=month` ⇒ `from = 当月 1 日`，`to = 当月最后一天`（当月未结束时取今天，Asia/Shanghai）。
- `mode=last_7_days` ⇒ `from = 今天 − 6 天`，`to = 今天`。
- `mode=custom` ⇒ 用 `from/to`，校验 `from <= to`。
- `mode=month` 缺 `month`、`mode=custom` 缺 `from`/`to`、`from > to` ⇒ `INVALID_SPEC`（不静默兜底）。
- 纯函数 `periodRangeOf(period, now)`，单测覆盖月末/闰年/时区。

### 5.2 注入规则

- 面板级 `timeScoped?: boolean`，缺省 `true`。
- `timeScoped=true` ⇒ 渲染器用 `period` 算出的 `{from,to}` **总是注入** `args.bizday`（不论面板 `args` 是否写了它）。KPI 面板通常不写 `bizday`，靠这条拿到时间窗。
- 指标没有 `bizday` 参数时，作者必须显式 `timeScoped: false`；否则查询回 `unknown_param:bizday`，面板显示明确错误（不静默忽略）。
- `timeScoped=false` ⇒ 用面板自己的 `args.bizday`（固定窗口面板，如附录）。
- 旧规格没有 `period` ⇒ 完全走现有「筛选栏 override」路径，行为不变。

### 5.3 顶部控件与标题

- 有 `period`：显示月份选择器（默认 `period.month` 或 `period.from` 所在月）、「近 7 天」、「自定义」三段。
- 标题保持登记表里的 `title` 不变；页面副标题动态显示当前窗口，如「统计期间 2026-10-01 ~ 2026-10-19」。
- 选到没数据的窗口：面板显示 `-` + 「该期间无数据」，不显示 0。

## 6 C：自动对比

### 6.1 模式

面板级 `compare?: 'auto' | 'prev_period' | 'prev_month' | 'none'`，缺省 `auto`；`kpi` 面板可用。

- `prev_period`：紧邻的等长上一窗口（10-01..19 ⇒ 9-12..30）。
- `prev_month`：上月同日期段（10-01..19 ⇒ 9-01..19）；月末夹取上月最后一天。
- `auto`：`period.mode=month` ⇒ `prev_month`；`last_7_days` / `custom` ⇒ `prev_period`。这样切「近 7 天」时自动变成「前 7 天」。
- `compare` **只允许出现在 `kpi` 面板**；其它图型带它 ⇒ `INVALID_SPEC`（不静默忽略）。
- 纯函数 `previousRangeOf(range, mode)`，单测覆盖跨月/跨年/月末。

### 6.2 显示与 `-` 语义

| 情形 | 显示 |
|---|---|
| 本期无数据（0 行 / total 为 null） | 数值 `-`，不显示对比 |
| 对比期无数据（0 行 / total 为 null） | 本期数值照常；对比显示 `-` |
| 对比期为真实 0 | 绝对差照常；百分比差显示 `-`（0 为分母无定义） |
| 本期与对比期都有数据 | `+12.3%` / `-3.2pp`（按 `format` 决定） |

- 比率类 KPI（客单价、会员占比、报损率、费用率）的对比用**百分点差**（`pp`），不是百分比变化。
- `goodDirection?: 'up' | 'down' | 'none'`，缺省 `none`（中性色）；销售额/订单数/客单价/会员占比可设 `up`，报损/费用设 `down`。不做「红绿自动」推断。

## 7 面板能力

### 7.1 `kpi` 面板

```ts
{
  chart: 'kpi'
  title: string
  metricId: string
  denominatorMetricId?: string   // 比率：分子/分母两个可加指标
  args?: Record<string, string | number | boolean | { from: string; to: string }>
  format: 'currency' | 'number' | 'percent'
  compare?: 'auto' | 'prev_period' | 'prev_month' | 'none'
  goodDirection?: 'up' | 'down' | 'none'
  span: number
  timeScoped?: boolean
}
```

- 可加指标：`/query` 带 `args.total=true`，取回包 `total`。
- 比率：分子、分母各查一次 `total`，相除；分母 0/null ⇒ `-`。
- 本期/对比期各查一次（比率各两次）；**按 `(metricId, args, 期间)` 去重**——销售额/订单数等会被多个 KPI 复用，不要重复打仓库。
- 格式化：`currency` 千分位 2 位小数；`number` 整数/千分位；`percent` 0.00%。
- 面板查询并发上限 4；单个 KPI 的本期/对比查询受同一上限约束，避免 8 张卡 × 4 次同时压仓库。

### 7.2 `text` 面板

```ts
{ chart: 'text', title?: string, content: string, span: number }
```

- 纯文本，≤2000 字，禁 HTML / Markdown 渲染；保留换行（`white-space: pre-wrap`）。
- 内容由 agent 写、人审发布；每期更新（静态文本，见 §9）。

### 7.3 `slice`（line/bar/table）

```ts
slice?: {
  dimensions?: string[]
  orderBy?: { column: string; dir: 'asc' | 'desc' }[]
  limit?: number          // 1..1000
  total?: boolean         // 表格页脚合计 / 图表注释
}
```

- 有 `slice` ⇒ 渲染器把 `dimensions/orderBy/limit/total` 传给 `/query`，服务端分组/排序/截断。
- `slice.dimensions` 缺省 = 面板 `dims`；`dims` 仍是渲染透视轴（两者保持一致，服务端只认 `slice.dimensions`）。
- 无 `slice` ⇒ 保持现状（grain 明细 + 前端透视），仅用于旧规格。
- `slice` 只允许 `line/bar/table`；`kpi`/`text` 带 `slice` ⇒ `INVALID_SPEC`。
- `orderBy` 目前只接受维度列（`authorize` 的既有约束）⇒ 时间序列可以 `bizday asc`；**按值 TopN 不在本轮**。
- 非可加指标的 line/bar 在写入侧直接拒（§8），避免前端求和错数；table 允许非可加（原始行）。
- 表格有 `slice.total` 时在页脚显示「合计」；图表有 `truncated` 时显示「已截断」提示。

### 7.4 渲染器其余修正

- 折线/柱状：`slice.orderBy` 给 `bizday asc` 时，x 轴按返回顺序即升序；无 `slice` 的旧规格保持现状。
- 每个面板显示 `data_as_of` / `freshness_line` / `masking` 中的可用信息（页脚一行，不抢主视觉）。
- 面板 `truncated=true` ⇒ 图表和表格都提示，不只表格。
- 面板 denied ⇒ 保留现有「这条口径当前不可用」，不拖垮整页。

### 7.5 schema 严格性

每个 union 成员 `.strict()`；不属于该图型的字段（`text` 带 `metricId`、`line` 带 `compare`、`kpi` 带 `slice`、`kpi` 带 `dims`、`text` 带 `args`）一律 `INVALID_SPEC`，不静默忽略。图型白名单仍是代码常量，加图型走 PR。

## 8 写入侧校验（关键，堵「坏报表落库」）

### 8.1 `deriveRequiredScope` 调整（`domain/report-scope.ts`）

- `text` 面板**跳过**（没有 metricId）。
- `kpi` 面板：`metricId` 必存在；有 `denominatorMetricId` 时也必须存在，并一起参与 scope 集合。
- 未知 metricId ⇒ 继续 `UNKNOWN_PANEL_METRIC`（点名）。
- 多 scope 冲突 ⇒ 继续 `CONFLICTING_PANEL_SCOPES`。

### 8.2 新增 `validatePanelMetrics(spec, catalog, adoptedSources)`

在 `POST /reports`、`PUT /reports/:id/spec`、MCP `propose_report`、MCP `revise_report_spec` 四处调用（`PUT /reports/:id` 不改 spec，不在此列）：

| 面板 | 校验 | 错误码 |
|---|---|---|
| `line` / `bar` | 指标必须 `totalable === true` | `CHART_REQUIRES_ADDITIVE` + metricId |
| `kpi` | 分子/分母都必须 `totalable === true` | `KPI_NOT_TOTALABLE` + metricId |
| `table` | 不限制（可加/不可加都能看原始行） | — |
| `text` | 跳过 | — |

- 理由：`line/bar` 的渲染器按 `(x, series)` 求和；非可加指标一求和就是错数（比率/存量/max/去重计数）。结构上拒掉，比提示词可靠。
- **源裁剪**：指标属于本租户未接入源 ⇒ `METRIC_SOURCE_NOT_ADOPTED`（与 L2 写入闸同码）。理由：提报时看着成功、观看面恒 denied 的面板是最难查的形态。`POST/PUT` 从宿主投影取 `TENANT_SOURCES`，MCP 从 `deps.adoptedSources` 取。
- `totalable` 已在 `data.metrics`（`MetricRow.totalable`），无需迁移。
- `slice.dimensions` 的合法性仍由 `/query`/`authorize` 判（同一事实源）；写入侧不复制第二份 grain 判定。

### 8.3 `propose_report` 也要校验

现状 `propose_report` 只做 `parseReportSpec` + create-only，不查词表 ⇒ 坏报表能落库、观看时才 denied。本轮在 `mcp-report-tools.ts` 里补 `loadMergedCatalog` + `deriveRequiredScope` + `validatePanelMetrics(spec, catalog, deps.adoptedSources)`，失败返回 `refused` + 错误码。`revise_report_spec` 同样过一遍。

## 9 API / MCP 变更

### 9.1 `POST /query` 扩参

- body 增加可选 `dimensions?: string[]`、`orderBy?: {column,dir}[]`、`limit?: number`、`total?: boolean`。
- 透传到 `runQuery(..., slicing)`；`total` 映射为 `SlicingSpec.total`（附加合计）。
- `args.total=true` 仍是「只回单行合计」的既有语义（KPI 用这条）；两者不混。
- 响应字段不变；`total` / `truncated` / `masking` / `data_as_of` 由渲染器消费。

### 9.2 MCP

- `get_report_spec({id})`：返回 `{id,title,renderer,requiredScope,version,spec}`；挂 `/mcp-manage`（`data:manage`）。用于 agent 改报前读回，避免「靠记忆重写整份 spec」。
- `list_metrics`（管理面）补 `params`（`name/type/required`）与 `totalable`；`tier` 不在库（`tier/owner` 不落库，README 已记），不承诺。
- `propose_report` / `revise_report_spec` 的入参形状不变；`revise_report_spec` 仍需 `expectedVersion`。

### 9.3 兼容

- 旧规格（无 `period`/`slice`/`kpi`/`text`）解析与渲染行为不变。
- `data.reports.spec` 是 JSONB，无需迁移。
- server 与 console 同版本部署；`parseReportSpec` 是唯一白名单，旧 console 遇到新图型会拒（版本不一致时不要混跑）。
- 已发布报表的改写仍需要 `data:manage` 的人（agent 的 `revise_report_spec` 拒已发布）；本轮不放开。

## 10 A：止血版（今天，零改码）

只重写这张已发布报表的 spec，不改代码：

| # | 面板 | 指标 | 形式 |
|---|---|---|---|
| 1 | 总销售额 | `lemeng:retail:net_sales` | table，`args.total=true` |
| 2 | 总订单数 | `lemeng:retail:order_count` | table，`args.total=true` |
| 3 | 报损合计 | `lemeng:loss:branch_amount` | table，`args.total=true` |
| 4 | 应付合计 | `lemeng:expense:branch_payable` | table，`args.total=true` |
| 5 | 销售额日趋势 | `lemeng:retail:net_sales` | line，dims `['bizday']`（B 版修升序） |
| 6 | 会员销售（按订单类型） | `lemeng:member:branch_vip_money` | bar，dims `['order_sale_type_name']` |
| 7 | 会员订单数（按订单类型） | `lemeng:member:branch_vip_nums` | bar，dims `['order_sale_type_name']` |
| 8 | 报损（按原因） | `lemeng:loss:branch_amount` | bar，dims `['cause']` |
| 9 | 应付（按项目） | `lemeng:expense:branch_payable` | bar，dims `['expense_type']` |
| 10 | 应收（按项目） | `lemeng:expense:branch_receivable` | bar，dims `['expense_type']` |

- 删除：销售额原始表、会员客单原始表、应付/应收原始表。
- 修正标题：「会员客单」→「会员订单数」；报损去掉未过滤的「出库」二字或明确方向。
- 这版仍**没有**客单价/占比/率/对比/结论；等 B+C。
- 操作：报表已发布（version 4），agent 不能改；需 `data:manage` 的人用 `PUT /reports/:id/spec`（带 `expectedVersion: 4`），或新建一张 v2 后发布、旧的下线。

## 11 验收

### 11.1 功能

1. 顶部可切月份 / 近 7 天 / 自定义；切换后所有 `timeScoped` 面板与副标题同步。
2. KPI 8 张：本期值正确；有对比数据时出差值；无数据时显示 `-`。
3. 比率 KPI（客单价/会员占比/报损率/费用率）与人工复算一致（客单价 = 销售额 / 订单数，等）。
4. `text` 面板纯文本渲染，换行保留，HTML 不执行。
5. 柱状/表格走服务端分组：费用按项目、报损按原因、会员按订单类型各一行/一组，不再出现「日 × 类型」明细。
6. 折线升序；`truncated` 在图表和表格都提示。
7. 非可加指标的 line/bar 在写入侧被拒（`CHART_REQUIRES_ADDITIVE`）；kpi 非可加被拒（`KPI_NOT_TOTALABLE`）。
8. 旧规格（无 `period`/`slice`/`kpi`/`text` 的存量报表）解析与渲染不回归。

### 11.2 数值锚点

- 销售额 51,273.89；会员 24,284.39 / 455；报损 806.64；应付 3,028.42；应收 415.00（窗口 10-01..19）。
- 客单价 = 51,273.89 / 957（2026-10-26 湖侧实测 `order_count` 合计 = 957，与 docx 一致）。
- 会员占比 = 24,284.39 / 51,273.89。
- 报损率 = 806.64 / 51,273.89；费用率 = `branch_net` / 销售额（若业务口径为应付，改用 `branch_payable`，见 §13.9）。

### 11.3 真机

- 移动视口 390×844：一屏一章，KPI 不挤压，长表可横向滚动。
- 时间切换后无整页白屏；单面板失败只塌自己那格。
- 首屏延迟以真机实测为准；KPI 查询按 `(metricId, args, 期间)` 去重 + 并发上限 4，不以 24+ 并发打仓库。
- 发布后观看面（`data:query`）可见；页门按发布规则。

## 12 实施顺序与文件落点

| 步 | 内容 | 文件 |
|---|---|---|
| 1 | 规格 schema：`period` / `kpi` / `text` / `slice` / `compare`；严格白名单 | `domain/report-spec.ts` |
| 2 | 期间数学：`periodRangeOf` / `previousRangeOf` | `domain/report-period.ts`（新） |
| 3 | 写入侧校验：text 跳过 / 分母 scope / 可加性 / 源裁剪 | `domain/report-scope.ts`、`routes/reports.ts`（读 `TENANT_SOURCES`） |
| 4 | `/query` 扩参 + slicing 透传 | `routes/query.ts` |
| 5 | MCP：`get_report_spec` / `list_metrics` 补 params / `propose_report` 校验 | `routes/mcp-report-tools.ts`、`routes/mcp-metric-tools.ts` |
| 6 | 渲染器：period 控件、KPI、text、slice、截断/掩码/新鲜度提示 | `console/reports/SpecView.tsx`、`KpiCard.tsx`（新） |
| 7 | 测试 | `report-spec.test.ts`、`report-period.test.ts`（新）、`report-scope.test.ts`、`reports.test.ts`、`query.test.ts`、`mcp-report-tools.test.ts`、`mcp-manage.test.ts`、`SpecView.test.tsx` |
| 8 | A 止血 spec（人工 PUT） | 生产 `data.reports.spec`，不进 git |
| 9 | v2 报表重建 + 人审发布 | v2 spec 存 `docs/superpowers/notes/2026-10-26-monthly-report-spec.json`（可 review），生产由人 PUT |

## 13 已知边界与待决

1. **真环比/同比**：历史不够，显示 `-`；11 月有完整两月后再切真环比；去年同比要等回采或明年。
2. **商品 Top10 / 时段分布**：需要新 L1（商品粒度、hour 桶）；本轮不做，不用原始明细硬凑。
3. **按值 TopN**：`authorize` 的 `orderBy` 只接受维度列；要按值排序得单独扩 `buildSlicedPlan` + 测试，本轮不做。
4. **L2 无 params**：`params: {}` 未修；KPI 比率用两个可加 L1 相除，不依赖 L2；L2 进时间窗报表仍不可用。
5. **文本结论是静态**：每期需人/agent 更新；动态模板（KPI 占位符）后置。
6. **标题静态**：登记表 `title` 不变，期间只进副标题；分享/深链的标题不会随期间变。
7. **`period` 的「今天」锚点**：`month` 模式的当月取今天为 `to`；若数据截止早于今天，面板会显示到截止日，副标题可再注明「数据截至 X」。
8. **已发布报表改写**：仍需要 `data:manage` 的人；agent 只能改未发布行。A 与 v2 都按这条走。
9. **费用合计口径**：应付 + 应收是否相加为「费用合计」需业务确认；验收锚点先分开列。
10. **订单数 957**：2026-10-26 湖侧实测 `order_count` 合计 = 957，与 docx 一致；若未来口径变更，按新声明重算，不在报表层硬凑。

## 14 证据位置

- 规格白名单：`modules/data/domain/report-spec.ts:12-30`
- 报表工具面：`modules/data/routes/mcp-report-tools.ts:22,96-119`
- 报表取数：`modules/data/routes/query.ts:11-14`；`modules/data/console/reports/SpecView.tsx:88,178,239,274`
- 1000 行/明细排序：`modules/data/domain/authz.ts:157,447-469`
- `total` 绕过可加性：`modules/data/domain/authz.ts:406,451-454`（totalable 闸只在切片真子集，516-520）
- L2 params：`modules/data/domain/metric-write.ts:131-142`；`modules/data/domain/semantic-compiler.ts:509-515`
- scope 派生：`modules/data/domain/report-scope.ts:27-41`
- 直读目标与缺口：`docs/architecture.md:253-296`
