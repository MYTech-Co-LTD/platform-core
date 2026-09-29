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

⚠️ **案例状态（无案例不立标准）**：本 SOP 的**形态**逐条有真机出处（见上）；但**本 SOP 自身的接线
读数尚未产生**——它是 Task 7 的产物，回填到 §F「实测记录」。**在那之前，§C 的判据是「必须打勾的
清单」，不是「已被验证的结论」。** 凡本 SOP 里标「**待真机核实**」的条目，都是**没有本仓案例**的
推断，照做时先验证再相信。

**两道安全阀**：

1. **env 先于 profile**：`MB_PROXY_CONSOLE_ORIGIN` 等键**没备齐就打开 `edit-proxy` 开关** ⇒
   mb-proxy 启动期直接抛（fail-fast）⇒ **crash loop + 健康看板开事故**。顺序不能反（§E-B3）。
2. **接线是运行态步骤**：`docker network connect` 不是配置——**容器/网络重建后要重做**（P7 同款）。
   掉了只有「编辑页打不开」，别处**没有任何报错**（§E-B2）。

---

## B 操作单（E0–E5）

> 每 Phase 三件套：**动作 / 命令或面板路径 / 过门条件**。过门条件不满足就停在那一步。

### E0 盘点与前置决策

| 动作 | 命令 / 面板 | 过门条件 |
|---|---|---|
| 定专用 host 名 | 拍板：`mb.<客户域>`（**只写占位，不写具体域名**） | host 名在手，且该客户**尚未占用**它 |
| 定 console origin | 取该客户项目的 `PUBLIC_ORIGIN`（**逐字**，见 §B-E3 的表） | 一个 `https://<host>`，**无路径、无尾斜杠** |
| 同机还是拆缝 | 见 `customer-onboarding.md §0` / `§3 决策 1` | 拍板：mb-proxy 与 Metabase 是否在**同一 compose 网络**（决定 E2 做不做、E3 的 URL 形态） |
| 目标机在线 | openship 面板「服务器」页（控制面 servers 列表） | serverId 在手、机器在线 |
| 该客户已登记 ≥1 张 Metabase 报表 | 平台后台报表页 | 有 `renderer='metabase'` 的行（`platform` 自绘行没有可编辑的页，`GET /reports/:id/edit-url` 回 409 `RENDERER_NOT_EDITABLE`） |

### E1 专用 host：暴露 `mb-proxy` 服务 → 绑域名 → 签证书

**顺序不能反**（`openship-adopt.md §4` 的订正逐字适用：只加域名、服务却还是 `exposed:false`，
**部署的路由同步会把该域名剪掉**）。

| 动作 | 命令 / 面板 | 过门条件 |
|---|---|---|
| ① 暴露 `mb-proxy` 服务并绑域名 | openship MCP `patch_projects_by_id_services_by_serviceId`（面板：项目 → 服务 → `mb-proxy` → 暴露 + 自定义域名）。**用服务 id，不是项目 id**；`exposedPort` = **`13010`**（= compose 里 `PORT`，也是宿主回环映射左端的容器侧端口） | 服务 `exposed=true`、`publicEndpoints` 含该 host |
| ② 回读域名记录 | openship MCP `get_domains`（或 `get_projects_by_id` 的域名列表） | 该 host **在列**（不依赖域名自动建出的时点，看不到就显式 `post_domains`） |
| ③ DNS 落到生产机 | 按面板提示给 `<客户域>` 指向目标生产机的 CNAME/A（形态见 adopt §4） | 解析生效 |
| ④ 验证 + 签证书 | openship MCP `post_domains_by_id_verify` → `post_domains_by_id_verify_ssl`（面板：域名 → 验证 / 签证书） | **回读** `verify` / `ssl` 状态为通过——**别只看 POST 的 2xx** |
| ⑤ edge 探活 | `curl -i https://mb.<客户域>/healthz` | **`200` + `{"ok":true}`**（`/healthz` 在鉴权之前，**不带 Cookie 也应 200**——这是「edge 路由 + 证书」都通了的判据） |

> ⚠️ **E1 未过就不要进 E2**：域名没绑上/证书没签，后面所有验收都会以「证书错」或「404」收场，
> 但根因在 E1，不在反代。

### E2 平台 ↔ Metabase 网络接线（照 P7 先例）

**先判断形态**（E0 拍板）：

| 形态 | 是否需要接线 | `DATA_METABASE_URL` 取值（见 §B-E3 表） |
|---|---|---|
| **同一项目 / 同一 compose 网络**（默认一客户一 project） | **不需要**——服务名即主机名，mb-proxy 直接解析到 `metabase` | `http://metabase:3000` |
| **拆缝**（mb-proxy 在平台单元、Metabase 在数据面单元） | **需要**：把 metabase 容器连进**平台网络**并给 alias | `http://metabase:3000`（靠 alias） |

**接线命令（拆缝形态；在目标机上跑，走 openship MCP `post_system_servers_by_id_exec`，别裸 SSH）**：

```sh
docker network connect --alias metabase <平台网络> <metabase 容器>
```

- `<平台网络>` = 平台部署单元的 compose 网络（形如 `openship-<平台 project 名>`；以 `docker network ls` 实测为准）；
- `<metabase 容器>` = 数据面单元里那个 metabase 容器（以 `docker ps` 实测为准）；
- **alias 必须是 `metabase`**——env 里的 URL 就按这个别名解析。

**重做与断言（P7 逐字同款：这是运行态步骤，重建后必重做；DNS 与 TCP 分开判）**：
平台镜像基于 `node:22`，**没有 `nc`**；且 `nc` 报 `bad address` 是**解析失败**、不是「连不上」。

```sh
# $MBPROXY = mb-proxy 容器名（以 docker ps 实测为准）
docker exec "$MBPROXY" node -e "require('dns').lookup('metabase',(e,a)=>console.log(e?('ERR '+e.code):('DNS_OK '+a)))"
docker exec "$MBPROXY" node -e "const n=require('net'),s=n.connect(3000,'metabase');s.on('connect',()=>{console.log('TCP_OK');s.end()});s.on('error',e=>console.log('TCP_ERR '+e.code))"
```

预期：`DNS_OK 172.x.x.x` + `TCP_OK`。

> ⚠️ **端口是容器侧 `3000`**（Metabase 在容器里监听 3000），**不是宿主映射的 `13030`**。
> `13030` 只是 `deploy/data-compose.yml` 给**宿主机**用的回环映射（`127.0.0.1:13030:3000`）——
> 见 §B-E3 两种形态的取值口径。

### E3 env 清单（**先备 env，再开 profile**；顺序不能反）

**在该客户项目的 project env 里备齐下列键**（openship MCP `patch_projects_by_id_env`；
面板：项目 → 环境变量）。**密钥一律 `isSecret`，值不进本文、不进 git**。

| 键 | 值形态（占位） | 用途 / **取值位置** | 是否新增 |
|---|---|---|---|
| `MB_PROXY_PUBLIC_ORIGIN` | `https://mb.<客户域>` | **模块**（`GET /reports/:id/edit-url`）用来拼 handoff URL。缺配/非 https/尾斜杠 ⇒ 该端点 **503 `EDIT_PROXY_UNCONFIGURED`** | **本计划新增** |
| `MB_PROXY_CONSOLE_ORIGIN` | `https://<console origin>` | **代理**用来设 CSP `frame-ancestors`。**必填**——缺则 mb-proxy **启动期抛**（这正是必须挂 `edit-proxy` profile 的原因） | **本计划新增** |
| `PLATFORM_SESSION_SECRET` | （≥32 字符） | 派生 handoff / 会话两条子密钥（模块签、代理验）。**取值位置**：openship 项目 env `isSecret`（已有键，复用） | 复用 |
| `DATA_METABASE_URL` | 见下「两种形态」 | 代理的上游基址；**也是模块报表面 facade 的上游**（同一把口径） | 复用 |
| `DATA_METABASE_API_KEY` | （服务身份） | 代理调上游用的 **`x-api-key`**（与模块同一把，服务身份）。**取值位置**：openship 项目 env `isSecret` | 复用 |
| `PORT` | `13010` | mb-proxy 容器内监听端口。**compose 已写死**（`environment.PORT`），一般**不必**在 env 里再配 | 复用（compose 内定） |

**两个 origin 的取值口径（本 SOP 最容易配错的两处）**：

- `MB_PROXY_PUBLIC_ORIGIN` = **专用入口**的 origin（E1 那个 host），**无尾斜杠、无路径**；
- `MB_PROXY_CONSOLE_ORIGIN` = **console 的真实 origin**，**必须与该客户项目的 `PUBLIC_ORIGIN` 逐字一致**
  （`.env.example:18` 就是它；生产上 = 后台实际访问域名，形如 `https://platform.<客户域>`）。
  ⚠️ **配错的后果是 fail-open 且线上静默**：代理**剥掉了上游的 X-Frame-Options**，只用这条 CSP 兜底——
  值写错（空串/`*`/带路径）等于**任意站点都能 iframe 编辑页**（见 `apps/mb-proxy/src/config.ts` 头注）。
  代理对形状是**启动期强校验**（只许 `https://<host[:port]>`），所以写错形态 = 起不来（响亮），
  但**写成一个「合法却不是 console」的 origin** 它拦不住 ⇒ 必须靠 §C 第 ⑨ 条实测。

**`DATA_METABASE_URL` 两种形态（哪种形态用哪个值）**：

| 消费方 / 形态 | 取什么值 | 为什么 |
|---|---|---|
| **容器内消费**（mb-proxy 容器、平台 server 容器——**生产恒是这一种**） | `http://metabase:3000` | 容器里的 `127.0.0.1` 是**自己的 netns**，指不到宿主回环（P7 同款道理）；靠 E2 的网络/alias 或同网络服务名解析 |
| **宿主进程消费**（本地 dev-stack、或平台进程未容器化） | `http://127.0.0.1:13030` | `13030` 是 `deploy/data-compose.yml` 的**宿主**回环映射端口，只有宿主上的进程够得到 |

> ⚠️ **不要照抄「127.0.0.1:13030」到生产**：mb-proxy 与 server **都在容器里**，用宿主回环形态
> 会解析到它们各自的 netns ⇒ 上游不可达。生产取 `http://metabase:3000`。

### E4 启用 `edit-proxy` 开关 + 定向部署

**过门条件：E3 的键全部已落**（`MB_PROXY_CONSOLE_ORIGIN` 尤其）——否则本步会 crash loop。

| 动作 | 命令 / 面板 | 过门条件 |
|---|---|---|
| ① 同步服务面 | openship MCP `post_projects_by_id_services_sync`（传回 compose 的完整 services 数组） | 服务清单里**出现 `mb-proxy` 行** |
| ② 打开 `edit-proxy` 开关 | 服务级置启用态（面板：项目 → 服务 → `mb-proxy` → 启用；REST/MCP 形态 = 服务级 `enabled:true`）。语义 = 「该客户的部署单元显式打开 profile `edit-proxy`」 | `mb-proxy` **enabled** |
| ③ 定向部署 | openship MCP `post_deployments_build_access` 或 `post_deployments`，**传 `serviceIds` 只含 `mb-proxy`**（照 `data-plane-deploy-sop.md` F.2 的纪律：**别全量部署**——会重启该客户的 pg/Metabase） | `mb-proxy` 容器起来 |
| ④ 验容器**真换了** | `docker ps` 看 mb-proxy 的创建时间 > 镜像构建时间；再 `docker inspect` 抽查 env 形状（**逐键看物化结果，不是看配置面**） | 新容器 + `MB_PROXY_CONSOLE_ORIGIN` 非空 |
| ⑤ 探活 | `curl -i https://mb.<客户域>/healthz` | `200 {"ok":true}` |

> ⚠️ **待真机核实（本仓无案例）**：`services_sync` **是否会把挂了 `profiles:` 的服务一并带出**、
> 以及 openship 侧「打开 profile」的确切落点（服务级 `enabled` 开关 vs 控制面的 compose profiles
> 选项），本 SOP **未取得实测**。照做时以 ① 的**服务面清单**为准：
> **出现 `mb-proxy` 行 ⇒ 置 enabled 即等价**；**没出现 ⇒ 用「新增服务」接口按 compose 定义补一行**
> （镜像 `platform-core-mb-proxy:local`、`command` 覆盖为 `pnpm --filter @platform/mb-proxy start`、
> 端口 `13010`、`profiles: ['edit-proxy']` 的那些 env 前提同 E3）。**别把「清单里有」当默认假设。**

> ⚠️ **别用 `refreshServiceIds` 顶替 `serviceIds`**：`data-plane-deploy-sop.md` F.2 实测——单传
> `refreshServiceIds` 会触发**全量重建**（把 `pg_duckdb` / `metabase-db` 一并重启）。

### E5 每客户接线的「收工自证」（进 §C 逐条勾）

E4 过后**不要**直接收工——按 **§C 的判据（①–⑫）**逐条打勾。§C 即 Task 7 的验收清单。

---

## C 验收判据（**Task 7 逐条勾**；缺一不可）

> 前置：E1（host + 证书）与 E4（服务启用 + 部署）都已过门；已有一枚**本租户**的有效 handoff → 已兑换成
> `mb_edit` Cookie（经 `GET /reports/:id/edit-url` 拿 URL，再 `GET /handoff?t=…` 走 302）。
> 除 ⑨（浏览器里比对 origin）与 ⑫（容器内 node 断言）外，其余全部用 `curl -i`（带/不带 Cookie）断言**响应码**。

| # | 判据 | 断言 | 期望 | 备注 |
|---|---|---|---|---|
| ① | **本租户经专用入口打开编辑页 200，且参数可改** | `GET /handoff?t=<本租户票>` → 再 `GET /dashboard/<本租户 did>`、`GET /api/dashboard/<本租户 did>` | handoff **302** + `Set-Cookie: mb_edit=…`；dashboard 页与 API 均 **200** | 「参数可改」= 编辑态租户参数是**普通参数**（spec §3⑦ 尾注 / 全局约束 2）——**别当缺陷修**，人工在页面上确认可改 |
| ② | **别租户对象 403** | 持**本租户**有效 Cookie，`GET /dashboard/<别租户 did>` | **403** `{"error":"NOT_ALLOWED"}` | 代理只授权**票据里那一张** did（`rules.ts`） |
| ③ | **无凭证 401** | **不带** `mb_edit` Cookie，`GET /dashboard/<本租户 did>` | **401** `{"error":"UNAUTHORIZED"}` | `/healthz` 与 `/handoff` 例外（在鉴权之前） |
| ④ | **`/api/search` 403** | `GET /api/search?q=…`（带有效 Cookie） | **403** | 枚举面**永久禁止**（全局约束 6） |
| ⑤ | **`/api/dataset` 403**（「编辑页不能任意查询」） | `POST /api/dataset`（带有效 Cookie） | **403** | 任意查询面**永久禁止**（全局约束 6）——这是「只编辑已登记报表」能力面的边界 |
| ⑥ | **canonicalization 探针全 403** | 逐条打 `/app/..;/api/search`、`/app/..%20/api/search`、`/app/..%00/api/search`、`/app/..%2f..%2fapi/search`（**四条必打**）；另可加打 `/app/..%3b..%3bapi/search`（Task 7 清单同款变体） | **全部 403** | 本地只证到「归一化收口后拒」（`normalizePath` 段白名单）；**上游 Jetty 如何解释由真机定论**——故必须真机打 |
| ⑦ | **真机 `GET /` 的读数** | `GET /`（带有效 Cookie）、`curl -i` | 记下**是 200 还是 3xx**；若 3xx，记 `location` 且**确认它落在放行表内**（`/app/`、`/static/`、`/assets/`、`/`、`/index.html`、`/favicon.ico`、`/api/session/properties`、`/dashboard/<did>`），并确认 **`location` 里无内网主机名泄露** | 代理**不跟**上游重定向（`redirect:'manual'`），3xx 原样给浏览器 ⇒ **`location` 不在表内则编辑页首页打不开** |
| ⑧ | **服务 API key 在 Metabase 的权限档位** | 在该 Metabase 实例查 `DATA_METABASE_API_KEY` 对应 user/group 的权限（或建 key 时用的 group） | **记下档位**（admin / 非 admin 专用 group） | 若为 **admin 档**，代理的放行表就是**唯一边界**（决定「放行表被绕过」的严重度）；口径见 `.env.example` 的 `DATA_METABASE_API_KEY` 注（**最小权限**：非 admin 专用 group） |
| ⑨ | **console 实际 origin == `MB_PROXY_CONSOLE_ORIGIN`** | ① 读一条经代理的响应头 `content-security-policy`（应 = `frame-ancestors <console origin>`）；② 在浏览器里看 console 的 `window.location.origin` | **两者相等**，且等于该客户项目的 `PUBLIC_ORIGIN` | **不等 ⇒ CSP 挡住 iframe ⇒ 编辑页白屏**（且线上静默）。这是 Task 5 遗留的必验项（progress：console 实际 origin 必须等于 `MB_PROXY_CONSOLE_ORIGIN`） |
| ⑩ | **样例 / 未登记对象 403** | `GET /dashboard/<未在本租户登记的 did>`（如 Metabase 自带样例） | **403** | 与 ② 同一条「只授权票据里那一张」规则 |
| ⑪ | **探活** | `GET /healthz`（不带 Cookie） | **200** `{"ok":true}` | E1⑤ / E4⑤ 已打过，收工再复跑一次 |
| ⑫ | **网络接线仍在**（拆缝形态） | 复跑 §E-B2 的两条 node 断言 | `DNS_OK` + `TCP_OK` | **容器/网络重建后必重跑** |

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
| 3 | console 兜底复用已消费的一次性票据 ⇒ 死路 | Task 5 改**重新领票**（`edit-url` 换新票 + `window.open`） |

### B 层：结构性（靠固定序列防）

| # | 坑 | 防法 |
|---|---|---|
| 4 | **env 未备就开 profile ⇒ crash loop**（`MB_PROXY_CONSOLE_ORIGIN` 缺则启动期抛） | **E3 先于 E4**（顺序不能反） |
| 5 | **`docker network connect` 是运行态步骤**，重建后掉 | E2 后必跑两条 node 断言；**每次重建容器后重做** |
| 6 | 服务面 env 不解析 `${VAR:-default}` 模板（数据面固有） | 一律写字面真值 / project env 明值 |
| 7 | 部署可能重写服务 env（丢值 ⇒ crash loop） | **部署后必验 env 形状**（读真值 → 服务级 PATCH 写回 → 重部署 → 再验形状） |
| 8 | 全量部署会重启该客户 pg/Metabase | **定向部署**（`serviceIds`，别 `refreshServiceIds`） |
| 9 | 只加域名不暴露服务 ⇒ 域名被路由同步剪掉 | **先暴露服务再建域名**（E1①→②；adopt §4 订正） |

### C 层：环境前置（检查项 + 判定）

| # | 检查项 | 判定 |
|---|---|---|
| 10 | 专用 host 的 DNS + 证书 | `post_domains_by_id_verify` / `verify_ssl` **回读**状态（别只看 POST 2xx） |
| 11 | `MB_PROXY_CONSOLE_ORIGIN` 是不是**console 的真实** origin | §C ⑨ 实测（写错形态=起不来，写成合法但错的=静默 fail-open） |
| 12 | `DATA_METABASE_URL` 是不是**容器视角** | 生产 = `http://metabase:3000`；宿主进程才用 `127.0.0.1:13030` |
| 13 | 服务 API key 的权限档位 | §C ⑧ 记下（admin 档 ⇒ 放行表是唯一边界） |
| 14 | `renderer='platform'` 的行没有可编辑的页 | `GET /reports/:id/edit-url` 回 **409 `RENDERER_NOT_EDITABLE`**（预期，不是故障）；列表里该行的「编辑」不渲染 |
| 15 | 多层 env 物化分叉（inline 覆盖 project） | 排障「回滚正常 + 新构建崩」先查 inline 层 |

---

## F 实测记录（**Task 7 回填**；当前为空）

> 回填格式：日期 + 镜像 ID（`docker inspect` 取）+ 逐条判据的响应码与关键响应体片段。
> **在回填之前，§C 的判据是「待打勾」，不是「已验证」。**

- [ ] E1⑤ `/healthz` 200 + E4⑤ 200
- [ ] §C ①②③④⑤⑥⑦⑧⑨⑩⑪⑫ 逐条读数
- [ ] spec §3⑦ 是否需订正（有出入才动）

---

## 关联

- `docs/superpowers/specs/2026-09-28-report-authoring-design.md` §3⑦（本 SOP 的规范来源：三条硬约束 + 实测读数。**该 spec 随本计划所在的分支/PR 系列落地**——本分支（`feat/346-edit-proxy`）此刻尚无该文件，Task 7 会把它一并纳入）
- `deploy/docker-compose.yml`（`mb-proxy` 服务定义：`profiles: ['edit-proxy']`、`command` 覆盖、`127.0.0.1:13010:13010`）
- `apps/mb-proxy/src/config.ts`（env 契约与形状校验）/ `rules.ts`（放行表 deny-by-default）/ `session.ts`（Cookie 属性）/ `handoff.ts`（票据/会话两条派生密钥）
- `deploy/data-plane-deploy-sop.md` P7（`docker network connect` 范式与 DNS/TCP 断言）/ §F.2（定向部署纪律）
- `deploy/openship-adopt.md` §4（先暴露服务、再加域名、再签证书）
- `deploy/customer-onboarding.md` §0 / §5 阶段 5（一客户一 project / 沿缝拆分）
