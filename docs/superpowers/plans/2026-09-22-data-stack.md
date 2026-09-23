# 数据栈 P0–P3 落地（duckle ETL + dbt + pg_duckdb + Metabase，issue #150）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两份 spec（选型定稿 + 七层分层）已拍板的数据栈按 **P0→P3** 落进仓与真机：P0 pg_duckdb 镜像（**本轮已改走官方镜像**，自建降为备件）；P1 数据面仓内工件（`deploy/data-compose.yml` / `duckle/` / `dbt/` / `contracts/`）+ 私有化单租户全链路闭环（乐檬 parquet → dbt staging/marts → Metabase 可见）；P2 Metabase 报表 facade + 报表登记 + L2 定义权下放 + 治理四机制；P3 SaaS 多租户（每租户 schema + 凭据收紧 + 串租户回归）。**另有 W4（新增）duckle 引擎能力接入**——见下方「本轮订正」与 W4 节。

**Architecture:** 数据面是**仓内工件 + 拆缝部署单元**（`deploy/customer-onboarding.md` §1 目标形态）：`deploy/docker-compose.yml`（部署单元 A，平台宿主）**不动**；数据栈全部服务进 `deploy/data-compose.yml`（部署单元 B，另一 project，全内网，端口全回环）。语义事实源 = **dbt YAML**（进仓库，是产品；引擎只当编译产物——spec §11.7）；**语义编译 = 我们自己的唯一编译点**（`modules/data/domain/semantic-compiler.ts`）。~~Ossie 暴露走 dbt 原生支持~~ **Ossie 本轮不采用**（见「本轮订正」A3）。平台侧身份/权限/登记/治理全部落在 `modules/data`（**不新建第二个数据域模块**——#146 已交付授权核心 `domain/authz.ts` + 词表 `data.metrics` + PAT + 统一审计，P2/P3 是它的扩面，复用同一条鉴权链）。Metabase 那条连接是**跨租户能力**（spec §11.3.1 安全论断）⇒ AI 建报表必须经平台 facade，凭据只在服务端 env。

**Tech Stack:** 数据面：**pg_duckdb 官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`（Docker Hub，上游构建；上游自陈配对 = DuckDB v1.4.3）** + Metabase OSS（**v0.63.18.1**，PoC 实测版本）+ dbt（postgres adapter 打 pg_duckdb 端点）+ duckle headless runner（二进制容器化）。平台侧：TypeScript / Hono / pg / zod / jose（嵌入 JWT 签名）/ vitest；守卫脚本 `scripts/*.mjs`（checkJs）+ `*.test.ts` fixtures。

**Spec:**
- `docs/superpowers/specs/2026-09-20-data-stack-module-design.md`（选型定稿 §11，2026-09-20 用户确认；§5/§6 的 Cube 内容是**技术记录非推荐路线**）
- `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（七层 + §10 ✅ 拍板记录——**六项裁决已销账，是最新口径**；与 §7 硬约束清单冲突处以拍板记录为准）

**编排侧材料（未进仓，派发 spec 里随附）**：裁决全文 `ledger-fixes.md`「#150/#151 启动前裁决」+「#150 点火前置全清」节（2026-09-22，含 dp-lab 已拍删除）；决策材料 `issue-150-decisions.md`（B7 前置的证据：`docs/architecture.md:121` + `scripts/check-compose.mjs:50`）。两者在编排者 worktree 本地（`.superpowers/sdd/` 不受 git 跟踪）——worker 看不到时找编排者要，别按本计划的转述二次脑补。

---

## ⚠️ 本轮订正（2026-09-23）——**本节口径优先于本计划下方一切旧文**

> **读法**：本计划是一份**边实施边订正**的活文档。下面**五条（A1–A5）**是 2026-09-23 方案整理的**最终口径**；
> 与它冲突的**任何**旧段落（含 Task 1 全文、各范文块、前后各轮自检记录）**一律以本节为准**。
> 职责边界的正典在 `docs/architecture.md` §2.2（新增的「数据栈组件分工」）。

**A1 走官方镜像（取代「自建镜像」）**：`pg_duckdb` 服务改用 **`pgduckdb/pgduckdb:18-v1.1.1`**
（Docker Hub；**上游构建**，其自陈配对 = **DuckDB v1.4.3**）。依据三条：
① `duckdb-ossie` 本轮**不采用** ⇒ 「必须钉 DuckDB v1.5.5」这个**自建的唯一理由消失**；
② **实测**：`pg_duckdb v1.1.1 × DuckDB v1.5.5` **编译失败**（**8 处 API 断裂**，如
`DBConfigOptions` 无 `allow_unsigned_extensions`、`extension_directory` 已改名
`extension_directories`——逐条见 `deploy/pg-duckdb/README.md` §2.2）；
③ **实测**：目标机（`10.0.0.5` / `113.249.104.181`）的 dockerd 已配 HTTPS Proxy，
`docker pull alpine:3.20` **真下载成功** ⇒ **能拉 Docker Hub**。
⇒ **W0 的 T1 从「独立交付块」降为「不派发的备件」**（见「波次与依赖」与 Task 1 头部）。

**A2 自建路径保留但标「未启用（备件）」**：`deploy/pg-duckdb/**` 与
`.github/workflows/pg-duckdb-image.yml` **保留不删**；将来若要走 ossie 通路，**按 `main` + commit sha
重新验证配对**再启用（**不是**「重新 dispatch 一次就好」）。

**A3 Ossie 本轮不采用**：语义声明的事实源 = **dbt YAML**；编译 = **我们自己的唯一编译点**
（`modules/data/domain/semantic-compiler.ts`）。spec §11.3 的「AI 走 `duckdb-ossie` MCP 问数据」
标「**未采纳（观察项）**」，理由：**两条 AI 通路 = 两套词表两套权限，是治理反模式** ⇒
保留**单一受管入口**。

**A4 W4（新增）**：duckle 引擎能力接入（drift / 契约校验 / 血缘 / 新鲜度）见下方 **W4 节**；
`contracts/` 据此**降级为「人写的意图源」**，机器面改用 duckle 自己的声明与门禁。

**A5 订正指针（spec 侧一律不追改）**：`docs/superpowers/specs/**` 是**历史快照，正文不改**。
下列条号**已被本轮取代**，一律以 `docs/architecture.md`（尤其 §2.2 与 §6.1）与本计划本节为准：

| 被取代的 spec 条 | 旧口径 | 现口径 |
|---|---|---|
| `2026-09-20-data-stack-module-design.md` §11.2 #3 | pg_duckdb **自建镜像**、钉 DuckDB **v1.5.5** | **官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`；自建 = 未启用备件 |
| 同上 §11.2 #4 | L1 语义声明 = **Ossie JSON** | **实际存储是 dbt YAML**（`dbt/semantics/l1_metrics.yml` + `dbt/models/common/marts/schema.yml`） |
| 同上 §11.3 | AI 走 **duckdb-ossie MCP** 问数据（两条 AI 路径） | **本轮只保留单一受管入口**（未采纳，观察项） |
| 同上 §11.9 #3/#4 | 「Ossie 观察信号」「自建镜像构建频率」两开放项 | **两项均随本轮消解**（ossie 出局 / 自建未启用） |

---

## 已拍口径（2026-09-22 全部人已拍——实施者不得重开）

| # | 拍板 | 落在本计划哪 |
|---|---|---|
| 0 | **dbt 进主干** = 对 09-20 定稿 §11.1 的生效扩展（定稿生效、dbt 提前） | T4 dbt 项目是 P1 主工件之一 |
| 1 | **定型在 dbt staging**：存量乐檬 parquet（VARCHAR）**不重落盘**，`stg_*.sql` 手写 cast，cast 正确性靠 dbt tests / 对账断言兜；「落盘即定型」收窄为**新数据源接入尽量在落盘侧做对** | T4（staging cast + 对账 singular tests）、T5（contracts 新源契约） |
| 2 | **语义事实源 = dbt YAML**（事实源纪律守 §11.7：引擎只当编译产物）；**语义编译 = 我们自己的唯一编译点**（`modules/data/domain/semantic-compiler.ts`）。~~Ossie 暴露经 dbt 原生支持~~ ⇒ **Ossie 本轮不采用**（2026-09-23「本轮订正」A3） | T4（schema.yml 语义声明）、T8（L1 物化 + 唯一编译点） |
| 3 | **问数入口 = OpenClaw → 平台 MCP**（已随 PR #146 落地，**销账**，本计划不重做）；Metabase MCP 记为「不经 facade 不合规」观察项；**spec §11.3 的 `duckdb-ossie` MCP 通路本轮未采纳（观察项）**——两条 AI 通路 = 两套词表两套权限，是治理反模式 ⇒ 保留单一受管入口 | 头部声明 + T7 不给 Metabase MCP 开任何口 |
| 4 | **物化调度 = openship jobs**（`dbt --select` 由 job 定时打；零新常驻组件） | T6（job 注册）、T11（多租户循环） |
| 5 | **L2 = 定义权下放**：租户管理员 + 平台超管均可**定义**指标与语义（不止 A 薄档裁剪）；定义产出是**受治理、可机检的声明**（禁任意 SQL 不变）；**预留 agent 接入面**（接入本身另题不在本轮）；门禁③机检范围**覆盖用户/agent 产生的声明**；C 厚档维持排除 | T8（L2 声明形态与权限）、T9（门禁③覆盖 L2） |
| 6 | **dp-lab / dp-lab-bi 已拍删除，落地时重建**：删除 = 人在 dashboard 操作（openship MCP 无删项目接口）；部署验证**按目标形态从仓内工件新建** | 开工前置② + T6 |

仍开放的项：**本轮已无**（2026-09-23 订正）。原来记的两项——自建镜像**构建频率与触发**（spec §11.9 #4）与 **Ossie 观察信号**（§11.9 #3）——**均随「本轮订正」消解**：自建路径**未启用** ⇒ 构建频率没有对象；**ossie 不采用** ⇒ 观察信号没有对象。工作流仍保持「**仅 `workflow_dispatch`**、不设 schedule、不在 push/PR 上跑」的形态——这对**备件路径**依然正确（§5.1 同口径）。

---

## 已知边界 / 分期项（2026-09-23 裁决登记——实施者按此执行，**不得自行扩大范围**）

> **用途**：把**已裁决的「本轮不做」与「分期待定」**集中登记，免得它们散在各轮注记里被读成「待办」或「已做」。
> 每条给出 **边界 / 依据 / 回指 issue**；**改边界前先回对应的裁决与 issue**。

| # | 已知边界 / 分期项 | 依据与回指 |
|---|---|---|
| 1 | **平台级 L2（`org='platform'`）的写入不开口（fail-closed）**——本轮**只实现租户 `data:manage` 管本 org 的 L2**；平台级 L2 的**写入面不开**，且 **`tenant:admin` 不得兼作平台门**。⇒ 即「拍板 #5 的平台超管那一半」**本轮不落地**，是**已知边界**而非缺陷 | **裁决（2026-09-23，用户拍）：本轮不做**。理由：仓内**没有平台超管 signal**（平台超管按 spec D4 在 **Casdoor 后台**运营，`tenant:admin` 是**租户级**内置码，`apps/server/src/loader.ts:137`）⇒ **无门可落**，且**不新造第二套超管判定**。回指 issue **#176 的 ②**（同现状见 `modules/data/manifest.yaml` 的 T8 注 + 该模块 README「L2 的已知边界」）。⚠️ 与 **#176 的 ①**（marts **缺 org 列**）**别混为一谈**——那**不是**边界、是**必须在 T6 之前收口的缺口** |

---

## Global Constraints

每条都是**项目级**要求，隐含在**每一个**任务里。

1. **架构先行（T2 是 P1 的第一个任务）**：`deploy/data-compose.yml` 落仓前必须先改 `docs/architecture.md`（§4.1 的 B7 行 + §1 拓扑 + §2 组件表 + §5 扩展点）与 `scripts/check-compose.mjs`（单白名单 → **主 compose + 数据面 compose 双白名单**）——顺序不得颠倒，否则 T3 的 PR 恒红（B7 当场撞）。架构文档更新里必须**显式接受**三条已被官方点名/记录的边界（spec 已知边界）：locked parameters 锁租户是「官方明说不推荐敏感数据」的用法、嵌入带「Powered by Metabase」水印、嵌入页不能禁 CSV 导出（数据外带面）。
2. **B7 双白名单与端口回环**：全仓只许 `deploy/docker-compose.yml` + `deploy/data-compose.yml` 两个 compose；两份文件里**所有** ports 条目一律 `127.0.0.1:` 起头（数据面全内网：不进 edge、不绑公网、不签平台外证书——spec §1）。「受管服务缺 ports 即报」（判据 b）**只对主 compose 的 postgres/server 生效**，数据面服务可整份裁剪、不设受管名。
3. **B1 三同纪律**：`modules/data` 扩展只碰 `data.*` schema（`scripts/lint-architecture.mjs`，gates job + PR 事件都跑）。`dbt/` `contracts/` `duckle/` 在 B1/B8/B9 扫描根（`apps/ packages/ modules/`）之外，靠 T4 的 `check-data-models.mjs` 与评审守。平台代码需要模块数据时走**模块端口**（问数计划约束 14 的既定模式），不自带模块 SQL。
4. **B9 env 契约**：模块代码引用的每个 env 键必须在根 `.env.example` 声明（只写键名与取法，不写真值）。本计划新增：`DATA_METABASE_URL` / `DATA_METABASE_API_KEY` / `DATA_METABASE_SECRET_KEY`（T7）。`scripts/` 与 dbt profile 的键是文档化键面（B9 不扫，但键面事实源仍齐）。
5. **org 隔离**：`modules/data` 新表一律 `org text not null`（值 = `identity.orgId`），读写 `where org = $1`，唯一索引含 org；`scripts/check-tenant-isolation.mjs` 是 gates 第五条守卫，动表的任务本地必跑。L1 平台级声明落 `org = 'platform'` 行（也是合法 org 值，不豁免）。
6. **迁移幂等**：`modules/data/migrations/*.sql` 全 `if not exists` / `add column if not exists`；数据面的租户 provisioning SQL 同样幂等（部署/脚本会全量重跑）。dbt 模型天然幂等（`create or replace` / full-refresh 语义），但**对账 singular test 必须可重复跑**。
7. **export 值/类型分行**（#44 生产事故）：桶文件里绝不混 `interface`/`type`；模块内新文件引类型一律 `import type`。
8. **提交纪律**：本计划实施 PR 一律 **`Refs #150`**——**伞 issue 的关闭权只留给 T13 的收尾 PR**（M2b 教训：#158 的 body 误带 `Closes #151` 提前关了伞 issue，被 discipline CI 抓到后只能 reopen）。docs 类提交免 issue；一切可见变更走 PR、只等 CI **CLEAN**；CHANGELOG 禁手写。
   **与之配套（第十轮 I-2 成文化）：本批 PR 标题与提交的 `type` 一律取 `build` / `docs` / `test`，不得取 `feat` / `fix`**——`scripts/check-pr-discipline.mjs` 对标题 `type ∈ {feat, fix}` **强制** body 含 `Closes/Fixes/Resolves #N`（该脚本的 `NEEDS_ISSUE` 名单），而它抽 issue 号的正则是 `(?:closes|fixes|resolves)\s+#(\d+)`、**不认 `Refs`**（T4 评审 §RR5.2 拿脚本自身的导出函数打真实 PR body 实测）⇒ 与上面「一律 `Refs #150`」**结构性互斥**：「`feat` 标题 + 只写 `Refs #150`」的 PR 在 `discipline` job 上**必红**，二者不可兼得（实测：`typeOf(feat…)=feat` ⇒ `nums.length=0` ⇒ 退出 1）。先例（均 `build(data-stack)` + `Refs #150`，已合并）：**#162 / #164 / #166 / #167 / #168**。**若某任务确实需要 `feat` / `fix`** ⇒ 必须**为该项目单独开一张 issue**（**不能**是伞 issue #150 —— 提前 `Closes` 会把它关掉），PR body 写 `Closes` 那张；**不得用 `skip-issue` 标签绕**（那是给紧急热修的口子，语义不对）。
9. **敏感值**：ZOS 凭据 / Metabase API key / 嵌入签名密钥 / duckle `--token` 只落 openship env(isSecret) 或部署 env，**绝不进仓库/文档/日志/提交信息**；`.env.example` 只写键名与取法。
10. **版本锁死**（2026-09-23 订正：**pg_duckdb 一项已改**）：
    - **pg_duckdb = 官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`**（Docker Hub，上游构建；上游自陈配对 = **DuckDB v1.4.3**）——
      ~~自建镜像钉 DuckDB v1.5.5（spec §11.2 #3，官方钉 v1.5.4 装不上 ossie，实测 404）~~ **作废**：
      ossie 本轮不采用 ⇒ 该理由消失；且自选配对 `v1.1.1 × v1.5.5` **实测编译失败**（8 处 API 断裂）。
      自建路径**未启用（备件）**，见「本轮订正」A1/A2。
    - Metabase **v0.63.18.1**（PoC 实测版；禁 `latest`/`.x` 可变 tag——spec §6.6 纪律）。
    - dbt / duckle 版本在各自 Dockerfile 里 ARG 钉死（默认值待实施时以压测环境实测版本核对）。
      ⚠️ **duckle 的 DuckDB 由它自己的传递依赖独占决定**（实测 `duckle==0.7.3` ⇒ `duckdb-cli==1.5.4`；
      手钉 1.5.5 是 `ResolutionImpossible`）——**与 pg_duckdb 内核不做版本对齐**（那是两个独立实例，
      只经 parquet 交互），详见 `deploy/duckle/README.md` §3。
    - 升级走 runbook，不随手改。
11. **口径单一定义**（layered §3 纪律）：口径只在 marts 定义一次；staging 只规范化不改义；消费层（BI/AI）只能组合已声明的指标与维度。**L2 不能改 L1 口径**（只能裁剪/别名/过滤/目标值/新定义走结构化声明）。
12. **禁任意 SQL 的定义面**：L2 定义 API 只接受**结构化、可机检的声明**（base 引用 + 白名单聚合/过滤/别名），由模块内**唯一编译点**生成 `select_sql`；不接受自由 SQL 入参。L1 行的 `select_sql` 只能由 sync 脚本从仓内 YAML 物化写入。
13. **唯一通道**：一切部署/回滚/重启/env/备份/job 操作走 **openship MCP**（根本法则）；真机验收任务（T6/T10/T13）的执行者是「拿着 openship 权限的操作者」（人或被授权的 agent），不是普通 worktree worker。
14. **AI 消费必须经平台**（spec §11.3.1 安全论断）：`semantic_query` 的 filter allowlist 防不了跨租户，保护来自**每租户会话绑定**——任何绕开 facade 的数据面直连（含 Metabase 官方 MCP）都不合规，不新增此类入口。
15. **先查再动手**（knowledge-capture）：涉及 duckle/S3 兼容端点/WeKnora 上传 → 先检索 WeKnora（skill: `weknora`）；尤其 duckle→天翼 ZOS 的 **sink 能力**——**现行口径（经验库《Duckle 原生 s3 sink 直连天翼云 ZOS 403 根因调查》条目自带的 2026-09-17 订正 + 真机实测；第十轮 B 节）**：**`snk.minio`（"Write via S3-compatible endpoint"）可直写 ZOS**（`validate` 过 2 stages 0 failed / `run` 两次 ok / 两条独立通道回读 / 重跑幂等 ETag+Size 逐字节一致）；**`snk.parquet` 仍 403**（抓包证实它 dial 的是 AWS 默认端点、根本没到 ZOS）、**`snk.s3` 仍 404**。⚠️ **旧口径「duckle 原生 s3 sink 直连 ZOS 反复 403、判定能力空白」已被取代**（同句尚在 spec §8，spec 是历史快照、**不追改**）——本仓/本部署面的复现归 T6（Task 6 Step 1 的 **Gate-D**）；**别照旧稿重推「能力空白」**。

---

## 开工前置——外部输入与 gate（编排者管，不是 worker 的步骤）

> 哪项没到位，对应 gate 波就**派不得**（派了也会停在第一个 gate 步）。正文里每个 gate 步回指这里的编号。

| # | 外部输入 | 谁给 | 解锁什么 | 没给卡住什么 |
|---|---|---|---|---|
| ① | ~~**pg_duckdb 镜像的可获取通道**：GHCR 拉取凭据（目标机 `docker login ghcr.io`）**或**「目标机本地构建」路径；另确认 Actions 额度可承担一次 ~1–2h 的 C++ 构建~~ ⇒ **已消解（2026-09-23）**：改用**官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`，Docker Hub **实测可拉**（目标机 dockerd 已配 HTTPS Proxy，`docker pull alpine:3.20` 成功）⇒ **不再需要** GHCR 凭据、本地构建路径**或** Actions 额度 | ~~人（org 设置 + dashboard）~~ **无人**（已完成） | ~~T1 的首次构建~~ **无** | **不再卡任何任务**（备件将来启用时才重新需要） |
| ② | ~~**dp-lab / dp-lab-bi 删除**（已拍，人在 dashboard 操作：`proj_BzOHhfY6_8OUFHR9` / `proj_gFnTdeeQfEuLPuQV`）+ **目标机选定**（第一次部署验证跑哪台机、与哪些生产负载同机）~~ ⇒ **已全部就位（2026-09-23）**：① dp-lab / dp-lab-bi **已删除**（2026-09-23，**含宿主侧清理**）；② **目标机已定**：`113.249.104.181` = `10.0.0.5` = server **`8281d598`**（shanghai）。⚠️ **该删除不阻塞 T6**：dp-lab 两项目在 server `23a1091e`（mytech-weknora），而 T6 目标机是 `8281d598`——**不同宿主、无端口/卷/网络共享** ⇒ 它属**清场项而非 gate**（原表把它与「目标机选定」捆成一个 gate 是过度绑定） | 人（**已完成**） | T6 全部（目标机已定） | **不再卡任何任务** |
| ③ | **ZOS 乐檬桶只读凭据**（存量 parquet 的读取面）落 openship env(isSecret)；**Metabase 服务账号 API key + 嵌入签名密钥**（T7 的 env 三键真值） | 人 | T6（ZOS）/ T10（Metabase） | T6 的 dbt 首跑、T10 |
| ④ | **业务排期/窗口**（目标机上首次起数据面、注册物化 job 的时段确认） | 人与客户/机主 | T6 的 `up` 与 job 注册 | T6 后半 |
| ⑤ | **SaaS 双租户验收环境**（multi 形态、两个测试租户 + 各自用户/PAT/凭据）与排期 | 人 | T13 | 仅 T13；T11/T12 的代码面不受影响 |
| ⑥ | **dbt 实测版本确认**：压测环境现场实际安装的 dbt 版本号（或确认按默认 `1.9.8` 钉死）——layered §11 只记了内存资源画像、**没有版本号**，「以 §11 实测版本核对」的出处不存在 | 人（实测人） | T3 的 `DBT_VERSION` 注释销账、T6 真跑用的版本 | T3 工件按默认值可先行；卡 T6 前的版本落定 |

派发前另两件事（团队记忆）：**先 `git fetch origin main`**（Orca `--base-branch main` 取本地 ref，长期 worktree 会脱节）；**worktree 路径必须 ASCII**（中文路径打挂 vitest 的 TS fixture 加载）。

---

## 文件结构与派发表

### 新建 / 修改的文件（全量）

| 文件 | 职责 | 任务 |
|---|---|---|
| `deploy/pg-duckdb/Dockerfile` | 自建 pg_duckdb 镜像（§11.4 recipe 容器化）——**⚠️ 未启用（备件）** | T1（**备件，不派发**） |
| `deploy/pg-duckdb/README.md` | 构建与运行 runbook（§11.4/§11.5 + 手工 docker commit 兜底）——**⚠️ 未启用（备件）**；文首记本轮改用官方镜像的理由与实测失败结论 | T1（**备件，不派发**） |
| `.github/workflows/pg-duckdb-image.yml` | 仅 `workflow_dispatch` 的镜像构建 → GHCR——**⚠️ 未启用（备件）** | T1（**备件，不派发**） |
| `docs/architecture.md` | B7 行改双白名单 + §1 拓扑（部署单元 B）+ §2 组件表 + §5 扩展点 + 三条显式接受 | T2 |
| `scripts/check-compose.mjs` | `ALLOWED` 单字符串 → 双白名单；规则二遍历两份文件 | T2 |
| `scripts/lint-architecture.test.ts` | **扩既有**的 check-compose fixtures describe（B7 测试一直在这里，黑盒 spawn 形态——别另起新测试文件） | T2 |
| `deploy/data-compose.yml` | 部署单元 B：pg_duckdb / metabase-db / metabase / duckle(etl profile) / dbt(etl profile) | T3 |
| `deploy/dbt/Dockerfile` | dbt runner 薄镜像（版本 ARG 钉死） | T3 |
| `dbt/dbt_project.yml` / `dbt/profiles.example.yml` | dbt 项目与连接模板（真值不进 git） | T4 |
| `dbt/models/common/staging/stg_lemeng_*.sql` + `sources.yml` | 乐檬 staging（手写 cast，一对一） | T4 |
| `dbt/models/common/marts/*.sql` + `schema.yml` | 星型/口径模型 + **语义声明（L1，事实源）** + dbt tests | T4 |
| `dbt/tests/audit_*.sql` | 对账 singular tests（每指标一条独立复算） | T4 |
| `dbt/models/customers/README.md` | 按客户扩展的目录约定（首个客户目录随 T6 建） | T4 |
| `dbt/README.md` | cast 规范/漂移策略/S3 凭据注入方式（核对结论落档） | T4 |
| `scripts/check-data-models.mjs` + `.test.ts` | 数据工件静态门禁（staging 模式 / 语义声明必填 / 同名唯一 / 对账测试存在） | T4（T9 扩） |
| `.github/workflows/ci.yml` | gates job 加一行 check-data-models | T4 |
| `.env.example` | dbt profiles 的文档化键段（B9 不扫 dbt，键面事实源仍齐） | T4 |
| `contracts/README.md` + `contracts/common/` + `contracts/customers/` | 采集契约（新源落盘 schema 声明，机检格式） | T5 |
| `duckle/common/` + `duckle/customers/` + `duckle/README.md` | duckle 管线定义骨架（ZOS 直写按未验证对待） | T5 |
| `deploy/duckle/Dockerfile` | duckle headless runner 镜像（二进制 + SHA256 校验 + `--token` 硬要求） | T5 |
| `deploy/customer-onboarding.md` | **摘掉六处「尚未进仓」标注**（PR #154 加的 :33/:51/:91/:157/:172/:199） | T6 |
| `docs/data-platform-handbook.md` | §3 落地位置四个 `<待补>` 补齐 + §5 验收记录 | T6 |
| `modules/data/domain/metabase.ts` + `.test.ts` | Metabase 客户端纯核（幂等 upsert / 嵌入开关 / 对账可观测面 / JWT 签名） | T7 |
| `modules/data/migrations/002_reports.sql` | 报表登记表（双写面的平台侧） | T7 |
| `modules/data/routes/reports.ts` + `.test.ts` | 报表管理 + 嵌入 URL 签发 + 对账端点 | T7 |
| `modules/data/manifest.yaml` / `index.ts` | 报表面声明与注册（**同一提交**） | T7 |
| `modules/data/console/*` | console 加「报表」页签（嵌入 iframe） | T7 |
| `.env.example` | `DATA_METABASE_*` 三键 | T7 |
| `modules/data/migrations/003_metrics_source.sql` | `data.metrics` 加 `source` 列（l1/l2） | T8 |
| `modules/data/domain/metric-store.ts` / `semantic-compiler.ts` | L1/L2 合并加载 + **唯一编译点**（结构化声明 → select_sql） | T8 |
| `modules/data/routes/metrics.ts` | 定义 API 收紧：L2 只收结构化声明 | T8 |
| `scripts/sync-data-semantics.mjs` | dbt YAML 的 L1 声明 → `data.metrics`（org='platform'）幂等物化 | T8 |
| `deploy/Dockerfile.server` | COPY 清单加 `dbt/`（sync 脚本的服务端读取面） | T8 |
| `deploy/data-tenants/provision-template.sql` + `scripts/reconcile-data-tenants.mjs` | 每租户 role + pg_duckdb USER MAPPING（凭据收紧）+ 租户启用集对账 | T11 |
| `dbt/macros/generate_schema_name.sql` | 每租户 schema 名生成 | T11 |
| `scripts/e2e-data-cross-tenant.mjs` + `.test.ts` | 串租户回归套件（问数/embed 缓存重放/桶凭据负测/L2 词表） | T12 |
| `docs/superpowers/specs/2026-09-20-data-stack-module-design.md` | §11.8 分期落地注记 + 已知边界更新（收尾） | T13 |

### 波次与依赖

| 波 | 任务 | 并行度 / 依赖 | gate |
|---|---|---|---|
| **W0（P0）** | ~~T1 镜像~~ ⇒ **不派发**（**降为备件「未启用」**，2026-09-23：「本轮订正」A1/A2） | — | — |
| **W1（P1 仓内工件）** | **T2（架构+B7）先行 → T3（data-compose）∥ T4（dbt）∥ T5（contracts+duckle）** | T3 依赖 T2（B7 放行）；T4/T5 与 T2/T3 文件面零交集 | — |
| **W1g（P1 真机闭环）** | T6 部署闭环 + 摘标注 | 操作者任务，串行 | 外部输入①②③④⑥ + W1 全合并 + ~~**T1 版本配对已验收（首次 dispatch）**~~ ⇒ **该前置已消解**（走官方镜像，无自选配对可验收；「本轮订正」A1） |
| **W2（P2 治理与配置面）** | **T7（facade+登记）→ T8（L2 定义权）→ T9（治理四机制）** | 严格串行：T7/T8 都改 `manifest.yaml`+`index.ts`（装载期双向核对，并行必冲突）；T9 的门禁③消费 T8 的声明形态；**T9 另依赖 T11**（跨波文件重叠，见下方第十一轮订正） | — |
| **W2g（P2 e2e）** | T10 端到端验收 | 操作者任务 | W1g 部署存活 + 外部输入③（Metabase 凭据）+ W2 合并 |
| **W3（P3 多租户代码面）** | T11（每租户 schema+凭据）→ T12（串租户回归套件） | 串行（T12 断言依赖 T11 形态） | — |
| **W3g（P3 SaaS 验收）** | T13 验收 + 收尾 + 关伞 | 操作者任务 | 外部输入⑤ + T11/T12 合并 + W1g 同款部署面 |
| **W4（新增，P0–P3 之后）** | **T14 duckle 引擎能力接入**（drift / 契约校验 / 血缘 / 新鲜度；`contracts/` 定位订正） | 见 W4 节（**文档已落，实现按接入 PR 分批**） | W1 全合并（`duckle/` + `deploy/duckle/` 在场）；**首次真跑前**须先销 §7.4 的四项未验 |

**W1 文件面零交集核验**（并行判据，逐任务点名的唯一触碰面）：
T2 = `docs/architecture.md` + `scripts/check-compose.mjs` + `scripts/lint-architecture.test.ts`；T3 = `deploy/data-compose.yml` + `deploy/dbt/Dockerfile`；T4 = `dbt/**` + `scripts/check-data-models.*` + `.github/workflows/ci.yml` + `.env.example`；T5 = `contracts/**` + `duckle/**` + `deploy/duckle/Dockerfile` + `.gitignore`。两两无共享文件，`ci.yml` 与 `.env.example` 只被 T4 碰（`.env.example` 的下一处触碰在 W2 的 T7，串行不冲突）。

**第十一轮订正——跨波文件重叠（原核验未查）**：上行核验只覆盖了 **W1 内部**的零交集，**未查跨波重叠**。实测 **T9 与 T11 共享两个文件**——`scripts/check-data-models.test.ts`（T11 的 16 例 fixtures）与 `dbt/README.md`（T11 的「多租户跑法」节）⇒ 原表的「W2 严格串行」只覆盖 W2 内部，**不能推出「W3 与 T9 无关」**。处置：**把 T11 编进 T9 的 `--deps`**（见下方派发块），既**保住 T7 ∥ T11 的并行收益**（T11 不依赖 T7），又挡住两笔在合并时互相撞车。这条也是「本波教训」第 1 条的同形实例：**判据写对了，但落点清单没列全**。

Orca 派发（W1 四任务两批；W2/W3 用 `--deps` 编码串行）：

```bash
git fetch origin main   # 先对齐（团队记忆：--base-branch main 取本地 ref）

# W0：**不派发**（2026-09-23 订正：T1 降为备件「未启用」；已合并的产物保留，见「本轮订正」A1/A2）
#   ~~orca orchestration task-create --spec "<T1 spec：pg_duckdb 镜像，见计划 Task 1>" --json~~
#   ~~orca orchestration worker-start --task <t1> --worktree new-top-level --name ds-image --agent claude --setup run --json~~

# W1：T2 先行；T2 合并后 T3/T4/T5 一次连发（三路并行）
orca orchestration task-create --spec "<T2 spec：架构先行+B7 双白名单>" --json
#   （T2 合并后）
orca orchestration task-create --spec "<T3 spec：data-compose>" --json
orca orchestration task-create --spec "<T4 spec：dbt 项目>" --json
orca orchestration task-create --spec "<T5 spec：contracts+duckle>" --json
orca orchestration worker-start --task <t3> --worktree new-top-level --name ds-compose --agent claude --setup run --json
orca orchestration worker-start --task <t4> --worktree new-top-level --name ds-dbt     --agent claude --setup run --json
orca orchestration worker-start --task <t5> --worktree new-top-level --name ds-etl     --agent claude --setup run --json

# W2 / W3：串行链用 --deps
orca orchestration task-create --spec "<T7 spec>" --deps '["<t6 或 w1 收口 task_id>"]' --json
orca orchestration task-create --spec "<T8 spec>" --deps '["<t7 task_id>"]' --json
orca orchestration task-create --spec "<T9 spec>" --deps '["<t8 task_id>","<t11 task_id>"]' --json
#   ↑ T11 必列（第十一轮订正）：T9 与 T11 共享 scripts/check-data-models.test.ts 与 dbt/README.md。
#     T11 可在 T7 期间并行开工（它不依赖 T7），但必须在 T9 之前合并。
# T10/T12/T13 同式（T12 依赖 T11）；--name 全 ASCII
```

> gate 波（T6/T10/T13）不 `worker-start`——按 M2b T5 形态派「操作者任务」或由编排者亲自执行。

---

## 常用命令（全计划通用，照抄 CI 原命令形态）

```bash
# 模块（P2/P3 的模块任务）
pnpm --filter data test
pnpm --filter data typecheck

# 全仓门禁（每波末必跑；CI gates job 同款——五条守卫一条不落 + T4 起第六条）
pnpm typecheck && pnpm test
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/check-tenant-isolation.mjs
# T4 合并后追加：
pnpm exec tsx scripts/check-data-models.mjs
```

> 带库用例：`DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（本地 compose pg；不带时相关 describe 静默 skip——skip 不等于通过，收尾前必须带 env 跑一次）。动 `data.*` 表的任务（T7/T8）后本地必跑 check-tenant-isolation。
>
> dbt 侧（T4 本地结构验证 / T6 真跑）：`dbt parse`（不连库）；真跑形态见 T6（`dbt build --select …`，profiles 键见 `dbt/profiles.example.yml`）。

---

# W0（P0）— 自建镜像基础　【**已降级为备件（未启用），不派发**】

> ## ⚠️ T1 降级为「备件（未启用）」（2026-09-23，「本轮订正」A1/A2）
>
> **本任务不再派发。** 产物（`deploy/pg-duckdb/**` + `.github/workflows/pg-duckdb-image.yml`）
> **已合并、保留不删**；`deploy/data-compose.yml` 的 `pg_duckdb` 服务已改用**官方镜像**
> `pgduckdb/pgduckdb:18-v1.1.1`。**下面整节按「备件的构建 runbook + 实测记录」读**，
> **不是待执行的步骤**。
>
> **启用备件的入口条件**：按 `main` + commit sha **重新验证配对**——自选的
> `pg_duckdb v1.1.1 × DuckDB v1.5.5` **已实测编译失败**（8 处 API 断裂），
> **不是**「重新 dispatch 一次就能过」（`deploy/pg-duckdb/README.md` §2.2/§5.2）。

### Task 1: pg_duckdb 自建镜像（Dockerfile + workflow_dispatch 构建 + GHCR + runbook）　【**备件，不派发**】

**~~为什么不被任何决策阻塞~~ ⇒ 本任务的存在理由已改（2026-09-23）**：原文的理由（「只依赖
spec §11.4 的实测 recipe（已验证可行）……是 #150 里唯一在 W1 之前就能独立交付的块」）
**只在 ossie 通路下成立**；ossie 出局（A3）+ 自选配对**实测编译失败**（A1）之后，
本任务**降为备件**。下面各 Step 是**已执行过的历史步骤 + 备件启用时的参考**。

**Files:**
- Create: `deploy/pg-duckdb/Dockerfile`
- Create: `deploy/pg-duckdb/README.md`
- Create: `.github/workflows/pg-duckdb-image.yml`

**Interfaces:**
- Consumes（**本任务已降为备件，下列输入当前无消费场景**）：spec §11.4 recipe（**已按 T1 交付实证订正，见 Step 1 后的订正说明——不是逐字转录**）；pg_duckdb v1.1.1 release + DuckDB v1.5.5 tarball（**别用 git clone——子模块在这条网上爬不动**，spec 原话；⚠️ 这一对该配对**实测编译失败**，见下风险条）。
- Produces: ~~镜像 `ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5`（tag 编码 pg_duckdb 版本 + DuckDB 版本；**不打 `latest`**——可变 tag 禁用是版本纪律）~~ ⇒ **⚠️ 该镜像从未产出**：首次构建**实测停在编译阶段**（8 处 API 断裂，见 `deploy/pg-duckdb/README.md` §2.2）。tag 公式与纪律仍见该 README §0（**备件启用时**才用得上）。

> **⚠️ 计划层选型风险 ⇒ 已实测落定：该配对编译失败（本任务据此降为备件）**
> pg_duckdb v1.1.1 自陈配对 DuckDB **v1.4.3**，而本计划原用 **v1.5.5**（跨 1 个 minor；
> 上游 CI 从不覆盖 `DUCKDB_VERSION`；spec 实测的 lab 是 pg_duckdb main/1.2.0-dev + v1.5.5）。
> 头文件级断裂**确实**排除了（v1.1.1 引用的 **52 个 duckdb 头**——**口径**：`#include "duckdb/…"` 与 `#include <duckdb/…>` **两形态并集去重**（只取双引号形态得 43，是更窄的口径；两处数字打架的根因就是口径没写）——在 v1.5.5 中 **52/52 全在**，逐条 HTTP 探针实测），
> **但它推不出「编译得过」**：**首次构建实测 8 处 API 断裂**（原名逐条见
> `deploy/pg-duckdb/README.md` §2.2，如 `DBConfigOptions` 无 `allow_unsigned_extensions`、
> `extension_directory` 已改名 `extension_directories`）⇒ **该配对不成立**。
> ⇒ **本条风险已关闭**：处置 = **改走官方镜像**（「本轮订正」A1），**不是**走原预案的「ARG 回退 `main`」。
> **备件将来启用时**才回到回退口径，且必须**按 `deploy/pg-duckdb/README.md` §0 的订正口径
> 重新核对上游自陈配对 + 重新实测 + 出「新」tag**（回退场景建议 `main-duckdb1.5.5` /
> `<sha8>-duckdb1.5.5`），**不得复用 `1.1.1-duckdb1.5.5`**——tag 是 Step 2 workflow `tags:` 与
> runbook §1b ⑦ `docker commit` 的**硬编码字面量**，不由 ARG 推导。原「W1g 的显式前置」**已消解**
> （官方镜像没有自选配对可验收，见波次表 W1g 行）。

- [ ] **Step 1: 写 Dockerfile（recipe 容器化；三个编译配置缺一不可）**

```dockerfile
# deploy/pg-duckdb/Dockerfile — 自建 pg_duckdb（spec 2026-09-20 §11.2 #3 / §11.4，实测 recipe 容器化）。
#
# ⚠️ 当前未启用（备件）——2026-09-23：部署路径已改用官方镜像 pgduckdb/pgduckdb:18-v1.1.1
#（deploy/data-compose.yml）。本文件保留不删；启用前先按 README §0 的订正口径核对上游自陈配对、
# 重新实测编译，并出新 tag。详见 deploy/pg-duckdb/README.md 文首与 §2.2、§5.2。
#
# 为什么当初自建：官方 pg_duckdb 钉 DuckDB v1.5.4，duckdb-ossie 只发到 v1.5.5（安装 404，实测）；
# 且 pg_duckdb 需 superuser + shared_preload_libraries（spec §9.4 方案 2）⇒ 必须自建 PG。
# ⚠️ 该理由**已消失**（ossie 本轮不采用）；且本镜像的 v1.1.1 × v1.5.5 配对**实测编译失败**
#（8 处 API 断裂，见 README §2.2）⇒ 这条路本轮不通。
# 构建耗时长（C++ 全量编译，-j2 下 ~1–2h）——这是版本换来的代价，别为了快改并行度把机器打 OOM
#（spec 实测：外层 -j 压不住 ninja，它按 nproc 起任务 ⇒ OOM；DISABLE_UNITY=1 同理是 OOM 对策）。
FROM postgres:17 AS build
ARG PG_DUCKDB_VERSION=v1.1.1
ARG DUCKDB_VERSION=v1.5.5
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl build-essential cmake ninja-build \
      liblz4-dev libzstd-dev zlib1g-dev libcurl4-openssl-dev postgresql-server-dev-17 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# tarball 预填 third_party/duckdb，绕开 git submodule（spec §11.4 ①）
RUN curl -fsSL https://github.com/duckdb/pg_duckdb/archive/refs/tags/${PG_DUCKDB_VERSION}.tar.gz \
      | tar xz --strip-components=1
RUN mkdir -p third_party/duckdb \
    && curl -fsSL https://github.com/duckdb/duckdb/archive/refs/tags/${DUCKDB_VERSION}.tar.gz \
      | tar xz -C third_party/duckdb --strip-components=1
# 补「子模块已初始化」哨兵：Makefile 的目标文件挂在
#   $(OBJS): .git/modules/third_party/duckdb/HEAD
# 上；该路径缺失时 make 会执行 `git submodule update --init --recursive`，
# 而上面 tarball 解出的树**不是 git 仓库** ⇒ fatal，退出 128（是当场退出，不是编译失败）。
# 源码既已由 tarball 预填到位 ⇒ 只需哨兵文件让 make 判该 target up-to-date（跳过 recipe）。
# ⚠️ 不是可选的：不加这两行，tarball-only 构建必挂。
RUN mkdir -p .git/modules/third_party/duckdb \
    && touch .git/modules/third_party/duckdb/HEAD
# 上游真 bug 的手工补丁（spec §11.4 ③）：jemalloc 文件缺一个 include
# ⚠️ 路径在**第三方树内**（该文件属 DuckDB）：pg_duckdb 自己的 src/ 下没有它——
# 按 §11.4 的简写写成 src/common/allocator/... 会 No such file 当场失败。
RUN sed -i '1i #include "duckdb/common/string_util.hpp"' \
      third_party/duckdb/src/common/allocator/allocator_jemalloc.cpp
# §11.4 ②：三个编译配置缺一不可（DISABLE_UNITY / CMAKE_BUILD_PARALLEL_LEVEL / 上面的 include）
RUN make DUCKDB_VERSION=${DUCKDB_VERSION} \
      DUCKDB_CMAKE_VARS="-DCXX_EXTRA=-fvisibility=default -DBUILD_SHELL=0 -DBUILD_PYTHON=0 -DBUILD_UNITTESTS=0 -DDISABLE_UNITY=1 -DOVERRIDE_GIT_DESCRIBE=${DUCKDB_VERSION}" \
      CMAKE_BUILD_PARALLEL_LEVEL=2 -j2
RUN make install

FROM postgres:17
# 运行期依赖：pg_duckdb.so 经 libduckdb.so 依赖 libcurl.so.4（ldd 实测），而 postgres:17 不带 libcurl4。
# §11.4 ④ 的 docker commit 路径碰不到这问题（libcurl4-openssl-dev 顺手把 libcurl4 带进了镜像）；
# 多阶段构建**不继承** build stage 的包 ⇒ 必须显式装。不装 = 扩展加载时报
# `libcurl.so.4: cannot open shared object file`（运行期加载失败，不是构建失败）。
RUN apt-get update && apt-get install -y --no-install-recommends libcurl4 \
    && rm -rf /var/lib/apt/lists/*
# make install 的落点在 PG 的 pkglibdir/sharedir——首次构建时以 `make install` 实际输出核对 COPY 路径
#（builder 与本 stage 同基镜像，路径一致；对不上就按 install 日志订正，别猜）。
COPY --from=build /usr/lib/postgresql/17/lib/ /usr/lib/postgresql/17/lib/
COPY --from=build /usr/share/postgresql/17/extension/ /usr/share/postgresql/17/extension/
# pg_duckdb 需 superuser + shared_preload_libraries（spec §9.4 方案 2）；compose 侧经 command 传
```

> ⚠️ 最后一组 COPY 路径标注了「首次构建核对」——recipe 只验证到 `make install` 成功，install 产物落点以构建日志为准。这是有意的 gate，不是含糊。

> **订正说明（2026-09-22，按 T1 交付实证）**：上面的范文块已**换成本体订正后的版本**（不是加注记），四处与旧稿不同：
> ① `sed` 目标补全到**第三方树内**（`third_party/duckdb/src/...`；该文件属 DuckDB，pg_duckdb 树内 `src/` 无 `common/` 目录）；
> ② 新增**子模块哨兵** `mkdir -p .git/modules/third_party/duckdb && touch .git/modules/third_party/duckdb/HEAD`；
> ③ 最终 stage 新增**运行期** `apt-get install -y --no-install-recommends libcurl4`；
> ④ Step 2 的 `tags:` 改用**小写字面量** `ghcr.io/mytech-co-ltd/...`。
> **四处根因同一个**：spec §11.4 的**简写**（③ 的路径未点明在第三方树内）与**缺项**（无 ② 哨兵步、无 ③ 多阶段运行期依赖、④ 未点明 org 名大写非法）。
> ⚠️ **旧稿是被 T1 交付实证证伪的版本，别再照抄旧稿**（本仓已知复发坑：订正只落注记、范文块不动 ⇒ 后来者照抄即复发）。
>
> **订正说明（2026-09-23，本轮）**：范文块的**头部注释**已与仓内 `deploy/pg-duckdb/Dockerfile`
> **逐字对齐**（补「当前未启用（备件）」段与实测失败的结论）——**构建逻辑一字未动**
> （硬约束：本文件只许改注释）。**整节已降为备件、不派发**（见本节头部）。

- [ ] **Step 2: 写 workflow（仅手动触发）**

```yaml
# .github/workflows/pg-duckdb-image.yml — 自建 pg_duckdb 镜像构建（P0，spec §11.8）。
# 仅 workflow_dispatch：构建频率与触发是 spec §11.9 #4 的**仍开放项**，本工作流不替它拍板——
# 不设 schedule、不在 push/PR 上跑。跑一次 ~1–2h 的 C++ 构建，动前想清楚 Actions 额度
#（team-harness PR#79 因账单挂起的教训）。
name: pg-duckdb-image
on: { workflow_dispatch: {} }
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 240
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: deploy/pg-duckdb       # Dockerfile 无本地 COPY，小 context；file 缺省即 <context>/Dockerfile
          platforms: linux/amd64          # 生产机都是 amd64；别多平台翻倍烧时间
          push: true
          # ⚠️ owner 段**必须写字面量小写**，不能用 ${{ github.repository_owner }}：
          # 本 org 是 MYTech-Co-LTD（含大写），而 OCI 引用名只接受小写仓库名 ⇒
          # buildx 报 `invalid tag "ghcr.io/MYTech-Co-LTD/...": repository name must be lowercase`。
          # 实测的失败时机：**解析 tag 阶段即终止**（Dockerfile 都没被读，一个构建步骤都不跑）——
          # 最便宜的失败形态，但错字面量仍会挡住整条路径，别写错。
          # 小写形态与 deploy/data-compose.yml 的引用（T3）逐字一致——改这里必须同步改那里。
          tags: ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5
```

- [ ] **Step 3: 写 runbook（`deploy/pg-duckdb/README.md`）**

必含四节：① 构建路径（CI dispatch；**手工 docker commit 兜底**——§11.4 recipe 的原形态，目标机/无额度时用，两路径产物同源同 tag）；② 运行期硬约束（§11.5 三条逐字：DuckDB 实例按连接、SET 与使用同会话；`install_extension` 同会话开两个 allow；`duckdb.query()` 看不到 PG 表用 `raw_query`）；③ 内存口径（每连接一个 DuckDB 实例、`max_memory` 默认 4096MB/连接——spec §9.4；资源收口怎么做：连接池上限 + `duckdb.memory_limit` 显式设）；④ ~~构建频率开放项说明（现口径=按需 dispatch；升级 DuckDB 版本 = 改 ARG 重跑，先核对 **duckdb-ossie 的发布版本**~~ ⇒ **2026-09-23 订正：本任务未启用，④ 改述为**「**备件启用时的入口条件**」——构建频率开放项**随本轮消解**；升级路径改为「**先按 §0 核对上游自陈配对 + 重新实测编译**」，**别再把 ossie 的发布版本当作 DuckDB 上限的依据**；**tag 是硬编码字面量、不由 ARG 推导，升级/回退都要按 §0 同步出「新」tag，别覆盖旧 tag**（这一句不变）。

- [ ] **Step 4: 验证 + 提交**　[**历史步骤——已于 2026-09-22 执行完毕（PR #162 已合并）**，勿重跑]

Run:
```bash
docker build --check -f deploy/pg-duckdb/Dockerfile .               # 语法面（需较新 docker；没有则留待首次真构建）
pnpm exec tsx scripts/check-compose.mjs                                # 不受影响，应 OK
pnpm typecheck && pnpm test
```
Expected: 全绿（本任务不碰既有面）。镜像的**真构建**（`docker build` 全程 / workflow dispatch）依赖外部输入①的额度确认——工件的正确性以 CI 构建成功为准，这一步记录在 T6 前完成即可。

```bash
git add deploy/pg-duckdb .github/workflows/pg-duckdb-image.yml
git commit -m "build(data-stack): 自建 pg_duckdb 镜像——DuckDB v1.5.5 recipe 容器化 + dispatch 构建"
gh pr create --title "build(data-stack): pg_duckdb 自建镜像（P0）" --body "Refs #150"
```

> **本条已按 T1 交付实证订正（commit `a5a0032` / PR #162）**：Step 1 / Step 2 的范文块已**换成交付物实证版本**（四处订正与根因见 Step 1 后的订正说明）；计划的版本配对风险条见 Interfaces 下（W1g 有显式前置）。**本条订正只动文档**——T1 交付物（`deploy/pg-duckdb/*`、`.github/workflows/pg-duckdb-image.yml`）另行处理，不在此列。
>
> **2026-09-23 追加（本轮订正）**：**T1 整体降为「备件（未启用）、不派发」**（「本轮订正」A1/A2）——
> 该配对**实测编译失败**（8 处 API 断裂），部署路径已改走官方镜像。Step 1–4 全部转为
> **历史记录 + 备件启用时的参考**；T1 交付物（三文件）**保留在仓**，其中
> `deploy/pg-duckdb/README.md` / `Dockerfile` / `.github/workflows/pg-duckdb-image.yml`
> 本轮**只改了注释与文档**（构建逻辑一字未动）。

---

# W1（P1）— 仓内工件

### Task 2: 架构先行 + B7 双白名单（architecture.md + check-compose.mjs + 守卫测试）

**为什么是 P1 第一个任务**：`data-compose.yml` 落仓会当场撞 B7（`check-compose.mjs:50` 写死 `ALLOWED = 'deploy/docker-compose.yml'`；约束条目 `docs/architecture.md:121`「全仓唯一 compose」）。公司规则 architecture-first：**先经人同意（spec 定稿 + 本计划评审 = 已同意的形态）→ 更新架构文档 → 再写代码**。本任务把「主 compose + 数据面 compose」的双白名单写进正典与守卫，T3 才有放行面。

**Files:**
- Modify: `docs/architecture.md`
- Modify: `scripts/check-compose.mjs`
- Modify: `scripts/lint-architecture.test.ts`（B7 的 fixtures 测试**一直在这里**——文件头注「覆盖三个脚本：lint-architecture、check-compose、check-env-example」，黑盒 spawn 形态。本任务扩它的 check-compose describe，**不另起新测试文件**。）

**Interfaces:**
- Consumes: `lint-architecture.test.ts` 既有的 `fixture()` / `run()` / `MINIMAL_COMPOSE` / `expectClean` 测试基建（spawn `check-compose.mjs <rootDir>`、断言退出码与输出行——门卫的对外契约就是这两样）。
- Produces: `check-compose.mjs` 的 `ALLOWED` 从单字符串变双白名单数组；`checkHostPortBindings` 对**每一份**放行文件执行判据 a/c，「受管服务缺 ports」（判据 b）按文件映射只对 `deploy/docker-compose.yml` 的 `postgres`/`server` 生效。

- [ ] **Step 1: 先扩既有测试（`lint-architecture.test.ts` 的 check-compose describe 加一组，先红）**

在既有「B7 全仓唯一 compose」describe 里：把首条用例的标题与语义更新为「只允许白名单两份」（负例的 `apps/server/docker-compose.yml` 仍违规，不用改），并**新增**一组：

```ts
describe('check-compose: B7 双白名单（P1 数据面 compose，issue #150）', () => {
  // 复用既有 fixture()/run()/expectClean；DATA_COMPOSE 是端口全回环的合法数据面最小例
  const DATA_COMPOSE = [
    'services:',
    '  pg_duckdb:',
    '    ports:',
    "      - '127.0.0.1:15432:5432'",
    '',
  ].join('\n')

  it('★ 主 compose + data-compose（全回环）→ 干净【本任务的行为变更，改 ALLOWED 前先红】', () => {
    const r = run('check-compose.mjs', fixture({
      'deploy/docker-compose.yml': MINIMAL_COMPOSE,
      'deploy/data-compose.yml': DATA_COMPOSE,
    }))
    expectClean(r)   // 现状红：data-compose 被判「多出来的 compose 文件」
  })

  it('★ data-compose 缺席 → 仍干净（拆缝是可选形态，第二份文件不强制存在）', () => {
    expectClean(run('check-compose.mjs', fixture({ 'deploy/docker-compose.yml': MINIMAL_COMPOSE })))
  })

  it('★ 规则二覆盖第二份文件：data-compose 的非回环端口违规', () => {
    const r = run('check-compose.mjs', fixture({
      'deploy/docker-compose.yml': MINIMAL_COMPOSE,
      'deploy/data-compose.yml': DATA_COMPOSE.replace("'127.0.0.1:15432:5432'", "'15432:5432'"),
    }))
    expect(r.status).toBe(1)
    expect(out(r)).toContain('deploy/data-compose.yml')
    expect(out(r)).toContain('未绑回环')
  })

  it('★ 第三份 compose 仍违规（白名单只有两份）', () => {
    const r = run('check-compose.mjs', fixture({
      'deploy/docker-compose.yml': MINIMAL_COMPOSE,
      'deploy/data-compose.yml': DATA_COMPOSE,
      'dbt/docker-compose.yml': MINIMAL_COMPOSE,
    }))
    expect(r.status).toBe(1)
    expect(out(r)).toContain('dbt/docker-compose.yml')
  })

  it('★ 判据 b 不跨文件：data-compose 里没有 postgres/server 不构成违规（受管名只对主 compose）', () => {
    expectClean(run('check-compose.mjs', fixture({
      'deploy/docker-compose.yml': MINIMAL_COMPOSE,
      'deploy/data-compose.yml': DATA_COMPOSE,
    })))
  })
})
```

Run: `pnpm exec vitest run --dir scripts` — Expected: **FAIL**（新增首条红：`deploy/data-compose.yml` 现在仍被判「多出来的 compose 文件」）。

- [ ] **Step 2: 改 check-compose.mjs（白名单 + 规则二遍历）**

```js
/** 被放行的 compose 文件（相对 rootDir）。P1 起为双白名单：主 compose（部署单元 A）+ 数据面
 *  compose（部署单元 B，issue #150；目标形态见 deploy/customer-onboarding.md §1）。 */
export const ALLOWED = ['deploy/docker-compose.yml', 'deploy/data-compose.yml']
/** 规则二判据 b 的受管服务**按文件**给：只对主 compose 生效——数据面服务整份可裁剪
 *  （customer-onboarding「服务裁剪」旋钮），不设受管名，否则裁剪即红。 */
const REQUIRED_PORT_SERVICES_BY_FILE = new Map([
  ['deploy/docker-compose.yml', ['postgres', 'server']],
])
```

`checkHostPortBindings` 改为遍历 `ALLOWED`（文件不存在仍跳过——拆缝是可选形态，`data-compose.yml` 缺席不是违规）；判据 b 的服务清单从 map 按**当前文件**取（`data-compose.yml` 取不到 ⇒ 不设受管名）；判据 a/c 对每份文件原样执行。头注的规则一说明同步改写（「只放行 deploy/docker-compose.yml」→「只放行白名单两份」）。

Run: `pnpm exec vitest run --dir scripts` — Expected: PASS（新旧用例全绿——含既有「真实仓必须干净」那条，此刻真仓还没有 data-compose.yml，缺席不违规）。

- [ ] **Step 3: 更新 docs/architecture.md（正典四点 + 三条显式接受）**

1. **§4.1 B7 行**：`全仓唯一 compose` → `全仓只两份 compose：deploy/docker-compose.yml（部署单元 A）+ deploy/data-compose.yml（部署单元 B，数据面，P1 起）`；后半句「所有 ports 必须 127.0.0.1: 起头」**不变且对两份都生效**。
2. **§1 拓扑**：§1.2 服务表**不动**（单元 A 仍是 postgres + server）；在 §1.2 末尾补一段「部署单元 B」：`deploy/data-compose.yml`（pg_duckdb ~~自建镜像~~**官方镜像**（2026-09-23 订正，见「本轮订正」A1）/ Metabase / metabase-db / duckle·dbt 一次性 runner），**独立 openship project、可选拆缝**（指针 `deploy/customer-onboarding.md` §0/§1），全内网、端口回环。
3. **§2 组件表**：加一行 `deploy/data-compose.yml + deploy/pg-duckdb`（数据面：~~自建 pg_duckdb 镜像~~ ⇒ **pgduckdb 官方镜像**（2026-09-23 订正，「本轮订正」A1；`deploy/pg-duckdb/` 标「未启用（备件）」）——**新组件**，spec §11.8 架构先行门点名要写进去的正是它）与一行 `dbt/ contracts/ duckle/`（数据工件：staging/语义声明/采集契约/管线，均非 Node workspace 包、在 B1/B9 扫描根外，由 `scripts/check-data-models.mjs` 守）。
4. **§5 扩展点**：加小节「数据面工件怎么演进」——改 dbt 模型/契约走 PR（口径单一定义纪律）；新增数据源 = contracts 契约 + duckle 管线 + dbt staging 三件套同 PR。
5. **显式接受三条**（spec 已知边界要求「显式接受或推翻，不能默默用」，落在单元 B 那段）：locked parameters 锁租户是官方点名「不推荐敏感数据」的用法——**接受**（隔离主力在数据层凭据/schema，locked param 是嵌入路径的执行点）；嵌入带水印、不能禁 CSV 导出——**接受**（导的是租户自己那份）。

- [ ] **Step 4: 全量验证 + 提交**

Run:
```bash
pnpm exec vitest run --dir scripts            # 既有守卫全量（check-compose 的 fixtures 与真仓两用例都在这）
pnpm typecheck && pnpm test
pnpm exec tsx scripts/check-compose.mjs        # 真仓此刻还没有 data-compose.yml ⇒ 仍 OK（缺席不违规）
pnpm exec tsx scripts/lint-architecture.mjs
```

```bash
git add docs/architecture.md scripts/check-compose.mjs scripts/lint-architecture.test.ts
git commit -m "build(data-stack): B7 双白名单——数据面 compose 放行 + 架构文档部署单元 B（架构先行）"
gh pr create --title "build(data-stack): B7 双白名单与架构文档数据面拓扑（P1 前置）" --body "Refs #150"
```

---

### Task 3: deploy/data-compose.yml（部署单元 B 编排）+ dbt runner 镜像

**Files:**
- Create: `deploy/data-compose.yml`
- Create: `deploy/dbt/Dockerfile`

**Interfaces:**
- Consumes: ~~T1 的镜像名（`ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5`）~~ ⇒ **2026-09-23 订正：pg_duckdb 用官方镜像 `pgduckdb/pgduckdb:18-v1.1.1`（Docker Hub），与 T1 无关**（「本轮订正」A1）；T5 的 `deploy/duckle/Dockerfile`（compose 引用其 build 路径——**两任务谁先后合并都行，W1g 前齐即可**）；`deploy/customer-onboarding.md` 阶段 5 的拆缝接线模型。
- Produces: 五个服务定义 + 三个卷 + 全回环端口。平台侧接线点 = 宿主 `127.0.0.1:15432`——**本计划选定的端口**（满足 customer-onboarding §4「拆缝两 project 同机端口必须错开」的约束；文档只记过 lab 实测端口 18080/18081/16379，**未记过 15432**——别把它引用成文档既有内容。最终接线形态由 T6 Step 6 回写进 customer-onboarding 阶段 5）。

- [ ] **Step 1: 写 data-compose.yml（T2 合并后才能提 PR——B7 放行面）**

```yaml
# deploy/data-compose.yml — 数据面部署单元 B（issue #150；spec 2026-09-20 §1/§11.1）。
# 全内网：不进 openship edge、不绑公网；所有 ports 一律回环（B7 规则二对两份 compose 都生效）。
# 拆缝用法（同仓同分支、独立 project）见 deploy/customer-onboarding.md §0/阶段 5。
# ⚠️ 顶层 name 必需——与主 compose 同一条理由（项目名/卷名撞车，docker-compose.yml 头注的实测事故）。
name: platform-core-data

services:
  # ── 湖上查询引擎 + 物化落点（2026-09-23 订正：**官方镜像**，非自建——官方镜像上游自陈配对
  #    = DuckDB v1.4.3；自建路径 `deploy/pg-duckdb/` 与 `.github/workflows/pg-duckdb-image.yml`
  #    保留为「未启用（备件）」，理由是 ossie 本轮出局 + 自选配对实测编译失败（8 处 API 断裂）──
  pg_duckdb:
    image: pgduckdb/pgduckdb:18-v1.1.1
    # 来源：Docker Hub（上游构建）。目标机 dockerd 已配 HTTPS Proxy，`docker pull` 实测可达 Docker Hub
    # ⇒ 无需 GHCR 凭据、无需本地构建（代理地址口径见公司基建速查，此处不写值）。
    # 备件路径（GHCR 拉取 / 目标机本地构建）见 deploy/pg-duckdb/README.md。
    environment:
      POSTGRES_USER: ${PGDUCK_USER:-platform}
      POSTGRES_PASSWORD: ${PGDUCK_PASSWORD:-platform}     # 真值走 project env（openship），不进 git
      POSTGRES_DB: ${PGDUCK_DB:-warehouse}
    # shared_preload_libraries 是 pg_duckdb 硬要求（spec §9.4 方案 2）
    command: ["postgres", "-c", "shared_preload_libraries=pg_duckdb"]
    volumes:
      - pgduckdata:/var/lib/postgresql/data
    ports:
      # 平台侧的接线点（DATA_WAREHOUSE_URL 指这里）。**别把它读成「谁都能连」**：回环 ⇒ 够得到的
      # 是**宿主进程**（宿主上的 edge、宿主上跑的 `docker compose run` job）。
      # **容器**消费方（单元 A 的 server）另说：容器里的 127.0.0.1 是自己的 netns，不是宿主回环；
      # 两份 compose 各一个 default 网络、无共享 external 网络/extra_hosts ⇒ **按现值不可达**。
      # 接线方式待 T6 裁决（计划 Task 6 Step 1 的 Gate-B）。
      - '127.0.0.1:15432:5432'
    mem_limit: ${PGDUCK_MEM_LIMIT:-2g}    # 每连接一个 DuckDB 实例（max_memory 默认 4096MB/连接，
                                          # spec §9.4）——连接数 × 内存必须显式收口，见 pg-duckdb/README §3
                                          # 实测语境：Compose v5.3.0 下解析进规范模型（2g → 2147483648）；
                                          # `mem_limit` 属**非 deploy 面**旧键，按 deploy-spec/swarm 模型
                                          # 解析的消费方可能不读 ⇒ 被静默忽略 = 本行唯一目的落空（spec §9.4）
    restart: unless-stopped

  # ── Metabase 应用库（spec §8：生产必须 Postgres，H2 官方 AVOID；不放 pg_duckdb 实例上：
  #    OLTP 应用库与 OLAP DuckDB 内存模型同池必打架）──
  metabase-db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${MBDB_USER:-metabase}
      POSTGRES_PASSWORD: ${MBDB_PASSWORD:-metabase}
      POSTGRES_DB: ${MBDB_DB:-metabase}
    volumes:
      - mbdata:/var/lib/postgresql/data
    healthcheck:
      # 与主 compose 同一条理由（deploy/docker-compose.yml:38-45 的 postgres healthcheck）：
      # 没有它 metabase 会在 PG 就绪前连库——空卷首启要跑 initdb，此窗口内不接受 TCP 连接，
      # Metabase 会 `Metabase Initialization FAILED` **退出**（不是自等），靠 restart 反复重启自愈。
      test: ['CMD-SHELL', 'pg_isready -U ${MBDB_USER:-metabase} -d ${MBDB_DB:-metabase}']
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
    restart: unless-stopped
    # 不映射 ports：只有同 compose 网络内的 metabase 够得到（服务名即主机名）

  # ── BI 渲染面（spec §11.2 #1；版本锁死 = PoC 实测版，禁 latest——§6.6 纪律）──
  metabase:
    image: metabase/metabase:v0.63.18.1
    environment:
      MB_DB_TYPE: postgres
      MB_DB_CONNECTION_URI: postgresql://${MBDB_USER:-metabase}:${MBDB_PASSWORD:-metabase}@metabase-db:5432/metabase
    depends_on:
      metabase-db:
        # service_healthy 而非 service_started（list 形态只等容器**被启动**）：Metabase 启动期
        # 连不上应用库即初始化失败退出——主 compose 对 postgres 是同形（deploy/docker-compose.yml:68-71）
        condition: service_healthy
    ports:
      # 回环；对外嵌入面怎么走（edge 反代 or 内网直连）是部署级决策，T6 定了记进 runbook
      - '127.0.0.1:13030:3000'
    restart: unless-stopped

  # ── duckle headless runner（T5 提供 Dockerfile；一次性执行，不常驻）──
  duckle:
    build: { context: .., dockerfile: deploy/duckle/Dockerfile }
    image: platform-core-duckle:local
    profiles: ["etl"]        # 平时 up 不起；docker compose --profile etl run duckle <args> 按需执行
    environment:
      # --token 是硬要求（spec §1：绑非回环且无凭据时 15 分钟内可被 claim 成管理员）——
      # 不用 :? 强制插值（会让没配 token 的部署连三服务的 up 都起不来）；真值在 etl 执行时给，
      # runner 入口对空 token 拒跑（T5 的 ENTRYPOINT 说明）。
      DUCKLE_TOKEN: ${DUCKLE_TOKEN:-}
    volumes:
      - duckle-workspace:/workspace
      - ../duckle:/pipelines:ro      # 相对路径锚在 compose 文件所在目录（deploy/）⇒ 一层 .. 即仓根
    # 无 ports：headless runner 不需要网络面

  # ── dbt runner（物化/测试执行器；调度=openship jobs 打 docker run，拍板 #4，零常驻）──
  dbt:
    build: { context: .., dockerfile: deploy/dbt/Dockerfile }
    image: platform-core-dbt:local
    profiles: ["etl"]
    environment:
      DBT_HOST: pg_duckdb          # compose 网络内走服务名（不是宿主视角的 127.0.0.1:15432）
      DBT_USER: ${PGDUCK_USER:-platform}
      DBT_PASSWORD: ${PGDUCK_PASSWORD:-platform}
      DBT_DBNAME: ${PGDUCK_DB:-warehouse}
      # ZOS/S3 凭据键见 dbt/profiles.example.yml——真值只在 project env（openship isSecret）
    volumes:
      - ../dbt:/usr/app:ro
    depends_on:
      - pg_duckdb
    # 无 ports

volumes:
  pgduckdata:        # 物化表/语义 schema（可从 parquet 重算，备份=省重建时间，spec §8）
  mbdata:            # Metabase 应用库（❌不可重建，必须备份——报表/集合/权限的真相所在）
  duckle-workspace:  # 管线定义的真源在仓内 duckle/；workspace 是中间产物（可重建）
```

> 卷的备份口径进 T6 的 runbook 步：openship 原生 producer（volume / pg-dump）打 `mbdata` 与 `pgduckdata`；**两个 project 的备份面互相独立**（spec §8 订正后的口径）。

- [ ] **Step 2: 写 deploy/dbt/Dockerfile（版本 ARG 钉死）**

```dockerfile
# deploy/dbt/Dockerfile — dbt runner（postgres adapter 打 pg_duckdb 端点）。
# ⚠️ DBT_VERSION 默认值待确认：layered §11 只有内存资源画像、未记 dbt 版本号——
# 待实测人确认（开工前置外部输入⑥：人给版本号，或确认默认 1.9.8），
# 拍板时以现场实际安装为准，确认后改掉本行注释。
FROM python:3.12-slim
ARG DBT_VERSION=1.9.8
RUN pip install --no-cache-dir "dbt-core==${DBT_VERSION}" "dbt-postgres==${DBT_VERSION}"
WORKDIR /usr/app
ENTRYPOINT ["dbt"]
```

- [ ] **Step 3: 验证 + 提交**

Run:
```bash
pnpm exec tsx scripts/check-compose.mjs        # T2 已合：data-compose 全回环 ⇒ OK；改出非回环会当场红
docker compose -f deploy/data-compose.yml config --quiet   # 本地语法面（不需要镜像在场）。若因 T5 的
                                                            # build 上下文文件（deploy/duckle/Dockerfile）
                                                            # 未合并而报错：跳过本步并在任务报告注明，
                                                            # 留 T5 合并后复验——别为过本步预写 T5 的文件
pnpm typecheck && pnpm test
```

```bash
git add deploy/data-compose.yml deploy/dbt/Dockerfile
git commit -m "build(data-stack): 数据面 compose（部署单元 B）——pg_duckdb/Metabase/duckle/dbt 全回环"
gh pr create --title "build(data-stack): deploy/data-compose.yml + dbt runner 镜像（P1）" --body "Refs #150"
```

> 真正的 `up` 不在本任务——那是 W1g（T6）的真机步。本任务的验收面 = B7 绿 + compose 语法绿 + 评审。

---

### Task 4: dbt 项目（乐檬 staging/marts + 语义声明 L1 + 对账 singular tests + 静态门禁）

**骨架的含义（诚实边界，同 M2b T2 范式）**：本任务交付**完整可解析的 dbt 项目** + 按 layered §9 五条实测坑编写的 cast 模式与测试结构 + **静态机检门禁**。staging 的**逐列清单**以 ZOS 实测样本为准——乐檬 46/43 列漂移（坑 #2）意味着「列清单照猜写」必然错，故 staging 模型给出模式与两三列实证样例（金额 `"12.79"`、时间两格式），列全集在 T6 真机首跑时按样本钉死并回填（T6 有对应核对步）。**这不是占位符——是无样本阶段可交付的最大真值 + 显式 gate。**

**Files:**（见派发表 T4 行）

**Interfaces:**
- Consumes: layered §3/§4（staging 一对一、marts 口径单一定义、标准路径十步）、§7 硬约束（含 1 的收窄注记）、§9 五坑、§11 资源画像；拍板 #1（staging 定型、存量不重落盘）与 #2（dbt YAML 事实源）。
- Produces: dbt 项目（`dbt parse` 可过）；`scripts/check-data-models.mjs`（导出 `checkDataModels(dir): Violation[]`，fixtures 可测）；ci.yml gates 加一行。

- [ ] **Step 1: 项目骨架 + profiles 模板**

`dbt/dbt_project.yml`（model-paths/models 配置，`common` 与 `customers` 两层目录，materialization 缺省 table——按需物化纪律靠 `--select`，不是全量禁物化）；`dbt/profiles.example.yml`（键：`DBT_HOST/DBT_USER/DBT_PASSWORD/DBT_DBNAME` + ZOS 五键经 `env_var` 注入，**真值永不进 git**）；`.env.example` 末尾追加文档化键段（同 WUJI 模式：B9 不扫 dbt，但键面事实源要齐）。

- [ ] **Step 2: staging 模型（手写 cast 的模式范文——列全集 gate 到 T6）**

`dbt/models/common/staging/stg_lemeng_retail_detail.sql` 骨架（**模式**是交付物，列清单是 gate）：

```sql
-- stg_lemeng_retail_detail.sql — 乐檬零售明细 staging（layered §3：一对一、只规范化不改义）。
-- 拍板 #1：存量 parquet 列全是 VARCHAR（坑 #1）不重落盘，cast 全部在本层手写，
-- 正确性由 dbt tests + 对账 singular tests 兜（「cast 错了不报错，只有断言能抓」）。
-- 坑 #5：读 parquet 必须 r['列名'] + 别名 r——SELECT * 能过、点名取列报 column does not exist，
--   SELECT * 的成功会掩盖它，写新 staging 的人必然踩（layered §9 原话）。
-- 坑 #4：DOUBLE 不是 pg_duckdb 可用的 cast 目标（type "double" is only a shell）——用 numeric/float。
-- 坑 #3：两个时间列两种格式（'2026-07-01 10:02:34' vs '20260707'）——两种形态都要 try。
-- ⚠️ 列全集【暂定】：以 ZOS 实测样本为准（46/43 列漂移，坑 #2），T6 首跑时按样本钉死回填；
--   漂移列（supplier_* 时有时无）的处置策略写进 dbt/README（显式分组/缺失列策略），禁 union_by_name 兜。
with r as (
    -- pg_duckdb 把 read_parquet 委托给 DuckDB 执行（裸扫描结果不是 PG 关系——§9.4 可见性坑，
    -- 所以它只出现在 staging 模型内部，物化落点见 Step 3 的 gate 2）
    select * from read_parquet('{{ var("lemeng_retail_path") }}/**/*.parquet')
)
select
    -- 金额：字符串 → numeric（示例列，列名按样本核对）
    r['amount']::numeric        as amount,
    -- 时间两格式：两种形态都 try 后合并（坑 #3；写法以压测实测口径为准）
    coalesce(
        try_strptime(r['order_time'], '%Y-%m-%d %H:%M:%S'),
        try_strptime(r['bizday'], '%Y%m%d')
    )::timestamptz              as order_time,
    -- 分区列（账套）：存量路径是 3120/ 而非 system_book=3120/（handbook §4 欠账「路径非 hive 分区」）——
    -- 分区值以路径解析进列（C3 身份跟着数据走），具体形态 T6 按实测路径定
    '{{ var("account_book") }}' as system_book
    -- …列全集按样本补齐，每列注明来源列名…
from r
```

> ⚠️ 若目标列在 parquet 里本就缺失则整列不可选（坑 #2 的显式处理面）。**本块的 SQL 形态以 2026-09-21 压测实测口径为准**（read_parquet 的调用面/S3 凭据注入/物化落点三处 gate 见 Step 3 注），实施 worker 先检索 WeKnora《duckdb-ossie 全链路 PoC》条目再动笔，别按本范文二次发明。

- [ ] **Step 3: 两处「以实测口径为准」的设计 gate（写进 dbt/README.md 的核对清单）**

1. **S3 凭据注入**：DuckDB 实例**按连接**存在（spec §11.5 #1）⇒ secret/`SET duckdb.s3_*` 必须在**每条连接**内生效——dbt 多线程多连接，注入方式（on-run-start / 模型 pre-hook / credential_chain secret / read_parquet 的连接串参数）以压测实测口径为准，核对后把结论落进 README 与 profiles 模板。
2. **物化落点必须是 PG 可见关系**（spec §9.4 可见性坑）：`duckdb.raw_query` 造出来的 DuckDB 侧对象**不进 pg_class** ⇒ Metabase 看不见。staging/marts 的 materialization 必须落在 PG 可见面（表/视图/`USING duckdb` 外表——以实测形态为准）。这条是「Metabase 看得见数据」的硬前提。

- [ ] **Step 4: marts + schema.yml（语义声明 = L1 事实源）+ dbt tests + 对账 singular tests**

- `marts/`：至少一个口径模型（如 `fct_retail_sale`，粒度显式）——**口径只在这里定义一次**（layered 纪律）。
- `schema.yml`：模型列描述 + tests（`not_null`/`unique`/`accepted_values`/金额范围——layered §4 步骤4）；**语义声明**（L1）：每个指标带 `name`（**命名空间 `<域>:<指标名>` 前缀**，layered §6）、表达式、粒度、`owner`、`tier`、`definition`——owner/tier/grain 是治理门禁的必填面（spec §10 机制 1 的 dbt 原生对应物）。
- `dbt/tests/audit_<指标>.sql`：**每个声明的指标一条对账 singular test**（独立复算 vs 物化结果逐位比对；spec §10 机制 4「同名唯一 + 每个指标一条对账查询」——硬要求 7「对账是硬要求：cast 错了静默，只有它能抓」）。**文件名映射唯一规则（T4 在此定义，T9 机检消费同一条——两个 worker 不得各造一套）**：指标命名空间 `<域>:<指标名>` 含冒号、不能进文件名 ⇒ `:` 替换为 `__`，例 `aftersales:refund_ratio` → `dbt/tests/audit_aftersales__refund_ratio.sql`。命名约定 `audit_*` 与指标名一一对应，机检在 Step 5 锁。

- [ ] **Step 5: 静态门禁 check-data-models.mjs（先红后绿）+ CI 接线**

新建 `scripts/check-data-models.test.ts`（fixtures：合规 dbt 目录 → 干净；缺 owner 的声明 → 违规；staging 用 `::double` → 违规；staging 无 `r['` 模式 → 违规；同名指标两处 → 违规；声明了指标但无 `audit_*.sql` → 违规）。`check-data-models.mjs` 检查项（静态、无库）：
① `staging/stg_*.sql` 必含 `r['` 取列模式（坑 #5 的结构性防御）；② 禁 `::double`（坑 #4）；③ 禁 `union_by_name`（硬约束 2：漂移必须显式处理）；④ staging 一对一（staging 模型 ↔ sources.yml 源一一对应）；⑤ 语义声明必填字段（owner/tier/grain/definition）齐全；⑥ 指标命名空间前缀 + **同名唯一**；⑦ 每个声明指标有对应 `dbt/tests/audit_<指标>.sql`（文件名按 Step 4 定义的 `:` → `__` 映射规则生成，T9 扩面时消费同一条规则，别另造）。
> scripts/ 是 checkJs——JSDoc 字面量类型会加宽（团队记忆），检查器用「单形状、字段恒在」写法，`pnpm typecheck` 才拦得住。

ci.yml 的 gates job 在 check-env-example 之后加一行 `- run: pnpm exec tsx scripts/check-data-models.mjs`。

- [ ] **Step 6: 验证 + 提交**

Run:
```bash
pnpm exec vitest run --dir scripts check-data-models
pnpm exec tsx scripts/check-data-models.mjs     # 真仓自检（本任务自己的 dbt/ 必须干净）
cd dbt && dbt parse && cd ..                     # 有 dbt 的机器上验证项目可解析（不需要库）
pnpm typecheck && pnpm test
pnpm exec tsx scripts/check-compose.mjs
```

```bash
git add dbt scripts/check-data-models.mjs scripts/check-data-models.test.ts .github/workflows/ci.yml .env.example
git commit -m "build(data-stack): dbt 项目——乐檬 staging/marts + L1 语义声明 + 对账 tests + 静态门禁"
gh pr create --title "build(data-stack): dbt 项目与数据工件静态门禁（P1）" --body "Refs #150"
```

---

### Task 5: contracts/（采集契约）+ duckle/（管线骨架）+ duckle runner 镜像

**Files:**（见派发表 T5 行）

**Interfaces:**
- Consumes: layered §4 步骤 1（契约 = 摸清源字段/类型后的 schema 声明）、硬约束 1 的**收窄口径**（拍板 #1：新数据源接入**尽量**在落盘侧做对——契约的适用面是**新源**；存量乐檬不重落盘、不由本任务追溯）；spec §1 的 duckle 打包事实（官方镜像只有 web 编辑器；headless = 二进制 + SHA256SUMS；`--token` 硬要求）。
- Produces: 契约目录约定与机检格式（JSON Schema）；duckle 管线骨架目录；`deploy/duckle/Dockerfile`。

- [ ] **Step 1: contracts/ 契约形态**

`contracts/README.md` + `contracts/common/_schema.schema.json`（契约本身的 JSON Schema：表名、字段名/类型/可空、分区键、批次标记、owner）。每个新数据源一份 `contracts/common/<源>.<表>.json` 或 `contracts/customers/<客户>/…`。**契约是「落盘即定型」的机器面**：duckle 管线落盘前按契约校验（类型不符即失败，不静默降级成 VARCHAR 重演坑 #1）。抖音（handbook §2「待接入」）是第一个适用对象——契约**模板**先行，实际抖音契约随接入 PR。

- [ ] **Step 2: duckle/ 管线骨架 + ZOS 直写的显式 gate**

`duckle/README.md` 开头必须先写这条已知事实：**duckle→天翼 ZOS 的 sink 能力以经验库 2026-09-17 订正后的口径为准 —— `snk.minio` 可直写（真机实测，转述准确、未夸大），`snk.parquet` 403、`snk.s3` 404 仍不通；「反复 403、判定能力空白」是已被取代的旧口径**（第十轮 B 节；同句尚在 spec §8，spec 是历史快照、**不追改**）——动手前先检索 WeKnora 核对现状；`duckle/common/` 与 `duckle/customers/` 目录约定（与 contracts/dbt 的 common/customers 三件套同构：一个新源 = 契约 + 管线 + staging 三个文件同 PR）。管线文件本体是**目录与命名约定 + README**，不放编造的 DSL 范文（duckle 管线格式以官方文档/实测为准，别按想象写）。`.gitignore` 加本地产物目录忽略：`duckle/**/_ops/`（若实测的 _ops 形态不同，以实测为准写正确 glob）。**模式内不得内嵌空格**——`duckle/**/ _ops/` 这种写法只会匹配「目录名以空格开头」的 `_ops`，照抄即空转；要忽略多种形态就写成多条独立模式、每条一行，别在一条模式里用空格拼。

- [ ] **Step 3: deploy/duckle/Dockerfile（headless runner 容器化）**　[**已交付** → `deploy/duckle/Dockerfile`]

> ⚠️ **2026-09-23 订正：原范文代码块已删除——它与交付物有四处实质差异，其中两处正是旧口径。**
>
> 被删掉的范文写的是：`ARG DUCKDB_VERSION=1.5.5`（理由是「与 pg_duckdb 内核对齐」）+
> `curl`/`unzip` 单独下载 DuckDB CLI + 内联 `ENTRYPOINT`。**三处都不成立**：
> ① **`DUCKDB_VERSION=1.5.5` 作废**——「与 pg_duckdb 内核对齐」**随本轮改用官方镜像 + ossie 出局
> 彻底失去对象**；且实测 `duckle==0.7.3` 在自己的元数据里**硬钉** `duckdb-cli==1.5.4`
> （手钉 1.5.5 是 `ResolutionImpossible`，见 `deploy/duckle/README.md` §3）；
> ② **不需要单独下载 DuckDB CLI**——`pip install duckle` 一步就把引擎装好了（实测）；
> ③ **ENTRYPOINT 不是内联 `--token` 透传**——`--token` 只属 `serve`/`web`，环境变量名是
> `DUCKLE_CONSOLE_TOKEN`，安全闸改由 `entrypoint.sh` 做。
>
> **正典是仓内文件**（四处的逐条依据写在 `deploy/duckle/Dockerfile` 文件头 §①–④ 与
> `deploy/duckle/README.md` §2.1/§3）。**保留旧范文 = 后来者照抄即复发**（本仓已知复发坑）。

> ⚠️ duckle 的 CLI 子命令形态与版本号曾是**首次构建核对点**——spec 只记了分发形态没记 CLI 面。
> **交付物已按实测核过**：PyPI 路径装出 `duckle` 与 `duckle-mcp` 两个 console script，
> `duckle` 是 `os.execve` 掉包内 `duckle-runner` 的**垫片**（⇒ 与 release 版同一程序、同一套参数）；
> CLI 面速查见 `deploy/duckle/README.md` §7。本任务不跑真管线——duckle→ZOS 直写按「未验证」对待，
> 验证归 W1g（T6 有核对步：能直写则记结论；不能则记「经 dbt/中转落盘」的替代路径结论，**不静默绕过**）。

- [ ] **Step 4: 验证 + 提交**

Run:
```bash
docker build --check -f deploy/duckle/Dockerfile .                 # 语法面（需较新 docker；没有则留待首次真构建）
pnpm exec tsx scripts/check-compose.mjs                            # duckle 服务引用本 Dockerfile，B7 不受影响
pnpm exec tsx scripts/check-data-models.mjs                        # 若 T4 已合，确认本任务没碰它的面
pnpm typecheck && pnpm test
```

```bash
git add contracts duckle deploy/duckle .gitignore
git commit -m "build(data-stack): 采集契约目录 + duckle 管线骨架与 runner 镜像（新源落盘即定型）"
gh pr create --title "build(data-stack): contracts/ 与 duckle/ 数据采集工件（P1）" --body "Refs #150"
```

---

# W1g（P1）— 真机部署闭环（gate：外部输入①②③④ + W1 全合并）

### Task 6: 数据面真机部署 + 全链路闭环 + 摘标注 + 物化 job 注册

**执行者是「拿着 openship 权限的操作者」（人或被授权的 agent），遵循唯一通道法则。** 对标 M2b T5 的形态；部署模型照 `deploy/customer-onboarding.md`（阶段 2 建 project / 阶段 5 拆缝 / 阶段 6 数据初始化 / 阶段 7 验收）。

- [ ] **Step 1: GATE——四项前置全绿才许动**

1. ~~**外部输入①**：pg_duckdb 镜像可获取（GHCR 凭据或目标机本地构建路径二选一）；首次构建已跑通（T1 的 CI dispatch 或目标机构建），tag 与 compose 一致。~~ ⇒ **2026-09-23 订正：本条前置已消解** —— 用**官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`（Docker Hub，**实测可拉**）；**不再需要** GHCR 凭据 / 本地构建 / 首次构建跑通。⚠️「tag 与 compose 一致」**只对备件路径成立**——现状 compose 用官方镜像、与备件 tag **不一致**，**这是预期形态**（见 `.github/workflows/pg-duckdb-image.yml` 头注）。
2. **外部输入②**（**2026-09-23 订正：已全部就位，且不卡本步**）：① dp-lab / dp-lab-bi **已删**（人在 dashboard；MCP 无删项目接口），**含宿主侧清理**——两者在 server `23a1091e`（mytech-weknora），**与 T6 目标机 `8281d598` 是不同宿主**、无端口/卷/网络共享 ⇒ 属**清场项而非 gate**；② **目标机已定**：`113.249.104.181` = `10.0.0.5` = server **`8281d598`**（shanghai）。
3. **外部输入③**：ZOS 乐檬桶只读凭据已落 openship env(isSecret)。⇒ **已就位并实测（2026-09-23）**：真机用它建 DuckDB secret 后 ZOS 认证通过（形态见下方销账块第 1 条）。
4. **外部输入④**：目标机时段已确认。W1 的 T2–T5 全部合并进 main。⇒ **已消费（2026-09-23）**：T6 部署已实际执行（时段已用掉）；T2–T5 均已在 main。
5. **外部输入⑥**：dbt 版本已确认（人给版本号或确认 1.9.8），T3 Dockerfile 的 ARG 注释销账——真跑用的版本必须与现场安装一致。⇒ **已销账（2026-09-23，本 PR ②）**：PyPI 实测钉 **1.9.1**——dbt-core 1.9.x 发到 1.9.9 而 **dbt-postgres 1.9.x 只发到 1.9.1**，1.9.8 配对不存在（构建必挂 `No matching distribution found for dbt-postgres==1.9.8`）；Dockerfile ARG 默认值已改 1.9.1，真机构建 + parse + debug 均已验证。
6. ~~**版本配对已验收（T1 的显式前置，不是「顺带」）**：pg_duckdb v1.1.1 × DuckDB v1.5.5 是未经任何一方验证的配对 ⇒ T1 的首次 dispatch 兼作该配对的验收：编译通过 = 配对成立；失败则把 `PG_DUCKDB_VERSION` ARG 回退 `main` …~~ ⇒ **2026-09-23 订正：本条前置已消解，且原因与原文预期相反** —— 该配对**已经验收过了，结果是失败**（`pg_duckdb v1.1.1 × DuckDB v1.5.5` **实测编译失败**，8 处 API 断裂，见 `deploy/pg-duckdb/README.md` §2.2）⇒ 本轮改用**官方镜像**（上游自陈配对 = DuckDB v1.4.3，**不需要**本仓再做配对验收）。**进本 gate 不再要求「配对已绿」**。将来若启用备件，才回到「**重新核对上游自陈配对 + 重新实测 + 出「新」tag**」的口径（**不是**原文的「ARG 回退 `main`」）。
7. **Gate-B（I-2 的接线裁决；必须在 Step 4 之前落地）——✅ 已裁决（2026-09-23，用户拍）**

   **缺口回述（原文保留以留可追溯性）**：`DATA_WAREHOUSE_URL` 钉的 `127.0.0.1:15432` 是**宿主回环**，而消费方是单元 A 的 `server` **容器**（`modules/data/domain/warehouse.ts:13` 在请求期读 env；`deploy/data-compose.yml:21` 该注释已按此订正）——容器里的 `127.0.0.1` 是自己的 netns，不是宿主回环；两份 compose 各一个 `default` 网络、无共享 external 网络、无 `extra_hosts`（T3 评审 §2.3 实测）⇒ **按现值 `ECONNREFUSED`**。判定一条命令：进单元 A 的 `server` 容器内跑 `nc -zv 127.0.0.1 15432`——**预期 refused**，refused 即坐实本缺口。

   **裁决（2026-09-23，用户拍）：共享 external network**，实现取**更省的做法**——**单元 B（`deploy/data-compose.yml`）加入单元 A 的既有网络** ⇒ **单元 A 的 compose 一行不改**（尊重本计划「单元 A 不动」的约束）。

   - **目标机实测的网络名**（协调方经 openship MCP 在 `10.0.0.5` 上实测）：**`openship-platform-core-shanhai`**（bridge）；**单元 A 的 `server` 与 `postgres` 都挂在该网络上**。
   - **实现形态**：`deploy/data-compose.yml` 的服务声明**两个**网络——自己的 `default` + 该 external（`external: true`，`name: openship-platform-core-shanhai`）；`pg_duckdb` 在其上以**服务名**可达。
   - **`DATA_WAREHOUSE_URL` 改服务名形态**（**不再用** `127.0.0.1:15432`）：`postgres://…@pg_duckdb:5432/warehouse`。

   **三条边界（一并写明，别漏）**：

   - ㈠ 该网络归 `platform-core-shanhai` 这个 project 所有 ⇒ 这是**跨 project 依赖**：该项目被删/重建时网络可能被重建（**同名则无碍**）。
   - ㈡ 单元 A 的网络里将出现数据面容器（**同信任域**），而**宿主端口仍全回环、B7 不破**。
   - ㈢ ~~原候选① `extra_hosts: host.docker.internal:host-gateway`（单元 A）~~ ⇒ **已排除，附原因**：**在回环绑定下不成立**——容器连宿主 bridge IP 时那里**没有监听**。**别再把它捡回来。**

   ⇒ 接线结果回写 `deploy/customer-onboarding.md` 阶段 5（Step 6 第 2 条）。**未接线即进 Step 4 = 该步「问数链路吃真数据」的验收句必然失败**（症状在连接层、不是配置报错）。
8. **Gate-C（T5 评审 M3；跑任何 duckle 命令前先读）**：引擎的 `--workspace <dir>` **默认值是「管线文件的父目录」**（v0.7.3 二进制 USAGE 原文：`Workspace root (default: pipeline file's parent)`），而 compose 把管线目录以 `../duckle:/pipelines:ro` **只读**挂载 ⇒ **只给 `--pipeline /pipelines/x.json` 而不给 `--workspace`** 时，引擎要把 `.duckle/`、`logs/`、`runs/` 写到只读挂载上 ⇒ **运行期写失败**（症状不在启动、也不在解析，是跑到写盘才炸）。⇒ **本波所有 duckle 作业（含 Step 5 的核对步、以及将来的 job）必须显式传 `--workspace /workspace`**。Step 5 的核对步另需按评审给的反向验法**故意不给** `--workspace` 跑一次、确认它确实报写失败（坐实这条警示不是空话），并把「漏写会撞只读挂载」这句补进 `deploy/duckle/README.md` §5（该文件的示例**已**显式带 `--workspace`，缺的只是这句警示）。依据：T5 评审 §4 的 M3（评审明标这条实施者无法自验）。
9. **Gate-D（T5 评审 I2 的口径防呆；读 spec §8 或本计划旧行之前先读本条）**：**ZOS 直写的现行口径一律以本计划为准** —— `snk.minio` **可直写** ZOS（经验库条目自带 2026-09-17 订正 + 真机实测：`validate` 过、`run` 两次 ok、两条独立通道回读、重跑幂等），`snk.parquet` **403**（抓包证实 dial 的是 AWS 默认端点）、`snk.s3` **404**。**spec 的两处同句已被取代，且按本仓纪律不追改**（`docs/superpowers/specs/2026-09-20-data-stack-module-design.md:526–527`、`docs/superpowers/specs/2026-09-15-aftersales-module-design.md:166` —— spec 是「当时怎么定的」历史快照）⇒ **T6 读 spec §8 的 ZOS 结论时一律以本计划为准**，**不得据 spec 恢复「能力空白」结论**。依据：T5 评审 §5.1–5.4 / I2（第十轮 B 节）。
10. **Gate-E（跨组件 parquet 格式兼容；官方镜像切换引入的新面）**：**duckle 自带 DuckDB `1.5.4`**（写 parquet 的一方；`duckle==0.7.3` ⇒ `duckdb-cli==1.5.4`），而 **pg_duckdb（官方镜像）是 `1.4.3`** ⇒ **写方比读方新**。本步真机**必验一条**：**用 duckle 写一个 parquet ⇒ 让 pg_duckdb `read_parquet` 读**（读得出、列类型符合预期）。同一条已记进 `duckle/README.md` §7.4 未验清单第 5 项。
11. **#182 门：模块 `storage` 能力「未声明」⇒ 数据面拿不到凭据**：`modules/data/manifest.yaml` **当前无 `storage:` 声明**（2026-09-23 实测：`grep -n storage modules/data/manifest.yaml` 无命中；对照 `modules/aftersales/manifest.yaml:14` 的 `storage: { kind: s3 }`）⇒ 宿主「不声明就不挂」（`apps/server/src/loader.ts:483-491`）⇒ `c.get(TENANT_STORAGE)` **恒 `undefined`**、租户管理台「**存储配置**」页**不可达**（`storageDeclarers ∩ 启用模块 ≠ ∅` 才显示）⇒ **没有任何 UI 入口能把本租户 ZOS 五元组写进租户行** ⇒ **T6 的数据面拿不到凭据**（Task 11 的 `provision-template.sql` USER MAPPING secret + Task 4 的 dbt S3 注入都源自这份凭据）。**修复笔已派（见 issue #182）**——本步开工前先确认该笔已合并、`storage: { kind: s3 }` 已在 manifest 里（**未落地则本步先等它**）。⚠️ 该声明**目前尚无消费点**（数据面读 ZOS 发生在 pg_duckdb 内部；模块只与 pg_duckdb 对话）⇒ 「**声明了能力但未消费**」这条**显式登记**，别被下一个人读成「已经接好了」（issue #182 的「已知的后续」节同此）。

   **T6 实测销账（2026-09-23，shanhai / `10.0.0.5` 真机；由 T6 收尾 PR 回填进计划）**——部署期现场逐条结论：

   - **pg_duckdb 建密钥（「S3 凭据注入」gate 的真机形态）**：`duckdb.create_simple_secret(...)` 签名实测为 `(type, key_id, secret, session_token, region, url_style, provider, endpoint, scope, validation, use_ssl)`、**全 text**；ZOS 内网端点**去 `https://` 前缀 + `use_ssl=false`** 认证通过。
   - **桶内 glob**：pg_duckdb 侧**不暴露** `glob()`，但 `duckdb.query()` 内**可用**（列取值用 `SELECT *` 包一层）。
   - **dbt parse**：通过（EXIT=0）——且真机 parse 顺带抓出两个模型的 Jinja 注释编译错（config 块内混 SQL 注释行），已随 T6 收尾 PR 修复。
   - **dbt debug**：Connection test **OK**。
   - **数据面容器 / 端口 / Gate-B 接线 / 平台重部署**：全部完成（过程与证据见编排侧 ledger 的 T6 节——`.superpowers/sdd/` 未进仓，需要时找编排者要，别按本节转述二次脑补）。
   - **数据本身为空（采集未开始）** ⇒ Step 3 物化/对账、Step 4「问数链路吃真数据」、Step 5 duckle 核对（Gate-C/D/E）**全部待数据到位后执行**——T6 未完，本销账只覆盖「部署 + 连通」面。

- [ ] **Step 2: 按目标形态建数据面 project（openship MCP）**

照 customer-onboarding 阶段 2（folder-upload 五步）或 git 绑定建 `platform-core-data`（或首个客户命名 `platform-core-<客户>-data`），composePath = `deploy/data-compose.yml`，serverId = 目标机；project env 物化 ZOS 五键 + `PGDUCK_PASSWORD` + `DUCKLE_TOKEN`（isSecret）。`up` 前三服务（pg_duckdb / metabase-db / metabase）——etl profile 的 duckle/dbt **不随 up 起**（零常驻，拍板 #4）。

- [ ] **Step 3: dbt 首跑（staging 列全集在这一步钉死回填）**

`docker compose -f deploy/data-compose.yml --profile etl run --rm dbt build --select path:models/common`（或 openship job 一次性触发）。首跑前把乐檬样本列清单与 T4 的暂定列对齐（`read_parquet` 的 `describe`/样本查询），漂移列（supplier_*）按 README 策略显式分组处理；**回填进 stg 模型走 PR**（列全集是代码，不是部署差异）。Expected: `dbt build` 绿（含 tests + 对账 singular tests——对账查询在**真数据**上通过，这正是治理机制 4 的落地形态）。

- [ ] **Step 4: Metabase 面板 + 平台接线 + 新行为验证（deploy-verify）**

- Metabase：建 pg_duckdb 连接（同 compose 网络走服务名 `pg_duckdb:5432`；连接用户用超级用户——pg_duckdb 的扩展/委托需要）→ sync → 在 marts 上建第一个 question/dashboard。**确定嵌入面暴露通道**（edge 反代域名 or 客户内网直连），结论记进 `deploy/customer-onboarding.md` 对应节（这是 spec「只经嵌入面出去」的落地决策，不绑公网）。
- 平台 project env 加 **`DATA_WAREHOUSE_URL=postgres://…@pg_duckdb:5432/warehouse`**（**服务名形态**——Gate-B 已于 2026-09-23 裁决，见 Step 1 第 7 项；~~原值 `127.0.0.1:15432` 是宿主回环、对容器消费方不可达~~）→ 重新部署平台 → **问数链路吃真数据**（#146 的 `POST /api/modules/data/query` 打真 marts——这是「新行为在线上可观测」的验法，比容器时间戳更硬）。
  - **订正注记（第九轮 I-2；评审 §6）**：上行 `127.0.0.1:15432` **只对宿主进程成立**；消费方是单元 A 的 `server` **容器**，容器内的 `127.0.0.1` 是自己的 netns ⇒ **按现值不可达（`ECONNREFUSED`）**，而症状在连接层、不是配置报错（「部署后验」类假绿高发区）。接线方式未定（Step 1 的 Gate-B，需人裁决）⇒ **本条的验收句在裁决落地前不可达**。原文保留以留可追溯性。**⇒ 2026-09-23 已裁决**（共享 external network `openship-platform-core-shanhai`；`DATA_WAREHOUSE_URL` 取**服务名形态** `…@pg_duckdb:5432/warehouse`——见 Step 1 第 7 项）⇒ **本条的缺口已闭合，按新值执行**。
- 容器时间戳照 deploy-verify 双验（创建 > 镜像构建）。

- [ ] **Step 5: 注册物化 job（拍板 #4）+ duckle→ZOS 结论落档**

经 openship MCP 建 job（cron 低频起步，如每日一次；command = `docker compose -f … --profile etl run --rm dbt build --select <被消费的组合>`——**按需物化**，不是全量）。duckle 核对步：跑一次最小管线，**验证 `snk.minio` 直写在本部署面是否成立**（经验库 2026-09-17 真机实测为「可直写」，但那是**经验库所在部署面**的复现、不是本仓的 ⇒ 本仓复现归本步；**别按「是否仍 403」的旧稿预设结论**）；结论（成立 + 实际参数 / 不成立 + 替代路径）记进 `duckle/README.md` 与 WeKnora（命中既有条目则**更新不新建**）。**动手前先读 Task 6 Step 1 的 Gate-D（口径防呆）与 Gate-C（`--workspace` 必显式传，否则写只读挂载）**。

- [ ] **Step 6: 摘「尚未进仓」标注 + handbook 补齐（docs PR）**

- `deploy/customer-onboarding.md`：摘掉六处「尚未进仓」标注（:33 / :51 / :91 / :157 / :172 / :199——行号以 grep「尚未进仓」实测为准）。
- `deploy/customer-onboarding.md` 阶段 5：**回写最终接线形态**——**⇒ 2026-09-23 订正（Gate-B 已裁决）：最终形态 = 「单元 B 加入单元 A 的既有 external network `openship-platform-core-shanhai`」+ `DATA_WAREHOUSE_URL=…@pg_duckdb:5432/warehouse`（服务名形态）**；下面原文的 `127.0.0.1:15432` **不再作为最终接线口径**（原文保留以留可追溯性）。原文：平台侧 env 加 `DATA_WAREHOUSE_URL=…@127.0.0.1:15432/warehouse`（15432 是**本计划选定**的端口，文档原本只记过 lab 端口 18080/18081/16379，此前未记过 15432），并写明「仅同宿主可达」的前提（回环端口在 productionMode=host 下由宿主进程可达；对照主 compose 头注的容器服务名口径时别误读为矛盾——那是 compose 网络内视图，两者说的是不同层的可达性）。
  - **订正注记（第九轮 I-2；评审 §6）**：上句「仅同宿主可达」的论证只覆盖**宿主进程**（宿主上的 edge / 宿主上 `docker compose run` 的 job）——**不覆盖容器消费方**（单元 A 的 `server` 容器）。`deploy/customer-onboarding.md:239-245` 的实测依据也正是「宿主 curl 200」，即**宿主视角**，所以容器侧缺口一直没暴露。回写 runbook 时**必须一并写明「容器消费方尚未接线（Step 1 的 Gate-B，待裁决）」**，别把这句写成结论性的接线口径。**⇒ 2026-09-23 订正（Gate-B 已裁决）**：回写时**直接写最终形态**（单元 B 加入单元 A 既有 external network `openship-platform-core-shanhai` + 服务名 `pg_duckdb:5432`）——**不再写「尚未接线 / 待裁决」**；「仅同宿主可达」的旧论证随之**下线**（容器消费方的可达性改由**跨 compose 共享网络内的服务名**承接）。
- `docs/data-platform-handbook.md` §3 落地位置四个 `<待补>` 补齐（duckle 管线→`duckle/`；dbt 项目→`dbt/`；语义声明→`dbt/models/**/schema.yml`；采集契约→`contracts/`）；§5 验收记录加一行（验收范围=本任务全链路，卡点→案例号）。

```bash
git add deploy/customer-onboarding.md docs/data-platform-handbook.md dbt
git commit -m "docs(data-stack): 摘「尚未进仓」标注 + handbook 落地位置补齐（P1 闭环实测）"
gh pr create --title "docs(data-stack): 数据栈工件落仓标注收口（P1 闭环）" --body "Refs #150"
```

---

# W2（P2）— 治理与配置面（严格串行：T7 → T8 → T9）

### Task 7: Metabase 报表 facade + 报表登记 + console 看板页

**为什么串行第一**：本任务与 T8 都改 `manifest.yaml` + `index.ts`（装载期双向核对，差一个方向就是起不来）——并行必然冲突（问数计划 W3 的既定教训）。

**Files:**（见派发表 T7 行）

**Interfaces:**
- Consumes: spec §4（M2 facade 形态：**facade 不持 Metabase 凭据是禁令的反面——凭据只在模块服务端 env**；幂等要自实现：API 无按名 upsert，`GET /api/search` → 有则 `PUT` 无则 `POST`）、§6.5（`embedding_params` 纯 API 可配；对账正规可观测面 = `GET /api/dashboard/embeddable` 等，**别看 iframe**；API key 非 Pro 功能；`PUT /api/permissions/graph` 的 revision 409 乐观锁——不碰权限图则无需处理）、§6.3（signed embedding OSS 可用；locked 值经我们签的 JWT 携带）、§7（双写面①：报表本体在 Metabase、登记在平台 ⇒ 对账必须有且显式可见）、§11.3.1（安全论断：**建报表 = 跨租户能力，必须经平台**）。既有 `RouteCtx` / `requesterOf`（`modules/data/routes/context.ts`）、`makeIdentity/buildTestApp/applyMigrations`（`test-util.ts`）。
- Produces:

```ts
// domain/metabase.ts —— Metabase 客户端纯核（fetch 可注入；mock 必须收严到真机形状，#51 教训：
// mock 接受比真机宽松的形状 = 缺陷结构性不可见。真机形状以 spec §6.5 的一手取证为准）
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export interface MetabaseDeps { fetcher: FetchLike; baseUrl: string; apiKey: string }
export interface EmbedParamSpec { name: string; mode: 'locked' | 'enabled' | 'disabled' }
export interface MbUpsertResult { id: number; created: boolean }
export async function upsertDashboard(deps: MetabaseDeps, name: string, collectionId?: number): Promise<MbUpsertResult>
// PUT /api/dashboard/{id}：enable_embedding + embedding_params（locked 锁租户参数）——发布+锁参数只有
// 未版本化老 API（spec §6.4：官方 MCP 与 Agent API 都没有嵌入工具，这步平台必须自己实现）
export async function setEmbedding(deps: MetabaseDeps, dashboardId: number, params: EmbedParamSpec[]): Promise<void>
export async function listEmbeddableDashboards(deps: MetabaseDeps): Promise<{ id: number; name: string }[]>
// 对账正规可观测面（spec §6.5 原话：以此为准，不要去看 iframe）
// 嵌入 JWT（HS256，METABASE_SECRET_KEY；locked 参数携租户值——对观看者不可见不可改）
export function signEmbedToken(secret: string, resource: { type: 'dashboard'; id: number },
  locked: Record<string, string>, ttlSeconds = 600): string
```

- 端点（manifest 同一提交加声明；`data:manage` = 制作/登记/对账，`data:query` = 拿嵌入 URL 观看）：
  - `POST /reports`（manage）：body `{ title, lockedParams, requiredScope? }` → upsertDashboard + setEmbedding + 登记行。幂等：重跑同 title 不重复建。
  - `GET /reports`（query）：本 org 可见清单（词表外的报表可见性也按 org + 行上 required_scope 裁）。
  - `GET /reports/:id/embed-url`（query + 行上 scope）：返回 `signEmbedToken(…, locked: { tenant: orgId, … })` 签出的嵌入 URL。**权限双门分开表态**（spec §4）：「谁能看」= platform scope（页门）；「看哪个租户的数据」= 嵌入时锁定的 tenant 参数（此处写死 = identity.orgId，不接受入参覆盖）。
  - `DELETE /reports/:id`（manage）：Metabase 侧归档 + 删登记行（对账差集的合法消除路径）。
  - `POST /reports/reconcile`（manage）：登记表 ↔ `listEmbeddableDashboards` 双向差集，**diff 显式返回**（对账失败显式可见，不静默——M3c 教训）。
- 迁移 `002_reports.sql`：`data.reports`（`org text not null` + `id/metabase_id/title/embed_params/required_scope/created_at/updated_at`，PK `(org, id)`，索引 `(org, metabase_id)`）——全幂等语法，外部字段一律 text（团队规则）。
- env 三键进 `.env.example`（B9）：`DATA_METABASE_URL` / `DATA_METABASE_API_KEY` / `DATA_METABASE_SECRET_KEY`（服务账号建非 admin 专用 group，key 继承其权限——spec §6.5 最小权限做法）。
- console「报表」页签：列表 + iframe（src = embed-url 端点产物）。**UI 自验纪律：开发完自己开界面走一遍**。

- [ ] **Step 1（TDD）**: `domain/metabase.test.ts`——用真 `Response` 造桩：upsert 幂等（search 命中→PUT 不 POST / 未命中→POST）、setEmbedding 的 PUT 载荷含 `enable_embedding` + `embedding_params` 映射、401/网络错的 fail-closed、JWT 断言（payload 含 locked tenant、exp、HS256 可验签）。
- [ ] **Step 2**: `routes/reports.test.ts`（真库）：无 `data:manage` 建报表 → 403；`embed-url` 的 locked tenant 恒 = `identity.orgId`（**入参带 tenant 一律忽略/拒**——安全论断的落点）；reconcile 对桩出的漂移返回差集。
- [ ] **Step 3**: 实现 domain + 路由 + `002_reports.sql` + manifest/index 同一提交 + console 页签。
- [ ] **Step 4**: 全量验证（含 `DATABASE_URL=… pnpm exec tsx scripts/check-tenant-isolation.mjs`——002 新表）+ PR：

```bash
git add modules/data .env.example
git commit -m "build(data-stack): Metabase 报表 facade——幂等建报/锁参嵌入/登记与对账（P2）"
gh pr create --title "build(data-stack): Metabase 报表 facade + 报表登记 + 看板页签（P2）" --body "Refs #150"
```

---

### Task 8: L2 配置层——定义权下放（结构化声明 + 唯一编译点 + L1 物化）

**Files:**（见派发表 T8 行）

**Interfaces:**
- Consumes: 拍板 #5 全文（定义权下放；可机检声明；agent 接入面预留；C 排除）+ 拍板 #2（dbt YAML 是 L1 事实源）；既有 `domain/authz.ts`（词表裁剪单实现——L2 合并后仍走它，**不另写第二处权限判定**）、`domain/metric-store.ts`（`data.metrics` 读写）。
- Produces:
  - `003_metrics_source.sql`：`data.metrics` 加 `source text not null default 'l2'`（值 `l1`/`l2`）+ 索引 `(source)`；**不加豁免**（org 列纪律不变）。迁移文件里给 default 加注释说明语义：「`default 'l2'` 只对**届时已清零/已处置**的表安全——存量行会被它静默改标 L2（见 Step 3 存量处置前置）」。
  - `domain/semantic-compiler.ts` —— **唯一编译点**：结构化声明 → `select_sql`。

```ts
// L2 结构化声明（可机检、禁任意 SQL 的实现面——拍板 #5）。
export interface L2Declaration {
  baseMetric: string          // 必须引用 L1 词表里已存在的 '<域>:<指标>'（编译时校验存在性）
  op: { kind: 'refine' }      // v1 只有 refine：裁剪/别名/过滤/目标值（A 薄档四件事）
  alias?: string
  visibility?: { dims: string[] }        // 可见维度白名单（维度名 ∈ L1 声明）
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]   // 维度名 ∈ L1 声明
  target?: number
}
export function compileL2(base: MetricDef, decl: L2Declaration): { selectSql: string; title: string }
// base 复用既有 MetricDef（modules/data/domain/authz.ts 导出、metric-store.ts 同款消费）——
// 仓内没有 L1Metric 这个类型名，别新造；若 L2 侧确需扩展字段，以 alias 关系注明
// （如 type L2Base = MetricDef & { … }），不另起平行类型。
// 受限表达式（B 中档）不在 v1——拍板原文「定义权下放」指的是定义新指标/语义的权限下放，
// 表达力档位的扩展（算术组合等）等真实需求出现再走 spec 增补，别在实现里私自放宽。
```

  - `scripts/sync-data-semantics.mjs`：读 `dbt/models/**/schema.yml` 的语义声明 → 幂等 upsert `data.metrics`（`org='platform'`、`source='l1'`；L1 行不再存在的删除）——**L1 的 select_sql 只能从这里写进**，管理 API 对 `source='l1'` 的行只读。`deploy/Dockerfile.server` COPY 清单加 `dbt/`（服务端读取面）。挂进部署序列（migrate 之后跑，或 openship job）。
  - 定义权限双门：租户管理员 = 既有 `data:manage`（本 org 内 L2 行）；平台超管 = 平台级 L2（`org='platform'` 的 l2 行，全租户可见）。**平台超管的识别沿用平台既有信号（实现时核对 identity/scopes 的超管口径，勿新造第二套超管判定）**。
  - `routes/metrics.ts` 收紧：POST/PUT 只收 `L2Declaration`（zod 校验，自由 SQL 入参下线——已有消费者只有本模块 console 页，同 PR 改齐）；catalog 加载 = L1（platform）∪ L2（本 org），L2 只 refine 不改口径。
  - agent 接入面**预留**：manifest 注释 + README 记「L2 定义 API 即将来的 agent 接入面（PAT + data:manage 已具备，MCP 工具面另题）」——**不实现**（拍板原文：接入本身另题不在本轮）。

- [ ] **Step 1（TDD）**: `semantic-compiler.test.ts`——base 不存在于 L1 → 抛；filters/visibility 的维度名不在 L1 声明 → 抛（机检即写时校验）；compile 产物是纯 SELECT（断言不含分号/DDL 痕迹）；同名 L2 在同 org 唯一。
- [ ] **Step 2**: `metric-store.test.ts` 扩：L1∪L2 合并、L2 不可覆盖 L1 口径、裁剪后词表经 authz 只少不多。
- [ ] **Step 3（存量处置前置——003 落生产前的 gate，不做完不许合并）**: 核对生产 `data.metrics` 存量行数（经 openship 或部署侧查询——worker 无 openship 权限时经编排者转操作者代查，**门槛不变**；别裸 SSH）。**为什么必须前置**：山海试点已跑过 #146，console 指标页用自由 `selectSql` 写过行——003 的 `default 'l2'` 会把这些存量行静默改标 L2，造出不受唯一编译点管辖的「L2 祖父级行」，违反全局约束 12。**非零 ⇒ 逐行人工复核显式处置**：每行要么迁入 dbt YAML（成为 L1 声明、经 sync 物化），要么删除（自由 SQL 行不迁 YAML 就只能删，没有第三种去向）；**处置结果（核对行数 + 逐行去向）记进任务报告**。核对为零 ⇒ 报告记「核对时为零」。本步完成才可合并 PR（merge main 即自动部署、003 立刻应用）。
- [ ] **Step 4**: 迁移 + sync 脚本（幂等：重跑两遍行数不变）+ 路由收紧 + console 指标管理页改声明式表单。
- [ ] **Step 5**: 全量验证（check-tenant-isolation 必跑）+ PR：

```bash
git add modules/data scripts/sync-data-semantics.mjs deploy/Dockerfile.server
git commit -m "build(data-stack): L2 定义权下放——结构化声明 + 唯一编译点 + L1 经 sync 物化（P2）"
gh pr create --title "build(data-stack): L2 配置层——定义权下放与可机检声明（P2）" --body "Refs #150"
```

---

### Task 9: 治理四机制收口 + 机检门禁覆盖 L2

**Files:**（见派发表 T9 行——扩 `check-data-models.mjs` 与其 fixtures、dbt/README 的血缘/排查节）

**Interfaces:**
- Consumes: spec §10 四机制的 dbt 原生对应（spec 原文：「四机制 dbt 原生全有——schema.yml / dbt docs / dbt test / 状态选择」）+ 拍板 #5 的门禁③条款（机检范围**覆盖用户/agent 产生的声明**）；T4 的七条静态检查、T8 的声明形态。
- Produces:
  - **记录**：schema.yml 必填字段（T4 已机检）+ T8 的 zod 写时校验 = 双面。
  - **血缘**：`dbt docs generate` 产物（runbook 化：T6 的 job 附带或独立低频 job 产出 lineage）；Postgres 目录递归（`information_schema.view_table_usage`）留作 marts 视图形态时的补充（零维护不漂移——spec §10 机制 2）。
  - **排查五步阶梯**：读声明 → dbt docs 看依赖 → `pg_get_viewdef` → 抽 parquet 源核对 → **独立复算**——写进 `dbt/README.md`（每步一条命令）。
  - **门禁③扩面**：`check-data-models.mjs` 加两类检查——(a) L2 声明静态面：模块内 `L2Declaration` 的 zod schema 与编译器的校验**同源**（fixtures 断言：schema 拒的编译器也拒，防两处漂移）；(b) `scripts/sync-data-semantics.mjs` 的 dry-run 模式：对**已部署库**跑 `--check`，diff 非空 ⇒ exit 1（openship job 定时打，漂移显式可见——对账机制 4 的 L1 侧）。
  - **同名唯一 + 对账在真数据通过**：T4 的 `audit_*` singular tests 已落；本任务在 runbook 记录「物化 job 每次跑都带 tests ⇒ 对账持续在真数据上执行」。

- [ ] **Step 1（TDD）**: check-data-models fixtures 扩（L2 schema/编译器同源断言；sync --check 的 diff 检出）。
- [ ] **Step 2**: README/runbook 血缘与排查节 + job 建议（对账 job 的 cron 建议）。
- [ ] **Step 3**: 全量验证 + PR：

```bash
git add scripts dbt/README.md
git commit -m "build(data-stack): 治理四机制收口——门禁③覆盖 L2 + 血缘/排查 runbook（P2）"
gh pr create --title "build(data-stack): 数据治理四机制与 L2 机检（P2）" --body "Refs #150"
```

---

# W2g（P2）— 端到端验收（gate：W1g 部署存活 + 外部输入③ + W2 合并）

### Task 10: P2 真机验收——嵌入 / 越权 / 对账漂移

**操作者任务（openship 权限）。** 对应 spec 验收 #3/#4/#5 与 P2 出口（越权被拒；对账能暴露漂移）。

- [ ] **Step 1: GATE**——W1g 的数据面部署仍在跑（经 openship MCP 核容器）；`DATA_METABASE_*` 三键已在平台 project env 物化（核对**物化结果**不是配置面——openship env 四层物化的既有坑）；W2 三任务已合并部署。
- [ ] **Step 2: facade 建报表闭环**——console 报表页签建一张报表（锁 tenant 参数）→ Metabase 侧可见同名 dashboard 且 `enable_embedding` + `embedding_params` 正确（回读 `GET /api/dashboard/{id}`，对账正规面）→ console iframe 内嵌可见、图上有 marts 真数据。**UI 自验自己走**。
- [ ] **Step 3: 权限双门 + 越权**——无 scope 用户看不到报表页（页门）；有 scope 但走嵌入的用户**锁死本租户**（换租户参数的任何尝试只会拿回自己那份数据——embed-url 端点忽略入参的实测）；MCP 通道（PAT）带 `data:query` 调报表制作类工具必须不可见/被拒（工具面只读问数，制作面是 `data:manage`——**越权调用被拒**各验一条：租户管理员跨 org、普通用户带 manage 缺失）。
- [ ] **Step 4: 对账暴露漂移**——手工在 Metabase 里删掉一个已登记 dashboard → `POST /reports/reconcile` 返回差集（**不是静默**）→ 经 `DELETE /reports/:id` 走合法消除后 reconcile 归零。结论记 handbook §5 一行。

---

# W3（P3）— SaaS 多租户代码面

### Task 11: 每租户 schema + 凭据收紧

**Files:**（见派发表 T11 行）

**Interfaces:**
- Consumes: spec §11.2 #6（隔离 = 每租户一桶 + 每租户一份凭据 + 每租户一个 schema）+ §9.5（pg_duckdb 侧：secret 可按 **PG role 的 USER MAPPING** 分、`SCOPE` 可收窄到桶前缀；per-schema + search_path 是更贴架构的绑定）+ §6.1（Metabase OSS 无逐用户隔离 ⇒ 权限执行点 = 平台胶水层的 locked parameter，架构文档已显式接受）+ M3c 既有 TENANT_STORAGE（每租户 ZOS 五元组的既有真源）。
- Produces:
  - `dbt/macros/generate_schema_name.sql`：按 `var('tenant')` 生成每租户 schema（`tenant_<org>`）；多租户跑法 = openship job 循环 `--vars '{tenant: …}'`（拍板 #4 的调度形态不变，只是加了循环维度）。
  - `deploy/data-tenants/provision-template.sql`：每租户三件（全幂等）——PG role、pg_duckdb **USER MAPPING（secret = 该租户 TENANT_STORAGE 凭据，SCOPE 收窄到该租户桶前缀）**、该租户 schema 授权。**凭据值走占位**，真值由 provisioning 脚本经 openship env 注入——模板进 git、值不进。
  - `scripts/reconcile-data-tenants.mjs`：对账②（spec §7）——平台租户启用集 ↔ 数据面已建 schema/role 双向差集，diff 显式输出（openship job 定时打）。**脚本读两侧**（platform DB + 仓库库）——scripts/ 不受 B1 扫描（与 check-tenant-isolation 同一先例），模块侧**不**加此端点（模块不读 platform.tenant，硬约束）。
  - marts 消费面：共享 dashboard + 模板变量锁 `tenant`（locked）——marts 表带 org 列、报表 SQL 过滤 org = 锁定值。**结构隔离在凭据/schema 层（staging 读源），locked param 是消费层执行点**——两层分工与 spec §6.1 重排后的权限执行点表一致，串租户回归（T12）两层都测。

- [ ] **Step 1（TDD）**: `generate_schema_name` 的断言进 check-data-models fixtures（schema 名必须由 tenant var 派生、不含裸字面量）；`reconcile-data-tenants` 的 fixtures（两侧集合的各种差集形态）。
- [ ] **Step 2**: 实现 macro + provisioning 模板 + 对账脚本 + `dbt/README` 多租户跑法节。
- [ ] **Step 3**: 全量验证 + PR：

```bash
git add dbt deploy/data-tenants scripts/reconcile-data-tenants.mjs scripts/check-data-models.test.ts
git commit -m "build(data-stack): 每租户 schema 与凭据收紧——USER MAPPING/SCOPE + 启用集对账（P3）"
gh pr create --title "build(data-stack): 多租户 schema/凭据收紧与对账（P3）" --body "Refs #150"
```

---

### Task 12: 串租户回归测试套件（含缓存重放）

**Files:** `scripts/e2e-data-cross-tenant.mjs`（新）+ `.test.ts`（mocked 形态单测）

**Interfaces:**
- Consumes: spec 验收 #2（**两租户并发，A 的任何入口看不到 B 的数据，且必须从数据面服务侧反向验，不能只验 UI**；**必测缓存重放**：A 查一次 → B 查同一条 → 断言 B 拿到自己的数据而不是 A 的缓存副本——cube 缓存 key 的原文依据已随 Cube 否决失效，但**测试本身保留**：Metabase 结果缓存同样可能把 A 的结果重放给 B，这是同一类坑在现栈的形态）+ T11 的形态。
- Produces: 参数化 CLI（env：两租户的 org/PAT/embed 密钥/仓库 DSN；exit 0/1，violation 逐条打印）。四个断言面：
  1. **问数 API**：租户 A 的 PAT 调 `POST /api/modules/data/query` 逐指标——结果集不含 B 的 org 值（词表裁剪 + 主体钉死的数据面实测）。
  2. **嵌入缓存重放**：A 的 JWT 调 Metabase embed API（`/api/embed/dashboard/{token}`——iframe 背后就是这个）拿数据 → B 的 JWT 查**同一张卡** → 断言 B 拿到 B 的数据（A 的缓存副本若被重放即红——**这正是最可能漏的一条**）。
  3. **凭据负测**：以 A 的 PG role 连 pg_duckdb 直接 `read_parquet` B 的桶路径 → 必须失败（USER MAPPING/SCOPE 的结构性隔离反证——从数据面反向验的字面落实）。
  4. **L2 词表**：A 的 PAT `tools/list`/`GET /metrics` 看不到 B org 定义的 L2 指标。

- [ ] **Step 1（TDD）**: `.test.ts`——四个断言面对 mocked fetch/PG 桩的判定逻辑（含「缓存副本被重放」这个必须能红起来的用例：桩让 B 的响应复用 A 的 body ⇒ 断言红）。
- [ ] **Step 2**: CLI 本体 + README 用法（真跑参数、openship job 形态建议：可并入 reconcile job 或独立）。
- [ ] **Step 3**: 全量验证 + PR：

```bash
git add scripts/e2e-data-cross-tenant.mjs scripts/e2e-data-cross-tenant.test.ts
git commit -m "test(data-stack): 串租户回归套件——问数/嵌入缓存重放/凭据负测/L2 词表（P3）"
gh pr create --title "test(data-stack): 串租户回归测试套件（P3）" --body "Refs #150"
```

---

# W3g（P3）— SaaS 真机验收与收尾（gate：外部输入⑤ + T11/T12 合并）

### Task 13: SaaS 双租户验收 + 收尾落档 + 关伞 issue

**操作者任务。**

- [ ] **Step 1: GATE**——外部输入⑤（SaaS multi 环境两测试租户：各自行/用户/PAT/ZOS 凭据/报表）+ T11/T12 已合并 + 数据面已在 SaaS 机部署（provisioning 模板已对两租户跑过）。
- [ ] **Step 2: 跑 T12 套件真机版**——四断言面全绿；物化 job 以两租户循环形态跑一轮（每租户 schema 各自有数）。
  - [ ] **隔离承重点回读（#174 / #175，裁决 = 先验后裁，2026-09-23 用户拍）**：`scope` 作 `USER MAPPING` 的 OPTION **无上游依据**（#174），且实现已把 spec §11.2 #6 的「**每租户一桶**」**降级为「共享桶 + 前缀 `SCOPE`」**（#175）⇒ **本步必须真机回读 DuckDB 侧 secret 的 `scope`**——**只验「DDL 没报错」不算验**（那正是 #174 点名的假绿形态）。两条分支：
    - **验通过** ⇒ **接受**该降级，并**回写 spec §11.2 #6**（写明：降级事实 + 依据 + 「**隔离的承重点是 `SCOPE`**」）——**回写 spec 是 T13 的动作**（spec 正文按纪律不追改，此处的回写是裁决后的一次性合法更新）。
    - **验不通** ⇒ **必须改造为「每租户一桶」**（或上游支持的等价隔离），**不得将就**。
    - **未验不得定稿**：本条的结论直接撑起 P3 的隔离承诺 ⇒ **不允许「先写结论、后补验」**。
- [ ] **Step 3: 收尾落档**——
  - spec（`2026-09-20-data-stack-module-design.md`）：§11.8 分期表加落地注记（P0–P3 各一行：日期 + PR/验收指针）；已知边界按实际落地更新（Metabase 嵌入面暴露通道的最终形态、ducle→ZOS 结论）。
  - handbook §5 验收记录补 P2/P3 两行。
  - **WeKnora 沉淀**（先 hybrid-search 查重，命中更新不新建）：~~pg_duckdb 自建镜像 recipe 容器化的实操增量（install 产物路径/构建时长）~~ ⇒ **改沉淀「自选配对的失败结论」**（2026-09-23 订正：「自建配方实操增量」**不存在**——首次构建**实测停在编译阶段**，`install` 从未跑到，故无产物路径/构建时长可记；有价值的是**8 处 API 断裂**这条 + 「官方镜像 + Docker Hub 可达」这条结论）；Metabase 老 API 幂等 upsert + `embedding_params` 的实操口径；串租户回归里缓存重放的结果（Metabase 缓存 key 是否含参数——实测结论对后来者高价值）。
  - 最终 docs PR：**body 写 `Closes #150`**——伞 issue 在此关闭（全局约束 8：此前所有 PR 一律 Refs）。

```bash
git add docs
git commit -m "docs(data-stack): #150 P0–P3 落地收尾——spec 分期注记 + 验收记录"
gh pr create --title "docs(data-stack): 数据栈 P0-P3 收尾（Closes #150）" --body "Closes #150"
```

---

# W4（新增）— duckle 引擎能力接入（2026-09-23 新增）

> **文档面本轮已落**（`duckle/README.md` §7、`contracts/README.md` §10、`docs/architecture.md`
> §2.2 与 §5.1）；**实现面在「第一个新数据源接入 PR」里分批销账**。本节的作用是把那些结论
> **钉成可执行的落点与 gate**，不是再写一遍结论。

**为什么新增**：本轮把 duckle 从「只是 ETL 执行器」正名为**管线层的机器面**（漂移门禁 / 契约校验 /
管线级血缘 / 新鲜度）——`contracts/` 据此**降级为「人写的意图源」**（见下 Step 1）。
**正典**：`duckle/README.md` §7（能力清单 C1 / 半替代 C2 / 三条坑 C3 / 未验清单 C4 / 接入方式 C5 /
wheel 订正 C6）。

### Task 14: duckle 引擎能力接入（drift / 契约校验 / 血缘 / 新鲜度）

**谁在什么条件下做（先读这条，别把它当独立任务派）**：

| 面 | 谁做 | 什么时候 | 为什么是这个时候 |
|---|---|---|---|
| **文档面** | 本轮方案整理 | **已完成**（2026-09-23） | 结论要先有正典，否则每接入一个源都要重新论证一次 |
| **实现面** | **接入新数据源的那个 PR 的执笔者** | **只在有源接入时** | C1–C3 的产物（`data.schema` / `qa.contract` / `drift` / 血缘）**都长在具体管线上**——**没有源就没有对象**。⇒ **不新开一个「能力接入」空 PR** |
| **未验项销账** | 同上 | 该 PR 的**首次真跑**时逐条销 | 未销完的管线**不得**当作「已验证」对外表述 |

**Files:**（**本任务不新建仓内文件**——实现在接入 PR 里，随三件套一起走）
- 管线定义：`duckle/<域>/<源>.<表>.json`（含 `node.data.schema` / `qa.contract` / `drift` / `qa.freshness` 节点）
- 同一 PR 的另两件：`contracts/<域>/<源>.<表>.json`（人写的意图源）+ `dbt/models/**/stg_<表>.sql`

**Interfaces:**
- Consumes: W1 的 `duckle/`（管线骨架）与 `deploy/duckle/`（镜像 + 入口闸）；`duckle/README.md` §7
  的能力结论；`contracts/` 的人写声明（**作为意图源，不是机器判据**）。
- Produces: 管线侧的四类机器面 + **与契约的逐项一致性**（人写的意图 ↔ 引擎执行的面）。

- [ ] **Step 1: 落点分工（C1–C2，逐条对号入座；别自己造轮子）**

  | 要的能力 | 交给谁 | 形态 |
  |---|---|---|
  | **列漂移门禁**（C1①） | **duckle `drift`** | 抓 missing / added / typeChanged，exit 1 |
  | **落地契约校验**（C1②） | **duckle `node.data.schema` + `qa.contract`**（+ `drift`） | 按声明定型，不符即失败（不静默降 VARCHAR） |
  | **管线级血缘**（C1③） | **duckle `catalog build`** → `.duckle/catalog.json` | 含 lint / orphans / owners |
  | **新鲜度**（C2，**半替代**） | **一半靠引擎**：run receipt + `logs/duckle_metrics.prom` + `qa.freshness`（上次成功时间 / 行数）；**另一半仍需自建**：**输入指纹**（引擎自陈未按 run 记录） | ⚠️ **别把「有时间戳」当成「有输入指纹」** |

  ⇒ **`contracts/` 的角色随之订正**：它是**人写的意图源**（接入起点 + 评审依据），
  **机器面在管线**（见 `contracts/README.md` §10）。两者**不是二选一**，但**必须一致**——
  契约里声明的列/类型/分区，要在 `data.schema` / `qa.contract` 里落成引擎认得的形态，
  **接入 PR 里逐项核对**（这是 `contracts/README.md` §9 第 2/5 条那两项未验的落点）。

- [ ] **Step 2: 三条坑按纪律落（C3——**写成管线里的门禁，不是写成一句提醒**）**

  1. **`drift` 假绿**：源未声明 schema 时 `drift` **静默 exit 0** ⇒ 门禁**必须先断言「声明存在」**
     （断言 `node.data.schema` 在场、且非空）**再**判 drift 的结论。
  2. **`qa.freshness` 时区**：对 **UTC 列按本地墙钟**算（实测偏 **+8h**）⇒ 用它**必须强制时区对齐**
     （本仓铁律 RFC3339 UTC），否则会把真延迟判成「新鲜」。
  3. **`pipelineHash` 语义**：它是**代码指纹、不是数据指纹** ⇒ **禁止**用它判「输入数据变没变」；
     输入变化判定走 Step 1 表里「仍需自建」的那个输入指纹。

- [ ] **Step 3: 未验项进 gate（C4——未销完不许称「已验证」）**

  下面四项**当前未验**（出处 `duckle/README.md` §7.4），**接入 PR 的首次真跑时逐条销账**，
  销账结论写进该 PR 的报告与 `duckle/README.md` §6/§7.4：
  1. **远端源（S3 / PG / REST）上的 `drift`**；2. **`review --data` / `review --drift`**；
  3. **容器内行为**（本机 docker daemon 未运行、镜像未构建）；4. **非回环 `UNCLAIMED` 分支**。
  ⚠️ 这四项**一条都不会因为「本机装上了 duckle」而自动销账**（PyPI 有 macOS/arm64 wheel，见 C6）。

- [ ] **Step 4: 接入方式（C5——**凭据走 job，不放宽入口闸**）**

  `drift` / `review --data` 要凭据与网络 ⇒ **etl job 显式带 `--token` 跑**。
  ⚠️ **不是**放宽 `deploy/duckle/entrypoint.sh` 的白名单闸——那是安全边界（`duckle/README.md` §7.5、
  `deploy/duckle/README.md` §8）。**动它 = 另一起决定**（要改先改 `entrypoint.sh` 的注释正典 + 独立评审）。

- [ ] **Step 5: 附带订正（C6）**　[**本轮文档已落**]

  PyPI 上 `duckle` 除 `manylinux2014_x86_64` **还有 `macosx_11_0_arm64` 与 `manylinux2014_aarch64`
  wheel**（实测装机成功：`0.7.3` + 传递依赖 `duckdb-cli==1.5.4`）⇒
  `deploy/duckle/README.md` §2.2 的「**release 资产只有 `-linux-x64`**」那句**已订正**
  （该句只对 **release 二进制**成立）。**装得上 ≠ 已验证管线**，Step 3 一项都不销。

---

## 附：与本计划相关的已知坑（执行时别重踩）

| 坑 | 出处 | 对本计划的影响 |
|---|---|---|
| ~~duckle 原生 s3 sink 直连 ZOS 反复 403（能力空白）~~ **旧口径已被取代**（经验库 2026-09-17 订正 + 真机实测）：`snk.minio` **可直写**；`snk.parquet` 403 / `snk.s3` 404 仍不通 | WeKnora 两条既有条目（spec §8 引；spec 同句是历史快照、不追改） | T5 不跑真管线；T6 核对并落结论（能/不能+替代路径）；**先检索 WeKnora 再动手**；**别照旧稿写「能力空白」**（第十轮 B 节 / Task 6 Step 1 Gate-D） |
| parquet 列全是 VARCHAR（金额/时间是字符串） | layered 坑 #1 | staging 手写 cast（拍板 #1）；契约管新源 |
| `DOUBLE` 不是 pg_duckdb 可用的 cast 目标 | layered 坑 #4 | 用 `numeric`/`float`；check-data-models 静态拦 |
| 读 parquet 必须 `r['列名']` + 别名 r | layered 坑 #5 | `SELECT *` 的成功会掩盖它；staging 规范 + 静态门禁双拦 |
| 同域不同日 46 vs 43 列（supplier_* 漂移） | layered 坑 #2 | 禁 `union_by_name` 兜；显式分组策略；列全集 T6 按样本钉死 |
| 两个时间列两种格式 | layered 坑 #3 | staging 双格式 try |
| DuckDB 实例按连接：SET/使用同会话；`install_extension` 同会话开两个 allow；`duckdb.query()` 看不到 PG 表 | spec §11.5 | dbt S3 凭据注入按连接处理（T4 gate）；用 `raw_query` |
| `read_parquet` 裸扫描不进 `pg_class` ⇒ Metabase 看不见 | spec §9.4 | 物化落点必须是 PG 可见关系（T4 gate 2） |
| Metabase API 无按名 upsert | spec §6.5 | facade 幂等自实现（search→PUT/POST） |
| locked parameters 是官方点名「不推荐敏感数据」的用法 | spec §6.1/已知边界 | T2 架构文档显式接受；隔离主力在凭据/schema 层 |
| 嵌入带水印、不能禁 CSV 导出 | spec §6.3 | 显式接受（数据外带面，导的是租户自己那份） |
| 物化存储 ~×8 膨胀 | layered §5.3 | 按需 `--select`，不全量物化 |
| 编译三配置缺一不可（DISABLE_UNITY / 并行度 2 / jemalloc include 补丁） | spec §11.4 | 以 **T1 交付物 Dockerfile** 为准（§11.4 原文已证伪，见 Step 1 后订正说明），别「优化」。⚠️ **该路径本轮未启用（备件）**——本轮只改了它的注释（「本轮订正」A1/A2） |
| Metabase↔Cube 版本级断点六次 | spec §6.2（cube 时代记录） | Cube 已否决，但**版本锁死 + 升级先核兼容**的纪律平移到 Metabase↔pg_duckdb：锁 v0.63.18.1，升级走 runbook |
| **duckle `drift` 在「源未声明 schema」时静默 `exit 0`（假绿）** | W4 / `duckle/README.md` §7.3 | 门禁**必须先断言「声明存在」**再判 drift 结论（只看退出码 = 把没声明当没漂移） |
| **duckle `qa.freshness` 对 UTC 列按本地墙钟算（实测偏 +8h）** | W4 / `duckle/README.md` §7.3 | 用它**必须强制时区对齐**（铁律 RFC3339 UTC）——否则真延迟会被判成「新鲜」 |
| **duckle `pipelineHash` 是代码指纹、不是数据指纹** | W4 / `duckle/README.md` §7.3 | **不能**用它判「输入数据变没变」；判定输入变化要靠自建的输入指纹（半替代那一半） |
| Actions 额度会挂起真实工作流 | team-harness PR#79 教训 | 镜像构建仅 dispatch；跑前确认额度（外部输入① —— **本轮已随「自建未启用」消解**，见「本轮订正」A1/A2） |
| 改部署配置≠生效（openship env 四层物化） | 团队记忆 | T10/T13 的 env 核对看**物化结果** |
| 合并只等 CI CLEAN；直推 main 拒发版 | 团队记忆/AGENTS #7 | 每 PR 等 CLEAN；本计划零直推 |
| 伞 issue 被中途 PR 的 Closes 提前关闭 | M2b #158 事故 | 全局约束 8：Refs #150 一路到底，T13 才关 |
| Orca `--base-branch main` 取本地 ref / 中文路径打挂 vitest | 团队记忆 | 派发块两行提醒 |

---

## 自检记录（作者填，reviewer 可复核）

### 自检纪律（问数计划四类坑的针对性自查，本计划写作时逐条执行）

1. **范文块与订正口径冲突**（问数 #35 类）：本计划所有代码块写作**之后**逐块对照拍板记录复核——dbt staging 范文只含「模式 + 实证坑样例」，列全集标 gate 不冒充定稿；facade 范文的 `FetchLike`/Response 桩形态与问数计划 T2 已合入的写法同源；写后自查揪出 7 处范文缺陷（见下表第二轮），全部修入本体。
2. **计数与清单不符**（#39 类）：文件表逐行核对任务的 Files 清单（见下「核对结论」#1）；六处「尚未进仓」标注行号以 grep 实测为准；L1 语义声明必填字段在 T4 Step 4 / T9 / `semantic-compiler` 三处口径一致（owner/tier/grain/definition）。
3. **接口消费方漏列**（#33 类）：`ALLOWED` 双白名单的消费方 = 守卫本体 + 新建测试 + T3 的 compose（落仓前提）；`check-data-models` 的消费方 = ci.yml gates（T4 接线）+ T9 扩面 + T11 的 macro 断言；`signEmbedToken` 的消费方 = embed-url 路由 + T12 断言 2；`compileL2` 的消费方 = metrics 路由 + T9 的 schema 同源断言——逐个在任务 Interfaces 写明。
4. **并行任务文件面交集为零**：W1 四任务逐任务点名唯一触碰面（见派发表下核验段）；W2 串行的两条理由（manifest 双向核对、T9 消费 T8 形态）写死在波次表。
5. **订正后的连带口径残留**（F3b 复核 N-2 / N-4 教训）：任何一处口径订正（数字 / 引用姿态 / 操作步骤）落地后，**全文 grep 该口径的原文与数字**（如「43」「逐字转录」「回退 ARG」），**逐条判定**是否与订正后口径冲突——同一份文档里新旧口径并存 ⇒ 后来者照抄旧的那条（第四轮只改了 L199 一处，漏了第一轮附表里的同口径残留）。执行结果见「自检发现与处置」第五轮。

### 自检发现与处置

**第一轮：引用核验**（逐个 grep/读文件验证）

| # | 核对项 | 结论 |
|---|---|---|
| 1 | 文件表 ↔ 各任务 Files 清单互查 | 一致（表内行与任务内清单逐行对过；T2 三文件均为 Modify/Create 与既有面相符） |
| 2 | 引用的门禁命令逐个对照 ci.yml 实测 | `pnpm exec tsx scripts/check-*.mjs` 五条 + `pnpm typecheck`/`pnpm test` 与 ci.yml gates job 逐字同形；`pnpm --filter data test/typecheck` 经 `modules/data/package.json` 的 `"name": "data"` 核实 |
| 3 | B7 前置证据复核 | `scripts/check-compose.mjs:50` `ALLOWED = 'deploy/docker-compose.yml'` 与 `docs/architecture.md:121`「全仓唯一 compose」均实测在位（决策材料同源） |
| 4 | 「尚未进仓」标注位置 | grep 实测六处：customer-onboarding.md :33/:51/:91/:157/:172/:199（T6 Step 6 已写明以届时 grep 为准） |
| 5 | 拍板六项 ↔ 任务落点 | 已拍口径表逐行有落点任务；~~仍开放两项（构建频率、Ossie 观察信号）显式标注「不阻塞、不擅自拍」~~ ⇒ **2026-09-23 追记：两项均随「本轮订正」消解**（自建未启用 ⇒ 构建频率无对象；ossie 不采用 ⇒ 观察信号无对象）。口径表 #2/#3 已同步订正 |
| 6 | modules/data 既有面（防重复造） | `authz.ts`/`metric-store.ts`/`warehouse.ts`/`routes/mcp.ts` 均实测在位（#146 已交付）；T7/T8 全部走扩面，无一处重建授权逻辑 |
| 7 | spec 中 Cube 时代条款的误引排查 | `cast({{v}} as text)`（cube SQL API 专用坑）**未**写进本计划任何 Metabase→pg_duckdb 步骤（真 PG 驱动参数化原生可用）；cube 缓存 key 依据在 T12 标注为「原文已失效、测试平移保留」 |

**第二轮：范文块写后自查（发现 7 处，已全部修入本体）**

| # | 缺陷（原文怎么错的） | 修正 |
|---|---|---|
| 1 | **T2 声称「check-compose 此前无单测，新建 test 文件」——错**。实测 `scripts/lint-architecture.test.ts` 文件头注明覆盖三守卫（lint-architecture / check-compose / check-env-example），B7 的 fixtures 测试（含回环规则负例）一直在那里，黑盒 spawn 形态 | T2 改为**扩既有 describe**（复用 `fixture()/run()/MINIMAL_COMPOSE/expectClean`），并同步更新文件表、W1 交集核验段与提交清单 |
| 2 | **compose 卷相对路径写反**：`- ../../duckle:/pipelines:ro`——相对路径锚在 compose 文件目录（deploy/），两层 `..` 越出仓根 | 改 `../duckle`、`../dbt`（与主 compose 的 `../.env` 同一层级口径） |
| 3 | **workflow 的 context/file 组合会解析出双写路径**：`context: deploy/pg-duckdb` + `file: deploy/pg-duckdb/Dockerfile` 时 file 相对 context 解析 | 省略 file（build-push-action 缺省取 `<context>/Dockerfile`） |
| 4 | **`${DUCKLE_TOKEN:?}` 会卡死无关部署**：compose 插值是文件级的，没配 token 时连三服务的 `up` 都解析失败 | 改缺省空 + 把安全闸放进 duckle 镜像 ENTRYPOINT（空 token 拒跑）；注释写明为什么不用 `:?` |
| 5 | **staging 范文把 `read_parquet` 包进 `duckdb.raw_query(...)`——形态错了**：spec §11.5 #2 的原文是 `raw_query` 用于「在会话内**建** DuckDB 侧的表/视图」（会话内副作用操作），不是可 FROM 的表函数；layered §4 的 staging 模式是直接对 parquet 行用 `r['列名']` 取列 | 重写为 `from read_parquet(...) r` 直读形态，并把「read_parquet 的调用面」加进 Step 3 的实测核对 gate |
| 6 | **`??` coalesce 运算符不是可靠的 DuckDB 语法**（写时顺手用了 R 风格） | 改标准 `coalesce(try_strptime(...), try_strptime(...))` |
| 7 | **duckle 二进制下载 URL 的 repo slug 属推测**（spec 只记了 ghcr org 与资产名，没记 GitHub repo 全名）；而 **PyPI `duckle` 是 spec 明载的另一条官方分发路径** | Dockerfile 主路径改 PyPI（spec 明载、无 slug 猜测），二进制路线降为 README 替代项；ENTRYPOINT 标注「CLI 子命令形态以官方文档核对」 |

**第三轮：开工前扫描七处（2026-09-22，返工撰写者修入本体；每处最小化修改 + 修后 grep 复核）**

| # | 发现（原文怎么错的） | 修正（落点） |
|---|---|---|
| 1 | **T8 的 003 迁移会把存量行静默改标 L2**：`source not null default 'l2'` 落到已跑过 #146 的生产库（山海试点 console 指标页用自由 `selectSql` 写过行）⇒ 存量行变「L2 祖父级行」，违反全局约束 12（`select_sql` 只能由唯一编译点生成） | T8 加 **Step 3 存量处置前置**（核对生产 `data.metrics` 行数——经 openship/部署侧查询；非零逐行人工复核：迁 dbt YAML 或删，结果记任务报告；完成才许合并）；003 的 default 语义加注释「只对届时已清零/已处置的表安全」 |
| 2 | T3 Step 3 的 `docker compose config` 验证依赖 T5 的 build 上下文文件（`deploy/duckle/Dockerfile`），W1 并行波里可能未合并 | 加 hedge：因 T5 文件未合并报错则跳过本步、报告注明、留 T5 合并后复验，别预写 T5 的文件 |
| 3 | T5 的 .gitignore 模式内嵌空格：`duckle/**/ _ops/` 只会匹配「目录名以空格开头」的形态，照抄即空转 | 改 `duckle/**/_ops/`（或以实测 _ops 形态为准的正确 glob），写明禁内嵌空格、多条形态写成多条独立模式 |
| 4 | 指标命名空间 `<域>:<指标名>` 含冒号，`audit_<指标>.sql` 按名字面映射会产出含 `:` 的文件名；T4/T9 两个 worker 可能各造一套映射 | T4 Step 4 定义唯一映射（`:` → `__`，例 `aftersales:refund_ratio` → `audit_aftersales__refund_ratio.sql`）；Step 5 机检⑦与 T9 扩面写明消费同一条规则 |
| 5 | T3 的引用姿态错：把 15432 说成 customer-onboarding 阶段 5「唯一跨 project 接线点」的既有内容——文档里没有 15432（只记过 lab 端口 18080/18081/16379），是本计划新选的端口 | 引用改「**计划选定**（满足 §4 端口错开约束）」；T6 Step 6 加回写步：最终接线形态（含 15432 与「仅同宿主可达」前提，对照主 compose 头注别误读为容器服务名矛盾）写回 customer-onboarding 阶段 5 |
| 6 | T3 的 dbt 版本核对出处不存在：「layered §11 资源画像实测的 dbt 版本」——§11 只有内存画像、无版本号 | 出处改「⚠️ 待实测人确认（拍板时以现场实际安装为准）」；开工前置表加**外部输入⑥**（人给版本号或确认 1.9.8），W1g gate（波次表 + T6 Step 1 GATE）同步带上 |
| 7 | T8 用了 `L1Metric` 类型名——仓内既有类型是 `MetricDef`（`modules/data/domain/authz.ts` 导出、`metric-store.ts` 消费；grep 实测），没有 L1Metric | Interfaces 改 `compileL2(base: MetricDef, …)`，注明复用既有类型、扩展字段走 alias 关系、不另起平行类型 |

**第四轮：T1 交付实证带回的订正（2026-09-22，T1 评审 I-1；范文块**本体已换**，非加注记）**

| # | 缺陷（原文怎么错的） | 修正（落点） |
|---|---|---|
| 1 | T1 Step 1 的 `sed` 目标写 `src/common/allocator/allocator_jemalloc.cpp`——**该路径在 pg_duckdb 树内不存在**（该文件属 `third_party/duckdb`；v1.1.1 树内 `src/` 无 `common/` 目录）⇒ 照抄即 `No such file` 当场失败 | Step 1 范文块路径补全进第三方树内 |
| 2 | T1 Step 1 **缺子模块哨兵步** ⇒ tarball-only 构建必挂（Makefile 的 `git submodule update --init --recursive` 在非 git 树 fatal，退出 128） | Step 1 范文块增 `mkdir -p .git/modules/third_party/duckdb && touch …/HEAD` |
| 3 | T1 Step 1 最终 stage **缺运行期依赖** ⇒ 扩展加载失败（`libcurl.so.4` 是 `libduckdb.so` 的 NEEDED；多阶段**不继承** build stage 的包） | Step 1 范文块最终 stage 增 `apt-get install -y --no-install-recommends libcurl4` |
| 4 | T1 Step 2 的 `tags:` 用 `${{ github.repository_owner }}`——org 名 `MYTech-Co-LTD` 含**大写**，而 OCI 引用名要求小写 | Step 2 范文块改字面量 `ghcr.io/mytech-co-ltd/…`（并写明实测失败时机 = 解析 tag 阶段） |
| 5 | **根因不止计划**：同一个被证伪的旧稿还在 spec §11.4（自称「实测，可照抄」）里；T1 brief 是同源生成物 | spec §11.4 同批订正（补路径口径 / 哨兵 / 多阶段运行期依赖 + 收窄「可照抄」边界）；brief 不手改——由 `task-brief` 从本计划重新生成（手改 = 双写漂移） |
| 6 | 计划层**选型风险未标注**：pg_duckdb v1.1.1 × DuckDB v1.5.5 是未经任何一方验证的配对（评审 I-2） | T1 Interfaces 下补配对风险条（含 ARG 回退 `main` 的口径）；W1g gate 两处（波次表 + T6 Step 1 第 6 项）写成**显式前置** |

**第五轮：订正口径的连带残留清扫（2026-09-22，F3b 复核对本计划的 N-2 / N-3 / N-4）**

| # | 缺陷（原文怎么错的） | 修正（落点） |
|---|---|---|
| 1 | **头文件计数口径没写，与 T1 runbook 侧的 52/52 打架**（复核 N-2；裁决 = **52 正确**：`#include "duckdb/…"` 双引号形态 43 + `<duckdb/…>` 尖括号形态 10，**两形态并集去重 52**；复核对 52 条逐条 HTTP 探针 = 52/52 全 200。只取双引号形态是更窄的口径，不是算错） | T1 Interfaces 的版本配对风险条改 **52 个 / 52/52 全在**，并**把口径写进正文**（两形态并集去重）——「口径没写」正是两处数字打架的根因 |
| 2 | **回退口径只提「改 ARG」不提「出新 tag」**（复核 N-3，与 runbook §5.2 同源的共同盲区）：tag 是 Step 2 workflow `tags:` 与 runbook §1b ⑦ `docker commit` 的**硬编码字面量**，不由 ARG 推导 ⇒ 只改 ARG 重跑 = 把 `main`（或某个 SHA）编出的产物盖到钉死的 `1.1.1-duckdb1.5.5` 上（撞 §0「旧 tag 保持可回滚」；且 `main`/SHA 本就不在 tag 公式的取值域内） | T1 Interfaces 风险条 + W1g gate（T6 Step 1 第 6 项）各补半句：**回退须按 §0 出「新」tag**（回退场景建议 `main-duckdb1.5.5` / `<sha8>-duckdb1.5.5`），**不得复用 `1.1.1-duckdb1.5.5`**。**另自查扩面**：T1 Step 3 的 ④（升级路径「改 ARG 重跑」）属同一盲区，一并补（升级/回退都要同步出新 tag） |
| 3 | 第一轮核验附表仍写「Dockerfile 逐字转录，别「优化」」——而 §11.4 原文**已被本轮明文证伪**（spec 写明「旧稿是已证伪的版本，别再照抄旧稿」）⇒ 照抄 = 要求把 Dockerfile 与一个已证伪的范文块逐字对齐（复核 N-4；同文档 L199 已改否定式，此为其**唯一残留**） | 结论列改「以 **T1 交付物 Dockerfile** 为准（§11.4 原文已证伪，见 Step 1 后订正说明），别「优化」」 |

**第五轮执行自查纪律第 5 条的 grep 结果（实测，供 reviewer 复核）**：

- **头文件计数口径**：全文**已无**旧口径的肯定式写法（原「v1.1.1 引用的…头在 v1.5.5 中全在」已改为 52/52 并写明口径）；其余数字命中**全是**端口 `5432` / `15432`（L176/181/355/374/453/479/502/531/758/759）与乐檬**列数漂移**（L588/612/998），与本口径无关。
- **「逐字转录」**：**执行面只剩 L199 一处**，且是否定式（「**不是**逐字转录」）；原第一轮附表的肯定式写法已按本表第 3 行改掉（本表引用行不计）。
- **「回退」**：L207 / L307 / L746 三处**执行步骤**均已带「出新 tag」半句；第四轮记录行里的「含 ARG 回退 `main` 的口径」是**历史落点描述、非执行步骤**，按原样保留。

**第六轮：T2 派发时的 grep 驱动面补全（2026-09-22，T2 交付带回；编号续第五轮，不重复用「第五轮」）**

| # | 缺陷（原文怎么错的） | 修正（落点） |
|---|---|---|
| 1 | **`check-compose.mjs` 的改点计划只点名 3 处，实际是 8 处引用 + 5 处口径文字**。计划 Step 2 只说：`ALLOWED` 常量、`checkHostPortBindings` 遍历、头注规则一。实际漏列：**L57 `REQUIRED_PORT_SERVICES` 变死 const**（被新 Map 取代——计划只说加 Map 没说删旧 const，留 = 死代码 + `typecheck:scripts` 未使用告警）；**L234 `compose 片段` 报错串里硬编码单路径**；**头注判断②**（「全仓只有一个 compose 是字面要求」）、**判断③**（「规则二只对被放行的那个文件生效」）、**判据 b 说明**（「postgres / server 两个受管服务」需补「按文件给」）、**L49 doc 注释**（「唯一被放行的 compose 文件」）、**L161 函数 doc**、**L175/L189 行内注释**、**L239 报错串插值**，以及三处 `file: ALLOWED`（判据 a/b/c 的报错要指向**当前**文件） | T2 按实际面全改（含删死 const、报错串改 `ALLOWED.join(' / ')`、判据 b 服务清单改 `REQUIRED_PORT_SERVICES_BY_FILE` 按当前文件取）。另：计划写 `export const ALLOWED`，实测**全仓零消费方**（B7 测试是黑盒 spawn、不 import）⇒ 维持**不导出**（不新增没人用的 API） |
| 2 | **活文档里的同一口径计划完全没列**：「全仓唯一 compose」/「唯一编排事实源」还写在 `AGENTS.md:41`（**项目事实唯一来源，优先级最高**）、`README.md:10`、`deploy/README.md:7`、`deploy/openship-adopt.md:45` 与 `:402`、`deploy/docker-compose.yml:1`（文件头注释）。T3 落 `data-compose.yml` 后这 6 处即为**错口径**，且散在多份活文档里 | T2 一并收敛为「白名单两份」口径（一行级改动，保留原句仍成立的部分如「不要在生产另写第三份」），改后重跑 grep 复核（见下「第六轮 grep 复核」） |
| 3 | **历史快照两处必须不动，计划与 brief 都未点名其「不改」性质**：`docs/superpowers/specs/2026-09-20-data-stack-module-design.md:34` 的「全仓唯一 compose…」落在 **「### 现状：为什么今天接不进来」** 表里——该节的**前提就是当时接不进来**，改它 = 篡改历史记录；`docs/superpowers/specs/2026-09-12-platform-architecture-doc-design.md:84` 是 architecture.md **自身的设计稿**，同属快照 | 两处**不改**，仅在 T2 报告登记（口径正典唯二：`docs/architecture.md` §1.2/§4.1 + 守卫本体）。其余 `specs/*.md`、旧 `plans/*.md` 的旧口径同样不改 |

**第六轮 grep 复核（T2 交付时实测，供 reviewer 复核）**：

- `grep -rn "全仓唯一\|全仓只\|唯一 compose\|唯一编排事实源\|唯一被放行" --include='*.md' --include='*.yml' .`（去 node_modules）后，**活文档面已无旧口径残留**：命中只剩 ① `docs/superpowers/**` 历史 spec/plan（含本计划 L333 / L1034 的**决策时证据记录**——写的是「当时实测在位」，属快照，不改）；② 无关同形词（`parsePageParam` / `authz.ts` 的「全仓唯一一份」指单实现，与 compose 无关）。
- `grep -n "ALLOWED\|唯一\|只许\|只放行" scripts/check-compose.mjs scripts/lint-architecture.test.ts` 命中全部落在**新口径**（白名单遍历 / 新 describe 标题），无旧单文件口径残留。
- **本表同时是一处「计划自身文字已过期」的登记**：Task 2 Step 1 的「在既有『B7 全仓唯一 compose』describe 里」与 L346 的描述，指的是**改动前**的 describe 标题（T2 已改为「B7 白名单两份」）——执行步骤类文字按**快照**保留，后来者照抄前先看本表。

**第七轮：T2 评审带回的订正（2026-09-22，PR #164 修复波；范文块与既存缺陷一并登记）**

| # | 缺陷（原文怎么错的） | 修正（落点） |
|---|---|---|
| 1 | **Task 2 Step 1 第 5 条用例的 fixture 是装饰**：它与首条用例 **fixture 与断言逐字同构**，且 `DATA_COMPOSE` 里只有 `pg_duckdb` ⇒ **判据 b 无从触发**，用例名声称的「判据 b 不跨文件」根本没被测到。评审注入回归（把按文件取改回全局清单）后 **101 用例仍全绿** ⇒ 本任务新引入的 `REQUIRED_PORT_SERVICES_BY_FILE` **零护栏** | 已改成**真触发形状**（data-compose 里放一个名为 `postgres` 的服务且不给 ports，期望仍干净）；变异实验实测：改回全局清单 ⇒ 该条**唯一转红**。**后来者照旧范文块（本计划 L391–396）抄 = 原地复发** |
| 2 | **判据 c 的缩进盲区**（既存机制，base 同形）：条目正则 `^ {6}-\s*(.+)$` 缩进精确，而判据 c 只在行内含 `ports` 关键字时才报 ⇒ **非 6 缩进的列表项**（缩进 8 / 与 `ports:` 同缩进 4——YAML 合法且常见）判据 a 与 c **同时失明**。主 compose 靠判据 b 歪打正着（红，但文案「服务还在却一条 ports 都没有」**与事实相反**）；本任务新放行的 `data-compose.yml` 受管名清单为空 ⇒ **连兜底都没有**（T3 上线即会出现「B7 绿灯 + 0.0.0.0 绑定」的宿主端口） | 判据 c 扩到「`ports` 块内缩进不为 6 的列表项」一并判违规（块边界与 `parsePorts` 同一套规则，**`parsePorts` 与判据 a/b 本体未动**）；「只支持 6 缩进」写进守卫头注的已知边界；补 5 条用例（缩进 8 非回环 / 缩进 4 / **缩进 8 但回环也红——fail-closed** / 主 compose 同样报 / volumes 块不被误扫） |
| 3 | **软链逃逸规则一是既存漏洞**：`readdir(withFileTypes)` 的 `entry.isFile()` 对符号链接为 false、`isDirectory()` 亦 false ⇒ 软链对 `walk` **完全不可见**，规则一永远看不到它；git 以 `mode 120000` 存软链 ⇒ 是一条可被 PR 带入的**真实绕过路径**。base（`bc7afc5`）与 head 行为**逐字相同** ⇒ **本 PR 未引入、未加剧**（放行面没有因此变宽） | **不在本 PR 修**（属另一个决定，修法方向见 issue）：已开 **issue #165** 登记缺陷与证据。后来者别以为白名单已经封住了这条路 |
| 4 | **§2 那行的覆盖表述会被读成「它们被守住了」**：原句「在 B1（跨 schema）与 B9（env 键齐全）的扫描根之外，由 `scripts/check-data-models.mjs`（T4 起）单独守」——「扫描根外」为真（评审仓外 fixture 实证），但 T4 的该脚本按计划只做 **dbt 工件的静态门禁**，**不覆盖 env 键**；`duckle/`（T5）与 `contracts/` **不在 B1/B8/B9 任何扫描面内** | 正典该行收窄为它**实际**覆盖的部分，并明说 `duckle/`/`contracts/` 的 env 键等约束**当前没有任何静态门禁**、需要时由 T4 按其职责扩面。**「无静态门禁」是已知状态，不是遗漏**——别再把这句读回成「已被守住」 |

**第八轮：T2 复评带回的裁量落地（2026-09-22，PR #164 文档收尾波）**

本轮**未修任何缺陷**——只把裁量与措辞落成文：正典末尾自约按复核 §6 的措辞补 RR6 例外条款（「目标形态引用必须随句标注」），§5.1 按 RR-M5 补半句；两处均**非**表内裁量项。

| # | 事项 | 裁决与依据 |
|---|---|---|
| ① | **RR-M1**：F2 引入一处**仅在不合法 compose 上可达**的理论假阳性——`ports` 块后跟一个**缩进 6** 的键（如 `labels:`），其下的列表项被误判为 ports 块条目。三 head 对照：`base` `bc7afc5` exit=0、`2cbfe97` exit=0、`9b6e6e1` exit=1 | **裁决不修**（见复核 §8 RR-M1）：合法 compose 服务级键一律缩进 4 ⇒ 该形状不可达；方向是 fail-closed（多报非漏报）；改它属**另一起「扩守卫」决定**。复核给的可选修法（`inPorts` 为真时，缩进 ≥6 且非列表项/注释/空行的行 ⇒ 终止块）**未写码验证** ⇒ 谁做谁走「改守卫 = 测试 + 独立评审」的完整流程 |
| ② | **RR-M3**：非 6 缩进条目落在**受管服务**上时，判据 b 多报一条**与事实相反**的文案（「服务还在，却一条 ports 条目都没有」——实际文件里有 `ports:` 声明），且排在判据 c 的正确诊断**之前**（m16 形状共 2 处违规） | **裁决不修**（见复核 §8 RR-M3）：净效果本波让这格**变好**（`2cbfe97` 下**只有**那条误导文案）。可选修法（判据 b 在该服务存在 `ports:` 声明时改中性文案，或把判据 c 报错排前）**同理属改守卫，另起决定** |
| ③ | **RR-M2**：复核 brief 的 RR1 格 6 期望与守卫**成文契约**冲突（`ports: []` 与受管服务空块的红是三 head **逐字相同**的既存行为） | 复核裁量**不改守卫**（「只认一种形态、其余 fail-closed」是本守卫核心设计），**改 brief 措辞**——已由协调方在 `task-2-rereview-brief.md` 该格改注为「**非受管服务的空块**」 |
| ④ | **RR-M4 / RR-M5**：PR #164 body §2 旧清单未同步（纯 nit）；`docs/architecture.md` §5.1 未同步 §2 的「无静态门禁」口径 | RR-M4 由**协调方直改 PR body**（不占提交）；RR-M5 本轮落地——§5.1 第 2 条后补半句「该纪律是流程约束，**当前无静态门禁**（见 §2）」。**是消歧不是纠错**：§5.1 原句上下文确在 T4 门的范围内，原句并没写错 |

**第九轮：T3 评审带回的裁量（2026-09-22，PR #166 修复波；范文块与接线口径一并登记）**

本轮**未修任何「Critical」级缺陷**——0 Critical / 2 Important / 4 Minor。I-1 修在文件面内（并同步订正本计划 Task 3 的范文块，见下表）；I-2 修法均落在被禁面（单元 A）⇒ 只订正文字 + 钉成 T6 的显式 gate。**评审报告全文**：`.superpowers/sdd/2026-09-22-data-stack/task-3-review.md`（下列每行的「依据」即指该报告的节号）。

| # | 事项 | 裁决与依据 |
|---|---|---|
| I-1 | `metabase` → `metabase-db` 的**就绪竞态**：只有 list 形态 `depends_on`（= 只等容器被启动），无 healthcheck / 无 `condition: service_healthy` ⇒ 空卷首启 initdb 窗口内 Metabase 初始化失败退出，靠 `restart` 反复重启自愈 | **本轮修**（PR #166 第二笔）：照主 compose 既有口径给 `metabase-db` 加 `pg_isready` healthcheck、`metabase` 改 map 形态 + `condition: service_healthy`（`deploy/docker-compose.yml:38-45` / `:68-71` 是形态来源）；**并同步订正本计划 Task 3 的范文块**（`diff` 自证块 ↔ 仓内文件仍逐字一致），防「照抄即复发」。根因=范文块缺这条，不是实施者自创。依据：评审 §0 表 I-1 / §2.8 |
| I-2 | `DATA_WAREHOUSE_URL=…@127.0.0.1:15432/warehouse` **对消费方不可达**：消费方是单元 A 的 `server` **容器**（`modules/data/domain/warehouse.ts:13` 请求期读 env），容器内的 `127.0.0.1` 是自己的 netns；两份 compose 各一个 `default` 网络、无共享 external 网络、无 `extra_hosts` ⇒ Step 4 的「问数链路吃真数据」按现值 `ECONNREFUSED` | **不在 T3 补**——可行修法（`extra_hosts` / 共享 external network / 改消费路径）**没有一条能只靠 `deploy/data-compose.yml` 完成**，且全回环是 B7 强制 + spec §1 安全姿态，改它才是错。⇒ 只订正 `deploy/data-compose.yml:21` 注释 + 本计划 Step 4/Step 6 的注记，**并钉成 T6 的 Step 1 Gate-B**（`nc -zv 127.0.0.1 15432` 预期 refused，三选一需人裁决）。依据：评审 §0 表 I-2 / §2.3 / §6（裁决三条理由） |
| M-1 | data-compose 引入的 8 个 env 键（`PGDUCK_USER/PASSWORD/DB/MEM_LIMIT`、`MBDB_USER/PASSWORD/DB`、`DUCKLE_TOKEN`）**不在 B9 门禁内**（`check-env-example.mjs:51` 的 `SCAN_ROOTS` 不含 `deploy/`、只扫 `.ts/.tsx`），根 `.env.example` 里也一个都没声明（实测只有 `DATA_WAREHOUSE_URL=`）⇒ 键面契约无静态门禁，漏配只会静默落在 `:-` 默认口令上 | **不扩门禁**（守卫面属 T2/守卫本体、`.env.example` 在 W1 归 T4——都不是 T3 的文件面）⇒ 归 **T6 gate**：核对 project env 里 `PGDUCK_PASSWORD` / `DUCKLE_TOKEN` 等已物化为 isSecret（与 Step 2 的物化清单对齐）。**B9 绿与本文件的 8 个键零关系**——别把它读成「env 键面已守」。依据：评审 §3 |
| M-2 | `mem_limit: ${PGDUCK_MEM_LIMIT:-2g}` **无实测注记**（该键是「动态内存收口」的唯一手段，被静默忽略即 spec §9.4「连接数 × 4GB」失控） | **本轮补注释**（裁决「留」不改形态）：`deploy/data-compose.yml` 该行下补「Compose v5.3.0 实测解析进规范模型（2g → 2147483648）；`mem_limit` 属**非 deploy 面**旧键，按 swarm 模型解析的消费方可能不读」；范文块同步。**不改写成 `deploy.resources.limits.memory`**——本仓是单机 `docker compose`（`runtimeMode=docker`），改形态属架构面变更，得先走文档。依据：评审 §2.6 |
| M-3 | `data-compose.yml` **无判据 b** ⇒ 实测「把某服务的 `ports:` 段落删空」**全绿且静默**（主 compose 同形会红）——宿主暴露面有无变成看不出来的事 | **是设计而非漏写**（brief 明写「没有判据 b 兜底」、计划 L40 与 `docs/architecture.md:143` 明写判据 b 只对主 compose 的 `postgres`/`server` 生效、T2 有回归用例钉住）⇒ **如实登记，不修**。方向朝安全侧（撤销暴露面而非增加），与判据 b 的立规理由同源。依据：评审 §1.4 / §1.5（cell C vs cell D） |
| M-4 | 本计划 Task 3 Step 3 的「若因 T5 未合并而 `config` 报错 ⇒ 跳过本步」**预期偏差**：`config` 是纯客户端解析、现场实测 **不会报错**（daemon 未起也 exit 0）⇒ 「compose 语法绿」**不覆盖 build context 是否可用**（`duckle`/`dbt` 两条 build 路径此刻都缺文件，T6 首次 `up --profile etl` 才会撞） | 归 **T6（Gate-A）**：`deploy/duckle/Dockerfile` + `duckle/`（T5）、`dbt/`（T4）必须落仓，**且 T5 的 ENTRYPOINT 必须真的对空 `DUCKLE_TOKEN` 拒跑**（本文件把该安全责任显式转给了 T5）。**本轮不改这句 Step 文字**（属 T6 面）。依据：评审 §0 表 M-4 / §2.4 / §2.7 / §0 Gate-A |
| — | **纪律改进（评审 §7）**：本轮 4 个问题**全部源自本计划的范文块**，而实施者「逐字照抄」在流程上正确、结果上却把缺陷一次搬进仓 | **范文块须附实测/正典出处，或显式标「待验」**（T1 的 pg-duckdb 两处块是正面样板：把实测结论与 open item 都写进块内，故照抄不会错）。**本条为纪律，不改任何代码**；本轮已按此订正 Task 3 块（I-1/M-2 两处）。 |

**第十轮：T4/T5 评审带回的裁量（2026-09-22，W1 收口波）**

本轮性质：**登记 + 口径订正——不改任何代码行为**。W1 的 T3/T4/T5 三笔各自带回「不在自己文件面内」的裁量，本波一次落进正典；两条 Important 的**文件面内**修复已由各自修复笔完成（下表只登记指针），跨任务的部分由本波订正文字。依据全文：`.superpowers/sdd/2026-09-22-data-stack/task-4-review.md`（下称 R4）/ `task-5-review.md`（下称 R5）；实施者侧 `task-4-report.md` §7 / `task-5-report.md` §2.1、§8。

| # | 事项 | 裁决与依据 |
|---|---|---|
| T4 I-1 | 门禁规则②只拦 `::double` 运算符形态，**`CAST(x AS double)` 逃检**（同一坑 #4、同一条类型名查找路径） | **已由 T4 修复笔修**（PR #167 第二笔 `4f039da`；`scripts/check-data-models.mjs` 的 `DOUBLE_CAST_RE` 扩为 `(?:::\s*\|\bas\s+)double\b(?!\s+precision)`）。证据指针：`task-4-fix-report.md` §2.1（**先红后绿**：改前 13 failed → 改后 GREEN）、§2.4（**真仓变异**：5 格逐格转红并逐字节还原）、§4（为何单一正则优于第二条正则）。依据：R4 §0.1 表 I-1 / §RR1.8（探针 G 实测修前逃检）/ §RR5.2。 |
| T4 I-2 | `feat` + `Closes #N` 与「只许 `Refs #150`」的**结构性互斥**未成文；实际命中 **T4 / T5 / T7 / T8 / T9 / T11 六个任务**（任务书列的「T4/T7/T9/T10/T12」**不准确**：T10 是真机验收任务、**不开 PR** ⇒ 不受影响；T5 / T8 / T11 被漏掉；T12 取 `test(...)` ⇒ 豁免） | **本轮修（计划层面）**：① 全局约束 8 补**成文规则**（含「确实需要 `feat`/`fix` ⇒ 必须给该项目**单独开一张 issue**、不能用伞 issue #150、不得用 `skip-issue` 标签绕」）；② 计划里 6 处 `feat(...)`（T4/T5/T7/T8/T9/T11，**共 12 行 = 6 组 commit subject + PR title**）逐处改 `build(...)`。依据：R4 §RR5.2（守卫行为独立实测）/ §RR5.3 / R5 §7.4。 |
| T4 M-1 | 其余 4 条与计划的偏离也没登记进计划 | **本轮登记**——见下面「T4 §7 五条偏离」表的 ①/②/④/⑤ 行（R4 §RR5.1 逐条裁决）。 |
| T4 M-2 | `::"double"`（**带引号**的类型名）同属坑 #4 形态但逃检 | **不修**，已转 **issue #170**。R4 §RR1.8 实测：正则要求 `double` 紧随 `::`，引号挡住了；真实仓无此写法，概率远低于 `CAST` 形态。 |
| T4 M-3 | 单引号字符串 / 双引号标识符里的 `::double` 会**误报** | **不修**：`maskSqlComments` 已声明的边界，方向是 **fail-closed**（多报非漏报）；改它属「扩守卫」另一起决定。依据：R4 §0.1 表 M-3。 |
| T4 M-4 | `dbt/README.md:96` 给 T6 的「并入 `marts/schema.yml`」核对步**判据不全**（该文件的字段形状不是 dbt 的 `metrics:` 规格） | **不修**（`dbt/**` 本轮只许做规则② 的注释同步）；R4 §RR5.1 ① 独立找到「字段形状不是 dbt metrics 规格」这条更硬的判据。 |
| T4 M-5 | `task-4-report.md` §5.2 把 fixture 的 `::double precision` 反面对照写成「已在真仓生效」——真仓 `dbt/` 里**没有**该写法（措辞不精确，代码无问题） | **不修**（报告侧文字，非仓内文件）；如实登记。 |
| T4 M-6 | `apps/server/.tmp-loader-fixtures/`（另 `-d9`）未被 `.gitignore` 忽略；PR #168 也没补 | **本轮修**（见 `.gitignore` 的实测形态与双向自证）。 |
| T4 M-7 | `modules/data/routes/query.test.ts` 单独跑 4060ms vs 5000ms 默认超时——边缘 flake 的机制证据，**非 T4 引入** | **已并入 issue #169**（本机负载下测试超时抖动）；不修测试、**不动任何超时值**。 |
| T4 M-8 | 规则②③每文件只报**第一条**命中（`firstMatchLine`）⇒「N 处违规」不是命中数；OK 行的计数面与违规检查面用的文件过滤器不同 | **不修**（行为不变）；登记为已知边界。依据：R4 §0.1 表 M-8。 |
| T4 观察 | `::timestamptz` 的语义依赖会话 `TimeZone`（`stg_lemeng_retail_detail.sql`） | 登记：**T6 核对时显式钉时区**。依据：R4 §0.1 表末行。 |
| T5 I1 | 入口闸白名单**过宽**：7 个动词可执行「非离线」工作（跑管线 / 读活源 / 重建环境 / 改活库），与闸**自身声明的不变量**直接矛盾 | **已由 T5 修复笔修**（PR #168 第二笔 `4ede4de`：六个动词 `sequence`/`deliveries`/`work`/`drift`/`branch`/`python` **移出**白名单 + `review` 改 `--data`/`--drift` **条件判定** + 删掉「每个都是引擎自陈无凭据无网络」的**普适断言**改逐条事实）。证据指针：`task-5-fix-report.md` §2（动词级对照）、§3（**先红后绿** 39/51 → 51/51 + **变异 28 条转红**）、§4（注释订正逐条引二进制原文）、§5（**主威胁防线未破**自证）。依据：R5 §0 表 I1 / §3.5。 |
| T5 I2 | ZOS「能力空白」**旧口径仍留在正典**（计划 4 处 + spec 2 文件 3 处），而 T6 的作业输入正是其中一处 ⇒ T6 会按旧稿重推错误结论 | **本轮修（计划层面 4 处 + grep 连带 1 处）**；spec 处**不追改**（历史快照）。落点见本节末「B 节落点」。依据：R5 §0 表 I2 / §5.1–5.4。 |
| T5 M1 | token **纯空白**（`"   "`）被放行 | **不修**（`deploy/duckle/entrypoint.sh` 非本轮落点，且属「扩闸」另一起决定）；T5 修复笔的用例集已把它**如实编码为「期望=现状」并标 `[M1 未修]`**，既未掩盖也未删条。依据：R5 §0 表 M1 / `task-5-fix-report.md` §3.1。 |
| T5 M2 | T4 交接第 4 项 `apps/server/.tmp-loader-fixtures/`（`pnpm test` 会生成）未补忽略 | **本轮修**（见 `.gitignore`）。 |
| T5 M3 | `--workspace` 引擎默认值 = **管线文件父目录** = `/pipelines`（**只读**挂载）⇒ 漏写即**运行期写失败** | **本轮钉成 T6 的 Gate-C**（Task 6 Step 1 第 8 项：本波所有 duckle 作业必须显式传 `--workspace /workspace`；Step 5 的核对步另按评审的反向验法**故意不给一次**、确认确实报写失败，并把警示补进 `deploy/duckle/README.md` §5）。依据：R5 §4 的 M3（评审明标这条**实施者无法自验**）。 |
| T5 M4 | 「元 schema 表达不了」的清单实为 **6 条**，第 6 条（分区键列不得 `nullable = true`）未登记进「两处必须同步」的那两份清单 | **已由 T5 修复笔修**（PR #168 第二笔）：`task-5-fix-report.md` §6.1（两处清单机器比对 **True**，6 条逐字一致）+ §6.2（真校验器复跑 **18/18 拒 + 8/8 过**；第 ⑥ 条探针「被放行」正是「表达不了」的机器实证）。依据：R5 §0 表 M4。 |
| T5 M5 | 类型枚举与 spec 记录的补救口径不一致（spec 写 `numeric`，枚举里没有）；`float` 作 `double` 替代品是**变窄**而非等价 | **登记待议，不修**：spec 是历史快照（不追改），类型枚举属 T5 的文件面、改它需另起决定。依据：R5 §0 表 M5。 |

**T4 §7 五条偏离逐条登记**（出处 `task-4-report.md` §7；裁决见 R4 §RR5.1）：

| # | 偏离 | 裁决与依据 |
|---|---|---|
| ① | L1 语义声明落 `dbt/semantics/l1_metrics.yml`，不在计划 Step 4 写的 `marts/schema.yml` | **可接受（本轮登记）**：门禁**两处都扫**（`dbt/semantics/**` 与 `dbt/models/**`）⇒ 两种落点都不漏检；另有一条更硬的独立理由——`marts/schema.yml` 的字段形状**不是 dbt 的 `metrics:` 规格**（同 T4 M-4）。该文件里已有指向它的注记。 |
| ② | 两个时间列各自定型，**不做**范文块的 `coalesce` | **可接受，且偏离是对的**：范文把「交易时间」与「业务日」两列两种语义 coalesce 成一个字段 ⇒ 同一行两个值都在时后者不可见 = **静默丢一半信息**，与坑 #3 原文（「同一张表里两个时间列两种格式」并列陈述）冲突。已在 `stg_lemeng_retail_detail.sql` 与 `dbt/README.md` §3 标为有意偏离。 |
| ③ | 提交/PR 类型用 `build` 而非计划 Step 6 的 `feat` | **必须修（计划层面）⇒ 本轮已修**（见上 T4 I-2）。`build` 是本仓**唯一可行**的类型选择；`skip-issue` 标签虽能豁免但语义不对（那是给紧急热修的口子）。 |
| ④ | `ci.yml` 注释「五个守卫」→「六个守卫」（两处） | **可接受**：加一行 step 就必须同步这处口径，否则文件头注释当场过期；属「本任务需要的那一行」的连带（**未碰任何 step 逻辑**）。 |
| ⑤ | 门禁必填字段取 Step 4 的**完整清单**（`name`/`expression`/`grain`/`owner`/`tier`/`definition`），非 Step 5 括号里简写的四字段 | **可接受**：计划**自身**矛盾（Step 4 明写六项、Step 5 ⑤ 简写成四项）⇒ 取更全的那份是对的（`expression` 是「口径本体」，缺了声明无法复算），**取全 = 取 Step 4 的正典**，不是自选。 |

**两条 issue 的指针**（本波开的，供后续波次取用）：**#169** = 本机负载下测试超时抖动（迁移 advisory lock 2s 重试 vs vitest 5s 默认超时，`modules/data` 在高负载下每次命中不同用例；T4 M-7 并入）；**#170** = 门禁规则② 的残余逃检面 `::"double"`（T4 M-2）。
⚠️ **#169 的描述已在第十一轮升级**：W2/W3 波它**首次打红了 CI**（不再只是「本机」现象）——以第十一轮为准。

**B 节落点（ZOS 旧口径订正）**——5 处，**按位置点名（不写行号：本计划后续编辑必然漂移；复核用 `grep -n "能力空白\|403\|直写"`）**：① 全局约束 15「先查再动手」；② Task 5 Step 2 的 `duckle/README.md` 已知事实句；③ **Task 6 Step 5 的 duckle 核对步（按 `自检纪律` 第 5 条做的 grep 连带项**——原文「验证 ZOS 直写是否仍 403」本身就带旧口径的预设）；④ 附录「与本计划相关的已知坑」表的那一行；⑤「有意的取舍」的 duckle 段。防呆 gate = **Task 6 Step 1 第 9 项 Gate-D**。
**spec 侧指针（仅点名，不追改）**：`docs/superpowers/specs/2026-09-20-data-stack-module-design.md:526–527` 与 `docs/superpowers/specs/2026-09-15-aftersales-module-design.md:166` 的「duckle s3 sink 能力空白」句**已被本波取代 —— 以本计划为准**。spec 是「当时怎么定的」历史快照，按本仓既有纪律**不追改**（处置同第六轮 #3）。

**两个取舍的裁定记录（开工前扫描，均维持，已写进「有意的取舍」节）**：
- **取舍 A 维持**——facade/治理归 P2：与 spec §11.8 分期表逐字一致（issue #150 的平铺清单无分期语义）。
- **取舍 B 维持**——不建第二数据模块、全扩 `modules/data`：扫描实测风险为低（manifest 约 13→19 条无结构性问题；报表页签走单一 frontend 入口不触 registry 面；零新权限码；只碰 `data.*`）。

**第十一轮：W2/W3 五笔带回的评审裁量与修复（2026-09-22/23，W2/W3 收口波）**

本轮**登记 W1 之后的五笔（W2/W3）**：评审结论、修复笔、合并 SHA 与遗留项。**只有这五笔进表**——W2g 的 T10 与 W3g 的 T13 是**操作者任务、不开 PR**（见「波次与依赖」节末那句注：gate 波不 `worker-start`），其真机结论按计划各自归 T13 与 T6。性质同第十轮：**登记 + 口径订正——不改任何代码行为**。五笔**全部**走「独立评审 → 修复笔 → 合并」，下表按**合并先后**排（= 下表的行序）。**「修复笔 SHA」是分支侧 commit**——PR 走 squash 合并 ⇒ 该 commit **不在 main 的历史上**（内容在），引它作「这笔改了什么」的指针，体例同第七/十轮。依据全文：`.superpowers/sdd/2026-09-22-data-stack/task-{7,8,9,11,12}-review.md` 及配套的 `task-*-fix-report.md`、`task-*-report.md`。

| # | 事项 | 裁决与依据 |
|---|---|---|
| T7 | 报表 facade + 登记 + 看板页签 | 评审 **0 Critical / 2 Important / 6 Minor**。**I-1 跨租户 Metabase 命名空间共享**——两个 org 的同名 title **共用同一张 dashboard** ⇒ B 可覆盖 A 的 `embedding_params`、**B 的 DELETE 会归档 A 的报表** ⇒ 修复笔 `dc8c355` **结构性消除**（Metabase 侧身份按 org 命名空间化为 `<org>/<title>`，查找 / 创建 / 发布 / 归档**四处口径一致**）。**I-2 `reconcile` 的 `unregistered` 按名求差 ⇒ 多租户下恒假阳性（报假绿 `ok:true`）**（spec §7 的目的被绕过）⇒ 换成「**不属于任何 org 的 `metabase_id` 才算未登记**」并两分为**可自愈 / 需人看**，另补 reconcile 回读断言 `embedding_params.tenant = locked`。合并 `52628a9b`（PR #172）。依据：`task-7-review.md` §0 / §RR1–RR2、`task-7-fix-report.md` |
| T11 | 每租户 schema + 凭据收紧 + 启用集对账 | 评审 **0C / 3I / 8M**。**I1 派生非单射且无人检测**——`Acme-Org` 与 `acme-org` 归一到同一 schema 时对账报 **clean / exit 0**，**正是本脚本存在意义的反面**（静默串租户）⇒ 新增 `collisions` 桶（同名组含多 org ⇒ 逐条报出 + `clean=false` + exit 1）。**I2 对账只覆盖 schema + role、对凭据面全盲，且凭据段失败不回滚前段 ⇒ 失败残留恰落在对账的绿区** ⇒ provision 模板**整份事务化**（失败 = 无残留）。**I3 spec §11.2 #6「每租户一桶」在实现里降级为「共享桶 + 前缀 `SCOPE`」且报告未点名** ⇒ 见下方 issue **#175**。另有 M3：口令的**日志面**如实声明（缺省配置下**失败**的那条改口令语句就带明文进服务端日志）。合并 `28f37790`（PR #173）。依据：`task-11-review.md` 结论摘要表、`task-11-fix-report.md` |
| T12 | 串租户回归套件（含缓存重放） | 评审 **1 Critical / 5 Important**。**C1 编排层无回归保护**——四个判定函数各自**都有牙齿**，但把面③或面④**整段从 `runSuite` 摘掉 ⇒ 34/34 全绿**，而**出口码只由那一层决定** ⇒ 补**编排级用例**（删任一面即红）。**I1 出口码把「判据不成立」误分类成「跑不起来」**——真机 `/query` 的 `denied` 是 **403**、`error` 是 **502**，被 `callJson` 非 2xx 一律抛成 **exit 2**，且**面②③④被整段跳过** ⇒ 403/502 交判据层 + 面级打散。**I2 空集静默空转**——`E2E_METRIC_ID=,` 经 `splitList` 成空集 ⇒ 整面不跑，而**输出读起来像「已验证」** ⇒ 空集 exit 2。**I3 四条判据分支被邻居分支遮蔽**（停用后全绿）；**I4 面② 的判据打在仓内正典两次点名「不可观测」的嵌入页正文上** ⇒ 改打计划指名的数据 API；**I5 面③ 的 `limit 0` 在 PG 语义下不执行扫描** ⇒ 改 `limit 1`。合并 `dbd80822`（PR #177）。依据：`task-12-review.md` 结论摘要表、`task-12-fix-report.md` |
| T8 | L2 配置层（定义权下放） | 评审 **1 Critical / 2 Important / 4 Minor**。**C1 消费通道词表未合并**——`/query`、MCP `tools/list`、chat 三条通道仍用只回本 org 的加载器 ⇒ **平台 L1 指标在三条通道上全部不可达**，而 `GET /metrics` 用的是**合并词表** ⇒ **同一 id 在两条通道上胜负相反**（与本 PR 自己写进 README 的不变量直接矛盾，且 **CI 结构性不可见**）⇒ 三条通道统一到单一落点 + **来源守卫**（四通道一致性断言 + 正则断言）。**I1 `--check` 不存在且未知 flag 被静默忽略 ⇒ 打了 `--check` 实际向真库物化**（评审**在真库**复现）⇒ 实现真 dry-run + 未知 flag 响亮拒绝。**I2 UI 未做真实浏览器自验**（该页已从只读改成**写入表单**）⇒ 补 CDP 走查。合并 `26fefcb9`（PR #178）。依据：`task-8-review.md` §0、`task-8-fix-report.md` |
| T9 | 治理四机制收口 + 门禁覆盖 L2 | 评审 **0C / 3I**。**I-3/I-4/I-5 = `dbt/README.md` §11 的三处命令错误**（`--profiles-dir` 指向只有 `profiles.example.yml` 的仓内目录；对 `materialized='table'` 的 marts 调 view-only 的 `pg_get_viewdef`；parquet 路径丢了 `lemeng/` 段且把叶子文件 `all.parquet` 写成 `<日期>.parquet`）——**离线可判、且 §11 与 §10 自相矛盾**；**M-2 目录递归 SQL 只按 `relname` join ⇒ 多租户下跨 schema 笛卡尔扇出**（本仓多租户正是「同一模型跑 N 次、模型名完全相同」）⇒ 已在本 PR 内订正（T9 修复笔 `489e0f2`）。**I-1 规则⑧是标记级文本比对、不是行为断言**（构造「编译器行为变了而标记未变」的改动时**假绿**，被 `semantic-compiler.test.ts` 兜住）⇒ 本轮只做**如实披露** + 登记为后续加固。合并 `dbf62d86`（PR #179）。依据：`task-9-review.md` §0、`task-9-fix-report.md` |

**评审交叉验证的正面事实（T8）**：T8 评审**用 openship MCP（未裸 SSH）独立复现**了 T8 的存量核对结论——主实例 `data.metrics` **0 行**、山海实例**无 `data` schema** ⇒ 计划风险登记里「存量会被 `default 'l2'` 静默改标」的前提**与实况不符**，本轮**不存在**该风险。

**本波四条 issue 的指针**（本波开的，供后续波次取用）：

- **#169**（本机负载下测试超时抖动）——**描述升级**：本波它**首次也打红了 CI**（PR #172 的 `unit` job 命中 `agent-loop.test.ts` 的 5000ms 超时 ⇒ `mergeable_state=unstable` ⇒ 按纪律**不强合**、重跑 CLEAN 后才合并）⇒ 第七/十轮写的「**只在本机**」**已不准确**。根因（**迁移全库 advisory lock 的 2s 重试 vs vitest 5s 默认超时**）不变，但影响面已从「本地开发信号」扩到「**CI 判定信号**」；处置口径**未变**：**不调大全局 `testTimeout`**（那是把红改成绿）。
- **#174**：租户隔离的**承重点未验**——`scope` 作 `USER MAPPING` 的 OPTION **无上游依据**；**T13 必须回读 DuckDB 侧 secret 的 `scope`**（只验「DDL 没报错」不够）。
- **#175**：spec §11.2 #6「**每租户一桶**」在实现里降级为「共享桶 + 前缀 `SCOPE`」⇒ **需人裁决**（两条路的代价对比已在 issue 里）。
- **#176**：L2 落地暴露的**两处计划缺口**——① dbt marts **缺 org 列**（会让 T6 的「问数链路吃真数据」验收**必然失败**，**须在 T6 之前收口**）；② 仓内**无平台超管 signal**（拍板 #5 的平台侧**无门可落**）。本轮按 **fail-closed** 先行（只实现租户 `data:manage` 管本 org 的 L2；`org='platform'` 的写入**不开口**）。

**本波教训（三条通用）**：

1. **「某一条通道接对了」≠「所有通道都接对了」**：本波三次 Critical/Important（**T12 的编排层**、**T8 的三条消费通道**、**T9 的 §11 命令**）**是同一形状**——判定逻辑写对了，但**接线 / 落点没到处改**。⇒ 任何「统一口径」类改动，**落点清单必须是所有消费方**并**逐条断言**，且要有一条**跨通道一致性的机器判据**（否则 CI 结构性看不见）。
2. **「静默空集」是独立的假绿类**：一个非空字符串（**一个逗号**）过了必填闸门、解析后却是空集 ⇒ **整面空转**，而输出读起来像「已验证 0 项」。⇒ **空集一律响亮失败。**
3. **不采信自陈（协调侧同样成立）**：T8 实施者自陈「已实现 `--check`」，评审**在真库**证明它不存在且会写库。⇒ 协调方当时已据该自陈写进 T9 任务书，事后订正为「**先实测四条性质、再围绕它搭门禁**」。**派发材料的每一句自陈都要有独立复核路径。**

**第十二轮：方案整理轮（2026-09-23，docs 型一笔 PR；`type=chore`，PR 标题/body 见报告）**

本轮性质：**口径整理 + 旧口径清理**，**不动任何代码逻辑**——唯一的功能面改动是
`deploy/data-compose.yml` 的 `pg_duckdb` **image 行**（`ghcr.io/…` 自建 tag → `pgduckdb/pgduckdb:18-v1.1.1`）
与相邻注释；`deploy/pg-duckdb/Dockerfile` 与 `.github/workflows/pg-duckdb-image.yml` **只改注释**。
**职责边界正典落在 `docs/architecture.md` §2.2（新增「数据栈组件分工」）与 §6.1（订正指针）**——
本计划只做「同步 + 落点 + gate」，**不复制 §2.2 的正文**。

| # | 旧口径（原文怎么错的） | 本轮订正（落点） |
|---|---|---|
| 1 | **pg_duckdb 走「自建镜像」**（钉 DuckDB v1.5.5，理由是 ossie 只发到 v1.5.5）——散在计划头部/Tech Stack/约束 10/Task 1 全文/Task 3 范文/T6 前置/`data-compose.yml`/`deploy/pg-duckdb/**`/workflow | 改**官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`；自建**降为「未启用（备件）」保留不删**。依据三条（ossie 出局 / 配对实测 8 处 API 断裂 / Docker Hub 实测可拉）见「本轮订正」A1。落点：计划头部与「本轮订正」A1/A2、约束 10、Task 1 头部+Interfaces+范文头注+Step 4 标记、Task 3 Consumes+compose 范文、T6 Step 1 第 1/6 项、波次表 W0/W1g、派发块 W0、外部输入①、文件表、附录、取舍条；`deploy/data-compose.yml`、`deploy/pg-duckdb/README.md`（§0/§2.2/§5.1/§5.2）、`Dockerfile`、workflow |
| 2 | **Ossie 仍在口径里**：语义暴露「经 dbt 原生支持」、AI 走 `duckdb-ossie` MCP（两条 AI 通路）；两个「仍开放项」 | **A3：Ossie 本轮不采用**（观察项）——单一受管入口，理由=两条通路两套词表两套权限是治理反模式。落点：计划头部/架构/口径表 #2/#3/「仍开放项」/A5 表、`docs/architecture.md` §2.2 末注 |
| 3 | **DuckDB 版本锁死 v1.5.5**（并被 duckle Dockerfile 范文继承为「与 pg_duckdb 内核对齐」） | pg_duckdb = 官方镜像（上游自陈配对 = **DuckDB v1.4.3**）；**duckle 的 DuckDB 由它自己的传递依赖独占决定**（`duckle==0.7.3` ⇒ `duckdb-cli==1.5.4`；手钉 1.5.5 = `ResolutionImpossible`），**两者不做对齐**。落点：约束 10、Task 5 Step 3 范文（**已删，见 #6**）、`deploy/pg-duckdb/README.md` §0/§2.2 |
| 4 | **L1 存储格式 =「Ossie JSON」**（spec §11.2 #4）——与仓内实际（dbt YAML）不符 | **事实源 = dbt YAML**；**订正指针**落 `docs/architecture.md` §6.1 与本计划「本轮订正」A5（**spec 正文不追改**，历史快照） |
| 5 | **`contracts/` 的机器面定位**（「落盘前按契约校验」，隐含一个从未存在的独立校验器） | **降级为「人写的意图源」**，机器面改用 **duckle 自己的声明与门禁**（`node.data.schema` + `qa.contract` + `drift`）。落点：`contracts/README.md` §10（新增）+ §4.3/§8、`duckle/README.md` §7、`docs/architecture.md` §5.1 第 2 条 |
| 6 | **T5 的 duckle Dockerfile 范文与交付物有四处实质差异**（其中 `DUCKDB_VERSION=1.5.5`、curl+unzip 单下 DuckDB 两处是旧口径） | **范文块整块删除**，只留「正典是仓内文件」的指针 + 四处差异摘要——**防「照抄即复发」**（本仓已知复发坑）。落点：Task 5 Step 3 |
| 7 | **W4 不存在**（duckle 只被当 ETL 执行器，其漂移/契约/血缘/新鲜度能力未进计划） | **新增 W4 + Task 14**（落点分工 / 三坑成纪律 / 未验项进 gate / 接入方式=job 带 token 不放宽闸 / C6 wheel 订正），并进波次表；`duckle/README.md` §7 与 `deploy/duckle/README.md` §8 落正典 |

**第十二轮 grep 复核（自检纪律第 5 条，实测供 reviewer 复核）**：

- **`ossie` / `Ossie`（本计划）**：命中**全部**落在「**订正语境**」——「本轮订正」A1/A3/A5、口径表 #2/#3、
  「仍开放项」（已消解）、约束 10 的删除线、Task 1 头注/范文头注、Task 5 Step 3 的差异摘要、
  第一轮 #5 的追记；**唯一**非订正语境是 **L752** 的「先检索 WeKnora《duckdb-ossie 全链路 PoC》条目」
  ——那是**经验库条目名**（该 PoC 在本轮之前做过，条目仍在库），**保留**。
- **`v1.5.5`（本计划）**：命中分三类——① **订正语境**（A1/#1~#3 各订正行、Task 1 Interfaces/风险条、
  T6 第 6 项、附录、取舍条）；② **备件工件自身的版本**（Task 1 范文 `ARG DUCKDB_VERSION=v1.5.5`、
  workflow `tags:`、§0 的 tag 公式例）——**备件保留，README/workflow/计划三处均已标「未启用」**；
  ③ **历史轮次记录**（第四/五轮与 L269 Step 4 commit message）——按本计划既有体例
  （「执行步骤类文字按快照保留」）**原样留**。
- **`Ossie JSON`**：本计划内**已无**（原 spec §11.2 #4 的写法）；只在「本轮订正」A5 的**对照列**里
  作为「旧口径」出现，与 L1 = dbt YAML 并列。`docs/architecture.md` §6.1 同形。
- **`自建镜像` / `自建`（本计划）**：命中分四类，**逐类可解释**——① **订正语境**（「本轮订正」A1/A2、
  口径表 #2/#3、约束 10 删除线、Task 1 头部与 Interfaces/风险条、Task 2 §1 与 §2 的删除线、
  外部输入①、波次表 W0、附录、取舍条）——**已明标取代**；② **备件工件自身的名称**（W0 标题、
  Task 1 标题、Task 1 的 `Dockerfile`/workflow 范文头注）——**均在标题或紧邻处标「未启用（备件）」**；
  ③ **已完成的历史命令**（L410/L411 的 commit message 与 PR title，PR #162 已合并）——按快照留；
  ④ **W4 里的「仍需自建」**（输入指纹、`pipelineHash` 那条）——**指自造能力，与镜像无关**。
  ⇒ **无一处仍把自建镜像当作在跑的部署路径。**

**第十三轮：T6 真机收尾轮（2026-09-23，`type=fix` 一笔 PR；main 红根因 + #184 + T6 现场修正登记）**

本轮性质：**登记 + 回填**——把 T6 部署期的现场修正与 gate 销账落回仓库（本 PR 四件：两个 dbt 模型的
Jinja 注释修复、`deploy/dbt/Dockerfile` 版本配对订正、`deploy/customer-onboarding.md` 阶段 5 的
openship services 模式三坑登记、计划 T6 gate 销账与本轮登记），外加 main 红根因与 #184 的正式登记。
**不动产品代码。**

| # | 事项 | 登记与依据 |
|---|---|---|
| 1 | **main unit 连红的根因坐实（#185）+ 修复（#186）** | main 的 unit job 自 `dbf62d8`（2026-09-22 16:05Z）起连红，失败集中在 `modules/data/routes/metrics.test.ts` 且**条数随运行变化**（竞态签名）。根因（#185，诊断报告 `main-red-diagnosis.md`）：`metric-store.test.ts` 的 `deleteStaleL1Metrics` 用例把平台桶里不在 keepIds 的行**全删**——含**并行兄弟文件正在使用的 L1 夹具**（兄弟随后 `400 L1_BASE_NOT_FOUND`）；引入者 #178（潜伏竞态，#179 换耗时分布后爆发；#179–#181 的 diff 未碰 `modules/data`，不是它们的回归）。修复 #186（`9b30e62`，2026-09-23 合并）：keepIds 并入兄弟夹具 id、断言一字未改；`modules/data` 全量（全新空库）19 files / 211 tests 全绿。**#169 根因订正**：诊断中 `mcp.test.ts` 仍偶发 5000ms 超时——advisory lock 抖动与本次连红**并存但不同源**，main 连红不归 #169。 |
| 2 | **#184 合并（`e8cc18a`）——三条裁决进正典** | ① Gate-B 裁决（共享 external network `openship-platform-core-shanhai` + `DATA_WAREHOUSE_URL` 服务名形态）落计划 T6 Step 1 第 7 项与 `docs/architecture.md` §2.2；② #175（scope 先验后裁）进 T13 核对清单；③ #176b（平台级 L2 写入不开口）进「已知边界 / 分期项」节。另含 duckle Dockerfile 注释前提订正与 T6 gate 增补（Gate-E / 外部输入② / #182 登记）。 |
| 3 | **T6 部署期现场修正（= 本 PR 四件）** | ① 两个 dbt 模型（`stg_lemeng_retail_detail.sql` / `fct_retail_sale.sql`）的 Jinja 注释修复——config 块内混 SQL 注释行致真 dbt 1.9.1 parse 报 `expected token`，注释移到块外（文字保留）；② `deploy/dbt/Dockerfile` 版本配对订正——PyPI 实测 dbt-core 1.9.x 发到 1.9.9 而 **dbt-postgres 1.9.x 只到 1.9.1**，1.9.8 配对不存在（构建必挂）⇒ ARG 默认钉 **1.9.1**；③ `deploy/customer-onboarding.md` 阶段 5 登记 openship services 模式三坑（相对路径 bind 被 400 / pgduckdb PG18 数据目录挂载约定变更 / services-sync 写入的 environment 不解析 `${VAR:-default}` 模板——2026-09-23 shanhai 真机）；④ 计划 T6 gate 销账（Task 6 Step 1 销账块，含外部输入③④⑥）+ 本轮登记。 |
| 4 | **悬而未决一条：openship 部署拉镜像对慢代理静默失败** | 症状：「Pulling image」无报错但服务 failed——拉取慢/失败**不响亮**。**已由智能代理修复根治**；但「**部署依赖镜像已在本地**」这个前提值得记进 onboarding（阶段 1 的预拉镜像清单或需扩到数据栈镜像）——**未落**，留 onboarding 下一笔。 |

### 有意的取舍（reviewer 请过目）

- **不新建第二个数据域模块**（报表/L2/治理全部扩 `modules/data`）：spec 写作时 `modules/<id>` 未定 id 且当时 `modules/data` 尚不存在；#146 落地后授权核心/词表/审计/通道都在 `data`，另起模块 = 授权逻辑第二份或跨模块端口，违反「授权核心单实现」的既定约束。**这是 spec 未显式裁决的落点选择，按最低摩擦 + 复用既有正典取的，请 reviewer 确认。**
- **Metabase 版本锁 v0.63.18.1（非 LTS v0.58）**：PoC 全链路实测版本；spec §6.6 的 LTS 口径是版本纪律的来源，但 0.63 已实现 OSI `ai_context`（spec §9.6 记录）且是实测通过组合。升级窗口与频次归 runbook，不在本计划拍。
- ~~**pg_duckdb 镜像走 GHCR + 目标机本地构建双路径**：私有化客户机未必有 GHCR 凭据，Dockerfile 在仓即「任何机器可复现」；GHCR 是 SaaS/自用的便捷面。构建频率（§11.9 #4）维持开放：dispatch-only。~~
  ⇒ **2026-09-23 订正（取舍已变，理由记全）**：**改走官方镜像** `pgduckdb/pgduckdb:18-v1.1.1`
  （Docker Hub）。**自建与 GHCR 双路径保留为「未启用（备件）」**——不是「自建没价值」，而是
  **它的成立前提（ossie 要来）没了 + 自选配对实测编译失败**；「私有化客户机未必有 GHCR 凭据」
  这条**原来的优点现在由 Docker Hub + 目标机代理**承接（**实测可拉**）。
  构建频率开放项**随「未启用」消解**（见「本轮订正」A1/A2、`deploy/pg-duckdb/README.md` §5.1）。
- **duckle 在 v1 只交付骨架与 runner 镜像，不交付可跑管线**：duckle→ZOS 直写**在本仓尚无复现结论**——经验库 2026-09-17 有 `snk.minio` 可直写的**真机实测**（第十轮 B 节），但那是经验库所在部署面的复现、**不是本仓/本部署面的**（复现归 T6，见 Task 6 Step 1 的 Gate-D）；在拿到**本部署面**的「直写可行或替代路径」结论前写「可跑管线」是编造。⚠️ **旧口径写的「已记录的能力空白」已被取代** —— 本条**结论不变、理由换了**；闭环数据源用存量乐檬 parquet（拍板 #1 本就不重落盘）。新源（抖音）接入是 data-platform 标准的 SOP 事件，不在 #150 的 P1 出口里。
- **T12 缓存重放断言保留但依据重写**：spec 验收 #2 的 cube 缓存 key 论据随 Cube 否决失效；Metabase 结果缓存是否把 A 的卡数据重放给 B 是**未验证的真实风险**，测试保留并以 Metabase embed API 为反向验面——真机结论（T13）无论红绿都沉淀 WeKnora。
- **facade/治理归 P2（不提前到 P1）——开工前扫描裁定：维持（2026-09-22，经扫描确认）**：与 spec §11.8 分期表逐字一致；issue #150 的平铺清单无分期语义，不构成把 facade/治理提前进 P1 的依据。
- **「不建第二数据模块、全扩 modules/data」——开工前扫描裁定：维持（2026-09-22，经扫描确认）**：扫描实测扩面风险为低——manifest 声明约 13→19 条无结构性问题（装载期双向核对照常兜底）；报表页签走单一 frontend 入口、不触模块 registry 面；零新权限码（复用 `data:manage`/`data:query`）；B1 面只碰 `data.*`。上方首条取舍的落点由此坐实。
