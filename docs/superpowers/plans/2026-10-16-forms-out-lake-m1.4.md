# M1.4 forms 出湖管线 实施计划

> **For agentic workers:** 本计划按采集正典 `docs/data-platform-handbook.md` 的 A→I 逐段执行；
> 流程执法用 `.claude/skills/collect-source`；判据数值只在正典与 spec，本计划不复制。
> Steps 用 `- [ ]` 跟踪。

**目标**：表单提交数据出湖——forms 导出 API → duckle `src.rest` → parquet 写湖 → dbt 通用 staging；
**任何新表单零改动自动可见**（新表单只是新的 `form_def_id` 值）。

**设计来源**（均已人审）：explore `docs/adr/0005-collection-form-layer.md` §13.1 ①②④（通用域设计 + 两处实测定案）；
正典 `docs/data-platform-handbook.md` §1.1.7（标准形态）/§1.3（A→I SOP）/§3（落地位置）。

## Global Constraints

- **调度归口 = duckle console**（正典 §1.1.7/§1.7）。⚠️ ADR §13.1 那句「sync job（openship job 调度）」
  是**松写法**，与正典冲突 ⇒ **正典赢**：管线调度走 console，openship job 只管**物化**。（此冲突登记在案，
  见下方「登记义务」。）
- **payload 列型 = 整列 VARCHAR**（JSON 文本，schema-on-read）。⚠️ 引擎默认行为**是反的**（落成全字段
  并集 STRUCT）⇒ **必须显式 `CAST(to_json(payload) AS VARCHAR)`**（ADR §13.1 ① 实测）。
- **追加语义靠批次目录**：`snk.parquet` 的 `mode:append` + 固定分区文件名**实测是覆盖不是追加**
  ⇒ `_batch`（运行时刻）列进 `partitionBy`，每轮新目录；读端 glob 全量；同批重跑幂等（ADR §13.1 ② 实测）。
- **鉴权零新增**：导出 API 声明 `forms:view`；数据面用**宿主既有 PAT**（`Bearer dkq_`，
  `apps/server/src/pat-auth.ts` + `runtime.port('data','resolvePatKey')`）。凭据值住 duckle
  `connections/<id>.json`（**密文**），管线 JSON 零密钥字符（正典 §1.1.7）。
- 三同纪律 / B1：导出面在 `modules/forms` 内，只碰 `forms.*` 与 `platform.*`。

## 闸门：本任务命中 skill 的「升级条款」第 2 条（新的数据域）

按 `collect-source`：「新数据域 ⇒ 先 brainstorming + spec 定案（人同意 → 改架构文档 → 再写码）」。
**本计划即该 spec 的落盘**；设计本身已由 ADR §13.1（人审）与路线图 M1.4 定，故此处不再重开设计讨论，
只把「实施面选择」与「冲突登记」写明待确认。

## 裁决：回迁 forms 到 mytech 数据面（2026-10-17，人已定）

> **本节的地位**：它**推翻**下文 E·console 的原落点。E·console 原文写「在 mytech 数据面项目
> （`proj_SU8cmQ8OLVfM971X`）新增 forms console 服务行」，**实施时偏离到了山海数据面**
> （`proj_AFbJvyb0onaX7LVr` / server `8281d598`），由此产生正典 §2 台账行尾那条「org 列 = 数据面
> 部署常量，与源租户 mytech 的关系待裁决」。人于 2026-10-17 裁决**回迁**。
> 按 `architecture-first`：**人已同意 → 先改架构文档 → 再写码**。本节先落事实、牵扯面与待人决策；
> 架构文档更新（R1）完成并过审后，才动 R2 及之后的代码/基建。

### 1 缺陷的机制（不是「console 放错机器」这么轻）

`org` 是**行级授权主体列**（`modules/data/domain/authz.ts` 恒拼 `WHERE org = '<orgId>'`）⇒ 标错租户
不是标签问题，是**可见性反转**：标 `shanhaiyiguo-org` 的 mytech 表单，山海用户看得到、mytech 用户看不到。

值**不是 console 盖的**，是物化 job 盖的（2026-10-17 取证，全部经 openship MCP exec，无裸 SSH）：

| 环节 | 事实 | 取证 |
|---|---|---|
| org 值来源 | `materialize.sh`：`SO=$(docker exec "$PLAT_CT" psql … 'select casdoor_org from platform.tenant order by id limit 1')` → `export LEMENG_SUBJECT_ORG="$SO"` | `scripts/lemeng/materialize.sh` |
| 即 | org = **数据面部署租户的常量**，与「这批数据是谁的」**无关** | `dbt/macros/subject_org.sql`（空串 fail-closed） |
| 该 job 的 `PLAT_CT` | `openship-platform-core-shanhai-postgres`（**山海**平台） | `materialize.sh` 硬编码缺省 |
| 湖里 | `staging.stg_forms_submission` **1 行**，`org = shanhaiyiguo-org` | 山海 pg_duckdb 直读 |
| 源侧 | mytech 平台 `forms.submission` **1 行**（`org = mytech`）；山海平台 **0 行** | 两平台 DB 直读 |
| 落点 | forms console `ZOS_BUCKET=shanhai-data`（**山海桶**） | forms-console 容器 `printenv` |
| 消费面 | 两侧 `data.metrics` 均 **0 条**触及 forms | 两平台 DB 直读 |

**契约其实写对了前提**：`contracts/common/forms.submission.json` 的 `layout.partitionBy` 只有
`["bizday","batch_id"]`——**org 刻意不进湖**，理由逐字是「在『一 console 一租户』下 org 是**部署常量**」。
⇒ 设计没错，**实施违反了它的前提**：console 落在了「部署租户 ≠ 源租户」的那台数据面。
⇒ 当前是**潜伏**缺陷（0 指标）；但 M1.4 的**全部意义**就是让它可查 ⇒ **第一个指标即泄漏**。

### 2 回迁的真正牵扯面（比「搬一个服务行」大一个量级）

两个数据面实测对照（2026-10-17，openship MCP）：

| | mytech 数据面 | 山海数据面 |
|---|---|---|
| project / server | `proj_SU8cmQ8OLVfM971X` / `23a1091e` | `proj_AFbJvyb0onaX7LVr` / `8281d598` |
| 平台→仓库（Gate-B） | **不通**：`getent hosts pg_duckdb` 无记录、`TCP FAIL ENOTFOUND` | 通：`172.18.0.4:5432` |
| warehouse 库 | 空（只有 `duckdb` schema 2 表，**无 `staging`/`data`**） | `staging` 有数（含 `stg_forms_submission`）、`data` |
| pg_duckdb 的湖凭据 | **无**（读 `s3://*` → `region ''` 默认端点 404） | 已配（读得了湖） |
| `dbt` / `duckle` 服务行 | 均 disabled；卷是 `../dbt`、`../duckle`（**相对 bind = 被当卷名**，已知坑） | 均 disabled；卷是 `/opt/...` 绝对路径 |
| console 行 | `lemeng-console-3120/64188` 是**空壳**（无 env、无卷） | 3120 / 64188 / **forms** 三行在跑 |
| 物化 job | **无**（`23a1091e` 上无 `/opt/*.sh`） | `lemeng-dbt-materialize`（`sh /opt/lemeng-materialize.sh`，`27 3 * * *`） |

⇒ **mytech 数据面是 2026-09-24 建了却从未启用的桩**；forms 之所以「跑得起来」，是因为它借了唯一
在跑的那台。⇒ 本裁决的实施面 = **把 mytech 数据面从零启用**（SOP `deploy/data-plane-deploy-sop.md`
P1–P8），不是搬一行服务。

### 3 绕不开的架构缺口：共享 dbt 树没有「域」这一维

`materialize.sh` 的 `mat_dbt_args()` = `build --profiles-dir /usr/app`——**全量 build、无 `--select`**
（#679 刻意：名单曾是事实全量，按需会漏）。而两个域**共用一棵树**：

```
dbt/models/common/staging/   ← stg_forms_submission.sql 与 stg_lemeng_*.sql 同目录
dbt/models/common/marts/     ← 全是乐檬 fct_*
```

⇒ 两侧都会 build 对方的模型，且**两种失败都很响**：

- **mytech 侧**全量 build 乐檬模型：读的是同一个 `shanhai-data` 桶 ⇒ **会成功**，把山海的乐檬业务
  数据物化进 mytech 仓库、**标成 `org=mytech`**（**反向泄漏**，方向与本次缺陷相反）；
- **山海侧**继续 build forms：桶里 forms 目录一空 ⇒ dbt 红 ⇒ `exit 1` 发生在写 `load_log` **之前**
  ⇒ 水位冻结、**所有指标的新鲜度固定行连带退化**（正是 #752 那个 bootstrap 缺陷的复发形态）。

**所以「按部署隔离域」是本裁决的硬前提，不是优化。**

### 4 建议（待确认）

| # | 动作 | 机制 / 注意 |
|---|---|---|
| 1 | 目录按域分：`models/lemeng/` + `models/forms/`（现 `common/` 拆开）。**二维格子定案：域是顶层轴、客户分叉嵌在域里**（`models/<域>/customers/<客户>/`）——`common/` 溶解成域的默认 | 现有 `STAGING_RE`/`MARTS_RE` 已是 `models/(?:.+\/)?staging/` ⇒ **门禁判据不用改**，只需改错误文案里写死的 `models/common/staging/` 路径。**现在改最便宜**（实测 `customers/` 下只有 README、无真子目录）。⚠️ 代价不是「纯仓内」：`dbt/` 在 `deploy/data-plane-manifest.txt` 是**投递项** ⇒ 重命名改 lock ⇒ **山海侧要重新 sync 数据面工件** |
| 2 | 域开关：**已实测选定** —— `dbt_project.yml` 按路径 `+enabled`，值由 `env_var('DATA_PLANE_DOMAINS')` 给（**不带默认值**） | 合 `materialize.sh` 头注的**成文处方**（「用该模型的 config 表达，**不要恢复 job 级名单**」）。实测（dbt 1.9.1 + dbt-postgres 1.9.1 = `deploy/dbt/Dockerfile` 钉的版本）：设 `forms` ⇒ manifest 只剩 forms 的模型（lemeng **整个不出现**）；**不带默认值**时变量未设 ⇒ **parse 报错（fail-closed）**；**带默认值 `''`** ⇒ 解析成空串 ⇒ **0 个模型、退出 0 ⇒ `MATERIALIZE_OK` 假绿**（默认值绝不可给）；域目录**未登记** ⇒ 默认 `enabled=true` ⇒ **每个面都 build 它**。⚠️ `+enabled` 里**不能引用本文件 `vars:` 块的 var**（`models:` 渲染早于工程 vars）。⇒ **fail-closed 域覆盖门禁是必需**：枚举 `dbt/models/*/`，每个域目录必须有显式 `+enabled` 条目——两个方向都静默（未登记 ⇒ 反向泄漏；漏配变量 ⇒ 零模型假绿），正是 #677/#679 假绿同形 |
| 3 | 两侧 materialize job 各传自己的域；mytech 侧 job 的 `PLAT_CT`/`PG_CT`/`CONSOLE_CT`/`NETWORK` 全指 mytech 资源 ⇒ `SO=mytech` | ⚠️ **`materialize.sh` 必须改，不是「无需改脚本」**：`mat_env_args()` 是**写死的 8 键清单**，`materialize.test.sh` 还钉了「`-e` token 恰 8 个」并逐键枚举 ⇒ 新 env 不进去 dbt 根本收不到。只有容器/网络/平台库那几个参数是已支持 env 覆盖的 |
| 4 | env 键 `LEMENG_SUBJECT_ORG` → 域中性名（如 `SUBJECT_ORG`） | 回迁后它是 forms 部署的主体来源，`LEMENG_` 前缀会误导。改净面：`dbt/macros/subject_org.sql`、`profiles.example.yml`、`materialize.sh`、`dbt/README.md` §（同名小节）、`schema.yml` 描述若干 |

### 5 待人决策

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | **桶**：mytech 数据面复用 `shanhai-data`，还是新开 `mytech-data`？ | **新开 `mytech-data`**——复用 = 把 mytech 自身域的表单数据写进**客户（山海）的桶**，与交付边界相悖；同桶还会把 §3 的反向泄漏从「配错才发生」变成「隔离一失效就发生」。**✅ 已核实（2026-10-17）：湖侧只有 4 个桶，没有 mytech 自己的湖桶 ⇒ 开桶是人工前置。** 核实方法与证据见下 |
| 2 | 山海侧 forms 残留（console `svc_nQaReL0EvSBqK9gW` + `staging.stg_forms_submission`）何时退 | 回迁验收通过后**同批退**，避免双写窗口 |
| 3 | ~~**爆炸半径**：「按域分次 build + 分次落账」是否纳入 R2？~~ | ✅ **已落地（2026-10-17，单开一个 PR）**。`materialize.sh` 改成**逐域跑**：每域一次 `dbt build`（域身份逐次收成单个值，**命令仍无 `--select`**）、每域成功即落该域的水位；红的域不落账、其余域照常，最后统一 `exit 1`。落账表集 = 「全 bizday 表」∩「本域 staging 模型名（**从树派生**）」⇒ 不引入手写名单。**动因是当天实测两次全量冻结**（#833 / #834 的 audit） |
| 4 | **「源 ≠ 部署」怎么发现？** | **建议加管线断言**。三条不变量今天**无门禁**；而配置一致性检查**抓不到** #729——那次是**源**（mytech 的导出 API）与**面**（山海）不一致，两侧配置各自自洽。可用抓手：导出响应**带 `org`**（A2）⇒ 断言「本页 `distinct(org)` ⊆ 部署主体 org」，不通过**拒写湖**。**当前不存在这条断言** |

### 5.1 桶核实（2026-10-17，三条独立证据，全部经 openship MCP / 容器内只读）

| # | 证据 | 结果 |
|---|---|---|
| 1 | openship `get_projects_by_id_storage`（`proj_SU8cmQ8OLVfM971X`） | `binding: null`、`candidates: []` ⇒ **openship 答不了**（ZOS 是外部存储，openship 只管它自己装的 MinIO app） |
| 2 | 仓内检索桶名 | 桶名**从不硬编码**，一律经 `LEMENG_ZOS_BUCKET` / `ZOS_BUCKET` env 取 ⇒ **仓也答不了** |
| 3 | SigV4 `ListBuckets`（stdlib 签名器，跑在 forms-console 容器内，凭据取容器自身 env） | `HTTP OK`；**桶清单 = `after-sales` / `bucket-5b9f` / `lemeng-datasource` / `shanhai-data`**（恰 4 个，**无 mytech 湖桶**） |

> **附带结论**：该 ZOS 凭据**具备账号级 ListBuckets 权限**（能列出全部 4 个桶，不只是自己那一个）。
>
> **交叉验证（DuckDB glob 判别）**：山海 pg_duckdb 上 `glob('s3://shanhai-data/*')` → HTTP 200；
> `glob('s3://mytech-data/*')` → **HTTP 404 `region 'xinan1'`**；阴性对照 `zzz-no-such-bucket-probe-xyz`
> → **同款 404** ⇒ `mytech-data` 对该凭据不可见。（S3 对不存在的桶返回 **404 NoSuchBucket**，不是 403。）
>
> ⚠️ **本次刻意未测 `CreateBucket`**：那是在公司 ZOS 账号里的**真实基建变更**，且超出 openship 管辖面
> ⇒ 归 R5 的人工前置，**不在此处顺手做**。

### 6 修订后的步骤（替代下文 E·console）

- [ ] R1 **架构文档更新**（新增「域」维度 + 数据面归属口径）→ 人审 —— **稿已成：PR #818**（`docs/architecture.md` 新增 §2.5 + §2.2/§4.2/§5.1 三处交叉引用），**待人审**
- [ ] R2 dbt 树按域分目录 + 域开关（`+enabled` + `env_var('DATA_PLANE_DOMAINS')` 不带默认值，已实测，见 §4 第 2 行）+ **fail-closed 域覆盖门禁** + 门禁文案。⚠️ **不是「纯仓内」**：`materialize.sh`/`materialize.test.sh` 必改（8 键清单 ⇒ 加第 9 键），`dbt/` 是投递项 ⇒ lock 变 ⇒ **山海侧要重新 sync**
- [ ] R3 mytech 数据面启用：S3 凭据 → Gate-B 接线 + `search_path`（`wire-warehouse.sh --check` 七断言全绿）→ `dbt`/`duckle` 服务行改绝对路径卷 → 数据面工件 sync（lock）
- [ ] R4 mytech 侧 materialize job（照 `lemeng-dbt-materialize` 形态，容器名/网络全换 mytech）
- [ ] R5 forms console 落到 `proj_SU8cmQ8OLVfM971X`（**新桶 —— 人工前置：开 `mytech-data`，见 §5.1**）→ seed workspace（含 `.duckle/keys/secret.key`）→ 重建 catalog → 首跑成功
- [ ] R6 验收：staging `org = mytech` + mytech 平台侧可查（四层验收）
- [ ] R7 山海侧残留退役 + 正典三处登记更新 + WeKnora 沉淀

> 数据**不需迁移**：mytech console 按 `id` 水位从源 API 重拉（增量语义天然覆盖）。

## 文件结构

| 路径 | 职责 |
|---|---|
| `modules/forms/routes.ts`（改） | 加 `GET /export/submissions`（声明 `forms:view`） |
| `modules/forms/storage.ts`（改） | 导出查询：增量水位 + 分页（游标） |
| `modules/forms/manifest.yaml`（改） | 声明导出端点（双向核对） |
| `contracts/forms/submission.json` | 湖列集**唯一事实源**（4 列 + payload 文本） |
| `deploy/duckle/console/pipelines/forms.submission.json` | 管线（真引擎产出后提交） |
| `deploy/duckle/console/schedules/<账套>.json`（改） | 排班种子（登记面①） |
| `dbt/models/common/staging/stg_forms_submission.sql` | 通用 staging（新表单零改动可见） |
| `docs/data-platform-handbook.md`（改） | §1.7 决策行 + §2 数据源行 + §5 验收行（收尾义务） |

## A→I 逐段计划

### A 摸清源（§1.3.1）

⚠️ **本任务的特殊性：源是我方自建** ⇒ A 段与「建源」合并——先落导出 API，再对它跑探针四条。

- [x] A1 建 `GET /export/submissions`：参数 `since`（增量水位，ISO8601）/ `limit`（服务端上限）/ `cursor`（游标分页）
- [x] A2 响应形状：`{ rows: [{ org, form_def_id, submitted_at, payload }], next_cursor }`
- [x] A3 **探针四条**（对真实端点，不引 PoC 结论）：真实值 / 能力反问 / 跨度上限 / whoami 级主体
- [x] A4 探针结论落任务目录；页参数与增量字段写进结论（C/D 段引用）
- [x] **判停**：探针没跑完不写湖

> 📌 **2026-10-17 勾选订正**：A3/A4/判停 原为未勾的**陈旧状态**——四条探针实际已跑（结论落
> `.superpowers/sdd/` 任务目录，被 C/D 段引用；`stg_forms_submission.sql` 头注亦记「探针四条对真实
> 端点跑过」），且 F1–F3 验收与主验收均已通过。此处只补齐勾选，不改判据。

### B 选型定案（§1.1 / §1.7）

- [x] B1 选 **L0 直连**（单窗/日频/无跨窗编排 ⇒ 一条管线 + 一条调度，§1.1.7）
- [x] B2 §1.7 补登记行（通道/落点前缀/分区键/节奏/调度归口/验收结论=空）

### C 契约（§1.3 + §1.2 B10）

- [x] C1 `contracts/forms/submission.json`：4 列，`payload` 为 **text**（整列 VARCHAR 定案）
- [x] C2 双轨同改：契约 + 管线内 `data.schema` 申报 + `qa.contract` 断言**两处一致**
- [x] C3 改列集跑 `gen-data-projection`（生成物必须 == 已提交，不手改投影）

### D 管线（§1.3 + §1.6 案例库）

- [x] D1 管线 JSON 由**真引擎**产出后提交（不手编）
- [x] D2 分页配置**成对检查**（页参数与翻页机制同在——缺一边 = 静默只取首页）
- [x] D3 `CAST(to_json(payload) AS VARCHAR)` 显式定型在位
- [x] D4 批次目录：`_batch` 进 partitionBy
- [x] D5 空响应按申报构造（缺申报 = 空页运行时才炸）

### E 调度（§1.3 + §1.5）

- [x] E1 排班 seed 进 `schedules/<账套>.json`（**登记面①**——只进 pipelines = 线上永不自动采集）
- [x] E2 重建 catalog（**登记面②**——不重建 ⇒ run record 不带 assets ⇒ 新鲜度锚静默失效）
- [x] E3 跑一次成功 run 起算新鲜度时钟（**登记面③**）
- [x] E4 排班如实入账（§2 台账行 + 调度记录对得上）

#### E 段实施分解（2026-10-17 定案：forms 走**专属 console**）

> 决策（人确认 2026-10-17）：forms 建**自己的 console/workspace**，不与乐檬账套混装——ADR-0014「一账套一
> console」；混装根因是**调度条目带不了自己的 env**（实测：提交时塞 env/args/params 被静默丢弃）⇒ 静默采错源。
> 下列各条是上文 E1–E4 的分解，**依赖顺序不许跳**：`E·闸 → E·种子 → E·console → E·告警(反向测试) → E·登记面②③ → E·验收 → E·收尾`。

- **E·闸**（先做，纯静态可当场验）：`check-console-schedules.mjs` 的「共享族」判据从「无数字后缀」
  升级为「**同域**（管线名首段）+ 本账套后缀」；账套书 → 域：纯数字 = `lemeng`，非数字书名 = 其字面量域
  （`forms`），且该域必须有管线。随之**删除** `EXEMPT_GLOBAL` 里 `forms.submission.l0` 那条豁免（它存在的
  唯一理由就是闸把无后缀管线当乐檬共享族——正是那条注释预告的动作）。
- **E·种子**（登记面①）：新增 `schedules/forms.json`（一条 `forms.submission.l0`，`enabled: true`，
  `timezone: Asia/Shanghai`，日批）。⚠️ **两处联动**：① `console-schedules-tz.test.ts` 钉的是「两本种子
  23 条」+ spec §10.6 转换表（其头注：改排班先改表，改表先改 spec）⇒ 加书必须同步改测试与表；
  ② `check-console-alerts` 判据 B ⇒ 已排班管线必须被**同源** `alerts.forms.json` 的 `on: [failure]` 命中。
- **E·告警**（G 段的仓内件，`data-monitor` 执法）：新增 `alerts.forms.json`（`match: forms.submission.l0`、
  `on: ["failure"]`、`channel` 走既有 OO 转投，与 `alerts.lemeng.json` 同源同路）。🚦 **硬判停（skill 场景 C）**：
  合并前必须做**反向测试**（人为触发一次真红 → OO 规则/企微真收到）并留证；该测试依赖 console 已存在 ⇒
  **仓内文件（E·种子/E·告警）与基建（E·console）同批做、反向测试后再合入**。
- 🚨 **E·console — 本节已被上文「裁决：回迁 forms 到 mytech 数据面」取代。** 实施时**偏离到了山海数据面**，
  由此产生 org 主体列错标（详见裁决节 §1–§3）。**回迁步骤见裁决节 §6（R1–R7），照本节原文做会复发同一缺陷。**
  原文保留仅作沿革记录。
- **E·console（原稿）**（生产机动作）：在 mytech 数据面项目（`proj_SU8cmQ8OLVfM971X` / server `23a1091e`）新增  **forms console 服务行**——照 `lemeng-console-<账套>` 形态（image `platform-core-duckle:local`、**独立
  workspace 卷**、不与既有 `duckle`/etl 服务行共用）。凭据面：workspace 内 `connections/<id>.json`（密文）+
  平台侧**一 PAT 一租户**（导出按 `identity.orgId` 隔离）。seed：`schedules.json` + `pipelines/`（含管线依赖的
  子管线/连接）+ `alerts.json` / `owners.json`。两个已实测的坑：① **相对 bind 会被当卷名**（挂载一律绝对路径）；
  ② 卷内定义**重启即生效**，改 **env 键**必须 refresh 重建容器。
- **E·登记面②③**：② 重建 catalog（`POST /api/catalog` 或容器内 `duckle catalog build --workspace /workspace`）
  ——漏了 ⇒ run record 整条不带 `assets` ⇒ 新鲜度锚静默失效；③ 跑一次成功 run 让新鲜度时钟起算（历史不追溯补）。
- **E·验收**（= 下文 F）：首跑成功后再**恢复** `stg_forms_submission`（#752 的暂时摘除）。
- **E·收尾**：正典 §5 验收行 + §1.6 案例库（只增不改）+ WeKnora（先查重）；并在 §1.7 备注注明 ADR「sync job
  调度」那句按松写法处理（#729 🔴 区）。

### F 验收（§1.4 / §1.4.1）

- [x] F1 四层验收逐层过（自证 / 幂等 / 独立通道 / 跨系统），缺一层不算过
- [x] F2 **主验收：新表单零改动自动可见**——新建一个形状不同的表单并提交，复跑 V4 round3 形态断言
- [x] F3 管线内闸只判「不可能错」的断言

### G/H/I

- [x] G 告警可达、新鲜度锚验过「匹配到」（非只配了没生效）
- [x] H 回填走同一条管线换时间窗（首用时实测 duckle 原生 backfills）
- [x] I 退役：本任务不涉及

## 收尾义务（skill 硬性）

1. 正典三处登记：§1.7 / §2 / §5
2. 新坑进 §1.6 案例库（只增不改）
3. WeKnora 沉淀（先查重，命中更新）

## 待确认（实施面选择）

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | **湖前缀**：`forms/submission`？ | 建议 `forms/submission/<org>/<bizday>/_batch=<ts>/` —— 与 `lemeng/<表>` 形态对齐 |
| 2 | **节奏**：日频还是更密？ | 建议**日批**（与 §1.1.7 的 L0 直连默认一致）；表单提交是低频事件，日批足够 |
| 3 | **水位字段**：用 `submitted_at` 还是 `id`？ | 建议 **`id`（bigserial）**——`submitted_at` 可被同秒并发提交撞出漏窗，`id` 单调无歧义 |
