# 指标语义治理（变更单 · 试算 · 归属 · 解析）——设计

> 状态：设计已与用户逐条确认（2026-11-12），待实施计划。
> 关联：`docs/architecture.md`（模块不变量）、`docs/module-protocol.md`（声明即授权）、
> 开发地图 `docs/superpowers/plans/2026-11-11-helix-borrow-roadmap.md` §6 候选池。

## 1. 背景：三个已经成立或即将成立的失败形态

1. **人手工建指标有风险** → 已收口 UI 新建入口（PR #2030），但「agent 建」还没有评审闭环：
   agent 经 `customize_metric` 直接写生效行，人无从核对。
2. **采纳前看不到数** → 草稿（`draft_spec`）对查询不可见，且草稿是 creator-scoped
   （`metric-governance.ts` 的 `created_by = requester`）。「先核对再采纳」在现有架构上不成立。
3. **同名不同义** → 两个部门各有一个「营业额」，今天只能靠 `title` 字符串混；
   `search_catalog` 按分数排序返回列表，**同名同分没有 tie 检测**，模型可能随意挑一个。

## 2. 目标 / 非目标

**目标**

- agent 负责一切指标实现（新建 / 改定义 / 元数据 / 覆盖 / 删除），**永不直接生效**。
- 人只做一件事：看试算结果 → **采纳**或**驳回（必填原因）**。
- 同名不同义在结构上不可能混淆：概念同一、id 唯一、部门内同名互斥、歧义必须澄清。
- 指标接入权限体系：归属部门决定默认可见范围，且**按 id 查询也要拦**。

**非目标**

- 不做站内问数（已定案，问数只走 MCP）。
- 不按「人」解析语义（同一问题不同人不同答案）；解析只按**可见集合**做确定性收敛。
- 不引入图数据库 / LLM ontology；复用现有 `entity` + `synonyms` + `semantic_relation`。
- 不改数据面（dbt / duckle / 湖）的既有契约。

## 3. 不变量

1. **生效只有一条路：人采纳。** 任何 agent 通道（MCP / PAT / 企微）都不能直接写生效行。
2. **数字只认 id，名字只做展示。** 报表、审计、导出一律钉 `metric id`；重名必须带部门限定。
3. **同名解析必须确定且可解释。** 可见集合内唯一 → 直接用并标注口径；≥2 个 → 澄清。
4. **权限判定单一实现。** 列表与查询共用同一个 `canViewMetric`；禁止第二份。

## 4. 架构分层

```
消费面   MCP(openclaw/三方) · 报表(PC/移动)
治理面   变更单 · 试算快照 · 采纳/驳回 · 审计 · 对账 · 使用统计
语义层   entity(概念) → 变体(owner_dept) → 编译产物(select_sql)
权限层   required_scope · 部门可见性 · 数据范围 RBAC · 掩码
数据面   dbt/duckle/湖（现状不动）
```

## 5. 数据模型

### 5.1 `data.metrics` 增列（P1 落地；编号按仓内下一可用，预计 047）

```sql
alter table data.metrics
  add column if not exists owner_dept   text,      -- 归属部门（platform.v_org_node.node_id）；NULL = 平台通用
  add column if not exists visible_depts text[],   -- 显式共享；NULL = 仅按 owner_dept 部门链
  add column if not exists variant_note text,      -- 同 concept 下「差在哪」的一句话（同名必填）
  add column if not exists reveal       text not null default 'panel';
alter table data.metrics drop constraint if exists metrics_reveal_check;
alter table data.metrics add constraint metrics_reveal_check check (reveal in ('panel','report'));
```

- `entity` / `synonyms`（031 迁移，现仅 L1 写）**开放给 L2**：变更单 payload 可带，
  校验 `entity ∈ 已声明实体 ∪ 本租户新增概念`（见 §5.3）。
- 唯一约束（部门内同名互斥）：

```sql
create unique index if not exists metrics_title_per_dept_uq
  on data.metrics (org, coalesce(owner_dept, ''), lower(title));
```

  平台桶（`org='platform'`）天然不受影响；同部门第三个「营业额」在写入时被数据库拒绝。
- `reveal='report'` 用于成本/毛利/工资一类：无权限即整表拒（见 §9.4）。

### 5.2 `data.metric_change` 新表（**P0 落地**；迁移 046——P0 先于 P1 合入）

```sql
create table if not exists data.metric_change (
  id            bigserial primary key,
  org           text not null,
  metric_id     text not null,
  kind          text not null check (kind in ('create','update','meta','override','delete')),
  payload       jsonb not null,           -- 声明 / 元数据 / 覆盖 / 删除说明（形状随 kind）
  status        text not null default 'draft'
                check (status in ('draft','preview_ready','preview_failed','adopted','rejected','superseded','withdrawn')),
  preview       jsonb,                    -- 试算快照（§6.2）
  submitted_by  text not null,
  submitted_channel text not null,        -- pat / wecom / session
  submitted_at  timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,
  reject_reason text,
  adopted_snapshot jsonb                  -- 采纳时的快照副本（不可变，留证）
);

-- 同一指标同时只允许一张未决单：避免「两份草稿互相覆盖」的老问题（评审 #1271-#7）
create unique index if not exists metric_change_one_pending_uq
  on data.metric_change (org, metric_id)
  where status in ('draft','preview_ready','preview_failed');

create index if not exists metric_change_queue_idx
  on data.metric_change (org, status, submitted_at desc);
```

### 5.3 概念（entity）

- 复用 L1 声明里的 `entities`（`dbt/semantics/l1_metrics.yml`，已含 synonyms / identity_keys /
  system_of_record / merge_rule / owner）。
- 租户新增概念落 `data.metric_concept`（P1 落地，`org/name/label/synonyms/owner_dept`），
  写侧校验 `entity ∈ 平台概念 ∪ 本租户概念`；平台概念只读。
- **不新建第二套概念词表**：L1 的 `entity` 是同一字段。

### 5.4 回填

| 对象 | 规则 |
|---|---|
| L1 行 | `owner_dept = null`（平台通用），`reveal='panel'` |
| 现有 L2 行 | `owner_dept = null`（保持全租户可见，不制造静默收缩）；`entity` 只在**能确定基底**时继承（W8 `declaration.baseMetric` 或 `override_of` 可解出），其余留空——**不按 description 文本猜** |
| `variant_note` | 回填为空；**下次修改该行时若 title 在同部门重复，强制补** |

## 6. 试算（preview）

### 6.1 流程

1. `POST /metric-changes` 落单（`draft`）。
2. 同步编译：**复用唯一编译点**（`semantic-compiler` / `writeL2Declaration` 同一份），
   编译失败 ⇒ 整单 400，不落库（`INVALID_DECLARATION`）。
3. 只读池跑窗口聚合（`analystPool`），`statement_timeout` 上限 10s、行数上限 1。
4. 成功 ⇒ `preview_ready` + 快照；失败（源不可用/超时）⇒ `preview_failed`，**不可采纳**。

### 6.2 快照形状

```json
{
  "window": { "from": "2026-11-01", "to": "2026-11-12", "tz": "Asia/Shanghai" },
  "value": 1102340.12,
  "rows": 12,
  "baseline": { "id": "lemeng:retail:net_sales", "value": 1234567.89, "deltaPct": -10.71 },
  "sample": [ { "dims": { "branch_num": "001" }, "value": 12345.6 } ],
  "compiledHash": "sha256:…",
  "ranAt": "2026-11-12T09:00:00Z",
  "durationMs": 412
}
```

- **baseline**：派生类取同 `entity` 最近的平台口径（或声明里的 `baseMetric`）同窗值；
  表达式类取各基底分别求和；声明类无 baseline，给 `sample`（按 grain 前 10 组）。
- 快照不可事后改写；重跑生成新快照并覆盖 `preview`（审计留旧值）。

### 6.3 成本与失败态

- 试算走只读池，受既有明细/查询并发闸约束；超时按 `preview_failed` 落单，人可见但不可采纳。
- 同一指标重跑试算有速率限制（每单每分钟 1 次），防 agent 刷。

## 7. 采纳 / 驳回

| 端点 | 规则 |
|---|---|
| `POST /metric-changes/:id/adopt` | **只认会话**（`REQUESTER_CHANNEL === 'session'`）；`preview_ready` 才可采纳；走唯一编译点写生效行；写 `adopted_snapshot`；发 `data.metric.definition.changed` 通知 |
| `POST /metric-changes/:id/reject` | 只认会话；`reject_reason` 必填（1–500 字）；`status=rejected` |
| `POST /metric-changes/:id/withdraw` | 提交者本人可撤回（`withdrawn`） |

- PAT / 企微通道打决策端点 ⇒ **403 `DECISION_REQUIRES_SESSION`**（结构性禁止自审）。
- 同一指标再次提交 ⇒ 旧的未决单自动 `superseded`（保留历史）。

## 8. 指标权限归属

### 8.1 有效可见集合

```
可见(指标, 观看者) =
    指标.owner_dept 为空            ⇒ 全租户（仍受 required_scope 约束）
  ∪ 观看者部门 ∈ 归属部门链         部门链 = 自身 ∪ 全部祖先 ∪ 全部后代
  ∪ 观看者部门 ∈ visible_depts      visible_depts 非空时追加的显式共享集合（兄弟部门靠它开）
```

- 兄弟部门默认不可见（这是「同名不撞车」的来源）；要开就写进 `visible_depts`，并走授权变更。
- 观看者多部门归属 ⇒ 取并集。
- 观看者无部门信息（membership 缺失）⇒ 只能看 `owner_dept` 为空的指标（fail-closed）。
- 显式共享是一次**授权变更**：走变更单 + 人采纳 + 审计，不能由报表作者自行勾选。

### 8.2 与既有权限的组合

```
能查 = required_scope ∧ 已接入源 ∧ 可见(指标, 观看者)
```

`data:cost` / `data:precise` 独立判定，不并入部门规则。

### 8.3 执法点（同一函数，五处调用）

| 位置 | 行为 |
|---|---|
| `GET /metrics`、`list_metrics`、`search_catalog` | 过滤（列表） |
| `POST /query`、`query_metric`、`explore_*` | **按 id 拦**；不可见 ⇒ 404（沿用跨租户惯例，避免枚举） |
| `POST /query/detail` | 继承指标的可见性，不能绕过 |
| 报表渲染 | 面板级 fail-closed（§9） |
| 移动端 | 复用同一 API，天然同源 |

函数签名：`canViewMetric(metric, viewer, org): boolean`，放 `domain/metric-visibility.ts`；
**列表与查询必须 import 同一份**，`check-*` 门禁加静态断言（禁止第二处实现）。

## 9. 报表 × 指标可见性

### 9.1 发布门（静态校验，硬阻断）

```
报表受众 = required_scope ∩ required_depts ∩ ACL
要求：报表受众 ⊆ 每个面板指标的可见范围
不满足 ⇒ 409 REPORT_METRIC_SCOPE_MISMATCH，回包指名 panels / metrics / 差集部门
```

三种合法出路：缩受众 / 显式共享指标（授权变更）/ 换指标 id。**不允许**静默换口径或降级为 0。

### 9.2 渲染闸（运行时，fail-closed）

- 平台自绘报表：逐面板判；无权 ⇒ 该面板渲染「无此口径权限」，其余正常；写 denial 审计。
- **Metabase 报表做不到面板级**（平台不知道其内部字段）：只能整表级——
  受众必须 ⊆ 声明 `metricIds` 的可见范围交集，否则不许发布。

### 9.3 泄露策略 `reveal`

| 值 | 行为 |
|---|---|
| `panel`（默认） | 面板级降级 |
| `report` | 报表中存在任一此类指标且观看者无权 ⇒ **整表 404**（防「总数 − 其他」反推） |

**谁能设 `reveal`**：只有**租户 L2 行 / 覆盖行**可设（变更单 payload 是唯一写入口）。平台
L1 行恒 `panel`——成本 / 毛利 / 工资一类敏感口径若落在平台词表上，**本机制覆盖不到**；若平台
口径也需要 `report` 语义，需另设写入机制（如 sync 声明带上该字段），**本波不做，记待议**。
租户自建的同名变体（L2 / 覆盖）可按下面的 payload 面设 `report`。

**写入面（P6 Task 4 起）**：**变更单 payload 是唯一写入口**——create/update 档顶层（与
`entity/synonyms/ownerDept/variantNote` 同栖）以及 override/declaration 档 entry 顶层都可带
`reveal: 'panel' | 'report'`。提交期 zod 校验闭集，列 CHECK（047）兜底（23514 ⇒ 400），
非字符串值采纳期 400（不静默）。缺席语义：**新行 = `panel`**（列默认）；**update 缺席 =
保留既有**（coalesce，普通内容写不得把泄露策略洗回 `panel`）。L1 sync 声明没有这个字段
（平台行恒 `panel`，见上）。

### 9.4 一致性巡检

每日 job 校验「已发布报表受众 vs 面板指标可见范围」，漂移入待办（不自动改报表）。

## 10. 同名解析与澄清

- `search_catalog` 增加 **tie 检测**：最高分并列 ≥2 条且 title/同义词相同 ⇒ 返回
  `ambiguous: true` + 候选（含 `id / title / dept / variantNote`），并在 guide 里要求先澄清。
- 回答信封增加 `caliber`：`{ id, title, dept, variantNote }`；所有答案必须能回答「按哪个口径」。
- 解析顺序：可见集合内唯一 → 用；多候选 → 澄清；零候选 → 明确说没有（不猜）。
- 报表/审计/导出永远落 id。

## 11. Agent 工具面

| 工具 | 变化 |
|---|---|
| `customize_metric` | **语义改为提交变更单**（不再直接写生效行），回 `{ changeId, status, preview }` |
| `delete_custom_metric` | 同上（`kind=delete`） |
| `submit_metric_change`（新） | 统一入口：create/update/meta/override/delete |
| `list_metric_changes`（新） | 自己提交的单 + 状态 + 驳回原因（agent 修订依据） |
| 采纳 / 驳回 | **不提供工具**；端点只认会话 |

## 12. 人面收口

- PC 指标页：删「编辑 / 元数据 / 覆盖口径 / 删除 / 认证 / 新建」全部写入口；保留只读清单 +
  口径展开（TechDetails）。**认证不再是独立按钮**：L2 采纳即生效，`certified` 由采纳动作置位
  （撤回认证走「提交一个降级变更单」，同样需要人采纳）。
- 新增「待核对」区（或页签）：一条变更单一行，显示 变更摘要 / 试算值 vs 参照值 / 差异；
  动作只有「采纳 / 驳回」。
- 移动端：指标页改纯只读；待核对入口可选（P6 评估）。

## 13. 错误码（新增）

| 码 | 含义 |
|---|---|
| `INVALID_DECLARATION` | 提交的声明编译不过 |
| `PREVIEW_UNAVAILABLE` | 试算失败/超时 ⇒ 不可采纳 |
| `DECISION_REQUIRES_SESSION` | 决策端点被 PAT/企微调用 |
| `CHANGE_ALREADY_PENDING` | 同指标已有未决单（先撤回或等结论） |
| `TITLE_EXISTS_IN_DEPT` | 同部门同名已存在（提示补 `variant_note` 或换名） |
| `REPORT_METRIC_SCOPE_MISMATCH` | 报表受众超出指标可见范围 |
| `METRIC_NOT_VISIBLE` | 按 id 查询越权（对外 404） |

## 14. 兼容与回滚

- 开关 `DATA_METRIC_REVIEW_MODE=on|off`（默认 `on`）。`off` 时 agent 写回旧行为（直接生效），
  用于线上回滚；**只保留一个发布周期**，之后删除旧分支。
- 迁移全部幂等（`if not exists` / `add column if not exists`）。
- 新端点必须在 `manifest.yaml` 的 `api.internal` 同提交声明（装载期双向核对）。

## 15. 测试策略

- 单测：状态机（含 `superseded` / 并发采纳）、`canViewMetric` 真值表（平台/部门链/共享/无部门）、
  tie 检测、`reveal` 两档、发布门差值报告。
- 路由：agent 提交 → `preview_ready`；无快照采纳 ⇒ 409；PAT 采纳 ⇒ 403；驳回原因必填。
- UI：待核对渲染试算/差异；写入口不存在（`queryByText` 为 null）。
- 迁移：空库跑两遍；老数据回填断言。
- 端到端：一条部门口径从提交到采纳，报表在兄弟部门视角下的降级/404 行为。

## 16. 验收指标

| 指标 | 目标 |
|---|---|
| 未试算即采纳 | 0 |
| 同名被"猜" | 0（只允许澄清） |
| 口径变更可回溯（谁提/谁批/当时数值） | 100% |
| 报表引用随部门变化而漂移 | 0（id 钉死） |
| 报表受众超出指标可见范围仍发布 | 0（发布门阻断） |
| 部门树错误导致选错口径 | 0（前置一致性检查） |

## 17. 风险与前置

1. **部门树可信度是硬前置**：P2 开工前先做组织架构一致性检查（人数/层级/重复/空分支），
   不过检不开 P2。
2. **试算成本**：窗口默认 7 个完整业务日；超时降级为 `preview_failed`（仍不可采纳）。
3. **agent 质量**：硬门能兜住"胡说"，但受理量可能上升；前两周人工盯驳回率。
4. **Metabase 能力边界**：只能整表级，必须写进发布门，不能假设它支持面板级。
5. **现有 L2 归属为空**：本期不强制回填部门，避免静默收缩可见性；新提交撞名时强制补。

## 18. 分期

| 期 | 交付 | 验收 |
|---|---|---|
| **P0** | 变更单表 + 试算 + 采纳/驳回 + 会话限定 | agent 提交可试算；未试算不可采纳；PAT 采纳被拒 |
| **P1** | `owner_dept` / `variant_note` / entity 开放给 L2 / 部门内同名唯一 | 同部门第二个「营业额」被拒 |
| **P2** | 指标可见性 + 五个执法点 + `reveal` | 按 id 越权 404；列表与查询同源 |
| **P3** | 解析 tie 检测 + 答案 `caliber` 标注 | 两部门同名必澄清；答案自带口径 |
| **P4** | agent 工具统一 + 人面写入口全删 | 全仓 UI 无写入口；agent 无法调决策端点 |
| **P5** | 发布门 + 渲染闸 + 巡检 | 受众超范围发布被拒；兄弟部门面板降级 |
| **P6** | 声明类对账证据接入 + 度量治理（使用统计下线） | 无证据不可采纳；零使用口径进下线候选 |
