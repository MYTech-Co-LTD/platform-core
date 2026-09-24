# 乐檬采集链路设计（山海一果 · 核心销售供应链域）

- 日期：2026-09-24
- 状态：**设计定稿（用户已确认），待 spec 评审合入**
- 依据：
  - 乐檬 AGI 网关/MCP 能力实测（2026-09-24，本仓之外调研；网关操作事实的正典 = 经验库
    条目《乐檬 AGI 网关接入手册》2026-09-24 更新版，含目录 197/分域时效/分页双风格等）
  - 本仓 main 现状（#167/#172/#177/#178/#179/#181/#187/#189/#193，数据栈 P0–P3 已落地）
  - `docs/superpowers/specs/2026-09-21-data-platform-layered-design.md`（七层分工与硬约束）
  - `duckle/README.md` §7（引擎能力接入：原生可替代/半替代/三坑/未验清单）
- 关联：`docs/superpowers/specs/2026-09-21-data-query-channels-design.md`（消费侧·问数三通道）、
  `deploy/data-plane-deploy-sop.md`（数据面部署 SOP）、issue #150（数据栈落地）
- **本文回答**：山海一果「核心销售供应链域」的数据从乐檬 AGI 到语义/消费，每一环怎么落；
  以及四项用户拍板（5 分钟零售增量 / 核心域范围 / AGI 全量回填 / 双 token）如何兑现。

---

## 0 已拍板的决策（2026-09-24，用户确认）

| # | 决策 | 内容 |
|---|---|---|
| 1 | **时效** | **零售与供应链单据均 5 分钟级增量**（零售走 posorder 时段过滤；单据系时间分量被网关忽略，走「日窗全拉 + 客户端 create_time 过滤」实现，见 §3.1/§6）；维度 T+0 日更 |
| 2 | **首期范围** | 核心销售供应链域：零售明细×2账套 + 调拨 + 批发(含退货) + 要货 + 门店/商品维度 |
| 3 | **历史数据** | AGI 全量回填（不迁移旧 parquet；旧湖被回填替代后退役） |
| 4 | **账套凭证** | 双 PAT（3120/64188 各一，均已到位）；PAT 实测绑定单账套（whoami） |
| 5 | **执行器**（两轮修正后） | **duckle 唯一管线执行器** + openship jobs 调度；**增补仅限 job 层薄 wrapper**（算窗口参数注入 env）；duckle 能力可覆盖的绝不自建 |
| 6 | **语义层单源** | `dbt/semantics/l1_metrics.yml` 是唯一 L1 事实源（拍板 2 / 2026-09-22）；**不引入 duckdb-ossie/Cube**，`modules/data` semantic-compiler 编译 L1+L2 供查询 |

---

## 1 业务结构（口径的根，用户口述钉死）

山海一果旗下两品牌 = 乐檬两个独立账套：

| 概念 | 事实 |
|---|---|
| 品牌/账套 | **3120 熊喵鲜生**（零售+批发+配送，供应链主体）、**64188 品品甜**（零售为主） |
| 门店零售明细 | 两账套各自采集、各自编码（branch_num/item_num 品牌内编号，跨账套撞号不同物） |
| 供应链侧 | 以 3120 账套为主（配送中心=branch 99） |
| 熊喵门店的配送 | **内部配送**（3120 调拨单：配送中心 99 → 熊喵门店） |
| 品品甜门店的配送 | **外部批发**（3120 批发单：总部 → 品品甜门店客户；账面是批发，集团内是供货） |
| 外部客户 | 批发客户中**除品品甜门店外**全部是事实上的外部客户 |
| 区域管理 | 两品牌门店被公司**统一划分区域**管理（跨账套的公司级维度，不随账套） |
| 商品档案 | 两账套**大部分一样**，个别不一样（item_code 是跨品牌归并键） |

由此派生的五条口径（**只在 ④ 建模层定义一次**，见 §7.3）。

---

## 2 主体模型：账套 ≠ 租户

- 山海一果 = 一个客户 = 一个 project = **平台一个租户**（对齐 `deploy/customer-onboarding.md`）。
- **账套是租户内的数据主体**，不是租户边界：两账套数据同桶同 schema，`system_book` 是数据列 + hive 分区键（消欠账 C3）。
- 隔离沿用定稿：每租户一桶一凭据一 schema；双 PAT 存数据面 env（openship isSecret），按主体路由到对应管线。**山海租户的湖桶已定名 `shanhai-data`**（2026-09-24 真机写入确认；endpoint 取内网 `xinan-1-internal.zos.ctyun.cn`、region `xinan1`、path-style、useSsl=true，五键键名按 `dbt/profiles.example.yml` 登记：`LEMENG_ZOS_BUCKET/ENDPOINT/REGION/ACCESS_KEY/SECRET`，已 isSecret 落 openship 数据面 project env）。
- **旧湖退役**：`lemeng/retail_detail/<账套>/<日期>/all.parquet`（非 hive、全 VARCHAR、字段漂移）被回填替代后整前缀下线；现有 `stg_lemeng_retail_detail`/`fct_retail_sale` 随新湖重写对齐（§7）。

---

## 3 数据源清单（7 采集面，AGI 实测 2026-09-24）

| # | 域 | ability | 账套 | 节奏（§6） | 自然键（行粒度） |
|---|---|---|---|---|---|
| 1 | 零售明细 | `nhsoft.retail.ai.pos.posorder.find` | **双** | 5min 时段窗 + 多层重放 | `(order_no, order_detail_num)` |
| 2 | 调拨单（内部配送源） | `nhsoft.ama.ai.transfer.out.order.find` | 3120 | 5min 增量 + 每小时全量 + 回溯 | `(order_no, item_num, lot_number)`（2026-09-24 实测：行无 id/序号列；单据内同品按批次拆行致 item_num 重复（100 单 655 行中 8 单重复），`(item_num, lot_number)` 残余重复 0；lot_number 有 121/655 行为空串/NULL，入键需 COALESCE） |
| 3 | 批发销售单 | `nhsoft.whs.ai.wholesaleorder.find` | 3120 | 同上 | `(wholesale_order_fid, order_detail_num)`（2026-09-24 实测：行自带 int 序号 `order_detail_num`，100 单 352 行全部 1..N 稠密 0 重复；item_num 单据内有重复（3/100 单）⇒ 序号列必需且充分） |
| 4 | 批发退货单 | `nhsoft.whs.ai.wholesalereturn.find` | 3120 | 同上 | `(wholesale_return_fid, return_detail_num)`（文档钉死：3120 近 126 天 0 退货单无法实测；OpenAPI 明细 DTO `AiWholesaleReturnDetailDTO` 自带 int 序号 `return_detail_num`，文档形状经 #3 实测交叉验证；首个真实样本落地时以唯一性断言复核） |
| 5 | 要货单 | `nhsoft.ama.ai.request.order.find` | **双** | 同上 | `(order_no, item_num)`（补货管线已实证 0 重复） |
| 6 | 门店维 | `nhsoft.user.ai.branch.find` | **双** | 全量快照日更 | `(system_book, branch_num)` |
| 7 | 商品维 | `nhsoft.base.ai.item.find`（+分类/品牌/部门） | **双** | 全量快照日更 | `(system_book, item_num)` |

批发客户维**不采集**：`whs.ai.client.find` 实测 HTTP 500（在架不可用）→ `dim_customer` 从批发明细派生（§7.2）。

> **需求侧与履约侧的分界**（要货单双账套的依据）：要货单是**需求侧**单据——各账套门店在本账套下单（熊喵店在 3120、品品甜店在 64188；补货管线双账套实测：3120 ≈3,002 单/月、64188 ≈1,117 单/月）。**履约侧**（调拨单 99→熊喵店、批发单→品品甜店/外部客户）只在 3120。§1「供应链以 3120 账套为主」的准确含义 = 主仓与发货在 3120，**不是**需求也只在 3120。

### 3.1 网关语义事实（设计已内化的，操作细节见经验库条目）

1. **分页双风格**：#1/#5/#6/#7 用 body `page_number/page_size`（**文档实写上限 200**；本仓发布版 `page_size=200 × 8 页`，容量口径与实测见 §6。早期记的「上限 100」是误读——100 在峰值窗需 14 页、末页哨兵必命中，而该窗真机全量跑通过 ⇒ 网关确实认 200）；#3/#4 用 `paging/limit/offset`；query 参数一律无效。
2. **日期语义三分域**：#1 按**营业日** + LocalTime 时段（全目录唯一支持时段过滤的域，实测真过滤）；#2/#5 按制单日（营业日最多晚 4 天 ⇒ 拉窗 [D-7, D] 再按 business_date 过滤）；#3/#4 `date_type` 显式选「制单时间/审核时间」，**时间分量被网关静默忽略**（文档 format=date-time 是假象，实测 06-07 点窗返回 10:43 的单）⇒ **单据系的 5 分钟增量靠「当日全拉 + 按 business_date 拆写覆盖」实现**：tick 全拉制单日=今日的单据、重写当日各 bizday 文件——新单 5 分钟可见；**近 7 日单据的状态变更（审核/作废）由每小时 [D-6,D] 全量覆盖刷新**（≤1h 可见，等价旧平台「5min 增量 + 每小时全量核对」）。
3. **跨度上限**（#1 文档明示）：单店 ≤3 个月 / 多店 ≤1 个月 ⇒ 回填分批策略（§9）。#3/#4 实测 >7 天直接拒绝（「查询时间区间不允许超过7天」）⇒ 其回溯/全量窗按 ≤7 天切批（每小时全量窗取 [D-6,D] 闭区间，见 §6）；#2 实测 30 天窗可查；#5 实测 8 天窗可查（同族 30 天窗亦可，2026-09-24 补测）。
4. **无 count 能力**（响应无 total）⇒ 翻页到短页 + 末页守卫；对账靠预聚合端点（§10）。
5. `branch_nums` 必须显式非空（空数组 400）；实测 100 店/批 × 30 分钟窗 0.6s。
6. **作废/取消单照返**（states 参数可过滤但不过滤）——采集层原样落，口径在建模层定。
7. 零售明细行自带 `system_book_code`；单据号自带账套前缀（YH3120…/TJ64188…）可交叉校验。

---

## 4 采集执行器：duckle 唯一 + job 层薄增补（决策 5）

### 4.1 分工

```
openship jobs（数据面机，cron）
   └─ job wrapper（shell，几十行：算窗口参数 → env 注入 → 带 --token 调 runner）
        └─ duckle-runner run duckle/<域>/<源>.<表>.json     ← 管线唯一执行器
             src.rest（body 分页=固定页容量多节点 + ctl.die 末页守卫）
             qa.contract（gate）＋ data.schema 定型 ＋ drift 门禁
             snk.minio 直写 ZOS（endpoint 不带 https / path style / useSsl / zstd）
```

- **job wrapper 是唯一自建增补**，职责仅三件：按当前时刻算窗口 env（`TIME_FROM/TIME_TO/BIZDAY/ HOUR/PART_SEQ`）、清晨 00:00–06:00 追加昨日 bizday、调 runner。无状态：窗口全部由时钟推导（`[now-10min, now]` 重叠式），**不需要水位持久化**。
- 这是 main 既定的「etl job 显式带 `--token` 跑授权作业」路径（`duckle/README.md` §7.5），不放宽 entrypoint 安全闸。
- **双账套 = 每账套一条顶层管线**（`ctl.foreach` 子管线凭据失效是实测坑，禁用）。
- 管线 JSON 由真引擎产出（duckle MCP `create_pipeline`/`validate`），仓内不手编范文；三件套纪律（`contracts/` + `duckle/` + dbt staging 同一 PR）。

### 4.2 本设计新引入的 Gate（未验，S1 实核）

| Gate | 内容 | 不通时的退路 |
|---|---|---|
| G1 | ~~`snk.minio` 对象 key 能否 `${ENV:…}` 参数化（tick 按 hour 分区直写）~~ **部分销账（G1a 2026-09-24 实测）**：本地 sink 路径 env 模板**通**——`snk.parquet` `path=/tmp/g1a/hour=${ENV:PROBE_HOUR}/all.parquet` 两跑 PROBE_HOUR=07/08 落两个目录各一文件；`mode=overwrite` 同 env 重跑为**覆盖**（inode 换新、行数仍 1、不报错不追加）。**G1b 已销（2026-09-24 真机）**：数据面机（project `platform-core-shanhai-data`）在 duckle runner 容器内跑昨日 24 时窗，回读对象存储逐条确认 key 为 `lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=NN/all.parquet`（24/24 窗 `status: ok`，空窗亦落空 schema 文件 550B），**key 内无 `${ENV:` 字面量残留**（全桶 key 扫描为空）⇒ `${ENV:…}` 模板在 snk.minio 的 bucket/key/凭据五字段上原位成立 | 退路未触发（本地湖+httpfs 上传通道保留为灾备） |
| G2 | ~~duckle（DuckDB 1.5.4）写 parquet ↔ pg_duckdb（1.4.3）回读兼容~~ **已销（2026-09-24 本机实测）**：**通**——`pgduckdb/pgduckdb:18-v1.1.1`（Postgres 18.1 + pg_duckdb 1.1.1，容器内 DuckDB 自证 v1.4.3）经 `duckdb.raw_query` 回读 1.5.4 写方（duckle 同源 CLI，`FORMAT PARQUET, COMPRESSION 'ZSTD'`）产物全通过：①Task5 zstd 样本 1 行读得出；②契约 18 列全类型面样本类型逐一吻合（VARCHAR×9、INTEGER×2、DATE、TIMESTAMP×2、DECIMAL(14,2)×3、DECIMAL(14,3)），decimal 边界值（±千亿级、0.01、-0.125、999.999）与 NULL/date/timestamp 值级保真；③hive 分区 glob 读通。⚠ 附带发现：`partitionBy` 剥离的分区键类型由路径字符串重推断——`system_book`（契约 varchar）读回 BIGINT、零填充目录 `hour=07` 读回 VARCHAR，staging 读侧须显式 cast 或 `hive_types` 钉死 | main 已列 Gate-E（T6），沿用其处置 |
| G3 | ~~调拨/批发明细嵌套行的稳定行键（order_no+item 是否够）~~ **已销（2026-09-24 实测）**：**不够**——调拨行无 id/序号列且同品多批次拆行（100 单 655 行，8 单 item_num 重复，`(item_num, lot_number)` 残余重复 0）⇒ 键 `(order_no, item_num, lot_number)`；批发行自带稠密序号（100 单 352 行全 1..N）⇒ 键 `(wholesale_order_fid, order_detail_num)`；退货 3120 近 126 天 0 单无法实测，按 OpenAPI 文档钉 `(wholesale_return_fid, return_detail_num)`（该文档形状经 #3 实测交叉验证可信） | 三键入契约时各配唯一性断言（staging 护栏）；调拨 `lot_number` 空/NULL（121/655 行）须 COALESCE 后入键；#4 首个真实样本落地时以断言复核 |
| G4 | ~~64188 token 的 whoami/能力面与 3120 一致~~ **已销（2026-09-24 实测）**：whoami `company_id=64188`、可见门店 129 家；能力面与 3120 同形（`posorder.find` 行含 `order_no`/`pos_order_details`，明细含 `order_detail_num`/`item_num`/`system_book_code`，行键范式成立） | ⚠️ 探针方法学：64188 单店单日可能空窗（店 1/99 七天窗均 0 单），探针/铺开须多店合查 |

继承 main `duckle/README.md` §7.4 未验清单中与本设计相关者：远端源 drift、容器内行为（归 S1 一并核）。

---

## 5 落地布局（消欠账对照）

```
s3://shanhai-data/lemeng/
  retail_order_line/system_book=3120/bizday=2026-09-24/hour=14/all.parquet  ← 覆盖写=该小时当前完整内容
  retail_order_line/system_book=64188/…
  transfer_out/     system_book=3120/bizday=2026-09-24/all.parquet
  wholesale_order/  system_book=3120/bizday=…/all.parquet
  wholesale_return/ system_book=3120/bizday=…/all.parquet
  request_order/    system_book=3120/bizday=…/all.parquet
  request_order/    system_book=64188/bizday=…/all.parquet
  dim_branch/       system_book=3120/snapshot=2026-09-24/all.parquet
  dim_item/         system_book=64188/snapshot=…/all.parquet
```

**写模型 = 分区单文件覆盖写**（每叶子分区一个 `all.parquet`，内容 = 该分区**当前完整内容**）：与 `contracts/` 元 schema（`fileName` 锁死 `all.parquet`）和补货管线已验证的字节级幂等范式一致。分层正典「② 不覆盖历史」的落法：① 分区文件随当日推进增长（重写=自然形态）；② **历史修正**（迟到审核/作废/改归属）由重放层幂等覆盖，同内容重跑 ETag 逐字节一致（snk.minio 实测特性）；③ 可回溯性由 `_ops` 运行记录 + 契约批次标记列承担。（曾评估过 append-only part 模型——保留每次拉取的原始状态——但与契约机器面冲突且存储翻倍，弃；记录在此防复读。）零售小时文件的完整内容由「全拉当前小时窗」保证（§6 tick 语义），单据系日文件由「全拉窗口后按 business_date 拆写」保证，**staging 不承担跨 part 去重**，只保留自然键唯一性断言作护栏。

| 旧欠账（handbook §4） | 本设计怎么消 |
|---|---|
| 列全 VARCHAR（C1） | duckle `data.schema` 落盘定型（金额 numeric/时间 timestamp/日期 date） |
| 账套只在路径（C3） | `system_book=` hive 分区键 + 行内列（零售明细行自带 sbc，其余域由管线常量注入） |
| 非 hive 命名 | 全域 hive 分区 |
| 字段集漂移（C2） | `data.schema` 声明 + `qa.contract` + `drift` 门禁（先断言声明存在，防假绿） |
| 双日期格式 | 落盘即定型为 date/timestamp |

嵌套明细（订单头↔行）：**管线内展开成行粒度**（code.sql `UNNEST`，引用列名必须用 `unnest.` 别名规则），湖里落平的行——契约列全标量、staging 免二次展开。

---

## 6 调度矩阵（openship jobs）

| job | cron | 窗口 | 覆盖写对象 |
|---|---|---|---|
| 零售 tick | `*/5` 全天 | bizday=今日（00:00–06:00 的 tick 同时打**昨日** bizday），`time_from=当前小时整点, time_to=now`（小时窗随时间增长，天然自愈漏 tick） | 当前 `hour=HH/all.parquet` |
| 零售时窗重放 | 每小时 `05` | 上一完整小时窗（抓迟到状态变更——时段过滤按成交时间） | 该 hour 文件 |
| 零售日终重放 | 02:00 | 昨 bizday 全天 24 个时窗 | 昨日全部 hour 文件 |
| 零售回溯重放 | 04:00 | [D-8, D-2] 逐日逐时窗（营业日最多晚 4 天，留余量） | 各日各 hour 文件 |
| 单据系 5min tick | `*/5`（07:00–23:00） | 制单日=今日 全拉（服务端时间分量无效，不做切片），拉回单据**按 business_date 拆写** | 当日各 `bizday/all.parquet` |
| 单据系每小时全量 | 每小时 `10` | 制单日 [D-6, D] 全量拆写——刷新近 7 日单据状态（审核/作废，≤1h 可见；闭区间 7 个日历日、date_end=D+1 00:00，恰在 #3/#4 的 7 天跨度上限内） | 各 bizday 文件 |
| 维度快照 | 05:00 | 全量翻页 | 当日 snapshot 目录 |
| 回填 | 手动/一次性 job | §9 | 同上 |

失败处理：job 失败 = openship job 告警（失败可见，不静默）；下一 tick 自然重试窗口（重叠式窗口天然容错一次漏拉）。观测：`_ops` 指标（行数/页数/窗口/耗时）由 job wrapper 写 OpenObserve（文件日志按 SOP 接入）。

**请求量估算（单据系 5min 的代价，写在这里让人看得见）**：每域每账套每天 ≈ 288 次当日全拉（2–5 页）+ 24 次 [D-6,D] 七日全量 ≈ **456 个「日窗当量」**；五条单据管线（调拨×1 + 批发×2 + 要货×2）合计 ~2.3k 次请求/天——网关实测单请求 0.6s 级，量级可承受；若实测晚高峰响应体积超标，降级方案是单据系 tick 降频至 15min（零售不受影响）。

**零售链路的页容量口径（2026-09-24 发布版；与 §3.1 #1 的「上限 200」同源）**：`page_size=200 × 8 页`，其中 **p8 是哨兵页**（挂 `ctl.die`：p8 仍有行 ⇒ 容量截断，中止——见实施计划的 Task 7）⇒ **真实静默通过阈值 = 7×200 = 1400 单/时**；1401–1600 区间落在 p8 上 ⇒ 是 **fail-loud 不丢数**（不是静默丢）。实测峰值窗 = **2026-09-23 19 点 1311 单** = **93.6%** 利用率（余量 89 单 / 6.4%）——**余量一律按 1400 算，不要写 1600**。⚠️ **扩容（如 12 页）尚未做**，已登记为后续 issue **#197**。

**已知残余风险（8 个页请求不是一个快照）**：8 个页请求**不是同一快照**——请求之间到达的单会让分页边界漂移，理论上一行可能**重复或被跳过**。当前的自愈是「整分区**覆盖写** + staging 的**自然键唯一性断言**」（重复 ⇒ 断言红，见 S1 的 `assert_stg_lemeng_retail_order_line_key_unique`）；S3（在线全域 5min 调度）会放大这个面——同一窗口 5 分钟一重拉 ⇒ 漂移机会更多。

---

## 7 dbt 模型（③ 清洗 / ④ 建模）

### 7.1 staging（一对一，只定型不改义）

`stg_lemeng_retail_order_line` / `stg_lemeng_transfer_out` / `stg_lemeng_wholesale_order` / `stg_lemeng_wholesale_return` / `stg_lemeng_request_order` / `stg_lemeng_branch` / `stg_lemeng_item`。
命名纪律 = `stg_<source>_<table>` 与 `sources.yml` 双向机检（main 已有门禁）。零售 staging 重写要点：湖已是行粒度定型列（管线内 UNNEST 已完成）→ 直接取列 + 自然键唯一性断言（覆盖写幂等的护栏）+ 状态/交易类型透传。

### 7.2 维度（marts）

| 维度 | 内容 | 备注 |
|---|---|---|
| `dim_store` | 两账套门店 union；**公司统一区域 = 平台主数据**（初值自 `report.ai.branchindicator.find` 的 region 同步，允许人工覆盖） | 区域是公司级决定，不依赖账套接口给什么；主数据所有权/跨模块消费走 #189 `dataDependencies` 协议 |
| `dim_item` + `dim_product` | 两账套档案各自完整保留；其上 canonical 商品层按 `item_code` 归并 | 「大部分一样」落在 canonical 层；个别不一样的两侧属性并存 |
| `dim_customer` | 从批发明细派生（client_fid → 最近名称/首末单/活跃天数）+ `is_pinpintian_store` 标记（品品甜门店判定：客户名匹配 64188 `dim_store`） | 替代不可用的 `whs.ai.client.find` |
| `dim_date` | 日期维 | |

### 7.3 口径（④ 定义一次，业务结构 §1 的直接映射）

```sql
内部配送   transfer_out WHERE out_branch_num = 99                     -- 熊喵门店（3120）
品品甜供货 wholesale WHERE dim_customer.is_pinpintian_store           -- 账面外部批发，集团内
外部批发   wholesale WHERE NOT is_pinpintian_store
出库       内部配送 + 品品甜供货 + 外部批发
净销售额   retail_order_line 有效单 SUM（state/交易类型白名单；退货单据为负）
```

粒度：事实四张 `fct_retail_sale`（重写）/ `fct_transfer_out` / `fct_wholesale` / `fct_replenish`，全部带 `system_book + bizday`，星型挂维度。dbt tests：自然键 unique/not_null、state accepted_values、金额范围。

---

## 8 L1 语义与对账（⑤/治理）

- **唯一事实源 `dbt/semantics/l1_metrics.yml`**（拍板 2），新增指标（初版全部 `tier: experimental`，owner: data-platform）：
  - 既有：`retail:net_sales`、`retail:order_count`（实现随新湖重写对齐；`order_count` 的列名/去重语义 G3（2026-09-24 已销）未覆盖零售口径——仍待实测钉死后转正或删除，**口径不能猜**）
  - 新增：`retail:gross_profit`、`supply:transfer_amount`（内部配送）、`wholesale:pinpintian_amount`、`wholesale:external_amount`、`supply:outbound_amount`、`replenish:request_quantity`；比率类（毛利率等）`additive=false` 语义写入 definition（上滚须重算分量）
- 每个声明指标按 `metricToAuditFileName()` 映射配一条 audit singular test（静态门禁已卡）。
- **对账源（本设计独有优势）**：AGI 预聚合端点 `report.ai.branchindicator.find`（店×日×指标，带 total_count）/ `report.ai.itemsales.find` 作为**独立第三方通道**：`明细聚合 vs branchindicator.sale_money` 逐店逐日比对，diff≠0 即红。对账拉取本身也是一个 duckle 管线（日更，落 `recon/` 前缀）。

---

## 9 AGI 全量回填（决策 3）

- 顺序：维度（branch/item 双账套）→ 零售（最大量）→ 调拨/批发/要货。
- 分批：零售按「多店 × 1 个月」为一批（跨度上限），job 循环逐月推进；单据系按**逐日单窗（每日一窗、制单日=当日）**滚动直至覆盖全部历史——#3/#4 跨度上限 7 天，不用多日窗。
- 走**同一管线同一写出通道**（回填=把窗口参数换成历史区间），保证回填数据与新采数据同型——这是「回填顺便消欠账」的实现方式。
- 深度：回填到 AGI 能给的最早日期为止（实测确认，预期 ≈ 旧湖起点 2026-07 附近）；更早历史不可得即明确记录边界。
- 出口：回填期逐日对账（§8）全绿 + 总量 sanity（店数/商品数/金额量级 vs 旧湖同期）。

## 10 验收分层（对账四层，缺一层不算过）

| 层 | 机制 | 抓什么 |
|---|---|---|
| 自证 | 写后回读对象存储（行数/金额） | 上传/转换失败 |
| 幂等 | **同 `batch_id`** 重跑 ETag/Size 逐字节一致；**换 `batch_id` 则 ETag 变——by design**（`batch_id` 是载荷列，判据与实测见 §11） | 不确定性/重复累积 |
| 独立通道 | branchindicator/itemsales 预聚合 vs 明细聚合（dbt audit） | 引擎/口径侧 bug |
| 跨系统 | 回填后与旧平台同期关键指标一次性对比 | 口径/语义分歧 |

## 11 分阶段

| 阶段 | 内容 | 出口（硬验收） |
|---|---|---|
| S1 | 首源范式：retail 3120 **日粒度**三件套（契约/管线/staging）+ G1–G4 实核 + 引擎产管线 + drift/容器行为核 | **已达成（2026-09-24 真机）**：新湖落桶（`shanhai-data` 24 对象、key 形态逐条正确、无字面量残留）；回读自证过（DuckDB httpfs：19,678 行 / 合计 1,622,276.08，FINISHED 18,566 行 / 1,522,801.61；hour=17 窗合计 **126,596.06 与既有基线逐分吻合**）；幂等**强判**通过（同 batch_id 重跑 ETag/Size 逐字节一致、对象数恒 1；换 batch_id 则 ETag 变——batch_id 是载荷列，by design）；drift 门禁**有效**（8 源声明断言 + 5 源实际比对、added-only 非阻断、exit 0；首跑 0 checked 仍 exit 0 = 实证「防假绿」断言的必要）；容器内行为**已核**（runner 容器内跑管线/回读/drift 全通）。⚠ 逐店对账未归零（149/149 全为正、合计 +17,250.91 / +1.15%），作 S2 口径对齐基线（见 §11 注） |
| S2 | dbt 域扩展：staging 七源 + 四事实 + 三维 + 口径五条 + 对账 tests（含 recon 管线） | 口径表 vs branchindicator 逐店逐日 diff=0 |
| S3 | 在线全域：零售 + 单据系 5min 调度全量铺开（tick/每小时全量/日终/回溯）+ 64188 双账套 | 双账户全域在线 5min；漏拉注入测试（跳 tick 后下一窗自愈）；状态变更 ≤1h 可见 |
| S4 | AGI 回填（§9） | 回填期对账全绿 + 与旧平台一次性对比记录 |
| S5 | L1 指标补全转正 + Metabase 看板（modules/data 报表面）+ 问数三通道接通 | 端到端问数（词表=L1 声明） |

> **S1 对账注（2026-09-24 真机，S2 对齐起点）**：湖内 FINISHED 明细行 SUM 逐店 vs AGI branchindicator 当日 `sale_money`——149 家有值门店**全部为正差**（无负差、无湖内独有店），合计 +17,250.91（+1.15%），逐店相对差 0.00%~39.28%（均值 1.11%），最大绝对差 +5,940.21（branch 157 保山隆阳2店）。全正的系统性偏置指向口径差（branchindicator 侧疑为扣除/净额口径），**非抽取缺失**——支撑证据：hour=17 窗合计与既有基线 126,596.06 逐分吻合。S2 口径对齐后该表应归零。另：branchindicator 单次 `branch_nums` 上限 100 家（269 家须 3 批拉取），已入 S2 实现约束。

每阶段开工前对照 `docs/architecture.md` 架构先行门；实现 PR 引用 issue #150（数据栈）或按需开新 issue。

## 12 非目标（明确不做）

- 会员/商城/WMS/采购/库存域（第二波，同一范式接入）
- 旧 parquet 迁移改造（被回填替代，旧湖直接退役）
- earth-gateway 通道保留（不依赖；其历史使命由回填终结）
- Ossie / Cube / 任何第二套语义引擎（决策 6）
- 零售 hour 分区 compaction、跨小时合并优化（量级不需要，出现读放大再议）
- 问数三通道本身的实现（已有独立 spec/plan）
