# 乐檬采集 S1（首源范式：retail 3120 日粒度 + Gate 销账）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `retail.ai.pos.posorder.find` 接成新湖第一个源（契约/管线/staging 三件套），销掉 G1–G4 四个 Gate，在 shanhai 数据面真机跑通一次日粒度采集并回读自证——为 S2–S5 的全域复制立范式。

**Architecture:** duckle 唯一管线执行器（引擎产管线 JSON，仓内不手编）；openship jobs 调度 + 薄 wrapper 注窗口 env；湖 = ZOS 上 hive 分区 `lemeng/retail_order_line/system_book=X/bizday=D/hour=H/all.parquet` 分区单文件覆盖写；dbt staging 一对一定型，口径不动（L1 零改）。设计正典 = `docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md`（下称 spec）。

**Tech Stack:** duckle 0.7.3（PyPI，自带 duckdb-cli 1.5.4）/ pgduckdb/pgduckdb:18-v1.1.1（DuckDB 1.4.3）/ dbt 1.9 + dbt-postgres / 天翼云 ZOS（snk.minio 或 httpfs 退路）/ openship MCP（jobs 与数据面操作唯一通道）。

## Global Constraints

- 分层纪律：staging 一对一不改义；口径只在 marts；L1 唯一事实源 `dbt/semantics/l1_metrics.yml` 本计划**零改动**（实现换源，声明不动）。
- 契约纪律：`contracts/` 元 schema（`_schema.schema.json`）判据——`partitionStyle=hive`、`fileName=all.parquet`、分区键列不可空、外部标识一律 `varchar`、`decimal` 必带 precision/scale、`batch.markerColumn` 必填。
- duckle 三坑（`duckle/README.md` §7.3）：`drift` 假绿（先断言声明存在）；`qa.freshness` 时区坑（**不用它**，新鲜度由 job receipt + 回读承担）；`pipelineHash` 是代码指纹不是数据指纹。
- 管线 JSON 由真引擎产出（duckle MCP `create_pipeline`/`validate_pipeline`），**禁止手写后不验证就落仓**；`data.schema` 只声明标量列；路径一律绝对路径；`ctl.foreach` 不用（凭据作用域坑）。
- AGI 网关事实（spec §3.1）：分页在 body（`page_number/page_size` 上限 100）、query 无效、无 total、`branch_nums` 非空、作废单照采、单店跨度≤3月/多店≤1月。
- 提交纪律：feat/fix 引用 issue #150；`tsx scripts/check-data-models.mjs` 必须每次过门（exit 0）；密钥只在 openship env（isSecret），任何文件不落明文。
- 执行分支：spec PR（#195）合入 main 后从 main 开新分支执行；本计划所有仓库改动基于该分支。

---

### Task 1: G4 探针——64188 token 身份核验

**Files:** 无仓库新增；Modify: spec §4.2 Gate 表（G4 行改「已销」+结论）

**Interfaces:** Produces: 64188 token 可用性结论（S3 双账套铺开的前置）

- [ ] **Step 1: whoami 探针**

```bash
curl -sS -X POST "https://cloud.nhsoft.cn/agi/mcp" \
  -H "Authorization: Bearer $LEMON_AGI_TOKEN_64188" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' \
  | grep -o 'data: .*' | sed 's/data: //' | python3 -c "import json,sys; d=json.load(sys.stdin); t=d['result']['content'][0]['text']; j=json.loads(t); print('company_id=',j.get('company_id'),'branch_num=',j.get('branch_num'),'可见门店数=',len(j.get('branch_nums',[])))"
```

token 取法：openship 数据面 project env `LEMON_AGI_TOKEN_64188`（isSecret）。本地执行时从 env 读；**不回显 token 值**。
Expected: `company_id= 64188`，branch_nums 非空。若 401 → 记录「token 未落/失效」，G4 转「待补」，不阻断 S1 其余任务（S1 只用 3120）。

- [ ] **Step 2: 能力面一致性抽查**（64188 token 调 posorder 1 行，确认与 3120 同形）

```bash
# 同上 URL 与头，method/tools/call name=call_agi_ability，
# arguments={"ability":"nhsoft.retail.ai.pos.posorder.find","method":"POST",
#   "body":{"branch_nums":[1],"date_from":"<昨日>","date_to":"<昨日>","time_from":"00:00:00","time_to":"23:59:59","page_number":1,"page_size":1}}
```

Expected: 返回结构含 `order_no`/`pos_order_details`（与 3120 实测同形）。

- [ ] **Step 3: 结论回写 spec 并提交**

编辑 spec §4.2 G4 行：`| G4 | ~~…~~ **已销（本日）**：whoami company_id=64188、门店 N 家；能力面与 3120 同形 |`（按实测值填）。
Run: `git add docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md && git commit -m "docs(spec): G4 销账——64188 token whoami/能力面实测 (#150)"`

---

### Task 2: G3 探针——单据系明细行键钉死

**Files:** 无仓库新增；Modify: spec §3 表（#2/#3/#4 行自然键列）与 §4.2 G3 行

**Interfaces:** Produces: 调拨/批发/退货的行粒度自然键（S3 契约的输入）

- [ ] **Step 1: 三端点各拉 1 天样本（3120 token）**

对以下三个 ability 各发一次（`call_agi_ability`，body 用各自分页风格）：
- `nhsoft.ama.ai.transfer.out.order.find` `{"start_date":"<昨日>","end_date":"<昨日>","page_number":1,"page_size":3}`
- `nhsoft.whs.ai.wholesaleorder.find` `{"date_start":"<昨日> 00:00:00","date_end":"<次日> 00:00:00","date_type":"制单时间","paging":true,"limit":3,"offset":0}`
- `nhsoft.whs.ai.wholesalereturn.find` `{"date_start":"<昨日> 00:00:00","date_end":"<次日> 00:00:00","date_type":"制单时间","paging":true,"limit":3,"offset":0}`

- [ ] **Step 2: 检查 items[] 行字段，判定行键**

对每个响应：`jq '.result[0].items[0]'`（或 python dict 打印）。判定规则：优先 `(单据号, 行唯一id)`（若有 `id`/`line_no`/`detail_id` 类字段）；否则 `(单据号, item_num)` 并验证**单据内 item 是否可重复**（`jq '.result[0].items | group_by(.item_num) | map(select(length>1))'` 全部端点为空数组 ⇒ 键成立；出现重复 ⇒ 行键必须含序号列，把该列名记下来）。

- [ ] **Step 3: 结论回写 spec 并提交**

spec §3 表 #2/#3/#4 的自然键列改为实测结论；§4.2 G3 行标「已销」+结论。
Run: `git add docs/superpowers/specs/2026-09-24-lemeng-collection-pipeline-design.md && git commit -m "docs(spec): G3 销账——调拨/批发/退货明细行键实测钉死 (#150)"`

---

### Task 3: 采集契约 lemeng.retail_order_line.json

**Files:**
- Create: `contracts/common/lemeng.retail_order_line.json`
- 参照: `contracts/common/_template.contract.json`、`contracts/common/_schema.schema.json`

**Interfaces:** Produces: 湖表 `lemeng/retail_order_line` 的落盘定型契约（Task 7 管线、Task 9 staging 的共同依据；列名以本契约为准）

- [ ] **Step 1: 写契约文件**（初稿列全集来自 2026-09-24 实测样本；Step 3 首跑前按全量样本补齐）

```json
{
  "$schema": "./_schema.schema.json",
  "contractVersion": 1,
  "domain": "lemeng",
  "table": "retail_order_line",
  "owner": "data-platform",
  "description": "乐檬零售订单明细行（posorder.find 拉回后管线内 UNNEST 成行粒度）。两账套各采各的；作废/取消单照采，口径在 marts。",
  "layout": {
    "prefix": "lemeng/retail_order_line",
    "partitionStyle": "hive",
    "partitionBy": ["system_book", "bizday", "hour"],
    "fileName": "all.parquet"
  },
  "batch": {
    "markerColumn": "batch_id",
    "type": "varchar",
    "unique": false,
    "note": "= 采集 run id（job wrapper 生成：retail-<UTC时间戳>-<窗口标识>）。同窗重跑换新 run id，幂等靠对象覆盖写。"
  },
  "columns": [
    { "name": "batch_id", "type": "varchar", "nullable": false, "description": "批次标记（采集 run id）" },
    { "name": "system_book", "type": "varchar", "nullable": false, "description": "账套（3120/64188）；分区键，来源=明细行 system_book_code" },
    { "name": "bizday", "type": "date", "nullable": false, "description": "营业日（shift_table_bizday，YYYYMMDD 落盘即定型为 date）；分区键" },
    { "name": "hour", "type": "integer", "nullable": false, "description": "成交时间所在小时（0-23）；分区键，由 order_time 推导" },
    { "name": "order_no", "type": "varchar", "nullable": false, "description": "订单号（自然键之一）" },
    { "name": "order_detail_num", "type": "varchar", "nullable": false, "description": "明细行号（自然键之一）" },
    { "name": "branch_num", "type": "integer", "nullable": false, "description": "门店号（账套内编号）" },
    { "name": "branch_name", "type": "varchar", "nullable": true, "description": "门店名" },
    { "name": "order_time", "type": "timestamp", "nullable": true, "description": "成交时间" },
    { "name": "order_operate_time", "type": "timestamp", "nullable": true, "description": "操作时间" },
    { "name": "state", "type": "varchar", "nullable": false, "description": "单据状态（FINISHED/CANCELED/REPAID/…）" },
    { "name": "order_source", "type": "varchar", "nullable": true, "description": "订单来源" },
    { "name": "item_num", "type": "varchar", "nullable": false, "description": "商品号（账套内编号，varchar 防撑爆）" },
    { "name": "item_code", "type": "varchar", "nullable": true, "description": "商品业务码（跨品牌归并键）" },
    { "name": "sale_money", "type": "decimal", "precision": 14, "scale": 2, "nullable": true, "description": "行成交金额（元）" },
    { "name": "discount_money", "type": "decimal", "precision": 14, "scale": 2, "nullable": true, "description": "行折扣金额（元）" },
    { "name": "payment_money", "type": "decimal", "precision": 14, "scale": 2, "nullable": true, "description": "行收款金额（元）" },
    { "name": "quantity", "type": "decimal", "precision": 14, "scale": 3, "nullable": true, "description": "行数量" }
  ]
}
```

- [ ] **Step 2: 过静态门禁**

Run: `tsx scripts/check-data-models.mjs`
Expected: exit 0，stdout `check-data-models: OK（…）`。若报列/分区跨字段不一致，按报错修（分区键必须在 columns 里且 nullable=false）。

- [ ] **Step 3: 样本校对列全集（首跑前，Task 8 之前完成）**

拉一个整日样本（Task 7 管线 ready 后跑 `page_size=100` 全翻页到本地 /tmp），`jq` 列出 detail 行全部字段；对照契约——缺列补进（毛利/成本类若返回则补 `profit` decimal 列，敏感口径由消费层权限管，采集不筛）；多列不删（落盘即定型，宁全勿缺）。
Run: `tsx scripts/check-data-models.mjs`（补列后再过门）

- [ ] **Step 4: Commit**

```bash
git add contracts/common/lemeng.retail_order_line.json
git commit -m "feat(contracts): 乐檬零售明细行契约——hive 三级分区+落盘定型 (#150)"
```

---

### Task 4: 本地 duckle 引擎与 MCP 就位

**Files:** 无仓库改动（工具就位 + 事实记录）

**Interfaces:** Produces: 管线组件的真实字段面（Task 5/7 的参数依据）；`duckle` CLI 与 MCP 的可用入口

- [ ] **Step 1: 安装**

```bash
python3 -m venv /tmp/duckle-venv && /tmp/duckle-venv/bin/pip install "duckle==0.7.3"
/tmp/duckle-venv/bin/duckle --help | head -30   # 确认 CLI 可用；duckdb 由 duckdb-cli 1.5.4 传递依赖带入
```

- [ ] **Step 2: 找到 MCP 入口**

Run: `/tmp/duckle-venv/bin/duckle --help` 里找 `mcp`/`serve` 子命令（`duckle/README.md` §4 提到 duckle 自带 MCP：`list_components`/`get_component_schema`/`create_pipeline`/`validate_pipeline`）。若 MCP 经 CLI 起（如 `duckle mcp`），记录启动命令；若只有桌面 App 引擎有（`~/Library/Application Support/io.duckle.app/engines/mcp/duckle-mcp`），用该二进制。
Expected: 能列工具清单（JSON-RPC initialize + tools/list，与乐檬 MCP 同法 curl 或 stdio）。

- [ ] **Step 3: 摸组件真实字段**

对 `src.rest`、`snk.minio`、`qa.contract`、`ctl.die`、`code.sql` 各调 `get_component_schema`，**逐字段记录**（ especial：`snk.minio` 的 key/prefix/endpoint/urlStyle/useSsl/format/mode 字段名；`src.rest` 的 body/method/headers/pagination 字段）。产物 = Task 7 参数清单的最终依据（贴进执行记录）。
Expected: 拿到 5 个组件的 schema JSON；`snk.minio` 存在且字段与 `duckle/README.md` §1.2 一致（endpoint 不带 https / urlStyle=path / useSsl）。

---

### Task 5: G1 探针——sink key 的 env 参数化（两段式）

> **环境订正（2026-09-24 执行时发现）**：本机无 ZOS 凭据（凭据只在数据面机/openship env，取不出明文）。原「本地直写 ZOS 测试桶」改为：**G1a 本地零凭据信号探针**（snk.parquet 本地路径的 env 参数化——同一模板引擎，强信号）+ **G1b 原位确认**（并入 Task 8 首次真机写 ZOS，失败即走退路）。spec G1 行在 G1b 确认前保持「部分销账（G1a 信号 + 待 G1b）」。

**Files:** 无仓库改动（探针管线留 /tmp，不落仓）；Modify: spec §4.2 G1 行（部分销账标注）

**Interfaces:** Produces: key 模板化的信号结论 + Task 8 的 G1b 验收点（Task 7 管线 sink 参数按信号结论先定形态）

- [ ] **Step 1: 造最小探针管线（引擎产）**

用 Task 4 的 MCP `create_pipeline`：一个 2 节点管线——python/inline 源产出 1 行假数据（含 Step 3 契约同名列子集，类型对齐）→ `snk.minio`，key 写 `` lemeng/_probe/g1/hour=${ENV:PROBE_HOUR}/all.parquet ``（endpoint/urlStyle/useSsl/format=parquet/mode=overwrite 按 Task 4 实测字段名）。**凭据走 ZOS 测试桶的 AK/SK（openship env 取，不进管线明文——若 connectionRef 支持 env 则用之）**。

- [ ] **Step 2: 两跑两对象**

```bash
PROBE_HOUR=07 /tmp/duckle-venv/bin/duckle-runner --pipeline /tmp/g1.json --workspace /tmp/g1-ws \
  --duckdb /tmp/duckle-venv/bin/duckdb --log-dir /tmp/g1-logs --name g1-a
PROBE_HOUR=08 <同上 --name g1-b>
```

- [ ] **Step 3: 回读对象存储判定**

```bash
# DuckDB httpfs 回读（endpoint 不带 https、path-style、zstd 无关读取）：
/tmp/duckle-venv/bin/duckdb -c "
INSTALL httpfs; LOAD httpfs;
CREATE SECRET zos (TYPE S3, KEY_ID '<AK>', SECRET '<SK>', ENDPOINT '<endpoint>', URL_STYLE 'path', REGION '<region>', USE_SSL true);
SELECT count(*) FROM read_parquet('s3://<桶>/lemeng/_probe/g1/hour=07/all.parquet');
SELECT count(*) FROM read_parquet('s3://<桶>/lemeng/_probe/g1/hour=08/all.parquet');"
```

Expected: 两个对象都存在、各 1 行 ⇒ **G1 通过**（key 可 env 参数化）。
若两次都写同一 key（hour=08 覆盖 07 或第二个对象不存在）⇒ **G1 不通**：Task 7 管线尾部改为「sink 落本地绝对路径 → wrapper 追加一段 DuckDB httpfs `COPY … TO 's3://…'` 上传」（退路，`duckle/README.md` §1.3 已投产通道）。

- [ ] **Step 4: 结论回写 spec 并提交**（G1 行标已销/退路，附两跑的对象 key 证据）

---

### Task 6: G2 探针——duckle 写的 parquet 由 pg_duckdb 回读

**Files:** 无仓库改动；Modify: spec §4.2 G2 行

**Interfaces:** Produces: 写读版本兼容结论（duckdb-cli 1.5.4 写 → pgduckdb 18-v1.1.1/DuckDB 1.4.3 读）

- [ ] **Step 1: 用 Task 5 的探针对象当读样本**（已是 duckle 产出；若 G1 走退路则用退路本地产物）

- [ ] **Step 2: 官方镜像回读**

```bash
docker run --rm -e AWS_ACCESS_KEY_ID=<AK> -e AWS_SECRET_ACCESS_KEY=<SK> \
  pgduckdb/pgduckdb:18-v1.1.1 psql -U platform -d warehouse -c \
  "SELECT count(*), column_type FROM (SELECT * FROM duckdb.raw_query(\"SELECT count(*) c, typeof(sale_money) t FROM read_parquet('s3://<桶>/lemeng/_probe/g1/hour=07/all.parquet', hive_partitioning=1)\")) q;"
```

（容器内 pg_duckdb 的 DuckDB 侧 httpfs 需先建 SECRET——按 `dbt/README.md` gate 1 的实测注入形态调整；本步目的是「读得出+类型符合契约」，SQL 形态允许按容器实际调整，**不许因报错跳过**——失败即 Gate 结果为「不通」，触发 main 计划 T6 Gate-E 的处置路径：写方降参（无 zstd/row_group 默认值）重试，仍不通则 duckle 写侧改经 pg_duckdb 兼容参数。）
Expected: 行数=1、类型=DECIMAL(14,2)（与契约一致）。

- [ ] **Step 3: 结论回写 spec 并提交**（G2 行销账，附类型证据）

---

### Task 7: 零售 3120 日粒度管线产出与落仓

**Files:**
- Create: `duckle/common/lemeng.retail_order_line.json`（引擎产，validate 过后落仓）

**Interfaces:**
- Consumes: Task 3 契约（列/类型/分区）、Task 4 组件字段面、Task 5 G1 结论
- Produces: 可被 `duckle --pipeline` 执行的管线；窗口/凭据全部 env 注入（Task 8/10 的调用面）：`LEMENG_TOKEN`、`BIZDAY`、`HOUR`（两位数字符串，如 `14`）、`HOUR_FROM`/`HOUR_TO`（LocalTime，如 `14:00:00`/`14:59:59`）、`BRANCH_NUMS`（JSON 数组字符串）、`SYSTEM_BOOK`、`ZOS_*`（五键）、`BATCH_ID`

- [ ] **Step 1: 经 MCP `create_pipeline` 生成**（以下为参数清单，节点 id/结构以引擎产出为准）

  1. **src.rest 页节点 ×8**（p1..p8，固定页容量）：POST `https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.pos.posorder.find`，headers `Authorization: Bearer ${ENV:LEMENG_TOKEN}`，body（每节点 page_number=1..8）：`{"branch_nums": <ENV:BRANCH_NUMS>, "date_from": "${ENV:BIZDAY}", "date_to": "${ENV:BIZDAY}", "time_from": "${ENV:HOUR_FROM}", "time_to": "${ENV:HOUR_TO}", "page_number": N, "page_size": 100}`；`data.schema` 声明标量列（order_no/state/order_time/branch…），**不声明 pos_order_details**（嵌套留推导）。0 行页靠声明过的 schema 正常类型化（已知坑）。
  2. **merge + code.sql 展开定型**：`SELECT <契约列> , '${ENV:SYSTEM_BOOK}' AS system_book, CAST(strptime(order_detail_bizday,'%Y%m%d') AS DATE) AS bizday, <hour 由 order_time 推导>, '${ENV:BATCH_ID}' AS batch_id FROM input o CROSS JOIN UNNEST(o.pos_order_details) AS unnest`（列引用 `unnest.item_num` 等；cast 目标用 numeric/float，**禁 double**）。
  3. **qa.contract**（gate 透传/拒绝）：order_no、order_detail_num、system_book、bizday、hour、batch_id 非空；sale_money 介于 -1e6..1e6。
  4. **ctl.die 末页守卫**：`condition=has-rows` 于 p8——第 8 页仍有行 = 容量截断，中止（消息含窗口标识）。
  5. **snk.minio**（或 G1 退路本地 sink+上传段）：key `lemeng/retail_order_line/system_book=${ENV:SYSTEM_BOOK}/bizday=${ENV:BIZDAY}/hour=${ENV:HOUR}/all.parquet`，`mode=overwrite`、`format=parquet`、`compression=zstd`。

- [ ] **Step 2: `validate_pipeline` 过 + `duckle validate` 过**（CLI 即 runner）

Run（runner 形态）：`/tmp/duckle-venv/bin/duckle validate /tmp/lemeng.retail_order_line.json`
Expected: `0 failed`。

- [ ] **Step 3: 落仓提交**

```bash
git add duckle/common/lemeng.retail_order_line.json
git commit -m "feat(duckle): 乐檬零售明细采集管线——8页容量+末页守卫+UNNEST定型+覆盖写 (#150)"
```

---

### Task 8: 真机首跑 + 回读自证 + 幂等

**Files:** 无仓库改动（真机操作全走 openship MCP；记录进 PR 描述）

**Interfaces:** Consumes: Task 7 管线（已落仓）、shanhai 数据面 project（已存在，SOP 案例站）

- [ ] **Step 1: 在数据面机执行昨日 24 时窗循环**（openship MCP server exec 或一次性 job；环境变量从 project env 注入）

**前置（SOP P2 钉 SHA 法）**：数据面机 checkout `/opt/platform-core-data/platform-core` 更新到本分支 HEAD 全 SHA（`git fetch && git checkout <全 SHA>`，SHA 从命令输出逐字复制），否则新管线文件不在 `/pipelines` 挂载里。

```bash
# 伪码（实际经 openship jobs 一次性 run；分支列表 = whoami.branch_nums 去 99）：
for H in $(seq -w 0 23); do
  BATCH_ID="retail-3120-$(date -u +%Y%m%dT%H%M%SZ)-$H"
  duckle --pipeline /pipelines/common/lemeng.retail_order_line.json --workspace /workspace \
    --duckdb "$(command -v duckdb)" --log-dir /workspace/logs/$H   # env: LEMENG_TOKEN/BIZDAY=昨日/HOUR=$H/HOUR_FROM=$H:00:00/HOUR_TO=$H:59:59/BRANCH_NUMS/SYSTEM_BOOK=3120/ZOS_*/BATCH_ID；CLI 无 --name，按 log-dir 区分（Task 5 实测订正）
done
```

Expected: 24 个 run 全部 `status: ok`（空时窗产出空 schema 文件，合法）。

- [ ] **Step 2: 回读自证（独立通道）**

```bash
# a) 对象清单：24 个 hour 文件在位
# b) DuckDB httpfs 回读行数 + SUM(sale_money)（分小时）
# c) 对账：AGI branchindicator 当日 sale_money（按店）vs 湖内 FINISHED 单 SUM——逐店 diff 表
```

Expected: (a) 24 文件；(b) 行数量级 ≈ 旧湖同期；(c) **diff 表留档**（首跑允许非零——口径含退货单为负、branchindicator 口径待 S2 对齐；但必须逐店记录差值，作为 S2 audit 基线）。

- [ ] **Step 3: 幂等重跑**

重跑任一时窗（同参数换 BATCH_ID）→ 对象 ETag/Size 与首跑一致（内容不变幂等）。
Expected: ETag 相同；不同则记录差异根因（时区内新单属正常，改跑冷门时窗 03:00 验证）。

- [ ] **Step 4: drift 门禁核（spec S1 出口项，main 未验清单 #1/#3 的就地核）**

在数据面对已落管线跑 drift（子命令形态以 `duckle --help` 实测为准，仓文档写 `duckle-runner drift`）（带 `--token` 的授权作业路径，`duckle/README.md` §7.5）：先断言管线 `data.schema` 声明存在（防假绿——三坑 #1），再跑 drift，期望 exit 0 且结论基于真实比对（非「未声明即绿」）；同场即完成「容器内行为」核（T8 全程在 runner 容器内执行，本步通过 = 未验 #3 就地销）。结论记入 PR 描述（通/不通+形态），不通则 S2 起以 `qa.contract` + 契约静态门禁为唯一列门禁（记进 spec）。

---

### Task 9: dbt 接新湖（staging 重写 + fct 换源）

**Files:**
- Modify: `dbt/models/common/staging/sources.yml`（增 `retail_order_line` 表声明，hive meta）
- Create: `dbt/models/common/staging/stg_lemeng_retail_order_line.sql`
- Modify: `dbt/models/common/marts/fct_retail_sale.sql`（换源适配）、`dbt/tests/audit_retail__*.sql`（若引用旧列名）
- Delete（迁移完成判据）: `dbt/models/common/staging/stg_lemeng_retail_detail.sql`（旧湖 staging，待 S4 回填覆盖同域后删；**本任务先保留双轨**——staging 改名并行，fct 切新源）

**Interfaces:**
- Consumes: 湖表 `lemeng/retail_order_line`（Task 8 产出）
- Produces: `stg_lemeng_retail_order_line`（typed 行粒度）；`fct_retail_sale` 列契约不变（`net_amount`/`order_count`/`system_book`/`bizday`——L1 expression 与 audit 零改动）

- [ ] **Step 1: sources.yml 增表**

```yaml
    tables:
      - name: retail_order_line
        description: '零售订单明细行（新湖，2026-09-24 契约）：hive 三级分区 system_book/bizday/hour，落盘即定型（numeric/timestamp/date），作废单照采。'
        meta:
          path_convention: 'lemeng/retail_order_line/system_book=<账套>/bizday=<日期>/hour=<时>/all.parquet'
          access_path: "read_parquet('s3://{{ var(\"zos_bucket\") }}/lemeng/retail_order_line/{{ var(\"account_book\") }}/**/*.parquet', hive_partitioning=1)"
          pagination: '新湖由 duckle 管线写入（duckle/common/lemeng.retail_order_line.json）'
```

- [ ] **Step 2: staging 模型**

```sql
{{ config(materialized='table') }}
-- stg_lemeng_retail_order_line — 一对一定型（湖已 typed，本层只做取列/命名/透传，不改义）。
-- 坑 #5 纪律：read_parquet 点名取列必须 r['列名']。
select
  r['batch_id']           as batch_id,
  r['system_book']        as system_book,
  r['bizday']             as bizday,
  r['order_no']           as order_no,
  r['order_detail_num']   as order_detail_num,
  r['branch_num']         as branch_num,
  r['branch_name']        as branch_name,
  r['item_num']           as item_num,
  r['item_code']          as item_code,
  r['state']              as state,
  r['order_source']       as order_source,
  r['order_time']         as order_time,
  r['sale_money']         as sale_money,
  r['discount_money']     as discount_money,
  r['payment_money']      as payment_money,
  r['quantity']           as quantity
from duckdb.raw_query(
  'SELECT * FROM read_parquet(''s3://' || {{ var("zos_bucket") }} || ''/lemeng/retail_order_line/{{ var("account_book") }}/**/*.parquet'', hive_partitioning=1)'
) as r
```

⚠️ 两处按实测调整（写清不许跳）：① `hive_partitioning=1` 在 pg_duckdb `raw_query`/`duckdb.query` 里的可用性——不通则分区列从 `filename` regexp 提取（老范式）并在本文件头注记；② `r['col']` 在 raw_query 结果上的引用形态以首跑报错为准修正。

- [ ] **Step 3: fct_retail_sale 换源 + 唯一性测试**

打开 `dbt/models/common/marts/fct_retail_sale.sql`：输入从 `ref('stg_lemeng_retail_detail')` 换 `ref('stg_lemeng_retail_order_line')`；`net_amount` 直接取 `sale_money`（已 typed，删 cast）；`order_count` 语义保持「按 order_no 去重」（`count(distinct order_no)`）；grain 保持 `system_book × bizday`；**列名与语义零改动**（L1 声明不动）。
`dbt/models/common/marts/schema.yml` 的 unique/not_null 测试对象改为新自然键（`order_no + order_detail_num` 组合唯一断言），state 加 accepted_values（FINISHED/CANCELED/REPAID/…按实测全集）。

- [ ] **Step 4: 数据面跑 dbt + 测试**

按 `deploy/data-plane-deploy-sop.md` etl 段在数据面执行（openship job / exec）：`dbt run --select stg_lemeng_retail_order_line fct_retail_sale` → `dbt test`。
Expected: run ok；`assert_fct_retail_sale_grain_unique` 过；`audit_retail__net_sales` 过（新湖首日数据）。

- [ ] **Step 5: 静态门禁 + 提交**

```bash
tsx scripts/check-data-models.mjs   # 双向命名机检：新 staging 必须有 sources 声明（Step 1 已加）
git add dbt/ && git commit -m "feat(dbt): 零售域切新湖——staging 重写+fct 换源，L1 零改 (#150)"
```

---

### Task 10: 日调度 job 注册 + _ops 观测

**Files:**
- Create: `scripts/lemeng/run-retail-day.sh`（薄 wrapper：窗口 env 计算 + 24 时窗循环 + `_ops` JSON 行输出）
- openship job（数据面 project，非仓库文件）

**Interfaces:** Consumes: Task 7 管线；Produces: 每日自动采集 + OO 可查的 `_ops` 流

- [ ] **Step 1: wrapper 脚本**（要点：`date -u` 推昨日 bizday；BIZDAY 用营业日格式 `YYYY-MM-DD`；BRANCH_NUMS 由 `whoami` 缓存文件或 env 常量注入；每窗 run 后写一行 `{"ts":…,"job":"retail-day","window":…,"rows":…,"status":…}` 到 stdout——openship job 日志 → OO 按 SOP 文件日志通道）

```bash
#!/usr/bin/env bash
set -euo pipefail
BIZDAY=$(date -u -v-1d +%F)          # macOS; 数据面 Linux 用 date -u -d 'yesterday' +%F；duckle 即 runner（无 duckle-runner 二进制）
for H in $(seq -w 0 23); do
  BATCH_ID="retail-${SYSTEM_BOOK}-$(date -u +%Y%m%dT%H%M%SZ)-$H"
  export HOUR="$H" HOUR_FROM="${H}:00:00" HOUR_TO="${H}:59:59" BATCH_ID
  duckle --pipeline /pipelines/common/lemeng.retail_order_line.json \
    --workspace /workspace --duckdb "$(command -v duckdb)" \
    --log-dir /workspace/logs/${BIZDAY}/$H
  echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"job\":\"retail-day\",\"system_book\":\"$SYSTEM_BOOK\",\"bizday\":\"$BIZDAY\",\"hour\":\"$H\",\"status\":\"ok\"}"
done
```

- [ ] **Step 2: 注册 openship job**（openship MCP）：`label=lemeng-retail-3120-daily`，cron `30 2 * * *`，serverId=数据面机，env 注 `LEMENG_TOKEN`（isSecret）/`SYSTEM_BOOK=3120`/`BRANCH_NUMS`/`ZOS_*`；命令 = `bash /opt/platform-core-data/platform-core/scripts/lemeng/run-retail-day.sh`

- [ ] **Step 3: 验收**

手动触发一次 job（`post_jobs_by_key_run`）→ exit 0 → 次日自动跑绿；OO 里 `retail-day` 流可查（_ops 行到达）。
Expected: job 历史 success ×2（手动+自动）；OO 查到 _ops 行。

- [ ] **Step 4: 提交 + S1 出口清单勾账**

```bash
git add scripts/lemeng/run-retail-day.sh
git commit -m "feat(jobs): 乐檬零售日采集 wrapper——窗口计算+24时窗循环+_ops (#150)"
```

对照 spec §11 S1 出口逐项勾：新湖落桶（Task 8a）/ 回读自证（8b）/ 幂等（8c）/ G2（Task 6）/ G1/G3/G4 销账（Task 1/2/5）——结果记入 PR 描述。

---

## 计划外事实（执行者必读）

- **代理**：本机 git 走 7897 间歇挂——push 失败先重试，再走 `ssh://git@ssh.github.com:443/`（本会话已验证可用）。
- **数据面已存在**：shanhai 全量站 2026-09-23 部署（含 etl），操作序列全在 `deploy/data-plane-deploy-sop.md`；**不要重新部署**，只在现有 project 上加 job/env。
- **凭据位置**：`LEMON_AGI_TOKEN_3120/64188`、`LEMENG_ZOS_*` 五键、`DUCKLE_TOKEN`——全部 openship 数据面 project env（isSecret），取法见 SOP P3；任何输出不回显值。
- **S2–S5 不在本计划**：域扩展/5min 调度/回填/语义 BI 各自成计划，依赖本计划销掉的 G1–G4 结论。
