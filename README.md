# platform-core

通用平台底座 monorepo（工单系统未来迁入为第一个模块）。

## 布局

- `apps/` — 可部署应用：`server`（Hono API）、`web`（前端，Task 17 生成）
- `packages/` — 共享库：`auth-core`（认证内核）、`platform-sdk`（`@platform/sdk`）
- `modules/` — 业务模块：`demo` 为占位，工单系统将迁入
- `deploy/` — 部署面：唯一 compose、宿主 Dockerfile、两份 runbook（`openship-adopt.md` 待人工
  执行；`branch-protection-runbook.md` 记录分支保护的现状与替代机制，见 `deploy/README.md`）
- `scripts/` — 工具脚本：门禁（`check-manifests` / `lint-architecture` / `check-compose` /
  `check-env-example` / `check-tenant-isolation`）、前端 registry 生成（`gen-console-registry`）、
  装载冒烟（`smoke-load`）

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
（typecheck + 五个守卫脚本对真仓跑）、`web`（前端单测 + 构建）、`smoke`（双形态装载冒烟）。
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
服务端拦不住直推，改用四层软机制：

- **①** `.githooks/pre-push` 拦下本机直推 `main`/`master`（含删除推送）
- **②** 根 `prepare` 让**同事 clone 后自动装上**①（钩子配置不随 clone 继承，光放文件没用）
- **③a** CI 校验装置完好（钩子还在、还带执行位、②的接线没被改掉）；**③b** `main-guard` 事后绊线
- **④** 本节与 `deploy/branch-protection-runbook.md`

**它们让直推变麻烦、让绕过变可见，但不让直推不可能**——一个 `git push --no-verify` 就够了
（git 此时不调用钩子，钩子看不见这个标志），所以别把它当强制门禁。完整的七条局限见 runbook 第三节。

确有理由直推（bootstrap / 紧急热修）：`PLATFORM_ALLOW_DIRECT_PUSH=1 git push origin main`，
并在 issue 或 PR 里补一条说明。

## 部署

```bash
docker compose -f deploy/docker-compose.yml up --build -d
curl -i http://127.0.0.1:13000/healthz     # → 200 {"ok":true}
```
人工冒烟清单：`docs/m0-smoke-checklist.md`。

## 已知边界

**照实写，不粉饰。**「本地全绿」在这两类边界上**不等于**「验过」。

- **移动端（`modules/aftersales/mobile`）tsconfig 是 `strict: false`**：整包搬自 `wuji-2`
  （源工程即 `strict: false`），按 strict 走会一次爆出成百条改写，属另一个任务的范围。
  **这是一次显式声明的弱化**，收紧是 M3b-2 之后的跟进项。
- **移动端的端到端本地验不了**（spec §5 #13）：`MockCasdoor` 只做 Casdoor、**不做公众号 OAuth**
  ⇒ 本地拿不到**访客 session**。本地覆盖到 shim 单测 + 组件测试 + 装载冒烟（H6）；
  「真壳 + 真访客」这一段**只在试点客户机上验**。**别把「本地全绿」读成「端到端验过」。**
- **M3c 存储配置的生效窗口**：single 部署下租户行有 **60s 进程内缓存**
  ⇒ 管理端「存储配置」保存后**最长 60s 生效**；多实例部署各实例各缓存、**无失效接口**。
  真访客上传的端到端同样**只能在试点客户机验**（本地拿不到访客 session，同上门那条）。
