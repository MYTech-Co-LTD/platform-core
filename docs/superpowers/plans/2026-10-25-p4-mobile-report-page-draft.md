# P4 移动端报表页拼装方案（熊喵店92 月度经营报告）
> 2026-10-25。上游：`2026-10-25-xiongmao-store92-monthly-report.md`（P0-P5 全部数据面已完成）。
> 约束：**平台自绘报表零改码**（panel=metricId+args×dims）、移动端形态、**能提不能发**（agent 提报→人审发布）。

## 0 前置依赖（发布闸）
- loss/member 两族 L1 进词表 = **山海更版**（窗口待定）。
- fct_member_summary 进 PG = 物化 job（本轮已手动触发）。
- 报表提报通路：agent 工具面（/mcp-manage propose_report）或 REST POST /reports（需平台会话）——**页门 requiredScope=data:manage 由平台强制**，提报后**人审发布**。

## 1 页面结构（移动端竖向单列，一章一屏）
| # | 章节 | panel 构成（每 panel 一屏块） | L1/数据源 | 状态 |
|---|---|---|---|---|
| 1 | 核心指标卡 | KPI 大数卡×N：销售额/客单数/客单价/配送金额/配销差额/费用/报损/应收/应付/净毛利（本期值，环比同比在卡角小字） | retail:net_sales / retail:order_count / loss:branch_amount / expense:branch_* / member:branch_vip_money | L1 待词表（loss/member）；零售/费用族已有 |
| 2 | 销售趋势 | 折线（日粒度 10-01..19）+ 环比卡 | retail:net_sales grain=bizday | ✅ 可拼 |
| 3 | 时段分布 | 柱状（2h 桶） | **需新 L2/L1（时段桶派生）**——staging.hour 在，桶列待声明 | 待声明 |
| 4 | 会员卡 | 会员销售/客单/占比 | member:branch_vip_money/vip_nums + receive_money 派生占比 | L1 待词表 |
| 5 | 报损表 | 表格（cause×金额） | loss:branch_amount grain=cause | L1 待词表 |
| 6 | 重点商品 | 表格 Top10（净销售额×商品维） | retail 净销售×商品粒度 L1（**待声明**——stg 有 item 粒度） | 待声明 |
| 7 | 费用明细 | 表格（expense_type×direction） | expense:branch_net grain 含 expense_type | ✅ 已有 |

## 2 五列对比形态的移动端替代
docx 的「本期/上月/环比/去年/同比」五列表在移动端窄屏不可读。替代：**每卡=本期大数 + 环比/同比两个小箭头**（panel 卡角）；期间对比数据由 compare_to 语义（**待 L2/L1 对比期声明**——word 档已登记为 P3 语义层件）。首期可只出本期值卡（对比期第二批）。

## 3 拼装顺序（词表就位后，一个会话内完成）
1. propose_report 提报「熊喵曲靖沾益2店经营月报」（renderer=platform，页门 data:manage）
2. panels 按上表 1→7 顺序逐个加（args=店92+2026-10-01..19 窗口）
3. **人审发布**（页门清空）→ 移动端真机走查（CDP 视口 390×844）
4. 逐格对 docx 验收（销售额/客单/会员/报损/费用五族锚已全部逐分闭合）

## 4 遗留登记
- 时段桶/重点商品/对比期三件 L1/L2 待声明（P3 语义层扩展，随山海更版批）
- 全店扇出 foreach 父子管线（member/loss 现为 [92] 单店静态批次）
- 配送金额口径对账（P2，transfer_money vs 湖内调入）
