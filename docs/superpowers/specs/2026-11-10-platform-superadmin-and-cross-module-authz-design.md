# 平台超管身份与跨模块权限原语：设计（选项与判据）

> **状态：用户已拍板 A1（2026-11-10）——维持现状（平台运营继续走 Casdoor 后台）；A2/A3 不实施，保留为候选。** 本文只做设计与决策登记，**不写码**。
> 关联 issue：#1821（本文）、#176（marts 缺 org 列 + 平台超管 signal）、#174 / #175（数据面租户隔离）、#153（multi 验收）。
> 架构先行：任何选项落地前先改本文，再开实现 issue。

## 0. 一句话

平台级权限码（`platformOnly`）今天只能由平台运营在 Casdoor 后台授予，console 内**没有平台超管身份、
也没有跨租户视图**；同时部门门 / 资产 ACL / 列值级裁剪的实现都长在 `modules/data`。本文给出两条线的
选项、推荐与「什么时候才抽成平台原语」的判据。

## 1. 现状取证（2026-11-10 核对）

### 1.1 平台级权限码

| 事实 | 位置 |
|---|---|
| `platformOnly` 是 manifest 权限条目的可选字段 | `packages/platform-sdk/src/manifest.ts:63,152` |
| 装载器仍把 `platformOnly` 码供给到每个租户 org（平台运营要能在 Casdoor 授予） | `apps/server/src/loader.ts:176`、`:217` |
| 租户管理员的授权宇宙过滤它；授权端点再显式 404 | `apps/server/src/admin-permissions.ts`、`apps/server/src/routes/admin.ts:111-116,200-213` |
| 平台内置码只有 `tenant:admin` | `apps/server/src/loader.ts:162` |

**结论**：`platformOnly` 解决了「租户管理员不能自授」，但没有解决「平台运营在应用内从哪进」。
当前唯一通路是 Casdoor 后台，且平台侧动作没有平台自己的审计面。

### 1.2 平台路由的租户锁定

| 事实 | 位置 |
|---|---|
| `/api/platform/admin/*` 整路由 `requireScope('tenant:admin')` | `apps/server/src/routes/admin.ts:98-99` |
| org 永远取自 `c.get('tenant').casdoor_org`，请求参数没有改 org 的口子 | `apps/server/src/routes/admin.ts:1-6`、`app.ts:319-335` |
| `platformRoutes` 是 branding/config（模块清单 + 启用闸门），不是跨租户运营面 | `apps/server/src/app.ts:274-279` |

**结论**：现有管理面**结构上不可能跨租户**；做平台运营页不能靠放宽 `/api/platform/admin/*`，
必须另开路由面并单独设计门禁。

### 1.3 跨租户数据面的既有缺口

- #176：`marts` 关系缺 `org` 列 ⇒ 行级授权没有着力点；同 issue 的「平台超管 signal」是本文 A 线的来源。
- #174 / #175：数据面租户隔离承重点未验、每租户一桶在实现中降级为共享桶+前缀 SCOPE。
- 这些是**数据面**问题，不在本文 A 线内解决；本文只登记与平台身份的关系。

### 1.4 跨模块权限原语的现状

| 原语 | 当前归属 | 是否平台通用 |
|---|---|---|
| 声明式 scope（manifest → 宿主门卫） | 平台（loader + `declaredScopeGate`） | ✅ 通用 |
| 部门门（`requiredDepts` + 祖先闭包） | `modules/data/domain/dept-gate.ts` | ❌ data 私有 |
| 资产 ACL（owner / viewer × 用户/部门/权限码） | `modules/data/domain/asset-auth.ts` + `data.asset_acl` | ❌ data 私有 |
| 列级/值级（`data:cost` / `mask_spec` / `data:precise`） | `modules/data/domain/authz.ts` / `mask.ts` | ❌ data 私有（与 `authorize()` SQL 投影强耦合） |
| 部门 → 成员展开（通知） | 宿主 `apps/server/src/channel-address.ts` 注入 | ✅ 宿主能力（先例） |

**先例**：`channel-address.ts` 证明「模块需要平台数据时，由宿主注入能力」是可行形态
（模块不直读 `platform.org_*`，B1 纪律不破）。

## 2. 决策点 A：平台超管身份

### 2.1 选项

| 选项 | 内容 | 成本 | 风险 | 适用 |
|---|---|---|---|---|
| **A1 维持现状** | 平台运营继续走 Casdoor 后台授予 `platformOnly` 码；console 不提供平台面 | 0 | 平台动作无应用内审计/视图；运营体验差 | 平台运营人数少、动作低频 |
| **A2 内置 `platform:admin` + 只读运营页** | `PLATFORM_BUILTIN_PERMISSIONS` 新增 `platform:admin`（`platformOnly`）；平台运营在 Casdoor 授予；宿主新增 `/api/platform/ops/*` **只读**聚合（租户清单、集成健康、组织同步状态）；**v1 不做跨租户写** | 中 | 权限集中；跨租户读必须严格只读；路由面要单独审计 | 需要应用内看见「平台整体状态」 |
| **A3 独立平台 Casdoor org/app + 平台 console** | 平台身份与租户身份彻底隔离，独立登录/应用 | 高 | 新部署单元、SSO 配置、多一套会话 | 平台运营组织化为独立团队 |

### 2.2 推荐与决策

**决策（2026-11-10，用户拍板）：A1 维持现状。** 平台运营继续在 Casdoor 后台授予 `platformOnly` 码；
不新增 `platform:admin`、不新增 `/api/platform/ops/*`。A2/A3 保留为候选，只有出现「平台运营需要
应用内跨租户视图」的真实需求时再回到本文。理由见 §2.5。

### 2.3 A2 的语义草案（若拍板实施）

- `platform:admin` 是**平台内置码**，`platformOnly: true`；loader 仍供给到每个租户 org，
  租户管理员的授权宇宙过滤它（与 `forms:global-manage` 同一条机制）。
- 门禁：`/api/platform/ops/*` 要求 `platform:admin`；**不复用** `/api/platform/admin/*`
  （后者必须保持租户锁定）。
- 读面：只读聚合 `platform.tenant` + `platform.integration` + `platform.audit` 的**摘要**；
  不返回租户业务数据；每次访问落 `platform.audit(action='platform.ops.read')`（或按需采样）。
- 写面：v1 **明确不做**。平台运营的写动作仍走 Casdoor 后台或 openship MCP。
- 风险控制：`platform:admin` 只能由 Casdoor 后台授予；租户管理员看不到、授不了；
  平台页面不返回任何租户业务表内容；路由与租户管理面物理分开。

### 2.4 需要用户拍板的问题

1. 平台运营是谁、几个人、是否独立组织？（决定 A1/A2/A3）
2. 若做 A2，v1 只读视图需要哪些？（租户清单 / 集成健康 / 组织同步状态 / 部署状态）
3. 是否接受「平台写动作继续走 Casdoor / openship」这一边界？

> **已拍板（2026-11-10）：A1。** 问题 2/3 不适用（不实施 A2）；平台写动作继续走 Casdoor / openship。

### 2.5 决策记录（A1）

**选定 A1：维持现状。** 理由：平台运营人数少、动作低频；`platformOnly` 已解决「租户管理员自授」；
应用内平台面没有真实需求，按 YAGNI 不建。

**后果与边界**：

- 平台专属码的授予与回收**只在 Casdoor 后台**；租户管理员看不到、授不了（`platformOnly` 双锁不变）。
- 平台侧动作**没有 platform 自己的审计面**；取证靠 Casdoor 侧审计 + `scripts/audit-permission-holders.mjs`
  （只读列各 org 中持有敏感码的用户）。
- 不新增 `platform:admin` 码、不新增 `/api/platform/ops/*`；`/api/platform/admin/*` 的租户锁定不变。
- 未来若出现「平台运营需要应用内跨租户视图」的真实需求，重新打开本文按 A2 分期（v1 只读）。

## 3. 决策点 B：跨模块权限原语

### 3.1 抽取判据（先立规矩）

1. **出现第二个真实消费方才抽**（仓库既有「第二个消费者再抽公共包」纪律，architecture §5 第 9 条同源）；
   没有真实需求时只登记接口候选，不建抽象。
2. **模块不直读平台表**（B1）：抽出的能力由宿主注入（`channel-address.ts` 先例），
   或走 manifest `dataDependencies` 的稳定只读视图。
3. **单一判定实现**：抽出后必须收敛到一份 `canView/canEdit`（资产 ACL 的既有纪律），
   不允许各模块各写一份。
4. **列/值级不强行通用化**：它与 data 的 `authorize()` SQL 投影强耦合；除非出现第二个
   查询引擎消费方，否则不上平台。

### 3.2 候选接口（仅登记，不实施）

| 需求 | 候选形态 | 触发条件 |
|---|---|---|
| 其他模块要按部门看数据 | 宿主注入 `deptGate`（`userDeptClosure` + `deptGatePasses` + `validateDeptGate`），manifest 声明能力 | 第二个模块出现 `requiredDepts` 类需求 |
| 其他模块要资产级共享（owner/viewer） | 平台 `platform.asset_acl(org, module, asset_id, ...)` + 宿主 `ctx.authz.canView/canEdit` | 第二个模块出现「用户自建内容默认私有」需求 |
| 其他模块要列/值级裁剪 | 暂不抽；data 内继续单一实现 | 出现第二个查询引擎消费方 |

> 明确不做：通用策略引擎 / ABAC / 表达式 DSL。当前三个原语已覆盖真实案例，新增抽象没有案例支撑
> （「无案例不立标准」）。

## 4. 分期与验收

| 期 | 内容 | 前置 |
|---|---|---|
| Phase 0 | ✅ 本文评审 + 拍板：**A1（2026-11-10）**；抽取触发条件维持 | 用户 |
| Phase 1（A2，**未实施**） | `platform:admin` 码 + `/api/platform/ops/*` 只读 + 审计 + console 页 | 未来真实需求；安全评审 |
| Phase 2（若抽原语） | 宿主注入部门门能力；第二个模块接入 | 第二个真实消费方 |
| Phase 3（独立线） | #176 marts org 列；#153 multi 验收 | 数据面设计 |

**A1 结论**：不实施 Phase 1。平台专属码的授予/回收只在 Casdoor 后台，取证用
`scripts/audit-permission-holders.mjs`；没有应用内平台视图（A1 明确接受）。

**A2 验收（候选，未实施）**：租户管理员在权限页看不到 `platform:admin`，直接 POST 该码返回 404；
平台运营持码可读运营页；租户业务数据不出现在响应；`/api/platform/admin/*` 的租户锁定回归不变。

**B 验收**：候选接口不落地前，模块不得直读 `platform.org_*` / `data.asset_acl`；
`lint-architecture` / `check-tenant-isolation` 保持绿。

## 5. 风险与已知边界

| 风险 | 处置 |
|---|---|
| 平台权限集中在少数账号 | Casdoor 后台授予；审计靠 Casdoor 侧 + `audit-permission-holders.mjs`；**无应用内平台视图（A1 接受）** |
| 平台页误放宽租户锁定 | （A2 若实施）物理分开路由；`/api/platform/admin/*` 不动；测试钉住「租户管理员访问 ops 404」 |
| 过早抽原语导致第二套真相 | 第二个真实消费方才抽；抽出后单一实现 |
| `platform:admin` 被租户管理员自授 | （A2 若实施）复用 `platformOnly` 过滤 + 授权端点 404 双锁 |
| 列/值级通用化把 data 的 SQL 投影拆散 | 明确不抽，直到第二个查询引擎消费方 |

## 6. 关联

- issue：#1821（本文）、#176、#174、#175、#153
- 既有 spec：`2026-10-27-authz-hardening-design.md`（platformOnly）、
  `2026-10-30-org-as-platform-primitive-design.md`（组织原语）、
  `2026-11-01-mobile-first-business-surface-design.md` §4（资产 ACL）、
  `2026-10-17-column-and-value-level-security-design.md`（列/值级）
- 架构：`docs/architecture.md` §4.2、`docs/module-protocol.md`「跨模块只读数据依赖」
- 先例：`apps/server/src/channel-address.ts`（宿主注入部门解析能力）
