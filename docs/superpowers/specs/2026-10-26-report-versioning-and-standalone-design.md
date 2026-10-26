# 报表版本管理与发布后独立链接设计

> 2026-10-26 · 状态：**设计稿（待评审后转实施计划）**
> 上游：`2026-10-26-monthly-report-period-compare-design.md`（B+C 内容能力）、
> `2026-09-28-report-authoring-design.md`（报表登记/写保护）、
> `2026-10-07-report-agent-toolface-design.md`（能提不能发）。
> 现场取证：2026-10-26 山海生产实例 + `modules/data` 现有读写路径。

## 0 一句话

发布 = 对当前草稿做一次**不可变快照**；独立链接 `/r/:id` 只读最新已发布版本，`?v=N` 钉住历史版本；链接走平台会话/企微免登，无导航、无菜单、无管理按钮，纯移动端单页。**版本是报表定义版本，不是数据快照**。

## 1 现状与问题

1. `data.reports.version` 是**写入计数器**（`migrations/005_report_version.sql`），每次写 spec/页门 +1；它只用于乐观并发，**没有历史**。
2. 平台报表的“发布”是页门派生 + 置空（`routes/reports.ts:314-337`）；发布后 `PUT /reports/:id/spec` 会**直接改线上内容**，没有草稿/已发布分离。
3. 没有任何版本快照/回滚；改坏了只能凭记忆改回。
4. console 报表页在 `/console` 壳内（`apps/web/src/App.tsx:21-50`），带 ProLayout 导航；没有可分享的独立页面。
5. `GET /reports/:id/spec` 读的是**可变草稿**，不是已发布快照；无法支撑“独立链接显示已发布版本”。

## 2 决策记录

| 决策 | 结论 |
|---|---|
| 独立链接鉴权 | **登录后可见**：平台会话 / 企微免登；不做公开链接、不做签名 token |
| 版本粒度 | **每次发布**生成一个不可变版本；草稿编辑不影响线上 |
| 版本语义 | **报表定义版本**（指标/维度/布局/文案），不是数据快照 |
| 适用范围 | 仅 `renderer='platform'` 自绘报表；Metabase 行不变 |
| 发布权 | 人（`data:manage`）；agent 仍只能提报/改未发布草稿 |
| 回滚 | 复制旧版本内容生成**新版本**（append-only），不把版本号倒回去 |
| 下线 | `published_version_id=null` + 页门挂 `data:manage`；所有 `/r/:id?v=*` 一并失效 |

## 3 数据模型

### 3.1 新表 `data.report_versions`

```sql
create table if not exists data.report_versions (
  id             text        not null primary key,   -- 应用层 randomUUID()；迁移回填用 md5 确定性值
  org            text        not null,               -- 租户隔离键（与 data.reports 同口径）
  report_id      text        not null,
  version        integer     not null,               -- 每报表从 1 单调递增（已发布版本号）
  title          text        not null,
  spec           jsonb       not null,
  required_scope text,                               -- 发布时由 spec 派生，快照留档
  draft_version  integer     not null,               -- 发布时的 data.reports.version
  published_at   timestamptz not null default now(),
  published_by   text        not null,
  note           text        not null default '',
  unique (org, report_id, version),
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);
```

- 幂等 DDL（`if not exists`）；`id` 不在 DB 里生成（与 `002_reports.sql` 同理由：不依赖 pgcrypto）。
- `version` 每报表独立；`(org, report_id, version)` 唯一。
- `draft_version` 用于判断“草稿有未发布改动”：`data.reports.version > 最新快照.draft_version`。
- `published_by` = `requester.userId`；`note` ≤200 字。

### 3.2 `data.reports` 增列

```sql
alter table data.reports add column if not exists published_version_id text;
```

- 指向 `data.report_versions.id`；`null = 当前没有已发布版本`。
- 不加 DB 外键也可（避免循环依赖）；应用层在同一事务里保证 `published_version_id` 属于本报表。若要 DB 兜底，加 `references data.report_versions(id) on delete set null`。
- `data.reports.version` **继续是草稿写入计数器**；`published_version_id` 指向的版本才有“已发布版本号”。

### 3.3 两个“版本”别混

| 名字 | 含义 | 用途 |
|---|---|---|
| `data.reports.version` | 草稿写入计数器（每次写 spec/页门 +1） | 乐观并发 `expectedVersion` |
| `report_versions.version` | 已发布内容版本号（1,2,3…） | 独立链接 `?v=N`、历史、回滚 |
| `report_versions.draft_version` | 发布时的草稿计数器 | 判断“有未发布改动” |

## 4 生命周期

### 4.1 草稿

- 草稿 = `data.reports.spec` + `title`；写入仍走 `PUT /reports/:id/spec`（`data:manage` + `expectedVersion`）。
- 草稿写入**不改** `published_version_id`，也不改线上独立链接内容。
- **已发布报表的草稿编辑不改线上页门**：`PUT /reports/:id/spec` 对 `published_version_id` 非空的行只写草稿（`updateSpec`），不改 `required_scope`；线上门归已发布快照。未发布行仍走 `updateSpecAndScope`（预览门跟随草稿）。
- 未发布报表的预览页门可继续跟随草稿派生 scope（沿用现状）；已发布报表的线上页门保持快照的 `required_scope`，直到下一次发布/下线。

### 4.2 发布 `POST /reports/:id/publish`

body：`{ expectedVersion: number, note?: string }`（`.strict()`）。

1. `withObjectLock(org/row:id)` 内读当前行；`expectedVersion` 不匹配 ⇒ 409 `STALE_WRITE`。
2. `renderer !== 'platform'` ⇒ 400 `RENDERER_NOT_SELF_DRAWN`；`spec` 为空 ⇒ 400 `NO_SPEC`。
3. `parseReportSpec` + `deriveRequiredScope` + `validatePanelMetrics`（同 B+C 设计 §8）；任一失败 ⇒ 400 带错误码，**不落任何版本**。若 B+C 的 `validatePanelMetrics` 尚未落地，先用现有 `deriveRequiredScope`；B+C 落地后自动接入。
4. 若已有已发布版本且 `title/spec/required_scope` 与最新快照逐字相同、且 `data.reports.version === 最新快照.draft_version` ⇒ 返回 `{publishedVersion, unchanged: true}`，不新建版本。
5. 否则：`version = max(report_versions.version)+1`；插入快照（`draft_version = 当前 version`）；同一事务内更新 `data.reports.published_version_id` 与 `required_scope = 派生值`。
6. 返回 `{publishedVersion, publishedAt, requiredScope}`。

并发：单实例由对象锁串行；多副本靠 `(org, report_id, version)` 唯一约束兜底，冲突时重读 max 重试一次，仍冲突 ⇒ 409。

### 4.3 下线 `POST /reports/:id/unpublish`

- body `{ expectedVersion: number }`。
- 锁内：`published_version_id = null`；`required_scope = 'data:manage'`（草稿预览档）。
- **不删版本**；但 `/r/:id` 与 `/r/:id?v=*` 全部返回 404/403（下线是总闸）。
- 幂等：本来没有已发布版本 ⇒ 200 `{unpublished:true, unchanged:true}`。

### 4.4 回滚 `POST /reports/:id/versions/:version/rollback`

- body `{ expectedVersion: number, note?: string }`。
- 锁内：读目标快照；不存在/不属于本报表 ⇒ 404。
- 用**当前词表**重新 `deriveRequiredScope` + `validatePanelMetrics`（旧快照引用的指标可能已删/改 scope）；失败 ⇒ 400，不落版本。
- 复制快照的 `title/spec` 到草稿（`data.reports` 更新，`version+1`），再插入**新版本** `version = max+1`，`note = note || 'rollback from vN'`，`draft_version = 新草稿版本`，`required_scope = 重新派生值`，`published_version_id = 新版本`。
- 旧版本全部保留（append-only）；独立链接的最新版本号前进，不倒退。

### 4.5 历史

- `GET /reports/:id/versions`（`data:manage`）：按 `version desc` 返回
  `{version, title, publishedAt, publishedBy, note, draftVersion, isCurrent}`；最多 100 条。
- `GET /reports/:id/versions/:version`（`data:manage`）：返回完整快照（含 spec），供 review/回滚确认。

## 5 读路径与 API

| 端点 | scope | 语义 |
|---|---|---|
| `GET /reports/:id/published-spec` | `data:query` | 最新已发布快照；无 ⇒ 404 `NOT_PUBLISHED` |
| `GET /reports/:id/published-spec?v=N` | `data:query` | 钉住 vN；版本不存在 ⇒ 404；报表已下线 ⇒ 404 |
| `GET /reports/:id/draft` | `data:manage` | 草稿 spec + 写入版本 + 最新已发布版本 + `hasUnpublishedChanges` |
| `GET /reports/:id/spec` | `data:query` | **保留**：草稿读取（旧 console 预览兼容）；新页面不再依赖它 |
| `POST /reports/:id/publish` | `data:manage` | §4.2 |
| `POST /reports/:id/unpublish` | `data:manage` | §4.3 |
| `POST /reports/:id/versions/:version/rollback` | `data:manage` | §4.4 |
| `GET /reports/:id/versions` / `.../versions/:version` | `data:manage` | §4.5 |

- `/published-spec` 的页门：用**该快照自己的** `required_scope`（`?v=N` 用 vN 的门）；不通过 ⇒ 404，不给存在性探针。当前行的页门只服务草稿/预览，不参与已发布快照判权。
- 面板数据仍走 `POST /query`：指标 scope / 掩码 / 审计 / 主体钉死全部不变。
- 钉住旧版本时，若旧 spec 引用的指标已被删除，该面板 denied，不影响其它面板；不回退整页。
- **下线是总闸**：`published_version_id` 为空时，所有版本链接（含 `?v=N`）一律 404。
- 版本是定义版本：`?v=N` 用 vN 的 spec + **当前湖里的数据**；不冻结数字。

## 6 发布后独立链接

### 6.1 路由

- 新裸路由：`/r/:id`（`?v=N` 钉版本）。
- 实现：`apps/web/src/App.tsx` 在 `ConsoleShell` **之外**加一条顶层路由，懒加载
  `modules/data/console/standalone.tsx`；不经过 `frontend.console` 注册表，因此没有 ProLayout。
- 为什么先做宿主裸路由：目前只有 data 模块有独立报表页，符合「无案例不立标准」；若第二个模块也需要，再抽 `frontend.standalone` 协议（manifest + 生成器 + 宿主挂载）。
- 路由顺序：放在 `{ path: '*' }` 兜底之前；`/r/:id` 比 `*` 更具体，react-router v6 会正确命中。

### 6.2 鉴权与回跳

- 走平台会话（Casdoor）；企微内置浏览器走现有 `/api/platform/auth/wecom/silent` 免登。
- 未登录：`platformFetch` 401 拦截跳 `/login?next=/r/<id>`；带版本时 `next=/r/<id>?v=N` 必须原样保留（#1060 已修查询串透传；本设计加一条回归用例）。
- 页面自身不做 scope 判定；`/published-spec` 与 `/query` 服务端裁决。无权限 ⇒ 极简「无权查看」页，无导航。
- 不做公开链接、不做签名 token；除 `noindex` 外不做任何 SEO/公开分享面。

### 6.3 页面形态

- 无 console 壳：无侧边栏、无顶部导航、无面包屑、无报表列表、无「关闭」按钮、无管理动作。
- 内容 = 报表标题 + 期间副标题 + 时间控件 + 面板 + 文本结论 + 极简页脚（版本/数据截止）。
- 移动优先：`max-width: 720px; margin: 0 auto; padding: 12px; padding-bottom: env(safe-area-inset-bottom)`；
  KPI 两列（≤360px 单列）、图表/表格全宽、表格横向滚动收敛在卡片内、页面不横向溢出。
- 版本标识：最新已发布不显眼；`?v=N` 在副标题显示「历史版本 vN」，让查看者知道不是最新。
- 文档标题 = 报表标题；`<meta name="robots" content="noindex,nofollow">`；不写公开缓存头。
- 错误态：`NOT_PUBLISHED` → 「报表未发布」；403 → 「无权查看」；404 → 「报表不存在」；均无导航。
- 期间控件保留（它是报表内容的一部分）；切换期间只改查询窗口，不改版本。

### 6.4 console 入口

- 报表行新增：
  - 「独立链接」：复制 `origin + '/r/' + id`；剪贴板失败回退可复制文本框。
  - 「版本」：历史抽屉；每行「查看」（新标签 `/r/:id?v=N`）、「回滚」（确认 + note）。
  - 「发布」：调 `/publish`，可填 note；有未发布改动时显示 badge。
  - 「下线」：调 `/unpublish`。
- 平台报表行的「改页门」入口**下线**（页门由发布时派生；手动改会与快照不一致）；Metabase 行保持现状。
- 「回收」仍删除报表登记行，`on delete cascade` 一并删版本；确认文案要写明「历史版本一并删除」。

### 6.5 组件复用

- 从 `console/reports/SpecView.tsx` 抽出 `ReportView`（标题、期间控件、面板、文本、页脚），带 `chrome: 'console' | 'standalone'`：
  - `console`：保留「关闭」按钮/内嵌边距；
  - `standalone`：无关闭、无列表、全宽移动布局。
- 数据来源：`ReportView` 调 `/published-spec`；未发布时 404，不回退草稿（独立链接不泄漏草稿）。
- console 报表页：优先 `/published-spec`；404 时回退 `/spec`（草稿预览，gate 持有者），保持旧行为。
- 单独组件测试：standalone 不渲染任何 `Menu`/`ProLayout`/管理按钮；`?v=N` 显示历史标识。

## 7 权限与不变量

1. **租户隔离**：所有版本表读写带 `org`；跨租户恒 404（不给存在性探针）。
2. **页门**：独立链接按当前报表页门；面板数据按指标 scope/掩码，仍由 `/query` 裁决。
3. **下线总闸**：`published_version_id=null` ⇒ 所有版本链接失效。
4. **发布权**：仅 `data:manage` 的人；agent 无 publish/unpublish/rollback 工具。
5. **能提不能发**：`propose_report` 建草稿；`revise_report_spec` 只改**未发布**草稿（`published_version_id !== null` ⇒ 拒 `PUBLISHED_REPORT`）；已发布报表草稿由人改。
6. **快照不可变**：`report_versions` 行只插不改不删（报表删除时 cascade 除外）。
7. **审计**：`published_by` / `published_at` / `note` 随版本永久留存。
8. **版本 ≠ 数据快照**：独立链接展示当前数据；要冻结数字需另做数据快照/导出（非目标）。

## 8 迁移与兼容

### 8.1 迁移（`modules/data/migrations/022_report_versions.sql`）

- `create table if not exists data.report_versions`（§3.1）。
- `alter table data.reports add column if not exists published_version_id text`。
- 回填：对 `renderer='platform'`、`spec is not null`、`required_scope is null` 的现有报表，
  插入 `version=1` 快照（`id = md5(org || ':' || report_id || ':' || 1)`，
  `draft_version = data.reports.version`，`published_at = updated_at`，`published_by = 'migration'`），
  并回填 `published_version_id`；`on conflict (org, report_id, version) do nothing`。
- 未发布（页门非空）的平台报表不回填；它们仍走草稿预览。
- 迁移幂等；部署脚本会全量重跑。

### 8.2 兼容

- `data.reports.version` 语义不变（草稿写入计数器）。
- `GET /reports/:id/spec` 保留为草稿读取；新页面用 `/published-spec`。
- 平台行的 `PUT /reports/:id`（旧发布路径）改为 **409 `USE_PUBLISH_ENDPOINT`**，避免“发布却没版本”；
  console 同步改用 `/publish` / `/unpublish`。Metabase 行保持 `PUT` 现状。
- `list_reports`（MCP）/`GET /reports/manage` 增加 `publishedVersion` / `hasUnpublishedChanges`；
  `get_report_spec` 返回草稿 + 最新已发布版本元数据。
- 既有平台报表（含熊喵月报）迁移后得到 v1，独立链接立即可用。

## 9 测试与验收

### 9.1 单元/集成

1. 发布 v1：快照落库、`published_version_id` 指向它、页门 = 派生值。
2. 发布后改草稿：`/published-spec` 仍返回 v1；`/draft` 显示 `hasUnpublishedChanges=true`。
3. 发布 v2：`/published-spec` 返回 v2；`?v=1` 返回 v1 spec；`?v=99` 404。
4. 幂等发布（草稿未变）：不新建版本，返回 `unchanged:true`。
5. 回滚到 v1：新建 v3（内容 = v1），`/published-spec` 返回 v3；历史列表 v1/v2/v3 都在。
6. 下线：`/published-spec` 与 `?v=*` 全 404；再发布可恢复。
7. 跨租户：别 org 读同一 id ⇒ 404。
8. 无页门用户：403/404；有页门用户正常。
9. 版本号并发：两请求同时发布 ⇒ 一个成功、一个 409/重试后唯一版本，不重号。
10. MCP：`list_reports` 带 publishedVersion；`revise_report_spec` 对已发布报表拒；`get_report_spec` 带草稿+已发布元数据。
11. 回归：现有报表 spec/查询/掩码/审计不变。

### 9.2 独立链接

1. `/r/:id` 无 `Menu`/`ProLayout`/管理按钮/报表列表；只有标题、期间控件、面板、页脚。
2. 390×844 视口：KPI 不挤压、表格横向滚动、页面不横向溢出、无遮挡。
3. 未登录访问 `/r/:id?v=1` → 登录后回到**同一路径+查询串**（#1060 回归）。
4. 未发布报表 → 「报表未发布」；无权限 → 「无权查看」；都不显示导航。
5. `?v=N` 显示「历史版本 vN」；期间切换仍可用。
6. 页面无 indexable 语义（`noindex`）。

### 9.3 真机

- 用熊喵月报：发布 v1 → 复制独立链接 → 手机浏览器/企微打开 → 无导航；改草稿 → 链接不变；发布 v2 → 链接变；`?v=1` 回旧版；回滚 → v3；下线 → 链接失效。
- 数据锚点与 B+C 设计一致（销售额 51,273.89 等）。

## 10 实施顺序与文件落点

| 步 | 内容 | 文件 |
|---|---|---|
| 1 | 迁移：版本表 + `published_version_id` + 回填 | `modules/data/migrations/022_report_versions.sql` |
| 2 | 存储层：版本 CRUD、发布/下线/回滚事务、`hasUnpublishedChanges` | `domain/report-store.ts`、`domain/report-version.ts`（新） |
| 3 | 路由：publish/unpublish/rollback/versions/published-spec/draft；`PUT` 平台行 409 | `routes/reports.ts`、`routes/context.ts`（如需） |
| 4 | manifest 声明新端点（装载期双向核对） | `modules/data/manifest.yaml` |
| 5 | MCP：`list_reports`/`get_report_spec` 带版本；`revise` 拒已发布 | `routes/mcp-report-tools.ts` |
| 6 | console：发布/下线/版本历史/独立链接/徽标；平台行隐藏改页门 | `console/reports/index.tsx` |
| 7 | 抽 `ReportView`；standalone 页面 | `console/reports/ReportView.tsx`（新）、`console/standalone.tsx`（新） |
| 8 | 宿主裸路由 `/r/:id` | `apps/web/src/App.tsx` |
| 9 | 测试 | `report-version.test.ts`、`reports.test.ts`、`mcp-report-tools.test.ts`、`console/reports/index.test.tsx`、`standalone.test.tsx`、`App.test.tsx`（新）、登录回跳用例 |
| 10 | 文档：模块协议“独立页”暂记为裸路由特例；`docs/architecture.md` 若涉及路由面 | `docs/module-protocol.md`（指针即可） |

## 11 已知边界与待决

1. **版本是定义版本，不是数据快照**：`?v=N` 用旧定义查当前数据；要冻结数字需另做数据快照/导出。
2. **Metabase 行不参与版本管理**：它没有平台 spec；Metabase 自己的 dashboard 历史另说。
3. **agent 不能发布/回滚**：`propose_report` 草稿、`revise_report_spec` 只改未发布草稿；已发布报表的草稿由人改。
4. **独立链接仅登录态**：不做公开/签名 token；接收者必须有平台账号（企微免登可用）。
5. **裸路由是 data 模块特例**：第二个模块需要独立页时再抽 `frontend.standalone` 协议。
6. **钉住旧版本用该版本快照的页门**：`?v=N` 按 vN 的 `required_scope` 判权；下线总闸（`published_version_id=null`）仍在，且 `/query` 的指标 scope/掩码继续兜底。
7. **下线是总闸**：一旦下线，历史版本链接也失效；重新发布后恢复（版本号继续前进）。
8. **回滚可能撞标题唯一键**：旧标题若已被别的报表占用，回滚更新 `title` 会失败 ⇒ 409 `TITLE_TAKEN`，不静默改标题。
9. **版本历史保留上限**：列表最多 100 条；表本身不自动清理（后续按需归档）。
10. **独立链接的期间控件是活的**：版本钉的是定义，不是当前选中的时间窗口；同一定义可切不同期间。

## 12 证据位置

- `data.reports` 表与 `version` 计数器：`modules/data/migrations/002_reports.sql:16-35`、`005_report_version.sql`、`007_report_spec.sql`
- 发布门派生：`modules/data/routes/reports.ts:314-337`；`domain/report-scope.ts:27-41`
- 草稿读取：`modules/data/routes/reports.ts:413-429`
- 写保护：`domain/report-store.ts:194-265`
- console 壳与路由：`apps/web/src/App.tsx:21-50`
- 登录回跳：`apps/web/src/pages/Login.tsx` 的 `nextTarget()`；#1060 查询串透传
- 租户隔离门禁：`scripts/check-tenant-isolation.mjs`
