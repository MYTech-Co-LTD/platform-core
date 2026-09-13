# platform-core 通用 SaaS 管理域（订阅进 Casdoor · 一层管理）：设计

> 本文是「platform-core 通用 SaaS 管理后台底座」的**规划稿**（spec）。
> **状态：设计已定稿（2026-09-13 用户确认），待 writing-plans 出实施计划后开工。**
> 工作铁律：实施中任何方向/范围调整，先改本文再动码。
>
> 触发链：「要做通用 SaaS 管理后台，混合架构，通用能力（用户/角色/权限/订阅）要完善，新模块能快速接入」
> → 确认混合架构两维 → 确认管理一层化 → 拍板订阅进 Casdoor（A2）→ 评估砍掉自建管理页。

## 1. 现状核实（2026-09-13 实测/源码核对）

### 1.1 平台侧已有

- 四张表（`apps/server/src/migrations/001_platform.sql`）：`platform.tenant`（slug/casdoor_org）、
  `tenant_domain`、`tenant_module`（订阅开关，现行 config 过滤第一环）、`audit`。
- `TENANT_MODE ∈ {multi, single}` 已实现（`config.ts` 强校验）——**部署形态混合的底座已在**。
- 权限码模型：模块 manifest 声明 → 装载器经 Casdoor Admin API **按租户 org 各建一套**
  （`loader.ts` provisionModulePermissions）→ `session.scopes` 从 Casdoor 读。
- console 三重过滤：config（tenant_module）∩ registry（构建期）∩ scope（用户）。
- auth-core 的 Casdoor 客户端现有方法：`ensureUser / getUser / upsertPermission(s) /
  bindUserToAllPermissions / verifyPassword` + adminRequest 通道——**无 Plan/Subscription/Role 方法**。

### 1.2 Casdoor 侧事实（源码级核对 casbin/casdoor master；部署为 `casbin/casdoor:latest`）

- `Plan`：owner/name、price/period、isEnabled、**`Role string`（单数，订阅者授予的角色）**、无模块列表字段。
- `Subscription`：owner（org）、**`User`（订阅者，user 维度必填语义）**、Plan、StartTime/EndTime、
  **`State`（SubscriptionState 状态机）**、Pricing/Payment（计费侧，本期不用）。
- Casdoor 管理后台原生页：用户 / 角色 / 权限 / 订阅——**日常运营操作全部可在此完成**。
- 做不到的：建 `platform.tenant` 行（跨平台库）、品牌设置（平台库 branding）。

## 2. 决策

- **D1 混合架构两维**：① 部署形态 `TENANT_MODE=single/multi`（已有，不动）；② 能力形态 =
  内置管理域（真身+链路）+ `modules/*` 可插拔（模块协议，不动）。
- **D2 订阅真身 = Casdoor Subscription（用户拍板 A2）**，**一模块一 Plan**（`mod-<moduleId>`）：
  Plan 无模块列表字段，一模块一 Plan 使开关正交、无组合爆炸；`Plan.Role` **留空不用于授权**——
  订阅管「租户能用什么」，授权管「谁能用」，两层不混。计费字段（price/period）本期闲置，将来真要计费天然衔接。
- **D3 订阅锚点 = 每 org 一个专用锚用户**（`_tenant_sub`，禁登、仅挂订阅）：Subscription.User 是
  user 维度；挂真实管理员会随人事变动断链。锚用户在 Casdoor 用户列表可见（边界 §6.2）。
- **D4 管理一层化**：只有平台超管（公司运营），**日常运营直接在 Casdoor 后台做**
  （用户/角色/权限/订阅的原生页）；**不自建 M2/M3 管理页**。将来租户自治/客户私有化管理需求出现时
  再建代理页——真身全在 Casdoor，**数据模型零返工**。
- **D5 config 聚合改造**：`/api/platform/config` 的模块清单从查 `tenant_module` 改为查该租户 org 的
  **Active 订阅**（`state=Active 且 now ≤ EndTime`）；带短 TTL 缓存（防每请求打 Casdoor）。
- **D6 tenant_module 退役**：迁移脚本把存量行回填为 Active Subscription；灰度开关
  `PLATFORM_SUBSCRIPTION_SOURCE=platform|casdoor` 切换读取源；切换验证后删表依赖。
- **D7 唯一自建管理件 = 租户开通 CLI**（服务器侧脚本，同 `seed.ts` 模式）：一键完成
  `platform.tenant` + `tenant_domain` + Casdoor org + 权限码扇出 + 锚用户 + 初始订阅 + branding 默认行。
- **D8 console UI 本期零改动**：菜单蓝图的「平台管理▾/帮助▾」组继续留白（无页面不挂菜单的规矩不变）；
  「我的订阅」只读页列为后续可选项。

## 3. 模块快速接入链路（本设计的验收主线）

```
模块开发者：只写 manifest（console 页 + 权限码声明）
   ↓ 装载器（已有，零改动）——启动时按租户 org 自动扇出登记权限码
   ↓ 平台超管：Casdoor 后台「Subscriptions」给租户建一条 Active 订阅（plan=mod-<id>，user=锚用户）
   ↓ 平台超管：Casdoor 后台「Permissions」把权限码授给用户/角色
   ↓ console 菜单自动出现（三重过滤链不动，第一环换成 Casdoor 订阅）
```

**新模块接入成本 = 一份 manifest + Casdoor 后台两次点击。新租户接入成本 = 跑一次 CLI。**

## 4. 设计正文

### 4.1 auth-core Casdoor 客户端扩展（M1a）

新增方法（全部走既有 `adminRequest` 通道）：

```ts
ensureAnchorUser(org: string): Promise<void>        // 建/复用 <org>/_tenant_sub，禁登（password 随机+isForbidden）
ensureModulePlan(moduleId: string): Promise<void>   // 建/复用 plan=mod-<moduleId>（owner=平台org，Role 留空）
listSubscriptions(owner: string): Promise<Sub[]>    // GET get-subscriptions?owner=
upsertSubscription(sub: SubInput): Promise<void>    // add/update-subscription（state/endTime）
```

首任务：**实测** Casdoor 订阅 API 运行行为（state 流转、EndTime 过期由谁驱动、User 字段空值行为），
与源码结构体核对，实测结论回填本文 §1.2。

### 4.2 config 聚合改造（M1b）

- `config` 服务：模块清单 = `listSubscriptions(租户 org)` 中 `state=Active && now ≤ EndTime` 的
  `plan=mod-<id>` 集合，映射回已装载模块；**TTL 缓存（默认 60s，env 可调）**，订阅变更后最长
  TTL 内生效（运营侧立即生效手段：等 TTL 或重启；页面级失效按钮属后续项）。
- 灰度开关 `PLATFORM_SUBSCRIPTION_SOURCE`：`platform`（读旧表，默认）| `casdoor`（读订阅）。
- 迁移脚本：遍历 `tenant_module` → 每行 `ensureAnchorUser + ensureModulePlan + upsertSubscription(Active)`；
  幂等可重跑；迁移后在 Casdoor 后台抽查比对。

### 4.3 租户开通 CLI（M1c）

`scripts/provision-tenant.mjs <slug>`：① 建 Casdoor org（若缺）② 建 `platform.tenant`/`tenant_domain`
③ 锚用户 ④ 触发权限码扇出（复用装载器 provision 逻辑）⑤ 可选 `--module <id>` 逐个建初始订阅
⑥ branding 默认行。输出每步结果，幂等。

## 5. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| M1a | Casdoor 客户端扩展 + API 行为实测 + 锚用户/Plan 机制 | 单测 + 真机 Casdoor 冒烟（建锚用户/Plan/订阅往返） |
| M1b | config 聚合改造 + 缓存 + 灰度开关 + 迁移脚本 | 既有 config/console 测试全绿（mock Casdoor）；迁移脚本对现网幂等重跑通过；灰度切 casdoor 后菜单与旧表一致 |
| M1c | 租户开通 CLI | 新开一个测试租户端到端走通（登录→菜单→模块页） |

**总验收 = §3 链路全链路演示**：新模块（用 demo 模块模拟）→ manifest 已在 → Casdoor 订阅 → 授权 → console 出菜单；退订（state 改 Terminated）→ 菜单在 TTL 内消失。

## 6. 已知边界

1. **Casdoor 订阅 API 运行行为未实测**（结构体已核对）——M1a 首任务实测定调，结论回填 §1.2。
2. 锚用户在各 org 用户列表可见——将来若建租户管理页需过滤；Casdoor 后台运营时知会运营同学忽略。
3. 订阅缓存一致性窗口 = TTL（默认 60s）；改订阅→菜单变化最长延迟一分钟，属可接受。
4. 私有化交付时「客户管理员怎么管用户」：随附 Casdoor 给客户 org 管理员账号（Casdoor 支持按 org
   收敛管理范围），或届时建租户管理页（真身不动，零返工）。
5. 本期不做：计费对接（Plan 价格字段闲置）、租户自治页、console「我的订阅」页、多语言管理文案。
6. 关联规划：console 菜单蓝图（`2026-09-13-console-saas-ui-blueprint-design.md` §3）的「平台管理▾」
   「帮助▾」继续留白；AI 通路 spec（`2026-09-13-case-engine-ai-pathway-design.md`）维持挂起，
   其模块落地时自然走本链路接入。

## 7. 关联

- 会话记忆：`frontend-stack-no-antdpro-migration`（方向 A）、`platform-core-multi-tenant-permission-model`
  （权限码 org 分桶——本设计不改此模型，只把「租户能用什么」从平台表挪到 Casdoor 订阅）。
- Casdoor 结构体核对来源：casbin/casdoor master `object/{plan,subscription,pricing}.go`（2026-09-13）。
