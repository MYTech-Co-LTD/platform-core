# 模块管理页协议（frontend.admin）+ 存储配置页能力联动 设计

- 日期：2026-09-20
- 状态：已评审（通用程度/存储页归属两处分叉均经确认）
- 关联：`docs/module-protocol.md`（本设计为其新增一节）、M3c 租户存储协议
  （`2026-09-16-m3c-tenant-storage-protocol-design.md`）、console 菜单规则唯一事实源
  （`2026-09-13-console-saas-ui-blueprint-design.md` §3）

## 背景与动机

「管理」组四项（用户管理/角色与授权/我的订阅/存储配置）是壳侧**写死**的
（`console-menu.ts` 的 `adminGroup()`），只受 `tenant:admin` 门禁，与模块启停零联动。
真实缺口：售后模块关闭后，为其服务的「存储配置」页仍挂在管理组里；模块带来的
管理类页面没有进入管理组的正规通道。

两项裁定（已确认）：

1. **做通用管理页协议**（`frontend.admin`），不只修存储页一个案例。
2. **存储配置页留在宿主**（它管理的是 `platform.tenant` 上的租户全局五列，不是模块
   私有配置），可见性走**能力联动**；不迁进售后模块（与 M3c「第二个消费者出现再抽
   公共包」的预留演进方向保持一致）。

## 目标 / 非目标

**目标**

1. 模块可通过 manifest `frontend.admin` 声明自有的「管理」组子页，随模块启停联动显隐。
2. 宿主「存储配置」页按 storage 能力联动：启用的模块里至少一个声明 `storage:` 才显示。
3. 协议扩展进正典（`module-protocol.md`）与机器契约（SDK schema + check-manifests）。

**非目标**

- 不改后端 config API 形状、不加后端路由、不动 DB（零后端零迁移）。
- 不迁移存储配置页代码（留 `apps/web/src/pages/admin/Storage.tsx`）。
- 本期没有任何模块声明 `frontend.admin`（协议就位，等第一个真实案例——aftersales/
  demo 均不声明）。
- 不动 `/api/admin/storage` 的门禁（保持 `tenant:admin`，宿主域）。

## 协议扩展：`frontend.admin`

manifest 新增**可选** `frontend.admin: [{path, title, icon?, scope, entry}]`，与
`frontend.console` 同形：

```yaml
frontend:
  console: [...]
  admin:                   # 可选；本期无模块声明
    - path: /console/admin/<module>/<page>   # 必须以 /console/admin/ 开头
      title: 页面标题
      icon: SettingOutlined                 # 可选，壳侧 CONSOLE_ICONS 同规
      scope: <module>:manage                # 必须 ∈ permissions[].code
      entry: ./console/admin/<page>.tsx     # 模块内文件
```

- **门禁双层**：组门 `tenant:admin`（宿主施加）+ 页门 `entry.scope`（同 console 条目
  的 scope 判定语义）。
- **校验**（SDK schema + `check-manifests` 双拦）：path 前缀 `/console/admin/`；scope
  ∈ `permissions[].code`；entry 形状同 console。
- **判定链与 console 三重过滤同构**：registry（构建期聚合，条目带 `group:'admin'` +
  moduleId）∩ config 启用集（运行时）∩ session scopes。服务端 config **不暴露** admin
  清单——前端自判，零后端改动。
- **路由**：走 `ConsoleModulePage` 既有通配前缀匹配 + 页门。模块 admin 页与宿主
  admin 页**共享** `/console/admin/` 前缀，不冲突靠两点：宿主 admin 显式路由只占
  各自精确路径（react-router 精确优先）；registry 全局 path 唯一（同 path 首个声明者胜）。

## 存储配置页：能力联动

- gen 脚本聚合 `storageDeclarers`（扫各 manifest 的 `storage:` 字段）进
  `console-registry.gen.ts` 生成物。
- **菜单显示规则**：`tenant:admin` ∧（`storageDeclarers` ∩ config 启用模块 ≠ ∅）。
  售后关闭 → 「存储配置」从管理组消失；开启 → 出现（位置仍为管理组第 4 位）。
- **直敲 URL**：路由级同判定，未满足时渲染与模块页一致的「模块可能未启用或未发布」
  Result 提示（不是裸 404）。
- `/api/admin/storage` 保持 `tenant:admin` 门禁不动：它管理租户全局列，属宿主域；
  模块关闭时 API 仍可用是**记录在案的决定**（无消费者、数据无害），不是遗漏。

## 菜单结构

管理组 children 顺序：`用户管理 / 角色与授权 / 我的订阅`（固定）→ `存储配置`
（能力联动）→ `模块 admin 页`（`frontend.admin` 按 manifest 声明序平铺）。

## 工程面

| 文件 | 改动 |
|---|---|
| `packages/platform-sdk/src/manifest.ts` | schema + 类型加 `frontend.admin` |
| `scripts/check-manifests.mjs` | 新校验：admin 路径前缀、scope 越界、entry 形状 |
| `scripts/gen-console-registry.mjs` | 条目聚合 `group`/`moduleId`；聚合 `storageDeclarers` |
| `apps/web/src/console-registry.gen.ts` | 生成物新形状（重新生成） |
| `apps/web/src/pages/console-menu.ts` | `adminGroup` 动态化：接收联动判定所需输入 |
| `apps/web/src/pages/Console.tsx` | admin 子路由的联动门 + 存储页路由判定 |
| 测试 | console-menu 联动矩阵单测、gen 脚本 fixture、check-manifests 新规则用例 |
| `docs/module-protocol.md` | 新增 `frontend.admin` 节（正典，随本 PR） |

（`docs/architecture.md` 已核：无「管理组固定四项」既述，storage 相关表述与新设计不冲突，不改动。）

## 验收

1. 单测：联动矩阵全绿——（售后开/关 × tenant:admin 有/无 × scope 有/无）下管理组
   children 的期望集合；gen 脚本 fixture 断言 `storageDeclarers`；check-manifests 对
   非法 admin 声明（坏前缀/越界 scope）拒绝。
2. 浏览器走查：本地栈开关售后模块（DB 翻 `tenant_module.enabled`），60s 内菜单联动；
   直敲 `/console/admin/storage` 在模块关闭时出「未启用」Result。
3. 全量门禁 + PR（feat 需先建 issue）。

## 已知边界

- admin 页与 console 页同 path 冲突：沿用「同 path 首个声明者胜」的去重规（注册表
  侧既有语义），spec 不另立。
- `storageDeclarers` 是构建期事实（manifest），运行时启用集来自 config 缓存（60s TTL）
  ——联动生效窗口同订阅退订，一致。
- 本期无 `frontend.admin` 消费者，该通道的端到端验证靠 fixture 单测；第一个真实模块
  接入时应补充浏览器级验收（届时销账）。
