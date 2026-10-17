# 零售净销售额改为「冲退货」：构件拆三列 + 对账锚切换 + 缺口治本

> 2026-10-17 ｜ 触发：业务同事两次报「平台数 ≠ 我们直接查的数」（3120 与 64188，间隔两天）
> ｜ 决策人：用户（2026-10-17 会话内三次裁决，见 §3）
> ｜ 上位口径：issue #430（换货折半）+ 客户裁1 回签（2026-10-13）
> ｜ 追踪：**#813**（本 spec 的口径 fix）／**#814**（§8 退货侧缺口治本）

## 0. 一句话

平台 certified 指标 `lemeng:retail:net_sales` 的**名字**叫「净销售额」，但**口径**是不冲退货
（会计上那叫 gross sales）。业务「直接查」的是冲退货的数，于是对不上。本次把口径改成
**销售侧 − 退货侧**，并把构件拆成 `sale_amount` / `return_amount` / `net_amount` 三列，
从结构上消除「一个名字扛两个语义」这个根因。

## 1. 现场证据（2026-10-17 真机）

### 1.1 两个数各是什么

| 账套 / 日 | 平台 certified（旧） | 乐檬 `sale_money` | 乐檬 `return_money` | 乐檬 `sale−return` |
|---|---|---|---|---|
| 64188 / 10-16 | **222,021.00** | 222,021.00 | **1,803.50** | **220,217.50** ← 业务「直接查」 |
| 3120 / 10-16 | 322,944.00（含漏采店） | 325,769.70 | 2,339.60 | 323,430.10 |

问数 bot 答的 222,021 与平台 certified **逐分一致** —— bot 没答错，是**口径名不副实**。

### 1.2 退货侧口径（本次新验证）

候选式 `Σ(sale_money + order_detail_share_discount)` over
`order_transaction_type like '%RETURN%' AND state='FINISHED'`：

| 账套 / 日 | 湖侧复算 | 乐檬 `return_money` | 差 |
|---|---|---|---|
| 64188 / 10-13 | 2,189.20 | 2,189.20 | **0.00** |
| 64188 / 10-16 | 1,803.50 | 1,803.50 | **0.00** |
| 3120 / 10-15 | 939.10 | 939.10 | **0.00** |
| 3120 / 10-16 | 2,339.60 | 2,339.60 | **0.00** |
| 64188 / 10-12 | 1,081.70 | 1,086.70 | +5.00 |
| 64188 / 10-15 | 1,075.40 | 1,095.20 | +19.80 |
| 64188 / 10-14 | 1,254.60 | 1,377.66 | +123.06 |

四条要点（均为实测，不是推断）：

1. **退货项是全额冲减，不套折半**。整单退货的 `order_total_money = −Σsale_money`，
   套折半式恒得 0，与实测不符。
2. **`REPAID_RETURN` 不计** —— 它们 `state='REPAID'`。若计入，64188/10-16 会变成
   2,403.85 ≠ 1,803.50。这是乐檬报表的事实。
3. **按退货单自身 bizday 归属**，**不是**按原单销售日。与 2026-10-05 对
   `2026-09-30-recon-zeroing-self-attribution.md` 的订正一致（那版「退货按原单销售日冲减」
   已被判定为错）。
4. **缺口方向恒定**：乐檬 ≥ 我们（见 §6）。

### 1.3 缺口的形状（未定位根因）

- 方向**恒定**：乐檬多、我们少（总量也少，不是归店差异）
- **逐店偶发**：br31 两日复现（10-14 缺 49.00、10-15 缺 19.80）；br20 全周（10-13..10-17）
  **一条退货行都没有**，乐檬却报 10-14 有 48.19
- 已排除：NULL 丢行（退货行 sd/tot 零 NULL）、日期错位（10-13 T-4 逐分吻合，缺口**不随天数增长**）、
  归店差异（总量亦少）
- **销售侧同窗口全部逐分吻合**（10-12..10-16 恒 0.00）⇒ 不是普遍性漏采，退货侧独有

## 2. 行业标准对照（本次评价的尺子）

一手来源：Wikipedia《Sales (accounting)》（income statement 标准式）：

> **Net sales = Gross sales − (Customer discounts, returns, allowances)**
> "Gross sales are the sum of all sales during a time period. Net sales are gross sales minus
> sales returns, sales allowances, and sales discounts. The sales figures reported on an income
> statement are net sales."

三条惯例：

| 惯例 | 内容 | 我们的现状 |
|---|---|---|
| 净销售额定义 | 扣退货是标准；只扣折扣不扣退货的那个量在会计上叫 **gross sales** | 现行口径 = gross，**名字错** |
| 事实表形态 | 同时暴露 gross / returns / net 三个 measure | `fct_retail_quantity` 已是（sale/return/net）；**`fct_retail_sale` 是异类** |
| 退货归期 | 两派：运营派（退货发生日）／财务派（回归原销售期） | 跟随乐檬 = **退货发生日**，不动 |
| 迟到事实 | POS 退货晚到是常态，标准解法是**重述窗口**（每次重采尾窗 T-N..T-0） | 我们「当天采完即定稿 + 封版 T-3」⇒ **结构性漏晚到退货** |

**注意**：零售运营 BI 里确实存在「net sales = gross − 折扣，退货单列」的变体。所以当初的选择
不是荒谬的，**错的是标签**。本 spec 的修法据此定为「**拆构件 + 改锚**」，而不是「只改一个减号」。

## 3. 决策记录（用户裁决）

| # | 议题 | 裁决 |
|---|---|---|
| D1 | 改动性质 | **补缺陷**（裁1 原文的净额 L 本就写作 `Σsale−Σreturn`，实现只落了折半）⇒ 走 fix issue + PR，**不请客户重新回签** |
| D2 | 本次范围 | **先改口径**；退货侧缺口**另开 issue** 治本 |
| D3 | 行业标准评价 | 采纳：拆三列 + 断言订正 + 缺口按重述窗口治本（baseline 只做过渡且带到期） |

## 4. 口径定义（逐字）

粒度不变：**(system_book, bizday, branch_num)**。

```
sale_amount    = Σ_订单[ (Σ非赠品行额 + order_total_money) / 2 − Σ分摊折扣 ]
                   条件 state='FINISHED' AND order_transaction_type='SALE_ORDER'
                   （现行式，一字不动；= 乐檬 sale_money 的湖侧复现）

return_amount  = Σ_行[ sale_money + order_detail_share_discount ]      （存正数量级）
                   条件 order_transaction_type like '%RETURN%' AND state='FINISHED'

net_amount     = sale_amount − return_amount
```

- **赠品判别式**只作用于销售侧（现行式）。退货侧不设——退货行的赠品判别式等价于
  `sale_money ≈ 0`，贡献本就为 0，设不设同值。
- **逐行 vs 逐单**：退货侧无逐单项（无 `tot`、无 `/2`），逐行与逐单恒等，故按行写。
- **行集**：`sale_amount` 与 `return_amount` **FULL JOIN** —— 只有退货没有销售的店日会出现
  （net 为负），这是正确的；`order_count` 在该行为 0。
- **谓词风险（登记）**：`like '%RETURN%'` 沿用本族「外部枚举宁可自动纳入」的做法；但
  **区分「计/不计」的其实是 `state`**（FINISHED vs REPAID）。若某天出现 `state='FINISHED'`
  的 `REPAID_RETURN`，会被计入 ⇒ 靠对账抓（§7 退货侧判据）。

## 5. 改动清单

| 文件 | 改什么 |
|---|---|
| `dbt/models/common/marts/fct_retail_sale.sql` | 加退货 CTE；输出 `sale_amount` / `return_amount` / `net_amount` 三列（原 `net_amount` 改名 `sale_amount`）；`order_count` 不动；头注改口径说明 |
| `dbt/semantics/l1_metrics.yml` | `net_sales` definition 逐字改 + `tier` 订正；**新增 `lemeng:retail:sales`**；`order_count` 措辞订正 |
| `dbt/tests/audit_lemeng__retail__net_sales.sql` | 复算加退货项（`net`） |
| `dbt/tests/audit_lemeng__retail__sales.sql` | **新增**：现行 sale-only 复算（= 现 `audit_lemeng__retail__net_sales.sql` 内容） |
| `dbt/tests/assert_fct_retail_sale_net_amount_nonnegative.sql` | 断言对象改 `sale_amount`（`net_amount` 可负）；建议改名 `..._sale_amount_nonnegative.sql` |
| `dbt/tests/audit_lemeng__retail__recon_exchange_shape.sql` | 形状守卫扩到退货行（`sale_money` / `order_detail_share_discount` 非空），防 NULL 静默丢行 |
| `dbt/models/common/marts/schema.yml` | `fct_retail_sale` 描述 + 三列描述；`fct_retail_quantity` 那句「净额按裁1 不冲退货单」订正 |
| `contracts/common/lemeng.retail_order_line.json` | `order_transaction_type` 描述里「平台的 sale_money 不冲减退货单」订正（保留「不进 gross」的事实，补「net 另减 return_money」） |
| `scripts/lemeng/recon-preagg.sh` | 湖侧 SQL 加退货项；源侧改比 `sale_money − return_money`；头注口径块订正 |
| `deploy/duckle/console/pipelines/lemeng.recon.preagg.json` / `.item.json` | 同款锚切换 + `_note` 订正 |
| `deploy/duckle/console/pipelines/FLOW.lemeng.md` | `lagg` 行「不扣退货」订正 |
| `docs/data-platform-handbook.md` | §1.4 独立通道表、§2 台账行、§5 验收记录行 |
| `docs/lemeng-recon-questions.md` | 订正块补一句「net 口径另见 2026-10-17 spec」 |

**下游零改动**：`expression` 仍是 `sum(fct_retail_sale.net_amount)`；词表 / Metabase / 问数自动跟随。
**无需回填**：模型是每次 materialize 全量重建。

**动契约/管线 JSON 的连带门禁**（#683 教训：lock 连纯文档改动都计哈希）：
改了 `contracts/**` 的描述 ⇒ 必跑 `scripts/gen-data-projection.mjs --check`；
改了 `deploy/duckle/**` 或 `dbt/**` ⇒ 必跑 `scripts/lemeng/data-plane-lock.mjs`。两处都红过。

## 6. 连带决定

### 6.1 `order_count` 不动，只改措辞

基面仍是销售单（`FINISHED + SALE_ORDER` 的去重笔数）——退货单不是「订单」。definition 里
「与净销售额同基面」改成「与 `lemeng:retail:sales` 同基面」。`tier` 保持 `certified`（基面未变）。

### 6.2 新增 `lemeng:retail:sales`（旧数的诚实名字）

- `label`: 销售额（不冲退货）
- `expression`: `sum(fct_retail_sale.sale_amount)`
- `tier`: `certified`（沿用旧 `net_sales` 的 5 天 × 63 店逐分归零验证，公式未变）
- **理由**：① 旧数有消费方（Metabase 卡 / 问数历史），换名不换值可平滑迁移；
  ② 让「毛/净」在语义层同时可见，从根上防同类误会复发

### 6.3 `net_sales` 的 `tier` 降为 `experimental`

现 YAML 写 `tier: experimental`、definition 文本却写「✅ tier=certified」，本就自相矛盾。
口径既然改了，按本仓规矩「certified 前一律 experimental」：**明确标 experimental**，
退货侧缺口清零（§7 容差归零）后再转 certified。definition 文本同步改。

> 现状不一致是**本次顺手订正**，不是新决定——两处对不上时以「新口径未经复验」为准。

## 7. 对账锚与过渡判据

对账锚从 `sale_money` 换成 **`sale_money − return_money`**，逐店。判据分两条：

| 判据 | 面 | 判红规则 | 状态 |
|---|---|---|---|
| 销售侧 | `sale_money` 逐店 | 现行（abs / pct 容差） | 不变，恒逐分 |
| **净额侧** | `sale_money − return_money` 逐店 | **过渡总量容差 `NET_ABS_TOL=200.00` 元/账套/日**（≈ 实测最大缺口 123.06 的 1.6 倍）＋逐店 diff 明细全量输出 | **新增** |

**为什么用总量容差而不是逐店容差**：缺口是**逐店偶发**的（§1.3），逐店容差设到能容纳 48.19
就必然放过同量级的真实回归。总量容差把「已知缺口」框成一个额度，**逐店明细全量输出**则保证
额度内的恶化可见（不靠总量掩盖）。

**过渡容差必须带到期条件**：退货侧缺口 issue（§8）修完 ⇒ `NET_ABS_TOL` 归 0，与销售侧同款逐分。
容差是**已知缺陷的显式记账**，不是「允许漂移」——所以：① 值在脚本头注里写明来路与到期条件；
② 超容差即判红（不是静默）；③ 逐店明细全量输出（避免总量容差掩盖逐店恶化）。

## 8. 缺口治本（另开 issue）

**方向**：重述窗口（restatement window）——每次重采一个尾窗（如 T-3..T-0），或封版前再扫一遍，
而不是「当天采完即定稿」。

**issue 必须包含**：§1.3 的缺口证据（三个 book-day 的逐店 diff、br31 两日复现、br20 全周无行）；
根因定位（先证伪/证实「晚到退货落在采完之后的窗口」）；采集链路改动范围；回填需求；
以及**本 spec §7 过渡容差的清零条件**。

## 9. 验收

1. 八条 `check-*` + 纪律脚本 + CI 全绿
2. materialize 后三条 audit 绿（`net_sales` / `sales` / `order_count`）
3. `recon-preagg.sh` 跑 10-12..10-16：**销售侧恒 0.00**；净额侧在登记过渡容差内
4. **业务验收（本次的目的）**：问数 bot 问 64188/10-16 → 回 **220,217.50**
5. Metabase 抽查：净销售额卡片出数 = 220,217.50；销售额（不冲退货）卡片出数 = 222,021.00
6. 缺口 issue 已建并挂上 §7 容差的到期条件

## 10. 已知边界与风险

| 风险 | 说明 |
|---|---|
| 缺口期净额不逐分 | §1.3；过渡容差记账，缺口 issue 治本 |
| `state='FINISHED'` 的 REPAID_RETURN | 谓词风险（§4）；靠净额侧对账抓 |
| 折半式是**反推**的 | 它复现乐檬 `sale_money`，语义不自洽（整单退货套折半恒 0）。本 spec **不往上叠新反推公式**——退货侧用直读式（`sale_money + sd`），不套折半 |
| 口径真值归属 | 本族口径实为「**乐檬报表复现口径**」，非会计口径。definition 已写明，避免「净销售额」被当会计净收入用 |
| 破坏性变更 | `net_sales` 数值会变（64188/10-16：222,021 → 220,217.50）。旧值以 `lemeng:retail:sales` 保留 |

## 11. 不做的事（YAGNI）

- 不声明 `return_amount` 指标（列在表里够用，等有消费方再声明）
- 不改退货归期（跟随乐檬 = 退货发生日，已验）
- 不动折半式（#430 + 裁1 回签）
- 不引入新机制（沿用现有 fct / audit / recon 三件套）
