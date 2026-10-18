# 通知规则层（Wave 3 / M3.1–M3.7）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 platform-core 落地「通知绑定层」——「什么事件 × 通知谁 × 用哪个模板 × 什么通道」的共享规则登记面：两张 org-scoped 表 + 规则管道（匹配→解析→`novu.trigger`→回执）+ 声明派生默认规则 + AI 工具面 + console 管理页/收件箱；接通 case-engine 审批事件与 forms 填催。

**Architecture:** 新建 `modules/notify` 承载「数据面 + AI 工具面 + console 页」三面（照 `modules/forms` 范式）。投递/模板留 Novu、解析（assignee）留 case-engine——本层**只新增绑定层**。规则**全声明式**：规则行只引用 Novu workflow identifier，不内嵌文案。常路径由 `approval: single` 声明**幂等派生**默认规则，零配置即通；规则登记退居覆盖/扩展面。

**Tech Stack:** 模块协议（`@platform/sdk` defineModule / ManifestSchema）+ pg（幂等 DDL + 真库集成测试）+ Hono + zod + vitest。**零新基础设施**（不建队列、不建 notifier 服务）。

**Spec（唯一上游，已人审）：** explore 仓 `docs/superpowers/specs/2026-10-16-notification-rules-design.md`；正典 explore 仓 ADR 0005 **§18**（通知规则层定案）+ **§19**（租户边界）。本仓 `docs/architecture.md` §2.6（本计划 Task 1 新增）。

---

## 决策点（动工前须人拍板——本计划不自作主张）

| # | 决策 | 推荐 | 备选 | 卡谁 |
|---|------|------|------|------|
| D1 | ~~新模块 id 命名~~ **✅ 已定（2026-10-18 人拍板）：`notify`** | schema `notify`；API `/api/modules/notify/*`；表 `notify.rule` / `notify.delivery` | — | **已解除** |
| D2 | **跨服务 emit 认证机制**（case-engine → platform-core 无平台会话；本仓现只有会话/PAT 两通道，**无服务令牌**） | **沿用 PAT（通道 B）**：case-engine 持一枚专用 PAT，`/emit` 声明独立 scope `notify:emit` | 新造服务令牌机制（宿主层，成本高、须新正典） | M3.4 / Task 10 |
| D3 | ~~定时器载体~~ **✅ 已定（2026-10-18）：openship job + 仓内管理命令** | 本仓两处先例（审计清理 job、dbt runner 零常驻）+ 仓内原则「有副作用的运维动作不该藏在 HTTP 服务里」；决策见 `docs/superpowers/specs/2026-10-18-notify-emit-seam-and-scheduler.md` | — | **已解除** |

> D1 已定 ⇒ **Task 1–9、12 全部解锁**。D2/D3 只卡 M3.4/M3.5（Task 10/11），到达时再定。

---

## Global Constraints

- **三同纪律**：`manifest.id` = DB schema 名 = API 前缀，三处一致（B1 门禁扫 schema 侧）。
- **迁移幂等**：`create schema/table/index if not exists`；DML `on conflict`；同批重复执行不报错。模块迁移执行器 `apps/server/src/migrate.ts` `runMigrations(pool, module, dir)`，记账表 `platform.schema_migrations`，**按 module 记账**（跨模块编号不冲突，冲突面只在同模块文件名）。
- **租户表**：`org text not null` 作**首列**；主键/唯一约束以 `org` 起头；热路径索引以 `org` 为前缀列。`scripts/check-tenant-isolation.mjs` **真库对账**（表有 `org` 列 + `NOT NULL` 两条判据），自动扫 `modules/*/migrations`，**新模块无需登记**。
- **全局表**（无租户归属）才允许无 org：`-- global-table: <理由>` 独占一行**紧贴** create table 上方（T1+T2 一起豁免）。
- **fail-closed（创建/写入时校验）**：解析器 × 挂载点必须匹配（form 挂载无 assignee 语义）；`user_list`/`field` 禁跨租户引用；错误一律**机检错误码**（调用方按 code 映射，不解析 message）。
- **fail-open（投递时）**：通知链任何一步失败**不阻塞业务**（case 照常创建）；失败进回执表 + OpenObserve 告警，**不建队列、不建重试风暴**（v1 靠 Novu 自身重试 + 人工重触发）。
- **幂等**：`unique(event_id, rule_id)`——emit 带**确定性 event_id**（业务转移一次一枚），重试/调度重叠天然去重、不双发。
- **Novu key 永不进浏览器**：in-app feed 由 platform-core 后端代理消费 Novu API，前端只见代理端点。
- **模板不进规则层**：规则行只存 Novu workflow identifier；文案治理沿用既有交付纪律（repo 正典 + Dev 建 + sync，WeKnora `06425b22`）。**Novu 生产环境建 workflow 一律 401**——只能 Dev 建再 sync（平台既有 fail-safe，不可绕）。
- **主体只来自身份**：org 取 `identity.orgId`（会话/PAT）或 `c.get('tenant').casdoor_org`（租户上下文）；**请求参数出现保留键一律 400**；解析器参数只解析到本 org 用户。
- **模块内不跨 import 他模块**（§12.13）；新 env 键必须同步进 `.env.example`（B9 门禁）。
- **AI 永不持有发布/发布档**：AI 工具面只有「写规则行」（高频×小，可逆），无「建模板/改文案」（低频×大，不可撤回）。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `docs/architecture.md` | §2.6 通知规则层落档（D1 定案 + 五条取舍 + 数据模型 + 执行流 + 门禁分层） | **先于代码** |
| `modules/notify/manifest.yaml` | id / permissions / api.internal 逐条声明 / frontend.console / migrations | 新 |
| `modules/notify/migrations/001_notify.sql` | 两表 + 幂等 DDL + 索引（`org text not null` 范式） | 新 |
| `modules/notify/domain/rules.ts` | **纯函数**：匹配（manual>derived，`'*'` 兜底）+ 解析器×挂载点校验（不 import pool/env/Hono） | 新 |
| `modules/notify/domain/rules.test.ts` | 匹配与校验单测（无 DB） | 新 |
| `modules/notify/domain/derive.ts` | **纯函数**：声明 → 派生规则（幂等） | 新 |
| `modules/notify/domain/derive.test.ts` | 派生单测（无 DB） | 新 |
| `modules/notify/domain/novu.ts` | Novu trigger 客户端（env 解析 + HTTP 封装，照 `modules/forms/domain/llm.ts` 范式） | 新 |
| `modules/notify/domain/novu.test.ts` | trigger 请求形状单测（mock fetch） | 新 |
| `modules/notify/storage.ts` | 规则 CRUD / 回执写入 / 匹配查询的 SQL 封装（pool 进、行出；org 参数进） | 新 |
| `modules/notify/pipeline.ts` | 管道编排：匹配 → 解析 → trigger → 回执（fail-open 边界） | 新 |
| `modules/notify/routes.ts` | 端点薄壳（identity → storage/pipeline，错误码映射状态码） | 新 |
| `modules/notify/mcp.ts` | `/mcp-manage` AI 工具面（写规则行；无发布类工具） | 新 |
| `modules/notify/console/index.tsx` | 一页两职责（规则管理区 + 收件箱区） | 新 |
| `modules/notify/console/api.ts` | console 调后端（`platformFetch`） | 新 |
| `modules/notify/test-util.ts` | `makeIdentity` + `buildTestApp` + `applyMigrations`（照 forms 先例，复用宿主 `runMigrations`） | 新 |
| `modules/notify/pipeline.test.ts` | 管道集成测试（DB + mock Novu） | 新 |
| `modules/notify/routes.test.ts` | scope 门 / org 钉死 / 校验错误码（DB） | 新 |
| `apps/web/src/console-registry.gen.ts` | 生成物（`gen-console-registry.mjs` 产出，**勿手改**） | 生成 |

---

## 关键形状（任务间共享的精确接口）

```ts
// modules/notify/domain/rules.ts —— 纯函数，不 import pool/env/Hono
export type RecipientKind = 'assignee' | 'submitter' | 'user_list' | 'field'
export type RuleOrigin = 'derived' | 'manual'
export type Channel = 'wechat_work' | 'in_app'

export type NotificationRule = {
  id: string
  org: string
  enabled: boolean
  eventType: string
  mount: string            // case_type_id | form_def_id | '*'
  templateId: string       // Novu workflow identifier
  recipient: RecipientKind
  recipientArg?: string | null   // user_list / field 的参数
  channels: Channel[]
  cooldownMinutes?: number | null
  origin: RuleOrigin
}

// 匹配：manual > derived；'*' 兜底；同优先级按 created_at 稳定序
export function matchRules(
  rules: NotificationRule[],
  event: { eventType: string; mount: string },
): NotificationRule[]

// 校验（fail-closed）：解析器 × 挂载点；返回机检错误码或 null
export function validateRule(input: RuleInput): { code: string } | null
```

```ts
// modules/notify/domain/novu.ts —— 唯一外部 HTTP 落点
export type NovuConfig = { baseUrl: string; apiKey: string }
export function novuFromEnv(): NovuConfig | null   // 缺省 null ⇒ /emit 回可解释 503
export async function trigger(cfg: NovuConfig, args: {
  templateId: string; subscriberId: string; payload: Record<string, unknown>
}): Promise<{ ok: true } | { ok: false; error: string }>
```

```ts
// modules/notify/pipeline.ts —— fail-open 边界（任何一步失败不抛给调用方）
export type EmitInput = {
  org: string
  eventId: string          // 确定性，业务转移一次一枚
  eventType: string
  mount: string
  payload: Record<string, unknown>
}
export async function emit(
  deps: { pool: Pool; novu: NovuConfig | null },
  input: EmitInput,
): Promise<{ delivered: number; failed: number }>
```

---

## 任务分解

### Task 1：文档先行（架构订正 + 本计划）

**Files:** Modify `docs/architecture.md`（§2.6 新增）；Create 本计划文件。

- [x] **Step 1:** D1 已定 = **`notify`**（2026-10-18 人拍板）；写入 §2.6。
- [ ] **Step 2:** `docs/architecture.md` 紧跟 §2.5 后新增 **§2.6 通知规则层（绑定层）**：五条取舍（Novu 留任 / 声明派生 / 模板不进层 / fail-open / 两态分离）、数据模型两表、执行流双入口、门禁分层、鉴权钉死、v1 事件清单——正文照 ADR §18.2–18.9 转写（**不复制正文到别处**，此处是本仓正典落点）。
- [ ] **Step 3:** 提交（docs 类，无需 issue）：`docs(arch): 新增 §2.6 通知规则层——Wave 3 正典落档（ADR 0005 §18 本仓落点）`。
- [ ] **Step 4:** 本计划文件同 PR 提交，待人审。

**验收**：`docs/architecture.md` 含 §2.6；D1 有明确结论。

---

### Task 2：迁移 `001_notify.sql`（两表 + 租户门禁）

**Files:** Create `modules/notify/migrations/001_notify.sql`；`modules/notify/migrations/.gitkeep`。

- [ ] **Step 1:** 写迁移（幂等，`org text not null` 首列，主键/索引以 org 起头）：

```sql
create schema if not exists notify;

create table if not exists notify.rule (
  org              text not null,
  id               text not null,
  enabled          boolean not null default true,
  event_type       text not null,
  mount            text not null,                 -- case_type_id | form_def_id | '*'
  template_id      text not null,                 -- Novu workflow identifier（只引用不内嵌）
  recipient        text not null check (recipient in ('assignee','submitter','user_list','field')),
  recipient_arg    text,
  channels         text[] not null default '{wechat_work,in_app}',
  cooldown_minutes int,
  origin           text not null check (origin in ('derived','manual')),
  created_by       text not null,
  created_at       timestamptz not null default now(),
  primary key (org, id)
);
create index if not exists idx_notify_rule_match
  on notify.rule (org, event_type, mount) where enabled;

create table if not exists notify.delivery (
  org        text not null,
  rule_id    text not null,
  event_id   text not null,
  event_type text not null,
  recipient  text not null,
  template   text not null,
  status     text not null check (status in ('sent','failed')),
  error      text,
  created_at timestamptz not null default now(),
  primary key (org, event_id, rule_id)           -- 幂等去重（unique(event_id, rule_id) 的 org-scoped 形）
);
create index if not exists idx_notify_delivery_list
  on notify.delivery (org, created_at desc);
```

- [ ] **Step 2:** 跑门禁（需 `DATABASE_URL` + CREATEDB）：

Run: `pnpm exec tsx scripts/check-tenant-isolation.mjs`
Expected: PASS（两表 org 列存在且 NOT NULL；无 `-- global-table` 违规）。

- [ ] **Step 3:** 幂等验证：同库连跑两遍 `runMigrations`，第二遍零变更、不报错（照 `modules/forms` 幂等测试范式，落 `notify/migrations.test.ts` 或复用宿主 `migrate.test.ts` 姿势）。

- [ ] **Step 4:** Commit：`feat(notify): 迁移 001——notification_rules/deliveries 两表（org-scoped，幂等）`。

---

### Task 3：`domain/rules.ts`（匹配 + 校验，纯函数，TDD）

**Files:** Create `modules/notify/domain/rules.ts`、`modules/notify/domain/rules.test.ts`。

- [ ] **Step 1:** 写失败测试（无 DB）：

```ts
// rules.test.ts
import { describe, it, expect } from 'vitest'
import { matchRules, validateRule } from './rules'

describe('matchRules', () => {
  it('manual 覆盖 derived（同 event+mount）', () => { /* 断言只回 manual */ })
  it("'*' 兜底：无精确 mount 时回通配", () => { /* ... */ })
  it('同优先级按 created_at 稳定序', () => { /* ... */ })
  it('disabled 规则不参与', () => { /* ... */ })
})
describe('validateRule', () => {
  it('form 挂载用 assignee ⇒ 拒（机检码）', () => { /* ... */ })
  it('case 挂载用 assignee ⇒ 通过', () => { /* ... */ })
})
```

- [ ] **Step 2:** Run: `pnpm --filter @platform/notify test`（或 `cd modules/notify && npx vitest run domain/rules.test.ts`）。Expected: FAIL（未实现）。

- [ ] **Step 3:** 实现 `matchRules` / `validateRule`（纯函数；错误码常量集中，如 `RULE_RECIPIENT_MOUNT_MISMATCH`）。

- [ ] **Step 4:** Run 测试，Expected: PASS。

- [ ] **Step 5:** Commit：`feat(notify): 规则匹配与解析器校验（纯函数）`。

---

### Task 4：`domain/derive.ts`（声明派生，纯函数，TDD）

**Files:** Create `modules/notify/domain/derive.ts`、`derive.test.ts`。

- [ ] **Step 1:** 写失败测试：`approval: single <审批人[]>` 声明 → 派生一条 `{event: case.awaiting_approval, mount: <case_type>, template: case_awaiting_approval, recipient: assignee, channels:[wechat_work,in_app], origin: derived}`；声明变更 ⇒ 重算**幂等**（同输入同输出，id 确定性）；forms 侧催办策略 ⇒ 派生 `form.due_reminder`。
- [ ] **Step 2:** Run，Expected: FAIL。
- [ ] **Step 3:** 实现：派生规则 **id 确定性**（如 `derived:<case_type>:<event>`），保证幂等 upsert。
- [ ] **Step 4:** Run，Expected: PASS。
- [ ] **Step 5:** Commit：`feat(notify): 声明派生默认规则（幂等）`。

---

### Task 5：`domain/novu.ts` + `storage.ts`（Novu 客户端 + SQL 封装）

**Files:** Create `modules/notify/domain/novu.ts`、`novu.test.ts`、`modules/notify/storage.ts`。

- [ ] **Step 1:** `novuFromEnv()`（`NOVU_BASE_URL` / `NOVU_API_KEY`；缺省 null）+ `trigger()`（`POST {base}/v1/events/trigger`，body `{name: templateId, to: subscriberId, payload}`）；测试 mock fetch 断言请求形状与错误分支。
- [ ] **Step 2:** `storage.ts`：`listRules(pool, org)` / `upsertRule(pool, org, rule)` / `deleteRule(pool, org, id)` / `setEnabled(pool, org, id, on)` / `insertDelivery(pool, org, row)`（`on conflict (org,event_id,rule_id) do nothing`，**幂等**）/ `listDeliveries(pool, org, limit)`。**org 一律来自调用方传入**，SQL 一律 `where org=$1`。
- [ ] **Step 3:** 新增 env 键同步 `.env.example`：`NOVU_BASE_URL=`、`NOVU_API_KEY=`（B9 门禁）。
- [ ] **Step 4:** Run 测试，Expected: PASS。
- [ ] **Step 5:** Commit：`feat(notify): Novu trigger 客户端 + 规则/回执 SQL 封装`。

---

### Task 6：`pipeline.ts` + `routes.ts` + `manifest.yaml` + `index.ts`（管道与端点）

**Files:** Create `modules/notify/pipeline.ts`、`routes.ts`、`manifest.yaml`、`index.ts`、`test-util.ts`、`pipeline.test.ts`、`routes.test.ts`。

- [ ] **Step 1:** `pipeline.emit()`：匹配 → 解析收件人（assignee 由 payload 传入，§15 已定 case-engine 负责解析）→ `novu.trigger` → 落回执；**任何一步失败记 failed 并返回计数，不抛**（fail-open）。
- [ ] **Step 2:** `routes.ts` 端点（薄壳，identity → storage/pipeline）：
  - `GET /rules`（`notify:view`）、`POST /rules`（`notify:manage`）、`PUT /rules/:id/enabled`、`DELETE /rules/:id`、`GET /deliveries`（`notify:view`）
  - `POST /emit`（`notify:emit`）——入参 `{eventId, eventType, mount, payload}`；org 取身份，**不从 body 取**
- [ ] **Step 3:** `manifest.yaml`：`id: notify`；permissions `notify:view/manage/emit`；`api.internal` 逐条声明（**与注册集合双向核对，差集即装载失败**）；`frontend.console` 条目（Task 8 落 entry）；`migrations: { dir: ./migrations }`。
- [ ] **Step 4:** `index.ts`：读 manifest → `defineModule({manifest, createRouter: ({pool}) => createNotifyRouter({pool, novu: novuFromEnv()})})`。
- [ ] **Step 5:** `pipeline.test.ts` / `routes.test.ts`（DB + mock Novu）：**负对照**——①停用/删除规则后不通知；②Novu 不可用时 emit 不抛（fail-open）；③解析器错配/跨租户被拒（fail-closed）；④重复 emit 不双发（幂等）。
- [ ] **Step 6:** Run: `DATABASE_URL=... pnpm --filter @platform/notify test`。Expected: PASS（含四条负对照）。
- [ ] **Step 7:** Commit：`feat(notify): 规则管道 + 端点 + manifest（含四条负对照）`。

---

### Task 7：AI 工具面 `/mcp-manage`

**Files:** Create `modules/notify/mcp.ts`；Modify `routes.ts`、`manifest.yaml`。

- [ ] **Step 1:** 照 `modules/forms/mcp.ts` 骨架（**抄形状不抄代码**）：工具 `list_rules`（无参）、`propose_rule`（`{eventType, mount, templateId, recipient, ...}`）；**无任何模板/发布类工具**（AI 永不碰文案）。
- [ ] **Step 2:** org 取 `identity.orgId`；`/mcp-manage` 声明 `scope: notify:manage`。
- [ ] **Step 3:** 测试：`propose_rule` 走 `validateRule`（fail-closed）；跨租户 `user_list` 被拒。
- [ ] **Step 4:** Commit：`feat(notify): 管理面 MCP 工具面（AI 建规则，无发布档）`。

---

### Task 8：console 页（规则管理区 + 收件箱区）

**Files:** Create `modules/notify/console/index.tsx`、`console/api.ts`；Modify `manifest.yaml`（`frontend.console` entry）；跑 `scripts/gen-console-registry.mjs` 生成 `apps/web/src/console-registry.gen.ts`。

- [ ] **Step 1:** 一页两分区（照 forms console 的 tabs 姿势）：**规则管理区**（列表：事件/挂载点/模板/收件人/最近投递态/origin 标记 + 启停开关 + AI 创建入口；**v1 无表单编辑器**）；**收件箱区**（待办查权威源 + 通知走 Novu in-app **经后端代理**——新增代理端点，Novu key 不进浏览器）。
- [ ] **Step 2:** `api.ts` 用 `platformFetch`。
- [ ] **Step 3:** 生成 registry：`node scripts/gen-console-registry.mjs`（生成物进 git，勿手改）。
- [ ] **Step 4:** 自验：本地起栈打开 console 页走一遍（UI 交付前自验纪律）。
- [ ] **Step 5:** Commit：`feat(notify): console 页——规则管理区 + 收件箱区`。

---

### Task 9：forms 侧 emit 接线（in-platform，填催）

> **⚠️ 前置未就绪（2026-10-18 复核）**：本 Task 原先假设「表单声明了催办策略」——**forms 里没有这个东西**
> （6 张表全查过，`assign`/`due`/`remind` 零命中；正典也未定义「催办策略」）。
> 设计稿见 `docs/superpowers/specs/2026-10-18-form-assignment-and-reminder-design.md`（PR #907）：
> 名单 = 字典引用、截止 = 发布后 N 天；**v1 名单按「人」**（`submitted_by` 直接对账，零新机制）。
> **该稿人审通过前不动本 Task 的码。**

**Files:** Modify `modules/forms/*`（契约字段 + 发布路径派生）、`modules/notify/*`。

- [ ] **Step 1:** 正典落档（§2.4 增补「指派与催办」）→ 人审 → 再写码。
- [ ] **Step 2:** 契约加 `assignees` / `due` 两个可选键；发布（人 gate 后）解析名单 → 逐人 emit `form.assigned` + `POST /derive`（v1 名单 = Casdoor 用户名）。
- [ ] **Step 3:** 测试：契约含名单的表单发布 → 每人生成一次 `form.assigned`；派生规则在 console 标「声明派生」；**不含名单的存量表单行为不变**（负对照）。
- [ ] **Step 4:** Commit：`feat(forms): 指派与催办声明（notify 绑定层）`。

---

### Task 10：case-engine 侧 emit 接线（**gated on M2.2 垂直切片**）

**Files:** Modify case-engine 仓（emit 调用）+ platform-core（`/emit` 认证，按 D2）。

- [ ] **Step 1:** **定 D2**（跨服务认证机制）——无平台会话，须选 PAT 或新令牌。
- [ ] **Step 2:** case-engine 在审批事件点 emit（携 `org` + 确定性 `event_id`）；platform-core `/emit` 按 ADR §19.1-2 校验 org 一致，**不一致 fail-closed 拒**。
- [ ] **Step 3:** 负对照（ADR §19.2）：跨服务调用**不带 org / 带错 org 必须被拒**。
- [ ] **Step 4:** **PoC 硬指标**：真实创建 case（`approval: single`）→ 声明自动派生规则 → **审批人企微真机收到通知**。
- [ ] **Step 5:** Commit（两仓各一 PR，body 交叉引用）。

---

### Task 11：定时器（`form.due_reminder` / `sla.breach_warning`）

> **D3 已定（2026-10-18）**：**openship job + 仓内管理命令**——本仓两处先例（审计清理 job、
> dbt runner 零常驻）+ 仓内原则「有副作用的运维动作不该藏在 HTTP 服务里」。
> 决策与依据见 `docs/superpowers/specs/2026-10-18-notify-emit-seam-and-scheduler.md`。
> **「甲」（in-platform）由此零新机制**：job 跑仓内脚本、脚本直连 DB（已核 `scripts/` 不在 B1 扫描根）。

**Files:** `scripts/notify-reconcile.mjs`（新）+ openship job 定义（面板）。

- [ ] **Step 1:** 写 `scripts/notify-reconcile.mjs`：查到期未提交 → 逐人 emit（`form.due_reminder`）；`event_id` 含日期 ⇒ 同日重跑不双发。
- [ ] **Step 2:** openship 面板建 job（照 `deploy/openship-adopt.md` 的 prune job 范式：一次性容器、零常驻、订阅失败通知）。
- [ ] **Step 3:** 负对照：同日重跑不双发；已提交的人不收；停用规则后不通知。
- [ ] **Step 4:** **实测沉淀**：N=500 的调度耗时与 Novu 限速（设计稿 §5 的待实测项）。
- [ ] **Step 5:** Commit + 交付记录。

---

### Task 12：Novu 五模板交付 + 五负对照全过 + WeKnora 沉淀

**Files:** repo 正典模板交付件（照 WeKnora `06425b22` 手册）。

- [ ] **Step 1:** v1 五模板（`case_awaiting_approval` / `case_status_changed` / `form_assigned` / `form_due_reminder` / `sla_breach_warning`）：**Dev 建 → 人审 → sync 生产**（生产 401 不可绕）。
- [ ] **Step 2:** 五负对照全过（spec §11）：①停用/删除后不通知；②Novu 不可用 case 创建不受阻；③解析器错配/跨租户被拒；④重复 emit 不双发；⑤manual 覆盖 derived 生效。
- [ ] **Step 3:** WeKnora 沉淀（**写前 hybrid-search 查重**，命中则更新原条目）。
- [ ] **Step 4:** Commit + 交付记录。

---

## Self-Review（对照 spec 逐节核）

- spec §1 背景目标 → Task 1/6/10（链路真通 + 自由挂载 + AI 创建 + 可视管理）
- §2 五取舍 → Global Constraints + Task 1 §2.6
- §3 数据模型 → Task 2
- §4 声明派生 → Task 4
- §5 执行流双入口 → Task 6（入口 A）+ Task 11（入口 B）
- §6 门禁分层 → Task 7（AI 无发布档）+ Task 12（模板人审）
- §7 鉴权多租户 → Global Constraints + Task 2（门禁）+ Task 6（org 钉死）
- §8 console 两职责 → Task 8
- §9 事件契约 v1 → Task 6 manifest + Task 10/11
- §10 错误处理 → Task 6（fail-open/fail-closed 分界）
- §11 验证路径 → Task 6/10/12（五负对照）
- §12 实施顺序 → Task 1（架构先行）先于全部代码
- §13 边界（不做） → 未列入任务即为不做（payload 条件/邮件短信/队列/表单编辑器/digest）

**缺口自陈**：D1/D2/D3 三项决策未定 → Task 1/10/11 相应步骤标注为待拍板；**不编**。
