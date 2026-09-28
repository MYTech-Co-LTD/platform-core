# P1/P2 生产侧最小实验报告：OO 投递通路 + WeCom 告警通路

> 任务 `task_1abaf4cd449a` · worktree `p1p2-probe` · 执行日 **2026-09-28** ·
> 依据 `docs/superpowers/specs/2026-09-28-duckle-l1-wave1-prep.md` §6.2 P1/P2
> 行为基准（**未改**）：`scripts/lemeng/run-retail-day.sh` 的 `ops_emit*` / `ops_ship` / `notify_fail` 段
> 引擎版本：**duckle 0.7.4**（console 容器内 `/usr/local/bin/duckle`，与 `deploy/duckle/Dockerfile` 钉死版本一致）

---

## 0. 结论摘要（先看这段）

| 面 | 能否随 L1 同时切 | 一句话 |
|---|---|---|
| **观测面**（`_ops` 行 → OpenObserve） | ✅ **能切** | 父管线里的 `snk.webhook` 可**逐字等价**复刻薄投递（URL/Authorization 走 `${ENV:}`，body 形 `[{…}]` 与薄壳相同）；已实测入 OO 专属测试流 |
| **告警面**（失败 → 企微机器人） | 🟡 **部分能切** | `ctl.try` 机制与发信通路**都实测通过**（消息已发出 1 条）；但**兜底子管线读不到 `${ENV:}`** ⇒ 企微 URL 只能走 workspace context（**密钥明文落 console workspace**）或保留薄投递 |

**三个必须由人拍板的缺口**（详见 §5）：

1. **子管线 `ENV:` 不通**（实测复现，根因是**单点**：`run_subpipeline_as` 只跑 context 替换，不跑 `apply_env_pass`）——涉及**全部**子管线路径（`ctl.try` 兜底 / `ctl.foreach` / `ctl.runjob` / `ctl.iterate` / batch items），正是 spec §6.1 **D1**。
2. **兜底子管线拿不到父 run 的上下文**（退出码 / 账套 / 模式 / 窗号）——`ctl.try` 只认 `fallbackPipelineRef` 一个属性，没有 contextVariables 通道。⇒ 现 `notify_fail` 文案里的 `账套=/模式=/退出码=` **在 L1 兜底里表达不出来**。
3. **「观测通道故障不影响采集判定」这条薄壳契约，L1 里没有原生等价物**。薄壳 `ops_ship` **任何情况下返回 0**（观测坏了采集照绿）；L1 里观测 sink 失败 = stage 失败 = **run 判红**。`continueOnFailure` 也救不了（源码注释明写「the run still ends failed」，与 §7.2 C 系实测一致）。

> 口径说明：本报告区分「**本次实测**」与「**读源码/引既有结论**」，后者逐处标注。

---

## 1. P1：`snk.webhook` → OpenObserve `_json` 投递通路

### 1.1 环境与做法

- **执行位置**：`platform-core-shanhai-data` 项目的 **`lemeng-console-3120` 容器**（openship MCP `.../services/{svc_srQwfTvdkjxbCeoA}/exec`）。选它是因为 OO/企微凭据就在该 **project env**（见 1.2）。
- **工作区**：容器内 `/tmp/duckle-probe/ws-*`（可写层，**非**卷）⇒ 生产卷 `/workspace` 零写入（末尾已复核，见 §1.5）。
- **专属测试流**：`duckle_l1_probe`（**新建**；`data_alerts` 与任何 `_ops`/`retail-day` 流**未触碰**）。

### 1.2 凭据面（**只记键名与用法，不回显值**）

在 console 容器内 `printenv`（**只取键名**）确认以下键存在：

| 键 | 用法 | 值形态（**只报布尔判定**） |
|---|---|---|
| `OO_BASE` | URL 前缀 | 非空，len=27 |
| `OO_ORG` | URL 路径段 | 非空，len=27 |
| `OO_AUTH` | `Authorization: Basic <该值>` | **预编码 base64**（值本身不含 `:`，`base64 -d` 后含 `:`）⇒ **不可再喂 `authType: "basic"`，会二次编码** |
| `WECOM_WEBHOOK_URL` | 企微机器人 webhook | 非空，len=89 |
| `SYSTEM_BOOK` / `DUCKLE_TOKEN` / `ZOS_*` | 采集侧 | 均在 |

**投递等价式（与薄壳 `ops_ship` 逐项对齐）**：

| 薄壳 | L1 节点 |
|---|---|
| `POST $OO_BASE/api/$OO_ORG/$STREAM/_json` | `url` |
| `-H "Authorization: Basic $OO_AUTH"` | `headers.Authorization` |
| `-H 'Content-Type: application/json'` | `headers.Content-Type` |
| `-d "[$1]"`（**单行包成数组**） | `batchMode: "array"`（1 行 ⇒ 一个 `[{…}]`） |

### 1.3 实测回执（两次，覆盖两种 body 形）

**P1a — `batchMode: "array"`（与薄壳同形）**

```
run id   : run-manual-duckle_l1_probe_p1a-1790577730936
status   : ok   duration : 293 ms
  s1                   ok (3 rows)
  w1                   ok (3 rows) - sent 1 batch (3 rows) to https://observe.hookflow.cn/api/<org>/duckle_l1_probe/_json
```

**P1b — `snk.webhook` 默认形（`bodyShape` 缺省 = `row`，每行一个裸 JSON 对象、N 次请求）**

```
run id   : run-manual-duckle_l1_probe_p1b-1790577741273
status   : ok   duration : 295 ms
  s1                   ok (3 rows)
  w1                   ok (3 rows) - sent 3 rows to https://observe.hookflow.cn/api/<org>/duckle_l1_probe/_json
```

> **两种都成功**（HTTP 2xx；`snk.webhook` 对非 2xx 抛错，见 §4 源码锚）⇒ OO 的 `_json` **同时接受 JSON 数组与裸对象**。

### 1.4 OO 侧证据（查询结果，截图式文本）

OO 流清单（`StreamList keyword=duckle`）：

```
{"total":3,"items":[{"name":"duckle_l1_probe","stream_type":"logs","stats":{"storage_size":0}},
                    {"name":"openship_scaffold_fullstack_duckle",...},
                    {"name":"openship_woke_duckle",...}]}
```

`SELECT _timestamp, probe, mode, seq FROM "duckle_l1_probe" ORDER BY mode, seq`：

```
+---------------------+-----------------+-------+-----+
| _timestamp (µs)     | probe           | mode  | seq |
+---------------------+-----------------+-------+-----+
| 1790577731224028    | duckle-l1-probe | array |  1  |   ← P1a 单批 3 行，同一次请求
| 1790577731224033    | duckle-l1-probe | array |  2  |
| 1790577731224035    | duckle-l1-probe | array |  3  |
| 1790577741559541    | duckle-l1-probe | row   |  1  |   ← P1b 三次独立请求
| 1790577741563983    | duckle-l1-probe | row   |  2  |
| 1790577741568289    | duckle-l1-probe | row   |  3  |
+---------------------+-----------------+-------+-----+
total = 6
```

- `array` 组三行时间戳相差 **7 µs** ⇒ 确系**同一个请求**（薄壳 `[$1]` 同形）。
- `row` 组三行相差 **~42 ms / ~4 ms** ⇒ 三个独立请求。
- 摄取时刻 `1790577731.2` / `1790577741.6`（≈ UTC `06:42:11` / `06:42:21`）与两次 run 的 `EXIT`/输出时刻吻合。

### 1.5 零生产写入复核

```
$ grep -rls 'duckle_l1_probe' /workspace      # → 空
$ ls /workspace                                # 只有 console 自己的 alerts.json / owners.json /
                                               #   pipelines/ / runs/ / schedules.json / logs/ / .duckle/
```
`/workspace` 下**无任何**探针文件；本次全部产物在 `/tmp/duckle-probe/`（容器可写层）。

### 1.6 ✅ 可直接进仓的节点写法（观测面）

**推荐形（与薄壳等价，进父管线）** —— 与 §7.2 的「`su` 汇总表 → `snk.webhook` POST OO」一致：

```json
{
  "id": "obs",
  "type": "sink",
  "position": { "x": 0, "y": 0 },
  "data": {
    "label": "OO _ops 投递",
    "componentId": "snk.webhook",
    "properties": {
      "url": "${ENV:OO_BASE}/api/${ENV:OO_ORG}/zzz_ops/_json",
      "method": "POST",
      "headers": {
        "Authorization": "Basic ${ENV:OO_AUTH}",
        "Content-Type": "application/json"
      },
      "batchMode": "array",
      "bodyType": "json"
    }
  }
}
```

- `batchMode: "array"` **必须显式写**：`snk.webhook` 的默认 `bodyShape` 是 `row`（每行一个裸对象、N 次请求）；只有显式 `array` 才与薄壳的 `[$1]` 同形。
  （若上游行**恒为 1 行**——`_ops` 每窗一行 / `dim` 每次一行——两种形都通，但 `array` 是逐字等价的那一种。）
- **字段名不用改**：行里的 `ts/job/system_book/snapshot/face/rows/status` 原样发出，与 `ops_emit_dim` 的 JSON 逐字段一致；`snk.webhook` 是「row = 上行对象的 JSON 序列化」，不做列改名。
- `${ENV:…}` 在 **url 与 headers 里都生效**（实测；源码 `apply_env_pass` 对节点 properties 做**深度**替换）——**前提：这条管线是父管线**，见 §5.1。
- 备选：`snk.rest`（默认 `bodyShape` 就是 `batch`，可省 `batchMode`）——两者在 `mod.rs:2212` 是**同一个分支**，行为一致；选哪个只影响可读性。

**判定：不需要「保留薄投递」。** 观测面可以原生切。

---

## 2. P2：`ctl.try` → 兜底子管线 → 企微告警

### 2.1 受控失败源

容器内起一个**永远 500** 的本地 mock（`/tmp/duckle-probe/mock500.py`，`127.0.0.1:18999`），
`src.rest` 打它 ⇒ stage error ⇒ 触发 `ctl.try` 兜底。**全程未碰真网关/真桶/真调度。**

### 2.2 机制验证（先证「兜底真的会跑」，**不涉外发**）

用**写本地 CSV 的兜底**替代企微兜底：

```
run id   : run-manual-duckle_l1_probe_p2a-1790577781814
status   : error
error    : mock 源 500: query: REST HTTP 500 from http://127.0.0.1:18999/mock-500: {"msg":"mock gateway 500 (L1 probe)"}
  g1                   error
  t1                   ok (0 rows)
fallback-ran.csv → MARKER PRESENT:  ev,at / fallback-fired,2026-09-28
```

**三件事一次证完**：
1. **`ctl.try` 装兜底 + 兜底真跑**（marker 文件落地）；
2. **原错照样传播**（run `status: error`）——「侧路副作用」语义，符合 §7.2 第 12 行；
3. **`ctl.try` 可放管线头，且能用一条 `trigger` 边定序到一个 `src.rest`** ——
   即「装配点放管线头」在**源节点之前**成立。关键：`compile` 用**全部**边做拓扑排序
   （`mod.rs:969` `order_edges`；源码注释原文「A trigger orders and does not wire」），
   所以边写 `"data": {"connectionType": "trigger"}` 即「只定序不接线」，不会被
   `src.rest` 的无输入端口判错。

### 2.3 ⛔ 负对照：兜底子管线**读不到** `${ENV:}`（本次最重要的发现）

把兜底的 sink 换成 `snk.webhook`，url 写 `${ENV:OO_BASE}/api/${ENV:OO_ORG}/duckle_l1_probe/_json`
（**父管线里刚被验证可用的同一个写法**）：

```
run id   : run-manual-duckle_l1_probe_p2_envprobe-1790577814312
status   : error
error    : mock 源 500: ... (and fallback '/tmp/duckle-probe/fallback-envprobe.json' also failed:
           query: OO _json from sub-pipeline: query:
           HTTP transport error to ${ENV:OO_BASE}/api/${ENV:OO_ORG}/duckle_l1_probe/_json:
           Bad URL: failed to parse URL: RelativeUrlWithoutBase: relative URL without a base)
```

**`${ENV:…}` 原样进了 URL**。根因（源码锚，0.7.4 `b62e8ce`）：

- `apply_env_pass`（`crates/duckle-runner/src/main.rs:843`）只对**顶层 doc** 生效；
- 所有子管线都走 `run_subpipeline_as`（`crates/duckdb-engine/src/connectors.rs:16885`），
  它只调 `substitute_into_child(&content, &merged)` —— **context 变量替换**，
  **不调 `apply_env_pass`**；
- 该函数自己的注释点名了覆盖范围：**「Every child path (runjob, iterate, foreach, batch items, install fallback) comes through this function」**
  ⇒ 这是**单点**缺口，不是 `ctl.try` 独有；`ctl.foreach` 的子管线同理。

> 与 #295「子管线 ENV 不通=阻塞项」一致，**本实验把它精确到单点、并证明它同样打 `ctl.try` 兜底**。

### 2.4 ✅ 正对照：兜底子管线**读得到 workspace context 变量**

给探测工作区写 `<ws>/.duckle/settings.json = {"context_file":"probe.env"}` + `<ws>/probe.env`（仅放
**非敏感**的 mock URL），兜底 url 写 `${PROBE_URL}`：

```
run id   : run-manual-duckle_l1_probe_p2_ctxprobe-1790577906918
error    : mock 源 500: ... (and fallback '.../fallback-ctxprobe.json' also failed:
           query: ctx placeholder url: query: HTTP 500 from http://127.0.0.1:18999/mock-500: ...)
```

`${PROBE_URL}` **被替换成了真 URL**（否则会是 `RelativeUrlWithoutBase` 而非 HTTP 500）
⇒ **子管线唯一的可用注入面是 workspace context**（`substitute_into_child` 里
`workspace_context_vars()` → `<ws>/repository.json` 的 `type:"context"` + `<ws>/contexts/*.json`，
或 `.duckle/settings.json` 的 `context_file`）。

### 2.5 🟩 企微真发（**全流程仅此 1 条**）

**纪律执行**：先 `duckle validate` 门（两个文件 5 项检查全 `"ok": true`）→ 再确认 mock 存活 → 才发。
**未出现「配错了重试」的多发**。

**发送路径**：`ctl.try`（管线头）→ mock 源 500 → 兜底子管线 `src.csv → snk.webhook(POST ${WECOM_URL})`。
`${WECOM_URL}` 由 §2.4 的 context 机制注入；企微 URL **从容器 env 转写进探测工作区的 context 文件**
（`chmod 600`，**全程未回显**），发完**立即删除**该文件。

**机器侧证据**：

```
send start : 2026-09-28T06:45:40Z   (UTC)
send end   : 2026-09-28T06:45:41Z   (UTC)
run id     : run-manual-duckle_l1_probe_p2_wecom-1790577940677

# 兜底子管线 runtime.log（企微 URL 不出现在日志里）：
{"event":"run_started",...,"ts":"2026-09-28T06:45:40.873Z"}
{"event":"stage_started","node_id":"fs","label":"告警文案行","component":"src.csv","ts":"...40.874Z"}
{"event":"stage_finished","node_id":"fs","status":"ok","rows":1,"duration_ms":81,"ts":"...41.036Z"}
{"event":"stage_started","node_id":"fw","label":"企微机器人","kind":"sink","component":"snk.webhook","ts":"...41.036Z"}
{"event":"stage_finished","node_id":"fw","kind":"sink","status":"ok","rows":1,"duration_ms":357,"error":null,"ts":"...41.393Z"}
{"event":"run_finished","status":"ok","duration_ms":519,"ts":"...41.393Z"}

# 父管线：
{"event":"stage_finished","node_id":"g1","status":"error","error":"query: REST HTTP 500 from http://127.0.0.1:18999/mock-500 ..."}
{"event":"run_finished","status":"error"}
```

**父 run 的 error 串里只有原始 500 错、没有 `(and fallback … also failed)` 后缀** ——
按 `lib.rs:3044-3058` 的逻辑，这**证明兜底返回了 Ok**，即企微 POST 拿到 HTTP 2xx
（`connectors.rs:409-419`：非 2xx 一律 `Err(EngineError::Query)`）。**发送时刻 2026-09-28T06:45:41Z（UTC）**。

**⚠️ 诚实的边界**：企微对**业务级拒收**（key 失效等）仍回 **HTTP 200 + `{"errcode":…}`**，
而 `snk.webhook` **丢弃响应体** ⇒ **机器侧只能证明「POST 发出且 HTTP 2xx」，不能证明「群里有这条消息」**。
这与 `deploy/duckle/console/README.md` 记的既有开环（「末跳群侧两条消息为目视确认开环」，issue #210）同源。
**请群里的人目视确认这 1 条**。
（本任务已在收尾时向协调者 `ask` 一次确认，截止报告定稿**未收到回复**；该确认是本次唯一未闭环项，
**不会再发第二条消息**。）

**消息原文**（`bodyTemplate` 渲染后的逐字内容；`${…}` 已代入 CSV 行值）：

```
[测试] L1 告警通路验证 2026-09-28
【乐檬采集失败】账套=3120 模式=mock-源-500(HTTP 500) 退出码=1 主机=lemeng-console-3120 2026-09-28T06:45:40Z
（本条为 L1 ctl.try 兜底子管线 snk.webhook→企微 的通路验证；任务 task_1abaf4cd449a / worktree p1p2-probe；群友请忽略）
```

### 2.6 ✅ 可直接进仓的节点写法（告警面）

**父管线侧（装配点放头）**：

```json
{ "id": "t1", "type": "transform", "position": { "x": 0, "y": 0 },
  "data": { "label": "ctl.try 兜底", "componentId": "ctl.try",
            "properties": { "fallbackPipelineRef": "alert.lemeng.wecom.json" } } }
```

边（**`trigger` 形：只定序不接线**，用来把它排到源节点之前）：

```json
{ "id": "e_t1_g1", "source": "t1", "target": "g1",
  "sourceHandle": "main", "targetHandle": "main",
  "data": { "connectionType": "trigger" } }
```

> ⚠️ `fallbackPipelineRef` 在 `mod.rs:3974-3990` 是**唯一**被读的属性（另有别名 `fallbackPath`）；
> `contextVariables` / 退出码 / 模式 **一概没有通道**（见 §5.2）。工作区内的相对名会被
> `resolve_subpipeline_ref` 解析（先试裸名 / 带扩展名 / `pipelines/` 下）。

**兜底子管线侧（企微 sink）**：

```json
{
  "id": "fw",
  "type": "sink",
  "position": { "x": 260, "y": 0 },
  "data": {
    "label": "企微机器人",
    "componentId": "snk.webhook",
    "properties": {
      "url": "${WECOM_URL}",
      "method": "POST",
      "headers": { "Content-Type": "application/json" },
      "bodyType": "text",
      "bodyTemplate": "{\"msgtype\":\"text\",\"text\":{\"content\":\"【乐檬采集失败】账套=${book} 模式=${face} 退出码=${rc} 主机=${hostx} ${at_utc}\"}}"
    }
  }
}
```

**三处要点（都是实测得来的，不是抄的）**：

1. **`url` 里不能写 `${ENV:WECOM_WEBHOOK_URL}`**（子管线不替换 ⇒ 必然 `Bad URL`）。
   必须用 **workspace context 变量**（`${WECOM_URL}`，值由部署侧写进 console workspace），
   或退回薄投递。**这是 D1 的取舍，需人拍板**。
2. **`bodyType: "text"` + `bodyTemplate` 是企微唯一可行形**：`snk.webhook` 的默认 body 是
   「上行行的 JSON」，拼不出企微要的 `{"msgtype":"text","text":{"content":…}}` 嵌套信封；
   `text` 形把模板渲染后**原样**当 body 发（`connectors.rs:511-521`），
   并且 **用户声明的 `Content-Type` 头优先于默认 `text/plain`**（`connectors.rs:400-409`）
   ⇒ 头里写 `application/json` 即可。模板里 `${列名}` 由行值代入。
3. 换行写 JSON 转义 `\n`（两个字符），企微会渲染成换行——**不要**指望 CSV 里的真换行。

### 2.7 文案模板建议（与现 `notify_fail` 风格对齐）

现薄壳（`run-retail-day.sh:438`）：

```
【乐檬采集失败】账套=${SYSTEM_BOOK:-?} 模式=${DIM_FACE:-${1:-?}} 退出码=$1 主机=$(hostname) $(date -u +%FT%TZ)
```

**建议的 L1 模板**（保持同一「一行式、字段名一致」风格）：

```
【乐檬采集失败】账套=${book} 模式=${face} 退出码=${rc} 主机=${hostx} ${at_utc}
```

供给行（兜底子管线里的 `src.csv`，或改用 `code.sql` 现算，见下）**列名即占位名**：

| 列 | 来源 | 备注 |
|---|---|---|
| `book` | 部署侧常量 | 可与 `${ENV:SYSTEM_BOOK}` 同源；**子管线读不到 ENV** ⇒ 目前只能写行值或 context |
| `face` | 模式/面 | 同上；现薄壳的 `模式=` 是动态的 ⇒ 见 §5.2 缺口 |
| `rc` | 退出码 | **兜底拿不到父 run 退出码** ⇒ 见 §5.2 缺口 |
| `hostx` | 主机 | 可用 `src.inline` 常量（容器 hostname 稳定） |
| `at_utc` | 时刻 | **别写死**：用 `code.sql` 的 `strftime(now(), '%Y-%m-%dT%H:%M:%SZ')` 现算 |

**两个已知改进方向（均**未实测**，标待沉淀）**：

- 把「现算时刻/账套」的 `src.csv` 换成 `src.csv → code.sql`：`SELECT …, strftime(now(),'%Y-%m-%dT%H:%M:%SZ') AS at_utc FROM input`。
  （§7.2 记 `code.sql` 里 `${ENV:…}` 替换有效 —— **但那是父管线**；在子管线里同样的坑适用，别指望。）
- 想让文案带上**退出码/窗号**：唯一原生思路是兜底子管线去**读父 run 的回执**
  （`<ws>/runs/receipts/<run_id>.json`，路径可由 `${workspace}` 内建 context 变量拼）。
  需用 `src.filelist` + glob 取最新一份 ⇒ **表达得出但绕**，且 run 名/目录布局一变就断。

**格式建议**：首行加 `[测试]` 或 `[演练]` 前缀门（本次即用此形），把演练消息与真告警在群里一眼分开——
这正是现薄壳 `LEMENG_NOTIFY=1` 门的 L1 对应物；L1 里没有等价门（`ctl.try` 装了就跑），
**演练必须靠换 fallback 文件或换工作区**来实现，值得写进 SOP。

---

## 3. 附带发现：`src.inline` 在 0.7.4 **可用**（推翻仓库现有表述）

`docs/superpowers/plans/2026-09-25-lemeng-collection-s2-dims.md:407` 记「`src.inline` 不可用（穷举 14 种形状全部 0 行）／**别计划用 `src.inline`**」。**该结论应按下面订正**：

| 形状 | 结果 |
|---|---|
| `"columns": [{"name":"probe","value":"…"}]` + `rowCount: 3` | ❌ **0 行 + 单列 NULL**（正是 `SELECT NULL WHERE false`） |
| `"columns": {"probe": "duckle-l1-probe", "mode": "inline-obj"}` + `rowCount: 3` | ✅ **3 行，列名/值正确** |

```
run id : run-manual-duckle_l1_probe_inline2-1790578008760   status: ok
  i1 ok (3 rows)   k1 ok (3 rows)
inline-out2.csv:  probe,mode
                  duckle-l1-probe,inline-obj   ×3
```

**为什么当年全灭**：`kv_pairs`（`builders.rs:10373`）对数组只认 **`{key,value}`**，**不认 `{name,value}`**；
而 `build_inline_source` 的 doc comment 恰好写着 *「`columns` is a list of {name, value}」*（`builders.rs:9229`）——
**注释与实现不一致**，照着注释试 14 次都会落到空列表。对象形（`{"列名":"值"}`）同样受支持。
⇒ 0.7.4 起 **`src.inline` 是造控制行/常量行的正解**，不必再用 `src.csv` 造 throwaway 文件。
（`rowCount` **重复同一行**，不能造「每行不同」的行；要不同得靠 `code.sql` + `range()`。）

---

## 4. 踩到的坑 / 方言清单增补（供 §7.2 销账与方言清单）

| # | 坑 | 事实与依据 | 影响 |
|---|---|---|---|
| 1 | **子管线 `${ENV:}` 不替换** | `run_subpipeline_as`（`connectors.rs:16885`）只做 context 替换；注释点名覆盖 runjob/iterate/foreach/batch/install fallback | 🔴 阻塞告警面独立切；D1 正主 |
| 2 | **`ctl.try` 无上下文通道** | `mod.rs:3974-3990` 只读 `fallbackPipelineRef`/`fallbackPath` | 🔴 兜底文案拿不到退出码/账套/模式 |
| 3 | **子管线唯一的注入面 = workspace context** | `substitute_into_child` 合并 `workspace_context_vars()`；实测 `${PROBE_URL}` 解出 | 🟡 可用，但密钥明文落 workspace |
| 4 | **`snk.webhook` 默认 `bodyShape` = `row`**（`snk.rest` = `batch`） | `mod.rs:2233-2257`；实测两形 OO 都收 | 🟡 要等价薄壳必须显式 `batchMode:"array"` |
| 5 | **`authType:"basic"` 会二次编码** | `push_rest_auth`（`builders.rs:10555`）对 `authToken` 做 base64；而 `OO_AUTH` **已是** base64 | 🟡 OO 必须走 `headers.Authorization` |
| 6 | **非 2xx 才判错，响应体被丢弃** | `connectors.rs:400-419` | 🟡 企微 `errcode` 假绿风险（既有开环） |
| 7 | **`trigger` 边可给源节点定序** | `mod.rs:960-970`：排序用全部边；「A trigger orders and does not wire」 | ✅ 让 `ctl.try` 能装在采集链**之前** |
| 8 | **`src.inline` 的 `columns` 是对象或 `{key,value}` 数组**（**不是** `{name,value}`） | `kv_pairs`（`builders.rs:10373`）vs 文档注释（`builders.rs:9229`）不一致 | 🟢 订正后可用 |
| 9 | **`snk.csv` `hasHeader` 已弃用 → `writeHeader`** | `duckle validate` 报 `deprecated_component_property`（`"fails": false`） | 🟢 不阻塞，别照抄老写法 |
| 10 | **duckle 镜像里没有 `pkill`** | 实测 `sh: 1: pkill: not found`（python:3.12-slim） | 🟢 起停临时进程要扫 `/proc`（**注意别把自己那条 `grep <名字>` 也匹配掉**——本次真踩到，自杀了自己的 exec shell） |
| 11 | **dash 的 `command -v a b c` 只解第一个** | `command -v duckle duckdb python3 curl` 只回 `duckle` ⇒ 会误判「镜像里没 duckdb」 | 🟢 逐个判 |
| 12 | **`src.inline` 失败是静默的** | 空 `columns` ⇒ `SELECT NULL WHERE false`：**0 行、单列 NULL、run 仍 `ok`** | 🔴 形状写错不报错，只会静默丢数据 |
| 13 | **`OPS_SINK=DISABLED` 式「观测不影响判定」在 L1 无对应物** | 薄壳 `ops_ship` 恒返 0（`run-retail-day.sh:281-320`，函数头注释逐字「**任何情况下都返回 0**」）；L1 里 sink 失败即 run 红；`lib.rs:3077-3084` 注释明写 `continueOnFailure` 后「the run still ends failed」 | 🔴 语义回归，需拍板 |

---

## 5. 缺口与待决（要人拍板的）

### 5.1 D1 落地建议（子管线密钥通路）

实测支持的事实：

- (a) **context 变量** —— **实测可用**（§2.4/§2.5）。代价：**密钥明文落 console workspace**
  （`<ws>/contexts/*.json` 或 settings 指的 `context_file`）。对企微这种「一条 webhook URL 即全部权限」的
  通知凭据，风险面是「能读 console 卷的人 = 能往告警群发消息」；比薄壳的 project env(isSecret) 差一档。
- (d) **上游修 `apply_env_pass` 作用于子文档** —— 真正的修法，且**是单点改动**
  （`run_subpipeline_as` 里 parse 之后补一次 env pass）。本实验把「单点」这一事实钉死了，
  可以直接回喂；**这是最干净的路，但排期不在我们手上**。
- 另注：**saved connection（`connectionRef`）在子管线里是被解析的**（`connectors.rs:16913-16923` 注释明写
  「a child using a saved connection failed for a field the connection provides… this is the one place」），
  但 connection 文件里的值同样是 workspace 里的明文（且 `${ENV:}` 存法在子管线仍不解析）
  ⇒ 相对 context 变量**没有额外收益**，未深试。

**我的建议**：**SOP 里先把 `ctl.try` 兜底限在「不需要新凭据」的场景**（如告警发到**已有** context 的通道），
同时把 (d) 作为回喂项开出去；在 (d) 落地前，**告警面「部分切」**——观测面先切，告警面留薄壳或走 context。

### 5.2 告警文案的动态字段（退出码/模式/窗号）

`ctl.try` 没有 contextVariables。可行但绕：兜底子管线读 `<ws>/runs/receipts/*.json`（父 run 的回执含
逐 stage status/error）。**未实测**，列作待沉淀。在这之前，L1 告警文案只能给「静态可确定」的字段。

### 5.3 「观测/告警故障是否应让采集 run 判红」

薄壳契约是 **不判红**（`ops_ship`/`notify_fail` 恒返 0）。L1 原生行为是 **判红**。
这**不是实现细节，是运维语义**：网关全挂时，观测面配错会不会把「本来能采」的 run 全变成红的？
需要有人拍；三选一：(i) 接受判红（观测面故障必须有人修，早暴露）；(ii) 观测节点挪出采集主链（另一个 run/子管线）；
(iii) 回喂上游要「软失败不改 run 状态」。

---

## 6. 本次实验的边界（没做什么）

- **未触真网关 / 真桶 / 生产卷 / 生产调度**（`/workspace` 已复核零写入，§1.5）。
- **未改任何仓内文件**（`run-retail-day.sh`、`duckle/`、compose 一律没动）；探针全部落在容器 `/tmp/duckle-probe/`。
- **只写了 1 条企微消息**，带 `[测试]` 前缀与任务号/worktree 名；发出后立即删除含 URL 的 context 文件。
- **未实测**：`code.sql` 在子管线里现算时刻；兜底读父回执；`continueOnFailure` 落在观测 sink 的真实行为
  （本条引 §7.2 C 系结论 + 源码注释，非本次实测）。
- **测试流 `duckle_l1_probe` 留了 6 行探针数据**（OO 里，不影响任何生产流）；如需清理，删流即可。

## 7. 复现入口

```sh
# 全部在 platform-core-shanhai-data 的 lemeng-console-3120 容器内（openship MCP exec）
cd /tmp/duckle-probe
duckle validate p1a-array.json p1b-row.json p2-marker.json p2-envprobe.json p2-ctxprobe.json p2-wecom.json --json
duckle --pipeline p1a-array.json --workspace /tmp/duckle-probe/ws-p1a --duckdb /usr/local/bin/duckdb --name duckle_l1_probe_p1a
python3 /tmp/duckle-probe/mock500.py &                 # 受控 500 源（注意：镜像无 pkill）
duckle --pipeline p2-marker.json --workspace /tmp/duckle-probe/ws-p2a --duckdb /usr/local/bin/duckdb --name duckle_l1_probe_p2a
```

管线 JSON 逐字稿见 §1.6 / §2.6（`p1a-array.json`、`p2-marker.json`、`fallback-wecom.json`、`p2-wecom.json`、`inline-probe2.json`）。
容器 `/tmp` 属可写层 ⇒ 下次部署会重建，**证据以本报告为准**。

---

**P1/P2 对照 §7.2 销账**：P1 从「待沉淀」→ ✅（节点写法给到，判定「不需保留薄投递」）；
P2 机制（`ctl.try` 兜底真跑、企微真发）→ ✅，但**密钥通路**（D1）与**上下文传递**两项仍是 ⏳，且**新增第 3 个缺口**（§5.3）。
