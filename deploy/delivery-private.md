# 私有化交付 runbook（spec-3）

> 适用：给一个私有化客户开出一套独立 platform-core 实例（TENANT_MODE=single）。
> 正典：`docs/superpowers/specs/2026-09-14-private-delivery-design.md`；本文是操作层。
> 铁律：运维动作一律走 openship MCP（本文工具名即 MCP 工具名）；每步都有「成功判据」，调一步验一步。

## 0. 每客户三决策点（开工前定）

| 决策 | 默认 | 例外 |
|---|---|---|
| 实例位置 | **客户自己的服务器**（注册 openship server） | 小客户/试点住我方机器 |
| Casdoor | **共用我方 sso.hookflow.cn**，客户一个独立 org | 合规要求 → 客户侧独立 Casdoor 实例（`CASDOOR_URL` 指过去，单独定运维归属） |
| 域名 | 客户自有域名，DNS A 记录到机器公网 IP | 无域名时用 openship 免费子域 |

## 1. 六步开通链路

### 步骤 1：客户机接入（仅客户机路径）

走 `cicd-project-onboarding` 标准阶段 A（网络打通 → 控制面 ufw 4878 白名单 → git
smart-proxy → docker 自动装 → 注册 server）。**本文不复述**，完成判据 = openship 里能看到
该 server（`get_projects` 拿到 serverId 备用）。

### 步骤 2：建 openship project

MCP `post_projects`：name=`platform-core-<客户slug>`、gitOwner=MYTech-Co-LTD、
gitRepo=platform-core、gitBranch=main、composePath=deploy/docker-compose.yml、
rootDirectory=deploy、framework=docker-compose。

⚠️ **serverId 在这一步传不进去**（`post_projects` 不收、`patch` 静默忽略）——只能在步骤 3
的部署调用里带。坑源：`deploy/openship-adopt.md` §6.2。

### 步骤 3：首次部署（带 serverId）+ env 物化

先 env（MCP `patch_projects_by_id_env`，environment=production）：

| 键 | 值 |
|---|---|
| `TENANT_MODE` | `single` |
| `PLATFORM_ORG` | `<客户 casdoor org>` |
| `CASDOOR_URL` | 我方 sso（默认）或客户独立实例 |
| `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` / `CASDOOR_ADMIN_USER` / `CASDOOR_ADMIN_PWD` / `CASDOOR_APPLICATION` | 按目标 Casdoor 取值（敏感值走 isSecret） |
| `PLATFORM_SESSION_SECRET` | 随机生成（isSecret） |
| `PUBLIC_ORIGIN` | `https://<客户域名>` |
| `PLATFORM_SUBSCRIPTION_SOURCE` | `casdoor`（**新交付一律 casdoor 源，全平台单一口径**；platform 源仅我方实例回滚兜底） |

再部署（MCP `post_deployments_build_access`）：projectId、**serverId**（步骤 1 拿的）、
deployTarget=server、branch=main、environment=production。

成功判据：`get_deployments_by_id_build` status=ready + 日志 Health check passed。
（postgres 探活误报忽略，见 adopt §6.3。）

### 步骤 4：CLI 开通租户（服务器侧执行）

⚠️ **本机直连生产库不可行**（pg 绑回环，B7）。CLI 在 server 容器内跑——`scripts/` 与
tsx 本来就在 runtime 镜像里（`deploy/Dockerfile.server` COPY ③ + 全量 node_modules），
容器 env 现成（DATABASE_URL 指服务名 postgres）。

MCP `post_projects_by_id_services_by_serviceId_exec`（serviceId 从
`get_projects_by_id_services` 拿，服务名 server），command：

```sh
pnpm exec tsx scripts/provision-tenant.mjs <客户slug> --org <客户org> --module <id>... \
  --product-name <产品名> --login-methods password[,wecom-qr] --domain <客户域名>
```

成功判据：逐步 ✓ 打印到 `permissions ×N`（N = 模块码数 + 1，含 tenant:admin）与
`subscribe mod-<id>`、`domain <host>`；**幂等可重跑**。

### 步骤 5：域名与证书

MCP `post_domains`（projectId、hostname=<客户域名>）→ `post_domains_by_id_verify` →
`post_domains_by_id_verify_ssl`。DNS 由客户侧先把 A 记录指到机器公网 IP。

### 步骤 6：冒烟

按 `deploy/README.md` 的部署后验证（容器创建时间 vs 镜像构建时间、新行为可观测）+
`docs/m0-smoke-checklist.md`。登录一口：CLI 建的是租户与订阅，**第一批用户要在 Casdoor
建号并挂码**（客户管理员 = `tenant:admin`，挂上后 console「管理」菜单组可见——M3 页自管）。

## 2. 升级 SOP

- **我方托管实例**：CI 自动（merge main 即部署，现状不动）。
- **客户实例**：维护窗口内逐家 MCP `post_deployments`（**必须带 serverId**、branch=main）。
  先通知客户定窗口；一次窗口内多家顺序执行，每家 ready 后再下一家。
- **回滚**：MCP `post_deployments_by_id_rollback`（每 project 独立回滚窗，互不牵连）。
- 批量脚本：3 家以上再立项（spec-3 §0 方案 B）。

## 3. 边界

- 独立 Casdoor 实例的部署与运维归属：特殊情况按客户单独定，本文不展开。
- 壳层定制（布局/导航/多语言）：**L2 车道未建前不接**（spec-1 §1），立项信号 = 第一个真实壳层需求。
