# 售后模块 M2a（模块后端）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `modules/aftersales` 落地售后域的后端——manifest 声明、建表迁移、工单/规则/主数据/附件四组域 API、天翼 ZOS 预签名存储；**不含数据迁移**（M2b 后置、另出计划）。

**Architecture:** 一个 manifest 驱动的可插拔模块（`defineModule` + `createRouter`），路由按 `scope` 分两面（管理端 `aftersales:manage` / 访客端 `aftersales:guest`，见 spec §2.2）；业务内核（金额公式 + 三态状态机）抽成 `domain/ticket.ts` 的**纯函数**，路由层只做事务与 IO；附件字节全程不过平台，走 ZOS 预签名 PUT/GET。金额一律整数分并在服务端权威计算，前端传来的金额一概不采信（`fixed` 是明写的例外：操作员输入，服务端**校验**而非重算）。

**Tech Stack:** TypeScript / Hono / node-postgres（`pg`）/ zod / `@platform/sdk`（模块契约）/ `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`（ZOS 预签名）/ vitest。

**规范正典：** `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`（下称「spec」）。
本计划是 spec 的**实施**，不是对 spec 的再设计——任何与 spec 冲突之处，**先改 spec 再动码**（工作铁律）。
动手前必读：`docs/module-protocol.md`（改模块 API / 门卫 / 声明前必读）。

---

## Global Constraints

以下每一条对本计划的**每个任务**都成立。括号里是出处，回退任何一条前先回出处。

**模块与协议**

1. 模块 `id` = `aftersales` = DB schema 名 = API 前缀（三同纪律）。
2. 权限码只有两个：`aftersales:manage`（管理端）/ `aftersales:guest`（访客端）；manifest 另声明
   `guest: { scope: aftersales:guest }`。
3. **声明即授权、装载期双向核对**：`manifest.api.internal[]` 与 `createRouter` 里注册的路由必须
   **逐条一致**，任一方向的差集 ⇒ **装载失败（进程起不来）**。⇒ **每个任务的 manifest 改动与其
   路由改动必须在同一个提交里**；模块**不写** `requireScope`（门禁由宿主施加）。
4. 声明路径是**模块内相对路径**，必须以 `/` 开头且不是裸 `/`；同 `(method, path)` 只能声明一次。
5. `HEAD` 按 `GET` 派发归一（issue #7）：只声明 `GET` 的端点在 `HEAD` 下放行——不要为 HEAD 另加声明。

**租户隔离（spec-1 §2）**

6. 售后域**全部是租户数据表**：每张表带 `org text not null`，值 = `identity.orgId`；**读写一律
   `where org = $1`**；唯一索引一律含 `org`；热路径索引以 `org` 为前缀列。**本模块没有全局表**。
7. 外部系统的字段（编码/编号/名称/分类）一律 `text`，不用 `varchar(n)`；`varchar` 只用于自己
   控制的枚举（`status`/`amount_type`/`approve_status` 用 `text` + `check`）。

**金额与业务内核（spec §2.1 / §2.4，逐字取自 wuji-1 源码实证）**

8. **目标表金额一律整数分**，列名 `_minor` 后缀，**永不浮点**。
9. **金额公式**：`售后金额 = (报损数量 − 基本数量 × 售后比例) × 基本单价`，**负数取 0**，
   **四舍五入到分**。
10. **三态状态机**：`pending`（待处理）→ `completed`（已处理，`ratio`/`fixed` 两条路）|
    `cancelled`（已驳回，`reject` 路，**金额强制归 0**）。源侧 `types/afterSalesWorkOrder.ts` 那个
    含 `processing` 的 4 态版本**全仓从未写入过**，是死声明，**勿照搬**。
11. **金额类型** `ratio | fixed | reject`：`ratio` 按公式算并落比例；`fixed` 的金额是**操作员
    输入值**，服务端**校验**（非负、整数分、上界）**而非重算**——这是「前端金额不采信」的
    **明写例外**；`reject` 金额 0、状态 `cancelled`。
12. `ticket_rule.refund_ratio` 存的是**小数比例，不是百分数**（源侧注释说谎，实测 `载入 ×100 /
    保存 ÷100`，保存走 `.toFixed(4)`）⇒ 列型 `numeric(6,4)`。
13. **工单域源金额单位 = 元带分精度**（`basic_unit_price` 是 `number`，公式末尾按分四舍五入）
    ⇒ M2b 的换算在工单域 = ×100。**不许外推到接龙域**（那是另一套，M2b 单独核）。

**附件与外部存储（spec §2.3）**

14. 天翼 ZOS：S3 兼容、**path-style 必开**、SigV4；**endpoint 可能被写成不带 `https://` 的域名**
    ——代码负责补全（WeKnora 两条实测条目为证）。
15. env 键固定五个：`AFTERSALES_ZOS_ENDPOINT` / `_REGION` / `_BUCKET` / `_ACCESS_KEY` / `_SECRET`。
16. **密钥绝不写入仓库/文档/提交信息**：本计划与 spec 只写「在哪、怎么取」；值只落
    openship env(isSecret)。代码里读 env，绝不写默认值兜底成明文。
17. key 规范 `aftersales/{org}/{ticket_ref}/{uuid}`，`ticket_ref` = 客户端幂等键（**不是**库内主键）；
    `{org}` 段必须净化掉需编码字符。
18. **预签名是必选而非优化**：平台全局 bodyLimit ~1MiB，移动端视频过服务器必炸。

**门禁与提交**

19. B1：模块源码里的 SQL **只能引用本模块 schema**（`aftersales.`），不得出现 `platform.` 等。
20. B7：全仓只允许 `deploy/docker-compose.yml` 一份 compose；**本计划不新增任何 compose**。
21. B9：代码里出现的每个 `process.env.KEY` / `env.KEY` 都必须在**根 `.env.example`** 声明
    （注释行也算声明；`env.KEY` 形式要求键以大写字母开头）。
22. 提交：Conventional Commits `type(scope): 中文一句话`；**feat/fix 必须先有 issue**；可见变更走
    PR（squash，subject 带 `(#N)`）；**仅当 CI CLEAN 才合并**。
23. 桶文件（barrel）`export` 值清单**绝不混 interface/type**（#44 生产事故）。本模块 `index.ts`
    只有 default export，天然规避——**不要**在里面加值导出清单。
24. 测试替身必须收严到真机形状（#50/#51）：本计划不引入新的 Casdoor 替身（模块测试直接构造
    `Identity` 对象），真机形状的替身需求归 `apps/server` 的测试。
25. **无案例不立标准**：本计划里标注为「M2a 新增守卫」的地方（如 `fixed` 金额上界）都是**新加**
    的服务端校验，源侧没有——实现时照写，但**不要**在别处把同类新守卫说成「源侧如此」。

**门禁怎么跑（本仓没有 `pnpm run gates` 这个聚合脚本，别照着习惯敲）**

CI 的 gates job 是**逐条**跑下面四个（`.github/workflows/ci.yml:71-74`）：

```bash
pnpm exec tsx scripts/check-manifests.mjs    # B4/B5：manifest 合法性 + migrations.dir 目录必须存在
pnpm exec tsx scripts/lint-architecture.mjs  # B1/B2/B8：跨 schema、认证代码唯一、硬编码域名/IP
pnpm exec tsx scripts/check-compose.mjs      # B7：compose 唯一 + ports 必须 127.0.0.1:
pnpm exec tsx scripts/check-env-example.mjs  # B9：代码引用的 env 键必须在根 .env.example 声明
```

其余 job：`pnpm test`（全仓单测 + `test:guard`）、`pnpm typecheck`、
`pnpm --filter @platform/web test`、`pnpm --filter @platform/web build`、
`DATABASE_URL=… pnpm exec tsx scripts/smoke-load.mjs`。
**这三条合起来就是「全量验证」的定义**（见 T10）——不要用「本任务相关的几条命令」代替。

---

## 波次划分（派发用）

> 判据与硬约束见 `~/.claude/rules/common/dispatch-and-visibility.md`：**波内不得改同一文件、
> 同一共享资源**；波末收齐产出 → 跑**全量**验证 → 再进下一波。

| 波次 | 任务 | 并行性 | 为什么是这个形状 |
|---|---|---|---|
| **Wave 0** | T1 建 issue → T2 架构文档先行 → T3 模块骨架+迁移 | **串行** | 架构先行（先文档后代码）；T3 产出 T4/T5 都依赖的 `package.json` |
| **Wave 1** | T4 `domain/ticket.ts` ‖ T5 `storage.ts` + `.env.example` | **并行** | 两组文件**零重叠**：T4 只碰 `domain/*`，T5 只碰 `storage.ts` + 根 `.env.example` |
| **Wave 2** | T6 工单域 → T7 规则域 → T8 主数据域 → T9 附件域 | **串行（协议硬约束）** | 四个任务都要改 `index.ts` + `manifest.yaml`，而 manifest 与注册路由必须逐条一致（装载失败是进程起不来）⇒ 同一文件、同一共享资源，**拿不准就降为串行** |
| **Wave 3** | T10 全量验证 + push + PR | 串行 | 波末全量验证 |

**Wave 2 为什么不并行**：唯一的原因是 `manifest.yaml` 与 `index.ts` 是四个任务的共享写点，而协议
要求二者逐条一致。**不要**为了并行把它们拆开——那等于绕过装载期双向核对。Waves 2 的串行是协议
成本，不是排期失误。

---

## 文件结构

```
modules/aftersales/
  manifest.yaml                     # 声明（T3 建空的；T6–T9 逐域追加）
  index.ts                          # defineModule + createRouter 组装（T3 建；T6–T9 追加各域注册）
  package.json                      # 依赖（T3 一次性建全，含 AWS SDK）
  tsconfig.json                     # extends ../../tsconfig.base.json（T3）
  vitest.config.ts                  # node 环境（T3）
  README.md                         # 租户隔离声明：本模块无全局表（T3）
  test-util.ts                      # 测试脚手架：makeIdentity / buildTestApp / applyMigrations（T3）
  module.test.ts                    # 装载 + 迁移落表（T3）
  migrations/
    001_init.sql                    # 7 张表（T3）：region/store/product/employee/ticket_rule/ticket/ticket_attachment
  domain/
    ticket.ts                       # 金额公式 + 状态机（纯函数，T4）
    ticket.test.ts                  #（T4）
  storage.ts                        # ZOS 配置 + 预签名（T5）
  storage.test.ts                   #（T5）
  routes/
    context.ts                      # ModuleHono / RouteCtx 两个共享类型（T6；四个域共同依赖它）
    ticket-manage.ts                # GET /tickets、GET /tickets/:id、POST /tickets/:id/process（T6）
    ticket-guest.ts                 # GET /guest/tickets、GET /guest/tickets/:id、POST /guest/tickets（T6）
    ticket.test.ts                  # 工单域真 PG 测试（T6）
    rule.ts                         # GET/POST /rules、PUT/DELETE /rules/:id（T7）
    rule.test.ts                    #（T7）
    masterdata.ts                   # GET /stores、GET /products、GET/POST /employees、POST /employees/:id/approve（T8）
    masterdata.test.ts              #（T8）
    attachment.ts                   # POST /guest/attachments、GET /attachments/:id（T9）
    attachment.test.ts              #（T9）
```

**为什么域路由导出的是 `register*` 函数而不是子 Hono**：宿主与测试都用 `app.route('/', router)` 挂载，
Hono 在 `route()` 时会拼前缀；子 Hono 再挂一次等于多一层拼接，出问题时报错点离现场很远。传一个
`(r, ctx)` 的注册函数，路径**一次写死在模块 router 上**，装载期双向核对比对的就是真实注册的路径。

**为什么域注册函数除了 `r` 还要收一个带 `storage` 的 `RouteCtx`**：ZOS 配置缺失时（CI 没有 ZOS 凭证）
模块**必须仍能装载**——只有附件端点回 503。这是刻意的：模块装载失败是进程起不来，不能因为一个
可选外部存储把整个模块乃至宿主拖死。

---

### Task 1: 建 issue（feat 必须先有 issue）

**Files:**
- 无文件改动（GitHub 侧）

**Interfaces:**
- Produces: issue 号 `#<N>`，T10 的 PR body 要写 `Closes #<N>`，T2/T3 的提交信息要写 `(#<N>)`。

- [ ] **Step 1: 确认当前分支与远端状态**

```bash
git status --short
git log --oneline -3
```

Expected: 工作区干净，最新提交是本计划与 spec 收口那两个 `docs(aftersales):` 提交。

- [ ] **Step 2: 建 issue**

```bash
gh issue create \
  --title "feat(aftersales): M2a 售后模块后端（域 API + 建表 + 天翼 ZOS 预签名存储）" \
  --body "$(cat <<'EOF'
## 目标

在 `modules/aftersales` 落地售后域后端：manifest 声明、建表迁移、工单/规则/主数据/附件四组域 API、
天翼 ZOS 预签名存储。**不含数据迁移**——数据迁移是 M2b，已定「空闲窗口一次性迁」，另出计划。

## 规范

- spec：`docs/superpowers/specs/2026-09-15-aftersales-module-design.md`
  （§2.1 数据模型 / §2.2 域 API 按 scope 分面 / §2.3 附件 ZOS / §2.4 金额与状态机源码实证）
- 计划：`docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md`

## 范围（做什么）

- `manifest.yaml`：`id: aftersales`、两个权限码、`guest: { scope: aftersales:guest }`、逐条声明域 API
- `migrations/001_init.sql`：7 张租户数据表（ticket / ticket_rule / ticket_attachment /
  store / product / employee / region），全部带 `org`
- 域 API：管理端（工单列表/详情/处理、规则 CRUD、门店/商品/员工、员工审批、附件取 URL）
  + 访客端（`/guest/*`：只看自己的工单、提交工单、附件预签名 PUT）
- `storage.ts`：ZOS 预签名（path-style、endpoint 补 `https://`）
- 根 `.env.example` 增 5 个 `AFTERSALES_ZOS_*` 键（B9）

## 范围外（明确不做）

- 数据迁移（M2b）：拉取/清洗/入库/对账——另出计划，择业务空闲窗口
- `archive_order` / `archive_order_item` / `department` 建表——归 M2b（spec §2.1，无实测样本/无源表）
- console 管理端与移动端 userApp——归 M3
- 接龙（groupbuying）域——二期另行立项

## 验收

- `pnpm run test` / `pnpm run typecheck` / `pnpm run gates` 全绿
- `node scripts/check-manifests.mjs` 通过；`tsx scripts/smoke-load.mjs` 两形态通过
- 真 PG 测试覆盖：金额公式、三态状态机、org 隔离双向、访客只读自己的工单、幂等提交
- 审批状态词表定死一套英文枚举（spec §5 #9）
EOF
)"
```

Expected: 输出一条新 issue 的 URL，形如 `https://github.com/MYTech-Co-LTD/platform-core/issues/<N>`。

- [ ] **Step 3: 记录 issue 号**

把 `<N>` 记下来并**在本计划文件里就地记一行**（后续任务要引用）：

```bash
# 把 <N> 换成真实号（只改这一行）
printf '\n<!-- issue: #<N> -->\n' >> docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md
```

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md
git commit -m "docs(aftersales): M2a 实施计划落盘并挂 issue #<N>"
```

---

### Task 2: 架构文档先行（先改文档，再写代码）

> `~/.claude/rules/common/architecture-first.md`：**先经人同意 → 更新架构文档 → 再写代码**，顺序不得颠倒。
> 用户已就 spec 拍板（本模块随 spec-3 试点交付），本任务是把这次落地**登记进架构文档**。

**Files:**
- Modify: `docs/architecture.md:57`（§2 组件表 `modules/<id>` 行）
- Modify: `docs/architecture.md:130`（§5 扩展点，末尾追加第 8 条）

**Interfaces:**
- Consumes: 无
- Produces: 无（纯文档）。T3 之后代码落地即与本行描述一致。

- [ ] **Step 1: 改 §2 组件表的 `modules/<id>` 行**

把 `docs/architecture.md` 第 57 行

```
| `modules/<id>` | 业务模块（现为 `demo` 占位） | `@platform/sdk`（+ 前端库） | 无人；由宿主装载 |
```

整行替换为

```
| `modules/<id>` | 业务模块。现为 `demo`（占位）与 `aftersales`（**第一个真业务模块**：售后域。M2a 只有域 API + 建表 + ZOS 预签名，console/mobile 归 M3） | `@platform/sdk`（+ 前端库；`aftersales` 另有 `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` 做天翼 ZOS 预签名） | 无人；由宿主装载 |
```

- [ ] **Step 2: §5 扩展点末尾追加第 8 条**

在 `docs/architecture.md` 第 130 行（`7. 部署**一般不用动**…`）之后、第 132 行的
`→ 逐条契约…` 之前，插入：

```
8. 有**外部访客面**（移动端/公众号客户）的模块：manifest 增声明 `guest: { scope }`
   （`scope` 必须 ∈ 本模块 `permissions[].code`，schema 拒绝越界），宿主 `wechat-oa` 访客登录路
   按**该租户已启用模块**发放这些码；访客面的端点照常在 `api.internal[]` 里**逐条声明**（scope
   用那个 guest 码），**不另开一套门禁**。访客身份不落 Casdoor（外部用户不进内部 IdP）。
   路径必须与管理端**分面**（如 `/guest/*`）——同 `(method, path)` 只能声明一次。
   → 例：`modules/aftersales`（首个使用者）；协议细节读 `docs/module-protocol.md`
```

- [ ] **Step 3: 自查门禁未被文档改动带偏**

```bash
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
```

Expected: 两条都 `OK`。文档不在门禁扫描面内（`SCAN_ROOTS` 是 `apps/ packages/ modules/`），
此步只是确认没手滑改到代码。

- [ ] **Step 4: 提交**

```bash
git add docs/architecture.md
git commit -m "docs(architecture): 组件表登记首个真业务模块 aftersales + 扩展点补访客面声明 (#<N>)"
```

---

### Task 3: 模块骨架 + 迁移建表（空 API，装载冒烟通过）

**这一任务交付什么**：一个**能被宿主装载、能建表、能被门禁放行**的模块，API 面为空。
空 API 是**合法**的——`api.internal` 在 schema 里是可选的，装载期双向核对是「空集合 vs 空集合」，相等即通过。

**Files:**
- Create: `modules/aftersales/package.json`
- Create: `modules/aftersales/tsconfig.json`
- Create: `modules/aftersales/vitest.config.ts`
- Create: `modules/aftersales/README.md`
- Create: `modules/aftersales/manifest.yaml`
- Create: `modules/aftersales/index.ts`
- Create: `modules/aftersales/migrations/001_init.sql`
- Create: `modules/aftersales/test-util.ts`
- Test: `modules/aftersales/module.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ModuleDefinition`（default export of `modules/aftersales/index.ts`）——T6–T9 往里加注册
  - `modules/aftersales/test-util.ts` 导出三个值：`makeIdentity(partial): Identity`、
    `buildTestApp(mod: ModuleDefinition, identity: Identity, ctx: ModuleContext): Hono`、
    `applyMigrations(pool: Pool): Promise<string[]>`
  - DB 表 7 张（列定义见 `001_init.sql`）

- [ ] **Step 1: 写 `modules/aftersales/package.json`**

```json
{
  "name": "aftersales",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0",
    "@platform/sdk": "workspace:*",
    "hono": "^4.13.0",
    "pg": "^8.16.0",
    "yaml": "^2.9.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/pg": "^8.18.0",
    "vitest": "^3.2.7"
  }
}
```

> `pg` 必须在 `dependencies` 里显式声明（pnpm workspace 不提升未声明的依赖）——路由文件要
> `import type { Pool } from 'pg'`。AWS 两个包同样必须在**本任务**一次装齐：T5 只加 `storage.ts`，
> 不改 `package.json`，这样 Wave 1 的 T4/T5 才真正零文件重叠。

- [ ] **Step 2: 写 `modules/aftersales/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  // 测试文件归 vitest 管（同 apps/server 与 auth-core 惯例：测试代码不做 strict-null 迁就）
  "include": ["**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

- [ ] **Step 3: 写 `modules/aftersales/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

// 售后模块是纯后端（无 console/mobile 页面）⇒ node 环境，不需要 happy-dom / jsx 配置。
export default defineConfig({
  test: { environment: 'node' },
})
```

- [ ] **Step 4: 写 `modules/aftersales/README.md`**

```markdown
# `modules/aftersales` — 售后域（platform-core 第一个真业务模块）

设计与分期见 `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`；
M2a（本模块当前形态）实施计划见 `docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md`。

## 表分类声明（`docs/module-protocol.md`「租户数据隔离」要求）

**本模块没有全局表**：`001_init.sql` 建的全部 7 张表
（`ticket` / `ticket_rule` / `ticket_attachment` / `store` / `product` / `employee` / `region`
及后续增量）都是**租户数据表**，每张都带 `org text not null`，读写一律 `where org = $1`。

按纪律，**全局表**（字典/配置类跨租户共享）才需要在本文声明理由——本模块无此类表，故无豁免项。
评审时请按此核对：若将来新增无 `org` 列的表，必须在本文补「为什么它可以是全局表」。

## 没有的东西（别当成疏漏）

- **数据迁移不在本模块**：全量拉取/清洗/入库/对账是 M2b，另出计划、择业务空闲窗口跑。
- **`archive_order` / `archive_order_item` / `department` 不在这里**：归 M2b 建（无实测样本 / 无源表）。
- **console 页面与移动端 userApp 不在这里**：归 M3。
```

- [ ] **Step 5: 写 `modules/aftersales/manifest.yaml`（空 API 形态）**

```yaml
id: aftersales
name: 售后管理
version: 0.1.0
platform: '>=0.1'
permissions:
  - { code: aftersales:manage, name: 售后管理端 }
  - { code: aftersales:guest,  name: 售后访客 }
# 访客码声明（spec §1.3 协议小扩展）：hosting 的 wechat-oa 登录路按该租户已启用模块发放这个码。
# 管理端与访客端的端点都在下面 api.internal 里逐条声明——分为两面是因为同一个
# (method, path) 只能声明一次、一条声明只带一个 scope（spec §2.2「路径按 scope 分面」）。
guest: { scope: aftersales:guest }
# api.internal 暂时为空：装载期双向核对是「空集合 vs 空集合」，本任务先交付「能装载 + 能建表」。
# T6–T9 每加一个域，就在同一个提交里同步追加声明与路由——两边不一致 = 进程起不来。
api:
  internal: []
migrations: { dir: ./migrations }
```

- [ ] **Step 6: 写 `modules/aftersales/index.ts`（空 router）**

```ts
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { Identity } from '@platform/sdk'

// 装配形状照 modules/demo/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  // 本任务先返回空 router：装载期双向核对（注册集合 ⟺ 声明集合）在两边都空时通过。
  // T6 起逐域在这里 register*；每次注册都必须与 manifest 的声明同批改。
  createRouter: () => new Hono<{ Variables: { identity: Identity } }>(),
})
```

- [ ] **Step 7: 写 `modules/aftersales/migrations/001_init.sql`**

```sql
-- 001_init.sql — 售后域 M2a 建表（modules/aftersales）。
--
-- 纪律（每条都有出处，别按口味改）：
--   · 全是【租户数据表】：带 org text not null，值 = identity.orgId，读写一律 where org = …（spec-1 §2）
--   · 唯一索引一律含 org；热路径索引以 org 为前缀列
--   · 金额一律【整数分】，列名 _minor 后缀，永不浮点（spec §2.1）
--   · 比例列 numeric(6,4)：源 after_sales_rule.refund_ratio 存的是【小数比例】不是百分数，
--     保存走 .toFixed(4)（spec §2.4 源码实证）——6 位精度 4 位小数，与源逐位对齐
--   · 外部系统来的字段（编码/编号/名称）一律 text，不用 varchar（团队规则 db-migration §2）
--   · 幂等：全部 if not exists——部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 不建 archive_order / archive_order_item / department：都归 M2b（spec §2.1，无实测样本/无源表）
--
-- source_id 列的存在理由：M2b 要把 13.2 万行源数据搬进来，靠 (org, source_id) 才能做成幂等、
-- 可重跑；M2a 自己创建的行 source_id 为空串，用【部分唯一索引】避开空串互撞。

create schema if not exists aftersales;

-- ── 共用主数据（「可搬迁」纪律：通用资源名，不掺售后语义；接龙二期有第二消费者时再评估抽独立模块）──

create table if not exists aftersales.region (
  id         bigserial primary key,
  org        text not null,
  source_id  text not null default '',
  name       text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists aftersales_region_org_source_idx
  on aftersales.region(org, source_id) where source_id <> '';
create index if not exists aftersales_region_org_idx on aftersales.region(org);

create table if not exists aftersales.store (
  id         bigserial primary key,
  org        text not null,
  source_id  text not null default '',
  name       text not null default '',
  region_id  bigint references aftersales.region(id),
  address    text not null default '',
  phone      text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists aftersales_store_org_source_idx
  on aftersales.store(org, source_id) where source_id <> '';
create index if not exists aftersales_store_org_idx on aftersales.store(org);

create table if not exists aftersales.product (
  id                     bigserial primary key,
  org                    text not null,
  source_id              text not null default '',
  name                   text not null default '',
  spec                   text not null default '',
  -- 免赔门槛的两个输入（spec §2.4 金额公式的 basic_quantity / basic_unit_price）。单价是【整数分】。
  -- default 0 的语义是「未录」——M2a 不造假数据；M2b 按 product_archive 实测字段回填（spec §5 #7 的邻接项）。
  basic_quantity         integer not null default 0,
  basic_unit_price_minor bigint  not null default 0,
  created_at             timestamptz not null default now()
);
create unique index if not exists aftersales_product_org_source_idx
  on aftersales.product(org, source_id) where source_id <> '';
-- 商品搜索的热路径：where org = $1 and name ilike $2 —— org 前缀列
create index if not exists aftersales_product_org_name_idx on aftersales.product(org, name);

create table if not exists aftersales.employee (
  id             bigserial primary key,
  org            text not null,
  source_id      text not null default '',
  name           text not null default '',
  phone          text not null default '',
  store_id       bigint references aftersales.store(id),
  -- 移动端身份锚（spec §2.1）：源 employee_info.openId 全量带过来。
  -- 注意源侧同一概念两种拼写：employee_info.openId vs employee_info_approve.openid —— M2b join 前必须归一（spec §3.3）。
  open_id        text not null default '',
  -- 审批态：定死一套【英文】枚举（spec §5 #9）。源侧三套词表（pending|approved|rejected、
  -- 待审批|通过|驳回）在 M2b 归一到这里；中文只是展示层的事，不入库。
  approve_status text not null default 'pending'
                 check (approve_status in ('pending', 'approved', 'rejected')),
  created_at     timestamptz not null default now()
);
create unique index if not exists aftersales_employee_org_source_idx
  on aftersales.employee(org, source_id) where source_id <> '';
create index if not exists aftersales_employee_org_openid_idx on aftersales.employee(org, open_id);

create table if not exists aftersales.ticket_rule (
  id           bigserial primary key,
  org          text not null,
  source_id    text not null default '',
  name         text not null default '',
  -- 源 after_sales_rule.refund_ratio：类型注释谎称「比例(%)」，实存【小数】，
  -- 载入时 ×100、保存时 ÷100、保存走 .toFixed(4)（spec §2.4 源码实证）⇒ numeric(6,4)。
  -- 公式里它直接当乘数用：basic_quantity * refund_ratio。
  refund_ratio numeric(6,4) not null default 0,
  remark       text not null default '',
  created_at   timestamptz not null default now()
);
create unique index if not exists aftersales_ticket_rule_org_source_idx
  on aftersales.ticket_rule(org, source_id) where source_id <> '';
create index if not exists aftersales_ticket_rule_org_idx on aftersales.ticket_rule(org);

-- ── 工单（M2a 的核心表）──

create table if not exists aftersales.ticket (
  id                     bigserial primary key,
  org                    text not null,
  source_id              text not null default '',
  code                   text not null default '',
  -- 客户端幂等键（spec §2.2）：同 org 同键重复提交【返回既有工单】，不再靠前端 300ms 防抖扛并发。
  -- 它同时是附件 object key 里的 {ticket_ref} 段（spec §2.3）——因为附件必须先于工单落库上传。
  client_request_id      text not null default '',
  -- 提交者 = 访客 session 的 sub（openid，spec §1.3）。管理端代提交时留空串。
  submitter_openid       text not null default '',
  product_id             bigint references aftersales.product(id),
  -- 消歧（spec §3.3 实证表）：源 product_name 存 ID 或名称，目标拆成 id + 快照名两列，M2b 一次洗清。
  product_name           text not null default '',
  store_id               bigint references aftersales.store(id),
  store_name             text not null default '',
  damage_quantity        integer not null default 0,
  -- 提交时从 product 快照下来的三个公式输入（spec §2.4）：
  -- 快照而非 join 实时取——规则/商品改价不得改写历史工单的金额依据。
  basic_quantity         integer not null default 0,
  basic_unit_price_minor bigint  not null default 0,
  -- 三态状态机（spec §2.4）：pending → completed | cancelled。
  -- 源 types/afterSalesWorkOrder.ts 那个含 processing 的 4 态版本【全仓从未写入过】，是死声明，勿照搬。
  status                 text not null default 'pending'
                         check (status in ('pending', 'completed', 'cancelled')),
  -- 金额类型（源 after_sales_type）：【处理时】写入，pending 期间为 null。
  amount_type            text check (amount_type in ('ratio', 'fixed', 'reject')),
  amount_minor           bigint not null default 0,
  -- ratio 路落这里的比例（源 after_sales_rate）；fixed/reject 路为 null。
  refund_ratio           numeric(6,4),
  operator               text,
  remark                 text not null default '',
  -- 只读档案表引用（spec §2.1）：archive_order 本身归 M2b 建，M2a 只留这一列。
  related_order          text not null default '',
  created_at             timestamptz not null default now(),
  processed_at           timestamptz
);
create unique index if not exists aftersales_ticket_org_clientreq_idx
  on aftersales.ticket(org, client_request_id) where client_request_id <> '';
create unique index if not exists aftersales_ticket_org_source_idx
  on aftersales.ticket(org, source_id) where source_id <> '';
-- 热路径索引以 org 为前缀列。列表查询形状：
--   管理端 where org = $1 [and status = $2] order by id desc
--   访客端 where org = $1 and submitter_openid = $2 order by id desc
create index if not exists aftersales_ticket_org_id_idx on aftersales.ticket(org, id desc);
create index if not exists aftersales_ticket_org_status_id_idx on aftersales.ticket(org, status, id desc);
create index if not exists aftersales_ticket_org_submitter_id_idx
  on aftersales.ticket(org, submitter_openid, id desc);

create table if not exists aftersales.ticket_attachment (
  id                bigserial primary key,
  org               text not null,
  -- 预签名发生在工单落库【之前】（移动端先传图后提交）⇒ 此列为 null 表示「已上传、尚未被工单认领」。
  -- 提交工单时按 (org, client_request_id) 把这些行认领过去。
  ticket_id         bigint references aftersales.ticket(id),
  client_request_id text not null default '',
  object_key        text not null,
  content_type      text not null default '',
  size_bytes        bigint not null default 0,
  uploader_openid   text not null default '',
  created_at        timestamptz not null default now()
);
create unique index if not exists aftersales_ticket_attachment_org_key_idx
  on aftersales.ticket_attachment(org, object_key);
create index if not exists aftersales_ticket_attachment_org_ticket_idx
  on aftersales.ticket_attachment(org, ticket_id);
create index if not exists aftersales_ticket_attachment_org_clientreq_idx
  on aftersales.ticket_attachment(org, client_request_id);
```

- [ ] **Step 8: 写 `modules/aftersales/test-util.ts`**

```ts
// test-util.ts — 模块测试的公共脚手架（不是测试文件：tsconfig 会 typecheck 它）。
import { readdir, readFile } from 'node:fs/promises'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, ModuleContext, ModuleDefinition } from '@platform/sdk'
// 【刻意】不复制 apps/server/src/migrate.ts 的实现。重跑语义（记账表 platform.schema_migrations、
// 单文件单事务、按文件名排序）是行为契约：复制一份就是第二个事实源，改一边另一边不生效，
// 而症状是「本地过了 CI 没过」这种最贵的错。跨包相对引用在这里是合理代价。
import { runMigrations } from '../../apps/server/src/migrate'

/** 造一个身份。默认给管理端码——访客面测试显式传 scopes: ['aftersales:guest']。 */
export function makeIdentity(partial: Partial<Identity> & { orgId: string }): Identity {
  const scopes = partial.scopes ?? ['aftersales:manage']
  return {
    userId: partial.userId ?? 'u-test',
    orgId: partial.orgId,
    displayName: partial.displayName ?? '测试用户',
    scopes,
    hasScope: (code: string) => scopes.includes(code),
  }
}

/**
 * 模块路由的测试壳：注入 identity 后把模块 router 挂在 '/'。
 *
 * 它与宿主 app.ts 的装配【不同源】——宿主那层（租户解析、会话、门卫、停用闸门）不在这里。
 * 端到端形态的断言（含门卫与闸门）归 apps/server 的测试，本壳只覆盖模块自身的业务行为。
 * 这样分工是为了让模块测试不依赖宿主的装配细节（宿主改了装配不该红在模块测试上）。
 */
export function buildTestApp(
  mod: ModuleDefinition,
  identity: Identity,
  ctx: ModuleContext,
): Hono {
  const app = new Hono<{ Variables: { identity: Identity } }>()
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    await next()
  })
  app.route('/', mod.createRouter(ctx))
  return app
}

/** 跑本模块的迁移（读 ./migrations/*.sql）。返回本次新应用的 version 列表。 */
export function applyMigrations(pool: Pool): Promise<string[]> {
  return runMigrations(pool, 'aftersales', new URL('./migrations', import.meta.url).pathname)
}

/** 迁移目录里全部 *.sql 的正文，按文件名排序（与 runMigrations 同一排序口径）。 */
export async function rawMigrationSqls(): Promise<string[]> {
  const dir = new URL('./migrations', import.meta.url)
  const entries = await readdir(dir)
  const files = entries.filter((f) => f.endsWith('.sql')).sort()
  return Promise.all(files.map((f) => readFile(new URL(f, dir), 'utf8')))
}
```

- [ ] **Step 9: 写失败的测试 `modules/aftersales/module.test.ts`**

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
  it('manifest.yaml 过 schema，且 id / 权限码 / guest 码三者自洽', () => {
    const raw = parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8'))
    const m = ManifestSchema.parse(raw)
    expect(m.id).toBe('aftersales')
    expect(m.permissions.map((p) => p.code).sort()).toEqual(['aftersales:guest', 'aftersales:manage'])
    expect(m.guest?.scope).toBe('aftersales:guest')
    expect(m.migrations?.dir).toBe('./migrations')
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
    // 池在文件级 afterAll 之前就被 end 了 ⇒ 说明有别的钩子提前收摊，本文件后续断言会假红。
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('applyMigrations 幂等：连跑两次，第二次不新应用任何版本', async () => {
    await applyMigrations(pool)
    const second = await applyMigrations(pool)
    expect(second).toEqual([])
  })

  it('迁移 SQL 本身幂等：不记账、直接连跑两遍不报错（部署脚本会全量重跑）', async () => {
    // 这条测的是【模块自己的产物】，与上一条测的【runner 记账】是两回事：
    // runMigrations 第二次因记账而跳过 SQL，等于没验 DDL 的 if not exists。
    // 而 db-migration.md §1 要的正是「同一批迁移重复执行不报错」。
    const sqls = await rawMigrationSqls()
    expect(sqls.length).toBeGreaterThan(0)
    for (const sql of sqls) {
      await pool.query(sql)
      await pool.query(sql)
    }
  })

  it('7 张表全部落库，且每张都带 org 列（租户数据表纪律）', async () => {
    const tables = ['region', 'store', 'product', 'employee', 'ticket_rule', 'ticket', 'ticket_attachment']
    const res = await pool.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'aftersales' and table_name = any($1::text[])`,
      [tables],
    )
    const byTable = new Map<string, string[]>()
    for (const r of res.rows) {
      byTable.set(r.table_name, [...(byTable.get(r.table_name) ?? []), r.column_name])
    }
    for (const t of tables) {
      expect(byTable.get(t), `表 aftersales.${t} 不存在`).toBeDefined()
      expect(byTable.get(t), `表 aftersales.${t} 缺 org 列`).toContain('org')
    }
  })
})
```

- [ ] **Step 10: 安装依赖并跑测试，确认失败**

```bash
pnpm install
pnpm --filter aftersales test
```

Expected: **FAIL** —— `Cannot find module '../../apps/server/src/migrate'`（若 `test-util.ts` 写错路径）
或先因 `modules/aftersales/index.ts` 不存在而失败。若第 9 步的文件都已存在，本步应当**通过**；
真正需要确认的是「失败是预期的失败」而不是环境噪音。

> 若 `pnpm install` 因网络失败：本机 docker/registry 走 smart-proxy。先按
> `~/.claude/CLAUDE.md` §3「生产机 docker 拉镜像的口径」确认无残留 `registry-mirrors`，
> 再重试；仍失败就升级给人，**不要**改用别的 S3 客户端绕开。

- [ ] **Step 11: 跑模块测试（真 PG）**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm --filter aftersales test
```

Expected: **PASS**（`manifest` 两条 + `迁移` 两条）。

> 本地 `DATABASE_URL` 取 `deploy/docker-compose.yml` 的 platform-pg（仅回环端口，B7 守着）。
> 没有 `.env` 时先照 `.env.example` 建一份；**不要把真实连接串提交进仓**。

- [ ] **Step 12: 跑全仓门禁**

```bash
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-env-example.mjs
```

Expected: 全绿。`check-manifests` 会走到 `modules/aftersales/manifest.yaml`——它校验
`migrations.dir` 指向的目录**必须存在**（`./migrations` 相对 manifest 自身位置，
`packages/platform-sdk/src/checks.ts:118-121`）。本任务已建该目录，故这一步同时验证了它。

- [ ] **Step 13: 跑装载冒烟（证明宿主真能把它装起来）**

```bash
pnpm --filter @platform/web build
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm exec tsx scripts/smoke-load.mjs
```

Expected: PASS。这一步是**本任务的核心证据**：模块能被真宿主装载、迁移被宿主自动跑掉、
manifest 与路由（此刻都是空集合）双向核对通过。

- [ ] **Step 14: 提交**

```bash
git add modules/aftersales
git commit -m "feat(aftersales): 模块骨架与建表迁移——7 张租户数据表，API 面暂空 (#<N>)"
```

---

## Wave 1（T4 ‖ T5 —— 两组文件零重叠，可并行）

> 本波两个任务**不碰同一文件**：T4 只动 `modules/aftersales/domain/`，T5 只动
> `modules/aftersales/storage.ts` + 仓库根 `.env.example`。T3 已把两个 AWS 包与 `pg` 装进
> `package.json`，所以 T5 **不需要**改 `package.json`——这正是 T3 要「一次装齐」的原因。

---

### Task 4: 业务内核 `domain/ticket.ts`（金额公式 + 三态状态机，纯函数）

> **实施订正（2026-09-15，T4 评审 R4 后回写）**：本节的代码块原把 ratio 路写成
> 「用全精度比例算钱 + 原样返回」，与本节 T7 用例「提交 `0.123456789` ⇒ 落库 `'0.1235'`」自相矛盾
> ⇒ 库里 `(refund_ratio, amount_minor)` 复算不上（实测差 250 分 / 167 分）。
> 已按裁决改为**在 domain 层归一到存储契约（4 位）**并导出 `normalizeRatio`（T6/T7 共用），
> `assertValidRatio` 降为它的薄封装。**下方实现代码块与仓内 `modules/aftersales/domain/ticket.ts`
> 逐字节一致**（去掉首尾围栏行后与仓内文件 `diff` 应为空——**可自行机检**，故此处不钉某个 commit SHA：
> 钉 SHA 会随下一次纯注释改动再次过期）；
> 仅测试代码块未同步（实际 23 条用例，见仓内文件）。裁决留痕：`.superpowers/sdd/2026-09-15-aftersales-m2a-module-backend/progress.md`。

**Files:**
- Create: `modules/aftersales/domain/ticket.ts`
- Test: `modules/aftersales/domain/ticket.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，不依赖 T3 之外的任何东西）
- Produces:
  - `type TicketStatus = 'pending' | 'completed' | 'cancelled'`
  - `type AmountType = 'ratio' | 'fixed' | 'reject'`
  - `class AmountValidationError extends Error`
  - `const MAX_FIXED_AMOUNT_MINOR = 100_000_000`
  - `computeAmountMinor(i: {damageQuantity: number; basicQuantity: number; basicUnitPriceMinor: number; refundRatio: number}): number`
  - `resolveProcess(ticket: {damageQuantity: number; basicQuantity: number; basicUnitPriceMinor: number}, input: ProcessInput): ProcessOutcome`
  - `isProcessable(status: TicketStatus): boolean`
  - `assertValidRatio(r: number): void` / `assertValidFixedAmount(m: number): void`
  - `const REFUND_RATIO_DECIMALS = 4`
  - `normalizeRatio(r: number): number`（校验 + 四舍五入到 4 位小数并【返回归一值】；`assertValidRatio` 是它丢弃返回值的薄封装）
  - `const TICKET_STATUSES = ['pending', 'completed', 'cancelled'] as const`（`TicketStatus` 由它派生）
  - `toMinor(v: string | number | null | undefined): number`
  - `toRatioOrNull(v: string | number | null | undefined): number | null`
  - T6/T7 直接复用 `resolveProcess` / `normalizeRatio` / `toMinor` / `toRatioOrNull`

- [ ] **Step 1: 写失败的测试 `modules/aftersales/domain/ticket.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import {
  AmountValidationError,
  MAX_FIXED_AMOUNT_MINOR,
  assertValidFixedAmount,
  assertValidRatio,
  computeAmountMinor,
  isProcessable,
  resolveProcess,
  toMinor,
  toRatioOrNull,
} from './ticket'
import type { TicketStatus } from './ticket'

describe('computeAmountMinor —— spec §2.4 金额公式', () => {
  const base = { basicQuantity: 100, basicUnitPriceMinor: 500, refundRatio: 0.1 }

  it('刚好等于免赔门槛 ⇒ 0', () => {
    expect(computeAmountMinor({ ...base, damageQuantity: 10 })).toBe(0)
  })

  it('低于门槛（门槛内）⇒ 0，不出现负数', () => {
    expect(computeAmountMinor({ ...base, damageQuantity: 3 })).toBe(0)
    expect(computeAmountMinor({ ...base, damageQuantity: 0 })).toBe(0)
  })

  it('超出门槛的部分才赔：(30 − 100×0.1) × 500 分 = 10000 分', () => {
    expect(computeAmountMinor({ ...base, damageQuantity: 30 })).toBe(10_000)
  })

  it('比例为 0 ⇒ 全额赔：3 × 250 = 750 分', () => {
    expect(
      computeAmountMinor({ damageQuantity: 3, basicQuantity: 100, basicUnitPriceMinor: 250, refundRatio: 0 }),
    ).toBe(750)
  })

  it('小数门槛算出的分位按四舍五入进位：(1 − 1×0.5) × 1 分 = 0.5 分 ⇒ 1 分', () => {
    expect(
      computeAmountMinor({ damageQuantity: 1, basicQuantity: 1, basicUnitPriceMinor: 1, refundRatio: 0.5 }),
    ).toBe(1)
  })

  it('比例是【小数】不是百分数：0.1 的门槛是 10 件，不是 0.1 件', () => {
    // 若被误当百分数（ratio=10）门槛会变成 1000 件、结果恒 0。用正值钉住正确解释。
    expect(computeAmountMinor({ ...base, damageQuantity: 100 })).toBe(45_000)
  })
})

describe('resolveProcess —— 三态状态机 + 金额类型（spec §2.4）', () => {
  const ticket = { damageQuantity: 30, basicQuantity: 100, basicUnitPriceMinor: 500 }

  it('ratio 路 ⇒ completed、按公式算钱、落比例', () => {
    expect(resolveProcess(ticket, { amountType: 'ratio', refundRatio: 0.1 })).toEqual({
      status: 'completed',
      amountType: 'ratio',
      amountMinor: 10_000,
      refundRatio: 0.1,
    })
  })

  it('fixed 路 ⇒ completed、【采信操作员输入】而不是重算', () => {
    // 这条钉的是 §0.3「前端金额不采信」的【明写例外】：固定额是业务输入而非计算值。
    // 如果哪天有人"顺手"让 fixed 也走公式，这条必须红。
    expect(resolveProcess(ticket, { amountType: 'fixed', amountMinor: 12_345 })).toEqual({
      status: 'completed',
      amountType: 'fixed',
      amountMinor: 12_345,
      refundRatio: null,
    })
  })

  it('reject 路 ⇒ cancelled、金额强制 0（即便这张工单本来算得出钱）', () => {
    expect(resolveProcess(ticket, { amountType: 'reject' })).toEqual({
      status: 'cancelled',
      amountType: 'reject',
      amountMinor: 0,
      refundRatio: null,
    })
  })

  it('fixed 金额非法（负 / 小数 / 超上界）⇒ AmountValidationError，不静默取整', () => {
    expect(() => resolveProcess(ticket, { amountType: 'fixed', amountMinor: -1 })).toThrow(AmountValidationError)
    expect(() => resolveProcess(ticket, { amountType: 'fixed', amountMinor: 1.5 })).toThrow(AmountValidationError)
    expect(() =>
      resolveProcess(ticket, { amountType: 'fixed', amountMinor: MAX_FIXED_AMOUNT_MINOR + 1 }),
    ).toThrow(AmountValidationError)
  })

  it('fixed 金额边界（0 与上界）⇒ 放行', () => {
    expect(assertValidFixedAmount(0)).toBeUndefined()
    expect(assertValidFixedAmount(MAX_FIXED_AMOUNT_MINOR)).toBeUndefined()
  })

  it('ratio 越界（<0 / >1 / NaN / Infinity）⇒ AmountValidationError', () => {
    for (const bad of [-0.1, 1.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveProcess(ticket, { amountType: 'ratio', refundRatio: bad })).toThrow(
        AmountValidationError,
      )
    }
    expect(assertValidRatio(0)).toBeUndefined()
    expect(assertValidRatio(1)).toBeUndefined()
  })
})

describe('isProcessable', () => {
  it('只有 pending 可处理；completed / cancelled 都是已终态', () => {
    expect(isProcessable('pending')).toBe(true)
    expect(isProcessable('completed')).toBe(false)
    expect(isProcessable('cancelled')).toBe(false)
  })
})

describe('pg 类型陷阱的收口（bigint 与 numeric 都返回【字符串】）', () => {
  it('toMinor：字符串、数字、null 都能落到 number', () => {
    expect(toMinor('10000')).toBe(10_000)
    expect(toMinor(10_000)).toBe(10_000)
    expect(toMinor(null)).toBe(0)
    expect(toMinor(undefined)).toBe(0)
  })

  it('toRatioOrNull：null 保持 null（fixed/reject 路的比例就是 null，不是 0）', () => {
    expect(toRatioOrNull('0.1000')).toBe(0.1)
    expect(toRatioOrNull(null)).toBeNull()
    expect(toRatioOrNull(undefined)).toBeNull()
  })
})

describe('TicketStatus 的取值就是源侧权威三态', () => {
  it('没有 processing —— 源 types/afterSalesWorkOrder.ts 那个 4 态版全仓零写入，是死声明', () => {
    const all: TicketStatus[] = ['pending', 'completed', 'cancelled']
    expect(all).toHaveLength(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter aftersales test domain/ticket.test.ts
```

Expected: FAIL —— `Failed to resolve import "./ticket"`。

- [ ] **Step 3: 写实现 `modules/aftersales/domain/ticket.ts`**

```ts
// domain/ticket.ts — 售后工单的业务内核【纯函数】：没有 IO（无 pg、无 Hono、无 fetch）。
// 抽出来的理由：这是 M2a 里唯一必须逐行对齐源行为的逻辑（spec §2.4），得能脱离数据库被穷举测试。
// 路由层只负责取数、开事务、把结果落库——算与判一概在这里。

/**
 * 三态状态机（spec §2.4）：pending → completed | cancelled。
 * 这里是状态取值的【唯一事实源】：类型从数组派生、测试直接断言数组本身，
 * 所以「往状态集里加一个值」会让类型与断言同时跟上，不可能出现类型漂移。
 * 源 types/afterSalesWorkOrder.ts 那个含 processing 的 4 态版本全仓零写入，是死声明，勿照搬。
 */
export const TICKET_STATUSES = ['pending', 'completed', 'cancelled'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export type AmountType = 'ratio' | 'fixed' | 'reject'

/**
 * M2a 新增守卫（源侧没有这个上界）：fixed 的金额是操作员手输的，必须有个天花板挡住误输。
 * 取一百万元——远高于任何真实售后单，又远低于 Number.MAX_SAFE_INTEGER。
 *
 * 【作用域只到 fixed 路】只有 assertValidFixedAmount 用它。ratio 路的金额是按公式算出来的，
 * 【没有任何显式上界】——它的取值上界由「报损数量 × 单价的合法输入范围」决定，不由本常量兜底。
 */
export const MAX_FIXED_AMOUNT_MINOR = 100_000_000

/** 金额/比例校验失败。路由层捕获它 → 400 INVALID_AMOUNT（不静默取整、不静默归零）。 */
export class AmountValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmountValidationError'
  }
}

/**
 * pg 的类型陷阱，一个函数收口：
 *   · bigint(int8) 默认返回【字符串】（pg 怕超出 Number.MAX_SAFE_INTEGER 丢精度）
 *   · numeric 同样返回【字符串】——`ticket_rule.refund_ratio` 就是 numeric(6,4)
 * 不转就直接参与算术是最阴的一类 bug：`"1200" * 3` 会被 JS 算对，`"1200" + 1` 却变成 "12001"。
 * 转 Number 在这里安全：比例是 4 位小数；金额分两路——fixed 由 MAX_FIXED_AMOUNT_MINOR（1e8 分）卡住，
 * ratio 由「报损数量 × 单价的合法输入范围」决定。两路都远在 2^53 之内。
 * 【别外推】1e8 只是 fixed 路的上界，不是全模块的兜底——ratio 路的金额没有显式上界。
 */
export function toMinor(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'number' ? v : Number(v)
}

/** 同 toMinor，但 null 保持 null——fixed/reject 路的 refund_ratio 就是 null，不能落成 0。 */
export function toRatioOrNull(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  return typeof v === 'number' ? v : Number(v)
}

export interface AmountInput {
  /** 报损数量（件，整数） */
  damageQuantity: number
  /** 基本数量（件，整数）——免赔门槛的基数 */
  basicQuantity: number
  /** 基本单价（整数【分】/件） */
  basicUnitPriceMinor: number
  /** 售后比例（【小数】不是百分数，spec §2.4 源码实证） */
  refundRatio: number
}

/**
 * 售后金额（整数分）= (报损数量 − 基本数量 × 售后比例) × 基本单价；负数取 0；四舍五入到分。
 *
 * 源（afterSalesWorkOrderManage.vue:687-705）在浏览器里按「元」算，末尾 `Math.round(amount*100)/100`
 * 是按分的四舍五入；目标表单价本来就是分，所以这里只剩一次 `Math.round` 到分。
 *
 * 【与源侧的关系】这里是【精确算术的按分四舍五入】；与源侧在【恰好半分位】上可差 1 分
 * （源侧浮点噪声所致，非本实现算错）——例：q=14.5、单价 0.01 元，
 * 源序 `Math.round(14.5 × 0.01 × 100)` = 14（中间值 14.499999999999998），本实现 `Math.round(14.5 × 1)` = 15。
 * 数学真值 14.5 分四舍五入就是 15 ⇒ 规格「四舍五入到分」被本实现精确满足。
 * （按 q∈{0.5,…,200 半步} × 单价∈{1..3000 分} 扫描：1_200_000 组里 34_636 处分歧，全部落在恰好半分位。）
 *
 * `basicQuantity * refundRatio` 会产生 IEEE 浮点尾差（如 0.1×3 = 0.30000000000000004、
 * 3×0.29 = 0.8699999999999999），但结果只经过一次乘法就被舍入到整数分，误差被舍入吸收；
 * 不参与累加，不会像浮点金额那样攒出假差额。
 */
export function computeAmountMinor(i: AmountInput): number {
  const payableQuantity = i.damageQuantity - i.basicQuantity * i.refundRatio
  if (payableQuantity <= 0) return 0
  return Math.round(payableQuantity * i.basicUnitPriceMinor)
}

/**
 * 比例的存储契约：`ticket.refund_ratio` 是 numeric(6,4)（spec §2.4 源侧保存走 .toFixed(4)）。
 * 算钱用的比例与落库的比例必须是【同一个数】，否则库里 (refund_ratio, amount_minor) 自相矛盾
 * ——按落库比例复算得不出落库金额，正是 spec §2.1「整数分」要防的对账假差额。
 */
export const REFUND_RATIO_DECIMALS = 4

/**
 * 比例收口的【唯一实现】（纯函数，无 IO）：先按现有口径卡 [0, 1] 与有限性（越界抛
 * AmountValidationError），再把比例四舍五入到存储契约的 4 位小数，【返回归一后的值】。
 *
 * 为什么是「四舍五入」而不是「拒绝 >4 位小数」：列就是 numeric(6,4)，存 0.123456789 会被列型
 * 收窄成 0.1235；与其让列型自己收窄、或干脆拒绝，不如在这里收口——算钱与落库用同一个数。
 * （计划 2329-2334 行的用例即：提交 0.123456789 ⇒ 落库 refund_ratio = 0.1235，是成功不是 400。）
 *
 * 归一按【十进制真值】做，不直接 `Math.round(r * 1e4) / 1e4`：`r * 1e4` 会把浮点噪声一起放大，
 * 恰好半分位上会漏进位（0.00015、0.33335 这类）。口径以【十进制真值】为准——调用方给的字面值
 * 就是十进制的，不是以列型的舍入结果为准。实测：0..1 的 100_001 个 5 位小数字面量里，
 * 直乘有 573 个漏进位、被 toFixed 的二进制近似带偏的有 4992 个，本实现 0 个偏离十进制真值。
 * 先按 15 位有效数字把二进制尾差收干净（十进制输入在 double 里的噪声 ~1e-16 相对量级），再整数量化。
 *
 * 【与列型口径的关系：恰好半分位一致，但不是全域一致】别把这里读成「与 numeric(6,4) 逐值相同」：
 * 对「比 4 位半分位低 1–2 ulp」的 double，`(r * 1e4).toPrecision(15)` 会把乘积收成【恰好 x.5】
 * ⇒ 本实现按半分位进位；而列型看到的是【严格小于 x.5 的精确十进制】⇒ 舍去，两边差 1e-4
 * （例：r = 0.12344999999999999 ⇒ 本实现 0.1235、numeric(6,4) 列 0.1234）。
 * 真机实测（pg 16.15）：0.00005…0.99995 共 10_000 个 4 位半分位，各取相对最近 double 的
 * −2/−1/0/+1/+2 ulp，共 50_000 个候选 ⇒ 20_000 处分歧，全部落在 −1/−2 ulp（各 10_000），
 * 方向恒为「本实现 > 列型」、差恒 1e-4；这些输入距半步十进制真值 4e-21…3e-16。
 *
 * 【这不影响要害性质】本函数要保证的是「库里 (refund_ratio, amount_minor) 自洽」，靠的是
 * 【输出落进 numeric(6,4) 不再被改动】。实测 250_001 个输入（100_001 个 5 位小数字面量
 * + 上述 50_000 个边界候选 + 100_000 个伪随机 double），归一值再走一遍 numeric(6,4) 转换，
 * 0 违例。所以上面那处分歧只是「函数的舍入口径 vs 列型口径」在极窄窗口上的差别，
 * 不会在库里造出比例与金额对不上的记录。
 *
 * 注：先卡后归一 ⇒ 归一值必然仍在 [0, 1]（r ∈ [0,1] ⇒ r·10⁴ ∈ [0,10⁴] ⇒ 归一值 ∈ [0,1]），
 * 因此不需要再补一道「归一后复核」。
 */
export function normalizeRatio(r: number): number {
  if (!Number.isFinite(r) || r < 0 || r > 1) {
    throw new AmountValidationError(`refundRatio 必须在 [0, 1] 内（收到 ${r}）`)
  }
  const factor = 10 ** REFUND_RATIO_DECIMALS
  return Math.round(Number((r * factor).toPrecision(15))) / factor
}

/**
 * 比例合法性的校验面（签名与语义保持不变，返回 void）。工单处理（ratio 路）与规则写侧（T7）
 * 共用这一条口径：内部委托 normalizeRatio 后丢弃返回值——「一条口径只有一个实现」，
 * 改了归一也就改了校验，不会两边漂移。
 */
export function assertValidRatio(r: number): void {
  normalizeRatio(r)
}

/** 固定额必须是非负【整数分】且不超过 MAX_FIXED_AMOUNT_MINOR。 */
export function assertValidFixedAmount(m: number): void {
  if (!Number.isInteger(m)) {
    throw new AmountValidationError(`固定金额必须是整数分（收到 ${m}）`)
  }
  if (m < 0) {
    throw new AmountValidationError(`固定金额不能为负（收到 ${m}）`)
  }
  if (m > MAX_FIXED_AMOUNT_MINOR) {
    throw new AmountValidationError(
      `固定金额超出上界 ${MAX_FIXED_AMOUNT_MINOR} 分（收到 ${m}）`,
    )
  }
}

/**
 * 可处理状态（三态里的 pending）。`satisfies TicketStatus` 把它钉在 TICKET_STATUSES 派生出的类型上
 * ——取值表改名/删值，这里编译期就报错，不会静默漂移；同时口径不放宽：
 * 只列进来的这一态算可处理（fail-closed），将来多出第四态默认【不可】处理。
 */
const PROCESSABLE_STATUS = 'pending' satisfies TicketStatus

/** 只有 pending 可以进处理动作；completed / cancelled 都是终态。 */
export function isProcessable(status: TicketStatus): boolean {
  return status === PROCESSABLE_STATUS
}

/** 处理动作的输入——三个分支互斥，用 discriminated union 让路由层的 zod 与这里同形。 */
export type ProcessInput =
  | { amountType: 'ratio'; refundRatio: number }
  | { amountType: 'fixed'; amountMinor: number }
  | { amountType: 'reject' }

export interface ProcessOutcome {
  status: TicketStatus
  amountType: AmountType
  amountMinor: number
  refundRatio: number | null
}

/**
 * 把一个处理动作解析成「状态 + 金额 + 比例」——纯函数，不碰数据库。
 * 三条路对应 spec §2.4 的三种金额类型，其中 fixed 是【采信操作员输入】（校验而非重算）。
 */
export function resolveProcess(
  ticket: { damageQuantity: number; basicQuantity: number; basicUnitPriceMinor: number },
  input: ProcessInput,
): ProcessOutcome {
  switch (input.amountType) {
    case 'ratio': {
      // normalizeRatio 一次收口（校验 + 归一），归一值【同时】用于算钱与落库：
      // 不能拿全精度的比例算钱、却被 numeric(6,4) 收窄后落库——那样库里的
      // (refund_ratio, amount_minor) 复算不上，正是 §2.1「整数分」要防的对账假差额。
      // 校验口径不另起炉灶：assertValidRatio 就是本函数丢弃返回值的薄封装。
      const refundRatio = normalizeRatio(input.refundRatio)
      return {
        status: 'completed',
        amountType: 'ratio',
        amountMinor: computeAmountMinor({ ...ticket, refundRatio }),
        refundRatio,
      }
    }
    case 'fixed': {
      assertValidFixedAmount(input.amountMinor)
      return {
        status: 'completed',
        amountType: 'fixed',
        amountMinor: input.amountMinor,
        refundRatio: null,
      }
    }
    case 'reject':
      return { status: 'cancelled', amountType: 'reject', amountMinor: 0, refundRatio: null }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter aftersales test domain/ticket.test.ts
pnpm --filter aftersales typecheck
```

Expected: PASS（全部用例），typecheck 无输出。

- [ ] **Step 5: 提交**

```bash
git add modules/aftersales/domain
git commit -m "feat(aftersales): 工单业务内核——金额公式与三态状态机（纯函数 + 穷举单测） (#<N>)"
```

---

### Task 5: 天翼 ZOS 预签名存储 `storage.ts` + `.env.example` 五键

**Files:**
- Create: `modules/aftersales/storage.ts`
- Test: `modules/aftersales/storage.test.ts`
- Modify: `.env.example`（仓库根，末尾追加五个键）

**Interfaces:**
- Consumes: T3 已装好的 `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
- Produces:
  - `interface ZosConfig { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }`
  - `zosConfigFromEnv(env: NodeJS.ProcessEnv): ZosConfig | null`（**五个键缺一即 null**）
  - `normalizeEndpoint(raw: string): string`
  - `sanitizeOrgSegment(s: string): string`
  - `objectKeyFor(org: string, clientRequestId: string, uuid?: string): string`
  - `class ZosStorage { constructor(config: ZosConfig); presignPut(key, contentType, expiresIn?): Promise<string>; presignGet(key, expiresIn?): Promise<string> }`
  - `const UPLOAD_URL_TTL_SECONDS = 600` / `const DOWNLOAD_URL_TTL_SECONDS = 600`
  - T6/T9 用 `zosConfigFromEnv` 造 `RouteCtx.storage`；T9 用 `objectKeyFor` / `presignPut` / `presignGet`

- [ ] **Step 1: 写失败的测试 `modules/aftersales/storage.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import {
  UPLOAD_URL_TTL_SECONDS,
  ZosStorage,
  normalizeEndpoint,
  objectKeyFor,
  sanitizeOrgSegment,
  zosConfigFromEnv,
} from './storage'
import type { ZosConfig } from './storage'

const FULL_ENV = {
  AFTERSALES_ZOS_ENDPOINT: 'zos.xinan1.ctyun.cn',
  AFTERSALES_ZOS_REGION: 'xinan1',
  AFTERSALES_ZOS_BUCKET: 'aftersales-test',
  AFTERSALES_ZOS_ACCESS_KEY: 'AKIATEST',
  AFTERSALES_ZOS_SECRET: 'secret-test',
}

describe('normalizeEndpoint —— 天翼 ZOS 实测坑之一', () => {
  it('裸域名补 https://（WeKnora 实证：写成不带协议的域名会让签名/连接失败）', () => {
    expect(normalizeEndpoint('zos.xinan1.ctyun.cn')).toBe('https://zos.xinan1.ctyun.cn')
  })

  it('已有协议的不重复补', () => {
    expect(normalizeEndpoint('https://zos.xinan1.ctyun.cn')).toBe('https://zos.xinan1.ctyun.cn')
    expect(normalizeEndpoint('http://zos.internal')).toBe('http://zos.internal')
  })

  it('去首尾空白与尾斜杠（带尾斜杠会让 path-style 拼出双斜杠）', () => {
    expect(normalizeEndpoint('  zos.xinan1.ctyun.cn/  ')).toBe('https://zos.xinan1.ctyun.cn')
    expect(normalizeEndpoint('https://zos.xinan1.ctyun.cn///')).toBe('https://zos.xinan1.ctyun.cn')
  })
})

describe('sanitizeOrgSegment —— spec §2.3「key 不用裸 = 等需编码字符」', () => {
  it('保留 [A-Za-z0-9._-]，其余一律换 _', () => {
    expect(sanitizeOrgSegment('acme')).toBe('acme')
    expect(sanitizeOrgSegment('acme/山海=1')).toBe('acme____1')
  })
})

describe('objectKeyFor —— 形状 aftersales/{org}/{ticket_ref}/{uuid}', () => {
  it('三段拼齐，ticket_ref 放的是【客户端幂等键】而非库内主键（spec §2.3）', () => {
    expect(objectKeyFor('acme', 'req-1', '11111111-2222-3333-4444-555555555555')).toBe(
      'aftersales/acme/req-1/11111111-2222-3333-4444-555555555555',
    )
  })

  it('org 与幂等键都过净化，key 里不出现裸 / 与 =', () => {
    expect(objectKeyFor('a/b=c', 'x/y=z', 'u')).toBe('aftersales/a_b_c/x_y_z/u')
  })

  it('不传 uuid 时自动生成，且两次不同（避免同名单覆盖）', () => {
    const a = objectKeyFor('acme', 'req-1')
    const b = objectKeyFor('acme', 'req-1')
    expect(a).not.toBe(b)
    expect(a.startsWith('aftersales/acme/req-1/')).toBe(true)
  })
})

describe('zosConfigFromEnv —— CI 没有 ZOS 凭证时模块必须仍能装载', () => {
  it('五个键齐 ⇒ 返回配置，且 endpoint 已补协议', () => {
    expect(zosConfigFromEnv(FULL_ENV)).toEqual({
      endpoint: 'https://zos.xinan1.ctyun.cn',
      region: 'xinan1',
      bucket: 'aftersales-test',
      accessKeyId: 'AKIATEST',
      secretAccessKey: 'secret-test',
    })
  })

  it('完全没配 ⇒ null', () => {
    expect(zosConfigFromEnv({})).toBeNull()
  })

  it.each([
    'AFTERSALES_ZOS_ENDPOINT',
    'AFTERSALES_ZOS_REGION',
    'AFTERSALES_ZOS_BUCKET',
    'AFTERSALES_ZOS_ACCESS_KEY',
    'AFTERSALES_ZOS_SECRET',
  ])('少 %s ⇒ null（附件端点随后回 503，绝不半配置启动）', (missing) => {
    const env = { ...FULL_ENV, [missing]: '' }
    expect(zosConfigFromEnv(env)).toBeNull()
  })
})

describe('预签名（纯离线计算：本测试【不需要】真凭证、不联网）', () => {
  const config: ZosConfig = {
    endpoint: 'https://zos.xinan1.ctyun.cn',
    region: 'xinan1',
    bucket: 'aftersales-test',
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret-test',
  }
  const storage = new ZosStorage(config)

  it('presignPut：path-style（bucket 在【路径】里）+ SigV4 签名 + 短 TTL', async () => {
    const url = new URL(await storage.presignPut('aftersales/acme/req-1/u1', 'image/jpeg'))
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('zos.xinan1.ctyun.cn')
    // ← 这条是 path-style 的证明。若 forcePathStyle 丢了，pathname 会变成
    //   /aftersales/acme/req-1/u1（bucket 跑到 host 前缀去）——ZOS 实测必须 path-style。
    expect(url.pathname).toBe('/aftersales-test/aftersales/acme/req-1/u1')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(UPLOAD_URL_TTL_SECONDS))
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    // 凭证范围形如 AKIATEST/<date>/xinan1/s3/aws4_request
    expect(url.searchParams.get('X-Amz-Credential')).toContain('AKIATEST/')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/xinan1/')
  })

  it('presignGet：同样 path-style，TTL 独立可配', async () => {
    const url = new URL(await storage.presignGet('aftersales/acme/req-1/u1', 60))
    expect(url.pathname).toBe('/aftersales-test/aftersales/acme/req-1/u1')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('同一 key 的 GET 与 PUT 签名不同（方法进了签名）', async () => {
    const put = await storage.presignPut('k', 'image/jpeg')
    const get = await storage.presignGet('k')
    expect(new URL(put).searchParams.get('X-Amz-Signature')).not.toBe(
      new URL(get).searchParams.get('X-Amz-Signature'),
    )
  })
})
```

> **测试为什么不需要真凭证**：SigV4 是本地计算——`getSignedUrl` 只用密钥算 HMAC，不发任何网络
> 请求。所以 CI（没有 ZOS 密钥）也能完整跑这个文件。**真正需要真凭证的那部分（ZOS 收不收这个
> 签名）只能在有桶的环境里验**，本计划不含该验证——它属于 spec §3.4 的客户机 e2e 验收。

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter aftersales test storage.test.ts
```

Expected: FAIL —— `Failed to resolve import "./storage"`。

- [ ] **Step 3: 写实现 `modules/aftersales/storage.ts`**

```ts
// storage.ts — 天翼 ZOS（S3 兼容）预签名。
//
// 为什么预签名是【必选】而不是优化（spec §2.3）：移动端附件是手机拍的图片+视频，而平台全局
// bodyLimit ~1MiB —— 视频过服务器必炸。所以字节全程不过平台：上传/下载都换成短 TTL 的
// 预签名 URL，服务端只记录元数据。
//
// 两个实测坑（WeKnora 两条条目背书），都在下面用代码兜住：
//   ① endpoint 常被写成【不带协议】的域名 ⇒ normalizeEndpoint 补 https://
//   ② ZOS 必须【path-style】 ⇒ S3Client 的 forcePathStyle: true

import { randomUUID } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

/** 五个键的【名字】就是契约（B9 门禁要求它们出现在根 .env.example）。值只落 openship env(isSecret)。 */
const ENV_KEYS = [
  'AFTERSALES_ZOS_ENDPOINT',
  'AFTERSALES_ZOS_REGION',
  'AFTERSALES_ZOS_BUCKET',
  'AFTERSALES_ZOS_ACCESS_KEY',
  'AFTERSALES_ZOS_SECRET',
] as const

export const UPLOAD_URL_TTL_SECONDS = 600
export const DOWNLOAD_URL_TTL_SECONDS = 600

export interface ZosConfig {
  /** 已规范化（含协议、无尾斜杠） */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/** endpoint 可能没写协议 ⇒ 补 https://；顺带吃掉空白与尾斜杠。见文件头 ①。 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** org 段净化：spec §2.3 要求 key 里不出现裸 `=` 等需编码字符。 */
export function sanitizeOrgSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * 对象 key：`aftersales/{org}/{ticket_ref}/{uuid}`。
 * `ticket_ref` 是【客户端幂等键】而不是库内主键——移动端先传图后提交，预签名时工单还没落库
 * （spec §2.3，2026-09-15 定）。
 */
export function objectKeyFor(org: string, clientRequestId: string, uuid = randomUUID()): string {
  return `aftersales/${sanitizeOrgSegment(org)}/${sanitizeOrgSegment(clientRequestId)}/${uuid}`
}

/**
 * 从 env 读配置。**五个键缺任何一个就返回 null** —— 这是刻意的：
 * CI 与本地开发没有 ZOS 凭证，若这里抛错，模块装载就会失败（而装载失败是【进程起不来】）。
 * 代价由附件端点承担：storage 为 null 时它们回 503 ZOS_NOT_CONFIGURED，其余域照常工作。
 */
export function zosConfigFromEnv(env: NodeJS.ProcessEnv): ZosConfig | null {
  const values = ENV_KEYS.map((k) => env[k])
  if (values.some((v) => !v)) return null
  const [endpoint, region, bucket, accessKeyId, secretAccessKey] = values as [
    string, string, string, string, string,
  ]
  return { endpoint: normalizeEndpoint(endpoint), region, bucket, accessKeyId, secretAccessKey }
}

export class ZosStorage {
  private readonly client: S3Client

  constructor(private readonly config: ZosConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // 见文件头 ②：ZOS 实测必须 path-style，否则 bucket 会被当成 DNS 子域拼进 host。
      forcePathStyle: true,
    })
  }

  presignPut(
    key: string,
    contentType: string,
    expiresIn: number = UPLOAD_URL_TTL_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: contentType }),
      { expiresIn },
    )
  }

  presignGet(key: string, expiresIn: number = DOWNLOAD_URL_TTL_SECONDS): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn },
    )
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter aftersales test storage.test.ts
pnpm --filter aftersales typecheck
```

Expected: PASS。若 `X-Amz-Signature` 的正则不匹配，**先确认不是把 64 位十六进制记成了别的长度**
（真实失败通常是 AWS SDK 换了签名算法版本）——不要为了让测试变绿而放宽成 `toBeTruthy()`。

- [ ] **Step 5: 在根 `.env.example` 末尾追加五个键**

追加以下内容（**只写键名与取法，不写任何值**）：

```bash

# ── 售后模块附件直传（天翼 ZOS；S3 兼容 / path-style / SigV4）────────────────
# B9 门禁要求：代码里出现的每个 env 键都必须在本文件声明（这里只声明键名）。
# 真值只落 openship env(isSecret)，绝不进仓库/文档/提交信息。
# 取法：天翼云 ZOS 控制台 → 对象存储 → 访问密钥。endpoint 只写域名即可（代码会补 https://）。
AFTERSALES_ZOS_ENDPOINT=
AFTERSALES_ZOS_REGION=
AFTERSALES_ZOS_BUCKET=
AFTERSALES_ZOS_ACCESS_KEY=
AFTERSALES_ZOS_SECRET=
```

> **只加这五个，不加公众号的键——公众号根本没有 env 键**（已核，非「以后再加」）：
> spec §4 #5 旧措辞写「`.env.example` 增键：公众号 + ZOS」，但 M1 已按 §1.3 落地——公众号凭证
> 在**租户行**（`platform.tenant.wechat_oa_app_id/secret`，见 `apps/server/src/migrations/005_tenant_wechat_oa.sql`），
> `packages/auth-core/src/wechat-oa.ts` 的 `{appId, secret}` 是**入参**、不读 env。
> 故本任务只需 ZOS 五个键；spec §4 #5 已同步订正（见 spec 修订记录）。

- [ ] **Step 6: 跑 B9 门禁确认声明齐了**

```bash
pnpm exec tsx scripts/check-env-example.mjs
```

Expected: `check-env-example: OK`。若报缺 `AFTERSALES_ZOS_*`，检查是不是把键写进了别的
`.env.example`（门禁只认**仓库根**那一份）。

- [ ] **Step 7: 提交**

```bash
git add modules/aftersales/storage.ts modules/aftersales/storage.test.ts .env.example
git commit -m "feat(aftersales): 天翼 ZOS 预签名存储（path-style + endpoint 补协议）与 env 键声明 (#<N>)"
```

---

## Wave 2（T6 → T7 → T8 → T9 —— 串行是协议成本）

> **本波四个任务必须串行**，不是排期保守：它们都要改 `modules/aftersales/manifest.yaml` 与
> `modules/aftersales/index.ts`，而协议要求**声明集合与注册路由集合逐条一致**，不一致的后果是
> **宿主进程起不来**（不是告警）。⇒ 两个任务同时改这两个文件，合并时必有一方把另一方挤掉。
> 按 `dispatch-and-visibility` 的波内硬约束：「拿不准就降为串行」。

**四个任务共同的收尾动作（每个任务都要做一遍，不重复写）**：

```bash
# ① 装载期双向核对的本地版（module.test.ts 已有这条用例，它现在会因声明与路由不齐而红）
pnpm --filter aftersales test
# ② 门禁
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
# ③ 真宿主装载（证明宿主能把它装起来——这是协议层唯一算数的证据）
pnpm --filter @platform/web build
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm exec tsx scripts/smoke-load.mjs
```

`pnpm --filter aftersales test` 里那条「声明集合 ⟺ 注册集合」用例就是本波的安全带：任何一个
任务漏改一半（加了路由没加声明、或反之），它在**本地**就红，而不是等到 smoke 报「装载失败」。

---

### Task 6: 工单域（管理端 + 访客端）

**Files:**
- Create: `modules/aftersales/routes/ticket-manage.ts`
- Create: `modules/aftersales/routes/ticket-guest.ts`
- Create: `modules/aftersales/routes/context.ts`（`ModuleHono` / `RouteCtx` 两个类型的落点）
- Create: `modules/aftersales/routes/ticket.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（追加 6 条声明）
- Modify: `modules/aftersales/index.ts`（装配 ctx + 注册两个域）

**Interfaces:**
- Consumes: `resolveProcess` / `isProcessable` / `AmountValidationError` / `toMinor` / `toRatioOrNull`（T4）；`zosConfigFromEnv` / `ZosStorage`（T5）
- Produces:
  - `routes/context.ts`：`type ModuleHono`、`interface RouteCtx { pool: Pool; storage: ZosStorage | null }`
  - `registerTicketManage(r: ModuleHono, ctx: RouteCtx): void`
  - `registerTicketGuest(r: ModuleHono, ctx: RouteCtx): void`
  - `index.ts` 的 `createRouter` 改为 `({ pool }) => …` 形态（后续 T7/T8/T9 往里追加 `register*`）

- [ ] **Step 1: 写 `modules/aftersales/routes/context.ts`**

```ts
// 路由层的两个共享类型。单独一个文件是为了让 T6–T9 四个域互相不 import（避免循环与耦合），
// 只共同依赖这里。
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import type { ZosStorage } from '../storage'

/** 模块路由的统一类型：identity 由宿主注入（模块自己【不写】门禁，spec/协议见 module-protocol）。 */
export type ModuleHono = Hono<{ Variables: { identity: Identity } }>

/** 每个域注册时拿到的依赖。storage 可能为 null（没配 ZOS 凭证），见 storage.ts 的说明。 */
export interface RouteCtx {
  pool: Pool
  storage: ZosStorage | null
}
```

- [ ] **Step 2: 写失败的测试 `modules/aftersales/routes/ticket.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// 与其他测试文件共用同一个临时 org 前缀，避免互相看见对方的行。
const ORG = 'test-aftersales-ticket'
const OTHER_ORG = 'test-aftersales-ticket-other'

describePg('工单域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const manage = makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] })
  const guest = makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] })
  const guestBob = makeIdentity({ orgId: ORG, userId: 'openid-bob', scopes: ['aftersales:guest'] })
  // buildTestApp 的第三个参数就是宿主的 ModuleContext（本仓模块只用到 pool）。
  // 【不要】在这里塞 storage：模块自己从 process.env 解析 ZOS 配置（见 index.ts），
  // 从测试注入的 storage 根本到不了 createRouter 里面——那会是一个静默失效的注入点。
  const ctx = { pool }
  const appManage = buildTestApp(mod, manage, ctx)
  const appGuest = buildTestApp(mod, guest, ctx)
  const appGuestBob = buildTestApp(mod, guestBob, ctx)

  let productId = 0
  let storeId = 0

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket where org = $1', [ORG])
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    // 商品快照：基本数量 100 件、单价 500 分（=5 元/件）⇒ 与 domain 测试同一组数
    const p = await pool.query<{ id: string }>(
      `insert into aftersales.product(org, name, spec, basic_quantity, basic_unit_price_minor)
       values ($1, '测试商品', '规格A', 100, 500) returning id`,
      [ORG],
    )
    productId = Number(p.rows[0].id)
    const s = await pool.query<{ id: string }>(
      `insert into aftersales.store(org, name, address, phone) values ($1, '测试门店', '', '') returning id`,
      [ORG],
    )
    storeId = Number(s.rows[0].id)
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
    await pool.query('delete from aftersales.ticket where org = $1', [ORG])
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const submit = (app: typeof appGuest, body: Record<string, unknown>) =>
    app.request('/guest/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const validBody = (clientRequestId: string) => ({
    clientRequestId,
    productId,
    storeId,
    damageQuantity: 30,
    remark: '摔坏了',
  })

  it('访客提交工单 ⇒ 201，商品字段被【快照】下来，状态 pending、金额类型暂空', async () => {
    const res = await submit(appGuest, validBody('req-snap'))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; code: string; status: string }
    expect(body.status).toBe('pending')
    expect(body.code).toMatch(/^AS-\d{8}$/)

    const row = await pool.query(
      `select product_name, store_name, basic_quantity, basic_unit_price_minor,
              amount_type, amount_minor, submitter_openid
         from aftersales.ticket where org = $1 and id = $2`,
      [ORG, body.id],
    )
    expect(row.rows[0]).toMatchObject({
      product_name: '测试商品',
      store_name: '测试门店',
      basic_quantity: 100,
      basic_unit_price_minor: '500', // ← pg 把 bigint 返回成字符串，别按 number 断言
      amount_type: null,
      amount_minor: '0',
      submitter_openid: 'openid-alice',
    })
  })

  it('幂等：同 clientRequestId 二次提交 ⇒ 返回【同一张】工单，且不新增行', async () => {
    const first = await submit(appGuest, validBody('req-idem'))
    const second = await submit(appGuest, validBody('req-idem'))
    expect(second.status).toBe(200)
    const a = (await first.json()) as { id: number }
    const b = (await second.json()) as { id: number }
    expect(b.id).toBe(a.id)
    const cnt = await pool.query(
      'select count(*)::int as n from aftersales.ticket where org = $1 and client_request_id = $2',
      [ORG, 'req-idem'],
    )
    expect(cnt.rows[0].n).toBe(1)
  })

  it('访客只能看到自己的工单：alice 提交的，bob 查列表看不到、按 id 查是 404（与不存在同形）', async () => {
    const created = await submit(appGuest, validBody('req-private'))
    const { id } = (await created.json()) as { id: number }

    const bobList = await appGuestBob.request('/guest/tickets')
    const bobBody = (await bobList.json()) as { items: { id: number }[] }
    expect(bobBody.items.some((t) => t.id === id)).toBe(false)

    const bobDetail = await appGuestBob.request(`/guest/tickets/${id}`)
    expect(bobDetail.status).toBe(404)
    // 同形：不存在的 id 也是 404、同样的错误体（不泄露"存在但不属于你"）
    const ghost = await appGuestBob.request('/guest/tickets/999999999')
    expect(ghost.status).toBe(404)
    expect(await bobDetail.text()).toBe(await ghost.text())
  })

  it('管理端看不到别的 org 的工单（租户隔离）', async () => {
    const other = makeIdentity({ orgId: OTHER_ORG, scopes: ['aftersales:manage'] })
    const res = await buildTestApp(mod, other, ctx).request('/tickets')
    const body = (await res.json()) as { items: { id: number }[]; total: number }
    expect(body.total).toBe(0)
    expect(body.items).toEqual([])
  })

  it('ratio 处理 ⇒ completed、服务端按规则算出金额（不信前端传来的任何金额）', async () => {
    const created = await submit(appGuest, validBody('req-ratio'))
    const { id } = (await created.json()) as { id: number }

    const res = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 刻意塞一个 amountMinor 想让服务端采信——ratio 路必须无视它
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 0.1, amountMinor: 999999 }),
    })
    expect(res.status).toBe(200)

    const row = await pool.query(
      'select status, amount_type, amount_minor, refund_ratio, processed_at from aftersales.ticket where org = $1 and id = $2',
      [ORG, id],
    )
    // (30 − 100×0.1) × 500 分 = 10000 分
    expect(row.rows[0]).toMatchObject({
      status: 'completed',
      amount_type: 'ratio',
      amount_minor: '10000',
      refund_ratio: '0.1000',
    })
    expect(row.rows[0].processed_at).not.toBeNull()
  })

  it('reject 处理 ⇒ cancelled、金额强制 0', async () => {
    const created = await submit(appGuest, validBody('req-reject'))
    const { id } = (await created.json()) as { id: number }
    const res = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(res.status).toBe(200)
    const row = await pool.query(
      'select status, amount_type, amount_minor, refund_ratio from aftersales.ticket where org = $1 and id = $2',
      [ORG, id],
    )
    expect(row.rows[0]).toMatchObject({
      status: 'cancelled',
      amount_type: 'reject',
      amount_minor: '0',
      refund_ratio: null,
    })
  })

  it('重复处理同一张工单 ⇒ 409（状态机条件更新的影响行数为 0）', async () => {
    const created = await submit(appGuest, validBody('req-double'))
    const { id } = (await created.json()) as { id: number }
    const first = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(first.status).toBe(200)
    const second = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(second.status).toBe(409)
    expect((await second.json()) as { error: string }).toMatchObject({ error: 'ALREADY_PROCESSED' })
  })

  it('处理不存在的工单 ⇒ 404', async () => {
    const res = await appManage.request('/tickets/999999999/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(res.status).toBe(404)
  })

  it('非法处理体（比例越界 / 固定额非整数）⇒ 400，且工单保持 pending', async () => {
    const created = await submit(appGuest, validBody('req-badbody'))
    const { id } = (await created.json()) as { id: number }
    const bad = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 1.5 }),
    })
    expect(bad.status).toBe(400)
    const row = await pool.query('select status from aftersales.ticket where org = $1 and id = $2', [ORG, id])
    expect(row.rows[0].status).toBe('pending')
  })

  it('管理端列表按状态筛选 + 分页，只回本 org', async () => {
    const res = await appManage.request('/tickets?status=pending&page=1&size=2')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; size: number }
    expect(body.page).toBe(1)
    expect(body.size).toBe(2)
    expect(body.items.length).toBeLessThanOrEqual(2)
    expect(body.total).toBeGreaterThan(0)
  })

  it('size 超上界被夹到 100（防止一次拉全表）', async () => {
    const res = await appManage.request('/tickets?size=99999')
    const body = (await res.json()) as { size: number }
    expect(body.size).toBe(100)
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm --filter aftersales test routes/ticket.test.ts
```

Expected: FAIL —— 路由还没注册，全部回 404。

- [ ] **Step 4: 写 `modules/aftersales/routes/ticket-manage.ts`**

```ts
import { z } from 'zod'
import {
  AmountValidationError,
  isProcessable,
  resolveProcess,
  toMinor,
  toRatioOrNull,
} from '../domain/ticket'
import type { TicketStatus } from '../domain/ticket'
import type { ModuleHono, RouteCtx } from './context'

/** 列表分页上界：模块自己的护栏，防止 size=99999 一次拉全表。 */
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

const ProcessBody = z.discriminatedUnion('amountType', [
  z.object({ amountType: z.literal('ratio'), refundRatio: z.number(), remark: z.string().max(2000).optional() }),
  z.object({
    amountType: z.literal('fixed'),
    amountMinor: z.number().int(),
    remark: z.string().max(2000).optional(),
  }),
  z.object({ amountType: z.literal('reject'), remark: z.string().max(2000).optional() }),
])

interface TicketRow {
  id: string
  status: TicketStatus
  damage_quantity: number
  basic_quantity: number
  basic_unit_price_minor: string
}

function parsePageParam(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, max)
}

export function registerTicketManage(r: ModuleHono, ctx: RouteCtx): void {
  // GET /tickets —— 管理端列表：服务端分页 + 状态筛选（spec §0.3：不搬「全量拉取+前端过滤」）
  r.get('/tickets', async (c) => {
    const org = c.get('identity').orgId
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const status = c.req.query('status')

    const where = ['org = $1']
    const params: unknown[] = [org]
    if (status) {
      params.push(status)
      where.push(`status = $${params.length}`)
    }

    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.ticket where ${where.join(' and ')}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, code, product_id, product_name, store_id, store_name,
              damage_quantity, status, amount_type, amount_minor, refund_ratio,
              operator, remark, related_order, created_at, processed_at
         from aftersales.ticket
        where ${where.join(' and ')}
        order by id desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )

    return c.json({
      items: listRes.rows.map(normalizeTicketRow),
      total: totalRes.rows[0].n,
      page,
      size,
    })
  })

  // GET /tickets/:id —— 管理端详情，附件带预签名 GET URL
  r.get('/tickets/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'INVALID_ID' }, 400)

    const res = await ctx.pool.query(
      `select id, code, submitter_openid, product_id, product_name, store_id, store_name,
              damage_quantity, basic_quantity, basic_unit_price_minor,
              status, amount_type, amount_minor, refund_ratio,
              operator, remark, related_order, created_at, processed_at
         from aftersales.ticket where org = $1 and id = $2`,
      [org, id],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)

    return c.json({
      ...normalizeTicketRow(row),
      attachments: await loadAttachments(ctx, org, id),
    })
  })

  // POST /tickets/:id/process —— 状态机条件更新（spec §2.2：影响行数 0 ⇒ 409）
  r.post('/tickets/:id/process', async (c) => {
    const org = c.get('identity').orgId
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'INVALID_ID' }, 400)

    const parsed = ProcessBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const body = parsed.data

    const client = await ctx.pool.connect()
    try {
      await client.query('begin')

      // 先读工单的快照字段算金额；再条件更新当守卫。
      // 这里【不加 for update】：真正的并发守卫是下面 update 的 where status='pending'——
      // 两个并发处理请求都会读到 pending、都算出一份金额，但只有一个 update 能落，另一份影响行数 0 ⇒ 409。
      const cur = await client.query<TicketRow>(
        `select id, status, damage_quantity, basic_quantity, basic_unit_price_minor
           from aftersales.ticket where org = $1 and id = $2`,
        [org, id],
      )
      const row = cur.rows[0]
      if (!row) {
        await client.query('rollback')
        return c.json({ error: 'NOT_FOUND' }, 404)
      }
      if (!isProcessable(row.status)) {
        await client.query('rollback')
        return c.json({ error: 'ALREADY_PROCESSED', status: row.status }, 409)
      }

      let outcome
      try {
        outcome = resolveProcess(
          {
            damageQuantity: Number(row.damage_quantity),
            basicQuantity: Number(row.basic_quantity),
            // pg 把 bigint 与 numeric 都返回成字符串——不转就是字符串算术（见 domain/ticket.ts）
            basicUnitPriceMinor: toMinor(row.basic_unit_price_minor),
          },
          body,
        )
      } catch (err) {
        await client.query('rollback')
        if (err instanceof AmountValidationError) {
          return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
        }
        throw err
      }

      const upd = await client.query(
        `update aftersales.ticket
            set status = $3, amount_type = $4, amount_minor = $5, refund_ratio = $6,
                operator = $7, remark = coalesce($8, remark), processed_at = now()
          where org = $1 and id = $2 and status = 'pending'`,
        [
          org,
          id,
          outcome.status,
          outcome.amountType,
          outcome.amountMinor,
          outcome.refundRatio,
          c.get('identity').displayName,
          body.remark ?? null,
        ],
      )
      if (upd.rowCount === 0) {
        await client.query('rollback')
        return c.json({ error: 'ALREADY_PROCESSED' }, 409)
      }

      await client.query('commit')
      return c.json({
        ok: true,
        id,
        status: outcome.status,
        amountType: outcome.amountType,
        amountMinor: outcome.amountMinor,
      })
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
}

/** bigint/numeric 在 pg 里都是字符串：出口统一转成 number 或 null，别把字符串漏给前端。 */
export function normalizeTicketRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    id: Number(row.id),
    productId: row.product_id === null ? null : Number(row.product_id),
    storeId: row.store_id === null ? null : Number(row.store_id),
    basicUnitPriceMinor: row.basic_unit_price_minor === undefined ? undefined : toMinor(row.basic_unit_price_minor as string),
    amountMinor: toMinor(row.amount_minor as string),
    refundRatio: toRatioOrNull(row.refund_ratio as string | null),
  }
}

/**
 * 附件行 + 预签名 GET URL。storage 为 null（没配 ZOS 凭证）时 url 回 null 而不是整个端点 503——
 * 工单本身的数据仍然有用，附件拉不到是「降级」不是「失败」（附件专用端点才是 503）。
 */
export async function loadAttachments(
  ctx: RouteCtx,
  org: string,
  ticketId: number,
): Promise<{ id: number; objectKey: string; contentType: string; sizeBytes: number; url: string | null }[]> {
  const res = await ctx.pool.query(
    `select id, object_key, content_type, size_bytes
       from aftersales.ticket_attachment
      where org = $1 and ticket_id = $2
      order by id`,
    [org, ticketId],
  )
  return Promise.all(
    res.rows.map(async (a) => ({
      id: Number(a.id),
      objectKey: a.object_key as string,
      contentType: a.content_type as string,
      sizeBytes: toMinor(a.size_bytes as string),
      url: ctx.storage ? await ctx.storage.presignGet(a.object_key as string) : null,
    })),
  )
}
```

- [ ] **Step 5: 写 `modules/aftersales/routes/ticket-guest.ts`**

```ts
import { z } from 'zod'
import { loadAttachments, normalizeTicketRow } from './ticket-manage'
import type { ModuleHono, RouteCtx } from './context'

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

const SubmitBody = z.object({
  // 客户端幂等键（spec §2.2）；同时是附件 object key 里的 {ticket_ref}（spec §2.3）
  clientRequestId: z.string().min(1).max(128),
  productId: z.number().int().positive(),
  storeId: z.number().int().positive().optional(),
  damageQuantity: z.number().int().nonnegative(),
  remark: z.string().max(2000).optional(),
  /** 本次提交要一起认领的附件（先传图后提交，见 spec §2.3） */
  attachmentIds: z.array(z.number().int().positive()).max(50).optional(),
})

export function registerTicketGuest(r: ModuleHono, ctx: RouteCtx): void {
  // GET /guest/tickets —— 只回自己的（按 submitter_openid 收窄，spec §2.2）
  r.get('/guest/tickets', async (c) => {
    const identity = c.get('identity')
    const page = Math.max(1, Number(c.req.query('page')) || 1)
    const size = Math.min(Math.max(1, Number(c.req.query('size')) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)

    const totalRes = await ctx.pool.query<{ n: number }>(
      'select count(*)::int as n from aftersales.ticket where org = $1 and submitter_openid = $2',
      [identity.orgId, identity.userId],
    )
    const listRes = await ctx.pool.query(
      `select id, code, product_name, store_name, damage_quantity, status,
              amount_type, amount_minor, remark, created_at, processed_at
         from aftersales.ticket
        where org = $1 and submitter_openid = $2
        order by id desc
        limit $3 offset $4`,
      [identity.orgId, identity.userId, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map(normalizeTicketRow),
      total: totalRes.rows[0].n,
      page,
      size,
    })
  })

  // GET /guest/tickets/:id —— 不是自己的 ⇒ 404（与不存在同形，不泄露"存在但不属于你"）
  r.get('/guest/tickets/:id', async (c) => {
    const identity = c.get('identity')
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'NOT_FOUND' }, 404)

    const res = await ctx.pool.query(
      `select id, code, product_id, product_name, store_id, store_name,
              damage_quantity, status, amount_type, amount_minor, refund_ratio,
              remark, related_order, created_at, processed_at
         from aftersales.ticket
        where org = $1 and id = $2 and submitter_openid = $3`,
      [identity.orgId, id, identity.userId],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ...normalizeTicketRow(row), attachments: await loadAttachments(ctx, identity.orgId, id) })
  })

  // POST /guest/tickets —— 提交工单：单端点单事务（spec §0.3、§2.2）
  r.post('/guest/tickets', async (c) => {
    const identity = c.get('identity')
    const org = identity.orgId

    const parsed = SubmitBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const body = parsed.data

    const client = await ctx.pool.connect()
    try {
      await client.query('begin')

      // ① 幂等：同 (org, clientRequestId) 已有 ⇒ 直接回既有工单，不新增行
      const dup = await client.query<{ id: string }>(
        'select id from aftersales.ticket where org = $1 and client_request_id = $2',
        [org, body.clientRequestId],
      )
      if (dup.rows[0]) {
        await client.query('commit')
        return c.json({ id: Number(dup.rows[0].id), duplicated: true }, 200)
      }

      // ② 快照商品与门店：基本数量/单价随工单冻住——规则或商品改价不得改写历史工单的金额依据
      const prod = await client.query<{
        id: string; name: string; basic_quantity: number; basic_unit_price_minor: string
      }>(
        'select id, name, basic_quantity, basic_unit_price_minor from aftersales.product where org = $1 and id = $2',
        [org, body.productId],
      )
      if (!prod.rows[0]) {
        await client.query('rollback')
        return c.json({ error: 'PRODUCT_NOT_FOUND' }, 400)
      }
      const product = prod.rows[0]

      let storeName = ''
      if (body.storeId !== undefined) {
        const st = await client.query<{ name: string }>(
          'select name from aftersales.store where org = $1 and id = $2',
          [org, body.storeId],
        )
        if (!st.rows[0]) {
          await client.query('rollback')
          return c.json({ error: 'STORE_NOT_FOUND' }, 400)
        }
        storeName = st.rows[0].name
      }

      const ins = await client.query<{ id: string }>(
        `insert into aftersales.ticket(
           org, client_request_id, submitter_openid,
           product_id, product_name, store_id, store_name,
           damage_quantity, basic_quantity, basic_unit_price_minor, remark)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id`,
        [
          org, body.clientRequestId, identity.userId,
          body.productId, product.name, body.storeId ?? null, storeName,
          body.damageQuantity, Number(product.basic_quantity), product.basic_unit_price_minor,
          body.remark ?? '',
        ],
      )
      const ticketId = Number(ins.rows[0].id)

      // ③ 编号：同一事务内补写（不是 generated column）——因为 M2b 迁移要【保留源编号】，
      //    生成列会让源编号落不进来。形状 AS-00000001，8 位补零。
      await client.query(
        `update aftersales.ticket set code = 'AS-' || lpad(id::text, 8, '0') where org = $1 and id = $2`,
        [org, ticketId],
      )

      // ④ 认领附件：把本次幂等键下、尚未归属的附件挂到这张工单上
      if (body.attachmentIds?.length) {
        await client.query(
          `update aftersales.ticket_attachment
              set ticket_id = $3
            where org = $1 and id = any($4::bigint[])
              and client_request_id = $2 and ticket_id is null`,
          [org, body.clientRequestId, ticketId, body.attachmentIds],
        )
      }

      await client.query('commit')
      return c.json({ id: ticketId, duplicated: false }, 201)
    } catch (err) {
      await client.query('rollback').catch(() => {})
      // 并发下两个请求可能同时通过 ① 的存在性检查 ⇒ 唯一索引 (org, client_request_id) 让后到的那个
      // 报 23505。这不是错误，是幂等：回读既有工单返回（与 ① 同一语义）。
      if ((err as { code?: string }).code === '23505') {
        const again = await ctx.pool.query<{ id: string }>(
          'select id from aftersales.ticket where org = $1 and client_request_id = $2',
          [org, body.clientRequestId],
        )
        if (again.rows[0]) return c.json({ id: Number(again.rows[0].id), duplicated: true }, 200)
      }
      throw err
    } finally {
      client.release()
    }
  })
}
```

- [ ] **Step 6: 改 `modules/aftersales/index.ts` 装配路由**

```ts
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
import { ZosStorage, zosConfigFromEnv } from './storage'
import { registerTicketManage } from './routes/ticket-manage'
import { registerTicketGuest } from './routes/ticket-guest'
import type { RouteCtx } from './routes/context'

// 装配形状照 modules/demo/index.ts（本仓模块的唯一范式）。
// 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块侧【不写】requireScope。
const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    const r = new Hono<{ Variables: { identity: Identity } }>()
    // 没有 ZOS 凭证时 storage 为 null：模块照常装载，只有附件端点回 503（见 storage.ts）
    const config = zosConfigFromEnv(process.env)
    const ctx: RouteCtx = { pool, storage: config ? new ZosStorage(config) : null }

    registerTicketManage(r, ctx)
    registerTicketGuest(r, ctx)
    // T7/T8/T9 在这里继续 register*
    return r
  },
})
```

- [ ] **Step 7: 改 `modules/aftersales/manifest.yaml` —— 逐条追加 6 条声明**

把 `api: internal: []` 整段替换为：

```yaml
api:
  internal:
    # ── 工单·管理端（aftersales:manage）──
    - { method: GET,  path: /tickets,             scope: aftersales:manage }
    - { method: GET,  path: /tickets/:id,         scope: aftersales:manage }
    - { method: POST, path: /tickets/:id/process, scope: aftersales:manage }
    # ── 工单·访客端（aftersales:guest）──
    # 为什么与上面分面而不是共用 /tickets：同一个 (method, path) 只能声明一次、一条声明只带一个
    # scope（packages/platform-sdk/src/manifest.ts 的 superRefine）。见 spec §2.2「路径按 scope 分面」。
    - { method: GET,  path: /guest/tickets,       scope: aftersales:guest }
    - { method: GET,  path: /guest/tickets/:id,   scope: aftersales:guest }
    - { method: POST, path: /guest/tickets,       scope: aftersales:guest }
```

- [ ] **Step 8: 收尾验证（用本波开头那组命令）**

```bash
pnpm --filter aftersales test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm --filter @platform/web build
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm exec tsx scripts/smoke-load.mjs
```

Expected: 全绿。`module.test.ts` 的「声明 ⟺ 注册」用例是这一步的关键——它红就说明 manifest 与
`index.ts` 没对齐（**别**先去看 smoke，那条用例的报错更清楚）。

- [ ] **Step 9: 提交**

```bash
git add modules/aftersales
git commit -m "feat(aftersales): 工单域——管理端列表/详情/处理 + 访客端提交/查询（幂等 + 状态机） (#<N>)"
```

---

### Task 7: 规则域

**Files:**
- Create: `modules/aftersales/routes/rule.ts`
- Create: `modules/aftersales/routes/rule.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（追加 4 条声明）
- Modify: `modules/aftersales/index.ts`（追加 `registerRule`）

**Interfaces:**
- Consumes: `normalizeRatio` / `AmountValidationError` / `toRatioOrNull`（T4）；`ModuleHono` / `RouteCtx`（T6）
- Produces: `registerRule(r: ModuleHono, ctx: RouteCtx): void`

- [ ] **Step 1: 写失败的测试 `modules/aftersales/routes/rule.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-rule'

describePg('规则域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    { pool },
  )

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_rule where org = $1', [ORG])
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_rule where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const post = (body: unknown) =>
    app.request('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('新建规则 ⇒ 201，比例按【小数】落 numeric(6,4)', async () => {
    const res = await post({ name: '常规售后', refundRatio: 0.1, remark: '' })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select name, refund_ratio from aftersales.ticket_rule where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ name: '常规售后', refund_ratio: '0.1000' })
  })

  it('四舍五入到 4 位小数（源侧保存走 .toFixed(4)，列型 numeric(6,4) 对齐）', async () => {
    const res = await post({ name: '多位小数', refundRatio: 0.123456789 })
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select refund_ratio from aftersales.ticket_rule where id = $1', [id])
    expect(row.rows[0].refund_ratio).toBe('0.1235')
  })

  it('比例越界 ⇒ 400（与工单处理共用 normalizeRatio 一条口径）', async () => {
    for (const bad of [1.5, -0.2]) {
      const res = await post({ name: '越界', refundRatio: bad })
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'INVALID_AMOUNT' })
    }
  })

  it('列表只回本 org，且恒有 org 过滤（租户隔离）', async () => {
    const res = await app.request('/rules')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string }[] }
    expect(body.items.map((r) => r.name)).toContain('常规售后')

    const other = makeIdentity({ orgId: 'test-aftersales-rule-other', scopes: ['aftersales:manage'] })
    const otherRes = await buildTestApp(mod, other, { pool }).request('/rules')
    expect((await otherRes.json()) as { items: unknown[] }).toMatchObject({ items: [] })
  })

  it('改规则 ⇒ 200；跨 org 改别人的规则 ⇒ 404（不是 403，避免泄露存在性）', async () => {
    const created = await post({ name: '待改', refundRatio: 0.2 })
    const { id } = (await created.json()) as { id: number }

    const ok = await app.request(`/rules/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '改过了', refundRatio: 0.25 }),
    })
    expect(ok.status).toBe(200)

    const other = makeIdentity({ orgId: 'test-aftersales-rule-other', scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, { pool }).request(`/rules/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '越权改', refundRatio: 0.3 }),
    })
    expect(cross.status).toBe(404)
    // 回读：值没被跨租户改掉
    const row = await pool.query('select name from aftersales.ticket_rule where org = $1 and id = $2', [ORG, id])
    expect(row.rows[0].name).toBe('改过了')
  })

  it('删规则 ⇒ 200；再删同一条 ⇒ 404', async () => {
    const created = await post({ name: '待删', refundRatio: 0.05 })
    const { id } = (await created.json()) as { id: number }
    expect((await app.request(`/rules/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/rules/${id}`, { method: 'DELETE' })).status).toBe(404)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm --filter aftersales test routes/rule.test.ts
```

Expected: FAIL —— 路由未注册，全部 404。

- [ ] **Step 3: 写实现 `modules/aftersales/routes/rule.ts`**

```ts
import { z } from 'zod'
import { AmountValidationError, normalizeRatio, toRatioOrNull } from '../domain/ticket'
import type { ModuleHono, RouteCtx } from './context'

/** 规则表是配置表（源侧 12 行），不需要分页，但仍设上界防呆。 */
const MAX_RULES = 500

const RuleBody = z.object({
  name: z.string().min(1).max(200),
  refundRatio: z.number(),
  remark: z.string().max(2000).optional(),
})

export function registerRule(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/rules', async (c) => {
    const org = c.get('identity').orgId
    const res = await ctx.pool.query(
      `select id, name, refund_ratio, remark, created_at
         from aftersales.ticket_rule where org = $1 order by id limit $2`,
      [org, MAX_RULES],
    )
    return c.json({
      items: res.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        // numeric 在 pg 里是【字符串】——出口统一转 number（见 domain/ticket.ts）
        refundRatio: toRatioOrNull(r.refund_ratio),
        remark: r.remark,
        createdAt: r.created_at,
      })),
    })
  })

  r.post('/rules', async (c) => {
    const org = c.get('identity').orgId
    const parsed = RuleBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, remark } = parsed.data
    let refundRatio: number

    try {
      // 与工单处理共用同一条口径（T4 的 normalizeRatio）——比例合法性与 4 位小数的唯一事实源。
      // 【落库必须用它的返回值】：assertValidRatio 只是它丢弃返回值的薄封装，
      // 用 void 封装等于「校验在 JS、量化交给 pg 列型」，又变成两套实现。
      refundRatio = normalizeRatio(parsed.data.refundRatio)
    } catch (err) {
      if (err instanceof AmountValidationError) {
        return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
      }
      throw err
    }

    const res = await ctx.pool.query<{ id: string }>(
      `insert into aftersales.ticket_rule(org, name, refund_ratio, remark)
       values ($1, $2, $3, $4) returning id`,
      [org, name, refundRatio, remark ?? ''],
    )
    return c.json({ id: Number(res.rows[0].id) }, 201)
  })

  r.put('/rules/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'NOT_FOUND' }, 404)

    const parsed = RuleBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, remark } = parsed.data
    let refundRatio: number

    try {
      refundRatio = normalizeRatio(parsed.data.refundRatio)
    } catch (err) {
      if (err instanceof AmountValidationError) {
        return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
      }
      throw err
    }

    const res = await ctx.pool.query(
      `update aftersales.ticket_rule set name = $3, refund_ratio = $4, remark = $5
        where org = $1 and id = $2`,
      [org, id, name, refundRatio, remark ?? ''],
    )
    // 跨租户改别人的规则同样是 rowCount 0 ⇒ 404：与"不存在"同形，不泄露存在性
    if (res.rowCount === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true, id })
  })

  r.delete('/rules/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'NOT_FOUND' }, 404)

    // 硬删是刻意的：这是配置表不是流水表，源侧也没有软删语义（spec §3.3 实证表：
    // "仅 group_buying_batch 有 is_deleted"）。历史工单不受影响——它落的是金额快照。
    const res = await ctx.pool.query('delete from aftersales.ticket_rule where org = $1 and id = $2', [org, id])
    if (res.rowCount === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true, id })
  })
}
```

- [ ] **Step 4: 在 `index.ts` 里追加一行**（在 `registerTicketGuest(r, ctx)` 之后）

```ts
    registerRule(r, ctx)
```

并在文件头 import 区追加：

```ts
import { registerRule } from './routes/rule'
```

- [ ] **Step 5: 在 `manifest.yaml` 的 `api.internal` 末尾追加 4 条**

```yaml
    # ── 规则·管理端（aftersales:manage）──
    - { method: GET,    path: /rules,     scope: aftersales:manage }
    - { method: POST,   path: /rules,     scope: aftersales:manage }
    - { method: PUT,    path: /rules/:id, scope: aftersales:manage }
    - { method: DELETE, path: /rules/:id, scope: aftersales:manage }
```

- [ ] **Step 6: 收尾验证（用 Wave 2 开头那组命令）+ 提交**

```bash
pnpm --filter aftersales test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
git add modules/aftersales
git commit -m "feat(aftersales): 规则域——比例校验与工单处理共用一条口径 (#<N>)"
```

---

### Task 8: 主数据域

**Files:**
- Create: `modules/aftersales/routes/masterdata.ts`
- Create: `modules/aftersales/routes/masterdata.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（追加 5 条声明）
- Modify: `modules/aftersales/index.ts`（追加 `registerMasterData`）

**Interfaces:**
- Consumes: `toMinor` / `toRatioOrNull`（T4）；`ModuleHono` / `RouteCtx`（T6）
- Produces: `registerMasterData(r: ModuleHono, ctx: RouteCtx): void`

> 本域的表是**共用主数据**（spec §1.2「可搬迁」纪律）：资源名通用、表不掺售后语义，接龙二期
> 立项时再决定是否抽独立档案模块。**现在抽是过早抽象**（YAGNI），所以不写任何"给未来用"的钩子。

- [ ] **Step 1: 写失败的测试 `modules/aftersales/routes/masterdata.test.ts`**

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-md'

describePg('主数据域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    { pool },
  )

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.employee where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    await pool.query(
      `insert into aftersales.store(org, name, address, phone) values ($1,'上海门店','', ''), ($1,'北京门店','','')`,
      [ORG],
    )
    await pool.query(
      `insert into aftersales.product(org, name, spec, basic_quantity, basic_unit_price_minor)
       values ($1,'苹果','规格A',100,500), ($1,'梨','规格B',50,300)`,
      [ORG],
    )
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.employee where org = $1', [ORG])
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const json = (body: unknown) => ({
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('门店列表只回本 org', async () => {
    const res = await app.request('/stores')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string }[] }
    expect(body.items.map((s) => s.name).sort()).toEqual(['上海门店', '北京门店'])
  })

  it('商品按名搜索（服务端过滤，不搬源侧「全量 13767 行 + 前端过滤」）', async () => {
    const hit = await app.request('/products?q=苹果')
    const hitBody = (await hit.json()) as { items: { name: string }[] }
    expect(hitBody.items.map((p) => p.name)).toEqual(['苹果'])

    const miss = await app.request('/products?q=不存在的名字')
    expect(((await miss.json()) as { items: unknown[] }).items).toEqual([])
  })

  it('商品分页：size 被夹到 100，单价以整数分回（bigint 已转 number）', async () => {
    const res = await app.request('/products?size=99999')
    const body = (await res.json()) as { size: number; items: { basicUnitPriceMinor: number }[] }
    expect(body.size).toBe(100)
    const apple = body.items.find((p) => p.basicUnitPriceMinor === 500)
    expect(apple).toBeDefined()
  })

  it('员工注册 ⇒ 201、审批态默认 pending', async () => {
    const res = await app.request('/employees', json({ name: '张三', phone: '13800000000' }))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select approve_status, open_id from aftersales.employee where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ approve_status: 'pending', open_id: '' })
  })

  it('员工列表可按审批态筛选，open_id 被带出来（它是移动端身份锚）', async () => {
    const res = await app.request('/employees?approveStatus=pending')
    const body = (await res.json()) as { items: { name: string; approveStatus: string; openId: string }[] }
    expect(body.items.every((e) => e.approveStatus === 'pending')).toBe(true)
    expect(body.items.find((e) => e.name === '张三')?.openId).toBe('')
  })

  it('审批通过 ⇒ 200 且状态落 approved；非法审批值 ⇒ 400', async () => {
    const created = await app.request('/employees', json({ name: '李四', phone: '13900000000' }))
    const { id } = (await created.json()) as { id: number }

    const bad = await app.request(`/employees/${id}/approve`, json({ approveStatus: 'maybe' }))
    expect(bad.status).toBe(400)

    const ok = await app.request(`/employees/${id}/approve`, json({ approveStatus: 'approved' }))
    expect(ok.status).toBe(200)
    const row = await pool.query('select approve_status from aftersales.employee where id = $1', [id])
    expect(row.rows[0].approve_status).toBe('approved')
  })

  it('跨 org 审批别人的员工 ⇒ 404（rowCount 0 与不存在同形）', async () => {
    const created = await app.request('/employees', json({ name: '王五', phone: '13700000000' }))
    const { id } = (await created.json()) as { id: number }
    const other = makeIdentity({ orgId: 'test-aftersales-md-other', scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, { pool }).request(
      `/employees/${id}/approve`,
      json({ approveStatus: 'approved' }),
    )
    expect(cross.status).toBe(404)
    const row = await pool.query('select approve_status from aftersales.employee where id = $1', [id])
    expect(row.rows[0].approve_status).toBe('pending')
  })

  it('员工注册带门店时，门店必须属于本 org（跨租户门店 id ⇒ 400，不是静默落 null）', async () => {
    const other = makeIdentity({ orgId: 'test-aftersales-md-other', scopes: ['aftersales:manage'] })
    const otherStore = await pool.query<{ id: string }>(
      `insert into aftersales.store(org, name, address, phone) values ($1,'别人的门店','','') returning id`,
      ['test-aftersales-md-other'],
    )
    const res = await app.request(
      '/employees',
      json({ name: '赵六', phone: '13600000000', storeId: Number(otherStore.rows[0].id) }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'STORE_NOT_FOUND' })
    await pool.query('delete from aftersales.store where org = $1', ['test-aftersales-md-other'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm --filter aftersales test routes/masterdata.test.ts
```

Expected: FAIL —— 路由未注册。

- [ ] **Step 3: 写实现 `modules/aftersales/routes/masterdata.ts`**

```ts
import { z } from 'zod'
import { toMinor } from '../domain/ticket'
import type { ModuleHono, RouteCtx } from './context'

/** 分页上界。源侧 product 有 13,767 行，服务端分页是硬需求不是优化（spec §0.3）。 */
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20
/** 门店是选择器数据（源侧 322 行），一次给全但设上界。 */
const MAX_STORES = 1000
/** 员工是审批列表（源侧 591 行），同上。 */
const MAX_EMPLOYEES = 2000
/** ILIKE 的 `%` `_` 在搜索词里是通配符——转义掉，否则用户输入 `%` 等于全表匹配。 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`)

const EmployeeBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50).optional(),
  storeId: z.number().int().positive().optional(),
  /** 微信 openid，移动端身份锚（spec §1.2）。console 侧注册时可留空，随迁时由 M2b 补。 */
  openId: z.string().max(200).optional(),
})

const ApproveBody = z.object({ approveStatus: z.enum(['approved', 'rejected']) })

export function registerMasterData(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/stores', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }
    const res = await ctx.pool.query(
      `select id, name, region_id, address, phone from aftersales.store
        where ${where} order by id limit $${params.length + 1}`,
      [...params, MAX_STORES],
    )
    return c.json({
      items: res.rows.map((s) => ({
        id: Number(s.id),
        name: s.name,
        regionId: s.region_id === null ? null : Number(s.region_id),
        address: s.address,
        phone: s.phone,
      })),
    })
  })

  r.get('/products', async (c) => {
    const org = c.get('identity').orgId
    const q = c.req.query('q')
    const sizeRaw = Number(c.req.query('size'))
    const size = Number.isInteger(sizeRaw) && sizeRaw >= 1 ? Math.min(sizeRaw, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
    const pageRaw = Number(c.req.query('page'))
    const page = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1

    const params: unknown[] = [org]
    let where = 'org = $1'
    if (q) {
      params.push(`%${escapeLike(q)}%`)
      where += ` and name ilike $${params.length}`
    }

    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.product where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, name, spec, basic_quantity, basic_unit_price_minor from aftersales.product
        where ${where} order by id
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map((p) => ({
        id: Number(p.id),
        name: p.name,
        spec: p.spec,
        basicQuantity: Number(p.basic_quantity),
        // bigint 是字符串——不转就会把 "500" 漏给前端（见 domain/ticket.ts 的说明）
        basicUnitPriceMinor: toMinor(p.basic_unit_price_minor),
      })),
      total: totalRes.rows[0].n,
      page,
      size,
    })
  })

  r.get('/employees', async (c) => {
    const org = c.get('identity').orgId
    const status = c.req.query('approveStatus')
    const params: unknown[] = [org]
    let where = 'org = $1'
    if (status) {
      params.push(status)
      where += ` and approve_status = $${params.length}`
    }
    const res = await ctx.pool.query(
      `select id, name, phone, store_id, open_id, approve_status from aftersales.employee
        where ${where} order by id desc limit $${params.length + 1}`,
      [...params, MAX_EMPLOYEES],
    )
    return c.json({
      items: res.rows.map((e) => ({
        id: Number(e.id),
        name: e.name,
        phone: e.phone,
        storeId: e.store_id === null ? null : Number(e.store_id),
        openId: e.open_id,
        approveStatus: e.approve_status,
      })),
    })
  })

  r.post('/employees', async (c) => {
    const org = c.get('identity').orgId
    const parsed = EmployeeBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, phone, storeId, openId } = parsed.data

    // 门店必须属于本 org——跨租户的 store_id 落进去 = 一个跨租户外键，后面每个 join 都是洞。
    // 校验与写入同事务，避免"校验通过后被并发删掉"的窗口。
    const client = await ctx.pool.connect()
    try {
      await client.query('begin')
      if (storeId !== undefined) {
        const st = await client.query('select id from aftersales.store where org = $1 and id = $2', [org, storeId])
        if (st.rowCount === 0) {
          await client.query('rollback')
          return c.json({ error: 'STORE_NOT_FOUND' }, 400)
        }
      }
      const res = await client.query<{ id: string }>(
        `insert into aftersales.employee(org, name, phone, store_id, open_id, approve_status)
         values ($1, $2, $3, $4, $5, 'pending') returning id`,
        [org, name, phone ?? '', storeId ?? null, openId ?? ''],
      )
      await client.query('commit')
      return c.json({ id: Number(res.rows[0].id) }, 201)
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })

  r.post('/employees/:id/approve', async (c) => {
    const org = c.get('identity').orgId
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'NOT_FOUND' }, 404)

    const parsed = ApproveBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    // 目标枚举定死英文（spec §5 #9：源侧三套词表并存——pending|approved|rejected 与中文
    // 待审批|通过|驳回；中文是展示层的事，不入库）。
    const res = await ctx.pool.query(
      'update aftersales.employee set approve_status = $3 where org = $1 and id = $2',
      [org, id, parsed.data.approveStatus],
    )
    if (res.rowCount === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true, id, approveStatus: parsed.data.approveStatus })
  })
}
```

- [ ] **Step 4: 在 `index.ts` 里追加一行 + import**

```ts
    registerMasterData(r, ctx)
```

```ts
import { registerMasterData } from './routes/masterdata'
```

- [ ] **Step 5: 在 `manifest.yaml` 的 `api.internal` 末尾追加 5 条**

```yaml
    # ── 主数据·管理端（aftersales:manage）──
    # 资源名刻意通用（stores/products/employees）——spec §1.2「可搬迁」纪律，
    # 接龙二期若成为第二消费者，这组端点可整体搬去独立档案模块。
    - { method: GET,  path: /stores,                 scope: aftersales:manage }
    - { method: GET,  path: /products,               scope: aftersales:manage }
    - { method: GET,  path: /employees,              scope: aftersales:manage }
    - { method: POST, path: /employees,              scope: aftersales:manage }
    - { method: POST, path: /employees/:id/approve,  scope: aftersales:manage }
```

- [ ] **Step 6: 收尾验证 + 提交**

```bash
pnpm --filter aftersales test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
git add modules/aftersales
git commit -m "feat(aftersales): 主数据域——门店/商品/员工与注册审批（服务端分页过滤） (#<N>)"
```

---

### Task 9: 附件域（预签名直传）

**Files:**
- Create: `modules/aftersales/routes/attachment.ts`
- Create: `modules/aftersales/routes/attachment.test.ts`
- Modify: `modules/aftersales/manifest.yaml`（追加 2 条声明）
- Modify: `modules/aftersales/index.ts`（追加两个 `register*`）

**Interfaces:**
- Consumes: `objectKeyFor` / `ZosStorage` / `UPLOAD_URL_TTL_SECONDS`（T5）；`ModuleHono` / `RouteCtx`（T6）
- Produces: `registerAttachmentGuest(r: ModuleHono, ctx: RouteCtx): void`、`registerAttachmentManage(r: ModuleHono, ctx: RouteCtx): void`

- [ ] **Step 1: 写失败的测试 `modules/aftersales/routes/attachment.test.ts`**

本文件**不需要 ZOS 真凭证**：预签名是离线计算（T5 已证），假配置即可。

**但假配置只能从 `process.env` 喂进去**——模块的 `storage` 不是宿主 `ModuleContext` 注入的，
而是 `createRouter` 自己 `zosConfigFromEnv(process.env)` 解析出来的（T6 的 index.ts）。
所以本文件用 `vi.stubEnv` 控制它，**且必须在 describe 回调体里、建 app 之前**：
`createRouter` 在**收集期**（describe 回调执行时）就 eager 跑完了，`beforeAll` 那一刻配置早已
解析、storage 早已定型 ⇒ 晚 stub 等于没 stub。

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-att'

describePg('附件域（已配置 ZOS）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ctx = { pool }
  // 假凭证——只为让预签名算得出来；真凭证只在部署环境的 env 里（openship isSecret）。
  // 五个键给齐，zosConfigFromEnv 才返回非 null。必须建在 app 之前，理由见本节开头。
  vi.stubEnv('AFTERSALES_ZOS_ENDPOINT', 'zos.xinan1.ctyun.cn')
  vi.stubEnv('AFTERSALES_ZOS_REGION', 'xinan1')
  vi.stubEnv('AFTERSALES_ZOS_BUCKET', 'aftersales-test')
  vi.stubEnv('AFTERSALES_ZOS_ACCESS_KEY', 'AKIATEST')
  vi.stubEnv('AFTERSALES_ZOS_SECRET', 'secret-test')
  const guest = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] }),
    ctx,
  )
  const manage = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    ctx,
  )

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const post = (body: unknown) => ({
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('访客申请上传 ⇒ 201，回预签名 PUT URL，且 key 形状是 aftersales/{org}/{幂等键}/{uuid}', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-1', contentType: 'image/jpeg', sizeBytes: 12345 }),
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; objectKey: string; uploadUrl: string }
    expect(body.objectKey).toMatch(new RegExp(`^aftersales/${ORG}/req-att-1/[0-9a-f-]{36}$`))
    const url = new URL(body.uploadUrl)
    expect(url.pathname).toBe(`/aftersales-test/${body.objectKey}`) // path-style
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy()
  })

  it('申请上传只写元数据、不碰字节：库里落的是 object_key，工单归属暂为 null', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-2', contentType: 'video/mp4', sizeBytes: 999 }),
    )
    const { id, objectKey } = (await res.json()) as { id: number; objectKey: string }
    const row = await pool.query(
      'select ticket_id, object_key, content_type, uploader_openid, client_request_id from aftersales.ticket_attachment where org = $1 and id = $2',
      [ORG, id],
    )
    expect(row.rows[0]).toMatchObject({
      ticket_id: null,
      object_key: objectKey,
      content_type: 'video/mp4',
      uploader_openid: 'openid-alice',
      client_request_id: 'req-att-2',
    })
  })

  it('非图片/视频 contentType ⇒ 400（白名单，不是黑名单）', async () => {
    const res = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-bad', contentType: 'text/html' }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'UNSUPPORTED_CONTENT_TYPE' })
  })

  it('管理端取附件 ⇒ 200 回预签名 GET URL；跨 org 取 ⇒ 404', async () => {
    const created = await guest.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-att-3', contentType: 'image/png' }),
    )
    const { id } = (await created.json()) as { id: number }

    const ok = await manage.request(`/attachments/${id}`)
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as { url: string; contentType: string }
    expect(body.contentType).toBe('image/png')
    expect(new URL(body.url).searchParams.get('X-Amz-Signature')).toBeTruthy()

    const other = makeIdentity({ orgId: 'test-aftersales-att-other', scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, ctx).request(`/attachments/${id}`)
    expect(cross.status).toBe(404)
  })
})

describePg('附件域（未配置 ZOS）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  // 收集期顺序：上一个 describe 的 stubEnv 生效过（那个 app 已建好、配置已定型），
  // 这里撤掉再建 app ⇒ 这个 app 拿到的就是「五个键全空 ⇒ storage = null」。
  vi.unstubAllEnvs()
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] }),
    { pool },
  )

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  it('storage 为 null ⇒ 503 ZOS_NOT_CONFIGURED（不静默失败、不假装成功）', async () => {
    const res = await app.request(
      '/guest/attachments',
      post({ clientRequestId: 'req-nostorage', contentType: 'image/jpeg' }),
    )
    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'ZOS_NOT_CONFIGURED' })
  })
})

// 收尾兜底：本文件的 stub 撤干净，别把假凭证漏给同 worker 里的其他测试文件。
afterAll(() => vi.unstubAllEnvs())
```

- [ ] **Step 2: 跑测试确认失败**

```bash
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm --filter aftersales test routes/attachment.test.ts
```

Expected: FAIL —— 路由未注册。

- [ ] **Step 3: 写实现 `modules/aftersales/routes/attachment.ts`**

```ts
import { z } from 'zod'
import { UPLOAD_URL_TTL_SECONDS, objectKeyFor } from '../storage'
import type { ModuleHono, RouteCtx } from './context'

/**
 * 只收图片与视频（白名单，不是黑名单）。
 * 理由不是"分类整洁"：预签名 GET 的 URL 一旦泄露，对象的实际内容由上传者决定，
 * 而桶域是独立源。收窄入口是这一层唯一能做的把关（`text/html` 一类不给进）。
 */
const ALLOWED_PREFIXES = ['image/', 'video/']
const MAX_DECLARED_BYTES = 500 * 1024 * 1024 // 500MB，仅作明显误报的护栏，见下方注释

const UploadRequest = z.object({
  /** 客户端幂等键——同时是 object key 的 {ticket_ref} 段（spec §2.3） */
  clientRequestId: z.string().min(1).max(128),
  contentType: z.string().min(1).max(200),
  /** 客户端自报大小。见 handler 里的【已知边界】注释：这是展示用的，不是强制。 */
  sizeBytes: z.number().int().nonnegative().max(MAX_DECLARED_BYTES).optional(),
})

export function registerAttachmentGuest(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/guest/attachments', async (c) => {
    const identity = c.get('identity')
    const parsed = UploadRequest.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { clientRequestId, contentType, sizeBytes } = parsed.data

    if (!ALLOWED_PREFIXES.some((p) => contentType.startsWith(p))) {
      return c.json({ error: 'UNSUPPORTED_CONTENT_TYPE', contentType }, 400)
    }

    // 没配 ZOS 凭证 ⇒ 服务端算不出预签名 URL。回 503 而不是 500，也不是假装成功——
    // 前者说"这个能力此刻不可用"，后者会在客户端留下一张永远传不上去的工单。
    if (!ctx.storage) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)

    const objectKey = objectKeyFor(identity.orgId, clientRequestId)
    // 先落元数据、后给 URL：字节从客户端直传 ZOS，全程不过平台（spec §2.3）。
    // 这一步【不校验对象是否真的传上来了】——预签名 PUT 是"给了一张票"，不是"票已核销"。
    // 是否真有字节，只有在读取时才知道（见下方【已知边界】）。
    const res = await ctx.pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(
         org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid)
       values ($1, null, $2, $3, $4, $5, $6) returning id`,
      [identity.orgId, clientRequestId, objectKey, contentType, sizeBytes ?? 0, identity.userId],
    )

    const uploadUrl = await ctx.storage.presignPut(objectKey, contentType)
    return c.json(
      {
        id: Number(res.rows[0].id),
        objectKey,
        uploadUrl,
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        // 【已知边界，写在这里让调用方看得见】客户端自报的 sizeBytes 是【建议值】：
        // 预签名 PUT 只约束 key 与 Content-Type，不约束长度——服务端没签 Content-Length，
        // 也没法在直传链路上拦（字节根本不过我们）。真正的体积上限要靠 ZOS 侧的桶策略
        // 或后端异步校验，M2a 不含。前端应把它当提示，不要当前置条件。
        sizeBytesAdvisory: true,
      },
      201,
    )
  })
}

export function registerAttachmentManage(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/attachments/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'NOT_FOUND' }, 404)

    const res = await ctx.pool.query(
      `select id, ticket_id, object_key, content_type, size_bytes, uploader_openid, created_at
         from aftersales.ticket_attachment where org = $1 and id = $2`,
      [org, id],
    )
    const row = res.rows[0]
    // 跨租户取别人的附件同样是 404：与不存在同形
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)

    if (!ctx.storage) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)

    return c.json({
      id: Number(row.id),
      ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
      objectKey: row.object_key,
      contentType: row.content_type,
      // bigint 是字符串——见 domain/ticket.ts 的说明
      sizeBytes: Number(row.size_bytes),
      uploaderOpenid: row.uploader_openid,
      createdAt: row.created_at,
      url: await ctx.storage.presignGet(row.object_key as string),
    })
  })
}
```

- [ ] **Step 4: 在 `index.ts` 里追加两行 + import**

```ts
    registerAttachmentGuest(r, ctx)
    registerAttachmentManage(r, ctx)
```

```ts
import { registerAttachmentGuest, registerAttachmentManage } from './routes/attachment'
```

- [ ] **Step 5: 在 `manifest.yaml` 的 `api.internal` 末尾追加 2 条**

```yaml
    # ── 附件（访客传、管理端取）──
    # 上传在访客面（外部客户拍的照片），读取在管理端（客服要看图判损）——按 scope 分面。
    - { method: POST, path: /guest/attachments, scope: aftersales:guest }
    - { method: GET,  path: /attachments/:id,   scope: aftersales:manage }
```

- [ ] **Step 6: 收尾验证 + 提交**

```bash
pnpm --filter aftersales test
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm --filter @platform/web build
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm exec tsx scripts/smoke-load.mjs
git add modules/aftersales
git commit -m "feat(aftersales): 附件域——访客预签名直传 + 管理端预签名读取 (#<N>)"
```

---

## Wave 3

### Task 10: 全量验证 + PR

**Files:**
- 无新增文件（只跑验证、开 PR）

**Interfaces:**
- Consumes: T1–T9 全部产出
- Produces: 一个 CI CLEAN 的 PR

- [ ] **Step 1: 确认工作区干净、分支正确**

```bash
git status --porcelain          # 期望：无输出
git log --oneline main..HEAD    # 期望：T1–T9 的提交，一条不缺
```

Expected: 前者空、后者有 9+ 条提交。若有未提交内容，**先弄清楚是什么再继续**——不要 `git add .`
一把抄。

- [ ] **Step 2: 跑【全量】门禁（该仓 CI 跑的全部命令，不只是本任务相关的）**

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter aftersales test
pnpm --filter @platform/web build
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm run test:guard
DATABASE_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2-)" pnpm exec tsx scripts/smoke-load.mjs
```

Expected: 全绿。**注意**：`pnpm typecheck` 走的是根脚本（`pnpm -r --if-present typecheck`
+ `typecheck:scripts`），比 `pnpm --filter aftersales typecheck` 覆盖面大——单独跑模块那条
**不能**替代它。

- [ ] **Step 3: 推分支**

```bash
git push -u origin feat/aftersales-m2a-module-backend
```

若报 SSL/代理错，先试默认（走 7897）；仍失败再加 `-c http.proxy= -c https.proxy=` 绕过
（本机 git 代理时好时坏，两种结论都别照抄单边）。

- [ ] **Step 4: 开 PR**

```bash
gh pr create --base main --head feat/aftersales-m2a-module-backend \
  --title "feat(aftersales): M2a 模块后端——域 API + 建表 + 天翼 ZOS 预签名 (Closes #<N>)" \
  --body "$(cat <<'EOF'
## 目标
platform-core 第一个真业务模块的后端落地（spec M2a 期）。

## 规范
- `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`
- `docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md`
- `docs/module-protocol.md`

## 范围
- `modules/aftersales`：manifest 声明 + 001 迁移建表（7 张）
- 域 API：工单（管理端 + 访客端）· 规则 · 主数据 · 附件
- 天翼 ZOS 预签名存储（path-style；上传/下载字节不过平台）

## 范围外（**不是遗漏，是有意的**）
- **数据迁移（M2b）**：用户拍板后置到业务空闲窗口，另出计划。本 PR 不含任何源数据依赖。
- console 管理端与移动端 userApp（M3）。
- spec §5 #6「评估租户隔离 CI 门禁升级」——那是独立决定，不随本模块夹带。

## 验收
- [ ] 全量门禁绿（typecheck / module tests / web build / 四道 gate / test:guard / smoke-load）
- [ ] `smoke-load` 证明宿主能装载本模块（装载期双向核对通过）
- [ ] 每个域都有真 PG 测试：金额公式、三态状态机、幂等、租户隔离、跨租户 404 同形

Closes #<N>
EOF
)"
```

- [ ] **Step 5: 等 CI，**只**在 CI CLEAN 时合并**

```bash
gh pr checks --watch
```

Expected: 全绿。**UNSTABLE 不许强合**——强合出过生产 502。

```bash
gh pr merge --squash --delete-branch
```

合并后确认 subject 带 `(#N)`（squash 由 GitHub 生成，标题里已含 `Closes #<N>` 与编号）。

---

## 本计划显式不做的事（写在这里，免得被当成漏项）

1. **M2b 数据迁移**——用户明确后置到空闲窗口（`我们先开发，数据后面找个空闲时间一次性迁就行了`）。
   本计划**不含**任何拉数/清洗/入库/对账步骤，也不预留脚本骨架。
2. **`department` / `archive_order` / `archive_order_item` 建表**——归 M2b（spec §2.1、§3.3：
   无源表样本，M2a 建表等于照猜写 DDL）。
3. **M1 的 userApp 静态托管与 auth-core 公众号 OAuth**——不在本计划，且**已合并到 main**
   （`apps/server/src/routes/auth-wechat-oa.ts`、`migrations/005_tenant_wechat_oa.sql`、
   `manifest.ts` 的 `guest?: { scope }`）；本计划的访客端点声明 `aftersales:guest`，
   落库后即可被真实访客 session 调用。**模块自己的 `mobile/` 目录（userApp 整迁）仍属 M3。**
4. **console 管理端 / 移动端整迁（M3）**——本计划只交付后端。
5. **ZOS 真机端到端验证**（真凭证上传一个视频再取回）——需要真桶，属 spec §3.4 的客户机验收，
   不放在本计划的本地门禁里；本计划的 storage 测试全部是**离线预签名**计算。
6. **spec §5 #6「评估租户隔离 CI 门禁升级」**——那是第一个真模块落地**之后**触发的独立决定。
7. **桶策略/后端异步体积校验**——T9 的 `sizeBytesAdvisory` 已把这条边界写在响应里；真上限靠
   ZOS 侧策略，M2a 不含。


<!-- issue: #73 -->
