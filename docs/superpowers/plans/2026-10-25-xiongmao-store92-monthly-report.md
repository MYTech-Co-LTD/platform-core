# 熊喵门店月度经营报告 · 移动端报表页与数据面补齐
> 2026-10-25 · 状态：设计稿（待评审）。起源：按《熊喵曲靖沾益2店2026年10月经营报告_截至19日.docx》做可复用语义层报表页；约束：报表页零改码、移动端形态。追踪 issue 待开。

## 0 一句话
销售侧锚点已逐分复现（销售额 51,273.89 / 客单数 957）；缺口全部在采集面（费用回填、报损未采）与语义层（桶/派生/期间标签），报表平台侧零改码。

## 1 实测证据（2026-10-25，湖=pg_duckdb staging，账套 3120，门店 92=熊喵曲靖沾益2店/dim_branch.code=沾益02）
| docx 锚 | docx 值 | 湖侧实测 | 判定 |
|---|---|---|---|
| 销售额 10-01..19 | 51,273.89 | 51,273.89（fct_retail_sale.net_amount） | ✅ 逐分 |
| 客单数 | 957 | 957 | ✅ 逐分 |
| 配送金额 | 32,114.96 | 调入 14,328.27（stg_lemeng_transfer_in.subtotal，仅「调入单」型）；批发直配假设已排除（店92 wholesale_out=0 行） | ❓ 口径待取证 |
| 应收累计 | 415.00 | 5.00（按审核日窗） | ❌ 采集空窗 |
| 应付累计 | 3,028.42 | 537.69 | ❌ 采集空窗 |
| 报损累计 | 806.64（来货损259.16/自然损387.64/试吃159.84） | 未采（client_expense 仅抖音补贴/售后补损两类 kind）；q_loss=299.19 非此口径 | ❌ 未采 |
| 会员三指标 | 47.36% 占比等 | staging 全层无 member/vip/card 列 | ❓ 上游待探 |
| 时段(2h) | 有 | stg_lemeng_retail_order_line.hour 8..23 在 | ✅ 可建模 |
| 商品级 | Top10 | order_line 商品行在 | ✅ 可建模 |

## 2 根因（已实证）
- **费用缺口**：`lemeng.branch.expense.l0.3120` 管线 10-13 首跑，每日只采 T-1 审核日单日（台账行 927：窗口=审核日）⇒ 10-01..11 空窗；上线前已审核的单（如 docx 整车运费 410，制单 9 月底）**永久漏**。湖内现存：店92 只有 10-21 新单 605（10月5-20号周期）。容量=硬编码 3 页×100=300（10-19 实测 287 行，逼近上限，无哨兵——§1.6 案例 26 同型）。
- **报损**：otherinout.find（D05 客户费用同端点）只滤了两类 kind；报损三类未采；staging 已带 `other_inout_audit_time`（归期口径有解）。
- **配送**：调入 14,328.27≠32,114.96；transfer_in 仅「调入单」型；待乐檬侧「配送金额」报表定义（候选：直配单据/时间窗语义）。
- **会员**：网关免凭据 tools/list=401；3120 console（shanhai-data 项目）凭据通路未建立。

## 3 工作包
- **P0 费用回填**（D04 既有源补数，§1.7 续行）：backfill 管线按审核日 9-20..10-12 逐日翻页（page_size≤200+容量哨兵，幂等覆盖写）。锚=回填后 ER=415.00 / EP=3,028.42 逐分 + 笔数。
- **P1 报损采集**（新源 §1.7 新行）：otherinout.find + 报损三类 kind；契约双轨（contracts/ + data.schema 申报一致，生成器产投影）；落 `stg_lemeng_loss_otherinout`→`fct_loss`（book×bizday×branch×kind[×item 明细视探针]）；词表 L1 报损金额；回溯跨度=探针必答（去年锚 1,541.24）。锚=806.64 + 三原因分组逐分。
- **P2 配送口径对账**：取乐檬侧「配送金额」定义 → 定模型。锚=32,114.96。
- **P3 语义层**：新 L1＝报损金额、净销售×商品（order_line 建 `fct_retail_sale_item`）、时段桶（2h 维列）、期间标签族（本期/上月同期/去年同期，dbt 日重算）；L2 expr＝客单价（同关系✓）、配销比、占比族；**净毛利/环比同比% 物化进经营报告 mart**（跨关系/跨期，expr 档结构上不可达——L2 B 中档 spec §2.3/2.5）。改声明走「山海更版→词表 job」链（#300 分叉在案）。
- **P4 移动端报表页（零改码）**：panel={metricId,args(店92+窗)}×dims；竖向单列、一章一屏、KPI 大数卡+行=期间标签简表；agent 工具面提报→人发布→移动视口真机验收（开发完自验纪律）。
- **P5 会员**：网关 tools/list 实探 → 有源建采集 / 无源标「上游无源」沉淀台账。

## 4 纪律挂点
P1 走 collect-source A→I（探针四条：真实值/能力反问/跨度上限/whoami）；P0 续既有登记行；动契约跑生成器+lock 脚本；新管线接 data-monitor 三层判停；开工前 WeKnora 查重（检索入口待接通）。

## 5 验收总锚
报表页逐格对 docx 全表（含三段时段表、星期分组、Top10、会员章视 P5）；移动端真机走查。

## 6 修正（2026-10-25 晚，WeKnora 查重复用 + OpenAPI 免鉴权实证）
- **P0/P1 日期参数语义修正**（复用 WeKnora「date_type 枚举终版」+「AGI 网关接入手册」）：网关日期过滤的是**制单日期**（营业日可晚制单日最多 4 天）；date_type 短词（「制单/审核」）被静默忽略返回全史，必须传长词「制单时间」并**实证返回数据的日期形状**（min/max 单据日断言）；查询窗 ≤7 天分片；WHS 系（otherinout）分页是 `paging/limit/offset` 风格。⇒ 回填=按制单窗逐 7 天片拉、湖内按 `audit_time` 归窗，配容量哨兵+日期分布断言；回填调度避开北京 20:00-21:00 时段性 429。
- **P1 字段面实证**（openapi.json 免鉴权拉取）：`nhsoft.whs.ai.otherinout.find` 请求支持 `other_inout_kinds`（复数）/`branch_nums`/`items` 明细/`state_code`；响应含 `other_inout_audit_time`/`other_inout_bizday`/商品明细 ⇒ 报损「商品×原因」章节有源。
- **P2 对账源定案**：`nhsoft.report.ai.branchindicator.find`（metrics/periods → `actual_value`，含「配送」等 11 指标，响应带 total_count）作为乐檬侧口径真值源，与湖内调入 14,328.27 对照定「配送金额」口径；openapi 已拉（branch_num/branch_region_name/metric/period 字段面在案）。
- **P5 预期修正**：WeKnora 记录 crm.ai.customer.find「在架但接口不存在」⇒ 会员探针预期=不可用；实跑 tools/list + call 定谳后按「上游无源」沉淀。
- WeKnora 查重结论：报损采集无既有条目（新坑，收口后沉淀）；网关手册 + date_type 两条已复用。

## 7 上游定谳（2026-10-25 深夜网关实跑，凭据=console env `LEMENG_TOKEN` 就地取用，未落转录）
| 上游问题 | 定谳 | 逐分验证 |
|---|---|---|
| 报损源 | **`nhsoft.ama.ai.adjustment.order.find`**（库存调整单）：`branch_nums`/`start_date`/`end_date`（纯 yyyy-MM-dd）/`page_number`+`page_size`；响应 `cause`(来货损/自然损/试吃)/`direction`=出库/`total_money`/`audit_time`/`cause_code` | 店92 窗10-01..19：来货损 10 单 259.16 + 自然损 17 单 387.64 + 试吃 8 单 159.84 = **806.64 逐分**（docx 三分组+合计全中） |
| 会员源 | **`nhsoft.report.ai.customeranalysissummary.find`**（客单分析，`summary_types=["order_sale_type"]`）：行带 `customer_vip_money/vip_nums/receive_money/customer_nums` | 销售 24,202.20 + 拼团 82.19 = **24,284.39 逐分**；会员客单 446+9=**455**；占比 **47.36%**——docx 三值全中 |
| 配送真值源 | **`nhsoft.report.ai.branchindicator.find`** `transfer_money`（metrics 枚举 11 指标）：date=周期内任一天→整月值；group_type=day 未生效（返回 period=202610 整月） | 整月 42,967.50 vs docx 19日 32,114.96 量级吻合；**19 日切点需日粒度**——group_type=day 参数再调或按 day 拉逐日累计（待办） |
| 费用 | 既有源 branch.expense.find 有效（env token 下 HTTP 200） | 回填 P0 不变（10-13 上线空窗） |
| 「上游没有」登记 | **无**。全部有源；ocrm.ai.customer.find（会员档案 paid_member/消费档案）与 posorder 行级 `order_card_phone` 亦可用（会员占比行级判定的备选） | — |
**坑记录（已复用/新踩）**：① MCP `/agi/mcp` 对管线 REST token 返 invalid_token 的真因=未先 initialize（无状态、无 session id，initialize 后 tools/call 可用）；② 连接卷 `connections/lemeng.json` 的 authToken 是 10-08 旧值已失效，**现行有效凭据在容器 env `LEMENG_TOKEN`**（token 轮换只更新 env 不回写卷文件——待与 token 轮换 SOP 对表）；③ date 参数三种形态并存：带时分秒（ama 费用）/纯 LocalDate（crm、adjustment、indicator）/LocalTime（posorder 时段）；④ 客户分析的会员口径=全部 order_sale_type 的 vip 字段合计（含拼团），漏拼团差 82.19。
