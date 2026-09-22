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

### 0.1 客户信息采集单（开工前收齐；标注阻塞的步骤）

客户侧：

| # | 采集项 | 阻塞 | 要点 |
|---|---|---|---|
| ① | 机器与网络 | 步骤 1 | 公网 IP + 与控制面的网络关系（同 VPC 走内网 / 跨 VPC 走公网，决定阶段 A 白名单配法）；docker 双容器余量即可（参照现有实例） |
| ② | Casdoor 归属 | 步骤 3/4 | 默认共用：定 org 名（建议 = 客户 slug，字母数字）。**只收一个管理员**——建号挂 `tenant:admin` 后，其余用户客户在 console M3 页自管（采集面最小化）；合规隔离则拿要求原文，独立实例单独定 |
| ③ | 域名 | 步骤 5 | 客户自有域名 + **DNS 控制人**（A 记录切换要约时间窗）；无域名用 openship 免费子域 |
| ④ | 品牌与登录 | 步骤 4 | `product_name`（控制台标题/登录页品牌）；要不要企微扫码——要则客户企微管理员提供三参（corp_id / agent_id / secret）。三参落**租户行** `wecom_corp_id/wecom_agent_id/wecom_secret`（不是 env；路由读租户行，见 `apps/server/src/routes/auth-wecom.ts`），**CLI 已有写入入口**（#115：`--wecom-corp-id [--wecom-agent-id] --wecom-secret`，corp+secret 必须同给、agent 可选随行，见步骤 4）；管理端写端点/配置页仍无（§3 边界），交付走 CLI 不受影响。**企微扫码除三参外，还差客户企微管理员在自建应用页配的两项后台开关**（值由我方提供，采集时一并约好）：**可信域名**（网页授权及 JS-SDK，填实例域名；其验证文件 `WW_verify_*.txt` 由我方经 openship 上线，口径见步骤 5）与**企业可信 IP**（填**实例机器的公网出口 IP**——gettoken 豁免此项、其余服务端 API 全受它拦；漏配 = 扫码回调 getuserinfo 报 60020，文案酷似 secret 错，极易误诊）。**另收公众号两参**：`--wechat-oa-app-id` / `--wechat-oa-secret`（客户公众号后台的 AppID / AppSecret）——同样落**租户行**（`wechat_oa_app_id/secret`），**已有 CLI 入口**（步骤 4）。⚠️ **两者是两件不同的东西**：企微 = console **内部登录**（员工），公众号 = **外部访客**登录（售后移动端，spec §1.3） |
| ⑤ | 模块清单 | 全局 | `--module` 集。仓内现有 `demo`（占位）+ **`aftersales` 售后管理**（M2a 后端 → M3a console → M3b-1 登记审批 → M3b-2 移动端 userApp，**四期已全期上线**）⇒ 真业务功能 = `--module aftersales` 一步开出。**订正（2026-09-16）**：原文写「仓内现只有 `demo` 占位模块；**真业务功能 = L1 模块开发先行**（spec-1 分级 + 模块接入流程），是试点排期的最大变量」——该判断在售后四期落地后已不成立：⑤ 由**开发级（周级）降为配置级（天内）** |

我方侧（可并行推进）：

- ⑥ 客户机阶段 A 材料（`cicd-project-onboarding` 清单：网络 → ufw 4878 → git smart-proxy → docker → 注册 server）
- ⑦ env 值备好：`PLATFORM_SESSION_SECRET` 随机生成、Casdoor 凭据、`PUBLIC_ORIGIN=https://<域名>`、
  **`--module` 含 `aftersales` 时另备 ZOS 五个键**（`AFTERSALES_ZOS_*`，见步骤 3）
- ⑧ 验收记录：六步成功判据逐项勾 + M1c 两笔销账（single 试点 + multi 测试租户，见 AGENTS.md 债账）

两条提示：①–⑤ **现在都是配置级**（天内）——⑤ 的订正见上（售后四期已上线，`--module aftersales`
即得一套真业务功能）；但「**演示什么**」仍要先问：落在**已上线模块之外**的诉求才是新的开发级变量
（L1 模块开发先行，spec-1 分级 + 模块接入流程）。共用 Casdoor 的 org 命名一旦定了不轻动
（租户行、权限桶、订阅 plan 都锚它）。

> **试点可演示的完整链路（2026-09-16，售后 M3b-2 上线后）**：**公众号访客登录 → 移动端提交工单
> （含图片/视频 ZOS 直传）→ console 处理按规则算金额 → 状态流转**。移动端入口
> `https://<客户域名>/app/aftersales`（manifest `frontend.userApp.mount`）。
> 前置两件（缺任一则链路断在各自那一段）：步骤 3 配齐五个 `AFTERSALES_ZOS_*` env（缺 = 提交页传图 503）、
> 步骤 4 带 `--wechat-oa-*` 两参（缺 = 访客登录 404）。⚠️ 这条链路的**「真壳 + 真访客」段本地验不了**
> ——`MockCasdoor` 只做 Casdoor、不做公众号 OAuth ⇒ 本地拿不到访客 session（售后 spec §5 #13），
> 只能在客户机上验；**别把「本地全绿」读成「端到端验过」**。

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

**共用 Casdoor 前置（#117 正典，先做这一步再配 env）**：给客户 org 建一个 application。
Casdoor 后台（platform 超管）建：owner=`admin`、organization=`<客户 org>`、名字建议
`<客户slug>-app`（山海实录：`shanhaiyiguo-app`，对照既有 `customerb-app` 形状）。两个硬理由：

- **org 至少要有一个 application**，provision CLI 的 `ensureAnchorUser`（add-user）才不被拒
  （#117 真机：`The organization: <org> should have one application at least`）；
- 下面的 env **三键指向它**——application 不自动建（含 clientId/redirectUris 等丰富形状，
  CLI 不代生成），人工建是正典；org 本身由 CLI `ensureOrg` 建（#117 修复后带
  owner=admin + passwordType=bcrypt，写后回读验形状）。

先 env（MCP `patch_projects_by_id_env`，environment=production）：

| 键 | 值 |
|---|---|
| `TENANT_MODE` | `single` |
| `PLATFORM_ORG` | `<客户 casdoor org>` |
| `CASDOOR_URL` | 我方 sso（默认）或客户独立实例 |
| `CASDOOR_APPLICATION` | **上面建的 `<客户slug>-app`（客户 org 自己的 application）** |
| `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` | **同一个 application 的三件套之二**（application 页取，secret 走 isSecret） |
| `CASDOOR_ADMIN_USER` / `CASDOOR_ADMIN_PWD` | Casdoor 管理员（admin API 会话登录用；pwd 走 isSecret） |

> ⚠️ **三键必须指向客户 org 自己的 application**（#117 山海实测）：沿用 `app-built-in` /
> admin 侧应用 ⇒ 登录链路断（`/api/login` 的 application 形参对不上用户 signupApplication
> 所属）。三键指同一个 application，别一半旧一半新。
| `PLATFORM_SESSION_SECRET` | 随机生成（isSecret） |
| `PUBLIC_ORIGIN` | `https://<客户域名>` |
| `PLATFORM_SUBSCRIPTION_SOURCE` | `casdoor`（**新交付一律 casdoor 源，全平台单一口径**；platform 源仅我方实例回滚兜底） |
| `AFTERSALES_ZOS_ENDPOINT` | 天翼 ZOS（S3 兼容）端点（**可省协议**，代码补 `https://`；如 `zos.xinan1.ctyun.cn`） |
| `AFTERSALES_ZOS_REGION` | ZOS 区域（如 `xinan1`） |
| `AFTERSALES_ZOS_BUCKET` | 附件桶名 |
| `AFTERSALES_ZOS_ACCESS_KEY` | ZOS 访问密钥 AK（**isSecret**） |
| `AFTERSALES_ZOS_SECRET` | ZOS 密钥 SK（**isSecret**） |

⚠️ 后五行（售后附件存储）：**只要 `--module` 集里含 `aftersales`，每个租户就必须有一份可用的存储配置**
——要么由这五个 env 键充当**平台默认**，要么该租户在管理端「存储配置」页配自己的桶。
凭证只有这两个落点（env 或租户行），我们侧备好给 MCP 设 isSecret。**漏配不是启动报错**：
五键缺任一 ⇒ 没有平台默认（SDK 的 `platformStorageFromEnv` 回 `null`），**服务照常起、其余功能照常**，
但**既没 env、又没配自己桶**的租户，附件端点回 **503 `ZOS_NOT_CONFIGURED`**——而移动端提交页的核心
就是传图/传视频（平台 bodyLimit ~1MiB，字节只能走预签名直传，见 storage.ts 文件头）。成功判据：提交页传图能拿到预签名 URL 并 PUT 成功
（并入步骤 6 冒烟）。

> **M3c（2026-09-17）起：上面五个 `AFTERSALES_ZOS_*` 的语义是「平台默认」，不再是唯一来源。**
> 宿主按**请求所属租户**解析存储配置（租户自己在管理端「存储配置」页配，落 `platform.tenant` 五列）：
> **五列全空** ⇒ 回落这五个 env 键；**五列全填** ⇒ 用该租户的桶。两处容易踩的：
> - **部分填写 ≠ 回落**：租户行只填了一部分 ⇒ **不注入**，附件写路径回 **503**
>   （fail-explicit；**绝不**悄悄写进平台桶 —— 那会让「租户以为附件在自己桶里、实际在平台桶」）；
> - **env 与租户都没配** ⇒ 附件端点回 **`503 ZOS_NOT_CONFIGURED`**（与 M3c 之前的表现一致）。
>

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
  --product-name <产品名> --login-methods password[,wecom-qr] --domain <客户域名> \
  --wechat-oa-app-id <公众号AppID> --wechat-oa-secret <公众号AppSecret> \
  --wecom-corp-id <企微企业ID> [--wecom-agent-id <企微应用ID>] --wecom-secret <企微应用Secret>
```

`--wechat-oa-*` 两参（**可选**，来自 §0.1 ④）：写租户行 `wechat_oa_app_id/secret` 两列，
即**该租户的访客登录启用开关**（启用判定就是「配置存在」，不是 `login_methods`，
`apps/server/src/routes/auth-wechat-oa.ts`）：

- **必须成对**：只给一个 = 参数错误，入口响亮报错（写半个 = 看起来配了其实不启用）。
- **secret 不进日志**：CLI 只回显 `wechat-oa <appId 前 6 位…>`，secret 只落库；本命令本身
  含明文 secret，**不要贴进 issue / 群 / 截图**。
- **不配**：该租户 `/silent` 直接 404 `WECHAT_OA_NOT_CONFIGURED` ⇒ 公众号访客登录路走不通。
- **幂等**：重跑一次**不带**这两参**不会**清掉已配好的两列（`on conflict do update` 只改本次列出的列）。

`--wecom-*` 三参（**可选**，#115，来自 §0.1 ④）：写租户行 `wecom_corp_id/agent_id/secret` 三列，
即**该租户的企微扫码启用开关**（启用判定 = corp_id + secret 成对存在，`apps/server/src/routes/auth-wecom.ts`）：

- **corp_id 与 secret 必须同给**：单给任一 = 参数错误，入口响亮报错（消费方判定只看这两列，
  写半个 = `WECOM_NOT_CONFIGURED` 半途态）。**agent_id 可选且仅随行**：单给 agent（不给前两者）
  同样报错；给了才写库 ⇒ 后补/改 agent 用全三参重跑即可。
- **secret 不进日志**：CLI 只回显 `wecom <corpId 前 6 位…>`，secret 只落库；同上**不要贴明文**。
- **不配**：console 企微扫码 tab 不可用（`--login-methods` 里配了 `wecom-qr` 也登录不了，
  404 `WECOM_NOT_CONFIGURED`）。
- **幂等**：重跑一次**不带**三参**不会**清掉已配三列；不带 agent 的重跑也不清已配的 agent 列
  （`on conflict do update` 只改本次列出的列，真 PG 三场景核过）。

成功判据：逐步 ✓ 打印到 `permissions ×N`（N = 模块码数 + 1，含 tenant:admin）与
`subscribe mod-<id>`、`domain <host>`、带两参时的 `wechat-oa <appId 前 6 位…>`、
带三参时的 `wecom <corpId 前 6 位…>`；**幂等可重跑**。

> ⚠️ **#117 修复后的响亮失败口径**（改前是「✓ org 假绿、晚到 ensureAnchorUser 才炸」）：
> `ensureOrg` 报「同名 org 已存在但单查失明」= 旧版 CLI 建出的 owner≠admin 畸形 org——
> 按报错提示人工删建（Casdoor `delete-organization` 走 JSON body `{owner,name}`，重建时带
> `owner:'admin'`），再重跑 CLI。`ensureAnchorUser` 报 `should have one application at least`
> = 步骤 3 前置的 application 没建——回去建完再重跑（幂等，重跑无副作用）。

> ⚠️ **重跑（含只为改三参/两参的重跑）必须把 `--product-name` 与 `--login-methods` 带全**
> （2026-09-19 山海换企微应用实测踩中）：租户行 upsert 对 `casdoor_org / product_name /
> login_methods` 三列**恒写**——不传就落 fallback（品牌洗成 slug、login_methods 洗成只剩
> `password` ⇒ 登录页企微 tab 消失）。上面两条「幂等不清列」的语义**只对企微三参与公众号
> 两参列成立**（`tenantRowUpsert`：这三列在每次 upsert 的 set 清单里，另五列给了才写）。

### 步骤 5：域名与证书

MCP `post_domains`（projectId、hostname=<客户域名>）→ `post_domains_by_id_verify` →
`post_domains_by_id_verify_ssl`。DNS 由客户侧先把 A 记录指到机器公网 IP。

**企微可信域名验证文件（`WW_verify_<code>.txt`）——openship 服务级注入口径（2026-09-19
起正典，零 PR 零发版零升级窗口）**：

1. MCP `patch_projects_by_id_services_by_serviceId`（server 服务）传
   `advanced: {files: [{path: "/app/apps/web/dist/WW_verify_<code>.txt", content: "<验证码>"}]}`
   （`advanced` 是**合并**语义，多个应用 = files 数组多行，每应用一个码）；
2. MCP `post_deployments_build_access`（environment=production，`serviceIds` 与
   `refreshServiceIds` 都带上 server 服务）——refresh 重建，秒级、不重构建；
3. 成功判据：`curl https://<客户域名>/WW_verify_<code>.txt` 回 **200 且内容逐字一致**，
   再让客户企微管理员在可信域名处点「验证」。

机制与实测（我方实例三验全过，2026-09-19）：宿主 `serveStatic` 按请求读磁盘（`app.ts`），
openship 把文件**挂载**进容器 dist（部署日志 `mounted N generated config file(s)`）；refresh
重建与 git 完整部署（含 compose 同步）后文件**都在**。删除 = `advanced.files` 置 null +
refresh；删后该路径落 SPA 兜底回 index.html——企微要逐字码，缺 = 响亮失败，不假绿。
**历史仓内口径（PR #29/#120，文件提交 `apps/web/public/` 随构建带出）已退役**：仓内旧文件
保留不迁移，新文件一律走注入。企微接入四要素全景（三参/可信域名/可信IP/扫码人账号）见
WeKnora 条目「企微自建应用接入 platform-core」。

### 步骤 6：冒烟

按 `deploy/README.md` 的部署后验证（容器创建时间 vs 镜像构建时间、新行为可观测）+
`docs/m0-smoke-checklist.md`。登录一口：CLI 建的是租户与订阅，**第一批用户要在 Casdoor
建号并挂码**：

- **挂码口径**：客户管理员挂 `tenant:admin`（console「管理」菜单组可见，M3 页自管）**加**
  `--module` 集各模块的**管理码**（aftersales = `aftersales:manage`——只挂 tenant:admin
  能进 console 但模块页 403；访客码 `aftersales:guest` 是移动端会话派生用的，不用挂人）。
- **建号/改密码口径**（#119 订正，2026-09-22）：Casdoor **add-user 与 set-password 都在服务端哈希**；
  而 `update-user` 的列白名单**不含 password**（`object.UpdateUser`，v1.0.0→master 8 版一致）⇒
  拿它改密码是**静默空操作**（回 ok、旧密码照旧可用），**不是**"写入明文/把账号锁死"（#117 现场的
  反推已订正）。⇒ 建号走 add-user（或 console M3 页）；**改密码走 console M3 的「重置密码」**
  （`resetUserPassword` 调 Casdoor 专用端点 `POST /api/set-password`，**form-urlencoded**）——它只写
  user 行的 password 几列，**不删号**，第三方绑定（企微/钉钉/飞书）与 roles 完整保留。
  两道闸防"静默改密不生效"：**前置**该 org 必须配 `passwordType`（空则 `cred.GetCredManager`
  回 nil ⇒ 不哈希，客户端直接拒绝执行）+ **写后回读** user 记录的 `passwordType`。
  **不要**用 update-user 改 password（无效），**也不要**再走"删号重建"（第三方绑定不可逆丢失）。
  ⚠️ 改密**不踢**既有会话（Casdoor 的 kick 只跟 is_forbidden/is_deleted 走）——要"重置即下线"需平台侧另做。

浏览器级冒烟用仓内脚本（#117 进仓固化，替代临时的 /tmp 版）：

```sh
SMOKE_BASE=https://<客户域名> SMOKE_USER=<冒烟账号> SMOKE_PASS=<密码在哪见下> \
  SMOKE_BRAND=<产品名> node scripts/smoke-delivery.mjs
```

断言集：登录页品牌 + 企微 tab → 表单登录落 `/console` → 管理菜单组（tenant:admin 证据）→
模块页无 403（模块码证据）→ 移动端壳 HTTP<500。截图落 `/tmp`（`SMOKE_OUT` 可改）。
凭据取法：冒烟账号在 Casdoor 客户 org 建号并挂码（同上口径），**密码只存在 openship env /
交付记录，不进仓、不进命令行参数**（脚本只从 env 读）。

**访客链路也只有在这里能验**（本地验不了，见 §0.1 链路一段）：公众号内打开
`https://<客户域名>/app/aftersales` → 登录（应拿到访客 session，不是回登录页）→ 提交一张带图的
工单（图片应直传 ZOS 成功）→ console 处理按规则出金额 → 状态流转到终态。

## 2. 升级 SOP

- **我方托管实例**：CI 自动（merge main 即部署，现状不动）。
- **客户实例**：维护窗口内逐家 MCP `post_deployments`（**必须带 serverId**、branch=main）。
  先通知客户定窗口；一次窗口内多家顺序执行，每家 ready 后再下一家。
- **回滚**：MCP `post_deployments_by_id_rollback`（每 project 独立回滚窗，互不牵连）。
- 批量脚本：3 家以上再立项（spec-3 §0 方案 B）。

## 3. 边界

- **租户级外部接入参数的运营面写入入口仍无（已知边界）**：公众号两参（#88）与企微三参（#115）
  的**交付路径**都已在 `scripts/provision-tenant.mjs`（步骤 4），但**管理端写端点与 console 配置页**
  两族都还没有（改配置 = 重跑 CLI）——交付不受影响；运营面需求（租户自助改配置）出现再立项。
- 独立 Casdoor 实例的部署与运维归属：特殊情况按客户单独定，本文不展开。
- 壳层定制（布局/导航/多语言）：**L2 车道未建前不接**（spec-1 §1），立项信号 = 第一个真实壳层需求。

## 4. 交付实录（真实案例沉淀——无案例不立标准，本文新增口径全部溯源到这一单）

### 2026-09-19 山海一果（第一单，`platform.shanhaiyiguo.com`）

**形态**：客户机独立实例（TENANT_MODE=single）+ 共用 sso.hookflow.cn（org
`shanhaiyiguo-org`，application `shanhaiyiguo-app`）+ 自有域名 + `--module aftersales`
（含 ZOS 五键、公众号两参、企微三参）。

**踩坑（= issue #117，三层真机缺陷，provision CLI 前两轮失败、第三轮全绿）**：

1. `ensureOrg` 的 add-organization body 缺 `owner` ⇒ 建出 owner="" 畸形 org：get-organizations
   列表可见、get-organization 单查失明（按 (owner,name) 查询）⇒ 「✓ org」假绿，晚到
   ensureAnchorUser 才报 `The organization: <org> does not exist`；
2. 缺 `passwordType` ⇒ 该 org 用户密码登录报 `unsupported password type: `；
3. `ensureAnchorUser` 的 add-user 缺 `signupApplication` + org 零 application ⇒ 被拒
   (`should have one application at least`)；两处写操作 200+status:error 被吞。

**修法（本仓 PR，Closes #117）**：CLI 侧补 owner/passwordType/signupApplication + 写后回读
验形状 + status!=='ok' 即抛 + 畸形 org 给处置线索；mock-casdoor 按真机形状收严（org/application
域 + add-user 两前置）；本文步骤 3/4/6 的新口径即由此立。

**当场处置（下一家别再踩）**：手工 `delete-organization`（JSON body）删畸形 org → 带
owner='admin' 重建 → `add-application` 建 `shanhaiyiguo-app`（org=shanhaiyiguo-org）→
env 三键改指该 application → 第三轮 CLI 全绿（permissions ×5 + subscribe mod-aftersales）。

**验收**：浏览器冒烟（本单用的 /tmp 临时版即 `scripts/smoke-delivery.mjs` 的前身）全过——
品牌/企微 tab/表单登录/console 管理菜单组/模块页无 403/移动端壳。

**同日闭环（换应用 1000012 后，交付当天全部收口）**：企微三参轮换（1000009→1000012，
重跑 CLI 的品牌/登录方式被洗——坑即步骤 4 的重跑警示）→ WW_verify 文件上线（PR #120，
**末代仓内口径**；此后新文件一律走步骤 5 注入）→ 企微后台可信域名（`platform.shanhaiyiguo.com`）
+ 企业可信 IP（实例出口 `113.249.104.181`）配齐 → 首管理员 ZhangDuo 建号挂码
（`tenant:admin` + `aftersales:manage`，name=企微 userid）→ **企微扫码登录机器验证通过**
（审计 `login.ok via=wecom-qr`，2026-09-19）。**未验（本单剩余）**：公众号访客链路
（待客户公众号侧可信域名 + 真机验证，见步骤 6）。

**销账**：本单即 M1c「single 试点端到端验收」的实录（AGENTS.md 债账对应项）。
