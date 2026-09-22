# deploy/

部署面（M0 Task 22 落地）。四份产物：

| 文件 | 是什么 | 什么时候看它 |
|------|--------|--------------|
| `docker-compose.yml` | **全仓两份 compose 之一**（约束 B7 白名单；另一份是 `data-compose.yml` 部署单元 B/数据面，P1 起放行。`scripts/check-compose.mjs` 守卫）：`postgres` + `server` 两个服务 | 本地起栈、单机跑；adopt 时作为 `composePath` |
| `Dockerfile.server` | 宿主镜像（两阶段，node:22-alpine）。文件头写了三条「容器里跑挂了先回来对」的目录契约 | 改镜像、排查启动期故障 |
| `openship-adopt.md` | OpenShip 接入 + 生产部署操作单：前置决策 → adopt → env → 域名 → 部署触发 → 验证 → 回滚 | **待人工执行**；有控制面权限者照它敲 |
| `branch-protection-runbook.md` | main 分支保护操作单 | **待人工执行**；有仓库 admin 权限者照它敲 |

常用命令：

```bash
docker compose -f deploy/docker-compose.yml up -d postgres   # 只起 PG（本地冒烟前置）
docker compose -f deploy/docker-compose.yml up --build -d    # 整栈
curl -i http://127.0.0.1:13000/healthz                       # → 200 {"ok":true}
docker compose -f deploy/docker-compose.yml down -v          # 收干净（含卷）
```

**起整栈前先确认 `CASDOOR_URL` 可达**（`.env` 里的那一项）：宿主启动期就要按
`platform.tenant` 的各租户 org 调 Casdoor 做模块权限码 upsert（**`single` 与 `multi` 都一样**），
连不上会 `upsertPermission` 抛错 → 容器进入 `restart: unless-stopped` 的循环（`docker compose ps`
显示 Restarting）。这是设计如此（fail-fast），不是故障。

**想跳过启动期这条 Casdoor 依赖**：不设 `SEED_DEMO`——`platform.tenant` 为空时供给循环不执行、
也不会去取 client。但注意两点：① `CASDOOR_ADMIN_USER` / `_PWD` **仍是必填**（缺了在配置装配
阶段就报错，改 `TENANT_MODE`/`PLATFORM_ORG` 都没用）；② 真正的登录仍要 Casdoor 可达，
否则 `CASDOOR_URL` 指向哪里都只能起个登录签不出会话（502）的空壳。

人工验收清单在 `docs/m0-smoke-checklist.md`（机检那一半在 `.github/workflows/ci.yml`）。
