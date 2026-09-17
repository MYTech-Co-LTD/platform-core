# M3c 每租户可配 ZOS（模块接入协议扩展落地）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ZOS 凭证从**进程 env**（只对单租户部署成立）收口到**每租户可配**：`platform.tenant` 加五列、
宿主按请求把**本租户的**存储配置投影进模块上下文、`aftersales` 从「装载期常量」改为「按请求解析」，
并为附件行补 `storage_ref` 让存量对象能被定位到**写入当时的桶**。

**Architecture:** 严格按已拍板的正典落地——`docs/module-protocol.md`「租户级配置注入」（规则正文）+
`docs/architecture.md` §4.3（机制与不变量对照）。载体 = Hono context 键（与 `identity` 同构）；
来源 = `platform.tenant` 行（与 `wechat_oa_*` 同构）；`ModuleContext` **一字不改**（加而不改）。
唯一的新增形状是 manifest 的**可选** `storage: { kind: s3 }`。

**Tech Stack:** Hono 4 / pg / zod / React 19 + antd 6（console 管理页）/ vitest + 真 PG；
宿主侧探测新增 `@aws-sdk/client-s3`（**待拍板 1 已裁定 → (A)**，2026-09-17；依赖表已更新 →
`docs/architecture.md` §2.1）。

**Spec（正典，**本计划不改它们**）:**
- `docs/module-protocol.md`「租户级配置注入：`storage`」——manifest 字段形状、context 键名与类型、
  注入位置、兜底语义、安全性质。
- `docs/architecture.md` §4.3 + §5 第 9 条。
- `docs/superpowers/specs/2026-09-16-m3c-tenant-storage-protocol-design.md`（决策记录；§5 分步、§8 七条裁定）。
- `docs/superpowers/specs/2026-09-15-aftersales-module-design.md` §2.3（两阶段 + `storage_ref` 缺口）。

**Issue:** #101（M3c：按已拍板的协议扩展落地）。

---

## Global Constraints

本节逐条取自正典与仓库纪律，**每个任务都隐含包含**。

- **`ModuleContext` 保持 `{ pool }` 一字不动**（`packages/platform-sdk/src/module.ts:20-22`）。
  新能力只有两处**加**：manifest 可选字段 + context 键（不声明就不 set）。
  改 `ModuleContext` 是**越权**（正典 §2.4 D1 明确排除 D2/D3）。
- **声明的语义是「能力」不是「租户」**（`module-protocol.md`「安全性质」三段，逐条硬约束）：
  ① 配置作用域永远是**本次请求所属租户**，模块**没有任何途径**指定 org；
  ② 注入的必须是**投影后的窄值**，**绝不**把 `TenantRow` 整个塞给模块
  （它坐着 `wecom_secret` / `wechat_oa_secret` / `casdoor_org`）；
  ③ manifest 里写不出 bucket / AK / org，只写得出 `kind`。
- **兜底 fail-explicit**（裁定 4）：租户行**五列全空** ⇒ 注入平台默认；**部分填写 ⇒ 不注入**
  （**绝不**回落平台桶——回落 = 数据位置误述 + 成本事故）；五列全填 ⇒ 注入租户自己的配置。
- **连通性验证只在请求路径之外**（裁定 5）：管理端**保存时探测** + 显式**「测试连接」**；
  **明确不**在请求路径上探测（预签名是 SigV4 **纯本地计算**，宿主永远无法在请求路径上发现配置坏）。
- **注入中间件不是门卫**：不做鉴权、不返回 403，只做投影。「宿主施加门禁」与「宿主注入材料」是两件事。
- **挂载顺序是硬约束**：投影中间件挂在**启用闸门之后**、`app.route(base, m.router)` **之前**
  （`apps/server/src/loader.ts:442` / `:444`）。Hono 里 handler 先注册、`use` 后注册 ⇒
  中间件**永不执行**——顺序错了的表现是 `c.get(TENANT_STORAGE)` **恒 `undefined`**，代码里看不出问题。
- **B1 三同**：模块只许自身 schema，平台代码只许 `platform.*`（`scripts/lint-architecture.mjs` 守）。
  跨租户取配置的实现只能在**宿主**侧（模块自己去查租户行 = 越权，正典已排除）。
- **B9 env 契约**：env 五键**保留**、`.env.example` **一行不改**（M3c **不新增任何 env 键**）。
- **敏感值不落日志 / 不回显 / 不进 audit**：SK 一律不回显（AK 只回掩码）；探测失败只回分类 + endpoint host。
- **提交纪律**：Conventional Commits；feat/fix 必须挂 issue（本线全部挂 `#101`）；一切可见变更走 PR。
  `CHANGELOG` **禁止手写**。**不要删改 provenance trailer**（`X-Orca-*`）。
- **测试门禁**：每个任务的完成判据是 `cd <包> && pnpm test` + 根 `pnpm typecheck` 绿；波末跑**全量**
  （见「验收」节的完整命令表）。
- **本仓已有事实（别重复发现）**：本机 `127.0.0.1:5432` 可能连的是**原生 postgres** 而不是 compose 容器
  ——跑需要真库的测试前先确认目标库，否则会在一套与 CI 不同的 schema 上得到假结论。
- **命令里的 `DATABASE_URL=…`** 一律指本计划统一的那个值
  `postgres://platform:platform@127.0.0.1:5432/platform`（首次出现时写全，其后用 `…` 省略；
  与 `docs/superpowers/plans/2026-09-16-aftersales-m3b2-mobile.md` 的写法一致）。

---

## 读码核实：与文档不符之处（**以代码为准**，本计划按代码写）

三类，全部经实读逐条核对。**协议语义一条都没错**，但指针与覆盖面有出入。

### A. 行号漂移（机械，但会误导排障）

| 文档说 | 实为 | 差 |
|---|---|---|
| `loader.ts:294` = `def.createRouter({ pool: deps.pool })`（正典 §4.3、module-protocol 各引一次） | **`loader.ts:321`** | −27 |
| `loader.ts:364-437` = `mount()` 的每模块循环 | **`loader.ts:391-476`** | −27 起 |
| `loader.ts:412` = 启用闸门 `app.use(base + '/*', gate)` | **`loader.ts:442`** | −30 |
| `loader.ts:414` = `app.route(base, m.router)` | **`loader.ts:444`** | −30 |
| `loader.ts:386-388` = 「`enabledFor` 每请求一查」 | **`loader.ts:435`** | −49 |
| `app.ts:276` = `runtime.mount(app)` | **`app.ts:278`** | −2 |
| `tenant.ts:12-32` = `TenantRow` | **`tenant.ts:13-33`** | −1 |
| `storage.ts:61-68` = `zosConfigFromEnv` | **`storage.ts:67-74`** | −6 |
| `routes/attachment.ts:72` = `where org = $1` | **`routes/attachment.ts:78`** | −6 |

（**相符**的：`module.ts:20-22` / `:92` / `:113` / `:121-125`、`session-middleware.ts:217,221`、
`app.ts:206` / `:214`、`tenant.ts:65` 的 `select t.*`、`migrations/001_init.sql:148-160`、
`routes/attachment.ts:36,85,96`、`.env.example:34-38`。）

处置：**本计划不改正典**（任务硬约束）。漂移回收清单见文末「附录」，另开文档 PR。

### B. 正典**未覆盖**的真代码事实（三条，其中两条会改变实现）

1. **storage 有 3 个消费点，文档只描述了 1 个。**
   正典与售后 spec §2.3 都把消费面描述成「附件端点」，实读是：

   | 消费点 | 行为 | 文档 |
   |---|---|---|
   | `routes/attachment.ts:36,45`（`POST /guest/attachments`） | 预签名 PUT + 落行 | ✅ 有 |
   | `routes/attachment.ts:85,96`（`GET /attachments/:id`） | 预签名 GET；无配置 ⇒ **503** | ✅ 有 |
   | **`routes/ticket-manage.ts:221-242` 的 `loadAttachments()`**（被 `ticket-manage.ts:90` 与 `ticket-guest.ts:75` 调用） | 工单详情一次列多个附件、逐个预签名；无配置 ⇒ 该项 **`url: null`**（**不是 503**） | ❌ **无** |

   ⇒ 它是**读侧的主要消费者**（一次列 N 个），且**它的降级语义与附件专用端点不同**。
   步 4 的改造面因此比文档描述大，`loadAttachments` 的签名（现为 `(ctx, org, ticketId)`）必须拿到
   按请求配置。本计划 T8 按此实现。

2. **single 模式下租户行有 60s 进程内缓存，配置变更的生效窗口文档没写。**
   `tenant.ts:51-61`：`TENANT_MODE=single` 时按 `casdoorOrg` 缓存整行（`ORG_CACHE_TTL_MS = 60_000`，
   只缓存命中、无失效接口）。⇒ 正典「配置列落 `platform.tenant` ⇒ `select *` 自动带出、零额外 DB 往返」
   **成立**，但 single 部署下**管理端保存后最长 60s 才生效，且多实例间不一致**（各实例各缓存）。
   ⇒ 本计划的处理：**不改缓存**，在配置页文案里写明该窗口（T7 Step 6）。
   **已裁定（待拍板 4 → (A)，2026-09-17）：不失效——把窗口写进协议与页面文案。**
   ⇒ 「要不要让写入路径主动失效缓存」**不再是待决项**。

3. **平台默认的 env 五键是 `AFTERSALES_ZOS_*`（模块命名空间）。**
   正典裁定「env 五键保留、语义降为**平台默认**」，而 M3c 之后**宿主**要读这五个键注入给**任何**
   声明 `storage` 的模块 ⇒ 「平台默认」事实上是「aftersales 的默认」。这是**命名债**，不是实现错
   （键名冻结是裁定的一部分）。本计划照裁定实现（T1 把键名常量与读取函数**收进 SDK 一处**，
   消灭「宿主一套、模块一套」的双实现漂移）。
   **已裁定（待拍板 3 → (A)，2026-09-17）：保持 `AFTERSALES_ZOS_*` 键名**——债仍在，账记在「附录」第 5 条；
   **改名仍是另一件事**（改协议 + `.env.example` + openship env），本计划不做。

> 附带核实：**B9 对这五个键本来就没有静态覆盖**——`modules/aftersales/storage.ts:16-22` 是
> `ENV_KEYS` 字符串数组 + `env[k]` 下标读，`check-env-example.mjs` 的三组检测器
> （`process.env.KEY` / `process.env['KEY']` / 宿主 `env.KEY`）**一条都不命中**。
> 故把键名搬进 SDK **不构成 B9 覆盖的回归**（本来就是零）；键在 `.env.example` 的声明不变。

### C. 任务简报的一处用词与正典冲突（按正典写）

简报说「按请求的存储解析：`storageFor(org)` 的形状」。**入参不能是 `org`**：正典 §「安全性质」第 1 条
与提案 §2.1-A4 明确排除「装成一个按 org 的解析器」（那等于把「模块可以指定 org」写进协议）。
⇒ 本计划的模块侧解析器入参是**注入的配置值**：`storageFor(cfg: TenantStorageConfig)`（T8）。

---

## 波次划分（派发用）

步号＝正典 §5 的步 2/3/4/5；**波内不得改同一文件**。

| 波 | 步 | 任务 | 并行性 |
|---|---|---|---|
| **Wave 1** | 步 2 | T1 SDK 协议面 → T2 manifest 可选字段 → T3 loader 投影（**env-only**） | **串行链**：T3 依赖 T1（`TenantStorageConfig`/`TENANT_STORAGE`）与 T2（manifest 认 `storage`，模块才声明得上）。T1 与 T2 文件不相交，可并行。 |
| **Wave 2** | 步 3 | T4 平台迁移 + `TenantRow` | **T4 先行**（唯一的串行点），随后 **T5 ∥ T6 ∥ T7 三路并行** |
| | | T5 投影升级（租户行优先）／T6 附件行 `storage_ref` 列／T7 管理端配置面 + 探测 + 页面 | 三者文件不相交：`tenant-storage.ts`+`loader.test.ts` / `modules/aftersales/migrations/003_*.sql` / `admin.ts`+`storage-probe.ts`+`apps/web/**`。T5、T7 均依赖 T4 的列与字段。 |
| **Wave 3** | 步 4 | T8 模块侧原子切换 → T9 宿主级端到端断言 | **串行**：T9 断言的行为在 T8 之前不存在。 |
| **Wave 4** | 步 5 | T10 全量门禁 + 试点验收 + 回滚演练 + 收尾 | **串行**（波末全量验证 + 运营动作） |

> 步 2 与步 3 **各自可独立上线且生产行为零变化**、步 4 是唯一原子切换——这三条已逐条对照真代码核实，
> 结论与两处修正见「分步可上线性与回滚点」节。

---

## 文件结构

```
packages/platform-sdk/src/
  module.ts                       改：TenantStorageConfig + TENANT_STORAGE（T1）
  storage.ts                      新：normalizeEndpoint / storageRefOf / platformStorageFromEnv + 键名常量（T1）
  storage.test.ts                 新（T1）
  manifest.ts                     改：可选 storage 字段（接口 + ManifestObject）（T2）
  checks.test.ts                  改：kind 写错 ⇒ errors 非空的用例（T2）
  index.ts                        改：导出上述符号（T1）

apps/server/src/
  migrations/006_tenant_storage.sql  新：platform.tenant 加五列（T4）
  tenant.ts                       改：TenantRow 加五字段（T4）
  tenant-storage.ts               新：resolveTenantStorage(row) 纯投影函数（T3 建骨架 / T5 升级为读租户行）
  loader.ts                       改：mount 内挂投影中间件（T3）
  loader.test.ts                  改：声明/未声明 storage 的注入用例 + 三态用例（T3/T5）
  storage-probe.ts                新：HeadBucket 探测（超时上界 + 失败分类）（T7）
  routes/admin.ts                 改：GET/PUT/DELETE /storage + POST /storage/test（T7）
  routes/admin.test.ts            改：baseTenant 字面量补五列（T4）+ 存储端点用例（T7）
  storage-probe.test.ts           新：真网络栈的失败分类用例（T7）
  storage-injection.test.ts       新：真装配 + 真 Host + 真登录的端到端断言（T9）
  package.json / ../../pnpm-lock.yaml  改：加 @aws-sdk/client-s3（T7）

modules/aftersales/
  manifest.yaml                   改：声明 `storage: { kind: s3 }`（T3）
  migrations/003_attachment_storage_ref.sql  新：ticket_attachment 加 storage_ref（T6）
  storage.ts                      改：ZosStorage 保留；解析器 storageFor(cfg) + client 缓存 + 平台默认（T8）
  index.ts                        改：不再装载期读 env（T8）
  routes/context.ts               改：RouteCtx 去掉 storage（T8）
  routes/attachment.ts            改：按请求解析 + 写/读 storage_ref（T8）
  routes/ticket-manage.ts         改：loadAttachments 收解析器（T8）
  routes/{attachment,ticket,registration-*}.test.ts  改：注入 storage 的方式（T8）
  test-util.ts                    改：buildTestApp 支持注入 TENANT_STORAGE（T8）
  module.test.ts                  改：manifest 认 storage 字段（T3）

apps/web/src/
  lib/api.ts                      改：三组 admin storage API（T7）
  pages/admin/Storage.tsx         新：配置页（T7）
  pages/admin/Storage.test.tsx    新：渲染冒烟（T7）
  pages/console-menu.ts           改：管理组加「存储配置」项（T7）
  App.tsx                         改：加 /console/admin/storage 路由（T7）

deploy/delivery-private.md        改：五个 env 键的语义补一句（T10，见附录）
README.md                         改：已知边界一句（single 生效窗口 + 端到端留试点）（T10）
```

---

## Wave 1（正典步 2：宿主机制，env-only）

> **本波的合并后状态**：声明了 `storage` 的模块能拿到 `c.get(TENANT_STORAGE)`，值 = **平台 env 默认**
> （租户行还没列可读）。**生产行为零变化**：env 有 ⇒ 与今天模块自己读 env 逐值等价；env 无 ⇒ 不 set
> ⇒ 模块 `undefined` ⇒ 附件端点 503，与今天等价。

### Task 1: SDK 协议面（类型 + context 键 + 三个纯函数）

**Files:**
- Modify: `packages/platform-sdk/src/module.ts`（在 `ModuleContext` 之后追加类型与常量）
- Create: `packages/platform-sdk/src/storage.ts`
- Create: `packages/platform-sdk/src/storage.test.ts`
- Modify: `packages/platform-sdk/src/index.ts`

**Interfaces:**
- Produces（T3/T5/T7/T8 全部依赖这些**确切**名字）：
  - `TenantStorageConfig = { kind: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }`
  - `const TENANT_STORAGE = 'platform.tenantStorage'`
  - `normalizeEndpoint(raw: string): string`
  - `storageRefOf(cfg: Pick<TenantStorageConfig, 'kind' | 'endpoint' | 'bucket'>): string`
  - `PLATFORM_STORAGE_ENV_KEYS: readonly string[]`
  - `platformStorageFromEnv(env: Record<string, string | undefined>): TenantStorageConfig | null`
- **不产生**任何客户端：`ZosStorage` 继续留在 `modules/aftersales/storage.ts`
  （spec §2.3「第二个消费者出现再抽公共包」）。**已裁定（待拍板 1 → (A)，2026-09-17）：本计划不抽**——
  宿主为自己的探测引**自己**的 `@aws-sdk/client-s3`；「宿主成为第二个消费者」让那条判据**到点**，
  但不等于现在抽公共包（两件事，见 `docs/architecture.md` §2.1）。

- [ ] **Step 1: 写失败的测试**

`packages/platform-sdk/src/storage.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { PLATFORM_STORAGE_ENV_KEYS, normalizeEndpoint, platformStorageFromEnv, storageRefOf } from './storage'

const FULL_ENV = {
  AFTERSALES_ZOS_ENDPOINT: 'zos.xinan1.ctyun.cn',
  AFTERSALES_ZOS_REGION: 'xinan1',
  AFTERSALES_ZOS_BUCKET: 'aftersales-test',
  AFTERSALES_ZOS_ACCESS_KEY: 'AKIATEST',
  AFTERSALES_ZOS_SECRET: 'secret-test',
}

describe('normalizeEndpoint', () => {
  it('无协议补 https://，吃掉尾斜杠与空白', () => {
    expect(normalizeEndpoint('zos.xinan1.ctyun.cn')).toBe('https://zos.xinan1.ctyun.cn')
    expect(normalizeEndpoint('  https://zos.xinan1.ctyun.cn///  ')).toBe('https://zos.xinan1.ctyun.cn')
    // 显式 http:// 不被改写（自建 MinIO 走明文是合法部署）
    expect(normalizeEndpoint('http://10.0.0.9:9000')).toBe('http://10.0.0.9:9000')
  })
})

describe('storageRefOf：配置标识（storage_ref 的规范形状）', () => {
  const cfg = { kind: 's3' as const, endpoint: 'https://zos.test', bucket: 'b1' }
  it('同配置 ⇒ 同串（值相等，不看引用）', () => {
    expect(storageRefOf({ ...cfg })).toBe(storageRefOf({ ...cfg }))
  })
  it('endpoint 或 bucket 变一个字 ⇒ 必不同（这是它存在的全部理由）', () => {
    expect(storageRefOf(cfg)).not.toBe(storageRefOf({ ...cfg, bucket: 'b2' }))
    expect(storageRefOf(cfg)).not.toBe(storageRefOf({ ...cfg, endpoint: 'https://zos.test/' }))
  })
  it('含 kind 前缀：第二个 kind 出现时不会与 s3 的 ref 撞车', () => {
    expect(storageRefOf(cfg).startsWith('s3|')).toBe(true)
  })
  it('不含密钥（AK/SK 不进 storage_ref —— 轮换 AK 不该让存量行失去归属）', () => {
    expect(storageRefOf(cfg)).not.toContain('AKIA')
  })
})

describe('platformStorageFromEnv（平台默认）', () => {
  it('五键齐 ⇒ 返回配置，endpoint 已规范化', () => {
    expect(platformStorageFromEnv(FULL_ENV)).toEqual({
      kind: 's3',
      endpoint: 'https://zos.xinan1.ctyun.cn',
      region: 'xinan1',
      bucket: 'aftersales-test',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret-test',
    })
  })
  it('缺任一键 ⇒ null（「没有平台默认」是一个确定状态，不是半成品配置）', () => {
    for (const k of PLATFORM_STORAGE_ENV_KEYS) {
      const partial = { ...FULL_ENV, [k]: undefined }
      expect(platformStorageFromEnv(partial), k).toBeNull()
    }
    expect(platformStorageFromEnv({})).toBeNull()
  })
  it('空串等同缺失（部署里 `KEY=` 是常见形态，不能当有效值）', () => {
    expect(platformStorageFromEnv({ ...FULL_ENV, AFTERSALES_ZOS_BUCKET: '' })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/sdk test`
Expected: FAIL —— `./storage` 不存在。

- [ ] **Step 3: 实现 `packages/platform-sdk/src/storage.ts`**

```ts
// storage.ts — 租户存储配置的**纯函数**面：规范化、配置标识、平台默认。
//
// 为什么这三样进 SDK 而不是各写一份：`storage_ref`（行上记的「写入当时的配置标识」）是
// **宿主与模块之间的字符串契约** —— 宿主拿它写、模块拿它比。两处各实现一次 = 两份事实源，
// 而失败形态是**静默的**（ref 永远匹配不上 ⇒ 存量附件全部读不出，平台侧只有一条日志）。
//
// 边界：SDK 只定义**配置的形状、标识与来源**，**不定义客户端**（`ZosStorage` 留在
// modules/aftersales/storage.ts —— spec §2.3「第二个消费者出现再抽公共包」）。
import type { TenantStorageConfig } from './module'

/**
 * 平台默认存储的 env 键。**缺任一 ⇒ 没有平台默认**（等价于「不注入」，见正典的兜底表）。
 *
 * ⚠️ 键名是 `AFTERSALES_ZOS_*`——**模块命名空间**。M3c 的裁定是「五键保留、语义从『唯一来源』
 * 降为『平台默认』」，故此处照裁定冻结键名；但从此宿主也要读它们，**第二个声明 `storage`
 * 的模块出现时，「平台默认」就变成了「aftersales 的默认」**。这是已知命名债，记账在此：
 * 改名 = 改协议 + 改 .env.example + 改 openship env，属**单独决定**（待拍板 3 → (A)：**保持键名**，2026-09-17）。
 * 收进 SDK 一处是为了消灭「宿主一套、模块一套」的双实现漂移——债的**范围**不减，但**漂移面**归零。
 */
export const PLATFORM_STORAGE_ENV_KEYS = [
  'AFTERSALES_ZOS_ENDPOINT',
  'AFTERSALES_ZOS_REGION',
  'AFTERSALES_ZOS_BUCKET',
  'AFTERSALES_ZOS_ACCESS_KEY',
  'AFTERSALES_ZOS_SECRET',
] as const

/** endpoint 可能没写协议 ⇒ 补 https://；顺带吃掉首尾空白与尾斜杠（正典要求注入值是「已规范化」的）。 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * 配置标识 = `storage_ref` 的值。**只用于相等比较**（从不拆开解析）。
 *
 * 三个字段的取法：
 *  · `kind` —— 目前只有 `s3`，带上它是**廉价的去歧义**（第二个 kind 出现时不会与 s3 撞串）；
 *  · `endpoint` —— 已规范化（`normalizeEndpoint` 之后），故同一配置的不同写法收敛成同一串；
 *  · `bucket` —— S3 桶名不含 `|`，URL 也不含裸 `|` ⇒ `|` 是无歧义分隔符。
 * **故意不含 region / AK / SK**：裁定②定的最小可用是「bucket + endpoint」；纳入 AK 会让
 * AK 轮换使存量行失去归属，而那是**数据面**的伤害，不该由标识符承担。
 */
export function storageRefOf(cfg: Pick<TenantStorageConfig, 'kind' | 'endpoint' | 'bucket'>): string {
  return `${cfg.kind}|${cfg.endpoint}|${cfg.bucket}`
}

/**
 * 平台默认配置（进程 env 五键）。**五键缺任一（或为空串）⇒ `null`** —— 「没有平台默认」
 * 是一个**确定状态**，宿主据此不 set、模块据此拿不到（与今天 `zosConfigFromEnv` 的语义逐字同款）。
 */
export function platformStorageFromEnv(
  env: Record<string, string | undefined>,
): TenantStorageConfig | null {
  const values = PLATFORM_STORAGE_ENV_KEYS.map((k) => env[k])
  if (values.some((v) => v === undefined || v === '')) return null
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values as [string, string, string, string, string]
  return { kind: 's3', endpoint: normalizeEndpoint(endpoint), region, bucket, accessKeyId, secretAccessKey }
}
```

- [ ] **Step 4: 在 `module.ts` 追加类型与键常量**

紧接 `ModuleContext`（`module.ts:20-22`）之后插入：

```ts
/**
 * 宿主按【本次请求所属租户】投影出的存储配置（正典「租户级配置注入」）。
 * kind 由 manifest 的 `storage.kind` 选定；五元组是 S3 兼容的通用形状（ZOS 只是实现之一）。
 *
 * ⚠️ 模块拿到的是**投影后的窄值**，不是 `TenantRow` —— 后者坐着 wecom/公众号密钥与 casdoor_org。
 * 这条是 B1 的延伸约束，不是风格问题（见 docs/architecture.md §4.3 的不变量表）。
 */
export interface TenantStorageConfig {
  kind: 's3'
  /** 已规范化（含协议、无尾斜杠）——`normalizeEndpoint` 的产物 */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * 存储配置的 Hono context 变量键。带 `platform.` 前缀避撞（照 DECLARED_GATE_APPROVED 的既有做法）。
 * 键名是**宿主 set / 模块 get 的约定**，编译器不连线 ⇒ 改名是破坏性变更。
 */
export const TENANT_STORAGE = 'platform.tenantStorage'
```

- [ ] **Step 5: 导出（`packages/platform-sdk/src/index.ts`）**

在 `export { DECLARED_GATE_APPROVED, defineModule, ... } from './module'` 之后追加：

```ts
export { TENANT_STORAGE } from './module'
export type { TenantStorageConfig } from './module'
export { PLATFORM_STORAGE_ENV_KEYS, normalizeEndpoint, platformStorageFromEnv, storageRefOf } from './storage'
```

> ⚠️ 只加**值导出**与 `export type`——**绝不**在值清单里混 `interface`（#44 生产事故：Node ESM 运行时
> SyntaxError，typecheck 与直连 src 的单测都拦不住）。`TenantStorageConfig` 与既有
> `Identity`/`ModuleContext` 同处理，走独立的 `export type` 行。

- [ ] **Step 6: 跑测试 + 类型**

Run: `pnpm --filter @platform/sdk test && pnpm typecheck`
Expected: PASS（新用例全绿；`pnpm typecheck` 含 `scripts/`，故顺带证明没有把新符号用错）。

- [ ] **Step 7: 提交**

```bash
git add packages/platform-sdk/src
git commit -m "feat(sdk): 租户存储配置的类型/context 键与三个纯函数（M3c 步 2）(#101)"
```

---

### Task 2: manifest 可选字段 `storage`

**Files:**
- Modify: `packages/platform-sdk/src/manifest.ts`（接口 `ModuleManifest` + `ManifestObject`）
- Modify: `packages/platform-sdk/src/checks.test.ts`

**Interfaces:**
- Produces: `manifest.storage?: { kind: 's3' }`。
  **缺省 = 不声明 = 宿主不注入**（现有模块一行不改仍装载通过）。

- [ ] **Step 1: 接口侧加一行**

`ModuleManifest`（`manifest.ts:17-29`）在 `guest?` 一行之后插入：

```ts
  /** 售后 spec §2.3 / 正典「租户级配置注入」：声明本模块需要**本租户的**存储配置。
   *  缺省 = 不声明 = 宿主不注入（`c.get(TENANT_STORAGE)` 恒 undefined），行为与今天逐字相同。
   *  ⚠️ 声明的是**能力**不是**租户**：这里写不出 bucket / AK / org，只写得出 kind。 */
  storage?: { kind: 's3' }
```

- [ ] **Step 2: zod 侧同步（否则编译期双向断言会红——这正是它存在的意义）**

`ManifestObject`（`manifest.ts:38-70`）在 `guest:` 一行之后插入：

```ts
  // 枚举**收窄**到 s3：写别的值 ⇒ schema 拒绝 ⇒ 装载失败（进程起不来，不是告警）——
  // 与 api.internal[].scope / guest.scope 的 fail-fast 同风格。
  storage: z.object({ kind: z.enum(['s3']) }).optional(),
```

- [ ] **Step 3: 跑 typecheck 确认双向断言通过**

Run: `pnpm typecheck`
Expected: PASS。若只改接口不改 zod（或反之），`manifest.ts:130-134` 的
`_AssertManifestBidirectional` 必报错——**这条红是设计，不是障碍**。

- [ ] **Step 4: 补一条 checks 用例（钉住「写错即拒绝」）**

**判断先说清：`scripts/check-manifests.mjs` / `checks.ts` 本身要不要认这个新字段？——不要改。**
三条理由：① 门禁的 ① 号检查项就是 `ManifestSchema.parse`，schema 一改它**自动**覆盖新字段
（zod object 默认剥离未知键，故旧 manifest 不会因此挂）；② 「声明了 `storage` 但代码里从没
`c.get(TENANT_STORAGE)`」是**运行期**事实，静态扫不出来——要扫就得引源码分析，收益不明而成本确定；
③ **门禁升级是单独的决定**（正典 §9 明写，本仓规矩「无案例不立标准」）——真出现「声明了不用」
的案例时再谈。故只补**既有检查项**的用例，不动门禁语义。

`packages/platform-sdk/src/checks.test.ts` 追加（照该文件既有 fixture 写法）：

```ts
  it('manifest.storage.kind 写错 ⇒ 报错（新字段自动走既有 schema 检查，门禁零改动）', async () => {
    await withRoot(async (root) => {
      await write(root, 'modules/storagemod/manifest.yaml', [
        'id: storagemod', 'name: storagemod 模块', 'version: 1.0.0', "platform: '>=0.1.0'",
        'permissions:', '  - code: storagemod:view', '    name: 查看',
        'storage: { kind: oss }', // ← 只有 s3 合法
        '',
      ].join('\n'))
      const { errors } = await runChecks(root)
      expect(errors.some((e) => e.includes('storage'))).toBe(true)
    })
  })

  it('manifest.storage.kind = s3 ⇒ 通过（正向对照：防止把「一律拒绝」当成修好了）', async () => {
    await withRoot(async (root) => {
      await write(root, 'modules/storagemod/manifest.yaml', [
        'id: storagemod', 'name: storagemod 模块', 'version: 1.0.0', "platform: '>=0.1.0'",
        'permissions:', '  - code: storagemod:view', '    name: 查看',
        'storage: { kind: s3 }',
        '',
      ].join('\n'))
      expect((await runChecks(root)).errors).toEqual([])
    })
  })
```

> fixture 走该文件**既有**的 `withRoot(fn)` + `write(root, relPath, content)` 两个 helper，
> **不要**新造一套 harness（那会造出第二个事实源）。`platform` 值用单引号——该文件顶部注释记着
> 「`>=` 开头的值必须加引号」。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter @platform/sdk test && pnpm exec tsx scripts/check-manifests.mjs`
Expected: PASS + `check-manifests: OK`（真仓的两个 manifest 都不声明 storage，照旧通过）。

- [ ] **Step 6: 提交**

```bash
git add packages/platform-sdk/src/manifest.ts packages/platform-sdk/src/checks.test.ts
git commit -m "feat(sdk): manifest 可选 storage 字段（枚举收窄 s3，写错即装载失败）(#101)"
```

---

### Task 3: loader 投影中间件（env-only）+ `aftersales` 声明

**Files:**
- Create: `apps/server/src/tenant-storage.ts`
- Modify: `apps/server/src/loader.ts`（`mount()` 内，闸门之后、`route` 之前）
- Modify: `modules/aftersales/manifest.yaml`（声明 `storage`）
- Modify: `apps/server/src/loader.test.ts`、`modules/aftersales/module.test.ts`

**Interfaces:**
- Produces:
  - `apps/server/src/tenant-storage.ts` → `resolveTenantStorage(row: TenantRow | undefined): TenantStorageConfig | undefined`
    （**本任务只实现平台默认分支**；T5 补租户行分支）
  - loader 行为契约：**声明了 `storage` 的模块**，其 API 子树（`/api/modules/<id>/*`）上
    `c.get(TENANT_STORAGE)` 有值（平台 env 完整时）或 `undefined`（env 不全时）；
    **未声明的模块**恒 `undefined`（不挂中间件）。

- [ ] **Step 1: 写失败的测试**

先在该文件的 fixture 工厂区（`manifestYaml` 之后）补一个**两个用例共用**的工厂——T5 也调它，
重复写一遍就是第二个事实源（fixture 漂移的症状是「一条用例过了、另一条没过」）：

```ts
  /** M3c 存储投影的 fixture：storagemod（manifest.yaml 声明 storage）+ plainmod（同 handler、不声明）。
   *  handler 把 context 键**原样回显**——唯一能证明「宿主真的 set 了」的证据面（断言模块内部变量
   *  只能证明它自己算出来的东西）。两组**共用同一份 handler 源码**，唯一差别是 manifest.yaml
   *  声明不声明 storage ⇒ 排除「handler 写法不同」这个第三变量。
   *  ⚠️ 声明必须写在 **manifest.yaml**：装载器读的是它（apps/server/src/loader.ts:280），
   *     index.ts 里的内联 manifest 不参与装载。 */
  async function writeStorageFixtures(modulesDir: string): Promise<void> {
    const echoIndexTs = (id: string): string => [
      "import { Hono } from 'hono'",
      "import { TENANT_STORAGE, defineModule } from '@platform/sdk'",
      '',
      'export default defineModule({',
      '  manifest: {',
      `    id: '${id}', name: '${id}', version: '1.0.0', platform: '>=0.1.0',`,
      `    permissions: [{ code: '${id}:view', name: '查看' }],`,
      `    api: { internal: [{ method: 'GET', path: '/ping', scope: '${id}:view' }] },`,
      '  },',
      '  createRouter: () => {',
      '    const app = new Hono()',
      "    app.get('/ping', (c) => c.json({ storage: c.get(TENANT_STORAGE) ?? null }))",
      '    return app',
      '  },',
      '})',
      '',
    ].join('\n')
    await writeModule(modulesDir, 'storagemod', {
      'manifest.yaml': manifestYaml('storagemod', 'storage: { kind: s3 }'),
      'index.ts': echoIndexTs('storagemod'),
    })
    await writeModule(modulesDir, 'plainmod', {
      'manifest.yaml': manifestYaml('plainmod'),
      'index.ts': echoIndexTs('plainmod'),
    })
  }
```

然后追加用例（用该文件既有的 `newModulesDir` / `writeModule` / `manifestYaml` / `injectIdentity` /
`acmeTenant` 工厂）：

```ts
  it('声明 storage 的模块：投影中间件把平台默认注入模块 API 子树（未声明则恒 undefined）', async () => {
    cleanupModules.push('storagemod', 'plainmod')
    const modulesDir = await newModulesDir()
    await writeStorageFixtures(modulesDir)

    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const app = new Hono<TestEnv>()
    app.use('*', injectIdentity([]))
    runtime.mount(app)

    // ① 平台 env 完整 ⇒ 注入（且**只有五个键**，没有 TenantRow 的任何别的字段）
    const saved = { ...process.env }
    process.env.AFTERSALES_ZOS_ENDPOINT = 'zos.xinan1.ctyun.cn'
    process.env.AFTERSALES_ZOS_REGION = 'xinan1'
    process.env.AFTERSALES_ZOS_BUCKET = 'platform-bucket'
    process.env.AFTERSALES_ZOS_ACCESS_KEY = 'AKIAPLAT'
    process.env.AFTERSALES_ZOS_SECRET = 'sk-platform'
    try {
      const on = await app.request('/api/modules/storagemod/ping')
      expect(await on.json()).toEqual({
        storage: {
          kind: 's3',
          endpoint: 'https://zos.xinan1.ctyun.cn',
          region: 'xinan1',
          bucket: 'platform-bucket',
          accessKeyId: 'AKIAPLAT',
          secretAccessKey: 'sk-platform',
        },
      })
      // ② 未声明 storage 的模块：同一个 handler 拿不到（「不声明 = 拿不到」，与未声明路径不可达同构）
      const off = await app.request('/api/modules/plainmod/ping')
      expect(await off.json()).toEqual({ storage: null })
    } finally {
      for (const k of ['ENDPOINT', 'REGION', 'BUCKET', 'ACCESS_KEY', 'SECRET']) {
        if (saved[`AFTERSALES_ZOS_${k}`] === undefined) delete process.env[`AFTERSALES_ZOS_${k}`]
        else process.env[`AFTERSALES_ZOS_${k}`] = saved[`AFTERSALES_ZOS_${k}`]
      }
      // ③ env 缺任一 ⇒ 不 set（声明了也拿不到 —— 「没有平台默认」是确定状态）
      delete process.env.AFTERSALES_ZOS_BUCKET
      const incomplete = await app.request('/api/modules/storagemod/ping')
      expect(await incomplete.json()).toEqual({ storage: null })
    }
  })
```

> **注入面断言必须含「只有五个键」**：用 `toEqual` 逐键相等（不是 `toMatchObject`）——
> 后者的宽松恰好会放过「顺手把整个 `TenantRow` 塞进去」这个**正典点名要防**的错误。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run src/loader.test.ts -t "投影中间件"`
Expected: FAIL —— `storage` 恒为 `null`（宿主还没挂投影）。

- [ ] **Step 3: 建 `apps/server/src/tenant-storage.ts`（本任务只做平台默认分支）**

```ts
// tenant-storage.ts — 租户行 → 模块可用的存储配置（**纯函数、零 IO**）。
//
// 为什么是宿主做投影而不是模块自己去查租户行：B1（模块只许自身 schema）+ 正典「安全性质」第 1 条
// （模块没有任何途径指定 org）。宿主是唯一能同时看见 `platform.tenant` 与模块上下文的地方。
//
// 零额外 DB 往返：租户行本来就已被请求链的租户中间件取过（apps/server/src/tenant.ts 的 `select t.*`），
// 这里只是把它**投影**成窄值 —— 不 new 连接、不发查询。
import { platformStorageFromEnv, type TenantStorageConfig } from '@platform/sdk'
import type { TenantRow } from './tenant'

/**
 * 本任务（正典步 2）只有平台默认分支：租户行上还没有配置列可读。
 * T5 会补上「租户行优先、env 兜底」的三态判定（全空 / 部分填 / 全填）——**只改这一个函数**。
 */
export function resolveTenantStorage(_row: TenantRow | undefined): TenantStorageConfig | undefined {
  return platformStorageFromEnv(process.env) ?? undefined
}
```

- [ ] **Step 4: loader 挂中间件**

`apps/server/src/loader.ts` 的 `mount()` 内，`app.use(base + '/*', gate)`（**442**）之后、
`app.route(base, m.router)`（**444**）之前插入：

```ts
        // 存储投影（M3c，正典「租户级配置注入」）：**只对声明了 storage 的模块**挂。
        //   · 位置是硬约束：必须在启用闸门之后（停用模块该拿 404 就先拿 404，不必先花代价解配置）、
        //     在 app.route **之前**（Hono 里 handler 先注册、use 后注册 ⇒ 中间件**永不执行**——
        //     顺序错了的表现是模块 c.get(TENANT_STORAGE) 恒 undefined，代码里看不出问题）。
        //   · 它不是门卫：不做鉴权、不返回 403，只做投影。「宿主施加门禁」与「宿主注入材料」是两件事。
        //   · 无租户上下文 ⇒ 不 set（放行给后续层）。真实链路上租户中间件先于一切业务路由，
        //     这里见到无租户只可能是测试壳或未过租户中间件的装配。
        //   · 不声明就不挂 ⇒ 模块拿到的恒 undefined（与「未声明路径 = 不可达」同构）。
        if (m.manifest.storage) {
          const project: MiddlewareHandler<MountEnv> = async (c, next) => {
            const cfg = resolveTenantStorage(c.get('tenant') as TenantRow | undefined)
            // 不 set 时不「清理旧值」：Hono 的 context 是**每请求**新建的，不存在跨请求残留。
            if (cfg) c.set(TENANT_STORAGE, cfg)
            await next()
          }
          app.use(base + '/*', project)
        }
```

导入行补：`TENANT_STORAGE`（`@platform/sdk` 的值导出）与 `resolveTenantStorage`（`./tenant-storage`）。

- [ ] **Step 5: `aftersales` 声明 `storage` + 模块测试断言**

`modules/aftersales/manifest.yaml` 在 `guest:` 一行之后插入：

```yaml
# 租户级存储（M3c，正典「租户级配置注入」）：声明 = 宿主在本模块的 API 子树上按请求注入
# c.get(TENANT_STORAGE)。不声明就没有——声明的是**能力**，不是租户（manifest 里写不出 bucket/AK/org）。
storage: { kind: s3 }
```

`modules/aftersales/module.test.ts` 的「manifest 过 schema」用例里加一条（同文件、同一条用例内）：

```ts
    expect(m.storage).toEqual({ kind: 's3' })
```

- [ ] **Step 6: 跑测试确认通过**

Run:
```bash
cd apps/server && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run src/loader.test.ts
cd modules/aftersales && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run module.test.ts
```
Expected: PASS。**特别确认 `loader.test.ts` 既有用例一条没红**——未声明 `storage` 的 fixture 模块
行为必须与改动前逐字相同（这正是「加而不改」的机检面）。

- [ ] **Step 7: 跑全量门禁（本波收口）**

Run: `pnpm typecheck && pnpm test && pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs && pnpm exec tsx scripts/check-env-example.mjs`
Expected: 全绿。**这是步 2 的上线判据**（外加 `pnpm --filter @platform/web build && pnpm --filter @aftersales/mobile build && pnpm smoke`，
smoke 需要这两个 dist 与可连的 PG）。

- [ ] **Step 8: 提交（步 2 合并点）**

```bash
git add apps/server/src/tenant-storage.ts apps/server/src/loader.ts apps/server/src/loader.test.ts \
        modules/aftersales/manifest.yaml modules/aftersales/module.test.ts
git commit -m "feat(server): 模块子树投影租户存储配置——env 作平台默认（M3c 步 2）(#101)"
```

> **步 2 的上线验收（生产零变化）**：合并部署后，`aftersales` 附件端点的三种表现必须与部署前
> **逐字相同**（env 完整 ⇒ 201/200 + 同一个桶的预签名 URL；env 缺键 ⇒ 503 `ZOS_NOT_CONFIGURED`）。
> 判据是**行为对比**，不是「流水线绿」（`deploy-verify.md`：流水线全绿 ≠ 部署成功）。

---

## Wave 2（正典步 3：租户行列 + 管理端配置面）

> **本波的合并后状态**：五列存在、管理端可写；投影开始读租户行。**生产行为仍然零变化**——
> 因为**消费者还没切换**（`aftersales` 此刻仍在用装载期 env 常量，不读 context 键）。
> ⚠️ 由此产生一个**运营窗口**：配置页能保存，但保存的配置在步 4 上线前**不生效**。
> **已裁定处置（待拍板 2 → (B)，2026-09-17）：T7 不随步 3 合并、跟步 4 一起上**——
> 见「分步可上线性与回滚点」节的修正 ②。

### Task 4: `platform.tenant` 加五列 + `TenantRow`

**Files:**
- Create: `apps/server/src/migrations/006_tenant_storage.sql`
- Modify: `apps/server/src/tenant.ts`（`TenantRow`）

**Interfaces:**
- Produces: `platform.tenant` 五列（`storage_endpoint` / `storage_region` / `storage_bucket` /
  `storage_access_key` / `storage_secret`）+ `TenantRow` 上同名的五个 `string | null` 字段。
  `select t.*`（`tenant.ts:65`）/ `select *`（`tenant.ts:55`）**零改动**自动带出。

- [ ] **Step 1: 写迁移**

`apps/server/src/migrations/006_tenant_storage.sql`（**照 005 的范式**：幂等、`add column if not exists`、
允许 NULL、注释说清「不配 ⇒ 什么」）：

```sql
-- 006_tenant_storage.sql — 租户级存储配置（M3c，售后 spec §2.3 目标形态 / 正典「租户级配置注入」）
--
-- 与 wecom 三参（003/004）、公众号两键（005）同桶：multi 下每个租户自己的桶。
-- 语义（裁定 4，fail-explicit）：
--   五列**全空**   ⇒ 该租户未配 ⇒ 宿主注入**平台默认**（进程 env 五键；env 缺任一 ⇒ 不注入）
--   **部分填写**   ⇒ 视为「配置存在但无效」⇒ **不注入**（绝不回落平台桶 —— 回落 = 数据位置误述 + 成本事故）
--   五列全填     ⇒ 注入该租户自己的配置
-- 允许 NULL（而不是 not null default ''）：`select *` 带出的 null 与「没配」是同一件事，
-- 且与 005 的既有时态一致。判定「全空 / 部分 / 全填」的实现只有一处（tenant-storage.ts）。
--
-- ⚠️ `storage_secret` 与 AK 是**密钥型**：绝不回显、绝不进日志 / audit / CHANGELOG。
-- ⚠️ 改了这五列**不会**自动让配置生效于 single 部署：single 的租户行有 60s 进程内缓存
--    （apps/server/src/tenant.ts 的 ORG_CACHE_TTL_MS），生效窗口最长 60s。
--
-- 幂等：本仓部署每次全量重跑迁移（migrate.ts 按 platform.schema_migrations 记账去重，
-- 重复执行同一文件不会再来一次；但文件本身仍按 `if not exists` 写成可重复的）。
alter table platform.tenant add column if not exists storage_endpoint     text;
alter table platform.tenant add column if not exists storage_region       text;
alter table platform.tenant add column if not exists storage_bucket       text;
alter table platform.tenant add column if not exists storage_access_key   text;
alter table platform.tenant add column if not exists storage_secret       text;
```

- [ ] **Step 2: `TenantRow` 加字段**

`apps/server/src/tenant.ts` 的 `wechat_oa_secret` 之后插入：

```ts
  /** 租户级存储配置（M3c，006）。五列**全空** ⇒ 未配（宿主注入平台默认）；**部分填写** ⇒ 不注入。 */
  storage_endpoint: string | null
  storage_region: string | null
  storage_bucket: string | null
  storage_access_key: string | null
  storage_secret: string | null
```

- [ ] **Step 3: 同步那个手写字面量（`TenantRow` 的唯一替身）**

`apps/server/src/routes/admin.test.ts:75` 的 `baseTenant` 是**手写的 `TenantRow` 字面量**——接口加字段
它必然 TS 报错（这正是 #68 记的那件事：**替身比真机窄**，那次的症状是「后加的两列没跟上」）。

```ts
  // 五列存储配置（M3c）：本组用例要改它们 ⇒ 字面量必须写全，缺一个就 TS2741
  storage_endpoint: null, storage_region: null, storage_bucket: null,
  storage_access_key: null, storage_secret: null,
```

> 其余 `TenantRow` 的来源都是**真库 `select *`**（`loader.test.ts` 的 `acmeTenant()`、`tenant.test.ts`）
> ⇒ 加列后自动带出，**不需要改**。全仓手写字面量只有这一处（`grep -rn "wechat_oa_app_id: null"` 只命中它）。
> 另：`scripts/provision-tenant.mjs` 的租户 upsert 是**条件式列清单**（给了才写那两列）
> ⇒ 新增可空列**不影响它**，其测试（断言列清单文本）也不需要动——已在 `scripts/provision-tenant.test.ts:58-77`
> 核对过。

- [ ] **Step 4: 跑迁移相关测试 + typecheck 确认幂等与形状**

Run:
```bash
cd apps/server && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run src/migrate.test.ts src/loader.test.ts src/routes/admin.test.ts
pnpm typecheck
```
Expected: PASS。另跑一条**真库对账**（确认列真的在，且 `select *` 带得出来）：

```bash
psql "$DATABASE_URL" -c "\d platform.tenant" | grep storage_
```
Expected: 五行 `storage_*  | text |`。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/migrations/006_tenant_storage.sql apps/server/src/tenant.ts \
        apps/server/src/routes/admin.test.ts
git commit -m "feat(server): platform.tenant 加存储五列（M3c 步 3）(#101)"
```

---

### Task 5: 投影升级为「租户行优先 + env 兜底」（三态判定）

**Files:**
- Modify: `apps/server/src/tenant-storage.ts`（唯一函数体）
- Modify: `apps/server/src/loader.test.ts`

**Interfaces:**
- Consumes: T1 的 `platformStorageFromEnv` / `TenantStorageConfig`；T4 的 `TenantRow` 五字段。
- Produces: `resolveTenantStorage(row)` 的**完整三态语义**（正典兜底表逐行）：
  | 租户行 | 返回 |
  |---|---|
  | 五列全空（含 `null` / 空串 / 纯空白） | 平台默认（env 缺任一 ⇒ `undefined`） |
  | 部分填写 | **`undefined`**（不注入，**绝不**回落） |
  | 五列全填 | 该租户的配置（`endpoint` 过 `normalizeEndpoint`） |
  | `row` 为 `undefined` | 平台默认（与全空同处理：无租户上下文时行为不变） |

- [ ] **Step 1: 写失败的测试（三态 + 边界，逐个断言）**

追加到 `apps/server/src/loader.test.ts`（或与 T3 同一条用例内合并；**建议独立用例**，便于定位）：

```ts
  it('投影三态：全空 ⇒ 平台默认；部分填 ⇒ 不注入（绝不回落）；全填 ⇒ 用租户的', async () => {
    cleanupModules.push('storagemod', 'plainmod')
    const modulesDir = await newModulesDir()
    await writeStorageFixtures(modulesDir)   // ← T3 Step 1 把该 fixture 工厂提到 describe 作用域，两个用例共用
    const runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactoryFor() })
    const app = new Hono<TestEnv>()
    runtime.mount(app)

    const acme = await acmeTenant()             // 该文件既有 helper：取 seed 的 acme 整行
    const withTenant = (row: TenantRow) =>
      createMiddleware<TestEnv>(async (c, next) => { c.set('tenant', row); await next() })

    const read = async (row: TenantRow | undefined) => {
      const a = new Hono<TestEnv>()
      if (row) a.use('*', withTenant(row))
      a.use('*', injectIdentity([]))
      runtime.mount(a)
      return (await (await a.request('/api/modules/storagemod/ping')).json()).storage
    }

    // ① 全空（本任务前的真实状态：五列都是 null）⇒ 平台默认
    expect(await read(acme)).toMatchObject({ bucket: 'platform-bucket' })

    // ② 部分填写 ⇒ undefined，**且绝不等于平台桶**（这条断言是裁定 4 的全部内容）
    const partial = { ...acme, storage_endpoint: 'https://zos.tenant.test', storage_bucket: 'tenant-b1' }
    expect(await read(partial)).toBeNull()
    expect(await read(partial)).not.toMatchObject({ bucket: 'platform-bucket' })

    // ③ 全填 ⇒ 用租户的（endpoint 带空格与尾斜杠也被规范化）
    const full = {
      ...acme,
      storage_endpoint: '  zos.tenant.test/  ',
      storage_region: 'xinan1',
      storage_bucket: 'tenant-b1',
      storage_access_key: 'AKIATENANT',
      storage_secret: 'sk-tenant',
    }
    expect(await read(full as TenantRow)).toEqual({
      kind: 's3', endpoint: 'https://zos.tenant.test', region: 'xinan1',
      bucket: 'tenant-b1', accessKeyId: 'AKIATENANT', secretAccessKey: 'sk-tenant',
    })

    // ④ 平台 env 不全 + 租户全空 ⇒ undefined（「没有平台默认」是确定状态，不是半成品）
    delete process.env.AFTERSALES_ZOS_BUCKET
    const empty = { ...acme }   // 五列本就是 null
    expect(await read(empty)).toBeNull()
    process.env.AFTERSALES_ZOS_BUCKET = 'platform-bucket'   // 复原（与 T3 的 save/restore 同一手法）

    // ⑤ 注入值**不含 TenantRow 的任何别的字段**（正典点名：wecom/公众号密钥绝不外泄）
    const injected = await read(full as TenantRow)
    expect(Object.keys(injected).sort()).toEqual(
      ['accessKeyId', 'bucket', 'endpoint', 'kind', 'region', 'secretAccessKey'],
    )
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/loader.test.ts -t "投影三态"`
Expected: FAIL —— ② 部分填写当前仍回平台默认（这正是要修的缺陷面）。

- [ ] **Step 3: 实现三态判定**

`apps/server/src/tenant-storage.ts` 的 `resolveTenantStorage` 整体替换：

```ts
/**
 * 三态判定（正典兜底表，**照抄不许改**）：
 *   全空     ⇒ 平台默认（env 五键；缺任一 ⇒ undefined = 「没有平台默认」）
 *   部分填写 ⇒ **undefined**（不注入）。⚠️ 绝不回落平台桶 —— 回落不是容错，是**把红改成绿**：
 *              租户以为附件落在自己的桶、实际落在平台桶 ⇒ 数据位置被误述 + 平台替租户承担成本。
 *  全填     ⇒ 该租户的配置。
 *
 * 「空」的判据包含 `null` / `''` / 纯空白（管理端表单与手改库都容易留下这些）——统一 trim 后判空，
 * 且 **trim 后的值才进配置**（粘进一个尾随空格不该让 endpoint 变成另一个主机名）。
 */
export function resolveTenantStorage(row: TenantRow | undefined): TenantStorageConfig | undefined {
  const platformDefault = platformStorageFromEnv(process.env) ?? undefined
  if (!row) return platformDefault

  const raw = [row.storage_endpoint, row.storage_region, row.storage_bucket,
    row.storage_access_key, row.storage_secret].map((v) => (v ?? '').trim())
  const filled = raw.filter((v) => v !== '').length
  if (filled === 0) return platformDefault        // 未配 ⇒ 平台默认
  if (filled < raw.length) return undefined       // 部分填写 ⇒ 不注入（fail-explicit）

  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = raw as [string, string, string, string, string]
  return { kind: 's3', endpoint: normalizeEndpoint(endpoint), region, bucket, accessKeyId, secretAccessKey }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && DATABASE_URL=… pnpm vitest run src/loader.test.ts`
Expected: PASS（含 T3 的用例与既有全部用例）。

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/tenant-storage.ts apps/server/src/loader.test.ts
git commit -m "feat(server): 存储投影三态判定——部分填写绝不回落平台桶（M3c 步 3）(#101)"
```

---

### Task 6: 附件行加 `storage_ref`

**Files:**
- Create: `modules/aftersales/migrations/003_attachment_storage_ref.sql`

**Interfaces:**
- Produces: `aftersales.ticket_attachment.storage_ref text not null default ''`。
  本任务**只加列**（写入路径在 T8）——加列本身零行为变化。

- [ ] **Step 1: 写迁移**

```sql
-- 003_attachment_storage_ref.sql — 附件行记录「写入当时的配置标识」（M3c 裁定 ②）
--
-- 为什么需要它：预签名用的是**当次请求解析出的配置**，而行上只有 object_key。租户的存储配置一旦
-- 变化（未配 → 配了自己的桶 / 换桶 / 换 AK 对应账号 / 回滚清空配置），存量行的下载链接就会指向**新桶**
-- ⇒ NoSuchKey；客户端表现为「附件打不开」，而平台侧**静默**（预签名是纯本地计算，平台发不出这个错）。
--
-- 列的形状：`<kind>|<endpoint>|<bucket>`，由平台 SDK 的 `storageRefOf()` 生成
-- （唯一的生成器，宿主与模块共用 —— 两处实现 = 两份事实源，失败形态是静默的）。
-- **不含 AK/SK**：轮换 AK 不该让存量行失去归属（裁定②定的最小可用是 bucket + endpoint）。
--
-- 空串的语义（**给存量行的定义，不是猜测**）：
--   ''  = 「本列引入之前写入的行」。本列引入前唯一存在的配置就是**平台 env 五键**（M2a 的单租户形态），
--         故读侧把 '' 当作**平台默认**解析（见 modules/aftersales/storage.ts 的 storageResolverFor）。
--   注意迁移器（apps/server/src/migrate.ts）跑在**数据库里**、读不到 env ⇒ 回填**不写真实桶名**：
--         写死一个桶名等于造第二份事实源（env 换了桶，库里还是旧名）。这是有意的取舍。
--
-- 回填口径的实测底数：生产库当前 ticket_attachment 为 **0 行**（售后 spec §5 #12 实测），
--   故这是**定义性回填**、无实际行可写。若某个部署确有存量行且其平台 env 的桶后来被换过，
--   那些行将读不出来 —— 与 spec §2.3 已承认的边界同类（凭据/位置的历史无法凭空重建）。
--
-- 不加索引：读取一律按 (org, id) / (org, ticket_id) 走既有索引，storage_ref 只参与**相等比较**、
--   从不作为过滤条件。加索引是给一个不存在的查询写保险。
--
-- 幂等：not null + default 让存量行直接得到 ''（PG 11+ 加带默认值的列是元数据操作，不重写表）。
alter table aftersales.ticket_attachment
  add column if not exists storage_ref text not null default '';
```

- [ ] **Step 2: 跑迁移测试确认幂等 + 累积终态**

Run:
```bash
cd modules/aftersales && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run module.test.ts
cd ../../ && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/check-tenant-isolation.mjs
```
Expected: PASS + `check-tenant-isolation: OK`（该门禁按**累积终态**判建表是否有 `org`；本迁移只加列、
不建表 ⇒ 不受影响。这条要**跑一遍**确认，别靠推理）。

- [ ] **Step 3: 提交**

```bash
git add modules/aftersales/migrations/003_attachment_storage_ref.sql
git commit -m "feat(aftersales): 附件行加 storage_ref——记录写入当时的配置标识（M3c 步 3）(#101)"
```

---

### Task 7: 管理端配置面（读 / 写 / 测试连接 / 清除）+ 配置页

**Files:**
- Create: `apps/server/src/storage-probe.ts`
- Modify: `apps/server/src/routes/admin.ts`、`apps/server/src/routes/admin.test.ts`
- Modify: `apps/server/package.json`（+ 根 `pnpm-lock.yaml`）
- Modify: `apps/web/src/lib/api.ts`、`apps/web/src/pages/console-menu.ts`、`apps/web/src/App.tsx`
- Create: `apps/web/src/pages/admin/Storage.tsx`、`apps/web/src/pages/admin/Storage.test.tsx`

**Interfaces:**
- 端点（全部落在既有 `/api/platform/admin/*` 的 `requireScope('tenant:admin')` + 写操作 CSRF 之内）：
  - `GET /storage` → `200 { configured: boolean; partial: boolean; endpoint: string; region: string;
    bucket: string; accessKeyIdMasked: string; platformFallback: boolean }`
    （`configured=false` ⇒ 该租户未配、走平台默认；`partial=true` ⇒ 库里是半套、附件一定不可用；
    **secret 一律不回显**，连字段都不出现）
  - `PUT /storage` → body `{ endpoint, region, bucket, accessKeyId?, secretAccessKey? }`
    （**AK/SK 留空 = 保持原值**；未配过且留空 ⇒ `400 {error:'INCOMPLETE'}`）
    → 保存前探测；失败 `400 {error:'STORAGE_PROBE_FAILED', reason, detail}`；成功 `200 {ok:true}`
  - `POST /storage/test` → 同 body 形状，**不写库** → `200 {ok:true}` / `400 {...同上}`
  - `DELETE /storage` → 清空五列（回落平台默认）→ `200 {ok:true}`
- Produces（前端）：`getAdminStorage` / `saveAdminStorage` / `testAdminStorage` / `clearAdminStorage`。

- [ ] **Step 1: 加依赖（**已裁定：待拍板 1 → (A)，2026-09-17——不是待决项**）

```bash
pnpm --filter @platform/server add @aws-sdk/client-s3@^3.700.0
```

> 版本**与 `modules/aftersales` 同一主版本**（`^3.700.0`）：两套 AWS SDK 的行为分叉
> （重试 / 错误形状）会让「探测说 OK、真传失败」这类问题极难查。
>
> ✅ **已裁定（待拍板 1 → (A)，2026-09-17），且 architecture-first 的「先改文档」那一步已完成**：
> `docs/architecture.md` §2 的依赖表已记上这条依赖边 + §2.1 写明「为什么是宿主」。**本步不再需要等人拍板。**
> ⚠️ 附带一条**分开记**的事实：这一步使 `apps/server` 成为**第二个 S3 消费者** ⇒ spec §2.3 / §9
> 的「第二个消费者出现再抽公共包」**判据到点**，但**本次没有抽**（`ZosStorage` 仍在
> `modules/aftersales/storage.ts`）。抽取是**下一个、尚未决策**的动作——见 `docs/architecture.md` §2.1。

- [ ] **Step 2: 写探测模块**

`apps/server/src/storage-probe.ts`：

```ts
// storage-probe.ts — 存储配置的连通性探测（HeadBucket）。**只在请求路径之外调用**（裁定 5）。
//
// 为什么必须存在：预签名（SigV4）是**纯本地计算、不发网络请求** ⇒ 宿主**永远无法**在请求路径上发现
// 「配置存在但连不上」。那种错误只在客户端拿预签名 URL 直连对象存储时出现，平台侧零日志、零告警、各处都绿。
// ⇒ 探测点是**唯一**能在平台侧发现配置错的位置：管理端保存时（拒绝保存）+ 显式「测试连接」（事后场景：
// 桶被删 / AK 轮换 / 网络策略变更）。
//
// 为什么**不**在请求路径上探测：每请求一次网络往返，会把存储侧的抖动**放大成平台 5xx**，
// 且把一个可选依赖变成硬依赖。
//
// 超时是主动设的手段，不是默认值：管理端「保存」是同步等待，没有上界 = 页面挂到网关超时。
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import type { TenantStorageConfig } from '@platform/sdk'

/** 失败档（有限枚举）。**为什么分类而不是透传**：回给前端的东西里不许有任何凭据/URL 细节。 */
export type ProbeFailure = {
  reason: 'TIMEOUT' | 'DNS' | 'TLS' | 'CONNECT' | 'HTTP_403' | 'HTTP_404' | 'HTTP_OTHER' | 'UNKNOWN'
  detail: string
}
export type ProbeResult = { ok: true } | ({ ok: false } & ProbeFailure)

const CONNECT_TIMEOUT_MS = 3_000
const REQUEST_TIMEOUT_MS = 5_000

export async function probeStorage(cfg: TenantStorageConfig): Promise<ProbeResult> {
  // 具体选项名随 @aws-sdk 版本演进（v3 走 requestHandler / NodeHttpHandler）——
  // 实现时以**装上的那一版**为准核对，别照抄记忆；超时必须同时压 connection 与 request 两段。
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    forcePathStyle: true,   // 与 modules/aftersales/storage.ts 同一口径（ZOS 实测要求 path-style）
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  })
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
    return { ok: true }
  } catch (err) {
    return { ok: false, ...classify(err, cfg) }
  } finally {
    client.destroy()
  }
}

/** 分类：把 SDK 的错误收成**有限的几档**。理由不是整洁——是**回给前端的东西里不许有任何凭据**，
 *  而 SDK 的原始 message 可能带上 URL 细节。原始 message 只进服务端日志。 */
function classify(err: unknown, cfg: TenantStorageConfig): ProbeFailure {
  // 按**真实错误**映射（不要只判 message.includes）：
  //   TimeoutError / 超时 abort        → 'TIMEOUT'
  //   err.code === 'ENOTFOUND'         → 'DNS'
  //   err.code === 'ECONNREFUSED'      → 'CONNECT'
  //   err.code 以 'CERT_'/'UNABLE_TO' 开头（TLS 校验失败）→ 'TLS'
  //   $metadata.httpStatusCode 403/404 → 'HTTP_403' / 'HTTP_404'；其余 4xx/5xx → 'HTTP_OTHER'
  //   其余 → 'UNKNOWN'
  // detail 只放 `<endpoint 的 host>: <HTTP 状态或错误码>`，**不放 SDK 原文**。
}
```

- [ ] **Step 3: 写路由（四端点）**

`apps/server/src/routes/admin.ts` 的 `writeAudit` 动作联合类型加
`'admin.storage.update' | 'admin.storage.clear'`，并在文件末尾（`subscriptions` 之后）追加：

```ts
  // ---- 租户级存储配置（M3c，正典「租户级配置注入」）----
  //
  // org 锁、scope 门禁、写操作 CSRF 三道结构锁由本文件顶部三条中间件统一施加 —— 这里不重复实现。
  // 敏感值纪律：secret **绝不回显**；AK 只回掩码；audit 只记 endpoint + bucket（不含任何凭据）。
  app.get('/storage', async (c) => {
    const t = c.get('tenant')
    const cols = [t.storage_endpoint, t.storage_region, t.storage_bucket,
      t.storage_access_key, t.storage_secret].map((v) => (v ?? '').trim())
    const configured = cols.every((v) => v !== '')
    return c.json({
      configured,
      // 部分填写在**读**这一侧也如实暴露：管理端要能看见「库里是半套」这个事实（否则用户只会看到 503）
      partial: cols.some((v) => v !== '') && !configured,
      endpoint: cols[0], region: cols[1], bucket: cols[2],
      accessKeyIdMasked: cols[3] === '' ? '' : cols[3].slice(0, 4) + '****',
      platformFallback: await platformFallbackAvailable(deps.pool), // env 五键是否齐全
    })
  })

  app.put('/storage', async (c) => { /* 校验 → 合并留空字段 → probeStorage → 失败 400 → 成功 UPDATE + audit */ })
  app.post('/storage/test', async (c) => { /* 同 body 解析与合并，只 probe，不写库 */ })
  app.delete('/storage', async (c) => { /* 五列置 null + audit 'admin.storage.clear' */ })
```

要点（实现时逐条落实）：
- **留空 = 保持原值**：`accessKeyId` / `secretAccessKey` 为空串或缺失 ⇒ 取库里现值；库里也是空 ⇒
  `400 {error:'INCOMPLETE'}`（不静默存半套——**fail-explicit 的第一道门**）。
- 保存前**先把五元组凑齐再探测**，探测通过才写 —— 顺序反了会出现「库里有配置、但探测没过」的中间态。
- 失败回 `400 { error: 'STORAGE_PROBE_FAILED', reason, detail }`，`detail` 里**只有** endpoint host 与
  HTTP 状态码。原始错误进 `console.warn`（含 tenant id，不含凭据）。
- `platformFallback` 用一个**不读 env 的**等价判定：注入侧的实现只有一处（`resolveTenantStorage`），
  路由侧复用 `platformStorageFromEnv(process.env) !== null` 即可（同一个 SDK 函数，不是第二份实现）。

- [ ] **Step 4: 写后端测试**

`apps/server/src/routes/admin.test.ts` 补一组用例。**先看清该文件的 harness**（它和别的测试文件
不一样，别照 `loader.test.ts` 的形状写）：

- 租户行是**模块级常量 `baseTenant`**（`:69`）注入的，GET 读的是它、**不是库** ⇒ 「库里存了什么」
  在用例里 = 改 `baseTenant` 的字段（**必须配 `afterEach` 把五列复位成 `null`**，否则用例互相污染）；
- `fakePool()`（`:53-66`）把所有 `pool.query` 记进 `audits` 台账并回 `{rows: []}` ⇒ **断言写库**
  要看台账里那条 `update platform.tenant …` 的 params，**不是**去查库；
- 请求走 `mount(deps(), { scopes: ['tenant:admin'] }).request('/api/platform/admin/…')`，
  写操作带文件里现成的 `withCsrf`。

```ts
  // ---- 租户级存储配置（M3c）----
  // ⚠️ baseTenant 是模块级常量：本组用例改它的五列，afterEach 必须复位（否则污染后续用例）。
  afterEach(() => {
    for (const k of ['storage_endpoint', 'storage_region', 'storage_bucket', 'storage_access_key', 'storage_secret'] as const) {
      baseTenant[k] = null
    }
  })

  const STORAGE = { endpoint: 'zos.acme.test', region: 'xinan1', bucket: 'b1', accessKeyId: 'AKIATEST', secretAccessKey: 'sk-test' }
  /** 台账里那条 UPDATE 的 params（写库的唯一观测口 —— fakePool 不真写） */
  const updateParams = (audits: Array<{ sql: string; params: unknown[] }>) =>
    audits.find((q) => /update\s+platform[.]tenant/i.test(q.sql) && /storage_endpoint/i.test(q.sql))?.params

  it('GET /storage：未配 ⇒ configured=false、partial=false；**响应体里没有 secret 字段**', async () => {
    const res = await mount(deps(), { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage')
    const body = await res.json()
    expect(body).toMatchObject({ configured: false, partial: false, endpoint: '', region: '', bucket: '', accessKeyIdMasked: '' })
    expect(Object.keys(body)).not.toContain('secretAccessKey')   // 字段不存在，不是「有但空」
    expect(JSON.stringify(body)).not.toContain('sk-')            // 任何形态的密钥都不该出现
  })

  it('GET /storage：部分填写 ⇒ partial=true（读侧如实暴露「库里是半套」，否则用户只看到 503）', async () => {
    baseTenant.storage_endpoint = 'https://zos.acme.test'
    baseTenant.storage_bucket = 'b1'                              // 只填两列
    const body = await (await mount(deps(), { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage')).json()
    expect(body).toMatchObject({ configured: false, partial: true, endpoint: 'https://zos.acme.test', bucket: 'b1' })
  })

  it('GET /storage：已配 ⇒ AK 只回掩码（前 4 位 + ****）、secret 仍不出现', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.acme.test', storage_region: 'xinan1', storage_bucket: 'b1',
      storage_access_key: 'AKIATEST', storage_secret: 'sk-test',
    })
    const body = await (await mount(deps(), { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage')).json()
    expect(body).toMatchObject({ configured: true, partial: false, accessKeyIdMasked: 'AKIA****' })
    expect(JSON.stringify(body)).not.toContain('sk-test')
  })

  it('PUT /storage：探测失败 ⇒ 400 STORAGE_PROBE_FAILED 且**库里纹丝不动**（写入必须在探测之后）', async () => {
    const d = deps()
    d.probe = async () => ({ ok: false, reason: 'HTTP_403', detail: 'zos.acme.test: 403' })
    const res = await mount(d, { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage', { method: 'PUT', headers: withCsrf, body: JSON.stringify(STORAGE) })
    expect(res.status).toBe(400)
    expect((await res.json())).toMatchObject({ error: 'STORAGE_PROBE_FAILED', reason: 'HTTP_403' })
    expect(updateParams(d.audits)).toBeUndefined()   // 一条 UPDATE 都没发出
  })

  it('PUT /storage：成功 ⇒ 五列落库（AK/SK 都在 params 里）+ 一条不含密钥的 audit', async () => {
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage', { method: 'PUT', headers: withCsrf, body: JSON.stringify(STORAGE) })
    expect(res.status).toBe(200)
    expect(updateParams(d.audits)).toEqual([
      'https://zos.acme.test', 'xinan1', 'b1', 'AKIATEST', 'sk-test', /* tenantId */ 1,
    ])
    const audit = d.audits.find((q) => /insert into platform[.]audit/i.test(q.sql))
    expect(audit?.params.join(' ')).not.toContain('sk-test')     // 密钥绝不进 audit
  })

  it('PUT /storage：AK/SK 留空 ⇒ 保持原值（不是清空），且探测用的是**合并后**的值', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.old.test', storage_region: 'x', storage_bucket: 'old',
      storage_access_key: 'AKIAOLD', storage_secret: 'sk-old',
    })
    const d = deps()
    let probed: { secretAccessKey: string } | null = null
    d.probe = async (cfg) => { probed = cfg; return { ok: true } }
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ endpoint: 'https://zos.new.test', region: 'x', bucket: 'new' }),  // AK/SK 不传
    })
    expect(res.status).toBe(200)
    expect(probed!.secretAccessKey).toBe('sk-old')                // 用旧值探测
    expect(updateParams(d.audits)).toEqual(['https://zos.new.test', 'x', 'new', 'AKIAOLD', 'sk-old', 1])
  })

  it('PUT /storage：未配过且 AK/SK 留空 ⇒ 400 INCOMPLETE（绝不静默存半套）', async () => {
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ endpoint: 'https://zos.new.test', region: 'x', bucket: 'new' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INCOMPLETE')
    expect(updateParams(d.audits)).toBeUndefined()
  })

  it('POST /storage/test：不写库（台账里只有 GET 与 audit 之外没有 UPDATE）', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.old.test', storage_region: 'x', storage_bucket: 'old',
      storage_access_key: 'AKIAOLD', storage_secret: 'sk-old',
    })
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage/test', {
      method: 'POST', headers: withCsrf, body: JSON.stringify({ endpoint: 'https://zos.new.test', region: 'x', bucket: 'new' }),
    })
    expect(res.status).toBe(200)
    expect(updateParams(d.audits)).toBeUndefined()                // 探测不改库
  })

  it('DELETE /storage：五列置 null（步 5 回滚路径的机检）+ audit 动作是 admin.storage.clear', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.old.test', storage_region: 'x', storage_bucket: 'old',
      storage_access_key: 'AKIAOLD', storage_secret: 'sk-old',
    })
    const d = deps()
    const res = await mount(d, { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage', { method: 'DELETE', headers: withCsrf })
    expect(res.status).toBe(200)
    expect(updateParams(d.audits)).toEqual([null, null, null, null, null, 1])
    expect(JSON.stringify(d.audits.find((q) => /audit/i.test(q.sql))?.params)).toContain('admin.storage.clear')
  })

  it('写操作的 CSRF 由本文件既有的整路由中间件统一施加（存储端点不例外）', async () => {
    const res = await mount(deps(), { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(STORAGE),
    })
    expect(res.status).toBe(403)
  })
```

**另写一条不属于本文件的用例**（它要铸真 socket，`admin.test.ts` 的替身 harness 覆盖不到）：把
`probeStorage` 指向 `http://127.0.0.1:1`（必然连不上）⇒ `ok:false` 且 `reason` 落在 `CONNECT` 档。
放在 `apps/server/src/routes/admin.test.ts` **之外**——建议 `apps/server/src/storage-probe.test.ts`，
理由写在用例头：**它证明分类映射在真实错误上有效**，而不是只证明「我们写了一个 catch」。

```ts
// storage-probe.test.ts（真实网络栈，不桩）
it('连不上 ⇒ ok:false / reason=CONNECT（分类映射在真实错误上有效）', async () => {
  const r = await probeStorage({
    kind: 's3', endpoint: 'http://127.0.0.1:1', region: 'x', bucket: 'b',
    accessKeyId: 'a', secretAccessKey: 'b',
  })
  expect(r).toMatchObject({ ok: false, reason: 'CONNECT' })
})
```

- [ ] **Step 5: 前端 API 层**

`apps/web/src/lib/api.ts` 追加（走既有 `request` / `adminWrite`，**不新造通道**）：

```ts
export interface AdminStorage {
  configured: boolean
  partial: boolean
  endpoint: string
  region: string
  bucket: string
  accessKeyIdMasked: string
  platformFallback: boolean
}
export const getAdminStorage = () => request<AdminStorage>('/api/platform/admin/storage')
export const saveAdminStorage = (v: { endpoint: string; region: string; bucket: string; accessKeyId?: string; secretAccessKey?: string }) =>
  adminWrite<{ ok: true }>('/api/platform/admin/storage', 'PUT', v)
export const testAdminStorage = (v: { ...同 save }) =>
  adminWrite<{ ok: true }>('/api/platform/admin/storage/test', 'POST', v)
export const clearAdminStorage = () => adminWrite<{ ok: true }>('/api/platform/admin/storage', 'DELETE')
```

- [ ] **Step 6: 配置页（**动手前先读 UI 纪律**）**

UI 依据（本仓没有 `DESIGN.md`，`AGENTS.md` 也未指定设计文档 ⇒ 以既有实现为纪律）：
- `docs/superpowers/specs/2026-09-13-console-saas-ui-blueprint-design.md` §3/§4 ——
  菜单「管理」组的位置规则与范围收敛（**新页面要出现在菜单里，必须先落这一条**）。
- `apps/web/src/pages/admin/Subscriptions.tsx` + `Users.tsx` —— 平台内置管理页的**唯一范式**：
  `Card` + antd `Table`/`Form` + `App.useApp().message` 反馈 + `loading` 态。
- **前端零新增依赖**（M3 计划 Global Constraints 原文）；表格用 antd `Table`，勿引 ProTable。
- 管理组是**壳侧固定分组**（不走 registry 聚合）⇒ 改 `console-menu.ts` 的 `adminGroup` 即可，
  **不需要**动 `gen-console-registry.mjs`。

`apps/web/src/pages/admin/Storage.tsx` 的实质内容：

```
Card「存储配置」
  ├─ 顶部状态告示（三态，文案按裁定 1 的「启用 = 是否 BYO」口径）
  │    · configured=false, platformFallback=true  → 「未配置：本租户附件使用平台默认存储」
  │    · configured=false, platformFallback=false → Alert warning：「未配置且平台无默认 ⇒ 附件功能不可用（503）」
  │    · partial=true                              → Alert warning：「配置不完整 ⇒ 按 fail-explicit 不予使用（附件不可用）」
  ├─ Form（5 项：endpoint / region / bucket / accessKeyId / secretAccessKey）
  │    · AK 的 placeholder 为 accessKeyIdMasked，SK 的 placeholder 为「留空表示不修改」
  │    · 全部 Input.Password 之外，SK 用 Input.Password
  ├─ 操作行：[保存] [测试连接] [清除配置(Popconfirm)]
  └─ 说明文字（运维必须看到的三句）
       · 保存时会做一次连通性探测，探测不通过不会写入
       · 未配置 = 使用平台默认存储；配置后**新**附件写入你的桶（存量附件仍按其写入时的桶读取）
       · 生效窗口：single 部署下最长 60 秒（租户行有 60s 进程内缓存）
```

- [ ] **Step 7: 路由 + 菜单**

`apps/web/src/App.tsx` 加一行（照 admin 三条既有行的形状，仍在 `AdminGate` 之内）：

```tsx
        { path: 'admin/storage', element: <AdminGate><AdminStoragePage /></AdminGate> },
```

`apps/web/src/pages/console-menu.ts` 的 `adminGroup.children` 追加：

```ts
      { path: '/console/admin/storage', name: '存储配置' },
```

> 图标：本项**不设图标**（`MenuDataItem` 的 icon 可省），避免动 `CONSOLE_ICONS`
> （那份表要求图标名先登记才渲染——不设图标就不欠这笔账）。

- [ ] **Step 8: 前端测试**

`apps/web/src/pages/admin/Storage.test.tsx` 照 `Users.test.tsx` 的形状（mock `../../lib/api` +
`MemoryRouter` + `Outlet context` + `AntdApp`）写三条：未配置态渲染出「平台默认」文案；
保存成功后 `message.success` 且重新拉取；测试连接失败时把 `reason` 显示出来（**不是**「操作失败」四个字）。

Run: `pnpm --filter @platform/web test && pnpm --filter @platform/web build`
Expected: PASS。

- [ ] **Step 9: 跑全量门禁（本波收口）**

Run: `pnpm typecheck && pnpm test && pnpm --filter @platform/web build && pnpm exec tsx scripts/check-compose.mjs && pnpm exec tsx scripts/check-env-example.mjs`
Expected: 全绿（`check-compose` 要跑 —— 本任务动了 `apps/server/package.json`，确认没顺手碰 compose）。

- [ ] **Step 10: 提交**

```bash
git add apps/server/src/storage-probe.ts apps/server/src/routes/admin.ts apps/server/src/routes/admin.test.ts \
        apps/server/package.json pnpm-lock.yaml \
        apps/web/src/lib/api.ts apps/web/src/pages/admin/Storage.tsx apps/web/src/pages/admin/Storage.test.tsx \
        apps/web/src/pages/console-menu.ts apps/web/src/App.tsx
git commit -m "feat(admin): 租户级存储配置面——读写/测试连接/清除 + 保存时探测（M3c 步 3）(#101)"
```

---

## Wave 3（正典步 4：模块侧原子切换）

> 正典把步 4 定为**唯一的原子切换**：`aftersales` 的存储从「装载期常量」改为「按请求解析」，
> 没有中间态。**本波是唯一有生产行为变化的合并点**（且只对配了的租户变化）。

### Task 8: `aftersales` 按请求解析 + 写/读 `storage_ref`

**Files:**
- Modify: `modules/aftersales/storage.ts`、`index.ts`、`routes/context.ts`、`routes/attachment.ts`、
  `routes/ticket-manage.ts`
- Modify: `modules/aftersales/test-util.ts`
- Modify: `modules/aftersales/storage.test.ts`、`routes/attachment.test.ts`、`routes/ticket.test.ts`、
  `routes/registration-manage.test.ts`、`routes/registration-guest.test.ts`、`routes/registration-chain.test.ts`
- Modify: `modules/aftersales/README.md`（已知边界）

**Interfaces:**
- Consumes: `TENANT_STORAGE` / `TenantStorageConfig` / `normalizeEndpoint` / `storageRefOf` /
  `platformStorageFromEnv`（全部来自 `@platform/sdk`，T1 产出）。
- Produces（模块内）：
  - `storageFor(cfg: TenantStorageConfig): ZosStorage` —— **按配置指纹缓存的 client 池**（入参是**配置值**，
    不是 org —— 正典排除「按 org 的解析器」，见「读码核实 C」）。
  - `storageCandidatesFor(injected: TenantStorageConfig | undefined): StorageCandidates`
  - `storageResolverFor(cands: StorageCandidates): (ref: string) => ZosStorage | null`
  - `warnUnresolvedRef(org: string, ref: string): void`
  - `RouteCtx = { pool: Pool }`（**去掉** `storage`；`ZosStorage | null` 的旧形状消失）
  - `loadAttachments(ctx, org, ticketId, resolve)`（新第 4 参）

- [ ] **Step 1: 写失败的测试（模块层，先钉读侧四态）**

`modules/aftersales/routes/attachment.test.ts` 的改法（**注意 `test-util.ts` 的注入方式是前提**，
见 Step 5）：把 `vi.stubEnv(...)`（该文件 `:34-38` 与 `:49-51` 的两段注释一起）换成
`buildTestApp(mod, identity, { pool }, TENANT_CFG)`，并新增：

```ts
  // 三套配置常量（本文件顶部）：TENANT_CFG（租户桶）/ PLATFORM_CFG（env 平台桶，用 vi.stubEnv 造）
  const TENANT_REF = storageRefOf(TENANT_CFG)
  const PLATFORM_REF = storageRefOf(PLATFORM_CFG)

  /** 直插一行附件（**不走端点**）：写 storage_ref 正是本任务要验的东西，用被测端点自己造不出对照组。 */
  async function insertAttachment(org: string, ref: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(org, object_key, content_type, storage_ref)
       values ($1, $2, 'image/jpeg', $3) returning id`,
      [org, `aftersales/${org}/seed/${Date.now()}-${Math.floor(Math.random() * 1e6)}`, ref],
    )
    return Number(rows[0]!.id)
  }

  /** 读那一行（GET /attachments/:id 走 manage 壳，它判 scope aftersales:manage）。 */
  const readUrl = async (id: number) => {
    const res = await manage.request(`/attachments/${id}`)
    return { status: res.status, body: await res.json() as { url?: string; error?: string } }
  }
```

> 四条用例的**判据统一是「url 指向哪个桶/主机名」**（url 是 SigV4 的**纯本地计算**产物 ⇒
> 本地就能断言「用了哪套配置」，**不需要真桶**）：
> ① 一致 ⇒ `url.host === 'zos.tenant.test'` 且 `url.pathname` 含 `/tenant-b1/`；
> ② 行的 ref = `PLATFORM_REF`（模拟早期行）⇒ url 指向**平台**主机与桶，**不是**当前租户的；
> ③ 行的 ref = `'s3|https://zos.old.test|old-bucket'`（两边都对不上）⇒ **503 `STORAGE_REF_UNRESOLVED`**，
>    且断言**响应体里不含任何预签名 URL**（"不猜、不硬签"的机检）；
> ④ `buildTestApp(mod, identity, { pool })`（**不传第 4 参** = 未配存储）⇒ 503 `ZOS_NOT_CONFIGURED`。
> 另外把 `POST /guest/attachments` 的用例补一条：成功后**库里那行的 `storage_ref` = `TENANT_REF`**
> （读侧全靠它，写侧不记就等于没做）。

以及 `routes/ticket.test.ts`（工单详情）补两条：某个附件的 ref 解析不出来时
**该项 `url: null` 而其余项照常**（工单数据仍然可用 —— 这是既有降级语义，不是新引入的），
且该次请求**在服务端留下一条 warn**（用 `vi.spyOn(console, 'warn')` 断言，含 org 与 ref、不含密钥）。

关键断言写法（**url 是本地计算的产物，故可断言「用了哪套配置」而不需要真桶**）：

```ts
    const url = new URL(body.url)
    expect(url.host).toBe('zos.tenant.test')       // 用的哪个 endpoint
    expect(url.pathname).toContain('/tenant-b1/')  // 用的哪个 bucket（path-style）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/aftersales && DATABASE_URL=… pnpm vitest run routes/attachment.test.ts -t "storage_ref"`
Expected: FAIL —— 模块还没读 context 键（恒走装载期 env）。

- [ ] **Step 3: 改 `storage.ts`（保留 `ZosStorage`，换掉来源）**

```ts
// 删：ENV_KEYS / ZosConfig / zosConfigFromEnv / normalizeEndpoint（实现移入 @platform/sdk，T1）
// 留：UPLOAD_URL_TTL_SECONDS / DOWNLOAD_URL_TTL_SECONDS / sanitizeOrgSegment / objectKeyFor / ZosStorage
// 加：
import { normalizeEndpoint, platformStorageFromEnv, storageRefOf, type TenantStorageConfig } from '@platform/sdk'

/** client 池：**按配置指纹缓存**，绝不每请求 new（凭据解析 + 连接池建设 + keep-alive 失效）。
 *  指纹**不含 SK 明文**（SK 轮换会换 AK 或换桶；拿明文做键等于把密钥摊在内存里做索引）。
 *  容量按**租户数量级**设上界（不是请求量级）。 */
const CLIENT_CACHE_MAX = 64
const clientCache = new Map<string, ZosStorage>()

export function storageFor(cfg: TenantStorageConfig): ZosStorage {
  const key = `${storageRefOf(cfg)}|${cfg.accessKeyId}`
  let s = clientCache.get(key)
  if (!s) {
    if (clientCache.size >= CLIENT_CACHE_MAX) clientCache.delete(clientCache.keys().next().value as string)
    s = new ZosStorage(cfg); clientCache.set(key, s)
  }
  return s
}

/**
 * 本请求的候选集合。**必须含平台默认**：早期行（`storage_ref = ''`）与「租户未配时上传的行」
 * 写的都是平台桶；只认注入值会让「租户从未配 → 配了自己的桶」这个**最常见的**切换把老附件全读丢
 * —— 而这条路径正是裁定 ② 要修的东西。
 *
 * 为什么整包导出而不是塞进 resolver 内部：调用方要靠 `all.length` 把两种失败分开
 * （「本租户压根没配」与「配置换过、旧桶读不了」对运维是两条完全不同的处置）。
 */
export interface StorageCandidates {
  /** 本次请求注入的配置（租户配置，或未配时的平台默认）；undefined = 本请求没有任何可用配置 */
  injected: TenantStorageConfig | undefined
  /** 平台默认（早期行的归属）；null = env 不全 ⇒ 没有平台默认 */
  platformDefault: TenantStorageConfig | null
  /** 有序候选（`injected` 在前、SQL 层去重同 ref 的重复） */
  all: TenantStorageConfig[]
}

export function storageCandidatesFor(injected: TenantStorageConfig | undefined): StorageCandidates {
  const platformDefault = platformStorageFromEnv(process.env)
  const all: TenantStorageConfig[] = []
  for (const c of [injected, platformDefault]) {
    if (c && !all.some((x) => storageRefOf(x) === storageRefOf(c))) all.push(c)
  }
  return { injected, platformDefault, all }
}

/** 读侧解析器：给定行上的 `storage_ref`，回可用的存储客户端（null = 这个对象读不出来）。 */
export function storageResolverFor(cands: StorageCandidates) {
  return (ref: string): ZosStorage | null => {
    // 空 ref = 本列引入前写入的行 ⇒ 平台默认（引入前唯一存在的配置就是平台 env 五键）
    if (ref === '') return cands.platformDefault ? storageFor(cands.platformDefault) : null
    const hit = cands.all.find((c) => storageRefOf(c) === ref)
    return hit ? storageFor(hit) : null
  }
}

/**
 * ref 解析不出来 = **平台侧唯一的信号**（客户端只会看到「附件打不开」，预签名是本地计算、
 * 平台发不出这个错）。但不能每请求刷一行 —— 按 `org + ref` 去重 60s（照 session-middleware
 * 的 warnDegrade 手法）。日志含 org 与 ref 摘要，**不含任何凭据**。
 */
const REF_WARN_INTERVAL_MS = 60_000
const lastRefWarnAt = new Map<string, number>()
export function warnUnresolvedRef(org: string, ref: string): void {
  const key = `${org}|${ref}`
  const now = Date.now()
  if (now - (lastRefWarnAt.get(key) ?? 0) < REF_WARN_INTERVAL_MS) return
  lastRefWarnAt.set(key, now)
  console.warn(
    `[aftersales] 附件读不出来：org=${org} 的行记录了 ref=${ref}，但当前既不是本租户配置也不是平台默认`
      + '（配置换过 / 凭据失效 ⇒ 平台侧无法为它签名）。这条 warn 是该故障在本仓的唯一信号。',
  )
}
```

> `ZosConfig` 类型删除后，`storage.test.ts:10` 的 `import type { ZosConfig }` 改成
> `TenantStorageConfig`；`normalizeEndpoint` 的用例**随实现移入** `packages/platform-sdk/src/storage.test.ts`
> （T1 已写），模块侧**不留同名单测**（那是第二份事实源）。模块侧改为一条**连线断言**：
> `platformStorageFromEnv({ ...五个键，endpoint 给 '  zos.xinan1.ctyun.cn/  ' }).endpoint === 'https://zos.xinan1.ctyun.cn'`
> ——证明「走 SDK 解析时补全仍然发生」。

- [ ] **Step 4: 改 `index.ts` 与 `context.ts`**

```ts
// index.ts：不再在装载期读 env（这正是本步要消灭的形态）
export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    const r = new Hono<{ Variables: { identity: Identity; [TENANT_STORAGE]?: TenantStorageConfig } }>()
    const ctx: RouteCtx = { pool }   // ← storage 从 RouteCtx 消失，配置改为按请求取
    registerTicketManage(r, ctx)
    registerTicketGuest(r, ctx)
    registerRule(r, ctx)
    registerMasterData(r, ctx)
    registerAttachmentGuest(r, ctx)
    registerAttachmentManage(r, ctx)
    registerRegistrationGuest(r, ctx)
    registerRegistrationManage(r, ctx)
    return r
  },
})

// context.ts：
export interface RouteCtx { pool: Pool }   // 删掉 storage: ZosStorage | null
```

> `[TENANT_STORAGE]?: TenantStorageConfig` 用**计算键名**：键常量是宿主 set / 模块 get 的约定，
> 写死字符串 'platform.tenantStorage' 就是第二份事实源（改名时它不会跟着改，症状是**静默拿不到**）。

- [ ] **Step 5: 改 `test-util.ts`（测试壳必须能注入 context 键）**

```ts
export function buildTestApp(
  mod: ModuleDefinition,
  identity: Identity,
  ctx: ModuleContext,
  storage?: TenantStorageConfig,   // ← 新增第 4 参：与宿主投影**同形状**的注入
): Hono {
  const app = new Hono<{ Variables: { identity: Identity } }>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    if (storage) c.set(TENANT_STORAGE, storage)   // 不传 = 未配（未声明 storage 的模块也是这个状态）
    await next()
  })
  app.route('/', mod.createRouter(ctx))
  // （其余一字不改：末尾那句 `as unknown as Hono` 的既有注释保持原样）
  return app as unknown as Hono
}
```

> ⚠️ **为什么必须改它**：模块的 `createRouter` 不再从 env 取配置 ⇒ 测试壳不注入就等于「未配存储」，
> 所有附件用例会静默变成 503。这是本步**最容易漏的一处**（测试红得莫名其妙，而代码「看着没问题」）。
> 5 个测试文件里的 `{ pool, storage: null }` 字面量（`registration-manage.test.ts:20`、
> `registration-guest.test.ts:20`、`registration-chain.test.ts:27-28` 等）随之删掉 `storage` 键；
> `ticket.test.ts:19-20` 那段「不要在这里塞 storage：模块自己从 process.env 解析 ZOS 配置（见
> index.ts），从测试注入的 storage 根本到不了 createRouter 里面——那会是一个静默失效的注入点」
> **已经过时**，必须改写（它描述的正是本次要消灭的装载期形态，留着它会把人引向错误结论）。

- [ ] **Step 6: 改写入路径（`routes/attachment.ts` 的 `POST /guest/attachments`）**

```ts
    const cfg = c.get(TENANT_STORAGE)
    if (!cfg) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)
    const storage = storageFor(cfg)
    const objectKey = objectKeyFor(identity.orgId, clientRequestId)
    const uploadUrl = await storage.presignPut(objectKey, contentType)   // 顺序不变：先签后落
    const res = await ctx.pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(
         org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid, storage_ref)
       values ($1, null, $2, $3, $4, $5, $6, $7) returning id`,
      [identity.orgId, clientRequestId, objectKey, contentType, sizeBytes ?? 0, identity.userId, storageRefOf(cfg)],
    )
```

> 顺序仍然是「先预签名、后落行」（既有注释的理由不变：签名会抛，先落行会留下无主孤儿）。
> `storage_ref` 是**纯函数产物**，放进这条 INSERT 是零成本的。

- [ ] **Step 7: 改读路径（`GET /attachments/:id` 与 `loadAttachments`）**

```ts
    // GET /attachments/:id —— 改动只在两处：查出行上的 storage_ref、按它解析配置
    const res = await ctx.pool.query(
      `select id, ticket_id, object_key, content_type, size_bytes, uploader_openid, created_at, storage_ref
         from aftersales.ticket_attachment where org = $1 and id = $2`,
      [org, id],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)

    const cands = storageCandidatesFor(c.get(TENANT_STORAGE))
    const storage = storageResolverFor(cands)(row.storage_ref as string)
    // 两种「签不出来」的语义必须分开（同形的话，运维分不清「本租户压根没配」与「配置换过、旧桶读不了」）：
    //   · 一个候选都没有（未配且无平台默认 / 部分填写）⇒ ZOS_NOT_CONFIGURED（与改动前逐字同形）
    //   · 有候选但该行的 ref 都对不上 ⇒ STORAGE_REF_UNRESOLVED（**显式失败**）
    //     —— 绝不拿当前配置硬签：那会签出一个指向**别的桶**的 URL，客户端拿到 NoSuchKey、
    //        平台侧零信号。这条正是 storage_ref 存在的全部理由。
    if (!storage) {
      const ref = row.storage_ref as string
      if (cands.all.length > 0) warnUnresolvedRef(org, ref)
      return c.json({ error: cands.all.length > 0 ? 'STORAGE_REF_UNRESOLVED' : 'ZOS_NOT_CONFIGURED' }, 503)
    }

    return c.json({
      id: Number(row.id),
      ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
      objectKey: row.object_key,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      uploaderOpenid: row.uploader_openid,
      createdAt: row.created_at,
      url: await storage.presignGet(row.object_key as string),
    })
```

```ts
export async function loadAttachments(
  ctx: RouteCtx,
  org: string,
  ticketId: number,
  resolve: (ref: string) => ZosStorage | null,   // ← 新增第 4 参（本请求的解析器）
): Promise<{ id: number; objectKey: string; contentType: string; sizeBytes: number; url: string | null }[]> {
  const res = await ctx.pool.query(
    `select id, object_key, content_type, size_bytes, storage_ref
       from aftersales.ticket_attachment where org = $1 and ticket_id = $2 order by id`,
    [org, ticketId],
  )
  return Promise.all(
    res.rows.map(async (a) => {
      const storage = resolve(a.storage_ref as string)
      // 单件失败**只让该项 url 为 null**：工单数据仍然有用，附件拉不到是「降级」不是「失败」
      // （附件专用端点才是 503，语义不变）。降级在此正当 —— 失败可单独补救（人工迁移 / 重配）
      // 且不该阻断「看工单详情」；条件是**日志里显式可见**（deploy-verify §3：不许用容错掩盖失败）。
      if (!storage) warnUnresolvedRef(org, a.storage_ref as string)
      return {
        id: Number(a.id),
        objectKey: a.object_key as string,
        contentType: a.content_type as string,
        sizeBytes: toMinor(a.size_bytes as string),
        url: storage ? await storage.presignGet(a.object_key as string) : null,
      }
    }),
  )
}
```

两个调用点把本请求的候选集穿进去（`ticket-manage.ts:90` 与 `ticket-guest.ts:75`，两处同形）：

```ts
      attachments: await loadAttachments(ctx, org, id, storageResolverFor(storageCandidatesFor(c.get(TENANT_STORAGE)))),
```

- [ ] **Step 8: 跑模块测试确认通过**

Run:
```bash
cd modules/aftersales && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run
```
Expected: PASS（全部用例，含既有 6 个测试文件）。**特别确认没有一条用例「静默变成 503 还绿」**
——逐条看断言里是否真的断言了 200/201（`test-util.ts` 漏注入的典型症状是状态码断言变成 503 而用例名还在说别的）。

- [ ] **Step 9: 提交**

```bash
git add modules/aftersales
git commit -m "feat(aftersales): 存储改按请求解析 + 写/读 storage_ref（M3c 步 4 原子切换）(#101)"
```

---

### Task 9: 宿主级端到端断言（真装配 + 真 Host + 真登录）

**Files:**
- Create: `apps/server/src/storage-injection.test.ts`

**Interfaces:**
- Consumes: `buildApp`（真装配）、`MockCasdoor`、真 PG、seed 的 acme/beta 两租户。
- Produces: 断言「注入的配置**真的驱动了预签名**」——这是模块层用例**证明不了**的一层
  （模块层是自己注入的，宿主层才验得到「宿主 → 模块上下文」这条链）。

- [ ] **Step 1: 写测试（照 `demo-tenant-isolation.test.ts` 的三件套：真 app + Host + 真登录）**

```ts
// storage-injection.test.ts — M3c 的端到端面：Host → 租户行 → 注入 → 预签名用哪套配置。
//
// 为什么走真装配：注入由「租户中间件取行 + 装载器挂投影 + 模块读 context 键」三层合成，
// 模块自己的测试壳只覆盖第三层（它是自己 set 的）——中间那条链只有 buildApp 有。
// 附件行的读取端点在**管理面**（scope aftersales:manage）⇒ 本地可用真会话验（账密登录）；
// 上传端点在**访客面** ⇒ 本地拿不到访客 session（见下方"已知边界"）。
const ACME = { endpoint: 'zos.acme.test', region: 'xinan1', bucket: 'acme-bucket', ak: 'AKIAACME', sk: 'sk-acme' }
```

用例（每条都断言**预签名 URL 的 host 与 path**，因为 URL 是本地计算结果、是「用了哪套配置」的直接证据）：

1. **租户配置驱动**：把 acme 五列写成 `ACME` ⇒ 插入一行 `storage_ref = 's3|https://zos.acme.test|acme-bucket'`
   ⇒ `GET /api/modules/aftersales/attachments/:id`（Host=acme.test，acme 管理员会话）⇒
   `url.host === 'zos.acme.test'` 且 `url.pathname` 含 `/acme-bucket/`。
2. **租户间不串**：beta 未配 ⇒ 同一路径下 beta 会话读 beta 自己的行 ⇒ `url` 指向**平台默认**（env 桩值）。
3. **fail-explicit**（裁定 4 的机检）：acme 只填 endpoint+bucket（部分填写）⇒ **503**，
   且**断言响应体里绝不出现平台桶名**（这条断言就是「绝不回落」全部内容）。
4. **storage_ref 失配**：行的 ref 既不是当前租户配置、也不是平台默认（如 `s3|https://zos.old.test|old-bucket`）
   ⇒ **503 `STORAGE_REF_UNRESOLVED`**，且**绝不**回一个指向当前桶的 URL。
5. **清除即回落**：`DELETE /api/platform/admin/storage`（acme 管理员 + CSRF）后，未配的 acme 又走平台默认。
6. **注入面不含租户行的其它字段**：同一租户的 `wecom_secret` / `wechat_oa_secret` 塞进种子行 ⇒
   断言 5 号用例里任何响应体都**不含**它们的值（正典「安全性质」第 2 条的端到端机检）。

- [ ] **Step 2: 跑测试确认通过**

Run: `cd apps/server && DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm vitest run src/storage-injection.test.ts`
Expected: PASS。

- [ ] **Step 3: 跑宿主全量 + 冒烟**

Run:
```bash
pnpm typecheck && pnpm test && pnpm --filter @platform/web build && pnpm --filter @aftersales/mobile build && \
  DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
Expected: 全绿。`pnpm smoke` 是**装配层的唯一证据面**（真进程 + 双形态）——`runtime.mount` 里多挂了一条
中间件，只有它覆盖得到「真启动期装配」。

- [ ] **Step 4: 提交**

```bash
git add apps/server/src/storage-injection.test.ts
git commit -m "test(server): 存储注入的端到端断言——注入真的驱动预签名（M3c 步 4）(#101)"
```

---

## Wave 4（步 5 + 收口）

### Task 10: 全量门禁 + 试点验收 + 回滚演练 + 文档收尾

**Files:**
- Modify: `README.md`（已知边界）
- Modify: `deploy/delivery-private.md`（五个 env 键的语义）

- [ ] **Step 1: 全量门禁（CI 四 job 的本地等价）**

```bash
pnpm install --frozen-lockfile
pnpm test && pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/check-tenant-isolation.mjs
pnpm --filter @platform/web test && pnpm --filter @platform/web build
pnpm --filter @aftersales/mobile build
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
Expected: 全绿。任何一条红都**不许**用 `--no-verify` 或跳过绕过（纪律：`--no-verify` 只在有人明确授权时用）。

- [ ] **Step 2: 上线（merge main 即自动部署；控制面 API 直调必须带 `/api/proxy` 前缀）**

部署后**必做**（`deploy-verify.md`：流水线绿 ≠ 部署成功）：
```bash
# 容器创建时间 > 镜像构建时间（否则跑的还是旧代码）
docker inspect --format '{{.Created}}' <server 容器>   # 经 openship MCP 执行，不裸 SSH
# 新行为在线上可观测（比时间戳更硬）：管理端 GET /api/platform/admin/storage 回 200 且 configured=false
```

- [ ] **Step 3: 试点验收（**本地验不了的那一段**）**

给**试点租户**配自己的桶（管理端操作）→ 在**试点客户机**上走完整链路：

| 验什么 | 判据 |
|---|---|
| 保存被探测挡住 | 故意写错 endpoint ⇒ 保存**被拒**并回显原因（库里纹丝不动） |
| 真连通 | 「测试连接」对试点桶回 ok |
| 访客真上传 | 移动端（微信内）选图 → 上传 → 提交工单 ⇒ **对象出现在租户桶**（ZOS 控制台可见）且库行 `storage_ref` = 该桶 |
| 管理端真下载 | 客服打开工单详情 ⇒ 图片能显示（预签名 URL 的 host = 租户桶） |
| 跨租户不可见 | 另一租户的管理员看不到该附件（404 与不存在同形） |
| 存量不丢 | 切到租户桶**之前**的附件仍能打开（走平台默认路径 ⇒ 验 `storage_ref` 真的在起作用） |

- [ ] **Step 4: 回滚演练（**在试点前的窗口内做**，见「分步可上线性」修正 ③）**

```bash
# 回滚 = revert 步 4 的 PR（唯一真回滚点）⇒ 模块回到装载期 env 形态
# ⚠️ 回滚**不是纯代码回滚**（见「分步可上线性」修正 ③）：
#    revert 后旧代码用平台桶给**所有**行签名 ⇒ 已写入租户桶的对象全部读不到
#    （客户端「附件打不开」、平台侧无信号）。**清空租户行救不回来**（旧代码根本不读它）。
# ⇒ 唯一安全的回滚时机是**试点前**（尚无租户真配过桶）；试点之后要回滚，
#    先按「把租户桶对象搬回平台桶」处置（或明确接受这批附件不可读）。
```
演练判据：revert 后附件端点行为与该租户配桶前**逐字一致**。

- [ ] **Step 5: 文档收尾（**本计划唯一允许改的两份**）**

`README.md` 的已知边界补一句：

```markdown
- M3c 存储配置：single 部署下租户行有 60s 进程内缓存 ⇒ 管理端保存后最长 60s 生效；
  真访客上传的端到端只能**在试点客户机**验（本地拿不到访客 session，见售后 spec §5 #13）。
```

`deploy/delivery-private.md` 的五个 env 键表格（`:77-81`）后补一句：

```markdown
> M3c 起：这五个键的语义是**平台默认**（不是唯一来源）。多租户部署下未配 env ⇒ **每个租户必须在
> 管理端「存储配置」里配自己的桶**，否则附件端点回 503（不再是「配齐 env 就全租户可用」）。
```

- [ ] **Step 6: 提交**

```bash
git add README.md deploy/delivery-private.md
git commit -m "docs: M3c 收尾——存储配置的生效窗口与 env 语义（#101）"
```

---

## 分步可上线性与回滚点（**对真代码逐条核实后的结论**）

正典 §5 的关键结论原文：**步 2 与步 3 可各自独立上线且生产行为零变化；步 4 是唯一的原子切换**。
逐条核实的结论：**成立**，但要补四处（①②③④：① 是补充前提，②③ 是对正典两处回滚/上线口径的修正，
④ 是 `storage_ref` 落地后对步 5 回滚表现的更新）。

| 步 | 正典声称 | 核实结论 | 依据 |
|---|---|---|---|
| 2 | 独立上线、零变化 | ✅ **成立** | 投影中间件是**纯函数、零 IO**；`aftersales` 此刻仍用**装载期 env 常量**，不读 context 键 ⇒ env 有 ⇒ 注入值与模块自读值**逐值相同**；env 缺 ⇒ 不注入 = `undefined` = 与 `zosConfigFromEnv` 返回 null 同效 ⇒ 503 同形 |
| 3 | 独立上线、零变化 | ✅ **成立**（但有一个运营窗口，见 ② ） | 列与配置面都**没有消费者**：`aftersales` 尚未读 context 键 ⇒ 保存进库的配置**不被任何代码使用** ⇒ 对生产行为零影响 |
| 4 | 唯一原子切换 | ✅ **成立** | 它同时改「解析来源」（装载期常量 → 按请求 context）与「读写两路的配置选择」——两者不可分离（读路径若还按 object_key 签、写路径已按租户桶写，就会出现**新对象落在租户桶、读却指向平台桶**）⇒ 确实没有中间态 |

**修正 ①（补充：步 2 的「零变化」有一个前提条件）**
步 2 之后，**平台默认 env 五键的消费者从「模块」变成「宿主」**⇒ 若某次部署只回滚了宿主而没回滚模块
（或反之），两边的 env 读法不一致会让「配了 env 却没生效」出现。这也是为什么 T1 把五键常量与读取函数
**收进 SDK 一处**——消除的正是这条缝。

**修正 ②（步 3 的运营窗口：配置能保存、但不生效）**
步 3 合并后、步 4 合并前，租户管理员可以保存存储配置，而**没有任何代码消费它**（附件仍写平台桶）。
此时平台侧的状态是「租户以为附件在自己桶里、实际在平台桶」——正是裁定 4 要防的**数据位置误述**，
只不过成因从「回落」换成了「未上线」。
**已裁定（待拍板 2 → (B)，2026-09-17）：采纳「先不合并配置页」这一处置。**
⇒ **步 3 只合 T4/T5/T6**（列与投影——它们是真的零变化），**T7 的配置页不随步 3 合并、跟步 4 一起上**；
即 Wave 2 里 T7 **照常实现**，只是**合并时点**跟着步 4 走。
⇒ 这一条**不再是待决项**，也不再需要「间隔 ≤ 一个部署周期」这个附加前提。

**修正 ③（步 4 的回滚不是纯代码回滚）**
正典 §5 的回滚栏写「revert 该 PR ⇒ 回到装载期 env 形态」，**没说清租户行的状态必须一起处置**：
revert 后旧代码用平台桶给**所有**行签名 ⇒ 已写入租户桶的对象**全部读不到**。
且**清空租户行救不回来**（旧代码不读它，照样签平台桶；而它里面的对象在租户桶）。
⇒ **回滚窗口应当限定在步 5 试点之前**（尚无租户真配过桶时，revert 是无害的）；试点之后再回滚，
必须先按「人工把租户桶对象搬回平台桶」处置。演练步骤见 T10 Step 4。

**修正 ④（步 5 的回滚栏：`storage_ref` 让这条从「静默」升级为「显式」）**
正典 §5 步 5 的回滚栏说「清空租户行五列 ⇒ 回落 env 兜底（注意 §7.2：已写入租户桶的对象会因此不可读）」。
`storage_ref` 落地后，**不可读这件事没变**（凭据没了，spec §2.3 已如实记了这个边界），但**表现变了**：
读侧能认出「这些行写的是租户桶」⇒ 回 **503 `STORAGE_REF_UNRESOLVED`** + 一条去重日志，
而不是一个指向平台桶的预签名 URL 换回客户端的 `NoSuchKey`。**平台侧从静默变成有信号**——
这正是裁定 ② 想要的效果。

---

## 验收与端到端验证

### 每步的成功判据

| 步 | 判据（可执行） | 生产可观测面 |
|---|---|---|
| 2 | `pnpm typecheck && pnpm test` 全绿；`loader.test.ts` 的注入用例（声明/未声明/env-不全三态）；`pnpm smoke` 绿 | 附件端点三种表现与部署前**逐字相同** |
| 3 | 006 迁移在真库跑通且**重复执行不报错**；`GET/PUT/POST test/DELETE /storage` 六条用例（含不桩的连通性分类）；`pnpm --filter @platform/web test` 绿 | 管理端能读能写、探测能挡住错配置；**附件行为仍不变** |
| 4 | 模块全量 + `storage-injection.test.ts` + `pnpm smoke` 全绿 | 配了桶的租户：新附件落在自己桶、旧附件仍可读；未配租户：行为不变 |
| 5 | T10 的验收表逐行打勾 + 回滚演练 | 端到端（真访客 + 真桶）**只在试点客户机成立** |

### 端到端怎么验 —— **本地验得了什么、验不了什么**

**本地验得了（真装配 + 真 Host + 真登录 + 真 PG）**：
- 注入真的驱动了预签名（T9 的六条用例）——判据是**预签名 URL 的 host 与 path**：
  它是 SigV4 的**纯本地计算**产物，所以「用了哪套配置」在本地就是可断言的，**不需要真桶**。
- 三态语义（全空 / 部分填 / 全填）、`storage_ref` 三种解析结果、跨租户不可见、注入面不含租户行其它字段。
- 管理面端点（`GET /attachments/:id`、`GET /tickets/:id` 的附件列表）都能用**账密登录的真会话**打通
  （`demo-tenant-isolation.test.ts` 的 `sessionCookie()` 现成）。

**本地验不了（**明写，别把「本地全绿」读成「端到端验过」**）**：
1. **访客面上传（`POST /guest/attachments`）拿不到真 session** —— `MockCasdoor` 只做 Casdoor、
   **不做公众号 OAuth**（售后 spec §5 #13 已裁定「留到试点」）。本地最多验到模块层单测 + 注入 identity
   的那一层。⇒ 「真壳 + 真访客 + 真桶」的完整链路**只能在试点客户机验**（T10 Step 3）。
2. **真实连通性** —— 预签名不发网络请求，「签名对不对」只有对象存储说了算；本地假凭证只能验
   「探测失败/成功两个分支」，验不了「探测说 OK 就等于真能传」。⇒ 试点的「真上传 + 真下载」是**唯一**证据。
3. **single 部署的 60s 生效窗口** —— 单实例本地能复现（连续两次请求观察缓存），
   但**多实例不一致**只能在线上看（各实例各缓存，无失效接口）。

---

## 待拍板清单（**6 项已于 2026-09-17 全部裁定**）

> **状态：已决。**「本计划的取法」一列保留为**计划写就时**的取法；**裁定结果以「裁定（2026-09-17）」列为准**
> （该列编号即**本表**的 #，与 spec §8 那七条裁定（①②③…）是两套编号，别混）
> （本次 6 项的裁定与取法**逐条一致**）。计划正文里原先引「见待拍板 N」的地方已同步改写为「已裁定」。

| # | 事项 | 选项 | 本计划的取法 | 为什么需要人 | 裁定（2026-09-17） |
|---|---|---|---|---|---|
| 1 | **宿主侧探测的实现位置**（保存时 + 测试连接需要一个 S3 客户端） | (A) `apps/server` 加 `@aws-sdk/client-s3` + `src/storage-probe.ts`（**本计划按此写**）／(B) 放进 `packages/platform-sdk`（宿主与模块共用，但 SDK 变重、依赖表变）／(C) 手写 SigV4（零新依赖，重造签名） | **(A)** | 无论哪条，`docs/architecture.md` §2 的依赖表都要改 ⇒ 命中 architecture-first 的「组件新增 / 技术栈」类别（**先经人同意 → 改文档 → 再写码**）。且 spec §9 把「存储客户端抽公共包」记为「第二个消费者出现再抽」——**宿主就是第二个消费者**，这条判据到点了 | **(A)** 落地。**architecture-first 的「改文档」那步已完成**：`docs/architecture.md` §2 依赖表已记该依赖边、§2.1 写明「为什么是宿主」，§5 第 9 条已指向它。⚠️ 另记一件事：判据「第二个消费者出现再抽公共包」**到点了，但本次不抽**（`ZosStorage` 仍在模块内）——详见 §2.1 |
| 2 | **步 3 的运营窗口怎么处置**（配置能保存但不生效） | (A) 步 3 与步 4 **同发版窗口**合并／(B) 步 3 只合 T4/T5/T6，**配置页随步 4 一起上**／(C) 接受窗口 | **(B)**（最保守，且它让「步 3 零变化」无需任何附加条件） | 这是交付节奏与运营风险，不是技术推导 | **(B)** 步 3 只合 T4/T5/T6；**配置页（T7）随步 4 一起上**（见「修正 ②」） |
| 3 | **平台默认 env 键名（命名债）**：`AFTERSALES_ZOS_*` 现在被宿主读、服务**所有**声明 storage 的模块 | (A) 保持（正典已裁定键名冻结）／(B) 改名 `PLATFORM_STORAGE_*`（改协议 + `.env.example` + openship env + delivery runbook） | **(A)** | 改协议 = 改正典；且涉及生产 env 的迁移（openship isSecret），是交付决定 | **(A)** **保持 `AFTERSALES_ZOS_*`**。改名仍是**另一件事**（债的账见「附录」第 5 条） |
| 4 | **single 模式的 60s 租户行缓存**：要不要让写入路径主动失效缓存 | (A) 不失效，只把窗口写进协议与页面文案（本计划）／(B) 加失效接口（`tenant.ts` 暴露 `invalidate(org)`，由 admin 写路径调用） | **(A)** | 改缓存语义会让「停用/配置生效」多出一条隐式契约；正典「`enabledFor` 刻意不缓存」的口径与之相邻，值得一起定 | **(A)** **不失效**——把该窗口写进**协议**与**页面文案**（T7 Step 6 / T10 Step 5） |
| 5 | **`storage_ref` 是否要扩展到「读旧对象所需的凭据」**（spec §2.3 明确留给「落地前待定」） | (A) 只记 `kind\|endpoint\|bucket`（本计划）／(B) 记配置标识 + 配置历史回取 | **(A)** | 记凭据 = 把密钥写进数据行；B 方案要引入配置历史表 ⇒ 数据模型级决定 | **(A)** 只记**配置标识**（三个字段：kind / endpoint / bucket），**不记凭据**——AK 轮换不该让存量行失去归属 |
| 6 | **读侧失配时的响应形状**（`GET /attachments/:id` 单件 ⇒ 503 OK；`GET /tickets/:id` 的列表项怎么表达） | (A) 保持 `url: null` + 去重日志（本计划）／(B) 每项加 `urlUnavailable` 字段 | **(A)** | 改响应形状会牵动 console 与移动端两端；且「附件读不到可单独补救、不该阻断看工单」是既有语义 | **(A)** **保持 `url: null` + 去重日志**（单件端点仍 503，两种形状都按本计划） |

---

## 附录：文档漂移回收清单（**另开文档 PR，本计划不改正典**）

实现落地后单独提一个 `docs:` PR 修正下列**已实测**的漂移（改正文，不复制正文）：

1. `docs/module-protocol.md`「租户级配置注入」的**注入点表**与 `docs/architecture.md` §4.3 引用的
   `loader.ts` 行号：`294 → 321`、`364-437 → 391-476`、`412 → 442`、`414 → 444`、`386-388 → 435`；
   `app.ts:276 → 278`；`tenant.ts:12-32 → 13-33`；`storage.ts:61-68 → 67-74`；
   `routes/attachment.ts:72 → 78`。
2. `docs/module-protocol.md`「租户级配置注入」补一句**消费面**：storage 的消费者有**三处**，
   其中 `routes/ticket-manage.ts` 的 `loadAttachments()`（工单详情的附件列表）**降级语义是
   `url: null` 而非 503**——这是模块自己的选择，不是协议规定，但协议不该给人一种「只有附件端点用」的印象。
3. `docs/module-protocol.md` 的「兜底语义」节补**生效窗口**：single 部署下租户行有 60s 进程内缓存
   （`apps/server/src/tenant.ts`），配置变更最长 60s 生效且多实例不一致。
4. `docs/architecture.md` §4.3 的机制段补 `storage_ref`（裁定 ② 的数据面后果）：配置变更时
   **存量行的下载链接会指向新桶**，故行上要记写入当时的配置标识，读时按它解析；
   并记明它的**边界**（解决「指向哪个桶」，不解决「用哪套凭据读它」）。
5. `deploy/delivery-private.md:31,42,77-81`：五个 env 键的语义从「配齐即全租户可用」改为「**平台默认**」
   （T10 Step 5 已含此改动；此条是提醒它与正典的口径要一致）。
6. **私有化交付的租户开通路径**（`scripts/provision-tenant.mjs`）**本期不动**：它是**条件式列清单**
   （给了才写那几列，`provision-tenant.mjs:82-84`），新增可空列对它零影响；但「交付时逐租户配存储」
   这件事目前**只有管理端一条路**（没有 CLI 参数）。要不要给 provision 加存储五参 =
   「私有化交付怎么配 BYO 桶」的产品决定，**不在 M3c 范围内**，记在此处免得下次重新发现。
