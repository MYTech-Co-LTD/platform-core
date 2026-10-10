# 售后账户体系统一 Phase 1（公众号账户化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地设计稿 `docs/superpowers/specs/2026-10-10-aftersales-account-unification-design.md` 的 Phase 1：`platform.identity_link` 绑定表、公众号登录两态 session、申请时自动匹配、管理面绑定修正、存量回填。

**Architecture:** 混合方案——人是 Casdoor 的人（本 Phase 只建草稿/绑定，不配角色），微信号是 platform 本地标签（`identity_link` 单行可变 + audit 留痕）。公众号 callback 按 active link 分流两态 session（中间态现状不动；正式态 `sub`=openid + 新载荷字段 `acct`/`ext`，校验走 Casdoor 同款降级）。模块经宿主注入的 `IdentityLinks` 服务消费绑定能力（storage 注入同款先例），manifest↔路由原子。

**Tech Stack:** Hono + pg + jose（宿主）；vitest（真 pg，`DATABASE_URL` 本地 docker platform-pg）；antd console（模块管理页）；Vue3 userApp。

## Global Constraints

- **分支纪律**：从本 worktree 分支 `ylwzzs/账户体系的问题` 继续；提交 Conventional Commits、**一个提交一个 scope**；PR 开启时 body 带 `Closes #N`（#N = 先建的真 issue，见 Task 12）。
- **测试**：真 pg 测试需要 `DATABASE_URL`（本地 docker platform-pg）；跑法 `pnpm --filter @platform/server test`（vitest `fileParallelism: false` 已配）。测试替身形状**必须与真机一致**（AGENTS 硬约束 #11）：Casdoor 替身响应形状照 `packages/auth-core/src/casdoor-client.ts` 实测形状。
- **B1 边界**：宿主**运行时**代码零触碰 `aftersales` schema；`scripts/` 一次性迁移脚本**允许**读模块 schema（迁移性质，与 M2b 同先例），运行时路由绝不读。
- **桶文件纪律**（#44）：`export {}` 值清单**绝不混入 interface/type**；类型一律 `export type`。auth-core/sdk 改导出后跑桶文件护栏测试。
- **manifest↔路由原子**（AGENTS 硬约束 #2）：新增端点必须同一提交里同时改 `manifest.yaml` 与路由注册，任一方向差集 = 装载失败。
- **敏感值**：脚本/日志**不打印完整手机号**（掩码规则：前 3 后 2，中间 `****`）；不写任何密钥明文。
- **执行环境注意**：本 worktree 路径含中文（`账户体系的问题`）。`runMigrations` 已修 fileURLToPath（#203）不受影响，但 **vitest 若出现 path/ENOENT 类怪错，换 ASCII 命名工作树执行**（历史实测：中文路径会打挂 vite 系测试）。
- **设计稿为准**：身份模型以设计稿 §1-§4 为准；本计划 Task 1 会把 §3.1 的 sub 语义**修订**为「sub 仍 = openid + 新增 `acct` 字段」（修订理由见 Task 1，写进设计稿留档）。

## File Structure（本计划新建/修改的全部文件）

```
apps/server/src/migrations/008_identity_link.sql        新建  绑定表 DDL
apps/server/src/identity-links.ts                       新建  link store + normalizePhone + matchOnApplication（宿主侧唯一事实源）
apps/server/src/identity-links.test.ts                  新建  真 pg 单测
apps/server/src/routes/auth-wechat-oa.ts                修改  callback 两态分流
apps/server/src/routes/auth-wechat-oa.test.ts           修改  两态用例
apps/server/src/session-middleware.ts                   修改  正式态分支 + Identity 填充
apps/server/src/session-middleware-account.test.ts      新建  正式态中间件用例
packages/auth-core/src/session.ts                       修改  SessionPayload acct/ext
packages/auth-core/src/session.test.ts                  修改  签发/验签往返用例
packages/platform-sdk/src/module.ts                     修改  Identity +bound fields；IdentityLinks 接口
apps/server/src/loader.ts                               修改  构造并注入 IdentityLinks 进 ModuleContext
modules/aftersales/index.ts                             修改  ctx.identityLinks → RouteCtx
modules/aftersales/routes/context.ts                    修改  RouteCtx +identityLinks；guestIdentityIds helper
modules/aftersales/routes/registration-guest.ts         修改  申请钩子 + me/identity/dispute + me/registration 扩展
modules/aftersales/routes/links-manage.ts               新建  管理面绑定端点 ×4
modules/aftersales/routes/links-manage.test.ts          新建
modules/aftersales/manifest.yaml                        修改  +5 端点声明（与路由同一提交）
modules/aftersales/routes/ticket-guest.ts               修改  多绑收窄（4 端点）
modules/aftersales/routes/attachment.ts                 修改  多绑收窄（1 端点）
modules/aftersales/console/index.tsx                    修改  +身份绑定 tab
modules/aftersales/console/links/index.tsx(+.test.tsx)  新建  绑定管理页
modules/aftersales/mobile/src/pages/storeEmployeeApproval.vue      修改  绑定身份展示+异议按钮
modules/aftersales/mobile/src/composables/useStoreEmployeeApproval.ts 修改
modules/aftersales/mobile/src/shims/wuji-data.ts        修改  +dispute API
scripts/audit-employee-phones.mjs(+.test.ts)            新建  前置摸底（只读）
scripts/backfill-identity-links.mjs(+.test.ts)          新建  存量回填
docs/superpowers/specs/2026-09-15-aftersales-module-design.md     修改  §1.3 取代指针
docs/superpowers/specs/2026-10-10-aftersales-account-unification-design.md 修改  §2 分期注记 + §3.1 sub 修订
docs/module-protocol.md                                 修改  guest 条文补中间态限定
```

---

### Task 1: 正典订正（先改文档再动码）

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-aftersales-account-unification-design.md`
- Modify: `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`
- Modify: `docs/module-protocol.md`

**Interfaces:** 无代码接口；后续所有任务以修订后的设计稿为准。

- [ ] **Step 1: 设计稿 §3.1 修订（sub 语义）+ §2 分期注记**

§3.1 表格「正式态」行的 sub 列改为 `openid（不变）`，并在 §3.1 末尾追加：

```markdown
> **修订（2026-10-10，计划期）：正式态 sub 仍 = openid**，账户身份经**新增载荷字段
> `acct`**（= casdoor_name）承载，`name` = casdoor_name。原「sub = casdoor_name 与内部
> session 同构」作废。理由：业务表身份锚是 openid（渠道事实），sub 若换成 casdoor_name，
> 全部 guest 写路径（submitter_openid = identity.userId 共 9 端点）都要改从新字段取登录
> openid，还要为「哪个 openid 登录的」再引入一个字段——同构收益只惠及展示，代价横贯写面。
> 中间态/正式态判定键 = `authVia==='wechat-oa' && acct 存在`。
```

§2 自动匹配段落末尾追加：

```markdown
> **分期注记（2026-10-10，计划期）**：Phase 1 自动匹配置信池 = `identity_link.phone`
> （**本地**，含回填的存量）；Casdoor 侧按手机号查户（覆盖总部员工兼门店场景）归 Phase 2
> ——真机 API 形状未钉（AGENTS #11），不进 P1。
```

- [ ] **Step 2: 旧正典加取代指针**

`2026-09-15-aftersales-module-design.md` §1.3 标题下插入一行：

```markdown
> ⚠️ **本节身份模型已被 2026-10-10 账户统一设计取代**（门店员工建 Casdoor 账户 + 本地绑定表），
> 访客 session 降级为中间态：见 `2026-10-10-aftersales-account-unification-design.md`。下文保留原文存档。
```

- [ ] **Step 3: module-protocol.md guest 条文补中间态限定**

`docs/module-protocol.md` §175-178 段落末尾追加：

```markdown
> **2026-10-10 修订**：`guest:{scope}` 发放的是**中间态**访客 session（绑定生效前）；绑定
> active 后签**正式态** session（scopes 走 Casdoor 角色）。两态发放同一批码，模块端点与
> 门卫对身份形态无感。详见 `2026-10-10-aftersales-account-unification-design.md` §3。
```

- [ ] **Step 4: 提交**

```bash
git add docs/
git commit -m "docs(aftersales): 账户统一正典订正——两态 session 语义、guest 条文中间态限定、旧正典取代指针"
```

---

### Task 2: 迁移 008 + identity_link store

**Files:**
- Create: `apps/server/src/migrations/008_identity_link.sql`
- Create: `apps/server/src/identity-links.ts`
- Test: `apps/server/src/identity-links.test.ts`

**Interfaces (Produces，后续任务逐字消费):**

```ts
// apps/server/src/identity-links.ts
export type LinkProvider = 'wechat-oa' | 'wecom'
export type LinkStatus = 'pending' | 'active' | 'revoked' | 'disputed'
export interface IdentityLinkRow {
  id: number; org: string; provider: LinkProvider; externalId: string
  casdoorName: string; status: LinkStatus
  phone: string | null; boundVia: 'auto' | 'manual' | null
  sourceApprovalId: number | null
}
export function normalizePhone(raw: string): string | null
//   规则：取数字；11 位且 86 开头去 86；恰好 11 位返回，否则 null（座机/乱码不匹配）
export async function findLinkByExternal(pool: Pool, org: string, provider: LinkProvider, externalId: string): Promise<IdentityLinkRow | null>
export async function findActiveLink(pool: Pool, org: string, externalId: string): Promise<{ casdoorName: string } | null>
//   provider 不限（任一渠道 active 即正式态）；status='active' 才命中
export async function listActiveExternalIds(pool: Pool, org: string, casdoorName: string): Promise<string[]>
export async function listCandidatesByPhone(pool: Pool, org: string, phone: string): Promise<string[]>
//   distinct casdoor_name、status='active'、跨 provider
export async function upsertLink(pool: Pool, p: { org: string; provider: LinkProvider; externalId: string; casdoorName: string; phone: string | null; boundVia: 'auto' | 'manual' | null; status: LinkStatus; sourceApprovalId: number | null }): Promise<IdentityLinkRow>
//   insert .. on conflict (provider, org, external_id) do update set ...（单行可变，历史进 audit）
export async function mutateLink(pool: Pool, org: string, id: number, patch: { status?: LinkStatus; casdoorName?: string; revokedBy?: string }): Promise<IdentityLinkRow | null>
```

- [ ] **Step 1: 写迁移 DDL**

`apps/server/src/migrations/008_identity_link.sql`：

```sql
-- 008_identity_link.sql — 微信/企微身份绑定表（账户统一设计 §1.2）。
-- 单行可变：一个 (provider, org, external_id) 永远一行，换绑/解绑原地改 status，
-- 历史走 platform.audit（action='identity.link.*'），不靠多行。
create table if not exists platform.identity_link(
  id bigserial primary key,
  org text not null,
  provider text not null check (provider in ('wechat-oa','wecom')),
  external_id text not null,
  casdoor_name text not null,
  status text not null default 'pending' check (status in ('pending','active','revoked','disputed')),
  phone text,
  bound_via text check (bound_via in ('auto','manual')),
  source_approval_id bigint,
  disputed_at timestamptz,
  bound_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now()
);
create unique index if not exists identity_link_external_uq
  on platform.identity_link(provider, org, external_id);
create index if not exists identity_link_account_idx
  on platform.identity_link(org, casdoor_name);
create index if not exists identity_link_phone_idx
  on platform.identity_link(org, phone) where status = 'active';
```

- [ ] **Step 2: 写失败测试**

`apps/server/src/identity-links.test.ts`（基建照抄 `auth-wechat-oa.test.ts` 头部：真 pg + `runMigrations(pool,'platform',…)` + 无 DATABASE_URL 则 `describe.skip`）：

```ts
// 核心用例（节选形状；完整按此模式展开）
it('normalizePhone：86 前缀去之、非 11 位返 null', () => {
  expect(normalizePhone('13800001111')).toBe('13800001111')
  expect(normalizePhone('+86 138-0000-1111')).toBe('13800001111')
  expect(normalizePhone('010-1234')).toBeNull()
})
it('upsertLink 冲突时原地更新（单行可变）', async () => {
  await upsertLink(pool, { org: 'o1', provider: 'wechat-oa', externalId: 'oA', casdoorName: 'u1', phone: '13800001111', boundVia: 'auto', status: 'active', sourceApprovalId: 7 })
  await upsertLink(pool, { org: 'o1', provider: 'wechat-oa', externalId: 'oA', casdoorName: 'u2', phone: '13800001111', boundVia: 'manual', status: 'pending', sourceApprovalId: 8 })
  const row = await findLinkByExternal(pool, 'o1', 'wechat-oa', 'oA')
  expect(row?.casdoorName).toBe('u2'); expect(row?.id).toBeDefined()
})
it('findActiveLink 跨 provider 命中且只认 active', async () => {
  // wecom 行 active + wechat-oa 行 pending ⇒ findActiveLink(org,'oB') 命中 wecom 的账户
})
it('listCandidatesByPhone 只数 active、跨 provider 去重', async () => { /* … */ })
it('mutateLink revoke 记 revoked_by/at；他 org 的 id 取不到（null）', async () => { /* … */ })
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @platform/server test -- identity-links`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 store（SQL 全部参数化，语句直白）**

`apps/server/src/identity-links.ts` 骨架：

```ts
// identity-links.ts — platform.identity_link 的宿主侧唯一读写层（设计稿 §1.2）。
// B1：本文件属宿主，只碰 platform schema；aftersales 数据由调用方作为入参传入。
import type { Pool } from 'pg'

export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2)
  return d.length === 11 ? d : null
}
const ROW = 'id, org, provider, external_id AS "externalId", casdoor_name AS "casdoorName", status, phone, bound_via AS "boundVia", source_approval_id AS "sourceApprovalId"'
// findActiveLink：select … where org=$1 and status='active' limit 1（provider 不限）
// listCandidatesByPhone：select distinct casdoor_name … where org=$1 and phone=$2 and status='active'
// upsertLink：insert … on conflict (provider, org, external_id) do update set
//   casdoor_name=excluded.casdoor_name, phone=excluded.phone, bound_via=excluded.bound_via,
//   status=excluded.status, source_approval_id=excluded.source_approval_id,
//   bound_at = case when excluded.status='active' then now() else bound_at end … returning <ROW>
// mutateLink：update … set（status/revoked_at/revoked_by 按 patch 组装）where id=$2 and org=$1 returning <ROW>
```

- [ ] **Step 5: 跑测试通过**

Run: `pnpm --filter @platform/server test -- identity-links`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/migrations/008_identity_link.sql apps/server/src/identity-links.ts apps/server/src/identity-links.test.ts
git commit -m "feat(server): identity_link 绑定表与宿主侧读写层——单行可变+audit 留痕的存储契约"
```

---

### Task 3: SessionPayload 增 acct/ext

**Files:**
- Modify: `packages/auth-core/src/session.ts:14-25,37-54,60-78`
- Test: `packages/auth-core/src/session.test.ts`（不存在则新建）

**Interfaces (Produces):** `SessionPayload.acct?: string`、`SessionPayload.ext?: string[]`；`signSession`/`verifySession` 对两字段往返保真；**不设字段的会话签出的 token 与改动前逐字节兼容**（老 token 可验）。

- [ ] **Step 1: 写失败测试（往返 + 兼容）**

```ts
it('acct/ext 往返保真', async () => {
  const token = await signSession({ sub: 'oA', org: 'org1', name: 'u1', scopes: ['aftersales:guest'], authVia: 'wechat-oa', acct: 'u1', ext: ['oA', 'oB'] }, SECRET, 1000)
  const p = await verifySession(token, SECRET)
  expect(p?.acct).toBe('u1'); expect(p?.ext).toEqual(['oA', 'oB'])
})
it('不设 acct/ext：验签得到 undefined，与旧 token 形状一致', async () => {
  const token = await signSession({ sub: 'n1', org: 'org1', name: 'n1', scopes: [], authVia: 'password' }, SECRET, 1000)
  const p = await verifySession(token, SECRET)
  expect(p?.acct).toBeUndefined(); expect(p?.ext).toBeUndefined()
})
```

- [ ] **Step 2: 跑失败** — `pnpm --filter @platform/auth-core test`（EXPECTED: FAIL）

- [ ] **Step 3: 实现** — `session.ts`：接口加两个可选字段；`signSession` 的 claims **条件写入**（`if (p.acct !== undefined) claims.acct = p.acct`、`if (p.ext !== undefined) claims.ext = p.ext`——不设字段的 token 载荷与改动前完全一致）；`verifySession` 回读 `acct: claims.acct === undefined ? undefined : String(claims.acct)`、`ext: Array.isArray(claims.ext) ? claims.ext.map(String) : undefined`。

- [ ] **Step 4: 跑通过 + 桶文件护栏** — `pnpm --filter @platform/auth-core test && pnpm test:guard`（EXPECTED: PASS；本任务无新增导出值，护栏应绿）

- [ ] **Step 5: 提交**

```bash
git add packages/auth-core/src/session.ts packages/auth-core/src/session.test.ts
git commit -m "feat(auth-core): session 载荷增 acct/ext——正式态账户身份与绑定集合（可选字段，旧 token 兼容）"
```

---

### Task 4: callback 两态分流

**Files:**
- Modify: `apps/server/src/routes/auth-wechat-oa.ts`（deps 接口 :56-70、签 session 段 :231-248、头注 :1-35）
- Test: `apps/server/src/routes/auth-wechat-oa.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 `findActiveLink`/`listActiveExternalIds`、Task 3 `acct/ext`、既有 `CasdoorFactory`（`session-middleware.ts:49`）、`effectiveScopes`（auth-core）。
- Produces: `WechatOaRoutesDeps` 增三个必填成员：

```ts
casdoor: CasdoorFactory
findActiveLink: (org: string, externalId: string) => Promise<{ casdoorName: string } | null>
listActiveExternalIds: (org: string, casdoorName: string) => Promise<string[]>
```

**分流语义（写进实现注释）：** 拿到 openid 后——
1. `findActiveLink` 抛错（DB 故障）⇒ 500 裸露、未发 cookie（与既有 scopes 取数同姿态，fail-loudly）；
2. active link 且 `casdoor.getUser(acct)` 正常 ⇒ **正式态**：`payload = { sub: openid, org, name: acct, scopes: effectiveScopes(acct, user.roles ?? [], perms), authVia: 'wechat-oa', acct, ext: [openid, …其他 active 绑定] }`；audit `login.ok` detail `{ via:'wechat-oa', acct }`（actor 仍 openid，保持审计键连续）；
3. link 存在但 getUser **返 null**（悬空）或 **抛错**（Casdoor 不可达）⇒ 降级**中间态**照常发会话 + audit `login.ok` detail `{ via:'wechat-oa', degraded:'dangling'|'casdoor-down', acct }`——登录路不因上游读故障阻塞（设计稿 §3.3：写操作才 fail-loudly）；
4. 无 active link ⇒ 中间态，**现状代码一字不改**。

- [ ] **Step 1: 追加失败用例**（假 Casdoor 工厂形状照 casdoor-client 实测：`getUser` 返 `{ roles: ['…'] }` 或 `null`，`getPermissions` 返 `[{users:[…],roles:[…],resources:[…]}}]` 形状数组）：

```ts
// 用例组：link 表插入用 Task 2 的 upsertLink 直塞
it('正式态：active link + Casdoor 有户 ⇒ token 带 acct/ext，scopes=Casdoor 有效码', …)
it('正式态：绑定集合含本 openid 之外的其他渠道绑定（wecom 行）', …)
it('降级：link 悬空（getUser=null）⇒ 中间态 token（无 acct）+ audit degraded=dangling', …)
it('降级：Casdoor 抛错 ⇒ 中间态 token + audit degraded=casdoor-down', …)
it('中间态：无 link ⇒ 与现状完全同形（既有用例回归）', …)
```

- [ ] **Step 2: 跑失败**（deps 新必填导致 makeApp 编译/断言失败）
- [ ] **Step 3: 实现**——`/callback` 在 `openid === null` 分支之后插入分流块（上方语义 1-4）；deps 三成员注入；头注 :1-14 的「不落 Casdoor 账号」表述改为两态口径（保留 OA_ANON_ACTOR 注释原样）。
- [ ] **Step 4: 全量跑** `pnpm --filter @platform/server test -- auth-wechat-oa`（既有用例必须全绿——中间态回归是本任务红线）
- [ ] **Step 5: 提交**

```bash
git add apps/server/src/routes/auth-wechat-oa.ts apps/server/src/routes/auth-wechat-oa.test.ts
git commit -m "feat(auth): 公众号 callback 两态分流——active link 签正式态(acct/ext)，悬空/故障降级中间态"
```

---

### Task 5: middleware 正式态分支 + Identity 扩展

**Files:**
- Modify: `apps/server/src/session-middleware.ts`（deps :51-76、刷新分支 :164-202、toIdentity :113-122）
- Modify: `packages/platform-sdk/src/module.ts`（`Identity` 接口 + 两个可选字段）
- Test: Create `apps/server/src/session-middleware-account.test.ts`

**Interfaces:**
- `SessionMiddlewareDeps` 增 `boundExternalIds?: (org: string, casdoorName: string) => Promise<string[]>`
- `Identity` 增 `accountName?: string`、`boundExternalIds?: string[]`（`toIdentity`：`accountName: p.acct`、`boundExternalIds: p.ext`——不设即 undefined，内部/中间态会话形状不变）

- [ ] **Step 1: 写失败用例**（新文件，签好 acct token 直接打中间件，或走 `makeApp`）：

```ts
it('正式态刷新：getUser 正常 ⇒ scopes=Casdoor 有效码、ext 重算重签', …)
it('正式态：getUser=null ⇒ 清会话（与内部路同唯一清会话分支）', …)
it('正式态：Casdoor 抛错 ⇒ 降级旧 scopes 不重签 + warn（复用现有窗口断言形状）', …)
it('正式态：boundExternalIds 抛错 ⇒ scopes 照刷、ext 沿用旧值', …)
it('中间态（无 acct）不触 Casdoor：neverCasdoor 工厂下刷新照常', …)
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**——`wantRefresh` 内分支改三路：`p.authVia==='wechat-oa' && p.acct` → 新账户分支（结构照抄内部分支 :182-201，`getUser(p.acct)`、`effectiveScopes(p.acct, …)`、ext 重算独立 try/catch）；`p.authVia==='wechat-oa'` → 既有访客分支原样；其余 → 内部分支原样。重签段 `fresh` 补 `ext`（重算成功才换新，失败沿用 `p.ext`）。
- [ ] **Step 4: 全量跑** `pnpm --filter @platform/server test`（auth.test.ts 既有降级/访客用例回归红线）
- [ ] **Step 5: 提交**

```bash
git add apps/server/src/session-middleware.ts apps/server/src/session-middleware-account.test.ts packages/platform-sdk/src/module.ts
git commit -m "feat(server): session 中间件正式态分支——账户会话校验同构内部路+绑定集合刷新"
```

---

### Task 6: matchOnApplication + IdentityLinks 服务类型

**Files:**
- Modify: `apps/server/src/identity-links.ts`（追加 `matchOnApplication` 与宿主实现工厂）
- Modify: `packages/platform-sdk/src/module.ts`（新增 `IdentityLinkView`/`IdentityLinks` **类型**导出，`export type` 纪律）
- Test: `apps/server/src/identity-links.test.ts`（追加）

**Interfaces (Produces，SDK 逐字):**

```ts
// packages/platform-sdk/src/module.ts 追加（类型 only，export type）
export type LinkProvider = 'wechat-oa' | 'wecom'
export interface IdentityLinkView {
  id: number; provider: LinkProvider; externalId: string; casdoorName: string
  status: 'pending' | 'active' | 'revoked' | 'disputed'
  phoneMasked: string | null; boundVia: 'auto' | 'manual' | null; createdAt: string
}
/** 宿主注入模块的绑定能力（ctx.identityLinks；未注入 = 旧宿主，模块须容忍 undefined） */
export interface IdentityLinks {
  /** 申请提交时的自动匹配（设计稿 §2）：返回终态供模块透出 */
  matchOnApplication(input: { org: string; provider: LinkProvider; externalId: string; phone: string; approvalId: number | null }):
    Promise<{ state: 'active' | 'multi' | 'draft'; candidates?: string[] }>
  describeOwn(org: string, externalId: string): Promise<IdentityLinkView | null>
  listForOrg(org: string, status?: IdentityLinkView['status']): Promise<IdentityLinkView[]>
  confirm(org: string, id: number, casdoorName?: string): Promise<void>
  rebind(org: string, id: number, casdoorName: string): Promise<void>
  revoke(org: string, id: number, by: string): Promise<void>
  dispute(org: string, externalId: string): Promise<boolean>
}
```

- [ ] **Step 1: 失败用例**（真 pg + 假 casdoorFor：`ensureUser` 记录调用、`getUser` 返 `{ roles: [] }`）：

```ts
it('唯一命中 ⇒ active+bound_via=auto，返回 {state:"active"}', …)
it('多命中 ⇒ pending + 返回 candidates（不绑）', …)
it('未命中 ⇒ ensureUser(externalId) 建草稿 + pending，返回 {state:"draft"}', …)
it('已 active 的 openid 重复提交申请 ⇒ 幂等返回 {state:"active"}，不改行', …)
it('手机号无效 ⇒ 与未命中同族（draft+pending），phone 落 null', …)
it('confirm/rebind/revoke/dispute 的状态机与 audit 落行（action=identity.link.*)', …)
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**——`matchOnApplication` 按设计稿 §2 流程图（先查 existing → active 幂等返；phone 规整无效/0 命中 ⇒ ensureUser 草稿+pending；1 命中 ⇒ active；多命中 ⇒ pending+candidates）。confirm/rebind 前 `casdoorFor(org).getUser(name)` 验户存在（null ⇒ 抛 `LINK_TARGET_MISSING`，handler 映 400）。所有 mutate 落 `platform.audit`（`action:'identity.link.confirm'|'…rebind'|'…revoke'|'…dispute'`，detail 带 id/from/to/actor）。**audit 插入与状态变更同一事务**。
- [ ] **Step 4: 跑通过** → **Step 5: 提交**

```bash
git add apps/server/src/identity-links.ts apps/server/src/identity-links.test.ts packages/platform-sdk/src/module.ts
git commit -m "feat(server): matchOnApplication 自动匹配与 IdentityLinks 服务——唯一命中即绑/多命中转人工/未命中建草稿"
```

---

### Task 7: 注入模块上下文 + 申请钩子

**Files:**
- Modify: `apps/server/src/loader.ts`（createRouter ctx 构造处，:353-361 附近）
- Modify: `packages/platform-sdk/src/module.ts:20-22`（`ModuleContext` 增 `identityLinks?: IdentityLinks`）
- Modify: `modules/aftersales/index.ts`（ctx → RouteCtx 透传）
- Modify: `modules/aftersales/routes/context.ts:26-28`（`RouteCtx` 增 `identityLinks?: IdentityLinks`）
- Modify: `modules/aftersales/routes/registration-guest.ts:65-94`（申请钩子）
- Test: Modify `modules/aftersales/routes/registration-guest.test.ts`（追加）

**注入形状（storage 同款思想，注册期注入）**：loader 构造实现对象（闭包持 pool + casdoor 工厂，方法签名即 SDK `IdentityLinks`），放进传给 `def.createRouter(ctx)` 的 ctx；模块 index.ts 把它透传进各域 `RouteCtx`；模块代码只调接口、**必须容忍 undefined**（旧宿主/单测）。

- [ ] **Step 1: 失败用例**（registration-guest.test.ts，ctx.identityLinks 注 stub）：

```ts
it('提交申请后调 matchOnApplication，phone/new_info 原样透传、approvalId 带回', …)
it('identityLinks 缺省（undefined）⇒ 照旧 201，不抛（向后兼容）', …)
it('matchOnApplication 抛错 ⇒ 500 且申请已落库（匹配失败不回滚申请）', …)
```

- [ ] **Step 2: 跑失败** → **Step 3: 实现**——`POST /guest/employee-approvals` 在 insert 返回 `id` 后、`c.json(…, 201)` 前插：

```ts
if (ctx.identityLinks) {
  await ctx.identityLinks.matchOnApplication({
    org, provider: 'wechat-oa', externalId: openid,
    phone: body.phone, approvalId: id,
  })
}
```

（匹配失败抛错 ⇒ 500 裸露：申请已落库、用户重试会 409 pending 防重——audit 有痕，管理员可从 pending 队列补绑；此取舍写进注释。）
- [ ] **Step 4: 全量跑** `pnpm --filter aftersales test && pnpm --filter @platform/server test`（模块装载冒烟：manifest 未动本任务不碰声明）
- [ ] **Step 5: 提交**

```bash
git add apps/server/src/loader.ts packages/platform-sdk/src/module.ts modules/aftersales/
git commit -m "feat(server): IdentityLinks 注入模块上下文——申请提交即触发自动匹配（缺省容忍旧宿主）"
```

---

### Task 8: 管理面绑定端点 + console 页

**Files:**
- Create: `modules/aftersales/routes/links-manage.ts`
- Create: `modules/aftersales/routes/links-manage.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（api.internal 增 4 条，**同一提交**）
- Modify: `modules/aftersales/index.ts`（注册新域）
- Modify: `modules/aftersales/console/index.tsx`（tabs 增 `{ key: 'links', label: '身份绑定' }`）
- Create: `modules/aftersales/console/links/index.tsx` + `index.test.tsx`

**Interfaces:** 4 端点（全部 `aftersales:manage`，handler 调 `ctx.identityLinks`，undefined ⇒ 503 `IDENTITY_LINKS_UNAVAILABLE`）：

```
GET  /identity-links?status=        → { items: IdentityLinkView[] }（无 total，单页，照 approvals 页约定）
POST /identity-links/:id/confirm    body { casdoorName?: string }（缺省=确认当前建议）
POST /identity-links/:id/rebind     body { casdoorName: string }（必填）
POST /identity-links/:id/revoke     无 body（revoked_by = identity.userId）
```

- [ ] **Step 1: manifest + 路由骨架同提交**（先写声明与空 handler，`parseIdParam` 用 context.ts 既有解析器）
- [ ] **Step 2: 失败用例**（links-manage.test.ts：stub identityLinks + 伪造 identity；覆盖 4 端点形状、403 无 scope 由门卫兜（单测直接打 handler 层则跳过）、503 未注入、400 rebind 缺参、404 他 org id）
- [ ] **Step 3: 实现** → **Step 4: 跑通过 + 装载冒烟** `pnpm smoke`（双向核对：声明↔注册差集必须为空）
- [ ] **Step 5: console 页**（照 `approvals/index.tsx` + `index.test.tsx` 模式：表格列=渠道/外部号掩码/账户/状态 Tag/绑定方式/操作（pending→确认/改绑、active→改绑/解绑、disputed→恢复或改绑）；`phoneMasked` 直接用服务端值，前端不再自行掩码）
- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/
git commit -m "feat(aftersales): 身份绑定管理面——list/confirm/rebind/revoke 四端点+manifest 原子声明+console 页"
```

---

### Task 9: guest 异议端点 + me/registration 扩展 + userApp 展示

**Files:**
- Modify: `modules/aftersales/routes/registration-guest.ts`（me/registration 响应 + 新端点）
- Modify: `modules/aftersales/manifest.yaml`（+1：`{ method: POST, path: /guest/me/identity/dispute, scope: aftersales:guest }`，同一提交）
- Modify: `modules/aftersales/mobile/src/shims/wuji-data.ts`、`modules/aftersales/mobile/src/composables/useStoreEmployeeApproval.ts`、`modules/aftersales/mobile/src/pages/storeEmployeeApproval.vue`
- Test: Modify `modules/aftersales/routes/registration-guest.test.ts`

**Interfaces:**
- `GET /guest/me/registration` 响应追加 `identity: { bound: boolean; status: 'active'|'disputed'; boundVia: 'auto'|'manual'|null; accountMasked: string } | null`（来自 `ctx.identityLinks.describeOwn`，undefined 服务 ⇒ `identity: null`）
- `POST /guest/me/identity/dispute` → `{ disputed: boolean }`（无 active 绑定 ⇒ `{ disputed: false }` 200，不 404——不向外泄露绑定存在性）

- [ ] **Step 1: manifest+路由同提交骨架** → **Step 2: 失败用例**（dispute 生效/无绑定 false/服务缺省 identity:null）→ **Step 3: 实现**（dispute 内部置 `status='disputed'`+`disputed_at`，audit `identity.link.dispute`；正式态 session 下次刷新因 link 非 active 而 ext 收缩——**中间态判定不变**，acct 会话校验依旧，业务资格由模块判定，语义闭环）
- [ ] **Step 4: userApp**——登记卡片（storeEmployeeApproval.vue :11-98 块内）加绑定行：`identity.bound` 时显示「已绑定账户：accountMasked（自动/人工）」+「这不是我」按钮 → `disputeMyIdentity()` 成功后刷新页面状态；composable 与 shim 各加对应方法（照 :188 `apiSend` 现款）。
- [ ] **Step 5: 跑通过**（server+模块测试）+ **userApp 真机自验列入 PR 描述**（本地无真微信环境，按仓库先例注明「真机公众号回调待试点补验」）
- [ ] **Step 6: 提交**

```bash
git add modules/aftersales/
git commit -m "feat(aftersales): 访客绑定身份可见与异议——me/registration 扩展+dispute 端点+userApp 展示"
```

---

### Task 10: guest 面多绑收窄

**Files:**
- Modify: `modules/aftersales/routes/context.ts`（追加 helper）
- Modify: `modules/aftersales/routes/ticket-guest.ts`（:36/:64/:94/:137 四端点中**读过滤**处）
- Modify: `modules/aftersales/routes/attachment.ts`（:35 所有权谓词 :233-246 处）
- Test: Modify `ticket.test.ts` / `attachment.test.ts`（或对应 guest 用例文件）

**Interfaces:** `context.ts` 追加：

```ts
/** guest 面身份集合：正式态=全部 active 绑定；中间态/旧会话=登录 openid 本身 */
export function guestIdentityIds(identity: Identity): string[] {
  return identity.boundExternalIds ?? [identity.userId]
}
```

- [ ] **Step 1: 失败用例**——伪造 `identity.boundExternalIds = ['oA','oB']`：`GET /guest/tickets` 返回两个 openid 的单；`GET /guest/tickets/:id`（oB 的单）放行；他人单 404；`POST /guest/attachments` 预签名认领校验按集合；**写路径断言不变**（`submitter_openid` 仍落 `identity.userId`=登录 openid——本任务红线：只动读侧）。
- [ ] **Step 2: 跑失败** → **Step 3: 实现**——读侧谓词 `open_id = $n` 改 `open_id = ANY($n)`（数组参数）；`readMySnapshot`（registration-guest.ts:31-44）同理 `open_id = ANY($1)`；settlement-orders（ticket-guest.ts:94）同款。逐文件扫 `/guest/` 全部读点（上方 3 文件 9 端点即全集，grep 复核）。
- [ ] **Step 4: 跑通过**（模块全量） → **Step 5: 提交**

```bash
git add modules/aftersales/routes/
git commit -m "feat(aftersales): guest 面读侧按绑定集合收窄——多绑身份看得到自己全部渠道的单据"
```

---

### Task 11: 摸底与回填脚本

**Files:**
- Create: `scripts/audit-employee-phones.mjs` + `scripts/audit-employee-phones.test.ts`
- Create: `scripts/backfill-identity-links.mjs` + `scripts/backfill-identity-links.test.ts`

**范式（照 `scripts/provision-tenant.mjs`）**：`npx tsx scripts/<name>.mjs`；`createRequire('../apps/server/package.json')` 取 pg；纯核函数 `export` 供同名 `.test.ts`；头注释写清用途/风险；**手机号输出一律掩码（前3后2）**。

- [ ] **Step 1: 摸底脚本**（只读）：`analyzePhones(rows: {org,openId,phone,approveStatus}[])` → `{ total, empty, invalid, dupGroups: { org, phoneMasked, openids[] }[] }`；main 打印汇总 + dup 明细（掩码）。跑一次本地库（或运维经 openship custom job 跑生产），**结果贴进 PR 描述**（决定 Phase 1 自动匹配置信基线，设计稿 §5.1）。
- [ ] **Step 2: 回填脚本**：`planBackfill(rows)` 纯核 → `{ binds: [{org, openId, phone}], invalid: […] }`（approved 且 phone 有效才进 binds；approved 无 phone → invalid 清单转人工；非 approved 全忽略）。main：逐条 `ensureUser(openId)`（已存在则跳过，幂等可重跑）→ `upsertLink({status:'active', boundVia:'manual', phone})`；逐条 try/catch 收集失败清单续跑；结束打印成功/失败计数（掩码）。
- [ ] **Step 3: 两个 `.test.ts` 覆盖纯核**（空 phone/86 前缀/dup 分组/非 approved 过滤）
- [ ] **Step 4: 跑通过 + 提交**

```bash
git add scripts/
git commit -m "chore(scripts): 存量手机号摸底与身份绑定回填脚本——只读盘点+幂等回填，输出全掩码"
```

---

### Task 12: 全量门禁 + PR

- [ ] **Step 1: 本地全量门禁**（本仓 CI 全集的本地近似，不只跑相关包）：

```bash
pnpm test && pnpm typecheck && pnpm build && pnpm smoke
node scripts/check-compose.mjs && node scripts/check-env-example.mjs
ls scripts/check-*.mjs 2>/dev/null   # 其余 check-* 逐个全跑，一个不落
```

Expected: 全绿。中文路径若引爆 vite 系测试 → 换 ASCII 工作树重跑（Global Constraints）。
- [ ] **Step 2: 建 issue** `gh issue create -t "feat(aftersales): 账户体系统一 Phase 1（公众号账户化）" -b "设计稿+计划链接；范围=identity_link/两态session/自动匹配/管理修正/存量回填"`
- [ ] **Step 3: 开 PR**（title `feat(aftersales): 账户统一 Phase 1——绑定表+两态 session+自动匹配 (#N)`，body 带 `Closes #N`、每任务验证清单、真机公众号回归待试点补验注记、手机号摸底结果）
- [ ] **Step 4: 等 CI CLEAN 再合**（UNSTABLE 不强合——历史红线）

---

## Self-Review 记录

- **Spec 覆盖**：§1.2 表→T2；§1.1 草稿户→T6（ensureUser）；§2 三层→T6/T7/T8；§2 异议→T9；§3.1/3.2/3.3→T3/T4/T5；§4.1 读收窄→T10；§4.2/4.3 迁移→T11；§5 前置→T11 Step1（摸底）+Task 12（真机注记）；§7 正典→T1；§8 YAGNI 未引入。**缺口**：§5.2 企微通讯录权限属 Phase 2，未列（有意）。
- **占位符扫描**：Task 2 Step 4 的 SQL 以骨架+逐条语义注释给出（insert/update 全形状在 DDL 与接口注释里可机械展开），Task 1 文案全文给出——无 TBD/「适当处理」类。
- **类型一致性**：`IdentityLinks` 七方法在 T6 定义、T7/T8/T9 消费，签名逐字一致；`findActiveLink`/`listActiveExternalIds` 在 T2 定义、T4/T5 deps 逐字一致；`acct/ext` 载荷字段 T3 定义、T4/T5 消费一致。
