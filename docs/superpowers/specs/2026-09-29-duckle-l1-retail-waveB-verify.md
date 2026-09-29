# Wave B 双点火兜底验证报告

> 2026-09-29 ｜ Orca worker `task_d4ae3d13d907`（dispatch `ctx_7fc9b7c8f6d6`）
> ｜ 本 worktree `platform-core/waveB-verify`（分支 `ylwzzs/waveB-verify`）
> ｜ 被验对象：`/Users/duo/orca/workspaces/platform-core/waveB-retail` @ `9e2fe3c`（分支 `feat/waveB-retail-l1`）的两条管线
> `deploy/duckle/console/pipelines/lemeng.retail.windows.l1.json`（父）+ `lemeng.retail_order_line.window.json`（子）
>
> **全部活动在本机 lab**：`/tmp/waveB-lab/`（mock 网关 `127.0.0.1:8899` + 回环 MinIO `127.0.0.1:9900`，桶 `lemeng-lab`）。
> **零生产写入**：未打真网关、未投递、未进 console/湖/生产调度、未外发、未改仓内任何文件。
> 唯一被改动的二进制是 `duckdb` 的一份**副本**（见 §1.3），原件未动。

---

## 0. 一句话结论

**双点火兜底成立，但有三条前置条件，且其中一条会让它静默失效。**

- ① **跨 run 只补缺口——成立，且细到页**：第 1 轮 hour=07 持续 500 ⇒ 07 失败、**08..23 零请求（截尾）**、run 红；
  第 2 轮解除故障后 ⇒ 00..06 **零请求**、07 **只补 page1 一页**、08..23 全补齐，run 转绿、24 窗全 ok。
  两轮合计 **293** 个请求；同一份工作若不用 checkpoint，第 2 轮光重采一轮就要 **289**（实测基线）。
- ② **两次点火的 bizday 同一个——成立**：UTC 02:30 与 10:30 两次点火，窗口表 `bizday` 都是 `2026-09-28`（= 该时刻的上海昨天），逐字相同。
  安全边界实测：UTC **< 16:00** 即安全；**16:00 整点翻到 09-29**。
- ③ **一条 cron 真的点火两次——动态实测成立**：cron `30 2,10 * * *`（tz=UTC）在本机 `duckle serve` 跨时钟两次点火点，
  观察到**恰好两次 run**（账本 `scheduledFor` 分别是 02:30 与 10:30），不重复、不多余。

**建议的 cron**：`30 2,10 * * *` 并**显式钉 `"timezone": "UTC"`**（理由与边界规则见 §4）。

**⚠️ 会静默失效的一条（必须知情）**：调度器的 `misfire` 默认是 `skip`——若第二次点火那一刻**进程不在跑**，
补跑逻辑会把这次 occurrence 记为 `skipped` 而**不执行**，双点火就少了一次、缺口不会被补。见 §4.3。

---

## 1. 方法与环境

### 1.1 被验对象与判据

| 项 | 值 |
|---|---|
| duckle | 0.7.4（`/private/tmp/duckle-lab-p1/.venv074/bin/duckle`，与 `deploy/duckle/Dockerfile` 的 `ARG DUCKLE_VERSION=0.7.4` 一致） |
| DuckDB | 1.5.5（同 venv） |
| mock 网关 | `/tmp/waveB-lab/mock/mock_gateway.py`（仅绑回环 `127.0.0.1:8899`；`/control/fail` 可按 (hour,page) 注入故障） |
| 对象存储 | `minio/minio` 容器，仅绑 `127.0.0.1:9900`，桶 `lemeng-lab` |
| 驱动 | `/tmp/waveB-lab/verify.py`（本轮新写）+ `exp1.sh` / `exp2b.sh`；沿用上一轮 worker 的 lab 变体规则（只改 URL 主机 / 工作区根 / 退避 60s→200ms，无行为改动） |
| 证据 | `/tmp/waveB-lab/evidence/V1a-*.access`、`V1a-*-summary.csv`、`V2-*.out`、`V2b-*.access`、`V3-serve/*` |

### 1.2 时间钉法（本报告的关键手法差异）

本报告的 ②③ 需要把**引擎时钟**钉到指定瞬时。实测下来有两条**互斥**的通路，必须说清楚用了哪条、为什么：

- **通路 A：libfaketime（能钉，但与 S3 冲突）**。被钉的时钟同时进入 runner 与 DuckDB。
  但 S3 请求签名带时间戳，MinIO 校验 ±15 分钟 ⇒ **时钟一钉，落湖就报
  `RequestTimeTooSkewed … Forbidden (403)`**。⇒ **凡是要写湖的场景，不能用 faketime。**
- **通路 B：SQL 层钉 `now()`**（`derive --now '<ts>'` 把 `now()` 文本替换成固定 `TIMESTAMPTZ`）。
  S3 用真实时钟 ⇒ 落湖正常。这是上一轮 lab 已在用的手法（`S7-bizday-*`）。

**分配**：
- **①（要写湖）** ⇒ 真实时钟两轮，靠「两轮都在同一个上海日历日内」保证 bizday 相同（并在日志里核对 bizday 列）。
  这不损失结论：① 验的是 checkpoint **指纹**，而指纹里没有任何「墙钟时刻」成分（除 bizday 外）——这一点由 §2.5 的反例单独证明。
- **②（不写湖）** ⇒ 用 `--target w0` 只跑到窗口表就停，**全程不碰 S3** ⇒ 可以安全用 faketime，把时钟精确钉到两个点火瞬时。
- **③（不写湖）** ⇒ 平凡管线 + 本机 `duckle serve`，sink 是本地 CSV ⇒ 安全用 faketime。

### 1.3 一处 lab 专有的二进制处理（必须知情，非生产改动）

DuckDB 官方二进制带 **hardened runtime**（`codesign -dv` 显示 `flags=0x10000(runtime)`），
macOS 会忽略 hardened 进程的 `DYLD_INSERT_LIBRARIES` ⇒ **faketime 钉不到 `now()`**。
做法：把 duckdb **复制一份**到 `/tmp/fk-test/duckdb-re`，对**副本**用
`codesign --force --sign - --entitlements`（加 `allow-dyld-environment-variables` / `disable-library-validation`）重签。
**原件未动**，且这只影响 lab；生产无此需求。`duckle-runner` 本身是 `adhoc, linker-signed`（非 hardened），直接可注入。

### 1.4 一处必须避开的坑（否则整场实验是假绿）

`nohup`（`/usr/bin/nohup`，受 SIP 保护）会**剥掉 `DYLD_INSERT_LIBRARIES`**——经它起的后台进程**根本没有被 faketime 注入**，
表现为「调度器看着好好的、就是到点不点火」。本报告 ③ 的后台 `duckle serve` 一律**不经 `nohup`**，
并以「run 记录里的 `${datetime}` 是否等于钉住的时刻」自证注入生效（见 §3.3 的自证行）。

---

## 2. ① 跨 run 只补缺口（承重证据）

### 2.1 两轮的事实

| | 第 1 轮（注入 `hour=07 / page=1` 持续 500） | 第 2 轮（`/control/failclear`，**保留**同一 workspace 的 checkpoint 状态） |
|---|---|---|
| run 状态 | `error`，`exit 1` | `ok`，`exit 0` |
| whoami | 1 次 | 1 次 |
| 业务请求 | **98** | **193** |
| 合计 | **99** | **194** |
| 汇总表 | 窗口：missing 17、ok 7（共 24 窗） | 窗口：ok 24（共 24 窗） |
| 湖上对象 | —（07 未落盘） | `bizday=2026-09-28` 下 **24** 个 hour 对象 |

第 2 轮的 194 = `whoami ×1` + `hour07/page1 ×1` + `hour08..23 ×12`（=192）。
**`hour00..06` 与 `hour07` 的 `page2..12` 一共 95 个请求，一条都没发**——全部按 checkpoint 复用。

### 2.2 第 1 轮 逐窗×逐页

### 第 1 轮 逐窗×逐页状态（窗=hour，页=page1..12；`–`=该页未发起请求）

| 窗 | p1 | p2 | p3 | p4 | p5 | p6 | p7 | p8 | p9 | p10 | p11 | p12 | 请求数 | 终态 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 00 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 01 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 02 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 03 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 04 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 05 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 06 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 12 | ok |
| 07 | 500×500×500 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 200 | 14 | fail |
| 08 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 09 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 10 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 11 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 12 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 13 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 14 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 15 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 16 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 17 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 18 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 19 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 20 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 21 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 22 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |
| 23 | – | – | – | – | – | – | – | – | – | – | – | – | 0 | **未采（截尾）** |

第 1 轮的「截尾」形状与上一轮报告 §4.2-2b 完全一致：hour=07 的 page1 被尝试 **3 次**（`retryAttempts: 4` ⇒ 3 次子管线 run），
`page2..12` 首次即 200；**hour 08..23 一次请求都没有**。汇总表把 07..23 记成 **missing（17 窗）**，
`dz` 判红 ⇒ 整批 `exit 1`。

**「不落残缺对象」这一条另做了干净桶复验**（`V1c`；lab 的 `reset` 不清 MinIO 桶，不清桶会让上一轮的旧对象冒充本轮结果 —— 第一次做时确实被这个坑骗到，已纠正）：
先删掉 `bizday=2026-09-28` 整个前缀确认 **0 个对象**，再跑故障轮 ⇒ 落盘 **恰好 7 个对象**，目录只有 `hour=00..06`，
**hour=07..23 一个对象都没有**。⇒ 失败窗不会在湖上留半成品。

### 2.3 第 2 轮 逐窗×逐页

| 窗 | p1 | p2 | p3 | ... | p12 | 请求数 | 终态 |
|---|---|---|---|---|---|---|---|
| 00 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 01 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 02 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 03 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 04 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 05 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 06 | 无请求（checkpoint 复用） | | | | | 0 | ok |
| 07 | p1 单发补采 | | | | | 1 | ok |
| 08 | 全 12 页 | | | | | 12 | ok |
| 09 | 全 12 页 | | | | | 12 | ok |
| 10 | 全 12 页 | | | | | 12 | ok |
| 11 | 全 12 页 | | | | | 12 | ok |
| 12 | 全 12 页 | | | | | 12 | ok |
| 13 | 全 12 页 | | | | | 12 | ok |
| 14 | 全 12 页 | | | | | 12 | ok |
| 15 | 全 12 页 | | | | | 12 | ok |
| 16 | 全 12 页 | | | | | 12 | ok |
| 17 | 全 12 页 | | | | | 12 | ok |
| 18 | 全 12 页 | | | | | 12 | ok |
| 19 | 全 12 页 | | | | | 12 | ok |
| 20 | 全 12 页 | | | | | 12 | ok |
| 21 | 全 12 页 | | | | | 12 | ok |
| 22 | 全 12 页 | | | | | 12 | ok |
| 23 | 全 12 页 | | | | | 12 | ok |

第 2 轮 24 窗全 `ok`，汇总表 `run_token` 24 行**同一个值**（一次 run 一个 run_token，与设计一致）。
湖上复验（`V1c` 第 2 轮后，经 S3 API 读回）：

| 判据 | 值 |
|---|---|
| 对象数 / 覆盖 hour | 24 个对象，24 个 hour 全覆盖 |
| 总行数 | 144（= 24 窗 × 6 行） |
| **逐 hour 的 `batch_id` 数 ≠ 1 的 hour** | **0**（该 recon 判据成立） |
| `batch_id` 样本 | `retail-3120-20260929T010045Z-00`，其 `20260929T010045` **正是本轮收据里的 `run_token`** |

⇒ 24 个窗口**都被这一轮重写**（含 checkpoint 复用的 00..06）⇒ 全天对象同属一次 run，`batch_id` 口径自洽。

### 2.4 合计数、以及「不用 checkpoint 会是多少」

| 项 | 值 | 来源 |
|---|---|---|
| 第 1 轮 | **99** | 实测 |
| 第 2 轮 | **194** | 实测 |
| **两轮合计** | **293** | 实测（= 293 行访问日志） |
| 干净状态跑一轮全量（= 第 2 轮若**不用** checkpoint 的成本） | **289** | 实测（`V1b-baseline`：1 whoami + 24×12 posorder） |
| 因此第 2 轮省下 | **95 个请求（33%）** | 289 − 194 |
| 若要给「两轮都不用 checkpoint」的合计 | ≈ **410** | **算术**（第 1 轮 hour07 三次尝试各重发 12 页 ⇒ 121；121 + 289）。**未本机实测**，标注为推算 |

### 2.5 反例：bizday 一变，checkpoint 立刻失效（这条把 ① 和 ② 焊在一起）

`V2b`：先在干净状态跑一轮全绿（bizday 现算 = `2026-09-28`），**保留 state**，
再把 `now()` 钉到 `2026-09-29T18:30Z`（⇒ bizday = `2026-09-29`）重跑：

| 轮 | 请求数 | bizday（访问日志实际带的 `date_from`） |
|---|---|---|
| V2b-1（bizday 2026-09-28） | 289 | `2026-09-28` ×288 |
| V2b-2（同 state，bizday 2026-09-29） | **289** | `2026-09-29` ×288 |

**热 state 之下，零复用**——证明 checkpoint 指纹里**含 bizday**（子管线请求体里的 `date_from`/`date_to`）。
这就把 ② 的边界从「bizday 读数是几」升级为「**bizday 一变，兜底就整个不工作**」。

---

## 3. ② 两次点火 bizday 是否同一个「上海昨天」

### 3.1 读数（`--target w0`，只跑到窗口表就停，不写湖）

管线里 bizday 的表达式（父管线窗口表 `w0`，本 Wave 的实现）：

```sql
strftime((now() AT TIME ZONE 'Asia/Shanghai') - INTERVAL 1 DAY, '%Y-%m-%d')
```

把引擎时钟分别钉到下列瞬时，读 `w0` 的 24 行：`bizday` 列**24 行全同值**（下表取该唯一值）。

| 点火瞬时 (UTC) | 上海墙钟 | 24 行里的 `bizday` | 该时刻的「上海昨天」 | 判定 |
|---|---|---|---|---|
| **2026-09-29 02:30:00** | 2026-09-29 10:30 | `2026-09-28` | 2026-09-28 | ✅ |
| **2026-09-29 10:30:00** | 2026-09-29 18:30 | `2026-09-28` | 2026-09-28 | ✅ **与上一行相同** |
| 2026-09-29 15:59:00 | 2026-09-29 23:59 | `2026-09-28` | 2026-09-28 | ✅ 边界内最后一分钟 |
| 2026-09-29 **16:00:00** | 2026-09-30 00:00 | **`2026-09-29`** | 2026-09-29 | ⚠️ **翻车点** |
| 2026-09-28 16:00:00 | 2026-09-29 00:00 | `2026-09-28` | 2026-09-28 | ✅ 安全窗下沿 |
| 2026-09-28 15:59:00 | 2026-09-28 23:59 | `2026-09-27` | 2026-09-27 | ✅ 下沿之外（目标变成另一天） |

⇒ **两轮点火（02:30Z / 10:30Z）的 bizday 逐字相同，且都等于该时刻的上海昨天。② 成立。**

### 3.2 安全边界（写给以后改 cron 的人）

记 `bizday(T) = date(上海(T)) − 1 天`。则

> **`bizday(T1) == bizday(T2)` ⟺ `T1`、`T2` 落在同一个「上海日历日」内 ⟺ 区间 `(T1, T2]` 里没有上海零点。**

上海零点 = **UTC 16:00**，于是：

- **cron 以 UTC 求值**（本项目的实际情况，见 §4.2）：
  小时列表里的**所有**时点必须落在 **16:00Z 的同一侧**。
  - 全部 `< 16` ⇒ 两次都取「上海昨天」，**这是我们要的**；
  - 全部 `≥ 16` ⇒ 两次都取「上海今天」（另一个语义，另一次批）；
  - **混着写（例如 `30 10,20 * * *`）⇒ 两次点火目标日不同**：第一次取 D−1、第二次取 D。
    后果有两层且都静默：第二次跑的是**另一天的数据**，且因为 bizday 已变，**checkpoint 零复用**（§2.5 实测）
    ⇒ 当天 D−1 的缺口**永远不会被补**。这是本形态最危险的写法。
  - 建议 `< 16` 且留余量：`30 2,10` 距悬崖 **5h30m**。
- **cron 若显式钉 `Asia/Shanghai`**：只要两次时点在同一条 `HH:MM` 列表里，就**天然同一个上海日历日**——
  「跨零点」这个失败模式在结构上消失。**这是更稳的写法**（见 §4.3 备选）。

### 3.3 未验 / 边界说明（不冒充）

- 上表用 `--target w0` 读窗口表，**未**把这两个时点完整跑到落湖（faketime 与 S3 冲突，见 §1.2）；
  但 bizday 是**窗口表的一列、run 内算一次**，落湖分区与请求体都从它派生 ⇒ 窗口表读数即为判据。
- 生产调度器的**容器时区**是**推断**（见 §4.2），未进容器 `printenv` 核对（本任务约束「不碰生产调度」）。

---

## 4. ③ 一条 cron 能否真的点火两次

### 4.1 静态：解析器接受「小时列表」

在**本机 `duckle serve` 的调度 API** 上直接试：

| 请求体 | 结果 |
|---|---|
| `cron = "30 2,10 * * *"`, `timezone="UTC"` | **HTTP 200**，落盘成 `kind:{type:"cron", expr:"30 2,10 * * *"}` |
| `cron = "30 25,10 * * *"`（值非法） | **HTTP 400** `Invalid cron expression` |
| `cron = "30 2,10 * *"`（字段数 4） | **HTTP 400** 同上 |
| `timezone = "Asia/Shangai"`（拼错） | **HTTP 400** `unknown time zone …`（**不静默回落**） |

机制侧佐证（源码）：`cronzone::normalize_cron` 把 5 字段补成 `0 <expr>` 后交给 `cron` crate 解析；
`cron_decision` 用 `now >= armed` 判到期。仓内**已有**在用形态 `*/5 0-15 * * *`（范围+步长），
与本轮实测的逗号列表同属一个解析器。

### 4.2 动态：真的点火两次（原始回执）

做法：本机 `duckle serve --tick-interval 1` 跑在 faketime 下（时钟用 `@` 形态的时间戳文件，
可被外部改写**步进**；`@` = 从该瞬时起按真实速率推进，因此 `sleep` 正常）。时间线：

| 时刻（钉住的 UTC） | 动作 | 观察到的 run 数 |
|---|---|---|
| `02:00:00` 起 | 建单条 schedule：cron `30 2,10 * * *`、tz=UTC | **0**（已 armed 到 02:30，未到点） |
| 步进到 `02:31:00` | 等 3 个 tick | **1** ← 第 1 次点火 |
| 步进到 `10:31:00` | 等 4 个 tick | **2** ← 第 2 次点火 |
| 再等 4 个 tick | — | **仍 2**（不重复、不多余） |

原始回执：

- `runs`（`/api/runs`，`at` 为调度器当时的时钟）：
  `[('scheduled','2026-09-29T10:31:00.034Z'), ('scheduled','2026-09-29T02:31:00.047Z')]`
- 两次 run 的收据文件：`run-scheduled-tick-1790649060001.json`（= 02:31:00Z）、
  `run-scheduled-tick-1790677860001.json`（= 10:31:00Z），`status: ok`、`trigger: scheduled`。
- **occurrence 账本**（`.duckle/occurrences.ndjson`）——`scheduledFor` 是**调度语义上的到点时刻**，
  比 `at`（tick 实际跑到的时刻）更能说明问题：

```json
{"occurrenceId":"occ-f79ff2b983c601b7","scheduledFor":"2026-09-29T02:30:00+00:00","timezone":"UTC","decision":"fired","decidedAt":"2026-09-29T02:31:00.000Z"}
{"occurrenceId":"occ-629a75a4a7473a68","scheduledFor":"2026-09-29T10:30:00+00:00","timezone":"UTC","decision":"skipped","reason":"overdue, and this schedule's misfire policy is skip","decidedAt":"2026-09-29T10:31:00.000Z"}
{"occurrenceId":"occ-629a75a4a7473a68","scheduledFor":"2026-09-29T10:30:00+00:00","timezone":"UTC","decision":"fired","decidedAt":"2026-09-29T10:31:00.000Z"}
```

注入自证（§1.4 要求）：同一次会话里 interval 调度的 run 打印出
`fired_token=2026-09-29_020004`、`dbnow=2026-09-29 02:00:00.10+00` ⇒ 时钟确实钉住了，不是「没注入所以没点火」。

### 4.3 ⚠️ 从账本里读出来的一条风险（默认 `misfire: skip`）

账本第 2、3 行是**同一个 occurrence（10:30）的两次决策**：先被 `catch_up` 判成
`skipped`（理由：*overdue, and this schedule's misfire policy is skip*），随后又被正常的 arming 路径判成 `fired`。
本机因为**进程一直在跑**，最终仍然点了火；但这条把默认策略暴露了出来：

> **`misfire` 默认 `skip` ⇒ 若第二次点火那一刻调度器进程不在跑（重启中/挂了/容器没起），
> 这次 occurrence 会被记成 `skipped` 而不再执行。双点火就变成单点火，当天的缺口不会被补。**

这是「双点火兜底」唯一的**静默失效**路径。要做真兜底，需要二选一：
① 把该 schedule 的 `misfire` 显式设成会重放的那个策略（`schedules.json` 里该字段可写）；
② 或保留默认，但把「调度器存活」纳入监控（本次未验 `misfire` 各取值的重放行为）。
**本任务未实测 `misfire` 非默认取值的重放行为 ⇒ 标「未验」。**

### 4.4 未验

- **生产 console 的写入路径**（面板/API 把 `timezone` 与小时列表一起写进 `schedules.json`）未验——
  本轮验的是 **schedule store + `duckle serve` 调度器**，而仓内 `console/schedules/*.json` 用的是**同一份记录格式**
  （`kind:{type,expr}` + 可选的 `timezone` 兄弟字段）。
- **`misfire` 非默认值下的重放行为**未验（见 §4.3）。

---

## 5. 结论

### 5.1 双点火兜底是否成立

**成立**，成立的条件（三条，缺一即不成立）：

1. **两次点火落在同一个上海日历日** ⇒ bizday 相同 ⇒ checkpoint 的指纹匹配（§2.5 的反例证明这不是「显然」，而是**必须**）。
2. **两次点火共用同一个 workspace**（checkpoint 状态在 `state/<子管线>_<item>/checkpoints/` 下，
   按 verify 结论：foreach 形按 child+item 天然稳定，与 run 名无关，跨进程可复用）。生产上这个 workspace 是
   `duckle-workspace:/workspace` 这个命名卷，跨 run 持久 ⇒ 满足。
3. **第二次点火时调度器确实在跑**（否则 `misfire: skip` 会把它丢掉，§4.3）。

成立后的收益：当天的缺口在第二次点火被补齐，**且成本只按缺口计**（本轮：补齐 17 个窗只花 192 个请求，
而不是重采 24 窗的 288 个）。这正是「run 红 → 当日补跑」这条既有运维动作在 L1 下的低成本版本。

### 5.2 建议的 cron 表达式与理由

**主选（改动面最小，且在本项目的时区语义下双向安全）：**

```json
{ "kind": { "type": "cron", "expr": "30 2,10 * * *" }, "timezone": "UTC" }
```

理由：

- `30 2,10` = 02:30Z 与 10:30Z = **北京 10:30 与 18:30**，同日；距 16:00Z 悬崖还有 **5h30m** 余量。
- 该写法在两种时区解读下都安全：按 UTC 读，两点都 < 16 ✅；按 `Asia/Shanghai` 读，两点都是同一天 10:30/18:30 ✅
  ⇒ **即使以后有人给容器加了 `TZ`，这个表达式也不会从「兜底成立」掉成「目标日分叉」**。
- **仍建议显式写 `"timezone": "UTC"`**：因为 cron 的时区**默认取机器本地时区**（源码 `cronzone::resolve_zone`：
  「With no zone configured the machine's local zone is used」），这是一个**隐式的、没写下来的依赖**；
  钉住它之后，换容器镜像/加 TZ 都不会偷偷改语义。
- 加的这份 schedule 要**指向父管线 `lemeng.retail.windows.l1`**（不是老的 `.run`）。⚠️ 相邻风险（上一轮报告已点名）：
  现有告警规则匹配的是 `lemeng.retail.windows.run`，**匹配不到 `.l1` ⇒ 失败会静默**；切流清单里必须先补 `alerts.json`。

**备选（把「跨零点」这个失败模式从结构上消掉）：**

```json
{ "kind": { "type": "cron", "expr": "30 10,18 * * *" }, "timezone": "Asia/Shanghai" }
```

理由：钉住上海时区后，`HH:MM` 列表里的两个时点**必然同日**，边界规则不用再让人心算 16:00Z。
代价：与现有 `30 2 * * *`（无 timezone）的读法不同，切换时要有人核对一次。

**给以后改 cron 的人的一条硬规则**（写在 §3.2）：**cron 以 UTC 求值且用小写时列表时，
列表里所有小时必须 `< 16`**（即 `0..15`）；混入 `≥16` 的小时会让两次点火目标不同的 bizday，
当天缺口**永不补齐**且告警不响（因为那时 checkpoint 也失效，第二跑会全量重采另一天）。

---

## 6. 证据索引（lab，零生产写入）

| 回执 | 内容 |
|---|---|
| `evidence/V1a-round1.access`（99 行）/ `V1a-round1-summary.csv` | 第 1 轮：截尾 08..23 零请求、07 三次尝试、17 窗 missing |
| `evidence/V1a-round2.access`（293 行 = 99+194）/ `V1a-round2-summary.csv` | 第 2 轮：00..06 零请求、07 只补 p1、08..23 全补齐、24 窗 ok |
| `evidence/V1c-*.out` + 干净桶复验 | 第 1 轮后湖上**恰好 7 个对象**（无残缺对象）；第 2 轮后 24 对象、逐 hour `batch_id` 数 = 1、`batch_id` = 本轮 run_token |
| `evidence/V1b-baseline.access`（289 行） | 干净全量一轮 = 289（「不用 checkpoint」的实测成本） |
| `evidence/V2b-1.access` / `V2b-2.access` | bizday 一变 ⇒ 零复用（289/289） |
| `evidence/V2-*.out` | `--target w0` 在 6 个瞬时下的窗口表读数（§3.1） |
| `evidence/V3-serve/occurrences.ndjson` / `runs/` / `schedules.json` / `serve.log` | ③ 两次点火的原始回执与账本 |
| `verify.py` / `exp1.sh` / `exp2b.sh`（`/tmp/waveB-lab/`） | 可复现入口（含 faketime + 重签名 duckdb 的钉钟手法） |
| mock 访问日志逐请求原文 | 见下方附录 A/B（每行：序号 / 窗 / 页 / 状态） |

> **与本任务无关的一处机器观察（不处理，仅上报）**：本机残留一个**别人的** duckle 进程
> （`duckle --pipeline ws/pipelines/clocktest.json --workspace ws`，PID 34867，自 2026-09-28 21:06 起
> 以 **98% CPU 空转约 12 小时**；父进程是另一个 Claude 会话的 shell 快照 zsh）。
> 不是本任务起的（本任务的 serve 一律已停），也**没有**影响本轮任何测量（所有 run 都正常收敛）。
> 因为无法确认那个会话是否还在用它，**未杀**——按「不碰别人的进程」处理，交给协调者处置。

---

## 附录 A：第 1 轮逐请求日志（99 条）

```
  1| whoami                    | 200
  2| hour=00 page9  | 200
  3| hour=00 page8  | 200
  4| hour=00 page7  | 200
  5| hour=00 page6  | 200
  6| hour=00 page5  | 200
  7| hour=00 page4  | 200
  8| hour=00 page3  | 200
  9| hour=00 page2  | 200
 10| hour=00 page12 | 200
 11| hour=00 page11 | 200
 12| hour=00 page10 | 200
 13| hour=00 page1  | 200
 14| hour=01 page9  | 200
 15| hour=01 page8  | 200
 16| hour=01 page7  | 200
 17| hour=01 page6  | 200
 18| hour=01 page5  | 200
 19| hour=01 page4  | 200
 20| hour=01 page3  | 200
 21| hour=01 page2  | 200
 22| hour=01 page12 | 200
 23| hour=01 page11 | 200
 24| hour=01 page10 | 200
 25| hour=01 page1  | 200
 26| hour=02 page9  | 200
 27| hour=02 page8  | 200
 28| hour=02 page7  | 200
 29| hour=02 page6  | 200
 30| hour=02 page5  | 200
 31| hour=02 page4  | 200
 32| hour=02 page3  | 200
 33| hour=02 page2  | 200
 34| hour=02 page12 | 200
 35| hour=02 page11 | 200
 36| hour=02 page10 | 200
 37| hour=02 page1  | 200
 38| hour=03 page9  | 200
 39| hour=03 page8  | 200
 40| hour=03 page7  | 200
 41| hour=03 page6  | 200
 42| hour=03 page5  | 200
 43| hour=03 page4  | 200
 44| hour=03 page3  | 200
 45| hour=03 page2  | 200
 46| hour=03 page12 | 200
 47| hour=03 page11 | 200
 48| hour=03 page10 | 200
 49| hour=03 page1  | 200
 50| hour=04 page9  | 200
 51| hour=04 page8  | 200
 52| hour=04 page7  | 200
 53| hour=04 page6  | 200
 54| hour=04 page5  | 200
 55| hour=04 page4  | 200
 56| hour=04 page3  | 200
 57| hour=04 page2  | 200
 58| hour=04 page12 | 200
 59| hour=04 page11 | 200
 60| hour=04 page10 | 200
 61| hour=04 page1  | 200
 62| hour=05 page9  | 200
 63| hour=05 page8  | 200
 64| hour=05 page7  | 200
 65| hour=05 page6  | 200
 66| hour=05 page5  | 200
 67| hour=05 page4  | 200
 68| hour=05 page3  | 200
 69| hour=05 page2  | 200
 70| hour=05 page12 | 200
 71| hour=05 page11 | 200
 72| hour=05 page10 | 200
 73| hour=05 page1  | 200
 74| hour=06 page9  | 200
 75| hour=06 page8  | 200
 76| hour=06 page7  | 200
 77| hour=06 page6  | 200
 78| hour=06 page5  | 200
 79| hour=06 page4  | 200
 80| hour=06 page3  | 200
 81| hour=06 page2  | 200
 82| hour=06 page12 | 200
 83| hour=06 page11 | 200
 84| hour=06 page10 | 200
 85| hour=06 page1  | 200
 86| hour=07 page9  | 200
 87| hour=07 page8  | 200
 88| hour=07 page7  | 200
 89| hour=07 page6  | 200
 90| hour=07 page5  | 200
 91| hour=07 page4  | 200
 92| hour=07 page3  | 200
 93| hour=07 page2  | 200
 94| hour=07 page12 | 200
 95| hour=07 page11 | 200
 96| hour=07 page10 | 200
 97| hour=07 page1  | 500
 98| hour=07 page1  | 500
 99| hour=07 page1  | 500
```

## 附录 B：第 2 轮逐请求日志（194 条；序号接第 1 轮，全局连续）

```
100| whoami                    | 200
101| hour=07 page1  | 200
102| hour=08 page9  | 200
103| hour=08 page8  | 200
104| hour=08 page7  | 200
105| hour=08 page6  | 200
106| hour=08 page5  | 200
107| hour=08 page4  | 200
108| hour=08 page3  | 200
109| hour=08 page2  | 200
110| hour=08 page12 | 200
111| hour=08 page11 | 200
112| hour=08 page10 | 200
113| hour=08 page1  | 200
114| hour=09 page9  | 200
115| hour=09 page8  | 200
116| hour=09 page7  | 200
117| hour=09 page6  | 200
118| hour=09 page5  | 200
119| hour=09 page4  | 200
120| hour=09 page3  | 200
121| hour=09 page2  | 200
122| hour=09 page12 | 200
123| hour=09 page11 | 200
124| hour=09 page10 | 200
125| hour=09 page1  | 200
126| hour=10 page9  | 200
127| hour=10 page8  | 200
128| hour=10 page7  | 200
129| hour=10 page6  | 200
130| hour=10 page5  | 200
131| hour=10 page4  | 200
132| hour=10 page3  | 200
133| hour=10 page2  | 200
134| hour=10 page12 | 200
135| hour=10 page11 | 200
136| hour=10 page10 | 200
137| hour=10 page1  | 200
138| hour=11 page9  | 200
139| hour=11 page8  | 200
140| hour=11 page7  | 200
141| hour=11 page6  | 200
142| hour=11 page5  | 200
143| hour=11 page4  | 200
144| hour=11 page3  | 200
145| hour=11 page2  | 200
146| hour=11 page12 | 200
147| hour=11 page11 | 200
148| hour=11 page10 | 200
149| hour=11 page1  | 200
150| hour=12 page9  | 200
151| hour=12 page8  | 200
152| hour=12 page7  | 200
153| hour=12 page6  | 200
154| hour=12 page5  | 200
155| hour=12 page4  | 200
156| hour=12 page3  | 200
157| hour=12 page2  | 200
158| hour=12 page12 | 200
159| hour=12 page11 | 200
160| hour=12 page10 | 200
161| hour=12 page1  | 200
162| hour=13 page9  | 200
163| hour=13 page8  | 200
164| hour=13 page7  | 200
165| hour=13 page6  | 200
166| hour=13 page5  | 200
167| hour=13 page4  | 200
168| hour=13 page3  | 200
169| hour=13 page2  | 200
170| hour=13 page12 | 200
171| hour=13 page11 | 200
172| hour=13 page10 | 200
173| hour=13 page1  | 200
174| hour=14 page9  | 200
175| hour=14 page8  | 200
176| hour=14 page7  | 200
177| hour=14 page6  | 200
178| hour=14 page5  | 200
179| hour=14 page4  | 200
180| hour=14 page3  | 200
181| hour=14 page2  | 200
182| hour=14 page12 | 200
183| hour=14 page11 | 200
184| hour=14 page10 | 200
185| hour=14 page1  | 200
186| hour=15 page9  | 200
187| hour=15 page8  | 200
188| hour=15 page7  | 200
189| hour=15 page6  | 200
190| hour=15 page5  | 200
191| hour=15 page4  | 200
192| hour=15 page3  | 200
193| hour=15 page2  | 200
194| hour=15 page12 | 200
195| hour=15 page11 | 200
196| hour=15 page10 | 200
197| hour=15 page1  | 200
198| hour=16 page9  | 200
199| hour=16 page8  | 200
200| hour=16 page7  | 200
201| hour=16 page6  | 200
202| hour=16 page5  | 200
203| hour=16 page4  | 200
204| hour=16 page3  | 200
205| hour=16 page2  | 200
206| hour=16 page12 | 200
207| hour=16 page11 | 200
208| hour=16 page10 | 200
209| hour=16 page1  | 200
210| hour=17 page9  | 200
211| hour=17 page8  | 200
212| hour=17 page7  | 200
213| hour=17 page6  | 200
214| hour=17 page5  | 200
215| hour=17 page4  | 200
216| hour=17 page3  | 200
217| hour=17 page2  | 200
218| hour=17 page12 | 200
219| hour=17 page11 | 200
220| hour=17 page10 | 200
221| hour=17 page1  | 200
222| hour=18 page9  | 200
223| hour=18 page8  | 200
224| hour=18 page7  | 200
225| hour=18 page6  | 200
226| hour=18 page5  | 200
227| hour=18 page4  | 200
228| hour=18 page3  | 200
229| hour=18 page2  | 200
230| hour=18 page12 | 200
231| hour=18 page11 | 200
232| hour=18 page10 | 200
233| hour=18 page1  | 200
234| hour=19 page9  | 200
235| hour=19 page8  | 200
236| hour=19 page7  | 200
237| hour=19 page6  | 200
238| hour=19 page5  | 200
239| hour=19 page4  | 200
240| hour=19 page3  | 200
241| hour=19 page2  | 200
242| hour=19 page12 | 200
243| hour=19 page11 | 200
244| hour=19 page10 | 200
245| hour=19 page1  | 200
246| hour=20 page9  | 200
247| hour=20 page8  | 200
248| hour=20 page7  | 200
249| hour=20 page6  | 200
250| hour=20 page5  | 200
251| hour=20 page4  | 200
252| hour=20 page3  | 200
253| hour=20 page2  | 200
254| hour=20 page12 | 200
255| hour=20 page11 | 200
256| hour=20 page10 | 200
257| hour=20 page1  | 200
258| hour=21 page9  | 200
259| hour=21 page8  | 200
260| hour=21 page7  | 200
261| hour=21 page6  | 200
262| hour=21 page5  | 200
263| hour=21 page4  | 200
264| hour=21 page3  | 200
265| hour=21 page2  | 200
266| hour=21 page12 | 200
267| hour=21 page11 | 200
268| hour=21 page10 | 200
269| hour=21 page1  | 200
270| hour=22 page9  | 200
271| hour=22 page8  | 200
272| hour=22 page7  | 200
273| hour=22 page6  | 200
274| hour=22 page5  | 200
275| hour=22 page4  | 200
276| hour=22 page3  | 200
277| hour=22 page2  | 200
278| hour=22 page12 | 200
279| hour=22 page11 | 200
280| hour=22 page10 | 200
281| hour=22 page1  | 200
282| hour=23 page9  | 200
283| hour=23 page8  | 200
284| hour=23 page7  | 200
285| hour=23 page6  | 200
286| hour=23 page5  | 200
287| hour=23 page4  | 200
288| hour=23 page3  | 200
289| hour=23 page2  | 200
290| hour=23 page12 | 200
291| hour=23 page11 | 200
292| hour=23 page10 | 200
293| hour=23 page1  | 200
```
