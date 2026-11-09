| 用户说法 | 首选指标 |
|---|---|
| 营业额 / 销售流水 | `lemeng:retail:sales`（不冲退货）；要冲退货用 `lemeng:retail:net_sales` |
| 销售金额 | 同上 |
| 配送金额 / 门店配送 | `lemeng:branch:transfer_money`（= `outbound:store_delivery`） |
| 出库金额（集团去重） | `lemeng:outbound:amount` = 门店配送 + 外部批发 |
| 外部批发金额 | `lemeng:outbound:external_wholesale` |
| 体系内批发 | `lemeng:outbound:region_net` 的 `体系内批发` 通道（3120 批发镜像） |
| 采购金额 / 采购 Top5 | `lemeng:purchase:amount`（按 `supplier_num` 分组 + Top-N） |
| 配销差额 / 配销比 | = 销售金额 − 配送金额（`lemeng:retail:sales` − `lemeng:branch:transfer_money`）；两条分别查，**不要拿配送金额当销售金额** |
| 门店数 / 门店销售 | `lemeng:branch:transfer_money`（门店配送）/ `retail:*` 系列 |
