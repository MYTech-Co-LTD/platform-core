# 问数三通道（一个授权核心）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 platform-core 落地 `modules/data` 模块与两个宿主鉴权中间件，用一个授权核心支撑三条问数通道（系统内会话 / 系统外个人 Key+MCP / 企微 OpenClaw），权限实时跟随用户、fail-closed、三通道统一审计。

**Architecture:** 授权核心是**纯函数**模块（`modules/data/domain/authz.ts`）——词表裁剪、主体钉死、fail-closed 只有一处实现。三条通道的差别**只存在于鉴权中间件一层**：会话（既有 `sessionMiddleware`）/ PAT（新增 `apps/server/src/pat-auth.ts`）/ 企微（新增 `apps/server/src/wecom-channel-auth.ts`）各自把身份解析成同一个 `Requester`，再走同一个 `runQuery`。模块 API 由 manifest 声明、宿主门卫 fail-closed（既有机制）；模块侧**不写** `requireScope`。

**Tech Stack:** TypeScript / Hono / PostgreSQL（`pg`）/ zod / vitest（backend + console 双 project）；React 19 + antd 6 + Vite（console）；MCP 部分**不用 SDK**——手写 stateless JSON-RPC over POST。

**Spec:** `docs/superpowers/specs/2026-09-21-data-query-channels-design.md`（已合入 main，`55a341b`）
**前置设计:** `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（七层架构 §10 fork #3）
**原型实测:** `/tmp/iam-lab/`（授权矩阵 11/11，本计划 T2 把它产品化）

---

## Global Constraints

每条都是**项目级**要求，隐含在**每一个**任务里。

1. **授权核心单实现**：三通道共用 `modules/data/domain/authz.ts`。任何通道、任何路由**不得**自建权限判定（不得在自己那里 filter catalog / 判 scope）。
2. **主体钉死**：SQL 里出现的 `org` 值**只来自身份解析**（`Requester.orgId`）。请求参数里出现保留键（`org` / `subject` / `tenant` / `tenant_id` / `org_id` / `casdoor_org`）一律拒 `subject_pinned_by_platform`。
3. **词表外指标不可见**：`tools/list` 与 `GET /metrics` 只回 `requiredScope` 命中请求者 scopes 的指标——是「看不见」，不是「调了报错」。
4. **fail-closed**：无身份 / 未授权 / 未声明 / 企微未关联 / Casdoor 不可达，一律拒绝并给出**可解释 reason**。PAT 通道**没有**缓存的 scopes，故 Casdoor 故障时**没有**「降级用旧权限」这条路（与 session 中间件的退化策略刻意不同，理由见 T5）。
5. **PAT 只存哈希**：`data.query_keys` 只存 SHA-256 十六进制，明文 token 只在创建响应里出现一次。哈希实现**两侧逐字一致**：
   ```
   createHash('sha256').update(token).digest('hex')
   ```
   `modules/data/domain/key-store.ts`（T3）与 `apps/server/src/pat-auth.ts`（T5）**必须各写这一行原文**（变量名 `token` 不变），且 **T10 必须有往返契约测试**（模块路由建 key → 宿主中间件验 key）。任何 key（PAT / 企微服务凭证 / LLM key）**不进**聊天记录、LLM 上下文、日志、提交信息。
6. **通道 C 走问数 API 不走 MCP**：`POST /api/modules/data/query` 带 `X-Wecom-Userid`。`/mcp` 端点**仅供通道 B**。通道 A 是模块内直接调 `runQuery`，不经 MCP 协议。
7. **审计三通道统一**：每一次问数（无论裁决）都写 `data.query_audit` 一行，字段覆盖「身份 / 通道 / key_id? / 指标 / 参数 / 行数 / 裁决+reason / ts」。
8. **回包带钉死主体**：ok 回包必含 `subject`（= 本次 SQL 钉死的 org 值），让客户端能独立验证。
9. **迁移幂等**：`DROP ... IF EXISTS` / `... IF NOT EXISTS`；全部 `create table if not exists` / `create index if not exists`（部署脚本每次全量重跑全部迁移，团队规则 `db-migration` §1）。
10. **env 键 B9 门禁**：代码里出现的每个 env 键都必须在根 `.env.example` 声明（只声明键名 + 「在哪、怎么取」，**不写真值**）。本计划引入的六个键：`DATA_WAREHOUSE_URL` / `DATA_WECOM_CHANNEL_KEY` / `DATA_QUERY_RATE_PER_MIN` / `DATA_LLM_BASE_URL` / `DATA_LLM_API_KEY` / `DATA_LLM_MODEL`。
11. **装载期双向核对**：注册的路由集合必须与 manifest 声明集合**完全一致**，任一方向差集 ⇒ 装载失败。⇒ **凡是加路由的任务，必须同一个任务内同时改 `manifest.yaml` + `index.ts` + 路由文件**（T6/T7/T8 因此串行，见派发表）。声明路径写**模块相对路径**（`/metrics`），loader 会给它加 `/api/modules/<id>` 前缀。
12. **提交纪律**：`docs` 提交不需要 issue；`feat`/`fix` **必须先有 issue**，PR body 写 `Closes #N`；一切可见变更走 PR，只等 CI **CLEAN** 才合；CHANGELOG 禁手写。执行本计划前先开 issue（见「开工前置」）。

---

## 开工前置（编排者做，不是某个 worker 的步骤）

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "feat(data): 问数三通道——授权核心 + 系统内/PAT/企微三通道" \
  --body "spec: docs/superpowers/specs/2026-09-21-data-query-channels-design.md
plan: docs/superpowers/plans/2026-09-21-data-query-channels.md

一个授权核心，三条鉴权通道。见 plan 的 12 条全局约束。"
```

记下返回的 issue 号，作为 `<N>`：

- 每个任务的分支名 `feat/data-query-t<k>`
- 每个任务的 PR body 末行 `Closes #<N>`
- feature 分支合并顺序：按任务号递增（T6→T7→T8→T9→T10 严格串行）

> ⚠️ **派发前先 `git fetch origin main`**：Orca 的 `--base-branch main` 取的是**本地 ref**，长期 worktree 里本地 main 会脱节 ⇒ worker 拿到旧基线。（团队记忆 `orca-base-branch-uses-stale-local-main`。）

---

## 文件结构与派发表

### 新建 / 修改的文件（全量）

| 文件 | 职责 | 任务 |
|---|---|---|
| `modules/data/package.json` | 模块包声明（名 `data`，**无** `@aws-sdk/*`） | T1 |
| `modules/data/tsconfig.json` | 继承 `tsconfig.base.json` | T1 |
| `modules/data/vitest.config.ts` | backend(node) + console(happy-dom) 双 project | T1 |
| `modules/data/manifest.yaml` | 门禁声明（**逐步成长**：T1 空 → T6/T7/T8 各加一批） | T1,T6,T7,T8 |
| `modules/data/index.ts` | 模块装配（`defineModule`） | T1,T6,T7,T8 |
| `modules/data/routes/context.ts` | `ModuleVars` / `ModuleHono` / `RouteCtx` / `requesterOf` / 参数解析 | T1(骨架),T6 |
| `modules/data/migrations/001_init.sql` | 三张表（metrics / query_keys / query_audit） | T1 |
| `modules/data/test-util.ts` | `makeIdentity` / `buildTestApp` / `applyMigrations` / `rawMigrationSqls` | T1 |
| `modules/data/domain/authz.ts` | **授权核心**（纯函数） | T2 |
| `modules/data/domain/metric-store.ts` | 词表读/写（`data.metrics`） | T3 |
| `modules/data/domain/key-store.ts` | PAT 建/列/吊销/解析（`data.query_keys`） | T3 |
| `modules/data/domain/audit-store.ts` | 审计写（`data.query_audit`） | T3 |
| `modules/data/domain/warehouse.ts` | 数据仓库连接（惰性单例） | T3 |
| `modules/data/domain/query-service.ts` | `runQuery` 编排（授权 → 执行 → 审计） | T4 |
| `modules/data/routes/metrics.ts` | `GET /metrics` / `/metrics/all` / `POST|PUT|DELETE /metrics/:id` | T6 |
| `modules/data/routes/query.ts` | `POST /query` | T6 |
| `modules/data/routes/keys.ts` | `GET /keys` / `POST /keys` / `DELETE /keys/:id` | T7 |
| `modules/data/routes/mcp.ts` | `POST /mcp`（手写 JSON-RPC） | T8 |
| `modules/data/domain/llm.ts` | `ChatModel` + `openAiCompatModel` + `llmFromEnv` | T9 |
| `modules/data/domain/agent-loop.ts` | `runAgentLoop`（AsyncGenerator） | T9 |
| `modules/data/routes/chat.ts` | `POST /chat`（SSE） | T9 |
| `modules/data/console/index.tsx` | 页签壳（问数对话 / 指标管理 / 问数 Key） | T9 |
| `modules/data/console/query/index.tsx` | 对话面板 | T9 |
| `modules/data/console/metrics/index.tsx` | 指标管理 | T9 |
| `modules/data/console/keys/index.tsx` | 问数 Key 管理 | T9 |
| `apps/server/src/pat-auth.ts` | PAT 鉴权中间件 | T5 |
| `apps/server/src/wecom-channel-auth.ts` | 企微渠道鉴权中间件 | T5 |
| `apps/server/src/config.ts` | 加三个 data 配置键 | T5 |
| `apps/server/src/app.ts` | 挂两个中间件（⑥ 的 `sessionMiddleware` 块之后、⑦ 平台路由之前） | T5 |
| `packages/platform-sdk/src/requester-vars.ts` | 新建：`REQUESTER_CHANNEL` / `REQUESTER_KEY_ID` 常量 + `RequesterVars` 类型 | T5 |
| `packages/platform-sdk/src/index.ts` | 导出上面两个常量（值）与 `RequesterVars`（类型）——**值/类型分行 `export`**（#44 纪律） | T5 |
| `modules/data/module.test.ts` | manifest↔路由双向核对 + 迁移幂等 | T1（T6/T7/T8 扩展） |
| `apps/server/src/data-query.e2e.test.ts` | 三通道端到端 + PAT 往返契约 | T10 |
| `docs/architecture.md` | 组件清单加 `modules/data` | T1 |
| `docs/standards/…` 指针 | 无正文复制（团队规则 唯一事实源） | — |
| `.env.example` | 六个 data 键 | T1 |

### 波次与依赖

| 波 | 任务 | 并行度 | 依据 |
|---|---|---|---|
| **W1** | **T1** 模块骨架 | 单独 | 后面所有任务都要 `modules/data` 存在 |
| **W2** | **T2 / T3 / T4 / T5** | **四路并行** | 互不共享文件：T2 只有 `domain/authz.ts`；T3 只有 `domain/{metric,key,audit}-store.ts` + `warehouse.ts`；T4 只有 `domain/query-service.ts`；T5 只有 `apps/server/src/{pat-auth,wecom-channel-auth,config,app}.ts` + sdk |
| **W3** | **T6 → T7 → T8** | **严格串行** | 三者都改 `manifest.yaml` + `index.ts`（约束 ⑪ 的双向核对），并行必然冲突 |
| **W4** | **T9** | 单独 | 依赖 T6（`/query`）+ T7（`/keys`）的端点形状 |
| **W5** | **T10** | 单独 | 依赖 T5–T9 全部 |

> **W2 的并行边界（重要）**：T5 的 `apps/server/src/pat-auth.ts` **不得** `import` `modules/data/**`——宿主静态依赖模块是架构违规，且会打掉 worktree 并行。它自带哈希行与自己的查询 SQL（约束 5 + T10 往返契约测试兜漂移）。

Orca 派发（W2 四路 + W3 串行）：

```bash
# W2：四个独立任务，一次连发
orca orchestration task-create --spec "<T2 spec>" --json
orca orchestration task-create --spec "<T3 spec>" --json
orca orchestration task-create --spec "<T4 spec>" --json
orca orchestration task-create --spec "<T5 spec>" --json
# 记 task_id 后一次连发四个 worker-start（= 并行）
orca orchestration worker-start --task <t2> --worktree new-top-level --name data-authz  --agent claude --setup run --json
orca orchestration worker-start --task <t3> --worktree new-top-level --name data-stores --agent claude --setup run --json
orca orchestration worker-start --task <t4> --worktree new-top-level --name data-query  --agent claude --setup run --json
orca orchestration worker-start --task <t5> --worktree new-top-level --name data-hostmw --agent claude --setup run --json

# W3：T7/T8 用 --deps 编码串行
orca orchestration task-create --spec "<T6 spec>" --json
orca orchestration task-create --spec "<T7 spec>" --deps '["<T6 task_id>"]' --json
orca orchestration task-create --spec "<T8 spec>" --deps '["<T7 task_id>"]' --json
```

每波末跑**全量**验证（见 T1 Step 6 的命令组），不只跑本任务那几条。

---

## 常用命令（全计划通用）

```bash
# 模块（在 modules/data 目录或 --filter data）
pnpm --filter data test
pnpm --filter data typecheck

# 宿主
pnpm --filter @platform/server test
pnpm --filter @platform/server typecheck

# sdk
pnpm --filter @platform/sdk test
pnpm --filter @platform/sdk typecheck

# 全仓门禁（每波末必跑）
pnpm typecheck && pnpm test
node scripts/check-compose.mjs
node scripts/check-env-example.mjs
```

> 本地跑需要数据库的用例：`DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（本地 compose pg）。**不带该 env 时相关 `describe` 自动 skip**（`describePg = dbUrl ? describe : describe.skip`）——skip 不等于通过，收尾前必须带 env 跑一次。

---

# W1 — 模块骨架

### Task 1: `modules/data` 骨架 + 三张表 + env 键

**为什么单独一波**：它是后面 9 个任务的地基（目录、迁移、测试脚手架、env 声明）。`api.internal` 声明**留空**——装载期双向核对要求声明集合 ≡ 注册集合，空集合配空路由是自洽的起点，后面 T6/T7/T8 各加一批。

**Files:**
- Create: `modules/data/package.json`
- Create: `modules/data/tsconfig.json`
- Create: `modules/data/vitest.config.ts`
- Create: `modules/data/manifest.yaml`
- Create: `modules/data/index.ts`
- Create: `modules/data/routes/context.ts`
- Create: `modules/data/migrations/001_init.sql`
- Create: `modules/data/test-util.ts`
- Create: `modules/data/module.test.ts`
- Create: `modules/data/README.md`
- Modify: `.env.example`（末尾追加六键）
- Modify: `docs/architecture.md`（组件清单表加一行 `modules/data`）

**Interfaces:**
- Consumes: `@platform/sdk` 的 `ManifestSchema` / `defineModule` / `Identity` / `ModuleContext` / `ModuleDefinition`；`apps/server/src/migrate.ts` 的 `runMigrations`（**刻意跨包相对引用，不复制**，理由见 `modules/aftersales/test-util.ts` 顶部注释）
- Produces:
  - `modules/data/routes/context.ts`：`interface DataTenant { id: number; casdoor_org: string }`、`type ModuleVars = { Variables: { identity: Identity; tenant: DataTenant } }`、`type ModuleHono = Hono<ModuleVars>`、`interface RouteCtx { pool: Pool }`、`parseIdParam(raw: string | undefined): number | null`
  - `modules/data/test-util.ts`：`makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity`、`buildTestApp(mod: ModuleDefinition, identity: Identity, ctx: ModuleContext, tenant?: DataTenant): Hono`、`applyMigrations(pool: Pool): Promise<string[]>`、`rawMigrationSqls(): Promise<string[]>`
  - 三张表（T3/T4 消费）：`data.metrics` / `data.query_keys` / `data.query_audit`
  - 六个 env 键（T3/T5/T9 消费）

- [ ] **Step 1: 先更新架构文档（架构先行：组件新增必须先改文档）**

`docs/architecture.md:57` 的组件表里 `modules/<id>` 那一行的「现为…」描述加上本模块：

```
| `modules/<id>` | 业务模块。现为 `demo`（占位）、`aftersales`（售后域）与 `data`（**数据问数域**：三条消费通道共用一个授权核心——会话 / 个人 Key+PAT / 企微渠道凭证；见 `docs/superpowers/specs/2026-09-21-data-query-channels-design.md`） | `@platform/sdk`（+ 前端库；`data` 另有模块内 LLM 编排，**无** S3 依赖） | 无人；由宿主装载 |
```

授权：本次改动已由已合入的 spec（`55a341b`）+ 本计划批准，符合「先经人同意 → 更新架构文档 → 再写代码」。

- [ ] **Step 2: 建包与配置**

`modules/data/package.json`（照 `modules/aftersales/package.json`，**删掉** `@aws-sdk/*`——本模块不碰对象存储）：

```json
{
  "name": "data",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@platform/sdk": "workspace:*",
    "antd": "^6.0.0",
    "hono": "^4.13.0",
    "pg": "^8.16.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^6.30.0",
    "yaml": "^2.9.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.9.1",
    "@testing-library/react": "^16.3.0",
    "@types/pg": "^8.18.0",
    "@types/react": "^19.2.0",
    "happy-dom": "^20.14.0",
    "vitest": "^3.2.7"
  }
}
```

`modules/data/tsconfig.json`（照 aftersales 的，**删掉** `exclude: ["mobile"]`——本模块没有嵌套 workspace）：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "paths": {
      "vitest": ["./node_modules/vitest/dist/index.d.ts"]
    }
  }
}
```

> `paths` 必须写、且只写 `vitest`：jest-dom 的 `declare module 'vitest'` 会向上解析到仓库根的 vitest 2.1.9，与本包的 3.2.7 不是同一个 `Assertion` 声明 ⇒ `toBeInTheDocument` 报不存在（issue #68 实测）。写 `paths` 会整体覆盖 base 的 `paths`，故**只留这一条**。

`modules/data/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

// backend（域/路由，node）与 console（组件，happy-dom）双 project。
// ⚠️ backend 的 include 写精确目录，不写 `**/*.test.ts` + exclude：显式 exclude 会覆盖默认
// 排除项（含 node_modules），把依赖包里的测试也扫进来（aftersales 实测 98 → 149）。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'backend',
          environment: 'node',
          include: ['domain/**/*.test.ts', 'routes/**/*.test.ts', '*.test.ts'],
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'console',
          environment: 'happy-dom',
          include: ['console/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
```

- [ ] **Step 3: 写 manifest（空声明）**

`modules/data/manifest.yaml`：

```yaml
id: data
name: 数据问数
version: 0.1.0
platform: '>=0.1'
permissions:
  - { code: data:query,  name: 数据问数 }
  - { code: data:manage, name: 数据指标管理 }
# ⚠️ api.internal 的 path 是**模块相对路径**（不带 /api/modules/<id> 前缀）——
# loader 的 applyDeclaredApiGate 会用 moduleApiBasePath(id) 加前缀后再做门卫比对。
# 声明集合必须与 createRouter 注册的集合逐条一致（装载期双向核对，任一方向差集 ⇒ 装载失败）。
# T1 起为空是自洽的（还没注册任何路由）；T6/T7/T8 各加一批，且必须在【同一个任务】里同时改
# 本文件的 api.internal 与 index.ts 的 register* 调用。
api:
  internal: []
frontend:
  console:
    - { path: /console/data, title: 数据问数, icon: BarChartOutlined, scope: data:query, entry: ./console/index.tsx }
migrations: { dir: ./migrations }
```

> `frontend.console` 这一条 T1 就写（T9 才建 `./console/index.tsx`）。**注意副作用**：manifest 声明了 `entry` 而文件不存在，web 构建期若去解析这个入口会失败。因此 **T1 就要建一个最小可用的 `modules/data/console/index.tsx` 占位**（一个什么都没有的导出组件），T9 再替换成真页面。这比「T9 才加 frontend 声明」更安全——后者会让 T9 同时承担「首次引入前端声明」的风险。

- [ ] **Step 4: 写迁移（三张表，全幂等）**

`modules/data/migrations/001_init.sql`：

```sql
-- 001_init.sql — 数据问数域建表（modules/data）。
--
-- 纪律（每条都有出处，别按口味改）：
--   · 幂等：全部 if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 外部系统来的字段（指标 id / 名称）一律 text，不用 varchar（团队规则 db-migration §2）
--   · tenant_id 用 bigint：与 platform.tenant.id 同型（会话中间件的 guestScopes 收 number）
--   · 主体隔离：metrics/keys/audit 三表一律带 tenant_id，读写一律 where tenant_id = …
--   · token_hash 唯一索引：同一个 token 不可能落两行（也挡住重复写入）
--   · casdoor_user 列存的是 **Casdoor 用户名**（不是 sub）——getUser 只按 name 取，
--     见 apps/server/src/session-middleware.ts 的 casdoor.getUser(p.name) 用法。

create schema if not exists data;

-- ── 指标词表（语义层声明在平台库里的投影）──
create table if not exists data.metrics (
  tenant_id      bigint      not null,
  id             text        not null,
  title          text        not null,
  description    text        not null default '',
  required_scope text,                                  -- NULL = 所有拿到本模块的人可见
  subject_column text        not null,                  -- 主体列名（如 org），授权核心据此拼 WHERE
  select_sql     text        not null,                  -- 不含 WHERE/GROUP BY/LIMIT 的 SELECT
  group_by       text        not null default '',       -- 不含前导空格，如 'org' 或 'org, day'
  params         jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (tenant_id, id)
);

-- ── 个人 Key（通道 B）──
-- 只存哈希：明文 token 只在创建响应里出现一次，永不落库/落日志。
create table if not exists data.query_keys (
  id           bigserial   primary key,
  tenant_id    bigint      not null,
  casdoor_user text        not null,                    -- Casdoor 用户名（不是 sub）
  name         text        not null,
  token_hash   text        not null unique,             -- sha256 hex
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists data_query_keys_tenant_user_idx
  on data.query_keys(tenant_id, casdoor_user);

-- ── 统一审计（三通道一张表）──
create table if not exists data.query_audit (
  id         bigserial   primary key,
  tenant_id  bigint      not null,
  user_id    text        not null,                      -- 通道报告的身份标识（会话=sub，PAT/企微=Casdoor 用户名）
  org_id     text        not null,                      -- 钉死的主体值（= 授权核心写进 SQL 的那个值）
  channel    text        not null,                      -- session | pat | wecom
  key_id     bigint,                                    -- 仅 pat 通道
  metric_id  text        not null,
  params     jsonb       not null default '{}'::jsonb,
  row_count  integer,
  verdict    text        not null,                      -- ok | denied | error
  reason     text,                                      -- 仅 denied/error
  created_at timestamptz not null default now()
);
create index if not exists data_query_audit_tenant_time_idx
  on data.query_audit(tenant_id, created_at desc);
```

- [ ] **Step 5: 写模块装配 + 路由共享层 + 占位前端**

`modules/data/routes/context.ts`：

```ts
// 路由层的共享层：类型 + 参数解析。单独一个文件是为了让 T6–T9 各域互相不 import。
// ⚠️ 引类型务必 `import type`，别把类型当值引（#44 的形状，typecheck 拦不住）。
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'

/**
 * 宿主注入的租户信息（宿主绝对真值，模块只读）。
 * **刻意不是完整的 `TenantRow`**：模块只可能用到这两列，收窄成显式形状后测试里造值不必补
 * 十几个必填字段。`TenantRow` 结构上可赋给本类型（宿主 `c.set('tenant', row)` 那侧无须转换）。
 */
export interface DataTenant {
  id: number
  casdoor_org: string
}

/**
 * 模块路由的统一 Env。identity 由宿主注入（模块自己【不写】门禁）。
 * `TENANT_STORAGE` 不在 Env 里：本模块不声明 `storage`，宿主不会设，设了也没人读。
 * T6 会在此求交请求者上下文：结果形状是
 *   `{ Variables: { identity: Identity; tenant: DataTenant } & RequesterVars }`
 * （`RequesterVars` 来自 `@platform/sdk`，T5 建立）——那是 PAT/企微通道带进来的「人机区分」，
 * 会话通道下不设该键。⚠️ 求交必须落在 `{}` **内层**（写 `ModuleVars & RequesterVars` 会把键搁到
 * Env 顶层，`c.get` 恒 undefined）。见 T5 `requester-vars.ts` 的注记。
 */
export type ModuleVars = { Variables: { identity: Identity; tenant: DataTenant } }

/** 模块路由实例的统一类型。 */
export type ModuleHono = Hono<ModuleVars>

/** 每个域注册时拿到的依赖。**只有 pool**（本模块无租户级存储配置）。 */
export interface RouteCtx {
  pool: Pool
}

/** 路径参数里的 id：只接受十进制正整数字面量，其余一律 null（照 aftersales/routes/context.ts）。 */
export function parseIdParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
```

> **`Context` 泛型的口径（别写错，typecheck 会拦）**：`Hono<ModuleVars>` / `Context<ModuleVars>` 里
> 的泛型参数是**整个 Env 对象**（`{ Variables: … }`），不是 `Variables` 的内容。写
> `Context<{ identity: Identity }>` 会得到 `c.set` 只接受 `never` 的报错。

`modules/data/index.ts`：

```ts
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { ModuleHono, ModuleVars, RouteCtx } from './routes/context'

// 装配形状照 modules/demo/index.ts 与 modules/aftersales/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    // 必须写泛型：裸 `new Hono()` 得到 `Hono<BlankEnv>`，Env 泛型不变 ⇒ 赋给 `ModuleHono` 报错。
    const r: ModuleHono = new Hono<ModuleVars>()
    const _ctx: RouteCtx = { pool }
    // T6/T7/T8 在此逐个 register*（每加一个，同任务里必须同步改 manifest.yaml 的 api.internal）
    void _ctx
    return r
  },
})
```

> `ModuleHono` 是 `routes/context.ts` 导出的类型别名（`Hono<ModuleVars>`）。`index.ts` **不要**再
> 内联写一遍 `Hono<{ Variables: … }>`——T6 给 Env 求交请求者上下文时只改一处。

`modules/data/console/index.tsx`（T1 占位；T9 替换）

```tsx
// T1 占位：manifest 的 frontend.console 已声明本入口，文件必须存在，
// 否则 web 构建期解析不到入口会失败。T9 替换成真页面（页签壳）。
export default function DataConsolePage() {
  return <div>数据问数（建设中）</div>
}
```

`modules/data/README.md`：

```markdown
# modules/data — 数据问数域

三条消费通道、一个授权核心。设计见
`docs/superpowers/specs/2026-09-21-data-query-channels-design.md`，
实施见 `docs/superpowers/plans/2026-09-21-data-query-channels.md`。

- 授权核心：`domain/authz.ts`（纯函数，三通道共用，**不得**在别处再判一次权限）
- 通道差别只在鉴权中间件层：会话（宿主既有）/ PAT（`apps/server/src/pat-auth.ts`）/
  企微（`apps/server/src/wecom-channel-auth.ts`）
- env 键见根 `.env.example`（真值只在 openship env，本仓不写明文）
```

- [ ] **Step 6: 写测试脚手架**

`modules/data/test-util.ts`——**照抄** `modules/aftersales/test-util.ts`，只改三处：默认 scope、模块的 Env 形状（本模块无 storage，多一个 `tenant` 且**可注入**）、模块名：

```ts
// test-util.ts — 模块测试的公共脚手架（不是测试文件：tsconfig 会 typecheck 它）。
import { readdir, readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, ModuleContext, ModuleDefinition } from '@platform/sdk'
// 【刻意】不复制 apps/server/src/migrate.ts 的实现。重跑语义（记账表 platform.schema_migrations、
// 单文件单事务、按文件名排序）是行为契约：复制一份就是第二个事实源，症状是「本地过了 CI 没过」。
import { runMigrations } from '../../apps/server/src/migrate'
import type { DataTenant, ModuleVars } from './routes/context'

/** 造一个身份。默认给问数码。 */
export function makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity {
  const scopes = partial.scopes ?? ['data:query']
  return {
    userId: partial.userId ?? 'u-test',
    orgId: partial.orgId,
    displayName: partial.displayName ?? '测试用户',
    scopes,
    hasScope: (code: string) => scopes.includes(code),
  }
}

/**
 * 模块路由的测试壳：注入 identity 与 tenant 后把模块 router 挂在 '/'。
 * 与宿主 app.ts 的装配【不同源】——租户解析、会话、PAT/企微中间件、门卫、停用闸门都不在这里。
 * 端到端形态（含三通道鉴权）归 apps/server 的测试（T10）。
 *
 * `tenant` 是**第 4 个参数且有默认值**：绝大多数用例只关心 identity，只有断言「主体钉死」的
 * 用例才需要指定 `casdoor_org`（授权核心写进 SQL 的值就来自它）。
 */
export function buildTestApp(
  mod: ModuleDefinition,
  identity: Identity,
  ctx: ModuleContext,
  tenant: DataTenant = { id: 1, casdoor_org: 'test' },
): Hono {
  // 泛型必须写 `ModuleVars`（不是内联 Variables）：`c.set` 的键集会随 Env 走，
  // 裸 `new Hono()` 得到 `BlankEnv` ⇒ `c.set` 只接受 `never`。
  const app = new Hono<ModuleVars>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    c.set('tenant', tenant)
    await next()
  })
  app.route('/', mod.createRouter(ctx))
  // `as unknown as Hono`：Hono 的 Env 泛型不变，带 Variables 的实例【不如约】赋给裸 Hono。
  // 本仓既有绕法（apps/server/src/app.ts 的 mount 处同样这么写）。
  return app as unknown as Hono
}

/** 跑本模块的迁移（读 ./migrations/*.sql）。返回本次新应用的 version 列表。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'data', new URL('./migrations', import.meta.url).pathname)
}

/** 迁移目录里全部 *.sql 的正文，按文件名排序（与 runMigrations 同一排序口径）。 */
export async function rawMigrationSqls(): Promise<string[]> {
  const dir = new URL('./migrations', import.meta.url)
  const entries = await readdir(dir)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  // 基 URL 必须补尾斜杠：不补会把最后一段当【文件名】替换掉（实测 ENOENT）。
  return Promise.all(files.map((f) => readFile(new URL(f, dir.href + '/'), 'utf8')))
}
```

- [ ] **Step 7: 写失败的测试**

`modules/data/module.test.ts`：

```ts
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema } from '@platform/sdk'
import mod from './index'
import { applyMigrations, rawMigrationSqls } from './test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

describe('manifest（不需要数据库）', () => {
  it('manifest.yaml 过 schema，id / 权限码 / 迁移目录自洽', () => {
    const raw = parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8'))
    const m = ManifestSchema.parse(raw)
    expect(m.id).toBe('data')
    expect(m.permissions.map((p) => p.code).sort()).toEqual(['data:manage', 'data:query'])
    expect(m.migrations?.dir).toBe('./migrations')
    // 本模块【不】声明 storage：问数不碰租户级对象存储（数据仓库连接是部署级，见 T3）
    expect(m.storage).toBeUndefined()
  })

  it('api.internal 的声明集合与 createRouter 注册的路由集合逐条一致（装载期双向核对的本地版）', () => {
    const declared = new Set((mod.manifest.api?.internal ?? []).map((e) => `${e.method} ${e.path}`))
    const registered = new Set(
      mod
        .createRouter({ pool: null as never })
        .routes.filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    )
    expect([...registered].sort()).toEqual([...declared].sort())
  })
})

describePg('迁移（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    // 池在本 afterAll 之前就被 end 了 ⇒ 说明有别的钩子提前收摊，本文件后续断言会假红。
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('applyMigrations 幂等：连跑两次，第二次不新应用任何版本', async () => {
    await applyMigrations(pool)
    const second = await applyMigrations(pool)
    expect(second).toEqual([])
  })

  it('迁移 SQL 本身幂等：不记账、直接连跑两遍不报错（部署脚本会全量重跑）', async () => {
    const sqls = await rawMigrationSqls()
    expect(sqls.length).toBeGreaterThan(0)
    for (const sql of sqls) {
      await pool.query(sql)
      await pool.query(sql)
    }
  })

  it('三张表建成，且 data.query_keys.token_hash 唯一', async () => {
    await applyMigrations(pool)
    const t = await pool.query(
      `select table_name from information_schema.tables
        where table_schema = 'data' order by table_name`,
    )
    expect(t.rows.map((r) => r.table_name)).toEqual(['metrics', 'query_audit', 'query_keys'])

    const u = await pool.query(
      `select indexname from pg_indexes
        where schemaname = 'data' and indexdef like '%unique%' and tablename = 'query_keys'`,
    )
    expect(u.rowCount).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 8: 跑测试，确认在实现之前红**

Run: `pnpm --filter data test`
Expected: 初始必红（`./index` 还不存在 → 解析失败）。写到 Step 2–6 的产物齐了之后：

Run: `pnpm --filter data test`
Expected: manifest 两条 PASS；带 `DATABASE_URL` 时四条迁移用例全 PASS（表名断言会先红一次，因为 `001_init.sql` 还没写——这是刻意的红）。

- [ ] **Step 9: 追加 env 键（B9）**

`.env.example` 末尾追加（**只声明键名 + 在哪、怎么取，绝不写真值**）：

```
# ── 数据问数模块（modules/data）────────────────────────────────────────────
# B9 门禁要求：代码里出现的每个 env 键都必须在本文件声明（这里只声明键名）。
# 真值只落 openship env(isSecret)，绝不进仓库/文档/提交信息。
#
# 数据仓库连接（pg_duckdb / Postgres，物化层）。**部署级**，不是租户级——
# 跨租户隔离由授权核心的主体钉死保证（这正是授权必须落在平台的原因）。
# 取法：openship 对应 project 的 env(isSecret)；本机开发指向本地 pg_duckdb。
DATA_WAREHOUSE_URL=
# 企微渠道服务凭证（通道 C）：OpenClaw native plugin → 平台问数 API 的 machine credential。
# 取法：openship env(isSecret) 生成/轮换；**不进** LLM 上下文与用户可见输出。
DATA_WECOM_CHANNEL_KEY=
# per-key 限速（次/分钟），缺省 60（通道 B 防 agent 循环问数打爆 pg_duckdb）。
DATA_QUERY_RATE_PER_MIN=
# 模块内 LLM 编排（通道 A；OpenAI 兼容端点，DeepSeek/wishub 协议）。
# 取法：openship env(isSecret)。key 只在服务端 env，不落浏览器。
DATA_LLM_BASE_URL=
DATA_LLM_API_KEY=
DATA_LLM_MODEL=
```

- [ ] **Step 10: 跑门禁 + 提交**

Run: `node scripts/check-env-example.mjs && pnpm --filter data typecheck && pnpm --filter data test`
Expected: 全绿（带 `DATABASE_URL`）。

```bash
git add modules/data .env.example docs/architecture.md
git commit -m "feat(data): 数据问数模块骨架——三张表/manifest/env 键/测试脚手架"
```

---

# W2 — 授权核心与地基（四路并行）

### Task 2: 授权核心（纯函数）

**这是整个设计的承重件**：spec §1「通道差别只允许存在于鉴权中间件一层」靠它兑现。它是 `/tmp/iam-lab/mcp_authz_server.py` 的产品化——原型实测 11/11，本任务是把它写成有测试的纯函数。

**Files:**
- Create: `modules/data/domain/authz.ts`
- Test: `modules/data/domain/authz.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不碰 pool / env / Hono）
- Produces（T4/T6/T7/T8/T9 全部消费）：

```ts
export type MetricParamType = 'date' | 'string' | 'number'
export interface MetricParamDef { column: string; type: MetricParamType; required?: boolean }

export interface MetricDef {
  id: string
  title: string
  description: string
  requiredScope: string | null          // null = 拿到本模块即可见
  subjectColumn: string                 // 主体列名，如 'org'
  selectSql: string                     // 不含 WHERE / GROUP BY / LIMIT 的 SELECT
  groupBy: string                       // 不含前导空格，如 'org' 或 'org, day'；空串 = 不分组的明细
  params: Record<string, MetricParamDef>
}

export type Channel = 'session' | 'pat' | 'wecom'
export interface Requester {
  userId: string
  orgId: string            // ← SQL 里主体值的唯一来源（钉死）
  channel: Channel
  keyId: number | null
  scopes: string[]
  hasScope: (code: string) => boolean
}

export const MAX_QUERY_ROWS = 1000
export const SUBJECT_RESERVED_KEYS: readonly string[]

export type DenyReason =
  | 'metric_not_declared' | 'metric_not_authorized' | 'subject_pinned_by_platform' | 'bad_param'

export type AuthzResult =
  | { ok: true; plan: { sql: string; metricId: string; subject: string } }
  | { ok: false; reason: DenyReason; metricId: string; detail?: string }

export function visibleMetrics(catalog: MetricDef[], requester: Requester): MetricDef[]
export function authorize(
  catalog: MetricDef[], requester: Requester,
  metricId: string, args: Record<string, unknown>,
): AuthzResult
export function sqlQuote(value: string): string
```

- [ ] **Step 1: 写失败的测试（11 条矩阵的产品化）**

`modules/data/domain/authz.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  MAX_QUERY_ROWS, authorize, sqlQuote, visibleMetrics,
  type MetricDef, type Requester,
} from './authz'

// 词表形状照 /tmp/iam-lab/mcp_authz_server.py 的 CATALOG（原型实测 11/11 的那份）
const CATALOG: MetricDef[] = [
  {
    id: 'mart_sales_daily',
    title: '销售日明细',
    description: '按主体分日的销售明细',
    requiredScope: 'data:query',
    subjectColumn: 'org',
    selectSql: 'SELECT org, day, category, revenue, orders FROM marts.mart_sales_daily',
    groupBy: '',
    params: { day_from: { column: 'day', type: 'date' }, day_to: { column: 'day', type: 'date' } },
  },
  {
    id: 'metrics_revenue_mom',
    title: '主体收入汇总',
    description: '主体收入汇总',
    requiredScope: 'data:query',
    subjectColumn: 'org',
    selectSql: 'SELECT org, round(sum(revenue)) AS revenue, count(*) AS rows FROM marts.mart_sales_daily',
    groupBy: 'org',
    params: {},
  },
  {
    id: 'finance_margin',
    title: '毛利',
    description: '仅财务可见',
    requiredScope: 'data:finance',
    subjectColumn: 'org',
    selectSql: 'SELECT org, margin FROM marts.mart_margin',
    groupBy: 'org',
    params: {},
  },
]

function req(over: Partial<Requester> = {}): Requester {
  const scopes = over.scopes ?? ['data:query']
  return {
    userId: 'alice',
    orgId: 'org_a_lemeng',
    channel: 'session',
    keyId: null,
    scopes,
    hasScope: (code) => scopes.includes(code),
    ...over,
  }
}

describe('visibleMetrics —— 词表裁剪（看不见，不是报错）', () => {
  it('A1 有 data:query → 见两条 query 指标，看不见 finance 那条', () => {
    expect(visibleMetrics(CATALOG, req()).map((m) => m.id))
      .toEqual(['mart_sales_daily', 'metrics_revenue_mom'])
  })

  it('B1 只有部分码 → 只见到对应子集', () => {
    expect(visibleMetrics(CATALOG, req({ scopes: ['data:finance'] })).map((m) => m.id))
      .toEqual(['finance_margin'])
  })

  it('C1 无任何码 → 词表为空（fail-closed）', () => {
    expect(visibleMetrics(CATALOG, req({ scopes: [] }))).toEqual([])
  })
})

describe('authorize —— 主体钉死', () => {
  it('A2 正常查：SQL 只含本主体，且带 LIMIT', () => {
    const r = authorize(CATALOG, req(), 'metrics_revenue_mom', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.subject).toBe('org_a_lemeng')
    expect(r.plan.sql).toContain("WHERE org = 'org_a_lemeng'")
    expect(r.plan.sql).toContain('GROUP BY org')
    expect(r.plan.sql).toContain(`LIMIT ${MAX_QUERY_ROWS}`)
  })

  it('A3 带日期参数：拼成参数化过滤，且值被引号包裹', () => {
    const r = authorize(CATALOG, req(), 'mart_sales_daily', {
      day_from: '2026-08-15', day_to: '2026-08-20',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.sql).toContain("AND day >= '2026-08-15'::date")
    expect(r.plan.sql).toContain("AND day <= '2026-08-20'::date")
  })

  it('A4 注入他人主体参数 → subject_pinned_by_platform（值只来自身份）', () => {
    const r = authorize(CATALOG, req(), 'metrics_revenue_mom', { org: 'org_b_demo' })
    expect(r).toEqual({ ok: false, reason: 'subject_pinned_by_platform', metricId: 'metrics_revenue_mom' })
  })

  it('A5 六个保留键逐个都拒（不是只挡 org 一个）', () => {
    for (const k of ['org', 'subject', 'tenant', 'tenant_id', 'org_id', 'casdoor_org']) {
      const r = authorize(CATALOG, req(), 'metrics_revenue_mom', { [k]: 'org_b_demo' })
      expect(r.ok, `保留键 ${k} 必须被拒`).toBe(false)
      if (!r.ok) expect(r.reason).toBe('subject_pinned_by_platform')
    }
  })

  it('B3 未声明指标 → metric_not_declared（先于授权判定）', () => {
    const r = authorize(CATALOG, req(), 'nope', {})
    expect(r).toEqual({ ok: false, reason: 'metric_not_declared', metricId: 'nope' })
  })

  it('C2 scope 不足 → metric_not_authorized', () => {
    const r = authorize(CATALOG, req({ scopes: [] }), 'metrics_revenue_mom', {})
    expect(r).toEqual({ ok: false, reason: 'metric_not_authorized', metricId: 'metrics_revenue_mom' })
  })

  it('未声明的参数键 → bad_param（客户端不能塞任意列名进 SQL）', () => {
    const r = authorize(CATALOG, req(), 'metrics_revenue_mom', { evil: '1' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('非法日期字面量 → bad_param（引号是拼的，格式必须先验）', () => {
    const r = authorize(CATALOG, req(), 'mart_sales_daily', { day_from: "2026-08-15' OR 1=1 --" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad_param')
  })

  it('单引号被转义（sqlQuote 双写）', () => {
    expect(sqlQuote("a'b")).toBe("'a''b'")
  })
})

describe('maxTurns/上限类不变量', () => {
  it('未知参数类型也走 bad_param 而不是静默忽略', () => {
    const cat: MetricDef[] = [{
      ...CATALOG[1], params: { n: { column: 'n', type: 'number' } },
    }]
    expect(authorize(cat, req(), 'metrics_revenue_mom', { n: 'abc' }).ok).toBe(false)
    expect(authorize(cat, req(), 'metrics_revenue_mom', { n: 3 }).ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter data test domain/authz.test.ts`
Expected: FAIL —— `Cannot find module './authz'`

- [ ] **Step 3: 写实现**

`modules/data/domain/authz.ts`：

```ts
// authz.ts — 问数授权核心（**纯函数**，三通道共用，全仓唯一一份权限判定）。
//
// 不变量（spec §5）：
//   1. 词表裁剪：scopes 之外的指标对调用方**不可见**（不是报错）
//   2. 主体钉死：SQL 里的主体值只来自 Requester.orgId；请求参数里出现保留键一律拒
//   3. fail-closed：未声明 / 未授权 / 参数非法，一律拒并给出可解释 reason
//   4. 回包带钉死主体（plan.subject）——客户端能独立验证
//
// 原型实测 11/11：/tmp/iam-lab/mcp_authz_server.py + run_matrix.py（同序拒绝链）。
// 本文件**不得** import 任何 pool / env / Hono —— 它是纯的，才能被三通道共用且可单测。

export type MetricParamType = 'date' | 'string' | 'number'
export interface MetricParamDef {
  /** 参数落到 SQL 里的列名（参数名 ≠ 列名是常态，如 day_from → day） */
  column: string
  type: MetricParamType
  required?: boolean
}

export interface MetricDef {
  id: string
  title: string
  description: string
  /** null = 拿到本模块即可见 */
  requiredScope: string | null
  subjectColumn: string
  /** 不含 WHERE / GROUP BY / LIMIT 的 SELECT */
  selectSql: string
  /** 不含前导空格；空串 = 不分组 */
  groupBy: string
  params: Record<string, MetricParamDef>
}

export type Channel = 'session' | 'pat' | 'wecom'

export interface Requester {
  userId: string
  /** 主体值（SQL 里 WHERE <subjectColumn> = '<orgId>'）——**只**来自身份解析 */
  orgId: string
  channel: Channel
  /** 仅 pat 通道 */
  keyId: number | null
  scopes: string[]
  hasScope: (code: string) => boolean
}

/** 单次查询行数上界（原型用 10 是演示；产品面 1000，超出即 truncated）。 */
export const MAX_QUERY_ROWS = 1000

/**
 * 主体保留键：请求参数里出现即拒。
 * 这是**唯一**保证「客户端无法指定主体」的地方——DB 连接是跨主体的（pg_duckdb 一条连接
 * 看得到所有租户），SQL 的正确性全靠这里。
 */
export const SUBJECT_RESERVED_KEYS = [
  'org', 'subject', 'tenant', 'tenant_id', 'org_id', 'casdoor_org',
] as const

export type DenyReason =
  | 'metric_not_declared'
  | 'metric_not_authorized'
  | 'subject_pinned_by_platform'
  | 'bad_param'

export type AuthzResult =
  | { ok: true; plan: { sql: string; metricId: string; subject: string } }
  | { ok: false; reason: DenyReason; metricId: string; detail?: string }

/** 词表裁剪：**看不见**，不是调了报错（spec §5 约束 3）。 */
export function visibleMetrics(catalog: MetricDef[], requester: Requester): MetricDef[] {
  return catalog.filter((m) => m.requiredScope === null || requester.hasScope(m.requiredScope))
}

/** 单引号双写（SQL 标准转义）。**只**用于已通过类型校验的值。 */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NUMBER_RE = /^-?\d+(\.\d+)?$/

/** 参数值 → SQL 字面量；非法返回 null（调用方转 bad_param）。 */
function literal(param: MetricParamDef, value: unknown): string | null {
  switch (param.type) {
    case 'date':
      return typeof value === 'string' && DATE_RE.test(value) ? `${sqlQuote(value)}::date` : null
    case 'number': {
      const s = typeof value === 'number' ? String(value) : value
      return typeof s === 'string' && NUMBER_RE.test(s) ? s : null
    }
    case 'string':
      return typeof value === 'string' ? sqlQuote(value) : null
  }
}

/**
 * 授权 + 出计划。拒绝链顺序**照原型**（未声明 → 未授权 → 主体钉死 → 参数），
 * 顺序是有意义的：未授权者拿到的 reason 不泄露「这个指标存在哪些参数」。
 */
export function authorize(
  catalog: MetricDef[],
  requester: Requester,
  metricId: string,
  args: Record<string, unknown>,
): AuthzResult {
  const metric = catalog.find((m) => m.id === metricId)
  if (!metric) return { ok: false, reason: 'metric_not_declared', metricId }
  if (metric.requiredScope !== null && !requester.hasScope(metric.requiredScope)) {
    return { ok: false, reason: 'metric_not_authorized', metricId }
  }

  for (const key of Object.keys(args)) {
    if ((SUBJECT_RESERVED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: 'subject_pinned_by_platform', metricId }
    }
  }

  const filters: string[] = []
  for (const [name, value] of Object.entries(args)) {
    const param = metric.params[name]
    if (!param) return { ok: false, reason: 'bad_param', metricId, detail: `unknown_param:${name}` }
    if (value === undefined || value === null || value === '') continue
    const lit = literal(param, value)
    if (lit === null) return { ok: false, reason: 'bad_param', metricId, detail: `invalid_value:${name}` }
    filters.push(` AND ${param.column} = ${lit}`)
  }
  for (const [name, param] of Object.entries(metric.params)) {
    const v = args[name]
    if (param.required && (v === undefined || v === null || v === '')) {
      return { ok: false, reason: 'bad_param', metricId, detail: `missing_param:${name}` }
    }
  }

  // 主体值只来自 requester.orgId —— 本行是本文件存在的理由
  const subject = requester.orgId
  const sql =
    `${metric.selectSql} WHERE ${metric.subjectColumn} = ${sqlQuote(subject)}` +
    filters.join('') +
    (metric.groupBy ? ` GROUP BY ${metric.groupBy}` : '') +
    ` LIMIT ${MAX_QUERY_ROWS}`

  return { ok: true, plan: { sql, metricId, subject } }
}
```

> `params` 只支持 `=` 比较（不是 `>=`）。原型的 `day_from >=` 是演示形态；产品面用显式列名 + `=` 更保守，需要区间就声明两个指标或后续加 `op` 字段（**不在本计划范围**，别顺手加）。

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm --filter data test domain/authz.test.ts`
Expected: PASS（11 条）

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/authz.ts modules/data/domain/authz.test.ts
git commit -m "feat(data): 授权核心——词表裁剪/主体钉死/fail-closed（原型 11/11 产品化）"
```

---

### Task 3: 存储层（词表 / Key / 审计 / 仓库连接）

**Files:**
- Create: `modules/data/domain/metric-store.ts`
- Create: `modules/data/domain/key-store.ts`
- Create: `modules/data/domain/audit-store.ts`
- Create: `modules/data/domain/warehouse.ts`
- Test: `modules/data/domain/key-store.test.ts`
- Test: `modules/data/domain/metric-store.test.ts`
- Test: `modules/data/domain/audit-store.test.ts`

**Interfaces:**
- Consumes: T1 的三张表；`domain/authz.ts` 的 `MetricDef` / `Channel`
- Produces（T4/T6/T7/T8/T10 消费）：

```ts
// metric-store.ts
export async function loadCatalog(pool: Pool, tenantId: number): Promise<MetricDef[]>
export async function upsertMetric(pool: Pool, tenantId: number, def: MetricDef): Promise<void>
export async function deleteMetric(pool: Pool, tenantId: number, id: string): Promise<boolean>

// key-store.ts
export const PAT_PREFIX: string                       // 'dkq_'
export const MAX_KEY_NAME_LEN: number                 // 64
export function newPatToken(): string                 // PAT_PREFIX + base64url(32 字节)
export function hashPat(token: string): string        // sha256 hex
export async function createPatKey(pool: Pool, tenantId: number, casdoorUser: string, name: string): Promise<{ id: number; token: string }>
export async function listPatKeys(pool: Pool, tenantId: number, casdoorUser: string): Promise<PatKeyRow[]>
export async function revokePatKey(pool: Pool, tenantId: number, casdoorUser: string, id: number): Promise<boolean>
export async function resolvePat(pool: Pool, token: string): Promise<ResolvedPat | null>
export async function touchPatKey(pool: Pool, id: number): Promise<void>
export interface PatKeyRow { id: number; name: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }
export interface ResolvedPat { keyId: number; tenantId: number; casdoorUser: string }

// audit-store.ts
export interface AuditEntry {
  tenantId: number; userId: string; orgId: string; channel: Channel
  keyId: number | null; metricId: string; params: Record<string, unknown>
  rowCount: number | null; verdict: 'ok' | 'denied' | 'error'; reason: string | null
}
export async function writeAudit(pool: Pool, entry: AuditEntry): Promise<void>

// warehouse.ts
export function warehouseConfigured(env?: Record<string, string | undefined>): boolean
export function warehousePool(env?: Record<string, string | undefined>): Pool   // 惰性单例；未配 ⇒ throw
export async function runWarehouseSql(pool: Pool, sql: string): Promise<{ columns: string[]; rows: unknown[][] }>
export const DATA_WAREHOUSE_UNCONFIGURED: string       // 'DATA_WAREHOUSE_UNCONFIGURED'
```

- [ ] **Step 1: 写失败的测试（key-store 是重点，哈希是跨进程契约）**

`modules/data/domain/key-store.test.ts`：

```ts
import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { PAT_PREFIX, createPatKey, hashPat, listPatKeys, newPatToken, resolvePat, revokePatKey, touchPatKey } from './key-store'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const TENANT = 9001

describe('token 形状（不需要数据库）', () => {
  it('前缀是 dkq_，32 字节随机 → base64url', () => {
    const t = newPatToken()
    expect(t.startsWith(PAT_PREFIX)).toBe(true)
    expect(t.length).toBeGreaterThan(40)
    expect(newPatToken()).not.toBe(t)          // 每次都不同
  })

  it('hashPat 与宿主中间件那条行**逐字一致**（跨进程契约，见 Global Constraints 5）', () => {
    const token = 'dkq_fixture-token'
    // ↓↓ 这一行必须与 apps/server/src/pat-auth.ts 里的实现完全相同
    const expected = createHash('sha256').update(token).digest('hex')
    expect(hashPat(token)).toBe(expected)
    expect(hashPat(token)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describePg('key-store（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_keys where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('建 key → 库里只有哈希，明文只在返回值里', async () => {
    await applyMigrations(pool)
    const { id, token } = await createPatKey(pool, TENANT, 'alice', '我的 key')
    expect(token.startsWith(PAT_PREFIX)).toBe(true)

    const raw = await pool.query('select token_hash from data.query_keys where id = $1', [id])
    expect(raw.rows[0].token_hash).toBe(hashPat(token))
    expect(raw.rows[0].token_hash).not.toContain(token)   // 明文不落库
  })

  it('resolvePat 命中 / 未知 token 返 null / 吊销后立刻失效', async () => {
    const { id, token } = await createPatKey(pool, TENANT, 'bob', 'k')
    const hit = await resolvePat(pool, token)
    expect(hit).toEqual({ keyId: id, tenantId: TENANT, casdoorUser: 'bob' })

    expect(await resolvePat(pool, 'dkq_never-existed')).toBeNull()

    expect(await revokePatKey(pool, TENANT, 'bob', id)).toBe(true)
    expect(await resolvePat(pool, token)).toBeNull()       // 吊销即时生效
  })

  it('listPatKeys 只列自己的，且 revoked 标记正确', async () => {
    const { id } = await createPatKey(pool, TENANT, 'carol', 'c1')
    const other = await createPatKey(pool, TENANT, 'dave', 'd1')
    const mine = await listPatKeys(pool, TENANT, 'carol')
    expect(mine.map((k) => k.id)).toContain(id)
    expect(mine.map((k) => k.id)).not.toContain(other.id)
    await revokePatKey(pool, TENANT, 'carol', id)
    expect((await listPatKeys(pool, TENANT, 'carol')).find((k) => k.id === id)?.revoked).toBe(true)
  })

  it('revokePatKey 对别人的 key 返 false（不能吊销别人的）', async () => {
    const { id } = await createPatKey(pool, TENANT, 'erin', 'e1')
    expect(await revokePatKey(pool, TENANT, 'frank', id)).toBe(false)
  })

  it('touchPatKey 写 last_used_at', async () => {
    const { id } = await createPatKey(pool, TENANT, 'gina', 'g1')
    await touchPatKey(pool, id)
    const r = await pool.query('select last_used_at from data.query_keys where id = $1', [id])
    expect(r.rows[0].last_used_at).not.toBeNull()
  })
})
```

`modules/data/domain/metric-store.test.ts` 与 `audit-store.test.ts` 用同一 `describePg` + 独立 `TENANT` 常量的形状：metric-store 测 `upsertMetric` 幂等（同 id 两次 → 一行、字段被覆盖）、`loadCatalog` 只回本租户、`deleteMetric` 返 true/false；audit-store 测写入后各列就对（尤其 `row_count: null` 与 `params` 的 jsonb 往返）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter data test domain/key-store.test.ts`
Expected: FAIL —— `Cannot find module './key-store'`

- [ ] **Step 3: 写 key-store.ts（含那行逐字哈希）**

```ts
// key-store.ts — 个人 Key（通道 B）的存储层。
//
// ⚠️ 哈希那一行必须与 apps/server/src/pat-auth.ts 里的实现**逐字一致**：
//     createHash('sha256').update(token).digest('hex')
//   两侧不共享代码是刻意的——宿主静态 import 模块是架构违规，且会打掉 worktree 并行。
//   漂移风险由 T10 的往返契约测试兜（模块建 key → 宿主中间件验 key）。
import { createHash } from 'node:crypto'
import { randomBytes } from 'node:crypto'
import type { Pool } from 'pg'

export const PAT_PREFIX = 'dkq_'
export const MAX_KEY_NAME_LEN = 64

export interface PatKeyRow {
  id: number
  name: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}
export interface ResolvedPat {
  keyId: number
  tenantId: number
  casdoorUser: string
}

/** 32 字节随机 → base64url，带可辨识前缀（日志/告警里一眼认出是 PAT）。 */
export function newPatToken(): string {
  return PAT_PREFIX + randomBytes(32).toString('base64url')
}

export function hashPat(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 建 key：明文只在本函数的返回值里出现这一次，库里只有哈希。
 * 名称超长/空 ⇒ 抛（路由层先校验，这里是最后一道）。
 */
export async function createPatKey(
  pool: Pool, tenantId: number, casdoorUser: string, name: string,
): Promise<{ id: number; token: string }> {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_KEY_NAME_LEN) {
    throw new Error(`key 名称长度必须是 1..${MAX_KEY_NAME_LEN}`)
  }
  const token = newPatToken()
  const r = await pool.query(
    `insert into data.query_keys (tenant_id, casdoor_user, name, token_hash)
     values ($1, $2, $3, $4) returning id`,
    [tenantId, casdoorUser, trimmed, hashPat(token)],
  )
  // ⚠️ node-pg 把 bigint(int8) 读成 **string** —— 不归一，后面 `===` 比较与 JSON 回包都会变味
  return { id: Number(r.rows[0].id), token }
}

export async function listPatKeys(
  pool: Pool, tenantId: number, casdoorUser: string,
): Promise<PatKeyRow[]> {
  const r = await pool.query(
    `select id, name, created_at, last_used_at, revoked_at
       from data.query_keys
      where tenant_id = $1 and casdoor_user = $2
      order by created_at desc`,
    [tenantId, casdoorUser],
  )
  return r.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revoked: row.revoked_at !== null,
  }))
}

/** 吊销：**必须带 casdoor_user** —— 不带就能吊销别人的 key。返回是否真命中一行。 */
export async function revokePatKey(
  pool: Pool, tenantId: number, casdoorUser: string, id: number,
): Promise<boolean> {
  const r = await pool.query(
    `update data.query_keys set revoked_at = now()
      where id = $1 and tenant_id = $2 and casdoor_user = $3 and revoked_at is null`,
    [id, tenantId, casdoorUser],
  )
  return (r.rowCount ?? 0) > 0
}

/** 解析 token → 主体。已吊销 / 不存在一律 null（fail-closed）。 */
export async function resolvePat(pool: Pool, token: string): Promise<ResolvedPat | null> {
  const r = await pool.query(
    `select id, tenant_id, casdoor_user from data.query_keys
      where token_hash = $1 and revoked_at is null`,
    [hashPat(token)],
  )
  if (r.rowCount === 0) return null
  const row = r.rows[0]
  return { keyId: Number(row.id), tenantId: Number(row.tenant_id), casdoorUser: row.casdoor_user }
}

/** 记一次使用。fire-and-forget 调用（失败不阻断问数）。 */
export async function touchPatKey(pool: Pool, id: number): Promise<void> {
  await pool.query('update data.query_keys set last_used_at = now() where id = $1', [id])
}
```

- [ ] **Step 4: 写 metric-store.ts / audit-store.ts / warehouse.ts**

`metric-store.ts` 要点：`loadCatalog` 的 `where tenant_id = $1`；`upsertMetric` 用 `on conflict (tenant_id, id) do update set …, updated_at = now()`（幂等，团队规则 db-migration §1）；行 → `MetricDef` 的映射里 `params` 是 jsonb（pg 已反序列化成对象）。

`audit-store.ts` 要点：单条 `insert`，`params` 用 `JSON.stringify(entry.params)` 传（pg 的 jsonb 参数位接受字符串）或直接传对象；`rowCount` 传 `null` 时列可空。

`warehouse.ts`：

```ts
// warehouse.ts — 数据仓库连接（pg_duckdb，物化层）。
//
// ⚠️ 这是**部署级**连接，不是租户级：一条连接看得到所有租户的数据。
//   这不违反 M3c「装载期不读任何配置」——那条规矩管的是**租户级存储配置**
//   （每租户一份 bucket/AK，必须在请求期投影）。仓库连接全部署一份，租户隔离由
//   授权核心的**主体钉死**保证（这正是授权必须落在平台、而不是落在那条连接上的原因）。
import { Pool } from 'pg'

export const DATA_WAREHOUSE_UNCONFIGURED = 'DATA_WAREHOUSE_UNCONFIGURED'
const STATEMENT_TIMEOUT_MS = 30_000

export function warehouseConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.DATA_WAREHOUSE_URL?.trim()
  return Boolean(v)
}

let singleton: Pool | null = null

/** 惰性单例：模块装载期**不**建连接（没配仓库的部署也要能起来）。 */
export function warehousePool(env: Record<string, string | undefined> = process.env): Pool {
  if (singleton) return singleton
  const url = env.DATA_WAREHOUSE_URL?.trim()
  if (!url) throw new Error(DATA_WAREHOUSE_UNCONFIGURED)
  singleton = new Pool({ connectionString: url, statement_timeout: STATEMENT_TIMEOUT_MS })
  return singleton
}

/** 测试钩子：清掉单例（换 env 的用例之间必须调）。 */
export function resetWarehousePool(): void {
  singleton = null
}

/** 执行并归一成 { columns, rows }（pg 的 Result 带 command/oid 等噪声，不外泄）。 */
export async function runWarehouseSql(
  pool: Pool, sql: string,
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const r = await pool.query(sql)
  const columns = r.fields.map((f) => f.name)
  const rows = r.rows.map((row) => columns.map((c) => (row as Record<string, unknown>)[c]))
  return { columns, rows }
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter data test domain/`
Expected: PASS（authz + 三个 store 全绿）

- [ ] **Step 6: 提交**

```bash
git add modules/data/domain/metric-store.ts modules/data/domain/key-store.ts \
        modules/data/domain/audit-store.ts modules/data/domain/warehouse.ts \
        modules/data/domain/*.test.ts
git commit -m "feat(data): 存储层——词表/Key/审计/仓库连接（PAT 只存 SHA-256）"
```

---

### Task 4: 问数编排 `runQuery`（授权 → 执行 → 审计）

**它是三通道唯一的执行入口**：通道差别到 `Requester` 为止，之后所有通道走的是同一条路径。审计在**所有**结局都写（spec §5 约束 7）。

**Files:**
- Create: `modules/data/domain/query-service.ts`
- Test: `modules/data/domain/query-service.test.ts`

**Interfaces:**
- Consumes: T2 的 `authorize` / `visibleMetrics` / `Requester` / `DenyReason`；T3 的 `loadCatalog` / `writeAudit` / `warehousePool` / `runWarehouseSql` / `DATA_WAREHOUSE_UNCONFIGURED`
- Produces（T6/T8/T9/T10 消费）：

```ts
/** SQL 执行器。命名出来是为了让 T6 的 `RouteCtx`、T8/T9 的 deps 都能引用同一个形状，
 *  而不是各自内联一份（内联三份 = 改一处漏两处）。`pg_duckdb` 侧由 T3 的 `runWarehouseSql` 提供。 */
export type SqlExecutor = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>

export interface QueryDeps {
  pool: Pool                // 平台库（词表 + 审计）
  execute?: SqlExecutor     // 缺省 = 真仓库（T3 的 runWarehouseSql）
}
export interface QueryOk { status: 'ok'; subject: string; metricId: string; columns: string[]; rows: unknown[][]; truncated: boolean }
export interface QueryDenied { status: 'denied'; metricId: string; reason: DenyReason | 'unauthenticated'; detail?: string }
export interface QueryError { status: 'error'; metricId: string; reason: 'warehouse_unconfigured' | 'warehouse_error'; detail: string }
export type QueryOutcome = QueryOk | QueryDenied | QueryError

export async function runQuery(
  deps: QueryDeps, tenantId: number, requester: Requester | null,
  metricId: string, args: Record<string, unknown>,
): Promise<QueryOutcome>
```

> `requester: Requester | null` 是刻意的：`null` = 匿名（无身份），返回 `denied/unauthenticated` 并**写审计**（原型 N2 的语义）。

- [ ] **Step 1: 写失败的测试**

`modules/data/domain/query-service.test.ts`：

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { runQuery, type QueryDeps } from './query-service'
import { upsertMetric } from './metric-store'
import { applyMigrations } from '../test-util'
import type { Requester } from './authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const TENANT = 9002

const METRIC = {
  id: 'sales_daily', title: '销售日明细', description: '',
  requiredScope: 'data:query', subjectColumn: 'org',
  selectSql: 'SELECT org, day FROM marts.sales_daily', groupBy: '', params: {},
}

function req(over: Partial<Requester> = {}): Requester {
  const scopes = over.scopes ?? ['data:query']
  return {
    userId: 'alice', orgId: 'org_a', channel: 'session', keyId: null, scopes,
    hasScope: (c) => scopes.includes(c), ...over,
  }
}

describePg('runQuery（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  // 注入假仓库：本任务只验编排，不验 SQL 真跑（真跑归 T10 的 e2e）
  let lastSql = ''
  const deps: QueryDeps = {
    pool,
    execute: async (sql) => {
      lastSql = sql
      return { columns: ['org', 'day'], rows: [['org_a', '2026-08-15']] }
    },
  }

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_audit where tenant_id = $1', [TENANT])
    await upsertMetric(pool, TENANT, METRIC)
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.query('delete from data.metrics where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('ok：执行 SQL 只带本主体，回包带 subject，审计记 ok + 行数', async () => {
    const out = await runQuery(deps, TENANT, req(), 'sales_daily', {})
    expect(out.status).toBe('ok')
    if (out.status !== 'ok') return
    expect(out.subject).toBe('org_a')
    expect(out.rows).toEqual([['org_a', '2026-08-15']])
    expect(lastSql).toContain("WHERE org = 'org_a'")

    const a = await pool.query(
      `select channel, key_id, verdict, row_count, reason from data.query_audit
        where tenant_id = $1 order by id desc limit 1`, [TENANT])
    expect(a.rows[0]).toMatchObject({ channel: 'session', key_id: null, verdict: 'ok', row_count: 1 })
  })

  it('denied：未授权指标 —— 不执行 SQL，但审计照写', async () => {
    const out = await runQuery(deps, TENANT, req({ scopes: [] }), 'sales_daily', {})
    expect(out).toEqual({ status: 'denied', metricId: 'sales_daily', reason: 'metric_not_authorized' })
    lastSql = ''
    const a = await pool.query(
      `select verdict, reason from data.query_audit where tenant_id = $1 order by id desc limit 1`, [TENANT])
    expect(a.rows[0]).toMatchObject({ verdict: 'denied', reason: 'metric_not_authorized' })
    expect(lastSql).toBe('')                                   // 被拒 ⇒ 从未触达仓库
  })

  it('denied：匿名（requester = null）→ unauthenticated', async () => {
    const out = await runQuery(deps, TENANT, null, 'sales_daily', {})
    expect(out).toEqual({ status: 'denied', metricId: 'sales_daily', reason: 'unauthenticated' })
  })

  it('denied：PAT 通道的 key_id 落进审计（通道 B 可追溯到具体 key）', async () => {
    await runQuery(deps, TENANT, req({ channel: 'pat', keyId: 42 }), 'sales_daily', {})
    const a = await pool.query(
      `select channel, key_id from data.query_audit where tenant_id = $1 order by id desc limit 1`, [TENANT])
    expect(a.rows[0]).toMatchObject({ channel: 'pat', key_id: '42' })
  })

  it('error：仓库执行抛错 → status:error + 审计 verdict=error', async () => {
    const bad: QueryDeps = { pool, execute: async () => { throw new Error('boom') } }
    const out = await runQuery(bad, TENANT, req(), 'sales_daily', {})
    expect(out.status).toBe('error')
    if (out.status !== 'error') return
    expect(out.reason).toBe('warehouse_error')
    const a = await pool.query(
      `select verdict, reason from data.query_audit where tenant_id = $1 order by id desc limit 1`, [TENANT])
    expect(a.rows[0]).toMatchObject({ verdict: 'error', reason: 'warehouse_error' })
  })

  it('truncated：行数达到上限时置位', async () => {
    const many: QueryDeps = {
      pool,
      execute: async () => ({ columns: ['org'], rows: Array.from({ length: 1000 }, () => ['org_a']) }),
    }
    const out = await runQuery(many, TENANT, req(), 'sales_daily', {})
    expect(out.status === 'ok' && out.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter data test domain/query-service.test.ts`
Expected: FAIL —— `Cannot find module './query-service'`

- [ ] **Step 3: 写实现**

```ts
// query-service.ts — 三通道**唯一**的执行入口。
//
// 通道差别到 Requester 为止：拿到 Requester 之后，会话/PAT/企微走的是同一条路径。
// 审计在**所有**结局都写（spec §5 约束 7）——包括被拒与出错，否则「为什么被拒」查不出来。
import type { Pool } from 'pg'
import { MAX_QUERY_ROWS, authorize, type DenyReason, type Requester } from './authz'
import { loadCatalog } from './metric-store'
import { writeAudit } from './audit-store'
import { DATA_WAREHOUSE_UNCONFIGURED, runWarehouseSql, warehousePool } from './warehouse'

/** 见 Interfaces 块：命名出来，供 T6 的 RouteCtx 与 T8/T9 的 deps 共同引用。 */
export type SqlExecutor = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>

export interface QueryDeps {
  pool: Pool
  /** 缺省 = 真仓库（惰性连接）。测试注入假执行器。 */
  execute?: SqlExecutor
}

export interface QueryOk {
  status: 'ok'; subject: string; metricId: string
  columns: string[]; rows: unknown[][]; truncated: boolean
}
export interface QueryDenied {
  status: 'denied'; metricId: string
  reason: DenyReason | 'unauthenticated'; detail?: string
}
export interface QueryError {
  status: 'error'; metricId: string
  reason: 'warehouse_unconfigured' | 'warehouse_error'; detail: string
}
export type QueryOutcome = QueryOk | QueryDenied | QueryError

export async function runQuery(
  deps: QueryDeps,
  tenantId: number,
  requester: Requester | null,
  metricId: string,
  args: Record<string, unknown>,
): Promise<QueryOutcome> {
  const audit = (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
  ) => writeAudit(deps.pool, {
    tenantId,
    userId: requester?.userId ?? '(anonymous)',
    orgId: requester?.orgId ?? '',
    channel: requester?.channel ?? 'session',
    keyId: requester?.keyId ?? null,
    metricId,
    params: args,
    rowCount,
    verdict,
    reason,
  })

  if (!requester) {
    await audit('denied', 'unauthenticated', null)
    return { status: 'denied', metricId, reason: 'unauthenticated' }
  }

  const catalog = await loadCatalog(deps.pool, tenantId)
  const authz = authorize(catalog, requester, metricId, args)
  if (!authz.ok) {
    await audit('denied', authz.reason, null)
    return { status: 'denied', metricId, reason: authz.reason, detail: authz.detail }
  }

  let result: { columns: string[]; rows: unknown[][] }
  try {
    if (deps.execute) {
      result = await deps.execute(authz.plan.sql)
    } else {
      result = await runWarehouseSql(warehousePool(), authz.plan.sql)
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const reason = detail === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured' : 'warehouse_error'
    await audit('error', reason, null)
    return { status: 'error', metricId, reason, detail }
  }

  await audit('ok', null, result.rows.length)
  return {
    status: 'ok',
    subject: authz.plan.subject,
    metricId,
    columns: result.columns,
    rows: result.rows,
    truncated: result.rows.length >= MAX_QUERY_ROWS,
  }
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter data test domain/query-service.test.ts`
Expected: PASS（6 条）

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/query-service.ts modules/data/domain/query-service.test.ts
git commit -m "feat(data): runQuery 编排——授权→执行→审计（所有结局都留痕）"
```

---

### Task 5: 宿主鉴权中间件（PAT + 企微）+ config + SDK 常量

**纯宿主侧任务，不碰 `modules/data/**`**（理由见 W2 并行边界）。它自带哈希行与查询 SQL——这是刻意重复，漂移由 T10 的往返契约测试兜。

**Files:**
- Create: `apps/server/src/pat-auth.ts`
- Create: `apps/server/src/wecom-channel-auth.ts`
- Create: `packages/platform-sdk/src/requester-vars.ts`
- Modify: `packages/platform-sdk/src/index.ts`（导出两个常量）
- Modify: `apps/server/src/config.ts`（加三个 data 配置键）
- Modify: `apps/server/src/app.ts:218`（sessionMiddleware 之后插两行 `app.use`）
- Test: `apps/server/src/pat-auth.test.ts`
- Test: `apps/server/src/wecom-channel-auth.test.ts`

**Interfaces:**
- Consumes: `@platform/auth-core` 的 `effectiveScopes` / `CasdoorClient` / `CasdoorUser`；`./session-middleware` 的 `CasdoorFactory` / `SessionEnv`；`./tenant` 的 `TenantEnv`
- Produces（T6/T10 消费）：

```ts
// packages/platform-sdk/src/requester-vars.ts
export const REQUESTER_CHANNEL = 'platform.requesterChannel'
export const REQUESTER_KEY_ID = 'platform.requesterKeyId'
/** Variables 片段（**不是**整个 Env）——交给宿主与模块各自求交自己的 Env。 */
export type RequesterVars = { [REQUESTER_CHANNEL]?: 'pat' | 'wecom'; [REQUESTER_KEY_ID]?: number }

// apps/server/src/pat-auth.ts
export interface PatAuthDeps { pool: Pool; casdoor: CasdoorFactory; ratePerMin?: number; now?: () => number }
/** 宿主侧两个中间件共用的 Env：租户 + 会话 + 请求者上下文。 */
export type RequesterEnv = TenantEnv & SessionEnv & { Variables: RequesterVars }
export function patIdentityMiddleware(deps: PatAuthDeps): MiddlewareHandler<RequesterEnv>
export const PAT_PREFIX = 'dkq_'          // 与 modules/data 的 key-store 同值（刻意各写一份）

// apps/server/src/wecom-channel-auth.ts
export interface WecomChannelAuthDeps { casdoor: CasdoorFactory; channelKey?: string }
export function wecomChannelIdentityMiddleware(deps: WecomChannelAuthDeps): MiddlewareHandler<RequesterEnv>
export const WECOM_USERID_HEADER = 'x-wecom-userid'
```

> **为什么 `MiddlewareHandler` 必须带泛型**（本仓实测口径）：`createMiddleware(fn)` 若不显式给泛型，
> 推出来的 `c` 是 `Context<BlankEnv>`，`c.set('identity', …)` 会报「参数类型 `Identity` 不能赋给
> `never`」。既有实现都这么写，照抄即可：
> `session-middleware.ts:124` = `(deps): MiddlewareHandler<TenantEnv & SessionEnv> => createMiddleware<TenantEnv & SessionEnv>(async (c, next) => {…})`；
> `tenant.ts:107` = `(deps): MiddlewareHandler<TenantEnv> => createMiddleware<TenantEnv>(…)`。
> **返回类型注解与 `createMiddleware` 的泛型参数必须同时写** —— 只写前者，上下文类型不会反向流入。

- [ ] **Step 1: 写失败的测试**

`apps/server/src/pat-auth.test.ts`（用真 HTTP MockCasdoor，照 `apps/server/src/app.test.ts` 的装配）：

```ts
import { afterAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { CasdoorClient } from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import { patIdentityMiddleware, type RequesterEnv } from './pat-auth'
import type { TenantRow } from './tenant'
import { createHash } from 'node:crypto'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const TENANT = 9003
const ORG = 'acme'

/** 租户字面量必须写全——缺一个字段就 TS2741，而且**后加的列最容易漏**，
 *  漏了就成了「测试替身比真机窄」。照 apps/server/src/routes/admin.test.ts:67 的写法。 */
const baseTenant: TenantRow = {
  id: TENANT, slug: 'acme', casdoor_org: ORG, product_name: 'P', logo: null,
  primary_color: '#1677ff', background: '', login_methods: ['password'],
  wecom_corp_id: null, wecom_agent_id: null, wecom_secret: null, wecom_provider: null,
  wecom_auto_signup: false,
  wechat_oa_app_id: null, wechat_oa_secret: null,
  storage_endpoint: null, storage_region: null, storage_bucket: null,
  storage_access_key: null, storage_secret: null,
  created_at: new Date(),
}

/** 本文件**自己**算哈希建 key：不 import 模块，正是为了证明「宿主不依赖模块」。
 *  也正因为这一行是独立实现，它与 key-store 的 hashPat 之间**没有**编译期约束——
 *  一致性只有 T10 的往返契约测试能证。别在这里图省事改成 import 模块的实现。 */
async function seedKey(pool: Pool, token: string, casdoorUser: string) {
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const r = await pool.query(
    `insert into data.query_keys (tenant_id, casdoor_user, name, token_hash)
     values ($1, $2, 'test', $3) returning id`, [TENANT, casdoorUser, tokenHash])
  return Number(r.rows[0].id)
}

/**
 * ⚠️ MockCasdoor 的用户/权限是**构造时播种**的（`MockCasdoorOptions`），**没有**
 * addUser / addPerm / removeUser / client(org) 这些方法。要几个人就在构造时给几个，
 * 想加人只能新建实例 ⇒ 每个用例各自 `new` 一个，不要指望跨用例复用。
 *
 * ⚠️ `get-permissions` 认 `owner=`，且**权限按 owner 分桶**：客户端 org 必须与被测租户的
 * `casdoor_org` 一致，否则拿到的是空权限（症状：`scopes: []`，看着像"权限配错了"）。
 */
function casdoorFor(mock: MockCasdoor) {
  return (org: string) =>
    new CasdoorClient({
      origin: mock.origin, clientId: 'test-client', clientSecret: '', org,
      adminUser: 'admin', adminPwd: 'pw',
    })
}

/** 一个「alice 在 acme、有 data:query」的 mock。绝大多数用例要的就是它。 */
const withAlice = () =>
  new MockCasdoor({
    users: [{ name: 'alice', password: 'pw', owner: ORG }],
    perms: [{ owner: ORG, users: ['alice'], resources: ['data:query'] }],
  })

describePg('patIdentityMiddleware（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_keys where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.end().catch(() => {})
  })

  /** 假 tenant 中间件 + 被测中间件 + 回显 handler。
   *  Env 泛型**必须**是 `RequesterEnv`（= TenantEnv & SessionEnv & { Variables: RequesterVars }）：
   *  `c.set('tenant', …)` 与 `c.get(REQUESTER_CHANNEL)` 都靠它，裸 `new Hono()` 会得到 BlankEnv。 */
  function app(mock: MockCasdoor, ratePerMin = 60) {
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => {
      c.set('tenant', baseTenant)
      await next()
    })
    a.use('/api/modules/*', patIdentityMiddleware({
      pool, casdoor: casdoorFor(mock), ratePerMin,
    }))
    a.post('/api/modules/data/query', (c) => c.json({
      userId: c.get('identity')?.userId ?? null,
      scopes: c.get('identity')?.scopes ?? null,
      channel: c.get(REQUESTER_CHANNEL) ?? null,
      keyId: c.get(REQUESTER_KEY_ID) ?? null,
    }))
    return a
  }

  it('有效 PAT → 注入 live scopes + 通道 / keyId', async () => {
    const mock = withAlice()
    await mock.start()
    const token = 'dkq_roundtrip-1'
    const keyId = await seedKey(pool, token, 'alice')

    const res = await app(mock).request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    const body = await res.json()
    expect(body).toMatchObject({ userId: 'alice', channel: 'pat', keyId })
    expect(body.scopes).toContain('data:query')
    await mock.stop()
  })

  it('未知 token → 401 INVALID_KEY（不落到下一层）', async () => {
    const mock = withAlice(); await mock.start()
    const res = await app(mock).request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: 'Bearer dkq_nope' },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('INVALID_KEY')
    await mock.stop()
  })

  it('Casdoor 挂 → 503 CASDOOR_UNAVAILABLE（**不**降级用旧权限——PAT 没有旧权限可降）', async () => {
    const token = 'dkq_roundtrip-down'
    await seedKey(pool, token, 'alice')
    const mock = withAlice(); await mock.start()
    await mock.stop()   // 关掉 → 连接失败
    const res = await app(mock).request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('CASDOOR_UNAVAILABLE')
  })

  it('用户已被删 → 401 USER_GONE（getUser 返 null，不是抛错）', async () => {
    // 库里坐着 ghost 的 key，但 mock 里**没有** ghost 这个人（构造时就不播种他）。
    // 真机口径：查无此人 ⇒ 200 + `{status:'ok', data:null}` ⇒ client 返 null；
    // 而 `{status:'error'}` 是另一堆情形（admin 会话失效等），client 会**抛**（走 503 分支）。
    // 想造后者用 `mock.setGetUserFault('error')`，别指望"删人"——mock 没有删除方法。
    const mock = withAlice(); await mock.start()
    const token = 'dkq_roundtrip-gone'
    await seedKey(pool, token, 'ghost')
    const res = await app(mock).request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('USER_GONE')
    await mock.stop()
  })

  it('已有 identity（会话通道）→ 不覆盖（first-setter-wins）', async () => {
    const mock = withAlice(); await mock.start()
    const a = new Hono<RequesterEnv>()
    a.use('*', async (c, next) => {
      c.set('tenant', baseTenant)
      c.set('identity', { userId: 'sess', orgId: ORG, displayName: 'sess', scopes: [], hasScope: () => false })
      await next()
    })
    a.use('/api/modules/*', patIdentityMiddleware({ pool, casdoor: casdoorFor(mock) }))
    a.post('/api/modules/data/query', (c) => c.json({ userId: c.get('identity').userId }))
    const res = await a.request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: 'Bearer dkq_roundtrip-1' },
    })
    expect((await res.json()).userId).toBe('sess')
    await mock.stop()
  })

  it('非 dkq_ 的 Bearer → 放行（不是 PAT 的地盘，交给下游门卫）', async () => {
    const mock = withAlice(); await mock.start()
    const res = await app(mock).request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: 'Bearer some-oauth-token' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).userId).toBeNull()
    await mock.stop()
  })

  it('超过 per-key 限速 → 429 RATE_LIMITED', async () => {
    const mock = withAlice(); await mock.start()
    const token = 'dkq_ratelimit'
    await seedKey(pool, token, 'alice')
    const a = app(mock, 2)   // 2 次/分钟
    const hit = () => a.request('/api/modules/data/query', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect((await hit()).status).toBe(200)
    expect((await hit()).status).toBe(200)
    const third = await hit()
    expect(third.status).toBe(429)
    expect((await third.json()).error).toBe('RATE_LIMITED')
    await mock.stop()
  })
})
```

`apps/server/src/wecom-channel-auth.test.ts` 用**同一套**辅助（`baseTenant` / `casdoorFor` / `withAlice` / `new Hono<RequesterEnv>()`，从 `./pat-auth` 引 `RequesterEnv` 类型即可），覆盖：渠道凭证正确 + `X-Wecom-Userid: alice` → 注入 `channel:'wecom'`；凭证错误 → 401 `CHANNEL_KEY_INVALID`；**未配** `DATA_WECOM_CHANNEL_KEY`（deps.channelKey 缺省）→ **直接 `next()` 放行**（该部署没开通道 C，不能把 `/api/modules/*` 全锁死）；缺 `X-Wecom-Userid` 头 → 401 `WECOM_USERID_REQUIRED`；`casdoor.getUser(userid)` 返 null（未关联）→ 401 `WECOM_USER_NOT_LINKED`（造法同上：userid 取一个 mock 里不存在的人）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter @platform/server test pat-auth`
Expected: FAIL —— `Cannot find module './pat-auth'`

- [ ] **Step 3: 写 SDK 常量 + 导出**

`packages/platform-sdk/src/requester-vars.ts`：

```ts
// 请求者上下文变量名（三通道共用）。
// 用**计算键名**而非字面量——字面量是第二份事实源，改名时它不会跟着改，
// 症状是**静默拿不到通道**（与 module.ts 的 TENANT_STORAGE 同一条理由）。
//
// 语义：**未设置 = 系统内会话通道**（sessionMiddleware 不设这两个变量）。
export const REQUESTER_CHANNEL = 'platform.requesterChannel'
export const REQUESTER_KEY_ID = 'platform.requesterKeyId'

/**
 * 上面两个变量的 **`Variables` 片段**（一个键→值的映射，**不是** Env，也**不是** Env 片段）。
 *
 * ⚠️ 用法只有一个形状：**求交进 `Variables`**。
 *   宿主：`TenantEnv & SessionEnv & { Variables: RequesterVars }`（T5，见该任务 pat-auth.ts）
 *   模块：`{ Variables: { identity: Identity; tenant: DataTenant } & RequesterVars }`（T6）
 *   **绝不写成 `ModuleVars & RequesterVars`**——那会把两个键搁到 Env **顶层**
 *   （Env 只认 `Bindings` / `Variables` 两个字段），结果 `c.get(REQUESTER_CHANNEL)` 恒 `undefined`：
 *   表现为**限速与审计静默丢失归属**，typecheck 不报错（`c.get` 的重载会退化成宽松签名）。
 *
 * `REQUESTER_*` 是 `const` 字面量 ⇒ 计算键名推出来的是**字面量键**（照 loader.ts:61 的写法）。
 */
export type RequesterVars = {
  [REQUESTER_CHANNEL]?: 'pat' | 'wecom'
  [REQUESTER_KEY_ID]?: number
}
```

`packages/platform-sdk/src/index.ts` 追加——**值一行、类型一行**（#44：`export { X }` 里混进
type 会让 Node ESM 运行时 SyntaxError，typecheck 与单测都拦不住）：

```ts
export { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from './requester-vars'
export type { RequesterVars } from './requester-vars'
```

- [ ] **Step 4: 写 pat-auth.ts**

```ts
// pat-auth.ts — 通道 B（系统外个人 Key）的鉴权中间件。
//
// ⚠️ 本文件**不得** import modules/data/**（宿主静态依赖模块 = 架构违规，且打掉 worktree 并行）。
//    它自带哈希行与查询 SQL：漂移由 apps/server/src/data-query.e2e.test.ts 的往返契约测试兜。
//
// 与 sessionMiddleware 的**刻意差别**：PAT 没有「缓存的旧 scopes」可降级——权限必须实时向
// Casdoor 取。所以 Casdoor 故障时这里 **fail-closed 503**，而不是像会话那样降级继续
// （会话降级的是"本次请求的授权新鲜度"，PAT 降级就等于**没有授权**）。
import { createHash } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import type { Pool } from 'pg'
import { effectiveScopes } from '@platform/auth-core'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity, RequesterVars } from '@platform/sdk'
import type { CasdoorFactory, SessionEnv } from './session-middleware'
import type { TenantEnv } from './tenant'

export const PAT_PREFIX = 'dkq_'
const DEFAULT_RATE_PER_MIN = 60
const WINDOW_MS = 60_000

/**
 * 宿主侧两个请求者中间件共用的 Env。定义在本文件、`wecom-channel-auth.ts` 引类型复用——
 * **只写一处求交**，两处各写一份必然会写歪（一处漏 SessionEnv，`c.get('session')` 就没了）。
 */
export type RequesterEnv = TenantEnv & SessionEnv & { Variables: RequesterVars }

export interface PatAuthDeps {
  pool: Pool
  casdoor: CasdoorFactory
  ratePerMin?: number
  /** 注入时钟（ms），仅供限速窗口取值。 */
  now?: () => number
}

export function patIdentityMiddleware(deps: PatAuthDeps): MiddlewareHandler<RequesterEnv> {
  const ratePerMin = deps.ratePerMin ?? DEFAULT_RATE_PER_MIN
  const now = deps.now ?? (() => Date.now())
  /** keyId → 本窗口起点。固定窗口足够（限速的目标是防 agent 循环，不是精确令牌桶）。 */
  const windows = new Map<number, { start: number; count: number }>()

  // 返回类型注解**与** createMiddleware 的泛型都不可省：只写注解，上下文类型不会反向流进
  // 回调，`c` 仍是 `Context<BlankEnv>`，`c.set('identity', …)` 报「不能赋给 never」。
  return createMiddleware<RequesterEnv>(async (c, next) => {
    // first-setter-wins：会话已解析过 → 本请求是系统内通道，PAT 不参与
    if (c.get('identity')) return next()

    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith(`Bearer ${PAT_PREFIX}`) ? header.slice('Bearer '.length).trim() : null
    // 不是 PAT 的地盘（没带 / 带了别的 Bearer）→ 放行，鉴权交给下游门卫（fail-closed 在那边）
    if (!token) return next()

    // ↓↓ 这一行必须与 modules/data/domain/key-store.ts 的 hashPat 实现**逐字一致**
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const q = await deps.pool.query(
      `select id, tenant_id, casdoor_user from data.query_keys
        where token_hash = $1 and revoked_at is null`,
      [tokenHash],
    )
    const tenant = c.get('tenant')
    if (q.rowCount === 0) return c.json({ error: 'INVALID_KEY' }, 401)
    const row = q.rows[0]
    const keyId = Number(row.id)
    // 跨租户的 key 一律无效（域名解析出的租户与 key 的租户必须一致）
    if (Number(row.tenant_id) !== Number(tenant.id)) return c.json({ error: 'INVALID_KEY' }, 401)

    const t = now()
    const w = windows.get(keyId)
    if (!w || t - w.start >= WINDOW_MS) windows.set(keyId, { start: t, count: 1 })
    else if (w.count >= ratePerMin) return c.json({ error: 'RATE_LIMITED' }, 429)
    else w.count += 1

    let scopes: string[]
    try {
      const casdoor = deps.casdoor(tenant.casdoor_org)
      const user = await casdoor.getUser(row.casdoor_user)
      if (user === null) return c.json({ error: 'USER_GONE' }, 401)
      const perms = await casdoor.getPermissions()
      scopes = effectiveScopes(row.casdoor_user, user.roles ?? [], perms)
    } catch {
      // 无缓存可降级 ⇒ fail-closed（没有任何第二套权限状态可以拿来用）
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 503)
    }

    const identity: Identity = {
      userId: row.casdoor_user,
      orgId: tenant.casdoor_org,
      displayName: row.casdoor_user,
      scopes,
      hasScope: (code: string) => scopes.includes(code),
    }
    c.set('identity', identity)
    c.set(REQUESTER_CHANNEL, 'pat')
    c.set(REQUESTER_KEY_ID, keyId)

    // 记一次使用：**不 await**（失败不阻断问数；last_used_at 不是审计真源，审计在 query_audit）
    void deps.pool
      .query('update data.query_keys set last_used_at = now() where id = $1', [keyId])
      .catch(() => {})

    await next()
  })
}
```

- [ ] **Step 5: 写 wecom-channel-auth.ts**

```ts
// wecom-channel-auth.ts — 通道 C（企微 × OpenClaw）的鉴权中间件。
//
// 身份模型采 data-analysis 生产方案：**企微 userid 即身份**，不建绑定码子系统
//   （内部人员身份的真相源就是企微；绑定码是多余且会漂移的第二份身份状态）。
// 「绑定」= 一次企微扫码登录：登录那一刻 Casdoor 落企微↔账号关联
//   （userid 即 Casdoor name，见 apps/server/src/routes/auth-wecom.ts 的注释）。
// 因此这里**只需** getUser(userid) 一步，无需任何绑定表。
//
// 未配 DATA_WECOM_CHANNEL_KEY 的部署 = 没开通道 C ⇒ 直接放行，不锁死 /api/modules/*。
import { createHash, timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import { effectiveScopes } from '@platform/auth-core'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
// Env 求交只写一处：从 pat-auth 引（它是类型，不会把两个中间件绑成运行时依赖）。
import type { RequesterEnv } from './pat-auth'
import type { CasdoorFactory } from './session-middleware'

export const WECOM_USERID_HEADER = 'x-wecom-userid'

export interface WecomChannelAuthDeps {
  casdoor: CasdoorFactory
  /** 渠道服务凭证（openship env isSecret）。未配 ⇒ 通道 C 关闭。 */
  channelKey?: string
}

/** 定长比较：两侧先 sha256 归一到同长度，再 timingSafeEqual。 */
function keyMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function wecomChannelIdentityMiddleware(deps: WecomChannelAuthDeps): MiddlewareHandler<RequesterEnv> {
  return createMiddleware<RequesterEnv>(async (c, next) => {
    if (deps.channelKey === undefined || deps.channelKey === '') return next()  // 通道 C 未启用
    if (c.get('identity')) return next()                                        // first-setter-wins

    const provided = c.req.header('x-channel-key')
    if (!provided || !keyMatches(provided, deps.channelKey)) {
      return c.json({ error: 'CHANNEL_KEY_INVALID' }, 401)
    }

    // userid 走**头部**不走 body：body 是问数参数，让身份的来源与参数混在一个面上会诱发
    // 「参数里塞身份」这类越权（同 spec §5 约束 2 的立意）。
    const userid = c.req.header(WECOM_USERID_HEADER)?.trim()
    if (!userid) return c.json({ error: 'WECOM_USERID_REQUIRED' }, 401)

    const tenant = c.get('tenant')
    let scopes: string[]
    try {
      const casdoor = deps.casdoor(tenant.casdoor_org)
      const user = await casdoor.getUser(userid)
      // 未关联 = Casdoor 里没有这个企微账号 ⇒ fail-closed + 客户端回一句扫码登录指引
      if (user === null) return c.json({ error: 'WECOM_USER_NOT_LINKED' }, 401)
      const perms = await casdoor.getPermissions()
      scopes = effectiveScopes(userid, user.roles ?? [], perms)
    } catch {
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 503)
    }

    const identity: Identity = {
      userId: userid,                 // 企微 userid 即 Casdoor name（本仓既有语义）
      orgId: tenant.casdoor_org,
      displayName: userid,
      scopes,
      hasScope: (code: string) => scopes.includes(code),
    }
    c.set('identity', identity)
    c.set(REQUESTER_CHANNEL, 'wecom')
    await next()
  })
}
```

- [ ] **Step 6: config.ts 加三个键**

`apps/server/src/config.ts`：`AppConfig` 加字段，`loadConfig` 里填：

```ts
export interface AppConfig {
  // …既有字段…
  /** 通道 C 的渠道服务凭证。未配 ⇒ 通道 C 关闭（中间件直接放行）。 */
  dataWecomChannelKey?: string
  /** per-key 限速（次/分钟），缺省 60。 */
  dataQueryRatePerMin: number
}
```

```ts
  // ── 数据问数（modules/data）──
  // 非必填：没配 = 没开对应的能力（通道 C 关闭 / 用默认限速）。
  // ⚠️ 注意 DATA_WAREHOUSE_URL **不在这里读**：它由模块自己在请求期从 process.env 取
  //    （部署级连接，装载期不建）。config 只管宿主中间件要用的两个。
  const rateRaw = optional('DATA_QUERY_RATE_PER_MIN')
  const dataQueryRatePerMin = rateRaw === undefined ? 60 : Number(rateRaw)
  if (!Number.isInteger(dataQueryRatePerMin) || dataQueryRatePerMin < 1) {
    throw new Error(`DATA_QUERY_RATE_PER_MIN 必须是正整数，当前=${JSON.stringify(rateRaw)}`)
  }
```

并在 `return { … }` 里加 `dataWecomChannelKey: optional('DATA_WECOM_CHANNEL_KEY')` 与 `dataQueryRatePerMin`。

- [ ] **Step 7: app.ts 挂两个中间件**

`apps/server/src/app.ts` 第 218 行之后（`sessionMiddleware` 块结束、`// ⑦ 平台路由` 之前）插入：

```ts
  // ⑥.5 数据问数两通道的鉴权（**必须在 sessionMiddleware 之后、runtime.mount 之前**）：
  //   · PAT（通道 B）：Bearer dkq_… → 用户 → 实时 scopes
  //   · 企微（通道 C）：渠道凭证 + X-Wecom-Userid → Casdoor 反查
  // 两条都只作用于 /api/modules/*（模块路由），且都遵守 first-setter-wins：
  // session 已注入 identity 时它们直接放行——**系统内通道不经这里**。
  // Hono 的中间件只影响**其后注册**的路由，故位置不能挪到 runtime.mount 之后。
  app.use('/api/modules/*', patIdentityMiddleware({
    pool,
    casdoor: casdoorFactory,
    ratePerMin: config.dataQueryRatePerMin,
  }))
  app.use('/api/modules/*', wecomChannelIdentityMiddleware({
    casdoor: casdoorFactory,
    channelKey: config.dataWecomChannelKey,
  }))
```

并在文件顶部 import：

```ts
import { patIdentityMiddleware } from './pat-auth'
import { wecomChannelIdentityMiddleware } from './wecom-channel-auth'
```

- [ ] **Step 8: 跑测试，确认通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test pat-auth wecom`
Expected: PASS

Run: `pnpm --filter @platform/server test && pnpm --filter @platform/sdk test`
Expected: 既有测试**全绿**（本步不能回归——装配顺序是既有契约）

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/pat-auth.ts apps/server/src/wecom-channel-auth.ts \
        apps/server/src/pat-auth.test.ts apps/server/src/wecom-channel-auth.test.ts \
        apps/server/src/config.ts apps/server/src/app.ts \
        packages/platform-sdk/src/requester-vars.ts packages/platform-sdk/src/index.ts
git commit -m "feat(data): 宿主鉴权中间件——PAT（实时权限/fail-closed 503）与企微渠道凭证"
```

---

# W3 — 模块路由（严格串行）

> 三个任务都改 `manifest.yaml` + `index.ts`，**必须串行**（约束 ⑪）。每个任务的分支基于前一个已合并的 main。

### Task 6: 指标与问数路由 + manifest 首批声明

**Files:**
- Create: `modules/data/routes/metrics.ts`
- Create: `modules/data/routes/query.ts`
- Modify: `modules/data/routes/context.ts`（`ModuleVars` 求交 `RequesterVars`、`RouteCtx` 加 `execute`、加 `requesterOf`）
- Modify: `modules/data/manifest.yaml`（`api.internal` 首批 5 条）
- Modify: `modules/data/index.ts`（注册 + 把 `execute` 透进 `RouteCtx`）
- Test: `modules/data/routes/metrics.test.ts`、`modules/data/routes/query.test.ts`
- Modify: `modules/data/module.test.ts`（双向核对自动覆盖，无需改；若红说明漏了声明）

**Interfaces:**
- Consumes: T2 `visibleMetrics`；T3 `loadCatalog`/`upsertMetric`/`deleteMetric`；T4 `runQuery`/`SqlExecutor`；T5 `RequesterVars`（`@platform/sdk`）
- Produces:
  - `modules/data/routes/context.ts`：`ModuleVars` 变为 **`{ Variables: { identity: Identity; tenant: DataTenant } & RequesterVars }`**（求交在 `Variables` **内层**，键名照抄上一条 Interfaces——别把 `& RequesterVars` 提到 Env 层）；`RouteCtx` 增 `execute?: SqlExecutor`；增 `requesterOf(c: Context<ModuleVars>): Requester`
  - `GET /metrics`（`data:query`）→ `{ metrics: [{id,title,description}] }`（**词表裁剪后的**）
  - `GET /metrics/all`（`data:manage`）→ 全量（含 `requiredScope`/`subjectColumn`）
  - `POST /metrics` / `PUT /metrics/:id` / `DELETE /metrics/:id`（`data:manage`）
  - `POST /query`（`data:query`）→ `QueryOutcome` 原样 + 200/403/500 状态码映射

- [ ] **Step 1: 写失败的测试**

```ts
// modules/data/routes/query.test.ts
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// ⚠️ 必须**先**建 app 再断言：`buildTestApp` 里的 `createRouter` 就是被测的模块装配，
// 建 app 这一步本身会跑装载期双向核对（声明集合 ≡ 注册集合）。
describe('POST /query 的参数面（不需要数据库）', () => {
  it('body 不是合法 JSON → 400 INVALID_BODY（在碰 DB 之前就拒）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: 'acme' }), { pool: null as never })
    const res = await app.request('/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })
})

describePg('POST /query（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('未声明的指标 → 403 + 可解释 reason（不是 500）', async () => {
    // 这条**需要真库**：`runQuery` 是先 loadCatalog 再判声明，没有 pool 会先炸在加载词表上
    // （错误信号会变成「500 而不是 403」，看着像授权坏了）。种一条真指标，再问一个没声明的。
    await upsertMetric(pool, 1, {
      id: 'sales_daily', title: '销售日明细', description: '',
      requiredScope: null, subjectColumn: 'org',
      selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
      groupBy: '', params: {},
    })
    const app = buildTestApp(mod, makeIdentity({ orgId: 'acme' }), { pool }, { id: 1, casdoor_org: 'acme' })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'nope', args: {} }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('metric_not_declared')
  })
})
```

> `buildTestApp` 第 4 参是 T1 定义的 `tenant`（缺省 `{ id: 1, casdoor_org: 'test' }`）。上例显式传
> `casdoor_org: 'acme'` 与身份的 `orgId` 对齐——**授权核心写进 SQL 的主体值取自 tenant**，
> 不传就与断言里的主体对不上（症状：行数对但归属错，或裁剪结果与预期相反）。

`metrics.test.ts` 覆盖：`GET /metrics` **只回词表内**（`data:query` 身份看不到 `data:finance` 指标）；`POST /metrics` 缺 `data:manage` 时**由宿主门卫**拦（模块壳测试只能验 happy path，门卫归 T10）——故这里验 `data:manage` 身份能建、`GET /metrics/all` 回全量。这些用例都要真库（词表读写），一律放 `describePg`。

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm --filter data test routes/`
Expected: FAIL —— 404（路由未注册）

- [ ] **Step 3: 写 `requesterOf` + 两个路由文件**

`context.ts` 追加：

```ts
import type { Context } from 'hono'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Requester } from '../domain/authz'

/**
 * identity → Requester（三通道**唯一**的身份归一）。
 * 通道变量未设 ⇒ 系统内会话通道（sessionMiddleware 不设这两个变量）。
 *
 * ⚠️ 泛型是 `Context<ModuleVars>`（**整个 Env**），不是 `Context<{ identity: … }>`。
 */
export function requesterOf(c: Context<ModuleVars>): Requester {
  const identity = c.get('identity')
  return {
    userId: identity.userId,
    orgId: identity.orgId,
    channel: c.get(REQUESTER_CHANNEL) ?? 'session',
    keyId: c.get(REQUESTER_KEY_ID) ?? null,
    scopes: identity.scopes,
    hasScope: (code: string) => identity.hasScope(code),
  }
}
```

`context.ts` 里 `requesterOf` 需要的 import（与上面同文件，一并写好）：

```ts
import type { Context } from 'hono'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { RequesterVars } from '@platform/sdk'
import type { Requester } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'
```

`context.ts` 的另两处改动（`ModuleVars` 与 `RouteCtx`）：

```ts
// ① ModuleVars 收进请求者上下文。**请求者变量在 Variables 里面**——
//    写成 `ModuleVars & RequesterVars` 会把键搁在 Env 顶层，`c.get(REQUESTER_CHANNEL)` 拿不到。
export type ModuleVars = {
  Variables: { identity: Identity; tenant: DataTenant } & RequesterVars
}

// ② RouteCtx 加执行器注入点：让路由层能把假仓库透传给 runQuery（T8/T9 的测试也靠它）。
export interface RouteCtx {
  pool: Pool
  /** 缺省 = 真仓库。测试注入假执行器。 */
  execute?: SqlExecutor
}
```

> **`tenant` 从哪来**：宿主 `TenantEnv` 会在请求上设 `tenant`（运行时是真的），T1 已把
> `DataTenant { id; casdoor_org }` 写进 `ModuleVars`、`test-util.buildTestApp` 也已注入。
> 所以这里**不需要**任何新机制——`c.get('tenant').id` 直接可用。本任务只需把
> `RequesterVars` 求交进 `Variables`、给 `RouteCtx` 加 `execute`。

`routes/query.ts`：

```ts
// POST /query —— 三条通道共用的问数入口（通道 C 走这里；通道 B 的 MCP 也走这里）。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { runQuery } from '../domain/query-service'

const QueryBody = z.object({
  metricId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
})

export function registerQuery(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/query', async (c) => {
    const parsed = QueryBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const tenantId = c.get('tenant').id
    // `execute` 必须透传：缺省会让 runQuery 去建真仓库连接，测试里就变成「断言被网络错误顶掉」
    const outcome = await runQuery(
      { pool: ctx.pool, execute: ctx.execute },
      tenantId, requesterOf(c), parsed.data.metricId, parsed.data.args,
    )

    if (outcome.status === 'ok') return c.json(outcome)
    if (outcome.status === 'denied') {
      // 词表外的指标一律 403 + 统一 reason（**不**为「未声明」与「未授权」区分状态码：
      // 区分会变成一个存在性探针，与约束 3「看不见」冲突）
      return c.json(outcome, 403)
    }
    return c.json(outcome, 502)
  })
}
```

`index.ts` 里 `RouteCtx` 的构造（`execute` 从宿主的 `ModuleContext` 取，协议里没有这个名字 ⇒ 显式转型）：

```ts
  createRouter: (moduleCtx) => {
    const r: ModuleHono = new Hono<ModuleVars>()
    // `ModuleContext` 协议上只有 pool；`execute` 是宿主给模块测试用的扩展点，
    // 生产装配下它是 undefined（= 走真仓库）。写显式转型而不是改协议。
    const _ctx: RouteCtx = {
      pool: moduleCtx.pool,
      execute: (moduleCtx as RouteCtx).execute,
    }
    registerMetrics(r, _ctx)   // T6
    registerQuery(r, _ctx)     // T6
    return r
  },
```

`routes/metrics.ts`：

```ts
// GET /metrics（词表裁剪后的，给对话/管理界面选）、GET /metrics/all（管理面，全量）、
// POST/PUT/DELETE（管理面）。**门禁由宿主施加**（manifest 的 api.internal），本文件不写 requireScope。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { visibleMetrics } from '../domain/authz'
import { deleteMetric, loadCatalog, upsertMetric } from '../domain/metric-store'

const MetricBody = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1),
  description: z.string().default(''),
  requiredScope: z.string().nullable().default(null),
  subjectColumn: z.string().min(1),
  selectSql: z.string().min(1),
  groupBy: z.string().default(''),
  params: z.record(z.object({
    column: z.string().min(1),
    type: z.enum(['date', 'string', 'number']),
    required: z.boolean().optional(),
  })).default({}),
})

/** 只投影消费面要的字段：`selectSql` / `subjectColumn` 属实现细节，不外泄。 */
const publicView = (m: { id: string; title: string; description: string }) =>
  ({ id: m.id, title: m.title, description: m.description })

/**
 * 指标 id 的**唯一**解析口径（PUT / DELETE 共用，两边必须同形）。
 *
 * ⚠️ 这里**不能**用 `parseIdParam`（T1 那个 `Number()` 解析器）：指标 id 是 `text`
 * （外部系统来的命名，如 `sales_daily`），数字解析器会把合法 id 判成非法 ⇒ 写操作**永远 404**。
 * `parseIdParam` 只服务 bigint 主键（T7 的 `query_keys.id` 用它，见那个任务的注记）。
 *
 * 形状校验的**真实承担者**是写入侧的 `MetricBody`（`z.string().min(1).max(64)`）；
 * 这里只挡「空/缺失」，一律 404 —— 与 aftersales 的「非法 id 一律 404」一致，不给存在性探针。
 */
const metricIdOf = (raw: string | undefined): string | null =>
  raw === undefined || raw === '' ? null : raw

export function registerMetrics(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/metrics', async (c) => {
    const all = await loadCatalog(ctx.pool, c.get('tenant').id)
    return c.json({ metrics: visibleMetrics(all, requesterOf(c)).map(publicView) })
  })

  r.get('/metrics/all', async (c) => {
    const all = await loadCatalog(ctx.pool, c.get('tenant').id)
    return c.json({ metrics: all })
  })

  r.post('/metrics', async (c) => {
    const parsed = MetricBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    await upsertMetric(ctx.pool, c.get('tenant').id, parsed.data)
    return c.json({ ok: true }, 201)
  })

  r.put('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const parsed = MetricBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    // 路径 id 与 body id 必须同值：否则「改 A 结果写了 B」是静默的数据事故。
    if (parsed.data.id !== id) return c.json({ error: 'ID_MISMATCH' }, 400)
    await upsertMetric(ctx.pool, c.get('tenant').id, parsed.data)
    return c.json({ ok: true })
  })

  r.delete('/metrics/:id', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const gone = await deleteMetric(ctx.pool, c.get('tenant').id, id)
    return gone ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND' }, 404)
  })
}
```

> **`PUT` 与 `DELETE` 同一口径**：都走 `metricIdOf`（原字符串、只挡空）——**别让其中一侧回到
> `parseIdParam`**。指标 id 是 `text`，数字解析器会把 `sales_daily` 判成非法。
> 本文件因此**不 import `parseIdParam`**（`parseIdParam` 仍在 `context.ts` 里，T7 的
> `query_keys.id` 是 bigint，那边用它是对的——见 T7 Step 3 的注记）。

- [ ] **Step 4: 同步改 manifest + index（同一任务内！）**

`manifest.yaml` 的 `api.internal` 从 `[]` 改为：

```yaml
api:
  internal:
    # ── 问数面（data:query）──
    - { method: GET,  path: /metrics, scope: data:query }
    - { method: POST, path: /query,   scope: data:query }
    # ── 指标管理面（data:manage）──
    - { method: GET,    path: /metrics/all, scope: data:manage }
    - { method: POST,   path: /metrics,     scope: data:manage }
    - { method: PUT,    path: /metrics/:id, scope: data:manage }
    - { method: DELETE, path: /metrics/:id, scope: data:manage }
```

> ⚠️ `GET /metrics` 与 `GET /metrics/all`:两条不同 (method, path)，可各带一个 scope（协议允许）。**同一条 (method,path) 只能声明一次、只带一个 scope**——所以问数面与管理面不能共用同一路径。

`index.ts` 的 `createRouter` 里：

```ts
    registerMetrics(r, ctx)
    registerQuery(r, ctx)
```

- [ ] **Step 5: 跑测试（含双向核对），确认通过**

Run: `DATABASE_URL=… pnpm --filter data test`
Expected: PASS —— 含 `module.test.ts` 的双向核对（若红，就是 manifest 与注册集合不一致）

- [ ] **Step 6: 提交 + PR**

```bash
git add modules/data
git commit -m "feat(data): 指标与问数路由 + manifest 首批声明"
gh pr create --title "feat(data): 指标与问数路由" --body "Closes #<N>"
```

---

### Task 7: 个人 Key 路由

**Files:**
- Create: `modules/data/routes/keys.ts`
- Modify: `modules/data/manifest.yaml`（加 3 条）
- Modify: `modules/data/index.ts`（注册）
- Test: `modules/data/routes/keys.test.ts`

**Interfaces:**
- Consumes: T3 的 `createPatKey`/`listPatKeys`/`revokePatKey`
- Produces:
  - `GET /keys`（`data:query`）→ `{ keys: [{id,name,createdAt,lastUsedAt,revoked}] }`（**只有自己的**）
  - `POST /keys`（`data:query`）body `{name}` → **201** `{id, name, token}`（明文 token 只此一次）
  - `DELETE /keys/:id`（`data:query`）→ 204 / 404

- [ ] **Step 1: 写失败的测试**

```ts
// modules/data/routes/keys.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const TENANT = 9004

describePg('个人 Key 路由（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_keys where tenant_id = $1', [TENANT])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_keys where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.end().catch(() => {})
  })

  function app(casdoorUser = 'alice') {
    const id = makeIdentity({ orgId: 'acme' })
    // casdoor_user 取 identity.displayName（会话通道里它**就是** Casdoor 用户名）。
    // 第 4 参是 T1 的 `DataTenant`（**不是**裸 tenantId）：`{ id: TENANT, casdoor_org: 'acme' }`。
    return buildTestApp(mod, { ...id, displayName: casdoorUser }, { pool },
                        { id: TENANT, casdoor_org: 'acme' })
  }

  it('建 key → 201 + 明文 token，且 token 以 dkq_ 开头', async () => {
    const res = await app().request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '我的 agent' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.token.startsWith('dkq_')).toBe(true)
    expect(body.name).toBe('我的 agent')
  })

  it('列 key → 只有自己的，且**不含** token', async () => {
    await app('alice').request('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a' }) })
    await app('bob').request('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'b' }) })
    const res = await app('alice').request('/keys')
    const body = await res.json()
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0].name).toBe('a')
    expect(JSON.stringify(body)).not.toContain('dkq_')     // 明文绝不回列表面
  })

  it('吊销 → 204；再吊销同一 id → 404', async () => {
    const created = await (await app().request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'k' }),
    })).json()
    expect((await app().request(`/keys/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await app().request(`/keys/${created.id}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('名称空 / 超 64 → 400 INVALID_BODY', async () => {
    const bad = (name: string) => app().request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    })
    expect((await bad('')).status).toBe(400)
    expect((await bad('x'.repeat(65))).status).toBe(400)
  })
})
```

> `buildTestApp` 是**四参**形态，第 4 参是 T1 定义的 `DataTenant`（`{ id; casdoor_org }`，默认 `{ id: 1, casdoor_org: 'test' }`）。
> **别传裸数字**——那是 `tenantId` 时代的形状，`c.get('tenant').casdoor_org` 会变 undefined。

- [ ] **Step 2: 跑测试，确认失败** → `pnpm --filter data test routes/keys.test.ts`（FAIL：404）

- [ ] **Step 3: 写 `routes/keys.ts`**

```ts
// 个人问数 Key 管理 —— **只管自己的**：`casdoor_user` 一律取自会话身份，客户端传什么都不认。
import { z } from 'zod'
import type { Context } from 'hono'
import type { ModuleHono, ModuleVars, RouteCtx } from './context'
import { parseIdParam } from './context'
import { createPatKey, listPatKeys, MAX_KEY_NAME_LEN, revokePatKey } from '../domain/key-store'

/**
 * 请求者身份 → Casdoor 用户名（三通道同义：会话 `SessionPayload.name`、
 * PAT `resolvePat().casdoorUser`、企微 userid——`pat-auth`/`wecom-channel-auth` 都把它写进 `displayName`）。
 */
function casdoorUserOf(c: Context<ModuleVars>): string {
  return c.get('identity').displayName
}

const KeyBody = z.object({ name: z.string().min(1).max(MAX_KEY_NAME_LEN) })

export function registerKeys(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/keys', async (c) => {
    const keys = await listPatKeys(ctx.pool, c.get('tenant').id, casdoorUserOf(c))
    return c.json({ keys })          // PatKeyRow 里**没有** token 字段，明文不可能从这里漏
  })

  r.post('/keys', async (c) => {
    const parsed = KeyBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { id, token } = await createPatKey(
      ctx.pool, c.get('tenant').id, casdoorUserOf(c), parsed.data.name,
    )
    // 明文 token **只在此一次**回包（库里只有 sha256）。此后任何接口都不再返回它。
    return c.json({ id, name: parsed.data.name, token }, 201)
  })

  r.delete('/keys/:id', async (c) => {
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const gone = await revokePatKey(ctx.pool, c.get('tenant').id, casdoorUserOf(c), id)
    return gone ? c.body(null, 204) : c.json({ error: 'NOT_FOUND' }, 404)
  })
}
```

> 三条都带 `casdoorUserOf(c)` ⇒ **越权删别人的 key 天然不可能**（`revokePatKey` 的 WHERE 里带 `casdoor_user`，
> 别人的 id 查不中 → `false` → 404）。404 而不是 403 是有意的：403 会变成「这个 id 存在」的探针。
> `parseIdParam` 在这里是**对的**（`query_keys.id` 是 bigint）；别和 T6 的指标 id（text）混。

- [ ] **Step 4: manifest 加三条 + index 注册**

```yaml
    # ── 个人 Key 管理（data:query；只能操作自己的）──
    - { method: GET,    path: /keys,     scope: data:query }
    - { method: POST,   path: /keys,     scope: data:query }
    - { method: DELETE, path: /keys/:id, scope: data:query }
```

> 为什么不是 `data:manage`：Key 是**每个人管自己的**，不是管理员给别人发。用 `data:manage` 会让只能问数的人生成不了 Key（与 spec §3「每个账号可生成专属的 key」冲突）。

- [ ] **Step 5: 跑测试 + 提交**

Run: `DATABASE_URL=… pnpm --filter data test` → PASS

```bash
git add modules/data
git commit -m "feat(data): 个人 Key 路由——生成（仅展示一次）/列/吊销"
```

---

### Task 8: MCP 端点（手写 JSON-RPC）

**为什么不用 `@modelcontextprotocol/sdk`**：本模块只用到 `initialize` / `tools/list` / `tools/call` / `ping` 四个方法 + 通知，协议面小且稳定；引 SDK 会把一个重依赖塞进模块（modules/* 的依赖面刻意保持窄）。stateless JSON-RPC over POST 的 `application/json` 响应是 streamable HTTP 的合法形态。

**Files:**
- Create: `modules/data/routes/mcp.ts`
- Modify: `modules/data/manifest.yaml`（加 1 条）
- Modify: `modules/data/index.ts`（注册）
- Test: `modules/data/routes/mcp.test.ts`

**Interfaces:**
- Consumes: T2 `visibleMetrics`；T4 `runQuery`；T6 的 `requesterOf`
- Produces: `POST /mcp`（`data:query`）——请求体 `{"jsonrpc":"2.0","id":N,"method":"…","params":{…}}`
  - `initialize` → `{protocolVersion, capabilities:{tools:{}}, serverInfo}`
  - `tools/list` → `{tools:[{name,description,inputSchema}]}`（**词表裁剪后的**，`inputSchema.properties` **不含**任何主体键）
  - `tools/call` `{name, arguments}` → `{content:[{type:'text',text:'<JSON>'}] , isError?}`
  - 无 `id` 的通知 → **202 空体**
  - 未知方法 → JSON-RPC error `-32601`

- [ ] **Step 1: 写失败的测试**

```ts
// modules/data/routes/mcp.test.ts —— 把 /tmp/iam-lab 的 11 条矩阵搬到这里（HTTP 形态）
```

用例（每条一次 `POST /mcp`）：
1. `initialize` → `result.protocolVersion` 是字符串，`capabilities.tools` 存在
2. 通知（无 id）→ 202 且 body 为空
3. 未知方法 → `error.code === -32601`
4. `tools/list`（有 `data:query`）→ 词表内的指标都在，`data:finance` 的**不在**
5. `tools/list` 的 `inputSchema.properties` **不含** `org`/`subject`
6. `tools/call` 未声明指标 → `content[0].text` 解析出 `{status:'denied',reason:'metric_not_declared'}`，`isError:true`
7. `tools/call` 未授权指标 → `metric_not_authorized`
8. `tools/call` 传 `org` 参数 → `subject_pinned_by_platform`
9. `tools/call` 正常 → `{status:'ok', subject, rows}`（用注入的 `execute` 假仓库；**注意**：模块路由的 `runQuery` 用的是 `warehousePool()`，测试要能注入——做法：`registerMcp(r, ctx)` 里 `ctx` 加一个可选的 `execute`，由 `test-util` 注入）

> **⚠️ 上一条揭示一个 T4/T6 的接口缺口**：`runQuery` 的 `deps.execute` 在路由层无处注入。**在 T6 就要解决**——`RouteCtx` 加可选 `execute?: (sql: string) => Promise<{columns,rows}>`，路由把它透传给 `runQuery`。T6 的 `test-util` 第 4 参相应扩展。若 T6 已合并但没加，T8 就地补（改 `context.ts` + `test-util.ts` + 三个路由文件透传）。

- [ ] **Step 2: 跑测试，确认失败** → `pnpm --filter data test routes/mcp.test.ts`（FAIL：404）

- [ ] **Step 3: 写 `routes/mcp.ts`**

结构：

```ts
const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

/** 指标 → MCP tool。**inputSchema 的 properties 只含声明的业务参数**——主体不属于客户端可指定面。 */
function toTool(m: MetricDef) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(m.params)) {
    properties[name] = { type: p.type === 'date' ? 'string' : p.type, description: '' }
    if (p.required) required.push(name)
  }
  return { name: m.id, description: m.description || m.title, inputSchema: { type: 'object', properties, required } }
}

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/mcp', async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | null
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200)
    }
    // 通知（无 id）：**不回**，202 空体（MCP 明确要求）
    if (msg.id === undefined) return c.body(null, 202)

    const tenantId = c.get('tenant').id
    const requester = requesterOf(c)
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-data-mcp', version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') {
      const catalog = visibleMetrics(await loadCatalog(ctx.pool, tenantId), requester)
      return reply({ tools: catalog.map(toTool) })
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await runQuery(
        { pool: ctx.pool, execute: ctx.execute }, tenantId, requester, name, args,
      )
      return reply({
        content: [{ type: 'text', text: JSON.stringify(out) }],
        isError: out.status !== 'ok',
      })
    }
    return rpcError(-32601, 'method not found')
  })
}
```

- [ ] **Step 4: manifest 加一条 + index 注册**

```yaml
    - { method: POST, path: /mcp, scope: data:query }
```

- [ ] **Step 5: 跑测试（含双向核对）+ 提交**

Run: `DATABASE_URL=… pnpm --filter data test` → PASS

```bash
git add modules/data
git commit -m "feat(data): MCP 端点——手写 JSON-RPC，同一授权核心同一对工具"
```

---

# W4 — 通道 A

### Task 9: 系统内问数（LLM 编排 + SSE + console 页签）

**Files:**
- Create: `modules/data/domain/llm.ts`、`modules/data/domain/agent-loop.ts`
- Create: `modules/data/routes/chat.ts`
- Create: `modules/data/console/index.tsx`（替换 T1 占位）
- Create: `modules/data/console/lib/api.ts`（模块专属的薄封装，**不复用** aftersales 的 `console/lib`——模块之间不互相依赖）
- Create: `modules/data/console/query/index.tsx`、`console/metrics/index.tsx`、`console/keys/index.tsx`
- Modify: `modules/data/manifest.yaml`（加 `POST /chat`）
- Modify: `modules/data/index.ts`
- Test: `modules/data/domain/agent-loop.test.ts`、`modules/data/routes/chat.test.ts`、`modules/data/console/index.test.tsx`

**Interfaces:**
- Consumes: T2/T4 全套；T6 的 `POST /metrics(/all)`、`POST /query`；T7 的 `/keys`
- Produces:
```ts
// domain/llm.ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** `role:'tool'` 必填：对应 ToolCall.id。缺了模型无法把结果对上是哪次调用。 */
  toolCallId?: string
  /** `role:'assistant'` 且本轮含工具调用时填：原样回放，下一轮才连得上。 */
  toolCalls?: ToolCall[]
}
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatTurn { content: string; toolCalls: ToolCall[] }
export interface ChatModel { complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatTurn> }
export interface LlmConfig { baseUrl: string; apiKey: string; model: string }
export class LlmError extends Error {}
export function llmFromEnv(env?: Record<string, string | undefined>): LlmConfig | null
export function openAiCompatModel(cfg: LlmConfig): ChatModel

// domain/agent-loop.ts
export type AgentEvent =
  | { type: 'activity'; tool: string; detail: string }
  | { type: 'final'; text: string; table?: { columns: string[]; rows: unknown[][] } }
  | { type: 'error'; reason: string; detail?: string }      // 流已开头 ⇒ 失败只能用事件表达，不能用状态码
export const MAX_AGENT_TURNS = 6
export interface AgentDeps { pool: Pool; tenantId: number; execute?: SqlExecutor }
export function runAgentLoop(deps: AgentDeps, requester: Requester, model: ChatModel, question: string): AsyncGenerator<AgentEvent>
```

> `ChatMessage` 比 spec 里的最小形状多两个字段，是**协议要求**不是设计选择：OpenAI 的 `role:'tool'`
> 消息必须带 `tool_call_id`，`role:'assistant'` 带工具调用时必须回放 `tool_calls`——少了任一个，
> 第二轮起模型收到的历史就是残缺的（它会把工具结果当成普通用户发言）。
> `AgentEvent` 多一个 `error` 变体同理：SSE 一旦开始推送，HTTP 状态码已经发出去了，失败只能走事件。

- [ ] **Step 1: 写失败的测试**

`agent-loop.test.ts`：用一个**假 ChatModel**（脚本化的回合序列）验：
- 模型先要 `list_metrics` → 收到的事件流里有 `{type:'activity', tool:'list_metrics'}`
- 再要 `query_metric` → 有 `activity` + 末事件 `{type:'final', text, table}`
- 模型**永远**在要工具（不收敛）→ 到 `MAX_AGENT_TURNS` 停下并给 `final`（**不**死循环）
- 模型要一个未授权指标 → 工具结果里是可解释 reason，**不**是 SQL 错误
- **LLM 上下文里绝不出现 token/凭证**（断言送进 `complete` 的 messages 全文不含 `dkq_` 与环境变量值）

`chat.test.ts`：SSE 响应头 `content-type: text/event-stream`；事件序列里有 `activity` 与 `final`；未配 `DATA_LLM_*` → 503 `LLM_UNCONFIGURED`（可解释，不是 500）。

- [ ] **Step 2: 跑测试，确认失败** → FAIL（模块不存在）

- [ ] **Step 3: 写 `domain/llm.ts`**

```ts
// domain/llm.ts —— OpenAI 兼容协议的最小客户端。
// 只实现 complete()（**不流式**）：v1 由后端把最终答案整体推给前端，SSE 只用来推「活动」事件。
// 供应商侧换谁都能接（data-analysis 先例：wishub / DeepSeek 协议兼容）。
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatTurn { content: string; toolCalls: ToolCall[] }
export interface ChatModel { complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatTurn> }
export interface LlmConfig { baseUrl: string; apiKey: string; model: string }

/** 只带**可安全外泄**的理由。失败详情不回显响应体（供应商侧常把请求原文回显，可能含凭证）。 */
export class LlmError extends Error {}

export function llmFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const baseUrl = env.DATA_LLM_BASE_URL?.trim()
  const apiKey = env.DATA_LLM_API_KEY?.trim()
  const model = env.DATA_LLM_MODEL?.trim()
  // 三个键**全在**才算配好。任一缺 ⇒ null（部署没开通道 A，应回可解释的 503，不是 500）
  if (!baseUrl || !apiKey || !model) return null
  return { baseUrl, apiKey, model }
}

interface OpenAiToolCall { id?: string; function?: { name?: string; arguments?: string } }
interface OpenAiChatResponse { choices?: { message?: { content?: unknown; tool_calls?: OpenAiToolCall[] } }[] }

export function openAiCompatModel(cfg: LlmConfig): ChatModel {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(messages, tools) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // apiKey 只在请求头；**绝不**进 messages / 审计 / 日志 / SSE 事件
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages.map(toWireMessage),
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: 'auto',
        }),
      })
      if (!res.ok) throw new LlmError(`LLM_HTTP_${res.status}`)
      const body = (await res.json()) as OpenAiChatResponse
      const msg = body.choices?.[0]?.message
      if (!msg) throw new LlmError('LLM_EMPTY_CHOICE')
      return {
        content: typeof msg.content === 'string' ? msg.content : '',
        toolCalls: (msg.tool_calls ?? [])
          .map((tc) => ({
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            arguments: parseArguments(tc.function?.arguments),
          }))
          .filter((tc) => tc.name !== '' && tc.id !== ''),
      }
    },
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

/** 供应商把 arguments 当**字符串**回（OpenAI 协议如此）。解析失败给空对象——让授权核心去拒，不在这里抛。 */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
```

> **`complete()` 为什么不做流式**：v1 的 UI 是「活动时间线 + 最终答案表格」，活动事件由 agent loop 产生
> （不是模型 token），末答案一次性到达完全够用。做流式要处理 SSE 分片与 tool_calls 的增量拼接
> （`index` 对齐），是徒增面积的复杂度。**后置**，不进 v1。

- [ ] **Step 4: 写 `domain/agent-loop.ts`**

```ts
// domain/agent-loop.ts —— 通道 A 的 LLM 编排。工具**只有两个**，且**都走同一个授权核心**
// （spec §5 约束 1：任何通道不得自建权限判定）。
import type { Pool } from 'pg'
import type { MetricDef, Requester } from './authz'
import { visibleMetrics } from './authz'
import { loadCatalog } from './metric-store'
import { runQuery } from './query-service'
import type { SqlExecutor } from './query-service'
import type { ChatMessage, ChatModel, ToolCall, ToolSpec } from './llm'

export type AgentEvent =
  | { type: 'activity'; tool: string; detail: string }
  | { type: 'final'; text: string; table?: { columns: string[]; rows: unknown[][] } }
  | { type: 'error'; reason: string; detail?: string }

export interface AgentDeps { pool: Pool; tenantId: number; execute?: SqlExecutor }

/** 硬上限。超出即收尾出 `final`，**不是**抛错、更不是继续转。 */
export const MAX_AGENT_TURNS = 6

const SYSTEM_PROMPT = [
  '你是平台数据问数助手。只能用提供的工具回答，不要臆造指标名或数字。',
  '你看到的数据**已经按当前用户权限裁剪过**：看不到的指标就是没权限，直接说明即可。',
  '**不要向用户索要或猜测组织/主体（org/subject）**——主体由平台按登录身份钉死，不由请求参数指定。',
  '工具返回 status=denied 时，用其中 reason 向用户解释，不要重试同一个调用。',
].join('\n')

/**
 * 工具面：**两个**。
 * `query_metric` 的 inputSchema **刻意不暴露 org/subject**（spec §5 约束 2）——
 * 主体不属于客户端可指定面，模型连"能不能填"都不该知道。
 */
const TOOLS: ToolSpec[] = [
  {
    name: 'list_metrics',
    description: '列出当前用户有权访问的指标（id / 标题 / 说明）。问数前若不确定指标 id，先调它。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'query_metric',
    description: '按指标 id 查询数据。参数只能来自该指标声明的维度。',
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: '指标 id，取自 list_metrics' },
        args: {
          type: 'object',
          description: '指标参数（日期区间等）。键必须是指标声明的参数名。',
          additionalProperties: true,
        },
      },
      required: ['metricId'],
    },
  },
]

export async function* runAgentLoop(
  deps: AgentDeps, requester: Requester, model: ChatModel, question: string,
): AsyncGenerator<AgentEvent> {
  // 词表在本轮对话开始时裁剪一次（同一次对话内权限漂移不做中途刷新——改权限下一次问答生效）
  const catalog = visibleMetrics(await loadCatalog(deps.pool, deps.tenantId), requester)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ]
  let lastTable: { columns: string[]; rows: unknown[][] } | undefined

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const reply = await model.complete(messages, TOOLS)
    // 原样回放 assistant 轮（含 tool_calls）——不回放则下一轮模型对不上工具结果
    messages.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls })

    if (reply.toolCalls.length === 0) {
      yield { type: 'final', text: reply.content, table: lastTable }
      return
    }

    for (const call of reply.toolCalls) {
      yield { type: 'activity', tool: call.name, detail: describeCall(call) }
      const result = await runTool(call, catalog, deps, requester)
      if (result.status === 'ok') lastTable = { columns: result.columns, rows: result.rows }
      // 拒绝结果**原样**回给模型：可解释的 reason 才让它能对用户说清「你没权限」
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) })
    }
  }

  // 到上限：把已有的表连同说明一起收尾（**不是**抛错）
  yield {
    type: 'final',
    text: '（本轮工具调用已达上限，先把目前查到的结果给你。）',
    table: lastTable,
  }
}

async function runTool(
  call: ToolCall, catalog: MetricDef[], deps: AgentDeps, requester: Requester,
): Promise<{ status: 'ok'; columns: string[]; rows: unknown[][] }
        | { status: 'denied'; metricId: string; reason: string; detail?: string }
        | { status: 'error'; reason: string; detail: string }
        | { metrics: { id: string; title: string; description: string }[] }> {
  if (call.name === 'list_metrics') {
    return { metrics: catalog.map((m) => ({ id: m.id, title: m.title, description: m.description })) }
  }
  if (call.name !== 'query_metric') {
    return { status: 'error', reason: 'unknown_tool', detail: call.name }
  }
  const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : ''
  const rawArgs = call.arguments.args
  const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>) : {}
  // 与 MCP 通道**同一个** runQuery ⇒ 同一个授权核心。这里不做任何权限判断。
  return runQuery({ pool: deps.pool, execute: deps.execute }, deps.tenantId, requester, metricId, args)
}

/** 活动事件的展示文案。**只放 id 与非敏感参数**——SQL、主体值、凭证都不进事件流。 */
function describeCall(call: ToolCall): string {
  if (call.name === 'list_metrics') return '列出可用指标'
  const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : '(未指定)'
  return `查询指标 ${metricId}`
}
```

> **`describeCall` 为什么单独抽出来**：活动事件会经 SSE 推到浏览器。凡是进事件的字符串都要能过
> 「会不会漏 SQL / 主体 / 凭证」这一关——把它钉在一个函数里，比散在 yield 现场可审。
>
> **`list_metrics` 用的是循环开头裁好的 `catalog`，`query_metric` 走 `runQuery` 自己再裁一次**：
> 看起来重复，但两者职责不同——前者是给模型的「看得见什么」，后者是**授权强制点**。
> 若让 `query_metric` 复用循环里那份词表，就等于把强制点降级成缓存，违反约束 1。

- [ ] **Step 5: 写 `routes/chat.ts`**

```ts
// POST /chat —— 通道 A。SSE：activity 事件（工具调用过程）+ final 事件（答案）+ error 事件。
// LLM 编排在**平台后端**（spec §2 已拍板）：key 在服务端 env 不落浏览器；审计集中；权限单点强制。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { llmFromEnv, LlmError, openAiCompatModel } from '../domain/llm'
import { runAgentLoop } from '../domain/agent-loop'

const ChatBody = z.object({ question: z.string().min(1).max(2000) })

export function registerChat(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/chat', async (c) => {
    const cfg = llmFromEnv()
    // 没配 LLM ⇒ 可解释的 503（不是 500）：部署没开通道 A 是配置状态，不是故障
    if (!cfg) return c.json({ error: 'LLM_UNCONFIGURED' }, 503)
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const requester = requesterOf(c)
    const deps = { pool: ctx.pool, tenantId: c.get('tenant').id, execute: ctx.execute }
    const model = openAiCompatModel(cfg)
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        const send = (ev: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
        try {
          for await (const ev of runAgentLoop(deps, requester, model, parsed.data.question)) send(ev)
        } catch (err) {
          // 流已经开了头 ⇒ 状态码发不出去了，失败只能用事件表达。
          // detail **只**取 LlmError 的自身文案（形如 LLM_HTTP_502），别把 unknown error 的 message
          // 透出去——fetch 的异常 message 里可能带 URL，其它异常可能带响应体回显。
          send({
            type: 'error', reason: 'AGENT_FAILED',
            detail: err instanceof LlmError ? err.message : undefined,
          })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // edge/nginx 默认会缓冲响应 ⇒ SSE 被攒成一坨、前端一个字都收不到。显式关掉。
        'x-accel-buffering': 'no',
      },
    })
  })
}
```

> 路由注册在 `index.ts` 里与 T6/T7 同一处：`registerChat(r, _ctx)`。
> **不要**在这里读 `DATA_LLM_*` 之外的东西——`ctx` 已带 `pool` 与 `execute`。

- [ ] **Step 6: 写 console（页签壳 + 三页）**

`modules/data/console/lib/api.ts`（薄封装；**模块各自一份**，不跨模块 import）：

```ts
// console/lib/api.ts —— 模块 API 薄封装：前缀拼接、错误体翻译、非 JSON 回落。
// 契约照 modules/aftersales/console/lib/api.ts（同一套语义，别改形状）。
import { platformFetch } from '@platform/sdk/web'

/** 三同纪律：模块 id = DB schema = API 前缀。 */
const PREFIX = '/api/modules/data'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code)
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown }
    return new ApiError(res.status, typeof body.error === 'string' ? body.error : `HTTP_${res.status}`)
  } catch {
    // 响应体不是 JSON（edge 502 的 HTML 页等）⇒ 回落成状态码，**不因解析失败吞掉状态**
    return new ApiError(res.status, `HTTP_${res.status}`)
  }
}

export async function apiGet(path: string): Promise<unknown> {
  const res = await platformFetch(PREFIX + path)
  if (!res.ok) throw await toError(res)
  return res.json()
}

export async function apiSend(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<unknown> {
  const res = await platformFetch(PREFIX + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
  })
  if (!res.ok) throw await toError(res)
  return res.status === 204 ? undefined : res.json()
}

const MESSAGES: Record<string, string> = {
  INVALID_BODY: '输入不合法，请检查后重试',
  NOT_FOUND: '目标不存在或已被删除',
  LLM_UNCONFIGURED: '本站未开启智能问数（未配置 LLM）',
  AGENT_FAILED: '问数过程中出错了，请稍后重试',
}

/** 已知码给中文文案；未知码回落成码本身（便于排障）。 */
export function messageOf(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? err.code
  return '网络异常，请稍后重试'
}
```

`modules/data/console/query/index.tsx`（问数对话；SSE 逐事件解析）：

```tsx
// console/query/index.tsx —— 通道 A 的对话 UI。
// ⚠️ 用 fetch + ReadableStream 读 SSE，**不用 EventSource**：EventSource 只能 GET，
// 带不了 POST body，而且不能带自定义头/JSON。
import { useState } from 'react'
import { Alert, Button, Card, Input, Space, Table, Typography } from 'antd'
import { platformFetch } from '@platform/sdk/web'
import type { AgentEvent } from '../../domain/agent-loop'

interface Bubble { kind: 'user' | 'activity' | 'answer' | 'error'; text: string; table?: AgentEvent & { type: 'final' } }

/** 逐行解析 SSE：**必须按块缓冲**——一个 chunk 可能切开一行，也可能含多行。 */
async function* readEvents(res: Response): AsyncGenerator<AgentEvent> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trimEnd()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue          // 空行/注释行（保活）跳过
      try {
        yield JSON.parse(line.slice(5).trim()) as AgentEvent
      } catch {
        // 单行坏了不该中断整条流；继续读下一行
      }
    }
  }
}

export default function QueryPage() {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])

  async function ask() {
    const q = question.trim()
    if (!q || busy) return
    setQuestion('')
    setBusy(true)
    setBubbles((b) => [...b, { kind: 'user', text: q }])
    try {
      const res = await platformFetch('/api/modules/data/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setBubbles((b) => [...b, { kind: 'error', text: body.error ?? `HTTP_${res.status}` }])
        return
      }
      for await (const ev of readEvents(res)) {
        if (ev.type === 'activity') setBubbles((b) => [...b, { kind: 'activity', text: `${ev.tool}：${ev.detail}` }])
        else if (ev.type === 'final') setBubbles((b) => [...b, { kind: 'answer', text: ev.text, table: ev }])
        else setBubbles((b) => [...b, { kind: 'error', text: ev.detail ?? ev.reason }])
      }
    } catch {
      setBubbles((b) => [...b, { kind: 'error', text: '连接中断' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Space.Compact style={{ width: '100%' }}>
        <Input value={question} onChange={(e) => setQuestion(e.target.value)}
               onPressEnter={ask} placeholder="问点什么，例如：上个月各门店销售额" disabled={busy} />
        <Button type="primary" onClick={ask} loading={busy}>问数</Button>
      </Space.Compact>
      {bubbles.map((b, i) => (
        <Card key={i} size="small">
          {b.kind === 'answer' && b.table?.table ? (
            <>
              <Typography.Paragraph>{b.text}</Typography.Paragraph>
              <Table size="small" rowKey={(_, idx) => String(idx)}
                     columns={b.table.table.columns.map((c) => ({ title: c, dataIndex: c }))}
                     dataSource={b.table.table.rows.map((row) =>
                       Object.fromEntries(b.table!.table!.columns.map((c, ci) => [c, String(row[ci])])))}
                     pagination={false} />
            </>
          ) : b.kind === 'error' ? (
            <Alert type="error" message={b.text} showIcon />
          ) : (
            <Typography.Text type={b.kind === 'user' ? undefined : 'secondary'}>{b.text}</Typography.Text>
          )}
        </Card>
      ))}
    </Space>
  )
}
```

`modules/data/console/keys/index.tsx`（**明文只此一次**）：

```tsx
import { useEffect, useState } from 'react'
import { Alert, Button, Input, Modal, Space, Table, Typography, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

interface KeyRow { id: number; name: string; createdAt: string; lastUsedAt: string | null; revoked: boolean }

export default function KeysPage() {
  const [rows, setRows] = useState<KeyRow[]>([])
  const [name, setName] = useState('')
  const [once, setOnce] = useState<string | null>(null)     // 明文 token：**只在内存里**，刷新即失
  const [messageApi, ctx] = message.useMessage()

  const load = () => apiGet('/keys')
    .then((b) => setRows((b as { keys: KeyRow[] }).keys))
    .catch((e) => messageApi.error(messageOf(e)))

  useEffect(() => { void load() }, [])

  async function create() {
    try {
      const b = (await apiSend('/keys', 'POST', { name: name.trim() })) as { token: string }
      setOnce(b.token)
      setName('')
      await load()
    } catch (e) { messageApi.error(messageOf(e)) }
  }

  async function revoke(id: number) {
    try { await apiSend(`/keys/${id}`, 'DELETE'); await load() }
    catch (e) { messageApi.error(messageOf(e)) }
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Space.Compact>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Key 名称，例如：我的 Claude Code"
               maxLength={64} />
        <Button type="primary" onClick={create} disabled={!name.trim()}>生成</Button>
      </Space.Compact>
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: '名称', dataIndex: 'name' },
        { title: '创建于', dataIndex: 'createdAt' },
        { title: '最近使用', dataIndex: 'lastUsedAt', render: (v: string | null) => v ?? '从未使用' },
        { title: '操作', render: (_: unknown, r: KeyRow) =>
            r.revoked ? '已吊销' : <Button danger size="small" onClick={() => revoke(r.id)}>吊销</Button> },
      ]} />
      {/* 明文 token **只在这一处**出现；关掉即不可再取（库里只有 sha256） */}
      <Modal open={once !== null} title="请立即复制——这条 Key 只显示这一次"
             onCancel={() => setOnce(null)} onOk={() => setOnce(null)} okText="我已保存">
        <Typography.Paragraph copyable={{ text: once ?? '' }} code>{once}</Typography.Paragraph>
        <Alert type="warning" showIcon message="关闭后无法再查看，只能重新生成。" />
      </Modal>
    </Space>
  )
}
```

`modules/data/console/index.tsx`（页签壳；**照 `modules/aftersales/console/index.tsx` 的实测结论，别自作聪明**）：

```tsx
// console/index.tsx — 数据模块 console 入口。
//
// ⚠️ 三条实测结论（照 modules/aftersales/console/index.tsx，本仓浏览器实测得来，勿「优化」）：
// 1. **不用嵌套 `<Routes>`**：本组件挂在宿主壳的 `{ path: '*', element: <ConsoleModulePage /> }`
//    之下，嵌套 Routes 是相对父路由匹配的 ⇒ 拿到的是 splat 剩余段，`path="query"` 永远匹配不上
//    ⇒ **整块空白且无任何报错**。改为按 pathname 末段直接选页。
// 2. **导航必须用绝对路径**：相对导航会以壳的 splat 为基准解析到 `/console/`，把 `data` 段丢掉。
// 3. 裸条目路径规范化到默认页签：让 URL 与页面内容始终一致（否则深链/刷新语义含混）。
import { useEffect } from 'react'
import { Layout, Menu } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import QueryPage from './query'
import MetricsPage from './metrics'
import KeysPage from './keys'

const TABS = [
  { key: 'query', label: '问数' },
  { key: 'metrics', label: '指标' },
  { key: 'keys', label: '我的 Key' },
] as const

type TabKey = (typeof TABS)[number]['key']
const TAB_KEYS: readonly string[] = TABS.map((t) => t.key)
const DEFAULT_TAB: TabKey = 'query'

function isTabSegment(seg: string): seg is TabKey {
  return TAB_KEYS.includes(seg)
}

export default function DataConsolePage() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const last = pathname.split('/').filter(Boolean).pop() ?? ''
  const active: TabKey = isTabSegment(last) ? last : DEFAULT_TAB
  const basePath = isTabSegment(last) ? pathname.slice(0, pathname.lastIndexOf('/')) : pathname

  useEffect(() => {
    if (!isTabSegment(last)) navigate(`${pathname}/${DEFAULT_TAB}`, { replace: true })
  }, [last, pathname, navigate])

  const PAGES: Record<TabKey, () => React.JSX.Element> = {
    query: QueryPage, metrics: MetricsPage, keys: KeysPage,
  }
  const Active = PAGES[active]

  return (
    <Layout style={{ background: 'transparent' }}>
      <Menu mode="horizontal" selectedKeys={[active]}
            items={TABS.map((t) => ({ key: t.key, label: t.label }))}
            onClick={({ key }) => navigate(`${basePath}/${key}`)}
            style={{ marginBottom: 16 }} />
      <Active />
    </Layout>
  )
}
```

`modules/data/console/metrics/index.tsx`（指标管理；**只读列表 + 下线**）：

```tsx
// 只读列表 + 下线。**不含新增/编辑**——为什么见下方注记（`MetricBody` 的必填项与
// 「口径只定义一次」两条硬约束共同排除了 UI 手搓指标定义这条路）。
import { useEffect, useState } from 'react'
import { Button, Space, Table, message } from 'antd'
import { apiGet, apiSend, messageOf } from '../lib/api'

interface MetricRow {
  id: string
  title: string
  description: string
  requiredScope: string | null
  subjectColumn: string
}

export default function MetricsPage() {
  const [rows, setRows] = useState<MetricRow[]>([])
  const [messageApi, ctx] = message.useMessage()

  const load = () => apiGet('/metrics/all')
    .then((b) => setRows((b as { metrics: MetricRow[] }).metrics))
    .catch((e) => messageApi.error(messageOf(e)))
  useEffect(() => { void load() }, [])

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {ctx}
      <Table rowKey="id" dataSource={rows} pagination={false} columns={[
        { title: 'id', dataIndex: 'id' }, { title: '标题', dataIndex: 'title' },
        { title: '说明', dataIndex: 'description' },
        { title: '所需 scope', dataIndex: 'requiredScope', render: (v: string | null) => v ?? '不限' },
        // 主体列**显示出来**（只读）：它是主体钉死的依据，管理员必须能一眼看出这个指标按哪列隔离。
        { title: '主体列', dataIndex: 'subjectColumn' },
        { title: '操作', render: (_: unknown, r: MetricRow) => (
            <Button danger size="small"
                    onClick={async () => {
                      try { await apiSend(`/metrics/${r.id}`, 'DELETE'); await load() }
                      catch (e) { messageApi.error(messageOf(e)) }
                    }}>删除</Button>) },
      ]} />
    </Space>
  )
}
```

> **本页不含「新增」——这是决定，不是省略。** 两条硬约束把 UI 手搓指标定义这条路排除了：
>
> 1. **`MetricBody` 的必填项**（T6）：`subjectColumn` 与 `selectSql` 都是 `z.string().min(1)`。
>    一个只收 `id/title/description/requiredScope` 的表单**必然 400 `INVALID_BODY`**
>    （不要写成「必填项没填就报错」——它连提交都过不去，且报错信息是英文 zod 细节）。
> 2. **口径只定义一次**（分层设计 §3/§7）：指标定义（含 SQL 与主体列）是 ④ 建模层的产物，
>    随管线走代码评审。在 console 里提供一个 SQL 输入框 = 允许在 ⑦ 消费层**第二次定义口径**，
>    正好破掉那条纪律。而本计划**没有任何**校验 `subjectColumn` 真在数仓表里存在的机制 ⇒
>    UI 写入的坏定义会**静默返回错数据**（这是选择只读的真正理由，不是洁癖）。
>
> ⇒ 指标定义的写入路径是 `POST/PUT /metrics`（`data:manage` 保护，给管线/运维用；T6 有测试），
> 或部署期 seed。本页只做**查看 + 下线**。**与 spec 不冲突**（spec §3 只要求词表裁剪生效，
> 未要求 UI 定义指标）。若 reviewer 认为必须有 UI 定义入口，请**同时**把 `subjectColumn`
> 存在性校验补进 T6，否则别加这个入口。

- [ ] **Step 7: 给页签壳补一个测试**

`modules/data/console/index.test.tsx`（照 `modules/aftersales/console/index.test.tsx` 的写法：`MemoryRouter` + 断言
裸路径被规范化到默认页签、页签点击后 URL 段正确）。**不测样式**，只测「URL 驱动哪一页」。

> **与 spec 的一处刻意偏离（记录在案）**：spec §3 写的是「console **个人页**新增『问数 Key』」，本计划把 Key 页签放进 `data` 模块自己的 console 页。理由：个人页属平台 console（`apps/web`），而所有问数端点都在模块的 API 子树上；跨到平台页会让平台前端依赖模块 API 前缀。**这一偏离要在 PR body 里写明**，并由 reviewer 确认可接受。

- [ ] **Step 8: manifest 加 `/chat` + index 注册 + 跑测试**

```yaml
    - { method: POST, path: /chat, scope: data:query }
```

`index.ts` 加 `registerChat(r, _ctx)`（与 T6/T7 同一处）。**manifest 与路由必须同一步改完**——
装载期双向核对，差一个方向就是**起不来**（不是告警）。

Run: `DATABASE_URL=… pnpm --filter data test && pnpm --filter data typecheck` → PASS

- [ ] **Step 9: 提交 + PR**

```bash
git add modules/data
git commit -m "feat(data): 通道A 系统内问数——后端 LLM 编排 + SSE + console 三页签"
```

---

# W5 — 端到端验收

### Task 10: 三通道 e2e + PAT 往返契约 + 收尾

**这是唯一能证明「一个授权核心」真的成立的测试**：同一个指标、同一份数据，三条通道各自带身份进来，得到**一致**的可见范围与钉死主体。

**Files:**
- Create: `apps/server/src/data-query.e2e.test.ts`
- Modify: `docs/superpowers/specs/2026-09-21-data-query-channels-design.md`（§6 待核实项按实测收口）
- Modify: `modules/data/README.md`

**Interfaces:**
- Consumes: T1–T9 全部；`apps/server/src/demo-tenant-isolation.test.ts` 的装配范式（**照它抄，不是 `app.test.ts`**——两者的 `tenantMode` 不同，见 Step 1 的 ⚠️）
- Produces: 无新公开接口（验收 + 文档收口）

- [ ] **Step 1: 写 e2e 测试**

`apps/server/src/data-query.e2e.test.ts` 骨架。**装配照 `demo-tenant-isolation.test.ts` 抄**
（真会话中间件 + MockCasdoor + 双租户域名分流，那个文件已跑通 —— `app.test.ts` 是
`single` 形态，**抄它会踩下面第 ③ 条的坑**）：

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { SESSION_COOKIE, signSession } from '@platform/auth-core'
import { buildApp } from './app'
import { getPool } from './db'
import { seedDemo } from './seed'
import type { AppConfig } from './config'
import { upsertMetric } from '../../modules/data/domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ADMIN_PWD = 'admin-pwd-for-test'
// 会话密钥：**一个常量，两处消费**（config 与 signSession）。别在用例里另写一份或读
// `process.env.SESSION_SECRET`——签验两边不一致的症状是「会话被当成无效」，
// 看起来像中间件/租户解析坏了，实际只是密钥不同（且 `??` 兜底让它只在 CI 上偶发）。
const SESSION_SECRET = 'test-secret-test-secret-test-secret!'

// 仓库连接指向**本机 pg**（e2e 用真 SQL 跑通「主体钉死」——这是整套设计最要紧的一条断言）。
// ⚠️ 两条：① 必须在**任何 buildApp 之前**（模块在**请求期**从 process.env 读它，T3 的
//    `warehouseConfigured()`）；② 必须 `if (dbUrl)` 守卫——Node 里 `process.env.X = undefined`
//    会把值**字符串化成 `"undefined"`**（不是删除）⇒ `warehouseConfigured()` 变 true，
//    指向一个假 DSN，报错信息完全不指向真因。
if (dbUrl) process.env.DATA_WAREHOUSE_URL ??= dbUrl

// 语料：一张跨主体的夹具表（两个 org 各一行），证明同一指标在两主体下各见各的
const FIXTURE_DDL = `
create schema if not exists marts;
create table if not exists marts.sales_daily (
  org text not null, day date not null, revenue numeric not null);
delete from marts.sales_daily;
insert into marts.sales_daily values
  ('acme', '2026-08-15', 100), ('beta', '2026-08-15', 999);
`

// MockCasdoor：形状照 demo-tenant-isolation.test.ts（owner = 用户归属 org，真机语义）。
// 本文件的用例**基本不走登录**（只有「PAT 往返契约」用一次会话 cookie），
// 直接 signSession 签发 ⇒ users/perms 的存在主要是为了让 Casdoor 通路不至于 404。
const mock = new MockCasdoor({
  users: [
    { name: 'alice', password: ADMIN_PWD, owner: 'acme' },
    { name: 'bob', password: ADMIN_PWD, owner: 'beta' },
  ],
  perms: [
    { owner: 'acme', resources: ['data:query', 'data:manage'], users: ['alice'] },
    { owner: 'beta', resources: ['data:query', 'data:manage'], users: ['bob'] },
  ],
})

let app: Awaited<ReturnType<typeof buildApp>>['app']

// 配置：照 **demo-tenant-isolation.test.ts** 抄（**不是** app.test.ts —— 见下 ⚠️）
function configWithCasdoor(casdoorUrl: string): AppConfig {
  return {
    port: 13001,                    // 别与 app.test.ts / isolation 的 13000 撞（真 socket 那层会起服务）
    databaseUrl: dbUrl!,
    // ⚠️⚠️ **必须 multi + platformOrg: ''**，不能抄 app.test.ts 的 `single`/`'acme'`：
    //   tenant.ts:57 `mode === 'single'` 时 **host 头完全忽略**、只按 platformOrg 查唯一租户。
    //   写成 single 的后果：`host: 'beta.test'` 也会解析到 **acme** 租户 ⇒
    //   ① 本用例赖以成立的两主体前提没了；② 更要命的是它**不报错**，只是断言在错误的主体上
    //   跑（"跨主体不可见"会变成"自己和自己比"）。
    tenantMode: 'multi',
    platformOrg: '',
    sessionSecret: SESSION_SECRET,
    casdoor: {
      url: casdoorUrl, clientId: 'test-client', clientSecret: '',
      application: 'app-built-in', adminUser: 'admin', adminPwd: ADMIN_PWD,
    },
    publicOrigin: 'http://127.0.0.1:13001',
    // **必需**：它为 platform.tenant 种下 acme/beta 两个租户 + 域名 acme.test / beta.test
    // （multi 模式靠域名分流）。本文件需要两个租户：acme 当"我自己"，beta 当"别人的主体"。
    seedDemo: true,
    // ★ 通道 C 的渠道凭证。**不给它 ⇒ wecomChannelAuth 会直接 next() 放行**（设计如此：
    //   没开通道 C 的部署不能被锁死）⇒ 用例 4 会静默变成"没验到东西"却仍然绿。
    dataWecomChannelKey: 'test-channel-key',
  }
}

// 通道 C 的 header 组合（**键名必须与 apps/server/src/wecom-channel-auth.ts 读的逐字一致**——
// 那个文件是本任务之前从未存在过的，T5 才建；抄错键名的症状是 401，不是"少了个头"）
const WECOM_HEADERS = { 'x-channel-key': 'test-channel-key', 'x-wecom-userid': 'alice' }

/** 三通道共用的请求入口：只要 host（租户）+ 可选的鉴权头——把「怎么带身份」留成参数。 */
async function req(
  path: string,
  host: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { host, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const QUERY_BODY = { metric: 'sales_daily', params: {} }

/**
 * alice 的两个凭证（**懒建 + 记忆化**）：用例 1/2/3/5/6/7/8 共用同一份身份，
 * 从而**互不依赖执行顺序**——若让用例 3 直接吃用例 1 的产物，用例 1 一红就会连带
 * 把其余用例变成「undefined 引起的怪错」，掩盖真因。
 *
 * `scopes` 只给 `data:query`（不给 `data:manage`）：用例 8 正是靠这个差值证明"门卫还在"。
 */
let aliceCookieCache: string | undefined
let alicePatCache: string | undefined

async function aliceCookie(): Promise<string> {
  if (!aliceCookieCache) {
    const token = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: ['data:query'], authVia: 'password' },
      SESSION_SECRET,
    )
    aliceCookieCache = `${SESSION_COOKIE}=${token}`
  }
  return aliceCookieCache
}

/** 通道 B 的凭证：走**模块的路由**建（于是它同时是宿主/模块两侧哈希实现的往返契约）。 */
async function alicePat(): Promise<string> {
  if (alicePatCache) return alicePatCache
  const res = await req('/api/modules/data/keys', 'acme.test', { cookie: await aliceCookie() }, { name: 'e2e' })
  expect(res.status, 'POST /keys 应 201').toBe(201)
  alicePatCache = ((await res.json()) as { token: string }).token
  return alicePatCache
}
```

（`signSession` / `SESSION_COOKIE` 从 `@platform/auth-core` 导入，见用例 2 的片段——**别写成
两次 import**，合并到文件顶部的 import 里。）

> **`app` 的装配点只有一个**：`beforeAll` 里
> `app = (await buildApp({ config: configWithCasdoor(mock.origin) })).app`
> （`buildApp` 是 **async**，返回 `{ app }`；`await mock.start()` 必须在它之前——`mock.origin`
> 是随机端口，装配期就要写进 config）。`afterAll` 里 `await mock.stop()`。
> **别在 describe 内私自关池**：池由下面文件级的 `afterAll` 守卫关（`app.test.ts` /
> `demo-tenant-isolation.test.ts` 同款），某处提前 `end()` 会让后续用例拿死池。

`beforeAll` 里按**固定顺序**做五件事（顺序不能换：先 seed 才有租户行，才有 tenantId），
并配一个文件级 `afterAll`：

```ts
let acmeTenantId = 0

beforeAll(async () => {
  if (!dbUrl) return

  // ① MockCasdoor 先起（mock.origin 是随机端口，装配期就要写进 config）
  await mock.start()

  const pool = getPool({ databaseUrl: dbUrl })

  // ② 夹具表（真 pg 上跑真 SQL —— "主体钉死"只有真 SQL 能证）
  await pool.query(FIXTURE_DDL)

  // ③ 租户：seedDemo 种下 acme/beta（slug / casdoor_org 都是 'acme'、'beta'，
  //    域名 acme.test / beta.test —— multi 模式靠域名分流，这正是 host 头在本文件里的作用）
  await seedDemo(pool)

  // ④ ★ tenantId **从库里查**，不要写死 1：platform.tenant.id 是自增，
  //    在**不是全新空库**上跑过几轮之后它就不是 1 了（`on conflict do update` 保留原 id）。
  //    写死 1 的症状是「用例全红且看起来像授权/装载问题」——实际上只是 fixture 挂到了别的租户。
  const { rows } = await pool.query<{ id: string }>(
    `select id from platform.tenant where slug = 'acme'`)
  acmeTenantId = Number(rows[0]!.id)
  if (!Number.isSafeInteger(acmeTenantId) || acmeTenantId <= 0) {
    throw new Error('e2e fixture: platform.tenant 里没有 acme 租户（seedDemo 没跑成）')
  }

  // ⑤ 指标定义走 T3 的 store（幂等 upsert，可重复跑）。**两个指标**：
  //    一个 alice 够得着（data:query），一个够不着（data:finance）——用例 6 的裁剪断言靠这对差值，
  //    只有一个指标的话「不在词表里」既可能是裁剪对了、也可能是词表本来就空（假绿）。
  await upsertMetric(pool, acmeTenantId, {
    id: 'sales_daily', title: '销售日报', description: '按主体分组的日销售额',
    requiredScope: 'data:query', subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.sales_daily', groupBy: '', params: {},
  })
  await upsertMetric(pool, acmeTenantId, {
    id: 'finance_summary', title: '财务汇总（alice 无权）', description: '给裁剪断言用的对照项',
    requiredScope: 'data:finance', subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.sales_daily', groupBy: '', params: {},
  })

  // ⑥ app 装配（**buildApp 是 async**，返回 `{ app }`；必须晚于 mock.start 与 DATA_WAREHOUSE_URL）
  app = (await buildApp({ config: configWithCasdoor(mock.origin) })).app
})

afterAll(async () => {
  if (!dbUrl) return
  await mock.stop()
  // 文件级关池守卫（app.test.ts / demo-tenant-isolation.test.ts 同款）：
  // 断言「没人私自 end 过」再关——这条断言本身就是防"某个 describe 提前关池"的探针。
  const pool = getPool({ databaseUrl: dbUrl })
  expect(pool.ended, '池在文件级 afterAll 之前就被 end 了——检查 describe 里是否私自关池').toBe(false)
  await pool.end().catch(() => {})
})
```

> **`process.env.DATA_WAREHOUSE_URL` 与 `mock.start()` 都必须早于 `buildApp`**：前者因为模块在
> **请求期**读它（T3 的 `warehouseConfigured()`），放晚了第一条 query 用例就会拿到
> `warehouse_unconfigured`；后者因为 `config.casdoor.url` 要写 `mock.origin`。
> **装配点全文件只有一处**（`beforeAll` ⑥），别在 describe 里再 `buildApp` 一次。

用例：

1. **PAT 往返契约**（建 key 用的是**模块的路由**，校验用的是**宿主中间件**——宿主与模块各自
   实现的那一行哈希只要有一个字符不同，这条必红）：`const pat = await alicePat()` →
   `expect(pat).toMatch(/^[A-Za-z0-9_-]{20,}$/)`（**别断言长度 32/64 这类具体值**——编码方式一改
   就假红）→ 再用它请求 `POST /api/modules/data/query` → **200**。
2. **通道 A（会话）**：**`signSession` 是 async 的**（`packages/auth-core/src/session.ts:37`，返回 `Promise<string>`），
   而且 `SessionPayload` 的 `iat/exp/sfa` 由它自己补 ⇒ 只传四段身份字段
   （`signSession` / `SESSION_COOKIE` 已在文件顶部 import，别在这里重复 import）：

   ```ts
   // ⚠️ 必须 await。漏了它拿到的是 Promise 对象，被模板串成 "[object Promise]"
   //    ⇒ 表现为「会话无效」被重定向，而不是类型错误（typecheck 也拦不住，因为模板串接受任意值）
   const token = await signSession(
     { sub: 'alice', org: 'acme', name: 'alice', scopes: ['data:query'], authVia: 'password' },
     SESSION_SECRET,   // ← 与 config.sessionSecret **同一个常量**（写两份必错，见上面的注记）
   )
   const res = await req('/api/modules/data/query', 'acme.test',
     { cookie: `${SESSION_COOKIE}=${token}` }, QUERY_BODY)
   ```
   断言 `res.status === 200`、`subject === 'acme'`，行里只有 `org='acme'` 的那条。
   （等价写法：直接 `await aliceCookie()` —— 它签的就是同一份载荷。用例 2 显式写出来是为了
   让「会话怎么来的」在用例里可见。）

   > **别为这条去走登录端点**：直接签发正是要证明「身份从会话带进来即可，不依赖登录路径」。
   > 走登录反而要多配 MockCasdoor 的密码/租户关系，把用例的失败面撑大。唯一注意：
   > `signSession` 会把 `sfa` 设为 now ⇒ `sessionMiddleware` 的 `needsScopeRefresh`
   > （`now - sfa >= 300`）**不会命中**，因此不会再向 Casdoor 拉 scopes——
   > 载荷里的 `scopes: ['data:query']` 就是本次请求的真值。（若手工构造 payload 把 `sfa`
   > 设成过去，中间件会去 MockCasdoor 拉权限，用例就变成在测 Casdoor 而不是测问数。）
   >
   > `name: 'alice'` 同时是**身份显示名**（`session-middleware.ts:118` `displayName: p.name`）
   > —— 与用例 4 的 `x-wecom-userid: alice`、用例 3 的 PAT 归属用户**必须是同一个字符串**，
   > 否则「三通道同一人得同一结果」这句断言在比较三个不同的人。
3. **通道 B（PAT）**：`await req('/api/modules/data/query', 'acme.test', { authorization: `Bearer ${await alicePat()}` }, QUERY_BODY)`
   → 200，`subject === 'acme'`，**行集与用例 2 逐行一致**（这就是「一个授权核心」的证明——
   把两次的 `rows` 各自 `JSON.stringify` 后 `toEqual`，别只比 `subject`）。
4. **通道 C（企微）**：`WECOM_HEADERS` 请求同一端点 → 同结果；再把 `x-wecom-userid` 换成
   `'nobody'` → **401 `WECOM_USER_NOT_LINKED`**。
   > 这条**必须先确认 `config.dataWecomChannelKey` 给上了**：不给它的部署里，
   > `wecomChannelAuth` 会**直接 `next()` 放行**（设计如此——没开通道 C 的部署不能被锁死）。
   > 于是"nobody 也被拒"这句会**因为别的理由**变绿或变红，而"alice 能查"这句会**在拿不到身份时**失败。
5. **主体钉死（三通道各测一次）**：`args: { org: 'beta' }` → 403 `subject_pinned_by_platform`，且**回包不含 beta 的任何数据**。
   （夹具里 beta 的金额是 **999**，acme 是 **100**——断言回包里没有 `999` 比断言"没有 beta 字样"硬。）
6. **词表裁剪（三通道各测一次）**：`data:finance` 的指标在 `tools/list`（通道 B）与 `GET /metrics`（通道 A）里**都不出现**。
7. **审计三通道统一**：三条成功请求之后查审计表——
   ```ts
   const pool = getPool({ databaseUrl: dbUrl! })
   const { rows: audit } = await pool.query<{ channel: string; org_id: string; verdict: string }>(
     `select distinct channel, org_id, verdict from data.query_audit
       where tenant_id = $1 and metric_id = 'sales_daily'`, [acmeTenantId])
   ```
   断言三个通道的 `(channel, org_id)` 组合**都出现**（`session` / `pat` / `wecom`，各自 `org_id='acme'`），
   且 `verdict` 只有 `'ok'`。
   > **必须带 `tenant_id` 过滤**：审计表是全租户共用的一张表，且本文件不是唯一写它的测试
   > （T3/T4 的单测也写）——不带过滤的 `count(*)` 会随别的测试跑过而变，是典型的间歇红。
8. **门卫仍然生效**（证明新中间件没绕过既有门禁）：用 `aliceCookie()`（只有 `data:query`）请求
   `GET /api/modules/data/metrics/all`（声明 `data:manage`）→ **403**。
   > ⚠️ 这条的绿**必须来自门卫**：如果 `data:manage` 这个 scope 压根没被声明进 manifest，
   > 门卫会因"未声明路径"而 403——**同样是 403，但没验到东西**。顺手断言一下
   > `GET /api/modules/data/metrics/all` 在**有 `data:manage` 的会话**下是 200
   > （另签一个 `scopes: ['data:query','data:manage']` 的会话即可），差值才说明问题。

- [ ] **Step 2: 跑 e2e，确认通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/server test data-query.e2e`
Expected: PASS（8 条）

> **先在全新空库上跑一次**（`dropdb` / `createdb` 后带 env 跑）——并发/迁移类问题只在空库暴露（团队记忆 `test-concurrency-races-need-fresh-empty-db`）。

- [ ] **Step 3: 收口 spec §6 的待核实项**

在 `docs/superpowers/specs/2026-09-21-data-query-channels-design.md` 的 §6 表里：

| # | 改法 |
|---|---|
| 1 | 已解决（recon 实测）：Casdoor 按 wecom userid 反查 = `casdoor.getUser(userid)`，因为 **userid 即 Casdoor name**（`apps/server/src/routes/auth-wecom.ts` 注释）。改为「已核实」并注明依据 |
| 2 | 保持「待核实」，但补一句：本实现的通道 C **不经过** `mcp.servers`，故 `requesterSenderId` 的跨版本稳定性**不影响**本通道 |
| 3 | 补上实际取值：per-key 限速默认 **60 次/分钟**（`DATA_QUERY_RATE_PER_MIN`）；LLM 选型走 OpenAI 兼容端点（`DATA_LLM_*`），具体模型实施期定 |
| 4 / 5 | 保持原状（另文 / 待沉淀） |

- [ ] **Step 4: 全量门禁**

Run:
```bash
pnpm typecheck && pnpm test
node scripts/check-compose.mjs
node scripts/check-env-example.mjs
```
Expected: 全绿。**任何一条红都不许合**（团队纪律：只等 CI CLEAN）。

- [ ] **Step 5: 提交 + PR + 合并**

```bash
git add apps/server/src/data-query.e2e.test.ts docs/superpowers/specs/2026-09-21-data-query-channels-design.md modules/data/README.md
git commit -m "test(data): 三通道 e2e——同一核心的主体一致性与 PAT 往返契约"
gh pr create --title "feat(data): 问数三通道端到端验收" --body "Closes #<N>"
```

merge 后按 `deploy/openship-adopt.md` §7 自动部署，**部署后必验**（`~/.claude/rules/common/deploy-verify.md`）：

```bash
# 1) 容器创建时间 > 镜像构建时间  2) 新行为在线上可观测（比时间戳更硬）
curl -sS https://<生产域名>/healthz
# 未配 DATA_WAREHOUSE_URL 的部署：POST /api/modules/data/query 应回 502 warehouse_unconfigured
# （可解释的失败 = 配置没配，而不是 500 —— 这本身就是一条线上可观测的新行为）
```

- [ ] **Step 6: WeKnora 沉淀**

按团队规则 `knowledge-capture`：先 hybrid-search **查重**，命中就更新原条目、不新建。值得沉淀的（新增、非显然、带具体动作）：

- 授权核心的产品化形态：**词表裁剪/主体钉死在纯函数层，通道差别只在鉴权中间件**（三通道一致性怎么测）
- PAT 通道**没有**缓存 scopes ⇒ Casdoor 故障必须 fail-closed 503，与会话的降级策略刻意不同
- 宿主/模块边界逼出的**逐字哈希重复 + 往返契约测试**这个模式（何时值得重复代码）
- 企微 userid 即 Casdoor name ⇒ 「绑定」不需要绑定表
- **注意 WeKnora WAF 触发词**：不写带 `WHERE ... IN` 的完整 SQL、不写 `${ENV:...}`、不写 `document.cookie`、不写 `--mount=type=cache`

---

## 附：与本计划相关的已知坑（执行时别重踩）

| 坑 | 出处 | 对本计划的影响 |
|---|---|---|
| node-pg 把 bigint 读成 string | 本计划 T3 | `key_id` / `id` 必须 `Number()` 归一，否则 `===` 与 JSON 回包变味 |
| 迁移幂等是**部署脚本全量重跑**的前提 | 团队规则 `db-migration` §1 | 三张表全 `if not exists`；T1 有一条不记账直跑两遍的测试专测这个 |
| `scripts/` 是 checkJs，JSDoc 字面量类型会被加宽 | 团队记忆 `scripts-checkjs-jsdoc-literal-types-widen` | 本计划不新增 `scripts/` 守卫，若新增须走「单形状、字段恒在」 |
| Orca 工作树中文路径会打挂 vitest | 团队记忆 `non-ascii-worktree-path-breaks-vitest` | W2 四路并行**不要**建在中文路径下（当前 worktree 目录名是 `采集板块`——派发前确认 Orca 新 worktree 的路径） |
| 桶文件（barrel）export 混入 type 会运行时崩 | 本仓 #44 事故；AGENTS.md 硬约束 10 | `packages/platform-sdk/src/index.ts` 加导出时，**值导出与类型导出分行**（`export { … }` 只放值） |
| 合并只等 CI CLEAN | 团队记忆 `merge-only-on-clean-ci` | 每个 PR 都等 CLEAN，**UNSTABLE 不许强合** |

---

## 自检记录（作者填，reviewer 可复核）

- **spec 覆盖**：§2 通道A → T9；§3 通道B（Key 管理 → T7，MCP → T8，per-key 限速 → T5）→ 全覆盖；§4 通道C → T5（中间件）+ T10（e2e）；§5 八条硬约束 → Global Constraints 1–8 逐条对应；§6 待核实 → T10 Step 3 收口。**§7「不采 SQL 白名单」**→ 落实为 T2 的「只有已声明指标、无自由 SQL」。
- **占位扫描**：无 TBD/TODO/「实现要点」；每个代码步骤都有可粘贴的代码块。
  唯一的**有意收窄**是 T9 的 console 指标管理页：**只读列表 + 下线，不含新增/编辑**——
  理由是「`MetricBody` 的 `subjectColumn`/`selectSql` 是必填」×「口径只定义一次」，
  且本计划没有 `subjectColumn` 存在性校验（UI 写入的坏定义会静默返回错数据）。
  已在 T9 Step 6 对应小节把两条理由写全，并在本记录「有意偏离」节复述。
- **类型一致性**：`Requester` / `MetricDef` / `QueryOutcome` 在 T2/T4 定义，T6/T7/T8/T9/T10 消费，签名逐处核对一致；`tenantId: number` 全链一致（T3 store → T4 runQuery → T6 路由）。

### 自检发现并**就地修正**的缺陷（第二轮逐字核仓后）

第一轮自检只做了「本计划内部」一致性，**没逐条对真仓 API 核**。第二轮回仓逐字核对（读
`session-middleware.ts` / `tenant.ts` / `auth-core/src/public.ts` / `casdoor-client.ts` /
`test-util/mock-casdoor.ts` / `app.test.ts` / `demo-tenant-isolation.test.ts` /
`routes/admin.test.ts` / `loader.test.ts` / `platform-sdk/web/platform-fetch.ts`）
后共改掉 **21 处**。它们分两类：

- **#1–#16：照想象写的 API 与真仓不符**——执行期会以「莫名其妙的红」形式爆炸。
- **#17–#21：计划自身不可执行/会假绿**——代码块齐全但**跑不通**或**验了空气**，
  比第一类更危险（第一类至少会红）。

| # | 缺陷 | 修正 |
|---|---|---|

| # | 缺陷 | 修正 |
|---|---|---|
| 1 | T5 测试用了 `MockCasdoor` 不存在的 `addUser` / `client(org)` 方法 | 改为**构造期播种**（`MockCasdoorOptions`）+ 一个 `casdoorFor(mock)` 工厂 |
| 2 | T5 测试用 `new Hono()` + 只 set 部分 `tenant` 字段 | 改 `new Hono<RequesterEnv>()` + `admin.test.ts:67` 的**全字段** `TenantRow` 字面量 |
| 3 | T5 两个中间件写成 `: MiddlewareHandler` + 裸 `createMiddleware` | 改成 `MiddlewareHandler<RequesterEnv>` + `createMiddleware<RequesterEnv>`（**两者都要写**，只写一个 ⇒ `Context<BlankEnv>` ⇒ `c.set` 只接受 `never`） |
| 4 | T6 `requesterOf(c: Context<ModuleHono>)` | 改 `Context<ModuleVars>`——`Context` 的泛型参数是**整个 Env 对象** |
| 5 | T6 `ModuleVars & RequesterVars`（把请求者键搁在 Env 顶层 ⇒ `c.get` 永远拿不到） | 改成 `{ Variables: { … } & RequesterVars }` |
| 6 | T6 `routes/query.ts` 里 `const identity` / `void identity` 死代码，且 `runQuery` **没传 `execute`** | 删死代码；`{ pool, execute }` 透传（否则 T8/T9 的测试会被真网络错误顶掉） |
| 7 | T6 Step 3 有一段**未决的推演散文**（"采后者——不，更简单…"）与一段已被 T1 作废的 `[TENANT_STORAGE]?` 片段 | 删除，改写为「T1 已把 `tenant` 放进 `ModuleVars`，本任务只加求交 / `RouteCtx.execute` / `requesterOf`」的定论 |
| 8 | T6 `routes/metrics.ts` 只有「要点」 | 补全为可粘贴实现（含 `publicView` 只投影三字段） |
| 9 | T6 Step 1 用 `pool: null as never` 造 `metric_not_declared`（自相矛盾：那条路径要真 `loadCatalog`） | 拆成「参数面（不需 DB）」与 `describePg`「需 DB」两组 |
| 10 | T7 Step 3 只有「要点」 | 补全为可粘贴实现 |
| 11 | T9 `AgentEvent` 少 `error` 变体（SSE 一开流就只能用事件报错） | 加 `{ type:'error'; reason; detail? }` |
| 12 | T9 `ChatMessage` 缺 `toolCallId` / `toolCalls`（OpenAI 的 `role:'tool'` 必须带 `tool_call_id`，`assistant` 轮要回放 `tool_calls`） | 补这两个可选字段并说明是**协议要求** |
| 13 | T9 `runAgentLoop(deps: { … execute?: … })` + Steps 3/4/5 全是「要点」 | 定义 `AgentDeps`；`llm.ts` / `agent-loop.ts` / `chat.ts`（含真 `ReadableStream` SSE 体）全部补成可粘贴实现；console 四页同样补代码 |
| 14 | T10 `signSession(...)` 当同步用（它是 `async`，返回 `Promise<string>`） | 改成 `await signSession(...)`，并写明「漏 await ⇒ 拿到 `[object Promise]` ⇒ 表现为会话无效，typecheck 拦不住」 |
| 15 | T5 `requester-vars.ts` 的 doc 注释把模块侧写成 `ModuleVars & RequesterVars`（= #5 已判为错的形状，**注释本身在教人写错**） | 注释改写成「只有一种用法：求交进 `Variables` 内层」，并写明写错的症状（`c.get` 恒 undefined ⇒ 限速/审计静默丢归属） |
| 16 | T6 `routes/metrics.ts` 的 `PUT` 用 `parseIdParam`（`Number()`）挡指标 id，而指标 id 是 `text` ⇒ **合法 id 恒 404**；且 PUT/DELETE 两侧口径不一 | 新增文件内 `metricIdOf`（原字符串、只挡空）作**唯一**口径，PUT/DELETE 共用；`DELETE` 补齐 `id === null` 分支；`PUT` 补 `ID_MISMATCH` 的「为什么」（改 A 写 B 是静默数据事故）。`parseIdParam` 移出本文件 import（T7 那边用于 bigint 键、保持不变） |
| 17 | T9 console 指标页的「新增」表单只发 `id/title/description/requiredScope`，而 T6 的 `MetricBody` 把 `subjectColumn`/`selectSql` 定为必填 ⇒ **POST 恒 400 `INVALID_BODY`**（页面上表现为"新增没反应"） | 该页改为**只读列表 + 下线**，并把两条理由写全（必填项矛盾 × 口径只定义一次 ⑦ 不改义，且本计划无 `subjectColumn` 存在性校验）；主体列改为**只读展示**（管理员要能看出按哪列隔离） |
| 18 | T10 `configWithCasdoor` 说"照 `app.test.ts` 的 configWith 抄"⇒ 拿到 `tenantMode:'single'` + `platformOrg:'acme'`；而 `tenant.ts:57` 在 single 下**完全忽略 host 头** ⇒ `host:'beta.test'` 也解析成 **acme** | 改抄 **`demo-tenant-isolation.test.ts`**（`multi` + `platformOrg:''`，README 级注释写清为什么），并写明写错的症状是「不报错，只是在错误的主体上断言」 |
| 19 | T10 全文件**没有装配点**：用例引用 `app`、引用 `buildApp(...)`，但没有任何一处真的调用（也没有 `MockCasdoor` 构造、没有文件级 `afterAll` 池守卫） | 补齐：`MockCasdoor` 构造（`owner`=用户 org）、`beforeAll` 六步含 ⑥ `app = (await buildApp({...})).app`、`afterAll` 含 `expect(pool.ended).toBe(false)` 守卫 |
| 20 | T10 两处"同源值"陷阱：① 用例里 `SECRET = process.env.SESSION_SECRET ?? 'test-session-secret'` 与 config 的 `sessionSecret` **不同源** ⇒ 签验不一致（症状像中间件坏了）；② `process.env.DATA_WAREHOUSE_URL ??= dbUrl` 在 `dbUrl` 为 `undefined` 时会被 Node **字符串化成 `"undefined"`** ⇒ `warehouseConfigured()` 变 true 指向假 DSN | ① 提成文件级常量 `SESSION_SECRET`，config 与 `signSession` 共用；② 加 `if (dbUrl)` 守卫，并写明 Node 的这个字符串化行为 |
| 21 | T10 用例靠**执行顺序**传状态（用例 3 直接吃用例 1 建的 token）⇒ 用例 1 一红，后面全变成「undefined 引起的怪错」，掩盖真因 | 加 `aliceCookie()` / `alicePat()` 两个**懒建 + 记忆化** helper，用例互不依赖顺序 |

**另外三处不是"与真仓不符"、而是"计划自己不可执行"**，也一并修了：

- **T7/T10 的 `buildTestApp` 第 4 参**：T1 已定为 `DataTenant`（`{ id; casdoor_org }`），T7 原先传裸 `TENANT` 数字 ⇒ 改为传对象。
- **T10 `acmeTenantId` 原本写死 1**：`platform.tenant.id` 是自增，非空库上跑过几轮就不是 1 ⇒ 改为 `beforeAll` 里**按 slug 查**并在查不到时抛错。
- **T10 的 e2e 配置缺 `dataWecomChannelKey`**：不给它 ⇒ 通道 C 的中间件**直接放行**（设计如此）⇒ 用例 4 会「没验到东西却仍然绿」。已补进 `configWithCasdoor` 并注明这个静默绿的机制。

### 仍然存在的一处**有意偏离**（reviewer 请裁决）

- **console 三页的代码是「照 `modules/aftersales/console/*` 的形态改写的」而非「逐字核对真仓后写出」**：
  aftersales console 有 6 页，逐页读进来核对成本高，且这些页面是**纯展示层**（权限不在这里强制，
  强制点在模块 API）。所以本计划对 console 采取「形态照抄 + 明确列出不可违反的三条实测结论
  （不用嵌套 `<Routes>` / 导航用绝对路径 / 裸路径规范化）」的策略。
  **若 reviewer 认为不够，请在评审时点出**——执行者遇到与真仓不符时，以真仓
  `modules/aftersales/console/` 的实际写法为准，并**就地修正本计划**。
- **Key 页签放在模块 console 而非平台个人页**（spec §3 原文）：理由已写在 T9 Step 6 前，**必须在 PR body 里写明**。
