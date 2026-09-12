# platform-core 架构文档：设计

> 本文是 `docs/architecture.md` 的**设计稿**（spec），不是架构正文本身。正文按本稿落地，正文写完后
> 本稿转为历史记录（与 `specs/` 下其余 spec 同档）。
>
> 触发：公司规则 `architecture-first` 要求「任何改动先查该项目的架构文档」，且架构文档的位置由项目
> 在 `AGENTS.md` 里指明。本仓**没有任何 architecture 类文档**（已扫全部本地与远端分支核实），
> 于是「先查架构」这一步无处落脚。本次是**补常设文档**，不绑定特定改动。

## 1. 现状核实（决定本文档不能怎么写）

全分支扫描后，仓里能算「设计文档」的只有三份，**没有一份是平台架构**：

| 现有文档 | 实际是什么 | 为什么不能直接当架构文档 |
|---|---|---|
| `docs/module-protocol.md` (204 行) | 模块 API **声明**这一条缝的契约（`api.internal` 怎么写、门卫判定顺序、装载期双向核对） | 只覆盖「模块接缝」一个切面，不含组件边界、装配顺序、部署拓扑 |
| `docs/superpowers/specs/2026-09-11-login-rate-limit-and-scope-enforcement-design.md` (304 行) | **单特性**设计（登录限速 + scope 强制） | 特性设计，不是常设架构 |
| `docs/superpowers/specs/2026-09-11-multi-tenant-permission-provisioning-design.md` (259 行) | **单特性**设计（多租户权限码供给） | 同上 |

另有一份**未合入**的 `AGENTS.md`（停在 `docs/issue-14-agents-md`，issue #14 仍 OPEN），它的「文档地图」
一节才是本应指向架构文档的地方。

## 2. 决策

- **D1 单文件 `docs/architecture.md`，以「不变量」为骨架。**
  否决「总览 + 每个 seam 一份小文档」：仓里已有 `module-protocol.md` 这类 seam 文档，再拆一层会与
  它们重叠、且多份文档必然漂移（违本仓「唯一事实源、只给指针」的既有规矩）。
  否决「只放组件图 + 索引」：索引回答不了「这次改动架构支不支持」，撑不住 `architecture-first` 的用途。
- **D2 不变量分两档标注：「门禁固化」与「仅文档」。** 这是本文档最值钱的部分——读者既不误以为
  「文档写的都是强制的」，也不误以为「没写的就是随便改」。
- **D3 只写代码与门禁里读不出来的东西**（为什么是这个装配顺序、不变量为什么存在、边界在哪、
  加一个模块要动哪些点）。凡是能从代码或门禁直接读出的，**只给指针，不复制正文**。
- **D4 不把「仅文档」那档升级为门禁。** 那是另一个决定，需要单独案例支撑；本稿只如实标注现状。
- **D5 交付解耦：** 正文走自己的 `docs:` PR 落 `main`；`AGENTS.md` 文档地图的指针**留给 issue #14
  那个 PR**，本 PR 不碰 `AGENTS.md`（它此刻不在 main 上）。代价是 #14 合入前存在一段发现性空窗，
  已在「已知边界」记录。

## 3. 目标 / 非目标

**目标**：`docs/architecture.md` 能让一个不熟悉本仓的人（或 agent）在动手前回答三个问题——
① 这次改动落在哪个组件、边界在哪；② 它会碰到哪些不变量、违反了会怎样；③ 加一个模块要动哪些点。

**非目标**：

- 不动任何代码；
- 不改 `docs/module-protocol.md` 正文（只引用），也不搬运 `specs/` 下已有内容；
- 不新增任何门禁脚本；
- **不追述 M0 历史**——与 `CHANGELOG.md` 已声明的口径一致（「此前历史不追述，事后补写只会写出
  一份与提交历史不同源的第二事实」）。

## 4. 正文骨架（六节）

1. **系统上下文与部署拓扑** — 底座定位（通用平台 monorepo，工单系统未来迁入为第一个模块）；单机
   拓扑（compose 两服务 `postgres` + `server`，两条端口映射都绑回环）；生产通道（openship edge →
   宿主回环端口，故绑回环不是可选项）；租户模式（`single` / `multi` 与 org 来源）。→ 指针 `deploy/*`
2. **组件与职责边界** — 逐项写「它做什么 / 依赖谁 / 谁依赖它」：`apps/server`（宿主，**`auth-core`
   的唯一合法消费方**）、`apps/web`、`packages/auth-core`（**认证代码唯一归属地**）、
   `packages/platform-sdk`（模块契约）、`modules/<id>`、`scripts/`、`deploy/`
3. **宿主装配链与 I-1 顺序契约** — `apps/server/src/app.ts` 里带标号的 **11 段（①–⑪）**，外加一个
   未编号的 **④.5 请求体上限**（`bodyLimit` 挂在 ④ 与 ⑤ 之间）。每段写清**为什么必须在这个位置**。
   三条可观测的顺序约束（都能在代码里指到出处）：
   - Hono 中间件只对**其后注册**的路由生效 ⇒ `bodyLimit` 必须早于所有 `/api/*` 路由注册；
   - 模块 `requireScope` 读 `c.get('identity')` ⇒ 租户→会话两道**必须先于** `runtime.mount`，
     少一道即模块 API 全线 401 / 漏身份；
   - 权限码供给按 `platform.tenant` 取各租户 org ⇒ `seed` **必须先于**装载（全新库上租户还不存在
     时一个码都建不出来）。
4. **不变量清单** — 两档逐条，每条四栏：**是什么 / 为什么 / 违反了会怎样 / 在哪固化**（见 §5）。
5. **扩展点：加一个模块要动什么** — 目录形状、`manifest.yaml`、三同纪律（`id` = DB schema =
   API 前缀）、console 注册、要不要动部署。→ 指针 `docs/module-protocol.md`
6. **文档地图** — 下挂索引，**只给指针**（`module-protocol.md` / `specs/` / `deploy/*` /
   `m0-smoke-checklist.md` / `README.md`）。

## 5. 事实依据：不变量两档清单（已逐条核准）

### 第一档「门禁固化」— 在 CI 真跑、且会红

**判据严格取「在 CI job 里跑」而非「脚本存在」**：脚本存在但没接进 CI 的不算固化。

| 规则 | 固化处（脚本） | 守什么 | 在哪跑 |
|---|---|---|---|
| B1 | `scripts/lint-architecture.mjs` | 跨 schema 引用：平台代码只许 `platform.*`，`modules/<id>/` 只许自身 id（**三同纪律**：`id` = DB schema = API 前缀） | `gates` |
| B2 | `scripts/lint-architecture.mjs` | 认证代码唯一：`jose` / `jsonwebtoken` / 含 casdoor 的 import 只许 `packages/auth-core/**`；`@platform/auth-core` 只许 `apps/server` 引 | `gates` |
| B4 B5 | `scripts/check-manifests.mjs` | manifest 合法性与双向核对 | `gates` |
| B7 | `scripts/check-compose.mjs` | 全仓唯一 compose 文件；文件里**所有** `ports` 条目必须 `127.0.0.1:` 起头 | `gates` |
| B8 | `scripts/lint-architecture.mjs` | 硬编码禁令：`hookflow.cn`、公网 IP 字面量（`127.0.0.1` 白名单） | `gates` |
| B9 | `scripts/check-env-example.mjs` | `.env.example` 键齐全 | `gates` |
| — | `ci.yml` 的 gates 步骤 | 提交纪律装置完好（`.githooks/pre-push` 带执行位 + 根 `prepare` 接线未被改掉） | `gates` |
| — | `unit` / `smoke` job | 挂真 PG 的全量测试 / 双形态**真进程**装载冒烟 | `unit` / `smoke` |

### 第二档「仅文档」— 无门禁，靠评审与人守

| 不变量 | 出处（**必须在 main 上可达**） |
|---|---|
| manifest 声明即授权（未声明 = 不可达，fail-closed） | `docs/module-protocol.md` |
| 装载期双向核对（注册集合与声明集合任一方向有差集即装载失败） | `docs/module-protocol.md` |
| `c.req.routePath` 是门卫比对基准（相对/绝对混用 ⇒ 门卫恒 403） | `docs/module-protocol.md` |
| HEAD 必须归一到 GET（Hono 按 GET 派发但 `c.req.method` 仍是 `'HEAD'`） | `apps/server/src/*.ts` 代码位 |
| `enabledFor(tenantId)` 只能**请求期**门控，不能在装载期过滤 | `apps/server/src/loader.ts` 代码位 |
| I-1 挂载顺序契约（租户→会话先于 `runtime.mount`） | `apps/server/src/app.ts` 代码位 |

> **出处纪律**：第二档每条必须给出 **main 上可达** 的出处。**不得引用尚未合入的 `AGENTS.md`**
> （它此刻不在 main 上，引用会变成悬空指针）。目前多条只有代码位可引——正文里给 `file:line`，
> 这就是「仅文档」这个标注的真实含义。

## 6. 验证方式（怎么知道这份文档是准的）

1. **路径存在性**：正文里出现的每个仓库内路径都真实存在（逐条 `ls`/`git ls-files` 核）。
2. **门禁 ID 可复核**：B1/B2/B4/B5/B7/B8/B9 逐个能在对应脚本里 grep 到，且都能在 `ci.yml` 找到
   执行步骤——即 §5 第一档表逐行可证。
3. **装配链一致**：§4 第 3 节的十一段顺序与 `apps/server/src/app.ts` 实际注册顺序逐段对齐。
4. **反向验证**：§5 第二档每条都能在标称出处里找到，**找不到就删掉那条**（宁缺勿编）。
5. **CI**：`docs:` 类型不进 CHANGELOG、不触发 `release.mjs` 的版本推进（区间内无可见提交 ⇒
   「无可见变更，跳过」，release 保持绿）。

## 7. 已知边界

- **会漂移，靠人维护**：本稿**不加**同步门禁（D4 / YAGNI）。正文只加一条自约：
  「**引用即路径，路径必须真实存在**」，人工守。
- **发现性空窗**：`AGENTS.md` 合入前，没有任何地方指向 `architecture.md`（D5 的代价，已知并接受）。
- **第二档只有代码位可引**：`HEAD 归一` / `enabledFor 请求期门控` / `I-1` 目前无 main 可达的文档
  出处，暂以代码位 `file:line` 充当。若日后 `AGENTS.md`（#14）合入，可回填为文档出处——
  属可选优化，不在本稿范围。
