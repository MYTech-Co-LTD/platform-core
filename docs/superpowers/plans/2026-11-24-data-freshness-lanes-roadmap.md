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
- [x] **00:02 / 01:02** 夜间 tick 覆盖昨天 h23 补录（**2026-11-27 核**：两轮 `ok` 25.7s / 22.2s，
      `load_log.max_bizday = 2026-11-26`；01:02 时闭窗边界=北京 00:00 ⇒ 11-26 整日进窗；源侧封版
      day 文件 11-26 含 h23 **24 行 / ¥1,213.58**。⚠️ 逐行比对不可行——口径（换货/赠品）使金额不可
      直比，故此为**结构性验证**而非数值对齐）
- [x] **09:02** 白天 tick 走新 view，当前小时不缺（**2026-11-27 核**：09:02 轮 `ok` 55.6s、
      `load_log.max_bizday = 2026-11-27`；今日 mart 41 行 / 57 单 / ¥3,597.80；**逐账套门店数与热层
      完全相等**（3120 20/20、64188 21/21）⇒ 当前小时无缺。耗时比夜间 20-25s 长，是首轮要读封版天腿）
- [x] 连续 2 天无 ETag 失败（小时腿）（**2026-11-27 核**：最后一次 ETag 类失败 = 11-25 10:33 CST
      tick；此后至今 tick/hourly 共 0 次 ETag 失败。11-26 的三次失败均非 ETag：两次
      `dispatch failed: fetch failed`（部署窗口）+ 一次 `hourly_dims timeout`）

### P0 车道拆分

- [x] **A4** 覆盖性门禁：每个 incremental 恰好属于一个车道（变异测试）——`scripts/check-data-lanes.mjs`，`scripts/lemeng/data-lanes.json` 为事实源
- [x] **A5** 起点门禁：1h 起点紧随最后一个采集偏移 + 10m 物化偏移对齐——同脚本；真机 gap 7 分钟（:58 → :05）
- [ ] **G0** 基线测量：单 build 时长/内存；两并发是否 postmaster 重启
- [x] **A1** `materialize.sh` selector 覆盖：`MATERIALIZE_LANE` 从 `data-lanes.json` 解析模型清单（tick/hourly 通用；未知车道 fail loud）+ `MATERIALIZE_HOURLY_SELECT`；3 条用例 + 静态接线断言
- [x] **A2** 10m 车道落地（仅 `fct_retail_sale`）：tick 已是该模型；A1 之后可选 `MATERIALIZE_LANE=retail_10m`（默认值不变）
- [x] **A3** 1h 车道按域分片：门店维 :04 / 10 域 :05–:41 奇数分钟错峰 / 窗口审计 :45；域 job 排除 `tag:audit_window`；load_log 按本轮模型反推上游 staging；**两轮验收：首轮 9/10（member 429）→ maxAttempts=3 后 10/10 + 审计独立 ok**；**拆域漏项的补口：`daily_report` 两件补 `data.dbt_daily_report`（09:10 CST），A4 门禁升级为「每个车道必须有 job」**
- [x] **B1** G0 基线测量 → **单飞定案**：两路并发峰值 2.46GB、重模型+采集峰值 3.02GB / 上限 4GB，无 postmaster 重启；长查询不可取消（只能预防）
- [x] **B2 第一阶段**（2026-11-25）：**实时车道留槽**（`JobDef.realtime` + 调度器 90 秒预留窗）
      + **retail_derived 分块**（order_event 343s / item_sale+quantity 65s，真机实测）+ **断言逐项计时**
      （分层的输入；本阶段**没动 asserts 频率**，避免敲掉 5 分钟探针节拍）
- [x] **B2 第二阶段**（2026-11-25）：断言**按成本分档**——结构判据（读 `pg_get_viewdef` / 表取一行）
      留 5 分钟；全量证明（`org_valid_single`）与延迟探测（`detail_path_latency`）搬进
      `data.warehouse_assertions_heavy`（`7,37 * * * *`）。实测 114s → 5 分钟档约 5s
- [x] **B2 第三阶段**（2026-11-28 收口）：
      **① chunk 不再切**——留槽已解决问题，证据：tick p50 **38s→21s**、p95 **43s→23s**（11-24→11-28），
      11-27/28 **零失败**；再切 chunk 要改 `order_event` 的窗口语义，收益不成比例。
      **② 两条新 probe 不新建 OO 规则**——按 §1.5.3 与 Phase 1 先例（「判据接上即可见，缺的从来不是规则」），
      桥 `oo-notify-bridge.sh` 通道② 消费 `verdict <> 'OK'`，新 check 自动覆盖。
      **③ 反向测试已做**：`WIRE_ORG_VALID_SINGLE_SELFTEST=1` 注入 → OO `data_plane_probes` 里确有
      `check=org_valid_single / verdict=ERR` 行（时间戳对得上执行时刻）⇒ 桥路径通
- [ ] **C1–C6** 水位 / 幂等 / 热湖互补性回归
- [x] **D1** SLA 事实源 `scripts/lemeng/sla.json`（产品/域/源/窗口/阈值）+ `check-data-lanes` 覆盖门禁（域缺条目/源 id 不存在/多出域 即红）
- [x] **D2** `scripts/lemeng/sla-check.mjs`（只读测量，恒 exit 0）+ `data.sla_check`（seed disabled）+ 11 条纯函数测试
- [x] **D3** `data.sla_measure` 历史表 + 观测模式（写表、不发探针）；源→建判据改 `|built−source|`：10m ≤10m、1h ≤75m（1h 源领先是节拍）
- [x] **D4** 观测回填 p95 + 接 OO 告警 + 开闸（**2026-11-27 完成**）：`data.sla_check` 继续 `*/5` 运行；
      **ERR 行投 OO `probe=sla`**（桥转企微，只投事实、不改判定/退出码）；阈值**按实测维持现值**
      ——真滞后 p95 全部低于阈值（10m 8.0 vs 10；1h 0.5–48.1 vs 75），唯一超阈的是真停摆。
      理由写进 `sla.json` 注释：不为了好看而调阈值
- [ ] **G6** 48h soak（**未到期**：tick 自 11-27 00:00 零失败、SLA 自 11-27 13:00 零 ERR
      ⇒ 最早 11-29 00:00（tick）/ 11-29 13:00（SLA）满 48h；到期前不翻绿）

### P0.5 物化水位门禁

> **2026-11-28 设计草案（未开工，待裁）**——先把「内容水位」是什么钉住，否则 S1–S9 无从谈起。
>
> **要解决的问题**：现在每个域到点就整轮重建，不管源端有没有新数据。拿「无变化」的日子跑全量，
> 既是成本也是**可变面的制造机**（时序方法论 §1 ② 的频率维）。
>
> **内容水位 = 源端能自己给出的「这一批数据变过没有」的证据**，三档强度（由强到弱）：
>
> | 档 | 判据 | 例子 | 可用性 |
> |---|---|---|---|
> | A | 源端提供版本/修订戳 | `last_edit_time` / `update_time` / ETag | 最好，**要先逐源确认有没有** |
> | B | 源端返回行数或合计 | 预聚合端点的 `total_count` | 便宜，但「改了值不改行数」看不出来 |
> | C | 我们自己算的内容指纹 | 上一批文件的 `count(*) + sum(金额列)` | 兜底，**只能事后发现**，省不了这一轮 |
>
> **前置取证（S1 之前必须先做）**：逐源确认它能给 A / B / C 哪一档，**能不能给**由接口实测决定，
> 不许按文档假设（案例 27：契约写「T-1 有数据」，实测恰好相反）。
>
> **默认值必须 fail-open**：拿不到水位 ⇒ 照常重建（`wm_kind='always'`）。**绝不能**因为读不到水位就跳过——
> 那是把「不知道」当成「没变」。
>
> **与 P0 车道的关系**：10m 车道（`fct_retail_sale`）**不参与**（数据一直在变，热层已是最便宜路径，见 §2 边界）；
> 先只在 1h 车道的域上试点，取「A 档 + 每日强制 build」的组合。


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
| 2026-11-25 | A1 车道选择器 | ✅ PR #2826 | `MATERIALIZE_LANE` 解析 `data-lanes.json`；未知车道 fail loud；materialize.test 112 pass |
| 2026-11-25 | A3 1h 车道拆域首轮 | ✅ 9/10 + 审计独立 | dims 34s / retail_derived 503s / purchase 42s / inventory 87s / client 33s / branch 63s / transfer 27s / outbound 53s / request 94s / loss 33s；窗口审计独立 ok 167s；**member 429 失败**（#2831） |
| 2026-11-25 | 429 容量竞态修复 | ✅ PR #2832 | lane `maxAttempts` 3 / dims 2；**DB 已写库** |
| 2026-11-25 | A3 拆域第二轮（修复后） | ✅ **10/10 + 审计** | 13:09–13:48：dims 36s / retail_derived 498s / purchase 39s / inventory 101s / **member 30s（429 修复生效）** / client 33s / branch 62s / transfer 27s / outbound 50s / request 96s / loss 30s；窗口审计 168s 独立 ok |
| 2026-11-25 | D1/D2 SLA 事实源 + 只读测量 | ✅ PR #2844 | `sla.json`（10m/1h 十域/日）+ `sla-check.mjs` + `data.sla_check`（disabled） |
| 2026-11-25 | **A3 漏项：daily_report 无 job** | ✅ 本 PR | `fct_retail_item_profit` / `fct_retail_profit` 拆域后停更；补 `data.dbt_daily_report`（09:10 CST）+ SLA daily_report + A4 门禁「每个车道必须有 job」 |
| 2026-11-26 | C 封版分区压缩 P0（单源端到端） | ✅ 搬运+记账+读面全部落地 | 48 个 `_MONTH` 文件；全史 parity 635,632+19,297=654,929；读速 275.4s → **21.9s**（线上视图 22.1s）；管线 `lemeng.lake.compact`（03:10）+ job `data.lake_compact_index`（03:40）；两腿视图 `stg_lemeng_business_collection_receive` |
| 2026-11-25 | B2 第二阶段：断言按成本分档 | ✅ 本 PR | 逐项计时实测：`org_valid` 84.4s（74%）/ `detail_path` 23.4s / 其余 14 条 ≤0.5s ⇒ 视图类改读 `pg_get_viewdef`（毫秒，抓的仍是 #2638 的同一根因）、表类 `limit 1`；全量证明与延迟探测搬 30 分钟 job；5 分钟档 114s → ~5s，probe 名不变（OO 存量规则零改动），新增两条为加法 |
| 2026-11-25 | B2 第一阶段：留槽 + 分块 + 计时 | ✅ 本 PR | 近 6h tick 领取迟到 p50 46s / p90 220s / max 442s，而利用率仅 39%（断言 118s×每5分钟=20% 容量、retail_derived 505s）⇒ 判定「排队无优先级」而非容量不足；`realtime` 标记 + 90s 预留窗（`hasDueSoon`）；retail_derived 拆两块（实测 order_event 343s / item_sale 27s / quantity 37s）；断言逐项 ms 只进 stdout |
| 2026-11-27 | 夜间/白天 tick 两条验证 + ETag 连续两天 | ✅ 已勾 | 见「待验证」三条的括注；白天首轮 09:02 `ok` 55.6s，当日 mart 与热层**逐账套门店数相等** |
| 2026-11-27 | `#2666` 月文件写不全 —— 已自愈，无现存偏差 | ✅ 核账 | parity 对账（2026-11 至今，逐账套×日比天文件 vs 月文件）：11-01～11-25 **全部一致**（11-20 已补齐 12,068 行 / ¥336,163.99）；**只有 11-26 月文件为 0**——它今早 07:40 才封版，月 compaction 每天 20:10 跑 ⇒ 今晚并入，属设计内滞后。根因仍待复发取证 |
| 2026-11-27 | 热层 GC 开闸（#2901） | ✅ 本次 PR | 生产首跑发现审计行恒报 `deleted=0`（psql `-q` 抑制命令标签），修好后重跑打真值；清空后视图对 11-26 仍 15,444 行（天文件腿）；排班 `next_run_at=2026-11-27T19:25Z` |
| 2026-11-27 | 压缩推广 #1：`member_summary` 两腿读 | ✅ PR #2929 | 48 个对象（24 月×2 账套）、parity 逐月相等（2024-11..2026-10）；读面翻两腿后 2026-10 视图 7,740 = 索引 5,471+2,269、2026-11 视图 6,213 = 原始 4,354+1,859 |
| 2026-11-27 | 压缩索引补输入指纹 | ✅ PR #2932 | `input_pattern`/`input_files` 两列（幂等 ALTER）——「月文件陈旧」从只能人工 parity 变成可查可判 |
| 2026-11-27 | 断言 ㉓ `compact_parity` 常驻 | ✅ PR #2935 | 每源核边界月、行数精确相等、原始 glob 用 `input_pattern`；heavy 档实测 2.2s（5,471=5,471）；判不了给 UNKNOWN |
| 2026-11-27 | `inventory_movement` 暂缓（推广 #2） | ⏸ 有据 | 同分区两条写路径（`all.parquet` + `chunk=segN`）会漏片；且消费方是 10 天窗、压缩收益低 ⇒ 排在 `retail_order_line` 之后甚至不做 |
| 2026-11-27 | SLA 判据按方向拆开（#2899） | ✅ 本次 PR | 旧 `|built−source|` 把「源闲置」判成「建落后」：2 天 120 条 ERR 里 **101 条** 是夜里源冻结（00:50 后无新单）+ tick 照建的形态。改为「只有 `source−built > 阈值` 才 ERR；`built ≥ source` 记『源无新数据』并给闲置分钟」。**生产回放**：窗口内 2,676 行，lag 判据 ERR 120 → **3**，其余 16 条 ERR 来自 build-age（建没跑，真问题）。D4 的假红噪音由此清除 |
| 2026-11-26 | 数据面密钥泄漏根治 | ✅ PR #2886 | 夜间回填**每次回读都 `create_simple_secret`** ⇒ 22,817 个内存态密钥，每次请求线性变慢（单文件 0.37s→0.01s、1,508 文件 275.4s→24.6s）。修复 + 分级清理，生产降回 2 个 |
| 2026-11-26 | 本周四项（观测面假红/真停摆） | ✅ PR #2888 | ㉒ 密钥数守卫（>5 判红，advisory）· `retail.windows.l1` 挪到 08:50 单轮（消除与 tick 的确定性 ETag 撞车）· SLA 加窗口起步宽限（09:00 那批 80 条假红）· 排空只拦批量车道（重启不再停摆 10–20 分钟） |
| 2026-11-26 | 对账台账归口 + 当夜自愈 + 对账档挪夜间 | ✅ PR #2891 / #2895 / #2897 | ① `recon_run` 从主档移到对账档（主档超时不再连坐台账）；② 新增 `data.recon_ledger_guard`（CST 04:30，判据与断言 ⑪ 同一 SQL，缺行才重建 ≈35s）；③ 对账档 11:45 → **03:30**（#2792 挪夜间时漏改的化石排班，白天那轮 ~500s 全史 CTAS 正撞 ETag）。**生产验证**：11-27 04:30 首跑 `RECON_LEDGER_GUARD_OK missing=0`；台账 bizday 推到 11-24；主档回到 17.5 分钟 |
| 2026-11-25 | 部署僵尸 running 行 | ✅ 本 PR（#2835） | `publish_dims` 部署被杀后行停留 22 分钟占槽（启动对账兜不住「executor 没重启」）；改为 runner 心跳：executor 每 10s 写 `platform.job_heartbeat`，`reapStale` 对「心跳过期 5 分钟」的 running 行直接 timeout（不再等 2×timeout）；有据可依的过期才回收，无心跳的旧 runner 仍走 2×timeout |

## §6 变更记录

| 日期 | 变更 | 原因 |
|---|---|---|
| 2026-11-24 | 建立本路线图，P0/P0.5/P1/P1.5/P2 分档 | 内容过多，先立导航面防跑偏 |

## §7 详细设计指针

- 湖封版分区压缩（C）：`docs/superpowers/specs/2026-11-26-lake-closed-partition-compaction-design.md`（P0 待实施）
- 热层设计：`docs/superpowers/specs/2026-11-23-retail-hot-layer-design.md`
- 增量 mart 与频率：`docs/superpowers/plans/2026-11-06-materialize-frequency-and-incremental.md`
- 数据面架构：`docs/architecture.md` §5
- 本线的详细 spec（待写）：`docs/superpowers/specs/2026-11-24-freshness-lanes-design.md`（P0 静态门禁落地后补）
