# 采集管线（本目录）· 图与读图约定

> **性质**：本目录的图是**地图**，不是正典。规则与判据以 `docs/data-platform-handbook.md` §1.1.7（形态与选型）
> 与各管线自己的 `_note`（方言细节）为准；投递程序见 `deploy/data-plane-deploy-sop.md` §E / §F.2。**本文件不复制正文。**
> **新增管线往哪放、叫什么名**：见 `docs/superpowers/plans/2026-10-05-collection-layout-convention.md`
>（**本目录永远平铺；新源系统加文件名前缀，不加子目录**）。

## 读图约定：**每个节点归三档之一**

| 档 | 怎么认 | 在**管线里**是什么 | 在**管线外**是什么 |
|---|---|---|---|
| **① 纯 duckle** | 组件自带全部行为，**我们只给参数/连线** | `ctl.foreach`（循环 + 并发 + 重试）· `ctl.merge` · `ctl.anchor` | 调度器（cron / misfire / catchup）· 运行记录与回执 · 新鲜度时钟 · catalog · 运行锁 · 节点级重试退避 |
| **② 载体是 duckle 组件，规则/配置是我们填的** | 机制是它的，**内容是我们的** | `src.rest`（分页 / 重试 / SSE 落盘是它的）· `ctl.die`（判定与阻断是它的）· `qa.contract`（求值是它的）· `snk.minio` / `snk.csv` / `snk.webhook`（写入是它的） | 保存的连接（`connections/`）· `schedules/<账套>.json` · `owners/alerts.<源系统>.json` |
| **③ 纯手写代码** | 组件只当**执行壳**，逻辑 100% 是我们写的 | **全部 `code.sql` 节点**（身份解析 / 断言 / 窗口表 / 定型 / 汇总 / `_ops` 行） | 机器上的脚本（`/opt/lemeng-*.sh`、`connection-setup.py`）· CI 守卫 · openship jobs |

**一句话**：**编排骨架是它的（①）· 规则与配置是我们填进去的（②）· 业务逻辑是我们写的（③）。**

**管线里没有自研组件**：③ 在管线里**只能**是 `code.sql` —— 引擎提供的 SQL 执行壳，逻辑全在里面。
（历史上那支 1021 行的 shell wrapper 已退役 ⇒ 管线外也没有自研执行链。）

## 图按【源系统】分，不按客户

| 源系统 | 图 | 管线文件名前缀 |
|---|---|---|
| **乐檬**（nhsoft AGI/MCP） | [`FLOW.lemeng.md`](FLOW.lemeng.md) | `lemeng.*` |
| （下一个源系统来的时候加一行） | `FLOW.<源系统>.md` | `<源系统>.*` |

**为什么按源系统、不按客户**：管线的**语义**（端点 / 契约 / 分页 / 窗口 / 方言）由**源系统**决定；
**客户与账套只是参数** —— 落在 `env` + 保存的连接 + 每账套一份的排班文件里。
按客户命名会得到 **N 份同一张图**，且客户一变就要改 N 处。
⇒ **图按源系统一份；客户差异在那一份里以「参数」的身份出现。**

## 引擎替掉了什么（旧 shell / wrapper 的职责对照）

| 过去 shell / wrapper 的职责 | 现在谁干 |
|---|---|
| 24 时窗循环、逐窗起新容器 | `ctl.foreach` |
| 逐窗失败登记不拖垮整批 + 末尾判红 | 单窗收据 CSV + `ctl.die` |
| 凭据↔账套自证（whoami 解析 + 比对） | `src.rest`（xml + raw 落盘）+ `code.sql` + `ctl.die` —— **已原生化，四条护栏一条不少** |
| 页数 / 容量阈值、末页哨兵 | `src.rest` 分页 + `ctl.die` 哨兵 |
| 重试 / 退避 | 引擎节点级 `retryAttempts` / `retryBackoffMs` |
| 幂等（同批重跑逐字节一致） | `batch_id` + 单对象覆盖写（key 不含 run_token） |
| 调度（几点跑 / 补跑语义 / 时区） | console 调度器 `cron` / `misfire` / `catchup` |
| 运行记录 / 回执 / 新鲜度 / catalog | 引擎产物 + `owners.json` |
| 观测行投 OO | `snk.webhook`（tick / windows / close 三条；**L0 两条按决定不做**，见 issue #414） |

## 维护约定

- 改了任何管线的节点/边 ⇒ 改**对应源系统**的那份 `FLOW.<源系统>.md`，并重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`；
- 新增源系统 ⇒ 加 `FLOW.<源系统>.md` + 在上表登记（与管线的文件名前缀同步）。
