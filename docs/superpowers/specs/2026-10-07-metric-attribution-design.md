# 语义追溯（操作人 + 版本）：口径的建 / 改 / 删留下「谁、何时、从什么到什么」

> 2026-10-07。兑现 issue **#489**（写路径无审计）；消费面复用**已经存在**的 console 指标页
> （`modules/data/console/metrics/index.tsx`）。上游口径：`2026-09-28-report-authoring-design.md` §4
> （语义写入面）与 `2026-10-07-mcp-write-face-design.md` §6.2（「写路径无审计」那条已知边界）。

## 0 一句话

给 `data.metrics` 的 L2 行加**最后操作人 + 版本**两列，另立**写审计表**记每次建/改/删（含口径快照），
在已有指标页的列表上加两列、行上开一个「变更历史」抽屉。

## 1 问题：不缺页面，缺的是「谁动的」

**先纠正一个容易走偏的前提**：语义层的可视化 CRUD **已经做完了** —— 指标页有列表（L1 平台 / L2 本租户
两层）、结构化声明表单（新建 / 编辑）、带确认的删除，且有单测覆盖「L1 只读、L2 可改可删」
「提交的 body 不含任何 SQL 字段」。**缺的只有一句半**：每条语义关联**操作人**与**版本**。

现状（2026-10-07 生产库实测）：

| 想知道 | 现在能靠什么 |
|---|---|
| 这条口径**什么时候**建/改的 | `data.metrics` 的 `created_at` / `updated_at`（**有时间**） |
| 这条口径**谁**建/改的 | **没有任何地方记** |
| 某条口径**曾经存在过、内容是什么、被谁删的** | **什么都不留**——行没了，时间戳随之消失 |

`data.query_audit` 是**查询专用**形状（`row_count` / `verdict` / `reason`），既无动作维度也无前后态，
写路径一行都没往里写（生产实测：一次完整的建→查→删往返，审计表**只多出读的那些行**）。

**为什么现在提**：MCP 写面（#486）之后，能改口径的人从「运维 + 租户管理员」扩到「任何一张带
`data:manage` 的 PAT 签出的 agent」。于是「对不上账时，谁把口径动了」从「理论上要答」变成「随时会被问」。

## 2 目标与非目标

**目标**：口径的建 / 改 / 删**可追溯到一个具体的人**（不是 key），并能在已有页面上看到；
删除**留证**（否则这条最贵的操作恰恰什么都没留下）。

**非目标**（写清楚，免得后面被当漏做）：

1. **不做回滚 / 撤销**——只做可追溯（#489 已定）；
2. **不做乐观并发**（`expectedVersion` 那套）——`data.metrics` 目前**无并发写案例**，
   按本仓「无案例不立标准」，出现再加（报表面的 `version` 当初是为「两个人同时编辑同一张报表」加的）；
3. **不做审计清理 / 归档**——无案例；只在 README 记一条边界（表会随时间增长）；
4. **`data.query_audit` 一行不动**——不合并、不迁移；
5. **L1 不参与**：平台口径由物化脚本写（`scripts/sync-data-semantics.mjs`），追溯走 **git**（仓内 dbt 声明 + PR），
   不经 API 改 ⇒ 本机制只覆盖 L2。

## 3 设计

### 3.1 存储（两处）

**（a）`data.metrics` 加两列**——迁移 `010_metric_attribution.sql`，幂等（`add column if not exists`）：

```sql
alter table data.metrics add column if not exists updated_by text;                       -- 最后操作人（Casdoor 用户名）
alter table data.metrics add column if not exists version    integer not null default 1;  -- 单调计数（照 005 报表先例）
```

**（b）新表 `data.metric_audit`**——写专用，与 `query_audit` 分开（见下 §4④）：

| 列 | 说明 |
|---|---|
| `id` | bigserial |
| `org` | 隔离键（text，= Casdoor org） |
| `metric_id` | 目标行（**删除后仍可查**——这正是本表存在的理由） |
| `action` | `create` / `update` / `delete` |
| `user_id` / `channel` / `key_id` | 身份三件套，口径与 `query_audit` **逐字一致**（channel ∈ session/pat/wecom） |
| `row_before` jsonb **NULL** | 变更**前**的行快照（建时为 NULL） |
| `row_after` jsonb **NULL** | 变更**后**的行快照（删时为 NULL） |
| `created_at` | 时间 |

**为什么是「前后两列」而不是「一个口径快照」**：§0 承诺的是「谁、何时、**从什么到什么**」——
只存一份后态就答不了「从什么」。两列的填充规则是完备且互斥的：

| action | row_before | row_after |
|---|---|---|
| `create` | NULL | 新行 |
| `update` | 旧行 | 新行 |
| `delete` | **被删的行** | NULL |

**快照内容** = 行的语义列（`title` / `description` / `subject_column` / `select_sql` / `group_by` / `params`），
即「口径 + 编译产物」都在里面（§4⑤）。⚠️ **注意**：L2 的**结构化声明**（base/alias/visibility/filters）
**本来就不落库**（库里存的是编译产物 + `description` 里的派生关系）⇒ 删除时能留的证就是**行快照**。
这是现状的边界，不是本设计的取舍；若要连声明一起留，得先让声明本身落库（另一件事）。

索引：`(org, metric_id, created_at desc)` —— 页面抽屉的查询形状。

### 3.2 写入点：唯一判定链里，且**与变更同事务**

审计写在 **`modules/data/domain/metric-write.ts`**（#486 抽出来的那条唯一判定链），因此：

- **两条入口（HTTP `POST/PUT/DELETE /metrics` 与 MCP 写面）自动都覆盖**，不必各写一份；
- 判定与审计**同源**：将来加闸门时不会出现「HTTP 记了、MCP 忘了」。

**同事务**是本设计的硬要求（「改了没记」与「记了没改」在取证上都是致命伤）：

```
取一个 client → BEGIN
  ├─ create：upsertMetric（version=1, updated_by=当前人）→ 写 audit(action=create)
  ├─ update：**先读出旧行** → upsertMetric（version+1, updated_by=当前人）→ 写 audit(action=update)
  └─ delete：**先读出被删行** → deleteMetric → 写 audit(action=delete, 带被删口径)
COMMIT
```

⚠️ **删除必须先读再删**——否则审计里没有「删了什么」，那正是当前最贵的缺口。
⚠️ **域层要拿到「人」**：`MetricWriteDeps` 现在只有 `{pool, adoptedSources}` ⇒ 必须加
**`requester: Requester`**（`userId` / `channel` / `keyId` 就是审计的身份三件套）。
**无身份（`requesterOf(c) === null`）⇒ 拒绝写入**，不写一条「无主」审计——这与 MCP 写面既有行为
（空身份返回 `unauthenticated`）统一，也把「写入必须能归属到人」变成结构约束而不是提醒。
⚠️ 事务化意味着 `metric-store` 的两个写入口不能再只收 `Pool`：把它们的连接参数类型放宽成
**`Pool | PoolClient`**（两者都有 `.query`，改的是类型不是实现），由 `metric-write` 在事务里传入 client。
**这一步是本设计里唯一有技术风险的地方**（现有实现是 `pool.query` 裸调，非事务）。
⚠️ `upsertMetric` 还要多收一个 **`updatedBy: string`**（落到 `updated_by`，并把 `version` 在冲突分支 +1）。
它是**必填**（不给默认值）：给了默认值就等于留了一条「不写人也能写库」的暗道，
而本设计全部意义就是堵它。**代价**：现有 **17 个调用点**（`grep -rn "upsertMetric("` 实测，
其中绝大多数是测试夹具）要一起改，夹具传一个字面量（如 `'fixture'`）即可——机械改动，编译器会逐个点名。

### 3.3 读：新端点（门 = `data:manage`）

| 端点 | 形状 |
|---|---|
| `GET /metrics/:id/audit` | 该 id 的变更列表，时间**倒序**；每行含 action / 身份三件套 / declaration / select_sql / created_at |
| `GET /metrics/all`（**改**） | 每行补 `updatedBy` / `version` —— 列表两列的数据源（避免页面为每行再打一次请求） |

门档与 `GET /metrics/all` 同（都是管理面动作：能看到「谁改的」本身就是管理信息）。

### 3.4 页面（改已有的 `console/metrics/index.tsx`）

- 列表**加两列**：**最后操作人**、**版本**；
- 行上**加「变更历史」按钮** → 抽屉（时间倒序：动作 / 人 / 通道 / 时间 / 口径摘要；**删除行标红**）；
- **L1 行**两列显示「平台物化（追溯走 git）」——刻意不显示空白，否则会被读成「这里缺数据」。
- 表单不动（新建 / 编辑 / 删除的行为一行不改）。

## 4 不变量（本设计的硬核）

① **审计与变更同生共死**：同一事务，要么都成、要么都不成。
② **审计只有一个写入点**：`domain/metric-write.ts`；绕过它直接写存储 = 漏审计（用承重断言钉住，见 §5）。
③ **删除必须在删之前留证**：否则「删了什么」不可复原。
④ **写审计与查询审计分表**：两者语义（动作 vs 结果）与频度（低频治理 vs 高频问数）都不同；
若硬塞进 `query_audit`，其 `row_count/verdict/reason` 必须全部变 nullable —— 「没有 row_count」
将同时表示「这是写行」与「这次查询没出数」，语义立刻模糊。**「同一张审计面」的精神是一个查询入口**，
不是物理同表；本条在 README 记明。
⑤ **给人看的是口径，留下的证是 SQL**：行快照里两者都在——给人看的是 `title` / `description`，
取证用的是 `select_sql` / `group_by` / `params`；它们同存于 `row_before` / `row_after`，各有各的读者
（与 `2026-09-28` 稿 §4.4「确认时给人看的是口径」不冲突）。
⑥ **读侧的范围必须说清**（否则会与既有约定打架）：`domain/audit-store.ts` 的文件头写着
「**只写不读**：审计的读侧（平台运营面）不在本模块，故这里没有 query 函数——**别顺手加**」。
本设计新增的读侧**不是**那条被推迟的东西：它是**租户对自己单条口径的历史**
（门 = `data:manage`、按 `(org, metric_id)` 限定），不是平台运营面的全局审计视图。
⇒ 落实方式：`query_audit` **保持只写、一行不改**；新表的写**与**读都放进**新文件**
`domain/metric-audit-store.ts`，并在该文件头把这条区分写明白。**不许**把读函数加进 `audit-store.ts`。

## 5 测试与验收

| # | 断言 | 为什么它值得存在 |
|---|---|---|
| 1 | 域层：建 / 改 / 删**各落一行**审计，字段齐（action / 身份三件套 / declaration / select_sql） | 地基 |
| 2 | 域层：**改**记的是新口径、**删**记的是被删时的口径（不是删后的空） | 钉住 §4③ |
| 3 | 域层：`version` 单调 +1、`updated_by` = 当前人 | 列表两列的真值 |
| 4 | 域层：**审计写失败 ⇒ 变更回滚**（注入一个必然失败的审计写入） | 钉住 §4①（同事务），且这是唯一能证明「同事务真的生效」的方式 |
| 5 | 路由：`GET /metrics/:id/audit` 的门是 `data:manage` | 与管理面同档 |
| 6 | **承重断言**：两条入口（HTTP 与 MCP 写面）各跑一次建/删，**各自都落审计** | 防「绕过 metric-write 直接 upsertMetric」——这是最可能的漏法 |
| 7 | 页面：两列渲染、抽屉拉取并渲染删除行、L1 行的「平台物化」文案 | 可见面 |
| 8 | 迁移幂等：`010` 连跑两遍零效果（本仓迁移纪律） | 部署脚本每次全量重跑 |

**端到端验收**（照 #489 的验收建议）：跑一次「建 → 查 → 删」往返，审计里能**完整读出这三步**
（建/删各一行、带人与口径；查询那步在 `query_audit`，两张表各司其职）。

## 6 落地物与建议顺序

| 序 | 落点 | 内容 |
|---|---|---|
| 1 | `modules/data/migrations/010_metric_attribution.sql` | 两列 + 新表 + 索引（幂等） |
| 2 | `modules/data/domain/metric-audit-store.ts`（新） | 写审计 + 读历史（照 `audit-store.ts` 的风格，**但**写清与它的分工，见 §4⑥） |
| 3 | `modules/data/domain/metric-store.ts` | 两个写入口连接参数放宽成 `Pool \| PoolClient`；`upsertMetric` 加必填 `updatedBy`（并 +1 `version`）；**连 17 个调用点一起改** |
| 4 | `modules/data/domain/metric-write.ts` | deps 加 `requester`；事务包裹；改/删前先读旧行；写审计（唯一写入点） |
| 5 | `modules/data/routes/metrics.ts` | `GET /metrics/:id/audit`（新）+ `/metrics/all` 补两列 + 无身份拒写 |
| 6 | `modules/data/manifest.yaml` | 声明新端点（装载期双向核对会盯） |
| 7 | `modules/data/console/metrics/index.tsx` | 两列 + 历史抽屉 |
| 8 | `modules/data/README.md` | 审计分表的口径 + 三条边界（表增长 / L1 不参与 / 无回滚） |

## 7 已知边界与未验

1. **L1 无追溯**（设计如此）：平台口径的变更史在 **git**，不在平台库里。页面上以文案显式说明。
2. **审计表会随时间增长**：本设计不清理。量级估算：只随**写**增长（低频），但长期无界——
   若将来成问题，另立「审计保留」议题（报表面有 `audit 保留 runbook` 可参照）。
3. **未验**：`metric-store` 现有写入口改成事务后，与既有并发测试的相互作用**未验**
   （本仓有过「并发类测试的红只在**全新空库**上复现、已迁移过的库会掩盖」的历史）；
   ⇒ 实施时必须先 `createdb` 一个**空库**再跑本包全量，别在已迁移的库上验收。
4. **未验**：抽屉在「某条口径被删后又用同 id 重建」时的历史归属——本设计按**同 id 同一条历史**处理
   （审计表只按 `(org, metric_id)` 归集），若这不符合预期，需要引入「行实例 id」。

---

## 附：与其他文档的关系

- 兑现 **#489**（写路径无审计）——本条即那次记账的展开；#489 的四个待定问题在本稿 §3.1/§3.2/§4④ 逐条落定。
- 消费面**复用**已有页面（`2026-09-28` 稿 §4.4 的「给人看的是口径」在 UI 上已经做到）。
- 与报表面 `version`（迁移 005）**同形不同因**：报表那条是为**乐观并发**，本条是为**追溯**；
  故本条**不**引入 `expectedVersion`（§2.2）。
