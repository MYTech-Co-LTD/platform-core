# 售后消费采集维表——实施计划（#476 PR②）

> 状态：**待两口拍**（§3；拍前不动手）。发布面（PR① #477/#478）已生产闭环：
> `data.dim_branch` 400 行 / `data.dim_item` 41,945 行（2026-10-07），探活⑥盯防。
> ADR：`docs/superpowers/specs/2026-10-07-cross-module-data-consumption.md`（形状②）。

## 1 侦察结论（2026-10-07 实测）

- 售后库**整库空**（ticket/employee/store/product/rules 全 0）⇒ 引用键可直接改自然键，零迁移。
- 消费面影响面 **160+ 处**：server 侧（routes/domain）约 40、测试夹具约 59、mobile 约 12+shim。
- `employee`/`employee_store` 是售后自有域（注册审批流）——**表保留**，但其 `store_id`
  引用本地空表 ⇒ 也要随引用键改。
- **账套维度是新发现（发布面没暴露、消费面必撞）**：`dim_branch` 按 (org, system_book) 分账套——
  3120=271 家、64188=129 家，**交集仅 40 家**（64188 有 89 家独有，如腾冲系列）。
  ⇒ 「售后的门店清单」不是简单 `where org=...`（那会出 400 行含两账套重复/混合）。

## 2 改造清单（拍口径后执行）

### ②a server 侧（无歧义部分）

1. `aftersales` 迁移 005：drop `region`/`store`/`product`（空表）；`employee.store_id`、
   `employee_store.store_id` → `store_code text`；`ticket.product_id/store_id (bigint)` →
   `product_code/store_code text`（`product_name/store_name` 快照列保留）。
2. `/stores`、`/guest/stores` 换源 `data.dim_branch`（按 §3-① 的账套口径过滤/去重）；
   `/products`、`/guest/products` 换源 `data.dim_item`。
3. `/employees` POST 的门店校验改查发布表；`registration`/`ticket` 域的引用与校验同步改。
4. 测试夹具：种 `data.dim_*`（发布表 = 消费契约，测试种它 = 模拟发布，合理）；约 59 处重写。

### ②b mobile 端（依赖 §3-②）

5. shim `StoreRow/ProductRow` 重映射（`id:number` → 自然键）；页面提交路径跟随 ticket 新键。
6. 价格字段：售后 `/products` 现返回无忌语义 `basic_quantity/basic_unit_price_minor`，
   乐檬维表**没有**这两列（有 item_cost_price/wholesale_price 等账套价格，语义不同）——
   选货页价格显示口径要业务拍（§3-②）。

## 3 待拍口径（拍前不动手）

| # | 问题 | 选项与影响 |
|---|---|---|
| ① | **售后的门店/商品清单按什么账套口径**？ | A. 跨账套并集去重（360 家门店，同 code 门店两账套属性可能不一致——取哪份？）B. 绑定单一账套（哪套？售后业务挂在哪个零售系统上？）C. 发布面拆第二张「去重视图」表（owner 定去重规则，消费方无感——改动在 data 侧） |
| ② | **选货页的价格/数量显示**（`basic_quantity`/`basic_unit_price_minor` 无对应） | A. 先不显示价格（只名称/规格/单位）B. 映射乐檬账套价（哪套？语义不同）C. 业务说清这两个字段的实际用途再定 |

## 4 验收（继承 issue #476 清单）

`GET /stores` `/products` 总数与发布表逐域对上；`q` 搜索+分页工作；访客面无需 data scope；
新 ticket 存自然键 + 名称快照；探活六条绿；全量门禁 + discipline 绿。
