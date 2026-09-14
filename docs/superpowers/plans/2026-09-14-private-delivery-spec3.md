# 私有化多实例交付 spec-3 落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec-3（`docs/superpowers/specs/2026-09-14-private-delivery-design.md`）：provision CLI 还三债（tenant:admin 扇出 / branding 参数 / --domain）、私有化交付 runbook 成文、三处旧文档订正。

**Architecture:** CLI 延续「纯核函数 + 薄壳」模式（`tenantProvisionSteps` 同款）；runbook 记录 openship MCP 调用序列，CLI 的服务器侧执行走 services exec 进 server 容器（scripts/ 与 tsx 已在 runtime 镜像，env 现成，零镜像改动）。试点交付属运营执行，不在本计划内。

**Tech Stack:** Node ESM CLI（tsx）/ vitest 纯核测试 / openship MCP / Markdown runbook。

## Global Constraints

- **分支**：`docs/private-delivery-spec`（已含 spec 提交 `1252ea1`）。
- **feat/fix 必须先有 issue**：Task 1 建 issue，PR body 含 `Closes #N`。
- **提交格式**：`type(scope): 一句话`，中文 subject。
- **CLI 运行方式**：一律 `npx tsx scripts/provision-tenant.mjs ...`（TS barrel + pg 经
  createRequire 锚 apps/server，裸 node 双不可行——spec-1 已修，勿回退）。
- **login_methods 合法值**：只有 `password` 与 `wecom-qr`（前端白名单静默丢弃坑，CLI 侧入口拦）。
- **runbook 纪律**：引用即路径，冒烟清单指针到 `deploy/README.md` 与 `docs/m0-smoke-checklist.md`，不复制正文。
- **波末验证**：`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm smoke`（先 `pnpm --filter @platform/web build`）。
- **M1c 债账本期不销**：试点走完才销（真案例才立标准），AGENTS.md 只加标注。

---

### Task 1: 建 issue（纪律前置）

**Files:** 无代码文件。

**Interfaces:**
- Produces: issue 编号 `#N`，Task 5 的 PR body 引用（`Closes #N`）。

- [ ] **Step 1: 创建 issue**

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "私有化交付能力缺口：provision CLI 三债 + 交付 runbook 缺位 + 旧文档口径漂移（spec-3 落地）" \
  --body "$(cat <<'EOF'
## 背景

spec-3（docs/superpowers/specs/2026-09-14-private-delivery-design.md）落地。
私有化是主要卖法（5+ 家），但：provision CLI 欠三债（tenant:admin 不在扇出——开通后挂码
要等宿主重启；无 branding 参数——建出的租户走前端兜底默认品牌；无 --domain）；交付流程
未成文；adopt runbook §6.1 还在教 tenant_module 插表旧口径；SaaS spec §6.4 未随 M3 回改。

## 要做

- [ ] CLI：tenant:admin 并入扇出（复用 loader 的 PLATFORM_BUILTIN_PERMISSIONS）
- [ ] CLI：--product-name / --login-methods（白名单校验入口拦）/ --domain（占用明确报错）
- [ ] 新 deploy/delivery-private.md（私有化交付 runbook，六步链路 + MCP 调用序列）
- [ ] 订正：openship-adopt.md §6.1（删插表 SQL → CLI）、SaaS spec §6.4、AGENTS.md 债账标注

## 验收（代码侧）

- 纯核测试绿（新参数解析 + steps 变化 + 扇出顺序）
- CLI 本地对本地库幂等重跑无差异
- 试点端到端（运营执行）走完后销 M1c 债
EOF
)"
```

- [ ] **Step 2: 记下 issue 编号 `#N`**。

---

### Task 2: provision CLI 三债（TDD）

**Files:**
- Modify: `scripts/provision-tenant.mjs`
- Test: `scripts/provision-tenant.test.ts`

**Interfaces:**
- Consumes: 既有 `tenantProvisionSteps(slug, opts)`、`planAllTenantGrants(orgs, modules)`；
  `apps/server/src/loader.ts` 的 `PLATFORM_BUILTIN_PERMISSIONS: ReadonlyArray<{code: string, name: string}>`。
- Produces:
  - `parseLoginMethods(raw?: string): string[]`（新导出；缺省 `['password']`；白名单
    `password`/`wecom-qr`，坏值 throw）
  - `provisionPerms(modulePerms, builtin = []): Array<{code, name}>`（新导出；builtin 在前）
  - `tenantProvisionSteps` 的 `opts` 增 `domain?: string`（steps 增 `domain:<host>`，位置在
    anchor 之后、permissions 之前）
  - CLI 新旗标：`--product-name <名>`（缺省 slug）、`--login-methods a,b`、`--domain <host>`

- [ ] **Step 1: 写失败测试（`scripts/provision-tenant.test.ts` 顶部 import 行替换，文件末尾追加两个 describe）**

```ts
import { parseLoginMethods, planAllTenantGrants, provisionPerms, tenantProvisionSteps } from './provision-tenant.mjs'
```

```ts
describe('parseLoginMethods（spec-3 §2.2：白名单入口拦）', () => {
  it('缺省 password；合法值解析去空格；顺序保留', () => {
    expect(parseLoginMethods()).toEqual(['password'])
    expect(parseLoginMethods('wecom-qr')).toEqual(['wecom-qr'])
    expect(parseLoginMethods('password, wecom-qr')).toEqual(['password', 'wecom-qr'])
  })
  it('坏值 throw 且报出合法集合——坏值进库=前端静默丢 tab', () => {
    expect(() => parseLoginMethods('password,oauth')).toThrow(/oauth.*password.*wecom-qr/)
  })
})

describe('provisionPerms（spec-3 §2.1：内置码在前并入扇出）', () => {
  it('builtin 在前 + 模块码随后（与装载器「内置码在前」同序）', () => {
    expect(provisionPerms([{ code: 'demo:view', name: 'x' }], [{ code: 'tenant:admin', name: '租户管理员' }]))
      .toEqual([{ code: 'tenant:admin', name: '租户管理员' }, { code: 'demo:view', name: 'x' }])
    expect(provisionPerms([{ code: 'demo:view', name: 'x' }])).toEqual([{ code: 'demo:view', name: 'x' }])
  })
})
```

原 `tenantProvisionSteps` describe 里追加 domain 用例：

```ts
  it('带 domain 时 steps 在 anchor 后插入 domain 步（spec-3 §2.3）', () => {
    expect(tenantProvisionSteps('acme', { org: 'o1', domain: 'acme.example.com' })).toEqual([
      'org:o1', 'tenant-row:acme', 'anchor', 'domain:acme.example.com', 'permissions',
    ])
  })
```

- [ ] **Step 2: 跑测试确认红**

Run: `pnpm run test:guard`
Expected: FAIL——`parseLoginMethods`/`provisionPerms` 未导出、domain 步不存在。

- [ ] **Step 3: 实现（`scripts/provision-tenant.mjs`）**

在 `planAllTenantGrants` 之后加两个纯核：

```js
/** login_methods 白名单（合法值与 apps/web/src/pages/Login.tsx 的 METHOD_LABELS 一致）：
 *  坏值前端静默丢弃只留账密 tab（adopt runbook §6.1 坑），在 CLI 入口拦下。 */
export function parseLoginMethods(raw) {
  if (!raw) return ['password']
  const allowed = new Set(['password', 'wecom-qr'])
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = parts.filter((p) => !allowed.has(p))
  if (bad.length > 0) throw new Error(`--login-methods 非法值：${bad.join(',')}（合法值：password, wecom-qr）`)
  return parts.length > 0 ? parts : ['password']
}

/** 权限扇出清单 = 内置码在前 + 模块码（spec-3 §2.1：开通即可挂 tenant:admin，不等宿主重启） */
export function provisionPerms(modulePerms, builtin = []) {
  return [...builtin, ...modulePerms]
}
```

`tenantProvisionSteps` 改为（插 domain 步）：

```js
export function tenantProvisionSteps(slug, opts = {}) {
  const org = opts.org ?? `${slug}-org`
  const steps = ['org:' + org, 'tenant-row:' + slug, 'anchor']
  if (opts.domain) steps.push('domain:' + opts.domain)
  steps.push('permissions')
  for (const m of opts.modules ?? []) steps.push('plan:' + m, 'subscribe:' + m)
  return steps
}
```

`main()` 单租户路径改造（参数解析段补三个旗标；`--all-tenants` 路径**不动**——批量发放与
branding/domain 无关）：

```js
  const productName = (() => { const i = args.indexOf('--product-name'); return i > 0 ? args[i + 1] : undefined })()
  const loginMethodsRaw = (() => { const i = args.indexOf('--login-methods'); return i > 0 ? args[i + 1] : undefined })()
  const domain = (() => { const i = args.indexOf('--domain'); return i > 0 ? args[i + 1] : undefined })()
```

打印计划行带上新参（slug 路径）：

```js
  console.log('[provision] 计划：', tenantProvisionSteps(slug, { org, modules, domain }).join(' → '))
```

权限扇出改用 provisionPerms（loader 导入行补 PLATFORM_BUILTIN_PERMISSIONS）：

```js
  const { provisionModulePermissions, PLATFORM_BUILTIN_PERMISSIONS } = await import('../apps/server/src/loader.ts')
```

```js
  const allPerms = provisionPerms(perms, PLATFORM_BUILTIN_PERMISSIONS.map((p) => ({ code: p.code, name: p.name })))
  await provisionModulePermissions(pool, (o) => (o === org ? c : c), allPerms); console.log('  ✓ permissions ×' + allPerms.length)
```

租户行 upsert 换成带品牌列（与 `apps/server/src/seed.ts` 口径对齐）：

```js
  const { rows } = await pool.query(
    `insert into platform.tenant(slug, casdoor_org, product_name, login_methods)
     values ($1, $2, $3, $4)
     on conflict (slug) do update set
       casdoor_org = excluded.casdoor_org,
       product_name = excluded.product_name,
       login_methods = excluded.login_methods
     returning id`,
    [slug, org, productName ?? slug, parseLoginMethods(loginMethodsRaw)],
  )
```

anchor 之后插 domain 步（tenantId 已在手）：

```js
  if (domain) {
    await pool.query('insert into platform.tenant_domain(tenant_id, domain) values ($1, $2) on conflict (domain) do nothing', [tenantId, domain])
    const { rows: occ } = await pool.query('select tenant_id from platform.tenant_domain where domain = $1', [domain])
    if (occ[0]?.tenant_id !== tenantId) throw new Error(`域名已被租户 #${occ[0].tenant_id} 占用：${domain}（on conflict 静默跳过，这里明确报错——spec-3 §2.3）`)
    console.log('  ✓ domain ' + domain)
  }
```

文件头用法注释同步：

```js
// 用法：npx tsx scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...
//       [--product-name <名>] [--login-methods password,wecom-qr] [--domain <host>]（org 缺省 <slug>-org）
//       npx tsx scripts/provision-tenant.mjs --all-tenants --module <id>...（批量发放：遍历 platform.tenant 各 org）
```

- [ ] **Step 4: 跑测试确认绿**

Run: `pnpm run test:guard`
Expected: PASS（新用例 + 原有用例全绿；`tenantProvisionSteps('acme')` 无 domain 时 steps 与旧断言一致——插步条件化，不破坏原形状）。

- [ ] **Step 5: 本地幂等走查（对本地库跑两遍，第二遍无差异、无报错；无 Casdoor 凭据则验到 fail-fast 段即可）**

```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform CASDOOR_URL=http://127.0.0.1:1 \
  node_modules/.bin/tsx scripts/provision-tenant.mjs smoke-cust --org smoke-cust \
  --module demo --product-name 冒烟客户 --login-methods password --domain smoke-cust.test
# 期望打印：计划含 domain 步 → Casdoor 边界 fail-fast（无凭据）；有凭据则两遍全绿
psql "postgres://platform:platform@127.0.0.1:5432/platform" \
  -c "select slug, product_name, login_methods from platform.tenant where slug='smoke-cust'" \
  -c "select domain from platform.tenant_domain where domain='smoke-cust.test'"
# 清理走查残留：
psql "postgres://platform:platform@127.0.0.1:5432/platform" -c "delete from platform.tenant_domain where domain='smoke-cust.test'" -c "delete from platform.tenant where slug='smoke-cust'"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/provision-tenant.mjs scripts/provision-tenant.test.ts
git commit -m "feat(scripts): provision-tenant 还三债——tenant:admin 进扇出、branding 参数、--domain（spec-3 §2）"
```

---

### Task 3: 新 runbook `deploy/delivery-private.md`

**Files:**
- Create: `deploy/delivery-private.md`

**Interfaces:**
- Consumes: Task 2 的 CLI 形态（旗标全集）；openship MCP 工具名。
- Produces: 交付 SOP 文档，Task 4/5 与后续试点引用。

- [ ] **Step 1: 写入全文**

````markdown
# 私有化交付 runbook（spec-3）

> 适用：给一个私有化客户开出一套独立 platform-core 实例（TENANT_MODE=single）。
> 正典：`docs/superpowers/specs/2026-09-14-private-delivery-design.md`；本文是操作层。
> 铁律：运维动作一律走 openship MCP（本文工具名即 MCP 工具名）；每步都有「成功判据」，调一步验一步。

## 0. 每客户三决策点（开工前定）

| 决策 | 默认 | 例外 |
|---|---|---|
| 实例位置 | **客户自己的服务器**（注册 openship server） | 小客户/试点住我方机器 |
| Casdoor | **共用我方 sso.hookflow.cn**，客户一个独立 org | 合规要求 → 客户侧独立 Casdoor 实例（`CASDOOR_URL` 指过去，单独定运维归属） |
| 域名 | 客户自有域名，DNS A 记录到机器公网 IP | 无域名时用 openship 免费子域 |

## 1. 六步开通链路

### 步骤 1：客户机接入（仅客户机路径）

走 `cicd-project-onboarding` 标准阶段 A（网络打通 → 控制面 ufw 4878 白名单 → git
smart-proxy → docker 自动装 → 注册 server）。**本文不复述**，完成判据 = openship 里能看到
该 server（`get_projects` 拿到 serverId 备用）。

### 步骤 2：建 openship project

MCP `post_projects`：name=`platform-core-<客户slug>`、gitOwner=MYTech-Co-LTD、
gitRepo=platform-core、gitBranch=main、composePath=deploy/docker-compose.yml、
rootDirectory=deploy、framework=docker-compose。

⚠️ **serverId 在这一步传不进去**（`post_projects` 不收、`patch` 静默忽略）——只能在步骤 3
的部署调用里带。坑源：`deploy/openship-adopt.md` §6.2。

### 步骤 3：首次部署（带 serverId）+ env 物化

先 env（MCP `patch_projects_by_id_env`，environment=production）：

| 键 | 值 |
|---|---|
| `TENANT_MODE` | `single` |
| `PLATFORM_ORG` | `<客户 casdoor org>` |
| `CASDOOR_URL` | 我方 sso（默认）或客户独立实例 |
| `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` / `CASDOOR_ADMIN_USER` / `CASDOOR_ADMIN_PWD` / `CASDOOR_APPLICATION` | 按目标 Casdoor 取值（敏感值走 isSecret） |
| `PLATFORM_SESSION_SECRET` | 随机生成（isSecret） |
| `PUBLIC_ORIGIN` | `https://<客户域名>` |
| `PLATFORM_SUBSCRIPTION_SOURCE` | `casdoor`（**新交付一律 casdoor 源，全平台单一口径**；platform 源仅我方实例回滚兜底） |

再部署（MCP `post_deployments_build_access`）：projectId、**serverId**（步骤 1 拿的）、
deployTarget=server、branch=main、environment=production。

成功判据：`get_deployments_by_id_build` status=ready + 日志 Health check passed。
（postgres 探活误报忽略，见 adopt §6.3。）

### 步骤 4：CLI 开通租户（服务器侧执行）

⚠️ **本机直连生产库不可行**（pg 绑回环，B7）。CLI 在 server 容器内跑——`scripts/` 与
tsx 本来就在 runtime 镜像里（`deploy/Dockerfile.server` COPY ③ + 全量 node_modules），
容器 env 现成（DATABASE_URL 指服务名 postgres）。

MCP `post_projects_by_id_services_by_serviceId_exec`（serviceId 从
`get_projects_by_id_services` 拿，服务名 server），command：

```sh
pnpm exec tsx scripts/provision-tenant.mjs <客户slug> --org <客户org> --module <id>... \
  --product-name <产品名> --login-methods password[,wecom-qr] --domain <客户域名>
```

成功判据：逐步 ✓ 打印到 `permissions ×N`（N = 模块码数 + 1，含 tenant:admin）与
`subscribe mod-<id>`、`domain <host>`；**幂等可重跑**。

### 步骤 5：域名与证书

MCP `post_domains`（projectId、hostname=<客户域名>）→ `post_domains_by_id_verify` →
`post_domains_by_id_verify_ssl`。DNS 由客户侧先把 A 记录指到机器公网 IP。

### 步骤 6：冒烟

按 `deploy/README.md` 的部署后验证（容器创建时间 vs 镜像构建时间、新行为可观测）+
`docs/m0-smoke-checklist.md`。登录一口：CLI 建的是租户与订阅，**第一批用户要在 Casdoor
建号并挂码**（客户管理员 = `tenant:admin`，挂上后 console「管理」菜单组可见——M3 页自管）。

## 2. 升级 SOP

- **我方托管实例**：CI 自动（merge main 即部署，现状不动）。
- **客户实例**：维护窗口内逐家 MCP `post_deployments`（**必须带 serverId**、branch=main）。
  先通知客户定窗口；一次窗口内多家顺序执行，每家 ready 后再下一家。
- **回滚**：MCP `post_deployments_by_id_rollback`（每 project 独立回滚窗，互不牵连）。
- 批量脚本：3 家以上再立项（spec-3 §0 方案 B）。

## 3. 边界

- 独立 Casdoor 实例的部署与运维归属：特殊情况按客户单独定，本文不展开。
- 壳层定制（布局/导航/多语言）：**L2 车道未建前不接**（spec-1 §1），立项信号 = 第一个真实壳层需求。
````

- [ ] **Step 2: 验证引用即路径**

Run: `ls docs/superpowers/specs/2026-09-14-private-delivery-design.md docs/m0-smoke-checklist.md deploy/README.md deploy/openship-adopt.md && rg -n "cicd-project-onboarding" deploy/delivery-private.md`
Expected: 全部存在；runbook 引用的标准名在场。

- [ ] **Step 3: Commit**

```bash
git add deploy/delivery-private.md
git commit -m "docs(deploy): 私有化交付 runbook——六步开通链路 + MCP 调用序列 + 升级 SOP（spec-3 §3）"
```

---

### Task 4: 订正三文档

**Files:**
- Modify: `deploy/openship-adopt.md`（§6.1）
- Modify: `docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md`（§6.4 + 修订记录）
- Modify: `AGENTS.md`（债账行）

**Interfaces:**
- Consumes: Task 3 的 runbook（指针目标）。

- [ ] **Step 1: adopt runbook §6.1 订正**

把 §6.1 里「照 `apps/server/src/seed.ts` 的口径手工建（幂等）」起的整段 psql heredoc
（`insert into platform.tenant ...` 到 `commit;`）替换为：

````markdown
生产**不能**用 `SEED_DEMO=1` 绕过（它会种出 acme/beta 两个演示租户）。改跑 provision CLI
（`deploy/delivery-private.md` 步骤 4，服务器侧容器内执行）：

```sh
pnpm exec tsx scripts/provision-tenant.mjs <slug> --org <casdoor-org> --module <id>... \
  --product-name <产品名> --login-methods password --domain <域名>
```

- **`login_methods` 的合法值只有 `password` 与 `wecom-qr`**（见 `apps/web/src/pages/Login.tsx`
  的 `METHOD_LABELS`）。CLI 已做白名单校验；**手工 SQL 路径仍在的话**写错的值被前端
  **静默丢掉**，登录页只剩账密 tab。
- `product_name` 就是控制台标题与登录页品牌。
- **`PLATFORM_SUBSCRIPTION_SOURCE=casdoor` 是新交付的统一口径**：模块启用走 Casdoor 订阅
  （CLI 的 `--module` 建 plan+Active 订阅）。往 `tenant_module` 插表的旧做法**废弃**——
  casdoor 源下没人读那张表，插了也白插。platform 源仅作我方实例的临时回滚兜底。
````

- [ ] **Step 2: SaaS spec §6.4 回改 + 修订记录**

§6.4 原文「私有化交付时「客户管理员怎么管用户」：随附 Casdoor 给客户 org 管理员账号
（Casdoor 支持按 org 收敛管理范围），或届时建租户管理页（真身不动，零返工）。」替换为：

```markdown
4. 私有化交付时「客户管理员怎么管用户」：给客户管理员挂 `tenant:admin` 码，用 console
   M3 自管页（用户/角色授权/我的订阅，2026-09-13 已上线）；或随附 Casdoor org 管理员账号
   （Casdoor 支持按 org 收敛管理范围）。交付流程正典：`deploy/delivery-private.md`（spec-3）。
```

修订记录追加一行：

```markdown
- 2026-09-14：§6.4 回改——M3 租户管理员页已上线，私有化客户管理口径改为 tenant:admin +
  console 自管；交付流程指向 spec-3 的 delivery-private.md。
```

- [ ] **Step 3: AGENTS.md 债账行标注**

`## 债账与遗留` 里「M1c CLI 的 multi 模式端到端验收未做」改为：

```markdown
- open issues（#12 CI 间歇红等）；spec「已知边界」节；M1c CLI 端到端验收未做（multi +
  single 两笔，待 spec-3 试点交付时销账——`deploy/delivery-private.md`）。
```

- [ ] **Step 4: Commit**

```bash
git add deploy/openship-adopt.md docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md AGENTS.md
git commit -m "docs(deploy): 订正三处旧口径——§6.1 插表废弃改 CLI、SaaS spec §6.4 随 M3 回改、债账标注待试点（spec-3 §3）"
```

---

### Task 5: 全量验证 + push + PR

**Files:** 无新文件。

**Interfaces:**
- Consumes: Task 1 的 `#N`。

- [ ] **Step 1: 全量验证**

```bash
pnpm test && pnpm typecheck && pnpm build && pnpm --filter @platform/web build && pnpm smoke
```

Expected: 全绿（CLI 改动只碰 scripts/，server/web 面零改动，但按波末规矩跑全量）。

- [ ] **Step 2: push**

```bash
git push -u origin docs/private-delivery-spec
```

- [ ] **Step 3: 开 PR（`#N` 替换为 Task 1 编号）**

```bash
gh pr create --repo MYTech-Co-LTD/platform-core \
  --base main \
  --title "feat(scripts): provision CLI 三债 + 私有化交付 runbook（spec-3） (#N)" \
  --body "$(cat <<'EOF'
Closes #N

## 内容

- feat(scripts)：provision-tenant 三债——tenant:admin 并入扇出（复用 loader
  PLATFORM_BUILTIN_PERMISSIONS，开通即可挂码不等重启）、--product-name /
  --login-methods（白名单入口拦）/ --domain（占用明确报错）；纯核测试带测
- docs(deploy)：新 delivery-private.md——六步开通链路（MCP 调用序列 + serverId 坑 +
  CLI 服务器侧容器内执行路径）+ 升级/回滚 SOP
- docs：订正 adopt §6.1（插表废弃 → CLI + casdoor 源统一口径）、SaaS spec §6.4（随 M3
  回改）、AGENTS.md 债账标注

## 验证

- [x] pnpm test / typecheck / build / smoke 全绿
- [x] 纯核测试：parseLoginMethods / provisionPerms / steps 含 domain 步
- [ ] CLI 对本地库幂等重跑无差异（含新参数；有 Casdoor 环境时补真机两遍）
- [ ] 试点客户六步全流程（运营执行，走完销 M1c 债）

spec：docs/superpowers/specs/2026-09-14-private-delivery-design.md
EOF
)"
```

（走查 checkbox 按实际结果勾，**不编**。）

- [ ] **Step 4: 等 CI CLEAN 再合并**（UNSTABLE 不合；合并后自动部署，做部署后验证）。
