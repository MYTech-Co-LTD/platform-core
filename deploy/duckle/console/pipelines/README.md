# 采集管线地图（本目录的图，不是正典）

> **性质**：这是**图 / 地图**，给人和 agent 一眼看清「谁在干什么、哪一格是引擎给的、哪一格是我们写的」。
> **规则与判据以正典为准**：形态与选型 → `docs/data-platform-handbook.md` §1.1.7；各管线的方言与细节 →
> 该管线文件自己的 `_note`；投递程序 → `deploy/data-plane-deploy-sop.md` §E / §F.2。**本文件不复制正文。**
> **维护约定**：改了任何管线的节点/边，**本图要跟着改**，并重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`。
> **新增管线往哪放、叫什么名**：见 `docs/superpowers/plans/2026-10-05-collection-layout-convention.md`（**本目录永远平铺；新源系统加文件名前缀，不加子目录**）。

## 读图约定

| 色 | 含义 |
|---|---|
| 🟦 **引擎替我们干的** | 编排 / 循环 / 重试 / 合并 / 定序 / 调度 —— **不用我们写** |
| 🟧 **语义由我们写** | SQL / 判据 / 契约 / 路径与分区 —— **载体仍是引擎组件，内容是我们定的** |

**一句话判据**：管线里只写「数据怎么流」；一切程序性的循环、重试、计数下沉给引擎。
**本目录 8 条管线里没有一个节点是自研组件**，也没有 shell 包装层（历史那支 wrapper 已退役）。

## 三种形态 × 8 条管线

| 形态 | 文件 | 份数 |
|---|---|---|
| **L0 直连**（单窗/日频，无跨窗编排） | `lemeng.dim.branch.l0.json` · `lemeng.dim.item.l0.json` | 各 1（双账套） |
| **L1 编排**（跨窗循环） | `lemeng.retail.windows.l1.json` · `lemeng.retail.tick.l1.json` · `lemeng.retail.close.l1.json` | 3 |
| **业务子管线**（单窗怎么采，被 L1 复用） | `lemeng.retail_order_line.window.json` · `lemeng.retail_order_line.tick.json` | 2 |
| **回填变体**（只差窗口来源，不进调度） | `lemeng.retail.windows.backfill.json` | 1 |

---

## 图 1 · L0 直连（维度面：全量快照）

```mermaid
flowchart TD
  S["调度 console：cron / misfire / catchup"]:::eng
  S --> W0["w0 src.rest 身份探针<br/>引擎：REST 源 + SSE 原件落盘 + 重试<br/>自写：探针体 / data.schema / 绝对路径（不写 s3://）"]:::own
  W0 --> G0["g0 g1 g2 code.sql<br/>引擎：执行 SQL<br/>自写：拆 SSE → 取最后一条 → 抠 company_id / 门店表"]:::own
  G0 --> D0["d0 ctl.die 反向闸<br/>引擎：无行即红<br/>自写：判据=抠不出身份就红（挡网关形状漂移）"]:::own
  D0 --> G3["g3 code.sql 两条断言<br/>自写：1 账套相符 2 配置门店⊆可见门店"]:::own
  G3 --> D1["d1 ctl.die<br/>引擎：有违规即红并阻断下游<br/>自写：先证后采（未证即 0 业务调用 / 0 写湖）"]:::own
  D1 --> GV["gv / dv 期望值形状闸<br/>自写：批号 / 账套 / 快照 / 页数的形状<br/>引擎：不合即红"]:::own
  GV --> P["p1…pN src.rest 分页<br/>引擎：分页抓取 + 重试 + 每页落盘<br/>自写：页数与页容量（阈值 = 页数-1 × 页容量）"]:::own
  P --> GUARD["guard ctl.die 末页哨兵<br/>自写：容量截断判据<br/>引擎：命中即红（fail-loud 不丢数）"]:::own
  GUARD --> MG["merge ctl.merge"]:::eng
  MG --> SH["shape code.sql 定型<br/>自写：注入 batch_id / system_book / snapshot + 全列定型"]:::own
  SH --> GT["gate qa.contract<br/>引擎：求值契约<br/>自写：哪几列 not_null"]:::own
  GT --> SK["sink snk.minio<br/>引擎：写对象存储<br/>自写：分区写进 key + 单对象覆盖（幂等）"]:::own
  classDef eng fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef own fill:#fff4e5,stroke:#e8710a,color:#7a3300
```

> `item.l0` 同形，差别只有：分页到 **150 页**、`shape` 多一步「摊平 3 对象」。

---

## 图 2 · L1 编排（零售跨窗）+ 被它复用的业务子管线

```mermaid
flowchart TD
  S["调度 console：cron / misfire / catchup / timezone"]:::eng
  S --> ID["身份门（同图 1 的 9 个节点）<br/>引擎：die + 定序<br/>自写：4 条判定 SQL"]:::own
  ID --> W0["w0 code.sql 窗口表<br/>自写：要采哪些窗"]:::own
  W0 --> FE["fe ctl.foreach<br/>引擎：逐窗循环 + 并发 + 同 run 同窗重试"]:::eng
  W0 --> WM["wm code.sql 收据形状 pending<br/>自写：窗口清单形状"]:::own
  WM --> WS["wsink snk.csv 本 run 窗口清单"]:::eng
  FE --> CH
  subgraph CH["业务子管线 · 单窗怎么采（window / tick 两个变体）"]
    direction TB
    C1["p1…p12 src.rest 分页<br/>引擎：分页 + 重试<br/>自写：页数/游标"]:::own --> C2["guard ctl.die 末页哨兵"]:::own
    C2 --> C3["merge ctl.merge"]:::eng
    C3 --> C4["flatten code.sql<br/>自写：UNNEST pos_order_details + 定型到契约列"]:::own
    C4 --> C5["gate qa.contract<br/>自写：契约列"]:::own
    C5 --> C6["sink snk.minio 写湖<br/>自写：一窗一 key 覆盖写"]:::own
    C6 --> C7["ordered ctl.anchor<br/>引擎：湖对象先落盘"]:::eng
    C7 --> C8["summ code.sql 本窗收据行"]:::own
    C8 --> C9["receipt snk.csv 单窗收据"]:::eng
  end
  FE --> A1["a1 ctl.anchor 整批跑完再汇总"]:::eng
  WS --> A1
  A1 --> SU["su code.sql 汇总（收据 × 窗口表）<br/>自写：每窗成色的唯一事实源"]:::own
  SU --> REP["rep snk.csv 汇总表（运行记录）"]:::eng
  SU --> OP["op code.sql _ops 行成形"]:::own
  OP --> WH["wh snk.webhook 投 OO"]:::eng
  SU --> SR["sr code.sql 缺口窗"]:::own
  REP --> A2["a2 ctl.anchor 先落盘后判红"]:::eng
  SR --> A2
  WH --> A2
  A2 --> DZ["dz ctl.die 末尾统一判红<br/>引擎：判红<br/>自写：判红文案"]:::own
  SR --> DZ
  classDef eng fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef own fill:#fff4e5,stroke:#e8710a,color:#7a3300
```

**三兄弟的差别只在窗口表**：`windows` = 24 窗（日批，零点在 UTC 02:30 / 10:30 双点火）；
`tick` = 当前小时 + 前一小时（每 5 分钟，`misfire:skip`，catchup 结构上补不回错过的窗）；
`close` = 仅前一小时（1 窗）。`backfill` 变体与 `windows` 同形，**只差窗口来源是参数**（`BIZDAY`），且**不含 `op`/`wh`**（手动驱动、不进调度）。

---

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

## 还必须自己写的（引擎给不了的业务语义）

| 自写件 | 解决什么问题 |
|---|---|
| 身份门 4 条 SQL + 2 条判据 | **凭据与账套是否相符** —— 防越权采错账套 |
| 窗口表 SQL（3 形） | 该采哪些窗（24 / cur+prev / prev） |
| 定型 SQL（注入 batch_id / system_book / snapshot + 列类型） | **落湖即定型** —— 防「列全是字符串」「同表两种时间格式」 |
| `qa.contract` 的 not_null 清单 | 契约 |
| 末页哨兵阈值算式 | 容量截断 **fail-loud**，不静默丢数 |
| 汇总 / 缺口 SQL + 判红文案 | 哪窗缺了、读哪份收据 |
| sink key 与分区形状 | 幂等 + 下游可读 |
| `_ops` 行形状 | 观测面对齐 |

---

## 落到「降工作量」的边界

- **新账套**（同渠道）：换连接 + 换账户号/门店清单 + 复核五点验收 —— **自写件一行不用改**。
- **新渠道**：形态与纪律可照抄，但上表「自写件」那一栏要重写一遍（乐檬特有的方言坑在
  `docs/data-platform-handbook.md` §1.6 案例库里，17 条）。
