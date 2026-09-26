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

## ✅ 调度器的实测事实（2026-09-26，本地真跑）

| 事实 | 证据 |
|---|---|
| **cron 按 UTC 解释** | 登记于 `06:54:22Z` → 触发于 `06:55:03Z`；容器 TZ 实测为 **UTC** |
| **会重复触发**（不是只跑一次） | `last_run_at` 从 `06:57:03Z` 走到 `06:58:03Z`；serve 日志两条 `scheduled tick -> ok` |
| 失败**如实入账** | 失败时 `last_run_status=error` + `last_run_error=<原因>`（不是静默绿） |
| ⚠️ **`/api/schedules` 的 GET 不回运行状态** | 文件里已有 `last_run_at`，GET 却一直返回 `null` ⇒ **观测要读 `schedules.json` 或 serve 日志**，别信那个 GET |
| `next_run_at` 对 cron 恒为 `null` | 不是故障（interval 形态才有） |

## 为什么「一账套一个 workspace」

- 调度条目**带不了自己的环境变量**（实测：提交时塞 `env`/`args`/`params` 会被**静默丢弃**）
  ⇒ 一个 console 进程只有**一套**凭据；
- 而 `LEMENG_TOKEN` 是**按账套绑定**的 ⇒ 两账套共用一个 console，必然有一个拿到错 token，
  且会**静默采错数据**（不是报错）。
⇒ 两个账套 = 两个 workspace = 两个 console 服务，各自一份 env（见计划 Task 3）。
