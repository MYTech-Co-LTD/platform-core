# platform-core

通用平台底座 monorepo（工单系统未来迁入为第一个模块）。

## 布局

- `apps/` — 可部署应用：`server`（Hono API）、`web`（前端，Task 17 生成）
- `packages/` — 共享库：`auth-core`（认证内核）、`platform-sdk`（`@platform/sdk`）
- `modules/` — 业务模块：`demo` 为占位，工单系统将迁入
- `deploy/` — 部署面：唯一 compose、宿主 Dockerfile、两份 runbook（`openship-adopt.md` 待人工
  执行；`branch-protection-runbook.md` 记录分支保护的现状与替代机制，见 `deploy/README.md`）
- `scripts/` — 工具脚本：门禁（`check-manifests` / `lint-architecture` / `check-compose` /
  `check-env-example`）、前端 registry 生成（`gen-console-registry`）、装载冒烟（`smoke-load`）

## 常用命令

```bash
pnpm install      # 安装全部 workspace 依赖
pnpm test         # 递归跑各包 test（--if-present）+ scripts/ 的守卫单测（test:guard）
pnpm typecheck    # 递归 tsc --noEmit + scripts/（根 tsconfig.json）
pnpm smoke        # 装载冒烟：需 DATABASE_URL 且先 pnpm --filter @platform/web build
pnpm build        # 递归构建（--if-present）
pnpm dev          # 启动 @platform/server 开发模式
```

CI（`.github/workflows/ci.yml`）四个门禁 job：`unit`（挂 PG 跑全量测试）、`gates`
（typecheck + 四个守卫脚本对真仓跑）、`web`（前端单测 + 构建）、`smoke`（双形态装载冒烟）。
另有两个非门禁 job：`deploy`（CD 触发，**默认惰性**——未设 repo variable
`OPENSHIP_PROJECT_ID` 时显示 skipped，adopt 之后才生效，见 `deploy/openship-adopt.md`）与
`main-guard`（提交纪律的事后绊线，见下节）。

## 提交纪律

**改动一律走 PR，不直推 `main`。**

```bash
git switch -c <你的分支名>
git push -u origin <你的分支名>
gh pr create --fill          # 等 CI 绿，由服务端合并
```

本仓是私有仓 + org plan = free，**GitHub 的分支保护与 rulesets 在该 tier 上不可用**
（实测 403：`Upgrade to GitHub Pro or make this repository public`；管理员也开不了，不是权限问题）。
所以服务端拦不住直推，改用四层软机制：本地 `pre-push` 钩子拦下直推、`pnpm install` 的
`prepare` 让同事 clone 后自动装上、CI 校验装置完好、以及 `main-guard` 事后报警。
**它们让直推变麻烦、让绕过变可见，但不让直推不可能**——别当成强制门禁。

确有理由直推（bootstrap / 紧急热修）：`PLATFORM_ALLOW_DIRECT_PUSH=1 git push origin main`，
并在 issue 或 PR 里补一条说明。全貌与局限见 `deploy/branch-protection-runbook.md`。

## 部署

```bash
docker compose -f deploy/docker-compose.yml up --build -d
curl -i http://127.0.0.1:13000/healthz     # → 200 {"ok":true}
```
人工冒烟清单：`docs/m0-smoke-checklist.md`。
