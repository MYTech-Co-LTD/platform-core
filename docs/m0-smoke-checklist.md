# M0 手工冒烟清单

> 用途：M0 验收里**机检覆盖不到**的那一半——真浏览器、真企微、真 Casdoor。
> 机检那一半（单测 / 门禁 / 双形态装载冒烟 / 静态产物逐字节）在
> `.github/workflows/ci.yml` 的四个 job 里，push 即跑，不在本清单重复。
>
> 状态图例（**不留空勾选框**：每一项要么给出证据，要么写清为什么现在做不了、缺什么前置）：
> - ✅ **已验**：附证据（命令 / 日志 / 产出）
> - ☐ **待人工**：步骤已写好，缺的只是人去过一遍
> - ⏳ **待补验**：有环境前置条件当次不具备，前置写在该行内
>
> 勾选方式：在本文件里把 ☐ 改成 ✅ 并补上日期与证据链接/路径；⏳ 项在前置条件满足后同样转 ✅。

---

## A. 部署面（Task 22 当次已验）

> **两条起栈路，别混用**（fix-1 补：原文档把两件事混在一条命令里，导致「照着做复现不了」）：
> - **看页面 / 手工复现登录链路** → **`pnpm dev:stack`**（`scripts/dev-stack.mjs`，本仓已跟踪）。
>   一次把 MockCasdoor + 宿主进程 + 本机 PG 起齐，打印可点的 URL，长驻到 Ctrl-C。
>   **不依赖 Docker、不读 `.env`、不依赖任何未提交的临时文件** —— 这是 A2 / C1 的复现入口。
> - **验镜像与 compose 本身**（A1 / A3 的容器部分）→
>   `docker compose -f deploy/docker-compose.yml up --build -d`。
>
> **两条共用的前置**（缺一条就表现成「文档里的 200 永远不出现」而文档不解释，fix-1 补）：
>
> 1. **PG 必须可连**。本机 5432 常被别的项目/容器占着（本机实测：一个早前任务留下的
>    `platform-pg` 容器常年占着它）。占用时 `docker compose up postgres` 会直接因端口冲突起不来，
>    A4 的复跑命令同样会失败。先看一眼：
>    `lsof -nP -iTCP:5432 -sTCP:LISTEN`——被占时**直接把 `DATABASE_URL` 指到那个已在跑的 PG**
>    （本仓 demo 用的 user/pass/db 都是 `platform`），不要为了腾端口去杀别人的进程。
>    `pnpm dev:stack` 默认就指向 `postgres://platform:platform@127.0.0.1:5432/platform`，
>    需要换时用 `DATABASE_URL=… pnpm dev:stack`。
> 2. **Casdoor 必须可达**。宿主启动期会按 `platform.tenant` 的各租户 org 调 Casdoor upsert 模块
>    权限码（**`single` 与 `multi` 都一样**），连不上则 `upsertPermission` 抛错、进程起不来；
>    容器在 `restart: unless-stopped` 下就是反复重启（`docker compose ps` 显示 Restarting）。
>    这是 fail-fast 的设计行为，不是故障。
>    **纯本地无 Casdoor 时**：不设 `SEED_DEMO`（租户表为空 ⇒ 供给循环不执行、不取 client）。
>    但 `CASDOOR_ADMIN_USER` / `_PWD` 仍必填，且登录本身要 Casdoor 可达——否则只能起个
>    登录签不出会话（502）的空壳。
>    **在容器里跑时这条尤其致命**：`CASDOOR_URL` 必须是**从容器内部**能解析到的地址——
>    宿主上的 `127.0.0.1` 在容器里指的是容器自己（原 A2 的复现就卡在这里，见 A2）。

### A1 单机 compose 起得来，`/healthz` 200 ✅

```bash
docker compose -f deploy/docker-compose.yml up --build -d
curl -i http://127.0.0.1:13000/healthz
```
证据（2026-09-11，本机 Docker 29.6.1 / Compose v5.3.0）：
`HTTP/1.1 200 OK` + `{"ok":true}`；容器 `Up (healthy)`（镜像里的 HEALTHCHECK 打容器内 `$PORT`）。

⚠️ **`HOST_PORT` 是现实存在的一个坎**：本机 13000 被另一工作树的遗留 dev mock 长占，当次用
`HOST_PORT=13001` 跑同一份 compose（`HOST_PORT` 的默认值就是 13000，容器侧端口恒为 13000）。
**下面 A2 的命令里写的是 13000，请按你实际暴露的宿主端口替换**。

### A2 账密登录 → 模块 API 200 ✅（Casdoor 侧为 mock）

**怎么复现（本仓已跟踪，fix-1 新增）** —— 不碰 Docker、不读 `.env`、不需要任何未提交的文件：

```bash
pnpm --filter @platform/web build      # 前置：静态托管要 dist（缺了页面全白而 /healthz 照绿）
docker compose -f deploy/docker-compose.yml up -d postgres   # 或任意可连的 PG，见上面前置 1
pnpm dev:stack                         # → http://127.0.0.1:13100，长驻到 Ctrl-C
```
另一个终端（cookie 名固定 `platform_session`；curl 视 127.0.0.1 为安全上下文，`Secure` cookie
在 http 上照样带得出去）：

```bash
curl -si -X POST http://127.0.0.1:13100/api/platform/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin1","password":"pw"}' -c /tmp/jar
# → 200 {"ok":true} + set-cookie: platform_session=…; HttpOnly; Secure; SameSite=Lax
#   （scopes 解出 demo:view / demo:note）
curl -si -b /tmp/jar http://127.0.0.1:13100/api/modules/demo/ping
# → 200 {"pong":true,"identity":{"userId":"admin1","orgId":"acme"}}
```
配套对照（同一次实测，`viewer1` 由 `dev:stack` 一并种好）：

```bash
curl -si http://127.0.0.1:13100/api/modules/demo/ping          # 无 cookie  → 401
curl -si -b <viewer1 的 jar> .../api/modules/demo/ping          # → 403 {"error":"FORBIDDEN","need":"demo:view"}
curl -si -b <viewer1 的 jar> .../api/modules/demo/notes         # → 403 {"error":"FORBIDDEN","need":"demo:note"}
```

**容器内那一遍（原始记录，2026-09-11）**：同一条链在 `docker compose` 起的 server 容器里也跑通了
——`/healthz` 200、登录 200 + `platform_session`、模块 API 200、401/403 对照、`/assets/*` 与容器内
磁盘产物**逐字节一致**（1,047,598B）。

⚠️ **它的复现有一处当时没交代的坑（fix-1 记账）**：MockCasdoor 只绑 `127.0.0.1`，容器连不到宿主
环回，当次是**临时**在 `.tmp/mock-casdoor-net.ts` 里补了一层 `0.0.0.0` 裸 TCP 转发才让容器按
容器名连上——而 `.tmp/` 在 `.gitignore` 里，**那个文件不在仓库中**，照着旧文档做的人会卡在
「容器连不上 Casdoor → 反复重启 → 文档里的 200 不出现」且文档不解释原因。要在容器里复现，
`CASDOOR_URL` 必须换成**容器可达**的地址（自己能提供一个的话）；**本仓跟踪的复现路径是
`pnpm dev:stack`（宿主进程 + 同一枚 MockCasdoor + 同一套 env 契约）**，它覆盖的是应用链路本身，
不覆盖镜像/容器运行时——镜像那部分由 A1/A3 单独证明。

⚠️ **边界**：这一步的登录走的是 `MockCasdoor`（真实 HTTP + 真实 `CasdoorClient` 代码路径，
但 Casdoor 本身是测试替身）。**对着真实 Casdoor 实例的账密登录尚未验证**——见 B2。

### A3 静态托管没有静默降级 ✅（白屏前兆的现场检查）

```bash
docker logs <server 容器> 2>&1 | grep -c '不存在，跳过静态托管'   # 必须为 0
# 宿主进程同样适用：pnpm dev:stack 的日志里这一行也必须为 0
```
证据：容器启动日志只有两行（`$ tsx src/index.ts`、`[server] listening on … modules=1`），
无 `[web] … 不存在，跳过静态托管`；`GET /login` → 200 html；`GET /assets/index-*.js` →
1,047,598 字节，与容器内 `apps/web/dist` 的磁盘产物**逐字节一致**。

**这条为什么单列**：`apps/server/src/app.ts` 的静态目录按文件自身位置解析 `../../web/dist`，
镜像里 `apps/` 与 `packages/` 的层级一旦被打散，它只打印一行 warn 就继续启动——
`/healthz` 照绿、页面全白。日志里那一行是唯一现场证据，**每次部署后都该 grep 一次**。
`scripts/dev-stack.mjs` 把这个静默降级直接做成了启动前置（缺 dist 时脚本自己先死），
因为「起得来但白屏」正是最该被拦掉的假绿。

### A4 双形态装载冒烟（multi + single）✅ 已机检化

`ci.yml` 的 `smoke` job 每次 push 自动跑（动态端口、36 条断言、含静态资产逐字节比对与
demo 403 路径）。本地复跑：
```bash
docker compose -f deploy/docker-compose.yml up -d postgres
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/web build
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```
⚠️ **本机现在直接跑会失败**：`platform-pg` 占着 5432，上面那条 `up -d postgres` 会端口冲突
（见本节开头的前置 1）。已有一个可连的 PG 时跳过第一条、把 `DATABASE_URL` 指过去即可。

---

## B. 待补验项（当次环境不具备）

### B1 企微真机 · 扫码登录 ⏳ 待企微配置后补验

**前置条件**（缺一条就做不了，逐条确认后再执行）：
1. 目标租户在 DB 里配好 `wecom_corp_id` / `wecom_agent_id` / `wecom_secret`
   （demo 种子里的 `ww_demo_corp` 是假值，**真机必须换成真企微自建应用**）；
2. 该应用在企微后台配好「可信域名」（与最终访问域一致）与「企业微信授权登录」回调；
3. `PUBLIC_ORIGIN` 与访问域名逐字一致（扫码回调的 `redirect_uri` 由它拼）；
4. 部署在**公网可达的 https 域名**上（企微不认 localhost / 自签证书）。

步骤：手机企微扫 `/login` 页面上的二维码 → 回调落地后应拿到 `platform_session` cookie 并跳
`/console`；核对身份是「当前企业成员」而不是静默 openid。

### B2 真实 Casdoor 账密登录 ⏳ 待 dev 环境账号后补验

**前置条件**：一个可用的 Casdoor 实例（如 `https://sso.hookflow.cn`）+ 该 application 的
`client_id`/`client_secret` + 至少一个可登录的用户与它的 org（对应 `PLATFORM_ORG`）。
A2 已把代码路径与容器链路验穿了，这一项验的是**真实 Casdoor 的形状差异**（形参风格、
`signupApplication`、`get-permissions` 的 owner 语义）——这些正是旧仓踩过坑的地方。

### B3 企微内打开 `/login` 静默登录 ⏳ 待企微配置后补验

**前置条件**：同 B1（真 corp 配置 + 可信域名 + https 公网域名），另需该应用开启
「网页授权及 JS-SDK」的静默授权范围。

步骤：在企业微信客户端内打开 `https://<域名>/login` → 不应出现二维码，应直接静默完成登录
并落 `/console`；若落到二维码分支，检查 `wecom-qr` 是否在 `login_methods` 里、UA 判定是否被
网关改写。

---

## C. 浏览器验证

### C1 console 演示页浏览器验证 + 截图 ✅

**验法**：`pnpm dev:stack` → Orca CLI 的 Browser Automation（命令是**顶层**的：`orca tab create
--url …` / `orca snapshot` / `orca fill --element @eN --value …` / `orca click --element @eN` /
`orca get --what url|title` / `orca eval --expression` / `orca screenshot`——`orca browser` 不是
一个子命令，「Browser Automation」只是 `orca --help` 里的**分组标题**）。

**结果（2026-09-11，Orca CLI 1.4.197）**：全链路通过。

| 步骤 | 结果 |
|------|------|
| 开 `http://127.0.0.1:13100/login` | 渲染出登录卡（标题 `Acme 工单` = 服务端 branding 命中），**不是白屏** |
| `admin1` / `pw` 提交 | 落到 `http://127.0.0.1:13100/console`，标题 `概览 - Acme 工单` |
| 左侧菜单 | `menuitem "概览"` + `menuitem "experiment 演示"`（`li.innerText === "演示"`，`href=/console/demo`） |
| 点「演示」 | `http://127.0.0.1:13100/console/demo`，标题 `演示 - Acme 工单` |
| 便签列表（读 `/api/modules/demo/notes`） | 渲染出 `#2 浏览器写入的第二条` / `#1 第一条：接入协议端到端` |
| 点 `Ping` | 页内 `{"pong":true,"identity":{"userId":"admin1","orgId":"acme"}}`（浏览器里走通的模块 API 往返） |
| 深链刷新 `reload` `/console/demo` | **不 404**：URL 不变、标题 `演示 - Acme 工单`、便签列表重新渲染（SPA 兜底成立） |
| 噪音检查 | 本次会话所有 `/api/*` 请求 `responseStatus` 全 = 200（session / config / branding / notes / ping）；SPA 内切菜单时挂的 `error` + `unhandledrejection` 监听器捕获到 **0** 条 |

留档：截图 `docs/img/console-demo-notes.png`（左菜单「概览 / 演示」+ 便签列表 + 右下 `admin1`）。

**一条现场观察（不是缺陷，但会让人以为菜单少了一项）**：Orca 内嵌浏览器的默认视口是 **864px**
宽，低于 ProLayout 的 `lg` 断点（992px），**侧栏会自动收起成纯图标**（此时菜单项的文字在 DOM 里
但不渲染，`innerText` 为空）。点侧栏底部的收起/展开按钮即可在 864px 下展开，菜单文字随即出现；
宽窗口（≥992px）本来就不收起。上面截图与菜单文案都是**展开态**下取的。

**这条为什么机检替不了**：`smoke` job 只断言「`/assets/*` 吐的是构建产物本体」，它证明不了
React 在浏览器里真的挂载出来了（Task 19 的教训：`curl 200 ≠ 页面可用`）。C1 是那一条的正面证据。

---

## D. M0 之后的第一次生产部署（adopt 之后）

`deploy/openship-adopt.md` 是操作单；adopt 完成后，本清单的 A1/A3/A4 需在**生产域名**上复做
一遍（A2 换成真实 Casdoor 账号、B1/B3 前置齐了就一起做掉）。生产侧特有的两条：
- `PUBLIC_ORIGIN` / 域名 / 企微可信域名三者一致；
- 容器日志 grep `跳过静态托管`（A3）——生产环境这个问题同样是静默的。
