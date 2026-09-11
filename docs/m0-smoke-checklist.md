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

### A1 单机 compose 起得来，`/healthz` 200 ✅

```bash
docker compose -f deploy/docker-compose.yml up --build -d
curl -i http://127.0.0.1:13000/healthz
```
证据（2026-09-11，本机 Docker 29.6.1 / Compose v5.3.0）：
`HTTP/1.1 200 OK` + `{"ok":true}`；容器 `Up (healthy)`（镜像里的 HEALTHCHECK 打容器内 `$PORT`）。
本机 13000 被另一工作树的遗留 dev mock 长占，当次用 `HOST_PORT=13001` 跑同一份 compose
（`HOST_PORT` 的默认值就是 13000）。

### A2 容器内真实链路：账密登录 → 模块 API 200 ✅（Casdoor 侧为 mock）

```bash
curl -si -X POST http://127.0.0.1:13000/api/platform/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"admin1","password":"pw"}'
# → 200 {"ok":true} + set-cookie: platform_session=…（scopes 内含 demo:view / demo:note）
curl -si -H "Cookie: platform_session=<上一步的 cookie>" \
  http://127.0.0.1:13000/api/modules/demo/ping
# → 200 {"pong":true,"identity":{"userId":"admin1","orgId":"acme"}}
```
配套对照（同一次实测）：不带 cookie → 401；`viewer1`（无 `demo:view`）→ 403 `FORBIDDEN need=demo:view`。

⚠️ **边界**：这一步的登录走的是 `MockCasdoor`（真实 HTTP + 真实 `CasdoorClient` 代码路径，
但 Casdoor 本身是测试替身）。**对着真实 Casdoor 实例的账密登录尚未验证**——见 B2。

### A3 静态托管没有静默降级 ✅（白屏前兆的现场检查）

```bash
docker logs <server 容器> 2>&1 | grep -c '不存在，跳过静态托管'   # 必须为 0
```
证据：容器启动日志只有两行（`$ tsx src/index.ts`、`[server] listening on … modules=1`），
无 `[web] … 不存在，跳过静态托管`；`GET /login` → 200 html；`GET /assets/index-*.js` →
1,047,598 字节，与容器内 `apps/web/dist` 的磁盘产物**逐字节一致**。

**这条为什么单列**：`apps/server/src/app.ts` 的静态目录按文件自身位置解析 `../../web/dist`，
镜像里 `apps/` 与 `packages/` 的层级一旦被打散，它只打印一行 warn 就继续启动——
`/healthz` 照绿、页面全白。日志里那一行是唯一现场证据，**每次部署后都该 grep 一次**。

### A4 双形态装载冒烟（multi + single）✅ 已机检化

`ci.yml` 的 `smoke` job 每次 push 自动跑（动态端口、36 条断言、含静态资产逐字节比对与
demo 403 路径）。本地复跑：
```bash
docker compose -f deploy/docker-compose.yml up -d postgres
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter @platform/web build
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm smoke
```

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

## C. 待人工过一遍（步骤已备好）

### C1 console 演示页浏览器验证 + 截图 ☐

步骤：起栈（A1）→ 浏览器开 `http://127.0.0.1:13000/login` → `admin1/pw` 登录 →
应落 `/console`，左侧菜单出现「演示」→ 点进 `/console/demo` → 便签列表渲染出来（同一页应能
读到 `/api/modules/demo/notes` 的数据）→ 刷新页面确认 `/console/demo` 深链不 404（SPA 兜底）。

留档：截图放 `docs/img/`（本仓目前没有该目录，需要时新建）。

**这条为什么机检替不了**：`smoke` job 只断言「`/assets/*` 吐的是构建产物本体」，它证明不了
React 在浏览器里真的挂载出来了（Task 19 的教训：`curl 200 ≠ 页面可用`）。顺带看一眼
浏览器 console 与 network 面板，有没有 401/500 的噪音请求。

---

## D. M0 之后的第一次生产部署（adopt 之后）

`deploy/openship-adopt.md` 是操作单；adopt 完成后，本清单的 A1/A3/A4 需在**生产域名**上复做
一遍（A2 换成真实 Casdoor 账号、B1/B3 前置齐了就一起做掉）。生产侧特有的两条：
- `PUBLIC_ORIGIN` / 域名 / 企微可信域名三者一致；
- 容器日志 grep `跳过静态托管`（A3）——生产环境这个问题同样是静默的。
