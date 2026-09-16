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
  **零跨模块 schema**（B1 干净）。租户行新增公众号配置（`wechat_oa_app_id/secret` 两列，
  形态仿 wecom 三参）；**wechat-oa 不是 console 登录 tab**（外部客户不进登录页）——路由
  启用判定 = 租户行公众号配置存在，不动 `login_methods` 白名单与前端 METHOD_LABELS。
  auth-core 新增公众号 OAuth（B2 边界内，认证代码只进 auth-core）。回调失败留痕与企微母本
  （auth-wecom）有一处**有意分叉**：code 被拒（微信 200+errcode 形状）的 BAD_CODE **写
  audit `login.fail`**（detail `via=wechat-oa, reason=no-openid`，actor 用显式匿名桶
  `wechat-oa-anon`——openid 未知，占位串与真实 openid 约定的 o 前缀无碰撞面），而企微路的
  BAD_CODE 只计数不写 audit（拿不到可信 actor）；理由：访客路没有 NO_ACCOUNT/JIT 后续分支，
  no-openid 是它唯一的内容物失败，不留行则零痕迹——后人勿以「统一口径」为由抹掉这行 audit。

**访客 scope 发放机制（协议小扩展）**：manifest 增可选字段 `guest: { scope: string }`——
模块声明自己的访客码（声明即授权的延伸）；wechat-oa 回调签访客 session 时，scopes =
**该租户已启用模块**声明的 guest 码集合（未启用/未声明 ⇒ 无码；停用模块的移动端 API 由
既有闸门 404 + 门卫 403 自然闭合）。访客 session 的 **scopes 刷新同样不查 Casdoor**（openid
在 Casdoor 无账户，查了必命中「用户不存在→清会话」，7 天 TTL 实际活不过 5 分钟），改按
该租户已启用模块的 guest 码重算重签——「停用模块即掉码」的语义因此在 session 层延续。
M1 落协议字段与发放逻辑，M2 的 aftersales manifest
声明 `guest: { scope: aftersales:guest }`。

## 2. 数据模型、域 API、附件

### 2.1 数据模型（`aftersales` schema；全部带 `org` 列——spec-1 租户隔离约定的规模化实践）

| 表 | 来源（wuji 数据源） | 说明 |
|---|---|---|
| `ticket` | after_sales_work_order | 编号/商品/门店/金额类型（按比例\|固定）/金额/附件引用/状态机（待处理→已处理\|已驳回）/处理人 |
| `ticket_rule` | after_sales_rule | 比例/固定额；工单实时算金额 |
| `ticket_attachment` | after_sales_work_order 的 `damage_images`（数组/字符串混用，归一后展开） | 附件对象键（ZOS `object_key`）+ 类型/大小/上传者。**`ticket_id` 可空**——§2.3 的预签名发生在工单落库**之前**（移动端先传图后提交），那一行先以 `client_request_id` 落库；提交工单时按 `(org, client_request_id)` 认领。唯一索引 `(org, object_key)` |
| `store` / `product` / `employee` / `region` | 共用主数据 | 「可搬迁」纪律；`employee.open_id` 是移动端身份锚。**M2a 建这四张**（各有源表） |
| `department` | 共用主数据（§0.1 原表清单的一行） | **建表归 M2b**（2026-09-15 定）：§3.3 的 14 张源表清单里**没有部门表**，M2a 既无源可映、又无 API 消费者（§2.2 主数据面只有 stores/products/employees）——建它等于照猜写 DDL，与 `archive_*` 同一条规矩 |
| `archive_order` / `archive_order_item` | group_buying_order(_item) 存量 | **只读档案表**：保工单关联订单展示/查询完整，无业务 API；接龙二期另起活表。**建表归 M2b**（2026-09-15 定）：它们唯一的消费者就是 M2b 的迁移脚本，而 `group_buying_*` 的字段清单**至今没有实测样本**（§3.3 只测得行数与几处类型异常）——M2a 建它等于照猜写 DDL。M2a 侧只留 `ticket.related_order` 引用列；M2b 拉样后建表，字段按样本定 |

**金额表示（2026-09-15 定）**：目标表金额**一律整数分**（列名 `_minor` 后缀或注释标明），
**永不浮点**——§0.3 服务端权威计算的前提（浮点累加会在对账时变成假的差额）。源侧单位
（分/元）的解释**不在这一层**，只发生在 §3.3 的迁移脚本一处转换里。

### 2.2 域 API（方案 A，manifest 逐条声明，门卫 fail-closed）

```
工单   GET/POST /tickets、GET /tickets/:id、POST /tickets/:id/process
规则   GET/POST/PUT/DELETE /rules
主数据 GET /stores、GET /products（搜索）、GET/POST /employees、POST /employees/:id/approve
附件   POST /attachments（元数据→预签名 PUT URL）、GET /attachments/:id（校验→预签名 GET URL）
```

**路径按 scope 分面（2026-09-15 定，协议硬约束推出来的）**：平台协议里**同一个
`(method, path)` 只能声明一次**（重复声明被 schema 拒绝，否则门卫判定二义），而一条声明只带
**一个** scope。于是「管理端看全部工单」与「访客看自己的工单」**不能共用 `GET /tickets`**
——必须分路径。访客面统一收进 `/guest/*` 前缀：

| 面 | scope | 端点 |
|---|---|---|
| 管理端 | `aftersales:manage` | `GET /tickets`（分页/筛选）· `GET /tickets/:id` · `POST /tickets/:id/process` · `GET/POST /rules` · `PUT/DELETE /rules/:id` · `GET /stores` · `GET /products` · `GET/POST /employees` · `POST /employees/:id/approve` · `GET /attachments/:id` |
| 访客端 | `aftersales:guest` | `GET /guest/tickets`（**只回自己的**，按 `identity.userId`＝openid 过滤）· `GET /guest/tickets/:id` · `POST /guest/tickets`（提交）· `POST /guest/attachments`（元数据→预签名 PUT URL） |

分面而非靠「同一个 handler 里判 scope」是**故意的**：门卫按声明逐条判定，一个端点一个 scope
是协议保证的性质；把两套权限塞进一个 handler 等于在模块里重造一套判定，正是 §0.3 要消灭的
「前端式编排」。`/guest/*` 的租户与身份仍由宿主注入（访客 session 的 `org` = 租户、
`sub` = openid），模块侧只多做一件事：**读写一律再按 `submitter_openid` 收窄**。

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
- **凭证放哪 —— 分两阶段（2026-09-16 裁定「方向 C」）**：
  - **M2a 已落地的形态**：进程 env `AFTERSALES_ZOS_ENDPOINT/REGION/BUCKET/ACCESS_KEY/SECRET`
    （B9 声明 + openship isSecret）。**该形态只对【单租户部署】成立**——一客户一部署
    （＝ spec-3 试点的交付形态），一个进程只服务一个租户，全局一份配置即正确。
  - **目标形态（M3 收口）**：**每租户可配**——凭证落**租户行**，与 §1.3 公众号
    `wechat_oa_app_id/secret` **同构**；**启用判定 = 租户行存储配置存在**；env 退化为
    **平台默认/兜底**（租户未配时用平台桶）。
    **为什么必须收**：`.env` 是**进程级**、而 `createRouter` 又是**装载期只调一次**
    ⇒ 多租户只能共用一个桶 + 一套 AK/SK：做不到租户自带存储（BYO）；一把密钥泄露
    ＝**全租户爆炸半径**；也无法按租户归集存储成本。
    **注意隔离本身没破**（下方 key 规范带 `{org}` 段，且每次读都 `where org = $1`、
    预签名由服务端按 DB 行生成）——缺的是**可配置性**，不是隔离。
  - **M3 的前置（架构先行）**：`ModuleContext` 目前**只有 `pool`**
    （`packages/platform-sdk/src/module.ts`），且 `createRouter` 在装载期只调一次
    ⇒ 宿主需**按请求**注入租户配置（照既有 `identity` 的做法：宿主中间件写进请求上下文，
    模块 `c.get(...)` 读）。这是**模块接入协议的扩展** ⇒ **先改 `docs/architecture.md` +
    `docs/module-protocol.md`，再动码**。
- key 规范 `aftersales/{org}/{ticket_ref}/{uuid}`（key 不用裸 `=` 等需编码字符）。
- **`{ticket_ref}` 不是工单的库内主键，是客户端自带的幂等键**（2026-09-15 定，写 M2a 计划时落实）：
  移动端的顺序是**先传图、后提交工单**（选照片→上传→提交），预签名发生在工单落库**之前**，
  那一刻没有任何库内 id 可拼。故该段放客户端生成的 `client_request_id`——它同时就是 §2.2
  要求的提交幂等键（`ticket` 表 `unique(org, client_request_id)`）。工单主键仍由库自增，
  两者互不替代（幂等键由客户端持有，主键由库持有）。
- **附件存量不搬运**：历史工单附件引用保持 COS 原值（无极 COS 账号保活可读；客户不在意
  历史凭证则可标记不可看——交付时按客户意思二选一）；新附件全走 ZOS。

### 2.4 工单处理：金额规则与状态机（**源行为实证** → 服务端权威实现）

M2a 要复刻的业务内核。以下全部取自 wuji-1 源码**逐行实证**，不是推测：

**金额公式**（源：`src/pages/afterSalesWorkOrderManage.vue:687-697`，**当前在浏览器里算**）：

```
售后金额 = (报损数量 − 基本数量 × 售后比例) × 基本单价      // damage_quantity/basic_quantity/basic_unit_price
         → 负数取 0（Math.max(0, …)），四舍五入到分
```

语义：`基本数量 × 比例` 是**免赔门槛**，超出部分才赔。⇒ M2a 把它搬成服务端纯函数并落库
（§0.3「服务端权威计算」）；**前端传来的金额一概不采信**。

**三态状态机**（源：`src/utils/enumConstants.ts:56-79` 为权威；`src/types/afterSalesWorkOrder.ts:60`
另声明了一个**含 `processing` 的 4 态版本，全仓从未写入过** —— 死声明，勿照搬）：

| 值 | 中文 | 处理动作 |
|---|---|---|
| `pending` | 待处理 | 提交时写入（`useAfterSalesWorkOrder.ts:460`） |
| `completed` | 已处理 | `ratio` / `fixed` 两条路 |
| `cancelled` | 已驳回 | `reject` 路（**金额强制归 0**） |

**金额类型 `after_sales_type`**（源：`enumConstants.ts:111` = `'ratio' | 'fixed' | 'reject'`）：

- `ratio`：按公式算，落 `after_sales_rate`（**小数比例，非百分数**）+ `after_sales_amount`。
- `fixed`：金额是**操作员输入值**，不是计算值 ⇒ 服务端**校验**（非负、整数分、上界）而非重算。
  这正是 §0.3「前端金额不采信」的**例外要写清**：固定额是业务输入，比例额才是计算值。
- `reject`：驳回，金额 0，状态 `cancelled`。

**两处源侧单位陷阱（M2a 必须按实证实现，别按注释）**：

- `ticket_rule.refund_ratio`：类型注释谎称「售后比例(%)」，**实存小数**——`AfterSalesRuleDialog.vue:138`
  载入时 ×100、`:166` 保存时 ÷100，且公式里直接当乘数用（`basic_quantity * refundRatio`）。
  精度实证：保存走 `.toFixed(4)` ⇒ 目标列定 `numeric(6,4)`。
- **工单域金额是「元」带分精度**：`basic_unit_price` 类型是 `number`（非 int），且公式末尾
  `Math.round(amount * 100) / 100` 是**按分的四舍五入**。⇒ §2.1「目标表整数分」的迁移换算
  在**工单域 = ×100**。**注意不外推到接龙域**（`group_buying_*.price:int` 是另一套，M2b 单独核）。

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

**通道已真机实测打通（2026-09-15，原「第一未知数」销账）**：无极托管库提供**只读 HTTP API**，
**不需要直连 DB、不需要导出文件**。以下口径全部来自实测，勿凭猜写迁移脚本：

```
GET https://data.wujisite.com/api/private/object
    ?appid=<app>&schemaid=<表名>&schemakey=<表级键>
分页  page（1 起）+ size（上限 15000）   ← limit/skip/offset/pagesize 等全部【静默忽略】（写错不报错）
计数  count=<任意值> → {"data":{"total":N}}
返回  {"data":[ …行字段平铺… ],"code":200,"version":-1}
```

- `schemaid` + `schemakey` 是**严格双因子**：错一即 `403 forbidden`；裸 `appid` 拿不到表清单
  （不可枚举，这是好事）。
- **键在哪、怎么取**：wuji 后台「数据源管理」逐表可见。M2 开工时落 **openship env isSecret**，
  **绝不进仓库/文档/提交信息**（本节只写表名，不写键值）。

**源表清单（14 张，行数为实测）**：

| 域 | 源表（`schemaid`） | 行数 | 去向 |
|---|---|---|---|
| 售后 | `after_sales_work_order` | 25,661 | M2 → `ticket` |
| 售后 | `after_sales_rule` | 12 | M2 → `ticket_rule` |
| 主数据 | `store_info` | 322 | M2 → `store` |
| 主数据 | `region_info` | 13 | M2 → `region` |
| 主数据 | `employee_info` | 591 | M2 → `employee`（`openId` = 移动端身份锚） |
| 主数据 | `employee_info_approve` | 214 | M2 → 员工审批态 |
| 主数据 | `product_archive` | 13,767 | M2 → `product` |
| 接龙·档案 | `group_buying_order` / `group_buying_order_item` | 32,040 / 59,786 | **只读档案表**（§2.1），无业务 API |
| 接龙·二期 | `group_buying_batch` / `group_buying_product` / `group_buying_cart` / `Ordering_rules` | 570 / 6,421 / 4,093 / 8 | 二期另行立项 |
| 接龙·二期 | `outbound_detail` | **309,485** | 二期 |
| — | `wechat_openid` | 未取 | **不迁**：wuji 内部 token 缓存，平台无消费者 |

⇒ 售后 M2 实搬量 ≈ **13.2 万行**（工单 25,661 仅 2 页），规模可控。

**源表「不合理」实证 —— 本节是「参考不照搬」的证据清单，目标表按 §2.1 重新设计、不照抄**：

| 现象 | 实测实例 | 迁移约束 |
|---|---|---|
| 同字段类型漂移 | `damage_amount:int/num`、`after_sales_rate:int/num` | schemaless；目标表必须定死类型 |
| 外键类型不匹配 | `group_buying_order.batch_id:str` → `group_buying_batch.batch_id:int` | 静默 join 失败的源头，引用关系逐对核 |
| **同一概念两种拼写** | `employee_info.openId` vs `employee_info_approve.openid` | **join 前必须归一**，否则员工审批态挂不上——而它是移动端身份锚 |
| 主键类型不统一 | `_id`：`employee_info:str` / `employee_info_approve:int` | 同上 |
| 时间字段五套并存 | `create_time` / `created_at` / `_ctime` / `ctime` / `timestamp_with_watermark` | `employee_info_approve` **同表内** `ctime`+`_ctime` 双套 |
| 嵌套突破扁平 | `employee_info_approve.approveinfo:obj` | 全区唯一嵌套字段，需展平 |
| 数组/字符串混用 | `after_sales_work_order.damage_images:arr/str` | 附件字段先归一再搬 |
| 字段名说谎 | `group_buying_batch.title:date`（叫 title 存日期） | 不照搬字段名 |
| 软删语义不统一 | 仅 `group_buying_batch` 有 `is_deleted` | 删除语义逐表问清 |
| **同名字段注释与值不符** | `after_sales_rule.refund_ratio` 注释写「比例(%)」，实存**小数** | 目标列 `numeric(6,4)`；实证见 §2.4 |
| **同概念多份声明互相打架** | `AfterSalesStatus`：`enumConstants` 3 态 vs `afterSalesWorkOrder.ts` 4 态（`processing` 全仓零写入）；`AfterSalesType` 两处语义不同（业务类型 vs 金额类型） | 目标枚举以 `enumConstants` 为准，见 §2.4 |
| **审批状态三套词表** | `store.ts`/`registerRequest.ts` 用 `pending\|approved\|rejected`，`employeeInfo.ts` 用 `待审批\|通过\|驳回` | 迁移前归一，见 §5 #9 |
| **金额单位未标** | `total_amount:int`、`price:int`（分？元？） | **工单域已由源码实证为元**（§2.4）；**接龙域仍待 M2b 动数据前落实**（§5 #7） |
| 字段与表名撞车 | `employee_info.store_info`（字段）vs `store_info`（表） | 目标表消歧 |

- 映射清洗：老数据二义（`product_name`/`store_selection` 存 ID 或名称）**迁移时一次洗清**，不带兼容层。
- `employee_info.openId` 全量带过来；订单档案表随迁（工单关联展示）。

**活库一致性 — 已定（2026-09-15，用户拍板）：① 一次性快照 + 空闲窗口。** 源库仍在写入
（实测最新 `_mtime` = 2026-09-12），工单表 25,661 行仍在涨。选定做法是**数据迁移整体后置**：
不与代码开发同期，择一个业务空闲窗口**一次性全量拉取入库**。

⇒ **M2 拆两段**（这是本次决定的直接后果）：
- **M2a 代码**：域 API + 建表 + ZOS 存储。**不依赖源数据**，即刻开工。
- **M2b 数据**：全量拉取 → 清洗 → 入库 → 对账。**择窗口单独跑，另出计划**；执行时以「拉取
  开始时 / 结束后各取一次最大 `_mtime`，加窗口内行数与金额汇总」为对账基线（§3.4）。

② `_mtime` 增量对账**不选**——它买的「源库不停写也能持续同步」在本项目没有需求方，代价却是
长期维护一套对账机制；`_mtime` 降级为 M2b 的**窗口内快照口径**，够用。

### 3.4 分期与验收

| 期 | 内容 |
|---|---|
| M1 底座三件 | userApp 静态托管 + 停用闸门补缺；auth-core 公众号 OAuth 路 + 租户行公众号配置（**启用判定 = 配置存在，非 `login_methods` 新值**——见 §1.3，此行旧措辞已订正） |
| **M2a 模块后端（代码）** | 域 API + 迁移建表 + ZOS 存储——**不依赖源数据，先做**（ZOS 凭证落地形态为**进程 env**，**仅单租户部署成立**，见 §2.3 的两阶段裁定） |
| **M2b 数据迁移（择窗口）** | 全量拉取 → 清洗 → 入库 → 计数/金额对账（一次性，另出计划） |
| M3 双端 | console 管理端 + 移动端 userApp 整迁；**并收口「每租户可配 ZOS」**（§2.3：凭证落租户行 + `platform.tenant` 加列 + 配置 UI + 模块接入协议扩展；协议文档先行） |

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
| 5 | `.env.example` 增键（B9）：**只有 ZOS**（公众号**不需要 env 键**——凭证在租户行 `wechat_oa_app_id/secret`，见 §1.3；此处旧措辞「公众号 + ZOS」已订正）。**注（2026-09-16）**：ZOS 这五个 env 键在 M3 收口后**仍保留**，但降级为**平台默认/兜底**（租户可在租户行覆盖，见 §2.3） | 代码 |
| 6 | 数据迁移脚本（导出→清洗→导入，幂等） | 代码 |
| 7 | `architecture.md` 组件表加行、module-protocol userApp 节更新；**并（M3）为「每租户配置注入」补 `ModuleContext` 契约**（§2.3，协议文档须先于代码落地） | 文档 |

## 5. 已知边界

1. **活库一致性：已定为「空闲窗口一次性全量」**（§3.3，2026-09-15 拍板）——数据迁移（M2b）
   整体后置于代码开发（M2a）之后，择业务空闲窗口一次跑完，以窗口首尾的行数/金额汇总对账。
   **M2a 不依赖源数据，即刻可开工**；M2b 的**排期取决于窗口**，不在 M2a 的关键路径上。
2. **cron 不碰**：售后域不需要定时任务；接龙自动失效属二期，届时再解决平台定时机制。
3. **接龙（groupbuying）二期**：购物车并发/库存锁/自动失效/live 表另起；主数据届时评估抽取。
4. 历史附件依赖无极 COS 账号保活（或客户接受不可看）。
5. 天翼 ZOS 端点写法坑（endpoint 不带 `https://`、path-style）带进实现注意——WeKnora 两条
   条目为证。
6. 第一个真模块落地后，触发 spec-1 留的「评估租户隔离 CI 门禁升级」。
7. **源库金额单位：工单域已证，接龙域仍开**（§3.3 实证表 + §2.4）——
   ① **工单域 = 元带分精度**（源码实证：`basic_unit_price` 是 `number`、公式末尾按分四舍五入）
   ⇒ M2b 换算 ×100，已可写；
   ② **接龙域未定**（`group_buying_order.total_amount:int` / `price:int`，是分是元未标），
   **M2b 动这半边数据前必须落实**——优先用数据自证（拉样看量级：接龙客单价若为几十元级，
   则 `5000` 是分、`50` 是元；再看有无非整百值），证不出来再问客户。
   内部表示一律整数分（§2.1），故 M2a 不受影响；**接龙域不许按猜测写转换**。
8. `wechat_openid`（wuji 内部 token 缓存）确认**不迁**——平台无消费者，只记录不搬运。
9. **审批状态词表需归一**（§3.3 实证表）：源侧三套并存——`store.ts` / `registerRequest.ts` 用
   `pending|approved|rejected`，`employeeInfo.ts` 用中文 `待审批|通过|驳回`。目标表**定死一套
   英文枚举**，中文是**展示层**的事；归一在 M2a 建表时定死类型、M2b 迁移时做映射。
10. **ZOS 凭证在多租户下是进程级共享**（2026-09-16 用户提出、当场裁定方向 C）：
    M2a 落地的 env 形态**只对单租户部署成立**；多租户共用一个桶 + 一套 AK/SK
    ⇒ 无 BYO、单密钥爆炸半径、成本不可归集（**隔离本身不破**）。**收口排在 M3**，
    见 §2.3 的两阶段裁定与前置（模块接入协议须先扩展）。
11. **`sanitizeOrgSegment` 的命名空间碰撞**（2026-09-16 实读代码发现，**登记未裁定**）：
    它把非 `[A-Za-z0-9._-]` 一律替换为 `_` ⇒ **两个不同的 org 可能落进同一 key 前缀**
    （`a/b` 与 `a_b` 都变 `a_b`）。**读隔离不受影响**（授权判定走 DB 的 `where org = $1`，
    不靠 key），但**对象命名空间会串**——若将来做「按前缀清理 / 按前缀计费 / 按前缀生命周期」，
    这里就是一个雷。收口方式待定（如 org 段改用可逆编码或加哈希短后缀）。
12. **孤儿附件没有 GC**（2026-09-16 T10 上线后验证实测，**M2b 收口**）：
    预签名发生在工单落库**之前**，行先以 `ticket_id is null` 落在 `client_request_id` 上（§2.3）。
    访客若**传了图但没提交工单**（或提交失败后放弃），那一行与**桶里的对象**都会**永久留存**。
    实测（2026-09-16，对已上线的生产实例）：模块内**没有任何删除路径**
    （`grep` 无 `DeleteObject` / 无 lifecycle / 无清扫器），而全仓唯一的 `ticket_id is null`
    出现在**认领谓词**里（`routes/ticket-guest.ts:165`，是消费路径，不是清扫器）
    ⇒ **库侧与桶侧都没有 GC**。生产库当前 `ticket_attachment` 为 **0 行**
    （尚无租户启用，属干净基线，非「已清理」）。
    ⇒ **M2b 需给出清理设计**：按「未认领且超过 N 天」同时清 DB 行与对象。
    数据上可行——`001_init.sql` 已有 `object_key` / `created_at` 与 `(org, ticket_id)` 索引；
    注意**对象 key 里不含工单信息**，只能由行的 `object_key` 反查。

## 6. 关联

- 源分析：pi 会话 `~/.pi/agent/sessions/--…-售后-接龙系统迁移--/2026-08-30T09-17-13…jsonl`
  （本文 §0.1 为其自足摘要）；源码 `~/Documents/mytechcode/wuji-1`、`wuji-2`。
- spec-1（个性化分级/租户隔离）、spec-3（私有化交付 runbook——总验收绑定其试点）。
- WeKnora：天翼 ZOS S3 兼容实测条目（5ce608d1 / eecc0a6f）。
- module-protocol.md（userApp 闸门缺口、租户数据隔离约定）。

## 7. 修订记录

- 2026-09-16（**M2a 已合并上线后，用户提出的多租户问题** ⇒ 当场裁定「方向 C」，**只改文档不动码**）：
  用户问「不同租户都装了这个模块怎么办？ZOS 是要可以配置的」。核代码后确认这是**真缺口**：
  `modules/aftersales/index.ts` 在 `createRouter` 里 `zosConfigFromEnv(process.env)` 建了一个
  **装载期单例**，而 `ModuleContext` **只有 `pool`** ⇒ 多租户共用一份凭证，**没有任何按租户的接缝**。
  根因是**本 spec 自身的不一致**：§1.3 把公众号凭证放在**租户行**，§2.3 却把 ZOS 放在**全局 env**，
  §4 #5 还专门把两者对立着写（「只有 ZOS」需要 env 键）。
  ⇒ ① §2.3 改写为**两阶段**：M2a 的 env 形态**明确限定单租户部署**；**目标形态（M3）＝每租户可配、
  凭证落租户行、启用判定＝配置存在**（与公众号同构）；② §3.4 的 M2a 行标注该边界、M3 行加入收口项；
  ③ §4 #7 把「`ModuleContext` 每租户配置注入契约」列为 M3 落地物；④ §5 补第 10 条（该边界）
  与第 11 条（`sanitizeOrgSegment` 命名空间碰撞，**登记未裁定**）。
  同日另补 §5 第 12 条：**孤儿附件没有 GC**（T10 上线后验证实测，M2b 收口）。
  **本相位不改任何代码、不加迁移**——按规矩「架构先行」，且协议扩展须**先改
  `docs/architecture.md` + `docs/module-protocol.md` 再动码**。

- 2026-09-15（M2a 开工前**回读订正**：§2.1 漏列 `ticket_attachment`）：§2.1 自述「数据模型」，
  却只列了 `ticket`/`ticket_rule`/主数据/`department`/`archive_*`，**没有附件表**——而 §2.2 声明了
  `POST /attachments` + `GET /attachments/:id`、§2.3 定了 ZOS key 规范与预签名直传、§2.1 的
  `ticket` 行又写着「附件引用」。三节都假定它存在，表却漏了 ⇒ 补一行（含 `ticket_id` 可空
  这一非显然点：预签名早于落库，行先落在 `client_request_id` 上，提交时认领）。
  本轮**不改任何设计**，只把已成事实的表补进清单——`ticket_attachment` 自 M2a 计划定稿起
  就在 `001_init.sql` 里（7 张表），此处是文档追平代码。

- 2026-09-15（M1 已合并后**回读订正**，两处旧措辞与落地物不符）：
  ① §4 #5「`.env.example` 增键：公众号 + ZOS」——**公众号半边是错的**：M1 落地后凭证在
  **租户行**（`platform.tenant.wechat_oa_app_id/secret`，见 `apps/server/src/migrations/005_tenant_wechat_oa.sql`），
  `packages/auth-core/src/wechat-oa.ts` 的 `{appId, secret}` 是**入参**不是 env 读取
  ⇒ **没有任何公众号 env 键**，`.env.example` 只需增 ZOS 五个。
  ② §3.4 的 M1 行「`login_methods` 新值」——与 §1.3 已定的「启用判定 = 租户行配置存在，
  不动 `login_methods` 白名单」**自相矛盾**，M1 按 §1.3 落地。此行旧措辞留着会误导
  M2a 的实施者去找一个不存在的白名单改动。

- 2026-09-15（写 M2a 计划时：三处收口，仍是**约束倒逼**，非口味）：
  ① §2.3 附件 key 段 `{ticket_id}` → **`{ticket_ref}` = 客户端幂等键**——移动端「先传图后提交」，
  预签名早于工单落库，那一刻无库内 id 可拼；该段改放 `client_request_id`（同时是 §2.2 的提交
  幂等键）。这是本节唯一一次改**已定的 key 规范**，理由是原规范在真实时序上不可实现。
  ② §2.1 主数据行拆开：M2a 只建 `store`/`product`/`employee`/`region`（四张各有源表），
  **`department` 归 M2b**——§3.3 源表清单里没有部门表，且 §2.2 主数据面无它的端点，
  M2a 建它＝照猜写 DDL（与 `archive_*` 同规矩）。
  ③ §2.2 管理端面补回 `POST /employees`——上一轮把散文摊成表时漏抄，而 §2.2 散文行原本有它
  （员工注册是 console 侧流程，§3.1）。**同轮内的自相矛盾，按更完整的原始清单修**。

- 2026-09-15（写 M2a 计划前：两处范围收口，均由**平台固有约束**倒逼，非口味调整）：
  ① §2.2 增「路径按 scope 分面」——协议规定同一 `(method, path)` 只能声明一次、一条声明只带一个
  scope（`manifest.ts` 的 superRefine 拒绝重复），故「管理端看全部工单」与「访客看自己的工单」
  **不可能共用 `GET /tickets`**；访客面统一收进 `/guest/*` 前缀，端点清单由散文改成双面表。
  ② §2.1 `archive_order` / `archive_order_item` **建表归 M2b**——其唯一消费者是 M2b 迁移脚本，
  而源 `group_buying_*` 字段至今无实测样本，M2a 建表＝照猜写 DDL；M2a 只留 `ticket.related_order`。
- 2026-09-15（M2a 设计依据：工单域源码实证，**新增 §2.4**）：为写 M2a 计划回读 wuji-1 源码，
  把要复刻的业务内核钉死成文——**金额公式**（`(报损数量 − 基本数量×比例) × 基本单价`，负数取 0，
  取整到分；源在 `afterSalesWorkOrderManage.vue:687-705`，**目前跑在浏览器里**）、**三态状态机**
  （`pending|completed|cancelled`；`types/afterSalesWorkOrder.ts:60` 那个含 `processing` 的 4 态版
  **全仓零写入，是死声明**）、**金额类型 `ratio|fixed|reject`**（`fixed` 的金额是**操作员输入**而非
  计算值 ⇒ §0.3「前端金额不采信」在此有**明写的例外**）。§3.3 实证表补 3 行（`refund_ratio` 注释
  与值不符、同概念多份声明打架、审批状态三套词表），§5 新增 #9。
  **金额单位问题拆解**：工单域由源码实证为**元带分精度**（§5 #7 ①），接龙域仍未定（②）。
- 2026-09-15（M2a 开工决策，用户拍板）：**两条前置项落定**——① §3.3 活库一致性 = **一次性快照 +
  空闲窗口**，数据迁移**整体后置于代码开发**，M2 据此**拆成 M2a（代码，即刻开工）/ M2b（数据，
  择窗口另出计划）**；② §2.1 新增「金额表示」= **目标表一律整数分，永不浮点**，源侧单位
  （分/元）的解释**收敛到 M2b 迁移脚本的一处转换**——§5 #7 随之从「开发期前置」降为
  **「迁移期前置」**（M2a 的服务端金额计算不再被它卡住）。§5 #1 相应改写。
- 2026-09-15（M2 前置调研，真机实测）：**原「第一未知数」销账**——无极托管库走只读 HTTP API
  可拉（非直连/非导出文件），§3.3 重写为「通道口径 + 14 张源表清单与实测行数 + 不合理实证表」。
  §5 边界 #1 由「导出方式未确认」换为「活库一致性策略未定」，并新增 #7 金额单位待问、#8
  `wechat_openid` 确认不迁。实证要点：`size` 上限 15000、`limit/skip/offset` 静默忽略、
  `schemaid`+`schemakey` 严格双因子、`employee_info.openId` 与 `employee_info_approve.openid`
  同概念两拼写。**键值一律不落文档**（在哪、怎么取：wuji 后台 → M2 落 openship env isSecret）。
- 2026-09-15（Task 6 实现轮，审查 I1+M1）：§1.3 增两处落定——① 回调 BAD_CODE 写 audit
  `login.fail`（actor=显式匿名桶 `wechat-oa-anon`），与企微母本「BAD_CODE 只计数不写
  audit」是**有意分叉**（访客路无 NO_ACCOUNT/JIT 后续分支，no-openid 是唯一内容物失败），
  勿以「统一口径」为由抹掉；② 访客 session 的 scopes 刷新不查 Casdoor（openid 无 Casdoor
  账户，查了必清会话——7 天 TTL 实际活不过 5 分钟），改按已启用模块 guest 码重算重签，
  停用即掉码在 session 层延续。
- 2026-09-15：初版。brainstorming 四问定方向（§0.2），三节设计（拓扑身份 / 数据API附件 /
  重写迁移分期）逐节确认后落盘；附件按用户修订：试点直连天翼 ZOS、存量不搬运。
- 2026-09-15（补3）：规划期两处定形——wechat-oa 非 console 登录 tab（启用判定=公众号配置
  存在，不动 login_methods）；访客 scope 走 manifest `guest:{scope}` 声明（协议小扩展，
  宿主按已启用模块发放）。
- 2026-09-15（补2）：用户订正身份模型——移动端是**外部客户**（非内部员工）：openid 签
  访客 session（不建 Casdoor 账号、scope=aftersales:guest 按订阅发放），业务资格由模块
  按绑定/审批状态判定；内部员工一律 Casdoor。§1.3 重写、§2 增 scope 分层。
- 2026-09-15（补）：应用户要求增 §0.3「迁移即重构」原则——无极前端直调/无事务模式不
  翻译，按标准开发范式重构（服务端权威金额、单端点事务、服务端分页过滤、单测门禁）。
