# #500 工单取价（按单结算价+挂原单+发布面归一）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 售后建单挂原单（MO/WO）冻结行级 `price_minor`；两源在发布面归一为 `data.dim_settlement_order_line`；WO→门店靠客户档案对照表映射。

**Architecture:** 新采集源 lemeng.client（进销存批发客户档案，GET 裸码全量翻页）→ staging → publish-dims 归一发布（transfer 直搬 + wholesale 经映射）→ aftersales 选单/冻结。spec：`docs/superpowers/specs/2026-10-09-500-ticket-settlement-price-design.md`（已获批，本计划不得偏离其 §4/§5/§6 的 schema 与规则）。

**Tech Stack:** duckle L0 管线（生成器脚本产出）+ dbt staging（pg_duckdb）+ publish-dims.mjs（node/pg 双连接）+ Hono 模块路由（zod）+ Vitest + React mobile。

## Global Constraints

- 提交纪律：`<type>(<scope>): <一句话>`；feat/fix 先有 issue，PR body `Closes #N`；CHANGELOG 由 release.mjs 生成**禁手写**；provenance trailer 不删改；提交只写一个 scope。
- 分支：每 Wave 从 `git fetch` 过的 `origin/main` 新建分支（多工作树并行，旧分支停在原地）。
- contracts 是湖列集**唯一事实源**；改列集 = 改契约 + 跑生成器，**生成物必须 == 已提交**，不手改管线 JSON 的投影列。
- 数据面新增/改动文件（dbt/、contracts/、pipelines/、scripts/lemeng/）→ 提交前必须 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` 刷新 `deploy/data-plane.lock`（CI gates 的 `check-data-plane-lock` 守着；PR #506 教训：分轮提交漏哈希 = 红）。
- scripts/ 是 checkJs：新函数用「单形状、字段恒在」的 JSDoc，可辨识联合会收窄失败。
- mock 收严到真机形状（#50/#51 教训）：client.find 的 mock 按 spec §2 实测形状，不放宽。
- 部署后验：merge 只等 CI **CLEAN**；main 自动部署 mytech；山海手动触发（webhook）后验 `activeDeploymentStatus`；容器验证**进容器 grep 产物**，不用 HTTP 探活。
- 本地 server 测试需 `DATABASE_URL`；并发/迁移类测试先 `dropdb/createdb` 空库再跑。
- 波末验证：该仓 CI 跑的**全部命令**（`pnpm test`、`pnpm typecheck`、`pnpm smoke`、五守卫），不只本任务相关的。

---

### Task 0: 立段 issue（两段各一个，#500 是第三段）

**Files:** 无（gh 操作）。

**Interfaces:**
- Produces: issue 号 `#516`（Wave①）、`#517`（Wave②），后续所有任务标题/PR 引用。

- [x] **Step 1: 建采集源 issue**（→ #516）

```bash
gh issue create --title "feat(data): lemeng.client 客户档案采集源——工单取价对照表（#500 段①）" --body "上游 spec：docs/superpowers/specs/2026-10-09-500-ticket-settlement-price-design.md §5。走 collect-source A→I。范围：探针定案、契约+L0 管线（3120，GET 裸码全量翻页+哨兵）、stg_lemeng_client、lock 刷新、首跑验收（41/41 fid 覆盖）、探活与台账回填。"
```

- [x] **Step 2: 建发布面 issue**（→ #517）

```bash
gh issue create --title "feat(data): dim_settlement_order_line 归一取价面——transfer∪wholesale 经门店映射（#500 段②）" --body "上游 spec §4/§5。范围：migration 014/015、publish-dims 归一段（override→同名→大声红）、wire-warehouse 探活判据、映射率验收与无极对平抽样。"
```

- [x] **Step 3: 回填计划文件**——把两个 issue 号写进本文件 Wave①/② 标题处，commit：

```bash
git add docs/superpowers/plans/2026-10-10-500-ticket-settlement-price.md
git commit -m "docs(data): 工单取价实施计划回填段 issue 号（#500）"
```

---

## Wave ① 采集源 lemeng.client（issue #516；collect-source A→I 执法）

> 段门：A→I 逐段判停，不过不进下段（`.claude/skills/collect-source`）。开工三查已由 spec §2 完成（台账无本源行→从 A 起；WeKnora `cb31a2fb` 已读；正典 §1.3 对应小节动手前重读）。

### Task 1: A 段——真机探针四条，产出探针报告

**Files:**
- Create: `.superpowers/sdd/2026-10-10-500-lemeng-client/probe-report.md`

**Interfaces:**
- Produces: `PAGE_TOTAL`（实测总页数）、`ROW_TOTAL`（总量）、`PAGE_SIZE_REAL`（limit 实际绑定值）、字段全键清单——Task 2/3 直接引用。

- [ ] **Step 1: 真机探针**（openship MCP → `proj_AFbJvyb0onaX7LVr` 服务 `lemeng-console-3120` exec；本会话已验证过的命令形态）：

```sh
# ① 全量翻页计数（limit=200，翻到空页；记录每页实返行数 ⇒ PAGE_SIZE_REAL）
for off in 0 200 400 …; do curl -s -m 25 \
  "https://cloud.nhsoft.cn/agi/api/nhsoft.whs.ai.client.find?limit=200&offset=$off" \
  -H "Authorization: Bearer ${LEMENG_TOKEN}"; echo; done > /tmp/client_probe.txt
grep -o '"client_fid":' /tmp/client_probe.txt | wc -l   # ROW_TOTAL
# ② 字段全键（响应首记录）
grep -o '"[a-zA-Z_]*":' /tmp/client_probe.txt | sort -u
# ③ 跨度上限：本接口无时间窗参数（基础资料快照）——记录「无窗口约束」结论
# ④ whoami 级主体：管线路径复用既有 identity 自证（gen 脚本里已有 w0 节点，无需新探针）
```

- [ ] **Step 2: 写探针报告**——四条结论 + `PAGE_TOTAL/ROW_TOTAL/PAGE_SIZE_REAL` + 哨兵阈值建议（数据页数 × 绑定值，哨兵页不计容量，照批发单 19 页算式注释形态）。不跑探针直接写码 = 最贵跳步（collect-source A 判停）。

- [ ] **Step 3: Commit** `docs(data): #516 客档源 A 段探针报告——总量/翻页绑定/哨兵阈值`

### Task 2: B+C 段——正典登记 + 契约

**Files:**
- Modify: `docs/data-platform-handbook.md`（§1.7 逐源决策登记 + §2 数据源清单各一行）
- Create: `contracts/common/lemeng.client.json`

**Interfaces:**
- Produces: 契约 layout `prefix: lemeng/client`、分区 `[system_book, snapshot]`——Task 3 的 sink key、Task 4 的 staging 读数路径都从这里取。

- [ ] **Step 1: §1.7 登记**（B 段判停：没有登记行 = B 没完成）。行格式照抄现有 lemeng.transfer_out 行：源=`lemeng/client`、选型=duckle 原生 L0 全量翻页快照（标准形态，无例外）、拍板日期 2026-10-10、范围=仅 3120、用途=工单取价对照表（spec §5：只消费 client_fid+client_name）。
- [ ] **Step 2: 契约文件**（双轨之一；列集 = Task 1 字段全键裁剪到对照表需要的 + 通用标识）：

```json
{
  "$schema": "./_schema.schema.json",
  "contractVersion": 2, "schemaVersion": 1, "consumerVersion": 1,
  "domain": "lemeng", "table": "client", "owner": "data-platform",
  "description": "乐檬进销存批发客户档案（nhsoft.whs.ai.client.find；#500 段① 2026-10-10 拍板）。【行粒度】一行 = 账套×快照日×客户。【快照】全量翻页覆盖写当日 snapshot 分区（基础资料，无业务时间窗；接口无窗口参数，实测记录见探针报告）。【接口约束】GET 裸能力码路径（文档 /whs/ai/ 前缀报路由未配置）；GET 下 keyword 不生效、limit 绑定松散（实返约 PAGE_SIZE_REAL/请求值×200）；总量 2000+。【用途边界】工单取价对照表——发布侧只消费 client_fid+client_name 两列；本档案不是门店维，行不进 dim_branch（spec §5 单源分工铁律）。",
  "layout": { "prefix": "lemeng/client", "partitionStyle": "hive",
    "partitionBy": ["system_book", "snapshot"], "fileName": "all.parquet" },
  "batch": { "markerColumn": "batch_id", "type": "varchar", "unique": false,
    "note": "= 采集 run id。每日快照整分区覆盖写。" },
  "columns": [
    { "name": "batch_id", "type": "varchar", "nullable": false,
      "expr": "'cl-${ENV:SYSTEM_BOOK}-client-' || replace(replace('${datetime}','-',''),'_','T') || 'Z'",
      "description": "批次标记（采集 run id）" },
    { "name": "system_book", "type": "varchar", "nullable": false,
      "expr": "'${ENV:SYSTEM_BOOK}'",
      "description": "账套（采集范围=3120）；分区键，采集侧常量注入" },
    { "name": "snapshot", "type": "date", "nullable": false,
      "expr": "CAST('${date}' AS DATE)",
      "description": "快照日（采集当日）；分区键。⚠️ 用 ${date} 单段——组合段替换层不生效（0.7.4 实测）" },
    { "name": "client_fid", "type": "varchar", "nullable": false,
      "expr": "CAST(c.client_fid AS VARCHAR)",
      "description": "客户主键，与 WO 单上 client_fid 精确同形（映射键一）" },
    { "name": "client_name", "type": "varchar", "nullable": true,
      "expr": "CAST(c.client_name AS VARCHAR)",
      "description": "客户名称（映射键二：与 dim_branch.name 精确同名）" },
    { "name": "client_code", "type": "varchar", "nullable": true,
      "expr": "CAST(c.client_code AS VARCHAR)", "description": "客户代码" },
    { "name": "client_type", "type": "varchar", "nullable": true,
      "expr": "CAST(c.client_type AS VARCHAR)",
      "description": "客户类型（13 种大杂烩，仅排查用，不做过滤依据）" },
    { "name": "branch_num", "type": "bigint", "nullable": true,
      "expr": "CAST(c.branch_num AS BIGINT)",
      "description": "所属门店编号（实测=99 管理中心，无 64188 指针；留档证伪用）" },
    { "name": "client_actived", "type": "boolean", "nullable": true,
      "expr": "CAST(c.client_actived AS BOOLEAN)", "description": "是否启用" },
    { "name": "client_del_tag", "type": "boolean", "nullable": true,
      "expr": "CAST(c.client_del_tag AS BOOLEAN)", "description": "是否删除" },
    { "name": "client_last_edit_time", "type": "varchar", "nullable": true,
      "expr": "CAST(c.client_last_edit_time AS VARCHAR)",
      "description": "最后修改时间（后续请求侧增量候选）" }
  ]
}
```

  ⚠️ 写前先读 `contracts/common/lemeng.wholesale_out.json` 全文与 `lemeng.dim.branch.l0.json`（基础资料快照先例）：若分支快照的分区风格与 `[system_book, snapshot]` 不同，**以仓内先例为准**订正本契约，别发明第二风格。投影源别名（`c.`）以 Task 3 生成器的实际 SQL 为准，两处必须一致（C 段双轨同改判停）。
- [ ] **Step 3: 台账 §2 清单行**——照 transfer_out 行格式：状态「B/C 已定，待首跑」。
- [ ] **Step 4: Commit** `feat(data): #516 客档源契约+正典登记（B/C 段）`

### Task 3: D 段——生成器脚本 + 管线 JSON

**Files:**
- Create: `scripts/lemeng/gen-client-pipeline.mjs`
- Create: `deploy/duckle/console/pipelines/lemeng.client.l0.3120.json`（**生成器产出**，不手编）

**Interfaces:**
- Consumes: Task 1 的 `PAGE_TOTAL`；Task 2 的契约 layout。
- Produces: 管线节点 id `w0`(identity 自证) / `p1..pN`(数据页) / `sentinel` / `merge`(ctl.merge) / `sink`(snk.minio)——Task 5 真机首跑按这些 id 验。

- [ ] **Step 1: 生成器脚本**——骨架照抄 `scripts/lemeng/gen-wholesale-out-pipeline.mjs`（参数校验/节点工厂/写出格式全保留），差异点：

```js
// 与批发单生成器的差异（其余逐行照抄）：
// ① 请求：GET + query（无 body）——wholesale 是 POST body，这里是实测定论的 GET：
//    url: 'https://cloud.nhsoft.cn/agi/api/nhsoft.whs.ai.client.find'
//    query 形态（duckle src.rest 的 query 由 url 模板直拼，页号只换 offset）：
//      `?limit=${PAGE_SIZE}&offset=${offset}`
// ② 无时间窗：不传 date_start/date_type（基础资料全量）
// ③ responsePath: '/result'（实测响应 shape：{code,msg,result:[…]}）
// ④ 分区 key：'lemeng/client/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date}/all.parquet'
//    （mode overwrite——每日快照整分区覆盖）
// ⑤ 数据页数 N = Task 1 的 PAGE_TOTAL + 哨兵页；哨兵 ctl.die 文案照批发单算式注释形态：
//    'lemeng client 容量截断：第 N+1 页（哨兵页）仍有 {rows} 行（system_book=${ENV:SYSTEM_BOOK}）
//     ⇒ 总量已击穿真阈值 <N×PAGE_SIZE_REAL> 条。处置：加数据页节点 → 同步改算式与哨兵页号 → 重生成 → 走 PR'
```

- [ ] **Step 2: 生成并校验**：`node scripts/lemeng/gen-client-pipeline.mjs --book 3120 --out deploy/duckle/console/pipelines/lemeng.client.l0.3120.json`，然后 duckle MCP `validate_pipeline`（编译过）+ 抽查投影列集 == 契约 columns（C 段双轨判停）。
- [ ] **Step 3: Commit** `feat(data): #516 客档源 L0 管线生成器+管线 JSON（3120）`（含 lock 刷新，见 Task 4 Step 3——同 PR 内一起刷）。

### Task 4: staging + lock + 断言

**Files:**
- Create: `dbt/models/common/staging/stg_lemeng_client.sql`
- Modify: `dbt/models/common/staging/sources.yml`、`dbt/models/common/staging/schema.yml`（若有断言挂载处，照 wholesale 的挂法）
- Create: `dbt/tests/assert_stg_lemeng_client_key_unique.sql`
- Modify: `deploy/data-plane.lock`（生成器刷新）

**Interfaces:**
- Produces: `staging.stg_lemeng_client`（列：batch_id/system_book/org/snapshot/client_fid/client_name/client_code/client_type/branch_num/client_actived/client_del_tag/client_last_edit_time）——Task 7 的发布 SQL 从这张表读。

- [ ] **Step 1: staging 模型**（头注与取数形态照抄 `stg_lemeng_wholesale_out.sql`——read_parquet 函数别名形态、前缀走 dbt_project.yml 同源 var）：

```sql
{{
    config(materialized='table')
}}
-- stg_lemeng_client.sql — 乐檬**批发客户档案** staging（#500 段①；全量快照、只规范化不改义）
-- 【用途边界】工单取价对照表（publish-dims 只消费 client_fid+client_name）；不是门店维，
--   行不进 dim_branch（spec §5 单源分工铁律）。13 种 client_type 大杂烩，不做过滤依据。
-- 【前缀单点】lemeng/client 段用 dbt_project.yml 同源 var（出处：契约 layout.prefix）。
select
  r['batch_id']::varchar as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['snapshot']::date as snapshot,
  r['client_fid']::varchar as client_fid,
  r['client_name']::varchar as client_name,
  r['client_code']::varchar as client_code,
  r['client_type']::varchar as client_type,
  r['branch_num']::bigint as branch_num,
  r['client_actived']::boolean as client_actived,
  r['client_del_tag']::boolean as client_del_tag,
  r['client_last_edit_time']::varchar as client_last_edit_time
from read_parquet(
  '{{ var("lemeng_lake_root") }}/lemeng/client/system_book=*/snapshot=*/all.parquet',
  hive_partitioning=true
) r
```

  （`lemeng_lake_root`/`subject_org()` 的真实名字以 `stg_lemeng_wholesale_out.sql` 现文为准——照抄它的写法，上面是形状示意，**执行时逐行对齐现文件**。）
- [ ] **Step 2: 唯一键断言**（照 `assert_stg_lemeng_wholesale_key_unique.sql` 改表名列集）：键 = `(snapshot, client_fid)`。
- [ ] **Step 3: 刷 lock**：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`，确认 `deploy/data-plane.lock` 含新文件哈希；本地 `pnpm test:guard`（含 check-data-plane-lock）绿。
- [ ] **Step 4: Commit** `feat(data): #516 stg_lemeng_client staging+断言+lock`

### Task 5: E/F/G 段——真机首跑 + 验收 + 探活 + 台账回填

**Files:**
- Modify: `docs/data-platform-handbook.md`（§1.7/§2 状态推进）、`scripts/lemeng/wire-warehouse.sh`（探活判据，与 Task 8 的面探活一起改也行——若 Wave② 紧随，合并到 Task 8 一次改）

- [ ] **Step 1: 管线上机**：按 `deploy/data-plane-deploy-sop.md` §E.3（sync-data-plane.sh 全 SHA 投递 → console 重载；bind-mount 钉 inode，只写文件不重载 = 跑旧定义）。
- [ ] **Step 2: 首跑**：console POST `/api/run`（跑 lemeng.client.l0.3120），盯节点全绿（w0 身份自证、各数据页、sentinel 空页、sink 落湖）。
- [ ] **Step 3: F 四层验收**：①湖行数 = ROW_TOTAL ± 翻页漂移；②staging 物化后 `staging.stg_lemeng_client` 同数；③**41/41 判据**——staging 里能查到 10-08 全部 41 个 WO client_fid（openship exec 进 pg_duckdb 查，命令形态同本会话）；④qa.contract/drift 绿。
- [ ] **Step 4: E/G 排班+探活**：调度挂 console schedules（照 dim 系基础资料的节奏）；台账 §2 行更新排班实况；新鲜度锚验「匹配到」（catalog lint）。
- [ ] **Step 5: 台账+WeKnora 回填**：正典两行推进；WeKnora `cb31a2fb` 更新首跑实况（分页标定值）。
- [ ] **Step 6: 波末验证 + PR**：`pnpm test && pnpm typecheck`（改动面的全部守卫）→ PR `Closes #516`。

---

## Wave ② 发布面归一（issue #517）

### Task 6: migration 014/015

**Files:**
- Create: `modules/data/migrations/014_dim_settlement_order_line.sql`
- Create: `modules/data/migrations/015_client_store_override.sql`

**Interfaces:**
- Produces: `data.dim_settlement_order_line`（PK `(org, order_no, item_code, line_key)`，索引 `(org, store_code, order_bizday)`）与 `data.client_store_override`——Task 7 写、Task 11 读。

- [ ] **Step 1: 014 DDL**（spec §4 逐字；头注照 012 风格写清：行粒度=原单行、只收已审 money>0、price 语义=按单结算口径基本单位分价、幂等=发布侧 delete+insert、迁移 drop 重建）：

```sql
drop table if exists data.dim_settlement_order_line;

create table data.dim_settlement_order_line (
  org          text not null,
  source       text not null,
  store_code   text not null,
  store_name   text,
  order_no     text not null,
  order_bizday date not null,
  order_time   text,
  item_code    text not null,
  item_name    text,
  line_key     text not null,
  quantity     decimal(14,6),
  money        decimal(14,2),
  price_minor  bigint not null,
  primary key (org, order_no, item_code, line_key)
);

create index if not exists data_dim_settlement_order_line_store_idx
  on data.dim_settlement_order_line (org, store_code, order_bizday);
```

- [ ] **Step 2: 015 DDL**（spec §4 对照表；头注写明消费序：override 优先于同名）：

```sql
drop table if exists data.client_store_override;

create table data.client_store_override (
  org        text not null,
  client_fid text not null,
  store_code text not null,
  primary key (org, client_fid)
);
```

- [ ] **Step 3: 空库迁移自检**：`dropdb` + `createdb` 后挂 `DATABASE_URL` 跑 `pnpm test`（迁移幂等：重复跑不报错）。
- [ ] **Step 4: Commit** `feat(data): #517 归一取价面+对照表迁移（014/015）`

### Task 7: publish-dims 归一段

**Files:**
- Modify: `scripts/lemeng/publish-dims.mjs`（dim_wholesale_out 段之后追加「── dim_settlement_order_line」段）

**Interfaces:**
- Consumes: `staging.stg_lemeng_client`（Task 4）、`data.client_store_override`（Task 6）。
- Produces: `data.dim_settlement_order_line` 行集 + 未映射红清单（console.error）。

- [ ] **Step 1: 归一 SQL**（照 dim_transfer_out 段的 warehouse 查询 + unnest 批插模式，头注引用 spec §4/§5）：

```js
    // ── dim_settlement_order_line（#500 段②）：工单挂原单取价面 ───────────────────
    // 行粒度 = 原单行（MO=grade 行、WO=明细行）；只收已审且金额为正；未映射 WO 行不进面、
    // 清单大声红（消费端 PRICE_NOT_FOUND fail-closed 兜底，发布不阻断——spec §5）。
    const faceRows = await warehouse.query(
      `with wo_map as (
         select w.org, w.order_no, w.client_fid, w.item_code, w.order_detail_num,
                w.quantity, w.money, w.bizday, w.item_name, w.create_time,
               coalesce(o.store_code,
                 (select b.code from staging.stg_lemeng_client c
                    join staging.stg_lemeng_branch b
                      on b.name = c.client_name
                     and b.snapshot = (select max(snapshot) from staging.stg_lemeng_branch)
                   where c.client_fid = w.client_fid
                     and c.snapshot = (select max(snapshot) from staging.stg_lemeng_client)
                   order by b.system_book asc limit 1)) as store_code,
               (select b.name from staging.stg_lemeng_client c
                  join staging.stg_lemeng_branch b on b.name = c.client_name
                 where c.client_fid = w.client_fid
                   and c.snapshot = (select max(snapshot) from staging.stg_lemeng_client)
                 order by b.system_book asc limit 1) as store_name
           from staging.stg_lemeng_wholesale_out w
           left join data.client_store_override_map o
             on o.org = w.org and o.client_fid = w.client_fid
          where w.state_code = 3 and w.money is not null and w.money > 0
       )
       select 'transfer' as source, t.org, t.branch_code as store_code, t.branch_name as store_name,
              t.order_no, t.bizday::text as order_bizday, t.create_time as order_time,
              t.item_code, t.item_name, coalesce(t.grade_item_num,0)::text as line_key,
              t.quantity, t.out_money as money,
              round(t.out_money / nullif(t.quantity,0) * 100)::bigint as price_minor
         from staging.stg_lemeng_transfer_out_published t
       union all
       select 'wholesale', m.org, m.store_code, m.store_name, m.order_no, m.bizday::text,
              m.create_time, m.item_code, m.item_name, m.order_detail_num::text,
              m.quantity, m.money,
              round(m.money / nullif(m.quantity,0) * 100)::bigint
         from wo_map m
        where m.store_code is not null`,
    )
```

  ⚠️ 执行时三处订正为真形状：① `stg_lemeng_transfer_out_published` 不存在——MO 侧直接复用本文件里已有的 dim_transfer_out 查询结果行（同事务内已算好，别查两遍；把该查询改造为同时喂两张表）；② override 是**平台库**表（`data.client_store_override`），warehouse SQL 够不着——实现改为：先从平台库读 override 行集，以**参数数组**注入 warehouse 查询（`unnest($n::text[],$m::text[])` 构造 inline map），或先在平台库建临时映射再搬运——**照 publish-dims 现有「warehouse 查、平台写」的方向，别跨库 join**；③ 列名以 stg 真实列集为准（Task 4 产物）。其余模式（5000 行分块、unnest 数组参数、事务 delete+insert、行数日志）逐行照 dim_transfer_out 段。
- [ ] **Step 2: 红清单**：插入前对 `wo_map` 里 `store_code is null` 的 distinct client_fid 打 `console.error(SCRIPT_NAME + ': 未映射批发客户 N 个（行 M 条不进面）：…')`；**不 exit 非零**（发布继续，消费端 fail-closed 兜底——spec §5「大声红」的落地形态）。注释里写明这个取舍。
- [ ] **Step 3: 真机验收**：按跑法注记 `docker exec -w /app openship-platform-core-shanhai-server node_modules/.bin/tsx scripts/lemeng/publish-dims.mjs`（openship MCP service exec 走）；判据：10-08 MO+WO 行数与 dim_transfer_out/dim_wholesale_out 对平、映射率与未命中清单人工过目、抽样单 price 与无极副本逐分对平。
- [ ] **Step 4: Commit** `feat(data): #517 publish-dims 归一段——映射解析+大声红`

### Task 8: 探活 + 波末

**Files:**
- Modify: `scripts/lemeng/wire-warehouse.sh`（判据 ⑥ 之后追加）

- [ ] **Step 1: 探活判据**（照 ⑥ 的形状）：`dim_settlement_order_line` 非空 + `max(order_bizday)` 距今 ≤2 天，否则 `ERR` 文案（「归一面 0 行/过期 ⇒ 工单取价不可用」）+ exit 1。
- [ ] **Step 2: 波末验证 + PR**：全量门禁（`pnpm test`、`pnpm typecheck`、`pnpm smoke`、守卫）→ PR `Closes #517`；merge 等 CI CLEAN → main 自动部署后，山海侧手工触发发布 job 重跑一次（数据面不随 app 部署自动跑）。

---

## Wave ③ 售后接线（#500 本体）

### Task 9: 迁移 006——ticket 自然键化 + settlement 六列

**Files:**
- Create: `modules/aftersales/migrations/006_ticket_natural_keys_settlement.sql`

**Interfaces:**
- Produces: ticket 新列 `product_code/store_code text not null default ''`、`settlement_source/settlement_order_no/settlement_item_code/settlement_line_key text not null default ''`、`settlement_price_minor bigint`、`settlement_bizday date`——Task 10 写、Task 11/12 读。

- [ ] **Step 1: DDL**（照 005 的死列化形状：摘 FK/not null、**不 drop**，保 001 全量重跑）：

```sql
-- 006_ticket_natural_keys_settlement.sql — 工单自然键化 + 挂原单冻结列（#500；spec §6.2/§6.3）。
-- 自然键：product_id/store_id bigint 死列化（摘 FK、摘 not null，不 drop——005 同款），
--   新引用列 = dim_item.item_code / dim_branch.code（not null default '' 与模块 text 列口径一致）。
-- 挂原单：settlement_* 六列冻结建单时的取价依据（spec §4 语义：price_minor=基本单位分价）。
alter table aftersales.ticket
  alter column product_id drop not null,
  alter column store_id drop not null;
alter table aftersales.ticket drop constraint if exists ticket_product_id_fkey;
alter table aftersales.ticket drop constraint if exists ticket_store_id_fkey;
alter table aftersales.ticket
  add column if not exists product_code text not null default '',
  add column if not exists store_code   text not null default '',
  add column if not exists settlement_source      text not null default '',
  add column if not exists settlement_order_no    text not null default '',
  add column if not exists settlement_item_code   text not null default '',
  add column if not exists settlement_line_key    text not null default '',
  add column if not exists settlement_price_minor bigint,
  add column if not exists settlement_bizday      date;
```

  （FK 约束名以 001_init.sql 实际命名为准，先 `\d aftersales.ticket` 核对再写 drop。）幂等自检同 Task 6 Step 3。
- [ ] **Step 2: Commit** `feat(aftersales): #500 工单自然键化+settlement 冻结列迁移（006）`

### Task 10: 建单取价——zod + 冻结 + fail-closed + 单测

**Files:**
- Modify: `modules/aftersales/routes/ticket-guest.ts`（SubmitBody + 建单事务）、`modules/aftersales/storage.ts`（若建单落库在 storage 层则改那里——以现有建单代码实际分层为准）
- Test: `modules/aftersales/module.test.ts`（或建单用例所在文件）

**Interfaces:**
- Consumes: Task 6 的面表、Task 9 的新列。
- Produces: 建单错误码 `PRICE_NOT_FOUND` / `ORDER_STORE_MISMATCH`（400，shape 照模块现有错误体惯例）。

- [ ] **Step 1: 失败测试**（dim 夹具模式：测试 setup 里建 `data.dim_settlement_order_line` 假表灌两行——一行 transfer 正常、一行 wholesale 串店）：

```ts
test('建单挂原单：冻结行价与依据，串店引用 400', async () => {
  // 正常：MO 行 (org, 'MO3120992607050085', item, '0') 存在且 store_code='S01'
  const ok = await submitTicket({ storeCode: 'S01', orderNo: 'MO3120992607050085',
    itemCode: 'I001', lineKey: '0', damageQuantity: 2 })
  expect(ok.status).toBe(201)
  expect(ok.body.settlement).toMatchObject({ source: 'transfer', orderNo: 'MO3120992607050085',
    itemCode: 'I001', lineKey: '0', priceMinor: 2700, bizday: '2026-10-08' })
  // 串店：同单行、storeCode='S02' ⇒ 400 ORDER_STORE_MISMATCH
  const bad = await submitTicket({ storeCode: 'S02', orderNo: 'MO3120992607050085',
    itemCode: 'I001', lineKey: '0', damageQuantity: 1 })
  expect(bad.status).toBe(400); expect(bad.body.error).toBe('ORDER_STORE_MISMATCH')
  // 缺单 ⇒ 400 PRICE_NOT_FOUND
  const missing = await submitTicket({ storeCode: 'S01', orderNo: 'MO000', itemCode: 'X', lineKey: '0', damageQuantity: 1 })
  expect(missing.status).toBe(400); expect(missing.body.error).toBe('PRICE_NOT_FOUND')
})
```

- [ ] **Step 2: 跑红** → **Step 3: 实现**——SubmitBody（string 四键；形状校验照 registration-guest.ts 对 dim_branch.code 的宽松校验先例）：

```ts
const SubmitBody = z.object({
  clientRequestId: z.string().min(1).max(128),
  storeCode: z.string().min(1).max(64),
  orderNo: z.string().regex(/^M[O]3120|^W[O]3120/).min(4).max(64),
  itemCode: z.string().min(1).max(64),
  lineKey: z.string().min(1).max(32),
  damageQuantity: z.number().int().nonnegative().max(MAX_INT4),
  remark: z.string().max(2000).optional(),
  attachmentIds: z.array(z.number().int().positive().safe()).max(50).optional(),
})
```

  建单事务内：`select source, store_code, order_bizday::text, price_minor from data.dim_settlement_order_line where org=$1 and order_no=$2 and item_code=$3 and line_key=$4` → 无行 400 `PRICE_NOT_FOUND`；`store_code !== storeCode` 400 `ORDER_STORE_MISMATCH`；命中则冻结六列；金额计算改读 `settlement_price_minor`（refund 公式落点以现有 process 路由实码为准，`basic_quantity` 换 `damage_quantity` 语义不动）。**注意 orderNo 正则别把前缀写死 3120**——正则应为 `/^MO|^WO/` + 数字，上面的 3120 是山海样本，通用形态按前缀族即可。
- [ ] **Step 4: 跑绿** → **Step 5: Commit** `feat(aftersales): #500 建单挂原单冻结+fail-closed（PRICE_NOT_FOUND/ORDER_STORE_MISMATCH）`

### Task 11: 选单端点 + manifest 声明 + 单测

**Files:**
- Modify: `modules/aftersales/routes/ticket-guest.ts`（或新 `routes/settlement.ts`——若 ticket-guest.ts 已超 400 行则新文件）、`modules/aftersales/manifest.yaml`、`modules/aftersales/api-types.ts`
- Test: 建单测试同文件

**Interfaces:**
- Produces: `GET /guest/settlement-orders?storeCode=&days=` → `{orders:[{orderNo, source, bizday, createTime, lines:[{itemCode, itemName, lineKey, quantity, priceMinor}]}]}`（mobile Task 13 消费此形状）。

- [ ] **Step 1: 失败测试**（夹具灌一单两行 → 断言分组与 days clamp：`days=400` ⇒ 按上限 90 查）。
- [ ] **Step 2: 实现**：

```ts
r.get('/guest/settlement-orders', async (c) => {
  const identity = c.get('identity')
  const storeCode = String(c.req.query('storeCode') ?? '')
  if (!storeCode) return c.json({ error: 'STORE_CODE_REQUIRED' }, 400)
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 30) || 30, 1), 90)
  const res = await ctx.pool.query(
    `select source, order_no, order_bizday::text as bizday, order_time,
            item_code, item_name, line_key, quantity, price_minor
       from data.dim_settlement_order_line
      where org = $1 and store_code = $2
        and order_bizday >= current_date - $3::int
      order by order_bizday desc, order_no, item_code, line_key`,
    [identity.orgId, storeCode, days])
  // 按 order_no 分组后 c.json({orders:[…]})——分组实现照 normalizeTicketRow 所在文件的风格
})
```

- [ ] **Step 3: manifest** `api.internal` 追加 `- { method: GET, path: /guest/settlement-orders, scope: aftersales:guest }`（漏声明 = 403，声明即授权是宿主铁律）；**装载期双向核对**：路由集合与声明集合必须一致，否则起不来。
- [ ] **Step 4: 跑绿 → Commit** `feat(aftersales): #500 选单端点+manifest 声明`

### Task 12: api-types / console 投影跟改

**Files:**
- Modify: `modules/aftersales/api-types.ts`（SubmitBody/工单行类型：productId/storeId→string 四键 + settlement 读形状）、`modules/aftersales/routes/ticket-manage.ts`（normalizeTicketRow 投影 settlement 列）、`modules/aftersales/console/tickets/`（列表/详情展示结算依据一行）

- [ ] **Step 1: 类型与投影**——`normalizeTicketRow` 加 `settlement` 字段（六列 → `{source, orderNo, itemCode, lineKey, priceMinor, bizday|null}`）；console 详情页在金额旁展示「依据：MO… × 品名 @ ¥27.00/kg（10-08）」（文案组件照现有详情排版）。
- [ ] **Step 2: 全量类型检查**：`pnpm typecheck`（api-types 改动会红连 console/mobile，顺到 Task 13 一起绿）。
- [ ] **Step 3: Commit** `feat(aftersales): #500 读侧投影+console 依据展示`

### Task 13: mobile 选单链

**Files:**
- Modify: `modules/aftersales/mobile/src/composables/useWorkOrderSubmit.ts`、`modules/aftersales/mobile/src/shims/`（wuji-data shim 的 `Number(payload.product_id)` 行）、`modules/aftersales/mobile/src/pages/`（建单页加选单步）
- Test: `useAfterSalesData.test.ts` 跟改

- [ ] **Step 1: 提交链改造**——`useWorkOrderSubmit` 的 payload 换四自然键 + 选单状态（选店后拉 `/guest/settlement-orders`，选单选行把 `orderNo/itemCode/lineKey/priceMinor` 带进提交体）；shim 的 `Number(payload.product_id)` 删除（自然键是 string）。
- [ ] **Step 2: 选单页**——交互流：选店 → 单列表（单号+bizday+source 徽标）→ 单内行列表（品名/数量/单价）→ 选中行回填建单表单并显示冻结价。组件样式照 pages 现有页。
- [ ] **Step 3: 单测跟改绿** → **Step 4: Commit** `feat(aftersales): #500 mobile 选单建单链（自然键+挂原单）`

### Task 14: 端到端验收 + 门禁 + PR + 部署后验

- [ ] **Step 1: 本地端到端**：dev-stack（MockCasdoor）+ Edge CDP 配方（记忆 platform-core-local-ui-verify-recipe：`--remote-allow-origins`、Node 全局 WebSocket、登录体 username）走通：选店→选单→建单→票面 settlement 有源→管理端可见。**开发完自己验（§1.6），不许丢给首轮测试**。
- [ ] **Step 2: 波末全量门禁**：`pnpm test && pnpm typecheck && pnpm smoke` + 八条 check-* 守卫（对照 CI gates 清单）全绿。
- [ ] **Step 3: PR**：`Closes #500`，body 关联段 issue ①② 与 #481 验收② 收口声明；等 CI CLEAN（UNSTABLE 不强合——merge-only-on-clean-ci）。
- [ ] **Step 4: 部署后验**：merge → 等 main 更版自动部署 mytech → 手动触发山海（webhook，判据取 activeDeploymentStatus）→ **进容器验证**（grep dist 产物含 settlement-orders 路由串，不用 HTTP 探活——宿主鉴权 401 挡路）→ 生产冒烟：真库选单建单一例 + `PRICE_NOT_FOUND` 一例。
- [ ] **Step 5: 收尾**：#481/#499/#500 收官评论；WeKnora 沉淀「挂原单取价」落地案例（先查重，命中更新 `cb31a2fb`）；`teamai import --from-mr`（三个 MR）。

---

## Self-Review 记录

1. **Spec 覆盖**：§4 schema→Task 6；§5 映射/大声红/override→Task 7；§6.1 端点+manifest→Task 11；§6.2 冻结矩阵→Task 10；§6.3 替换关系→Task 9/10；§7 通用性（无代码分支，自然成立）；§8 四条验收→Task 5/7/14；§9 三段 issue→Task 0。无缺口。
2. **占位符扫描**：Task 7 Step 1 的三处「⚠️ 执行时订正为真形状」是**显式核对指令**（列出真来源文件），不是 TBD；Task 4 Step 1 同理。其余步骤均有实码/实命令。
3. **类型一致性**：面表列名（Task 6）↔ 发布 SQL（Task 7）↔ 端点查询（Task 11）↔ settlement 六列（Task 9）↔ normalizeTicketRow（Task 12）一致；`PRICE_NOT_FOUND`/`ORDER_STORE_MISMATCH` 在 Task 10/14 两处同拼写。
