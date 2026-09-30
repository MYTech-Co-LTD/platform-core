# 零售明细直读视图设计（spec ③ · 单条链）

> **一句话**：给零售订单明细做一条 **dbt 视图**（不物化、直读湖），让 AI 能在授权范围内读到
> **明细粒度 + 湖的新鲜度**，而不是只能读日更的聚合表。
>
> **本 spec 只做一条链**：零售明细 → 视图（每租户 schema）→ 逐列显式 cast → 注入 `org` → 两条真机 gate。
> **不含**：AI 的接入身份与凭据下发、`#175` 桶策略、其它源与维度面、「定格边界」原则的升格——各自另开。

上位依据：`docs/architecture.md` §2.2（数据栈分工，2026-09-26 订正后「AI 可在授权范围内直读数据面」）、
`docs/superpowers/specs/2026-09-26-subject-org-column-design.md`（主体列，其实现为 PR #258）。

---

## 0 已拍板的决策（2026-09-26，用户确认）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **只做单条链**（零售明细一张视图） | 本仓一贯 incremental（S1→S2 的走法）；两条 gate 还没验 ⇒ **先拿一张证**；错了只错一张 |
| 2 | **不含** AI 接入 / 凭据下发 / `#175` | 属性不同（仓内 dbt vs 数据面凭据面）；一份 spec 一个决策面，评审不混 |
| 3 | 「物化取舍原则（定格边界）」**先写在本 spec，标注「待升格」** | 无案例不立标准：现在只有 1 租户、0 条跑通的链 |
| 4 | 新增一层 **`views/`**（dbt 生成的只读关系） | 明细直读在分层里没有归属层 ⇒ 必须显式加一层，并同步架构文档（架构先行） |
| 5 | 本期就把物化 job 改成**按租户跑** | 视图要落进 `tenant_<org>`；连带 marts 也进该 schema（见 §3.6） |

---

## 1 现状事实（逐条带出处；2026-09-26 实测）

### 1.1 采集节奏：**零售明细当前是「日更」**

| 源 | 调度在哪 | cron | 状态 |
|---|---|---|---|
| 零售明细（3120） | openship job `lemeng-retail-3120-runner`（`custom:NchVfw7_7ffc_WJT`） | `30 2 * * *` | **enabled**；**2026-09-26 02:30 跑成功**（296s） |
| 零售明细（64188） | duckle console 自带调度 `deploy/duckle/console/schedules/64188.json` 的 `lemeng.retail.windows.run` | `30 2 * * *` | enabled |
| 零售明细（3120，console 那条） | 同目录 `schedules/3120.json` 同一条 | `30 2 * * *` | **`enabled: false`** ⇒ 3120 走上面那个 openship job |
| 维度面 branch | 两个 console | `0 2 * * *` | 两账套都 enabled |
| 维度面 item | 两个 console | `0 11 * * *` | 两账套都 enabled |

⇒ **零售明细的湖里数据每天更新一次**（≈02:30 UTC 之后）。**这条直接决定 §6 的「本期收益」判断**。

**作业落点正在迁移（读文档，别按旧口径写）**：`docs/data-platform-handbook.md:100` 的归口表把「何时跑」
一分为二——**采集（duckle 管线）的调度归 duckle 自带调度器**（宿主 = 数据面常驻 console），
**非 duckle 的 runner（dbt、自建脚本）仍归 openship job**（理由逐字：dbt 是另一个 runner，
**容器内没有 docker，丢不进 console**）。
迁移计划的切法见 `docs/superpowers/plans/2026-09-26-lemeng-scheduling-via-duckle.md:11,209`：
**第一片只接维度面**（纯新增、零迁移），**零售 job「不在本计划内」且明写「其迁移需单独决定与观察 ——
别顺手一起动」**。⇒ 本 spec **不碰零售采集的迁移**；也**不把物化搬进 console**（归口如此）。
⚠️ 附带一处文档漂移：那份计划写的落点是 `deploy/duckle/schedules/…`，仓里实际是
`deploy/duckle/console/schedules/…`（本 spec 以后者为准）。

### 1.2 湖现状（经 pg_duckdb 回读，2026-09-26 实测）

零售订单明细：**3 个营业日**（`2026-09-23` ~ `2026-09-25`）、**90,837 行**、**2 个账套**。

### 1.3 视图形态：真机已验可行（同日 spike，逐条为实测）

- ✅ 视图体里放 `read_parquet` 的调用**可行**：建视图成功、查询成功（90,837 行）。
- ✅ 视图里**注入常量列**可行（`'<值>'::text as org`）——这是「视图带主体列当行级授权锚点」的前提。
- ✅ `information_schema` 里可见，`table_type` 报 `VIEW` ⇒ 满足 gate 2「物化落点必须是 PG 可见关系」。
- ⚠️ **视图的每一列都必须显式 cast**：不 cast 时日期列/金额列在 `information_schema.columns` 里呈现为
  **`USER-DEFINED`**；显式 cast（`::date` / `::numeric(20,2)`）之后才回到 `date` / `numeric`。
  视图是「按列暴露给消费层」的形态 ⇒ **硬要求**。
- ⚠️ **过滤器下推（分区裁剪）未定论**：3 天数据下单日过滤 207ms vs 全量 249ms，**分不出差别**；
  且 `duckdb.query` 只接受**单条 SELECT**（喂 `explain …` 报 `Parser Error: Expected a single SELECT statement`）
  ⇒ **拿不到 DuckDB 计划**，不能靠计划回答。
- ⚠️ **「新落盘文件可见」未直接实测**（要往湖里加文件才能测，属写操作，未做）——机制可推（视图不存数据 ⇒ 每次查询重新展开 glob）、**未直接验证**。

### 1.4 现有门禁**看不见新层**

主体列门禁（规则 ⑩，随 #258 落地）的扫描面是 `dbt/models/**/staging/stg_*.sql` + `dbt/models/**/marts/*.sql`
⇒ **新增的 `views/` 会整体逃检**。这正是这类门禁最容易漏的形态（规则加了、层加了、不覆盖）。

### 1.5 物化 job 的两处现状

- 命令**只活在 openship 里**（`lemeng-dbt-materialize`，`custom:yNWqnvY65iWz1unf`，cron `20 3 * * *`）：
  SOP §F.6 自己记了这条遗留「无版本、无 diff 可评审」。
- `--select` 是**硬编码**的四个模型；**不带 `--vars '{tenant: …}'`** ⇒ 现状一切落进默认 schema
  （**per-tenant schema 这条能力至今没有在真机上被行使过**）。
- **这个 job 是 2026-09-26 13:43 新建的**（`createdAt`，是 #253 那笔读路径修复的产物），
  至今只有**两次手动跑**（都成功）；**第一次定时跑是 2026-09-27 03:20 UTC，本 spec 落笔时还没发生**
  ⇒ **它的「定时可靠性」未验**（别把「手动跑成功」读成「每天都会成功」）。
- ⚠️ 由此看出一处**文档漂移**：`docs/data-platform-handbook.md:308` 写「现状：没有任何 job 在跑 dbt，
  PG 物化停在 09-23」——那是**该 job 建立之前**的状态，现已不成立。本 spec 以本节实测为准（顺手提一句，
  修哪一条由后续收口那笔决定）。

### 1.6 dbt 侧缺省与既有纪律

`dbt/dbt_project.yml` 缺省 `+materialized: table`，且每个模型**再显式写一次** config
（防「改项目缺省静默改变语义」）⇒ 新视图模型必须显式 `materialized='view'`。

---

## 2 「物化取舍」判据（**待升格**，本轮只写判据不立标准）

> **物化 = 已定格的历史；直读 = 未定格的（今天 / 流动窗口）。**

用它解释本 spec 的取舍：**明细开视图**（明细要能问到「今天正在发生的」），**marts 仍物化**
（口径是历史的、定格后日更足够）。**物化的频率由「数据多久定格」决定，不由采集频率决定。**

**升格路径（写明但本轮不做）**：等这条链跑通且有真实运行数据（≥1 个采集周期）后，把判据提炼进
本仓正典 `docs/data-platform-handbook.md`（采集正典）或按需升为公司标准。**现在不升**：只有一个租户、
零天运行数据，且视图的两条 gate 未验——凭它立标准就是拍脑袋。

---

## 3 设计

### 3.1 新层与命名

| | 层 | 物化 | 读什么 |
|---|---|---|---|
| ③ | `dbt/models/**/staging/stg_*` | table | 湖（定型一次） |
| ④ | `dbt/models/**/marts/fct_*` | table | staging |
| **新** | **`dbt/models/common/views/vw_lemeng_retail_order_line.sql`**（**待落仓**：随本 spec 的实现） | **view** | **湖（定型 + 逐列 cast）** |

- 归属：dbt 生成的**只读明细面**（七层里属 ⑦ 消费的材料，但由 dbt 的机制产生）。
- 命名：`vw_<域>_<表>`，与 `stg_` / `fct_` 前缀区分。
- **架构先行**：本 spec 合入时**一并改 `docs/architecture.md`**（§2.2 第 3 条 dbt 的输出句 +
  §6.1 订正指针加一行：七层的分层叙述自此多一层）。**文档先于代码**。

### 3.2 共享 macro：列清单的**唯一定义点**

视图要自己读湖 + 自己定型 ⇒ 与 staging 的「读 + cast」**职责重叠**。抽一个 macro 输出**列清单**
（18 列 + 注入列），让 **staging（表）与视图（视图）共用同一份**：

- 位置：`dbt/macros/`（与 `dbt/macros/generate_schema_name.sql` / `dbt/macros/subject_org.sql` 同级）。
- 为什么不用「视图复制一份列清单 + 加一条断言两处一致」的替代方案：那是**两处维护 + 靠门禁兜**；
  macro 是**一处定义**，与 `generate_schema_name.sql`（schema 名的唯一定义点）同风格。
- **重构 staging 是这次的真实动作**：现有 `stg_lemeng_retail_order_line.sql` 改为调 macro。
  它的输出受三层保护（schema.yml 的列级测试、规则 ①/⑩、两条 `audit_*` 独立复算）⇒ 可验。
- ⚠️ **未验**：macro 展开后的 SQL 是否与今天逐字等价，只能由真机 `dbt parse` + `audit_*` 对账回答
  （本机没有 dbt）⇒ 归本 spec 的真机验收。

### 3.3 视图体：逐列显式 cast（硬要求）

按 §1.3 的实测：不 cast ⇒ 消费层与元数据面看到 `USER-DEFINED`。⇒ 视图体里**每一列都写显式 cast**，
与 staging 的定型规则**由 §3.2 的 macro 保证同源**。

同时**不依赖 hive 推断**（既有正典纪律：分区键一律显式 cast，不依赖推断——零填充 `hour=07` 与
无前导零目录读回的**类型不同**）。

### 3.4 主体列 `org`：复用 #258 的 macro

视图体末尾注入 `{{ subject_org() }} as org`（与 staging / marts 同一 macro、同一 env 键
`LEMENG_SUBJECT_ORG`）⇒ **视图也带着行级授权锚点**。

**前置依赖**：`dbt/macros/subject_org.sql` 随 **#258** 合入。⇒ ③ 的实现排在 #258 之后（见 §7）。

### 3.5 门禁：扫描面扩到 `views/*.sql`（否则新层逃检）

- `scripts/check-data-models.mjs` 的规则 ⑩ 扫描面从「staging + marts」扩到 **+ `dbt/models/**/views/vw_*.sql`**。
- **空转自检**照旧（什么都没扫到 / 全落豁免 ⇒ 判违规）。
- fixtures 补一格：`views/` 下的模型缺 `as org` ⇒ 红。
- 这一条**必须与视图模型同一个 PR**：先加层、后补门禁 = 中间那段时间新层是裸的。

### 3.6 物化 job：本期改成按租户跑（+ 顺带收口一处遗留）

**为什么动的是 openship job、而不是把它也搬进 console**：`docs/data-platform-handbook.md:100` 的归口表
逐字写着「非 duckle 的 runner（dbt、自建脚本）→ **openship job**（dbt 是另一个 runner，容器内没有
docker，丢不进 console）」⇒ **dbt 物化的归口就是 openship job**，与 §1.1 那条迁移**不冲突**
（迁移的是采集的「何时跑」）。

视图要落进 `tenant_<org>` ⇒ job 必须带 `--vars '{tenant: …}'`（与 #258 的 `LEMENG_SUBJECT_ORG` 同一批补）。

- `--select` 加视图模型（**硬编码清单**，忘了加 = 视图永远不建，且**不会报错**）。
- **连带影响（必须写进验收）**：marts 也会跟着落进 `tenant_<org>`；消费侧靠
  `deploy/data-tenants/provision-template.sql` 里 role 的 `search_path` 解析（模板已写，**pg_duckdb 上未验**）
  ⇒ 加一条真机 gate。
- **顺带收口 SOP §F.6 记的遗留**：既然这次必须改 job 命令，就**同时把命令抽进仓**
  （`scripts/lemeng/materialize.sh` + 进投递清单），job 只调 `sh /opt/…`。
  理由：不然这次改动**又是一次无法评审的生产编辑**——而那正是遗留条目要治的病。

---

## 4 验收

**本机（可跑的逐字命令）**：

```bash
pnpm exec tsx scripts/check-data-models.mjs      # 含扩面后的规则 ⑩
pnpm run test:guard                               # fixtures（含新格）
pnpm typecheck
for s in check-manifests lint-architecture check-compose check-env-example \
         check-data-plane-lock; do pnpm exec tsx scripts/$s.mjs; done
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs  # dbt/** 改了就必须重跑（本仓两次实测踩过）
```

**真机（数据面机，经 openship MCP；本机没有 dbt / pg_duckdb）**：

1. `dbt parse` 通过（容器内，用现成的 `platform-core-dbt:local`）。
2. 视图**建成**、`information_schema` 里类型**不是** `USER-DEFINED`、能在 `tenant_<org>` 里查到。
3. `audit_*` 对账仍绿（证明 §3.2 的 macro 重构没有改变 staging 的输出）。
4. 两条 gate（§5）。
5. 消费侧 `search_path` 解析（§3.6 的连带）。

---

## 5 两条 gate

| gate | 怎么验 | 状态 |
|---|---|---|
| **新鲜度** | 建好视图后，**等下一批采集落湖**（≈次日 02:30 UTC 之后）再查视图能否看见新分区。**不需要造文件**（自然实验） | 待跑 |
| **分区裁剪** | 湖里攒到**足够天数**再测时间差。经验下限 **≥ 14 天**（现在 3 天，207ms vs 249ms 分不出）；计划层面拿不到（§1.3）⇒ 真正的判据在跑 gate 时定 | **挂起** |

**裁剪的兜底（现在只登记、不设计）**：若裁剪不成立，退路是「高频物化最近窗口 + 视图读历史」——
形态等结论出来再设计，**不许先按「视图一定便宜」做容量规划**。

---

## 6 已知边界 / 非目标

1. **本期收益是「明细粒度」，不是「新鲜度」**（重要，两句都要看）：
   - **明细粒度：立即兑现**。现在 `fct_retail_sale` 只有 4 列、粒度是**账套 × 业务日**
     ⇒ 问不到「哪个商品/哪家门店/哪个时段/哪些订单作废」。视图给的是**行粒度明细**（18 列）。
   - **新鲜度：本期 ≈ 0**。采集是**日更**（§1.1）⇒ 视图与「日更物化的表」在新鲜度上**没有差别**，
     只省掉物化那一段延迟。要兑现「销售数据 08:00–24:00 每 5 分钟」那条需求，**采集频率得先提上去**
     ——那是另一件（**已立 issue #260**，不在本 spec）。这条与正典一致：
     `docs/data-platform-handbook.md:272` 该源的台账行写的就是「**设计 5min tick / 现行日粒度**」。
   - **落点正在迁移**（§1.1）：采集的「何时跑」正迁往 duckle 自带调度器，**零售那条尚未决定**
     ⇒ **新鲜度的判据以迁移后的落点为准**；若零售切过去且频率变了，本节结论要重算。
   ⇒ **别拿本 spec 去宣称「明细已经实时了」**；它宣称的是「明细问得到了」。
2. AI 的接入身份 / 凭据怎么按租户下发：**另开**（今天真机上是全局一份凭据、无收窄）。
3. `#175`（每租户一桶 vs 共享桶 + 前缀）：**另开**。本期只有一个租户，两种都跑得通。
4. 其它源、维度面、marts 的视图化：**另开**。
5. 「定格边界」判据的升格：**另开**（§2）。
6. **不改** `#258` 已落地的 marts/staging 形态与 `contracts/`。

---

## 7 依赖链（③ 的实现被前面卡着）

```
spec B 补 LEMENG_SUBJECT_ORG（+ 本 spec 的 tenant var）
        ↓
   #258 合入（subject_org macro 到位）
        ↓
   ③ 可实现（视图复用 macro）
```

⇒ **spec B 的那一小步是 ③ 的前置**。替代方案是 ③ 自带一份等价注入——**不采用**：那会造出
第二个 `org` 定义点，正是 #258 花力气消灭的东西。
