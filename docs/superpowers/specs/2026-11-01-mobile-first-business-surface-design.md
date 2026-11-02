# 业务面移动优先 + 资产级配置（设计）

> **状态：待用户 review（2026-11-01 起草）。** 按架构先行，review 通过后开 issue 分期实施。
> 触发：用户提出「凡是涉及业务的都在移动端操作，页面与交互向移动倾斜；个人权限下的配置
> （如我创建的报表允许谁看、推给谁、推什么）也放移动端；现在只在企微内，后续钉钉/飞书」。

## 0. 一句话

把「**配置 vs 业务**」的载体划分，改成按**爆炸半径**划分：平台级/租户级授权留在 PC，
**资产级配置**（我自己的报表/推送归谁看）与**业务执行**以移动端为主；
每个业务功能**只做一个端**，不做双实现；IM 入口留 adapter 扩展位，本期只实现企微。
资产授权用 **ACL（owner + 点名/部门/权限码三类受让方）** 表达，**用户自建内容默认私有**。

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
| D4 | **资产可见性用 ACL 表达**：`owner` + `viewer`（受让方 = 用户/部门/权限码三类），不把「哪些人」压成单一 scope 字符串 |
| D5 | **用户自建内容默认私有**（`visibility='restricted'`）；历史资产保持 `tenant` 语义不变，不回填、不改已有可见性 |

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

### 4.1 数据模型：ACL，而不是一列 owner

```sql
-- 资产本体（例：data.reports）
alter table data.reports
  add column if not exists visibility text not null default 'tenant';  -- 'tenant' | 'restricted'

-- 资产 ACL：谁能看 / 谁是所有者
create table if not exists data.asset_acl (
  org          text not null,
  asset_id     text not null,
  subject_type text not null check (subject_type in ('user','dept','scope')),
  subject_id   text not null,          -- user = Casdoor 用户名；dept = org_node.ext_id；scope = 权限码
  relation     text not null check (relation in ('owner','viewer')),
  granted_by   text not null,
  granted_at   timestamptz not null default now(),
  primary key (org, asset_id, subject_type, subject_id, relation)
);
```

**为什么是 ACL 而不是 `owner` 单列**（业界对照 Google Drive / GitHub / Notion）：
「我建的报表**允许哪些人**看」天然有三种受让方——**点名的人、部门、权限码**。
一列 owner 无法表达"点名共享"，日后必然再迁一次；ACL 三种都在模型里。

**为什么 `visibility` 与 ACL 并存**（而非二选一）：
`visibility` 决定**默认可见面**，ACL 决定**例外**：
- `tenant`（历史资产默认，**行为零变化**）：沿用现有 `required_scope` / `required_depts` 粗门
- `restricted`（**新建资产默认**）：只有 owner + `viewer` 行里的人可见

### 4.2 判定（两件事分开，各自单一实现）

```
canViewAsset(row, requester, acl):
  acl 有 (user, requester) owner|viewer            ⇒ true
  acl 有 (dept, requester 的部门闭包内) viewer       ⇒ true
  acl 有 (scope, requester.hasScope) viewer         ⇒ true
  row.visibility === 'tenant'                      ⇒ 旧粗门（required_scope/depts，NULL=全模块可见）
  否则                                              ⇒ false      ← restricted 默认不公开

canEditAsset(row, requester, acl):
  acl 有 (user, requester) owner                    ⇒ true
  requester.hasScope('<模块>:manage')               ⇒ true（**审计 byAdmin=true**）
  否则                                               ⇒ false
```

**判停**：
- `canViewAsset` 与 `canEditAsset` **各只有一份实现**（模块 domain 层），PC/移动、列表/详情、
  导出/嵌入 URL **全部走它**——两处各写一遍就是 #1179 的翻版（同一规则两个入口结论不同）。
- **`canEditAsset` 不看 `viewer`**：被点名可看 ≠ 可改配置。
- 管理员改他人资产**必须留审计**（who / 哪条 / 改了什么 / `byAdmin`）。
- owner 判定用 **Casdoor 用户名**（与权限码同源），不引第二套身份。

### 4.3 默认私有 + 历史兼容

| 资产 | visibility | 谁能看 |
|---|---|---|
| 新建（本期起） | `restricted` | owner + 显式 ACL；**开箱只有自己** |
| 历史（`owner IS NULL`） | `tenant` | 行为与今天逐字一致（不猜测、不回填） |

**为什么翻默认值**：业界对「用户自建内容」一律 private-until-shared（Drive/Notion/GitHub 私有库）；
今天的 `required_scope IS NULL ⇒ 全模块可见` 是 **public by default**，与"我的报表"的直觉相反。
历史资产**保持 public** 是刻意的：翻默认值不应改变已有数据的可见性。

### 4.4 所有者生命周期（补业界必备项）

- **转移**：owner 可把自己资产转给他人（写 ACL + 审计）；管理员可代转。
- **离职/停用**：owner 不再活跃时资产不自动消失——管理员可接管（已有 `:manage`），
  控制台列出「无活跃所有者的资产」供清理。**不做自动转移**（谁接管是需要人判断的事）。

### 4.5 与「推送给谁」的关系

- 推送收件人继续用 `notify` 的 `recipient`（dept / literal / scope_holders）——**不并入 asset_acl**：
  一个是"看这条资产"，一个是"收这类通知"，语义与生命周期都不同。
- 移动端只提供表单壳；**不做第二套推送配置存储**。

## 5. 移动端形态

### 5.1 入口：**1 个应用 + 1 个入口页**（不给每个版块建应用）

- 每个租户在 IM 工作台配 **一个**「业务工作台」应用，主页填静默登录深链
  `/api/platform/auth/wecom/silent?next=/m`（#1047 深链已支持）。
- `/m` = **入口页**：按当前用户 scopes 列出可用版块（读 `/api/platform/config` 的按人过滤结果）。
  它只是「一屏卡片」，不是完整应用壳——**这是壳的最小形态，也是唯一必需形态**。
- **为什么不是每版块一个应用**（用户最初设想的兜底做法）：应用数 = 版块数 × 租户数，
  是乘法成本；且**IM 应用的可见范围会变成第二套权限源**（谁在工作台看得到 ≠ 谁有权限码），
  两处必然漂移。一个应用 + 一个入口页把「入口可见性」收敛到平台自己的 scopes 上。
- 交付清单只配一次/租户：应用名、主页 URL、可见范围（= 该租户全部业务用户）。

> 若某天出现「需要独立图标」的真实诉求（如不同部门要固定不同入口），再评估拆应用；
> 那是运营选择，不是架构前提。

### 5.2 协议扩展（入口与交付清单的唯一事实源）

`frontend.userApp` 增加可选字段：

```yaml
frontend:
  userApp:
    mount: /app/aftersales
    dist: ./mobile/dist
    scope: aftersales:manage        # 新增：进入该版块所需权限码
    title: 售后管理                 # 新增：入口页卡片名 / 交付清单用
    icon: ToolOutlined              # 新增（可选）
```

- 宿主读面（`/api/platform/config`）按 session scopes 过滤 `userApp` 条目 ⇒
  「这个人该看到哪些版块」**只有一个事实源**。
- 匿名请求仍只拿租户级启用清单（不泄露按人信息——现有匿名口径不变）。
- 停用闸门不变（已登录 + 停用 ⇒ 404 与 API 同形）。

### 5.3 前端栈：**复用逻辑，不复用 UI**

- 新的业务页面统一 **React**；但**不直接复用 `apps/web` 的 antd 桌面组件**——
  桌面组件搬上手机 = "缩小版桌面"。移动端用移动组件库（antd-mobile / TDesign 其一，实施时定）。
- 复用的是 **`@platform/sdk/web`、领域逻辑与类型**，不是组件。
- `modules/aftersales/mobile`（Vue）按「不动就不动」保留，**不再扩展**；大改时评估并入 React。
- 理由（D2 的实施口径）：双实现是「移动优先」最大的隐性成本；桌面 UI 复用是第二大的。

### 5.4 移动专属动作的 PC 只读兜底

- **写**只在一个端（D2 不变）；**读**两端都开（同一 API、同一 `canViewAsset`）。
- 理由：客服/支持场景要在 PC 查状态；只读兜底不违反"不做双实现"。

## 6. 渠道契约：入站登录与出站发送是同一个「渠道」（留空间，本期只实现企微）

今天平台有**两套各自描述"企微"的东西**：出站 = `notify` 的 provider 表
（`wecom_chat`/`in_app`/`webhook`）；入站 = `auth-wecom` 路由里写死。加钉钉/飞书时
会出现两个 registry 同时描述同一渠道且各自漂移。

**契约（一层概念，两个能力）**：

```ts
export interface ImChannel {
  id: 'wecom' | 'dingtalk' | 'feishu'
  /** 入站：工作台静默登录（容器内打开即免登） */
  auth: {
    buildSilentLoginUrl(input: { corpId: string; agentId?: string; redirectUri: string; state: string }): string
    exchangeCode(input: { code: string; redirectUri: string }): Promise<{ externalUserId: string }>
    entryHint(): { homepagePattern: string }   // 交付清单：应用主页该填什么
  }
  /** 出站：委托给 notify 的 provider（不重复实现发送） */
  send: { provider: 'wecom_chat' | 'dingtalk_chat' | 'feishu_chat' }
}
```

- `auth-wecom` 的三条路由改造为「读 `ImChannel.auth`」——**行为逐字不变**
  （`/qr` `/silent` `/callback` 的参数、state cookie、`next` 深链语义保持）。
- 新增 IM = 新 `ImChannel` + 一个 provider + `.env.example` 键 + 交付清单条目；
  **不新增一套登录中间件，也不新增一套发送实现**。
- 本期**只实现 `wecom`**；`dingtalk`/`feishu` 只出现在类型联合里（不建空壳文件）。
- 出站侧的多渠道设计已存在（spec 2026-10-31），本条只是把**入站**并入同一个概念。

## 7. 分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **P0** | 本 spec review | 用户签字 |
| P1 | 资产授权：`visibility` + `data.asset_acl` + `canViewAsset`/`canEditAsset` 单一实现 + 审计 + 移动端报表配置页 | ① 新建报表**默认只有自己能看**；② 点名/部门/权限码三种共享都生效；③ 别人的报表可看不可改（403 说明原因）；④ 管理员可改且 audit 记 `byAdmin`；⑤ 历史资产可见性**零变化** |
| P2 | 协议 `userApp.scope/title/icon` + `/api/platform/config` 按人过滤 + `/m` 入口页 + 交付清单口径 | 无码用户在入口页看不到该版块；有码用户可见；匿名仍只拿租户级清单 |
| P3 | IM adapter 抽取（行为不变，企微回归测试全绿） | 企微登录/深链/审计三条回归不变 |
| P4 | 所有者转移/接管（§4.4）+ `surface` 机检（manifest `surfaces` + check-manifests） | 转移留审计；`surfaces: both` 缺理由则门禁红 |
| P5 | （按需）第二 IM / 完整移动壳 | 另立 spec |

## 8. 不做（YAGNI）

- 不做统一移动壳 / 跨模块「我的待办」（等版块数与真实诉求说话）
- 不做 PC 与移动双实现（D2）
- 不在移动端做平台级/租户级授权（§3 判定表）
- 不为资产级授权新造权限码体系（复用 `:manage` + owner）
- 历史资产不强制回填 owner / 不改其可见性（来源未知是诚实状态）
- 不把推送收件人并入 `asset_acl`（看资产 ≠ 收通知，生命周期不同）
- 不自动转移离职者的资产（谁接管是需要人判断的事）

## 9. 影响面清单

| 面 | 文件 | 改动 |
|---|---|---|
| 迁移 | `modules/data/migrations/0xx_asset_acl.sql`（新增） | `visibility` 列 + `data.asset_acl` 表 |
| 判定 | `modules/data/domain/asset-auth.ts`（新增） | `canViewAsset` / `canEditAsset` 单一实现 |
| 路由 | `modules/data/routes/reports.ts` | 创建写 owner ACL + `visibility='restricted'`；读写全走两判定 + 审计 |
| 协议 | `docs/module-protocol.md`、manifest schema | `userApp.scope/title/icon`；`surfaces`（P4） |
| 宿主 | `apps/server/src/routes/config.ts` | 已登录时按 scopes 过滤 `userApp`；匿名口径不变 |
| 入口页 | `apps/web` 或独立静态页 `/m` | 按 scopes 列版块卡片 |
| 登录 | `apps/server/src/routes/auth-wecom.ts` + `packages/auth-core` | 抽 `ImChannel.auth`（行为不变） |
| 移动 | 报表配置页（React + 移动组件库） | 共享/推送表单 |
| 文档 | `platform-permission` skill | 增「资产级授权（ACL）」条；判据表加 `canView`/`canEdit` |

## 10. 追加（2026-11-02）：移动端指标页（L1+L2）

> 用户追加需求：再增加一个页面展示**所有指标**（含 L1/L2），但**只能管理自己创建的指标**。

### 10.1 与现有模型的对齐

| 事实 | 出处 | 对设计的影响 |
|---|---|---|
| 指标行带 `source ∈ {l1, l2}`；**L1 由 dbt YAML 物化写入，管理 API 只读**；L2 走唯一编译点（结构化声明，拒收自由 SQL） | `003_metrics_source.sql` 头注 + 全局约束 12 | 「管理自己创建的」**只适用于 L2**；L1 是平台口径，移动端**只读展示**，管理按钮不出现 |
| `data.metrics` **没有 `created_by`/owner 列** | 迁移清单核对 | L2「谁创建的」无从判断 ⇒ 需补 `created_by`（迁移 027），新建时写 `identity.userId`；存量行为 NULL（诚实状态，不猜） |
| 查看侧已有 `required_scope` / `required_depts` / 值级掩码，全部按请求者算 | 现有授权核心 | **"数据范围跟随查看者"已天然满足**，移动化零改动 |

### 10.2 判定（复用报表同款口径，单一实现）

- **L1**：只读卡片（名称/口径/新鲜度/来源=平台声明）；管理入口不出现
- **L2 且 `created_by = 我`**：可编辑（走唯一编译点重新声明，**仍然拒收自由 SQL**）
- **L2 且非我创建**：只读
- 「所有指标」= 本租户全量（L1+L2），**查看**沿用现有 `required_scope` 门——指标列表本身已按此裁剪

### 10.3 红线（继承 + 新增）

- L1 管理 API 只读的纪律**不因移动端改变**（全局约束 12：定义面禁自由 SQL，唯一编译点不变）
- `created_by` 只是**展示与归属**，不构成新的授权维度——授权仍是 `required_scope` + 掩码
- 移动端与 PC 共用同一套指标 API 与编译点；**不做双实现**

### 10.4 治理层（2026-11-02 追加，分析师评审后补）

业界（dbt Semantic Layer / Looker / Cube / PowerBI endorsed metrics）与"自建指标列表"的分水岭
不在展示，在**治理**。分析师评审找出 5 个缺口，按 P0/P1/P2 分层：

| 缺口 | 影响 | 层 |
|---|---|---|
| L2 编辑无发布语义：creator 改一处，全租户看数人的数字跟着变，无版本/diff/通知 | 静默改口径，无人知晓 | **P0** |
| 无可信度分级：L1 平台口径与 L2 自建并存，用户不知道信哪个 | 两个相近指标谁权威无从判断 | **P0** |
| 新鲜度未露出：用户拿上周数据当实时做决策 | 移动端最需要"数据截至 X 时" | **P0** |
| 无使用统计：指标蔓延，没人敢下线 | 治理闭环缺一半 | P1 |
| L2 孤儿 + 元数据薄 | creator 离职即孤儿 | P1 |

#### 10.4.1 用户拍板（2026-11-02）

| # | 决策 |
|---|---|
| D6 | **L2 变更走「草稿 → 确认 → 生效」**（不做即时生效）：creator 编辑产生草稿，确认后经唯一编译点编译生效；生效**必发通知**给该指标的 viewer（复用 notify：`metric.definition.changed` 事件，收件人 = 当前 `viewer` 受让方 + `required_scope` 持有者） |
| D7 | **可信度分级**：L1 恒 `certified`（平台口径自动）；L2 默认 `draft`，**管理员审核后升 `certified`**（先手动标，审核工作流出现真实诉求再自动化） |

#### 10.4.2 P0 落地清单

| 项 | 落点 |
|---|---|
| L2 草稿/生效 | `data.metrics` 增 `draft_spec jsonb`（草稿）与 `certified text`（certified/draft）；编译点只吃 `spec`（生效列），确认 = 草稿 → spec + 事件 |
| 变更通知 | 确认生效时 enqueue `metric.definition.changed`（viewer = ACL viewer + required_scope 持有者） |
| 新鲜度徽标 | 移动卡片读 `017` 的新鲜度列 + SLA 木桶：绿（SLA 内）/黄（超期）/红（断流）；**不进 SLA 判据**（展示层） |
| certified 字段 | L1 恒 certified（读侧从 `source='l1'` 推导）；L2 默认 draft，管理员可升 |

#### 10.4.3 P1/P2 登记（本期不做）

- 使用统计读面：`query_audit` 按 metricId 聚合（谁、多久一次、最近一次）
- L2 下线流程：使用统计为 0 + N 天 ⇒ 候选下线清单
- 元数据：业务描述 / 单位 / 口径说明字段
