# platform-core 通用 SaaS 管理域（订阅进 Casdoor · 一层管理）：设计

> 本文是「platform-core 通用 SaaS 管理后台底座」的**规划稿**（spec）。
> **状态：设计已定稿并全部落地——M1（PR #42/#43）、M3（PR #47/#48）已上线；D6 灰度已切 casdoor（2026-09-14，openship env `PLATFORM_SUBSCRIPTION_SOURCE=casdoor`）且 §5 总验收通过（见修订记录）。tenant_module 表保留为回滚兜底，拆表是另一个待议决定。**
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

### 1.2 Casdoor 侧事实（2026-09-13 真机尖刺验证，三轮；源码级核对 casbin/casdoor master）

- `Plan`：owner/name、price/period、isEnabled、**`Role string`（单数，订阅者授予的角色）**、无模块列表字段。
- `Subscription`：owner（org）、`User`（订阅者）、Plan、StartTime/EndTime、`State`（状态机）。
- **真机实测结论（sso.hookflow.cn，借 server 容器凭据，测完残留清零）**：
  1. **全套 CRUD 可用**：add/get/update/delete plan 与 subscription 均走通；admin 会话可跨 org 读列表。
  2. **时间必须 RFC3339（UTC Z 后缀）**：写 `"YYYY-MM-DD HH:MM:SS"` 会被存下但**毒化该 org 的
     get-subscriptions 整体列表**（解析报错、列表全挂，单条读不受影响）——比"写失败"严重，
     属危险失败模式。客户端必须强格式化 + 写后回读验证；解毒手段 = update/delete 单条。
  3. **用户名仅字母数字**（`_` 被拒：「The username may only contain alphanumeric characters」）——
     D3 锚用户命名不得含下划线。
  4. **delete 类端点全部要 JSON body `{owner,name}`**；`?id=` query 形式对 delete-user **静默无效**
     （返回空、什么都没删）——阴险坑，客户端封装必须钉死 body 形式。
  5. `add-subscription` **不校验 user**（空/不存在均收）——仍保留锚用户：Casdoor UI 按用户展示/管理订阅，
     空 user 的订阅在运营后台不可见不可管。
  6. 现网已存在他人订阅（woke org `sub_6a6def`，2026-08-29 支付流程产生，plan-pro Active）——
     说明订阅流已被试过；M1b 迁移脚本读列表时须容忍非 `mod-` 前缀的外来订阅。
- Casdoor 管理后台原生页：用户 / 角色 / 权限 / 订阅——日常运营操作全部可在此完成。
- 做不到的：建 `platform.tenant` 行（跨平台库）、品牌设置（平台库 branding）。

## 2. 决策

- **D1 混合架构两维**：① 部署形态 `TENANT_MODE=single/multi`（已有，不动）；② 能力形态 =
  内置管理域（真身+链路）+ `modules/*` 可插拔（模块协议，不动）。
- **D2 订阅真身 = Casdoor Subscription（用户拍板 A2）**，**一模块一 Plan**（`mod-<moduleId>`）：
  Plan 无模块列表字段，一模块一 Plan 使开关正交、无组合爆炸；`Plan.Role` **留空不用于授权**——
  订阅管「租户能用什么」，授权管「谁能用」，两层不混。计费字段（price/period）本期闲置，将来真要计费天然衔接。**plan 按租户 org 各建一份**（修订：Casdoor UI 的 plan picker 按当前 org 查，平台 org 的 plan 运营在租户视角选不到——随订阅扇出建，与权限码同构）。
- **D3 订阅锚点 = 每 org 一个专用锚用户**（`tenantsub`，禁登、仅挂订阅；**仅字母数字**，实测 `_` 被
  用户名字符集拒绝）：Subscription.User 是 user 维度且 Casdoor UI 按用户管理订阅（空 user 不可管，
  实测不校验但不可运营）；挂真实管理员会随人事变动断链。锚用户在 Casdoor 用户列表可见（边界 §6.2）。
- **D4 管理双层（2026-09-13 二次确认修订，推翻初版「一层化」——初版折叠时丢了「租户管理员
  要在自建后台管」的原始意图，属决策对齐偏差）**：
  - **平台超管（公司运营）→ Casdoor 后台**（sso.hookflow.cn）：租户 org 开通、订阅发放/退订、
    全局用户/角色/权限。不建平台超管页（原 M2 维持砍）。
  - **租户管理员 → platform-core console 自建页（恢复 M3）**：本租户用户管理、角色与授权、
    我的订阅（只读）。后端 = apps/server 代理 Casdoor Admin API（**锁 org=本租户**，越界即拒）
    + listSubscriptions 只读。真身仍在 Casdoor，页面是代理——不违 A2。
- **D5 config 聚合改造**：`/api/platform/config` 的模块清单从查 `tenant_module` 改为查该租户 org 的
  **Active 订阅**（`state=Active 且 now ≤ EndTime`）；带短 TTL 缓存（防每请求打 Casdoor）。
- **D6 tenant_module 退役**：迁移脚本把存量行回填为 Active Subscription；灰度开关
  `PLATFORM_SUBSCRIPTION_SOURCE=platform|casdoor` 切换读取源；切换验证后删表依赖。
- **D7 唯一自建管理件 = 租户开通 CLI**（服务器侧脚本，同 `seed.ts` 模式）：一键完成
  `platform.tenant` + `tenant_domain` + Casdoor org + 权限码扇出 + 锚用户 + 初始订阅 + branding 默认行。
- **D9 租户管理员识别 = 权限码 `tenant:admin`**（平台内置码，随装载器按租户 org 扇出供给，
  与模块码同机制）；console「管理」菜单组与 M3 页面以它门禁。授权动作在 Casdoor 完成（给用户挂码）。
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
ensureAnchorUser(org: string): Promise<void>        // 建/复用 <org>/tenantsub，禁登（password 随机+isForbidden；仅字母数字名）
ensureModulePlan(org: string, moduleId: string): Promise<void>  // 建/复用 plan=mod-<moduleId>（owner=租户org，Role 留空）
listSubscriptions(owner: string): Promise<Sub[]>    // GET get-subscriptions?owner=（容忍外来订阅，只认 mod- 前缀）
upsertSubscription(sub: SubInput): Promise<void>    // add/update-subscription（state/endTime）
// 三条铁律（真机实测，§1.2）：
// ① startTime/endTime 一律 RFC3339 UTC（写错毒化整个 org 的列表读取）
// ② delete 类端点一律 JSON body {owner,name}（query 形式静默无效）
// ③ 每次写订阅后回读验证（防静默坏行）
```

~~首任务：实测 Casdoor 订阅 API 运行行为~~ **已完成（2026-09-13 三轮真机尖刺），结论回填 §1.2。**

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
| **M3（修订恢复）** | 租户管理员 console 页：用户管理 / 角色与授权 / 我的订阅（只读）；后端代理锁 org | 有 tenant:admin 码的账号见「管理」菜单组；用户增删/授权往返真机验证；无码账号不可见 |

**总验收 = §3 链路全链路演示**：新模块（用 demo 模块模拟）→ manifest 已在 → Casdoor 订阅 → 授权 → console 出菜单；退订（state 改 Terminated）→ 菜单在 TTL 内消失。
**✅ 已通过（2026-09-14 真机验收）**：切 casdoor 源后 config 清单与旧表基线一致；发放（Active）→ 菜单/工作台出现；退订（Terminated）→ config ~8s 内剔除、浏览器菜单消失；复订 → ~32s 内恢复（TTL 窗口内）。验收中发现并修复 issue #50（update-subscription 缺 `?id=` 静默失效，PR #51）。

## 6. 已知边界

1. ~~Casdoor 订阅 API 运行行为未实测~~ **已实测闭环（§1.2 真机尖刺）**；残余未知只剩 EndTime 到期后
   state 由谁翻转（Casdoor 定时任务 vs 只读不翻）——不阻塞设计：读取侧已按 `state=Active 且
   now ≤ EndTime` 双重判定，翻不翻都不影响口径。
2. 锚用户在各 org 用户列表可见——将来若建租户管理页需过滤；Casdoor 后台运营时知会运营同学忽略。
3. 订阅缓存一致性窗口 = TTL（默认 60s）；改订阅→菜单变化最长延迟一分钟，属可接受。
4. 私有化交付时「客户管理员怎么管用户」：给客户管理员挂 `tenant:admin` 码，用 console
   M3 自管页（用户/角色授权/我的订阅，2026-09-13 已上线）；或随附 Casdoor org 管理员账号
   （Casdoor 支持按 org 收敛管理范围）。交付流程正典：`deploy/delivery-private.md`（spec-3）。
5. 本期不做：计费对接（Plan 价格字段闲置）、租户自治页、console「我的订阅」页、多语言管理文案。
6. 关联规划：console 菜单蓝图（`2026-09-13-console-saas-ui-blueprint-design.md` §3）的「平台管理▾」
   「帮助▾」继续留白；AI 通路 spec（`2026-09-13-case-engine-ai-pathway-design.md`）维持挂起，
   其模块落地时自然走本链路接入。
7. M3「角色与授权」页口径（2026-09-13 补）：授权 = **权限码 ↔ 用户直挂**（与
   effectiveScopes 的 matchUser 语义一致，含 `tenant:admin` 自身的授予/回收 = 管理员交接）。
   Casdoor Role 组管理不在 M3（那是平台超管在 Casdoor 后台的事）；将来要做角色组再扩。

## 7. 关联

- 会话记忆：`frontend-stack-no-antdpro-migration`（方向 A）、`platform-core-multi-tenant-permission-model`
  （权限码 org 分桶——本设计不改此模型，只把「租户能用什么」从平台表挪到 Casdoor 订阅）。
- Casdoor 结构体核对来源：casbin/casdoor master `object/{plan,subscription,pricing}.go`（2026-09-13）。

## 8. 修订记录

- 2026-09-13（晚）：**D4 一层化 → 双层**。用户澄清原始意图：平台超管管 Casdoor，**租户管理员在自建
  console 管**。初版一层化把两层都折叠进 Casdoor 后台，砍掉的 M3（租户管理员页）**恢复**；M2（平台
  超管页）维持不做。新增 D9（tenant:admin 权限码）。M1 的全部产出（订阅真身/客户端方法/双源/CLI）
  不受影响——M3 页面正是构建在 M1 之上。
- 2026-09-13（夜）：M3 计划落盘（`plans/2026-09-13-m3-tenant-admin-console.md`，issue #46），
  补 M3 授权页口径（码↔用户直挂，角色组不做）。
- 2026-09-14：**D6 灰度切换完成 + §5 总验收通过**。生产切 `PLATFORM_SUBSCRIPTION_SOURCE=casdoor`
  （openship env），tenant_module 存量已回填为 Active 订阅（mytech/mod-demo）；表保留为回滚兜底。
  验收中发现 issue #50（upsertSubscription update 缺 `?id=`，真机静默 no-op，宽松替身遮蔽——
  PR #51 修复并收严回读验 state）。迁移动作在容器内以等价客户端调用完成（脚本因 pnpm 布局
  在容器解析不到 pg，此坑待沉淀）。
- 2026-09-14（晚）：§6.4 回改——M3 租户管理员页已上线，私有化客户管理口径改为 tenant:admin +
  console 自管；交付流程指向 spec-3 的 `deploy/delivery-private.md`。
