# 数据面 duckle console 的声明式定义（调度下沉）

> 上位决策：`openship-platform` 仓 **ADR-0014**（业务调度改用 duckle 自带调度器）。
> 实施步骤与全部实测证据：`docs/superpowers/plans/2026-09-26-lemeng-scheduling-via-duckle.md`。

本目录放**每个账套的 console 需要的东西**，由部署步骤 **seed 进该账套的 workspace 卷**
（console 只认自己 workspace 里的 `schedules.json` 与 `pipelines/`）：

| 文件 | 是什么 |
|---|---|
| `pipelines/lemeng.dim.branch.run.json` | **薄管线**：跑门店维（单 `code.shell` 节点调 `/opt/lemeng-run.sh dim`） |
| `pipelines/lemeng.dim.item.run.json` | 薄管线：跑商品维 |
| `schedules/3120.json` | 账套 3120 的调度定义（门店维 UTC 02:00 / 商品维 UTC 11:00） |
| `schedules/64188.json` | 同上（账套 64188） |

**为什么是「薄管线」而不是把守卫搬进管线**：见计划 Task 2 的留档 —— `ctl.setvar` 的值
**不能用在 sink 路径中间**（引擎发 SQL 拼接，写文件语句的目标路径不接受表达式），
而 dim 的 `…/snapshot=<日期>/all.parquet` 正是路径中间 ⇒ 日期这类「每天变」的值必须**编译期**来自环境。
⇒ 仍由 `/opt/lemeng-run.sh` 按显式时区算好再传进去，**dim 管线一行不改**（S3-a 刚验证过）。
宿主与容器**共用同一份守卫逻辑**（脚本加了个 `LEMENG_IN_CONTAINER=1` 的调用模式，见 PR #224）。

## ⚠️ 薄管线为什么必须长这样（三条实测依据，缺一条就是静默错）

1. **`code.shell` 不会因非零退出让管线失败。**
   实测：节点 `exit 3`，整条管线仍报 `status: ok` —— 退出码只是**一行数据**。
   ⇒ 必须跟一个 **`qa.contract`** 判红：`rules = { exit_code: "in_range:0,0" }`
   （落地报错长这样：`Data contract violated: in_range(exit_code, 0.0, 0.0): 1 row(s) failed`）。
   用 `in_range:0,0` 而**不是** `in_set:0` —— 前者在本仓生产管线里已在用，后者未验证。

2. **判据后面必须有 sink，否则判据根本不被求值。**
   实测：引擎是**惰性**的（预览里每个节点 `kind` 都是 `view`）。`gate` 当叶子时，
   `exit 3` 照样 `status: ok` —— **判据形同虚设**；补一个 sink 之后才报错。
   ⇒ 薄管线**必须以 sink 收尾**（这里用 `snk.csv` 落到 `/workspace/logs/`，顺带当运行记录）。

3. **console 必须显式给 `--duckdb`。**
   实测：不给时每次触发都记 `last_run_error: "DuckDB engine isn't installed yet."`（管线没跑起来）。

## 失败告警怎么接（2026-09-26）

**接在 wrapper 里，不接在管线的 `ctl.try`** —— 因为 `ctl.try` 的配置**未建模**（schema 只有 `notes`），
靠猜属性名配它得到的会是「**静默不生效**」。wrapper 里一个 `EXIT` trap 覆盖**所有**失败路径，
且**只有一份代码**。

- 只在该变量为 `1` 时告警：`LEMENG_NOTIFY`（**薄管线会设它**）⇒ 人工/诊断跑失败不刷告警群
  （噪声会让人开始忽略告警，那比没有告警更坏）；
- 通道：企微机器人 webhook，URL 走 **project env 的 `WECOM_WEBHOOK_URL`**；
- 缺 URL 时打 `NOTIFY_SKIPPED`（**不静默**）；**告警绝不改退出码**（别把判红变成绿）。

## 引擎原生告警 `alerts.json`（2026-09-27；链路经 OpenObserve，端到端实测通过——末跳群侧两条消息为目视确认开环）

**与上面那条并存，不替换** —— 两条覆盖不同的面：

| | wrapper 的 `EXIT` trap（上一节） | 引擎原生 `alerts.json`（本节） |
|---|---|---|
| 覆盖 | 「wrapper 自己判红」（采集/自证失败） | 「引擎把这次 run 记成非 ok」——**含 wrapper 之前就失败的路径**（源不存在、DuckDB 起不来、判据失败…），这些 wrapper 看不见 |
| 门槛 | 仅 `LEMENG_NOTIFY=1`（薄管线会设）⇒ 人工/诊断跑不刷群 | 无门槛：打进这个 console 的 run 都算 |
| 凭据 | project env `WECOM_WEBHOOK_URL` | OO 三键：project env `OO_BASE`/`OO_ORG`/`OO_AUTH(isSecret)`（与数据面机 `/etc/openobserve-ingest.env` 同名同值——那份是**宿主**凭据面，容器不读它，容器侧走 openship project env 整体注入） |
| 事件 | 只有失败 | `failure` + `recovery`（恢复通知**不受冷却压制**，源码 `Event::is_all_clear`） |

- **投递链路（2026-09-27 用户拍板 + 端到端实测通过；机器侧证据止于 OO 告警 firing——企微群侧两条消息为目视确认开环，见 #210 待确认项）**：引擎 POST → OO JSON 摄取
  （`${ENV:OO_BASE}/api/${ENV:OO_ORG}/data_alerts/_json`，`Authorization: Basic ${ENV:OO_AUTH}`）
  → OO 告警（org=miyuan，**scheduled 1 分钟频次**两条：`data_alerts_failure` / `data_alerts_recovery`
  ——⚠️ realtime 评估器在本部署实测**不触发**（现存 12 条生产告警也全是 scheduled），故用调度频次，
  延迟 ≤1 分钟；silence 10 分钟与引擎冷却 15 **刻意错开**；分两条是因 OO 条件只 AND 不能 OR，
  合并会把恢复消息用 silence 存没）
  → OO 目的地 `data_alerts_wecom`（http 模板 `data_alerts_wecom_markdown`＝企微 markdown 形状；
  **企微群机器人 URL 只存 OO 服务端，不进仓**）→ 企微群。
  证据链与三跳排障口径（流里见行 / 告警触发记录 / 目的地投递错误）见 issue #210 终态评论与
  `alerts.json` 头注。旧案「引擎直发企微 errcode 40008 假绿」与「经 Novu 落个人」均已推翻（路线对比见 #210）。
- **文件位置**：`deploy/duckle/console/alerts.json` → seed 进该账套 workspace 卷的 **`/workspace/alerts.json`**
  （**不在** `/workspace/pipelines/` 里）。字段语义、冷却计法、凭据来路都写在**文件头的 `_note`**
  （serde 无 `deny_unknown_fields` ⇒ 未知键被忽略；实测无 parse 报错）。
- **生效动作**：`/workspace` 是卷 ⇒ 与 `schedules/`、`pipelines/` 同类，**seed + 重启容器**即生效
  （SOP §F.2 第 1 类，**不必定向部署**）。更强的一条：`alerts::load()` 在**每次 notify 时现读盘**
  ⇒ 严格说连重启都不需要。**但 seed 那步不能漏**——漏了 = 改了没生效**且不报错**。
  （改 **env 键**另说：env 是容器创建时注入 ⇒ 必须 refresh 重建容器才拿到新值，2026-09-27 实测。）
- **🔴 覆盖边界**：只覆盖**打进这个 console 的 run**（`/workspace/pipelines/` 下的薄管线）。
  **零售的每日生产 run 走 openship job、落在另一个卷 ⇒ 本规则看不到它**，零售面告警待 W2。
  **别把本文件读成「采集全链路的告警」。** 另：账套 **64188 的卷尚未 seed 这版**（要不要切是独立决定）。

## L0 形态管线的观测面与排障口径（2026-09-28 Wave 1；#276）

> **本节只放口径与指针**；阈值理由 / 取舍正文在 `alerts.json`、`owners.json` 两个文件的 `_note`
> （⑨ / ⑧），以及管线自己的 `_note` ⑧。**有冲突时以那三处为准**（本节不复制正文）。

L0 形态（一条管线替代「薄管线 + shell + 重管线」，正典 §1.1.7）**没有 `snk.csv` 运行记录**。
首例 = `pipelines/lemeng.dim.branch.l0.json`。三件事各归谁：

| 面 | 落点 | 备注 |
|---|---|---|
| **运行记录 / 排障入口** | **引擎回执**（`runs/receipts/`） | 不是文件凭证——回执由引擎自产，**不用投递**（正典 §1.6 派生物表） |
| **失败告警** | `alerts.json` 的 `lemeng.dim.*.l0` 规则 | ⚠️ 按**形态末段**分组，不是宽 glob；取舍见 alerts.json ⑨ |
| **新鲜度 SLA** | `owners.json` 的湖对象条目（`snk.minio` 目标） | 过渡期两套资产并存，形状见 owners.json ⑧ |

### 排障三问怎么答（L0 管线，容器内经 openship MCP 的容器执行端点）

| 问 | 答法 |
|---|---|
| **今天跑没跑** | `runs/receipts/` 里 `run-*<pipeline_id>*.json` 的 `startedAt`（⚠️ 判触发看 `startedAt`，`schedules.json` 的 `last_run_at` 是**完成**时刻） |
| **几行** | 同一份 receipt 的 `nodes.sink.rows`（= 落湖行数） |
| **什么状态** | receipt 的 `status` + 逐节点 `nodes.<id>.status/rows/durationMs`；逐节点时间线看 `logs/<pipeline_id>/runtime.log`（每次 run 首尾各一行 `run_started`/`run_finished`） |

一条命令答完三问（容器内 `python3` 恒在，不必装 `jq`）：

```sh
python3 -c "import json,glob,os;fs=glob.glob('/workspace/runs/receipts/*branch_l0*.json');f=max(fs,key=os.path.getmtime);r=json.load(open(f));print(os.path.basename(f),r['status'],r['startedAt'],'sink_rows=',r['nodes']['sink']['rows'])"
```

⚠️ **回执有保留上限**（`runs/receipts/` 200 条、`runs/` 50 条/管线——正典 §1.6）⇒ 它是**近期**
排障入口，不是长期审计账。日频管线 ≈ 200 天。

### 🔴 新增 L0 管线的硬前置：**重建 catalog**

`owners.json` 的新鲜度**依赖 catalog**（见其 ②）：catalog 是**静态扫描 `pipelines/` 的产物**、
不是每次 run 现推 ⇒ **管线文件进卷后不重建 catalog，该管线的 run record 整条不带 `assets` 字段**
（2026-09-28 实测：三次 L0 run 的 receipt 全无 `assets`，而同日薄管线正常带）。
⇒ 新 L0 管线**上线清单必须含**：

1. seed 管线 + seed `alerts.json` / `owners.json`（同路，进 `/workspace/`）+ 定向重建容器；
2. **重建 catalog**（Operator `POST /api/catalog`，或容器内 `duckle catalog build --workspace /workspace`）；
3. 跑一次成功 run，确认**新回执带 `assets`** ⇒ 新鲜度时钟才起算（历史回执**不追溯**补）。

⚠️ 自查「规则挂上没有」按 `owners.json` ⑤：freshness.json 里该资产**出现且非 unknown**；
恒 `unknown` = 规则没挂；恒 `stale` 而管线确在成功跑 = 时钟没起算（查第 2 步）。

## ✅ 调度器的实测事实（2026-09-26，本地真跑）

| 事实 | 证据 |
|---|---|
| **cron 按 UTC 解释** | 登记于 `06:54:22Z` → 触发于 `06:55:03Z`；容器 TZ 实测为 **UTC** |
| **会重复触发**（不是只跑一次） | `last_run_at` 从 `06:57:03Z` 走到 `06:58:03Z`；serve 日志两条 `scheduled tick -> ok` |
| 失败**如实入账** | 失败时 `last_run_status=error` + `last_run_error=<原因>`（不是静默绿） |
| ⚠️ **`/api/schedules` 的 GET 只回定义、不回运行状态** | 它返回**以 `pipeline_id` 为键的字典**（**不是数组**），每条字段是 `{id, enabled, cron, intervalSeconds, intervalMinutes, planId, timezone, exclude, misfire, catchup}`——**没有任何 `last_run_*`** ⇒ 观测要读 `schedules.json` 或 serve 日志，别信那个 GET。<br>✅ **但它适合自证「定义加载了没」**：GET 到的条目数与 seed 的一致即生效（2026-09-26 实测：零售条目 seed + 重启后即出现在 GET 里，并带上了 console 补的 `misfire`/`catchup`） |
| `next_run_at` 对 cron 恒为 `null` | 不是故障（interval 形态才有） |

## 为什么「一账套一个 workspace」

- 调度条目**带不了自己的环境变量**（实测：提交时塞 `env`/`args`/`params` 会被**静默丢弃**）
  ⇒ 一个 console 进程只有**一套**凭据；
- 而 `LEMENG_TOKEN` 是**按账套绑定**的 ⇒ 两账套共用一个 console，必然有一个拿到错 token，
  且会**静默采错数据**（不是报错）。
⇒ 两个账套 = 两个 workspace = 两个 console 服务，各自一份 env（见计划 Task 3）。
