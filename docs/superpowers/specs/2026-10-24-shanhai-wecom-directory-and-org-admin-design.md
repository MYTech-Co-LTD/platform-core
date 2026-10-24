# 山海企微通讯录同步 + console 组织架构与角色管理后台：设计

> 本文是「山海企微通讯录同步到 Casdoor + platform-core console 自建组织管理后台」的**规划稿**（spec）。
> **状态：设计已定稿（2026-10-24 brainstorming 收敛，用户逐段确认）；实施未开工。**
> 工作铁律：实施中任何方向/范围调整，先改本文再动码。

## 0. 背景与决策链

触发链：「在 Casdoor 上把山海的企微通讯录同步也做了，然后自建后台，显示完整的企微组织架构，并配置角色和权限」
→ 查得 mytech 租户已实证同款通路（WeKnora「Casdoor 企微通讯录同步落地全案」，条目 `919ae8e9-52b8-4553-9ae4-7983f3891d82`，2026-10-18）
→ 逐段确认四个决策点（后台归属 / 角色层语义 / 存量对账 / 同步节奏）+ 组织架构数据通路选型 → 本文。

## 1. 现状核实（2026-10-24 源码与 WeKnora 核对）

### 1.1 Casdoor 侧

- `sso.hookflow.cn`（机 113.249.101.33，不在控制面）已升级官方 latest（mytech 同步作业时完成），
  **内建 WeCom Syncer**；mytech 租户已跑通：用户同步 + 组织树落在 Casdoor group 树（1 顶级 + N 部门）。
- mytech 全案关键教训（本文直接继承，见 §3.3）：
  `userid→Name + isKey:true`（撞键根因=无 isKey 时 fallback 取第一列）；`is_read_only=true`
  （关掉会把本地户反向创建进企微通讯录）；corpid 放 syncer 的 user 字段；**通讯录同步助手
  secret 才能拉全量通讯录**（自建应用 secret 权限面不同）；run-syncer 新镜像是 POST。
- 该 Casdoor 是**多业务共享生产库**：6 组织（含山海一果，数百用户）、9 应用、600+ 用户。
  一切写动作按全案彩排法 + 回滚三件套执行。

### 1.2 platform-core 侧

- M3 租户管理员页已在（`apps/web/src/pages/admin/`）：Users / Permissions（码↔用户直挂）/
  Subscriptions / Keys / Storage；后端代理 Casdoor Admin API **锁本租户 org**（SaaS 管理域 spec D4）。
- `CasdoorClient`（`packages/auth-core/src/casdoor-client.ts`）现有方法覆盖
  用户 CRUD / 权限码 upsert+授权（码↔用户直挂）/ 订阅 / org / 锚用户——**无 group、无 Role 方法**。
- 售后账户统一（2026-10-10 spec，Phase 1 已交付）：**人归 Casdoor、绑定归本地 `identity_link`**；
  门店员工存量户**按 openid 命名**（`scripts/backfill-identity-links.mjs:242` `ensureUser(openId)`，
  Casdoor 用户名限字母数字），手机号在 `identity_link.phone`。山海 org 的数百存量用户即来源于此。
- session scopes 计算链路（session-middleware → Casdoor effectiveScopes）当前只覆盖
  「用户∈权限 users[]」直挂语义；**「用户∈角色→角色∈权限」继承是否自动生效未实测**（§3.4 命门项）。

## 2. 决策

- **D1 后台归属 = platform-core console，M3 管理页组扩展**（用户拍板 A）：
  山海租户管理员是第一个真实用户，功能全租户通用；后端代理 Casdoor 锁 org，越界即拒。
  不建独立后台（C 否），不靠 Casdoor 原生后台（B 否——角色/权限只有进自建后台租户管理员才能自助运营）。
- **D2 引入角色层 = Casdoor Role（org 内）**（用户拍板 A）：租户管理员建角色 → 挂权限码 →
  给用户授角色。数百人规模下逐人挂码不可运营，角色批量授是必需。码↔用户直挂口径保留（叠加非替换）。
  部门级默认角色（角色挂部门自动继承）不做（YAGNI，§5）。
- **D3 存量对账 = 摸底先行，数据定策略**（用户拍板 A）：企微通讯录清单与 `identity_link` 存量
  按手机号比对；交集 ≈ 0 → 直接同步无对账；交集显著 → 重叠自然人走 `identity_link` 绑定归一
  （一个自然人一账户、公众号+企微多绑定——售后统一设计既有模型）+ 禁用同步器建的重复户。
  同步器按「企微 userid = 本地用户名」对齐，与山海存量 openid 命名**永不相交**，重叠者必成一人两户，
  这是摸底存在的理由。
- **D4 同步节奏 = 手动触发先行**（用户拍板 A）：syncer 建好保持 disabled，走
  「摸底 → 副本彩排 → 手动首次真同步 → 验收 → 观察期」，跑稳后再议定时。mytech 同款纪律，
  两租户口径一致；console「同步」按钮不做（§5）。
- **D5 组织架构数据通路 = Casdoor 权威源，console 纯代理读**（用户拍板方案 1）：
  syncer 把用户+group 树写进 Casdoor；console 经宿主代理读，**无本地表**。
  「人归 Casdoor」延伸为「组织树也归 Casdoor」，真源唯一。本地镜像（方案 2）与宿主直连企微
  API（方案 3）否决：第二真源/漂移/凭据负担/与花名册权限两张皮。

## 3. 设计正文

### 3.1 分期

| 期 | 内容 | 性质 |
|---|---|---|
| Phase 0 | 通讯录 vs identity_link 存量摸底（一次性只读） | 运维作业 |
| Phase 1 | syncer 配置 + 副本彩排 + 手动首次真同步 + 验收（含对账，按 D3 数据） | 运维作业（Casdoor 机 SSH，授权留档） |
| Phase 2 | console 组织架构页 + 角色管理页 + 后端代理 | 开发作业（issue → PR → CI → merge） |

两线衔接：Phase 2 真机验收用 Phase 1 的真实数据做基线，故顺序执行。

### 3.2 前置条件（Phase 0 开工前，用户去落实）

山海企微管理员提供：**corpid + 通讯录同步助手 secret**（安全基线：只记「在哪、怎么取」，不写明文）
+ **可信 IP 白名单放行 Casdoor 机（113.249.101.33）出口 IP**。摸底与同步都依赖此 secret。

### 3.3 Phase 0/1：同步侧（踩 mytech 全案）

**摸底（Phase 0）**：`scripts/` 一次性只读脚本，拉山海企微通讯录全量（部门树 + 成员
userid/姓名/手机号）与山海 org 存量用户 + `identity_link` 存量按手机号比对，输出交集数字。
手机号若企微侧不可读（敏感字段）→ 记录并降级姓名匹配（弱键，重名不自动判，转人工清单）。
顺带确认：山海租户 org 在 Casdoor 的真名（实施时从 `platform.tenant.casdoor_org` 读取，不硬编码）。

**syncer 配置（Phase 1）**：`type=wecom`，organization=山海 org；corpid 放 user 字段；
secret=通讯录同步助手的；`table_columns` 照 mytech 模板（**userid→Name + isKey:true**）；
**`is_read_only=true` 铁律**；建好后 disabled，手动 run-syncer（POST）。

**彩排与执行**：T0 备份（pg_dump 双份）→ 临时网络隔离 + 副本 postgres + conf 副本 →
副本上真同步全绿（撞键零、组织树形状正确、存量权限零丢失）→ 才动生产。
**共享库硬验收：其他 5 org 零影响**（全库总用户增量 = 山海净增数）。

**对账步骤（若 D3 摸底交集显著）**：同步后跑对账脚本（`scripts/`，写操作默认 dry-run、
`--apply` 才生效，同 `backfill-identity-links.mjs` 模式）——重叠自然人（手机号命中）给存量
openid 账户加 `identity_link(provider='wecom', external_id=企微userid, casdoor_name=存量名,
status=active, bound_via=manual)`，并禁用同步器建的重复户（isForbidden）。手动重跑同步
只 add/update、不翻转 forbidden 的行为**在彩排时实测钉死**；不成立则对账脚本每次同步后补跑。
交集 ≈ 0 则本步骤整体跳过。

**不依赖自动删除**：企微侧删人，平台户不自动消失——离职 = 管理员在 console/Casdoor 后台
手动禁用（与 M3 用户管理页衔接）。

### 3.4 Phase 2：console 后端

**开工前置实测**（真机形状钉死才写码；mock 收严到真机形状——AGENTS #11）：
group API 形状（Group 对象 owner/name/parentId、按 org 拉取端点）；Role 对象形状
（users[]/permissions[]、增删成员调用）；Permission 对象 roles 字段（角色挂码 = 往权限
roles[] 写角色名）；**effectiveScopes 链路**——「用户∈角色→角色∈权限」是否自动计入 session
scopes。这是角色层能否生效的**命门项**：Casdoor 原生继承生效则零改动；不生效则读侧
展开角色成员（兜底方案已定，实现处 = session-middleware scopes 计算）。

**CasdoorClient 扩展**（`packages/auth-core`，全走既有 adminRequest，形状按实测修正）：
`listGroups(org)`（树由后端按 parentId 组装，孤儿节点挂根并标记，不丢人）、
`listRoles / upsertRole / deleteRole`（delete 走 JSON body 铁律）、
`setRoleMembers(role, users)`（整组替换 + `?id=` + 回读）、
`grantPermissionToRole(code, role)`。

**admin 路由**（`routes/admin.ts` 扩展，`tenant:admin` 门禁——内置码不进 manifest，既有口径）：

```
GET  /api/platform/admin/org-tree              # group 树 + 各节点人数
GET  /api/platform/admin/org-tree/members      # ?group=<name> 节点成员
GET/POST /api/platform/admin/roles             # 列表/建角色
DELETE   /api/platform/admin/roles/:name       # 删角色
PUT      /api/platform/admin/roles/:name/members      # 角色↔用户（整组替换）
PUT      /api/platform/admin/permissions/:code/roles  # 码↔角色
```

- 所有端点从 session 取 org、Casdoor 调用强制 owner=本租户（越界即拒，D4 纪律）；
- 写操作走既有 adminWrite csrf 通道；每次写后回读验证（三铁律）；
- 锚用户 `tenantsub` 在成员列表继续过滤（M3 既有行为延伸）。

### 3.5 Phase 2：console 前端

- **组织架构**（`pages/admin/OrgTree.tsx`）：左 antd Tree（部门树）+ 右 Table（选中节点成员：
  姓名/账号/状态/角色 tags）；行操作 = 授角色/收角色（弹窗多选）；顶部按姓名/账号搜索。
  成员表含**禁用状态列**（同步不删人，离职户可见可辨，§3.3）。
- **角色管理**（`pages/admin/Roles.tsx`）：角色列表（成员数/挂码数）+ 建角色 + 编辑
  （成员管理 + 权限码勾选，码清单沿用 Permissions 页数据源）。
- **现有五页全部保留不动**：组织架构是同一批人的部门视图（增量），Permissions 页仍是
  码↔用户直挂面，角色页是新增批量授权面。「管理」菜单组加两项，`tenant:admin` 门禁不变。
- 规模口径：山海数百用户，后端一次 listUsers+listGroups 组装树和成员索引，前端全量渲染，
  不做分页/虚拟滚动（真机慢了再优化）。

## 4. 验收

**单测**：mock-casdoor 扩展新方法（形状收严到真机实测结果）；路由测试覆盖锁 org 越界 403 /
`tenant:admin` 门禁 / 写后回读；树组装单测含孤儿节点挂根。

**同步侧真机验收（Phase 1）**：副本彩排全绿（撞键零、组织树形状正确、存量权限零丢失、
tenantsub 未动）；生产真同步后山海 org 用户数与企微通讯录对上（± 对账判定数）、组织树与
企微部门逐节点一致、**其他 5 org 零影响**、**is_read_only 生效证据 = 企微通讯录人数不变**。

**console 真机验收（Phase 2）**：租户管理员见两个新页、无 `tenant:admin` 者不可见（回归）；
角色往返真机验证（建角色 → 挂码 → 授人 → 该用户刷新 session 后菜单出现 → 收角色 → 消失，
这是 effectiveScopes 的最终判定）；UI 亲自浏览器走通（dev-stack 配方）；**山海生产部署走
手工更版 webhook 链路**（山海不在自动部署通路），部署后线上复验。

**知识沉淀**：同步完成后**更新** WeKnora「Casdoor 企微通讯录同步落地全案」**原条目**
（查重已命中，不新建）：补山海案例、对账方法、effectiveScopes 结论。

## 5. 明确不做（YAGNI）

部门级默认角色 ｜ console「同步」按钮 ｜ 定时同步（跑稳后另议）｜ 企微登录路打通 identity_link
绑定账户（售后统一设计 Phase 2 范围）｜ 跨租户身份打通 ｜ 组织树本地镜像/缓存表 ｜
同步自动删除离职户 ｜ 组织架构页分页/虚拟滚动优化 ｜ console「我的订阅」页等其他 M3 遗留项。

## 6. 风险与已知边界

1. **effectiveScopes 角色继承未实测**——命门项；不自动继承则读侧展开（兜底已定，§3.4）。
2. 企微手机号若拉不到 → 对账降级姓名匹配（弱键，重名转人工）。
3. 共享生产库：全部动作按彩排法 + 回滚三件套（旧镜像在盘 + compose 备份 + DB 双备份）；
   Casdoor 机 SSH 作业**再次留档授权**（根本法则第 1 条例外，先例 mytech 全案）。
4. 同步器不删人：组织架构页状态列区分禁用户；企微侧与平台花名册的长期一致性靠人工纪律。
5. 山海生产实例非自动部署：console 功能上线要手动触发山海更版（webhook 链路）。
6. 存量 openid 命名户与企微同步户在 Casdoor 用户列表并存的观感问题：摸底后若决定绑定归一，
   重复户禁用但保留（不可直接删——identity_link 与业务表引用链未清理前删户即断链）。

## 7. 与既有 spec 的关系（不破坏项）

- SaaS 管理域 spec：D4 双层管理不变——本设计是 M3 的**扩展**（组织视图 + 角色层叠加）；
  §6.7「码↔用户直挂」口径保留；平台超管仍在 Casdoor 后台运营。
- 售后账户统一设计：人归 Casdoor / 绑定归 `identity_link` 模型不破坏；对账复用 identity_link；
  企微登录整合留给其 Phase 2。
- 权限码按租户 org 分桶模型不变（loader 扇出机制零改动）。

## 8. 关联

- WeKnora：`919ae8e9-52b8-4553-9ae4-7983f3891d82`（Casdoor 企微通讯录同步落地全案——同步侧作业手册）。
- 本仓 spec：`2026-09-13-saas-admin-domain-design.md`（D4/M3）、
  `2026-10-10-aftersales-account-unification-design.md`（identity_link/人归 Casdoor）。
- 会话记忆：`shanhai-manual-deploy-webhook`（山海手工更版）、`casdoor-wechat-oa-mobile-subtype`（企微登录多租户硬伤背景）。
