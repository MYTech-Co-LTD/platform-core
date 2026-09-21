# 新模块接入文档（module-onboarding）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `docs/module-onboarding.md`——一份面向「要新接一个业务模块的开发者」的接入文档，把协议、契约、约定收拢成一处，并接上双向指针。

**Architecture:** 纯文档交付。新文档管「怎么接入」，协议语义与边界的正典仍是 `docs/module-protocol.md`——本文**只留指针、不复制正文**（唯一例外：spec 全文收录的三张图、声明→效果对照表、症状速查表，它们是「接入视角的重组」，正典里没有等价物）。事实源：`packages/platform-sdk/src/manifest.ts`（机器契约）、`modules/demo`（最小模板）、`modules/aftersales`（全能力用例）。

**Tech Stack:** Markdown；校验用 `grep` + 仓库既有门禁（`pnpm test` / `pnpm typecheck` / `scripts/check-manifests.mjs` 等）。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-09-20-module-onboarding-doc-design.md`（D1–D6）。
- **不复制正典正文**：语义/边界/踩坑一律写「见 `module-protocol.md`「X」节」，不搬运文字（D1）。
- **受众止于仓内边界**：终点是「CI 全绿 + 本地装载通过」；部署/交付只留指针（指向 `deploy/openship-adopt.md`），不写 runbook 内容（D3）。
- **死字段如实标注**：`notifications` / `config.schema` / `bindings` 标「预留·无消费者」，禁止把它们描述成有效能力（D4）。
- **示例引用现文件，不内联大段代码**（避免第三份副本漂移）。
- 文档内所有反引号路径与「节名」引用**必须真实存在**——任务末步用现成命令核实。
- 提交纪律：`docs(scope): subject` 格式；可见变更走 PR（分支 `docs/module-onboarding` 已建，spec 已提交在 d5b4313）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `docs/module-onboarding.md` | 创建 | 接入指南主体（§0–§7 + 已知边界） |
| `AGENTS.md` | 修改 | 文档地图加一行：新接模块 → module-onboarding.md |
| `docs/module-protocol.md` | 修改 | 顶部加反向指针一句 |
| GitHub issue ×2 | 创建 | ① schema 死字段清理待议 ② 控制台路由门禁缺口（均不阻塞文档） |

`docs/module-onboarding.md` 分三个任务写（主干 / 能力面 / 收尾+边界），每个任务产出**可独立评审**的一批章节；最后两个任务是配套改动与交付验收。

---

### Task 1: 文档主干 §0–§4（必读 / 骨架 / manifest 参考 / 入口契约 / 迁移）

**Files:**
- Create: `docs/module-onboarding.md`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: 文档骨架与标题层级——后续任务按 `## §5 …` `## §6 …` `## §7 …` `## 已知边界` 追加同级节，不得改动本任务已建的标题文字。

- [ ] **Step 1: 写文档头与 §0**

按下列逐字内容建文件（`<id>` 等占位符仅在正文出现，路径引用一律用真实存在的文件）：

```markdown
# 新模块接入指南

> **本文管「怎么接入」**：目录骨架、manifest 全字段、入口契约、迁移纪律、验收清单、故障速查。
> **协议语义与边界的正典是 `docs/module-protocol.md`**——本文不复制其正文，只在需要处给指针。
> 机器契约源是 `packages/platform-sdk/src/manifest.ts`（zod schema）；本文与它漂移时以 schema 为准。
>
> **两份现成模板**：`modules/demo`（最小，后端 API + 一页 console）、
> `modules/aftersales`（全能力：访客面 / 租户存储 / 移动端 / 页内多页）。

## §0 接入前必读

1. `docs/architecture.md`——架构不变量（B1 跨 schema 三同、B9 env 契约、I-1 挂载顺序等）。
   不变量与本次接入冲突时，**先讨论架构，不要先写码**。
2. `AGENTS.md` 的「项目专属硬约束」1–11——每条都对应一次真实事故或评审结论。
3. 本文 §6 的验收清单——它是「接入完成」的定义。
```

- [ ] **Step 2: 写 §1 目录与工程骨架**

内容要求（手把手，逐条写成可直接照做的清单）：

```markdown
## §1 目录与工程骨架

模块住 `modules/<id>/`（`<id>` 必须小写 kebab-case，见 §2）。`pnpm-workspace.yaml` 的
globs 是 `['apps/*', 'packages/*', 'modules/*', 'modules/*/*']`——`modules/<id>/` 自动被
收纳，含子 package.json 的目录（如前端子包）也自动成为 workspace 包。

从 `modules/demo` 起步（最小可跑），需要更多能力面时对着 `modules/aftersales` 抄。

| 路径 | 何时需要 | 说明 |
|---|---|---|
| `manifest.yaml` | **总是** | 接入协议单一事实源（§2） |
| `index.ts` | **总是** | 入口：读 yaml → `ManifestSchema.parse` → `defineModule`（§3） |
| `package.json` | **总是** | `name` = 模块 id；deps 见 demo（`@platform/sdk` workspace:* + `hono` + `yaml`） |
| `tsconfig.json` | **总是** | `extends "../../tsconfig.base.json"`，`noEmit: true`（照 demo） |
| `vitest.config.ts` | 有测试时 | 照 demo（含 `vitest` 显式 paths 映射，成因见 demo 文件注释） |
| `migrations/` | 有表时 | SQL 迁移，目录名可改但须在 manifest 声明（§4） |
| `console/` | 声明 `frontend.console`/`admin` 时 | 管理台页（§5） |
| `mobile/` 等前端子包 | 声明 `frontend.userApp` 时 | 独立构建产物，`dist` 相对模块目录（§5） |
| `README.md` | 有全局表时 | 声明全局表理由（§4） |
```

- [ ] **Step 3: 写 §2 manifest 全字段参考**

内容要求：一张表覆盖 schema 全部字段（`packages/platform-sdk/src/manifest.ts`），
「谁校验」列写三层中实际生效的那些（schema 校验 / `check-manifests` 文件存在性 / 装载期双向核对）。
**逐字采用下列表格**（行序、措辞、死字段标注不要改）：

```markdown
## §2 manifest 全字段参考

契约源 `packages/platform-sdk/src/manifest.ts`。表的「校验」列：
**schema** = zod 校验（装载期与 `check-manifests` 门禁**同时**覆盖）；
**门禁** = `scripts/check-manifests.mjs` 额外的文件存在性/白名单检查；
**装载** = 装载期双向核对等运行期检查。

| 字段 | 必填 | 形状 | 语义要点 | 校验 |
|---|---|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9-]*$` | 模块命名空间（三同之一：模块 id = schema 名 = 权限前缀） | schema |
| `name` | 是 | string | 展示名 | schema |
| `version` | 是 | `x.y.z` | 宽松 semver，三段数字 | schema |
| `platform` | 是 | `^>=?[0-9]` | 平台版本约束（如 `>=0.1`）；**裸版本号不合法** | schema |
| `permissions[]` | 是 | `{code,name}[]` | 权限码清单；`code` 必须 `<id>:` 前缀 | schema |
| `api.internal[]` | 否 | `{method,path,scope}[]` | 模块 API 声明，**未声明 = 不可达**；path 模块内相对、禁裸 `/`；scope ∈ permissions | schema + 装载期双向核对 |
| `guest.scope` | 否 | string | 访客码，必须 ∈ permissions；宿主 wechat-oa 登录路按已启用模块发放 | schema |
| `storage.kind` | 否 | `'s3'`（枚举收窄） | 声明 = 宿主在本模块 API 子树注入 `c.get(TENANT_STORAGE)`；**声明的是能力不是租户** | schema |
| `frontend.console[]` | 否 | `{path,title,icon?,scope,entry}[]` | 管理台平铺页；path 不得占 `/console/admin/` 前缀；scope ∈ permissions | schema + 门禁（entry 文件存在） |
| `frontend.admin[]` | 否 | 同上 | 管理组子页；path **必须** `/console/admin/` 开头 | schema + 门禁（entry 文件存在） |
| `frontend.userApp` | 否 | `{mount,dist}` | 独立前端应用（C 端/移动端）；`dist` 相对模块目录 | schema |
| `migrations.dir` | 否 | string | 迁移目录，缺省 `migrations`；目录不存在静默跳过 | schema + 门禁（目录存在） |
| `bindings` | 否 | `Record<string,'required'\|'optional'>` | **预留·无消费者**：仅 `check-manifests` 查键白名单 `{postgres, novu, cube}`，**无任何运行时消费——声明了不会有任何效果** | 门禁（键白名单） |
| `notifications.dir` | 否 | string | **预留·无消费者**：schema 接受，当前无任何读取方——声明了不会有任何效果 | schema |
| `config.schema` | 否 | string | **预留·无消费者**：同上 | schema |

> 上面三个「预留·无消费者」字段是**已知债**（清理与否另议）。如实标注是为了防止接入者
> 以为声明了就有能力——`module-protocol.md` 开篇记的正是「一个字段死于零文档」的教训。
```

- [ ] **Step 4: 写 §3 后端入口契约**

内容要求：`defineModule` 形状、yaml 单一事实源姿势、identity 取法、不写 requireScope、路由与声明逐字一致。
**必须用下列正文**（可补一句指向 demo 现文件，不内联整段代码）：

```markdown
## §3 后端入口契约

模块入口 `index.ts` 的姿势（照 `modules/demo/index.ts`，逐行可抄）：

1. **yaml 是单一事实源**：启动时读同目录 `manifest.yaml`，经 `ManifestSchema.parse` 校验后
   交给 `defineModule`——**不在 TS 里维护第二份副本**（防漂移）。
2. **`defineModule({ manifest, createRouter })`**：`createRouter(ctx)` 的 `ctx` 是
   `ModuleContext = { pool }`——数据库连接由宿主给，**模块零连接代码**。
3. **身份由宿主注入**：路由里用 `c.get('identity')`（`Identity` 类型从 `@platform/sdk` 导出，
   含 `userId`/`orgId`/`displayName`/`scopes`/`hasScope()`）。模块内自建
   `new Hono<{ Variables: { identity: Identity } }>()` 拿到类型检查。
4. **不写 `requireScope`**：门禁由宿主按 `api.internal` 声明**强制施加**；模块再写一遍是冗余。
   漏写不会导致匿名可读——未声明的 `(method, path)` 一律 403，装载期双向核对还把
   「注册了没声明」变成装载失败。
5. **路由路径与声明逐字一致**：`createRouter` 里注册的每条 `(method, path)` 都要在
   `api.internal` 里有一条声明，反之亦然——两个方向的差集都让**装载失败（进程起不来）**。
   路径含 `:param` 时声明里也要写 `:param`。
6. **多租户写入必带 org**：读写一律按 `c.get('identity')!.orgId` 过滤（§4）。

声明写法的细则（裸 `/` 为何被拒、`*` 的子树语义、exact-ALL 的已知放松）见
`module-protocol.md` 的「规则：没声明 = 不可达」与「装载期双向核对（fail-fast）」两节。
```

- [ ] **Step 5: 写 §4 数据库与迁移**

内容要求：三同纪律、org 三条纪律指针、迁移幂等要求、执行时机、全局表豁免标记。
**必须用下列正文**：

```markdown
## §4 数据库与迁移

**三同纪律**：模块的表建在**本模块 schema**（= manifest `id`）。`create table` 建到别处或不
限定 schema，`scripts/check-tenant-isolation.mjs` 一律判违规（建到别处 = 门禁看不见 = 静默放行）。

**租户数据表三条纪律**（正典详解见 `module-protocol.md`「租户数据隔离」节）：

1. 租户数据表必须带 `org text not null` 列，值 = `identity.orgId`；读写一律 `where org = $1`。
2. 唯一约束必须含 org：`unique(org, …)`（无业务唯一键的表不适用）。
3. 热路径索引以 org 为前缀列。

**全局表**（字典/配置类跨租户共享）可不带 org，但要在模块 README 声明理由，**并且**在建表
语句上方紧贴一行 `-- global-table: <理由>`（理由是必填、标记必须紧贴 DDL）。细节见
`docs/module-protocol.md`「租户数据隔离」节与「租户隔离 CI 门禁」节。

**迁移执行**：`apps/server/src/migrate.ts` 按 `platform.schema_migrations(module, version)`
主键记账——**同一批迁移重复执行是幂等的**（版本已在账本里就跳过）。因此：

- DDL 一律 `create table if not exists` / `add column if not exists` / `create index if not exists`；
- 视图一律 `drop view if exists` + `create view`（**不要** `create or replace view`，见团队规则 `~/.claude/rules/common/db-migration.md`）；
- 来自外部系统的字段一律 `text`，不用 `varchar(n)`；
- 目录不存在静默跳过——没有表的模块不需要 `migrations/`。

文件命名与版本号自愈姿势可参考 `modules/demo/migrations/`（含一条「账本幽灵记录」的处置注释）。
```

- [ ] **Step 6: 核实本文档内所有路径与节名引用真实存在**

Run:
```bash
grep -oE '`[A-Za-z0-9_./-]+\.(md|ts|tsx|mjs|json|yaml|sql)`' docs/module-onboarding.md \
  | tr -d '`' | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```
Expected: 无输出（无 `MISSING:` 行）。占位路径（形如 `modules/<id>/…`）不被该正则捕获，属正常。

再核正典节名引用（**用 python3 提取**，理由见下）：

```bash
python3 -c "
import re
s=open('docs/module-onboarding.md',encoding='utf-8').read()
print('\n'.join(sorted(set(re.findall(r'「[^」]+」',s)))))
"
```

> ⚠️ **2026-09-20 订正（本条曾写错，勿回退）**：本命令原写作「**必须**用 python3：实测
> `grep -oE '「[^」]+」'` 在本机会静默丢结果，多字节方括号表达式不靠谱」。**该结论是假的**——
> `grep -oE '「[^」]+」' <file> | wc -l` 与 python `len(re.findall(...))` 在同一份真文档上是
> **53 vs 53，逐条相同**，grep 无辜。
>
> 真根因：当时的比较管道里有个 **`sort -u`**——macOS 的 `sort -u` 在 `en_US.UTF-8` 下会把
> **互不相同的中文串判为相等并去重**（实测：10 个不同中文词 ⇒ 剩 1 条；`LC_ALL=C sort -u`
> 才正常 10 条；`sort` 不加 `-u` 也正常）。于是「少掉的」全是 `sort -u` 折叠的，与 grep 无关。
>
> **教训（比结论本身更值钱）**：拿「工具 A 的输出集合」与「工具 B 的输出集合」对比来判定某个
> 工具坏了之前，先确认**两边的集合运算语义一致**（尤其排序/去重所用的 locale）——否则你测的是
> 自己的管道，不是被怀疑的那个工具。对本仓的实操含义：**含非 ASCII 的去重比较一律先钉 locale**
> （`LC_ALL=C sort -u`），或直接用 python 的 `set`。经验已沉淀进 WeKnora「研发运维经验库」。
逐条确认每个节名在 `docs/module-protocol.md` 里以 `##`/`###` 标题**存在**——判据是
**标题前缀匹配**（正典标题常带括注，如 `## 租户数据隔离（spec-1 §2，2026-09-14）`，书名号内写
`租户数据隔离` 即命中；要求「逐字全等」会与本文自己的写法冲突）。

- [ ] **Step 7: 提交**

```bash
git add docs/module-onboarding.md
git commit -m "docs(onboarding): 新模块接入指南主干——目录骨架/manifest 全字段/入口契约/迁移"
```

---

### Task 2: §5 能力面（心智模型 + 三图 + 声明→效果对照表 + 各能力面）

**Files:**
- Modify: `docs/module-onboarding.md`（在 §4 之后追加 `## §5 能力面按需接入`）

**Interfaces:**
- Consumes: Task 1 建的文档骨架（标题层级 `## §N`）；不得改动 §0–§4 文字
- Produces: `## §5 能力面按需接入` 节——Task 3 在其后追加 §6/§7

- [ ] **Step 1: 写 §5 开头的心智模型（壳 vs 应用）**

**逐字采用**（含三张 ASCII 图，原样从 spec 搬运）：

````markdown
## §5 能力面按需接入

### 心智模型：一个壳，模块交付「页」

**管理后台是单一壳**（`apps/web`，React + ProLayout），模块交付的是**页**：构建期由
`scripts/gen-console-registry.mjs` 聚合成 `apps/web/src/console-registry.gen.ts`，运行时壳做
**三重过滤**（config 启用集 ∩ registry 已挂载 ∩ session scope）出菜单，命中后 lazy load 模块
entry 的 default 导出、渲染进壳的 `Outlet`，共享壳的布局/主题/会话（`ConsoleOutletContext`）。

**没有「进入应用 → 独立菜单体系」这回事。** 要独立 UI 的是 C 端场景，走 `frontend.userApp`
（真独立构建，挂 `/app/<id>`，如 aftersales 的 Vue 移动端）。

**行业参照**：本平台 = Stripe / Grafana 系（统一壳 + 页聚合 + 页内自绘导航），
不是 Odoo / Salesforce 系（app 切换器 + 每 app 独立菜单）——后者是 40+ app 重套件的形态，
本平台模块数量级不需要。

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

声明怎么变成菜单：

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
        （任何一项不过 ⇒ 菜单不出。注意这是「菜单」的过滤——
          路由层另按 registry ∩ session scope 兜底，不含 config，见「已知边界」）
```

**两级菜单**：壳侧栏一条（**协议管**：扁平数组、不支持嵌套、显隐三重过滤）+ 页内导航
**模块自绘**（**协议不管**）：

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
````

- [ ] **Step 2: 写「声明 → 可见效果」对照表**

**逐字采用**：

```markdown
### 声明了会发生什么（先看这张表建立预期）

| 你声明了… | 管理台上发生什么 |
|---|---|
| `frontend.console[]` 条目 | 菜单**平铺**一条 = 一页（协议不支持嵌套；多页面收一个条目、页内真子路由分区——`modules/aftersales/console/index.tsx` 是现成姿势）；显隐 = registry ∩ config 启用集 ∩ session scope 三重过滤；**一个条目 = 侧栏一项 + 页内自绘导航** |
| `frontend.admin[]` 条目 | 进**管理组 children**，顺序：平台内置三项 → 存储配置 → 模块 admin 页（manifest 声明序）；三条约法（`/console/admin/` 前缀 / scope ∈ permissions / console 条目禁占该前缀）。⚠️ **组门 `tenant:admin` 目前只由菜单侧施加**——模块 admin 页走 `*` 通配的 `ConsoleModulePage`（`registry ∩ 页门 scope`），`AdminGate` 只包住平台内置四项 |
| `storage: {kind: s3}` | **触发租户管理台「存储配置」页可见**（能力联动：`storageDeclarers ∩ 启用模块 ≠ ∅` 才显示/可达）；运行时 `c.get(TENANT_STORAGE)` 取本租户配置 |
| 模块被停用 | **菜单面**：菜单不出（三重过滤含 config）。**路由面**：模块页/模块 admin 页走 `registry ∩ session scope`，**不查 config** ⇒ 持码用户直敲 URL 仍可打开该页。唯一由 config 驱动的路由门是 `/console/admin/storage` 的 `StorageGate`。API 面 404（与「不存在」同形） |

> ⚠️ 上表第 2、4 行是 **2026-09-20 实测订正**后的口径，**不要回退**成「菜单与页面同隐」那种
> 把菜单与路由混为一谈的写法。证据（写 §5 时可引用）：`apps/web/src/App.tsx:30` 模块页落 `*`
> 通配；`Console.tsx` 的 `ConsoleModulePage` 只判 `registry` + `session.scopes`，无 config 查询；
> `App.tsx:26-29` 的 `AdminGate` 只包内置四项；`apps/server/src/session-middleware.ts:193` 普通
> 会话 scopes 来自 Casdoor（非按启用模块过滤）。缺口记录在案，修复另议（不在本计划范围）。
```

> 🕰 上块（逐字采用）的「组门 `tenant:admin` 只由菜单侧施加」「路由面不查 config」是 **#127 之前**
> 的实测口径。该口径**已于 #127 反转**（2026-09-21）：路由层接入 config 启用集、模块 admin 页路由套
> `AdminGate`。以 `docs/module-protocol.md` 现行正文为准，**勿按上块「不要回退」的祈使句照抄**。

- [ ] **Step 3: 写各能力面字段细节**

内容要求：五个能力面各一小节，每节 = 字段形状 + 最小示例（引用现文件）+ 语义指针。**必须覆盖**：

1. **`frontend.console`**——字段五项；**菜单与路由是两套判定**（必须写清：菜单 = `registry ∩ config 启用集 ∩ session scope`；路由 = 落 `*` 通配的 `ConsoleModulePage`，只判 `registry ∩ session scope`，**不查 config**）；`icon` 走壳侧 `CONSOLE_ICONS` 白名单（**未登记的名字不渲染图标**，需要新图标要先在壳里登记——现成反例：`modules/aftersales` 声明 `icon: ToolOutlined` 未登记，该菜单项实际无图标）；多页面姿势（声明 1 条 + 页内子路由）；两个实测坑 → 见 §7。
2. **`frontend.admin`**——字段五项 + 三条约法；**门禁必须如实写**：菜单侧有组门 `tenant:admin`，但模块 admin 页走 `*` 通配的 `ConsoleModulePage`、只判页门 scope，**直敲 URL 时不套 `AdminGate`**（详见「已知边界」）；本期零真实消费者。
3. **`frontend.userApp`**——`mount` 与前端工程 `base` **必须一致**（不一致 ⇒ 产物引用错前缀）；`dist` 相对**模块目录**解析；停用 ⇒ 静态与 API 面同时 404（`module-protocol.md`「停用语义」节）。
4. **`guest.scope`**——访客码语义与发放路径，指针 `module-protocol.md`「停用语义」节的 guest 段。
5. **`storage`**——声明姿势、`TENANT_STORAGE` 取法、部分填写不回落、连通性验证必须在请求路径之外（管理端保存时探测 + 「测试连接」动作），指针 `module-protocol.md`「租户级配置注入：`storage`」节。

> 🕰 上面第 1、2 条要求写进文档的「菜单与路由是两套判定」「直敲 URL 时不套 `AdminGate`」是
> **#127 之前**的口径，**已于 #127 反转**（路由层吃 config + 模块 admin 页过组门）。以
> `docs/module-protocol.md` 现行正文为准，**勿按本步照写**。

- [ ] **Step 4: 核实新增内容的路径与节名引用**

Run:
```bash
grep -oE '`[A-Za-z0-9_./-]+\.(md|ts|tsx|mjs|json|yaml|sql)`' docs/module-onboarding.md \
  | tr -d '`' | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
python3 -c "
import re
s=open('docs/module-onboarding.md',encoding='utf-8').read()
print('\n'.join(sorted(set(re.findall(r'「[^」]+」',s)))))
"
```
Expected: 第一条无输出；第二条逐条在 `docs/module-protocol.md` / `apps/web` 源码中找到对应标题或标识符（如 `storageDeclarers`、`ConsoleOutletContext`、`CONSOLE_ICONS` 确实存在于源码）。
（第二条用 `grep -oE` 或 python 都可以——**grep 本身没问题**；含非 ASCII 的**去重比较**才要钉
locale，见 Task 1 Step 6 的订正说明。）

核实命令（对标识符）：
```bash
grep -rn 'CONSOLE_ICONS\|ConsoleOutletContext' apps/web/src/pages/Console.tsx | head
grep -rn 'storageDeclarers' apps/web/src/console-registry.gen.ts scripts/gen-console-registry.mjs | head
```

- [ ] **Step 5: 提交**

```bash
git add docs/module-onboarding.md
git commit -m "docs(onboarding): 能力面——心智模型三图/声明→效果对照表/console·admin·userApp·guest·storage"
```

---

### Task 3: §6 验收清单 + §7 故障速查 + 已知边界

**Files:**
- Modify: `docs/module-onboarding.md`（追加 `## §6`、`## §7`、`## 已知边界`）

**Interfaces:**
- Consumes: Task 1/2 的章节
- Produces: 完整文档——Task 4/5 只做配套与验收，不再改正文

- [ ] **Step 1: 写 §6 接入验收清单**

**必须用下列正文**（命令逐字来自仓库 root `package.json` 与 `.github/workflows/ci.yml`；
注意：写入文档时外层用四个反引号围栏，因为正文里含 bash/ts 代码块）：

````markdown
## §6 接入验收清单

全量命令见 `README.md` §常用命令。模块接入后至少跑通：

```bash
pnpm install                  # 收纳新 workspace 包
pnpm test                     # 递归各包 test + scripts/ 守卫单测
pnpm typecheck                # 递归 tsc --noEmit + scripts/
pnpm exec tsx scripts/check-manifests.mjs        # manifest schema + entry/migrations 文件存在性
pnpm exec tsx scripts/lint-architecture.mjs      # 架构不变量
pnpm exec tsx scripts/check-tenant-isolation.mjs # 真库对账：本模块 schema 每张表都有 org 列（**需 DATABASE_URL**，且该库要有 CREATEDB 权限——它自建一次性库；缺了会响亮失败）
pnpm smoke                    # 装载冒烟（需 DATABASE_URL，且先 pnpm --filter @platform/web build **与 pnpm --filter @aftersales/mobile build**——它硬检查移动端产物）
```

CI 四个门禁 job（`unit` / `gates` / `web` / `smoke`）覆盖上面这些——`gates` 另外还跑
`check-compose` / `check-env-example` 与提交纪律守卫，是**超集**，别写成「就是这些」；全绿才算接入完成。
装载期检查会额外咬人：**注册路由与 `api.internal` 声明的任一方向差集 ⇒ 装载失败**（进程起不来）。
构建期还有一条：**两个模块声明同一条 `frontend.console[].path` ⇒ `gen-console-registry` 硬失败**
（菜单是按 path 聚合的，重复即二义）。

**给模块测试加一条匿名探测**（`module-protocol.md`「调试：匿名探测」节）——用
`probeAnonymous` 断言每条已声明路由在无 identity 时都是 401，比相信代码里写了什么更硬：

```ts
import { probeAnonymous } from '@platform/sdk/test-util/anonymous-probe'

const results = await probeAnonymous(mountedApp) // 期望每条都是 401
```
````

- [ ] **Step 2: 写 §7 故障速查**

**必须用下列内容**（症状 → 病因 → 出路；**后端一张表 + 前端一张表**，别把前端症状挂在
`### 后端` 下）：

```markdown
## §7 故障速查

### 后端

| 症状 | 病因 | 出路 |
|---|---|---|
| 端点恒 403 | ① 身份缺该端点的 scope 码（`403 {"error":"FORBIDDEN","need":"<code>"}`——最常见：Casdoor 未授权或角色没挂这个码） ② 请求了已声明路径上**未声明**的 method（`403 {"error":"FORBIDDEN"}`） ③ 声明路径相对/绝对混用（门卫比对基准是宿主**绝对** `routePath`） | ①② 见 `module-protocol.md`「门卫的判定顺序」节；③ 的机制另见同文「实现注意（踩过的坑，勿重蹈）」节 |
| 进程起不来（装载失败） | 注册路由与声明的**双向差集** | 读失败信息里的差集原文（带 `未声明但已注册 […]；已声明但未注册 […]`） |
| 停用模块的 API 面是 404（不是 403） | 停用语义**有意如此**（404 与「不存在」同形 ⇒ 模块 API 面内不可枚举） | `module-protocol.md`「停用语义」节 |
| `c.get(TENANT_STORAGE)` 恒 `undefined` | ① manifest 没声明 `storage` ② 租户行**部分填写**（绝不回落平台桶） ③ 投影中间件挂载顺序错 | `module-protocol.md`「租户级配置注入」节 |

> ⚠️ **裸 `/` 与 scope ∉ `permissions` 不表现为 403**——它们是 schema 拒（`ManifestSchema` 直接
> 拒绝 ⇒ 装载失败 / `check-manifests` 红），见 §2 的「校验」列。别在这张表里找它们。

### 前端

| 症状 | 病因 | 出路 |
|---|---|---|
| 模块页整块空白、零报错 | 用了嵌套 `<Routes>`——模块页挂在壳的 splat 路由 `*` 之下，嵌套路由按 splat 剩余段匹配，永远匹配不上 | 按 pathname 末段直接选页（照 `modules/aftersales/console/index.tsx`） |
| 点页签跳到别的路径（模块段丢失，如 `/console/rules`） | 相对导航以壳的 splat 路由为基准解析 | 导航一律用**绝对路径** |
| 管理台 `message.*` 抛 TypeError | 壳里 antd `<App>` 提供者缺失（`useApp` 是裸 `useContext`） | 已由 `Console.tsx` 的 `<AntdApp>` 覆盖；模块页不需要自己加 |
| 模块停用后直敲模块页 URL 仍能打开（菜单已消失） | **实现缺口**：路由层不含 config——模块页/模块 admin 页都落 `/console` 的 `*` 通配（`apps/web/src/App.tsx:30`），`ConsoleModulePage` 只按 `registry ∩ session scope` 放行（`apps/web/src/pages/Console.tsx`） | 「已知边界」路由层不吃 config 条（#125 spec 的「门禁双层」自相矛盾，缺口记录在案、修复另议）；真正由 config 驱动的路由门只有 `/console/admin/storage` 的 `StorageGate` |
| 访问 `/app/<id>` 拿到的是控制台壳（不是模块前端） | `frontend.userApp.dist` 目录不存在 ⇒ 装载器**静默跳过**（不报错）：静态挂载与 SPA fallback 都没挂，请求落到控制台顶层 `*` 路由 | 先构建前端子包（`pnpm --filter <pkg> build`）；CI 的移动端产物检查只覆盖 `modules/aftersales/mobile`，新模块要自己保证 |

> 前端表的空白页 / 丢模块段两条是 aftersales M3a 浏览器实测抓到的，正典里没有等价
> 记载——它们只在 `modules/aftersales/console/index.tsx` 的注释里，本表把它提到接入视角。
```

> 🕰 上表「模块停用后直敲模块页 URL 仍能打开（菜单已消失）」一行是 **#127 之前**的实现缺口口径。
> 该口径**已于 #127 反转**（2026-09-21）：路由层吃 config ⇒ 直敲出「模块可能未启用」Result；模块
> admin 页另过组门 `AdminGate`。以 `docs/module-protocol.md` 现行正文为准，**勿按该行照抄**。

- [ ] **Step 3: 写「已知边界」**

**必须用下列正文**（四条，逐字采用概念，可直接抄；第一条是路由门禁缺口，勿删——§5 的前向
引用指向它）：

```markdown
## 已知边界

- **路由层不吃 config（2026-09-20 实测）**：停用模块的**菜单**会消失，但**页面本身**没有 config
  路门——模块页与模块 admin 页都落 `/console` 的 `*` 通配（`apps/web/src/App.tsx:30`），由
  `ConsoleModulePage` 只按 `registry ∩ session scope` 放行（`Console.tsx`），持码用户直敲 URL
  仍可打开；模块 admin 页同样**不套**组门 `AdminGate`（它只包住平台内置四项，`App.tsx:26-29`）。
  真正由 config 驱动的路由门只有 `/console/admin/storage` 的 `StorageGate`。这是**实现缺口**
  （#125 spec 的「门禁双层」与它自己的「路由」条自相矛盾），缺口记录在案、修复另议。
- **manifest 三个字段是预留（无消费者）**：`notifications.dir`、`config.schema`（schema 接受、
  无人读取）、`bindings`（仅 `check-manifests` 查键白名单，无运行时消费）。声明它们**不会有
  任何效果**——见 §2 表。清理与否另议。
- **`frontend.admin` 本期零真实消费者**：协议与联动逻辑已交付（fixture 级验证覆盖），但还没有
  真实模块用它。第一个真实模块接入时要补**浏览器级**验收（沿 2026-09-20 spec 的待销账）。
- **平铺菜单在模块多了会破**：侧栏模块条目是平铺的（协议不支持嵌套），行业经验约 7±2 项。
  届时的演进先例是 Grafana 的做法——section 分组 + 排序权重 + **管理员侧** placement 配置
  （与本平台「模块作者 manifest 决定序」不同）。现在不做（YAGNI），方向先钉住。
```

> 🕰 上块第 1 条「路由层不吃 config」是 **#127 之前**的实现缺口口径，**已于 #127 反转**（缺口即
> #127 的立项对象；修复后 `docs/module-onboarding.md` 的「已知边界」节已删去该条，不再有路由门禁
> 缺口条目）。以 `docs/module-protocol.md` 现行正文为准，**勿按上块（含「第一条勿删」的前向引用）照写**。

- [ ] **Step 4: 核实文档完整性**

Run:
```bash
grep -n '^## ' docs/module-onboarding.md
```
Expected: 依次出现 `## §0 接入前必读`、`## §1 目录与工程骨架`、`## §2 manifest 全字段参考`、
`## §3 后端入口契约`、`## §4 数据库与迁移`、`## §5 能力面按需接入`、`## §6 接入验收清单`、
`## §7 故障速查`、`## 已知边界`——九节齐全、无缺号。

Run: `pnpm exec tsx scripts/check-manifests.mjs`
Expected: 通过（文档改动不影响 manifest）。

- [ ] **Step 5: 提交**

```bash
git add docs/module-onboarding.md
git commit -m "docs(onboarding): 补验收清单/故障速查/已知边界——文档主体交付完成"
```

---

### Task 4: 配套改动（AGENTS.md 文档地图 + 正典反向指针 + 正典口径订正）+ 两个 issue

**Files:**
- Modify: `AGENTS.md`（「文档地图（动手前先读对应的）」表）
- Modify: `docs/module-protocol.md`（顶部引言块；「模块管理页：`frontend.admin`」节的「显隐联动」bullet）
- Create: GitHub issue ×2（`gh issue create`）

**Interfaces:**
- Consumes: Task 1–3 交付的 `docs/module-onboarding.md`（指针目标必须已存在）
- Produces: 双向指针闭环；两个 issue 编号（写进 PR 描述）

- [ ] **Step 1: AGENTS.md 文档地图加一行**

在 `AGENTS.md` 的文档地图表中，`| 设计稿与实施计划 | … |` 行**之前**插入一行（逐字）：

```markdown
| 新接一个业务模块 | `docs/module-onboarding.md`（接入步骤/全字段参考/验收清单/故障速查）；协议语义正典仍是 `docs/module-protocol.md` |
```

- [ ] **Step 2: 正典顶部加反向指针**

在 `docs/module-protocol.md` 的引言块（第 3–7 行的 `> …` 引用块）**末尾**追加一行（逐字）：

```markdown
>
> **接入视角的指南见 `docs/module-onboarding.md`**——本文是语义与边界的正典，那份文档管
> 「怎么接入」（步骤、属性全字段参考、验收清单、故障速查），不复制本文正文。
```

- [ ] **Step 2b: 订正正典的「显隐联动」口径（2026-09-20 实测）**

`docs/module-protocol.md` 的「模块管理页：`frontend.admin`」节里，「**显隐联动**」bullet 现写作
「菜单/路由 = registry（构建期聚合）∩ config 启用集（运行时）∩ session scope」「模块停用 ⇒ 页面
消失（菜单不出、直敲出「模块可能未启用」Result）」。**这与实现不符**，改为（逐字）：

```markdown
- **显隐联动（2026-09-20 实测订正）**：**菜单与路由是两套判定**，别混为一谈——
  - **菜单**（侧栏）= registry（构建期聚合，`group:'admin'`）∩ config 启用集（运行时，订阅/
    `tenant_module`）∩ session scope。模块停用 ⇒ **菜单不出**。
  - **路由**（直敲 URL）= `ConsoleModulePage`（`/console` 下的 `*` 通配）只判 registry ∩
    session scope，**不查 config**；模块 admin 页同样落该通配，**不套**组门 `AdminGate`
    （它只包住平台内置四项）。⇒ 停用模块的页面对**持码用户**直敲仍可打开。
  - 唯一由 config 驱动的路由门是 `/console/admin/storage` 的 `StorageGate`
    （`storageDeclarers ∩ 启用模块 ≠ ∅`）。
  - 证据：`apps/web/src/App.tsx:26-30`、`apps/web/src/pages/Console.tsx` 的
    `ConsoleModulePage`/`AdminGate`/`StorageGate`、`apps/server/src/session-middleware.ts:193`。
  - ⚠️ 「停用 = 该租户看不到这个模块」在 **API 面与 userApp 面**照旧成立（见「停用语义」节）；
    上面说的是**控制台路由面**的实现缺口，缺口记录在案、修复另议。
```

> 为什么必须一起改：正典是唯一事实源，只改新文档会让两边对同一件事各说各话。

**同一节还有一处同类错述**（「语义」bullet 上方的 :192-193），一并改：

```
- **语义**：模块自有的「管理」组子页。两层权限——组门 `tenant:admin` + 页门 `scope`（同
  console 条目判定）；⚠️ 组门目前**只在菜单侧**生效（见下条「显隐联动」）。
```

（原标题「门禁双层」改成「两层权限」是刻意的：原措辞暗示两层在同一处强制，与实测不符。
⚠️ 同文件讲**存储投影**的那处「宿主施加门禁」**不要动**——它说的不是门禁。）

**同一节还有第三处同源错述**（「服务端 config 不暴露 admin 清单」条），一并改：

```
- **服务端 config 不暴露 admin 清单**：前端**菜单**按 registry∩config 自判（**路由**面见上条——
  只按 registry∩scope），零后端改动。
```

> 🕰 本 Step 2b 要求把正典「显隐联动」改成「**菜单与路由是两套判定**」的整套文本，**已于 #127 反转**：
> 正典现行正文是「菜单与路由**同一套判定**」（路由吃 config 启用集 + 模块 admin 页过组门
> `AdminGate`），本步的三个订正块（显隐联动 / 两层权限 / config 不暴露 admin 清单）全部作废。
> 以 `docs/module-protocol.md` 现行正文为准，**勿按本步照抄**。

- [ ] **Step 3: 核实双向指针与订正落地**

Run:
```bash
grep -n 'module-onboarding' AGENTS.md docs/module-protocol.md
grep -n '菜单与路由是两套判定' docs/module-protocol.md docs/module-onboarding.md
```
Expected: 第一条 `AGENTS.md` 1 处、`docs/module-protocol.md` 1 处；
第二条两个文件各命中（正典订正 + 新文档同口径）。
（**不要把 `docs/module-onboarding.md` 放进第一条 grep**——它的 H1 是「新模块接入指南」，
文件名不自指，期望它命中是错的。）

> 🕰 本步第二条 grep（`菜单与路由是两套判定`）的口径**已于 #127 反转**：两份文档里那段文本已被删改，
> 该 grep 现在**本就不该命中**——**不要为了让它变绿而把旧口径写回文档**。以 `docs/module-protocol.md`
> 现行正文为准。

- [ ] **Step 4: 开两个 issue（死字段清理待议 + 控制台路由门禁缺口）**

**4a — 死字段清理待议：**

Run:
```bash
gh issue create \
  --title "chore(sdk): manifest 预留字段清理待议（notifications/config.schema/bindings）" \
  --body "$(cat <<'EOF'
实测（2026-09-20，写新模块接入文档时发现）：

| 字段 | 现状 |
|---|---|
| `notifications.dir` | schema 接受，**零消费者**（无任何读取方） |
| `config.schema` | schema 接受，**零消费者** |
| `bindings` | 仅 `packages/platform-sdk/src/checks.ts` 的 `BINDING_KEYS`（`{postgres, novu, cube}`；经 `scripts/check-manifests.mjs` 调用）查键白名单，**无运行时消费** |

三者均为「声明了不会产生任何效果」。已在 `docs/module-onboarding.md` §2 表与「已知边界」节
如实标注为「预留·无消费者」（不阻塞文档交付）。

待议：删除？还是补齐消费者？或明确标注为规划中能力（若是，需写明目标版本与用途）。

背景：`docs/module-protocol.md` 开篇记的正是「一个字段死于零文档」的教训——本 issue 是该
教训的镜像应用（字段活着但无消费者，同样需要如实披露）。
EOF
)"
```
Expected: 输出新 issue 的 URL；记下编号供 PR 描述使用。

**4b — 控制台路由门禁缺口（2026-09-20 实测）：**

Run:
```bash
gh issue create \
  --title "fix(web): 控制台路由层不吃 config——停用模块的页面对持码用户仍可直达；模块 admin 页缺组门" \
  --body "$(cat <<'EOF'
## 现象

`docs/module-protocol.md` 曾写作「菜单/路由 = registry ∩ config ∩ session scope」「模块停用 ⇒
页面消失（菜单不出、直敲出「模块可能未启用」Result）」。2026-09-20 写模块接入文档时实测：

| 层 | 实际判定 | 证据 |
|---|---|---|
| 侧栏菜单 | `registry ∩ config 启用集 ∩ session scope` | `apps/web/src/pages/console-menu.ts:86-104` |
| **模块页路由** | **`registry ∩ session scope`，不查 config** | `Console.tsx` 的 `ConsoleModulePage`（`apps/web/src/App.tsx:30` 的 `*` 通配） |
| **模块 admin 页路由** | 同上，且**不套**组门 `tenant:admin` | `App.tsx:26-29` 的 `AdminGate` 只包平台内置四项 |
| `/console/admin/storage` | `storageDeclarers ∩ 启用模块 ≠ ∅` | `Console.tsx` 的 `StorageGate`（**唯一** config 驱动的路由门） |

辅证：`apps/server/src/session-middleware.ts:193` 普通会话 scopes 来自 Casdoor，**不按启用模块
过滤**（只有访客路 :176 按已启用模块重算）⇒ 停用模块的页对持码用户直敲可达；有页 scope 但无
`tenant:admin` 的用户可直敲进模块 admin 页。

测试面：`Console.test.tsx` **已有**路由级用例（②c 无 scope 直敲模块页 → 403；⑧ 直敲
`/console/admin/storage` → 未启用 Result），但**没有**覆盖本缺口的两条：
(a) 停用模块 + 持有该 scope 的用户直敲模块页仍可打开（config 维度无断言）；
(b) 模块 admin 页路由缺 `tenant:admin` 组门（无断言）。

## 影响

- 「停用 = 该租户看不到这个模块」在**控制台路由面**不成立（API 面与 userApp 面照旧成立）。
- 模块 admin 页的「组门 `tenant:admin`」在直敲路径上不存在。

## 待议（两个独立决定）

1. 模块页路由是否吃 config（停用 ⇒ 与菜单同隐）？若要，`ConsoleModulePage` 需接 `config`。
2. 模块 admin 页是否套 `AdminGate`（组门）？#125 spec 自身矛盾：门禁双层 bullet 说要，路由 bullet
   说走 `ConsoleModulePage` + 页门。

注：两条都会改变用户可见行为，需独立 spec 与验收（含直敲 URL 的浏览器级用例）。

背景：写 `docs/module-onboarding.md` 时发现，文档已按**实测**口径如实描述（见该文档 §5 与
「已知边界」节），正典 `module-protocol.md` 同步订正。
EOF
)"
```
Expected: 输出新 issue 的 URL；连同 4a 的编号一起写进 PR 描述。

- [ ] **Step 5: 提交**

```bash
git add AGENTS.md docs/module-protocol.md
git commit -m "docs(agents): 文档地图加模块接入指南行 + 正典补反向指针并订正控制台显隐口径"
```

---

### Task 5: 全量验收与 PR

**Files:**
- 无新增文件；跑门禁 + 开 PR

**Interfaces:**
- Consumes: Task 1–4 全部产出
- Produces: 合并进 main 的 PR

- [ ] **Step 1: 跑全量门禁**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: 全绿。

- [ ] **Step 2: 跑五个守卫脚本**

Run:
```bash
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-tenant-isolation.mjs   # 需 DATABASE_URL（真库对账）
```
Expected: 五条全过。

- [ ] **Step 3: 全文档指针终检**

Run:
```bash
grep -oE '`[A-Za-z0-9_./-]+\.(md|ts|tsx|mjs|json|yaml|sql)`' docs/module-onboarding.md \
  | tr -d '`' | sort -u | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
grep -c '^## ' docs/module-onboarding.md
```
Expected: 第一条无输出；第二条 = 9（九节齐全）。

- [ ] **Step 4: 推送并开 PR**

```bash
git push -u origin docs/module-onboarding
gh pr create --title "docs(onboarding): 新模块接入指南——协议/契约/约定收拢成一处" \
  --body "$(cat <<'EOF'
## 做了什么

新建 `docs/module-onboarding.md`：面向「要新接一个业务模块的开发者」的接入文档，
把散落在正典各节、demo 代码注释、aftersales 实践里的接入知识收拢成一处。

- 九节：必读 / 目录骨架 / manifest 全字段参考 / 后端入口契约 / 数据库与迁移 /
  能力面（心智模型 + 声明→效果对照表）/ 验收清单 / 故障速查 / 已知边界
- **不复制正典正文**，语义与边界一律留指针（`docs/module-protocol.md`）
- 三张 ASCII 图讲清「一个壳 + 模块页」的运行时形态（对齐行业 Stripe/Grafana 系，
  明确不是 Odoo/Salesforce 的 app 切换器形态）
- 故障速查把 aftersales 浏览器实测抓到的两个前端坑（空白页 / 丢模块段）提到接入视角
- 配套：`AGENTS.md` 文档地图加行 + 正典顶部反向指针

设计依据：`docs/superpowers/specs/2026-09-20-module-onboarding-doc-design.md`

## 如实标注的已知债

manifest 的 `notifications.dir` / `config.schema` / `bindings` 经实测**无消费者**
（或仅白名单校验），文档标为「预留·无消费者」。

**相关 issue（本 PR 只记录、不修复，故不写 Closes——写了会在合并时误关）：**
- #126 死字段清理待议
- #127 控制台路由门禁缺口（模块页路由不吃 config + 模块 admin 页缺组门）

> 注：#127 的正文在评审中修正过一次（原写的「路由门禁无测试」不成立——
> `Console.test.tsx:407`/`:366` 已有路由级用例；真实缺口收窄为 (a) config 维度无断言
> (b) admin 页组门无断言）。

## 验收

- 全量门禁（test / typecheck / 五个守卫脚本）全绿
- 文档内所有路径与节名引用经脚本核实真实存在
EOF
)"
```
Expected: 输出 PR URL；等 CI 全绿后合并（**合并只等 CI CLEAN**）。

---

## Self-Review

**1. Spec coverage：**

| spec 节 | 覆盖任务 |
|---|---|
| §3 骨架九节 | Task 1（§0–§4）、Task 2（§5）、Task 3（§6/§7/已知边界） |
| §3.1 心智模型 | Task 2 Step 1 |
| §3.2 三张图 | Task 2 Step 1（逐字） |
| §3.3 对照表 | Task 2 Step 2（逐字） |
| §3.4 症状速查 | Task 3 Step 2（**后端 4 条 + 前端 5 条**；比 spec §3.4 的 4+2 多 antd App、「停用后仍可直达」、「`/app/<id>` 返回控制台壳」三行） |
| §4 配套交付 1（正文） | Task 1–3 |
| §4 配套 2（AGENTS.md） | Task 4 Step 1 |
| §4 配套 3（反向指针） | Task 4 Step 2 |
| §4 配套 4（死字段 issue） | Task 4 Step 4 |
| §5 验收标准 | Task 3 Step 4、Task 5 Step 1–3 |
| §6 已知边界 | Task 3 Step 3 |
| D6 行业参照系 | Task 2 Step 1（心智模型末段） |
| D6 演进先例 | Task 3 Step 3（已知边界第三条） |

无缺口。

**2. Placeholder scan：** 无 TBD/TODO；每个文档撰写步骤都给了逐字内容或明确的覆盖清单
（§5 三个能力面小节、§7 前端三条症状为「覆盖清单」形态，因为其内容由指针构成，指针本身已写明）。

**3. Type consistency：** 文档路径 `docs/module-onboarding.md` 全文一致；分支名
`docs/module-onboarding` 与 Task 5 推送命令一致；脚本名与 `scripts/` 实际文件逐字核对过
（`check-manifests.mjs` / `lint-architecture.mjs` / `check-tenant-isolation.mjs` / `check-compose.mjs` /
`check-env-example.mjs` / `gen-console-registry.mjs`）；README 节名「§常用命令」与 README 实际标题一致。
