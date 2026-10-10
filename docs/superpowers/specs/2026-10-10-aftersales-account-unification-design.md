# 售后账户体系统一：混合方案（花名册/权限归 Casdoor，微信绑定归 platform）——设计

> 状态：设计定稿（2026-10-10 brainstorming 收敛，用户认可）。实施分期见 §6。
> 本稿订正的正典条文见 §7；实施前须先落 §7 的正典订正（架构先行）。

## 0. 背景与决策链

### 0.1 触发（2026-10-10 用户定性）

原正典把售后移动端用户定性为**外部客户**（加盟商店员），身份走访客 session、
不建任何账户。本次用户推翻该定性：**门店的人以后也算内部员工的一种，
与总部员工同一个账户体系，区别靠权限做**；企微与公众号都可绑定到同一账户、
识别成一个人；门店现阶段只给公众号登录，进企微后再绑定。

### 0.2 被推翻的拍板（本稿生效后失效）

| 原拍板 | 出处 | 处置 |
|---|---|---|
| 外部用户不进内部 IdP、不建 Casdoor 账号 | aftersales spec §1.3（2026-09-15） | **推翻**：门店员工建 Casdoor user（租户 org 下） |
| 移动端身份 = 访客 session（终态） | aftersales spec §2.5 身份定性（2026-09-16） | **降级为中间态**（见 §3.1）：访客 session 从终态变为「绑定生效前」的过渡态 |
| 「访客身份不落 Casdoor」 | module-protocol.md §175-178 | **改写**：中间态不落 Casdoor（保留），正式态落 Casdoor（新增） |

### 0.3 方案取舍记录（2026-10-10）

| 方案 | 一句话 | 判定 |
|---|---|---|
| A' 全本地 | 账户表也建在 platform，Casdoor 保持纯登录 IdP | 否：权限码体系现成在 Casdoor（按 org 扇出），花名册与权限分裂两地，要么跨系统对表、要么推翻权限架构 |
| B' 全进 Casdoor | 绑定关系也写 Casdoor（User.Wechat 列） | 否：单值列装不下一个账户多 openid；绑定是高频改、要审核界面的数据，远程 API（有三铁律坑）不适合承载 |
| **混合（定案）** | **人是 Casdoor 的人，微信号是 platform 本地的标签** | 花名册+权限（低频、组织化）归 Casdoor；绑定关系（高频、要审核/多绑/改绑）归本地表，两边各取所长 |

调研依据：Casdoor 公众号能力与 User 模型一手调研（WeKnora 条目
`acc6df70-a3f0-4ea6-9027-4cdc0b56e32c`，2026-10-10）。本设计**不依赖** Casdoor
微信 provider（Mobile subtype）——静默授权路继续由宿主自实现，Casdoor 只当
用户/权限库用，因此对自部署 Casdoor 版本无 Mobile 能力要求。

### 0.4 对前期评估的两处订正（留档，防止回潮）

1. 「User.Wechat 单值列多租户硬伤」：在**账户 per-org** 的既有模型下不成立——
   门店员工的 Casdoor user 建在租户 org 下，一个 user 只服务一个租户，单值列够用。
   跨租户身份打通不在需求内（租户隔离是硬约束），本设计也不依赖该列（绑定在本地表）。
2. 「统一后门店登录强依赖 Casdoor 可用性」：内部路已有降级先例
   （session-middleware 查询失败续旧 scopes、仅明确「查无此人」才清会话），门店沿用。

## 1. 身份模型

### 1.1 账户真身 = Casdoor user（per-org）

- 门店员工与总部员工同为一本花名册：Casdoor user。门店员工建在**租户 org** 下
  （与「权限码按租户 org 扇出」的既有账户观一致），姓名/手机号入档。
- 权限区分靠角色：租户 org 下建**门店角色**，挂 `aftersales:guest` 等门店码；
  管理角色照旧挂 `aftersales:manage`。角色/权限的运营入口 = console（平台超管
  直操 Casdoor 后台的 D4 分工不变）。
- 草稿户：自动匹配「未命中」时即建 Casdoor user（无角色、标记草稿态），
  供管理员在审核时「补全绑定/拒绝（删户）」，避免审核通过时才建户的长链路。

### 1.2 绑定关系真身 = platform 本地 `platform.identity_link`

新表（platform schema，宿主所有，模块不直接触碰——B1 纪律不破）：

```
platform.identity_link
  id, org,
  provider        'wechat-oa' | 'wecom'
  external_id     openid / 企微 userid
  casdoor_name    关联的 Casdoor user（org 内唯一名）
  status          pending | active | revoked
  bound_via       auto | manual        （机器自动绑 / 人工确认绑）
  audited         申请 id、decided_by、bound_at、revoked_at、revoked_by …
  unique (provider, org, external_id)   ← 一条微信号/企微号只绑一个账户
  index  (org, casdoor_name)            ← 反查一个账户的全部绑定
```

- **多绑允许**：一个 casdoor_name 下多行 link（工作号+生活号、公众号+企微）。
- Casdoor user 的 `WeChat`/`Wecom` 列**不作为绑定真源**（可留空或写主绑定作展示）。
- 修正能力（审核界面，全本地表操作）：确认自动绑定 / 改绑到另一账户 / 新建 /
  拒绝 / 解绑（revoked，留痕）；换绑冷却期**不做**（YAGNI，留痕已可追责）。

## 2. 供给流程：自动匹配 + 人工修正 + 资格审批（三层）

关键拆分：管理员原一次审批干的「身份匹配」与「资格确认」两件事，前者机械自动化，
后者保留人工。

```
申请提交（公众号注册页）/ 企微首次登录
  ↓ 宿主按强键（手机号）自动匹配 identity_link ∪ Casdoor user
  ├─ 唯一命中 → 自动绑定（bound_via=auto, status=active），即时生效
  │             + userApp 内展示「当前绑定身份 + 异议入口」（不做公众号
  │             模板消息推送——依赖服务号消息权限，新依赖不做）
  ├─ 多命中   → 不自动绑；link pending + 候选清单转人工
  └─ 未命中   → 建草稿 Casdoor user + link pending，转人工
  ↓
人工（压力从「逐条审」降为「看异常」）：
  ① 修正：审核界面逐条显示机器判定建议 → 确认/改绑/新建/拒绝（§1.2）
  ② 资格审批：沿用 employee_approval 语义——「是不是我们门店的人」人工判，
     approved 才有提单资格；一次审批同时完成「员工登记确认 + 账户绑定确立」
```

- **公众号路**（改造最小）：静默授权链**原样保留**（snsapi_base、userApp 401
  整页跳转、零习惯改变）；改动仅在 callback 签 session 前后——openid 先查
  identity_link 分流两态 session（§3.1）。
- **企微路**（语义反转点）：现有「userid = Casdoor name」内部链路保留（查到
  user = 内部员工，照旧）；**查无此人不再是异常**，转门店流程——经通讯录拉取
  姓名/手机号预填申请（可选，自动数据需标识来源）→ 同一套自动匹配。
- 手机号是唯一自动匹配强键（姓名重名不匹配）；匹配前先做存量摸底（§5）。

> **分期注记（2026-10-10，计划期）**：Phase 1 自动匹配置信池 = `identity_link.phone`
> （**本地**，含回填的存量）；Casdoor 侧按手机号查户（覆盖总部员工兼门店场景）归 Phase 2
> ——真机 API 形状未钉（AGENTS #11），不进 P1。

## 3. session 与权限

### 3.1 两态 session（访客 session 语义保留为中间态）

| 态 | 触发 | sub | scopes | 校验路径 |
|---|---|---|---|---|
| 中间态 | openid 未绑/绑定 pending | openid（现状不变） | guest 声明机制（现状不变，仅申请相关端点） | 现状 guest 旁路（不查 Casdoor）不变 |
| 正式态 | openid 有 active link | openid（不变） | Casdoor effectiveScopes（门店角色） | 内部 session 同构 + §3.3 降级 |

- 正式态签发时把该账户**全部 active 绑定的 external_id 集合**注入 identity
  （模块据此做「我的工单」等多绑收窄，§4.3）；集合随 scopes 刷新机制同步刷新。
- 隐含结论（写进正典防回潮）：**「统一账户」≠「消灭访客 session」**——异步审批
  必然产生 openid 先于账户的中间态，双态并存是设计，不是没改干净。

> **修订（2026-10-10，计划期）：正式态 sub 仍 = openid**，账户身份经**新增载荷字段
> `acct`**（= casdoor_name）承载，`name` = casdoor_name。原「sub = casdoor_name 与内部
> session 同构」作废。理由：业务表身份锚是 openid（渠道事实），sub 若换成 casdoor_name，
> 全部 guest 写路径（submitter_openid = identity.userId 共 9 端点）都要改从新字段取登录
> openid，还要为「哪个 openid 登录的」再引入一个字段——同构收益只惠及展示，代价横贯写面。
> 中间态/正式态判定键 = `authVia==='wechat-oa' && acct 存在`。

### 3.2 scopes 双轨的边界

- 中间态 = manifest `guest:{scope}` 声明机制（既有协议字段保留）；
  正式态 = Casdoor 角色/权限码（门店角色挂 `aftersales:guest`）。
- 模块端点与门卫**零改动**（两轨发放同一批码，声明即授权语义不变）。

### 3.3 可用性

正式态校验沿用内部路降级：Casdoor 查询失败 → 续旧 scopes 不重签；
仅「明确查无此人」清会话。建户/绑定类**写操作**不降级（fail-loudly，排队重试）。

## 4. 数据模型与迁移

### 4.1 模块侧消费点变化

- 中间态端点零改动（identity.userId 仍 = openid）。
- 正式态「我的工单」等收窄查询：`submitter_openid = identity.userId`（单 openid）
  改为 `submitter_openid ∈ identity.绑定 external_id 集合`——涉及
  ticket-guest / registration-guest / attachment 的全部 guest 面读写点
  （**含 spec 之外的 `/guest/settlement-orders`**，实施期以路由注册表为准全量扫）。
- 业务表 openid 锚**不回填**（openid 继续是渠道事实），存量查询靠 §4.2 回填的
  link 表展开集合。

### 4.2 存量迁移（一次性）

1. 存量 approved 员工（aftersales.employee）→ 批量建 Casdoor user（租户 org）；
2. 存量 openid（employee.open_id ∪ ticket.submitter_openid ∪ 附件 uploader）→
   回填 identity_link（bound_via=manual，status=active）；
3. 手机号空/重复/冲突行**不自动绑**，导清单转人工（与资格审批同队列）。
- 与 #151（M2b 迁移+孤儿附件 GC）的排序：本设计迁移在 M2b **之前**独立成批，
  不混入（失败面隔离）。

### 4.3 迁移纪律

幂等（可重跑）；批量建户走 Casdoor API 需限速 + 失败清单 + 续跑；
每批写后回读验目标状态（Casdoor 三铁律：update 带 `?id=`、回读验）。

## 5. 落地前置（Phase 1 开工前）

1. **存量手机号质量摸底**：`aftersales.employee.phone` 空/重复/格式异常率——
   一次只读盘点，结果决定自动匹配置信度基线与人工兜底量级；
2. **企微通讯录手机号读取权限**：现有三参自建应用能否读成员手机号
   （敏感字段可能需额外授权）；不可读则企微侧自动匹配降级为「转人工」；
3. Casdoor 建户/查户 API 批量行为实测（ensureUser 已有封装，验重复名/限速）。

## 6. 分期

| 期 | 内容 |
|---|---|
| **Phase 1** | identity_link 表 + 正典订正（§7）+ 公众号路两态 session + 自动匹配 + 审核界面扩展（搜人比对/确认/改绑/解绑）+ 存量迁移 + 通知与异议 |
| **Phase 2** | 企微绑定：分流、通讯录预填、企微首次登录走同一套匹配 |
| **Phase 3**（按需） | 自助解绑/换绑、换绑冷却期、绑定运营报表 |

## 7. 对正典的订正清单（实施第一步，架构先行）

1. `docs/superpowers/specs/2026-09-15-aftersales-module-design.md` §1.3/§2.5：
   身份章节按本稿重写，原两条拍板标注被本稿取代（保留原文加删除线或指针）；
2. `docs/module-protocol.md` §175-178：`guest:{scope}` 条文补「中间态专用」限定，
   正式态身份路径指向本稿；
3. 代码内「账户唯一真源是 Casdoor」类注释（auth.ts:9-10 等）随 Phase 1 订正为
   「员工花名册+权限真源 = Casdoor；微信/企微绑定关系真源 = platform.identity_link」；
4. `docs/architecture.md` 若有身份/账户相关不变量，同步订正（实施期核对，不虚改）。

## 8. 明确不做（YAGNI）

- 跨租户身份打通（同一自然人在多租户 = 多个独立账户）；
- Casdoor 微信 provider 登录路（Mobile subtype 不启用，静默路自实现保留）；
- Casdoor user `WeChat`/`Wecom` 列作绑定真源；
- 换绑冷却期、自助解绑（Phase 3 按需）；
- unionid 打通公众号与企微身份（依赖开放平台同主体认证，本设计用手机号强键替代）。
