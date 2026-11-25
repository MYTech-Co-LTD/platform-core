# 数据新鲜度双车道（10m / 1h）——路线图与台账

> **本文件是这条线的唯一导航面 + 进度台账。开工前先读 §4 台账，别重做已完成项。**
> 详细设计另立 spec/issue；本文件只做导航，不重复正文。
> 两条维护规则：① 每完成一项，在同一 PR 更新 §5 台账；② 改范围/顺序，先在 §6 写变更记录。

## §1 目标（可判定）

| # | 判据 | 怎么量 |
|---|---|---|
| G1 | **销售明细**（`fct_retail_sale`）端到端 p95 ≤ **10 min** | 源可拉到 → mart 可查 |
| G2 | **其他交易/快照源** mart 端到端 p95 ≤ **1 h** | 同上；按域 |
| G3 | **日报表源**（`item_sales` / `item_profit` / `customer_analysis` / `saler_commission` / `inventory_movement`）SLA = **1 天** | 不混入 G2 |
| G4 | **数字面 SLA 与 AI 文本分离**：数字 10m/1h；AI 文本单独定 | 报表显示 `data_as_of` |
| G5 | 零漏窗、零双算、零 ETag（小时腿） | 断言面 + 台账 |

## §2 边界（明确不做）

- **不改「湖 + PG」存储选型**；P3 之前不引入 Iceberg/Delta/流式。
- **零售 10m 车道不做条件触发**（数据一直在变，热层已是最便宜路径）。
- **日报表源不强行小时级**（源端能力未证前）。
- **生成型报表文档不承诺 10 分钟**（AI 文本单列）。
- **P0/P0.5 不改采集语义**；采集探针只在 P1.5 试点。

## §3 已定决策（2026-11-24）

| # | 决策 |
|---|---|
| D1 | 「报表」= 控制台/问数**在线查 mart**；AI 文本单独定 SLA |
| D2 | **10m 车道 = 仅 `fct_retail_sale`**（`docs/architecture.md:261` 既有定案） |
| D3 | **1h 车道 = 其余 incremental**（含 3 个零售派生 mart），按域分片 |
| D4 | 日报表源 5 个保持日批 |
| D5 | 并发默认**单飞 + chunk ≤3 min**；G0 实测后可切并行（B3） |
| D6 | P0.5 物化水位门禁：**仅对有内容水位的域开启**，其余默认 `always` |
| D7 | 安全网不可省：每日强制 build + 日终全量 + 对账 |
| D8 | **保留 dbt 作为工程化层**（2026-11-25 用户决定）：DAG/增量/67 条审计测试/选择器/血缘都留；热路径暂不抽取成裸 SQL，后续若 dbt 选择器/宏的维护成本持续高于收益再评估 |

## §4 阶段与条目（状态）

### 已完成（本次会话，2026-11-24）

- [x] 采集窗口扩到次日 01:59；5 个夜间 job 挪档（#2792）
- [x] `data.dbt_tick` 物化窗口扩到 01:52（#2801 / #2802）
- [x] 热腿按窗取批 + 只补今天的闭窗两窗（#2803 / #2804）
- [x] 存量 `job_schedule` cron 与 registry 对账并修正（直接改库，5 个夜间 job + tick）

### 待验证（今晚/明早）

- [x] **02:30** 已验证：view **没有**翻转 —— tables 选择器不含 staging（#2815）；修复见 `fix/tables-rebuild-staging-views`
- [ ] **00:02 / 01:02** 夜间 tick 覆盖昨天 h23 补录
- [ ] **09:02** 白天 tick 走新 view，当前小时不缺
- [ ] 连续 2 天无 ETag 失败（小时腿）

### P0 车道拆分

- [x] **A4** 覆盖性门禁：每个 incremental 恰好属于一个车道（变异测试）——`scripts/check-data-lanes.mjs`，`scripts/lemeng/data-lanes.json` 为事实源
- [x] **A5** 起点门禁：1h 起点紧随最后一个采集偏移 + 10m 物化偏移对齐——同脚本；真机 gap 7 分钟（:58 → :05）
- [ ] **G0** 基线测量：单 build 时长/内存；两并发是否 postmaster 重启
- [x] **A1** `materialize.sh` selector 覆盖：`MATERIALIZE_LANE` 从 `data-lanes.json` 解析模型清单（tick/hourly 通用；未知车道 fail loud）+ `MATERIALIZE_HOURLY_SELECT`；3 条用例 + 静态接线断言
- [ ] **A2** 10m 车道落地（仅 `fct_retail_sale`）
- [ ] **A3** 1h 车道按域分片
- [x] **B1** G0 基线测量 → **单飞定案**：两路并发峰值 2.46GB、重模型+采集峰值 3.02GB / 上限 4GB，无 postmaster 重启；长查询不可取消（只能预防）
- [ ] **B2** 单飞锁 + chunk 上限实现（≤3 分钟）
- [ ] **C1–C6** 水位 / 幂等 / 热湖互补性回归
- [ ] **D1–D4** per-mart SLA 断言 + 告警
- [ ] **G6** 48h soak

### P0.5 物化水位门禁

- [ ] **S1** 水位表（`source_watermark` / `build_watermark`）
- [ ] **S2** 内容水位清单（每域一个 `wm_kind`，默认 `always`）
- [ ] **S3** 门禁脚本（fail-open）
- [ ] **S4** 跳过记账（`skipped_no_change`）
- [ ] **S5** 时间敏感 mart 排除
- [ ] **S6** 每日强制 build
- [ ] **S7** 观测与告警
- [ ] **S8** A/B 对照（1 周）
- [ ] **S9** 回滚开关

### P1 不可变微批 + manifest（P0 验收后）

- [ ] **I1** key/manifest 设计
- [ ] **I2** 采集写新 key + manifest
- [ ] **I3** 读侧 manifest 快照 + 双读开关
- [ ] **I4** compaction + manifest-aware GC
- [ ] **I5** 零售先灰度
- [ ] **I6** 3 天零 ETag

### P1.5 采集探针（试点）

- [ ] 选 1–2 源（建议 `dim.item` / `dim.branch`）
- [ ] 探针三条件：便宜 / 充分 / 可靠（fail-open）
- [ ] A/B 一周（探针组 vs always pull，行数/校验和一致）
- [ ] 通过后逐源推广

### P2 资产事件驱动

- [ ] **J1** 采集完成事件
- [ ] **J2** 触发器 + debounce/coalesce
- [ ] **J3** 背压（10m 优先 / 1h 让路）
- [ ] **J4** 验证（迟到/重复/丢失事件）

## §5 台账

| 日期 | 条目 | 状态 | 证据/链接 |
|---|---|---|---|
| 2026-11-24 | #2792 采集窗口 + 夜间挪档 | ✅ 合并 | PR #2792 |
| 2026-11-24 | #2801 tick 物化窗口 | ✅ 合并/部署 | PR #2802，11:43/11:52 tick ok |
| 2026-11-24 | #2803 热腿按窗取批 | ✅ 合并/部署 | PR #2804，8,535 = 6,453 + 2,082 |
| 2026-11-24 | 存量 cron 对账 | ✅ 已改库 | tables/a1/a2a/a2b/window/tick |
| 2026-11-24 | 02:30 view 翻转 | ⏳ 待验证 | 今晚 02:30 |
| 2026-11-24 | P0 A4/A5 静态门禁 | ✅ PR #2811 | 18 增量全部归属；37 小时级源，最后 :58 → 1h :05，gap 7；10 条 fixture 测试 |
| 2026-11-25 | 02:30 view 未翻转，根因定位 | ✅ 修复 | #2815（选择器补 staging）+ #2819（parquet 别名谓词）；手动重建后 view 含 `retail_hot`（len 5504） |
| 2026-11-25 | 热层首跑验证 | ✅ | 三腿等价 211 = 0 + 211；09:42 tick（首跑新 view）ok 32s；今日 fct 90 行 / 净额 8,696.20 |
| 2026-11-25 | G0 并发实验 | ✅ 单飞定案 | 2.46GB / 3.02GB / 4GB；postmaster 未重启；`pg_terminate_backend` 对 DuckDB 扫描无效 |
| 2026-11-25 | A1 车道选择器 | ✅ 本 PR | `MATERIALIZE_LANE` 解析 `data-lanes.json`；未知车道 fail loud；materialize.test 112 pass |

## §6 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-24 | 建立本路线图，P0/P0.5/P1/P1.5/P2 分档 | 内容过多，先立导航面防跑偏 |

## §7 详细设计指针

- 热层设计：`docs/superpowers/specs/2026-11-23-retail-hot-layer-design.md`
- 增量 mart 与频率：`docs/superpowers/plans/2026-11-06-materialize-frequency-and-incremental.md`
- 数据面架构：`docs/architecture.md` §5
- 本线的详细 spec（待写）：`docs/superpowers/specs/2026-11-24-freshness-lanes-design.md`（P0 静态门禁落地后补）
