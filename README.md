# platform-core

通用平台底座 monorepo（工单系统未来迁入为第一个模块）。

## 布局

- `apps/` — 可部署应用：`server`（Hono API）、`web`（前端，Task 17 生成）
- `packages/` — 共享库：`auth-core`（认证内核）、`platform-sdk`（`@platform/sdk`）
- `modules/` — 业务模块：`demo` 为占位，工单系统将迁入
- `deploy/` — 部署面：唯一 compose、宿主 Dockerfile、两份待人工执行的 runbook（见 `deploy/README.md`）
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
第五个 `deploy`（CD 触发）**默认惰性**：未设 repo variable `OPENSHIP_PROJECT_ID` 时显示 skipped，
adopt 之后才生效——见 `deploy/openship-adopt.md`。

## 部署

```bash
docker compose -f deploy/docker-compose.yml up --build -d
curl -i http://127.0.0.1:13000/healthz     # → 200 {"ok":true}
```
人工冒烟清单：`docs/m0-smoke-checklist.md`。
