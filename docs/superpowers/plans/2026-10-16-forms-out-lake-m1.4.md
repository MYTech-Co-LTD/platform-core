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
- [ ] A3 **探针四条**（对真实端点，不引 PoC 结论）：真实值 / 能力反问 / 跨度上限 / whoami 级主体
- [ ] A4 探针结论落任务目录；页参数与增量字段写进结论（C/D 段引用）
- [ ] **判停**：探针没跑完不写湖

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
- **E·console**（生产机动作）：在 mytech 数据面项目（`proj_SU8cmQ8OLVfM971X` / server `23a1091e`）新增
  **forms console 服务行**——照 `lemeng-console-<账套>` 形态（image `platform-core-duckle:local`、**独立
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
