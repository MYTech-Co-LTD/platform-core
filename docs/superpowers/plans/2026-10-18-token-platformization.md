# token 平台化（#894）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把个人 Key（PAT，通道 B）的**密钥表 + 生成/吊销 + 管理面**从 `modules/data` 上移到宿主（`platform.*`），并删掉 `runtime.port('data','resolvePatKey')` 这条「凭据表长在模块 schema、宿主绕 B1 去取」的间接层；配套平台级「个人页（登录即可）+ 管理页（`tenant:admin`）」。

**Architecture:** 新表 `platform.api_key`（宿主 schema，B1 天然允许）→ 宿主 key-store 直查 → `pat-auth.ts` 的注入源从**模块端口**换成**宿主函数**（同签名，改动最小）→ `modules/data` 的端口/存储/路由/页面/声明**同一提交**退役（manifest 双向核对要求两侧同删）→ 宿主控制台加两个静态页（个人页**不套** `AdminGate`，管理页套）。

**Tech Stack:** TypeScript / Hono / pg / vitest / react-router-dom + antd。

**Spec:** 本仓 `docs/architecture.md` **§1.5 身份与访问**（本分支）+ issue **#894**。

---

## Global Constraints

- **B1 扫描根 = `apps/ + packages/ + modules/`**（`scripts/lint-architecture.mjs:8,49`）⇒ **宿主迁移（`apps/server/src/migrations/`）不得引用 `data` schema**。
  存量迁移因此**必须走 `scripts/`**（不在扫描根内，已核）。
- **manifest 双向核对**：`api.internal` 声明集合必须与 `createRouter` 注册集合逐条一致，差集 ⇒ **装载失败** ⇒ 删路由必须**同一提交**删声明。
- **隔离键用 `org text`**（不是 `tenant_id int`）：对齐 `pat-auth.ts:83-86` 的 `key.org !== tenant.casdoor_org` 比较口径（当前跨租户比对就是 text org）。宿主其他表用 int 那是它们的事——**本表必须能与 `casdoor_org` 直接比**。
- **哈希实现只有一份**：上移后是宿主那份（`sha256(token).hex`）。前缀 `dkq_` 是**协议**（两边同值不是重复，别删）。
- **fail-closed 不降级**：Casdoor 故障 ⇒ `503 CASDOOR_UNAVAILABLE`（PAT 没有「缓存的旧 scopes」可降，与 session 中间件**刻意不同**）。
- **迁移幂等**：`create table if not exists`；存量迁移 `on conflict do nothing`，可重跑。
- **用户体验不变**：**已发出的 token 必须继续有效**（哈希原样搬 ⇒ 验收硬指标）。
- 迁移编号：现有最大 `008` ⇒ 新迁移 **`009_*.sql`**。

---

## 文件结构

| 路径 | 职责 | 动作 |
|---|---|---|
| `docs/architecture.md` | §1.5 正典 | **已落**（PR #896 分支） |
| `apps/server/src/migrations/009_platform_api_key.sql` | 新表 `platform.api_key`（幂等 DDL + 索引） | 新 |
| `apps/server/src/api-key-store.ts` | 宿主 key-store：生成/哈希/建/列/吊销/解析/触碰（**唯一哈希实现**） | 新 |
| `apps/server/src/api-key-store.test.ts` | 单测（DB；含「只落哈希」「吊销即解析不到」） | 新 |
| `apps/server/src/pat-auth.ts` | `resolveKey` 注入源：模块端口 → 宿主函数；注释同步 | 改 |
| `apps/server/src/pat-auth.test.ts` | 注入形状基本不变（换成宿主函数）；补「表不可达 ⇒ 503」 | 改 |
| `apps/server/src/app.ts` | 第 247 行 `runtime.port('data','resolvePatKey')` → 宿主 store；第 241-245 注释同步 | 改 |
| `apps/server/src/routes/platform.ts`（或新文件 `api-keys.ts`） | 端点：个人 CRUD（会话身份，**免 scope**）；管理员视图（`tenant:admin`） | 改/新 |
| `apps/web/src/App.tsx` | 加**不套** AdminGate 的静态路由 `/console/me/keys`；`/console/admin/keys` 套 AdminGate | 改 |
| `apps/web/src/pages/me/Keys.tsx` / `pages/admin/Keys.tsx` | 两个页 | 新 |
| `apps/web/src/pages/console-menu.ts` | 菜单：个人项（免闸门）+ 管理组项 | 改 |
| `modules/data/index.ts` | 删 `createPorts` 整块 + `resolvePat/touchPatKey` import | 改 |
| `modules/data/domain/key-store.ts` | 删（哈希/生成已迁宿主） | 删 |
| `modules/data/routes/keys.ts` | 删 | 删 |
| `modules/data/manifest.yaml` | 删 `/keys` 三条声明（**与上面同提交**） | 改 |
| `modules/data/console/keys/index.tsx` | 删（页面移到宿主） | 删 |
| `scripts/migrate-pat-keys.mjs` | **存量迁移**（data → platform，幂等，打印条数） | 新 |
| `apps/server/src/data-query.e2e.test.ts` | 往返契约用例改语义（不再是「模块建 → 宿主端口认」） | 改 |

---

## 关键形状

```ts
// apps/server/src/api-key-store.ts —— 宿主侧，唯一哈希实现
export const PAT_PREFIX = 'dkq_'                       // 与旧 modules/data 同值；协议，不是重复
export function newPatToken(): string                  // dkq_ + randomBytes(32).base64url
export function hashPat(token: string): string         // sha256 hex（唯一一份）

export interface ResolvedPatKey { keyId: number; org: string; casdoorUser: string }
export function createPatKey(pool: Pool, org: string, casdoorUser: string, name: string): Promise<{ id: number; token: string }>
export function listPatKeys(pool: Pool, org: string, casdoorUser: string): Promise<PatKeyRow[]>
export function revokePatKey(pool: Pool, org: string, casdoorUser: string, id: number): Promise<number>
export function resolvePat(pool: Pool, token: string): Promise<ResolvedPatKey | null>   // where token_hash=$1 and revoked_at is null
export function touchPatKey(pool: Pool, org: string, id: number): Promise<void>
```

> ⚠️ `revokePatKey` **必须带 `casdoorUser`**——旧实现注释写明：不带就能吊销别人的 key。
> `resolvePat` 返回值形状与 SDK 的 `ResolvedPatKey`（`packages/platform-sdk/src/module.ts:111-117`）**同形**，`pat-auth.ts` 无需改类型。

```sql
-- apps/server/src/migrations/009_platform_api_key.sql（照 data.query_keys DDL 搬，隔离键改 org）
create table if not exists platform.api_key (
  id           bigserial   primary key,
  org          text        not null,           -- = tenant.casdoor_org（pat-auth 直接比它）
  casdoor_user text        not null,           -- Casdoor 用户名（不是 sub）
  name         text        not null,
  token_hash   text        not null unique,    -- sha256 hex
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists platform_api_key_org_user_idx on platform.api_key (org, casdoor_user);
```

---

## 任务分解

### Task 1：计划落档（本文件）

- [x] **Step 1:** §1.5 正典已落（本分支，PR #896）。
- [ ] **Step 2:** 本计划同 PR 提交，待人审。**人审通过前不动码**（架构先行）。

### Task 2：迁移 `009_platform_api_key.sql`

- [ ] **Step 1:** 按上面 DDL 写迁移（幂等、`org text not null`、`token_hash unique`、`(org, casdoor_user)` 索引）。
- [ ] **Step 2:** 跑 `pnpm exec tsx scripts/lint-architecture.mjs`（宿主迁移只碰 `platform` ⇒ 应绿）。
- [ ] **Step 3:** 起本机 PG 跑一遍宿主迁移（`apps/server` 启动即跑），断言表与索引存在（照 `modules/data/module.test.ts:63-85` 查 `pg_indexes` 的形状写宿主版）。
- [ ] **Step 4:** Commit：`feat(platform): 迁移 009——platform.api_key（PAT 密钥表上移宿主）`

### Task 3：宿主 key-store + 单测

- [ ] **Step 1:** 写 `apps/server/src/api-key-store.ts`（照 `modules/data/domain/key-store.ts:29-105` 的四处 SQL **搬实现、不搬文件**）。
- [ ] **Step 2:** 单测（DB，`describePg`）：① `newPatToken` 形状（`dkq_` 前缀 + 每次不同）② `hashPat` = sha256 hex ③ 建 key **只落哈希**（库里查不到明文）④ `resolvePat` 命中 / 未知 token 返 null ⑤ **吊销后解析不到** ⑥ `touchPatKey` 改 `last_used_at`。
- [ ] **Step 3:** Run：`pnpm --filter @platform/server test`。Expected: PASS。
- [ ] **Step 4:** Commit：`feat(platform): 宿主 key-store（唯一哈希实现）`

### Task 4：`pat-auth.ts` 换注入源 + 测试改造

- [ ] **Step 1:** `app.ts:247` 的 `resolveKey: runtime.port('data','resolvePatKey')` 换成宿主 store 的绑定（如 `resolveKey: (t) => resolvePat(pool, t).then(r => { if (r) void touchPatKey(pool, r.org, r.keyId).catch(()=>{}); return r })`——**把旧的 fire-and-forget 触碰语义一并搬过来**，否则 `last_used_at` 会静默失效）。
- [ ] **Step 2:** `pat-auth.ts` 的**注释**同步（文件头 1-13 行那段「走模块端口」的理由已过时；`resolveKey` 缺失 ⇒ 503 那条改为「宿主 store 未装配」的兜底，或按实际装配方式删）。
- [ ] **Step 3:** `pat-auth.test.ts`：`resolveKey` 注入形状**可原样保留**（注入源换了不影响测试）；**新增**一条：宿主 store 抛错 ⇒ `503 PAT_UNAVAILABLE`。
- [ ] **Step 4:** Run：`pnpm --filter @platform/server test`。Expected: PASS（全部旧断言仍绿——**这是「行为不变」的证据**）。
- [ ] **Step 5:** Commit：`refactor(platform): PAT 解析源由模块端口改宿主 key-store（行为不变）`

### Task 5：宿主端点（个人 CRUD + 管理员视图）

- [ ] **Step 1:** 在宿主路由（`apps/server/src/routes/`）加：
  - `GET/POST/DELETE /api/platform/keys[/:id]`——**会话身份，免 scope**（个人页）；归属钉死 `session.userId` + `tenant.casdoor_org`。
  - `GET /api/platform/keys?all=1`（或独立路径）——`tenant:admin`：看/吊销**全租户**的 key。
- [ ] **Step 2:** 归属校验照 `modules/data/routes/keys.ts:5-7,18-22` 的形状（主体只来自身份，绝不读请求）。
- [ ] **Step 3:** 测试：免 scope 端点对普通登录账号 200；管理员端点对无 `tenant:admin` 者 403；**跨租户负对照**（A 租户的 key 在 B 租户的视图里不出现）。
- [ ] **Step 4:** Commit：`feat(platform): 个人 Key 端点（个人免 scope + 管理员 tenant:admin）`

### Task 6：`modules/data` 退役（**一个提交内同删两侧**）

- [ ] **Step 1:** 删 `createPorts`（`modules/data/index.ts:46-56`）+ 相关 import（第 13 行）。
- [ ] **Step 2:** 删 `modules/data/routes/keys.ts` 与 `modules/data/index.ts:33` 的 `registerKeys` 调用。
- [ ] **Step 3:** **同一提交**删 `modules/data/manifest.yaml:69-71` 的三条 `/keys` 声明（否则装载期双向核对失败）。
- [ ] **Step 4:** 删 `modules/data/domain/key-store.ts`、`modules/data/console/keys/`、`modules/data/domain/key-store.test.ts`、`modules/data/routes/keys.test.ts`。
- [ ] **Step 5:** 跑 `check-manifests` + `lint-architecture` + `check-tenant-isolation`（`data.query_keys` 表**暂不删**，见 Task 8）。Expected: 全绿。
- [ ] **Step 6:** Commit：`refactor(data): 退役 PAT 端口与 key 管理（已上移宿主）`

### Task 7：宿主控制台两页

- [ ] **Step 1:** `apps/web/src/App.tsx` 加**不套 `AdminGate`** 的静态路由 `/console/me/keys`（放在 `admin/*` 与通配之前；react-router v6 静态段优先）。
- [ ] **Step 2:** `apps/web/src/pages/me/Keys.tsx`——照 `modules/data/console/keys/index.tsx` 的 UI（生成/列表/吊销；明文 token **只显示一次**，刷新即失）。
- [ ] **Step 3:** `pages/admin/Keys.tsx` + `App.tsx` 的 `<AdminGate>` 包裹（照 `admin/storage` 形状，`App.tsx:28-34`）。
- [ ] **Step 4:** `console-menu.ts`（`106-123`）加**不受 `TENANT_ADMIN_SCOPE` 闸门**的个人项；管理组加「Key 管理」。
- [ ] **Step 5:** `gen-console-registry` 不受影响（本地页不走 registry）——跑一遍确认无 diff。
- [ ] **Step 6:** **UI 自验**（纪律）：起 `pnpm dev:stack`，用无 `tenant:admin` 的账号走个人页（生成 → 复制 token → 吊销），再用管理员账号看管理页。**取证走文本**（本机模型不能吃图时用 playwright 取 DOM 文本，见 WeKnora 条目）。
- [ ] **Step 7:** Commit：`feat(web): 个人 Key 页（免 scope）+ 管理页（tenant:admin）`

### Task 8：存量迁移脚本（**B1 决定它必须走 `scripts/`**）

- [ ] **Step 1:** 写 `scripts/migrate-pat-keys.mjs`：读 `data.query_keys` → `insert into platform.api_key ... on conflict (token_hash) do nothing`；**幂等**；打印 `moved / skipped / total`。
- [ ] **Step 2:** **先实测存量行数**（文档里没有任何数量估计，不能引用）：`select count(*) from data.query_keys`（本机 dev 库 + 生产库各一次，记录到交付记录）。
- [ ] **Step 3:** 本机跑一遍，断言：迁移后**旧 token 仍可用**（拿一条旧 token 打 `/api/modules/*` ⇒ 200）——**这是「用户体验不变」的硬验收**。
- [ ] **Step 4:** **不删旧表**（expand-contract）：`data.query_keys` 留待观察一个发布周期后再删（另开 issue）。
- [ ] **Step 5:** Commit：`chore(platform): 存量 PAT key 迁移脚本（data.query_keys → platform.api_key）`

### Task 9：契约测试改语义 + 全量门禁

- [ ] **Step 1:** `apps/server/src/data-query.e2e.test.ts:230-241` 的「PAT 往返契约：模块路由建的 key，宿主中间件（经模块端口）认下来」**语义已变**——改为「宿主端点建的 key，宿主中间件认下来」；**保留这条用例**（它仍是唯一能抓「建/认两侧装配错位」的测试，只是两侧都在宿主了）。
- [ ] **Step 2:** 全量门禁：`unit` / `gates`（含 `lint-architecture`、`check-manifests`、`check-tenant-isolation`）/ `web` / `smoke`。
- [ ] **Step 3:** Commit：`test(platform): PAT 往返契约改为主宿主两侧`

### Task 10：验收（负对照，写进 PR）

- [ ] **Step 1:** 逐条跑并记录：
  - ① **已发 token 仍有效**（存量迁移后，用旧 token ⇒ 200）
  - ② **个人页免 scope**：无任何 `tenant:admin` 的账号能生成并用自己的 token
  - ③ **管理页 fail-closed**：无 `tenant:admin` ⇒ 403
  - ④ **跨租户**：A 租户的 token 打 B 租户 ⇒ 401 `INVALID_KEY`（同码不泄露存在性）
  - ⑤ **吊销即时生效**：吊销后立刻用同一 token ⇒ 401
  - ⑥ **Casdoor 故障 ⇒ 503**（不降级）
- [ ] **Step 2:** PR body 写清「哪些是实测、哪些未验」。

---

## Self-Review（对照 #894 范围核）

- 「迁移 `platform.api_key` + 存量迁移」→ Task 2 + Task 8 ✓
- 「`pat-auth.ts` 改直查；退役端口与 key-store」→ Task 3/4/6 ✓
- 「平台级 console 页（个人 + 管理两档）」→ Task 7 ✓
- 「正典更新」→ 已在 §1.5（Task 1）✓
- **缺口自陈**：① **旧表何时删**未定（Task 8 Step 4 记了 expand-contract，但删除时点需人定）；② **存量规模未知**（Task 8 Step 2 要求实测，不引用文档）；③ 个人页在宿主壳是**首例**（无先例可照抄，Task 7 是最小改动路径，实施时若发现壳结构不允许，回到人处确认）。
