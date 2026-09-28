# D2 实验报告：L0 形态里的「身份门」能否原生化

> 2026-09-28 ｜ worker `task_6300397c2e6d` ｜ 计划 `docs/superpowers/plans/2026-09-28-wave1-branch-l0.md` Task 1
> 上游依据：`docs/superpowers/specs/2026-09-28-duckle-l1-wave1-prep.md` §4.2 差异 2
> 行为基准：`scripts/lemeng/run-retail-day.sh:341-420`（`identity` 子命令，**只读不改**）
>
> **零生产**：全部实验在本机 `/tmp/d2-lab/`（自写 mock 网关 + 隔离 duckle workspace + 自造假密钥 `LAB-TOKEN-*`）。
> 未碰生产 console、未碰湖、未动生产调度、未用真凭据、未上机裸敲。
> 对真网关**只有只读元数据调用**（匿名 OpenAPI 目录 + `openapi.json`，仅取计数与 schema，不取行数据）。

---

## 0. 一句话结论（先看三条）

1. **能，且今天就能原生化（候选 1）。** `src.rest` + `responseFormat:"xml"` + `rawResponseDestination` 能把 SSE 原样落盘且**不报错**，
   再用 3 个 `code.sql` 抠 `^data: ` → 断两条断言 → 2 个 `ctl.die`。
   实测与现 wrapper 的「先证后采 + 拒绝写湖」**逐条对齐**（身份不符 ⇒ **0 次 `branch.find` + 0 写湖**）。
2. **候选 2（换 JSON 身份端点）是更干净的解，但真网关的匿名目录里没有这样的端点**（19,758 次探测，0 命中）。
   用替身端点实测证明了「**若有则 1:1 原生**、且比候选 1 少 2 个节点、无需读文件」。
3. **候选 3（数据面自证）不够格当唯一闸。** 实测放行了一个真实错配：**凭据属于账套 8888、数据被写进 `system_book=3120` 分区**，
   唯一的触发条件是「两个账套的门店编号空间重叠」——它**不校验 `company_id`**，也不满足「先证后采」。
4. ⇒ **L0 不缺身份前闸。不建议接受「缺闸」**。建议：按**候选 1** 落地（含 4 条护栏），
   同时向网关侧提「JSON 身份能力」诉求，落地后迁到**候选 2**；**候选 3 只作纵深，不作唯一闸**。

---

## 1. 行为基准：现 wrapper 的身份门在挡什么

读 `scripts/lemeng/run-retail-day.sh:341-420`（`identity` 子命令）。它做**两件事**：

| # | 断言 | 方向 | 失败语义 |
|---|---|---|---|
| ① | `whoami.company_id == SYSTEM_BOOK` | 相等 | 凭据账套 ≠ 目标账套 ⇒ **防串账套** |
| ② | `配置门店(BRANCH_NUMS) ⊆ whoami.branch_nums(可见门店)` | **单向** | 配了一个本账套看不见的店 ⇒ 清单/账套错配 |

三条工程性质（后面逐条比对）：

- **先证后采**：身份未证时**一个采集请求都不发**（spec §5 的 S5 场景实测：访问日志只有 whoami 一条）。
- **两类失败分开**：**传输失败**（网络/HTTP 非 200）重试 3 次；**答了但答得不对**是确定性错配 ⇒ 立即判红、不重试。
- **②的方向不能反**：账套可见门店里**有多余是正常的**（99 是熊喵中央店，采集清单故意排除）。

### 1.1 没有这道闸，具体会出什么事故（代码注释原话摘录 + 归纳）

- **`system_book` 是采集侧按账套常量注入的**，管线里**列值与 sink 路径同源**于同一个 `ENV:SYSTEM_BOOK`
  ⇒ **标错账套不会自己暴露**：列值和分区路径会**一起错**，数据面看不出异常。
- **dim 面最危险**：快照是**全账套**的，账套错配**不像零售那样表现为「某店 0 行」，而是整张维表落进错的
  `system_book` 分区且行数正常**。这正是本次要迁的 `lemeng.dim.branch` 的形态。
- **零售面**：「这家店本来就没单」与「账套/凭据配错了」在数据面上**都是 0 行、长得一模一样**
  （spec §4.2 G4：64188 店 1/99 **七天窗均 0 单**）⇒ 不能拿「空不空」当信号。
- 多店合查只**降低误判概率**，**开跑前自证才能把二者从根上分开**。

> ⇒ 缺闸的实际后果不是「多花几次请求」，而是**静默污染湖分区**：数据看起来完全正常，消费方查的是错的账套。

---

## 2. 实验环境（可复现）

| 件 | 值 |
|---|---|
| duckle | **0.7.4**（`/private/tmp/duckle-lab-p1/.venv074/bin/duckle`，源码 `source-analysis/duckle-latest` @ `b62e8ce release: v0.7.4`） |
| DuckDB | **1.5.5**（同 venv） |
| mock 网关 | `lab/mock/mock_gateway.py`；**形状照真网关实测抄**：SSE 帧 `event: message\r\ndata: {…}\r\n\r\n`；`Accept: application/json` 单独给 ⇒ **406**（真网关行为） |
| mock 账号 | `LAB-TOKEN-3120`→company 3120/门店 1001–1020；`LAB-TOKEN-9999`→company 9999/7001–7010；`LAB-TOKEN-OVERLAP`→company **8888**/门店 **1001–1005**（编号空间重叠，用于暴露候选 3 盲点）；`WEIRD/TAG/OPEN`→载荷含 `<`、`&`、未闭合尖括号 |
| 隔离 workspace | `lab/ws/`（管线、raw、out 全在本机） |
| 跑法 | `cd /tmp/d2-lab && . ./env.sh && python3 evidence.py` |

---

## 3. 候选 1：`src.rest` + `rawResponseDestination`（**可行**）

### 3.1 关键机制（三条，都是实测不是推断）

**M1 — 原始体在 parse 之前落盘。** 源码 `crates/duckdb-engine/src/connectors.rs:16156-16168` 的注释明写
「persist the original body before parsing」，实测确认：SSE 体被写进文件（493 B）**同时** JSON 解析失败、节点报错。

但**只有这个还不够** —— 节点报错会把整条 run 拉红：

```
[M-] e1a  响应格式 json + raw 落盘：raw 文件已写（493 B），但 status=error / rc=1
[M-] e1c  …再加 continueOnFailure:true：下游 g0 仍 error，status=error / rc=1   ← 此路不通
```

`continueOnFailure` 这条路**不成立**：软 stage 只让「后面的 stage 继续跑」，**run 本身仍然判红**
⇒ 身份正确的那一天也会天天红。**排除**。

**M2 — `responseFormat:"xml"` 是那把钥匙。** 同一个 SSE 体，改 `responseFormat` 为 `xml` 后：
节点**报 0 行、状态 ok、rc=0**，且**原始体照写不误**。原因：XML 走 `walk_xml_to_rows`（`util.rs:496`），
quick-xml 把一个没有标签结构的文本流读成 Text 事件直到 EOF，**不报错**，行集为空。

```
[M+] e1b  响应格式 xml + raw 落盘：status=ok / rc=0 / w0 ok (0 rows)，raw 文件 493 B
```

⇒ 于是「**原始体被留下**」与「**节点不失败**」同时成立。这是候选 1 成立的全部机理。

**M3 — 闸前的定序用 trigger 边（`connectionType:"on-subjob-ok"`），不用数据边。**
duckle 的 trigger 边语义是「after this，**只定序不接线**」（源码 `plan/mod.rs:961-966` + 测试
`a_trigger_edge_orders_a_stage_without_wiring_it`）。用它把 `ctl.die` 连到 5 个分页 source 上，
既保证**先证后采**，又不给 source 平白接一个上游。

### 3.2 判定表（每条 = 一次真实 run）

| 场景 | rc | status | `branch.find` 次数 | 落湖行数 | 结论 |
|---|---|---|---|---|---|
| 身份相符（token 3120 / book 3120） | 0 | ok | 5 | 20 | ✅ 正常采集 |
| **凭据账套错配**（token 9999 / book 3120） | 1 | error | **0** | **–** | ✅ 与 wrapper 一致 |
| **网关形状漂移**（200 + 无 `data:` 行的 body） | 1 | error | **0** | **–** | ✅ fail-closed |
| 载荷含 `<`、`>`、`&` | 0 | ok | 5 | 20 | ✅ 不影响 |
| 载荷含良构标签 `<A>门店</A>` | 0 | ok | 5 | 20 | ✅ 不影响 |
| 原件路径带 `${ENV:BATCH_ID}` | 0 | ok | 5 | 20 | ✅ 落盘为 `whoami-run-abc123.sse`（§3.5 并发处置已验证） |
| **载荷含未闭合尖括号** `门店<A` | 1 | error | **0** | **–** | ⚠️ **假红**（见 §3.5） |
| **期望值缺参**（`BRANCH_NUMS` 未注入） | **0** | **ok** | 5 | **20** | ❌ **静默放行**（见 §3.4） |
| 网关不可达（mock 停掉） | 1 | error | 0 | – | ✅ fail-closed |

第 2、3 行是**决定性的**：与 wrapper 的 S5 行为（「访问日志只有 whoami 一条、零 `branch.find`」）**完全一致**。

### 3.3 可直接抄的节点写法

**闸本体（7 节点）**，`deploy/duckle/console/pipelines/lemeng.dim.branch.l0.json` 前面挂这一串：

```jsonc
// ① SSE 探针：xml 模式吞掉解析 + raw 原样落盘
{ "id":"w0", "type":"source",
  "data":{ "label":"whoami(xml+raw)", "componentId":"src.rest",
    "properties":{
      "url":"https://cloud.nhsoft.cn/agi/mcp", "method":"POST",
      "headers":{ "Authorization":"Bearer ${ENV:LEMENG_TOKEN}",   // L0 落地时改 connectionRef:"lemeng"
                  "Content-Type":"application/json",
                  "Accept":"application/json, text/event-stream" },   // ⚠️ 少一个就 406
      "body":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\",\"arguments\":{}}}",
      "paginationType":"none",
      "responseFormat":"xml",                                   // ← 钥匙（见 M2）
      "rawResponseDestination":"/workspace/.duckle-raw/whoami-${ENV:BATCH_ID}.sse",  // ← 见 §3.5-③④
      "retryAttempts":3, "retryBackoffMs":2000                  // ← 复刻 wrapper 的传输重试 3 次
    },
    "schema":[{"name":"x","type":"string"}]                     // ← 必填，见 §3.5-①
  }},

// ② 抠出所有 `data: ` 行
{ "id":"g0", "data":{ "componentId":"code.sql", "properties":{ "sql":
  "SELECT unnest(regexp_extract_all(content, '(?m)^data: ([^\\r\\n]*)', 1)) AS line FROM read_text('/workspace/.duckle-raw/whoami-${ENV:BATCH_ID}.sse')" }}},

// ③ 取最后一条 + 拆 JSON-RPC 外壳（wrapper 取的是 m[-1]，这里对齐）
{ "id":"g1", "data":{ "componentId":"code.sql", "properties":{ "sql":
  "SELECT json_extract_string(line, '$.result.content[0].text') AS txt FROM input QUALIFY row_number() OVER () = count(*) OVER ()" }}},

// ④ 取身份事实
{ "id":"g2", "data":{ "componentId":"code.sql", "properties":{ "sql":
  "SELECT json_extract_string(txt, '$.company_id') AS company_id, json_extract_string(txt, '$.branch_nums') AS branch_nums FROM input" }}},

// ⑤ 反向闸：形状漂移/抠不出身份 ⇒ 必须红（缺了它就静默放行）
{ "id":"d0", "type":"control", "data":{ "componentId":"ctl.die",
  "properties":{ "condition":"no-rows", "message":"identity: whoami 无可解析身份（网关形状变了？）⇒ 拒绝写湖" }}},

// ⑥ 两条断言的违规行
{ "id":"g3", "data":{ "componentId":"code.sql", "properties":{ "sql":
  "SELECT 'book' AS violation, company_id AS detail FROM input WHERE company_id IS DISTINCT FROM '${ENV:SYSTEM_BOOK}' \
   UNION ALL \
   SELECT 'branch' AS violation, CAST(c.branch_num AS VARCHAR) FROM (SELECT unnest('${ENV:BRANCH_NUMS}'::BIGINT[]) AS branch_num) c \
   LEFT JOIN (SELECT unnest(CAST(json_extract(branch_nums, '$[*]') AS BIGINT[])) AS branch_num FROM input) w USING (branch_num) \
   WHERE w.branch_num IS NULL" }}},

// ⑦ 有违规行 ⇒ 红
{ "id":"d1", "type":"control", "data":{ "componentId":"ctl.die",
  "properties":{ "condition":"has-rows", "message":"identity: 凭据账套/门店清单自证未过 ⇒ 拒绝采集与写湖" }}}
```

**接线（关键是最后 5 条 trigger 边）**：

```
w0 → g0 → g1 → g2 → d0 → g3 → d1
d1 --trigger--> p1, p2, p3, p4, p5      ← 「after this，只定序不接线」= 先证后采
p1..p5 → ctl.merge(main_1..main_5) → shape(code.sql) → qa.contract → snk.minio
```

> `merge` 的 `targetHandle` 必须是 `main_1..main_5`（`ctl.merge` 有 5 个编号输入口），不是全 `main`。

### 3.4 必须一起带的 4 条护栏（少一条就有静默失效）

| # | 护栏 | 证据 | 不带的后果 |
|---|---|---|---|
| ① | `w0` 必须声明 `data.schema` | 去掉后实测：`w0: query returned 0 records and no schema is declared to type an empty result` ⇒ rc=1 | 每次身份门**必炸**（探针恒 0 行） |
| ② | 必须有「抠不出身份 ⇒ 红」的**反向闸** `d0(no-rows)` | 网关形状漂移场景实测：无 `d0` 时 0 行一路走到底、**静默放行**；加了 `d0` ⇒ rc=1 | 网关换形状 = 闸**静默失效** |
| ③ | `BRANCH_NUMS` 这类**期望值缺参**不会自己报错 | **实测**：`BRANCH_NUMS` 未注入时 duckle 只在 stderr 打一行 `is unresolved` 警告，run 仍 **rc=0 / status ok / 写湖 20 行** | 期望值没注入 ⇒ ②号断言**静默失效**，闸只剩一半 |
| ④ | 传输失败要显式重试 | 实测 `retryAttempts:3 + retryBackoffMs:1000` 生效（elapsed≈3s）；不带则第一次抖动就判红 | 把一天的采集断在一次网络抖动上（与 wrapper 的「重试 3 次」不等价） |

> **③ 是最值得上游修的一条**：`${ENV:X}` 解析不到时 duckle **只警告不报错**（源码 `duckle-runner/src/main.rs:874-878`
> 保留原占位符文本）。而占位符文本进 SQL 后**大多数时候会炸**（实测：`'${ENV:...}'::BIGINT[]` ⇒ 转换错误，rc=1），
> **但在这个闸里它没炸**（`g3` 报 `rows:null`/`status:ok`，run 绿）——
> 也就是「**闸的失效模式恰好是静默放行**」，正是这仓反复吃的亏。

### 3.5 候选 1 的已知弱点（诚实清单）

| 弱点 | 实测表现 | 性质 | 处置 |
|---|---|---|---|
| **未闭合 `<` 会假红** | 载荷含 `门店<A` ⇒ `xml: parse: syntax error: tag not closed` ⇒ rc=1、零采集 | **fail-closed 的假报警**（安全方向对，可用性方向错：身份明明是对的，当天采集被拒） | 无内解。已在 §7 建议里标为「上游诉求 2」 |
| **本地明文 PII 落盘** | raw 文件含 `name`/`phone` 等操作员身份字段 | 隐私面 | 路径**绝不许写 `s3://`**（会把明文 PII 落进对象存储）；落在容器临时区、随容器回收 |
| **相对路径按进程 CWD 解析** | 实测 `rawResponseDestination:"d2-rel-whoami.sse"` 落在**进程 CWD**、不在 `--workspace` 下 | 可移植性 | 一律写**绝对路径**（如 `/workspace/.duckle-raw/…`） |
| **借来的开关** | 用 `responseFormat:"xml"` 表达「别解析，只留原件」，语义不诚实 | 可维护性 | 上游诉求 1（见 §7） |
| **同容器并发会撞 raw 路径** | 固定路径下两个 run 会互相覆盖探针文件 | 并发面 | 路径里带 `${ENV:BATCH_ID}`（例见 §3.3 ①） |

---

## 4. 候选 2：换一个返回 JSON 的身份端点

### 4.1 真网关目录普查结果：**没有**

匿名目录 `https://agi.lemengcloud.com/ability/<code>/openapi.json`（无需鉴权）**可批量拉**，本轮共探测：

| 轮次 | 动作词 | 模块 × 实体 | 探测数 | 命中 |
|---|---|---|---|---|
| probe1 | `find` | 29 × 42 | 1,218 | 1（`branch.find`，已知） |
| probe2 | `info,get,current,list,detail,me` | 20 × 37 | 4,440 | 0 |
| probe3 | 12 个动作词 | 25 × 47 | 14,100 | 1（`branch.find`） |
| **合计** | | | **19,758 次探测**（跨轮有重复码，非 19,758 个不同码） | **仅 `nhsoft.user.ai.branch.find`** |

**这个 0 命中是有分量的**，不是「目录不全」：仓内已知的 3 个真能力
（`nhsoft.user.ai.branch.find` / `nhsoft.base.ai.item.find` / `nhsoft.retail.ai.pos.posorder.find`）
在同一个目录里**全部 200**。也就是说**目录确实在发布真能力**，而**公司/账套/用户维度的 JSON 身份能力不在其中**。

> 限制（诚实标注）：目录**只有**已发布 openapi 的能力；能力列表接口 `/backend-api/v1/agi/abilities` **需鉴权**（实测 401），
> 本任务无真凭据 ⇒ **无法穷举**。因此结论应表述为「**按开放目录与命名规律找不到**」，
> 而不是「**网关一定没有**」。要坐实需要一次带凭据的 `tools/list`（MCP）或问网关侧要能力清单。

### 4.2 若有，则是 1:1 原生（用替身端点实测通过）

用一个**替身** JSON 端点（mock `/agi/api/nhsoft.user.ai.company.find`，返回 `company_id` + `branch_nums`）搭同构闸：

| 场景 | rc | status | `branch.find` 次数 | 落湖行数 |
|---|---|---|---|---|
| 身份相符 | 0 | ok | 5 | 20 |
| **凭据账套错配** | 1 | error | **0** | **–** |

⇒ 行为与候选 1 **完全等价**，但：
- **13 个 stage vs 候选 1 的 15 个**（少 2 个）；
- **不读本地文件**（无 `read_text`、无 raw 落盘 ⇒ 无 PII 落盘面、无路径/并发问题）；
- **不借 XML 开关**（正常 `json` 模式 ⇒ 无「未闭合 `<` 假红」弱点）。

**⇒ 这是三案里唯一「无已知弱点」的解。价值 = 一个网关侧的能力。**

---

## 5. 候选 3：数据面自证（`branch.find` 门店集合比对）

做法：不调 whoami，把 `branch.find` 返回的门店集合与「预期集合」比对，不等就 `code.sql` 出 mismatch 行 + `ctl.die has-rows`。
**预期集合不需要硬编码 800 个店号** —— 直接用**已在注入的运行参数 `BRANCH_NUMS`**（非凭据），SQL 侧
`unnest('${ENV:BRANCH_NUMS}'::BIGINT[])`，**期望值就是请求参数本身**，维护成本为零。

### 5.1 判定表（每条 = 一次真实 run）

| 场景 | rc | status | `branch.find` 次数 | 落湖行数 | 结论 |
|---|---|---|---|---|---|
| 相符（token 3120 / 配置 1001–1020） | 0 | ok | 5 | 20 | ✅ |
| **错账套·编号空间不相交**（token 9999 / 配置 1001–1020） | 1 | error | **5** | **–** | ⚠️ 抓到了，但**已经采了 5 页** |
| **错账套·编号空间重叠**（token **8888** / 配置 1001–1005） | **0** | **ok** | 5 | **5** | ❌ **放行** |
| 配置含一个看不见的店（1001,1002,**5555**） | 1 | error | 5 | – | ✅ |

### 5.2 盲点实证（这是候选 3 的致命处）

第 3 行不是构造出来的边角案例，是**直接复现了这道闸本该拦的事故**：

```
凭据 = LAB-TOKEN-OVERLAP  →  whoami 会说 company_id = 8888, branch_nums = [1001..1005]
run 的 SYSTEM_BOOK       =  3120
结果                     :  gate 绿 (rc=0)，5 行数据写进 out/e3-branch.parquet
```

即：**数据来自账套 8888，被写进 `system_book=3120` 的分区**，而闸**一声不响**。
触发条件仅仅是「两个账套的门店编号空间有交集」——在真实多账套环境里这**不是罕见前提**
（同一集团下不同账套、编号规则相同或人工编号撞号都会造成）。

### 5.3 结论

候选 3 **不能**当唯一身份闸，原因三条：

1. **不校验 `company_id`**：它的语义只是「配置门店 ⊆ 可见门店」的子集关系检查，**根本没有账套维度的断言**（盲点 5.2 即为证）。
2. **不满足「先证后采」**：判定发生在采集**之后**（表里 5 次 `branch.find` 已成事实）。它保住的是「**不写湖**」，
   **不是**「不多采」。对账套错配的**大**任务（零售日批 1459 单/时那种量级），这是实打实的浪费。
3. **兜底方向反了**：它只证明「我要的店在这个凭据下存在」，**证不了「这个凭据就是我要的账套」**。

> ✅ 但它**便宜且无副作用**（0 额外请求、0 额外凭据、期望值免费），因此**值得作为纵深**保留 ——
> 作为**第二道**（能挡住编号不相交的错配、挡住清单写错店号），**绝不是第一道**。

---

## 6. 三案总判定

| | 候选 1（xml+raw） | 候选 2（JSON 端点） | 候选 3（数据面自证） |
|---|---|---|---|
| 今天能落地 | ✅ | ❌ 需网关侧新增能力 | ✅ |
| `company_id == SYSTEM_BOOK` | ✅ | ✅ | ❌ **完全没有** |
| 配置门店 ⊆ 可见门店 | ✅ | ✅ | ✅ |
| 先证后采（错配 ⇒ 0 采集） | ✅ **实测 0 次** | ✅ **实测 0 次** | ❌ 已采完才判 |
| 错配 ⇒ 不写湖 | ✅ | ✅ | ✅（编号相交时 ❌） |
| 网关形状漂移 ⇒ fail-closed | ✅（需加 `d0`） | ✅（需加 `d0`） | n/a |
| 已知假红风险 | ⚠️ 未闭合 `<` | 无 | 无 |
| 落盘 PII | ⚠️ 有（本地） | 无 | 无 |
| 节点数 | 15 | 13 | 10 |
| **结论** | **✅ 立即可落地的正解** | **✅ 目标形态（需上游）** | **⚠️ 只作纵深** |

---

## 7. 建议（给到能拍板的粒度）

**建议 A（立即，Wave 1 用）—— 按候选 1 落地，并带齐 §3.4 的四条护栏。**
理由：它是**今天唯一能实测复刻 wrapper 行为的解**，且已含「先证后采 + 拒绝写湖」。**不接受「L0 缺身份前闸」。**

**建议 B（并行，向网关/上游提两个诉求，落地后迁候选 2）——**

1. **网关侧：新增一个返回 JSON 的身份能力**（形如「公司/账套信息查询」，返回 `company_id` + 可见门店）。
   这是**成本最低、收益最大**的一条：它把身份门从「15 节点 + XML 借道 + 本地落盘」压到「13 节点 + 纯 JSON」，
   并**同时消掉未闭合 `<` 假红与 PII 落盘**两个弱点。**建议作为正式需求提给 Lemeng。**
2. **duckle 上游：给 `src.rest` 一个诚实的「只留原件不解析」开关**
   （如 `responseFormat:"raw"`/`"text"`，或直接支持 SSE 解帧）。
   现在靠 `responseFormat:"xml"` 借道，靠的是 quick-xml 对非 XML 文本的**宽容**——这份宽容没有契约保证，
   且**已经实测出反例**（未闭合 `<` ⇒ 假红）。
3. **duckle 上游（可选项，但价值高）：`${ENV:X}` 解析不到时应当硬失败，而不是打一行警告继续跑。**
   实测证据：期望值缺参时本闸**静默放行并写湖**（§3.4 ③）。对「用了占位符就意味着值必须存在」的场景，
   现在是 fail-open，方向是反的。

**建议 C（纵深，可同批做）—— 保留候选 3 作为第二道闸**（编号不相交的错配、清单填错店号都能挡），
**但明确定位为纵深**：它的绿**不构成**身份已证。

**建议 D（口径）——** 把「身份门是采集前闸」写成 **L0 的默认组成部分**，而不是 L1 专有。
现正典 §1.1.7 的 L0 行**完全没提身份门**，而 L1 图里挂了「身份门：探针 + 集合比对 + die」——
本实验证明**身份门在 L0 同样能原生承载**，没有理由把它留给 L1。

---

## 8. 正典 §1.1.7「身份门那一行」的建议改法

### 8.1 L0 档那一行（**新增**，本实验的直接产出）

现文（`docs/data-platform-handbook.md:386`）：

```
| **L0 直连**（默认） | **单窗/日频/无跨窗编排**的采集 | **一条管线 + 一条调度**，没有第二种文件 | **①现行可用**（既有先例：维度面 `lemeng.dim.*`） |
```

建议改为（**加粗为新增文字**）：

```
| **L0 直连**（默认） | **单窗/日频/无跨窗编排**的采集 | **一条管线 + 一条调度**，没有第二种文件。
**默认形态含身份门（第一段）：`src.rest`(whoami, `responseFormat:"xml"`) + `rawResponseDestination` 落原件
→ `code.sql` 抠 `^data: ` → 断①账套②门店子集 → `ctl.die`；闸后**用 trigger 边**（`connectionType:"on-subjob-ok"`）
定序到采集 source（先证后采）。**
**四条护栏缺一即静默失效**：① 探针节点必须声明 `data.schema`（0 行否则报错）；② 必须有「抠不出身份 ⇒ 红」
的反向闸（`ctl.die no-rows`，挡网关形状漂移）；③ 期望值缺参不会自己报错（`${ENV:X}` 未解析**只警告**）
⇒ 期望值要以**结构性方式**确保存在；④ 传输失败要显式 `retryAttempts`（对齐 wrapper 的 3 次重试）。
**已知弱点**：载荷含未闭合 `<` 会**假红**（fail-closed）；原件含 PII ⇒ **路径禁写 `s3://`**。
**目标形态**：网关提供 JSON 身份能力后，本段退化为 3 个节点（见 D2 报告 `/tmp/d2-lab/report-d2.md`）。 |
```

### 8.2 L1 图里那一行（**订正**，从「设想」改为「实测口径」）

现文（`:395`）：

```
     身份门：探针 + 集合比对 + die        ← 替代 wrapper 的凭据↔账套自证
```

建议改为：

```
     身份门：src.rest(whoami, responseFormat:"xml") + rawResponseDestination
             → code.sql 抠 `^data: ` → 断 ①company_id==SYSTEM_BOOK ②配置门店⊆可见门店
             → ctl.die(has-rows) ＋ 形状反闸 ctl.die(no-rows)
             ← 替代 wrapper 的凭据↔账套自证（**L0/L1 同形**；实测见 D2 报告）
             ⚠️ 真 whoami 是 SSE（src.rest 只认 JSON）⇒ 靠 xml 模式「只留原件不解析」借道；
                上游若给 JSON 身份能力或 raw 模式，本段可直接收缩
```

### 8.3 「配套决策」表建议加一行

| 场景 | 做法 |
|---|---|
| **身份门怎么建** | **默认带**（L0/L1 同形，见上）；**三条护栏必带**（schema / 反向闸 / 期望值存在性）；**不要**用数据面自证当唯一闸（实测有编号重叠盲点） |

---

## 9. 未决 / 未验 / 上游诉求

**未验（本轮没做，落地前要补）**

1. **真网关上的 `Accept` 行为**：本轮 mock 严格复刻了「`Accept: application/json` 单独给 ⇒ 406」，
   但**没有对真 whoami 端点跑过候选 1 的完整闸**（零生产约束）。落地前建议在 console 容器内用**只读**探针跑一次。
2. **`connectionRef` 承载凭据时本闸是否仍然成立**：本 lab 用 `${ENV:LAB_TOKEN}`。L0 落地要改 `connectionRef:"lemeng"`，
   ⚠️ 已知 duckle 有「**连接加载失败是静默的**（fail-open ⇒ 空凭据 ⇒ 静默 401）」的红线（正典 §1.1.7 原文），
   ⇒ 换 `connectionRef` 后**必须重跑本报告的判定表**，特别是「缺凭据 ⇒ 必须红」那一格。
3. **生产路径下 `/workspace/.duckle-raw/` 是否可写、是否随容器回收**（本轮只在 lab 验证了绝对路径可写）。
4. **`BRANCH_NUMS` 在生产是不是真的会注入**：本报告的③号护栏依赖它。若生产改用「不带 `branch_nums` 过滤的全量拉取」，
   则②号断言的期望值来源要重新设计。

**上游诉求（按建议 B）**

- Lemeng：新增返回 JSON 的公司/账套能力（**最优解**）。
- duckle：`src.rest` 支持 `responseFormat:"raw"/"text"`（或 SSE 解帧）。
- duckle：`${ENV:X}` 未解析 ⇒ 硬失败而非警告。

---

## 附录 A：证据文件（全在 `/tmp/d2-lab/`，**不入仓**）

| 文件 | 内容 |
|---|---|
| `evidence.py` / `evidence.txt` | §3.2 §4.2 §5.1 三张判定表的**可重跑源**（一条 run 一行） |
| `ws/pipelines/e1e-gate.json` | 候选 1 闸（含四条护栏）；`e1e-gate-plain.json` 形状漂移变体 |
| `ws/pipelines/e2-json-identity.json` | 候选 2（JSON 身份端点，替身） |
| `ws/pipelines/e3-data-selfproof.json` | 候选 3（数据面自证） |
| `ws/pipelines/e1a-raw-json.json` / `e1c-raw-soft-gate.json` | 被排除的两条路（raw 但解析失败 / `continueOnFailure`） |
| `mock/mock_gateway.py` | mock 网关（SSE 帧 / 406 / 分页 / 6 个账号含 OVERLAP 与畸形载荷） |
| `mockstate/requests.log` | 每次 run 的访问日志（「先证后采」的举证就是数它里面 `branch.find` 的条数） |
| `gate-nodes.json` | §3.3 节点写法的机读版 |
| `out/fin-*.txt` | 判定表每一行的完整 run 输出 |
| `probe1/2/3.log` | 真网关匿名目录普查记录（仅 hit 行；无行数据） |

## 附录 B：复现

```sh
cd /tmp/d2-lab
# mock 网关（真网关形状：SSE 帧 + 406）
python3 mock/mock_gateway.py 8867 &
. ./env.sh                      # 自造假密钥 LAB-TOKEN-*，无真凭据
python3 evidence.py             # 跑完 §3.2 §4.2 §5.1 全部判定表
python3 probe3.py 2>/dev/null   # 真网关匿名目录普查（只读，仅打 hit）
```

---

## 附录 C：本报告对「别默认接受缺闸」的回答

**不接受，也不需要接受。** 三条实测结论合起来是：

- **L0 完全可以不带 shell 地承载身份门**（候选 1，实测复刻 wrapper 行为）；
- **现有 wrapper 的行为基准是可达成的**，不是「只有 shell 能给的能力」；
- 唯一真正缺的是**网关侧一个 JSON 身份能力**（候选 2）——它能把方案从「可行但有已知弱点」抬到「干净且无已知弱点」，
  但这**是优化项，不是 L0 的前置条件**。

⇒ Wave 1 的 Task 3 **可以按候选 1 写进 L0 管线**，不必为身份门保留 shell，也不必把身份门降级到平台/诊断层。
