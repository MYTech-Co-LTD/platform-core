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
| 1 | **零售时效** | 5 分钟级增量（AGI posorder 时段过滤支持，不走 earth-gateway）；其余域日内定时覆盖 |
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
- **账套是租户内的数据主体**，不是租户边界：两账套数据同桶同 schema，`company_id` 是数据列 + hive 分区键（消欠账 C3）。
- 隔离沿用定稿：每租户一桶一凭据一 schema；双 PAT 存数据面 env（openship isSecret），按主体路由到对应管线。
- **旧湖退役**：`lemeng/retail_detail/<账套>/<日期>/all.parquet`（非 hive、全 VARCHAR、字段漂移）被回填替代后整前缀下线；现有 `stg_lemeng_retail_detail`/`fct_retail_sale` 随新湖重写对齐（§7）。

---

## 3 数据源清单（7 采集面，AGI 实测 2026-09-24）

| # | 域 | ability | 账套 | 节奏（§6） | 自然键（行粒度） |
|---|---|---|---|---|---|
| 1 | 零售明细 | `nhsoft.retail.ai.pos.posorder.find` | **双** | 5min 时段窗 + 多层重放 | `(order_no, order_detail_num)` |
| 2 | 调拨单（内部配送源） | `nhsoft.ama.ai.transfer.out.order.find` | 3120 | 日窗覆盖 ×3 次 | `(order_no, 明细行键)`⚠️G3 |
| 3 | 批发销售单 | `nhsoft.whs.ai.wholesaleorder.find` | 3120 | 日窗覆盖 ×3 次 | `(wholesale_order_fid, 明细行键)`⚠️G3 |
| 4 | 批发退货单 | `nhsoft.whs.ai.wholesalereturn.find` | 3120 | 日窗覆盖 ×3 次 | 同上 |
| 5 | 要货单 | `nhsoft.ama.ai.request.order.find` | 3120 | 日窗覆盖 ×3 次 | `(order_no, item_num)`（补货管线已实证 0 重复） |
| 6 | 门店维 | `nhsoft.user.ai.branch.find` | **双** | 全量快照日更 | `(company_id, branch_num)` |
| 7 | 商品维 | `nhsoft.base.ai.item.find`（+分类/品牌/部门） | **双** | 全量快照日更 | `(company_id, item_num)` |

批发客户维**不采集**：`whs.ai.client.find` 实测 HTTP 500（在架不可用）→ `dim_customer` 从批发明细派生（§7.2）。

### 3.1 网关语义事实（设计已内化的，操作细节见经验库条目）

1. **分页双风格**：#1/#5/#6/#7 用 body `page_number/page_size`（上限 100）；#3/#4 用 `paging/limit/offset`；query 参数一律无效。
2. **日期语义三分域**：#1 按**营业日** + LocalTime 时段（全目录唯一支持时段过滤的域，实测真过滤）；#2/#5 按制单日（营业日最多晚 4 天 ⇒ 拉窗 [D-7, D] 再按 business_date 过滤）；#3/#4 `date_type` 显式选「制单时间/审核时间」，**时间分量被网关静默忽略**（文档 format=date-time 是假象，实测 06-07 点窗返回 10:43 的单）。
3. **跨度上限**（#1 文档明示）：单店 ≤3 个月 / 多店 ≤1 个月 ⇒ 回填分批策略（§9）。
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
| G1 | `snk.minio` 对象 key 能否 `${ENV:…}` 参数化（tick 按 hour 分区直写） | tick 落本地湖 → wrapper 用 DuckDB httpfs 上传（已投产通道） |
| G2 | duckle（DuckDB 1.5.4）写 parquet ↔ pg_duckdb（1.4.3）回读兼容 | main 已列 Gate-E（T6），沿用其处置 |
| G3 | 调拨/批发明细嵌套行的稳定行键（order_no+item 是否够） | 按实测样本钉死自然键后回填契约 |
| G4 | 64188 token 的 whoami/能力面与 3120 一致 | 按 3120 范式微调后双账套铺开 |

继承 main `duckle/README.md` §7.4 未验清单中与本设计相关者：远端源 drift、容器内行为（归 S1 一并核）。

---

## 5 落地布局（消欠账对照）

```
s3://<山海桶>/lemeng/
  retail_order_line/company_id=3120/bizday=2026-09-24/hour=14/part-<runid>.parquet  ← 每 run 追加一个 part
  retail_order_line/company_id=64188/…
  transfer_out/     company_id=3120/bizday=2026-09-24/part-<runid>.parquet
  wholesale_order/  company_id=3120/bizday=…/part-<runid>.parquet
  wholesale_return/ company_id=3120/bizday=…/part-<runid>.parquet
  request_order/    company_id=3120/bizday=…/part-<runid>.parquet
  dim_branch/       company_id=3120/snapshot=2026-09-24/part-<runid>.parquet
  dim_item/         company_id=64188/snapshot=…/part-<runid>.parquet
```

**写模型 = append-only**（对齐分层正典「② 落地原样保留、不覆盖历史、可回溯」）：每次 run 写自己的 part（`<runid>` 唯一），重放/回溯也只是再追加一个 part；**同一自然键的多版本由 staging 去重收敛**（保留最新拉取批次）。这与补货管线「按日覆盖写同一对象键、字节级幂等」的已验证范式是**有意的范式选择差异**——选 append-only 的理由：① 与分层设计 §2 正典一致；② Raw 层保留每次拉到的原始状态（含状态迁移痕迹），可回溯可审计。代价（重放窗口的多份存储，有界：零售每窗最多重拉 ~8 次）按 parquet 压缩后可接受。幂等验收相应改为「同窗重跑后 staging 收敛结果一致」（§10）。

| 旧欠账（handbook §4） | 本设计怎么消 |
|---|---|
| 列全 VARCHAR（C1） | duckle `data.schema` 落盘定型（金额 numeric/时间 timestamp/日期 date） |
| 账套只在路径（C3） | `company_id=` hive 分区键 + 行内列（零售明细行自带 sbc，其余域由管线常量注入） |
| 非 hive 命名 | 全域 hive 分区 |
| 字段集漂移（C2） | `data.schema` 声明 + `qa.contract` + `drift` 门禁（先断言声明存在，防假绿） |
| 双日期格式 | 落盘即定型为 date/timestamp |

嵌套明细（订单头↔行）：duckle 侧**不展开**（schema 只声明标量列、嵌套列交给真实数据推导——实测纪律），行粒度展开在 dbt staging 用 `UNNEST` 完成（引用列名必须用 `unnest.` 别名规则）。

---

## 6 调度矩阵（openship jobs）

| job | cron | 窗口 | 追加 part 到 |
|---|---|---|---|
| 零售 tick | `*/5` 全天 | bizday=今日（00:00–06:00 的 tick 同时打**昨日** bizday），`time_from=now-10min, time_to=now` | 当前 hour 目录 |
| 零售时窗重放 | 每小时 `05` | 上一完整小时窗（抓迟到状态变更——时段过滤按成交时间） | 该 hour 目录 |
| 零售日终重放 | 02:00 | 昨 bizday 全天 | 昨日各 hour 目录 |
| 零售回溯重放 | 04:00 | [D-8, D-2] 逐日（营业日最多晚 4 天，留余量） | 各日各 hour 目录 |
| 单据系日采 | 07:30 / 12:00 / 18:00 | 制单日 [D-7, D]；拉回单据**按 business_date 拆写**到各自 bizday 目录（迟到落账自然归位，无「窗口外丢弃」） | 各 bizday 目录 |
| 维度快照 | 05:00 | 全量翻页 | 当日 snapshot 目录 |
| 回填 | 手动/一次性 job | §9 | 同上 |

失败处理：job 失败 = openship job 告警（失败可见，不静默）；下一 tick 自然重试窗口（重叠式窗口天然容错一次漏拉）。观测：`_ops` 指标（行数/页数/窗口/耗时）由 job wrapper 写 OpenObserve（文件日志按 SOP 接入）。

---

## 7 dbt 模型（③ 清洗 / ④ 建模）

### 7.1 staging（一对一，只定型不改义）

`stg_lemeng_retail_order_line` / `stg_lemeng_transfer_out` / `stg_lemeng_wholesale_order` / `stg_lemeng_wholesale_return` / `stg_lemeng_request_order` / `stg_lemeng_branch` / `stg_lemeng_item`。
命名纪律 = `stg_<source>_<table>` 与 `sources.yml` 双向机检（main 已有门禁）。零售 staging 重写要点：UNNEST 明细 → 行粒度 + 自然键去重（append-only 多版本的收敛点）+ 状态/交易类型透传。

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

粒度：事实四张 `fct_retail_sale`（重写）/ `fct_transfer_out` / `fct_wholesale` / `fct_replenish`，全部带 `company_id + bizday`，星型挂维度。dbt tests：自然键 unique/not_null、state accepted_values、金额范围。

---

## 8 L1 语义与对账（⑤/治理）

- **唯一事实源 `dbt/semantics/l1_metrics.yml`**（拍板 2），新增指标（初版全部 `tier: experimental`，owner: data-platform）：
  - 既有：`retail:net_sales`、`retail:order_count`（实现随新湖重写对齐；`order_count` 的列名/去重语义按 G3 实测钉死后转正或删除——**口径不能猜**）
  - 新增：`retail:gross_profit`、`supply:transfer_amount`（内部配送）、`wholesale:pinpintian_amount`、`wholesale:external_amount`、`supply:outbound_amount`、`replenish:request_quantity`；比率类（毛利率等）`additive=false` 语义写入 definition（上滚须重算分量）
- 每个声明指标按 `metricToAuditFileName()` 映射配一条 audit singular test（静态门禁已卡）。
- **对账源（本设计独有优势）**：AGI 预聚合端点 `report.ai.branchindicator.find`（店×日×指标，带 total_count）/ `report.ai.itemsales.find` 作为**独立第三方通道**：`明细聚合 vs branchindicator.sale_money` 逐店逐日比对，diff≠0 即红。对账拉取本身也是一个 duckle 管线（日更，落 `recon/` 前缀）。

---

## 9 AGI 全量回填（决策 3）

- 顺序：维度（branch/item 双账套）→ 零售（最大量）→ 调拨/批发/要货。
- 分批：零售按「多店 × 1 个月」为一批（跨度上限），job 循环逐月推进；单据系按日窗循环（[D-7,D] 滚动直至覆盖全部历史）。
- 走**同一管线同一写出通道**（回填=把窗口参数换成历史区间），保证回填数据与新采数据同型——这是「回填顺便消欠账」的实现方式。
- 深度：回填到 AGI 能给的最早日期为止（实测确认，预期 ≈ 旧湖起点 2026-07 附近）；更早历史不可得即明确记录边界。
- 出口：回填期逐日对账（§8）全绿 + 总量 sanity（店数/商品数/金额量级 vs 旧湖同期）。

## 10 验收分层（对账四层，缺一层不算过）

| 层 | 机制 | 抓什么 |
|---|---|---|
| 自证 | 写后回读对象存储（行数/金额） | 上传/转换失败 |
| 幂等 | 同窗重跑后 **staging 收敛结果一致**（append-only 原始层 + 自然键去重，见 §5 写模型） | 不确定性/重复累积 |
| 独立通道 | branchindicator/itemsales 预聚合 vs 明细聚合（dbt audit） | 引擎/口径侧 bug |
| 跨系统 | 回填后与旧平台同期关键指标一次性对比 | 口径/语义分歧 |

## 11 分阶段

| 阶段 | 内容 | 出口（硬验收） |
|---|---|---|
| S1 | 首源范式：retail 3120 **日粒度**三件套（契约/管线/staging）+ G1–G4 实核 + 引擎产管线 + drift/容器行为核 | 新湖落桶；回读自证过；pg_duckdb 读得出（G2） |
| S2 | dbt 域扩展：staging 七源 + 四事实 + 三维 + 口径五条 + 对账 tests（含 recon 管线） | 口径表 vs branchindicator 逐店逐日 diff=0 |
| S3 | 在线全域：零售 5min 调度（tick/时窗/日终/回溯）+ 64188 双账套铺开 + 单据系三节奏 | 双账套全域在线；漏拉注入测试（跳 tick 后下一窗自愈） |
| S4 | AGI 回填（§9） | 回填期对账全绿 + 与旧平台一次性对比记录 |
| S5 | L1 指标补全转正 + Metabase 看板（modules/data 报表面）+ 问数三通道接通 | 端到端问数（词表=L1 声明） |

每阶段开工前对照 `docs/architecture.md` 架构先行门；实现 PR 引用 issue #150（数据栈）或按需开新 issue。

## 12 非目标（明确不做）

- 会员/商城/WMS/采购/库存域（第二波，同一范式接入）
- 旧 parquet 迁移改造（被回填替代，旧湖直接退役）
- earth-gateway 通道保留（不依赖；其历史使命由回填终结）
- Ossie / Cube / 任何第二套语义引擎（决策 6）
- 零售 hour 分区 compaction、跨小时合并优化（量级不需要，出现读放大再议）
- 问数三通道本身的实现（已有独立 spec/plan）
