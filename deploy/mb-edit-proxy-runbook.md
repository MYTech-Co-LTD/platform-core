# Runbook：报表编辑页反代（**每客户接线** SOP）

## A 定位与案例

> **适用**：把报表**编辑页**（Metabase 编辑态）经专用反代搬进平台后台（spec §3⑦「甲」形态）后，
> **为某一个客户接通它的专用入口**——专用 host、平台↔Metabase 网络、env、启用开关、验收。
>
> **不适用**：数据面本身的部署（那是 `deploy/data-plane-deploy-sop.md`）；平台面 adopt（那是
> `deploy/openship-adopt.md`）；SaaS（`multi`，不走专用 host，见 `customer-onboarding.md §8`）。
>
> **为什么不并进 `data-plane-deploy-sop.md`**（本条是有意的切分，不是随手新建）：
> ① 反代服务 `mb-proxy` 住在**平台部署单元**（`deploy/docker-compose.yml`），而它要连的 Metabase
> 住在**数据面**——这是**跨单元**的一条线，两边各自的 SOP 都只讲单侧；
> ② 本 SOP 的验收判据（§C，①–⑫）是 **Task 7 要逐条勾的清单**，独立成文才勾得动；
> ③ 「每客户接线」是**重复执行**的动作（每接一个客户走一遍），与数据面「从零到验收」的一次性序列
> 不同节奏。

**形态来源（沿用既有先例，未另起文风）**：

- **专用 host + 暴露服务 + 签证书**的序列 → `openship-adopt.md §4`（含「**先暴露服务再加域名**，
  否则路由同步会把域名剪掉」那条订正）；
- **跨单元 `docker network connect` 接线 + DNS/TCP 分开判 + 重建后必重做**的范式 → `data-plane-deploy-sop.md`
  **P7**（`pg_duckdb` 先例；含「平台镜像里没有 `nc`，用 node 断言」这条）；
- **一客户一 project / 一机不够才沿缝拆**的口径 → `customer-onboarding.md §0`。

**案例状态（无案例不立标准）**：

- 本 SOP 的**形态**逐条有真机出处（见上）；但**本 SOP 自身的接线读数尚未产生**——它是 Task 7 的产物，
  回填到 §F「实测记录」。**在那之前，§C 的判据是「必须打勾的清单」，不是「已被验证的结论」。**
- 凡本 SOP 里标「**待真机核实**」的条目，都是**没有本仓案例**的推断，照做时先验证再相信。
- ⚠️ **本 runbook 是新接线、尚未固化为工具**：P7 那条先例已经把「重做 + 断言」固化成脚本
  （`scripts/lemeng/wire-warehouse.sh` → 投递为 `/opt/lemeng-wire-warehouse.sh`，配探活 job），
  并明确「**别照文档手敲**」。**本 SOP 的 §B-E3 目前仍是手敲**——按同一口径，
  下次接线时应把 E3 抽成脚本 + 探活 job（掉了要能告警，而不是等人发现编辑页打不开）。

**两道安全阀**：

1. **env 先于启用**：`MB_PROXY_CONSOLE_ORIGIN` 等键**没备齐就把该服务置 `enabled: true`** ⇒
   mb-proxy 启动期直接抛（fail-fast）⇒ **crash loop + 健康看板开事故**。顺序不能反（§B-E1 → §B-E2）。
2. **接线是运行态步骤**：`docker network connect` 不是配置——**容器/网络重建后要重做**（P7 同款）。
   掉了只有「编辑页打不开」，别处**没有任何报错**（§B-E3）。

---

## B 操作单（E0–E5）

> **依赖关系（先看这句，别只靠编号猜）**：
> **E1（备 env）⇒ E2（让服务存在：服务面 → 开关 → 暴露+绑域名 → 定向部署）⇒ E3（网络接线）/ E4（域名证书 + edge 探活）⇒ E5（§C 逐条验收）**。
> 两条硬依赖：
> ① **E1 早于一切服务动作**——`MB_PROXY_CONSOLE_ORIGIN` 没备齐就启 mb-proxy ⇒ 启动期抛（crash loop）；
> ② **E2 早于所有「可观测断言」**——`/healthz`、两条 node 断言、edge 探活**都要 mb-proxy 的服务行与
>    容器先存在**；没有它，那几道门**不可能通过**。
>
> ⇒ **先让服务存在，再断言**。⚠️ 本 SOP 的**上一版把断言排在了「让服务存在」之前**（且写着「E1 未过
> 就不要进 E2」）——那样照顺序执行，**第一步就撞上一道不可能通过的门**。本版已按依赖重排。
>
> ⚠️ **E3 与 E4 同层**（都在 E2 之后、都只需 E2 的容器已存在），**两者之间无依赖**：
> 接线不依赖证书、签证书也不依赖接线。**但 `/healthz` 只证 E2/E4，不证 E3**——
> 它免鉴权、**不触上游**（`apps/mb-proxy/src/app.ts`），过了只说明「edge 路由 + 证书 + 容器」通了。
>
> 每 Phase 三件套：**动作 / 命令或面板路径 / 过门条件**。过门条件不满足就停在那一步。

### E0 盘点与前置决策

| 动作 | 命令 / 面板 | 过门条件 |
|---|---|---|
| 定专用 host 名 | 拍板：`mb.<客户域>`（**只写占位，不写具体域名**） | host 名在手，且该客户**尚未占用**它 |
| 定 console origin | 取该客户项目的 `PUBLIC_ORIGIN`（**逐字**，见 §B-E1 表） | 一个 `https://<host>`，**无路径、无尾斜杠** |
| **取票前置：调用者须持 `data:manage`** | `GET /reports/:id/edit-url` 的页门由 manifest 声明为 **`data:manage`**（`modules/data/manifest.yaml`；宿主门卫按声明施加）。**运维/验收账号必须有该 scope** | 缺 scope ⇒ **403 `{"error":"FORBIDDEN","need":"data:manage"}`**（**不是**「编辑页坏了」——**别对着 403 猜**）。⚠️ **`UNAUTHENTICATED` 的码位别归错层**（订正 2026-09-29，终审 I-1）：**完全未认证经宿主门卫是 `401`**（`apps/server/src/loader.ts` 的通配 fallback：`!identity ⇒ 401 UNAUTHENTICATED`；`packages/platform-sdk/src/module.ts` 的 `requireScope` 同形）；而 **`403 UNAUTHENTICATED` 来自模块自身**的 fail-closed 守卫（`modules/data/routes/reports.ts`：门卫放行了但 `requesterOf(c) === null` ⇒ 取不到 requester/orgId）。⇒ 见 401 = 「没登上/会话没了」，见 **403 `UNAUTHENTICATED` = 「门卫放行但模块取不到身份」（配置/上下文问题）**，两者不是一回事 |
| **专用 host 与 console 必须同父域（same-site）** | 拍板 host 名时一并定：console 的 host 与专用 host 必须**互为兄弟子域**（同一 registrable domain，形如 `platform.<客户域>` + `mb.<客户域>`） | 两者**同 registrable domain**（cookies 的 same-site 判据）；⚠️ **缺这条 ⇒ 编辑页 401 + 白屏且线上静默**——理由见本节末注 |
| 同机还是拆缝 | 见 `customer-onboarding.md §0` / `§3 决策 1` | 拍板：**平台单元与数据面单元是否在同一台机**。⚠️ **这一条决定 E3 有没有通路**：`docker network connect` 要求**同一 docker daemon**，且 `data-compose.yml` 的 metabase **不发布宿主端口** ⇒ **数据面在另一台机时本 runbook 无任何通路**（分支说明见 §B-E3） |
| 目标机在线 | openship 面板「服务器」页（控制面 servers 列表） | serverId 在手、机器在线 |
| 该客户已登记 ≥1 张 Metabase 报表 | 平台后台报表页 | 有 `renderer='metabase'` 的行（`platform` 自绘行没有可编辑的页，`GET /reports/:id/edit-url` 回 409 `RENDERER_NOT_EDITABLE`） |

> ⚠️ **为什么「同父域」是硬前提（订正 2026-09-29，终审 I-4）**：编辑页是在 console 的 **iframe** 里打开的
> （`modules/data/console/reports/index.tsx` 的编辑面板），而反代发的 `mb_edit` 是
> **`SameSite=Lax`**（`apps/mb-proxy/src/session.ts`：`Path=/; HttpOnly; Secure; SameSite=Lax`，**无 `Domain`**）。
> `Lax` 只放行 **same-site** 的请求；iframe 属**子资源**、不是顶层导航 ⇒ **跨站时浏览器根本不带这枚 Cookie**
> ⇒ iframe 内 401 + 白屏（console 只看得到一块空白，**别处没有任何报错**）。
> **§C ⑨ 盖不住这条**：⑨ 比对的是 CSP `frame-ancestors` 的 **origin**（「谁能嵌」），
> 而 same-site 是 cookie 的**发送**判据（「嵌进来时带不带凭证」）——两件事，各查各的。

### E1 备 env（**最早**；服务能启动的前提）

**在该客户项目的 project env 里备齐下列键**（openship MCP `patch_projects_by_id_env`；
面板：项目 → 环境变量）。**密钥一律 `isSecret`，值不进本文、不进 git**。

| 键 | 值形态（占位） | 用途 / **取值位置** | 是否新增 |
|---|---|---|---|
| `MB_PROXY_PUBLIC_ORIGIN` | `https://mb.<客户域>` | **模块**（`GET /reports/:id/edit-url`）用来拼 handoff URL。**缺配 / 非 https / `PLATFORM_SESSION_SECRET` 过短** ⇒ 该端点 **503 `EDIT_PROXY_UNCONFIGURED`**（尾斜杠**会被归一**，不 503——见下注） | **本计划新增** |
| `MB_PROXY_CONSOLE_ORIGIN` | `https://<console origin>` | **代理**用来设 CSP `frame-ancestors`。**必填**——缺则 mb-proxy **启动期抛**（故**未备 env 之前不得启用该服务**） | **本计划新增** |
| `PLATFORM_SESSION_SECRET` | （≥32 字符） | 派生 handoff / 会话两条子密钥（模块签、代理验）。**取值位置**：openship 项目 env `isSecret`（已有键，复用） | 复用 |
| `DATA_METABASE_URL` | 见下「两种形态」 | 代理的上游基址；**也是模块报表面 facade 的上游**（同一把口径） | 复用 |
| `DATA_METABASE_API_KEY` | （服务身份） | 代理调上游用的 **`x-api-key`**（与模块同一把，服务身份）。**取值位置**：openship 项目 env `isSecret` | 复用 |
| `PORT` | `13010` | mb-proxy 容器内监听端口。**compose 已写死**（`environment.PORT`），一般**不必**在 env 里再配 | 复用（compose 内定） |

> ⚠️ **尾斜杠的实测口径（别写反）**：`MB_PROXY_PUBLIC_ORIGIN` 的**尾斜杠是归一**，不是 503——
> 模块侧 `.replace(/\/+$/, '')` 之后再校验（`modules/data/routes/reports.ts`），代理侧
> `MB_PROXY_CONSOLE_ORIGIN` 同样先归一（`apps/mb-proxy/src/config.ts`）。**503 的触发条件是
> 「缺配 / 非 `https://` / secret < 32 字符」，尾斜杠不在其列。**

**两个 origin 的取值口径（本 SOP 最容易配错的两处）**：

- `MB_PROXY_PUBLIC_ORIGIN` = **专用入口**的 origin（E2③ 绑的那个 host），**无路径、无尾斜杠**（写了也会被归一）；
- `MB_PROXY_CONSOLE_ORIGIN` = **console 的真实 origin**，**必须与该客户项目的 `PUBLIC_ORIGIN` 逐字一致**
  （`.env.example:18` 就是它；生产上 = 后台实际访问域名，形如 `https://platform.<客户域>`）。
  ⚠️ **配错的后果是 fail-open 且线上静默**：代理**剥掉了上游的 X-Frame-Options**，只用这条 CSP 兜底——
  值写错（空串/`*`/带路径）等于**任意站点都能 iframe 编辑页**（见 `apps/mb-proxy/src/config.ts` 头注）。
  代理对形状是**启动期强校验**（只许 `https://<host[:port]>`），所以写错形态 = 起不来（响亮），
  但**写成一个「合法却不是 console」的 origin** 它拦不住 ⇒ 必须靠 §C 第 ⑨ 条实测。

**`DATA_METABASE_URL` 两种形态（哪种形态用哪个值）**：

| 消费方 / 形态 | 取什么值 | 为什么 |
|---|---|---|
| **容器内消费**（mb-proxy 容器、平台 server 容器——**生产恒是这一种**） | `http://metabase:3000` | 容器里的 `127.0.0.1` 是**自己的 netns**，指不到宿主回环（P7 同款道理）；靠 E3 的 `alias metabase`（或同网络服务名）解析 |
| **宿主进程消费**（本地 dev-stack、或平台进程未容器化） | `http://127.0.0.1:13030` | `13030` 是 `deploy/data-compose.yml` 的**宿主**回环映射端口，只有宿主上的进程够得到 |

> ⚠️ **不要照抄「127.0.0.1:13030」到生产**：mb-proxy 与 server **都在容器里**，用宿主回环形态
> 会解析到它们各自的 netns ⇒ 上游不可达。生产取 `http://metabase:3000`。

### E2 让服务存在：服务面 → 开关 → 暴露+绑域名 → 定向部署

**过门条件：E1 的键全部已落**（`MB_PROXY_CONSOLE_ORIGIN` 尤其）——否则本步起的容器会 crash loop。

| 动作 | 命令 / 面板 | 过门条件 |
|---|---|---|
| ① 同步服务面 | openship MCP `post_projects_by_id_services_sync`（传回 compose 的完整 services 数组） | 服务清单里**出现 `mb-proxy` 行**（**没有它，②③ 都无从下手**） |
| ② 打开 `edit-proxy` 开关 | 服务级置启用态（面板：项目 → 服务 → `mb-proxy` → 启用；MCP 服务级 PATCH 的 `enabled:true`） | `mb-proxy` **enabled** |
| ③ 暴露服务 + 绑域名（**先暴露再部署**） | openship MCP `patch_projects_by_id_services_by_serviceId`：`exposed=true`、`exposedPort="13010"`、`customDomain="mb.<客户域>"`、`domainType="custom"`、`publicEndpoints=[{port:13010,domainType:"custom",customDomain:"mb.<客户域>"}]`。**用服务 id，不是项目 id** | 服务 `exposed=true`、`publicEndpoints` 含该 host；域名记录随之建出（§B-E4 回读） |
| ④ **定向部署**（只重建 mb-proxy） | 见下「**定向部署的正确调用**」 | mb-proxy 容器起来 |
| ⑤ 验容器**真换了** | `docker ps` 看 mb-proxy 创建时间 > 镜像构建时间；`docker inspect` 抽查 env 形状（**逐键看物化结果，不是看配置面**） | 新容器 + `MB_PROXY_CONSOLE_ORIGIN` 非空 |

**定向部署的正确调用（按真实 schema，别照抄等价项）**：

```jsonc
// openship MCP: post_deployments_build_access
{ "projectId": "<该客户项目 id>", "serviceIds": ["<mb-proxy 服务 id>"] }
```

- **依据（逐参数核对过工具 schema）**：`post_deployments_build_access` 的入参**支持 `serviceIds` /
  `refreshServiceIds`**（且 `projectId` 必填）⇒ **只有它**表达得出「只重建 mb-proxy」。
- ⚠️ **`post_deployments` 没有 `serviceIds` 参数**——它的 body 只有 `projectId` / `branch` /
  `commitSha` / `environment` / `serverId`。⇒ **照它走 = 全量部署**，会把该客户的 `pg_duckdb` /
  `metabase-db` **一并重启**。**上一版把 `post_deployments` 当成 `build_access` 的等价项，是错的且危险；
  本版已删。** **不许**留一条会被误读成「安全的部分重建」的命令。
- **若确无「只重建 mb-proxy」的路径**（本仓**未实测**过该定向部署）⇒ 只能**整栈重建**，
  **必须**：① 明写风险（重启客户 pg/Metabase，有中断窗口）；② **降级建议：先在非生产客户验证**，
  再上生产客户。
- ⚠️ **别用 `refreshServiceIds` 顶替 `serviceIds` 去表达「重建」**：`data-plane-deploy-sop.md` F.2
  实测——**单传它触发了全量重建**（把 `pg_duckdb` / `metabase-db` 一并重启）。`refreshServiceIds` 的
  语义是「**不重新构建**、只按新 env 重建点名服务」，**别拿它当重建开关用**。

> ✅ **已实测（2026-09-29，PR #366 合并当天的生产事故）**：**compose `profiles` 对 openship 部署无效**——
> 该服务照样被拉起，缺 `MB_PROXY_CONSOLE_ORIGIN` ⇒ 启动期抛 ⇒ **crash loop**（13 次重启），健康看板开事故并发出 1 条通知。
> 机制：`docker compose config` 里它确实只在 `--profile` 下出现（**本地**默认启停语义成立），
> 但 **openship 按自己的服务清单逐服务显式启停**（服务表从 compose 同步出 `mb-proxy` 一行）⇒ profile 拦不住。
>
> **⇒ 启停闸门只能用 openship 的服务级开关**（`enabled`）：
> - **停用**（默认态）：`patch_projects_by_id_services_by_serviceId`，body `{"enabled": false}`，
>   需要时再 `post_projects_by_id_services_byServiceId_stop` 立刻停机（事故会随之 auto-resolve）。
> - **启用**：先把 E1 的 env 备齐，**再** `{"enabled": true}`，然后按 §E2 的定向部署把服务起出来。
> - ⚠️ **`services_sync`（从 compose 同步服务表）可能重置 `enabled`** ⇒ **每次同步后回查该服务的开关**，
>   别让「同步一下」把闸门又打开（本次事故就是「闸门失效 + env 未备」的组合）。
> - ⚠️ 别把 `profiles` 当服务面字段传给 API（服务面认 `enabled` / `exposed` 那一套）。
>
> 服务行没出现时用「新增服务」接口按 compose 定义补一行（镜像 `platform-core-mb-proxy:local`、
> `command` 覆盖为 `pnpm --filter @platform/mb-proxy start`、端口 `13010`；E1 的 env 前提同）。

### E3 平台 ↔ Metabase 网络接线 + 断言（**同机形态下恒需接线**；跨机无通路 ⇒ 见下分支说明）

**先纠正一句陈旧口径**：`customer-onboarding.md §0` 写「一个 project 的 compose 含**数据栈全部服务**」，
**与本仓两份 compose 的事实不符**——`deploy/docker-compose.yml`（部署单元 A）**没有 metabase**；
Metabase 只在 **`deploy/data-compose.yml`**（部署单元 B）里（`deploy/data-compose.yml:61`），
而 B 是**独立 project**（`platform-core-<客户>-data`，见 `customer-onboarding.md §5 阶段 5`）。
⇒ **不存在「同一 compose 网络所以不用接线」这条捷径**；**同机形态下接线是必做的**（漏了 ⇒ 编辑页静默打不开）——**跨机形态没有通路，见下分支说明**。

> ⚠️ **分支：数据面在另一台机时，本 SOP 无通路**（订正 2026-09-29，终审 I-3——**上一条「接线恒需做」
> 只在同机形态下成立**）：
> - `docker network connect` 要求两个容器**同一 docker daemon**——跨机接不了；
> - 而 `deploy/data-compose.yml` 的 `metabase` **不发布宿主端口**（只有宿主回环 `127.0.0.1:13030:3000`，
>   `data-compose.yml:73`）⇒ 跨机时**也没有**一个可让平台侧指向的已发布端口。
>
> ⇒ 跨机（「沿缝拆开两台机」）时，本 runbook 的接线**没有任何可用通路**，结果是**编辑页打不开且线上静默**
> （别处无报错）。**跨机需另定架构**（例如数据面发布一个受控端口 / 隧道，并相应改写 `DATA_METABASE_URL`）
> ——**本仓尚无案例，标「待沉淀」，别照本文硬做**。
> **本仓默认「一客户一机」⇒ 同机才是本 runbook 的支持形态**（`customer-onboarding.md §0`）。

**接线命令（照 P7 先例；在目标机上跑，走 openship MCP `post_system_servers_by_id_exec`，别裸 SSH）**：

```sh
# ① 先取三个实名（都以实测为准，别照抄）：
#   <平台网络>      : docker network ls    → 形如 openship-<平台 project 名>
#   <metabase 容器> : docker ps            → 数据面 project 里那个 metabase
#   <mb-proxy 容器> : docker ps            → E2④ 刚起的那个
# ② 接进去（alias 固定为 metabase）：
docker network connect --alias metabase <平台网络> <metabase 容器>
```

- **alias 必须是 `metabase`**——E1 的 `DATA_METABASE_URL` 就按这个别名解析（`http://metabase:3000`）。

**重做与断言（P7 逐字同款：这是运行态步骤，容器/网络重建后必重做；DNS 与 TCP 分开判）**：
平台镜像基于 `node:22`，**没有 `nc`**；且 `nc` 报 `bad address` 是**解析失败**、不是「连不上」。

```sh
# $MBPROXY = mb-proxy 容器名（E2④ 起的那个；以 docker ps 实测为准）
docker exec "$MBPROXY" node -e "require('dns').lookup('metabase',(e,a)=>console.log(e?('ERR '+e.code):('DNS_OK '+a)))"
docker exec "$MBPROXY" node -e "const n=require('net'),s=n.connect(3000,'metabase');s.on('connect',()=>{console.log('TCP_OK');s.end()});s.on('error',e=>console.log('TCP_ERR '+e.code))"
```

预期：`DNS_OK 172.x.x.x` + `TCP_OK`。

> ⚠️ **端口是容器侧 `3000`**（Metabase 在容器里监听 3000），**不是宿主映射的 `13030`**。
> `13030` 只是 `deploy/data-compose.yml` 给**宿主机**用的回环映射（`127.0.0.1:13030:3000`）——
> 见 §B-E1 两种形态的取值口径。

### E4 域名验证 + 签证书 + edge 探活

| 动作 | 命令 / 面板 | 过门条件 |
|---|---|---|
| ① 回读域名记录 | openship MCP `get_domains`（或 `get_projects_by_id` 的域名列表） | 该 host **在列**（E2③ 暴露服务时应已自动建出；看不到就显式 `post_domains`） |
| ② DNS 落到生产机 | 按面板提示给 `<客户域>` 指向目标生产机的 CNAME/A（形态见 adopt §4） | 解析生效 |
| ③ 验证 + 签证书 | openship MCP `post_domains_by_id_verify` → `post_domains_by_id_verify_ssl`（面板：域名 → 验证 / 签证书） | **回读** `verify` / `ssl` 状态为通过——**别只看 POST 的 2xx** |
| ④ edge 探活（**本阶段第一条可观测断言**） | `curl -i https://mb.<客户域>/healthz` | **`200` + `{"ok":true}`**（`/healthz` 在鉴权之前，**不带 Cookie 也应 200**——这是「edge 路由 + 证书 + mb-proxy 容器」三者都通了的判据） |

> ⚠️ **E4④ 的 `/healthz` 失败 ⇒ 归因「容器 / 进程没起来」**（订正 2026-09-29，终审 I-2）：
> `/healthz` 在 `apps/mb-proxy/src/app.ts` 里注册在**鉴权之前**、且**不触上游**（不查 Metabase）
> ⇒ 它**与 E3 的平台↔Metabase 接线无关**。502 / 证书错 ⇒ 查 **E2（容器起没起、edge 路由绑没绑）**
> 与 **E4①②③（DNS 解析 + 验证 + 证书）**，**别去查 E3 的网络**（那是条对不上号的岔路）。

### E5 每客户接线的「收工自证」（进 §C 逐条勾）

E2–E4 过后**不要**直接收工——按 **§C 的判据（①–⑫）**逐条打勾。§C 即 Task 7 的验收清单。

---

## C 验收判据（**Task 7 逐条勾**；缺一不可）

> 前置：E2（服务启用 + 定向部署）、E3（网络接线）、E4（host + 证书）都已过门；
> 已有一枚**本租户**的有效 handoff → 已兑换成 `mb_edit` Cookie
> （经 `GET /reports/:id/edit-url` 拿 URL——**该端点需调用者持 `data:manage`**，缺则 403 `FORBIDDEN`；
> 再 `GET /handoff?t=…` 走 302）。
> 除 ⑨（浏览器里比对 origin）与 ⑫（容器内 node 断言）外，其余全部用 `curl -i`（带/不带 Cookie）断言**响应码**。
>
> ⚠️ **另一个前置（只存在于浏览器侧、`curl` 测不出）：专用 host 与 console 必须同父域（same-site）**（订正
> 2026-09-29，终审 I-4）。`mb_edit` 是 **`SameSite=Lax`**（`apps/mb-proxy/src/session.ts`），而编辑面板是
> console 里的 **iframe** ⇒ 跨站时浏览器**不带**这枚 Cookie ⇒ **401 + 白屏且线上静默**。
> **⑨ 盖不住这条**：⑨ 比对 CSP `frame-ancestors` 的 **origin**（「谁能嵌」），本条是 cookie 的**发送**判据
> （「嵌进来时带不带凭证」）。⇒ 拍 host 名时就定死（§B-E0「专用 host 与 console 必须同父域」）。

| # | 判据 | 断言 | 期望 | 备注 |
|---|---|---|---|---|
| ① | **本租户经专用入口打开编辑页 200，且参数可改** | `GET /handoff?t=<本租户票>` → 再 `GET /dashboard/<本租户 did>`、`GET /api/dashboard/<本租户 did>` | handoff **302** + `Set-Cookie: mb_edit=…`；dashboard 页与 API 均 **200** | 「参数可改」= 编辑态租户参数是**普通参数**（spec §3⑦ 尾注 / 全局约束 2）——**别当缺陷修**，人工在页面上确认可改 |
| ② | **别租户对象 403** | 持**本租户**有效 Cookie，`GET /dashboard/<别租户 did>` | **403** `{"error":"NOT_ALLOWED"}` | **别租户 did 怎么取**：取别租户**已登记报表**行的 `metabase_id`（Task 7 Step 1 种两租户数据时即有；也可从平台库 `data.reports` 按另一 org 查 `metabase_id`）。代理只授权**票据里那一张** did（`rules.ts`） |
| ③ | **无凭证 401** | **不带** `mb_edit` Cookie，`GET /dashboard/<本租户 did>` | **401** `{"error":"UNAUTHORIZED"}` | `/healthz` 与 `/handoff` 例外（在鉴权之前） |
| ④ | **`/api/search` 403** | `GET /api/search?q=…`（带有效 Cookie） | **403** | 枚举面**永久禁止**（全局约束 6） |
| ⑤ | **`/api/dataset` 403**（「编辑页不能任意查询」） | `POST /api/dataset`（带有效 Cookie） | **403** | 任意查询面**永久禁止**（全局约束 6）——这是「只编辑已登记报表」能力面的边界 |
| ⑥ | **canonicalization 探针全 403** | 逐条打 `/app/..;/api/search`、`/app/..%20/api/search`、`/app/..%00/api/search`、`/app/..%2f..%2fapi/search`（**四条必打**）；另可加打 `/app/..%3b..%3bapi/search`（Task 7 清单同款变体） | **全部 403** | 本地只证到「归一化收口后拒」（`normalizePath` 段白名单）；**上游 Jetty 如何解释由真机定论**——故必须真机打 |
| ⑦ | **真机 `GET /` 的读数** | `GET /`（带有效 Cookie）、`curl -i` | 记下**是 200 还是 3xx**；若 3xx，记 `location` 且**确认它落在放行表内**（`/app/`、`/static/`、`/assets/`、`/`、`/index.html`、`/favicon.ico`、`/api/session/properties`、`/dashboard/<did>`），并确认 **`location` 里无内网主机名泄露** | 代理**不跟**上游重定向（`redirect:'manual'`），3xx 原样给浏览器 ⇒ **`location` 不在表内则编辑页首页打不开** |
| ⑧ | **服务 API key 在 Metabase 的权限档位** | **只能在 Metabase 管理界面看**：Metabase 后台 → Settings / Admin → **Authentication → API keys**（具体菜单路径随版本，以该实例实际菜单为准），点开该 key 看它**所属 group 的权限** | **记下档位**（admin / 非 admin 专用 group） | ⚠️ 本仓**没有**该查询的既定只读端点，**别照猜的端点打**（各版本路径不同）。若为 **admin 档**，代理的放行表就是**唯一边界**（决定「放行表被绕过」的严重度）；口径见 `.env.example` 的 `DATA_METABASE_API_KEY` 注（**最小权限**：非 admin 专用 group） |
| ⑨ | **console 实际 origin == `MB_PROXY_CONSOLE_ORIGIN`** | ① 读一条经代理的响应头 `content-security-policy`（应 = `frame-ancestors <console origin>`）；② 在浏览器里看 console 的 `window.location.origin` | **两者相等**，且等于该客户项目的 `PUBLIC_ORIGIN` | **不等 ⇒ CSP 挡住 iframe ⇒ 编辑页白屏**（且线上静默）。这是 Task 5 遗留的必验项（progress：console 实际 origin 必须等于 `MB_PROXY_CONSOLE_ORIGIN`） |
| ⑩ | **样例 / 未登记对象 403** | `GET /dashboard/<未在本租户登记的 did>` | **403** | **样例 did 怎么取**：在 Metabase 里打开自带样例 dashboard，看 URL 的 `/dashboard/<id>`；或任取一个**不在 `data.reports` 里**的 did。与 ② 同一条「只授权票据里那一张」规则 |
| ⑪ | **探活** | `GET /healthz`（不带 Cookie） | **200** `{"ok":true}` | E4④ 已打过，收工再复跑一次 |
| ⑫ | **网络接线仍在** | 复跑 §B-E3 的两条 node 断言 | `DNS_OK` + `TCP_OK` | **容器/网络重建后必重跑** |

**记档要求**（Task 7 Step 5）：把命令、响应码、关键响应体片段回填到 §F「实测记录」，
**含日期与镜像 ID**；若实测与 spec §3⑦ 有出入，**订正 spec 并说明**（别留一份自相矛盾的正文）。

---

## D 已知边界（**是设计，不是缺陷**——写进交付说明，别当 bug 报）

1. **编辑页内不能搜索 / 浏览其他报表**。放行表**只授权票据里那一张 dashboard**（比「本租户全部已登记
   对象」更严）⇒ 页面里的搜索框、集合浏览、跳转别张报表**一律 403**。**枚举面是被主动封掉的**
   （`/api/search`、`/api/collection*`、`/api/table*`、`/api/database*`、`/api/user*`、`/api/setting*`、
   `/api/permissions*` 永久禁止）。**导航面是 console 的报表列表**——每张报表各自领一张票据。
2. **跨租户对象一律 403**（不做存在性区分，不给探测面）。
3. **编辑面板与嵌入预览并存，不做互斥**（Task 5 裁决：关编辑面板会牺牲 Metabase 里**未保存的编辑**
   ⇒ 只做单向收起，不双向关闭）。**这是记录在案的裁决，不是遗漏。**
4. **编辑态租户参数是普通参数（可改、可为空）**；**锁定只在「嵌入观看」时生效**（spec §3⑦ 尾注）。
5. **票据 120s 一次性**（nonce 兑换即消费）、**代理会话 8h**（`EDIT_TTL_SEC` = 28800s）。console 的「在新标签打开」
   兜底是**重新领一张票**（旧票已被 iframe 消费，复用必 401）——这是已修复的行为，不是缺陷。
6. **卡片集合缓存 ≤60s**：某张卡被移出 dashboard 后，最多 60s 内仍可被 query（fail-closed 侧无害，
   只影响本 dashboard 刚摘下的卡）。记录不改。

---

## E 坑表（照数据面 SOP 的三层分类）

### A 层：已根治

| # | 坑 | 根治处 |
|---|---|---|
| 1 | 归一化只折精确 `..` ⇒ `/app/..;/api/search` 等被放行并上行 | Task 4 改**逐段白名单** `SEG_RE`（含 `%`/空白/NUL/非 ASCII 一律拒）；`proxyPath` 保证「判的路径 == 上行的路径」 |
| 2 | dashcard 只判 did ⇒ 任意卡片 id 借壳上行 | Task 4 补 `cid ∈ cards`（fail-closed：取不到卡片集合 ⇒ 空集 ⇒ 不放行） |
| 3 | console 兜底复用已消费的一次性票据 ⇒ 死路 | Task 5 改**重新领票**（`edit-url` 换新票 + `window.open`）；**并且**：预开窗必须**同步**（`await` 之后再 `window.open` 会被弹窗拦截）、且**不能带 `noopener`**（带它 `window.open` **恒返 `null`**，拿不到句柄 ⇒ 兜底退化成「每次都弹一句被拦」）——终审 I-5，见 `reports/index.tsx` 内的订正记录 |
| 4 | **本接线文档（上一版）把「可观测断言」排在「让服务存在」之前** ⇒ 照顺序走第一步就撞上**不可能通过**的门 | 本版重排 §B（E1 env → E2 让服务存在 → E3/E4 断言），并在 §B 段首用「依赖关系」句固定该次序 |
| 5 | 把 `post_deployments`（**无 `serviceIds`**）当定向部署 ⇒ **全量重建**、重启客户 pg/Metabase | 本版删该等价项，改 `post_deployments_build_access` + `serviceIds`（§B-E2 附依据；B 层第 9 条同源风险） |

### B 层：结构性（靠固定序列防）

| # | 坑 | 防法 |
|---|---|---|
| 6 | **env 未备就置 `enabled:true` ⇒ crash loop**（`MB_PROXY_CONSOLE_ORIGIN` 缺则启动期抛；**2026-09-29 生产实测**） | **E1 先于 E2**（顺序不能反）；compose `profiles` **不是**部署闸门 |
| 7 | **`docker network connect` 是运行态步骤**，重建后掉 | E3 后必跑两条 node 断言；**每次重建容器后重做**（P7 已固化成脚本，本 SOP 尚未） |
| 8 | 部署可能重写服务 env（丢值 ⇒ crash loop） | **部署后必验 env 形状**（读真值 → 服务级 PATCH 写回 → 重部署 → 再验形状） |
| 9 | 全量部署会重启该客户 pg/Metabase | **定向部署**（`build_access` + `serviceIds`；别 `refreshServiceIds` 单参、别 `post_deployments`） |
| 10 | 只加域名不暴露服务 ⇒ 域名被路由同步剪掉 | **先暴露服务再建域名/再部署**（E2③→④；adopt §4 订正） |
| 11 | **服务面没有 `profiles` 字段**（那是 compose 概念，且对 openship 部署无效） | 服务面只认 `enabled` / `exposed` 等；**闸门 = 置 `enabled`**；`services_sync` 后要回查 |

### C 层：环境前置（检查项 + 判定）

| # | 检查项 | 判定 |
|---|---|---|
| 12 | 专用 host 的 DNS + 证书 | `post_domains_by_id_verify` / `verify_ssl` **回读**状态（别只看 POST 2xx） |
| 13 | `MB_PROXY_CONSOLE_ORIGIN` 是不是**console 的真实** origin | §C ⑨ 实测（写错形态=起不来，写成合法但错的=静默 fail-open） |
| 14 | `DATA_METABASE_URL` 是不是**容器视角** | 生产 = `http://metabase:3000`；宿主进程才用 `127.0.0.1:13030` |
| 15 | 服务 API key 的权限档位 | §C ⑧ 记下（admin 档 ⇒ 放行表是唯一边界）；本仓无只读端点，看 Metabase 管理界面 |
| 16 | 取票前置：调用者须持 `data:manage` | 缺 ⇒ 403 `{"error":"FORBIDDEN","need":"data:manage"}`（**不是**编辑页故障） |
| 17 | `renderer='platform'` 的行没有可编辑的页 | `GET /reports/:id/edit-url` 回 **409 `RENDERER_NOT_EDITABLE`**（预期，不是故障）；列表里该行的「编辑」不渲染 |
| 18 | 多层 env 物化分叉（inline 覆盖 project） | 排障「回滚正常 + 新构建崩」先查 inline 层 |
| 19 | 专用 host 与 console 是否**同父域**（same-site） | `SameSite=Lax` 的 `mb_edit` 要经 **iframe** 送到专用 host ⇒ **必须同 registrable domain**（形如 `platform.<域>` + `mb.<域>`）；跨站 ⇒ **401 + 白屏且线上静默**。**§C ⑨ 不覆盖此条**（⑨ 查的是 CSP origin）。§B-E0 拍板时定死 |

---

## F 实测记录（**Task 7 回填**；当前为空）

> 回填格式：日期 + 镜像 ID（`docker inspect` 取）+ 逐条判据的响应码与关键响应体片段。
> **在回填之前，§C 的判据是「待打勾」，不是「已验证」。**

- [ ] E1 env 已落（键名齐全、`MB_PROXY_CONSOLE_ORIGIN` 非空）
- [ ] E2 mb-proxy 服务行 + 容器起来（创建时间 > 镜像构建时间）
- [ ] E3 `DNS_OK` + `TCP_OK`
- [ ] E4 `/healthz` 200
- [ ] **专用 host 与 console 同父域（same-site）已确认**（§C 前置 / §E#19；**⑨ 不覆盖此条**——浏览器里真开一次 iframe 看它是否 401 才算数）
- [ ] §C ①②③④⑤⑥⑦⑧⑨⑩⑪⑫ 逐条读数
- [ ] spec §3⑦ 是否需订正（有出入才动）

---

## 关联

- `docs/superpowers/specs/2026-09-28-report-authoring-design.md` §3⑦（本 SOP 的规范来源：三条硬约束 + 实测读数。**该 spec 随本计划所在的分支/PR 系列落地**——本分支（`feat/346-edit-proxy`）此刻尚无该文件，Task 7 会把它一并纳入）
- `deploy/docker-compose.yml`（`mb-proxy` 服务定义：`command` 覆盖、`127.0.0.1:13010:13010`；`profiles: ['edit-proxy']` 只是**本机 compose 的默认启停语义**，**不是** openship 的部署闸门）
- `deploy/data-compose.yml`（Metabase 本体：`metabase` 服务、容器内端口 3000、宿主回环 `127.0.0.1:13030:3000`）——**它在独立 project，故接线必做**
- `apps/mb-proxy/src/config.ts`（env 契约与形状校验）/ `rules.ts`（放行表 deny-by-default）/ `session.ts`（Cookie 属性）/ `handoff.ts`（票据/会话两条派生密钥）
- `modules/data/manifest.yaml`（`GET /reports/:id/edit-url` 的页门 = `data:manage`）
- `deploy/data-plane-deploy-sop.md` P7（`docker network connect` 范式与 DNS/TCP 断言）/ §F.2（定向部署纪律）
- `deploy/openship-adopt.md` §4（先暴露服务、再加域名、再签证书）
- `deploy/customer-onboarding.md` §0 / §5 阶段 5（一客户一 project / 沿缝拆分）——**§0 那句「compose 含数据栈全部服务」是陈旧口径，与本仓两份 compose 的事实不符**（见 §B-E3）
