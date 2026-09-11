# 设计：multi 形态的模块权限供给（M1 闭债 R1）

> 来源：GitHub issue #3「M1 立项：平台底座 M0 终审遗留债」第一、二节。
> 状态：设计已获批（2026-09-11），待写实现计划。
> 轮次名：R1（闭债轮）。**本轮不碰**工单模块化。

## 0. 一句话

权限码是**平台级能力**，但 Casdoor 的权限记录**按 org 存储**（`owner=` 形参）。当前**写侧只往一个 org 写、读侧按租户 org 读**，两侧不同源 ⇒ 除 `PLATFORM_ORG` 所指租户外，其余租户 `effectiveScopes` 恒空 ⇒ 模块 API 全体 403，而宿主全绿。

## 1. 现状取证（读代码得到的事实）

### 1.1 写侧：只落一个 org，且 multi 下整条路径被跳过

- `apps/server/src/app.ts:94` —— `casdoor: config.platformOrg ? casdoorFactory(config.platformOrg) : undefined`
- `apps/server/src/config.ts:27` —— `platformOrg` 注释已写明「single 模式 = 唯一租户的 casdoor org；**multi 模式恒为空串**」。
  ⇒ `app.ts` 把 `PLATFORM_ORG` 当 multi 的供给 org 用，**违背了 config.ts 自己文档化的意图**。
- `scripts/smoke-load.mjs:568` —— multi 子进程传 `PLATFORM_ORG: ''` ⇒ `casdoor: undefined` ⇒
  `loader.ts:108-113` 走 warn 分支，**权限 upsert 全程零调用**。

### 1.2 读侧：按租户自己的 org

- `apps/server/src/session-middleware.ts:109` —— `deps.casdoor(p.org)`，`p.org` = `tenant.casdoor_org`
- `apps/server/src/routes/auth.ts`、`auth-wecom.ts` —— 同款 `casdoorFactory(tenant.casdoor_org)`

### 1.3 租户 org 互不相同

- `apps/server/src/seed.ts:18-36` —— demo 租户 acme(`casdoorOrg: 'acme'`) 与 beta(`casdoorOrg: 'beta'`)。

⇒ 除 `PLATFORM_ORG` 所指租户外，租户的 `getPermissions(owner=<自己的 org>)` 返回空集，
`effectiveScopes` 恒空，`requireScope` 全体 403。

### 1.4 权限模型本身的约束（为什么不能用「集中式权限」）

`CasdoorPermission.users` 是**用户名列表**（`packages/auth-core/src/casdoor-client.ts:36-39`）。
用户驻留在各自 org，用户名**只在 org 内唯一**。若所有租户共用平台 org 的权限记录，
`acme/zhang` 与 `beta/zhang` 在该列表里重名冲突，无法区分。且租户管理员将无法自治授权。

**故本设计采用「每租户各建一套权限码」**：权限记录归属租户自己的 org，与用户同域。

## 2. 目标与非目标

### 目标

1. multi 形态下，**每个租户**在自己的 Casdoor org 内都拥有全部已装载模块的权限码。
2. 写侧与读侧**同源**：都以 `platform.tenant.casdoor_org` 为准，不再依赖 `PLATFORM_ORG`。
3. 门禁不再对上述故障**结构性失明**：新增的冒烟断言在修复前必须失败（见 §5.4）。

### 非目标（本轮不做）

- 工单模块化（M1 主线，另立计划）
- 真机验证（需 `sso.hookflow.cn`，issue 第三节）
- issue 第四节其余延后设计题（登录限速、branding 语义、`/healthz` vs `/readyz`、`getPermissions` 翻页）
- issue 第五节工程 Minor
- **撤销 issue 里「`TENANT_MODE=multi` 按非生产可用对待」那句警告** —— 保留到做过一次真实 multi 生产演练之后

## 3. 设计

### 3.1 写侧：装载器按租户 org 遍历供给

**接口变更**（`apps/server/src/loader.ts`）：

```ts
export interface LoadModulesDeps {
  pool: Pool
  /** 按 org 返回 CasdoorClient 的工厂（宿主传 casdoorFactory，按 org 缓存实例）。
   *  缺省 → 权限供给 warn 跳过（保留「只登录不管理」的部署形态） */
  casdoorFor?: (org: string) => CasdoorClient
}
```

装载器内部：

1. 查 `select casdoor_org from platform.tenant`（**权威租户清单来自 DB，不是 env**）。
2. 对每个租户 org、每条 `manifest.permissions`，调 `upsertPermission(code, name)`。
3. 组织方式：外层遍历 org、内层遍历 permission —— 与 Casdoor 的 (owner, code) 二维键对齐，
   也让每个 org 的 `get-permissions` 查重只拉一次。

**抽成可复用函数并导出**：

```ts
export async function provisionModulePermissions(
  pool: Pool,
  casdoorFor: (org: string) => CasdoorClient,
  permissions: ReadonlyArray<{ code: string; name: string }>,
): Promise<void>
```

装载器与未来的**租户创建入口**共用它。本轮**不造**租户创建 API（范围外），
函数导出即是为它留的唯一接口，避免「新增租户只能靠重启」变成死路。

### 3.2 启动次序修正（必须与本轮一并修）

现状 `app.ts`：② `loadModules` → ③ `seedDemo`。

改成从 DB 取租户 org 后，**全新库上装载时 `platform.tenant` 是空的** ⇒ 一个权限码都建不出来，
要等下次重启才供给。这是本设计**引入**的缺陷，必须同时消除。

**新次序**：`runMigrations(platform)` → `seedDemo` → `loadModules`

安全性论证：`apps/server/src/migrations/001_platform.sql:26-31` 的 `platform.tenant_module`
只有 `tenant_id int not null references platform.tenant(id)`，**`module_id` 是裸 `text not null`、
无外键**（模块是磁盘装载，DB 里没有模块表）。故 `seedDemo` **不依赖**装载器已运行，重排安全。

### 3.3 宿主装配（`app.ts`）

```ts
// 旧：casdoor: config.platformOrg ? casdoorFactory(config.platformOrg) : undefined
// 新：直接把工厂交给装载器，由它按 DB 里的租户 org 逐个供给
runtime = await loadModules(modulesDir, { pool, casdoorFor: casdoorFactory })
```

`PLATFORM_ORG` 的作用域收窄为**仅 single 模式的租户解析**（`tenant.ts:44-53`），
与 `config.ts:27` 的既有注释一致。

同时**保留**多租户下的可观测性：当凭据缺失而跳过供给时，warn 必须点明「哪些租户因此没有权限码」，
不能只留一句泛泛的跳过日志（今天的 warn 就说不清后果）。

### 3.4 空集与失败语义

| 情形 | 行为 |
|---|---|
| `platform.tenant` 零行 | 不供给、不崩（正常分支：全新库尚未 seed） |
| `casdoorFor` 缺省 | warn 列出受影响的租户 org，跳过供给 |
| 某租户 org 的 upsert 抛错 | 原样上抛 ⇒ 宿主启动 fail-fast（与 `single` 今日行为同构） |

### 3.5 运维面变化（⚠ 用户已确认接受；**方向经复评反转，见下方更正**）

**multi 模式从此也在启动期连 Casdoor。** 此前 multi 完全跳过 upsert、启动期不碰 Casdoor。

- ~~`CASDOOR_ADMIN_USER` / `_PWD` **缺** ⇒ warn + 跳过供给（**保住今天 multi 的启动行为**）~~
- 凭据**在** ⇒ 真供给；Casdoor 不可达 ⇒ **fail-fast 起不来**

**更正（R2 复评后，用户裁决）**：上面那条被划掉的写法援引了一个**不存在的前提**——
「未配凭据时服务可启动，只是各租户用户 403，属于『只登录不管理』的合法形态」。实际是
**缺凭据时没有任何人能拿到会话**：登录签发前必调 `getUser` + `getPermissions`，两者都走
admin 会话（`routes/auth.ts`）⇒ 登录一律 502，模块 API 根本到不了。

**故 `CASDOOR_ADMIN_USER` / `_PWD` 改为 config 层必填、启动期 fail-fast。** 理由：缺凭据的
实例起得来也 100% 无用，让它启动只会制造"healthz 绿而无事可用"的假绿——正是本仓已在防的
模式（对照「静态托管静默降级 ⇒ 页面白屏但 `/healthz` 照绿」）。`config.ts` 里
「管理端点凭据…可空——纯登录场景不需要」那句错话（本 spec 之前就存在）一并更正。

后果：共享 SSO 抖动不再只影响 single 客户，multi 的生产容器也会跟着反复重启
（`restart: unless-stopped` 下）。这与 `single` 的既有取舍同构，但是**多租户部署的新失败面**。

文档同步（`deploy/openship-adopt.md`）：

- `:128` —— 「`multi` 时 … 且**跳过**启动期权限 upsert」已不成立，改写为「按各租户 org 逐个供给」
- `:133` —— 原写「**只有** upsertPermission（模块权限码）用它」，更正为"登录也要它"
- `:216`（已知陷阱 2）—— 适用条件从「`single` + `PLATFORM_ORG` 非空时」扩展为**两种模式**，
  并写明凭据缺失在配置装配阶段就报错

## 4. 冒烟失明（issue 第二节三条成因，逐条对治）

### 4.1 成因 ①：`get-permissions` 忽略 `owner=`

`packages/auth-core/src/test-util/mock-casdoor.ts:253-257` 自陈「mock 单 org，忽略具体值」。

**改法**：权限**按 org 分桶存储**。`get-permissions?owner=X` 只回 X 的权限；
`add-permission` 取载荷 `owner` 归桶；`update-permission` 按 **(owner, name)** 二元组定位
（今天只按 `name` 找，跨 org 会同名互撞）。`MOCK_ORG` 常量退化为「登录应答里的 org 字面量」，
不再代表「唯一的权限桶」。

### 4.2 成因 ②：预种权限 ⇒ `add-permission` 零调用

`scripts/smoke-load.mjs:533-536` 把 `p-demo-view` / `p-demo-note`（且 `users: [ADMIN1]`）
预种进 mock ⇒ 装载器 `upsertPermission` 的查重**必命中** ⇒ 走 update 分支；
admin1 的授权也**从不经过装载器**。

**改法**：**撤掉全部预种**。改为冒烟在子进程引导完成**之后**，以**租户管理员身份走 HTTP**
（`POST /api/login` 取 admin 会话 cookie → `POST /api/update-permission`）给 **acme 这一个 org**
把 `demo:view` / `demo:note` 授予 admin1。

这不是自造夹具：**这正是真实租户管理员的路径** —— 装载器负责**建码**，租户管理员负责**授权**。
两者分开断言，才让「装载器真跑过」这件事可见。

### 4.3 成因 ③：`runMulti` 从不驱动 beta

`scripts/smoke-load.mjs:405-477` 只驱动 `acme.test` 与未知 host。

**改法**：驱动 `beta.test`，断言 beta 租户下 admin1 的模块 API **403** ——
装载器在 beta 的 org 里建了码（可查证），但 **beta 没给 admin1 授权** ⇒ 403 是**授权在拦**，
不是路由不存在。这就是 issue 所说的「其余租户恒 403」的可执行形态。

### 4.4 回归锁：诱饵 `PLATFORM_ORG`

multi 子进程的 `PLATFORM_ORG` 设为**诱饵值**（不指向任何租户 org，如 `NOT-ACME-ORG`），
断言全链路**仍通过**。

**这条断言能排除什么，必须说准**（初稿把它的效力写大了，复评指出后收敛）：`platformOrg` 的
全部消费点只有 `tenant.ts` 的 single 分支、`app.ts` 的中间件入参与 single boot 探针，供给侧
已纯 DB 驱动、**根本不经过任何读取分支**。所以它排除的是**一件具体的事**：供给 org 退回
`config.platformOrg`（修复前 `app.ts` 的形状）。这条绊线是活的——`config.ts` 并未在 multi 下
强制清空该值，诱饵确实能到达 `config.platformOrg`。

它**不能**排除：① 供给 org 取 `platform.tenant` 里的任意单条（那是 beta 那条断言的活）；
② 任何读侧问题。且对 env 回退这一种形状，beta 断言同样会红 ⇒ 两者冗余，诱饵只赢在更早、
更直指原因。**别把它当「写读同源」的完整证明**——同源由「beta 码存在」+「beta scopes 缺失」
两条合起来证：若供给仍依赖 `PLATFORM_ORG`，beta 的码就不会存在，而 beta-403 会与「码不存在
也 403」**无法区分**；故 beta 侧必须同时断言「码**存在**」而「授权**不存在**」。

## 5. 验收判据

### 5.1 单元测试

- `apps/server/src/loader.test.ts`
  - 两租户 ⇒ **两个 org 各收到**全部权限码
  - 零租户 ⇒ 不调用、不抛错
  - `casdoorFor` 缺省 ⇒ warn 跳过、不抛错
- `packages/auth-core/src/test-util/mock-casdoor.test.ts`（或既有测试文件内）
  - **★ 负例**：`get-permissions?owner=acme` **不回** beta 桶的权限码
  - `update-permission` 按 (owner, name) 定位：跨 org 同名互不影响

### 5.2 集成（冒烟）

`scripts/smoke-load.mjs` 双形态：

- multi：acme 全链路通过（装载器建码 + 管理员授权 ⇒ ping 200 / notes 可达）
- multi：**beta 403**，且 beta 的码**存在**（授权缺失，非码缺失）
- multi：`add-permission` **真的被调用**（mock 暴露调用记录供断言）
- multi：诱饵 `PLATFORM_ORG=NOT-ACME-ORG` 下全链路仍通过
- single：行为**不变**（同一代码路径，租户表恰好一行）

### 5.3 门禁

`pnpm test`（含 `test:guard`）、`pnpm typecheck`、四个守卫脚本（`check-manifests` /
`lint-architecture` / `check-compose` / `check-env-example`）全绿。
冒烟需 Docker：**执行前需启动 Docker daemon**（本轮开始时代理未运行，PG 相关 50 条测试处于 skip）。

### 5.4 判据的元要求

**新断言必须在修复前失败。** 落实现时先加断言、跑一遍看它红，再改实现。
一条「修完才第一次运行」的断言等于没有验证过它测的是不是那个 bug ——
这正是本 issue 第二条（门禁结构性失明）的教训本身。

## 6. 风险与取舍

| 风险 | 处置 |
|---|---|
| multi 启动期新增 Casdoor 依赖 | 已确认接受；凭据缺失时不新增硬依赖（§3.5） |
| 供给时机只有启动期，新增租户需重启 | 已确认接受；抽出 `provisionModulePermissions` 供未来租户创建入口调用（§3.1） |
| `seedDemo` 与 `loadModules` 重排引入新故障 | 无外键依赖（§3.2 论证）；冒烟双形态覆盖该次序 |
| mock 改按 org 分桶后，既有测试大面积变红 | 预期内：这正是「mock 单 org」假设的显影。逐条核对红的是否都是**该红的** |
| `getPermissions` 的 `pageSize=100` 无翻页（issue 第四节） | 本轮不动；权限码数量远超 100 时另行扩面 |

## 7. 变更面清单

| 文件 | 变更 |
|---|---|
| `apps/server/src/loader.ts` | `casdoorFor` 工厂 + 按租户 org 遍历 + 导出 `provisionModulePermissions` |
| `apps/server/src/app.ts` | 传 `casdoorFactory`；**重排 seed 与 loadModules 次序**；warn 说清后果 |
| `apps/server/src/loader.test.ts` | 三组新用例（§5.1） |
| `packages/auth-core/src/test-util/mock-casdoor.ts` | 权限按 org 分桶；`owner=` 生效；(owner,name) 定位 |
| `packages/auth-core/src/**/*.test.ts` | mock 分桶的新用例 |
| `scripts/smoke-load.mjs` | 撤预种；HTTP 管理员授权；驱动 beta；诱饵 `PLATFORM_ORG`；断言 `add-permission` 被调 |
| `deploy/openship-adopt.md` | §3.5 的两处文档同步 |
| `CHANGELOG.md` | 【修复】条目（公司纪律：可见变更必须行内标注） |
| 根 `.env.example` | 若 `PLATFORM_ORG` 注释需随作用域收窄调整，一并改（`check-env-example` 守卫约束键全集） |
