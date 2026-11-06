# 零售侧键缺口（W7 Task 1 实测，2026-11-07）

## 实测（生产仓库，单日 2026-10-20，只读）

`staging.stg_lemeng_retail_order_line` 共 **26 列**：

| 键 | 有/无 | 证据 |
|---|---|---|
| `item_num` / `item_code` | ✅ 有 | 15,267 行 **100%** 有 `item_num`；去重 **1,858** 个商品；商品维在 `staging.stg_lemeng_item` |
| 客户类字段（`client_fid`/`customer`/`member`/`vip`/`phone`/`card`） | ❌ **零命中** | 26 列里搜不到任何客户标识 |

## 结论

1. **商品维度可做**：新建 `fct_retail_item_sale`（粒度 = 账套×业务日×门店×商品），口径是**行级金额**，
   与 `fct_retail_sale`（净销售额，逐单计算）**不是同一口径**，不可互相替代。
2. **客户维度补不了**：零售订单行不含客户标识 ⇒ `retail × client` **不进关系声明**；
   客户分析只能走 `fct_hq_outbound.client_fid` / `fct_client_contribution` / `fct_client_expense`。
   若业务确需"按客户看零售"，那是**源侧缺口**（POS 订单未关联会员/客户），需业务方推动源系统改造。

## 副作用与边界

- `fct_retail_sale` **一个字节未改**：50 条指标回归基线不受影响（唯一键、粒度断言、逐单除法口径都不动）。
- 新模型首次物化后需验：行数 = 当日去重 (店,商品) 组合数；`item_num` 对 `stg_lemeng_item` 命中率 ≥95%。
