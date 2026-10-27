# 权限体系加固：JIT 零授权 · platformOnly 码 · 禁用失效 · 订阅源 fail-closed

> **状态：设计已定稿（2026-10-27），待 issue / PR。**
> **触发**：对 `platform-core` 组织架构与权限体系的静态审计发现四处「代码行为与设计意图之间的缝」：
> ① JIT 自动建号把 org 内全部权限码挂给新用户（含 `tenant:admin`）；
> ② 平台专属码 `forms:global-manage` 可被租户管理员自授，而它写的是全部署共享的全局字典；
> ③ Casdoor 禁用用户后，平台自己的会话与 PAT 不会失效；
> ④ `PLATFORM_SUBSCRIPTION_SOURCE` 缺省为 `platform`，而旧表「无行 = 启用」是 fail-open。
> **工作铁律**：实施中任何方向 / 范围调整，先改本文再动码（架构先行）。

## 0. 一句话

四个缝都按 **fail-closed** 收紧：JIT 只建号不授权；平台专属码从租户管理员的授权宇宙里消失；禁用用户最迟 5 分钟掉会话、PAT / 渠道 C 即时失效；订阅源未配置时默认走 Casdoor。

## 1. 现状与问题（代码取证）

### 1.1 A：JIT 全量授权

- `apps/server/src/routes/auth-wecom.ts:324-345`：企微直连路 + `wecom_auto_signup=true` 时，
  `ensureUser()` 后调 `bindUserToAllPermissions(name)`。
- `packages/auth-core/src/casdoor-client.ts:833-857`：该方法遍历本 org **全部**权限记录，
  把用户追加进 `users[]` —— 包括平台内置码 `tenant:admin` 与敏感码 `data:cost` / `data:precise`。
- 后果：租户一旦打开自动建号，**任何第一次企微扫码的成员直接成为租户管理员**，并拿到成本 / 精确值权限。
  默认 `wecom_auto_signup=false` 只是把风险关在开关后面，不是结构性防护。

### 1.2 B：平台专属码可被租户管理员自授

- 设计意图（`docs/architecture.md:449-453`）：`forms:global-manage`「默认无任何租户角色持有，
  授予 = 平台运营显式动作 ⇒ 一个租户管理员改不到全局字典」。
- 实际实现：
  - 装载器把该码扇出到**每个租户 org**（`apps/server/src/loader.ts:161-175`）；
  - 租户管理员的权限宇宙 = 内置码 + **全部已装载模块码**（`apps/server/src/app.ts:307-316`），
    没有任何过滤；
  - 授权端点只校验「码在宇宙里」+「用户在本 org」（`apps/server/src/routes/admin.ts:151-172`）。
- 后果：任一租户管理员可在权限页把 `forms:global-manage` 授给自己或本 org 用户，然后编辑
  `forms.dict_global_item`。该表**没有 org 列**（`modules/forms/migrations/001_kernel.sql:273-285`），
  是多租户部署下全部署共享的 ⇒ **跨租户写入**。

### 1.3 C：禁用用户不失效

- `packages/auth-core/src/casdoor-client.ts:72-77` 的 `CasdoorUser` 不含 `isForbidden`；
  `getUser()` 也不回传它。
- 会话刷新（`apps/server/src/session-middleware.ts:227-244`）与 PAT 解析
  （`apps/server/src/pat-auth.ts:99-108`）只判「用户是否存在」，不判「是否被禁用」。
- 后果：
  - 已有 `platform_session` 因滑动续期可无限延续（每活跃一天续一次）；
  - PAT v1 永不过期，禁用后仍可一直用；
  - 企微 / 公众号登录路在用户存在时不检查禁用，仍会签发正式会话。
- 现状口径：管理员在 console 点「禁用」只挡住 Casdoor 的**新密码登录**，不是完整的离职处置。

### 1.4 E：订阅源缺省 fail-open

- `.env.example:29`：`PLATFORM_SUBSCRIPTION_SOURCE=platform`；
  `apps/server/src/app.ts:156` 同样是「只有显式 casdoor 才走订阅，否则旧表」。
- 旧表分支（`apps/server/src/loader.ts:430-439`）的语义是「**无行 = 启用**」。
- 后果：新部署 / 私有化交付漏配该变量且 `tenant_module` 为空 ⇒ **所有模块对所有租户默认启用**。
  交付文档已要求「新交付一律 casdoor」，但代码默认值站在开放侧。

## 2. 决策

| # | 决策 | 理由 |
|---|------|------|
| **D1** | **JIT 零授权**：建号成功、能登录，但不挂任何权限码；由管理员按角色 / 部门授权 | 「建号 ≠ 授权」；默认拒绝，授权是显式动作 |
| **D2** | **`manifest.permissions[].platformOnly`**：标记平台专属码；loader 照旧供给到各 org，但**租户管理员的授权宇宙过滤掉它**；授权端点再加一道显式拒绝 | 保留平台运营经 Casdoor 后台授予的合法通路，同时让租户管理员结构上授不了 |
| **D3** | **禁用失效**：`getUser` 暴露 `isForbidden`；PAT / 渠道 C **即时** 401；会话在最迟一次 scopes 刷新（≤5 分钟）清 cookie；企微 / 公众号登录拒绝；**公众号正式态直接拒绝，不降级访客** | 禁用是「账户停用」，不是「绑定悬空」；不给禁用账户留半套能力 |
| **D4** | **订阅源默认 = casdoor**：只有显式 `PLATFORM_SUBSCRIPTION_SOURCE=platform` 才读旧表；未设 / 非法值一律 casdoor | 漏配必须落在关闭侧；旧表仅作回滚 |
| **D5** | **存量只审计、不自动回收**：提供只读脚本列各 org 中持有敏感码的用户；回收由人工确认 | 无法区分「JIT 误授」与「管理员有意授」；自动回收会误伤 |
| **D6** | **一个 umbrella issue + 一个 PR**；文档 / 架构订正先于代码提交 | 四项同属一个权限加固面，评审上下文一致；架构先行 |

## 3. 设计正文

### 3.1 A：JIT 零授权

**改动**：

1. `apps/server/src/routes/auth-wecom.ts` 的 JIT 分支**删除** `bindUserToAllPermissions(name)`：
   ```ts
   await casdoor.ensureUser(name)
   ;[user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
   ```
   随后照常 `effectiveScopes(name, user.roles ?? [], perms)`。新号无角色、也不在任何权限记录的
   `users[]` 里 ⇒ `scopes` 为空。
2. **删除** `CasdoorClient.bindUserToAllPermissions` 及其单测（`casdoor-client.test.ts` 的同名
   describe）。全仓唯一消费方是 JIT；留着一个「一键全挂」的公开方法就是留一把可误用的提权工具。
3. JIT 分支置 `jitCreated = true`，最终 `login.ok` 审计的 `detail` 加 `jit: true`——让「哪些账号是
   自动建出来的」在审计面可查，供 D5 的存量复核使用。

**行为**：JIT 用户登录成功但 console 无任何模块；管理员用「组织架构 / 角色管理」批量授权后，
该用户下次 scopes 刷新（≤5 分钟）或重新登录即可见。

**不做的**：不自动给任何「默认角色」或「基础码」——没有真实需求，且会给新的默认授权面。

### 3.2 B：`platformOnly` 权限码

**协议**：`packages/platform-sdk/src/manifest.ts`

- 接口：`permissions: Array<{ code: string; name: string; platformOnly?: boolean }>`。
- zod：权限条目改为 `z.object({ code: z.string(), name: z.string(), platformOnly: z.boolean().optional() }).strict()`。
  - 内层 `.strict()` 是新加的：拼错字段名（如 `platform_only`）必须**装载失败 / check-manifests 红**，
    不允许 Zod 静默剥离。
- 接口与 schema 的双向断言 `_AssertManifestBidirectional` 继续兜漂移（无需改）。

**声明**：`modules/forms/manifest.yaml` 的 `forms:global-manage` 加 `platformOnly: true`。

**隔离点**：

1. **loader 不变**：`provisionModulePermissions` 仍把 `platformOnly` 码供给到每个租户 org。
   平台运营需要能在 Casdoor 后台把它授给指定账户；码存在不等于租户管理员能授。
2. **admin 权限宇宙过滤**（`apps/server/src/app.ts:307-316`）：
   ```ts
   permissions: () => all.filter((p) => !p.platformOnly)
   platformOnlyPermissions: () => new Set(all.filter((p) => p.platformOnly).map((p) => p.code))
   ```
   `GET /permissions`、角色页的码清单、`POST/DELETE /permissions/:code/{users,roles}` 的
   宇宙校验都因此自动排除它。
3. **显式拒绝（defense in depth）**（`apps/server/src/routes/admin.ts`）：
   `AdminRoutesDeps` 新增可选 `platformOnlyPermissions?: () => ReadonlySet<string>`；
   授权 / 回收端点先查该集合，命中即 `404 { error: 'NO_SUCH_CODE' }`。
   这是对「未来有人改了宇宙注入、忘了过滤」的第二道锁；测试要断言「即使宇宙被误注入，
   显式拒绝仍生效」。

**语义边界**：`platformOnly` 只约束「谁能在**本平台 console** 授予」，不改变端点门卫。
持有该码的用户（由平台运营在 Casdoor 授出）仍然能调用声明了该 scope 的模块端点。

**存量**：审计脚本列出当前持有 `forms:global-manage` 的租户用户；人工确认后回收。
不自动回收——可能是平台运营有意授予的。⚠️ 由于该码已从租户管理员的授权宇宙中过滤，
**存量回收也只能由平台运营在 Casdoor 后台完成**（租户管理员的回收面同样看不到它）；
这一点要写进运维口径，否则会出现「知道该收但界面上收不了」的困惑。

### 3.3 C：禁用用户失效

**形状**：

- `CasdoorUser` 增加 `isForbidden: boolean`（`getUser` 的 `get-user` 真机响应字段）。
- `getUser()` 映射 `isForbidden: u.isForbidden === true`。
- 测试替身照真机收严：mock 的 `get-user` 已经存 / 回 `isForbidden`，只需在客户端映射与
  各消费点断言；新增夹具必须带该字段（AGENTS #11：替身不得比真机宽松）。

**逐通道处置**：

| 通道 / 入口 | 位置 | 处置 | 时效 |
|---|---|---|---|
| 内部会话（账密 / 企微） | `session-middleware.ts` 内部分支 | `user === null \|\| user.isForbidden` ⇒ 清 cookie（与 `userGone` 同处置） | ≤5 分钟（下次 scopes 刷新） |
| 公众号正式态会话 | `session-middleware.ts` 正式态分支 | 同上 | ≤5 分钟 |
| 公众号中间态 | 同上访客分支 | **不变**（不查 Casdoor） | — |
| PAT | `pat-auth.ts` | `isForbidden` ⇒ 401 `USER_DISABLED` | **即时**（每次请求实时解析） |
| 渠道 C | `wecom-channel-auth.ts` | `isForbidden` ⇒ 401 `USER_DISABLED` | **即时**（每次请求实时解析） |
| 企微登录 | `auth-wecom.ts` | `user !== null && isForbidden` ⇒ `login.fail reason=forbidden`，`fail('NO_ACCOUNT')` | 即时 |
| 公众号正式态登录 | `auth-wechat-oa.ts` | `user.isForbidden` ⇒ `login.fail reason=forbidden`，`fail('NO_ACCOUNT')`（**不降级 guest**） | 即时 |
| 账密登录 | `auth.ts` | 防御性检查：`getUser` 为 `isForbidden` ⇒ 401 `BAD_CREDENTIALS`（正常应由 Casdoor `verifyPassword` 先拒） | 即时 |

**关于「不降级 guest」**：公众号正式态指向一个被禁用的账户时，直接拒绝登录，不退化为访客。
理由：`isForbidden` 是账户停用，不是绑定悬空；给访客能力等于「禁用只禁一半」。
若业务上需要「禁用正式身份但保留外部客户访客资格」，这是一个**新的产品决定**，需另开 spec 改成 B 档。

**不清 PAT / 不删会话**：不做额外副作用。PAT 由 `isForbidden` 即时挡；会话由刷新清；
重新启用后，未吊销的 PAT 会恢复可用（禁用是可逆的运营动作）。要永久撤销请显式吊销 key。

**窗口说明**：会话的 5 分钟窗口来自既有的 `SCOPES_TTL_SEC=300`；本次不引入每请求吊销台账
（见 §6）。管理员在 console 禁用后，PAT / 渠道 C 立即失效，浏览器会话最迟 5 分钟失效。

### 3.4 E：订阅源默认 fail-closed

**纯函数**（`apps/server/src/subscription-source.ts`）：

```ts
export function resolveSubscriptionSource(raw: string | undefined): 'platform' | 'casdoor' {
  return raw === 'platform' ? 'platform' : 'casdoor'
}
```

**宿主装配**（`apps/server/src/app.ts`）：

- `subscriptionSource: resolveSubscriptionSource(process.env.PLATFORM_SUBSCRIPTION_SOURCE)`；
- 启动期日志：
  - 未设置 ⇒ `[modules] PLATFORM_SUBSCRIPTION_SOURCE 未设置，默认 casdoor（fail-closed）`；
  - `platform` ⇒ warn「旧表是回滚档，不是生产口径」；
  - 其他非空值 ⇒ warn「未知值，按 casdoor 处理」。
- `loadModules` 的 `subscriptionSource?` 参数**保持可选**：它只服务测试与注入式用法，
  生产唯一调用方是 `app.ts`，永远显式传值。这是有意的边界，不把测试夹具的缺省当生产默认。

**配置模板**：`.env.example` 改为 `PLATFORM_SUBSCRIPTION_SOURCE=casdoor`，注释写明
「未设置 = casdoor；`platform` 仅回滚用」。

**测试替身**（`packages/auth-core/src/test-util/mock-casdoor.ts`）：

- 新增 seed 项 `subscriptions?: Array<{ owner, name, user, plan, startTime, endTime, state }>`；
- 新增 `GET /api/get-subscriptions?owner=<org>`，返回 `{ status:'ok', data: [...] }`（真机形状）；
- `enabledFromSubscriptions` 认的是**裸** `plan=mod-<id>`（不是 `org/mod-<id>`），mock 种子用裸形。

**冒烟**（`scripts/smoke-load.mjs`）：

- 不再注入 `PLATFORM_SUBSCRIPTION_SOURCE` ⇒ 走默认 casdoor；
- mock 为 `acme` / `beta` 各种一条 `mod-demo` Active 订阅（`endTime` 远期）；
- 现有断言不变：acme 全链路通、beta 模块 API 403（授权缺失，不是模块停用）。
  ⚠️ beta 也必须有 Active 订阅，否则启用闸门先回 404，会把「授权缺失」误判成「模块不存在」；
  这正是本项要钉死的测试形状。

### 3.5 存量审计（D5）

新增只读脚本 `scripts/audit-permission-holders.mjs`：

```sh
node scripts/audit-permission-holders.mjs \
  [--org <casdoor_org>] \
  [--code tenant:admin] [--code forms:global-manage] ...
```

- 默认码集：`tenant:admin`、`forms:global-manage`、`data:cost`、`data:precise`；
- 默认遍历 `platform.tenant` 的全部 org；`--org` 收窄；
- 走 `CasdoorClient.getPermissions()`（admin 凭据来自 env），只读打印 `org / code / users[]`；
- **不写任何东西**；输出供人工复核，尤其关注 A 的 JIT 存量与 B 的 global-manage 持有者。

脚本只做取证，不自动回收——自动判断「该不该有」需要业务上下文。

### 3.6 文档同步

| 文档 | 改什么 |
|---|---|
| `docs/architecture.md` §4.2 JIT 行 | 「建号 + 挂全量码后重读成功」⇒「建号 + 重读成功；**不挂任何码**」；补一句「自动建号 ≠ 自动授权」 |
| `docs/architecture.md` §2.4 P4 断言 | 把「租户管理员改不到全局字典」从「默认无角色持有」改为「`platformOnly` + 授权宇宙过滤」的**机制性**表述 |
| `docs/architecture.md` §1.5 | 补「禁用账户」段落：PAT / 渠道 C 即时、会话 ≤5 分钟 |
| `docs/module-protocol.md` | 新增「权限码声明（`permissions[]`）」小节：命名空间、按租户 org 供给、`platformOnly` 语义与执法点 |
| `docs/module-onboarding.md` | 字段参考补 `platformOnly` |
| `.env.example` | `PLATFORM_SUBSCRIPTION_SOURCE=casdoor` + 注释 |
| `deploy/openship-adopt.md`、`deploy/delivery-private.md` | 明确「未设置 = casdoor；`platform` 仅回滚」 |
| `docs/superpowers/specs/2026-09-13-saas-admin-domain-design.md` | **不改**（历史快照纪律）；以本次 spec + architecture 为准 |

`CHANGELOG.md` **不手写**：由 `release.mjs` 从 conventional commits 生成。

## 4. 测试与验收

### 4.1 单元

| 项 | 断言 |
|---|---|
| A | JIT 分支不再调用 `bindUserToAllPermissions`；新号 scopes 为空；`login.ok` 审计带 `jit:true`；`CasdoorClient` 已无该方法 |
| B | manifest 接受 `platformOnly: true`；错误类型 / 未知字段 ⇒ 校验失败；loader 仍向 org 供给该码；admin 宇宙与 `GET /permissions` 不含它；grant/revoke 返回 `NO_SUCH_CODE`；即使宇宙误注入，显式拒绝仍生效 |
| C | mock `get-user` 回 `isForbidden`；内部会话 / 公众号正式态会话被清；PAT / 渠道 C 返回 `USER_DISABLED`；企微 / 公众号登录拒绝；账密路防御性拒绝；**未禁用用户全部照常**；Casdoor 故障仍走既有降级（不被误清） |
| E | `resolveSubscriptionSource`：`platform` → platform；`undefined` / `''` / `'casdoor'` / 垃圾值 → casdoor；loader casdoor 分支：Active 且未过期 ⇒ 启用，Terminated / 过期 / 非 mod- 前缀 ⇒ 不启用 |

### 4.2 冒烟

- 默认（不设 `PLATFORM_SUBSCRIPTION_SOURCE`）⇒ casdoor；acme 全链路通，beta 模块 API 403；
- 显式 `PLATFORM_SUBSCRIPTION_SOURCE=platform` 的旧表路径由 loader 单测覆盖（smoke 不再跑旧表）。

### 4.3 门禁

`pnpm test`、`pnpm typecheck`（含 `scripts/`）、`pnpm smoke`、`gates` 全绿：
`check-manifests` / `lint-architecture` / `check-tenant-isolation` / `check-env-example` /
`check-column-scope-monotonicity` 等。

### 4.4 手工验收（dev-stack）

1. **A**：开 `wecom_auto_signup` 的租户，新企微账号登录 ⇒ console 无模块；管理员授角色 ⇒
   重新登录后模块出现。
2. **B**：租户管理员权限页**看不到** `forms:global-manage`；直接 POST 该码 ⇒ 404；
   Casdoor 后台给某账户授该码 ⇒ 该账户仍可调用全局字典端点。
3. **C**：禁用某用户 ⇒ 其 PAT 立即 401；浏览器会话在 5 分钟内被清；重新登录被拒；
   重新启用后可正常登录。
4. **E**：不设变量启动 ⇒ 日志显示 casdoor 默认；设 `platform` ⇒ 明确 warn。

## 5. 风险与取舍

| 风险 | 处置 |
|---|---|
| JIT 用户登录后空白，运营需批量授权 | 审计脚本 + 文档；角色 / 组织架构页已支持批量授；授权后 ≤5 分钟生效 |
| 租户管理员看不到平台码，误以为系统缺功能 | `platformOnly` 的语义写进 module-protocol / onboarding；平台运营在 Casdoor 授 |
| 会话 5 分钟窗口 | 显式接受；PAT / 渠道 C 即时；要更强需 per-request 吊销台账（§6 不做） |
| E 翻转默认值影响依赖旧默认的部署 | 生产已显式 casdoor；升级说明写明「回滚须显式设 platform」 |
| 权限条目内层 `.strict()` 可能拒绝存量未知字段 | 仓内 manifest 实测只用了 `code` / `name`；这是有意的 fail-fast |
| 删除 `bindUserToAllPermissions` 影响外部脚本 | 全仓 grep 唯一消费方是 JIT；该包为内部包（仅 `apps/server` 引） |
| 存量越权未自动回收 | D5：只读审计 + 人工确认；自动回收无法区分有意授权 |

## 6. 不做（YAGNI）

- **每请求吊销台账**（C 的 5 分钟窗口升级）——没有真实案例要求秒级；真需要时再建表。
- **应用内平台超管身份**（B 的根因，issue #176 的「平台超管 signal」）——本次只堵租户管理员自授，
  平台运营仍走 Casdoor 后台；补平台身份是另一个决定。
- **自动回收存量越权**——会误伤有意授权。
- **PAT 过期 / 轮换**——v1 决策不变。
- **数据面直读通路 / marts org 列**（#174/#175/#176）——另一条线，本次不碰。
- **UI 改版**：权限页只做列表过滤，不加「平台专属」标记或说明（保持租户侧不可见）。

## 7. 变更面清单

| 文件 | 变更 |
|---|---|
| `packages/platform-sdk/src/manifest.ts` | 权限条目加 `platformOnly?`；内层 `.strict()` |
| `modules/forms/manifest.yaml` | `forms:global-manage` 标 `platformOnly: true` |
| `apps/server/src/app.ts` | admin 权限宇宙过滤 + `platformOnlyPermissions` 注入；订阅源解析改 `resolveSubscriptionSource` + 启动日志 |
| `apps/server/src/routes/admin.ts` | `AdminRoutesDeps.platformOnlyPermissions`；grant/revoke 显式拒绝 |
| `apps/server/src/routes/auth-wecom.ts` | 删 `bindUserToAllPermissions`；JIT 零授权；`jit:true` 审计；禁用检查 |
| `packages/auth-core/src/casdoor-client.ts` | `CasdoorUser.isForbidden`；`getUser` 映射；删 `bindUserToAllPermissions` |
| `apps/server/src/session-middleware.ts` | 内部 / 公众号正式态分支检查 `isForbidden` |
| `apps/server/src/pat-auth.ts` | `isForbidden` ⇒ 401 `USER_DISABLED` |
| `apps/server/src/wecom-channel-auth.ts` | 同上 |
| `apps/server/src/routes/auth-wechat-oa.ts` | 正式态 `isForbidden` 拒绝登录 + audit |
| `apps/server/src/routes/auth.ts` | 账密路防御性检查 |
| `apps/server/src/subscription-source.ts` | `resolveSubscriptionSource` 纯函数 |
| `.env.example` | 默认 casdoor |
| `packages/auth-core/src/test-util/mock-casdoor.ts` | 订阅种子 + `get-subscriptions` 端点 |
| `scripts/smoke-load.mjs` | 默认 casdoor；acme / beta 种 `mod-demo` Active 订阅 |
| `scripts/audit-permission-holders.mjs` | 新增（只读） |
| `docs/architecture.md`、`docs/module-protocol.md`、`docs/module-onboarding.md`、`deploy/*.md` | §3.6 |
| 各对应 `*.test.ts` | §4.1 |

## 8. 关联

- issue：随 PR 创建后回填（一个 umbrella issue，四项 checklist）。
- 既有 spec：`2026-09-13-saas-admin-domain-design.md`（D4/D9、订阅）、
  `2026-09-11-multi-tenant-permission-provisioning-design.md`（按 org 扇出）、
  `2026-10-24-shanhai-wecom-directory-and-org-admin-design.md`（角色层 / 组织树）。
- 相关开放 issue：#176（平台超管 signal）、#153（multi 验收）。
- memory：`platform-core-multi-tenant-permission-model`（权限码按 org 分桶）。

## 9. 修订记录

- 2026-10-27：初稿。四项决策经用户确认：A 零授权、B `platformOnly`、C ≤5 分钟窗口
  （公众号正式态直接拒绝）、E 默认 casdoor。
