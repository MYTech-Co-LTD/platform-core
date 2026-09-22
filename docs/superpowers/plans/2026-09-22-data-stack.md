# 数据栈 P0–P3 落地（duckle ETL + dbt + Ossie 语义 + pg_duckdb + Metabase，issue #150）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把两份 spec（选型定稿 + 七层分层）已拍板的数据栈按 **P0→P3** 落进仓与真机：P0 自建 pg_duckdb 镜像固化成 CI 构建；P1 数据面仓内工件（`deploy/data-compose.yml` / `duckle/` / `dbt/` / `contracts/`）+ 私有化单租户全链路闭环（乐檬 parquet → dbt staging/marts → Metabase 可见）；P2 Metabase 报表 facade + 报表登记 + L2 定义权下放 + 治理四机制；P3 SaaS 多租户（每租户 schema + 凭据收紧 + 串租户回归）。

**Architecture:** 数据面是**仓内工件 + 拆缝部署单元**（`deploy/customer-onboarding.md` §1 目标形态）：`deploy/docker-compose.yml`（部署单元 A，平台宿主）**不动**；数据栈全部服务进 `deploy/data-compose.yml`（部署单元 B，另一 project，全内网，端口全回环）。语义事实源 = **dbt YAML**（进仓库，是产品；引擎只当编译产物——spec §11.7），Ossie 暴露走 dbt 原生支持（拍板）。平台侧身份/权限/登记/治理全部落在 `modules/data`（**不新建第二个数据域模块**——#146 已交付授权核心 `domain/authz.ts` + 词表 `data.metrics` + PAT + 统一审计，P2/P3 是它的扩面，复用同一条鉴权链）。Metabase 那条连接是**跨租户能力**（spec §11.3.1 安全论断）⇒ AI 建报表必须经平台 facade，凭据只在服务端 env。

**Tech Stack:** 数据面：pg_duckdb 自建镜像（DuckDB **v1.5.5**，spec §11.2 #3）+ Metabase OSS（**v0.63.18.1**，PoC 实测版本）+ dbt（postgres adapter 打 pg_duckdb 端点）+ duckle headless runner（二进制容器化）。平台侧：TypeScript / Hono / pg / zod / jose（嵌入 JWT 签名）/ vitest；守卫脚本 `scripts/*.mjs`（checkJs）+ `*.test.ts` fixtures。

**Spec:**
- `docs/superpowers/specs/2026-09-20-data-stack-module-design.md`（选型定稿 §11，2026-09-20 用户确认；§5/§6 的 Cube 内容是**技术记录非推荐路线**）
- `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（七层 + §10 ✅ 拍板记录——**六项裁决已销账，是最新口径**；与 §7 硬约束清单冲突处以拍板记录为准）

**编排侧材料（未进仓，派发 spec 里随附）**：裁决全文 `ledger-fixes.md`「#150/#151 启动前裁决」+「#150 点火前置全清」节（2026-09-22，含 dp-lab 已拍删除）；决策材料 `issue-150-decisions.md`（B7 前置的证据：`docs/architecture.md:121` + `scripts/check-compose.mjs:50`）。两者在编排者 worktree 本地（`.superpowers/sdd/` 不受 git 跟踪）——worker 看不到时找编排者要，别按本计划的转述二次脑补。

---

## 已拍口径（2026-09-22 全部人已拍——实施者不得重开）

| # | 拍板 | 落在本计划哪 |
|---|---|---|
| 0 | **dbt 进主干** = 对 09-20 定稿 §11.1 的生效扩展（定稿生效、dbt 提前） | T4 dbt 项目是 P1 主工件之一 |
| 1 | **定型在 dbt staging**：存量乐檬 parquet（VARCHAR）**不重落盘**，`stg_*.sql` 手写 cast，cast 正确性靠 dbt tests / 对账断言兜；「落盘即定型」收窄为**新数据源接入尽量在落盘侧做对** | T4（staging cast + 对账 singular tests）、T5（contracts 新源契约） |
| 2 | **语义事实源 = dbt YAML**；Ossie 暴露经 **dbt 原生支持**（拍板人裁定：此前材料假设的自建 YAML→引擎格式转换层代价不成立）；事实源纪律仍守 §11.7（引擎只当编译产物） | T4（schema.yml 语义声明）、T8（L1 物化） |
| 3 | **问数入口 = OpenClaw → 平台 MCP**（已随 PR #146 落地，**销账**，本计划不重做）；Metabase MCP 记为「不经 facade 不合规」观察项 | 头部声明 + T7 不给 Metabase MCP 开任何口 |
| 4 | **物化调度 = openship jobs**（`dbt --select` 由 job 定时打；零新常驻组件） | T6（job 注册）、T11（多租户循环） |
| 5 | **L2 = 定义权下放**：租户管理员 + 平台超管均可**定义**指标与语义（不止 A 薄档裁剪）；定义产出是**受治理、可机检的声明**（禁任意 SQL 不变）；**预留 agent 接入面**（接入本身另题不在本轮）；门禁③机检范围**覆盖用户/agent 产生的声明**；C 厚档维持排除 | T8（L2 声明形态与权限）、T9（门禁③覆盖 L2） |
| 6 | **dp-lab / dp-lab-bi 已拍删除，落地时重建**：删除 = 人在 dashboard 操作（openship MCP 无删项目接口）；部署验证**按目标形态从仓内工件新建** | 开工前置② + T6 |

仍开放的项（**不阻塞本计划，但别擅自拍**）：自建镜像**构建频率与触发**（spec §11.9 #4）——本计划按「仅 workflow_dispatch 手动触发、不设 schedule」处理，等于把这个开放项维持原状；Ossie 观察信号（§11.9 #3）——只观察不行动。

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
9. **敏感值**：ZOS 凭据 / Metabase API key / 嵌入签名密钥 / duckle `--token` 只落 openship env(isSecret) 或部署 env，**绝不进仓库/文档/日志/提交信息**；`.env.example` 只写键名与取法。
10. **版本锁死**：DuckDB **v1.5.5**（spec §11.2 #3，pg_duckdb 官方钉 v1.5.4 装不上 ossie，实测 404）、Metabase **v0.63.18.1**（PoC 实测版；禁 `latest`/`.x` 可变 tag——spec §6.6 纪律）、dbt / duckle 版本在各自 Dockerfile 里 ARG 钉死（默认值待实施时以压测环境实测版本核对）。升级走 runbook，不随手改。
11. **口径单一定义**（layered §3 纪律）：口径只在 marts 定义一次；staging 只规范化不改义；消费层（BI/AI）只能组合已声明的指标与维度。**L2 不能改 L1 口径**（只能裁剪/别名/过滤/目标值/新定义走结构化声明）。
12. **禁任意 SQL 的定义面**：L2 定义 API 只接受**结构化、可机检的声明**（base 引用 + 白名单聚合/过滤/别名），由模块内**唯一编译点**生成 `select_sql`；不接受自由 SQL 入参。L1 行的 `select_sql` 只能由 sync 脚本从仓内 YAML 物化写入。
13. **唯一通道**：一切部署/回滚/重启/env/备份/job 操作走 **openship MCP**（根本法则）；真机验收任务（T6/T10/T13）的执行者是「拿着 openship 权限的操作者」（人或被授权的 agent），不是普通 worktree worker。
14. **AI 消费必须经平台**（spec §11.3.1 安全论断）：`semantic_query` 的 filter allowlist 防不了跨租户，保护来自**每租户会话绑定**——任何绕开 facade 的数据面直连（含 Metabase 官方 MCP）都不合规，不新增此类入口。
15. **先查再动手**（knowledge-capture）：涉及 duckle/S3 兼容端点/WeKnora 上传 → 先检索 WeKnora（skill: `weknora`）；尤其 **duckle 原生 s3 sink 直连天翼 ZOS 反复 403、判定能力空白**（spec §8 记录的两条既有条目）——T5 的 duckle→ZOS 直写按「未验证」对待，处置见该任务。

---

## 开工前置——外部输入与 gate（编排者管，不是 worker 的步骤）

> 哪项没到位，对应 gate 波就**派不得**（派了也会停在第一个 gate 步）。正文里每个 gate 步回指这里的编号。

| # | 外部输入 | 谁给 | 解锁什么 | 没给卡住什么 |
|---|---|---|---|---|
| ① | **pg_duckdb 镜像的可获取通道**：GHCR 拉取凭据（目标机 `docker login ghcr.io`）**或** 明确走「目标机本地构建」路径；另确认 Actions 额度可承担一次 ~1–2h 的 C++ 构建（team-harness PR#79 因账单挂起的教训） | 人（org 设置 + dashboard） | T1 的首次构建、T6 的部署 | 仅卡 T1 的构建执行与 T6；T1 写工件不受影响 |
| ② | **dp-lab / dp-lab-bi 删除**（已拍，人在 dashboard 操作：`proj_BzOHhfY6_8OUFHR9` / `proj_gFnTdeeQfEuLPuQV`）+ **目标机选定**（第一次部署验证跑哪台机、与哪些生产负载同机） | 人 | T6 全部 | T6 |
| ③ | **ZOS 乐檬桶只读凭据**（存量 parquet 的读取面）落 openship env(isSecret)；**Metabase 服务账号 API key + 嵌入签名密钥**（T7 的 env 三键真值） | 人 | T6（ZOS）/ T10（Metabase） | T6 的 dbt 首跑、T10 |
| ④ | **业务排期/窗口**（目标机上首次起数据面、注册物化 job 的时段确认） | 人与客户/机主 | T6 的 `up` 与 job 注册 | T6 后半 |
| ⑤ | **SaaS 双租户验收环境**（multi 形态、两个测试租户 + 各自用户/PAT/凭据）与排期 | 人 | T13 | 仅 T13；T11/T12 的代码面不受影响 |

派发前另两件事（团队记忆）：**先 `git fetch origin main`**（Orca `--base-branch main` 取本地 ref，长期 worktree 会脱节）；**worktree 路径必须 ASCII**（中文路径打挂 vitest 的 TS fixture 加载）。

---

## 文件结构与派发表

### 新建 / 修改的文件（全量）

| 文件 | 职责 | 任务 |
|---|---|---|
| `deploy/pg-duckdb/Dockerfile` | 自建 pg_duckdb 镜像（§11.4 recipe 容器化） | T1 |
| `deploy/pg-duckdb/README.md` | 构建与运行 runbook（§11.4/§11.5 + 手工 docker commit 兜底 + 构建频率开放项说明） | T1 |
| `.github/workflows/pg-duckdb-image.yml` | 仅 `workflow_dispatch` 的镜像构建 → GHCR | T1 |
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
| **W0（P0）** | T1 镜像 | 单独，不依赖任何决策 | — |
| **W1（P1 仓内工件）** | **T2（架构+B7）先行 → T3（data-compose）∥ T4（dbt）∥ T5（contracts+duckle）** | T3 依赖 T2（B7 放行）；T4/T5 与 T2/T3 文件面零交集 | — |
| **W1g（P1 真机闭环）** | T6 部署闭环 + 摘标注 | 操作者任务，串行 | 外部输入①②③④ + W1 全合并 |
| **W2（P2 治理与配置面）** | **T7（facade+登记）→ T8（L2 定义权）→ T9（治理四机制）** | 严格串行：T7/T8 都改 `manifest.yaml`+`index.ts`（装载期双向核对，并行必冲突）；T9 的门禁③消费 T8 的声明形态 | — |
| **W2g（P2 e2e）** | T10 端到端验收 | 操作者任务 | W1g 部署存活 + 外部输入③（Metabase 凭据）+ W2 合并 |
| **W3（P3 多租户代码面）** | T11（每租户 schema+凭据）→ T12（串租户回归套件） | 串行（T12 断言依赖 T11 形态） | — |
| **W3g（P3 SaaS 验收）** | T13 验收 + 收尾 + 关伞 | 操作者任务 | 外部输入⑤ + T11/T12 合并 + W1g 同款部署面 |

**W1 文件面零交集核验**（并行判据，逐任务点名的唯一触碰面）：
T2 = `docs/architecture.md` + `scripts/check-compose.mjs` + `scripts/lint-architecture.test.ts`；T3 = `deploy/data-compose.yml` + `deploy/dbt/Dockerfile`；T4 = `dbt/**` + `scripts/check-data-models.*` + `.github/workflows/ci.yml` + `.env.example`；T5 = `contracts/**` + `duckle/**` + `deploy/duckle/Dockerfile` + `.gitignore`。两两无共享文件，`ci.yml` 与 `.env.example` 只被 T4 碰（`.env.example` 的下一处触碰在 W2 的 T7，串行不冲突）。

Orca 派发（W1 四任务两批；W2/W3 用 `--deps` 编码串行）：

```bash
git fetch origin main   # 先对齐（团队记忆：--base-branch main 取本地 ref）

# W0：单独
orca orchestration task-create --spec "<T1 spec：pg_duckdb 镜像，见计划 Task 1>" --json
orca orchestration worker-start --task <t1> --worktree new-top-level --name ds-image --agent claude --setup run --json

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
orca orchestration task-create --spec "<T9 spec>" --deps '["<t8 task_id>"]' --json
# T10/T11/T12/T13 同式；--name 全 ASCII
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

# W0（P0）— 自建镜像基础

### Task 1: pg_duckdb 自建镜像（Dockerfile + workflow_dispatch 构建 + GHCR + runbook）

**为什么不被任何决策阻塞**：镜像构建只依赖 spec §11.4 的实测 recipe（已验证可行），不碰 compose、不碰 B7、不碰模块；文件面三个新文件。**这是整个 #150 里唯一在 W1 之前就能独立交付的块。**

**Files:**
- Create: `deploy/pg-duckdb/Dockerfile`
- Create: `deploy/pg-duckdb/README.md`
- Create: `.github/workflows/pg-duckdb-image.yml`

**Interfaces:**
- Consumes: spec §11.4 recipe（逐字转录，见下）；pg_duckdb v1.1.1 release + DuckDB v1.5.5 tarball（**别用 git clone——子模块在这条网上爬不动**，spec 原话）。
- Produces: 镜像 `ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5`（tag 编码 pg_duckdb 版本 + DuckDB 版本；**不打 `latest`**——可变 tag 禁用是版本纪律）。

- [ ] **Step 1: 写 Dockerfile（recipe 容器化；三个编译配置缺一不可）**

```dockerfile
# deploy/pg-duckdb/Dockerfile — 自建 pg_duckdb（spec 2026-09-20 §11.2 #3 / §11.4，实测 recipe 容器化）。
# 为什么自建：官方 pg_duckdb 钉 DuckDB v1.5.4，duckdb-ossie 只发到 v1.5.5（安装 404，实测）。
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
# 上游真 bug 的手工补丁（spec §11.4 ③）：jemalloc 文件缺一个 include
RUN sed -i '1i #include "duckdb/common/string_util.hpp"' \
      src/common/allocator/allocator_jemalloc.cpp
# §11.4 ②：三个编译配置缺一不可（DISABLE_UNITY / CMAKE_BUILD_PARALLEL_LEVEL / 上面的 include）
RUN make DUCKDB_VERSION=${DUCKDB_VERSION} \
      DUCKDB_CMAKE_VARS="-DCXX_EXTRA=-fvisibility=default -DBUILD_SHELL=0 -DBUILD_PYTHON=0 -DBUILD_UNITTESTS=0 -DDISABLE_UNITY=1 -DOVERRIDE_GIT_DESCRIBE=${DUCKDB_VERSION}" \
      CMAKE_BUILD_PARALLEL_LEVEL=2 -j2
RUN make install

FROM postgres:17
# make install 的落点在 PG 的 pkglibdir/sharedir——首次构建时以 `make install` 实际输出核对 COPY 路径
#（builder 与本 stage 同基镜像，路径一致；对不上就按 install 日志订正，别猜）。
COPY --from=build /usr/lib/postgresql/17/lib/ /usr/lib/postgresql/17/lib/
COPY --from=build /usr/share/postgresql/17/extension/ /usr/share/postgresql/17/extension/
# pg_duckdb 需 superuser + shared_preload_libraries（spec §9.4 方案 2）；compose 侧经 command 传
```

> ⚠️ 最后一组 COPY 路径标注了「首次构建核对」——recipe 只验证到 `make install` 成功，install 产物落点以构建日志为准。这是有意的 gate，不是含糊。

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
          tags: ghcr.io/${{ github.repository_owner }}/platform-core-pg-duckdb:1.1.1-duckdb1.5.5
```

- [ ] **Step 3: 写 runbook（`deploy/pg-duckdb/README.md`）**

必含四节：① 构建路径（CI dispatch；**手工 docker commit 兜底**——§11.4 recipe 的原形态，目标机/无额度时用，两路径产物同源同 tag）；② 运行期硬约束（§11.5 三条逐字：DuckDB 实例按连接、SET 与使用同会话；`install_extension` 同会话开两个 allow；`duckdb.query()` 看不到 PG 表用 `raw_query`）；③ 内存口径（每连接一个 DuckDB 实例、`max_memory` 默认 4096MB/连接——spec §9.4；资源收口怎么做：连接池上限 + `duckdb.memory_limit` 显式设）；④ 构建频率开放项说明（现口径=按需 dispatch；升级 DuckDB 版本 = 改 ARG 重跑，先核对 duckdb-ossie 的发布版本）。

- [ ] **Step 4: 验证 + 提交**

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
2. **§1 拓扑**：§1.2 服务表**不动**（单元 A 仍是 postgres + server）；在 §1.2 末尾补一段「部署单元 B」：`deploy/data-compose.yml`（pg_duckdb 自建镜像 / Metabase / metabase-db / duckle·dbt 一次性 runner），**独立 openship project、可选拆缝**（指针 `deploy/customer-onboarding.md` §0/§1），全内网、端口回环。
3. **§2 组件表**：加一行 `deploy/data-compose.yml + deploy/pg-duckdb`（数据面：自建 pg_duckdb 镜像——**新组件**，spec §11.8 架构先行门点名要写进去的正是它）与一行 `dbt/ contracts/ duckle/`（数据工件：staging/语义声明/采集契约/管线，均非 Node workspace 包、在 B1/B9 扫描根外，由 `scripts/check-data-models.mjs` 守）。
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
- Consumes: T1 的镜像名（`ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5`）；T5 的 `deploy/duckle/Dockerfile`（compose 引用其 build 路径——**两任务谁先后合并都行，W1g 前齐即可**）；`deploy/customer-onboarding.md` 阶段 5 的拆缝接线模型。
- Produces: 五个服务定义 + 三个卷 + 全回环端口。平台侧接线点 = 宿主 `127.0.0.1:15432`（customer-onboarding 阶段 5「唯一跨 project 接线点」）。

- [ ] **Step 1: 写 data-compose.yml（T2 合并后才能提 PR——B7 放行面）**

```yaml
# deploy/data-compose.yml — 数据面部署单元 B（issue #150；spec 2026-09-20 §1/§11.1）。
# 全内网：不进 openship edge、不绑公网；所有 ports 一律回环（B7 规则二对两份 compose 都生效）。
# 拆缝用法（同仓同分支、独立 project）见 deploy/customer-onboarding.md §0/阶段 5。
# ⚠️ 顶层 name 必需——与主 compose 同一条理由（项目名/卷名撞车，docker-compose.yml 头注的实测事故）。
name: platform-core-data

services:
  # ── 语义层 + 物化落点（spec §11.2 #3：自建镜像，DuckDB v1.5.5）──
  pg_duckdb:
    image: ghcr.io/mytech-co-ltd/platform-core-pg-duckdb:1.1.1-duckdb1.5.5
    # 镜像获取两条路（deploy/pg-duckdb/README.md）：GHCR 拉取（需目标机 docker login）或目标机本地构建同 tag。
    environment:
      POSTGRES_USER: ${PGDUCK_USER:-platform}
      POSTGRES_PASSWORD: ${PGDUCK_PASSWORD:-platform}     # 真值走 project env（openship），不进 git
      POSTGRES_DB: ${PGDUCK_DB:-warehouse}
    # shared_preload_libraries 是 pg_duckdb 硬要求（spec §9.4 方案 2）
    command: ["postgres", "-c", "shared_preload_libraries=pg_duckdb"]
    volumes:
      - pgduckdata:/var/lib/postgresql/data
    ports:
      # 平台宿主的接线点（DATA_WAREHOUSE_URL 指这里）；回环 ⇒ 只有同宿主的 edge/宿主进程够得到
      - '127.0.0.1:15432:5432'
    mem_limit: ${PGDUCK_MEM_LIMIT:-2g}    # 每连接一个 DuckDB 实例（max_memory 默认 4096MB/连接，
                                          # spec §9.4）——连接数 × 内存必须显式收口，见 pg-duckdb/README §3
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
    restart: unless-stopped
    # 不映射 ports：只有同 compose 网络内的 metabase 够得到（服务名即主机名）

  # ── BI 渲染面（spec §11.2 #1；版本锁死 = PoC 实测版，禁 latest——§6.6 纪律）──
  metabase:
    image: metabase/metabase:v0.63.18.1
    environment:
      MB_DB_TYPE: postgres
      MB_DB_CONNECTION_URI: postgresql://${MBDB_USER:-metabase}:${MBDB_PASSWORD:-metabase}@metabase-db:5432/metabase
    depends_on:
      - metabase-db
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
# ⚠️ DBT_VERSION 默认值待核对：以 2026-09-21 分层 spec 压测环境实测的 dbt 版本钉死
#（layered §11 资源画像那轮实测用的版本），实施时核对后改掉本行注释。
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
docker compose -f deploy/data-compose.yml config --quiet   # 本地语法面（不需要镜像在场）
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
- `dbt/tests/audit_<指标>.sql`：**每个声明的指标一条对账 singular test**（独立复算 vs 物化结果逐位比对；spec §10 机制 4「同名唯一 + 每个指标一条对账查询」——硬要求 7「对账是硬要求：cast 错了静默，只有它能抓」）。命名约定 `audit_*` 与指标名一一对应，机检在 Step 5 锁。

- [ ] **Step 5: 静态门禁 check-data-models.mjs（先红后绿）+ CI 接线**

新建 `scripts/check-data-models.test.ts`（fixtures：合规 dbt 目录 → 干净；缺 owner 的声明 → 违规；staging 用 `::double` → 违规；staging 无 `r['` 模式 → 违规；同名指标两处 → 违规；声明了指标但无 `audit_*.sql` → 违规）。`check-data-models.mjs` 检查项（静态、无库）：
① `staging/stg_*.sql` 必含 `r['` 取列模式（坑 #5 的结构性防御）；② 禁 `::double`（坑 #4）；③ 禁 `union_by_name`（硬约束 2：漂移必须显式处理）；④ staging 一对一（staging 模型 ↔ sources.yml 源一一对应）；⑤ 语义声明必填字段（owner/tier/grain/definition）齐全；⑥ 指标命名空间前缀 + **同名唯一**；⑦ 每个声明指标有对应 `dbt/tests/audit_<指标>.sql`。
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
git commit -m "feat(data-stack): dbt 项目——乐檬 staging/marts + L1 语义声明 + 对账 tests + 静态门禁"
gh pr create --title "feat(data-stack): dbt 项目与数据工件静态门禁（P1）" --body "Refs #150"
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

`duckle/README.md` 开头必须先写这条已知事实：**duckle 原生 s3 sink 直连天翼 ZOS 反复 403、两条 WeKnora 既有条目判定能力空白**（spec §8）——动手前先检索 WeKnora 核对现状；`duckle/common/` 与 `duckle/customers/` 目录约定（与 contracts/dbt 的 common/customers 三件套同构：一个新源 = 契约 + 管线 + staging 三个文件同 PR）。管线文件本体是**目录与命名约定 + README**，不放编造的 DSL 范文（duckle 管线格式以官方文档/实测为准，别按想象写）。`.gitignore` 加 `duckle/**/ _ops/` 本地产物目录（以实测的 _ops 形态为准）。

- [ ] **Step 3: deploy/duckle/Dockerfile（headless runner 容器化）**

```dockerfile
# deploy/duckle/Dockerfile — duckle headless runner（spec §1 打包事实：官方镜像只有 web 编辑器；
# headless 分发 = 二进制（duckle-runner-linux-x64 + SHA256SUMS.txt）或 PyPI duckle，后者是
# spec 明载的分发路径，取它做主路径；二进制路线记进 README 作替代。
# runner 另需一个 duckdb 在 PATH（或 DUCKLE_DUCKDB_BIN）——版本与 pg_duckdb 内核对齐（v1.5.5）。
FROM python:3.12-slim
ARG DUCKLE_VERSION=x.y.z          # ⚠️ 待核对：以 PyPI 实际版本钉死（首次构建时查）
ARG DUCKDB_VERSION=1.5.5
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "duckle==${DUCKLE_VERSION}"
# duckdb CLI（版本锁死；zip 资产名以官方 release 页为准——首次构建核对）
RUN curl -fsSLO "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb_cli-linux-amd64.zip" \
    && unzip -j duckdb_cli-linux-amd64.zip duckdb -d /usr/local/bin/ \
    && rm -f duckdb_cli-linux-amd64.zip
WORKDIR /workspace
# --token 硬要求（spec §1）：入口对空 DUCKLE_TOKEN 拒跑（exit 1），别让「没配 token 也能起」
# 成为默认——compose 不用 :? 强制插值（会卡住无关服务的 up），安全闸放在这里。
ENTRYPOINT ["sh", "-c", 'exec duckle "$@" --token "$DUCKLE_TOKEN"', "--"]
```

> ⚠️ duckle 的 CLI 子命令形态（`duckle run …`/runner 入口名）与版本号是**首次构建核对点**——spec 只记了分发形态没记 CLI 面，按官方文档核对，别按本 ENTRYPOINT 范文照抄。本任务不跑真管线——duckle→ZOS 直写按「未验证」对待，验证归 W1g（T6 有核对步：能直写则记结论；不能则记「经 dbt/中转落盘」的替代路径结论，**不静默绕过**）。

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
git commit -m "feat(data-stack): 采集契约目录 + duckle 管线骨架与 runner 镜像（新源落盘即定型）"
gh pr create --title "feat(data-stack): contracts/ 与 duckle/ 数据采集工件（P1）" --body "Refs #150"
```

---

# W1g（P1）— 真机部署闭环（gate：外部输入①②③④ + W1 全合并）

### Task 6: 数据面真机部署 + 全链路闭环 + 摘标注 + 物化 job 注册

**执行者是「拿着 openship 权限的操作者」（人或被授权的 agent），遵循唯一通道法则。** 对标 M2b T5 的形态；部署模型照 `deploy/customer-onboarding.md`（阶段 2 建 project / 阶段 5 拆缝 / 阶段 6 数据初始化 / 阶段 7 验收）。

- [ ] **Step 1: GATE——四项前置全绿才许动**

1. **外部输入①**：pg_duckdb 镜像可获取（GHCR 凭据或目标机本地构建路径二选一）；首次构建已跑通（T1 的 CI dispatch 或目标机构建），tag 与 compose 一致。
2. **外部输入②**：dp-lab / dp-lab-bi 已删（人在 dashboard；MCP 无删项目接口）+ 目标机已选定。
3. **外部输入③**：ZOS 乐檬桶只读凭据已落 openship env(isSecret)。
4. **外部输入④**：目标机时段已确认。W1 的 T2–T5 全部合并进 main。

- [ ] **Step 2: 按目标形态建数据面 project（openship MCP）**

照 customer-onboarding 阶段 2（folder-upload 五步）或 git 绑定建 `platform-core-data`（或首个客户命名 `platform-core-<客户>-data`），composePath = `deploy/data-compose.yml`，serverId = 目标机；project env 物化 ZOS 五键 + `PGDUCK_PASSWORD` + `DUCKLE_TOKEN`（isSecret）。`up` 前三服务（pg_duckdb / metabase-db / metabase）——etl profile 的 duckle/dbt **不随 up 起**（零常驻，拍板 #4）。

- [ ] **Step 3: dbt 首跑（staging 列全集在这一步钉死回填）**

`docker compose -f deploy/data-compose.yml --profile etl run --rm dbt build --select path:models/common`（或 openship job 一次性触发）。首跑前把乐檬样本列清单与 T4 的暂定列对齐（`read_parquet` 的 `describe`/样本查询），漂移列（supplier_*）按 README 策略显式分组处理；**回填进 stg 模型走 PR**（列全集是代码，不是部署差异）。Expected: `dbt build` 绿（含 tests + 对账 singular tests——对账查询在**真数据**上通过，这正是治理机制 4 的落地形态）。

- [ ] **Step 4: Metabase 面板 + 平台接线 + 新行为验证（deploy-verify）**

- Metabase：建 pg_duckdb 连接（同 compose 网络走服务名 `pg_duckdb:5432`；连接用户用超级用户——pg_duckdb 的扩展/委托需要）→ sync → 在 marts 上建第一个 question/dashboard。**确定嵌入面暴露通道**（edge 反代域名 or 客户内网直连），结论记进 `deploy/customer-onboarding.md` 对应节（这是 spec「只经嵌入面出去」的落地决策，不绑公网）。
- 平台 project env 加 `DATA_WAREHOUSE_URL=postgres://…@127.0.0.1:15432/warehouse`（同机接线点）→ 重新部署平台 → **问数链路吃真数据**（#146 的 `POST /api/modules/data/query` 打真 marts——这是「新行为在线上可观测」的验法，比容器时间戳更硬）。
- 容器时间戳照 deploy-verify 双验（创建 > 镜像构建）。

- [ ] **Step 5: 注册物化 job（拍板 #4）+ duckle→ZOS 结论落档**

经 openship MCP 建 job（cron 低频起步，如每日一次；command = `docker compose -f … --profile etl run --rm dbt build --select <被消费的组合>`——**按需物化**，不是全量）。ducle 核对步：跑一次最小管线验证 ZOS 直写是否仍 403；结论（能/不能+替代路径）记进 `duckle/README.md` 与 WeKnora（命中既有条目则**更新不新建**）。

- [ ] **Step 6: 摘「尚未进仓」标注 + handbook 补齐（docs PR）**

- `deploy/customer-onboarding.md`：摘掉六处「尚未进仓」标注（:33 / :51 / :91 / :157 / :172 / :199——行号以 grep「尚未进仓」实测为准）。
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
git commit -m "feat(data): Metabase 报表 facade——幂等建报/锁参嵌入/登记与对账（P2）"
gh pr create --title "feat(data): Metabase 报表 facade + 报表登记 + 看板页签（P2）" --body "Refs #150"
```

---

### Task 8: L2 配置层——定义权下放（结构化声明 + 唯一编译点 + L1 物化）

**Files:**（见派发表 T8 行）

**Interfaces:**
- Consumes: 拍板 #5 全文（定义权下放；可机检声明；agent 接入面预留；C 排除）+ 拍板 #2（dbt YAML 是 L1 事实源）；既有 `domain/authz.ts`（词表裁剪单实现——L2 合并后仍走它，**不另写第二处权限判定**）、`domain/metric-store.ts`（`data.metrics` 读写）。
- Produces:
  - `003_metrics_source.sql`：`data.metrics` 加 `source text not null default 'l2'`（值 `l1`/`l2`）+ 索引 `(source)`；**不加豁免**（org 列纪律不变）。
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
export function compileL2(base: L1Metric, decl: L2Declaration): { selectSql: string; title: string }
// 受限表达式（B 中档）不在 v1——拍板原文「定义权下放」指的是定义新指标/语义的权限下放，
// 表达力档位的扩展（算术组合等）等真实需求出现再走 spec 增补，别在实现里私自放宽。
```

  - `scripts/sync-data-semantics.mjs`：读 `dbt/models/**/schema.yml` 的语义声明 → 幂等 upsert `data.metrics`（`org='platform'`、`source='l1'`；L1 行不再存在的删除）——**L1 的 select_sql 只能从这里写进**，管理 API 对 `source='l1'` 的行只读。`deploy/Dockerfile.server` COPY 清单加 `dbt/`（服务端读取面）。挂进部署序列（migrate 之后跑，或 openship job）。
  - 定义权限双门：租户管理员 = 既有 `data:manage`（本 org 内 L2 行）；平台超管 = 平台级 L2（`org='platform'` 的 l2 行，全租户可见）。**平台超管的识别沿用平台既有信号（实现时核对 identity/scopes 的超管口径，勿新造第二套超管判定）**。
  - `routes/metrics.ts` 收紧：POST/PUT 只收 `L2Declaration`（zod 校验，自由 SQL 入参下线——已有消费者只有本模块 console 页，同 PR 改齐）；catalog 加载 = L1（platform）∪ L2（本 org），L2 只 refine 不改口径。
  - agent 接入面**预留**：manifest 注释 + README 记「L2 定义 API 即将来的 agent 接入面（PAT + data:manage 已具备，MCP 工具面另题）」——**不实现**（拍板原文：接入本身另题不在本轮）。

- [ ] **Step 1（TDD）**: `semantic-compiler.test.ts`——base 不存在于 L1 → 抛；filters/visibility 的维度名不在 L1 声明 → 抛（机检即写时校验）；compile 产物是纯 SELECT（断言不含分号/DDL 痕迹）；同名 L2 在同 org 唯一。
- [ ] **Step 2**: `metric-store.test.ts` 扩：L1∪L2 合并、L2 不可覆盖 L1 口径、裁剪后词表经 authz 只少不多。
- [ ] **Step 3**: 迁移 + sync 脚本（幂等：重跑两遍行数不变）+ 路由收紧 + console 指标管理页改声明式表单。
- [ ] **Step 4**: 全量验证（check-tenant-isolation 必跑）+ PR：

```bash
git add modules/data scripts/sync-data-semantics.mjs deploy/Dockerfile.server
git commit -m "feat(data): L2 定义权下放——结构化声明 + 唯一编译点 + L1 经 sync 物化（P2）"
gh pr create --title "feat(data): L2 配置层——定义权下放与可机检声明（P2）" --body "Refs #150"
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
git commit -m "feat(data-stack): 治理四机制收口——门禁③覆盖 L2 + 血缘/排查 runbook（P2）"
gh pr create --title "feat(data-stack): 数据治理四机制与 L2 机检（P2）" --body "Refs #150"
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
git commit -m "feat(data-stack): 每租户 schema 与凭据收紧——USER MAPPING/SCOPE + 启用集对账（P3）"
gh pr create --title "feat(data-stack): 多租户 schema/凭据收紧与对账（P3）" --body "Refs #150"
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
- [ ] **Step 3: 收尾落档**——
  - spec（`2026-09-20-data-stack-module-design.md`）：§11.8 分期表加落地注记（P0–P3 各一行：日期 + PR/验收指针）；已知边界按实际落地更新（Metabase 嵌入面暴露通道的最终形态、ducle→ZOS 结论）。
  - handbook §5 验收记录补 P2/P3 两行。
  - **WeKnora 沉淀**（先 hybrid-search 查重，命中更新不新建）：pg_duckdb 自建镜像 recipe 容器化的实操增量（install 产物路径/构建时长）；Metabase 老 API 幂等 upsert + `embedding_params` 的实操口径；串租户回归里缓存重放的结果（Metabase 缓存 key 是否含参数——实测结论对后来者高价值）。
  - 最终 docs PR：**body 写 `Closes #150`**——伞 issue 在此关闭（全局约束 8：此前所有 PR 一律 Refs）。

```bash
git add docs
git commit -m "docs(data-stack): #150 P0–P3 落地收尾——spec 分期注记 + 验收记录"
gh pr create --title "docs(data-stack): 数据栈 P0-P3 收尾（Closes #150）" --body "Closes #150"
```

---

## 附：与本计划相关的已知坑（执行时别重踩）

| 坑 | 出处 | 对本计划的影响 |
|---|---|---|
| duckle 原生 s3 sink 直连 ZOS 反复 403（能力空白） | WeKnora 两条既有条目（spec §8 引） | T5 不跑真管线；T6 核对并落结论（能/不能+替代路径）；**先检索 WeKnora 再动手** |
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
| 编译三配置缺一不可（DISABLE_UNITY / 并行度 2 / jemalloc include 补丁） | spec §11.4 | Dockerfile 逐字转录，别「优化」 |
| Metabase↔Cube 版本级断点六次 | spec §6.2（cube 时代记录） | Cube 已否决，但**版本锁死 + 升级先核兼容**的纪律平移到 Metabase↔pg_duckdb：锁 v0.63.18.1，升级走 runbook |
| Actions 额度会挂起真实工作流 | team-harness PR#79 教训 | 镜像构建仅 dispatch；跑前确认额度（外部输入①） |
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

### 自检发现与处置

**第一轮：引用核验**（逐个 grep/读文件验证）

| # | 核对项 | 结论 |
|---|---|---|
| 1 | 文件表 ↔ 各任务 Files 清单互查 | 一致（表内行与任务内清单逐行对过；T2 三文件均为 Modify/Create 与既有面相符） |
| 2 | 引用的门禁命令逐个对照 ci.yml 实测 | `pnpm exec tsx scripts/check-*.mjs` 五条 + `pnpm typecheck`/`pnpm test` 与 ci.yml gates job 逐字同形；`pnpm --filter data test/typecheck` 经 `modules/data/package.json` 的 `"name": "data"` 核实 |
| 3 | B7 前置证据复核 | `scripts/check-compose.mjs:50` `ALLOWED = 'deploy/docker-compose.yml'` 与 `docs/architecture.md:121`「全仓唯一 compose」均实测在位（决策材料同源） |
| 4 | 「尚未进仓」标注位置 | grep 实测六处：customer-onboarding.md :33/:51/:91/:157/:172/:199（T6 Step 6 已写明以届时 grep 为准） |
| 5 | 拍板六项 ↔ 任务落点 | 已拍口径表逐行有落点任务；仍开放两项（构建频率、Ossie 观察信号）显式标注「不阻塞、不擅自拍」 |
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

### 有意的取舍（reviewer 请过目）

- **不新建第二个数据域模块**（报表/L2/治理全部扩 `modules/data`）：spec 写作时 `modules/<id>` 未定 id 且当时 `modules/data` 尚不存在；#146 落地后授权核心/词表/审计/通道都在 `data`，另起模块 = 授权逻辑第二份或跨模块端口，违反「授权核心单实现」的既定约束。**这是 spec 未显式裁决的落点选择，按最低摩擦 + 复用既有正典取的，请 reviewer 确认。**
- **Metabase 版本锁 v0.63.18.1（非 LTS v0.58）**：PoC 全链路实测版本；spec §6.6 的 LTS 口径是版本纪律的来源，但 0.63 已实现 OSI `ai_context`（spec §9.6 记录）且是实测通过组合。升级窗口与频次归 runbook，不在本计划拍。
- **pg_duckdb 镜像走 GHCR + 目标机本地构建双路径**：私有化客户机未必有 GHCR 凭据，Dockerfile 在仓即「任何机器可复现」；GHCR 是 SaaS/自用的便捷面。构建频率（§11.9 #4）维持开放：dispatch-only。
- **duckle 在 v1 只交付骨架与 runner 镜像，不交付可跑管线**：duckle→ZOS 直写是已记录的能力空白（两条 WeKnora 条目），在拿不到「直写可行或替代路径」的实测结论前写「可跑管线」是编造；闭环数据源用存量乐檬 parquet（拍板 #1 本就不重落盘）。新源（抖音）接入是 data-platform 标准的 SOP 事件，不在 #150 的 P1 出口里。
- **T12 缓存重放断言保留但依据重写**：spec 验收 #2 的 cube 缓存 key 论据随 Cube 否决失效；Metabase 结果缓存是否把 A 的卡数据重放给 B 是**未验证的真实风险**，测试保留并以 Metabase embed API 为反向验面——真机结论（T13）无论红绿都沉淀 WeKnora。
