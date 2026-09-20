# 新模块接入文档（module-onboarding）设计

> 2026-09-20 brainstorm 定稿。目标：把「新接一个业务模块」所需的协议、契约、约定
> 收拢成一份**面向接入者**的文档。
>
> 本 spec 承载设计与决策；成文后规则正典仍是 `docs/module-protocol.md`，
> 本 spec 只作决策留档，不承载规则。

## 1. 背景与问题

### 现状盘点（2026-09-20）

| 材料 | 是什么 | 缺口 |
|---|---|---|
| `docs/module-protocol.md`（432 行） | 协议正典，按主题逐节追加（每节带日期/issue 出处），面向**已接入的维护者**讲 why 与边界 | 不是接入视角；manifest 多数字段（`frontend.console`/`userApp`/`guest`/`migrations`/`platform`）散落各节或未成节 |
| `modules/demo` | 事实上的最小模板 | 「照抄姿势」只在 `index.ts` 代码注释里（「后续业务模块照抄」） |
| `modules/aftersales` | 全能力真实用例（guest/storage/userApp/分面/页内 tabs） | 姿势只在 manifest 与 console 代码注释里 |
| `packages/platform-sdk/src/manifest.ts` | 机器契约源（zod schema） | 是代码不是文档；不含「什么时候用哪个字段」的判断 |

一个新模块作者今天要**逆向拼凑**：manifest 全字段参考、入口契约（`defineModule`/`createRouter({pool})`/`c.get('identity')`）、目录骨架、门禁 checklist、故障排查——没有一处一次说清。

### 顺带发现：schema 死字段

实测（2026-09-20）：`notifications.dir` 与 `config.schema` **零消费者**（schema 收、
没人读）；`bindings` 仅 `check-manifests` 的键白名单（`{postgres, novu, cube}`）在查，
无运行时消费。这是 module-protocol.md 开篇「一个字段死于零文档」教训的镜像——
写文档时必须处置它们（见 D4）。

## 2. 决策记录（四个分叉 + 两个过程补强）

### D1 文档形态：新建 `docs/module-onboarding.md`，正典不动

- 新文档管「**怎么接入**」：步骤、全字段参考（只写形状 + 指针）、checklist、症状速查
- 语义/边界/踩坑的正典是 `module-protocol.md`，**不复制正文、只留指针**
- 弃选 B（重构正典为单文件）：432 行正典被 AGENTS.md、代码注释、specs 广泛引用，
  重构 churn 全部引用点；「接入指南」与「协议正典」读者姿态不同（按步骤走 vs 查语义）
- 弃选 C（字段参考由 schema 生成）：防漂移收益真，但生成链路要维护，且生成表写不了
  「哪个字段什么时候用」的判断

### D2 覆盖面：全字段覆盖，分深度档

- **主干路径**（`permissions` + `api.internal` + `migrations`，每个模块必经）：手把手
- **能力面**（`frontend.console`/`admin`/`userApp`、`guest`、`storage`）：字段参考 +
  最小示例 + 语义指针，按需查阅
- 理由：demo 都带 console 页，接入者第一天就碰前端条目；但 userApp/guest/storage 是
  特殊形态，写深了文档比代码长

### D3 受众：内部研发，止于仓内边界

- 读者假设：能访问本仓、走正常 PR 流程的内部开发者（含未来接手者）
- 文档终点：**CI 全绿 + 本地装载通过**。部署/交付侧（openship env、生产冒烟、私有化
  runbook）由 `deploy/openship-adopt.md` 与交付 runbook 承载，本文只留指针

### D4 死字段：如实标注，清理另立决定

- 字段参考表给 `notifications`/`config.schema`/`bindings` 如实标注「**预留·无消费者**
  （schema 接受但当前无运行时消费——声明了不会有任何效果）」
- 是否从 schema 删除属结构性变更，不搭文档车；开 issue 记录待议

### D5（过程补强）§5 以「声明 → 可见效果」为先

菜单/可见性语义显性化为对照表（用户点名：刚合入 #125 的菜单联动不能埋在指针后面），
置于 §5 最前；配套心智模型一节（见 §5 设计）。

### D6（过程补强）行业参照系与演进先例入「心智模型 + 已知边界」

检索结论（2026-09-20）：行业三种菜单形态——

1. **统一壳 + 侧栏分组**（Stripe/Linear/Grafana）：Grafana 与本协议最同构——插件页面
   落侧栏「More apps」分区；整插件可搬 section（带排序权重）；单页可抽进其他分区；
   页面路径强制模块命名空间（`/a/PLUGIN_ID/…`）；**placement 归管理员配置而非插件声明**
2. **App 切换器/套件**（Salesforce App Launcher / Odoo app 网格 / Zoho One）：45+ app 的
   重套件形态；Zoho 自己都撰文讲这种导航的代价（用户被迫记功能住在哪个模块）
3. **壳导航 + 应用自绘页内导航**（Shopify 嵌入 app）：侧栏是壳的；app 用 App Bridge 可
   把菜单项挂到 iframe 外；页内导航全归 app

**本平台 = 形态 1 + 形态 3 混合，与行业主流同构，不抄形态 2**（2 个模块不需要切换器）。
借鉴两点：心智模型给接入者行业参照系；已知边界钉住「模块多时平铺会破」的演进先例
（Grafana：section 分组 + 排序权重 + 管理员侧 placement）。

## 3. 文档骨架（`docs/module-onboarding.md`）

| 节 | 内容 | 深度 |
|---|---|---|
| §0 接入前必读 | 指针：architecture.md 不变量、AGENTS.md 硬约束、模板（demo=最小 / aftersales=全能力） | 短 |
| §1 目录与工程骨架 | `modules/<id>/` 该有什么文件、workspace 收纳、从 demo 起步 | 手把手 |
| §2 manifest 全字段参考 | 一张表：字段/必填性/形状/语义指针（正典 §X）/谁校验（schema·check-manifests·装载期三层）；死字段如实标注 | 参考 |
| §3 后端入口契约 | `defineModule({manifest, createRouter({pool})})`、yaml 单一事实源姿势、`c.get('identity')`（I-1）、路由与声明逐字一致、不写 requireScope | 手把手（主干核心） |
| §4 数据库与迁移 | 三同纪律（schema=id）、org 列三条纪律指针、迁移幂等（团队 db-migration 规则） | 手把手 |
| §5 能力面按需接入 | **心智模型 → 声明→可见效果对照表 → 各能力面字段细节**（详见下节） | 按需查阅 |
| §6 接入验收 checklist | 会咬人的门禁清单：check-manifests、装载期双向核对、check-tenant-isolation、probeAnonymous 进模块测试、全量命令（指针 README §常用命令，不复制） | checklist |
| §7 常见故障速查 | 症状 → 原因 → 出路（初版清单见 §3.3） | 速查表 |
| 已知边界 | 死字段预留、frontend.admin 零真实消费者、平铺菜单演进先例 | 短 |

### 3.1 §5 心智模型（全文收录，成文时直接落）

**壳 vs 应用**：管理后台是单一壳（apps/web，React + ProLayout），模块交付的是「页」——
构建期聚合成 `console-registry.gen.ts`（`scripts/gen-console-registry.mjs`）、运行时三重
过滤（config 启用 ∩ registry 挂载 ∩ session scope）出菜单、lazy load 渲染进壳的 Outlet，
共享壳的布局/主题/会话（ConsoleOutletContext）。**没有「进入应用 → 独立菜单体系」**。
要独立 UI 的是 C 端场景，走 `frontend.userApp`（真独立构建，挂 `/app/<id>`）。

**两级菜单**：壳侧栏一条（协议管：扁平、不支持嵌套、显隐三重过滤）+ 页内导航模块
自绘（协议不管：aftersales 用 antd Menu 画页签、按 URL 末段选页、深链可直达）。

**行业参照**：本平台 = Stripe/Grafana 系（统一壳 + 页聚合 + 页内自绘），不是
Odoo/Salesforce 系（app 切换器）。

三张 ASCII 图随文收录（本 spec §3.2 的图 1/2/3）。

### 3.2 图（成文时直接收录）

**图 1 运行时形态——一个壳，模块是「页」**：

```
┌────────────────────────────────────────────────────────────────┐
│  ConsoleShell（apps/web，唯一的壳：React + ProLayout）            │
│  壳管：布局 / 主题 / 暗色切换 / 会话 / 登出                        │
│ ┌──────────────┬─────────────────────────────────────────────┐ │
│ │  侧栏菜单      │              页面区 <Outlet/>                │ │
│ │  （只有这一套） │                                             │ │
│ │              │   ┌─────────────────────────────────────┐   │ │
│ │  概览          │   │ 点「售后管理」⇒ 懒加载 aftersales 的   │   │ │
│ │  演示     ─────┼──▶│ console/index.tsx，渲染在这个框里      │   │ │
│ │  售后管理   ───┼──▶│                                     │   │ │
│ │              │   │ aftersales 页内想多页？自己写子路由：    │   │ │
│ │ ▾ 管理         │   │ /console/aftersales/tickets          │   │ │
│ │   用户管理      │   │ /console/aftersales/rules           │   │ │
│ │   角色与授权    │   │ （页内导航，侧栏菜单不跟着变）           │   │ │
│ │   我的订阅      │   └─────────────────────────────────────┘   │ │
│ │   存储配置*     │                                             │ │
│ │   模块admin页*  │   （点菜单其他项 ⇒ Outlet 里换成别的模块页）    │ │
│ └──────────────┴─────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
 * 存储配置/模块admin页：只有 tenant:admin 且模块声明了才出现
```

**图 2 声明怎么变成菜单——构建期聚合 + 运行时过滤**：

```
modules/<A>/manifest.yaml              modules/<B>/manifest.yaml
  frontend.console/admin 条目               frontend.console 条目
        │                                        │
        └───────────────┬────────────────────────┘
                        ▼  构建期（pnpm build 前置脚本）
        scripts/gen-console-registry.mjs 聚合
                        │
                        ▼
        apps/web/src/console-registry.gen.ts（生成文件）
                        │
                        ▼  运行时，壳里做三重过滤
        config 启用集        registry 挂载        session scope
        （租户启用了          （构建期已           （用户有
          这个模块吗）          挂载了吗）           这个权限码吗）
             └──────── 三项全过 ────────┘
                        │
                        ▼
        菜单出现该条目 + 点进去懒加载模块页
        （任何一项不过 ⇒ 菜单不出、直敲 URL 也进不去）
```

**图 3 两级菜单——壳侧栏一条，页内页签模块自己画**：

```
┌──────────────────────────────────────────────────────────────────┐
│ ConsoleShell（壳）                                                │
│ ┌────────────┬─────────────────────────────────────────────────┐ │
│ │ 壳的侧栏菜单 │  aftersales 的页面区（模块自己的地盘）              │ │
│ │            │ ┌─────────────────────────────────────────────┐ │ │
│ │ 概览         │ │ ⌗工单 ⌗规则 ⌗员工 ⌗商品 ⌗门店 ⌗申请审批      │ │ │
│ │ 演示         │ ├─────────────────────────────────────────────┤ │ │
│ │ 售后管理 ────┼─▶│ （选中页签的内容区）                          │ │ │
│ │            │ │                                             │ │ │
│ │ ▾ 管理      │ └─────────────────────────────────────────────┘ │ │
│ │   …         │   ↑ 这排页签是 aftersales 自己用 antd <Menu>     │ │
│ └────────────┴──── 画的，URL 驱动：/console/aftersales/tickets   │ │
└──────────────────────────────────────────────────────────────────┘
```

### 3.3 §5「声明 → 可见效果」对照表（成文时收录）

| 你声明了… | 管理台上发生什么 |
|---|---|
| `frontend.console[]` 条目 | 菜单**平铺**一条 = 一页（协议不支持嵌套；多页面收一个条目、页内真子路由分区——aftersales 现成姿势）；显隐 = registry ∩ config 启用集 ∩ session scope 三重过滤；**一个条目 = 侧栏一项 + 页内自绘导航** |
| `frontend.admin[]` 条目 | 进**管理组 children**，顺序：平台内置三项 → 存储配置 → 模块 admin 页（manifest 声明序）；三条约法（`/console/admin/` 前缀 / scope ∈ permissions / console 条目禁占该前缀）。⚠️ **组门 `tenant:admin` 目前只由菜单侧施加**——模块 admin 页走 `*` 通配的 `ConsoleModulePage`（`registry ∩ 页门 scope`），`AdminGate` 只包住平台内置四项 |
| `storage: {kind: s3}` | **触发租户管理台「存储配置」页可见**（能力联动：`storageDeclarers ∩ 启用模块 ≠ ∅` 才显示/可达）；运行时 `c.get(TENANT_STORAGE)` 取本租户配置 |
| 模块被停用 | **菜单面**：菜单不出（三重过滤含 config）。**路由面**：模块页/模块 admin 页走 `registry ∩ session scope`，**不查 config** ⇒ 持码用户直敲 URL 仍可打开该页。唯一由 config 驱动的路由门是 `/console/admin/storage` 的 `StorageGate`。API 面 404（与「不存在」同形） |

> ⚠️ **2026-09-20 实测订正（必须按此写，勿回退成「菜单与页面同隐」）**：菜单与路由是**两套判定**。
> 证据链：`apps/web/src/App.tsx:30` 模块页落 `*` 通配 → `Console.tsx` 的 `ConsoleModulePage`
> 只做 `consoleRegistry.find(...)` + `session.scopes.includes(entry.scope)`，**无 config 查询**；
> `App.tsx:26-29` 的 `AdminGate` 只包平台内置四项；`apps/server/src/session-middleware.ts:196`
> 普通会话 scopes 走 Casdoor（非按启用模块过滤，只有访客路 :176 重算）。
> 正典 `module-protocol.md` 的「显隐联动」bullet 写作「菜单/路由 = registry ∩ config ∩ session
> scope」与之不符，Task 4 一并订正。缺口（是否让路由层也吃 config / 给模块 admin 页补组门）
> 开 issue 跟踪，不在本计划内。

### 3.4 §7 症状速查初版清单

后端：

| 症状 | 病因 | 出路 |
|---|---|---|
| 端点恒 403 | ① 裸 `/` 声明 ② 声明相对/绝对混用（比对基准是宿主绝对 routePath） ③ scope 不在本模块 permissions | 按 module-protocol.md「规则」节自查 |
| 进程起不来（装载失败） | 注册与声明双向差集 | 读失败信息里的差集原文 |
| 停用模块 API 面 404（不是 403） | 停用语义设计如此（不可枚举） | module-protocol.md「停用语义」 |
| `c.get(TENANT_STORAGE)` 恒 undefined | 未声明 `storage` / 租户行部分填写不回落 | module-protocol.md「租户级配置注入」 |

前端：

| 症状 | 病因 | 出路 |
|---|---|---|
| 模块页**整块空白且零报错** | 用了嵌套 `<Routes>`——模块页挂在壳 splat 路由 `*` 之下，嵌套路由按 splat 剩余段匹配，永远匹配不上 | 按 pathname 末段直接选页（aftersales `console/index.tsx` 姿势） |
| 页签点击跳错路径（如跳到 `/console/rules` 丢掉模块段） | 相对导航以壳的 splat 路由为基准解析 | 导航一律**绝对路径** |

## 4. 配套交付

1. `docs/module-onboarding.md`（主体，按 §3 骨架成文）
2. `AGENTS.md` 文档地图加一行：「**新接一个业务模块** → `docs/module-onboarding.md`」
3. `module-protocol.md` 顶部加一句反向指针（「接入视角的指南见 module-onboarding.md」）
4. GitHub issue：schema 死字段清理待议（`notifications`/`config.schema` 零消费者、
   `bindings` 仅白名单校验）——不阻塞本文档

## 5. 验收标准

- 文档内所有指针逐一核实指向存在（正典节名、README 节名、demo/aftersales 文件路径）
- 全量门禁照跑绿（docs 改动不影响，但守纪律）
- 走 PR（docs 类型，无需 issue 前置；死字段 issue 另开）

## 6. 已知边界（文档「已知边界」节明示的内容）

- **路由层不吃 config（2026-09-20 实测）**：模块页与模块 admin 页的路由判定是 `registry ∩
  session scope`，**不含 config**——停用模块的页面对持码用户仍可直敲直达；覆盖此点的测试只有
  菜单侧（`Console.test.tsx` 的 ① 用例）。这是**实现缺口**而非设计意图（#125 spec 的「门禁双层」
  与它自己的「路由」条自相矛盾），缺口开 issue 跟踪，文档如实写现状。
- `notifications` / `config.schema` / `bindings` 为预留·无消费者（D4）
- `frontend.admin` 本期零真实消费者，端到端只靠 fixture 验证——第一个真实模块接入时
  补浏览器级验收（沿 #125 spec 的待销账）
- 平铺菜单在模块数量多时会破（行业经验约 7±2 项）；演进先例：Grafana 的 section
  分组 + 排序权重 + 管理员侧 placement 配置。现在不做（YAGNI），方向先钉住
