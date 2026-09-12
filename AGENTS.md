# AGENTS.md —— platform-core

> **本文件是本项目 agent 指令的唯一来源。** `CLAUDE.md` 只有一行 `@AGENTS.md`（Claude Code 的 import 语法）—— **不要往 CLAUDE.md 加内容**，否则两份规矩必然漂移。
>
> **团队级通用约束**（teamai 分发，**已全局生效**，本项目不重复写）：架构先行 · 数据库迁移纪律 · 部署后验 · 提交与 PR 纪律 · 密钥规矩 · 知识沉淀 · 派发与可见性 · 根本法则（唯一通道 / 无案例不立标准）
> 落点：Claude `~/.claude/rules/common/`、Codex `~/.codex/rules/common/`、pi `~/.pi/agent/rules/common/`

## 1. 项目是什么

通用平台底座 monorepo（工单系统未来迁入为第一个模块）。

| 目录 | 内容 |
|---|---|
| `apps/server` | Hono API 宿主：安全头 → `/healthz` → **租户解析 → 会话** → 平台路由/登录 → 模块挂载 |
| `apps/web` | 前端 console（含 registry 聚合） |
| `packages/auth-core` | 认证内核（Casdoor 客户端 + MockCasdoor 测试替身） |
| `packages/platform-sdk` | `@platform/sdk`：`defineModule` / `declaredScopeGate` / manifest 校验 |
| `modules/` | 业务模块（`demo` 占位；工单系统将迁入） |
| `deploy/` | 唯一 compose、宿主 Dockerfile、两份 runbook（`openship-adopt.md`、`branch-protection-runbook.md`） |
| `scripts/` | 门禁（`check-manifests` / `lint-architecture` / `check-compose` / `check-env-example`）+ 前端 registry 生成 + 装载冒烟 |

## 2. 文档地图（动手前先读）

| 文档 | 何时必读 |
|---|---|
| **`docs/module-protocol.md`** | **改模块 API / 门卫 / `manifest.api.internal[]` 声明前必读**：没声明=不可达、装载期双向核对、`method === 'ALL'` ≠ 一定是中间件、门卫判定顺序、实现注意（踩过的坑）、匿名探测 |
| `docs/superpowers/specs/`、`docs/superpowers/plans/` | 改架构 / 新功能前**先在此产设计与计划**，再动代码（见团队规则 `architecture-first`） |
| `docs/m0-smoke-checklist.md` | 验收 / 手工冒烟清单 |
| `deploy/branch-protection-runbook.md` | 提交纪律的四层软机制与「七条局限」 |
| `deploy/openship-adopt.md` | 部署接入（待人工执行） |
| `README.md` | 布局 / 常用命令 / 提交纪律 / 部署（**本文件不重复它**） |

## 3. 项目专属硬约束

1. **模块 API 权限 = manifest 声明即授权**：模块**不手写** `requireScope`；宿主按 `manifest.api.internal[]` 施加门卫（`declaredScopeGate`）。**未声明 = 不可达**（fail-closed），错误体与 `requireScope` 逐字一致。
2. **装载期双向核对（fail-fast）**：注册的路由集合必须与声明集合**完全一致**，任一方向的差集都让装载失败——让「声明与代码漂移」不可能悄悄存在。
3. **`c.req.routePath` 是门卫比对基准**：包裹层被 mount 到前缀下后 `routePath` 是**绝对路径**；`declared[].path` 必须与它同基准（相对/绝对混用 ⇒ 门卫恒 403）。
4. **HEAD 必须归一到 GET**：Hono 把 HEAD 按 GET 派发，但 `c.req.method` 仍是 `'HEAD'` ⇒ 比对前归一（issue #7 已修，**勿回退**；`viewer1 HEAD → 403` 与 `admin1 HEAD → 200` 都有冒烟断言锁着）。
5. **停用模块要按租户门控**：`enabledFor(tenantId)` 是**按租户**的，而 `mount()` 是**全局一次**的 ⇒ 只能在**请求期**门控，**不能**在装载期过滤（装载期过滤会连带把启用租户也挡掉）。
6. **服务端分支保护在本 tier 不可用**（free 私仓，实测 403 `Upgrade to GitHub Pro`）⇒ 靠四层软机制：`.githooks/pre-push` + 根 `prepare` 自动接线 + CI 装置校验 / `main-guard` 事后绊线 + runbook。**它们是"让直推麻烦、让绕过可见"，不是强制门禁**（`--no-verify` 即可绕过）。
7. **冒烟必须真进程**：`pnpm smoke`（双形态：multi + single）覆盖「进程内直调 app」看不到的那层（启动期装配、Host 语义、静态托管）。改装配/路由/Host 语义时它是唯一证据面。

## 4. 常用命令与门禁

```bash
pnpm install      # 装全部 workspace 依赖
pnpm test         # 各包 test（--if-present）+ scripts/ 守卫单测（test:guard）
pnpm typecheck    # 递归 tsc --noEmit + scripts/（根 tsconfig.json）
pnpm build        # 递归构建（--if-present）
pnpm dev          # 启动 @platform/server 开发模式
pnpm smoke        # 装载冒烟：**需 DATABASE_URL**，且先 pnpm --filter @platform/web build
```

CI 四门禁 job：`unit`（挂 PG 跑全量测试）/ `gates`（typecheck + 四个守卫脚本对真仓跑）/ `web`（前端单测 + 构建）/ `smoke`（双形态装载冒烟）。
两个非门禁 job：`deploy`（**默认惰性**，未设 repo variable `OPENSHIP_PROJECT_ID` 时 skipped）/ `main-guard`（提交纪律的事后绊线）。

> **本地跑门禁时注意**：`gates` 里的 `pnpm typecheck` 覆盖 `scripts/`（根 `tsconfig.json`）——只跑包内 `tsc --noEmit` 会漏掉 `scripts/*.mjs` 的类型错误（踩过：JSDoc typedef 缺字段，本地绿 CI 红）。

## 5. 部署

```bash
docker compose -f deploy/docker-compose.yml up --build -d
curl -i http://127.0.0.1:13000/healthz     # → 200 {"ok":true}
```

- **生产部署通道 = openship**（公司标准；见根本法则「唯一通道」）——`ci.yml` 的 `deploy` job 在设置 `OPENSHIP_PROJECT_ID` 后生效，接入步骤见 `deploy/openship-adopt.md`。
- 部署后**必验「容器创建时间 vs 镜像构建时间」**（防「容器跑旧代码」）——见团队规则 `deploy-verify`。
- 人工冒烟：`docs/m0-smoke-checklist.md`。

## 6. 提交纪律

**改动一律走 PR，不直推 `main`**（`git switch -c <分支>` → push → `gh pr create --fill` → 等 CI 绿 → 服务端合并）。
理由、四层软机制与七条局限见 `README.md`「提交纪律」与 `deploy/branch-protection-runbook.md`。
确有理由直推（bootstrap / 紧急热修）：`PLATFORM_ALLOW_DIRECT_PUSH=1 git push origin main`，并在 issue/PR 补说明。

## 7. 债账与经验

- **M0 遗留债账**：issue **#3**（含已裁决延后项与具名阻塞项）——改这块前先读它，避免重复处理已裁决项。
- **本项目的坑与经验** → WeKnora 经验库（见团队规则 `knowledge-capture`：先查重、命中则更新原条目）。
- **飞检/偶发**（如 CI web job 间歇性红）先做「**同一 commit 重跑是否变绿**」判定，再排查因果。
