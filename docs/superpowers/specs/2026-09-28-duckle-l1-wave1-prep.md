# Wave 1 前置实验包 + L1 管线草案（纯实验室 / 只读，零生产写入）

> 2026-09-28 ｜ worker `task_b5861dd6fcc5` ｜ 依据：`docs/data-platform-handbook.md` §1.1.7、
> `docs/superpowers/specs/2026-09-28-duckle-orchestration-capability-survey.md`（下称 §N）
>
> **本报告全部活动**：本机 `/tmp` 与本 worktree `.tmp/wave1-lab/`（`.tmp/` 已 gitignore）+ 生产侧
> **只读** HTTP 探针（经 openship MCP `exec` 在 console 容器内发起，仅打印计数与 schema，不含行数据、不含凭据）。
> **未碰湖、未碰生产卷、未改生产调度、未上机裸敲。**

---

## 0. 一句话结论（先看三条硬结论）

1. **E1 sink 覆盖语义定案**：`snk.minio` 的 `mode: overwrite` 是**单对象覆盖**——同 key 重写只替换那一个对象，
   同前缀下的其它对象**不清理**；而 `partitionBy` 在云 sink 上被**静默忽略**（既不报错也不分区）。
   ⇒ **L1 子管线的 sink 写法照现重管线抄，别动**：一窗一 key 的单对象、分区写进 key、不开 `partitionBy`。
2. **E2 真网关分页零改动**：`branch.find` **没有任何 total/hasNext 信号**，末页是 `HTTP 200 + code:0 + content:[]`。
   ⇒ 末页哨兵（`ctl.die has-rows`）是**唯一**可行的停止信号且实测成立；L1 下分页**不需要改**。
   附带订正：本任务的「12 页×200」是**零售/对账**路径的数，`lemeng.branch` 真实配置是 **5 页 × 200（阈值 800）**。
3. **⚠️ 拦路石（本次最大发现）**：`ctl.foreach` 的**子管线读不到 `${ENV:...}`，也不认 `connectionRef`**——
   runner 的 env pass / connection 解析只作用于**顶层文档**。§8/§1.1.7 设想的「子管线＝现重管线逐字保留」
   **照抄会直接跑挂**。原生可行通路只有两条：`${ITER_ITEM_*}` 行值 与 **workspace context 变量**。
   本 lab 用后者跑通（详见 §4.1）。

---

## 1. 实验环境（可复现）

| 件 | 值 |
|---|---|
| duckle | **0.7.4**（`/private/tmp/duckle-lab-p1/.venv074/bin/duckle`） |
| DuckDB | **1.5.5**（同 venv 的 `duckdb`，`DUCKLE_DUCKDB_BIN` 指定） |
| S3 兼容端点 | `minio/minio:latest` 容器，**仅绑回环 `127.0.0.1:9900`**，桶 `lemeng-lab` |
| mock 网关 | 本 lab 自写 `mock/mock_gateway.py`，监听 `127.0.0.1:8866`，**形状照真网关实测抄**（见 §3） |
| lab 目录 | `<worktree>/.tmp/wave1-lab/`（`pipelines/` `data/` `out/` `mock/` `mockstate/` `state/`） |
| 跑法 | `. ./env.sh && ./scenarios.sh`；`./reset.sh` 清引擎状态（**注意它会删 `state/`，跨 run 复用场景别用**） |

---

## 2. 任务 1：sink 分区覆盖语义实验（`partitionBy` 到底覆盖谁）

### 2.1 实验设计（四种情形）

| 编号 | 情形 | 管线 |
|---|---|---|
| A | `snk.minio` 不带 `partitionBy`，**跨 run 重写同一 key** | `pipelines/e1-minio-nopartby.json` |
| B | `snk.minio` **带** `partitionBy:["snapshot"]` | `pipelines/e1-minio-partby.json` |
| C | **同 run 内**两个 sink 节点写**同一 key** | `pipelines/e1-minio-two-sinks-same-key.json` |
| D | 对照：**本地** `snk.parquet` + `partitionBy`（非云 sink） | `pipelines/e1-local-partby.json` |

### 2.2 证据（`out/e1-evidence.txt` / `out/e1-content.txt` / `out/e1-object-list.txt`）

**A — 跨 run 重写（同 key）**
```
步骤 1  写 ab.csv（2026-09-26 × 2 行 + 2026-09-27 × 2 行）
步骤 2  读回 → 2026-09-26|00|1  2026-09-26|01|2  2026-09-27|00|3  2026-09-27|01|4   （4 行）
步骤 3  同 key 改写 a.csv（只剩 2026-09-26）
步骤 4  读回 → 2026-09-26|00|11  2026-09-26|01|22                              （2 行）
        ⇒ 2026-09-27 的两行**消失**：整对象被替换，不是「合并」。
步骤 5  对象清单里，同前缀下**人工放的两个 marker**
        e1/nopartby/stale.parquet 与 e1/nopartby/snapshot=2026-01-01/old.parquet
        **原样还在** ⇒ overwrite 只作用于**它自己那一个对象**，不清前缀。
```

**B — 带 `partitionBy`**
```
桶内对象：e1/partby/all.parquet     ← 一个对象，没有 hive 目录
内容：4 行（两个 snapshot 全在里面）
⇒ partitionBy 被**静默忽略**：不分区、不报错、不告警。
```
> 源码侧双锚：v0.7.3 `crates/duckdb-engine/src/plan/builders.rs:9687-9700`
> `build_cloud_sink()` 里有一段 `obj.remove("partitionBy")`，注释原文：
> *"partitionBy is intentionally NOT forwarded: a partitioned directory write over httpfs (s3/gs/azure)
> behaves very differently from a single-object COPY and isn't validated against a live target,
> so cloud sinks keep writing a single object as before."*
> 本次 0.7.4 **实测**行为与之一致（B 桶里就是单对象）。

**C — 同 run 内两个 sink 写同一 key**
```
两个 sink 各写 2 行（writer=A / writer=B）
结果：writer=A 的 2 行
⇒ **后写者胜，先写者的数据静默丢失**：不报错、不合并、不告警。
```

**D — 本地 `snk.parquet` + `partitionBy`（对照）**
```
run1（ab.csv）后目录：
  snapshot=all.parquet/snapshot=2026-09-26/data_0.parquet
  snapshot=all.parquet/snapshot=2026-09-27/data_0.parquet
run2（a.csv，只有 2026-09-26）后：
  snapshot=2026-09-26/data_0.parquet  → 被**改写**为 11/22
  snapshot=2026-09-27/data_0.parquet  → **仍在，还是旧数据 3/4**
⇒ 本地分区写是「**只覆盖本次发出的那一片**」，兄弟分区**不清理**。
   这正是 0.7.4 catalog 里那句 "Reruns overwrite the slice we just emitted." 的实测形状。
```

### 2.3 结论与**写法建议**（这是 §7.2 点名要的「我方待沉淀」项）

| 维度 | 实测语义 |
|---|---|
| 云 sink（`snk.minio/r2/b2/s3`）`overwrite` | **单对象覆盖**：只替换 key 指向的那一个对象；前缀下其它对象**不动** |
| 云 sink 的 `partitionBy` | **静默忽略**（等价于没写） |
| 同 run 多 sink 同 key | **后写者胜**，先写者数据丢失且无声 |
| 本地 sink 的 `partitionBy` | 分区目录生效，但**只覆盖本次发出的分区**，陈旧分区滞留 |

**⇒ L1 子管线 sink 写法（明确建议，照抄现重管线）**

```
componentId: snk.minio
  bucket/key   ：一窗一 key，**分区写进 key 本身**（如 …/system_book=${..}/window=<窗>/all.parquet）
  mode         ：overwrite          ← 单对象替换，天然幂等，语义最干净
  partitionBy  ：**不要写**          ← 写了等于没写，但会让人误以为有分区清理语义
```

**为什么这条建议是对的（而不是"将就现状"）**：
- L1 子管线是「一窗一跑」，**每一跑的产物就是一个对象**，单对象覆盖恰好等于「这一窗整份替换」——与现薄壳
  「同窗重跑覆盖 `hour=` 分区」的幂等口径**逐字一致**，且没有任何滞留面。
- 反例就是**别**把 L1 写成「reject 单管线形 + 一个 sink 装 24 窗 + `partitionBy=hour`」：按上表，24 窗的行会
  全挤进**一个对象**（partitionBy 被忽略），而你**以为**得到了 24 个分区。这是 §8 备选形里最危险的一处。
- 同理，**永远不要**让两个 sink 节点指向同一 key（情形 C 会静默丢数）。

---

## 3. 任务 2：真网关分页复核（**只读**）

### 3.1 方法

在 console 容器内（`lemeng-console-3120`，openship MCP `exec`）发起只读 POST；探针只打印
**行数 / 信封 code / result 的键名 / 标量字段**，**不打印任何门店行数据，不打印凭据**。

### 3.2 证据

**账套 3120**（`branches.find`，`page_size=200`）
```
page=1  http=200 envelope_code=0 msg=None rows=200
page=2  http=200 envelope_code=0 msg=None rows=70
page=3  http=200 envelope_code=0 msg=None rows=0
page=4  http=200 envelope_code=0 msg=None rows=0
page=5  http=200 envelope_code=0 msg=None rows=0
page=6  http=200 envelope_code=0 msg=None rows=0
topkeys=[code,msg,result]  resultkeys=[content,page_number,page_size]
```
**账套 64188**：`page=1 rows=129`，`page=2..6 rows=0`（同形状）。

- 响应信封只有 `code / msg / result{content, page_number, page_size}`——**没有 total，没有 hasNext，没有游标**。
- 末页是 **HTTP 200 + `code:0` + `content:[]`**——**不是**错误码、**不是** 404。
  ⇒ 「空页」是**唯一**可用的停止信号，正对 `ctl.die has-rows` 的语义。
- `page_size` 被尊重（`page_size=1` 时每页 1 行）；同页重复请求行数稳定。
- **`paginationType: page` 在本网关不可用**（实测三连）：
  `?page_number=2` 查询串 + body `page_number:1` → 返回 **page 1 的 200 行**（**body 赢**）；
  纯查询串 + 空 body → **400**；body 缺 `page_size` → **400**；camelCase `pageNum/pageSize` → **400**。
  而引擎的 page 风格是把参数拼进 **URL query**（`connectors.rs:15871-15879`，停止条件 `row_count == 0`）
  ⇒ 对不上，**5 个静态页节点必须保留**。

### 3.3 结论

- **L1 下分页不需要改动**：子管线照抄现 5 页节点 + 第 5 页哨兵；哨兵逻辑与真网关行为一致。
- 余量（本次实测）：3120 = 270 家 / 阈值 800（34%）；64188 = 129 家 / 阈值 800（16%）。哨兵页均为空，**未触发**。

### 3.4 ⚠️ 两处必须写进报告的订正

1. **「12 页×200」不是 `lemeng.branch` 的数。** 本任务书把它挂在 `lemeng.branch` 上，但仓内事实是：
   - `deploy/duckle/.../lemeng.branch.json`（= `duckle/common/lemeng.branch.json`）：**5 页 × 200**，
     p5 是哨兵，`ctl.die` 消息里写明真阈值 = (5−1)×200 = **800**。
   - **12 页 × 200（阈值 11×200=2200）** 是**零售订单/对账**路径（`run-retail-day.sh:587` `RECON_PAGES=12`；
     手册 §2 第 579 行「生产峰值 1459 单/时击穿 1400 阈值 ⇒ 扩容到 12 页（#197）」）。
   - 两者是**同一网关家族的不同端点**，分页行为同构，所以本复核结论对两者都成立；
     但**别把 12 页的算术搬到 branch 上**（会把阈值算成 2200，是错的）。

2. **真网关的 `whoami` 是 SSE，不是 JSON**（这一条影响任务 3 的身份门，见 §4.2）：
   `POST https://cloud.nhsoft.cn/agi/mcp`（JSON-RPC `tools/call` name=`whoami`）实测：
   ```
   content_type='text/event-stream'  bytes=2490
   body_prefix='event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"con…'
   is_plain_json=False  has_sse_data_lines=True
   ```
   `Accept: application/json` 单独给 → **406 Not Acceptable**（只肯吐 SSE）。
   内层 payload 键：`auth_type, branch_num, branch_nums, company_id, company_user_id, name, phone, timestamp, user_id, version`。
   猜测的两个 JSON 端点 `company.find` / `user.find` → **403**（不存在或本 token 无权）。

---

## 4. 任务 3：L1 骨架原型（mock 网关，跑通）

### 4.1 草案两文件（可直接进仓；**未提交生产目录**）

| 文件（lab 内） | 对应生产落点建议 | 说明 |
|---|---|---|
| `.tmp/wave1-lab/pipelines/l1-branch.window.json` | `duckle/common/lemeng.branch.json` 的 L1 版 | **子管线** = 现重管线 + `checkpoint:true` + 窗号注入 |
| `.tmp/wave1-lab/pipelines/l1-branch.l1.json` | `duckle/common/lemeng.branch.l1.json`（新增） | **父管线** = 身份门 + 窗口表 + foreach + 汇总 + 末尾判红 |

两条管线 `duckle validate` 均 **ok**（13 stages / 12 stages）。

### 4.2 ⚠️ 与 §8 草案的差异点（实施时会踩的）——本节是任务 3 最值钱的产出

#### 差异 1（**拦路石**）：子管线读不到 `${ENV:...}`，也不认 `connectionRef`

**现象**（第一次跑就撞上）：
```
error: ctl.foreach(...)[row 0]: page 5 (sentinel): REST HTTP transport to
       ${ENV:LAB_GW}/agi/api/nhsoft.user.ai.branch.find: Bad URL: RelativeUrlWithoutBase
```
占位符**原样**留在子管线里。

**根因（源码锚）**：`apply_env_pass()`（`crates/duckle-runner/src/main.rs:802`，注释 §793「Substitute
`${ENV:NAME}` placeholders across every node's properties」）**只被调用在整份文档上**——
调用点全在 runner：`main.rs:471/972/1758/1780`、`serve.rs:927/1282/3976`、`drift.rs:82`、`follow.rs:163`、
`pipetest.rs:66`——**没有一处作用于 `ctl.foreach` 从盘上读进来的子文档**。
`resolve_connection_refs()` 同病（调用点同样只在 runner 侧）。
引擎侧留给子管线的注入面是 `substitute_into_child()`（`connectors.rs:18410`），它合并的是
**workspace context 变量 + 调用点 substitutions**，源代码注释把这件事说得非常直白：

> `context_vars_for_workspace`（`connectors.rs:19220`）文档注释：
> *"Mirrors the frontend's buildContextVars so a sub-pipeline read raw from disk resolves the same
> `${...}` references the top-level pipeline does (**the parent arrives pre-resolved, a foreach /
> runjob child does not**)."*

**这意味着什么**：现重管线 `duckle/common/lemeng.branch.json` 里**满屏** `${ENV:ZOS_*}` /
`${ENV:LEMENG_TOKEN}` / `${ENV:SYSTEM_BOOK}` / `${ENV:SNAPSHOT}` / `${ENV:BATCH_ID}`——
**照 §8「子管线 = 现重管线逐字保留」抄，一跑就挂**，而且挂法是「URL 变成相对路径」这种最难认的形状。

**原生可行通路（只有两条）**

| 通路 | 机制 | 代价 |
|---|---|---|
| `${ITER_ITEM_<COL>}` 行值 | 窗口表的列被逐行代入子管线 JSON 文本（`lib.rs:2023-2027`） | 常量要当**数据**从父侧搬过去（父侧可以正常解析 `${ENV:}`）；**密钥会进行值** |
| **workspace context 变量**（本 lab 采用） | `repository.json` 里 `type:"context"` → `contexts/<id>.json` 的 `variables[]`，以 `${KEY}` / `${context.NAME.KEY}` 暴露给子管线；另有内建 `${workspace}` `${projectroot}` `${date}` | 需要往 console workspace 落一份 context 文件；**密钥落 context 文件 = 明文落盘**，与 §7.3「管线不碰密钥落盘」冲突 |

本 lab 走的是第二条：加 `repository.json` + `contexts/lab.json`，子管线里
`${ENV:X}` → `${X}`、`${ENV:LAB_LAB}` → `${workspace}`。改完一次跑通（见 §4.3）。

**⇒ 给 §1.1.7 / §8 的订正建议**：把「子管线 = 现重管线逐字保留」改成
**「子管线 = 现重管线，但 `${ENV:*}` 一律改写为 context 变量（或行值）」**；
并把「**密钥怎么进子管线**」作为一个**显式决策**开出去（四个选项与取舍见 §6.1 D1）。
**这一条不解决，L1 没有首航可能。**

#### 差异 2：§8 的身份门（`src.rest POST whoami`）对真网关**不可实现**

真 `whoami` 是 SSE（§3.4-2），而 `src.rest` 只会 `JSON.parse` 响应体。本 lab 做了**负对照**证明这一点：

```
pipelines/probe-sse-whoami.json（照 §8 写：POST /agi/mcp + responsePath=/result/content）
→ exit 1
error: whoami over SSE (real shape): query: REST response not JSON: expected value at line 1 column 1
```

（lab mock 的 `/agi/mcp` 就是按真网关的 `event: message\r\ndata: {...}` 帧复现的。）
引擎里**没有任何 SSE 解析**（全仓 `event-stream` 只命中 `duckle-runner/src/serve.rs:1296` —— 那是 console
**往外吐** SSE，不是解析）。

**可能出路（未验证，见 §6）**：`src.rest` 的 `rawResponseDestination`（把**解析前的原始体**写到本地/`s3://`）
+ `code.sql` 里按 `^data: ` 抠行再 `from_json`——属于「能表达但没实测」；
或者干脆**身份门留在平台/诊断层**（§7.3 本来就把「凭据↔账套配置治理」划归部署面）。
**但注意**：现薄壳的 `identity` 子命令是**真在用**的（`run-retail-day.sh:341-420`，dim 分支 L854-857 调它），
所以「搬到平台层」不是删掉它，而是换承载面。

#### 差异 3：末页（0 行）的 `src.rest` **必须显式声明 `schema`**

实测：
```
error: p5: query returned 0 records and no schema is declared to type an empty result
```
现重管线**每一页节点都带 `data.schema`**（13 列），正是为此。lab 子管线补上 schema 后才跑通。
⇒ **这条现重管线已经做对了，迁移时别顺手删掉 `schema`**（删了在第 1 页就满、自然页就空的今天**不一定立刻炸**，
但哨兵页一旦空就必炸——而哨兵页在真实余量下**恒空**，所以等于必炸）。

#### 差异 4：`continueOnFailure` 让「末尾判红」成立，但 `su` 的主输入**必须与 `fe` 解耦**

§8 把 `su`（汇总）画在 `fe` 下游。软 stage 语义是：`fe` 失败后**继续跑后面的 stage**（§4 / 实测生效），
**但 `fe` 的 view 根本不存在**（stage SQL 是 `CREATE OR REPLACE VIEW "fe" AS SELECT * FROM "w0"`，
错误发生在建 view **之前**）：
```
su: Catalog Error: Table with name fe does not exist!   ← 首次实现踩到
```
**改法（lab 已用，跑通）**：`su` 的主输入改接**窗口表 `w0`**，用 `a1 ← fe` 的 **trigger 边**保证定序
（`su` 同时有 `w0` 的 main 边与 `a1` 的 trigger 边，两者都满足才跑）。这样 `fe` 软失败时 `su` 照跑。
⇒ **§8 的 `su` 边要改**：数据来自窗口表，不是来自 foreach 的透传行。

#### 差异 5：`window` / `rows` 是 DuckDB 保留字，**必须引号**（§10 第 3 条复现）

```
su: Parser Error: syntax error at or near "window"
```
`SELECT DISTINCT "window" ... ON r."window" = w."window"` 才对。规则层也已复发一次。

#### 差异 6（顺带确认，与 §8 一致）

- `ctl.foreach` 顺序形**在首个失败行即中止**（`[row 2]`），剩余行**当轮不跑**——与 §3.3 一致。
  对「单窗失败不拖批」要**读准**：已成功窗的数据**不丢**、不重复请求；**未跑的尾窗靠下一次重试/下一次调度补**。
- `retryAttempts: 2` 是 **stage 级整体重跑**，靠子管线 per-item checkpoint 把成本收敛到失败窗（§3.2 D2 复现）。

### 4.3 跑通回执（四机制，逐窗请求日志）

完整日志：`out/l1-scenarios.txt`（含每场景的逐窗请求日志 + 收据 + 汇总）。

| 场景 | 断言 | 结果 | 证据要点 |
|---|---|---|---|
| **S1** 全绿 | 逐窗执行 | `exit 0` | 每窗 5 页（p5→p1）各一次；3 张收据各 `250,ok`；汇总 3 行全 ok |
| **S2** w03 恒 504 | 单窗失败不拖批 + 末尾判红 | `exit 1` | w01/w02 各 5 页成功、收据落地；w03 四次 504（两轮 stage 重试）；`sr`=1 行；**`rep` 先落盘**（3 行）**再 `g1` 判红**；汇总 `w03,0,missing` |
| **S3** 网关恢复后重跑（**不清 `state/`**） | 跨 run 只补失败窗 | `exit 0` | 访问日志**只有** `w03` 的 5 个请求 + 1 个 whoami；**零** w01/w02 请求；汇总三窗全 ok |
| **S5** `SYSTEM_BOOK=9999`（≠ 凭据账套 3120） | 身份门 + 先证后采 | `exit 1` | 访问日志**只有 whoami 一条**，**零** `branch.find`；无任何收据；`a0/w0/fe` 根本没跑 |

**S3 逐窗请求日志（原文）**
```
16|…|whoami|page-|200
17|…|w03|page5|200
18|…|w03|page4|200
19|…|w03|page3|200
20|…|w03|page2|200
21|…|w03|page1|200
```
**S2 汇总（原文）**
```
window,rows,status
w01,250,ok
w02,250,ok
w03,0,missing
```

**四机制判定：逐窗执行 ✅ / 单窗失败不拖批 ✅ / 跨 run 只补失败窗 ✅ / 末尾判红 ✅（exit 1 且收据先落盘）**
**额外：身份门「先证后采」✅（S5 零采集请求）**

---

## 5. 迁移后与现薄壳行为的**等价性对照表**

现薄壳两件：`deploy/duckle/console/pipelines/lemeng.dim.branch.run.json`（薄包装管线）
+ `scripts/lemeng/run-retail-day.sh` 的 `dim` 分支（L815-880；它自己起容器跑重管线）。
「L1 承担者」列里，**lab 已证**的标 ✅，**设计已写但 lab 未覆盖**的标 ⏳。

| # | 现薄壳做的事 | 现实现锚 | L1 里由谁承担 | lab 证据 | 判定 |
|---|---|---|---|---|---|
| 1 | `DIM_FACE` 合法性断言（branch\|item，否则 exit 2） | `run-retail-day.sh:823-830` | **拆成两条管线**（`lemeng.branch.l1` / `lemeng.item.l1`）⇒ 这个参数**消失**，不需要断言 | 父管线无此节点 | ✅ 消失 |
| 2 | `SNAPSHOT` 推导（`TZ=Asia/Shanghai date +%F`）+ `YYYY-MM-DD` 形状断言（exit 3） | `:835-843` | `ctl.setvar`（运行时 SQL `strftime`，§6 职责 #9）+ `qa.contract` 的 regex 形状闸 | ⏳ 本 lab 用小固定值走通链路；**TZ 版 setvar 未在本 lab 实测**（§6 已列） | ⏳ |
| 3 | `BATCH_ID` 铸造（`dim-<book>-<face>-<UTC 时刻>`） | `:857` | `ctl.setvar` 在父 run 内一次铸造 → 经 context 变量/行值传子 | ⏳ 同 #2（lab 固定值） | ⏳ |
| 4 | **容器编排**：`$COMPOSE run --rm` 每跑起一个新容器 + 一串 `-e` 注入 | `:858-861` | **整层消失**——父管线一个进程跑完，env 由 console 的 project env 注入 | ✅ 本 lab 单进程跑通整条父管线 | ✅ 消失（收益本体） |
| 5 | **身份自证**（`identity` 子命令；`IDENTITY_CHECKED` 去重 export） | `:341-420`、`:854-857` | 父管线 `v0 → v1 → g0`（探针 + 集合比对 + `ctl.die`），`a0` 锚点强制**先证后采**；去重需求随「单进程」消失 | ✅ S5（错配 → 零采集）；✅ S1（匹配 → 照采） | ⚠️ **表达力成立，但对真网关要先解决 SSE**（§4.2 差异 2） |
| 6 | 跑重管线 + 从 stdout 抠 `status` | `:862-864` | 子管线**就是**那条重管线；run 状态即结果，不需要抠字符串 | ✅ S1/S2 的 `fe` 状态 | ✅ |
| 7 | `_ops` 行（stdout + OO 投递；取不到 sink 行记 `null`，`OPS_ROWS_UNPARSED` 可见） | `:865-874`、`ops_emit_dim:331-338` | 汇总表 `su` → `rep` 落盘（每窗一行 `window,rows,status`）；**OO 投递通道**用 `snk.webhook` POST `_json` | ✅ 汇总表落地（S2 三行、S3 三行全 ok）；⏳ **OO 通道未实测**（§6） | 🟡 行数原生（正则解析整类问题消失）；**投递待验** |
| 8 | 退出码判红（`rc != 0 → exit rc`；薄管线再用 `qa.contract exit_code in_range:0,0` 兜一层） | `:875-876`、薄管线 `gate` 节点 | `ctl.die has-rows`（`g1`）+ 引擎退出码契约 0/1/2 | ✅ S2 `exit 1`、S1/S3 `exit 0` | ✅ |
| 9 | 容量哨兵（管线**内部** `ctl.die has-rows`，branch 第 5 页 / item 第 150 页） | 重管线 `guard` 节点；`run-retail-day.sh:819` | **原样保留在子管线里**（逐字搬） | ✅ 子管线 `guard` 节点在场并跑过（S1–S3 均 0 行通过） | ✅ 零改动 |
| 10 | 失败告警（`EXIT` trap + WeCom webhook，`LEMENG_NOTIFY=1` 门） | `:422-456`、`:683-684` | `ctl.try` 兜底子管线（`snk.webhook` → WeCom），装配点放管线头 | ⏳ **未实测**（§6） | 🟡 语义对口，待验 |
| 11 | 薄包装管线本身：`code.shell` → `qa.contract` → `snk.csv` 运行记账 | `lemeng.dim.branch.run.json` | 父管线直接挂调度（`crates/scheduler`），**整条薄管线删掉**；运行记账由 `rep`（汇总表）承接，run 记录由引擎自己的 run log/receipts 承接 | ✅ 父管线可单跑（S1 `exit 0`） | ✅ 消失 |
| 12 | 调度（console，UTC `0 2 * * *` / `0 11 * * *`） | 手册 §2 第 603 行 | **不迁**——调度本就在 console 侧，L1 只是把「挂哪条管线」从薄管线换成父管线 | — | ✅ 不变 |
| 13 | 诊断族（`probe/identity/listing/idem3/drift/recon/agg/rb/envfile`） | `run-retail-day.sh` 各分支 | **不进采集主链**（§7.3）；只把 `identity` 的面换承载（见 #5） | — | ⏳ 独立议题 |

**净收益（本 lab 规模）**：`run-retail-day.sh` 的 `dim` 分支 + 薄包装管线两层被父管线吸收；
**代价**：多一层子管线 + 子管线必须做 `${ENV:*}` 改写（差异 1）。

---

## 6. 未决项与建议

### 6.1 必须先决策（**阻塞 L1 首航**）

| # | 事项 | 为什么阻塞 | 建议 |
|---|---|---|---|
| **D1** | **子管线的密钥怎么进**（差异 1） | 不解决，子管线连 URL 都拼不出来 | 四个选项，需人拍板：<br>(a) **context 变量**（本 lab 用法）——最简洁，但密钥明文落 console workspace；<br>(b) **行值**（窗口表带常量列）——密钥进 run 行值与日志面，更差；<br>(c) **分层下传**：父→`ctl.foreach`→薄子管线→`ctl.runjob(contextVariables=[...])`→重管线，靠 `inherited_subs` 逐层继承（`connectors.rs:16406-16416`）。**它只搬「谁读得到」，不解决「值从哪来」**——最外层的值仍得来自行值或 context；好处是**重管线只需把 `${ENV:X}` 改成 `${X}`，不必改成 `${ITER_ITEM_X}`**。需实测；<br>(d) 让上游把 **`apply_env_pass` / `resolve_connection_refs` 也作用于子文档**（真正的修法，直接回喂）。 |
| **D2** | **身份门的承载面**（差异 2） | 真 `whoami` 是 SSE，`src.rest` 读不了 | 先做**最小实验**：`src.rest` + `rawResponseDestination` + `code.sql` 抠 `^data: ` 是否可行；不行则把身份门留在平台/诊断层（并明确它「不再是采集前闸」的后果）。若长期要做，回喂上游「`src.rest` 支持 SSE 解帧」。 |

### 6.2 需要生产侧小实验（本 lab 无法覆盖）

| # | 事项 | 建议实验 | 预期产出 |
|---|---|---|---|
| **P1** | **OO 投递通路**（引用 §7.2「我方待沉淀」） | 最简：一条只有 `snk.webhook` 的管线，POST 到 OO 的 `_json` 入口，看**端点/鉴权头/字段名**是否对得上现 `ops_emit_dim` 的 JSON（`ts/job/system_book/snapshot/face/rows/status`） | 一个能进仓的 `snk.webhook` 节点写法（或判定「需保留薄投递」） |
| **P2** | **WeCom 告警通路** | 最简：`ctl.try` + 兜底子管线（`snk.webhook` → 企微机器人）造一次失败，看是否真的发出、文案模板怎么给 | §7.2 第 12 行「待实测」销账 |
| **P3** | **`ctl.setvar` 的 TZ 版 SNAPSHOT/BIZDAY 推导** + `qa.contract` regex 形状闸 | 在 console 容器内跑 `ctl.setvar`（`TZ=Asia/Shanghai`）验证推导值与现薄壳逐日对齐（**跨零点**要点） | 对照表 #2/#3 从 ⏳ 转 ✅ |
| **P4** | **`continueOnFailure` 在真网关失败下的行为** | lab 已证软 stage 继续；生产侧再验一次「网关整段 504 时父 run 仍走到 `g1` 判红」 | 告警面不会哑 |

### 6.3 已知代价（接受，不修）

- **连败 ≥N 中止**：引擎无此概念（§3.3），按 2026-09-28 拍板**接受代价**（网关全挂时 24 窗快速失败，
  跨 run 补采保证正确性）。本 lab 的 S2 已复现「失败窗不拖累已成功窗」，缺的只是止损。
- **`src.rest.maxRetries`** 仍是广告未实现（§10 第 9 条）——请求级自愈用 stage retry + checkpoint 方言顶替（S2 里
  w03 的 4 次 504 就是「2 轮 stage 重试 × 1 页」），**别配 `maxRetries`**。

### 6.4 建议的下一步（给 Wave 1 首航）

1. 先拍 **D1**（子管线密钥通路）——这是唯一真正阻塞项。
2. **D1 定了**再按本报告 §4.2 的 6 条差异改草案，然后**新旧并行跑数日逐分对比**（手册 §1.1.7 Wave 1 口径）。
3. 并行推进 **P1/P2**（OO/WeCom）——它们不阻塞首航，但决定「观测/告警面」能否同时切。

---

## 7. 证据文件索引（全部在 `.tmp/wave1-lab/`，零生产）

| 文件 | 内容 |
|---|---|
| `out/e1-evidence.txt` | E1 跨 run 重写的分步证据（含 marker 存活） |
| `out/e1-content.txt` | E1 三种情形的读回内容 |
| `out/e1-object-list.txt` | 桶内对象清单 |
| `out/l1-scenarios.txt` | **S1/S2/S3/S5 全量回执**（逐窗请求日志 + 收据 + 汇总 + exit code） |
| `out/run-s{1,2,3,5}.out` | 各场景原始 stdout |
| `out/sse-probe.out` | 差异 2 的负对照（`src.rest` 读 SSE 失败） |
| `mockstate/access.log` | 逐请求事实源 `<seq>\|<ts>\|<window>\|page<N>\|<status>` |
| `pipelines/*.json` | E1 四条 + L1 父/子 + SSE 负对照 |
| `scenarios.sh` / `reset.sh` / `env.sh` | 复现入口 |
