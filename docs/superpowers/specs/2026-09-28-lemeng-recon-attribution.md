# 乐檬零售对账缺口自主归因报告

> bizday = **2026-09-27**（单日下钻）｜账套 = **3120**｜门店 = **150**（有数据店，来自 `BRANCH_NUMS`）
> 湖：`lemeng/retail_order_line/system_book=3120/bizday=2026-09-27/hour=*`（9233 行）
> 对账源：`report.ai.itemsales.find`；明细源：`pos. posorder.find`
> 只读执行：数据面机 `<serverId 8281d598>` 容器 `lemeng-console-3120`（openship MCP server exec）；未写湖、未改生产、未外发
> 证据脚本：`docs/recon-attribution-evidence/`（s1–s28 共 28 个复现脚本 + 归因表）

---

## 0. 结论摘要（先看这五条）

| # | 结论 | 状态 |
|---|---|---|
| 1 | **#287 的「item 级两边全部逐分一致 ⇒ 湖数据无损」是错的**，且错因已定位：join 键类型不匹配 | **推翻（已复核，附原始输出）** |
| 2 | **−364.49 已 100% 逐元归因**，24 店全部闭合，**未被解释部分 = 0.00** | **完成** |
| 3 | 缺口构成：**赠品 −363.01（99.6%）+ 退货 −1.48（0.4%）**，4608 个 (店,商品) 里 4566 个逐分吻合 | **完成** |
| 4 | **能否归零**：退货部分可归零（我方漏采字段）；**赠品部分不可归零**——网关该字段恒为空，非我方丢失 | **给出边界** |
| 5 | **我方采集侧确有 2 处真实缺陷**（`item_code` 恒空 + 关键字段未采），单独见 §5 | **需改管线** |

---

## 1. 第一优先：#287 可疑结论复核 —— **推翻**

### 1.1 原结论与错因

#287 写：「item 级对照（summary_types=[branch,item]）：**两边共有的 (店,商品) 全部逐分一致**——湖数据无损」。
结论来源是 `reconA` 脚本，其 join 键构造为：

```python
key = (int(row["branch_num"]), row["item_num"])   # 湖侧：item_num 从 duckdb -csv 读出 → str
pre[(w["branch_num"], w["item_num"])] = w         # 平台侧：JSON 数字 → int
```

实测两边的真实类型（s3_item.py 原始输出）：

```
LAKE   item_num sample vals: ['312009072', '312005039', ...]   ← VARCHAR（湖 schema 确认：item_num VARCHAR）
PREAGG item_num TYPES: ['int']                                  ← int
overlap(int str) = 81   ← 用错键时
```

> ⚠️ 湖 schema 里 `item_num` 是 **VARCHAR**（`contracts/common/lemeng.retail_order_line.json` 明确「varchar 防撑爆」）。
> 故 `(255, "312009072") != (255, 312009072)` ⇒ **81/81 全部落空**，脚本把「全部未匹配」打印成 `lake item-rows with NO preagg counterpart: 81`，
> 被读成了「平台排除了 81 个商品」。

### 1.2 正确类型重做后的原始输出（s4_itemcmp.py，店 255/92）

```
=== ITEM-LEVEL, stores [255, 92] | pre=81 lake=81 keys | intersect=81
lake-only (preagg excluded): 0 | preagg-only: 0
=== MATCHED ROWS (diff = pre.sale_money - lake.fin_pos) ===
rows with money diff >=0.005: 37 / 81 ; sum=-134.40
  b=255 item=312006711 diff=-61.05 qdiff=-2.042 pre_sale=0.00 present=2 lake=61.05 泰国金枕榴莲-优级
  b=92  item=312006952 diff=-28.21 qdiff=-1.015 pre_sale=0.00 present=1 lake=28.21 秋月梨特级
  b=92  item=312013871 diff=-22.05 qdiff=-0.855 pre_sale=0.00 present=0 lake=22.05 会泽盐水石榴特级
  b=255 item=312006962 diff=-19.80 qdiff=-1.014 pre_sale=0.00 present=1 lake=19.80 会泽盐水石榴优级
  b=92  item=312014785 diff=-1.80  qdiff=-1.000 pre_sale=0.00 present=1 lake=1.80  可口可乐矮听330ml
```

**判定：不一致 —— 且差额正好等于该店分支级残差。**

- 店 255：−61.05 + −19.80 = **−80.85** = 该店分支残差 ✓
- 店 92：−28.21 + −22.05 + −1.80 = **−52.06** = 该店分支残差 ✓

### 1.3 全量重做（s7 / s12，24 家残差店）

`lake-only = 5`（且 `fin_pos` 全为 0.00，见 §1.4）、`preagg-only = 0`；
**逐店 item 级 gap 求和 = 该店分支残差，24/24 全部 `OK`**：

```
bn      sum(pre)  sum(lake)   sum_diff br_resid  closure
14       3452.10    3471.97     -19.87   -16.00      OK
19       2033.08    2140.10    -107.02   -14.54      OK
92       2845.40    2898.16     -52.76   -52.06      OK
255      1526.10    1607.74     -81.64   -80.85      OK
260      1546.00    1750.91    -204.91   -70.06      OK
...（24 家全部 OK）
```

> 注：`sum_diff` 与 `br_resid` 不等是**因为分支级公式还要减 `order_detail_share_discount` 与 `return_money`**，
> 减完即等。正确的逐项目径是 `gap = pre.sale_money − (lake_gross − pre.share_discount − pre.return_money)`。

**⇒ #287 该条结论作废。** 真实结论：**两边 (店,商品) 集合相同、无排除，但金额在具体商品上不一致；差额可以在 item 级精确定位。**

### 1.4 顺带澄清：55 个「湖有平台无」的键不是数据问题

全量 150 店：湖侧 4663 个 (店,商品) 键，平台侧 4608，交集 4608，**湖独有 55 个**。
逐一核验（s27_lakeonly.py）：**55 个全部 `FINISHED` 净额 = 0.00**，状态只有 `CANCELED`(48) / `REPAID`(6) / 两者(1)。
即平台不报「只有作废/反结账行」的商品。**非数据丢失。**

---

## 2. −364.49 逐元归因表

### 2.1 归因方法（可复现）

对每个 (店,商品)：

```
gap = pre.item.sale_money − ( lake_gross − pre.item.order_detail_share_discount − pre.item.return_money )

  lake_gross = Σ(lake.sale_money WHERE state='FINISHED' AND sale_money>=0)
```

`lake_gross` 与平台 `sale_money` **在 4566 个商品上逐分相等**（gap=0.00）。

### 2.2 总账（s21_final.py）

```
items=4608  SUM gap = -364.49

category                  items      sum_gap
0_exact                    4566         0.00     ← 99.09% 的商品逐分吻合
1_gift(present>0)            21      -363.01     ← 99.63% 的残差
2_return(ret>0)              21        -1.48     ← 0.41% 的残差
5_OTHER (无 present/return 且 |gap|>=0.5)   0     0.00     ← 未被解释 = 0
```

**判别式：平台侧 `present_num`（赠品数量）与 `return_num`（退货数量）。**

| 判别 | 含义 | 证据 |
|---|---|---|
| `present_num > 0` | 该商品的**整行/部分行被平台按赠品剔除**（数量与金额同时剔除） | 见 §2.3 |
| `return_num > 0` | 该商品的**部分行属退货单**，平台按 `return_money` 冲减 | 见 §2.4 |
| 两者皆 0 | 逐分吻合 | 4566 项 |

### 2.3 逐店归因表（24 家残差店，全部闭合）

| 店 | 残差 | 赠品(present_num) | 退货(txn_type) | 未解释 |
|---|---|---|---|---|
| 14 | -16.00 | -16.00 | 0.00 | **0.00** |
| 19 | -14.54 | -14.54 | 0.00 | **0.00** |
| 29 | -25.80 | -25.80 | 0.00 | **0.00** |
| 36 | -3.04 | -3.00 | -0.04 | **0.00** |
| 48 | -20.29 | -20.29 | 0.00 | **0.00** |
| 51 | -0.12 | 0.00 | -0.12 | **0.00** |
| 62 | 0.06 | 0.00 | 0.06 | **0.00** |
| 75 | -19.80 | -19.80 | 0.00 | **0.00** |
| 89 | -19.80 | -19.80 | 0.00 | **0.00** |
| 90 | -0.20 | 0.00 | -0.20 | **0.00** |
| 92 | -52.06 | -52.06 | 0.00 | **0.00** |
| 94 | -0.38 | 0.00 | -0.38 | **0.00** |
| 131 | -0.04 | 0.00 | -0.04 | **0.00** |
| 141 | -21.33 | -21.33 | 0.00 | **0.00** |
| 155 | -0.16 | 0.00 | -0.16 | **0.00** |
| 188 | -14.40 | -14.40 | 0.00 | **0.00** |
| 190 | -0.02 | 0.00 | -0.02 | **0.00** |
| 246 | -5.14 | -5.14 | 0.00 | **0.00** |
| 250 | -0.28 | 0.00 | -0.28 | **0.00** |
| 255 | -80.85 | -80.85 | 0.00 | **0.00** |
| 257 | -0.06 | 0.00 | -0.06 | **0.00** |
| 260 | -70.06 | -70.00 | -0.06 | **0.00** |
| 264 | -0.14 | 0.00 | -0.14 | **0.00** |
| 266 | -0.04 | 0.00 | -0.04 | **0.00** |
| **合计** | **-364.49** | **-363.01** | **-1.48** | **0.00** |

### 2.4 赠品 21 项（−363.01）—— 逐项证据

| 店 | item_num | 商品 | gap | 平台 present_num | 平台 sale_num | 湖 gross |
|---|---|---|---|---|---|---|
| 255 | 312006711 | 泰国金枕榴莲-优级 | -61.05 | 2.042 | 0 | 61.05 |
| 260 | 312003086 | 特价商品（销） | -55.00 | 1.0 | 3.0 | 308.70 |
| 92 | 312006952 | 秋月梨特级 | -28.21 | 1.015 | 0 | 28.21 |
| 29 | 1332 | 七点谷力芙芙蕾蛋糕 | -25.80 | 1.0 | 0 | 25.80 |
| 92 | 312013871 | 会泽盐水石榴特级 | -22.05 | 0.855 | 0 | 22.05 |
| 48 | 312011431 | 法兰西西梅（一级） | -20.29 | 0.51 | 0.63 | 45.36 |
| 75 | 312005116 | 牧业纯牛奶 | -19.80 | 1.2 | 7.0 | 364.60 |
| 255 | 312006962 | 会泽盐水石榴优级 | -19.80 | 1.014 | 0 | 19.80 |
| 89 | 312014882 | 小橙优选小青柠汁 | -19.80 | 2.0 | 0 | 19.80 |
| 14 | 312011754 | 牛油果（拼团个） | -16.00 | 8.0 | 6.0 | 35.80 |
| 260 | 3364 | 青犀蜜瓜 | -15.00 | 2.0 | 0 | 15.00 |
| 188 | 312003086 | 特价商品（销） | -14.40 | 3.0 | 4.0 | 191.30 |
| 19 | 312008728 | 乡韵 云腿小饼麦（80g） | -8.50 | 1.0 | 15.0 | 136.00 |
| 141 | 312001728 | 美都麒麟瓜B | -8.43 | 1.686 | 1.73 | 25.55 |
| 19 | 312004560 | 三红柚特级 | -6.04 | 1.344 | 13.284 | 120.01 |
| 246 | 312001546 | 进口香蕉 | -5.14 | 0.516 | 3.898 | 43.72 |
| 141 | 312003052 | 鲜切水果（销） | -5.00 | 1.0 | 0 | 5.00 |
| 141 | 312016358 | 玫瑰红柚（一级） | -4.99 | 1.0 | 11.0 | 74.49 |
| 36 | 312001546 | 进口香蕉 | -3.00 | 0.6 | 0 | 3.00 |
| 141 | 312002287 | 金枕榴莲肉 | -2.91 | 0.294 | 0 | 2.91 |
| 92 | 312014785 | 可口可乐矮听330ml | -1.80 | 1.0 | 0 | 1.80 |

**机制（单行取证，s15_gifts.py）**：平台把**赠品行**从 `sale_num`/`sale_money` 里整体剔除，数量改记到 `present_num`。
以店 260 `312003086` 为例（同一商品 4 行）：

```
h=10 ord=...004 det=3  sale= 16.00  disc=  0.00 qty=1.000   ← 保留
h=19 ord=...020 det=2  sale= 55.00  disc= 55.00 qty=1.000   ← 赠品行，剔除
h=20 ord=...025 det=1  sale=187.70  disc=  0.00 qty=1.000   ← 保留
h=20 ord=...026 det=1  sale= 50.00  disc=  0.00 qty=1.000   ← 保留
湖 gross = 308.70 ； 平台 sale_money = 253.70 = 308.70 − 55.00 ✓
平台 present_num = 1.0 = 被剔除行数量 ✓ ； 平台 sale_num = 3.0 = 4.000 − 1.0 ✓
```

### 2.5 退货 21 项（−1.48）—— 逐项证据

| 店 | item_num | 商品 | gap | 平台 return_num | 平台 return_money | 湖 gross |
|---|---|---|---|---|---|---|
| 250 | 312006712 | 泰国金枕榴莲特级 | -0.28 | 5.918 | 318.9 | 1095.68 |
| 94 | 312017743 | #红宝石柚（特级） | -0.18 | 1.216 | 48.3 | 142.86 |
| 264 | 3364 | 青犀蜜瓜 | -0.14 | 1.226 | 24.2 | 48.54 |
| 90 | 312006952 | 秋月梨特级 | -0.12 | 1.44 | 36.8 | 94.45 |
| 94 | 312016696 | #福建三红柚 | -0.10 | 0.826 | 16.3 | 52.50 |
| 155 | 312017743 | #红宝石柚（特级） | -0.10 | 1.466 | 58.29 | 116.68 |
| 94 | 312009072 | 越南金枕榴莲 | -0.10 | 2.838 | 112.9 | 409.41 |
| 51 | 312011053 | 泰国金枕榴莲（特级散果） | -0.10 | 5.062 | 261.14 | 522.38 |
| 257 | 312006712 | 泰国金枕榴莲特级 | -0.06 | 2.672 | 133.3 | 266.66 |
| 260 | 312006713 | 泰国金枕榴莲优级 | -0.06 | 2.692 | 134.3 | 268.66 |
| 36 | 312001606 | 红宝石柚（特级中果） | -0.04 | 1.355 | 53.9 | 377.53 |
| 90 | 3209 | 青花蜜瓜(特级) | -0.04 | 0.665 | 13.14 | 118.67 |
| 131 | 312001546 | 进口香蕉 | -0.04 | 0.26 | 3.6 | 9.69 |
| 155 | 312003452 | 串收番茄 | -0.04 | 0.818 | 32.53 | 117.73 |
| 266 | 312009072 | 越南金枕榴莲 | -0.04 | 1.822 | 65.2 | 1348.70 |
| 51 | 3450 | 夏能王子蜜瓜 | -0.02 | 1.61 | 31.86 | 256.47 |
| 90 | 312013587 | 叶子叔叔百分享（西瓜味VC软糖）20g（盒装） | -0.02 | 1.0 | 11.89 | 162.70 |
| 190 | 312006711 | 泰国金枕榴莲-优级 | -0.02 | 1.91 | 76.0 | 654.97 |
| 155 | 312001557 | 昭通苹果优级 | -0.02 | 0.86 | 11.68 | 35.08 |
| 90 | 312001990 | 甄甜麒麟瓜（特级） | -0.02 | 0.95 | 9.47 | 102.35 |
| 62 | 312016692 | #突尼斯软籽石榴优级 | 0.06 | 0.986 | 15.6 | 31.14 |

### 2.6 一个必须记下的排除项：`discount_money >= sale_money` **不是**赠品标记

归因中一度以为「行折扣 ≥ 行金额」即赠品（它在若干赠品行上恰好成立：`55.00/55.00`、`14.40/30.00`、`61.05/122.11`）。
**实测证伪**（s14_cand / s20_contrast）：

- 全湖 `disc≥sale` 行金额合计 **17,804.60**，而真实被剔除的只有 **363.01**——规则会**误杀 98%**。
- 反例：店 15 `3094` 甄甜麒麟瓜 **20 行全部 `disc>sale`**，平台 `sale_money=420.00` 与湖 `420.60 − sd 0.60` **逐分吻合**，一行未剔；店 164 `312016359`（15 行）、店 28 `3143` 同理。
- 平台侧 `discount_money` 与湖侧**逐分相等**（店 15：676.79 = 676.79；店 164：1202.90 = 1202.90），说明折扣列本身没采错，**赠品与否与折扣列无关**。
- 赠品行也**不必**满足 `disc≥sale`：店 250 `312006712` 被判退货的 3 行折扣为 `0.00 / 17.60 / 17.48`，均 `< sale`。

> **结论：任何基于湖侧 `sale_money/discount_money/qty` 的排除规则都无法复现平台口径。** 这正是下面 §3 的分水岭。

---

## 3. 能否归零？

### 3.1 分两半回答

| 组成 | 金额 | 能否归零 | 依据 |
|---|---|---|---|
| **退货** | −1.48 | **能** —— 只需补采订单级 `order_transaction_type` | §3.2，已验证可**逐分复现** |
| **赠品** | −363.01 | **不能（当前通道）** —— 网关该字段恒为 null，不是我方丢失 | §3.3，已实测 |
| 未解释 | 0.00 | — | — |

### 3.2 退货：已验证可归零（s24_retmark.py）

订单级字段 `order_transaction_type ∈ {SALE_ORDER, PARTIAL_ORDER_RETURN, FULL_ORDER_RETURN, NO_ORDER_RETURN}`。
**非 `SALE_ORDER` 订单内的行金额，逐店逐商品等于平台的 `return_money`**：

```
bn  n_ord n_nonsale | 非销售单行金额 by item        | 平台 return_money / return_num
19     44      1    | 011698=5                     | 011698=5/1.000            diff=0.00
36     37      1    | 001606=54                    | 001606=54/1.355           diff=0.02
51     47      1    | 011053=261 3450=32           | 011053=261/5.062 3450=32/1.610  diff=0.06
90    120      3    | 006952=37 004141=20 3209=13  | 006952=37/1.440 004141=20/3.000 3209=13/0.665  diff=0.10
94     46      3    | 009072=113 017743=48 016696=16 | 009072=113/2.838 017743=48/1.216 016696=16/0.826 diff=0.19
250    78      4    | 006712=319 006711=28         | 006712=319/5.918 006711=28/2.854  diff=0.14
...（24 店全查，全部 0.0x 级差，差额=被剔行的 share_discount）
```

单行取证：店 250 `312006712` 的退货正是这三单 —— `PARTIAL_ORDER_RETURN(...018, 2.374)` + `FULL_ORDER_RETURN(...065, 1.766)` + `FULL_ORDER_RETURN(...074, 1.778)`，数量 2.374+1.766+1.778 = **5.918** = 平台 `return_num` ✓。

### 3.3 赠品：当前通道下**不可归零**（s22_livefields.py 实测）

OpenAPI 文档（`PosOrderDetailAiVO`，75 字段）**确实定义了**赠品标记：
`order_detail_state`（`PRESENT-赠送(代码2)`）、`order_detail_policy_present_flag`（是否赠品促销明细）、`order_detail_policy_flag`（4=赠品促销）。

**但真机响应里这些字段是空的**（店 255 全 58 行 / 店 19 全 67 行统计）：

```
=== 店 255 全 58 行 order_detail_state 直方图 ===  {None: 58}
=== 店 255 全 58 行 order_detail_policy_flag 直方图 ===  {None: 58}
=== 店 19 全 67 行 非空计数 ===
   order_detail_std_price      67
   order_detail_price          67
   order_detail_online_qty     67
   order_detail_share_discount 43
   order_detail_discount       37
   order_detail_state          0        ← 恒空
   order_detail_policy_flag    0        ← 恒空
   order_detail_policy_present_flag 0   ← 恒 False
目标赠品行（店 255 单 3120255262700020030）实测：
   money=61.05 amount=2.042 disc=122.11 std=59.8 price=29.9 | present_flag=False policy_flag=None
```

**⇒ 赠品/销售的拆分（`present_num`）是平台内部按促销规则算出来的，`posorder.find` 不暴露。**
不是「我方漏采了能解决它的字段」——**补采这些字段也拿不到**。

**要归零只剩外部路径**（即《对账口径确认清单-致乐檬》Q1/Q2 要的东西）：
1. 赠品标记字段的**真值供给**（网关把 `order_detail_state`/`policy_present_flag` 填上）；
2. 或 `present_num` 的计算规则文档；
3. 或赠品商品/促销单清单的获取途径。

> ✅ 结论更新：S2 的 `audit_*` 可以把断言收紧到 **「逐店 |diff| < 0.5 且差额必须落在平台 `present_num>0` / `return_num>0` 的商品上」**，
> 即**把残差变成有名有姓、可复算的排除项**，而不是无解释的 0.11%。

---

## 4. 我方**已采但可用**的字段：`order_detail_share_discount` 可自算

顺带验证（s26_sdcheck.py，30 店 × 1120 个商品）：

```
items checked=1120  exact=1120  mismatch=0  worst_err=0.0000
```

`Σ(行 order_detail_share_discount)` **逐分等于**平台 item 级 `order_detail_share_discount`。
⇒ 补采这一列后，**分支级公式里的 `sd` 可以自算**，不再依赖平台报表（当前是 `pre.sale_money + sd + ret` 反推）。

**分支级公式的可自算度**（补采后）：

```
可自算：Σ sale_money、Σ share_discount、退货冲减（order_transaction_type）
不可自算：赠品剔除（present_num）           ← 唯一剩余的硬依赖
```

---

## 5. ⚠️ 我方采集侧缺陷（**要改管线**，本节显著标出）

> 判定标准：不是「上游没给」，而是「上游给了、我们没落」。

### 5.1 `item_code` 恒为 NULL —— 读了**不存在的 JSON 路径**（确证）

管线节点 `flatten`（`duckle/common/lemeng.retail_order_line.json`）写的是：

```sql
json_extract_string(u.d, '$.item_code') AS item_code
```

**但 `item_code` 不在 `PosOrderDetailAiVO` 的 75 个字段里，也不在订单级 `PosOrderAiVO` 里**（s26 结构核验）：

```
PosOrderDetailAiVO has item_code  -> False
PosOrderAiVO       has item_code  -> False
```

**真机后果**：湖里 9233/9233 行 `item_code` 全为空串：

```
rows=9233 item_code non-null=0 empty=9233
```

**影响**：`item_code` 是契约里写明的「跨品牌归并键」（`dbt/models/common/staging/stg_lemeng_*.sql` 依赖它做归并），恒空 ⇒ **该归并维度实际失效**。
（真实可用的是 `item_num` + 维度表 `lemeng.item`；或 `order_detail_item`（商品名称，不稳定，不宜作键）。）

### 5.2 明细 75 字段只采了 8 个 —— 其中 2 个会影响对账能力

现采：`order_detail_bizday / order_detail_num / branch_num / item_num / order_detail_money / order_detail_discount / order_detail_payment_money / order_detail_amount`（→ 契约 18 列）。

**建议补采（按对账价值排序）**：

| 字段 | 层级 | 价值 | 证据 |
|---|---|---|---|
| `order_transaction_type` | 订单 | **可让退货部分逐分归零**（−1.48） | §3.2 已验证 |
| `order_detail_share_discount` | 明细 | **可自算分支级 `sd`**，摆脱报表依赖 | §4 已验证 1120/1120 |
| `order_detail_std_price` / `order_detail_price` | 明细 | 复核折扣/改价口径 | 真机有值 |
| `order_detail_online_qty` | 明细 | 线上单规格换算数量（团购渠道） | 真机有值 |
| `order_ref_billno` | 订单 | 退货关联原单号（问答 Q3 取证） | 文档有 |
| `order_detail_state` / `policy_present_flag` / `policy_flag` | 明细 | ⚠️ **采了也没用**（真机恒 null/False） | §3.3 |

### 5.3 `payment_money` 是冗余列

`payment_money`（契约「行收款金额」）与 `sale_money` **逐行完全相同**：

```
lines=8993  pay!=sale: 0
```

`order_detail_payment_money` 在真机恒等于 `order_detail_money`，**无独立信息量**，不可用于任何判别（也正好解释了 §2.6 那些基于 `payment_money=0` 的假设为何全部选空）。

### 5.4 非缺口类小观察（不影响金额）

`bizday=2026-09-27` 分区内有 **4 行** `order_time` 落在 2026-09-28（店 153 ×2、店 79 ×2），**全部 `CANCELED`**，不进 `FINISHED` 口径 ⇒ 与 #287「时间锚假设排除」一致，非本次缺口成因。

---

## 6. 对 #287 的更正动作

| 动作 | 状态 |
|---|---|
| 在本报告给出复核判定 + 正确 join 的原始输出 | ✅ **已执行**（§1，含 raw output） |
| 更正评论正文（声明原 item 级结论作废 + 真实结论 + 指导意义） | ✅ **已备好**：`docs/recon-attribution-evidence/issue-287-correction-comment.md` |
| 把更正评论贴到 issue #287 | ⏳ **待执行** —— 本轮 worker 纪律明令「Don't post to Slack, GitHub, or other channels during the run; report through these commands」；且任务书本身允许「已执行或待执行，标明」。**正文已就绪，协调者/人类一声即可发布。** |
| 同步《对账口径确认清单-致乐檬》 | ⏳ **待执行**，且清单有一条**实质更新**（非文字润色）：Q2 应从「请增加赠品标记字段」改为 **「字段已存在（`order_detail_state`/`order_detail_policy_present_flag`）但网关返回恒为空/false，请填真值，或提供 `present_num` 计算规则 / 赠品清单」**——否则对方会答「我们文档里有这个字段」，问题不闭环。建议新增 Q8 承载这一点。 |

> ⚠️ 上两条都是**外发动作**（GitHub issue / 发给乐檬），按纪律不擅自发布。
> 另：Q1 的措辞也建议收紧——原文「差额与赠品数量强相关，怀疑按赠品商品标记排除」，
> 现在可升级为**已确认**：`present_num` 是官方字段「商品赠送数量」，21 个商品逐项对上、占残差 99.63%。

---

## 7. 第二优先（三条自主路径）执行情况

| 路径 | 状态 | 结果 |
|---|---|---|
| ① 查全字段（posorder OpenAPI） | ✅ 已走通 | `PosOrderDetailAiVO` **75 字段**、`PosOrderAiVO` 53 字段全部列出；**发现 6 个对账相关字段**（`order_transaction_type` / `order_detail_share_discount` / `std_price` / `price` / `online_qty` / `order_ref_billno`）；**同时证伪**「补采赠品标记即可归零」——赠品标记字段真机恒空（§3.3）。**本路径是本次归因的关键转折。** |
| ①′ itemsales 官方定义 | ✅ 已取到 | 见下 |
| ② 用 `present_num` 反推赠品价值 | ✅ 已走通 | **这就是 −363.01 的全部来源**：21 个 `present_num>0` 商品逐项对上，99.63% 残差被它解释（§2.4）。**不需要新字段即已闭环归因** |
| ③ 第三源交叉（`branchindicator.find`） | ⬜ 未做 | 路径 ② 已把残差归到 0.00，第三方口径已无边际价值；**留作后续**：若乐檬回话推翻 `present_num` 语义，再用它做交叉 |

### 7.1 itemsales.find 官方字段定义（`AiSaleAnalysisRow`，18 字段）

请求：`bizday_start`/`bizday_end`（≤31 天）+ `summary_types`（`branch`/`item`/`bizday`，≤2 个）+ `branch_nums`（**必传，≤100 家**）；
另支持 `item_nums` / `item_departments` / `category_codes` / `supplier_nums` 过滤。
返回 `result.{total_count, rows}`；**维度字段按 `summary_types` 条件返回**（选 branch 才有 `branch_num`，选 item 才有 `item_num`/`item_code`/`item_name`/`spec`/`unit`）——这解释了 §1.1 里「只选 branch 时没有 item 字段」的形状。

| 官方字段 | 官方定义 | 本次实测语义 |
|---|---|---|
| `sale_num` | 商品销售数量 | **不含赠品与退货**（= 湖数量 − `present_num` − `return_num`） |
| `sale_money` | 商品销售金额 | 对应「已销售」部分 |
| `item_price` | **商品销售均价** | **= `sale_money / sale_num`**（官方背书 §2.4 的 `price × sale_num = sale_money`，例：店 250 `55.5107 × 13.98 = 776.04` ✓） |
| `present_num` | **商品赠送数量** | 赠品拆分真身；湖侧无法复现（§3.3） |
| `return_num` / `return_money` | 商品退货数量 / 金额 | 与订单级 `order_transaction_type` 非 SALE 的行**逐分吻合**（§3.2） |
| `discount_money` | 商品折扣金额 | ⚠️ **文档措辞与实际值不符**，见 §7.2 |
| `order_detail_share_discount` | **订单明细分摊金额** | 官方确认语义；与我方补采后自算值 1120/1120 逐分相等（§4） |

### 7.2 ⚠️ `discount_money` 语义与文档不符，勿当「折扣差额」用

官方写「商品折扣金额」，但实测值**经常大于 `sale_money`**：

- 店 164 `312016359`：`discount_money = 1202.90`，而 `sale_money = 577.76`；
- 店 255 赠品行：`discount = 122.11 = std_price 59.8 × amount 2.042`（= **标准价金额**），而 `money = 61.05`；
- 但店 19 `1133`：`std=5.0 price=5.0 amount=7.0` → `std_amount = 35.0 = money`，而 `disc = 0.0`。

⇒ **该列既非「折扣差额」也非稳定地等于「标准价金额」**，只在部分行成立。
**因此不要用它做任何排除/判别规则**（§2.6 已证伪基于该列的 `disc≥sale` 猜想）。
湖侧同一列（`order_detail_discount`）保持原样采集即可，但**口径解释需向乐檬确认**（已列清单 Q4）。

---

## 8. 复现方式（只读）

```sh
# 读取通路：openship MCP server exec → 数据面机容器（容器 env 里已有 ZOS_* / LEMENG_TOKEN）
# 证据脚本已落本 worktree：docs/recon-attribution-evidence/
python3 docs/recon-attribution-evidence/rpy.py docs/recon-attribution-evidence/s21_final.py   # 总归因
python3 docs/recon-attribution-evidence/rpy.py docs/recon-attribution-evidence/s22_livefields.py  # 网关字段实测
python3 docs/recon-attribution-evidence/rpy.py docs/recon-attribution-evidence/s24_retmark.py     # 退货标记验证
python3 docs/recon-attribution-evidence/rpy.py docs/recon-attribution-evidence/s26_sdcheck.py     # share_discount 验证
```

- `rb.py`：容器内 duckdb + S3 secret 回读（值由容器 env 展开，不进命令行/日志）
- `rpy.py`：容器内跑 python（网关调用）
- `oxec.py`：openship MCP server exec 薄封装（读本地 MCP 配置里的 token，不落明文）

**工具坑（本次踩到，供后来者）**：
1. `item_num` 两边类型不同（湖 VARCHAR / 平台 int）——**join 前必须统一为 str**，否则静默全落空（本次事故根因）。
2. duckdb CLI 输出首行是 `CREATE SECRET` 的 `Success/true` 噪声，解析要按表头行切片。
3. `post_system_servers_by_id_exec` 的 `timeoutMs` **上限 120000**，传 180000 会被 schema 拒（报错藏在 JSON 里，易误读为「命令无输出」）。
4. 平台 `discount_money` **不能当「折扣差额」理解**（官方文档写「商品折扣金额」，但实测常大于 `sale_money`）——
   详见 §7.2。基于该列的任何排除规则都是错的（§2.6 已证伪）。
5. `get_projects` / `get_projects_by_id_services` 的返回里，compose 层注入的 env 键**不在 env 表**里（与既有记忆一致）；
   判容器真实 env 要进容器 `printenv`，不要据表格推断。
6. 网关 `itemsales.find` 的**维度字段按 `summary_types` 条件返回**：只传 `["branch"]` 时 rows 里**没有** `item_num`
   （不是空值，是键不存在），据此判断「两边字段不一致」会误判。
