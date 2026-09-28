# D1 决策实测：L1 子管线的密钥通路（能否「只在最外层解析、绝不落数据面」）

> 2026-09-28 ｜ worker `task_c62e87f4cc40` ｜ 依据：`docs/superpowers/specs/2026-09-28-duckle-l1-wave1-prep.md` §4.2 差异 1、§6.1 D1
>
> **本报告全部活动**：本机 `/tmp/d1-lab/`（本地 workspace + 回环 mock 网关）+ 只读源码阅读。
> **零生产**：未碰湖、未碰生产卷、未改生产调度、未上机、未用真实生产密钥（自造假密钥 `LABSEC_2f9c1a7b4e6d8035`）。
>
> 结论一句话：**D1 有免落盘解**，且它不是四个选项里的任何一个 —— 是引擎原生的第五个通路
> **`ctl.runjob.contextVariables`（调用点 substitutions）**。已端到端实测通过，落盘审计逐处有据。

---

## 0. 结论速览（先看五条）

1. **假设成立且比预期更强**。`ctl.runjob` 有 `contextVariables`、`ctl.runpipeline`/`ctl.trigger` 有 `parameters`，
   形状都是 key-value。顶层（唯一被 `${ENV:}` 解析的文档）在**调用点**写 `{"SECRET":"${ENV:X}"}`，
   由 runner 解析成明文后**只在内存里**传给子文档。
2. **`ctl.foreach` 没有**这个参数（只有 `pipelineRef/itemKey/concurrency/dispatch/maxAttempts/...`）。
   所以「顶层就是 foreach」的 §8 形态**不能**从顶层直接注入 —— 需要改判断的是**层数**，不是参数。
3. **子文档与孙文档都能拿到值**，不需要 `${ITER_ITEM_*}` 也不需要 context 文件。
   实测：顶层 → `ctl.foreach` → 子 → `ctl.runjob` → 孙，四级链条全通过，mock 回显的摘要与假密钥**逐位相符**。
4. **落盘审计（关键）**：`contextVariables` 通路下，工作区内**任何持久面**都没有明文，连**运行期临时 run DB 都没有**
   （实测运行中扫到 5 个 run DB、36 次观测、明文命中 **0**）。密钥只存在于进程内存。
   但有 **两条条件性泄露路径**必须写进 L1 规范（见 §4）。
5. **顺带订正 spec 一条已确证结论**：`ctl.foreach` 的子管线**现在认 `connectionRef` 了**（0.7.4 起）。
   §4.2 写「也不认 connectionRef」**对 0.7.4 已过时**。这是第六条通路，在「密文落盘」上比第五个更干净（见 §7）。

---

## 1. 环境与可复现

| 件 | 值 |
|---|---|
| duckle | **0.7.4**（PyPI `LATEST: 0.7.4`，实测 `pip index versions` 确认；binary `/private/tmp/duckle-lab-p1/.venv074/bin/duckle`） |
| DuckDB | **1.5.5**（同 venv，`DUCKLE_DUCKDB_BIN` 指定） |
| 源码快照 | `source-analysis/duckle-latest` @ `b62e8ce`（2026-09-25）。**与已装 wheel 逐字节一致**：`diff -q packaging/pypi/duckle/_components.py <site-packages>/duckle/_components.py` → IDENTICAL（139019 B）。⇒ **下文源码行号可直接对应线上 binary 行为** |
| workspace | `/tmp/d1-lab/ws/`（本地，无 context 文件、无 repository.json） |
| mock 网关 | 自写 `mock/mock_probe.py`，`127.0.0.1:8877`；回显 `sha256(tok)[:12]` + `len`，**不落明文**；请求日志在 workspace **之外**（`/tmp/d1-lab/mockstate/`），避免污染 duckle 侧审计 |
| 假密钥 | `LABSEC_2f9c1a7b4e6d8035`（sha256[:12] = **`fcd77c2f93ca`**，len 23） |
| 跑法 | `. ./env.sh && ./run.sh <scene> <top.json>`；`./audit.sh` 出汇总审计 |
| 证据 | `./evidence/`（本报告同目录）：`run-s*.out` 原始 stdout、`audit-final.txt`、`s1-poll2.txt`、`pipelines/`、`mock/`、`run.sh`、`audit.sh` |

---

## 2. Q1：那个参数存在吗？—— 存在（源码锚）

### 2.1 属性 schema（引擎自述）

| 组件 | 参数 | 出处 |
|---|---|---|
| `ctl.runjob` | `['pipelineRef','returnsRows','passesRows','**contextVariables**']`，`contextVariables` 是 `kind: key-value` | `crates/duckle-mcp/catalog.json`；`packaging/pypi/duckle/_components.py:101` |
| `ctl.runpipeline` / `ctl.trigger` | 同形，键名 `**parameters**` | 同上 |
| `ctl.foreach` | `['pipelineRef','itemKey','concurrency','dispatch','maxAttempts','retryBackoff','retryInitialSeconds','retryMaxSeconds']` —— **没有 substitutions** | 同上 |
| `ctl.iterate` | `['pipelineRef','count']` —— 同样没有 | 同上 |

组件的 summary 原文（`ctl.runjob`）：
> *"Calls a child pipeline (job) as a side effect, **passing parent context variables that are substituted as `${VAR}` into the child before it runs**."*

### 2.2 消费侧（编译期 → 运行期）

```
plan/mod.rs:3991   } else if component_id == "ctl.runpipeline"
plan/mod.rs:3992       || component_id == "ctl.trigger"
plan/mod.rs:3993       || component_id == "ctl.runjob"
plan/mod.rs:4009       let mut vars = kv_pairs(&props, "contextVariables");
plan/mod.rs:4010       if vars.is_empty() {
plan/mod.rs:4011           vars = kv_pairs(&props, "parameters");
                       }
plan/mod.rs:4058       run_job = Some((path, vars, passes_rows));   // → RuntimeSpec::RunJob
                       ───────────── 运行期 ─────────────
lib.rs:2139            let mut subs = match sets_run_vars { true => self.run_vars_so_far(&db_path), false => Default::default() };
lib.rs:2143            subs.extend(vars.iter().cloned());            // ← 调用点的键值进来（"call 命名者胜"）
lib.rs:2146            self.run_subpipeline_with_subs(path, &subs)   // → run_subpipeline_as
plan/builders.rs:10373 pub(crate) fn kv_pairs(...)                    // 接受 {k:v} 与 [{key,value}] 两种形状
```

### 2.3 注入侧（子文档怎么拿到）

```
connectors.rs:16885  pub(crate) fn run_subpipeline_as(&self, path, subs, item)
connectors.rs:16904      let inherited = self.inherited_subs.lock()...        // 上层传下来的
connectors.rs:16907-8    inherited.chain(subs)  → merged                      // 本调用点的覆盖继承的
connectors.rs:16909      content = substitute_into_child(&content, &merged);
connectors.rs:16940-49   inherited_subs := merged   （仅本子运行期间，兄弟调用不继承）
connectors.rs:19824  pub(crate) fn substitute_into_child(content, subs)
                         merged = workspace_context_vars(); for (k,v) in subs { merged.insert(k,v) }
```

引擎源码把这件事说得非常直白（`lib.rs:2128-2131`）：
> *"What the run has worked out so far goes first, and **what the call names goes over it**: naming a value on the call is how a parent says 'run the child with this one', so it has to win."*

以及（`lib.rs:16901-16905`）：
> *"What this job was handed flows on to whatever it runs, so **a value named by a caller still reaches a body lifted out further down**."*

### 2.4 为什么这样就「不落盘」

`${ENV:...}` 的解析器只有一个，且**只作用于顶层文档**：

```
duckle-runner/src/main.rs:843  pub(crate) fn apply_env_pass(doc, workspace, env_path)
main.rs:885-888                    for node in &mut doc.nodes { substitute_deep(props, &replace) }
```

顶层文档是唯一被 env pass 过的文档 ⇒ 在**顶层的 `ctl.runjob` 调用点**写 `${ENV:LAB_SECRET}`，
在 runner 手里就被换成明文，此后一路是**内存里的 HashMap**，从不回写。

> ⚠️ 注意方向：这一步**只有在顶层**成立。同一个 `contextVariables` 若写在**子文档**里、值写 `${ENV:...}`，
> 子文档没被 env pass ⇒ 占位符原样透传（与 §4.2 差异 1 同病）。

---

## 3. Q2：端到端实测（值真的到了最内层）

四个场景，全部用 mock 回显的 `sha256(tok)[:12]` 判定「值是否真到达」。
**判定式：mock 看到 `fcd77c2f93ca`(len 23) ⇔ 假密钥逐位到达最内层。**

| 场景 | 形态 | 结果 | 最内层看到的 | 深度 |
|---|---|---|---|---|
| **S0** | 顶层 `foreach` → leaf（**无任何提供方**）—— 负对照 | **exit 1** | `RelativeUrlWithoutBase`（占位符原样，复现差异 1） | — |
| **S1** | 顶层 `**ctl.runjob**(contextVariables={"LABSECRET":"${ENV:LAB_SECRET}"})` → mid(`foreach`) → leaf | **exit 0** | `fcd77c2f93ca` ✅ | 3 |
| **S2** | **任务给的链形**：顶层 `ctl.setvar` + `foreach` → mid2 → **`ctl.runjob`** → leaf | **exit 0** | `fcd77c2f93ca` ✅ | 4 |
| **S3** | 顶层 `ctl.setvar` + `foreach` → leaf | **exit 0** | `fcd77c2f93ca` ✅ | 2 |
| **S9** | 顶层 `foreach` → leaf（credential 来自 **`connectionRef`**，全链无 `${ENV:}`） | **exit 0** | `fcd77c2f93ca` ✅ | 2 |

**S0 原文**（负对照，坐实「子管线什么都不继承」）：
```
error: for each: query: ctl.foreach(.../leaf.json)[row 0]: query: probe: query:
       REST HTTP transport to ${LAB_GW}/probe?tok=${LABSECRET}&tag=w01:
       Bad URL: failed to parse URL: RelativeUrlWithoutBase: relative URL without a base
```

**S1 回执**（`evidence/run-s1.out` + mock 日志）：
```
status : ok
1|...|path=/probe|tag=w01|secret_src=query|tok_sha12=fcd77c2f93ca|tok_len=23
2|...|path=/probe|tag=w02|secret_src=query|tok_sha12=fcd77c2f93ca|tok_len=23
3|...|path=/probe|tag=w03|secret_src=query|tok_sha12=fcd77c2f93ca|tok_len=23
```

**S2 回执**：`exit_code=0`，9 次请求（3 窗 × 内层 3 窗 —— mid2 自带 foreach，嵌套两层），全部 `fcd77c2f93ca`。
⇒ **`ctl.runjob` 的 `contextVariables` 能被它自己的 `ctl.foreach` 继续往孙辈继承**（靠 `inherited_subs`）。

**顺带确认**：`inherited_subs` 是**逐层继承**的（`lib.rs:16940-16949` 用 `std::mem::replace` 装了 `merged`，
子运行结束再还原）⇒ 深度不受限。

---

## 4. Q3：落盘审计（逐处 有/无 明文）—— 最关键的产出

### 4.1 审计方法

对工作区 + OS 临时目录**穷举**，逐处 `grep` 假密钥字面量。审计方法**有牙**已被证明：
S4 与 S3-fail 两个场景确实被抓出明文（下面标 🚨 的两行）——不是「因为没写东西所以干净」。

### 4.2 主表（场景 S1 = 推荐的 contextVariables 通路；密钥走 URL 与走 header 各测一遍）

| # | 持久面 | 路径 | 明文? | 证据 |
|---|---|---|---|---|
| 1 | 管线文件本身 | `ws/pipelines/*.json` | **无** | 只含 `${ENV:LAB_SECRET}` / `${LABSECRET}` 占位符 |
| 2 | 运行日志 | `ws/logs/<run>/runtime.log` | **成功路径：无** | S1/S3 全绿后 grep 干净 |
| 3 | 运行日志（**失败路径**） | `ws/logs/<run>/runtime.log` | 🚨 **有 —— 当且仅当密钥写在 URL/query 里** | `evidence/run-s3-fail.out`：`REST HTTP transport to http://…?tok=LABSEC_2f9c1a7b4e6d8035&tag=w01`。**改放 header 后同场景 CLEAN**（`run-s3h-fail.out`） |
| 4 | 运行历史 | `ws/runs/<pipeline>.json` | 🚨 **同 #3 条件** | 失败时 error 文本被整条记入（S3-fail）；成功时只有 node/status/rows/durationMs |
| 5 | 运行收据 | `ws/runs/receipts/run-*.json` | **无** | 只有 runId/status/pipelineHash/nodes{status,rows,durationMs}，**无属性** |
| 6 | 状态 / checkpoint | `ws/state/<child>/checkpoints/<node>.ndjson` | **无** | 内容 = `{"key":"<64hex>","at":…,"output":[…行数据]}` —— **key 是哈希**，另有该节点的**输出行**。⚠️ 推论：**别让密钥出现在管道返回的行里** |
| 7 | 批次队列 | `ws/batches/<id>.ndjson` | 🚨 **有 —— 无条件**（`dispatch:"queue"` 时） | `evidence/run-s4.out`：`{"vars":{"ITER_INDEX":"0","ITER_ITEM_WINDOW":"w01","LABSECRET":"LABSEC_2f9c1a7b4e6d8035"},…}`。**仅当密钥经 `ctl.setvar` 进 run vars 时**（`carried` 取自 `run_vars_so_far`）；纯 `contextVariables` 通路不进 `carried` |
| 8 | 输出 / 收据 | `ws/out/*.csv` | **无**（本 lab 只回显摘要） | 值派生面：只要管道不把密钥**返回**成列，这里就干净 |
| 9 | 缓存 / 锁 | `ws/.duckle/` | **无** | 只有 `locks/*.lock` 空壳 |
| 10 | workspace context 文件 | `ws/contexts/` + `repository.json` | **N/A（本方案不使用）** | 目录根本不存在 —— 这正是相比选项 (a) 的增益 |
| 11 | 运行期临时 DB | `$TMPDIR/duckle_run_<pid>_<nanos>_<seq>.duckdb` | **contextVariables 通路：无**；**setvar 通路：有（进程存活期）** | 见 §4.3 |
| 12 | 其它临时产物 | `$TMPDIR/duckle-rest-*.json` | **无** | 实测 0 字节 |
| 13 | 死信 | sink `deadLetter` / `ctl.deadletter` | **未实测** | 按设计接收**行数据**（`props.rs:583` 起）。与 #6 同规矩：别让密钥进返回行 |

### 4.3 §4.2 第 11 行的判决实验（这一条决定「推荐哪个形态」）

**形态 A（`ctl.runjob.contextVariables`）** —— 运行中扫描：

```
POLL2: distinct run DBs seen = 5 | observations = 36 | plaintext hits = 0
   duckle_run_48252_…_0 … _4.duckdb
```
⇒ 5 个 run DB（每层一个）被反复读到，**明文命中 0**，且**从未出现 `duckle_var__*` 表**。
**密钥不落任何数据库文件。**

**形态 B（`ctl.setvar` + `foreach`）** —— 同一手法：

```
duckle_run_46597_…_0.duckdb : PLAINTEXT PRESENT
strings → duckle_var__LABSECRET
          LABSEC_2f9c1a7b4e6d8035
```
出处：`plan/mod.rs:3919` 的 `ctl.setvar` 把值写成 **run 自己数据库里的一张表**
（`plan/mod.rs:237 run_var_relation(name) → "duckle_var__<name>"`；`lib.rs:1692` `db_path = std::env::temp_dir()/duckle_run_*.duckdb`）。

**追加压力测试——进程被 SIGKILL**：
```
run DBs before=1 after SIGKILL=2
duckle_run_47397_…_0.duckdb : PLAINTEXT PRESENT  <-- survives SIGKILL
```
`TempDbGuard`（`lib.rs:1698`）是 **Drop 守卫**：正常退出会删，**SIGKILL / 断电 不会**。
⇒ 形态 B 的 run DB 是**「进程存活期 + 非正常终止后永久」的明文面**。

### 4.4 审计结论

* **形态 A 是唯一做到「全绿、全失败、全终止方式下都零明文」的形态。**
* 形态 B 也能过（日常全绿无明文），但有**两个必须写进规范的红线**：`dispatch:"queue"` 禁用、SIGKILL 会留 DB。
* **与密钥位置无关的两条通用红线**（无论哪个形态）：
  1. **密钥绝不能进 URL / query string**（失败即写 `logs/` + `runs/`，而且是逐请求重复写）；
  2. **别让密钥出现在管道返回的行里**（会进 `state/…/checkpoints`、死信、以及任何 sink）。

---

## 5. Q4：四选项的落盘代价表（供拍板）+ option (c) 增益评估

> 说明：spec §6.1 的四选项是 (a) context 变量、(b) 行值、(c) 分层下传、(d) 上游改 `apply_env_pass`。
> 实测之后，(c) 的定位需要**订正**（见 §5.2），并应新增两个原生选项（第五/第六）。

### 5.1 代价表

| 选项 | 值从哪来 | 落盘面（明文） | 端口/工程代价 | 判定 |
|---|---|---|---|---|
| **(a) context 变量** | `contexts/<id>.json` | 🚨 **workspace 内常驻明文文件**（随 workspace 进备份/快照/git） | 低（本 lab 已跑通） | 可用但**与 §7.3「管线不碰密钥落盘」直接冲突** |
| **(b) 行值**（驱动表带常量列） | 顶层 SQL 常量或源数据 | 🚨 run DB（进程期）；🚨 若 `dispatch:"queue"` → `batches/*.ndjson` 明文；⚠️ 驱动 SQL 文本可能进失败日志 | 中（要给窗口表加列） | **最差** |
| **(c) 分层下传** | —— | ✅ **无**（实测 5 run DB / 0 命中） | 低（多一层薄管线） | **推荐**（定位见 §5.2） |
| **(d) 上游改 `apply_env_pass`/`resolve_connection_refs` 作用于子文档** | 顶层 env | ✅ 无（与顶层同） | 高（改上游 + 等发版） | 正确但**不可自控**；`connectionRef` 那半 0.7.4 已实现（见 §7） |
| **(e) 第五通路：`ctl.runjob.contextVariables`（新）** | 顶层 env（**调用点**写 `${ENV:}`） | ✅ **无**（含运行期） | 低 | **本次推荐主线** |
| **(f) 第六通路：`connectionRef`（新，0.7.4）** | `connections/<id>.json` | ✅ **密文**（若用加密写入方）／🚨 明文（若用 MCP 建） | 低 | **静止面最优**，但有坑（见 §7 三条） |

### 5.2 option (c) 到底省了什么 —— 以及 spec 对它的定位错在哪

§6.1 原文说 (c)：
> *「**它只搬「谁读得到」，不解决「值从哪来」** —— 最外层的值仍得来自行值或 context；好处是重管线只需把 `${ENV:X}` 改成 `${X}`。」*

**实测订正**：这个判断只对了一半。`contextVariables` **同时**是「值从哪来」的答案 ——
因为顶层文档**会被 env pass**，所以把 `${ENV:X}` 写在**顶层的调用点**，明文就在顶层被造出来，
再经 `inherited_subs` 逐层下传。**不再需要行值，也不再需要 context 文件。**

⇒ (c) 的真实增益比 spec 说的大得多：

| 维度 | spec 预期 | 实测 |
|---|---|---|
| 解决「谁读得到」 | ✅ | ✅ |
| 解决「值从哪来」 | ❌（仍要 (a) 或 (b)） | ✅ **解决**（顶层 `${ENV:}`） |
| 静止明文 | （未评估，因仍需 (a)/(b)） | ✅ **零** |
| 运行期明文 | （未评估） | ✅ **零**（5 run DB / 0 命中） |
| 改动面 | 重管线 `${ENV:X}` → `${X}` | 同左，另加一层薄入口 |

**唯一真实代价**：要在 §8 的「L0 直连 / L1 foreach 两层」之上**再插一层薄入口**（因为 `ctl.foreach` 不接受调用点变量）。
这是**结构性变更，需要人拍板**（§9 给了两个候选形态，把这条差异摊开）。

---

## 6. Q5：可直接抄的写法

> 以下 JSON 片段全部来自本 lab 跑绿的管线文件（`evidence/pipelines/`），可直接抄。
> **占位约定**：`<ws>` = workspace 绝对路径；生产里用 `${workspace}`（子文档内）或 `${ENV:...}`（顶层）。

### 6.1 推荐形态 A（零明文，含运行期）—— 三层

```
┌─ 入口（顶层，唯一被 ${ENV:} 解析的文档） ─────────────────────┐
│  ctl.runjob  pipelineRef="<ws>/pipelines/l1-window.json"      │
│             contextVariables={"ZOS_ACCESS_KEY":"${ENV:ZOS_ACCESS_KEY}", ...} │
└───────────────────────┬──────────────────────────────────────┘
                        │ 明文只在内存，写入子文档文本（不落盘）
┌─ L1 薄壳（子）─────────────────────────────────────────────┐
│  src.csv(窗口表) → ctl.foreach(pipelineRef="…/l0-heavy.json")  │
└───────────────────────┬──────────────────────────────────────┘
                        │ inherited_subs 继承 ⇒ ${ZOS_ACCESS_KEY} 仍可用
┌─ L0 重管线（孙，现重管线逐字保留，只改占位符名）──────────────┐
│  src.rest headers:{Authorization:"Bearer ${LEMENG_TOKEN}"}    │
│  snk.minio accessKey="${ZOS_ACCESS_KEY}" secretKey="${ZOS_SECRET_KEY}" │
└───────────────────────────────────────────────────────────────┘
```

**入口管线**（`top-*.json` 的 `runjob` 节点，逐字可抄）：
```json
{"id":"rj","position":{"x":220,"y":0},"data":{"label":"run L1","componentId":"ctl.runjob",
  "properties":{
    "pipelineRef":"${ENV:LAB}/ws/pipelines/mid.json",
    "contextVariables":{
      "ZOS_ACCESS_KEY":"${ENV:ZOS_ACCESS_KEY}",
      "ZOS_SECRET_KEY":"${ENV:ZOS_SECRET_KEY}",
      "LEMENG_TOKEN":"${ENV:LEMENG_TOKEN}"
    }}}}
```
> `contextVariables` 接受 `{k:v}` 或 `[{"key":…,"value":…}]` 两种形状（`plan/builders.rs:10373`）。

**L1 薄壳**（`foreach` 节点）：
```json
{"id":"fe","position":{"x":220,"y":0},"data":{"label":"for each window","componentId":"ctl.foreach",
  "properties":{"pipelineRef":"${workspace}/pipelines/l0-heavy.json","itemKey":"window","concurrency":1}}}
```
> 子文档内用 `${workspace}`（内建 context 变量，`connectors.rs:20738-20741`）；**不要**在子文档里写 `${ENV:...}`。

**L0 重管线**（改动 = 只把 `${ENV:X}` 改成 `${X}`；**密钥一律走 header / props，绝不放 URL**）：
```json
{"id":"p1","data":{"componentId":"src.rest","properties":{
  "url":"https://<gw>/agi/api/….find",
  "method":"POST",
  "headers":{"Authorization":"Bearer ${LEMENG_TOKEN}"},
  "body":"{\"page_number\":1,\"page_size\":200,\"window\":\"${ITER_ITEM_WINDOW}\"}",
  "responsePath":"/result/content","checkpoint":true}}}

{"id":"sink","data":{"componentId":"snk.minio","properties":{
  "bucket":"${LAB_BUCKET}","endpoint":"${LAB_ENDPOINT}","urlStyle":"path","useSsl":"false",
  "accessKey":"${ZOS_ACCESS_KEY}","secretKey":"${ZOS_SECRET_KEY}",
  "key":"l1/branch/system_book=${SYSTEM_BOOK}/window=${ITER_ITEM_WINDOW}/all.parquet",
  "format":"parquet","mode":"overwrite","compression":"zstd"}}}
```

### 6.2 备选形态 B（不新增层，保持 §8 两层）—— 用 `ctl.setvar`

顶层就是 foreach，前面挂一个 `ctl.setvar`：
```json
{"id":"sv","data":{"componentId":"ctl.setvar","properties":{
  "name":"ZOS_SECRET_KEY","value":"'${ENV:ZOS_SECRET_KEY}'"}}}
```
* `value` 是 **SQL 表达式**，所以要包一层 SQL 字符串字面量引号（lab 实测通过）。
* 依赖 `sets_run_vars`（`lib.rs:1740`）开关 + `carried = run_vars_so_far()`（`lib.rs:2180`）把 run var 带进每行 subs。
* ⚠️ **两条红线**（§4.3）：`dispatch` 必须 `inline`（`queue` 会把明文写进 `batches/*.ndjson`）；
  run DB 在 SIGKILL 后留明文。
* ⚠️ 值里若含单引号会破坏 SQL 字面量 —— 生产密钥（base64 族）通常没有，但要知情。

### 6.3 形态 C（静止密文面最优）—— `connectionRef`（0.7.4 可用）

```json
{"id":"sink","data":{"componentId":"snk.minio","properties":{
  "connectionRef":"zos-prod",
  "bucket":"…","key":"…","format":"parquet","mode":"overwrite"}}}
```
* 子管线**能解析**（实测 S9 通过；`connectors.rs:16921` 是修这个的那一处）。
* 但**三条坑**见 §7。

### 6.4 硬性写法红线（全形态适用）

1. **密钥绝不进 URL / query string**（失败即 `logs/` + `runs/` 明文）。
2. **密钥绝不进返回行**（会进 `state/*/checkpoints`、死信、sink）。
3. **子文档里绝不写 `${ENV:...}`**（顶层之外无人解析，会静默变相对路径）。
4. **`ct:foreach` 子管线若用 `dispatch:"queue"`，密钥不得经 `ctl.setvar`**（`batches/*.ndjson` 明文）。

---

## 7. 附带订正与新发现（对 spec 的账）

### 7.1 订正：子管线**已经认** `connectionRef`（0.7.4）

§4.2 差异 1 写「子管线……**也不认 `connectionRef`**」——**对 0.7.4 已过时**。源码：

```
connectors.rs:16911-16922
  // A node may hold only `connectionRef` … Every surface resolves refs on the document
  // it was handed, and a child is not that document - it is read from disk right here -
  // so a child using a saved connection failed for a field the connection provides.
  // Every child path (runjob, iterate, foreach, batch items, install fallback) comes
  // through this function, so this is the one place…
  duckle_secrets::resolve_connection_refs(ws, &mut sub_doc.nodes)
```
**lab 实测 S9 通过**（child 用 `connectionRef` 拿到凭据，全链无 `${ENV:}`、无 context、无 setvar，mock 收到 `fcd77c2f93ca`）。

### 7.2 新发现：`connectionRef` 的加密是「写入方决定」的，且有 fail-open

`duckle-secrets` 的静止加密（AES-256-GCM，密钥 `<workspace>/.duckle/keys/secret.key` 0600，
密文前缀 `enc:v2:`，绑定 AAD 防跨字段搬移）：

| 事实 | 状态 | 证据 |
|---|---|---|
| 引擎**支持**连接字段静止密文 | **源码确证** | `crates/duckle-secrets/src/lib.rs:1-17`（模块文档）、`:182 encrypt_value`、`:331 load_connection` 会解密 |
| 加密写入方 = 桌面 app / `duckle serve` | **源码确证** | `duckle-runner/src/serve.rs:877 connection_encrypt_payload`；`apps/desktop/src/secrets.rs:20` |
| **MCP `create_connection` 写明文** | 🚨 **实测确证** | 建的连接文件原样 `"authToken": "LABSEC_2f9c1a7b4e6d8035"` |
| 加密往返（真密文可解） | **未实测**（本机无 AES-GCM 库；上游有 `crates/duckle-secrets/tests/connection_e2e.rs` 覆盖） | 标记待验，不冒充 |
| **非 Salesforce 连接「加载失败」是静默的** | 🚨 **实测确证** | `duckle-secrets/src/lib.rs:411-414`：`Err(e) => return if is_salesforce { Err(e) } else { Ok(()) }`。实测：放一个伪造 `enc:v2:` → **exit 0、无报错、凭据为空**（典型的「静默 401」形状） |

> ⇒ 用 `connectionRef` 要额外立两条规矩：**只能用会加密的写入方建连接**；
> **连接加载失败必须单独探测**（它不会让管线红）。

### 7.3 新发现：runner 还有另外两个密钥来源（对 D1 有用）

`apply_env_pass` 在解析 `${ENV:...}` **之前**先跑：

```
main.rs:846  duckle_duckdb_engine::context::apply_vault(doc)   // ${VAULT:NAME} — 外部 vault 命令
main.rs:850  读 <workspace>/secrets.env                        // 明文文件
main.rs:853  load_secrets_enc(workspace)                       // <workspace>/secrets.enc（AES-256-GCM + Argon2id，口令 DUCKLE_BUNDLE_PASSPHRASE）
main.rs:864  real env is checked first at lookup time so it always wins
```

⇒ 顶层 `${ENV:X}` 的值可以来自 **真实 env（零落盘）**、`secrets.env`（明文文件）、
或 `secrets.enc`（**密文文件**，口令在 env）。**这三者是 `contexts/*.json` 的更好替代**：
同样供顶层解析，但静止面从「明文」变成「无 / 密文」。属于选项 (a) 的可加固版本，**未实测**（标注待验）。

---

## 8. 未验 / 待验（不冒充）

| 项 | 为什么没测 |
|---|---|
| `secrets.enc` 端到端（生成 + 顶层解析） | 需要 `DUCKLE_BUNDLE_PASSPHRASE` 与打包路径；`secrets.env`（明文）与真 env 未单测 |
| `${VAULT:NAME}` 端到端 | 需要造一个 vault 命令；源码路径清晰（`context.rs:247`），未实跑 |
| `connectionRef` **真密文**往返 | 本机无 AES-GCM 实现可用；上游 e2e 测试覆盖，但未在本 lab 复现 |
| `deadLetter` / `ctl.deadletter` 落盘面 | 未构造死信场景；按设计接收行数据（§4.2 #13） |
| `dispatch:"queue"` + 形态 A 的**worker 侧** | 源码判读：`run_batch_item` 在**新进程**里跑子管线，`inherited_subs` 为空 ⇒ **`contextVariables` 不会随批次文件到达**（`connectors.rs:16862-16872`）。**未实跑 worker 验证**，标待验 |
| 生产 workspace 的 `.duckle/keys/` 生命周期 | 属部署面（进不进备份/snapshot），本 lab 无法覆盖 |

---

## 9. 需要人拍板的一件事

**D1 的技术结论已经明确（零明文可行），剩下的是「层数」这个结构决定：**

| 方案 | 形态 | 明文面 | 结构代价 |
|---|---|---|---|
| **A** | 入口(`runjob`+contextVariables) → L1(`foreach`) → L0(重管线) | **全零** | 比「L0/L1 两层」**多一层薄入口**（须改 `docs/data-platform-handbook.md` §1.1.7 的形态定义） |
| **B** | L1(`setvar`+`foreach`) → L0(重管线) | 成功路径零；**run DB 进程期明文 + SIGKILL 驻留** | 保持两层不变 |

**建议 A**：唯一代价是一层薄入口，换来的是「全场景零明文 + 不必给窗口表加常量列」。
**若必须保持两层** → 选 B，但 §6.2 的两条红线要进规范。

无论 A/B，§6.4 的四条写法红线都要写进 L1 规范。

---

## 10. 证据索引（全部在 `./evidence/`）

| 文件 | 内容 |
|---|---|
| `audit-final.txt` | **落盘审计汇总表**（S1 / S1H / S3 / S4 四场景 × 9 个持久面） |
| `s1-poll2.txt` | 形态 A 运行期 run DB 扫描（5 DB / 36 观测 / 0 明文） |
| `run-s0.out` | 负对照：子管线什么都不继承（`RelativeUrlWithoutBase`） |
| `run-s1.out` / `run-s2.out` / `run-s3.out` | 三个绿场景 |
| `run-s3-fail.out` | 🚨 失败路径把 URL 里的密钥写进 **3 处**：`<ws>/logs/top-s3/runtime.log`、`<ws>/logs/leaf_w01/runtime.log`、`<ws>/runs/top-s3.json`（实测 `grep -rl` 逐条点名） |
| `run-s3h-fail.out` | 同场景、密钥改走 header → CLEAN |
| `run-s4.out` + `s4-queue-leak-proof.txt` | 🚨 `dispatch:"queue"` 把密钥写进 `batches/*.ndjson`（**原文**：`"vars":{…,"LABSECRET":"LABSEC_2f9c1a7b4e6d8035"}`，3 行逐窗重复） |
| `run-s6.out` | 失败 sink（`snk.minio` + 死的 endpoint）→ CLEAN |
| `run-s7.out` / `run-s7-kill.out` | 形态 B 运行期 run DB 明文 + SIGKILL 后驻留 |
| `run-s9.out` | 子管线 `connectionRef` 通过（订正 §4.2） |
| `pipelines/` | 全部 lab 管线（可直接抄的写法） |
| `mock/mock_probe.py` | mock 网关（回显摘要，不落明文；日志在 workspace 之外） |
| `run.sh` / `audit.sh` / `env.sh` | 复现入口 |
