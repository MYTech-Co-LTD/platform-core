# Runbook：OpenShip 接入（adopt）+ 生产部署

> 状态：**已执行（2026-09-13 首次真实部署）**。执行记录：项目 `proj_v0QZ68VYDc0pkFxL` ·
> 生产机 `23a1091e`（mytech-weknora，219.151.186.106）· 域名 `mytech.hookflow.cn` ·
> 首次部署服务 **2/2 成功**，线上 `/healthz` `{"ok":true}`。
>
> **本文已按这次真实部署订正**：原文有 **3 处错**（`rootDirectory` 填错、缺「建租户行」、
> 部署调用缺 `serverId`）与 **1 处待验证项已关闭**（回环映射，见 §0）。下文各节带
> `2026-09-13 订正` 标注。下次接新客户时**照订正后的走**。
>
> 与 `deploy/branch-protection-runbook.md` 同一形态：**先决策、再操作、每步带验证与回退**。

## 为什么没在 Task 22 里直接 adopt

两件事都不是代理该替人拍的板：

1. **要选一台机器**。adopt 必须给 `serverId`，即「平台底座跑在哪台生产机上」。仓里没有这个
   答案（`deploy/` 里只有编排，没有机器归属），而机器归属牵涉成本、VPC 可达性、数据落在谁的
   盘上、与既有 woke / salary 等项目的资源隔离。选错了不是改一行配置能挽回的。
2. **会在共享控制面留下状态**。adopt 一次会创建：项目记录、env（含密钥）、卷、
   域名与证书、部署历史与快照。控制面是公司共享基建，这些变更**有对外可见面**（域名可达、
   证书签发），且不是「删掉项目记录」就当没发生过（证书、快照、卷还在）。

本文里的命令本身大多是幂等或可回退的（`ensure` 按名复用、env PATCH 是 upsert、域名可删、
部署可回滚），但**首次创建**不可逆。所以：决策 → 执行 → 验证，三步都要人盯着。

## 前置决策（执行前必须有人拍板）

| # | 决策 | 为什么不能默认 | 建议 |
|---|------|----------------|------|
| 1 | **目标服务器 `serverId`** | 决定数据与算力落在哪台机 | 复用 scaffold 系已落地的那台（控制面里 `woke` / `salary-calculation` 同在 `f993b5c7-58a9-42d6-b6c2-6ad0cecc85b8`）；也可另开一台，但要走 `cicd-project-onboarding` 阶段 A |
| 2 | **PG 策略** | 决定卷与备份面 | 见「生产差异」第 1 条。M0 阶段建议直接用 compose 里的 postgres（数据在 named volume），并把它纳入 openship 的卷备份 |
| 3 | **域名 + 证书** | 对外可见面 | `platform.<公司域>`；DNS CNAME → 目标生产机，`.env` 的 `PUBLIC_ORIGIN` 必须与它逐字一致（企微回调 `redirect_uri` 由它拼） |
| 4 | **项目名 / slug** | 决定控制面标识与下面的 repo variable 值 | `platform-core`（已核对：控制面当前 6 个项目里没有被占用） |
| 5 | **Casdoor 接入参数** | 启动期就要真连 | 用哪个 org / application / admin 凭据。**注意**：配了 admin 凭据时，宿主启动期会按各租户 org 调 Casdoor upsert 模块权限码（`single`/`multi` 皆是），Casdoor 不可达 = 进程起不来（见下方「已知陷阱」） |

## 要接的东西（一张表看完）

| 项 | 值 | 依据 / 备注 |
|----|----|-------------|
| 源 | GitHub `MYTech-Co-LTD/platform-core`，分支 `main` | 与其它项目一致（`gh repo view`） |
| 项目类型 | `projectType=services`、`framework=docker-compose` | compose 编排的多服务项目 |
| 运行模式 | `runtimeMode=docker`、`productionMode=host`、`sourceKind=git` | 与 `woke` 项目同形 |
| 仓库根 | `rootDirectory=deploy` | ⚠️ **2026-09-13 订正：原文写 `.`，是错的。** openship 把 compose 的 `build.context: ..` **相对 `rootDirectory`** 解析 ⇒ 填 `.` 时 `..` 逃出仓库，部署**必失败**：`Invalid Compose build context: path escapes the linked repository`。填 `deploy` 才对（= `deployments/prepare` 自己返回的值，**以 prepare 为准**） |
| compose | `composePath=deploy/docker-compose.yml` | **全仓两份 compose 之一**（部署单元 A；另一份是 `deploy/data-compose.yml` 部署单元 B/数据面——**P1 起放行，文件缺席不违规**，约束 B7 白名单由 `scripts/check-compose.mjs` 机检守卫），不要在生产另写第三份 |
| env | 根 `.env.example` 的 13 键（见下表） | B9 门禁保证「代码引用的键都有声明」，故这份清单就是全集 |
| 卷 | `pgdata`（compose 命名卷 → `<project>_pgdata`） | PG 数据。生产要进备份策略 |
| 域名 | `platform.<公司域>`（决策 3） | 走 openship edge 签证书 |
| 部署触发 | `ci.yml` 的 `deploy` job（**惰性**，见第 7 节） | 需人工建一个 repo variable 才激活 |

## 操作单

### 0. 前置检查（四条，缺一条就别往下走）

```bash
# ① 目标服务器在线且 openship 认它
docker context ls >/dev/null 2>&1   # 仅提示：adopt 在控制面侧执行，本地无需 docker
# 看控制面：GET /settings 的 defaultDeployTarget/defaultServerId，或面板「服务器」页

# ② 镜像能在这台机器上构建出来（本任务只验证过本地 macOS；生产是 linux，先跑一次 prepare）
#    经 MCP：openship 的 deployments/prepare（repo=MYTech-Co-LTD/platform-core, branch=main）
#    期望：framework=docker-compose、composePath 被认到 deploy/docker-compose.yml
#    ⚠️ 若 prepare 认不出，别硬 adopt——先把 composePath 显式传进去再试。
#
#    ✅ **回环映射已实测确认（2026-09-13 首次真实部署）** —— 本节原是本仓「唯一没能
#        独立验证」的一环，现已关闭：**openship 的 services 模式不会重写 host_ip 前缀**，
#        两个服务的宿主端口都原样保持回环：
#          · server   `127.0.0.1:13000:13000`   ✓
#          · postgres `127.0.0.1:5432:5432`     ✓（`deployments/prepare` 的输出里可见）
#        之所以还是要核：**换 openship 版本或换机器时它未必仍成立**，而重写的后果是**静默的**
#        —— edge 照常反代、冒烟照常绿，只是「任何能访问宿主该端口的人都能绕过 edge」这条又
#        回来了。**两条都要看，DB 那条不能省**：被重写回 0.0.0.0 时 postgres 比 server 更重
#        —— server 前面至少还有 edge，而库一旦落在宿主网络上就是**裸暴露一个可直连的 PG**
#        （口令即全部防线），且没有任何应用层日志会告诉你。
#        对不上就把 prepare/scan 的原始输出原样贴回来，别硬推。

# ③ 目标机上 13000 / 5432 没被别的项目占用
#    （本机实测就有过 13000 被上一轮 dev mock 长占的先例）

# ④ 【2026-09-13 新增】目标机的 docker 能拉到 docker.io 镜像
#    这台机上踩到：daemon.json 里的 registry-mirrors 指向一个**返回 401 的 mirror**
#    ⇒ 构建第一步 `FROM node:22-alpine` 就失败（`401 Unauthorized`），且**该机上任何
#    docker.io 拉取都会失败**（不止本项目）。
#    标准口径：**不配 registry-mirrors**（docker.io 也走 HTTPS_PROXY→CONNECT）；若 mirror
#    指向的是公司 smart-proxy 也可用。旧机若配的是第三方 mirror，跑
#    `openship-platform/scripts/retrofit-docker-proxy.sh`（幂等）修。
#    自检：
#      docker info | grep -iE 'http proxy|https proxy'   # 应有代理
#      docker pull node:22-alpine                        # 必须成功
```

### 1. adopt：建项目（`ensure` 语义 —— 同名复用，不会建两份）

```bash
OPENSHIP_URL=https://deploy.hookflow.cn
TOKEN=$OPENSHIP_API_TOKEN          # openship PAT（opsh_pat_…）

curl -fsS -X POST "$OPENSHIP_URL/api/projects" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "name": "platform-core",
    "slug": "platform-core",
    "gitProvider": "github",
    "gitOwner": "MYTech-Co-LTD",
    "gitRepo": "platform-core",
    "gitBranch": "main",
    "sourceKind": "git",
    "projectType": "services",
    "framework": "docker-compose",
    "rootDirectory": "deploy",
    "composePath": "deploy/docker-compose.yml",
    "runtimeMode": "docker",
    "productionMode": "host",
    "hasServer": true,
    "hasBuild": true,
    "port": 13000,
    "readiness": { "enabled": true, "path": "/healthz", "port": 13000, "stabilization": true }
  }'
# 记下返回的 projectId（形如 proj_xxxxxxxx）——下面每一步都要它，第 7 节还要回填到 GitHub
```

> 等价做法：直接用 openship MCP 的 `post_projects`（同一套字段）。用 MCP 时注意它是
> **写操作**，同样受本文开头的「两个理由」约束。

**`/healthz` 是就绪探针**：宿主把它挂在租户中间件之前，不带业务 Host，容器探针与 LB 都能打
（见 `apps/server/src/app.ts` 第 115 行）。所以 `readiness.path` 填它，别填 `/`（`/` 要 SPA dist）。

### 2. 注入 env（13 键 = 根 `.env.example` 全集）

```bash
curl -fsS -X PATCH "$OPENSHIP_URL/api/projects/$PROJECT_ID/env" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "environment": "production",
    "upserts": [
      { "key": "PORT",                  "value": "13000" },
      { "key": "TENANT_MODE",           "value": "single" },
      { "key": "PLATFORM_ORG",          "value": "<客户 casdoor org>" },
      { "key": "DATABASE_URL",          "value": "postgres://platform:<强口令>@postgres:5432/platform" },
      { "key": "PUBLIC_ORIGIN",         "value": "https://platform.<公司域>" },
      { "key": "CASDOOR_URL",           "value": "https://sso.hookflow.cn",           "isSecret": true },
      { "key": "CASDOOR_CLIENT_ID",     "value": "<application client id>" },
      { "key": "CASDOOR_APPLICATION",   "value": "<signupApplication>" },
      { "key": "CASDOOR_CLIENT_SECRET", "value": "<secret>",   "isSecret": true },
      { "key": "CASDOOR_ADMIN_USER",    "value": "<admin>",    "isSecret": true },
      { "key": "CASDOOR_ADMIN_PWD",     "value": "<admin pw>", "isSecret": true },
      { "key": "PLATFORM_SESSION_SECRET","value": "<openssl rand -base64 48 生成的 ≥32 字符>", "isSecret": true }
    ],
    "deletes": []
  }'
```

| 键 | 生产怎么给 | 说明 |
|----|-----------|------|
| `PORT` | `13000` | 与 compose 的容器端口一致 |
| `DATABASE_URL` | 依决策 2 | compose 内网服务名 `postgres`；**不要照抄 `.env.example` 的 `127.0.0.1`**（那是宿主视角） |
| `TENANT_MODE` | `single`（单客户）/ `multi`（多租户） | `multi` 时租户由 Host 解析，`PLATFORM_ORG` 不再参与；**两种模式都会**按 `platform.tenant` 的各租户 org 逐个供给模块权限码 |
| `PLATFORM_ORG` | 单客户 = 客户 Casdoor org | `single` 模式下必填，配错的表现是启动期报「租户不存在」；`multi` 模式下不参与租户解析与权限供给 |
| `PLATFORM_SESSION_SECRET` | ≥32 字符随机串 | 会话签名密钥，**泄漏即等于会话可伪造**；换值会让所有会话失效 |
| `CASDOOR_URL` | `https://sso.hookflow.cn` | 共享 SSO |
| `CASDOOR_CLIENT_ID` / `_SECRET` | 该 application 的凭据 | 走 OIDC code 换 token |
| `CASDOOR_ADMIN_USER` / `_PWD` | Casdoor 管理员 | **启动期必需**。它**不只**服务模块权限码供给：登录签发前必调 `getUser` + `getPermissions`，两者都走 admin 会话 —— 缺凭据时没有人能拿到会话（即便凭据正确也签不出：签发前 502；错凭据仍是 401） |
| `CASDOOR_APPLICATION` | `signupApplication` | 账密登录要它，否则真实 Casdoor 报 Unauthorized operation |
| `PUBLIC_ORIGIN` | `https://<域名>` | 企微回调 `redirect_uri` 由它拼，必须与最终访问域名逐字一致 |
| `SEED_DEMO` | **不要设** | 只在 dev/冒烟置 `1`；生产设了会种出 acme/beta 两个演示租户 |

> ⚠️ **2026-09-13 实测：用本节的 curl（或 MCP `patch_projects_by_id_env`），别用 dashboard 的
> 「环境变量」表单。** 那个表单**能读不能存** —— 加行 / 键盘输入 / 上传 `.env` 三种都在保存时
> 被丢弃（点「保存更改」只保存右栏设置并跳转到 `/projects/<id>/runtime`，未保存的行随之丢失），
> 而**同一个 PATCH 接口一次就成**。密钥值也不必经手第三方：在 dashboard 页面控制台里 fetch 那个
> 接口即可（同源、带会话；注意 dashboard 的 API 走 **`/api/proxy/api/...`** 前缀）。

### 3. 卷

compose 里的 `pgdata` 由 node 侧命名（`<project>_pgdata`）。adopt 后到控制面把该卷纳入备份
策略（openship 原生 producer：`volume` / `pg-dump`）。**这是平台底座的唯一有状态面**——丢了
就得重跑迁移与 seed，租户/品牌/模块启用配置全部归零。

### 4. 域名 + 证书

```bash
# 加域名（DNS 先按提示 CNAME → 目标生产机）
curl -fsS -X POST "$OPENSHIP_URL/api/domains" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"'"$PROJECT_ID"'","hostname":"platform.<公司域>","isPrimary":true}'
# 验证 + 签证书（回读 verify/ssl 状态，别只看 POST 的 2xx）
curl -fsS -X POST "$OPENSHIP_URL/api/domains/$DOMAIN_ID/verify"    -H "Authorization: Bearer $TOKEN"
curl -fsS -X POST "$OPENSHIP_URL/api/domains/$DOMAIN_ID/verify-ssl" -H "Authorization: Bearer $TOKEN"
```

**顺序不能反**：`PUBLIC_ORIGIN` 与域名必须一致，否则企微登录的 `redirect_uri` 会被 Casdoor /
企微拒（回调域名不匹配）。

> ⚠️ **2026-09-13 订正：光加域名不够，还必须先把服务标记为暴露。**
> openship 的模型是「**服务**（service）暴露 + 绑域名」，edge 才有得反代。实测：只调
> `/api/domains` 把域名加上、但服务仍是 `exposed:false` / `publicEndpoints:[]` 时，
> **部署的路由同步会把该域名剪掉**（项目域名列表变回空），表现是「明明加过、回头查不见了」。
> 正确顺序：
> ```bash
> # ① 先把 server 服务标记为暴露并绑域名（用服务 id，不是项目 id）
> curl -fsS -X PATCH "$OPENSHIP_URL/api/projects/$PROJECT_ID/services/$SERVER_SERVICE_ID" \
>   -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
>   -d '{"exposed":true,"exposedPort":"13000","domainType":"custom",
>        "customDomain":"platform.<公司域>",
>        "publicEndpoints":[{"port":13000,"domainType":"custom","customDomain":"platform.<公司域>"}]}'
> # ② 域名会随之自动建出（含 sslStatus=provisioning），然后再 verify
> ```
> 把 `server` 暴露为公网入口是**有意的决定**（它前面就是 edge）；`postgres` **不要暴露**。

### 5. 生产差异（相对仓库里的 `deploy/docker-compose.yml`）

本仓的 compose 是「单机跑起来」的事实源，**生产只需改这三处**，其余照搬：

1. **PG 是否留在 compose 里**
   - 留：**不必再手工删 `postgres.ports`** —— R5 修复轮起它已绑回环（`127.0.0.1:5432:5432`），
     本来就不给宿主公网面留暴露。生产若要连宿主回环都不留，请**走下面的选项 2（整份删掉
     postgres service）**，不要只抽掉那条映射：本仓 `scripts/check-compose.mjs` 的 B7 规则二
     对"**服务还在、却一条 ports 条目都没有**"报违规（有意为之：把"撤掉宿主暴露面"变成一次
     想清楚的决定，而不是顺手删一行）。同理，server 的那条映射也不要单删。
   - 不留：删掉整个 `postgres` service，`DATABASE_URL` 指向托管库；`depends_on` 一并删。
     **B7 规则二对这条路径不报**（R5-2 建议改 1 订正：旧实现把"服务不存在"与"有服务但没
     端口"混成同一条违规，于是照本选项做完会让 CI 的 gates job 变红，且报错文字是"postgres
     服务缺少宿主端口映射"——理由与事实相反）。
2. **`HOST_PORT` 逃生口不需要设**（它只是给「本机 13000 被占」用的），默认就是 13000。
3. **顶层 `name: platform-core`**：本地留着它防「与别的 `deploy/` 仓库串项目」；若 openship 的
   services 模式按自己的项目名管理该栈（以 `deployments/prepare` / `folder/scan` 的识别结果为准），
   以 openship 为准——它才是生产编排的持有者。

### 6. 首次部署（人工跑一次）

> **2026-09-13 新增本节**：原文从 §5 直接跳到「CI 接线」，**没有首次部署这一步**；而手工首发
> 与 CI 触发**不是一回事** —— 前者要显式选机器、且必须先备好租户行。

#### 6.1 前置：必须先建一行 `platform.tenant`，否则**整站 500**

`TENANT_MODE=single` 的租户解析按 `PLATFORM_ORG` 查 `platform.tenant`；**查不到就抛错、
每个业务请求都 500**：

```
Error: TENANT_MODE=single 但租户不存在：casdoor_org="mytech"（检查 PLATFORM_ORG 配置或先跑 seed）
    at /app/apps/server/src/tenant.ts:103
```

**`/healthz` 仍是 200**（它挂在租户中间件**之前**，架构文档 §3 的第 ⑤ 段）⇒ **这个故障探活
发现不了**，只有打业务端点才暴露。首次部署后如果「探活绿、页面 500」，先查这里。

生产**不能**用 `SEED_DEMO=1` 绕过（它会种出 acme/beta 两个演示租户）。改跑 provision CLI
（`deploy/delivery-private.md` 步骤 4，服务器侧容器内执行；私有化交付全流程也看那份 runbook）：

```sh
pnpm exec tsx scripts/provision-tenant.mjs <slug> --org <casdoor-org> --module <id>... \
  --product-name <产品名> --login-methods password --domain <域名>
```

- **`login_methods` 的合法值只有 `password` 与 `wecom-qr`**（见 `apps/web/src/pages/Login.tsx`
  的 `METHOD_LABELS`）。CLI 已做白名单校验（坏值入口即拒）；**手工 SQL 路径若还在用**，
  写错的值会被前端**静默丢掉**，登录页只剩账密 tab。
- `product_name` 就是控制台标题与登录页品牌。
- **`PLATFORM_SUBSCRIPTION_SOURCE=casdoor` 是新交付的统一口径**：模块启用走 Casdoor 订阅
  （CLI 的 `--module` 建 plan+Active 订阅）。往 `tenant_module` 插表的旧做法**废弃**——
  casdoor 源下没人读那张表，插了也白插。platform 源仅作我方实例的临时回滚兜底。
- `plan` 上还要记得：**新客户 = 新 org + 新租户行**，这套是逐客户一份。

#### 6.2 发起部署：**必须传 `serverId`**

```bash
# 用 deployments/build/access —— **能传 serverId 的那个调用**
curl -fsS -X POST "$OPENSHIP_URL/api/deployments/build/access" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"'"$PROJECT_ID"'","serverId":"<决策 1 的 serverId>",
       "deployTarget":"server","branch":"main","environment":"production"}'
```

> ⚠️ **2026-09-13 订正**：项目**创建时拿不到 `serverId`** —— `post_projects` **不接受**该字段
> （建出来是 `serverId: null`），而 `patch` 会**静默忽略**它（返回 200、值仍是 null，极易误判
> 为已设置）。因此它**只能在部署这一步传**。
> **不带 `serverId` 不会报错**，只会落到控制面的 `defaultServerId`（很可能是**另一台机器**）
> —— 静默部署到错的地方。

#### 6.3 成功判据（别只看 HTTP 200）

`get_deployments_by_id_build` 里：`status=ready` · `partial.successful` 等于服务数 ·
日志出现 `Health check passed: "server" answered at 127.0.0.1:13000/healthz`。

> 日志里 postgres 那条 `never answered at 127.0.0.1:5432/healthz` 是**误报**：openship 给每个
> 服务都按 HTTP 探活，而 postgres 不提供 HTTP。server 能连上库即为证据。

### 7. 部署触发（CI 接线）

`ci.yml` 里已经有 `deploy` job，它**默认不跑**，等一个 repo variable：

```bash
# 人工执行一次（值是第 1 步拿到的 projectId）
gh variable set OPENSHIP_PROJECT_ID --repo MYTech-Co-LTD/platform-core --body proj_xxxxxxxx
# PAT 是 job 里真正发请求用的凭据
gh secret set OPENSHIP_TOKEN --repo MYTech-Co-LTD/platform-core
```

设置之后：**push 到 `main` 且四个门禁 job（unit/gates/web/smoke）全绿**时，`deploy` job 会
`POST /api/deployments {projectId, branch:"main", commitSha: <本次 push 的 sha>}`，控制面按
commitSha 锚定构建部署。

为什么用 repo variable 当闸门（而不是「有没有配 secret」）：**job 级 `if` 读不到 `secrets`
上下文**（GitHub 只放行 `github` / `needs` / `vars` / `inputs`），所以「secret 存在即跑」这个
写法根本不成立。`vars` 在 job 级 `if` 里可用，而 `OPENSHIP_PROJECT_ID` 本来就是 adopt 之后
必须人工回填的**必填参数**——让它兼任开关，就不存在「开关开了但参数没填」的中间态。

> **✅ 已启用（2026-09-14）**：variable `OPENSHIP_PROJECT_ID=proj_v0QZ68VYDc0pkFxL`、
> `OPENSHIP_URL=https://deploy.hookflow.cn/api/proxy`、secret `OPENSHIP_TOKEN`（scoped PAT
> `ci-platform-core-deploy-scoped`；启用当天曾临时用 fullAccess PAT，同日已收紧）均已配置。
> 此后 merge 到 main = 门禁全绿后自动部署（端到端验证：PR #53/#54 合并 → deploy job →
> healthz 200）。
> 三个实测坑：
> ① **API 基址带 `/api/proxy` 前缀**——edge 把裸 `/api/*` 路由给 dashboard 壳（SPA fallback
>    404/403），真实 API 在 `/api/proxy/api/*`。`OPENSHIP_URL` 变量必须指到代理前缀（本文
>    §8 的示例 URL 里的裸 `/api` 路径在本控制面拓扑下同样要加前缀）。
> ② **PAT 端点在控制面「设置 → API 令牌」**；scoped PAT 触发部署需要**两条 grant**：
>    `{resourceType:"project", resourceId:"proj_xxx", permissions:["write"]}` 让 deployment:write
>    过，**外加** `{resourceType:"github_repository", resourceId:"OWNER/REPO", permissions:["read"]}`
>    ——deploy 入口有 `assertGitHubRepoAccess(op=read)` 前置（github-access.ts），scoped
>    principal 的 GitHub 权限只来自 github_* grant，缺了就 403 `GITHUB_ACCESS_DENIED`
>    （"You don't have access to OWNER/REPO"——文案酷似授权配置错误，极易误诊；2026-09-14
>    曾据此误判为「控制面版本旧、上游已修」，实测 v0.7.2 本就如此，与版本无关）。
>    另：403 body 若是 "already in progress" 则是**部署互斥**（#59 已加 CI 重试），先读 body 再下结论。
> ③ dashboard 会话创建 PAT 的 POST `/api/proxy/api/tokens`，值只在响应里出现一次。

### 8. 验证（首次部署后逐条做）

```bash
curl -fsS "$OPENSHIP_URL/api/projects/$PROJECT_ID/deployments" -H "Authorization: Bearer $TOKEN" | head -c 400
# ① 部署状态到 live/success，没卡在 pending-actions（卡住就看 get_projects_by_id_pending_actions）
curl -i https://platform.<公司域>/healthz          # → 200 {"ok":true}
curl -i https://platform.<公司域>/login            # → 200 text/html（SPA 首页）
curl -s https://platform.<公司域>/api/platform/branding   # → 该租户的品牌 JSON
```

再看容器日志里**不得**出现 `[web] ... 不存在，跳过静态托管`（出现即白屏前兆，见「已知陷阱」）。
最后的逐项人工清单在 `docs/m0-smoke-checklist.md`。

### 9. 回滚

```bash
# 回到上一个部署（openship 原生回滚，按 commit 或快照）
curl -fsS -X POST "$OPENSHIP_URL/api/deployments/$DEPLOYMENT_ID/rollback" -H "Authorization: Bearer $TOKEN"
```

## audit 保留（`platform.audit` 清理）

登录端点**每次登录尝试（成功 / 失败都算）**都会写一行 `platform.audit`——成功路径同样落审计
（`apps/server/src/routes/auth.ts:121`、`apps/server/src/routes/auth-wecom.ts:272`）。限速器
（`apps/server/src/rate-limit.ts`）把写入速率压到**有界**：失败路径另有「单账号 5 次/15 分」与
「租户 300/分」两道，成功路径只计入「租户全部尝试 1000/分」这一道兜底桶。但它并不改变
"会一直长"这件事——所以保留策略必须单独做。

清理由 **openship job** 定时执行，**应用进程不自己跑**（有副作用的运维动作不该藏在一个 HTTP
服务里）。函数与索引来自 `apps/server/src/migrations/002_audit_retention.sql`：

```bash
# 每日一次；默认保留 90 天。返回值 = 删除行数（便于在 job 日志里核对）
psql "$DATABASE_URL" -c "select platform.prune_audit();"
```

- 保留期按需传参：`select platform.prune_audit(180);`
- job 的建立方式见 openship 面板「Jobs」；建议同时订阅**失败通知**（job 静默失败 = 清理没发生，
  而这件事从应用侧完全看不出来）
- 删除行数写进 job 日志才有意义：长期恒为 `0` 是正常的（无超期行；`prune_audit` 返回的是
  `select count(*)`，只会 ≥ 0，**不存在"为负"这种形态**）。真要从日志里追的是 job **报错**
  ——那才意味着清理没发生

## 已知陷阱（都是本仓实测或从既有项目教训里抄来的）

1. **静态托管静默降级**：`app.ts` 的 `webDistDir` 按【`apps/server/src/app.ts` 自己的位置】解析
   `../../web/dist`。镜像里 `apps/` 与 `packages/` 的层级被打散 → 该目录不存在 → 只打印一行
   warn 就继续启动（`/healthz` 照绿、页面白屏）。容器日志里搜 `跳过静态托管` 是唯一的现场证据。
2. **启动期连不上 Casdoor 就起不来**（设计如此，fail-fast）：装载器会按 `platform.tenant` 的
   每个租户 org 调 `upsertPermission`——**`single` 与 `multi` 都一样**（M1 起 `multi` 不再跳过
   供给）。**别把 Casdoor 排在平台容器后面部署**；共享 SSO 短暂不可用时，`restart: unless-stopped`
   会让容器反复重启直到它恢复。
   另：`CASDOOR_ADMIN_USER`/`_PWD` 在 M1 起是**必填**，缺了在配置装配阶段就报错——不要试图
   靠"不配凭据"来跳过启动期供给：登录本身也要 admin 会话，缺了谁都拿不到会话。
3. **境内构建可能很慢**：镜像构建要现拉 pnpm（corepack）与整棵依赖树。本机（macOS + 已缓存）
   构建约 2 分钟；生产机如果直连 npm 官方源被限速，可参照 `data-platform-scaffold` 里
   `core/gateway/Dockerfile` 的 `ARG NPM_REGISTRY` 办法加国内镜像源（本 Dockerfile 目前
   **没有**这个 ARG，属已知留白）。
4. **compose 默认项目名 = compose 文件所在目录名**。本仓 compose 在 `deploy/` 下，**任何**同样
   把 compose 放 `deploy/` 的仓库都会得到同一个项目名，互相接管容器与卷。仓库里的 compose 已用
   顶层 `name: platform-core` 钉死（见该文件注释里的实测事故），生产侧若由 openship 指定项目名，
   以 openship 为准。
5. **升级到「声明即授权」那一版时，老模块会让进程【启动即死】**（破坏性变更，动作必须做）：
   `manifest.api.internal[]` 从 `{name, scope}` 变成 `{method, path, scope}`，且装载器起做
   双向核对——**只要模块注册过路由却没写 `api.internal`（或还写着旧形状），宿主进程直接起不来**，
   而不是"少一道鉴权"。失败信息带双向差集原文（`未声明但已注册 [...]`），照它逐条补
   `method`/`path`/`scope` 即可。做法：升级前先用
   `pnpm exec tsx scripts/check-manifests.mjs`（静态消费方，与装载器同一套 schema）把全部模块过一遍，
   把要补的清单一次性列出来；**别**指望"先上线再一个个补"——任何一个模块没补上，整台宿主的
   进程都起不来（模块是同一进程内装载的，没有单模块降级形态）。
   `app.all('/x', h)` / `use(路径, 终结 handler)` 这类多方法端点同理：要么逐 method 声明，
   要么改成显式 method 路由（详见 `docs/module-protocol.md`）。

## 相关

- `deploy/docker-compose.yml` —— 部署单元 A 的编排事实源（仓内只有**两份**：本份 + `deploy/data-compose.yml` 部署单元 B/数据面；约束 B7 机检守卫：`scripts/check-compose.mjs`）
- `deploy/Dockerfile.server` —— 宿主镜像；文件头写了三条「容器里跑挂了先回来对」的目录契约
- `.env.example` —— env 键全集的声明面（约束 B9 机检守卫：`scripts/check-env-example.mjs`）
- `.github/workflows/ci.yml` —— `deploy` job 的定义与惰性闸门
- `docs/m0-smoke-checklist.md` —— adopt 之后逐项勾选的人工验收清单
- 标准：`team-harness/docs/standards/cicd-project-onboarding.md`（本 runbook 是它在
  `projectType=services` + GitHub 源这一形态下的具体化）
