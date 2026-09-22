# 数据栈模块接入（duckle ETL + Ossie 语义层 + pg_duckdb + Metabase BI，平台统一身份）

- 日期：2026-09-20
- 状态：**架构已定稿**（2026-09-20，用户确认）——见 **§11**。
  最终形态：**duckle → parquet(每租户桶) → pg_duckdb(自建, DuckDB v1.5.5) + Ossie 语义层 → Metabase**，
  隔离下推数据层，AI 走两条已验证路径（`duckdb-ossie` MCP 问数据 / 平台 facade 建报表）。
  **仍开放四项**（§11.9）：数据单元仓落点 · L2 表达力档位 · Ossie 观察信号 · 自建镜像构建频率。
  ※ 历史轨迹（保留作技术记录，**非推荐路线**）：§9.6 曾建议「不引入语义层产品」→ 同日 PoC
  证明 `duckdb-ossie` 可行后改为引入；§5/§6.2 的 Cube 内容为技术记录，**已被 §9 否决的结论不变**。
  ※ 「MCP 形态」已收敛为 **M2（平台自建 facade）**——M1 因超管连接 = 跨租户能力而被否决。
- 关联：`docs/architecture.md`（**§1 拓扑、§2 组件表、§5 扩展点须改；§1.2 服务表不变**）、`docs/module-protocol.md`、
  `docs/module-onboarding.md`、`deploy/openship-adopt.md`、`deploy/delivery-private.md`、
  `2026-09-16-m3c-tenant-storage-protocol-design.md`（租户存储复用）、issue #126（bindings 清理）

## 背景与动机

### 需求

业务侧要一个「数据/采集板块」：**duckle 做 ETL、cube 做语义层、Metabase 做 BI**。
硬约束由提出方给定：

1. **全局身份与权限由平台统一控制**——不允许第二套权限真相。
2. 有权限的管理员可以**通过 MCP 创建 Metabase 报表**，并嵌入平台页面给有权限的人看。
3. 两种部署形态都要：**SaaS（`multi`，一套服务所有租户）** 与
   **私有化（`single`，每个客户一套独立部署）**。

### 现状：为什么今天接不进来

| 事实 | 出处 |
|---|---|
| 模块 = **同进程装载**的路由 + 页；`ModuleContext` 只有 `{ pool }`，没有进程/端口能力 | `packages/platform-sdk/src/module.ts:20` |
| manifest **没有**服务/容器/端口字段 | `docs/module-onboarding.md` §2 |
| `bindings` 形似支持，实为**死字段**（仅键白名单 `{postgres,novu,cube}`，零运行时消费者） | `packages/platform-sdk/src/checks.ts:16`、issue #126 |
| 全仓唯一 compose，只有 `postgres` + `server` 两个服务 | `deploy/docker-compose.yml`（B7 守卫） |
| 任一模块装载失败 ⇒ **整台宿主起不来**（无单模块降级形态） | `deploy/openship-adopt.md` §已知陷阱 5 |

⇒ 「模块自带多个服务」在**今天的协议里没有通道**，本设计**不扩模块协议**，
而是把服务放到平台之外的一个**独立部署单元**，模块只做控制面与页。

### 关键的结构性判断（决定了下面所有选型）

- **私有化下「每租户一套」是天然结果**：每客户本来就一套独立部署，零额外机制。
- **SaaS 下「每租户一套」不可行**：那是运行时按租户批量拉起容器组，而 openship 的编排
  模型是「人工 adopt 项目」，平台自身也没有编排能力（宿主只是个 Node 进程）。
  ⇒ **SaaS 形态下数据面服务只能共享一套，租户分面必须发生在服务内部。**
- 由此：**cube 的多租户能力不是可选项，是 SaaS 能否成立的前置条件**（§5）。

## 目标 / 非目标

**目标**

1. 模块以**既有协议**接入（同进程 API + console 页 + 迁移），模块协议**零改动**。
2. 数据面（B 胶水 / duckle / cube / Metabase / MCP 工具面）打包为**一个独立部署单元**，
   全内网，不对公网暴露。
3. **平台是身份与权限的唯一事实源**；数据面服务一律**不持有平台身份**。
4. MCP 报表制作面：两种入口（AI 客户端直调、控制台内入口）**共用同一条鉴权链**。

**非目标**

- **不扩模块协议**引入「模块自带服务」；`bindings` 保持死字段（清理归 issue #126，不在本设计内）。
- **不做 Metabase 的终端用户自助分析**——本设计只做「管理员制作 + 嵌入观看」。
  SSO 路线（用户映射进 Metabase）记为**将来升级路径**，不在本期（见 §6 与 §已知边界）。
- 不在 SaaS 下为每租户起独立服务实例（见上文结构性判断）。
- MCP 本体的通用网关化 / 多业务复用不在本期。

## 设计

### 1 边界与部署单元

```
┌─ platform-core 仓内 ───────────────────────────────────────────┐
│  modules/<id>/          ← 全平台唯一的身份/权限处理点            │
│    · API：配置 / 触发 / 查询 / 状态   (api.internal 逐条声明)     │
│    · console 页：看板（嵌 Metabase signed embed）                │
│    · migrations：配置与登记表（带 org 列，三同纪律）              │
│    · manifest 声明 storage:{kind:s3} ← 复用 M3c，取本租户 ZOS 配置 │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTP（地址来自 env；禁硬编码，B8 守）
┌───────────────────────────▼───────────────────────────────────┐
│  独立部署单元（openship 另一个 project，非本仓，全内网）           │
│    B 胶水服务（自建镜像）   ← 无平台身份，只接已鉴权指令            │
│    duckle                   ← 官方镜像只含 web 编辑器，详注见下    │
│    cube core + Cube Store   ← 官方镜像，不对外。**两个组件不是一回事**：│
│                                 Core = 语义层；Store = 预聚合物化存储，  │
│                                 生产模式下**必须作为独立进程**跑        │
│    Metabase                 ← 官方镜像，只经嵌入面出去             │
│    MCP 工具面               ← 报表制作，不持 Metabase 凭据         │
│    [+] 新增有状态面：Metabase 应用库 / duckle workspace           │
└───────────────────────────────────────────────────────────────┘
```

**服务间全部内网**：B / duckle / cube / Metabase / MCP 都不进 openship edge、不绑公网、
不签证书。对外只有一个面：`modules/<id>/` 的 API 与页。

**duckle 的打包事实（调研订正）**：官方**确有**镜像 **`ghcr.io/slothflowlabs/duckle-web`**
（CI 自带 `packages: write`，30 个 tag 与 release 对齐），但它是**web 编辑器**，
**不是 headless runner**。headless 路线的官方分发仍是**二进制**
（`duckle-runner-linux-x64`，41MB，带 `SHA256SUMS.txt`）或 PyPI `duckle`，
外加一个 `duckdb` 在 PATH 上（或用 `DUCKLE_DUCKDB_BIN`）。
（Docker Hub 的 `slothflowlabs/*` **命名空间根本不存在**，别去那儿找。）
⇒ 待定的小选择：直接用 `duckle-web` 镜像，还是自己容器化 headless runner。
⚠️ 无论哪条，`duckle-runner serve` 绑非 `127.0.0.1` 且无凭据时，
**15 分钟内任何人可 claim 成管理员** ⇒ `--token` 是硬要求（与 B7「端口绑回环」同类问题的两面）。

### 2 身份与权限模型

**唯一事实源 = 平台**（Casdoor 身份 + scopes + 租户启用集）。数据面服务**一律不持有**
平台用户、不自己判权限。

三层，由平台施加：

| 层 | 谁 | 管什么 |
|---|---|---|
| 平台超管 | 我方运营 | 跨租户；可建**全局报表**（`platform` 归属） |
| 租户管理员 | 客户 | 限本租户；可建**本租户报表** |
| 普通用户 | 客户员工 | 只看；由 platform scope 控页门 |

**租户分面只有一个入口**：`modules/<id>/` 从 `c.get('identity')!.orgId` 取租户，
转换为对 B 的调用参数。数据面服务都**不解析租户**（不自己判定「你是谁」）——
把平台既有的纪律「宿主施加门禁、模块不自己写鉴权」原样复制到服务边界上。

⚠️ **但「不解析」不等于「不强制」**：租户值会被**作为参数**传下去，而 **cube 仍必须按
传入的租户值强制过滤**（§5）。分工是「**解析**在一处、**强制**可在多处」——这个区分必须
保持，否则会被读成「cube 不需要做租户过滤」，那正好踩中 cube 的 fail-open 默认（§5）。

### 3 数据流

**取数（模块 → 存储 → duckle → cube）**

模块声明 `storage: { kind: 's3' }`（**复用 M3c 既有协议，零新增**），运行时经
`c.get(TENANT_STORAGE)` 取**本租户自己的** ZOS 五元组，把待分析数据落该租户的桶。
duckle 读 parquet 做 ETL，产出仍落该桶；**cube 经官方 DuckDB 数据源驱动直读同一批
parquet**（`CUBEJS_DB_TYPE=duckdb` + `CUBEJS_DB_DUCKDB_S3_*`，`URL_STYLE=path`），
**中间不需要再立一个数据库**。

⇒ **租户边界天然落在「每租户一个桶 + 每租户一份凭据」上**，且这条边界被
**四个环节共用**：模块写入、duckle 读写、cube 读取、Cube Store 的持久层（§8）。
**一个隔离原语贯穿全栈**——这是本设计最省的地方，不要各自另造。
⇒ 也因此 §5 的主机制从行级谓词改为**每租户数据源**（见 §5 修正说明）。

**回写（B → 模块 → 业务模块）** —— 采用**经模块中转**，理由是租户身份只在一处处理：

```
B ──→ modules/<id>/  ──→ 业务模块（各自已声明的 API）
      ↑ 唯一鉴权 + 定租户点
```

B 不直接回调业务模块，也不持有业务模块的凭据。

### 4 MCP 工具面（报表制作）

**两条入口，一条鉴权链**（否则「AI 客户端直调」就是绕过平台权限的后门）：

```
AI 客户端 ──┐
            ├──→ MCP 工具面 ──→ modules/<id>/ ──→ 服务账号 ──→ Metabase
控制台页 ───┘        ↑              ↑
              不持 Metabase    唯一鉴权 + 定租户点
                 凭据
```

- **MCP 自己持有 Metabase 凭据是禁止的**（等于绕过平台权限，与硬约束冲突）。
- 报表登记在**平台侧**（模块的配置表）：`报表 ↔ 租户归属(`platform`|org) ↔ 挂哪个页
  ↔ 需要哪个权限码`。
- **权限双门必须分开表态**：「谁**能看**」由 platform scope 控；「看**哪个租户的数据**」
  由嵌入时锁定的租户参数控（见 §6）。
- ⚠️ 引入**双写面**：报表本体在 Metabase，登记在平台。Metabase 侧被手工删改时平台侧
  不知情 ⇒ **必须有对账**（§7）。

#### ⚠️ 待决策：MCP 用官方的还是自建的（调研新增分叉）

调研发现 **Metabase 有官方内建 MCP server，且 OSS 免费可用**，写工具齐备
（`create_collection` / `create_dashboard` / `create_question` / `update_*` / `execute_sql`）。
**但它的鉴权是「会话绑定连接者本人的 Metabase 权限」——要求调用者有 Metabase 账号。**

| 选项 | 做法 | 代价 |
|---|---|---|
| **M1 用官方 MCP** | 给**管理员**开 Metabase 账号，管理员在 AI 客户端直连官方 MCP | 省掉一整套自建；但**引入第二身份库**（至少对管理员一层），与「全局身份由平台统一控制」有张力 |
| **M2 自建 MCP facade** | 我们写工具面，内部用**服务账号 API key** 调 Metabase 老 API | 保住唯一事实源（与 §2 一致）；代价是多一层要维护，且要自己实现幂等（**API 无按名 upsert**） |

**建议 M2**（与硬约束一致），但 M1 是官方原生、成本明显更低——**待你选**。

※ 无论哪条：**官方 MCP 与 Agent API 都没有嵌入工具** ⇒「发布 + 锁参数」那一步
**只能走未版本化的老 API**，这部分平台侧必须自己实现（`embedding_params` 可纯 API 配置）。

### 5 租户分面

**结论（2026-09-20；含一次重要修正）：走 L1——cube 一套实例。**
**但租户分面的主机制不是行级 `queryRewrite`，而是「每租户数据源 + 每租户桶」。**
L2（每租户一套实例）保留为后置预案（触发条件见本节末）。

⚠️ **修正说明**：本 spec 初稿把 L1 定为「行级 `queryRewrite`」。后续核查发现 cube 官方有
**DuckDB 数据源驱动**，可直接查 S3 兼容对象存储上的 parquet
（`CUBEJS_DB_TYPE=duckdb` + `CUBEJS_DB_DUCKDB_S3_*` 系列，**支持 `URL_STYLE=path`** 与自定义
endpoint），而我们的数据本来就落**每租户一个 ZOS 桶**。两者一接，隔离语义升级：

| | 行级过滤（初稿方案） | **每租户数据源（修正后主机制）** |
|---|---|---|
| 隔离靠什么 | `queryRewrite` 注入的谓词 | **每租户一套 S3 凭据，只指向自己的桶** |
| 失效模式 | 漏写/漏接 ⇒ **静默返回全量**（cube 的 fail-open 默认姿态，见下） | 在**凭据层面**就够不到别的桶 |
| 要靠人自觉吗 | **要**（官方自家 recipe 都错过，见下） | 不要 |
| 官方支持 | ✅ | ✅（`driver_factory` 每租户数据源；官方章节 *Multiple DB Instances with Same Data Model*） |

⇒ **主机制 = 每租户数据源**；行级 `queryRewrite` **下沉为纵深防御第二层**（不是主门），
但本节第 3/4 条（CI 门禁 + 串租户回归测试）**仍然必做**——纵深防御同样要能验，
且串租户回归测试是唯一能验出「凭据配错」的手段。

⚠️ **资源注意**：`CUBEJS_DB_DUCKDB_MEMORY_LIMIT` **默认吃 75% 可用内存**——
与 §8 的资源收口是同一条账，必须显式设，否则 DuckDB 会把容器内存吃满。

#### ⚠️ 该机制与「报表嵌入」撞出的三岔路（未决，由 §6.2 的打靶裁决）

Metabase OSS 一个数据库连接 = 一组凭据，而 cube 的身份来自连接级用户名。于是：

| 路线 | 做法 | 隔离强度 | 代价 |
|---|---|---|---|
| **A** | **一份报表共享**给所有租户 + locked parameter 锁租户 | **弱**——cube 只看到一个身份 ⇒ 租户只能靠**行级谓词**承载 ⇒ 回到 fail-open 风险面 | 报表一份，provision 与对账最简单 |
| **B** | **每租户一份报表副本** + 每租户一条 Metabase 连接 | **强**——隔离落在凭据/数据源层 | 报表数 × 租户数；provision 与对账体量放大（近似 Metabase 的 `Tenants` 功能，但那是 Pro/EE，OSS 须自己实现） |
| **C** | 共享报表 + 单一连接 + **每次查询切 `__user`** ⇒ cube 按 `__user` 选数据源 | **强**（若成立） | **未验证**——正是 §6.2 的打靶 |

⇒ **§6.2 的 `psql` 打靶的裁决范围因此扩大**：它不只在「权限执行点在哪」之间裁决，
而是**在 A / B / C 之间裁决**。C 通 ⇒ 兼得 A 的简洁与 B 的隔离；
C 不通 ⇒ 只能在 A / B 之间选，**本 spec 倾向 B**（隔离是结构性的，值那个副本成本），
但这条须在 P2 之前显式确认。

#### ✅ 打靶已完成：路线 C **端到端实测通过**（2026-09-20，本地实验台）

实验台：MinIO（S3 兼容、path-style，ZOS 替身）+ parquet + cube `v1.7.19`（DuckDB 驱动直读 S3）
+ Metabase `v0.63.18.1`（OSS，PG 驱动连 cube SQL API）。全部本地实跑，非推演。

| 实测项 | 结果 |
|---|---|
| DuckDB 走 path-style S3 读 parquet | ✅ （独立验，`s3_endpoint` + `s3_url_style=path` 生效） |
| cube 经 DuckDB 直读对象存储 parquet | ✅ 端到端 |
| 自造 fail-closed（`queryRewrite` 缺 org 即 throw） | ✅ `FAIL-CLOSED: securityContext.org is missing` |
| Metabase **sync** 接 cube SQL API | ✅ `complete`（**这正是历史六次故障所在的那一步**） |
| Metabase → cube 普通查询 | ✅ |
| `__user` 从 **Metabase 透传到 cube** | ✅ 触发身份切换 |
| 非超管切身份 | ✅ **被拒**（`cannot change security context … not allowed`） |
| **超管连接 + 模板变量，同一张卡切 A/B 租户** | ✅ **`tenant-a` / `tenant-b` 各自 500 行，端到端成立** |

**⇒ 路线 C 成立。** 单连接 + 一张共享报表 + 变量 ⇒ 按查询切租户。

**三个实测挖出的坑（实现时必须照做，否则必踩）**：

1. **`checkSqlAuth` 有个隐形契约**：必须**回传「期望的密码」**（Cube 拿它的返回值和客户端给的比）；
   且 **`__user` 触发的再鉴权路径没有密码可比，契约要求回 `skipPasswordCheck: true`**——
   否则切换会被密码校验挡下（表现为 `password authentication failed`，极具误导性）。
2. **Metabase 的模板变量必须写成 `cast({{v}} as text)`**。写成 `'{{v}}'`（引号内）会让
   **Metabase 自己**报 `more parameters than we can handle`——它按**参数化查询**发，
   而 cube 的 SQL API 是**纯文本接口**。不看实测猜不到。
3. **那条 Metabase 连接必须是超管**（`CUBEJS_SQL_SUPER_USER`），否则切不动。

**⚠️ ③ 的安全含义（必须写进设计，不是脚注）**：那条超管连接 = **一个跨租户能力**——
**谁能建 Metabase 报表，谁就能查任意租户的数据**。
⇒ **实测反证了两条既有决定是必需的**：
① **Metabase 绝不对租户暴露**；② **建报表必须经平台中转（§4 的 M2 facade）**——
原先只是「与硬约束一致」的偏好，现在有实测依据；**M1（给管理员开 Metabase 账号直连）被实测否决**
（那等于把跨租户能力交出去）。

#### ⚠️ 本节最重要的发现：cube 的默认姿态与本仓纪律**正好相反**

| | platform-core | Cube Core |
|---|---|---|
| 默认 | **fail-closed**：未声明 = 403（硬约束 #1） | **fail-open**：官方原话「all rows are **public**」——漏写策略 = **静默返回全量** |
| 兜底 | 装载期双向核对，差集即装载失败 | **无**。RBAC 是否启用 = 「至少一个 cube 声明了非空 `accessPolicy`」；没声明的 cube 完全不施加 RLS |
| 佐证 | `packages/platform-sdk/src/checks.ts` 键白名单 | 官方自家承认：「per-tenant data source」recipe **产出的就是不安全配置**，修法是**加 warning 而非改默认值**（PR #11411）；真实串租户事故 issue #4129「Multi tenancy return other's data」 |

⇒ **cube 层必须由我们自造 fail-closed 兜底**。否则是「**配错了就静默串数据**」，而不是
「配置对了就安全」——这正是本仓最忌讳的静默失效。

#### ⚠️ 本节六条的前提（与 §6.2 耦合，这是自检抓到的一处矛盾）

它们成立的前提是「**cube 真的收到了逐租户的身份**」。而 §6.2 表明：Metabase 那条路默认是
**单一服务账号连接** ⇒ cube 可能只看到一个身份。

⇒ **§6.2 的 `psql` 打靶决定这个前提是否成立**：

- 打靶**通过** ⇒ cube 是权限执行点，下面六条是**硬要求**；
- 打靶**不通过** ⇒ 权限执行点下移到**平台胶水层**（查询文本里的租户谓词），
  下面第 1/2/5/6 条的 RLS 相关部分**降级为纵深防御**；
- **但第 3 条（CI 门禁）与第 4 条（串租户回归测试）无论哪条路都必须做**——
  纵深防御同样要能验，而且串租户测试正是唯一能验出「漏接一张卡」的手段。

#### 落地条件（缺一不可）

1. **自造 fail-closed**：`queryRewrite` 里租户缺失即 `throw`（官方明说会阻断查询）；
   模型一律用 `requiredFilter('org')`（缺值 throw）而非 `filter()`（缺值静默放行）。
2. **四件套全配**：`context_to_app_id` + `context_to_orchestrator_id` +
   `pre_aggregations_schema` + `scheduled_refresh_contexts`。少任一项官方都明说会串。
   尤其 `pre_aggregations_schema`：官方 Warning「Cube **will wipe out** the contents of this
   database schema before use」，且**每个 app_id 只求值一次**——不配 `context_to_app_id`
   就派生的 schema 名，会把所有租户钉死在「第一个触发编译的租户」的 schema 上。
3. **CI 门禁机器校验**「每个模型都有 org 过滤」——不能靠人自觉（**官方自己的 recipe 都错过**）。
   按本仓既有姿势实现（键白名单 + 双向核对那一套）。
4. **串租户回归测试**（官方文章建议的测法）：同一查询以两个租户身份跑，断言第二个拿到
   **自己的**数据、而**不是第一个的缓存副本**。
   ※ 这条尤其必要：**cube 的缓存 key 里不含 securityContext**（源码事实：
   `queryCacheKey = [query, values, preAggregations.map(loadSql)]`）。隔离**不是**靠 key 带租户，
   而是靠「租户谓词有没有真的进最终 SQL」——进了 key 自然不同，没进则编译出**完全相同**的
   SQL、**直接共用同一条缓存**。
5. **确认 cube 版本已含 PR #11661**（2026-08-27 merge）——否则 per-tenant `orchestratorId`
   会连接风暴 OOM（该 PR 记录的真实生产事故：router 积压 65,551 个 established socket、
   ingress 6 小时内被 OOM-kill 38–46 次）。
6. **refresh worker 单实例**（官方：「anything above one is **not a supported nor recommended**
   configuration」）且**必须配 `scheduledRefreshContexts`**——预聚合构建路径
   **不经过** `queryRewrite`（源码事实），不配则 context 为 `undefined`，
   `if (tenant_id)` 卫语句**静默不成立**。
   ※ 一处值得记的缺口：`queryRewrite` 的唯一生产调用点覆盖全部 API 查询路径
   （**含 SQL API，SQL API 不是绕过口**），但预聚合构建/refresh 路径不在其中。

#### 规模阈值与拆集群预案（写死，不是「以后再说」）

| 维度 | 已核实的硬限制 |
|---|---|
| orchestrator 池 | `OrchestratorStorage` LRU **硬上限 100**，且**静默忽略** `compilerCacheSize` env |
| 编译缓存 | 默认 **250**、**不可禁用**；warm-up 是 Cube Cloud **独有**，自托管没有 ⇒ 超限即反复冷编译（单次毫秒~秒） |
| 查询队列 | 默认**单条全局队列**（refresh worker 共用），并发默认 5 |
| 内存足迹 | 每 `contextToAppId` ~10–20MB（官方 team 表态）；**闲置租户连接池不自动回收**（LRU 只覆盖部分内存结构） |
| refresh worker | 内存线性增长（已报一例 ~150MB/h、每 ~11.5 小时死一次，持续两个月） |
| 官方口径 | 官方**唯一**数字是 Cloud 侧「>100 tenants → multi-cluster」；自托管无官方租户上限表述。官方最接近劝阻的一句：refresh 过载时「You probably have a lot of tenants… **you'd need to deploy several Cube clusters**（each one per a reduced set of tenants）」 |

⇒ **几十租户 OK；接近 100 即须执行「按租户子集拆集群」预案**（官方路径：路由键 =
`context_to_app_id`、租户粘性），**而不是回到「每租户一套」**。

#### 两条必须记录的可用性事实

- **自托管 Cube Store 无 HA**：官方明说「If any cluster node is down, it'll lead to a
  **complete cluster outage**」（开源版不复制节点）。这是一条**新的单点故障**，须进可用性台账。
- **资源口径（订正 —— 本 spec 草稿曾误述，2026-09-20 重核一手文档）**：
  官方 `admin/deployment/core` 的「Memory and CPU」段给的是**冗余多实例拓扑**的配比：
  2×API（各 ≥3GB/2vCPU）+ refresh worker（≥6GB）+ Cube Store router（≥6GB/4vCPU）+
  2×worker（各 ≥8GB/4vCPU）。**按文档数字相加 = 34GB RAM / 16 vCPU**。
  ⚠️ **草稿曾写「≈28GB」，那是调研报告的转述，与文档数字对不上，已订正为 34GB。**

  **但这不等于「每客户的下限」**，三条都有同一页的原文依据：
  ① 该页明说这些估算是「based on **default settings** and are **very generic**…
     you should **always tweak resources based on consumption patterns** you see」；
  ② 栈组成那句原文是「**One or more** Cube API instance」——**单实例被正面列出**，
     是后面的容量段才写「Each Cube **cluster** should contain at least 2 Cube API instances」；
  ③ 实例数由数据量决定：官方规则「1 Cube Store worker **per partition or per 1M rows
     scanned in a query**」⇒ 数据量小则 1 个 worker 有据可依。

  ⇒ **私有化小客户的真实规格必须按实际数据量实测确定，不得直接套用该表的和。**

- ⚠️ **但有一条躲不掉：Cube Store 在生产模式下必需。** 官方 Warning 原文
  「there're multiple parts of Cube which **require Cube Store in production mode**」
  （它管内存缓存、队列与预聚合）——**不用预聚合也逃不掉**。
  且开源 Cube Store **不支持节点复制**（router 与每个 worker 都只能单实例副本）；
  架构文档明说单实例模式「_can_ be run … this is often **unsuitable for production
  deployments**」，官方 **strongly** 建议跑成 cluster。
  ⇒ 小规模可行，但**这是官方明确不建议的形态**，须在架构评审显式接受并**实测**验证。
- **容量口径**：每 API 实例 **1–10 RPS**；每 Cube Store router **50–100 QPS**。
  （调研报告另称「官方 Helm chart 已于 2023 删除」，**本次未一手核实**，暂不作为设计依据。）

#### L2（每租户一套）的真实触发条件——仅此三条

① 合规要求物理隔离；② 需要 HA（见上）；③ refresh worker 已过载且拆不了。

※ **注意区分**：「每租户独立数据源 / 独立库」**不等价于**每租户一套实例——官方有
「一套实例 + `driverFactory` 每租户一个库」的现成章节（*Multiple DB Instances with Same
Data Model*）。别把前者误当成后者，那会让资源评估高一个数量级。

### 6 Metabase 能力边界（调研已回，2026-09-20）

#### 6.1 ⚠️ 最硬的结论：Metabase OSS **没有任何逐用户隔离能力**

官方原文：*"Row and column security, impersonation, and database routing are only available
on Metabase **Pro and Enterprise** plans."* 更要紧的是——**OSS 连「View data」权限都没有**
（*"Metabase will only display this View data setting in the Pro/Enterprise version"*）。
官方隔离手段决策树里，只有 **locked parameters** 是 OSS 可用的那一支。
（附：SSO / user attributes / `Tenants` 一等公民功能 / impersonation / database routing——
**全部 Pro/EE**。另：官方 FAQ 明说 Pro 与 Enterprise **功能完全相同**，差别在支持与部署形态，别默认「必须买 Enterprise」。）

⇒ **据此重排权限执行点（这是本节对整体设计的最大影响）：**

| 面 | 是不是权限执行点 |
|---|---|
| **平台模块 API**（`identity.orgId` + scope） | ✅ **是**——唯一执行点 |
| **平台胶水层（locked parameter 锁租户）** | ✅ **是**——嵌入路径上的实际执行点 |
| Metabase | ❌ **不是**。它只是**渲染面** |
| Cube 的 RLS（走 Metabase 那条路时） | ❌ **默认失效**（见 6.2） |

⚠️ 官方**明确不建议**把 locked parameters 用于敏感数据：*"Don't use locked parameters when…
You're working with sensitive data. Use a method that enforces access at the permissions or
database level instead."* 我们的场景恰恰是敏感数据 ⇒ **这条是已知的、被官方点名的不推荐用法**，
必须在架构评审时显式接受或推翻（不能默默用）。

#### 6.2 Metabase → Cube：能连，但**单连接会塌缩掉 Cube 的 RLS**

- **能连**：Cube SQL API 走 Postgres 线协议，**Cube 官方有专门的 Metabase 页**
  （*"Metabase connects to Cube as to a Postgres database"*；cube 暴露成表、measure/dimension
  变成列）。需开 `CUBEJS_PG_SQL_PORT`（**默认关闭**）+ `CUBEJS_SQL_USER`/`_PASSWORD`。
- ⚠️ **但 Metabase 官方驱动列表里没有 Cube，Metabase 文档从不提 Cube**——这是「用 PG 驱动
  连一个不是 Postgres 的端点」，**Metabase 侧不背书**。
- ⚠️ **已知脆弱性（实测故障，六例）**：Metabase 依赖大量 PG 专有内省，**每次 Metabase 升级
  都把 Cube 打挂**，典型症状是 **sync 持续失败**（不是连不上），全靠 Cube 侧打补丁兼容。
  已发生：`information_schema.views` 缺失、`has_any_column_privilege`、`FORMAT()`、
  `COL_DESCRIPTION()`、`regclass`、`Type "TIMESTAMP" is not supported for parameter decoding`、
  `current_catalog is not implemented, it's a stub`。
  ⇒ **双方版本都必须锁死，且规定「先升 Cube、再升 Metabase」，并把 Metabase 的 sync 状态
  纳入监控。**
- ⚠️ **权限塌缩（本节最硬的卡点）**：Metabase 一个 database connection = **一组凭据、连接池复用**；
  Cube 的身份来自 **连接级用户名**（`checkSqlAuth`），**SQL API 没有任何 JWT 通路**。
  ⇒ **默认行为是「绕过 Cube 权限」**：Metabase 以单一服务账号连 Cube，Cube 只看到一个
  `securityContext`，**你在 Cube 模型里写的 RLS 被整体塌缩到服务账号上**。
  要救回来只有两条：① 把租户值经 locked parameter 喂进 Cube 的 `__user`（共享连接必须是
  `CUBEJS_SQL_SUPER_USER`，**且每张卡都要接线，漏一张即全租户泄露 = fail-open**）；
  ② 买 Pro/EE 去赌 **connection impersonation → `SET ROLE`** 那条通路
  （机制上通：Metabase EE 发 `SET ROLE <attr>`，Cube ≥ v1.3.71 会据此重认证换 context）
  —— 但**双方文档均未记载、无人验证过**。
- ⇒ **本 spec 的裁定**：**权限判定留在平台胶水层 + Cube**；**Metabase 是渲染面，不是权限面**。
  并在实现前**先做半天 `psql` 打靶**验证 `__user` / `SET ROLE` 能否真的切 `securityContext`
  —— 这条打完才定「Cube 仍是权限执行点」还是「权限全落平台胶水层」。**打靶结论落地前不得开工。**
- ⚠️ Cube SQL API 的硬限制（做 BI 大表要注意）：**默认 5 万行截断**
  （`CUBESQL_NON_STREAMING_QUERY_MAX_ROW_LIMIT` 默认 50000）；**post-processing 的 `ORDER BY`
  官方明说「can be incorrect」**；无写、无 DDL；并发连接上限 `CUBEJS_MAX_SESSIONS`（超了可能 OOM）。

#### 6.3 locked parameters：可用（OSS），但有两个硬折扣

- ✅ **能锁租户**，且官方用例直接就是它：*"You can use locked parameters to display filtered
  data based on attributes captured by your web server, such as a username or **a tenant ID**."*
  值由我们签的 JWT 携带，**对观看者不可见、不可改**。
- ✅ **两种参数都支持**：仪表盘过滤器 与 **原生查询变量（SQL variable）**。
- ✅ **OSS 可用**（guest / static / signed embedding 是同一个东西，*"works on all Metabase
  plans, including OSS"*）。
- ⚠️ **折扣一：带「Powered by Metabase」水印**，去掉要 Pro/EE。
- ⚠️ **折扣二：不能禁止数据导出**（*"only Pro and Enterprise plans can disable data downloads"*）
  ⇒ 嵌入页默认允许导出 CSV。**这是需要显式接受的一条数据外带面**（导的是租户自己那份，
  但它意味着我们无法阻止租户把数据导出到平台之外）。
- ⚠️ guest embed **用不了**：row/column security、database routing、drill-through、
  query builder、AI chat、usage analytics、自定义可视化。

#### 6.4 官方 MCP server **存在**（含 OSS）——但它与「用户不落 Metabase」冲突

- ✅ **官方内建，`all plans` 含 OSS**：端点 `https://{metabase}/api/metabase-mcp`，HTTP transport；
  Admin > AI > MCP 开关（需开 AI 功能，**不需要配 AI provider**）。
  写工具齐备：`create_collection` / `create_dashboard` / `create_question` /
  `update_dashboard`（含归档）/ `update_question` / `execute_sql`（可关）。
  ⇒ **「管理员通过 MCP 创建报表」官方原生支持**，不必自建。
- ⚠️ **但它的鉴权是「会话绑定连接者本人的 Metabase 权限」**——这**要求调用者有 Metabase 账号**，
  与「用户不落 Metabase」**直接冲突**。
- ⚠️ **官方 MCP 没有任何嵌入工具**（Agent API 的 schema 里也没有 `enable_embedding`）
  ⇒「建报表」与「发布 + 锁参数」是**两套 API**：后者只能走**未版本化的老 API**
  （官方亲口 *"We don't version the Metabase API"*，但同一段又明确背书程序化内容创建）。
- ⇒ **⚠️ 待你决策（见 §4 的 MCP 形态分叉）**：① 用官方 MCP + 给管理员开 Metabase 账号
  （省事，但引入第二身份库）；② 自建 MCP facade，内部调服务账号 API key（保住「平台统一身份」，
  多写一层）。

#### 6.5 程序化创建与对账的能力面

- **幂等要自己实现**：`POST` 恒创建、`PUT /{id}` 按 id 覆盖，**API 没有按名 upsert**。
  做法 = `GET /api/search`（或本地维护 name→id）→ 有则 `PUT`、无则 `POST`。
- ✅ `embedding_params` 是 `参数名 → "disabled"|"enabled"|"locked"` 的映射 ⇒ **locked 可纯 API 配**，
  `PUT /api/dashboard/{id}` 接受 `enable_embedding` / `embedding_type` / `embedding_params`。
- ✅ 官方 OpenAPI 规范公开：`https://www.metabase.com/docs/latest/api.json`（534 path）。
- ✅ **对账的正规可观测面**（**以此为准，不要去看 iframe**）：
  `GET /api/dashboard/embeddable`、`GET /api/card/embeddable`、
  `GET /api/dashboard/{id}` 回读 `enable_embedding`/`embedding_params`。
- ⚠️ **未查到、且不得写进对账逻辑**：报表被 unpublish/删除后**嵌入方 iframe 显示什么**
  —— 官方文档没有任何说明，也无可靠社区证据 ⇒ **不可观测**。
- ✅ 凭据：**API key 不是 Pro/EE 功能**（只有「从 config 文件建 key」是 Pro/EE，别混）。
  可做**最小权限**：建一个非 admin 专用 group，key 继承该 group 权限。
- 其他护栏：`PUT /api/permissions/graph` 带 `revision` 乐观锁（写陈旧 → **409**，不动数据）；
  有 Trash（可恢复）；**集合不可永久删除**。

#### 6.6 生命周期（Metabase 自带节奏，与平台不同频）

- **应用库：一开始就用 Postgres**。H2 官方明写*"AVOID in production"*，且 H2→PG 迁移官方
  只给受限支持（版本必须一致、禁止边迁边升级、目标须全新空库）⇒ **别走迁移，起步就 Postgres**。
- **升级**：官方路径是**先备份应用库**；迁移持锁、**必须单节点**；*"otherwise you may end up with
  a **corrupted application database**"*。降级须 restore 备份或用高版本 JAR 跑 `migrate down`。
- **版本纪律**：LTS 支持 14 个月、非 LTS 约 2 个月 EOL；**禁用 `latest`/`.x` 这类可变 tag**；
  当前 LTS = **v0.58**。
- **配置即代码**：**没有官方 Terraform**。官方四条里 `config.yml`/Serialization/Remote Sync
  全是 Pro/EE，**只有官方 CLI `mb`（`@metabase/cli`）的基本内容命令 OSS 可用**（需 ≥ v58，
  自带 Claude Code agent skill）。**漂移对账无官方 runbook，须自建。**

### 7 状态与生命周期

- **启用/停用联动**：模块停用 ⇒ B 停止接收指令、duckle 管线停跑、页面菜单消失
  （沿用 `enabledFor` 请求期门控的既有语义与已知缺口，不另立）。
- **私有化下的删除**：客户退场时该客户的数据面单元整体下线（每客户一套，天然干净）。
- **对账（必须有，不是可选）**：两条双写面各需一条幂等的对账——
  ① 平台登记表 ↔ Metabase 报表本体；② 租户启用集 ↔ 数据面里的租户资源。
  按 M3c 的教训（**配了但不对在请求路径上不可观测**），对账失败必须**显式可见**
  （日志/告警），不能静默。

### 8 有状态面与备份

本设计**引入至少两份新的持久状态**——但它们落在**独立部署单元**里，
**不在 platform-core 的 compose 内**：

| 状态 | 归属 | 可重建？ | 备份性质 |
|---|---|---|---|
| Metabase 应用库 | 新单元 | ❌ **不可重建**（报表/集合/权限的真相所在） | **必须备份**。默认内嵌 H2，**生产必须换 Postgres** |
| **Cube Store 持久层** | 新单元（**但落对象存储**） | ✅ **可重建**（从源 parquet 重算预聚合） | 备份 = **省重建时间**，不是防数据丢失。见下 |
| duckle workspace | 新单元 | ⚠️ 部分（管线定义是真源，中间产物可重建） | 管线定义必须备份；`--temp-dir` 临时盘不用 |
| duckle `--temp-dir` | 新单元 | ✅ 纯临时 | 无需备份 |

**⚠️ 关于「Cube Store」——它不是 Cube Core 的同义词（2026-09-20 补）**

`cube-js/cube` 这个项目里有**两个组件**，常被混称：

| 组件 | 是什么 | 语言 / 镜像 |
|---|---|---|
| **Cube Core**（= 语义层本体，通常说的「cube」） | 数据模型编译、查询 → SQL、对外 API | Node/TS；`cubejs/cube` |
| **Cube Store** | 官方自述「**Cube pre-aggregation storage layer**」——自写的**物化 OLAP 缓存存储**，只做「存并高速返回 rollup 表」；同时承担查询结果的内存缓存与队列 | **Rust**；`cubejs/cubestore` |

- **生产模式必须独立进程**（官方原文：*"In production, Cube Store **must** run as a separate process"*；开发模式下才默认内嵌）。
- **它的持久数据可以放对象存储，官方示例默认放本地目录**（2026-09-20 核一手文档）：
  官方 `cube-store-architecture` 原文「All **persistent data** lives in a **cloud object store**.
  Compute nodes are [stateless]」（图中标注 `(S3 / GCS / MinIO)`）、
  「All persistent data is stored as **Parquet** files」、
  「cloud object store (S3, GCS, MinIO, **or a local directory in development**)」；
  且队列状态也在那里（「the queue state lives in …」）⇒ **compute 节点无状态**。
  ⚠️ 但**官方那份「production-ready」compose 示例用的就是本地目录**
  （`CUBESTORE_REMOTE_DIR=/cube/data` + `volumes: - .cubestore:/cube/data`）
  ⇒ **两种形态都支持，本地目录是示例默认**。
  ⇒ 「Cube Store 数据目录」**要不要备份取决于选哪种形态**：选本地目录 ⇒ 需备份
  （**但它是可重建的派生数据，备份只为省重建时间**，不是防数据丢失）；选对象存储 ⇒ 无本地状态。
  ⚠️ 草稿曾把它登记成「必须备份的有状态面」——**口径过重，已订正**。
- 💡 **收敛点**：Cube Store 的持久层**也是 parquet + 对象存储** ⇒ 可复用到**租户自己的桶**，
  §3「每租户一桶」的隔离继续成立，不必为它另造一套存储。
- ⚠️ **但必须实测**：Cube Store 要连 S3 兼容端点，而本公司在「S3 兼容组件直连 ZOS」上有
  **踩坑史**——WeKnora 两条既有条目确认 duckle 原生 s3 sink 直连天翼云 ZOS 反复 403、
  最终判定能力空白。**不能据此推断 Cube Store 也一样，但也绝不能假设它能连**：
  这是 P1 之前必须打的第二个靶（与 §6.2 的 `psql` 靶并列）。
- 单容器也能起（官方给过 `docker run -p 3030:3030 cubejs/cubestore`），但架构页同时说单实例
  *"often **unsuitable** for production deployments"* ⇒ **同一份文档里存在张力**，
  小规模部署属「能做但不推荐」，须在架构评审显式接受。
- 💡 **对资源规格的意义**：那份示例配比里 **Cube Store 占了大头**
  （router 6GB + 2×worker 16GB = **22GB，约 65%**），而 Cube Core 本体只有 6GB（2×3GB）。
  ⇒ 「cube 语义层没那么大」这个直觉**对 Core 成立**；重的是它旁边那个存储层，
  而存储层的体积**直接由数据量决定**（官方规则：1 worker / 1M rows scanned per query）。

**⚠️ 一处引用自检订正（本 spec 草稿曾写错）**：「`pgdata` 是平台底座的**唯一**有状态面」
这句话在 **`deploy/openship-adopt.md:176`（§3 卷）**，**不在** `docs/architecture.md`，
也**不在** `AGENTS.md`——已逐条核过（`grep -rn 有状态面 --include='*.md'`）。

**且它对本设计仍然成立**：那句话说的是 `platform-core` **这个 project**，而新单元是
**另一个 project**；platform-core 的 compose 仍是 `postgres` + `server` 两个服务。

⚠️ 但它**不得**被读成「整个系统只有一份状态」：接入新单元时，必须在其**自己的 runbook**
里把上面两份列入备份（openship 原生 producer `volume` / `pg-dump`），
且**两个 project 的备份面互相独立**——新单元丢了，平台的租户/品牌配置不受影响，反之亦然。

另：duckle 有 `--memory-limit / --threads / --temp-dir / --max-temp-size` 四个资源预算参数
（DuckDB 默认 spill 可用 90% 磁盘），**共享机上必须显式收口**，否则会打爆同机其他项目。

### 9 语义层选型：**方向反转**（案例证据否决 Cube，2026-09-20）

> ⚠️ **本节是【过程记录】，其建议已被同日定稿的 §11 取代。**
> **§9.1 的「不引入独立语义层」与 §9.4 的方案 1**——都在同日 PoC 证明 `duckdb-ossie` 可行后
> **改为引入语义层**。**以 §11 为准。**
>
> **本节仍然有效的部分**：§9.2（否决 Cube 的完整证据）、§9.3（对「实测通过 ≠ 该采用」的自我约束）、
> §9.6(a)(d)(e)(f)（现成产品交叉点真空 / L1-L2 双层 / Metabase Tenants 陷阱 / Metabase 自带 Models 可作 L2 载体）。
> **被推翻的只有一条**：「不建独立语义层」。

> ⚠️ **本节推翻了本 spec 前文（§5 / §6.2）默认的「用 Cube 做语义层」路线。**
> §5 / §6.2 的 Cube 内容**保留为技术记录**（本机实测确实成立），但**不再是推荐路线**。

#### 9.1 建议（**待确认**，非既成决定）

**不引入独立语义层产品。** 口径沉到**数据层**（本链路 = duckle 产出的汇总/宽表层），
用**视图**暴露给 Metabase。接入层选 **pg_duckdb**（Metabase 走原生 PG 驱动）。

#### 9.2 为什么否决「Cube + Metabase」

**(a) 两头厂商都已主动撤退**——这不是「没人用」，是**双方都不兜底**：

| 事实 | 出处 |
|---|---|
| Metabase **主动删掉** Cube 驱动条目 | `metabase/metabase` PR #49780（2024-11-08），diff 只删一行，正文全文 "Like it says on the tin."，零理由 |
| Metabase 员工 | 「**We don't officially support Cube**」 |
| Metabase 维护者 | 「we don't maintain it with Cube in mind… they could maintain their own separate driver」 |
| Cube **砍掉** Metabase metrics 同步 | `cube-js/cube#9403`（2025）：「we had to **remove the support**」+「**there are no such plans**」 |
| Cube 官方 SLS 清单已无 Metabase | 只剩 Superset / Preset / Tableau；且 SLS **从不进 Cube Core**，只在 Cloud 付费档 |

**(b) 版本级断点 9 次，最新一次至今 open**：0.51.2 的 `FORMAT()`/`COL_DESCRIPTION()` →
schema sync 全挂；修完又撞 `%s`；**2026-03 的 `LIKE … ESCAPE '\'` 让所有字符串筛选全挂，
issue 至今 open**，用户只能靠停在旧版 Metabase。cube 仓 metabase 相关 **16 个 issue 仍 open**。

**(c) 三条容易漏的致命项**：
① **核心卖点失效**——走 REST API 用预聚合，**走 SQL API（Metabase 这条路）不用**；
② **逐用户/租户隔离是架构性限制**（#7415，2023 开至今 open）：粒度是「连接」不是「终端用户」，
维护者称 known limitation 且**从未写进文档**；
③ **Metabase OSS 里能救隔离的机制全在付费档**（Impersonation / Database routing 均 Pro/EE）。

**(d) 业界「Metabase 前加一层语义层」的成功落地 = 0**；Cube 的真实客户几乎全配自研前端或
Superset。有一条 Reddit 原话：「I can't find any real people's accounts of using it beyond
their demo videos.」——**长期稳定的第一人称复盘：零**。
> 盲区声明：Cube 社区在闭源 Slack、Reddit 被 IP 级封锁，故「找不到拆掉的故事」**可能部分是渠道问题**。

#### 9.3 本机实测的定位（**必须降权，这是本节的自我约束**）

§6.2 记的那批实测（sync 成 / 查询成 / `__user` 切身份成 / 每租户数据源成 / fail-closed 成）
**全部为真**，但**只证明「能做」，不证明「该做」**：它解决的是「租户过滤」这一格，
而 §9.2 的 (a)(b)(c) 是**长期面**的问题，实测**碰不到**。
⇒ **不要把「实测通过」当作选型依据**；它只是排除了「根本连不上」这一种失败。

#### 9.4 替代方案（证据强度排序）

| # | 方案 | 证据 | 代价 |
|---|---|---|---|
| 1 | **不建独立语义层**：口径沉到数据层，Metabase 薄展示 | **最强**——业内唯一有工程师自写复盘、且三家做法高度一致（Langfuse / Floryn / Combo） | 丢掉指标复用/血缘/缓存等产品能力，靠纪律补 |
| 2 | 接入层换 **pg_duckdb**（Metabase 原生 PG 驱动） | 结构性正确（无 PG 驱动连非 PG 端点的错配） | ① 每连接一个 DuckDB 实例、`max_memory` 默认 **4096MB/连接**、无 per-tenant 配额；② 需 superuser + `shared_preload_libraries` ⇒ **必须自建 PG**；③ 必须 ≥ v1.1.0 |
| 3 | 用 **Metabase 自带 Data Studio**（它 2026-03 已自称语义层） | 官方主线 | **治理件 Library / 依赖图 / schema viewer / 依赖诊断都标 Pro/EE** ⇒ 先核实 OSS 到底给什么 |

方案 1 的三条纪律（三家一致）：**只读 marts / 禁止对裸表写 SQL / 每模型有 owner + 血缘**。

⚠️ pg_duckdb 的**可见性坑**：`read_parquet()` 裸扫描与 `duckdb.query()` 结果**不是 PG 关系、
不进 `pg_class`** ⇒ **Metabase 看不见**，必须包成视图 / 物化视图 / `USING duckdb` 表。

#### 9.5 对 §5 的影响

§5 的租户分面讨论**仍然有用**，但主路径要换：走 pg_duckdb 时，隔离落在
**PG 角色 + 每租户桶**（pg_duckdb 的 secret 可按 **PG role 的 USER MAPPING** 分，
并有 `SCOPE` 可收窄到某前缀）——**与 §3「每租户一桶 + 每租户一份凭据」同构**。
§5 里 Cube 特有的 `queryRewrite` / `contextToAppId` / `pre_aggregations_schema` 等条款，
**降级为「若将来仍评估 Cube 时的技术参考」**。

#### 9.6 语义层：最终结论与路线（2026-09-20 补；两轮专项调研 + 本机实测）

> 本节是 §9 的结论更新。**前文对 Cube 的否决不变**，但「不引入独立语义层」这个结论
> **被细化了**：不是「不要语义层」，而是「**现成产品不存在，但有一条可自持的路径**」。

**(a) 现成产品：交叉点是真空的**（两轮调研独立撞到同一堵墙）

| 路线 | 判据「语义可配、不入 git」 | 「BI 能查」 |
|---|---|---|
| 商业语义层（GoodData / Kyvos / Sigma / Omni / ThoughtSpot） | ✅ 过（都有 API 写模型） | ❌ **全部不能**（无 pgwire/SQL/JDBC） |
| 有 pgwire 的（AtScale / OrionBelt） | ❌ **全不过**（模型就是 Git 文件） | ✅ 能 |

AtScale 最彻底：官方原文「**The AtScale UI is a Git client**」「Design-time RBAC is managed at
the **source control level (e.g. Git)**」——**正是本设计要避免的**。

**唯一技术三条全中的是 `Slayer`（MotleyAI，MIT）**：pgwire on 5145、模型经 REST 持久化
（存储后端可换 SQLiteStorage）、官方文档点名 Metabase。**但 `v0.10.2 / 2026-03 建仓 / 215★`，
pre-1.0；pgwire 认证是单一共享 token；行级租户隔离只在 engine 侧** ⇒ **够做 PoC，不够压生产**。

**(b) ★ 可行路径：`Apache Ossie`（格式）+ `duckdb-ossie`（执行层）** —— **本机已实测**

| 验证项 | 结果 |
|---|---|
| `duckdb-ossie` 存在 | ✅ DuckDB 社区扩展，MIT，本机 v1.5.5 `installed=true, loaded=true` |
| 它是真语义层 | ✅ 模型加载 → `ossie_metrics()`/`ossie_fields()` 枚举 → **指标是 JSON 里的一等实体** |
| 语义查询 | ✅ `ossie_query([metrics],[dimensions],[filters])` 三种形态全通 |
| **编译成 SQL（可审计）** | ✅ `ossie_compile()` 返回 `SELECT orders.org, sum(orders.amount) … GROUP BY orders.org` |
| **结果与裸 SQL 基线逐位一致** | ✅ `32482.0 + 32680.3 = 65162.3` |
| **按租户绑定** | ✅ **同一模型 + `search_path` 切 schema** → tenant-a/tenant-b 各读各的（`rebind` 参数签名也拿到了：`ossie_load(VARCHAR, rebind MAP(VARCHAR,VARCHAR), validate_sources BOOL, allow_filter_functions BOOL)`） |

⇒ **「指标定义是数据、可枚举、确定性编译、可按租户绑定」四件都成立**——这正是本设计要的语义层形态。

**(c) ⚠️ 唯一阻塞：一个 patch 版本**

```
pg_duckdb 内嵌 DuckDB = v1.5.4        （实测）
duckdb-ossie 只发布到 v1.5.5          ⇒ 安装报 HTTP 404
一手确认：pg_duckdb Makefile:18  DUCKDB_VERSION = v1.5.4
最新发布 tag = v1.1.1 (2025-12-18)，main 的 1.2.0 未发版
```
**▶ 观察项：等 pg_duckdb 把 `DUCKDB_VERSION` 升到 v1.5.5（或更新）。** 届时半小时即可 PoC。

**(d) L1 / L2 双层（用户确认的方向）**

| | **L1 平台语义** | **L2 租户语义** |
|---|---|---|
| 谁定义 | **我方**（产品能力） | **租户自己**（业务配置） |
| 性质 | **代码**（进仓库） | **配置 / 数据**（**永不进仓库**） |
| 数量级 | 几十个 | **N 租户 × M 项** ⇒ 进仓库必然污染，且客户业务细节进代码库（保密/合规） |
| 形态 | Ossie 模型（或 dbt） | 租户表里的配置 + 模块的管理界面/MCP |

**L2 表达力必须受控**：能配「选哪些指标/维度可见、过滤切片、别名、目标值」，
**不能写任意 SQL**（否则治理被绕开 + 隔离被破坏）。真要新指标 → **进 L1**（低频、走 PR）。

**(e) ⚠️ Metabase 的 Tenants 陷阱**：它的设计前提是「**共享语义、隔离数据**」——官方原文
「you can use the same content and group permissions for all tenants, **so you don't have to
create all new stuff for each tenant**」。⇒ **「每租户语义不一样」恰是它想帮你避免的事**，
它没有「tenant 级模型库」。**每租户不同语义只能靠构造**（每租户独立 schema/表 → 各挂各的语义对象）。

**(f) 已实测可用、且是「配置类」的一层**：**Metabase 自带的 Models / Metrics**
（本机 OSS 实测可建可复用：基于 Model 建问题 → 结果与基线逐位一致；collection 权限在 OSS 可用）。
⇒ **可作 L2 的即时载体**（存应用库、不进 git、可 API 管理），
**但它给的是「可复用的模型」不是「有结构的语义层」**（无血缘、无测试、**无漂移检测**——
实测踩到：底层 parquet 列名一变，Model 静默失效直到有人跑它）。

**(g) 建议路线（不赌）**

| 阶段 | 做什么 |
|---|---|
| **现在** | 上「**视图 + Metabase Models/Metrics + 治理门禁**」（§10）——已验证、零新组件、业务能跑 |
| **P0 并行** | 盯 **pg_duckdb 升 DuckDB ≥ v1.5.5**；到位后做 **pg_duckdb × duckdb-ossie PoC** |
| **PoC 成了** | 语义层换成 Ossie：**L1 模型进仓库、L2 租户模型进租户表**，视图降级为物化落点 |
| **PoC 不成** | 维持第一行，**损失可控**（业务逻辑没押在 Ossie 上） |

**纪律：押架构，别押规范。** 业务逻辑的唯一事实源留在**我们自己掌控的文本格式**里，
语义层引擎当**编译产物**——这样 Ossie 冻不冻结、活不活下去，退出成本都是「一次解析任务」，
不是「一次重新建模」。（Ossie 现状：**spec 是 Draft 0.2.0.dev0，白纸黑字 "do not depend on this
version in production"，唯一 tag 是 RC，从无 GA**；但治理已中立化——**MetricFlow 已移交 OSI 共治**
（maintainers = dbt Labs + Snowflake + Tableau），**Metabase v0.63 也已实现 OSI 的 `ai_context` API**。）

### 10 语义治理（四机制，均已本机验通）

> 目的：**不陷入语义困境**——口径要能记录、溯源、排查、看血缘、防漂移。

**(1) 记录**：结构化 `COMMENT ON VIEW`，**与 `CREATE VIEW` 写在同一条迁移里**（物理上无法分叉）：

```sql
COMMENT ON VIEW metrics_xxx IS '{"owner":"…","definition":"…","grain":["org",…],
  "sources":["s3://…"],"tier":"certified","refresh":"live"}';
```
必需字段 `owner / definition / grain / sources / tier`；可用 `::jsonb ?& ARRAY[…]` 机检。

**(2) 血缘（三段，前两段全自动）**：

| 段 | 机制 | 谁维护 |
|---|---|---|
| 报表 → 视图 | 平台**报表登记表**（chart_id ↔ 视图 ↔ 权限码 ↔ **口径版本**） | 模块（P2 建） |
| 视图 → 视图/表 | **Postgres 目录递归** `information_schema.view_table_usage` | **零维护、永不漂移** |
| 视图 → parquet | 正则抽 `pg_get_viewdef()` 里的 `s3://` | 免费（**写法受约束**：路径须字面量可解析） |

**(3) 排查五步阶梯**（每步一条命令）：读 COMMENT → `pg_get_viewdef` → 递归依赖 →
抽 `s3://` 去对象存储核对 → **独立复算**（绕开视图直接打 parquet 与视图输出对比）。
**第 5 步最硬**：不依赖任何元数据，直接验数。

**(4) 四条 CI 门禁**（仿 `check-tenant-isolation.mjs` 的既有姿势）：
① 每个 `metrics_*` 必须有 COMMENT；② 必需字段齐全；
③ **COMMENT 声明的 `sources` 必须与视图 SQL 里实际的 `s3://` 路径集合一致**（钉住文档与实现）；
④ 同名指标唯一 + **每个 metrics 视图必须有一条对账查询且在真数据上通过**。

**软肋（诚实标注）**：① parquet 层血缘是**文本解析非目录**（门禁③兜底，但写法受约束）；
② **跨系统血缘断在 parquet**（duckle 侧要它自己的记录）；③ `tier: certified` 只是标记，无强制；
④ pg_duckdb 的目录查询有 `PGDuckDB/CreatePlan … regclass` 噪声警告（结果正确）。

**何时上 dbt**：上面四机制 dbt 原生全有（`schema.yml`/`dbt docs`/`dbt test`/状态选择）。
**触发条件**：指标数上去 / 多团队改口径 / 「谁改的为什么改」开始扯皮。
**迁移是纯叠加**（视图照旧，改由 dbt 生成），**不返工**。

### 11 架构定稿（2026-09-20，用户确认）

> **本节的结论已经过本机全链路实测，不再是待议建议。** §9.6 的「观察项 / 待 PoC」
> 已在同日完成 PoC（自建 pg_duckdb + Ossie + MCP），下文是收口后的定稿。

#### 11.1 架构

```
duckle（ETL，已定）
   │  parquet，每租户一个 ZOS 桶（复用 M3c TENANT_STORAGE）
   ▼
pg_duckdb ★自建镜像（DuckDB v1.5.5）—— 原生 PostgreSQL 端点
   ├─ Ossie 语义模型    指标/维度是【一等实体】，编译成可审计 SQL
   ├─ 表/视图           物化与暴露面
   └─ 每租户一个 schema + search_path ← 租户绑定
   ▼ 原生 PostgreSQL 驱动
Metabase（BI；AI 建报表经【平台 facade】）
   ▲
platform-core
   modules/<id>/   唯一身份/权限点 · L2 租户语义配置 · 报表登记 · 治理门禁（§10）
```

#### 11.2 七个决定

| # | 决定 | 依据（均本机实测或一手取证） |
|---|---|---|
| 1 | **BI = Metabase** | AI 建报表端到端验通（建报表→建页面→发布→签 JWT 嵌入）；图表构建器对 AI 友好（空 viz settings 也能渲染）；原生 PG 驱动；**官方镜像直接可用** |
| 2 | **语义层 = Ossie 模型 + `duckdb-ossie`** | PoC 全通：模型加载 → `ossie_metrics()` 枚举 → 语义查询 → `ossie_compile` 出 SQL → 与裸 SQL 基线**逐位一致** → 按租户绑定 |
| 3 | **★ pg_duckdb 自建镜像（DuckDB v1.5.5）** | ossie 只发到 v1.5.5，官方 pg_duckdb 钉 v1.5.4（实测 404）。**自建已验证可行**（见 §11.4） |
| 4 | **L1 / L2 双层语义** | L1 平台语义（Ossie JSON，**进仓库**，是产品）；L2 租户语义（**租户表里的配置，永不进 git**） |
| 5 | **AI 建报表走平台 MCP facade** | Metabase 那条连接是**跨租户能力**（实测：超管连接可切任意租户）⇒ 调用者绝不可直连 |
| 6 | **隔离 = 每租户一桶 + 每租户一份凭据 + 每租户一个 schema** | Metabase OSS 的逐用户隔离是**零**（Pro/EE 才有），隔离只能下推数据层 |
| 7 | **治理 = §10 四机制** | 已本机验通；**Ossie 只管编译、不管治理**，这块必须我们补 |

#### 11.3 AI 的两条已验证路径

| AI 要做的事 | 走哪条 | 验证状态 |
|---|---|---|
| **问数据**（自然语言 → 答案） | **`duckdb-ossie` 自带 MCP** | ✅ 实测：`tools/list` **只有 `semantic_query`**；调被关掉的 `query` → **`Tool not found`**（安全包含成立，且有 `scripts/mcp_check.py` 双向 CI 断言） |
| **建报表 / 建页面** | **Metabase（经平台 facade）** | ✅ 实测：建报表→建页面→放上去→发布→签 JWT 嵌入 |

⇒ **两条都落在自己的栈上，都不需要第三方 SaaS。**
⇒ 「AI 问数据」这条路的口径由**你声明的词表**决定（agent 只能用 `ossie_metrics()`/`ossie_fields()` 里的名字）——
**与「平台统一控制口径」同向**。

#### 11.3.1 ⚠️ AI 消费的权限模型（实测：**ossie 的 MCP 自身不带权限**）

**事实**：把 `duckdb_mcp` 的全部设置项列尽，**没有任何身份面**——
`mcp_allow_all_commands` / `mcp_console_logging` / `mcp_disable_serving` / `mcp_lock_servers` /
`mcp_log_file` / `mcp_log_level` / `mcp_server_file` / `allowed_mcp_commands` / `allowed_mcp_urls`
（其中的 `user` / `username` 是 DuckDB 的 HTTP/S3 设置，**不是 MCP 鉴权**），
发布函数（`mcp_publish_tool` / `mcp_publish_query`）**也没有 auth 参数**。

⇒ **它是本地 stdio 进程，「鉴权」= 操作系统层面谁能起/接上它。接上即全量**（所有租户、所有指标）。

**因此 facade 是唯一的鉴权与定租户点，且要做【两件事】——不是一件：**

| facade 的动作 | 解决什么 | 现状 |
|---|---|---|
| **① 定租户 → 绑数据**（`search_path` / `rebind` / 每租户 schema） | **数据隔离** | ✅ 本机实测可做（平台控制会话 ⇒ 各租户只读自己的） |
| **② 按调用者 scope 裁词表** | **指标级授权** | ⚠️ **Ossie 模型里没有这个概念，必须在平台侧现算** |

第 ② 条易漏：**同租户内不同角色该看到不同指标**，而 Ossie **没有按主体授权的构造**
（`allow_filter_functions` 是「准不准用过滤函数」的开关，不是「谁能看哪个指标」）。
落地方式：facade 按 scope **动态生成** MCP 的 `metrics` / `dimensions` 两个资源
（它们本就是「发布的查询」，可由 facade 代发）。
⇒ 与 §11.3 的「**AI 的自由度 = 你给它声明的词汇量**」是同一件事。

**★ 安全论断（必须写死）：`semantic_query` 的 filter allowlist 防的是「AI 写任意 SQL」，
防不了「AI 用允许的维度去够别的租户的数据」。**

> 过滤条件是 **AI 自己提供**的。若会话绑的是全量数据，一个 `orders.org = 'tenant-b'` 就能横跨租户。

⇒ **「AI 消费必须经平台」不是架构洁癖，是安全必需**；**保护来自每租户的会话绑定，
不来自 ossie 的 filter allowlist**。只要 facade 按租户绑会话，filter 再怎么猜也只能在自己那份数据里猜。

**▶ 观察项（补充）**：`duckdb_mcp` 将来是否长出身份面（token / user / 按主体的工具授权）。
若长出，facade 的一层可省；**但「租户绑定」这件事无论它怎么长都仍归平台**。

#### 11.4 自建 pg_duckdb 的 recipe（单容器 `docker commit` 路径 = 实测；多阶段容器化路径 = 已按 T1 实证订正）

> **「可照抄」的边界（2026-09-22 订正）**：本节原标题自称「实测，可照抄」——**这个说法只对 ④ 的单容器 `docker commit` 路径成立，而且要先补上 ①′ 哨兵步**；**多阶段容器化路径已被 T1 交付实证证伪**（照抄本节原文即构建失败或加载失败）。订正依据见本节末。

```
依赖：liblz4-dev libzstd-dev zlib1g-dev libcurl4-openssl-dev（+ cmake/ninja/g++/postgresql-server-dev-17）
源码：gh api repos/duckdb/duckdb/tarball/v1.5.5    ← 别用 git clone（子模块在这条网上爬不动）

① 预填 third_party/duckdb（解压 tarball，绕开 git submodule）
①′ 补子模块哨兵：mkdir -p .git/modules/third_party/duckdb && touch .git/modules/third_party/duckdb/HEAD
    （不加必挂：Makefile 的每个目标文件都挂在 $(OBJS): .git/modules/third_party/duckdb/HEAD 上，
     该路径缺失时 make 去执行 `git submodule update --init --recursive`，
     而 tarball 解出的树不是 git 仓库 ⇒ fatal: not a git repository，退出 128。
     源码已由 ① 预填到位 ⇒ 哨兵文件让 make 判该 target up-to-date、跳过 recipe 即可解除。
     main 与 v1.1.1 的 Makefile 都有这条前置 ⇒ 与 pg_duckdb 版本无关）
② make DUCKDB_VERSION=v1.5.5 \
     DUCKDB_CMAKE_VARS="-DCXX_EXTRA=-fvisibility=default -DBUILD_SHELL=0 -DBUILD_PYTHON=0 \
       -DBUILD_UNITTESTS=0 -DDISABLE_UNITY=1 -DOVERRIDE_GIT_DESCRIBE=v1.5.5" \
     CMAKE_BUILD_PARALLEL_LEVEL=2 -j2
③ 手工补一行上游 bug：third_party/duckdb/src/common/allocator/allocator_jemalloc.cpp 缺
   #include "duckdb/common/string_util.hpp"
   （⚠️ 该文件属 DuckDB、在第三方子模块树内——pg_duckdb 自己的 src/ 下没有它
    （v1.1.1 实证：src/ 只有 catalog/pg/scan/utility/vendor 与 pgduckdb_*.cpp，无 common/ 目录）；
    旧稿的简写 src/common/allocator/... 会 No such file 当场失败）
④ make install → docker commit 成派生镜像
```

**三个编译配置缺一不可**：`DISABLE_UNITY=1`（统一编译单元 OOM）、
`CMAKE_BUILD_PARALLEL_LEVEL=2`（外层 `-j` 压不住 ninja，它按 nproc 起 8 个 ⇒ OOM）、
**jemalloc 那个 include 补丁（上游真 bug）**。

**④ 单容器 `docker commit` 路径为什么碰不到「运行期缺库」这类坑**（⇒ 这才是「可照抄」的真实边界）：

- **运行期 `libcurl4` 天然被带进来**：`libcurl4-openssl-dev`（构建依赖）依赖 `libcurl4`；`docker commit`
  提交的是**整个构建容器**，那份 `libcurl4` 就留在镜像里了 ⇒ 无需显式装。
  **多阶段容器化路径不继承 build stage 的包**（最终 stage 只拿 `COPY --from=build` 的产物）⇒
  **必须显式 `apt-get install -y --no-install-recommends libcurl4`**。不装 = 运行期报
  `libcurl.so.4: cannot open shared object file`——这是**扩展加载失败，不是构建失败**
  （`libcurl.so.4` 是 `libduckdb.so` 的 NEEDED，`ldd` 可验；`postgres:17` 基镜像不带它）。
- **单容器路径没有「多阶段继承」这回事**（只有一个 stage），故无此坑。
- ⚠️ **但 ①′ 哨兵不是 ④ 能豁免的**：它源于「tarball 解出的树不是 git 仓库」这条性质，与单容器/多阶段**无关**
  ——两条路径在同一 cwd 跑同一个 Makefile，前置条件一样。所以「④ 可照抄」的前提是**先补 ①′**。

> **订正依据（2026-09-22，T1 交付实证 + 评审复核）**：本书原文的 ③ 是**简写**（未点明在第三方树内），
> ①′ 哨兵与多阶段运行期 `libcurl4` 是**缺项**——三者照抄即失败。多阶段容器化路径（`deploy/pg-duckdb/Dockerfile`）
> 已按实证订正；本节已同步（①′ / ③ 路径 / ④ 的边界说明）。**旧稿是已证伪的版本，别再照抄旧稿。**

#### 11.5 运行期三个硬约束（实测踩到，必须知道）

1. **★ pg_duckdb 的 DuckDB 实例是「按连接」的** ⇒ `SET`（GUC）与「用它」**必须在同一会话**。
   `install_extension` 同理：必须在同一会话里同时开
   `duckdb.allow_community_extensions` **和** `duckdb.allow_unsigned_extensions`。
   （跨会话会报出极具误导性的错——签到三次。）
2. **`duckdb.query()` 跑在 DuckDB 原生上下文，看不到 Postgres 表** ⇒ 用 `duckdb.raw_query()`
   在会话内建 DuckDB 侧的表/视图。
3. **`rebind` 的键是「模型里声明的 `source`」**（官方例子 `MAP{'tpcds.public': 'memory.main'}`）；
   **per-schema + `search_path` 是更贴架构的那条**（每租户一个 schema，同名视图各指各的数据）。

#### 11.6 `duckdb-ossie` 的风险与对冲（必须一起看）

**风险是实的**：`iqea-ai/duckdb-ossie` —— **3 stars / 0 fork / 0 issue / 建仓 2026-08-12 /
两个维护者**，且**不在 `apache/ossie/converters/` 里**（它自称的「reference implementation」未经基金会列名）。
对照规范仓 `apache/ossie`：**2,160 stars / 280 forks / 135 open issues / 今日仍 push**。

⇒ **规范很硬，实现很薄。** 那句「最坏情况推演（它停更 → 自己写编译器）」**不是尾部风险，是基准情形**。

**但对冲成本低，三条**：
1. **它证明了这条路可行**——存在证明不需要成熟；PoC 的每个行为都可作为我们自己实现的规格
2. **MIT ⇒ 可合法 fork**；它只有 ~8 个源文件、纯 C++/cmake，**接管成本低**
3. **核心能力就是「JSON/YAML → SQL」**，**自己实现是几百行的确定性任务**

⇒ **别把 `duckdb-ossie` 当依赖用，把它当规格说明书用**：fork 它，或照它写自己的那几百行。
**两条路都比「押一个语义层产品」便宜。**

#### 11.7 押架构不押规范（贯穿性纪律）

**业务逻辑的唯一事实源，留在我们自己掌控的 JSON/YAML 里；语义层引擎只当编译产物。**

- Ossie 成了 → 白拿互操作（别人能读我的模型、我能换引擎）
- Ossie 死了 → 我的 JSON 还在，编译器我自己写
- **两种结局都不亏** —— 这才叫「方向靠谱」

**要选的是「业务逻辑以我掌控的文本格式存在」，不是「支持某个标准」。**

#### 11.8 分阶段

| 阶段 | 做什么 | 出口 |
|---|---|---|
| **P0** | 把自建 pg_duckdb 固化成 **CI 构建 + 版本化镜像**；把 §11.4/11.5 写成 runbook | 一条命令产出可用镜像 |
| **P1** | 私有化单租户闭环：duckle → parquet → pg_duckdb + Ossie → Metabase | 全链路可见 + 容器时间戳验新代码 |
| **P2** | L2 配置层 + MCP facade + 报表登记 + **§10 治理四机制** | 越权被拒；对账能暴露漂移 |
| **P3** | SaaS 多租户：每租户 schema + 凭据收紧 + **串租户回归测试**（含缓存重放） | 从数据面**反向**验隔离 |

**架构先行门**：P1 开工前必须先改 `docs/architecture.md`（§1 拓扑 / §2 组件表 / §5 扩展点），
并把 §11.4 的「自建镜像」这个新组件写进去。

#### 11.9 仍开放（不含糊）

| # | 事项 |
|---|---|
| 1 | **数据面单元的仓落点**（自建镜像的构建仓 / 数据单元的编排仓放哪） |
| 2 | **L2 表达力划在哪档**（A 薄：可见性+过滤+别名+目标值 / B 中：+受限表达式 / C 厚） |
| 3 | Ossie 的观察信号（见 §9.6(g)）：0.2.0 GA、round-trip issue 收敛、`apache-ossie-dbt` 上 PyPI |
| 4 | 自建镜像的**构建频率与触发**（跟 pg_duckdb 上游走还是跟 DuckDB 版本走） |

## 架构影响（架构先行门 —— 必须先过评审）

公司规则明列 6 项越权动作，本设计撞 **4 项**：

| 越权项 | 本设计哪里撞 |
|---|---|
| 组件新增 | B / duckle / cube / Metabase / MCP 工具面，5 个新组件 |
| 存储方案变更 | 新增 ≥2 份持久状态（§8）+ 数据落 ZOS 桶 |
| 接口设计变更 | 模块 ↔ B 契约、模块 ↔ MCP 契约、跨 project 对接 |
| **鉴权方案变更** | MCP 凭据如何映射到平台身份（含 AI 客户端直调那条） |

⇒ 顺序必须是：**先经人同意 → 更新 `docs/architecture.md` → 再写代码**。
本 spec 本身不等同于该同意。

**须同步更新的文档（自检后订正）**：

- `docs/architecture.md`：**§1（拓扑）**新增「模块可依赖**仓外**数据面单元」这一形态；
  **§2（组件表）**为该形态补一行；**§5（扩展点）**加「依赖外部数据面单元的模块怎么接」。
  ※ **§1.2 的两个服务不变**——新单元不在本仓 compose 内（B7）。
- `.env.example`：新增键（数据面地址、MCP 凭据位置），B9 门禁覆盖。
- **新单元自身另立接入 runbook**（含卷与备份、`--token` 硬要求、资源预算四项）——
  **落在新单元自己的仓里，不在本仓**。
- `AGENTS.md` / `deploy/openship-adopt.md`：**不改**（经核对，二者均无被本设计推翻的表述）。

## 工程面

| 面 | 改动 |
|---|---|
| `modules/<id>/` | 新建模块：manifest + index.ts + migrations + console 页 |
| 独立部署单元 | 新建仓（或本仓外的目录）：compose + 各服务 Dockerfile + MCP 工具面 |
| `deploy/docker-compose.yml` | **不动**（B7：新单元自带编排，不在本仓 compose 内） |
| `.env.example` | 新增键（数据面地址、MCP 凭据位置），B9 门禁 |
| 备份策略 | 新增卷入账（§8） |

## 验收

1. **私有化形态**：单客户全链路——模块落 parquet → duckle ETL → cube → Metabase 嵌入
   看板可见；容器时间戳验「跑的是新代码」。
2. **SaaS 形态 · 串租户（本清单最重要的一条）**：两租户并发——**租户 A 的任何入口都
   看不到租户 B 的数据**，且必须**从数据面服务侧反向验**，不能只验 UI。其中**必测缓存重放**：
   以租户 A 身份查一次 → 再以租户 B 身份查**同一条查询** → 断言 B 拿到**自己的**数据，
   而**不是 A 留下的缓存副本**（cube 缓存 key 不含 `securityContext`，这是最可能漏的一条）。
3. **权限双门**：无 scope 用户看不到页；有 scope 但租户不匹配时嵌入报表查不到数据。
4. **MCP 两条入口**：AI 客户端直调与控制台入口走同一鉴权链；**越权调用必须被拒**
   （超管/租户管理员越界各测一条）。
5. **对账**：手工在 Metabase 里删掉一个已登记报表 ⇒ 对账能把差异暴露出来（不是静默）。
6. 全量门禁（`pnpm test` / `typecheck` / gates / smoke）+ PR（feat 需先建 issue）。

## 已知边界

- **「放弃终端用户自助分析」订正为：不是取舍，是 OSS 的硬边界。** 调研确认逐用户隔离、
  SSO、user attributes、`Tenants`、impersonation、database routing **全部 Pro/EE**；
  guest embed 本身也不支持 query builder / drill-through。若要自助分析，升级路径 =
  **上 Pro/EE + SSO + row/column security 或 `Tenants`**，另开一轮设计。
  ⚠️ 升级账要算清：① **按嵌入用户数计费**（官方原文 *"count toward the accounts billed"*）；
  ② **Cube 身份透传仍未解决**（即便有了 Metabase 用户身份，送进 Cube 仍要 `__user` 注入或
  那条未验证的 `SET ROLE`）。另：**Pro 与 Enterprise 功能相同**，别默认买 EE。
- **OSS 的两个硬折扣已记录**：嵌入带「Powered by Metabase」**水印**（去水印 = Pro/EE）；
  **不能禁止数据导出**（嵌入页默认允许导出 CSV）——这是一条显式接受的**数据外带面**。
- **本设计依赖一条「官方明说不推荐」的用法**：用 locked parameters 锁租户。官方原文建议
  敏感数据改用「permissions 或 database level」。**这条必须在架构评审时显式接受或推翻，
  不能默默用。**
- **Metabase ↔ Cube 的版本耦合是长期运维负债**：Metabase 官方不支持 Cube（驱动列表无 Cube、
  文档从不提 Cube），已发生**六次「Metabase 升级打挂 Cube sync」**。
  **双方版本锁死 + 先升 Cube 再升 Metabase + sync 状态入监控**——不是一次性配置，是要养的。
- **双写面是结构性代价**（报表在 Metabase、登记在平台），靠 §7 的对账兜，不可能消除。
- **SaaS 形态的可行性押在 §5 的 L1**（一套实例 + 行级过滤，已由调研确认为可行）。
  若实现阶段发现 §5 的六条落地条件无法满足，则回到 §5 的 **L2 触发条件**（合规要求物理隔离 /
  需要 HA / refresh worker 过载且拆不了）重新评估——**而不是**擅自改成「每租户一套」。
- 模块停用后的**路由层不吃 config** 是平台既有缺口（issue #127），本设计沿用不修。
- `bindings` 仍是死字段；本设计**不复活它**（复活与否归 issue #126）。若最终认为该由协议
  表达「模块需要外部服务」，那是另一个设计，须先改 `docs/module-protocol.md`。
