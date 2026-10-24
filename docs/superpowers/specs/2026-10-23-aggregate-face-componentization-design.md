# 聚合面组件化 Phase 3：编译期单一事实源（设计）

> **一句话**：让每个 measure（口径组件）只声明一次，由生成器编译成 fct 的度量列与下钻的表达式/行域——
> 聚合面与下钻面从同一份定义产出，`expression` 与 `detail.filter` 的重复实现退役。
>
> **性质**：架构级（语义声明面 + 物化生成链）。**状态**：设计稿，待评审后转实施计划。
> **前序**：Phase 1（`2026-10-21-bot-drillthrough-design.md`，已上线）；Phase 2（`2026-10-22-drillthrough-phase2-design.md`，已上线）。

---

## 0 结论与范围

| 项 | 决定 |
|---|---|
| 单一事实源的落点 | **measure 定义一处**；聚合面与下钻面都由它编译产出 |
| 是否查询期组合组件 | **否**——fct 保持物化缓存，查询期执行形态零变化 |
| 是否删掉 fct | **否**——fct 骨架（join / 去重 / 分母 / 分区）继续**手写**，只有**度量列区**改为生成物 |
| `expression` | 切换期保留为旧值；逐条切换后退役（P3.4） |
| 首批范围 | **retail_sale 一族 4 条指标**（`net_sales` / `order_line` / `sales` / `order_count`） |
| 可加性元数据 | 本批**声明 + 守恒校验**；不做贡献分解（那是下一批，见 §8） |
| 切换方式 | 影子对账 ≥N 天 → 逐条签核切换；**永不批量硬切** |

### 反转条件（出现则停，不硬做）

- 影子对账在任一店日出现 > 1 分差异且无法归因到精度 ⇒ 停止切换，先查口径；
- 生成后的 fct 度量列导致物化耗时上涨超过预算（§6.3）⇒ 退回手写列，只保留声明与校验；
- certified 指标的口径定义在组件化过程中需要**任何**语义变更 ⇒ 停下来单独裁决，不许「顺手改对」。

---

## 1 现状与问题

### 1.1 事实（2026-10-23 实测）

- 43 条 L1 指标：31 条只有 `expression`、2 条 `expression + compose + detail`、10 条为比率类（`ratio` 形态）。
- 仅有 **3 个 measure 组件**（`sale_amount@order` / `return_amount@line` / `line_amount@line`），只有 **2 条指标**有 `compose`。
- 43 条指标背后是 **14 个 fct 模型**；`expression` 全部指向 fct 列（如 `sum(fct_retail_sale.net_amount)`）。
- `fct_*.sql` 是**手写**的：join、去重、分母、分区都在里面；measure 的表达式是它的**下钻面复写**。

### 1.2 问题：同一口径两份实现

| 事故 | 形态 |
|---|---|
| #917 | 对账子管线手搓「净销售额」，与 dbt 构件悄悄漂移，两次静默事故 |
| Phase 2 实施 | 聚合面把 `state='FINISHED'` 内嵌进 `expression` 的 CASE，下钻面写在 `detail.filter`——两处**声明**漂移无机器守卫，靠 `sync-data-semantics.test.ts` 的真事实源用例钉死 |
| measure 组件 | `sale_amount@order` 在每一支里重复三遍 `state='FINISHED' and order_transaction_type='SALE_ORDER'` |

结论：**问题不是「组件不够多」，是「口径落点不唯一」**。组件化若只增加声明而不改变落点，只是把第三份抄本加进来。

---

## 2 设计总览

```
          ┌──────────────┐
          │  measures    │  一处定义：expr + domain + additivity + unit
          └──────┬───────┘
     ┌───────────┼─────────────┐
     ▼           ▼             ▼
 fct 度量列区   compose 表达式   detail.filter
 （生成物）    （既有字段）      （由 domain 派生）
     │
     ▼
  aggregate select_sql（sync 物化，不变）
```

三条不变量：

1. **运行时零变化**：`query_data` 仍读 fct 列；`query_detail` 仍跑同一形状的 SQL。变的只是这些 SQL/列**从哪来**。
2. **fct 骨架手写**：join / 去重 / 分母 / 分区 / 断言不进声明面（`docs/architecture.md` §4.1 B11 的边界不变）。
3. **切换以数值为准**：任一生成物上线前，必须与旧实现逐分对账通过。

---

## 3 声明模型

### 3.1 measure 形态（非破坏性扩展）

```yaml
measures:
  sale_amount@order:
    expr: >-
      case when sum(case when <赠品判别式> then 1 else 0 end) = 0 then 0
      else (sum(case when <赠品判别式> then 0 else sale_money end)
            + max(order_total_money)) / 2
           - sum(order_detail_share_discount)
      end
    domain: "state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'"
    additivity: additive
    unit: CNY
```

- **字符串形态在 P3.0 内一次性迁走**：`additivity` 必填（见下），字符串形态无法表达它 ⇒ P3.0 完成时门禁对字符串形态报红。存量只有 3 个组件，迁移成本可忽略；留一个「字符串 = 隐含 additive」的兼容口，等于把「不知道」默认为「可加」，正是本设计要消灭的失败形态。
- **`domain` 的语义**：引用 **`domains:` 里声明的具名行域**（不是自由 SQL），该 measure 的**基础行集**。`expr` 写在这个行集之上（不再重复域谓词）；编译时：
  - 聚合面：`base as (select … from <relation> where <该域的完整谓词>)`，度量列在 base 上聚合；
  - 下钻面：`detail.filter` = compose 所引用组件域的**最小上界（LUB）**（见 §3.1.1）。

### 3.1.1 具名行域与最小上界

同一条 compose 可能混合**不同行域**的组件（例：净销售额 = 销售侧 `FINISHED ∧ SALE_ORDER` − 退货侧
`FINISHED ∧ RETURN`）。下钻面要展示的是「构成这个指标的全部行」，即两者的**最小上界**——
用交集/「字符串相同」都算不出来，所以行域必须**声明成层次**：

```yaml
domains:
  finished:        "state = 'FINISHED'"
  sale_finished:   { extends: finished, filter: "order_transaction_type = 'SALE_ORDER'" }
  return_finished: { extends: finished, filter: "order_transaction_type like '%RETURN%'" }

measures:
  sale_amount@order:
    domain: sale_finished
    ...
```

- 完整谓词 = 沿 `extends` 链自根向下的 `filter` 逐层用 `and` 连接；
- `detail.filter` = 所引用组件域的 LUB（沿链上溯到最近公共祖先）；**无公共祖先 ⇒ 抛错**
  （fail-closed：不许悄悄放宽成 `true`）；
- 例：`sale_finished ⊔ return_finished = finished`，`where` 谓词逐字为 `state = 'FINISHED'`——
  与两条指标今日的 `detail.filter` 完全一致（逐字复现是本批的验收判据之一）。
- **`additivity` 必填**，**与指标级 `additivity` 同一词表**（避免第二套方言）：
  - `flow`：任意维度上卷 = 先分组求和再相加（金额类）；
  - `stock`：跨时间不可加、跨实体可加（库存快照类）；
  - `non_additive`：任何上卷都不成立（去重计数、比率）。
  **缺省值不存在**——漏写即门禁红（默认值会把「不知道」伪装成「可加」）。
- **`unit`**：人读与机器校验用（`CNY` / `count` / `ratio`）；比率类指标必须声明，防止「金额 + 笔数」被同轴展示。
- **`grain`**：该表达式**逐组求值的键**（`order` / `line`），两阶段编译的输入（§4.2）。

> **为什么必须两阶段（规划期发现，2026-10-23）**：`fct_retail_sale` 的算术是
> **逐单 `(ng+tot)/2 - sd`，再按门店日求和**；而下钻面的 measure 表达式是
> `(Σng + max(tot))/2 - Σsd`——两者**只在订单粒度上相等**，在门店日粒度上因舍入位置不同而可能差几分。
> 若把单个 measure 表达式直接当聚合式编译到门店日，就会**改变 certified 指标的数值**。
> 因此 measure 必须声明 `grain`，编译时先按该 grain 的键求值、再按指标 grain 聚合——
> 这正是把「除法在哪一层」从两份实现里收回到一处声明的唯一办法。

### 3.2 指标侧的变化

| 字段 | 切换前 | 切换后 |
|---|---|---|
| `expression` | fct 列的直接引用 | **退役**（P3.4）；切换期保留为对照值 |
| `compose` | 只用于下钻 | 保留；且必须能由 measure 集合复算 |
| `detail.filter` | 手写 | **删除**，编译期从 measure.domain 派生 |
| `detail.columns` | 手写 | 不变（条件列不是口径，是权限面） |

### 3.3 可加性与 grain 的关系

`@order` / `@line` 后缀描述「表达式的自然算术语义」，不是二次分组指令：

- `@order` measure 在订单级算术上成立（折半公式、`max(order_total_money)`）；
- 消费方**不得**在比 `@order` 更细的粒度上分组（否则每行各算一次）；
- 门禁校验：指标的 `grain` 与所用 measure 的粒度**不可更细**（现有 `dimensions` 闭集已覆盖下钻侧；聚合面在 P3.1 加入同一判据）。

---

## 4 编译路径

### 4.1 生成物与标记区

沿用 `scripts/gen-data-projection.mjs` 的既定范式（契约 → 列区生成物，手改会被 `--check` 红）：

- 每个 fct 模型在 SQL 中以**标记注释**划出「度量列区」：
  ```sql
  -- BEGIN GENERATED MEASURES (由 scripts/gen-fct-measures.mjs 生成，勿手改)
  ...
  -- END GENERATED MEASURES
  ```
- 新脚本 `scripts/gen-fct-measures.mjs`：输入 `dbt/semantics/l1_metrics.yml` 的 `measures`，输出各区段；
  `--check` 与 CI 门禁同源（生成物 == 已提交）。
- **非生成区**（FROM/JOIN/WHERE/分区/断言）原样保留，生成器只重写标记区内文本。

### 4.2 表达式编译规则

1. 以 `domain` 构造 `base` CTE（无 `domain` 时 `base` = 原行集）；
2. **两阶段**：先按 `grain` 的键分组求 `expr`（`<measure>__gen` CTE），再按指标 grain 聚合（`sum(...)`）——
   除法/减值发生在第一阶段，与 fct 现有形态逐字节同构；
3. **生成的 fct 度量列沿用现有列名**（如 `net_amount`）⇒ 指标 `expression`（`sum(fct_retail_sale.net_amount)`）在切换期**逐字不变**，这就是「运行时零变化」的落点；`expression` 的退役是 P3.4 的事，与本设计不耦合；
4. 下钻面：`drill expr = compose`（既有）；`detail.filter` **由 sync 从 measure.domain 派生后物化**（`data.metrics.drill_detail`），声明面删掉该键——派生规则与编译同源，避免第三份抄本。

> ⚠️ 编译**不做**语义改写：`compose` 的 `+ - ( )` 文法、measure 的表达式文本都是声明内容，
> 编译器只负责「放到哪一层、套什么 base」——口径解释权仍在声明里。

### 4.3 `--check` 与漂移

- `gen-fct-measures.mjs --check`：生成物与仓内文件逐字节一致，否则红；
- `sync-data-semantics --check`：库内 `data.metrics` 与声明一致（既有）；
- 两者合起来覆盖「声明 → 生成物 → 库」三跳（Phase 2 的「三跳同批改」教训固化为门禁）。

---

## 5 迁移路径（P3.0 → P3.4）

| 阶段 | 内容 | 退出判据 |
|---|---|---|
| **P3.0** | 声明模型扩展（对象形态 / domain / additivity / unit）+ 门禁改造（字符串形态报红、`additivity` 缺失报红）+ 生成器骨架 + **影子对账框架** | 存量 3 个组件迁成对象形态；生成器对空集幂等；门禁全绿；**运行时零变化** |
| **P3.1** | retail_sale 一族双跑：`fct_retail_sale` 的度量列新旧两路并行 | 连续 ≥N 天、全账套×全店日逐分一致（≤ 1 分）；差异全部有归因 |
| **P3.2** | 切 `fct_retail_sale` 度量列到生成物；删 `net_sales` / `order_line` 的 `detail.filter` 与重复谓词 | 切换后首日物化 PASS；聚合==下钻上卷守恒校验通过；certified 签核记录在案 |
| **P3.3** | 4 族影子迁移（branch_expense / client_expense / transfer_line_quality / retail_quantity），一波影子、分批签核；其余 8 族例外登记见 §8（2026-10-24 勘察缩幅，issue #1031） | 4 族影子对账全绿；experimental ~7 天先切、certified ~14 天签核切换 |
| **P3.4** | **measure-backed 指标**的 `expression` 退役；defer/exclude 族（§8）的 `expression` 即口径正典单点，**保留** | 可退役指标全切 + 一个观察窗无回归 |

> **P3.2 实施记录（2026-10-23/24，issue #1020）**：只切列、不改口径——`fct_retail_sale` 输出仍是同样 8 列
> （`system_book, org, bizday, branch_num, sale_amount, return_amount, net_amount, order_count`），
> `sale_amount` / `return_amount` 改取生成区 rollup、`net_amount` 由两者相减，指标 `expression` 逐字未动。
> 切换依据 = **P3.0 真机影子对账**（框架见 issue #1012 / PR #1018 → `4c0cf89a`）：2026-10-09..10-22 共 **14 天 / 3087 个店日**，
> `sale_amount` / `return_amount` / `net_amount` 三列与旧列 **diffs=0 / nulls=0**（该数字出自 P3.0 上线会话的真机复核，
> **仓内未落盘**；PR #1018 正文只记了框架与判据）。
>
> **合并后真机验收（2026-10-24 已通过）**：计划 PR #1023 → `7969154e`、实现 PR #1026 → `8810e2ef`（v0.191.0），
> main CI 两轮 CLEAN（#1026 轮 deploy 因连合互斥挂一次，rerun 后绿）。数据面链：SYNC_OK 225/225（钉 `8810e2ef`）→
> 词表 job **未变 43 / 回读 43** → materialize **PASS=312**（= 316 − 影子对账 1 − `__gen` not_null 3）`MATERIALIZE_OK` →
> 山海实例 `dep_3l9MpY-ppaYpp3W5` ready（v109，3/3 服务）。**零差异裁决**：切换前后同窗指纹
> `n=3087, md5=ceb30fc583806787015e9e06b58653d0` **逐字节一致**（后续物化重建两轮后终验仍一致）；
> 表恰 8 列、`__gen` 全退（information_schema 实测）。其间一次 materialize 失败系**采集窗口并发写湖**
> （`recon_gift_hit` / `assert_vw_retail_order_line_matches_stg` / `audit_lemeng__retail__net_quantity` 三审计瞬时红；
> 切换前 10-23 09:27 已有同签名失败先例，重跑即绿）——与本切换无关。
> **性能观察（§6.3，未裁决）**：切换后干净单跑 165s（attempt-1 单轮全绿），切换前跨窗干净样本 97–151s
> （中位 ~110s；02:27 UTC 槽位排班不存在，无严格同窗基线）——同槽位对照留待切换后排班运行
> （11:27/13:27/15:27 UTC vs 前日同槽 115/120/117s）复核；持续超预算才触发反转条件第二条。

**首批只做 retail_sale 一族**，其余按需推进——第一段目标是「证明脚手架」，不是「改造全仓」。

> **P3.3 勘察定案（2026-10-24，issue #1031）**：15 个 fct 全列逐一勘察 + 43 条指标 expression
> 提取（结论：候选指标全部是 `sum(fct_x.col)` 直引，无第二份口径实现）后，范围从「其余 13 族」
> 缩到 **4 族 9 条指标**；6 族 defer（双源 join / 组合长表 / streak / 跨期窗——measure 的单
> relation 假设与两阶段编译装不下）、2 族 exclude（纯透传，0 聚合，无口径可组件化）。
> P3.4 的「expression 全量退役」前提随之修正（见上表行）。逐族结构性理由登记在 §8。

---

## 6 守卫与验收

### 6.1 语义 diff 门禁

- measure 变更 ⇒ 自动列出受影响指标与受影响面（fct 列 / compose / filter）；
- `tier: certified` 的指标口径受影响时，PR 必须带**签核节**（谁、依据、期望数值变化）；
- 无签核 ⇒ 门禁红（`tier` 第一次从「标记」变成「约束」）。

### 6.2 守恒校验（本批新增）

1. **聚合 == 下钻上卷**（双向）：对有下钻的指标，`query_data` 的逐店日值 == `query_detail` 按同维度上卷的值（1 分容差）；现有 `assert_drill_*` 是反向（下钻 == 聚合），二者合起来才闭合。
2. **加总守恒**：`additive` measure 的指标，明细逐行求和 == 聚合值；`non_additive` measure 在跨粒度相加时门禁/测试**必须红**。
3. **零值语义**：空分组（某店日全为作废行）在下钻面是 0 行、聚合面是零值组——这是**已裁定**的差异，校验要显式排除，不许当成 bug 修（Phase 2 §8 已记录）。

### 6.3 性能预算

- 物化耗时与扫描字节：切换前后同窗口对比，deviation ≤ 10%；
- 查询延迟 p95 不得劣化（运行时零变化 ⇒ 理论上不变，但生成列可能改变执行计划，要实测）；
- 超预算 ⇒ 走「反转条件」第二条。

---

## 7 风险与回滚

| 风险 | 缓解 |
|---|---|
| certified 数值漂移 | 影子对账逐分 + 签核 + 逐条切换 |
| fct 手写骨架被生成器误伤 | 标记区外**零改动**（`--check` 逐字节比对） |
| 声明面扩张成「小 SQL 方言」 | domain 只允许**布尔谓词**且不含子查询/分号；additivity 是枚举，不是表达式 |
| 迁移半途而废（两条路径长期并存） | P3.4 设退役期限；每个 fct 族切换后立刻删旧列 |

**回滚**：

- 单条指标：revert 该条声明 + 生成物 ⇒ 重跑 sync/materialize；
- 单族：revert 标记区 + 恢复手写列（生成器产物在 git 里可逐字节回退）；
- **无 DDL、无数据迁移**（fct 表结构不变，列名不变）。

---

## 8 非目标与后续

- **不做查询期组件组合**（§0）；
- **不做贡献分解 / 比率重算的分析面**（本批只铺元数据；另立 spec）；
- **不做自由 SQL / 自定义度量**（约束 12 不变）；
- 比率类指标（`ratio` 形态的 10 条）暂不纳入组件化，等口径模型统一后再议；
- `detail.columns`（条件列）与掩码语义不动，归 #995；
- **fct 族例外登记（P3.3 勘察，2026-10-24，issue #1031）**——结构性理由，不是优先级排序：
  - **defer（6 族，编译器能力外）**：`fct_request_fulfillment`（双源 left join + 派生列）、
    `fct_contribution` / `fct_client_contribution` / `fct_hq_outbound`（组合长表：多湖表
    union/join + 域选择性冲减 + 快照去重）、`fct_branch_day_activity`（streak 连续无销售）、
    `fct_retail_comparable_growth`（跨期窗 cur/pri 对比）——measure 的单 relation 假设与
    两阶段编译装不下这些结构；其 `expression`（`sum(fct_x.col)`）就是口径正典单点；
  - **exclude（2 族，结构性透传）**：`fct_purchase`、`fct_inventory_snapshot`——0 聚合直落，
    聚合面无口径可拆，无可组件化对象；
  - **重开条件**：编译器支持多 relation / 窗口形态的 measure 声明，且有真实消费需求时再议；
    不为「架构完整性」而迁。

---

## 9 已裁决（2026-10-23）

1. **影子对账窗口**：默认 **7 天**；`tier: certified` 的指标取 **14 天**（覆盖跨周与封版重写周期）。
2. **`additivity` 不允许 `unknown`**：三值（flow / stock / non_additive）必填，漏写/写 `unknown` 均门禁红——不给「不知道」留挡箭牌。
3. **certified 口径变更的签核载体**：**PR 正文固定节**（Who / Why / 期望数值变化 / 对账窗口）＋ 由 release 流程汇总进发版说明；不单独建 `docs/metric-changelog/`（避免第二份台账）。
