# 乐檬采集 S2-a（维度面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `nhsoft.user.ai.branch.find`（门店维）与 `nhsoft.base.ai.item.find`（商品维）接成**双账套全量快照**：契约 / 管线 / staging 三件套各自同一个 PR，落湖并可由 dbt 读。

**Architecture:** 复用 S1 立下的范式——duckle 唯一执行器（管线由真引擎产出，不手写落仓）、分区单文件覆盖写（`all.parquet`）、契约是**人写的意图源**而机器面是 `node.data.schema` + `qa.contract` + `drift`。与零售链路的**唯一结构差异**：维度是**全量快照**（分区键 `snapshot=<日期>`，不是 `bizday/hour`），且商品维量级大一个数量级。

**Tech Stack:** duckle（桌面版引擎，MCP 已接）/ DuckDB / 天翼云 ZOS / dbt 1.9 + dbt-postgres / pg_duckdb / openship MCP（jobs 唯一通道）。

## Global Constraints

- **三件套同一个 PR**（`contracts/` + `duckle/` + `dbt/` staging）——少一件即半接（`docs/architecture.md` §5.1 第 2 条）。
- **管线必须由真引擎产出并通过 `validate_pipeline` 才落仓**；禁止手写 JSON 后不验证（`duckle/README.md` §4）。
- `node.data.schema`（`data.schema`）**只声明标量列**；嵌套数组**不要**声明为 json 再去 UNNEST（`duckle/README.md` §4 第 1 条坑）。
- 类型词表（实测，`run_pipeline` 拒绝 `integer`）：`string / int32 / int64 / float32 / float64 / bool / date / timestamp / time / decimal / json / binary / geometry`。
- **路径一律绝对路径**（`变量 workspace` 在 run 时不解析）。
- **密钥只写 `${ENV:...}`**，任何文件不落明文；输出不回显值。
- 时间一律 RFC3339 UTC。**openship cron 按 UTC 解释**（SOP §E.7）：北京时间 10:00 ⇒ `0 2 * * *`；19:00 ⇒ `0 11 * * *`。
- 幂等：`snk.minio` 用 `mode=overwrite` + `format=parquet` + `compression=zstd`，每叶子分区一个 `all.parquet`。
- 改 `deploy/data-plane-manifest.txt` 覆盖的任一文件后，**必须重跑** `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`，否则 `gates` 红。
- 提交纪律：`feat` 必须先有 issue（**开工前先开**，数据栈史诗 #150 已关闭）；实现 PR 引用它。
- 运维一律走 **openship MCP**，不裸 SSH。

## File Structure

| 文件 | 职责 |
|---|---|
| `contracts/common/lemeng.branch.json` | 门店维契约（人写的意图源） |
| `contracts/common/lemeng.item.json` | 商品维契约 |
| `duckle/common/lemeng.branch.json` | 门店维管线（引擎产） |
| `duckle/common/lemeng.item.json` | 商品维管线（引擎产） |
| `dbt/models/common/staging/stg_lemeng_branch.sql` | 门店维 staging（一对一） |
| `dbt/models/common/staging/stg_lemeng_item.sql` | 商品维 staging |
| `dbt/models/common/staging/sources.yml` | 加两个 source 条目 |
| `dbt/dbt_project.yml` | 加两个 prefix var（路径单点） |
| `dbt/models/common/staging/schema.yml` | staging 列契约与唯一性断言声明 |
| `dbt/tests/assert_stg_lemeng_branch_key_unique.sql` | 自然键唯一性护栏 |
| `dbt/tests/assert_stg_lemeng_item_key_unique.sql` | 同上 |
| `scripts/lemeng/run-retail-day.sh` | 复用为主；新增 `dim` 模式（见 Task 5） |

---

### Task 1: 探针——管线形状定死 + 列全集钉死

**Interfaces:**
- Produces: ①「页码能否进 body」的结论（决定 Task 2/3 的管线是 **2 节点扇出** 还是 **N 个显式页节点**）；② 两个端点的**列全集与类型**（Task 2/3 的契约、Task 4 的 staging 依赖它）。

**背景（已实测，别重做）**：引擎 `src.rest` 的 `paginationType: page` + `pageParam` **只把页码拼进 query**（实测 URL `…?page_number=1`），而**本网关无视 query**：`POST branch.find?page_number=2` 与 `?page_number=5` 返回的都是第 1 页（`[142,16,38]`，而 body 传 `page_number:2` 得到 `[69,888,9]`）。且 `{page}` 写进 body **不替换**（原样发出 ⇒ 网关 400 JSON parse error）。⇒ 引擎自带分页对本网关**不可用**，页码必须进 body。

- [ ] **Step 1: 验扇出能否把「逐行值」送进 body**

造一条两节点管线：`src.inline`（一列 `pg`、值 `2`、重复 2 行）→ `src.rest`（`url` = branch.find，`method: POST`，`body` = `{"page_number": {pg}, "page_size": 3}`，`urlTemplate` = 同 URL，`parentKeyColumn` = `pg`，`maxPages: 1`）。

Run: duckle MCP `run_pipeline`，`target` = 那个 `src.rest` 节点（**只跑到 source，不落 sink**）
Expected（判别式）：
- **返回 `[69,888,9]`（= 第 2 页）⇒ 扇出成立** ⇒ Task 2/3 用 **2 节点**形状：`src.inline` 产出页码行 + 一个 `src.rest` 发 N 次请求。
- **返回 400 `JSON parse error`（`{pg}` 原样发出）⇒ 扇出不成立** ⇒ Task 2/3 退回 **零售范式：N 个显式 `src.rest` 页节点 + `ctl.merge`**（商品维约 95 个，门店维 2 个）。

把结论逐字记进本计划末尾「计划外事实」，再动 Task 2。

- [ ] **Step 2: 两账套拉全量样本，钉列全集**

对 `nhsoft.user.ai.branch.find`（body `{"page_number":1,"page_size":200}`）与 `nhsoft.base.ai.item.find`（同形状，`page_size` 上限 **200**，201 报 `每页条数不能超过200`），**各用 3120 与 64188 两个令牌**取样本：

```bash
# 令牌从环境读，不回显值
curl -sS -X POST "https://cloud.nhsoft.cn/agi/mcp" -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call_agi_ability","arguments":{"ability":"nhsoft.user.ai.branch.find","method":"POST","body":{"page_number":1,"page_size":200}}}}'
```

响应包一层：`{code, success, msg, result:{page_number, page_size, content:[…]}}`（**无 total 字段** ⇒ 只能「页空即止」）。

Expected（2026-09-25 已探到的基线，用它们核对）：
- `branch.find` **13 列**：`branch_num, code, name, pinyin, type, enable, region_id, province, city, district, contact, phone, address`
- `item.find` **~97 列**，含嵌套：`item_department`(对象)、`scope_list`(数组)、`item_specs`、`item_tag_relations`、`extended_property_relation_list`、`pos_item_area_dto`、`sale_commission_dto`
- 行量：`branch` 3120=**270**、64188=**129**；`item` 两账套均 **>17000 且 <20000**（`page 17000` 存在、`20000` 不存在）

- [ ] **Step 3: 结论回写 spec 与计划**

改 `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md` §3 的表：**加一列「量级（实测）」**，填 `branch 270/129`、`item ≈1.9万/账套`、`retail 峰值 1459 单/时`。

Run:
```bash
git add docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md
git commit -m "docs(spec): §3 补「量级（实测）」列——维度面探针结论 (##214)"
```

---

### Task 2: 门店维三件套

**Files:**
- Create: `contracts/common/lemeng.branch.json`
- Create: `duckle/common/lemeng.branch.json`（引擎产）
- Create: `dbt/models/common/staging/stg_lemeng_branch.sql`

**Interfaces:**
- Consumes: Task 1 的列全集与管线形状结论
- Produces: 湖路径 `lemeng/dim_branch/system_book=<账套>/snapshot=<YYYY-MM-DD>/all.parquet`；契约列名（Task 4 的 staging 与 assert 依赖）

- [ ] **Step 1: 写契约**（照 `contracts/common/lemeng.retail_order_line.json` 形状）

```json
{
  "$schema": "./_schema.schema.json",
  "contractVersion": 1,
  "domain": "lemeng",
  "table": "branch",
  "owner": "data-platform",
  "description": "乐檬门店维（nhsoft.user.ai.branch.find 全量快照）。两账套各采各的；快照自愈（改名/停用无需增量游标）。",
  "layout": {
    "prefix": "lemeng/dim_branch",
    "partitionStyle": "hive",
    "partitionBy": ["system_book", "snapshot"],
    "fileName": "all.parquet"
  },
  "batch": {
    "markerColumn": "batch_id",
    "type": "varchar",
    "unique": false,
    "note": "= 采集 run id（job wrapper 生成）。同快照重跑换新 run id，幂等靠对象覆盖写。"
  },
  "columns": [
    { "name": "batch_id",   "type": "varchar", "nullable": false, "description": "批次标记" },
    { "name": "system_book","type": "varchar", "nullable": false, "description": "账套（3120/64188）；分区键，来源=采集侧常量注入（`ENV:SYSTEM_BOOK`）" },
    { "name": "snapshot",   "type": "date",    "nullable": false, "description": "快照日（Asia/Shanghai 日历日）；分区键" },
    { "name": "branch_num", "type": "integer", "nullable": false, "description": "门店号（账套内编号）；自然键之一" },
    { "name": "code",       "type": "varchar", "nullable": true,  "description": "门店编码" },
    { "name": "name",       "type": "varchar", "nullable": true,  "description": "门店名" },
    { "name": "pinyin",     "type": "varchar", "nullable": true,  "description": "拼音码" },
    { "name": "type",       "type": "varchar", "nullable": true,  "description": "门店类型" },
    { "name": "enable",     "type": "boolean", "nullable": true,  "description": "是否启用" },
    { "name": "region_id",  "type": "integer", "nullable": true,  "description": "区域 id（账套内；公司统一区域走平台主数据，spec §7.2）" },
    { "name": "province",   "type": "varchar", "nullable": true,  "description": "省" },
    { "name": "city",       "type": "varchar", "nullable": true,  "description": "市" },
    { "name": "district",   "type": "varchar", "nullable": true,  "description": "区县" },
    { "name": "contact",    "type": "varchar", "nullable": true,  "description": "联系人" },
    { "name": "phone",      "type": "varchar", "nullable": true,  "description": "电话" },
    { "name": "address",    "type": "varchar", "nullable": true,  "description": "地址" }
  ]
}
```

⚠️ `type` 一列叫 `type` 是**网关原名**，别改成 `branch_type`——契约列名与湖列名一对一，改名会让 drift 门禁与下游对不上。若 `check-data-models.mjs` 对 `type` 这种保留字报错，才改名为 `branch_type` **并在管线 code.sql 里同步别名**。

- [ ] **Step 2: 过静态门禁**

Run: `pnpm exec tsx scripts/check-data-models.mjs`
Expected: exit 0

- [ ] **Step 3: 产管线**（duckle MCP `create_pipeline`，`validate=true` 落 `duckle/common/lemeng.branch.json`）

节点形状参照 `duckle/common/lemeng.retail_order_line.json`：`src.rest`（`url`/`method: POST`/`body` 含 `page_number` 与 `page_size: 200`/`headers.Authorization: "Bearer ${ENV:LEMENG_TOKEN}"`/`responsePath: "/result"`）→ `code.sql`（定型 + 注入 `batch_id`/`system_book`/`snapshot`）→ `qa.contract` → `snk.minio`。

- 取数节点：**2 页足够**（270 行 = 200+70），但仍按 Task 1 的结论选形状；**末页挂 `ctl.die` 哨兵**（`condition: "has-rows"`），阈值留余量（写 5 页 = 1000 家）。
- `data.schema` 只声明用到的标量列（`branch_num: int64, code: string, name: string, pinyin: string, type: string, enable: bool, region_id: int64, province: string, city: string, district: string, contact: string, phone: string, address: string`）。
- sink：`key` = `lemeng/dim_branch/system_book=${ENV:SYSTEM_BOOK}/snapshot=${ENV:SNAPSHOT}/all.parquet`，`mode: overwrite`，其余照抄零售 sink。
- `code.sql` 必须注入三列：`'${ENV:BATCH_ID}' as batch_id`、`'${ENV:SYSTEM_BOOK}' as system_book`、`CAST('${ENV:SNAPSHOT}' AS DATE) as snapshot`。

Run: 引擎 `validate_pipeline` 通过后再落仓
Expected: `valid`

- [ ] **Step 4: 写 staging**（照 `stg_lemeng_retail_order_line.sql` 的分区键 cast + `r['col']` 形态）

```sql
{{
    config(materialized='table')
}}
-- stg_lemeng_branch.sql — 乐檬门店维 staging（新湖；一对一、只规范化不改义）
-- 分区键推断类型不合约 ⇒ 三列显式 cast；取列必须 `from read_parquet(...) r` 函数别名形态
-- （CTE 形态在 pg_duckdb 上取列即报错，见 stg_lemeng_retail_order_line.sql 头注【二】）。
select
  r['batch_id']              as batch_id,
  r['system_book']::varchar  as system_book,
  r['snapshot']::date        as snapshot,
  r['branch_num']            as branch_num,
  r['code']                  as code,
  r['name']                  as name,
  r['pinyin']                as pinyin,
  r['type']                  as type,
  r['enable']                as enable,
  r['region_id']             as region_id,
  r['province']              as province,
  r['city']                  as city,
  r['district']              as district,
  r['contact']               as contact,
  r['phone']                 as phone,
  r['address']               as address
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("lemeng_branch_prefix") }}/*/snapshot=**/all.parquet'
) r
```

⚠️ 注释必须在 Jinja `config` 块**外**（dbt 1.9.1 实测报 `expected token`）。

- [ ] **Step 5: 过门禁 + 提交**

Run: `pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/check-data-plane-lock.mjs`
Expected: 后者**红**（新文件未进 lock）⇒ 跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` 再验，绿。

```bash
git add contracts/common/lemeng.branch.json duckle/common/lemeng.branch.json \
        dbt/models/common/staging/stg_lemeng_branch.sql deploy/data-plane.lock
git commit -m "feat(lemeng): 门店维三件套——契约/管线/staging（双账套全量快照） (##214)"
```

---

### Task 3: 商品维三件套

**Files:** Create `contracts/common/lemeng.item.json`、`duckle/common/lemeng.item.json`、`dbt/models/common/staging/stg_lemeng_item.sql`

**Interfaces:** Consumes Task 1 的 item 列全集；Produces 湖路径 `lemeng/dim_item/system_book=<账套>/snapshot=<日期>/all.parquet`

- [ ] **Step 1: 定列投影规则**（**决策**，写进契约 description）

`spec §7.2` 的「完整保留」指的是**两账套档案各自保留**（不合并），不是「列一个不落」。故：

- **标量列全留**（含 `item_num, item_code, bar_code, pinyin, item_name, spec, item_type, item_brand, item_category, unit_name, …`）；
- **摊平 1 个嵌套对象**：`item_department` → `item_department_id`(int64) / `item_department_name`(varchar) / `item_department_code`(varchar)；
- **丢弃 6 个数组/深层对象**：`scope_list`、`item_specs`、`item_tag_relations`、`extended_property_relation_list`、`pos_item_area_dto`、`sale_commission_dto` —— 它们是**运营配置**（销售范围、提成、POS 区域），不是分析维；`data.schema` 只认标量，硬塞成 json 列会与 README §4 第 1 条坑相撞。**要时再加**（回填可重跑快照）。

- [ ] **Step 2: 写契约**（同 Task 2 形状；`partitionBy: ["system_book","snapshot"]`、`prefix: "lemeng/dim_item"`、列按 Step 1 规则，外部标识一律 `varchar`、`decimal` 必带 precision/scale）

- [ ] **Step 3: 过静态门禁** — Run: `pnpm exec tsx scripts/check-data-models.mjs`；Expected: exit 0

- [ ] **Step 4: 产管线**（引擎产 + `validate`；**约 95 页**——末页哨兵写 **120 页（24000 容量）留余量**，超了 fail-loud 不静默截断）

⚠️ **本条是「页数」风险点**：商品会增长，页数是硬编码的。哨兵页是唯一防线，务必留足余量并把「如何扩页数」写进管线头注。

- [ ] **Step 5: 写 staging**（照 Task 2 的 cast + `r['col']` 形态，列数按 Step 1；`from read_parquet('s3://{{ var("zos_bucket") }}/{{ var("lemeng_item_prefix") }}/*/snapshot=**/all.parquet') r`）

- [ ] **Step 6: lock 重生成 + 提交**

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
git add contracts/common/lemeng.item.json duckle/common/lemeng.item.json \
        dbt/models/common/staging/stg_lemeng_item.sql deploy/data-plane.lock
git commit -m "feat(lemeng): 商品维三件套——契约/管线/staging（双账套全量快照） (##214)"
```

---

### Task 4: dbt 接线（sources / vars / 断言）

**Files:** Modify `dbt/dbt_project.yml`（+2 vars）、`dbt/models/common/staging/sources.yml`（+2 sources）、`dbt/models/common/staging/schema.yml`（+2 模型列契约）、Create `dbt/tests/assert_stg_lemeng_branch_key_unique.sql`、`dbt/tests/assert_stg_lemeng_item_key_unique.sql`

**Interfaces:** Consumes Task 2/3 的 staging 模型名与列名；Produces 下游 marts（S2-b）可挂载的两张维度

- [ ] **Step 1: 加 prefix var**（路径单点，与 `lemeng_retail_order_line_prefix` 同处）

- [ ] **Step 2: 加 source 条目**（照现有 `sources.yml` 形状：`access_path` 用 `read_parquet('s3://{{ var("zos_bucket") }}/…/**/*.parquet') r`）

- [ ] **Step 3: 写两条自然键唯一性断言**

```sql
-- assert_stg_lemeng_branch_key_unique.sql — 自然键 (system_book, snapshot, branch_num) 必须唯一
-- 覆盖写幂等的护栏：重复 ⇒ 红（与 stg_lemeng_retail_order_line 的同名断言同理）
select system_book, snapshot, branch_num, count(*) as n
from {{ ref('stg_lemeng_branch') }}
group by 1, 2, 3
having count(*) > 1
```

`item` 同理，键 `(system_book, snapshot, item_num)`。

- [ ] **Step 4: 过门禁 + 提交**（Run: `pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsc -p tsconfig.json`；Expected: exit 0）

---

### Task 5a: wrapper 的 `dim` 模式（**分支内**）

**Interfaces:** Consumes Task 2/3 的管线文件名；Produces `run-retail-day.sh` 的 `dim` 模式（Task 5b 的 job 按它发命令）

> **为什么 5a/5b 拆开（2026-09-25 拍板）**：投递程序按**全 SHA** 从 GitHub 取件。若在分支 SHA 上投递，等于**生产跑未合并的代码**而 main 上没有对应提交 —— 与仓规「merge main 才上线」冲突。故**仓内代码走 PR，生产动作留到合并后**。

- [ ] **Step 1: 加 `dim` 模式**

在 `scripts/lemeng/run-retail-day.sh` 的 `case` 里新增 `dim`：按 `DIM_FACE=branch|item` 跑对应管线（`/pipelines/common/lemeng.<face>.json`），窗口参数换成 `SNAPSHOT`（`TZ=Asia/Shanghai date +%F`，**显式钉时区**，与 `BIZDAY` 同理），并**复用启动自证门**（`IDENTITY_CHECKED` 的 export 语义见 `windows` 分支注释）。

照现有 `window` 分支的形状写：`$COMPOSE run --rm -e LEMENG_TOKEN … -e BATCH_ID="$BATCH_ID" duckle --pipeline "$PIPELINE" …`，跑完发一行 `_ops`（`{"ts","job":"dim","system_book","snapshot","face","rows","status"}`），退出码契约与现有模式一致（失败非零）。

⚠️ 改完**必须跑全文件邻接扫描**（`$VAR` 紧跟非 ASCII 会打挂 bash 3.2，本仓一天咬过两次，见 #212）。

- [ ] **Step 2: 更新头注 + lock + 门禁 + 提交**

头注的用法串与退出码契约要加 `dim`（`#   sh run-retail-day.sh dim      # 维度快照（DIM_FACE=branch|item，双账套）`）。

```bash
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs      # wrapper 是投递单元，必须重生成
pnpm exec tsx scripts/check-data-plane-lock.mjs       # 期望绿
git add scripts/lemeng/run-retail-day.sh deploy/data-plane.lock
git commit -m "feat(lemeng): wrapper 加 dim 模式——维度快照（双账套全量） (#214)"
```

---

### Task 5b: 投递 + 注册 job + 真机验（**合并之后另起一段执行**）

**Interfaces:** Consumes 已合并进 main 的 Task 2/3/5a；Produces 4 条 openship job + 真机落湖证据

> **前置**：本 Task **不在功能分支内执行**。先把 Task 1–5a 的 PR 合并进 main，**再从 main 的合并提交**做投递与注册。

- [ ] **Step 1: 投递**（openship MCP `post_system_servers_by_id_exec`）

```bash
sh /opt/lemeng-sync.sh <合并提交全SHA> --check    # 先只比不写
sh /opt/lemeng-sync.sh <合并提交全SHA>            # 正式
```

Expected: `SYNC_OK 25/25` 且末行 `# revision <全SHA>`。**全 SHA 逐字复制，绝不手工补。**

- [ ] **Step 2: 注册 4 条 job**（openship MCP `post_jobs`）

| job | cron（UTC） | env |
|---|---|---|
| `lemeng-dim-branch-3120` | `0 2 * * *`（北京 10:00） | `DIM_FACE=branch, SYSTEM_BOOK=3120, SNAPSHOT` |
| `lemeng-dim-branch-64188` | `0 2 * * *` | `DIM_FACE=branch, SYSTEM_BOOK=64188` |
| `lemeng-dim-item-3120` | `0 11 * * *`（北京 19:00） | `DIM_FACE=item, SYSTEM_BOOK=3120` |
| `lemeng-dim-item-64188` | `0 11 * * *` | `DIM_FACE=item, SYSTEM_BOOK=64188` |

- `serverIds: ["8281d598-af73-4d0b-99dd-bc8681fcc8bb"]`；命令 `sh /opt/lemeng-run.sh dim`；`timeoutMs` 按商品维量级给足（≥1800000）；secrets 照抄零售 job 的 7 键。
- **3120 的 `BRANCH_NUMS`** = `1..270 \ {99} ∪ {888}`（269 家，照零售 job）。
- **64188 的 `BRANCH_NUMS`** = **全要 129 家**（`{1..128} ∪ {999}`，含 99 —— 2026-09-25 拍板；与 3120 口径不同，**别照抄**）。
- ⚠️ **64188 的 `LEMENG_TOKEN`**：`LEMENG_TOKEN` 是**按账套绑定**的。生产侧 64188 令牌需另行落进 job secrets（值不经 agent 转手）。

- [ ] **Step 3: 各触发一次 + 回读自证**

Run: openship MCP `post_jobs_by_key_run`（4 条）→ 读 run 输出
Expected: exit 0、`_ops` 行 `status: ok`、sink 行数 = 预期（branch 3120=**270** / 64188=**129**；item ≈**1.9 万**/账套）

- [ ] **Step 4: 真机回读**（wrapper 的 `rb` 模式或 pg_duckdb 直读）

```sql
select system_book, snapshot, count(*) from read_parquet('s3://<桶>/lemeng/dim_branch/**/*.parquet') group by 1,2;
```

Expected: 与 sink 行数一致；分区键 `system_book`（varchar）/ `snapshot`（date）可读且类型合契约。

---

## 计划外事实（执行者必读）

- **代理**：本机 git 走 7897 间歇挂——push 失败先重试 2~5 次，再走 `ssh://git@ssh.gitlab…`/`ssh.github.com:443` 兜底。**别断定「代理死了」去改配置**。
- **duckle 引擎在本地桌面版**：`~/Library/Application Support/io.duckle.app/engines/`（MCP 已接）。`run_pipeline` 需要 `DUCKLE_DUCKDB_BIN`；`${ENV:...}` 取自 **MCP 进程的 env**，不在管线里写死。
- **网关分页事实（2026-09-25 实测）**：`page_size` 上限 **200**（201 报 `每页条数不能超过200`）；响应**无 total** ⇒ 页空即止；**query 里的 `page_number` 被完全无视**（页码必须进 body）；`item.find` 不支持 `offset/limit`（返回 0 行）。
- **64188 令牌**：本地 `~/.zshrc` 有 `LEMON_TOKEN_64188`（已验可用：`company_id=64188`、门店 129 家）。**生产侧的 64188 令牌需另行落进 openship job secrets**（按公司规矩，密钥值不经 agent 转手）。
- **门店清单口径（2026-09-25 拍板）**：3120 = `1..270 \ {99} ∪ {888}`（**269 家**，99=熊喵中央店故意排除）；**64188 = 全要 129 家**（`{1..128} ∪ {999}`，**含 99**）——**两账套口径不同，别互相照抄**。
- **Task 5 拆成 5a/5b（2026-09-25 拍板）**：仓内代码（wrapper 的 `dim` 模式 + lock）走 PR；**投递 / 注册 job / 真机验留到合并之后**——投递按全 SHA 取件，分支 SHA 投上去等于生产跑未合并代码。
- **承载 issue：#214**。`dim_customer` / `dim_date` / 四事实 / 口径五条 / 对账 `diff=0` 属 **S2-b**，另开 issue 与计划。

## Self-Review（写完自查）

- **spec 覆盖**：§3 两个维度面 ✓ Task 2/3；§5 湖布局（`dim_branch/`、`dim_item/` 的 `snapshot=` 分区）✓；§7.2 dim 设计（两账套各自保留）✓ Task 3 Step 1；§11 S2 的「四事实三维」——**本计划只覆盖「三维」里的二（branch/item）**，`dim_customer`（从批发明细派生，依赖批发面数据）与 `dim_date`、以及「四事实」「口径五条」「对账 diff=0」**不在本计划**，属 S2-b，开工前另写计划。
- **占位符**：无 TBD/TODO；`#214` 是**开工前要开的 issue 号**，不是待填内容。
- **类型一致**：契约用 JSON Schema 类型名（`integer/varchar/boolean`），管线 `data.schema` 用引擎词表（`int64/string/bool`），staging 用 SQL cast（`::int/::varchar/::date`）——三套词表**故意不同**，各自对齐自己的机器面；名字必须能一一对上（见 Task 2 Step 1 的 `type` 列警告）。
