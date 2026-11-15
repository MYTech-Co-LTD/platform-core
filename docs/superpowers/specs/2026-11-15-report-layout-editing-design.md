# 报表版式编辑：24 栅格拖动换位 + 拖边调宽（design）

> 2026-11-15 · 对应路线图 `docs/superpowers/plans/2026-11-13-report-platform-roadmap.md`
> （R3 呈现层扩展；不改变「版式走模板 + 槽位」硬规则 5，不引入坐标语义）

## 1. 目标与非目标

**目标**

1. 报表所有者/管理员可以**拖动换位**、**拖边改宽**（span 1–24），保存为报表草稿版式（默认版式）。
2. 每个观看者可在默认版式之上做**个人微调**（顺序 + 宽度），只影响本人；可重置。
3. 移动端/打印/旧规格不回归：无坐标、无重叠，纵向仍是顺序流。

**非目标（明确不做）**

- 自由画布 / 绝对坐标（x/y/w/h）、面板重叠 —— 路线图非目标不变。
- 跨页拖动（面板 `page` 归属只能通过改规格调整，布局编辑不搬页）。
- 新建图型/新块类型（那是 L4/L3 另一条线）。
- 移动端手势编辑（移动端只按个人版式**渲染**，编辑入口在桌面 console；触屏浏览器降级为「上移/下移/加宽/变窄」按钮）。

## 2. 数据模型

### 2.1 面板身份键（唯一实现：`modules/data/domain/report-layout.ts`）

```
panelKey(panel) = `${page ?? 1}|${chart}|${title}`     // page 取面板 `page` 字段
```

- 同名同图同页的面板（允许重复）按**出现次序**加后缀 `#2`、`#3`（序列化时确定；解析时按同规则还原）。
- 键只用于**对齐版式**，不落进报表规格，不参与取数。

### 2.2 版式条目

```ts
type LayoutItem = { key: string; span: number }   // span: int 1..24
```

- 条目集合必须与当前规格的面板键**完全一致**（多重集相等）；否则视为「版式已过期」，服务端 409 / 前端忽略并提示。
- 顺序语义：数组顺序 = 面板在同页内的展示顺序；不同页的条目相对次序不跨页生效。

### 2.3 存储

| 层级 | 位置 | 谁写 | 生效面 |
|---|---|---|---|
| 默认版式 | `data.reports.spec`（沿用 `PUT /reports/:id/spec` 的版本语义） | owner ∪ `data:manage` | 所有观看者，随发布生效 |
| 个人版式 | 新表 `data.report_layout_pref` | 任何可看该报表的登录用户（仅本人一行） | 仅本人 |

```sql
-- 054_report_layout_pref.sql
create table if not exists data.report_layout_pref (
  org        text not null,
  report_id  text not null,
  viewer     text not null,
  items      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (org, report_id, viewer),
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);
```

写入前校验：条目数 ≤ 24、`span` 整数 1..24、`key` 长度 ≤ 200、无重复键、请求体 ≤ 8KB。
失败一律 400，不静默截断。

## 3. 服务端

全部走现有鉴权链（声明式门卫 + `canViewAsset` / `canEditAsset`），不新增权限码。

| 端点 | 作用 | 语义 |
|---|---|---|
| `PUT /reports/:id/layout` | 应用默认版式 | body `{ items, expectedVersion }`；在**存储的原始 spec**（v1/v2 均可）上只改顺序与 `span`，不动 IR 版本；沿用 `PUT /spec` 的锁、指标校验与页门派生语义；键不匹配 → 409 `LAYOUT_STALE` |
| `GET /reports/:id/my-layout` | 读个人版式 | `{ items: LayoutItem[] \| null }` |
| `PUT /reports/:id/my-layout` | 存个人版式 | 校验后 UPSERT，返回 `{ ok: true }` |
| `DELETE /reports/:id/my-layout` | 重置个人版式 | 删除本人一行 |

为什么默认版式**不复用客户端 PUT /spec**：`GET /spec` 回的是归一化 v1 形态，客户端回写会把 v2 降级成 v1；
服务端应用版式能在原始 spec 上原地改顺序/宽度，IR 与 datasets 原样保留。

## 4. 前端

- 新共享组件 `LayoutEditorModal`：24 栅格预览（只画标题 + 图型标签 + 宽度），
  - 拖动卡片换位（HTML5 DnD）；拖右侧把手改 `span`（吸附整数）；
  - 每张卡片提供键盘/触屏按钮「上移 / 下移 / 变窄 / 变宽」；
  - 「重置」恢复打开时的版式；保存失败原位显示人话（409 = 报表已更新，请重新打开）。
- **所有者入口**：管理清单行内「布局」（`platform` + `canEdit`）。保存 = `PUT /reports/:id/layout`（草稿）。
- **观看者入口**：观看页工具栏「布局」。保存 = `PUT /reports/:id/my-layout`，并提供「恢复默认」。
- 渲染合并：`applyLayout(panels, items)` 纯函数；键集合不匹配 ⇒ 返回原样并标 `stale`（前端提示一次，不阻断）。
- 视觉遵循 `DESIGN.md`：卡片圆角 12、选中/拖拽态用主色 `#4D6BFE`、无装饰动画（仅 150ms 过渡）。

## 5. 验收

1. 默认版式：所有者拖动 + 调宽 → 发布 → 所有观看者看到新版式；观看者个人版式仍覆盖默认。
2. 个人版式：A 调整不影响 B；刷新/换设备后仍在；「恢复默认」后回到默认。
3. 失效：所有者改面板集合（增删/改标题）后，旧个人版式被忽略且提示一次；默认版式写回 409 并提示重开。
4. 不回归：单页/多页、打印全部、移动端（窄屏全宽）、`deniedPanels` 占位、KPI/AI 面板渲染不变。
5. 测试：`report-layout` 纯函数单测；路由 CRUD/ACL/校验/409 集成测试；`LayoutEditorModal` 交互测试（拖动、按钮、保存失败）；`ReportView` 合并与失效测试。

## 6. 风险

- **HTML5 DnD 在触屏不可用**：已提供按钮替代路径，编辑入口仅桌面 console；移动端只读。
- **个人版式与默认版式的键碰撞**：键由标题/图型/页组成，改标题即失效——这是有意的 fail-safe（宁可重置，不错位）。
- **v2 顺序写回**：按页分组重排，保持页间原有相对次序，避免影响打印顺序。
