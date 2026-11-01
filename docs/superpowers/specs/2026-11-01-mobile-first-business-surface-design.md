# 业务面移动优先 + 资产级配置（设计）

> **状态：待用户 review（2026-11-01 起草）。** 按架构先行，review 通过后开 issue 分期实施。
> 触发：用户提出「凡是涉及业务的都在移动端操作，页面与交互向移动倾斜；个人权限下的配置
> （如我创建的报表允许谁看、推给谁、推什么）也放移动端；现在只在企微内，后续钉钉/飞书」。

## 0. 一句话

把「**配置 vs 业务**」的载体划分，改成按**爆炸半径**划分：平台级/租户级授权留在 PC，
**资产级配置**（我自己的报表/推送归谁看）与**业务执行**以移动端为主；
每个业务功能**只做一个端**，不做双实现；IM 入口留 adapter 扩展位，本期只实现企微。

## 1. 现状与证据（2026-11-01 核对）

| # | 事实 | 出处 | 对设想的影响 |
|---|---|---|---|
| 1 | PC 是单壳 React，模块 console 目录**按 `scope` 过滤** | `apps/web` + `frontend.console[].scope` | PC 侧权限过滤 ✅ 可直接复用 |
| 2 | 移动端是**每模块独立站点**（Vue+TDesign），`frontend.userApp: {mount,dist}` | `modules/aftersales/manifest.yaml` | 没有统一入口；**没有按人过滤**（只有租户级启用闸门） |
| 3 | `data.reports` 只有 `required_scope` / `required_depts`，**没有 owner** | `modules/data/migrations/002_reports.sql` | 「我创建的报表我来配」**今天做不到**：任何持 `data:manage` 的人都能改任意报表的门 |
| 4 | 资产创建/改门用的是**模块码**，不是资产级授权 | `modules/data/routes/reports.ts` | 需要新增「资产级授权」这一判定维度 |
| 5 | 推送原语已齐：`recipient`(dept/literal/scope_holders) × `template` × `channels` | `modules/notify` + `platform-permission` skill | 移动端只需**表单壳**，不新造推送系统 |
| 6 | 登录链路写死在 `auth-wecom`（`/qr` `/silent` `/callback`，含 `next` 深链） | `apps/server/src/routes/auth-wecom.ts` | 接钉钉/飞书会复制一套登录逻辑 ⇒ 需要 adapter |
| 7 | 门卫在宿主、按 manifest 声明施加 | `module-protocol.md` | **移动化只换壳，不换权限模型** ✅ 最大便宜 |

## 2. 决策（用户 2026-11-01 拍板）

| # | 决策 |
|---|---|
| D1 | **资产级授权**：`owner` 可改自己的资产；持有模块管理码者（如 `data:manage`）可改全部，且**留审计** |
| D2 | **端的选择按功能定，不按端定**：需要在 PC 操作的业务保留 PC 页面；其余适合移动的**只做移动端**；同一功能**不做双实现** |
| D3 | **IM 留扩展位**：先把「容器能力」抽成 adapter 契约，本期只实现企微；钉钉/飞书接入时只加一个 adapter + 入口配置，不复制登录逻辑 |

## 3. 判定表：什么放哪个端

| 层 | 例子 | 载体 | 判据 |
|---|---|---|---|
| 平台级 | SSO 配置、通道密钥、模块启停、订阅 | **PC only** | 一次误操作波及全租户/全人 |
| 租户级授权 | 权限码→角色→人、租户通道 | **PC**（移动只读看状态） | 授权本身是权力，不该在手机上随手做 |
| **资产级配置** | 我建的报表谁能看、推给谁、推什么 | **移动 ✅**（管理员的批量操作可在 PC） | 影响面限于自己的资产 |
| 业务执行 | 工单、员工登记、审批 | **移动**（PC 保留个别「大屏/批量」场景） | 高频、现场、需拍照扫码 |

**新增功能的强制动作**：在 spec/PR 里显式写一行 `surface: pc | mobile`。
写 `both` 必须给理由（如「批量录入」），否则评审拒——这是 D2 的落地方式。

## 4. 资产级授权（本期核心新增）

### 4.1 数据模型

```sql
-- 例：data.reports（其余资产域照此模式）
alter table data.reports add column if not exists owner text;   -- Casdoor name；NULL = 迁移前的历史行（未知）
```

- **不强制回填**：历史行 `owner IS NULL` = 来源未知；**不猜测**（与 `org_membership.source` 同款口径）。
- 新建资产必须写 `owner = identity.userId`；缺 owner 的新行 = 缺陷。

### 4.2 判定（单一实现，PC/移动共用）

```
canEditAsset(row, requester):
  requester.hasScope('<模块>:manage')  ⇒ true（并记录 audit: byAdmin=true）
  row.owner === requester.userId        ⇒ true
  否则 ⇒ false
```

**判停**：
- 这个函数**只能有一份**（放模块 domain 层），PC 路由与移动路由都调它——两处各写一遍 =
  迟早出现「PC 能改、移动改不了」的分叉（对照 #1179 的教训）。
- 管理员改他人资产**必须留审计**（谁、哪条、从什么改成什么）。
- owner 判定用 **Casdoor 用户名**（与权限码同源），不引第二套身份。

### 4.3 与现有门的关系

- **资产级授权管「谁能改这条资产的配置」**；`required_scope` / `required_depts` 管「**谁能看到这条资产的内容**」。
- 两者**正交**，都要过：改门的人（owner/管理员）与看内容的人（scope/部门）是两件事。
- 报表的「谁能看」配置项 = 现有 `required_scope` + `required_depts`（部门门原语），
  **不新增**；移动端只提供表单。

## 5. 移动端形态

### 5.1 入口：IM 工作台应用（本期不建统一壳）

- 每个「业务版块」在企微工作台配一个应用，主页填**静默登录深链**：
  `/api/platform/auth/wecom/silent?next=<版块首页>`（#1047 深链已支持）。
- **可见范围 ⊆ 持有对应权限码的人**——交付清单必须同时配两处；只配一边的症状：
  点进去 403 / 工作台看不到。
- 暂不做统一移动壳（YAGNI）：入口由 IM 工作台承担。若将来版块数膨胀，再评估「一应用 + 入口页」。

### 5.2 协议扩展（为入口与交付清单）

`frontend.userApp` 增加可选字段：

```yaml
frontend:
  userApp:
    mount: /app/aftersales
    dist: ./mobile/dist
    scope: aftersales:manage        # 新增：入口可见所需权限码（宿主在 /api/platform/config 里按人过滤）
    title: 售后管理                 # 新增：工作台应用名 / 交付清单用
```

- 宿主读面按 session scopes 过滤 `userApp` 条目 ⇒ 「这个人在工作台该看到哪些应用」有单一事实源。
- 停用闸门不变（已登录 + 停用 ⇒ 404 与 API 同形）。

### 5.3 前端栈收敛（D2 的配套）

- 新的业务页面**统一 React**（复用 `apps/web` 组件与 `@platform/sdk/web`），不新开 Vue 子包。
- `modules/aftersales/mobile`（Vue）按「不动就不动」原则保留，**不再扩展**；下次大改时评估并入 React。
- 理由：同一功能 React(PC)+Vue(mobile) 双实现 = 「移动优先」变成维护成本翻倍。

## 6. IM adapter 契约（留空间，本期只实现企微）

```ts
export interface ImChannelAdapter {
  id: 'wecom' | 'dingtalk' | 'feishu'
  /** 工作台静默登录地址（容器内打开即免登） */
  buildSilentLoginUrl(input: { corpId: string; agentId?: string; redirectUri: string; state: string }): string
  /** 用容器给的 code 换用户身份 */
  exchangeCode(input: { code: string; redirectUri: string }): Promise<{ externalUserId: string }>
  /** 可选的「工作台应用」注册说明（交付清单用） */
  entryHint?(): { homepagePattern: string }
}
```

- `auth-wecom` 的三条路由改造成「读 adapter」——**行为不变**（`/qr` `/silent` `/callback` 的
  参数、state cookie、`next` 深链语义逐字保持）。
- 新增 IM = 新 adapter + 路由注册 + `.env.example` 键 + 交付清单条目，**不新增一套登录中间件**。
- 本期**只实现 `wecom`**；`dingtalk` / `feishu` 留类型占位（编译期不出现，避免空壳）。

## 7. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | 本 spec review | 用户签字 |
| P1 | 资产所有权：`owner` 列 + `canEditAsset` 单一实现 + 审计 + 移动端报表配置页 | ① 我建的报表我能配；② 别人的报表我能看不能改（403 并说明原因）；③ 管理员能改且 audit 记 `byAdmin` |
| P2 | 协议 `userApp.scope/title` + `/api/platform/config` 按人过滤 + 交付清单口径 | 无码用户在工作台看不到该应用；有码用户可见 |
| P3 | IM adapter 抽取（行为不变，企微回归测试全绿） | 企微登录/深链/审计三条回归不变 |
| P4 | （按需）统一移动壳 / 第二 IM | 另立 spec |

## 8. 不做（YAGNI）

- 不做统一移动壳 / 跨模块「我的待办」（等版块数与真实诉求说话）
- 不做 PC 与移动双实现（D2）
- 不在移动端做平台级/租户级授权（§3 判定表）
- 不为资产级授权新造权限码体系（复用 `:manage` + owner）
- 历史资产不强制回填 owner（来源未知是诚实状态）

## 9. 影响面清单

| 面 | 文件 | 改动 |
|---|---|---|
| 迁移 | `modules/data/migrations/0xx_report_owner.sql`（新增） | `owner` 列 |
| 判定 | `modules/data/domain/asset-auth.ts`（新增） | `canEditAsset` 单一实现 |
| 路由 | `modules/data/routes/reports.ts` | 创建写 owner；改门/删走 `canEditAsset` + 审计 |
| 协议 | `docs/module-protocol.md`、`frontend.userApp` schema 校验 | `scope` / `title` |
| 宿主 | `apps/server/src/routes/config.ts`（启停清单读面） | 按 scopes 过滤 userApp |
| 登录 | `apps/server/src/routes/auth-wecom.ts` + `packages/auth-core` | 抽 adapter（行为不变） |
| 移动 | `modules/data/mobile/`（新增）或复用 console 页面组件 | 报表配置页 |
| 文档 | `platform-permission` skill | 增「资产级授权」判别条 |
