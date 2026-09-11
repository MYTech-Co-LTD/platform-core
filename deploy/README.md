# deploy/

部署面（M0 Task 22 落地）。四份产物：

| 文件 | 是什么 | 什么时候看它 |
|------|--------|--------------|
| `docker-compose.yml` | **全仓唯一的 compose**（约束 B7，`scripts/check-compose.mjs` 守卫）：`postgres` + `server` 两个服务 | 本地起栈、单机跑；adopt 时作为 `composePath` |
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

人工验收清单在 `docs/m0-smoke-checklist.md`（机检那一半在 `.github/workflows/ci.yml`）。
