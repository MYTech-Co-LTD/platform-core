# 乐檬（lemeng）采集管线流程图

> **这是「源系统 = 乐檬」的图。** 两个账套（3120 / 64188）**共用同一批管线** —— 客户差异只在
> `env`（账户号 / 门店清单 / 桶）· 保存的连接 · 每账套一份的排班文件 ⇒ **下面两张图对两个账套都成立**，
> 客户既不进图、也不进文件名。
> **图例与通用表**（🟦 引擎替我们干的 / 🟧 语义由我们写）在 [`README.md`](README.md)；
> **形态与选型的正典**在 `docs/data-platform-handbook.md` §1.1.7；**乐檬特有的方言**在各管线自己的
> `_note` 与 handbook §1.6 案例库。**本文件不复制正文。**
> **维护约定**：改了乐檬任何管线的节点/边 ⇒ 改本图，并重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`。

## 乐檬的三形态 × 8 条管线

| 形态 | 文件 | 份数 |
|---|---|---|
| **L0 直连**（单窗/日频，无跨窗编排） | `lemeng.dim.branch.l0.json` · `lemeng.dim.item.l0.json` | 各 1（双账套） |
| **L1 编排**（跨窗循环） | `lemeng.retail.windows.l1.json` · `lemeng.retail.tick.l1.json` · `lemeng.retail.close.l1.json` | 3 |
| **业务子管线**（单窗怎么采，被 L1 复用） | `lemeng.retail_order_line.window.json` · `lemeng.retail_order_line.tick.json` | 2 |
| **回填变体**（只差窗口来源，不进调度） | `lemeng.retail.windows.backfill.json` | 1 |

---

## 图 1 · L0 直连（维度面：全量快照）

图例：**①** 纯 duckle · **②** duckle 组件 + 我们的规则/配置 · **③** 纯手写代码（`code.sql`）

```mermaid
flowchart TD
  S["① 调度 console：cron / misfire / catchup"]:::e1
  S --> W0["② w0 src.rest 身份探针<br/>组件的：REST 请求 + 重试 + SSE 原件落盘<br/>我们的：探针体 / data.schema / 绝对路径（不写 s3://）"]:::e2
  W0 --> G0["③ g0 g1 g2 code.sql<br/>壳：SQL 执行<br/>我们写的：拆 SSE → 取最后一条 → 抠 company_id / 门店表"]:::e3
  G0 --> D0["② d0 ctl.die 反向闸<br/>组件的：无行即红<br/>我们的：判据 = 抠不出身份就红（挡网关形状漂移）"]:::e2
  D0 --> G3["③ g3 code.sql 两条断言<br/>我们写的：账套相符 + 配置门店 ⊆ 可见门店"]:::e3
  G3 --> D1["② d1 ctl.die<br/>组件的：有违规即红并阻断下游<br/>我们的：先证后采（未证 ⇒ 0 业务调用 / 0 写湖）"]:::e2
  D1 --> GV["③ gv code.sql 期望值形状闸<br/>我们写的：批号 / 账套 / 快照 / 页数的形状"]:::e3
  GV --> DV["② dv ctl.die（我们的：形状不合即红）"]:::e2
  DV --> P["② p1…pN src.rest 分页<br/>组件的：分页抓取 + 重试 + 每页落盘<br/>我们的：页数与页容量（阈值 = 页数-1 × 页容量）"]:::e2
  P --> GUARD["② guard ctl.die 末页哨兵<br/>组件的：命中即红（fail-loud 不丢数）<br/>我们的：容量截断判据"]:::e2
  GUARD --> MG["① merge ctl.merge（零逻辑）"]:::e1
  MG --> SH["③ shape code.sql 定型<br/>我们写的：注入 batch_id / system_book / snapshot + 全列定型"]:::e3
  SH --> GT["② gate qa.contract<br/>组件的：契约求值<br/>我们的：哪几列 not_null"]:::e2
  GT --> SK["② sink snk.minio<br/>组件的：写对象存储<br/>我们的：分区写进 key + 单对象覆盖（幂等）"]:::e2
  classDef e1 fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef e2 fill:#fff4e5,stroke:#e8710a,color:#7a3300
  classDef e3 fill:#e6f4ea,stroke:#137333,color:#0d5221
```

> `item.l0` 同形，差别只有：分页到 **150 页**、`shape` 多一步「摊平 3 对象」。

---

## 图 2 · L1 编排（零售跨窗）+ 被它复用的业务子管线

```mermaid
flowchart TD
  S["① 调度 console：cron / misfire / catchup / timezone"]:::e1
  S --> ID["身份门（同图 1 的那 9 个节点）<br/>② ctl.die 判定 · ③ code.sql 四条判定 SQL"]:::e3
  ID --> W0["③ w0 code.sql 窗口表<br/>我们写的：要采哪些窗"]:::e3
  W0 --> FE["① fe ctl.foreach<br/>循环 + 并发 + 同 run 同窗重试<br/>（我们只给 pipelineRef / itemKey / retryAttempts）"]:::e1
  W0 --> WM["③ wm code.sql 收据形状 pending"]:::e3
  WM --> WS["② wsink snk.csv 本 run 窗口清单（我们的：路径 + 覆盖）"]:::e2
  FE --> CH
  subgraph CH["业务子管线 · 单窗怎么采（window / tick 两个变体）"]
    direction TB
    C1["② p1…p12 src.rest 分页<br/>组件的：分页 + 重试 · 我们的：页数 / 游标"]:::e2 --> C2["② guard ctl.die 末页哨兵"]:::e2
    C2 --> C3["① merge ctl.merge"]:::e1
    C3 --> C4["③ flatten code.sql<br/>我们写的：UNNEST pos_order_details + 定型到契约列"]:::e3
    C4 --> C5["② gate qa.contract（我们的：契约列）"]:::e2
    C5 --> C6["② sink snk.minio 写湖（我们的：一窗一 key、覆盖写）"]:::e2
    C6 --> C7["① ordered ctl.anchor（零逻辑，只定序：湖对象先落盘）"]:::e1
    C7 --> C8["③ summ code.sql 本窗收据行"]:::e3
    C8 --> C9["② receipt snk.csv 单窗收据"]:::e2
  end
  FE --> A1["① a1 ctl.anchor（整批跑完再汇总）"]:::e1
  WS --> A1
  A1 --> SU["③ su code.sql 汇总（收据 × 窗口表）<br/>我们写的：每窗成色的唯一事实源"]:::e3
  SU --> REP["② rep snk.csv 汇总表（运行记录）"]:::e2
  SU --> OP["③ op code.sql _ops 行成形"]:::e3
  OP --> WH["② wh snk.webhook 投 OO（我们的：url / 头 / 批次模式）"]:::e2
  SU --> SR["③ sr code.sql 缺口窗"]:::e3
  REP --> A2["① a2 ctl.anchor（先落盘后判红）"]:::e1
  SR --> A2
  WH --> A2
  A2 --> DZ["② dz ctl.die 末尾统一判红（我们的：判红文案）"]:::e2
  SR --> DZ
  classDef e1 fill:#e8f0fe,stroke:#4285f4,color:#0b3d91
  classDef e2 fill:#fff4e5,stroke:#e8710a,color:#7a3300
  classDef e3 fill:#e6f4ea,stroke:#137333,color:#0d5221
```

---

## 管线之外：③ 纯手写的那一层（图里原先看不见的那半张图）

管线只是链路的一段。围着它转的这些件**不属于 duckle**，是我们自己写/配的：

| 件 | 在哪 | 干什么 | 档 |
|---|---|---|---|
| `lemeng-wire-warehouse.sh` | `/opt/` | 平台↔仓库两条**易失接线**的幂等重做 + 只读复查 | ③ |
| `lemeng-diagnose.sh` | `/opt/` | 诊断 / 对账（湖 vs 网关翻页累计，容差 0） | ③ |
| `lemeng-backfill.sh` | `/opt/` | 回填驱动（两道 fail-closed 闸 + 五批降序） | ③ |
| `lemeng-readback.sh` | 检出内 | **免凭据**独立回读湖（换通道复核，不复用被测通路） | ③ |
| `connection-setup.py` | `/opt/` | 建**密文**连接（禁用明文写入方） | ③ |
| `authoring-ws.sh` | 仓内 `scripts/` | 装配桌面 authoring 工作区（仓 ⇄ 工作区映射） | ③ |
| CI 守卫 8 条 | 仓内 `scripts/check-*.mjs` | catalog 命名 / 数据面 lock / 清单 / compose / env 模板 … | ③ |
| openship jobs | 控制面 | 观测行采集 · 接线探活（每 5 分钟）· **部署后接线重做** · 构建缓存兜底清理 | ③ |

**读法**：图 1 / 图 2 画的是「管线里面」；上面这张表是「管线外面」。**两半合起来才是完整链路** —— 而**只有管线里面**才要求「① ② ③ 分明」；管线外面本来就是③，不必再分。

**三兄弟的差别只在窗口表**：`windows` = 24 窗（日批，零点在 UTC 02:30 / 10:30 双点火）；
`tick` = 当前小时 + 前一小时（每 5 分钟，`misfire:skip`，catchup 结构上补不回错过的窗）；
`close` = 仅前一小时（1 窗）。`backfill` 变体与 `windows` 同形，**只差窗口来源是参数**（`BIZDAY`），且**不含 `op`/`wh`**（手动驱动、不进调度）。

---

---

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
