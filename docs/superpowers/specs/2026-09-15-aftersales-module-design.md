# platform-core 第一个真业务模块：售后域（wuji 迁移）：设计

> 本文是「售后管理从无极平台（wuji）迁入 platform-core 作第一个 L1 业务模块」的**规划稿**。
> **状态：设计定稿（2026-09-15 brainstorming 四问 + 三节逐节确认），未落实施。**
> 工作铁律：实施中任何方向/范围调整，先改本文再动码。

## 0. 背景与决策链

### 0.1 源系统事实（2026-08-30 pi 会话完整分析，本节为自足摘要）

源 = `wuji-1`（PC 管理端 ~2.3 万行）+ `wuji-2`（移动端 H5 ~1 万行），无极低代码平台上的
Vue 3 + TS + TDesign 项目，山海一果业务，双端共用一套库（21 个数据源表）。两大版块：
**售后管理**（规则/工单提交/处理/审批）+ **商品接龙**（批次/点单/购物车/订单）。

分析的黄金结论——**平台耦合度极低**：3.3 万行代码对无极的依赖只有 3 包 7 方法
（`@wujibase/wuji-data` 的 DBObject 统一 DSL：query×122/update×57/delete×29/create×26/
count×17/getById×3；`@wujibase/wuji` 的 Message/Confirm/getCurrentUser 等运行时工具；
`@wujibase/wuji-upload`），无编译期魔法——整包代码可原样搬进标准 Vite 工程。
已知隐患（迁移时根治，不带走）：移动端重复提交靠 300ms 防抖、无后端事务、老数据二义
（工单 `product_name` 存 ID 或名称、`store_selection` 存门店 ID 或名称）。

原分析的迁移目标是 data-analysis；本 spec 改落 **platform-core**（作第一个 L1 模块，
随 spec-3 试点在客户机交付）。落点差异已在决策时摆明：无 PostgREST/RLS/主数据对齐红利，
console 是 React（Vue 只能走 userApp），换取模块协议 + 统一管理台 + spec-3 交付链。

### 0.2 brainstorming 四问（2026-09-15）

1. **PC 管理端归宿：React 重写进 console**（统一管理台卖点，~2.3 万行 UI 重写，逻辑复用）。
2. **首发域：售后先行**（流程简单风险低；接龙实时业务——购物车并发/库存锁/cron——二期立项）。
3. **移动端身份：保留微信 openid**（店员零习惯改变；auth-core 新增公众号静默授权路）。
4. **存量数据：全量迁移**（工单/规则/员工/门店/商品/订单档案表 + open_id 锚）；
   **附件存量不搬运**（历史引用保持 COS 原值原地，新附件全走 ZOS）。

方案取舍：**A（域 API + 定制 shim）**选定——后端写正经 REST API，wuji-2 的 shim 手工映射
DBObject DSL → 域 API；否决 B（通用数据网关）——表级粗粒度权限违背平台细粒度声明哲学，
通用网关自身成为新协议面，省几百行 shim 抵不上。

### 0.3 「迁移即重构」原则（用户拍板，2026-09-15 补）

无极平台可改的只有前端——原项目大量逻辑是「前端直调数据源、无数据库事务」的多步编排
（逐条 await 链、前端算金额、全量拉取+前端过滤、前端防抖扛并发）。**迁移不是翻译这些
模式，是按标准开发范式重构**：

- **前端多步编排 ⇒ 收敛为后端单端点 + 数据库事务**；shim 只映射「旧调用面 → 新 API」，
  不保留旧的无事务语义（shim 是兼容入口，不是问题搬运器）。
- **服务端权威计算**：金额（按规则比例/固定额）一律服务端算并落库；前端传来的金额只作
  展示参考，**永不信任**。
- 全量拉取 15000 条 + 前端过滤 + 分批并发限流（wuji-1 模式）⇒ 服务端分页/过滤/聚合。
- 标准范式配套：输入校验 zod、错误码规范、状态机/金额计算/幂等**必须有单测**（wuji 零
  测试，目标平台测试门禁 testing.md C1–C7 照走）。

## 1. 模块拓扑、主数据归属、身份

### 1.1 拓扑

```
modules/aftersales            ← 售后域模块（通用产品模块，不带客户前缀——多客户复用）
  ├─ manifest.yaml             ← id: aftersales（=DB schema =API 前缀，三同纪律）
  ├─ index.ts                  ← 域 API（§2）
  ├─ console/                  ← React 管理端（重写 wuji-1 售后部分，§3.1）
  ├─ mobile/                   ← wuji-2 Vue 原样迁 + shim（frontend.userApp 声明）
  └─ migrations/               ← 售后域表
接龙 modules/groupbuying       ← 二期另行立项（本 spec 只留边界）
```

### 1.2 主数据归属

门店/商品/员工/区域等双版块共用表：**试点期放 `aftersales` schema，按「可搬迁」纪律设计**
——通用资源名（`/stores /products /employees`）、表不掺售后语义；接龙立项时**有真实第二
消费者了**再决定是否抽独立档案模块（YAGNI；现在抽是过早抽象）。

### 1.3 身份（两类用户，2026-09-15 用户订正：移动端是外部客户，非内部员工）

- **内部员工**（PC console / 企微内）= Casdoor 现成路（password / wecom），不动。
- **外部客户**（移动 H5，面向公众）= **新增 `wechat-oa` 访客登录路**：公众号静默授权
  （snsapi_base）→ code 换 openid → 签**访客 session**（sub = openid、org = 租户、
  scopes = `['aftersales:guest']`，按租户订阅模块发放）——**不建 Casdoor 账号**（外部
  用户不进内部 IdP）。fail-closed 语义：登录只认 openid 身份，**业务资格由模块判定**
  （openid↔客户↔门店绑定与审批状态是模块数据，沿用 wuji-2 既有流程随迁）；宿主登录路
  **零跨模块 schema**（B1 干净）。租户行新增公众号配置（app_id/secret，敏感值走 openship
  env，形态仿 wecom 三参）。auth-core 新增公众号 OAuth（B2 边界内，认证代码只进 auth-core）。

## 2. 数据模型、域 API、附件

### 2.1 数据模型（`aftersales` schema；全部带 `org` 列——spec-1 租户隔离约定的规模化实践）

| 表 | 来源（wuji 数据源） | 说明 |
|---|---|---|
| `ticket` | after_sales_work_order | 编号/商品/门店/金额类型（按比例\|固定）/金额/附件引用/状态机（待处理→已处理\|已驳回）/处理人 |
| `ticket_rule` | after_sales_rule | 比例/固定额；工单实时算金额 |
| `store` / `product` / `employee` / `department` / `region` | 共用主数据 | 「可搬迁」纪律；`employee.open_id` 是移动端身份锚 |
| `archive_order` / `archive_order_item` | group_buying_order(_item) 存量 | **只读档案表**：保工单关联订单展示/查询完整，无业务 API；接龙二期另起活表 |

### 2.2 域 API（方案 A，manifest 逐条声明，门卫 fail-closed）

```
工单   GET/POST /tickets、GET /tickets/:id、POST /tickets/:id/process
规则   GET/POST/PUT/DELETE /rules
主数据 GET /stores、GET /products（搜索）、GET/POST /employees、POST /employees/:id/approve
附件   POST /attachments（元数据→预签名 PUT URL）、GET /attachments/:id（校验→预签名 GET URL）
```

**scope 分层**（身份两类用户的落点）：移动端端点（提交工单/查自己的工单）声明
`aftersales:guest`（访客 session 发放）；管理端点（处理/规则/员工/审批）声明内部码
`aftersales:manage`——门卫**零改动**（identity+scope 判定照旧），访客身份进既有 identity
结构；`ticket` 提交者字段 = openid（外部客户标识，可选关联门店）。

**并发与幂等**（§0.3 的落点）：处理动作用状态机条件更新（`update … where status=待处理`，
影响行数 0 ⇒ 409）；工单提交带客户端幂等键（后端去重，不再靠前端防抖）；处理端点按
`ticket_rule` **服务端重算金额**；工单提交/员工审批等多步写一律单端点单事务。

### 2.3 附件 → 天翼 ZOS 直连

- 存储 = **天翼 ZOS**（S3 兼容、path-style、SigV4；公司现成端点体系如 xinan1 区域）。
  WeKnora 实测结论背书：ZOS S3 兼容可用（当年 duckle 403 是 duckle sink 能力空白，非 ZOS 问题）。
- 存储工具 `modules/aftersales/storage.ts` 模块内自持（标准 S3 客户端 + 自定义 endpoint），
  第二个消费者出现再抽公共包。
- **预签名直传是必选而非优化**：移动端附件是手机拍的图片+视频，平台全局 bodyLimit ~1MiB，
  视频过服务器必炸。字节全程不过平台；上传换预签名 PUT（短 TTL），下载经 scope 校验换
  预签名 GET（短 TTL）。
- env：`AFTERSALES_ZOS_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET`（B9 声明 + openship isSecret）；
  key 规范 `aftersales/{org}/{ticket_id}/{uuid}`（key 不用裸 `=` 等需编码字符）。
- **附件存量不搬运**：历史工单附件引用保持 COS 原值（无极 COS 账号保活可读；客户不在意
  历史凭证则可标记不可看——交付时按客户意思二选一）；新附件全走 ZOS。

## 3. 管理端重写、数据迁移、分期

### 3.1 console 管理端（wuji-1 售后部分 → React + antd）

| wuji-1 页面 | console 条目 |
|---|---|
| 售后工单处理（919 行大头） | `/console/aftersales/tickets`（三态列表 + 处理弹窗 → 状态机端点） |
| 售后规则管理 | `/console/aftersales/rules` |
| 员工信息管理 + 注册审批 | `/console/aftersales/employees`（含审批） |
| 商品/门店档案（引用面） | `/console/aftersales/products`、`/stores`（只读起步） |

纪律照 demo 范式：HTTP 只走 `platformFetch`、权限读 Outlet 注入 scopes、零反向依赖
apps/web。30 个 composable 的业务逻辑随页面移植，但口径是**业务规则复用、实现按 §0.3
重构**（前端算金额/全量过滤等模式不搬运，改调服务端）。

### 3.2 移动端 userApp

wuji-2 整包 + Vite 壳 + shim（`wuji-data` 7 方法 → 域 API；`getCurrentUser` → session；
`wuji-upload` → 预签名直传）；只保留售后工单提交相关页（wuji-2 TODO 本就要删接龙页——
留给二期）。**连带补 userApp 停用闸门**（module-protocol 挂名缺口：`enabled=false` 时
userApp 静态必须同形 404——首个真实 userApp 用户，闸门与本模块同批落地）。

### 3.3 数据迁移（全量）

- **开工前置确认项（第一未知数）**：无极托管库的导出方式（直连 / 导出文件 / API 拉取）。
- 映射清洗：老数据二义（`product_name`/`store_selection`）**迁移时一次洗清**，不带兼容层。
- `employee.open_id` 全量带过来（移动端身份锚）；订单档案表随迁（工单关联展示）。

### 3.4 分期与验收

| 期 | 内容 |
|---|---|
| M1 底座三件 | userApp 静态托管 + 停用闸门补缺；auth-core 公众号 OAuth 路 + 租户行公众号配置 + `login_methods` 新值 |
| M2 模块后端 | 域 API + 迁移建表 + ZOS 存储 + 数据全量迁移与清洗 |
| M3 双端 | console 管理端 + 移动端 userApp 整迁 |

**总验收绑定 spec-3 试点**：客户机六步交付；单租户 e2e（公众号登录 → 提交工单含 ZOS 直传
视频 → console 处理按规则算金额 → 状态流转）；多租户 org 隔离测试；停用闸门 404 同形；
迁移核对（计数/金额汇总比对）；**M1c 两笔债顺带销账**。

## 4. 落地物清单

| # | 物 | 性质 |
|---|---|---|
| 1 | 本 spec | 文档 |
| 2 | `modules/aftersales`（manifest/迁移/index/console/mobile/storage） | 代码 |
| 3 | auth-core 公众号 OAuth + 租户行公众号配置 + `wechat-oa` 登录路 | 代码 |
| 4 | userApp 静态托管 + 停用闸门（loader/module-protocol 回写） | 代码+文档 |
| 5 | `.env.example` 增键（B9）：公众号 + ZOS | 代码 |
| 6 | 数据迁移脚本（导出→清洗→导入，幂等） | 代码 |
| 7 | `architecture.md` 组件表加行、module-protocol userApp 节更新 | 文档 |

## 5. 已知边界

1. **无极库导出方式未确认**（§3.3 前置项）——未确认前 M2 数据迁移排期是虚的。
2. **cron 不碰**：售后域不需要定时任务；接龙自动失效属二期，届时再解决平台定时机制。
3. **接龙（groupbuying）二期**：购物车并发/库存锁/自动失效/live 表另起；主数据届时评估抽取。
4. 历史附件依赖无极 COS 账号保活（或客户接受不可看）。
5. 天翼 ZOS 端点写法坑（endpoint 不带 `https://`、path-style）带进实现注意——WeKnora 两条
   条目为证。
6. 第一个真模块落地后，触发 spec-1 留的「评估租户隔离 CI 门禁升级」。

## 6. 关联

- 源分析：pi 会话 `~/.pi/agent/sessions/--…-售后-接龙系统迁移--/2026-08-30T09-17-13…jsonl`
  （本文 §0.1 为其自足摘要）；源码 `~/Documents/mytechcode/wuji-1`、`wuji-2`。
- spec-1（个性化分级/租户隔离）、spec-3（私有化交付 runbook——总验收绑定其试点）。
- WeKnora：天翼 ZOS S3 兼容实测条目（5ce608d1 / eecc0a6f）。
- module-protocol.md（userApp 闸门缺口、租户数据隔离约定）。

## 7. 修订记录

- 2026-09-15：初版。brainstorming 四问定方向（§0.2），三节设计（拓扑身份 / 数据API附件 /
  重写迁移分期）逐节确认后落盘；附件按用户修订：试点直连天翼 ZOS、存量不搬运。
- 2026-09-15（补2）：用户订正身份模型——移动端是**外部客户**（非内部员工）：openid 签
  访客 session（不建 Casdoor 账号、scope=aftersales:guest 按订阅发放），业务资格由模块
  按绑定/审批状态判定；内部员工一律 Casdoor。§1.3 重写、§2 增 scope 分层。
- 2026-09-15（补）：应用户要求增 §0.3「迁移即重构」原则——无极前端直调/无事务模式不
  翻译，按标准开发范式重构（服务端权威金额、单端点事务、服务端分页过滤、单测门禁）。
