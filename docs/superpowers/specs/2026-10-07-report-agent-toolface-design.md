# 报表 agent 制作通路（MCP 工具面）：能提、不能发

> 2026-10-07。上游：`2026-09-28-report-authoring-design.md` **§8 步骤 5**（agent 制作通路：工具面——选指标/选维度；写规格，
> 「**放最后**，因为前四步是它的前提」）与 **§4.3**（「提议 ≠ 直接新建」，且**这条不能只写在提示词里——它得是工具面的结构**）。
> 现状断言全部按 2026-10-07 的**代码实测**，不是照抄文档。

## 0 一句话

把报表制作的工具面挂进**已有的管理面 MCP 端点**（`/mcp-manage`）：agent 能**列指标与维度、看已有报表、提一张新报表、
改未发布报表的规格**；而「发布」「回收」**在工具集里根本不存在**。

## 1 前提核对：步骤 1–4 已落地（否则不该开这一步）

| 上游步骤 | 实测 |
|---|---|
| 1 底座：renderer 列 + 发布路径三件套 + 对账判据加厚 | ✅ `data.reports` 有 renderer/spec/version；`POST /reports/reconcile` 的判据已加厚（`routes/reports.ts` 里「参数没声明 / 卡带 `{{tenant}}` 标签但没映射」那一族，含 2026-09-29 的单卡粒度人裁） |
| 2 写保护：版本守卫 + 锁 | ✅ `PUT /reports/:id` 与 `/spec` 都走 `withObjectLock(\`${org}/row:${id}\`)` + `expectedVersion`（陈旧 ⇒ 409 `STALE_WRITE`） |
| 3 管理面：列表 / 页门 / 发布 / 回收 | ✅ `GET /reports/manage` + `PUT /reports/:id` + `DELETE`；console 有页（`console/reports/index.tsx` + `SpecView.tsx`） |
| 4 反代与会话（编辑页进 console） | ✅ `GET /reports/:id/edit-url` |

**报表面现有 10 个端点**（建/改/删/清单/管理清单/spec 读写/edit-url/embed-url/reconcile）；**manifest 里没有 `tools`** ⇒ 唯一缺口就是本稿。

## 2 报表模型里没有 `published` 状态：「页门」就是审批面（本稿的结构基础）

| 概念 | 实际是（`modules/data/README.md`「管理面」一节） |
|---|---|
| 发布（所有人可见） | **页门清空**：`PUT /reports/:id` body `{"requiredScope": null}` |
| 未发布 | 页门挂一个 scope（观看面按行裁，管理面不裁） |
| 回收 | `DELETE /reports/:id` |

⚠️ **`POST /reports` 的 `requiredScope` 缺省就是 `null` = 发布** —— README 专门记着这个陷阱（「重登记会静默把页门
清成所有人可见」）。⇒ **在现状下，「agent 直接新建」就等于「agent 直接发布」**（缺省即发布）。这就是本稿必须
让工具面在**结构上**堵住它的原因。

## 3 设计

### 3.1 端点：扩已有的 `/mcp-manage`

它是**管理面**端点，门是 `data:manage`（manifest 声明）——**报表制作本身就是管理动作，受众与门档完全一致**
⇒ 直接加工具，不新开端点（少一个端点、客户端少配一个 server）。manifest 里那段自述从「本租户口径的定义」
放宽为「**管理面：口径 + 报表**」。

### 3.2 工具集（四个）

| 工具 | 干什么 | 结构性约束 |
|---|---|---|
| `list_metrics` | **复用现有的**（基底 L1 + 本租户口径，各带 `dimensions`）⇒ 「选指标 / 选维度」一步到位 | 只把描述放宽到「定义口径 / **制作报表前**先调它」——**不新增读工具**（同一份事实不立第二个工具面） |
| `list_reports`（新） | 管理清单：title / renderer / **页门** / 版本 / 规格摘要 —— **查重**用 | 对应 §4.3「提议会**先让它看到候选**」 |
| `propose_report`（新） | 建一张 `renderer='platform'` 的报表；spec 走**既有** `parseReportSpec` 白名单 | ⚠️ **不收 `requiredScope` 入参**；平台**强制**写 `data:manage`（§3.3①）。⚠️ **走 create-only，撞名即拒**（§3.3④） |
| `revise_report_spec`（新） | 改报表规格（映射既有 `PUT /reports/:id/spec`），带 `expectedVersion`（沿用写保护） | ⚠️ **先读页门，非空才动**；已发布 ⇒ 拒（见 §3.3②） |

**不给的**：改页门 / 发布、回收 —— 工具集里**根本不存在**这两个工具。

### 3.3 「能提、不能发」的三条结构落点

① **建报工具没有 `requiredScope` 入参** ⇒ **造不出「已发布」**：那个「缺省即发布」的陷阱从结构上消失。
   平台强制写入的页门值取 **`data:manage`**——语义是「**只有管得住的人能看到**」，与现状「未发布 = 页门挂一个
   scope」的模型一致（**零新状态**），人之后在 console 把它改成真实页门、或清空即发布。
② **`revise_report_spec` 先读页门，非空才动** ⇒ agent 碰不到员工看得到的东西（已发布报表的规格改动一律回 console）。
③ **发布 / 回收工具不存在** ⇒ 想发也发不了。
④ **撞名即拒（create-only）** ⇒ agent **改不了任何既有报表**。理由是本稿验证时挖出来的：
   `POST /reports` 的冲突键是 **`(org, title)`**，`on conflict … do update set … required_scope = excluded.required_scope`
   —— 同名的「新建」实际是**改写既有行**（换规格 + **重置页门**）：若那张报表**已发布**，它会**静默从员工视野消失**，
   且**绕过 §3.3②**（那条只护 `revise_report_spec`）。⇒ `propose_report` 必须走**原子 create-only**
   （`insert … on conflict do nothing`，无行返回即「撞名」⇒ 拒 `TITLE_TAKEN`），而**不是**「先查再写」
   （后者在并发下仍会把既有行改掉）。实现：给 `upsertReport` 加显式模式参数（`'upsert'` 默认 / `'create-only'`），
   一处 SQL 两个分支，不复制列清单。

四条合起来 = §4.3 的「提议 ≠ 新建」**落在结构上**，不靠提示词。

### 3.4 复用与单一事实源

| 面 | 复用什么 | 为什么 |
|---|---|---|
| 规格白名单 | `domain/report-spec.ts` 的 `parseReportSpec`（严格白名单 + 图型常量） | 与 HTTP 面同一份判据；另写一份 = 第二个事实源 |
| 建 / 改 | `domain/report-store.ts`（`upsertReport` / `getReport` / `updateSpec`） | 同上；且**写保护与对象锁**自动继承 |
| 读清单 | `domain/report-store.ts` 的管理清单读取（与 `GET /reports/manage` 同源） | 同上 |

**HTTP 面与 console 一行不改**：本稿只加一个工具面，不改既有行为。

### 3.5 文件分片（写面已经长到该拆了）

| 文件 | 职责 |
|---|---|
| `routes/mcp-manage.ts` | **只做合成 + 注册**：把两片工具集拼成一个 `McpToolSet` |
| `routes/mcp-metric-tools.ts` | 口径三工具（从现 `mcp-manage.ts` **原样搬**，注释与判定一行不改） |
| `routes/mcp-report-tools.ts` | 报表**三**工具（`list_reports` / `propose_report` / `revise_report_spec`；**本稿新增**。`list_metrics` 不在这片——它属口径片，两片共用一个） |

## 4 不变量

① **建出来的报表页门必然非空**（agent 无法产出「已发布」的报表）。
② **已发布报表的规格改动不经 agent**（`revise_report_spec` 先查页门）。
③ **发布 / 回收不是工具**（工具集里没有这条路）。
③′ **agent 改不了既有报表**：`propose_report` 走 create-only（撞名即拒），`revise_report_spec` 只碰未发布行。
④ **规格白名单只有一份**（`parseReportSpec`）；**写保护与锁只有一份**（`report-store` + 对象锁）。
⑤ **门档不变**：仍由宿主按 `/mcp-manage` 的 `data:manage` 声明施加；工具面不写授权代码。

## 5 非目标

1. **不做报表「读数据」**——那是问数面（`/mcp` 的每指标一工具）的事；
2. **不做 Metabase 报表的 agent 通路**——嵌入要凭据，§3④ 已把「agent 不持凭据」写成硬约束；
3. **不做发布 / 回收 / 改页门**（§3.3③）；
4. **不改 HTTP 面与 console**；
5. **不给 agent 建报时指定 id 的能力**（id 由平台生成 ⇒ 结构上抢不了既有 id）。

## 6 测试与验收

| # | 断言 | 为什么它值得存在 |
|---|---|---|
| 1 | `list_reports` 回管理清单（含页门与版本），且**含未发布行**（管理面不裁） | 查重的前提 |
| 2 | `propose_report` 成功 ⇒ 行落库，`renderer='platform'`，**`requiredScope` 非空** | ★ 承重断言① |
| 3 | ★ **承重断言②**：对**已发布**（页门为 null）的报表调 `revise_report_spec` ⇒ **拒**，且行未变 | 「能提不能发」的正面落点 |
| 3′ | ★ **承重断言③**：与**既有报表同 title**（尤其已发布那张）调 `propose_report` ⇒ **拒 `TITLE_TAKEN`**，且既有行的**规格与页门一字未动** | 本稿验证时挖出的改写漏洞的正面落点 |
| 4 | 对**未发布**的报表 `revise_report_spec` ⇒ 成功、版本 +1；陈旧 `expectedVersion` ⇒ 拒 | 复用写保护的证据 |
| 5 | 规格白名单：白名单外的图型 / 多塞一个字段 ⇒ 拒（沿用既有码） | 与 HTTP 面同判据 |
| 6 | ★ **变异确认**：把「强制页门」改成 `null` ⇒ 断言 2 **必须变红** | 判据只有变异确认（本仓口径） |
| 7 | 工具集里**不存在**发布/回收类工具：`tools/list` 的名字集合恰为那六个，`publish_report`/`delete_report` 一类查不到 | 结构约束的机检落点 |

## 7 落地物

| 序 | 落点 | 内容 |
|---|---|---|
| 1 | `routes/mcp-metric-tools.ts` | 从 `mcp-manage.ts` **原样搬**口径三工具（纯重构，既有测试不改必须全绿） |
| 2 | `routes/mcp-report-tools.ts` | 报表四工具 + 承重约束 |
| 3 | `routes/mcp-manage.ts` | 改成合成 + 注册 |
| 4 | `routes/mcp-report-tools.test.ts` | 上表 7 条 |
| 5 | `modules/data/manifest.yaml` | 自述放宽为「管理面：口径 + 报表」（**声明本身不变**——端点没变） |
| 6 | `modules/data/README.md` | 记：报表工具面「能提不能发」的口径 + `data:manage` 作为未发布页门值的约定 |

## 8 已知边界与未验

1. **`data:manage` 作为「未发布」页门值是约定，不是新机制**：它借用既有「页门 = 一个 scope」的语义，
   含义是「只有持 `data:manage` 的人能在观看面看到」。若将来出现「某租户没有这个码」的形态，要回来重估。
2. **未验**：真实 MCP 客户端在本端点工具数从 3 涨到 **6**（口径三 + 报表三；`list_metrics` 两片共用）后的表现
   （分页 / 工具上限）——**没拿真客户端连过**。
3. **`POST /reports` 的冲突键是 `(org, title)`**（`on conflict … do update`）—— 这正是 README 记的
   「重登记重置页门」的机制。本稿**不**依赖它：`propose_report` 走 create-only（§3.3④），
   所以「同一个 title 不能建第二张」是**结构**结果（撞名即拒），不是靠 `list_reports` + 提示词。
   ⚠️ 代价：agent **无法**用同一个 title 迭代同一张报表（改名或走 `revise_report_spec`）——这是有意的取舍。

---

## 附：与既有文档的关系

- 兑现上游 spec 的 **§8 步骤 5**（最后一步）；§4.3 的「提议 ≠ 新建」在本稿 §3.3 落成三条结构约束。
- 与 `2026-10-07-mcp-write-face-design.md`（口径写面）**共用同一个端点与协议壳**，工具集分片不混。
- §4.1 的三个落点表不变：L2 = 租户一键（已实现）；L1 草案 = PR（**不经 MCP**，仍走我方评审）。
