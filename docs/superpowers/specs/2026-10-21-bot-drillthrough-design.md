# bot 问数：度量组件 + 维度集合 + 明细下钻（设计）

> **一句话**：把「口径」从**每条指标一份聚合表达式**，改成**每个域一份可加度量组件**；聚合与下钻变成同一机制的两种维度子集——下钻读直读湖的视图，聚合 Phase 1 仍读 marts。
>
> **性质**：架构级（语义层声明面 + 查询面）。**状态**：设计稿，实施前需评审。

---

## 0 结论与范围

| 项 | 决定 |
|---|---|
| 口径的组织方式 | **域级度量组件**（只声明一次）+ 指标**组合**组件 |
| 下钻 | 同一组件集，**换维度子集** + 换关系（视图） |
| 明细新鲜度 | **直读湖**（5 分钟 tick），不读物化表 |
| Phase 1 聚合面 | **不动**（仍读 `fct_*`）；Phase 2 才切到组件 |
| 逐指标 `contribution`（旧提案） | **否决**——那是把口径复制 N 次（#831 的放大版） |

### 反转条件（出现则重新评审，不是「继续硬做」）

| 若发生 | 应对 | 是否重做方案 |
|---|---|---|
| 视图中重查询 OOM | `detail.relation` 换成物化明细表 | **否**（换一个配置值） |
| 某指标组件对不上账 | 该指标标「不可下钻」 | **否**（局部） |
| 全史上卷（1.9s）不够快 | Phase 1 本就不动聚合面 | **否** |
| 组件覆盖度不足 | 已量化 93%，3 条例外已点名 | **否** |

---

## 1 问题（全部带实证）

### 1.1 口径与明细结构性不相通

| | 值（2026-10-20，两账套） |
|---|---:|
| `net_sales`（口径聚合） | 434,857.09 |
| 明细表 `sum(sale_money)` | 456,308.01 |

差 4.7% **不是 bug**：口径在 `fct_retail_sale.sql` 里是**订单级算术**（赠品排除 → `(非赠品额+订单总额)/2 − 分摊折扣`），明细表没有这套逻辑，也没有以「可在明细上求值」的形式存在。⇒ **「这个数由哪些行构成」答不出来。**

### 1.2 聚合与明细的时钟不同

marts 每 2h 全量重建；湖 5 分钟 tick。⇒ 下钻可能比聚合新，逐行相加与聚合值不等。

### 1.3 粒度在声明时钉死

`groupBy = grain.join(', ')` 固化。调用方不能加维度、不能排序取 top-N。

### 1.4 bot 没有可组合的查询面

`query_data(metricId, args)` 是单入口。实测一轮「10-20 有多少行」：模型 0 次 `list_metrics`，凭记忆选了 `outbound:line_count`（返回 null）与 `net_sales`，最终把**门店行 219** 当成行数（真实订单行 15,222）。

---

## 2 设计

### 2.1 总体架构

```
湖（parquet, 5min tick）
 ├─[dbt staging 表] → fct_* 表 ── 聚合读面（Phase 1 不动）
 └─[dbt view vw_*]── 直读湖 ── 明细读面（本 spec 新增）
                        │
   l1_metrics.yml ──sync──> data.metrics
      ├ measures: {组件名 → 行级表达式}       ← 域级，只声明一次
      └ dimensions: [...]                      ← 可分组维度集合
                        │
   query_data(metricId, args)          → 聚合（Phase 1 读 marts）
   query_detail(metricId, args, …)     → 下钻（读 vw_*，同一组件集）
```

### 2.2 视图层（`dbt/models/**/views/vw_*`）

- `materialized='view'`，**直读湖**，**逐列显式 cast**（不 cast ⇒ 消费层见 `USER-DEFINED`）
- 列清单**由契约生成器产出**（`contracts/*.json` 是唯一事实源），**禁止手写第三份**
- FROM 段带**封版断言**（防混代 glob）
- ⚠️ **schema 落点：沿用主体列（单 schema + `org` 列），否决 `2026-09-26` spec §3.6 的 `tenant_<org>`**——线上仓库无租户 schema，且该 spec 自述「per-tenant schema 至今未在真机行使过」

### 2.3 声明面

```yaml
measures:                        # 域级：一个组件只定义一次
  sale_amount@order: >-
    (sum(case when <赠品判别式> then 0 else sale_money end) / 2 + max(order_total_money) / 2
     - sum(order_detail_share_discount))
  return_amount@line: >-
    sum(case when <退货赠品判别式> then 0 else sale_money + order_detail_share_discount end)
```

> **`<赠品判别式>` 必须逐字照抄 `dbt/models/lemeng/marts/fct_retail_sale.sql` 里的那一句**（销售侧与退货侧是**两个不同的**判别式：退货侧取绝对值形态）——**禁止另写一份**。组件与 mart 是同口径的两种粒度，不是两套实现；E2 的零偏差就是这条的证据。

- name: 'lemeng:retail:net_sales'
  expression: 'sum(fct_retail_sale.net_amount)'      # Phase 1 聚合面（不动）
  compose: 'sale_amount@order - return_amount@line'  # 下钻/未来聚合面
  dimensions: [system_book, bizday, branch_num, order_no, item_num]
  detail:
    relation: 'vw_lemeng_retail_order_line'
    filter: "state = 'FINISHED' and order_transaction_type = 'SALE_ORDER'"
    columns:                                          # 显式声明，不是「视图有啥给啥」
      - { col: order_no }
      - { col: item_num }
      - { col: order_detail_std_price, granted_by: data:cost }
      - { col: order_detail_price,     granted_by: data:cost }
```

**字段语义**

| 字段 | 约束 |
|---|---|
| `measures.*` | 行级可求值的聚合表达式；`sum(组件)` 必须与对应 mart 列逐分一致 |
| `compose` | 组件组合；结果是该指标在**原子粒度**的值 |
| `dimensions` | 可分组列的**闭集**；下钻 = 选到最细子集 |
| `detail.relation` | 必须是 PG 可见关系（view 或表） |
| `detail.columns[].granted_by` | 复用现有 `MaskSpec.grantedBy` 语义 |

### 2.3.1 ⚠️ 声明面是**闭集**——加字段必须先改门禁

`scripts/check-data-models.mjs` 的 `METRIC_KEYS` 是**闭集**（未知键直接拒），现行成员：
`name / label / definition / expression / ratio / grain / source / sources / freshness_sla_days / owner / tier / reads / required_scope / mask / additivity / scope_note`。

⇒ 本 spec 新增的 **`compose` / `dimensions` / `detail`** 必须先加进该常量；顶层 **`measures:`** 是**新的顶层段**（现行 YAML 只有 `metrics:`），要给 `check-data-models` 与 `sync-data-semantics` **各加一份 schema**。该文件头注明确要求：**加字段 = 改常量 + 改 README + 走 PR**。

另：`mask` 键**在词表里存在但至今没有任何指标使用**（grep 实测 0 处）——本 spec 的列级掩码会是它**第一次被真正用上**，落库形状须先与 `MaskSpec`（`{column, kind, grantedBy, step?}`）对齐，别按想象的字段名写。


### 2.4 查询面

新增工具 `query_detail`（**不做** `query_data` 的 flag：回包形状与参数都不同，且更难被模型发现）。

```ts
query_detail({
  metricId, args,                      // args 与 query_data 同形
  dimensions?: string[],               // 缺省 = 最细（原子粒度）
  orderBy?: 'value' | '<dim>', desc?: boolean,
  limit?: number,                      // 默认 50，上限 500，超出静默夹紧
  offset?: number
})
```

回包**必带 `rowCountTotal`**（同一 `where` 的 `count(*)`，不受 limit 影响）—— 根治「把样本当全量」。

**术语钉死**：
- **原子粒度** = 该指标 `detail` 声明里**最细的可行维度子集**（对 `net_sales` 是「账套 × 业务日 × 门店 × 订单」）。它是**口径可精确分解的最粗粒度**，不是明细表的行粒度——折半与折扣分摊是**订单级各做一次**，摊到行属设计选择，不由本 spec 决定。
- `dimensions` 缺省值 = 原子粒度；显式传入时必须是**已声明集合的子集**，超出即 `BAD_PARAM`（不允许调用方凭空加列，否则又是注入面）。

**`bizday` 必传**：直读湖全史已实测 11.14s，随天数线性涨。缺范围回 `400 BAD_PARAM`。

### 2.5 权限（核心，已实测）

| 机制 | 复用方式 |
|---|---|
| 词表裁剪 | `visibleMetrics()`（`requiredScope` + `sourceSystem`），**纳入 `catalog-consumers.test.ts` 守卫** |
| 主体谓词 | `WHERE <subjectColumn> = '<requester.orgId>'`，不另写 |
| 值级掩码 | `maskedSelectSql()` 作用在 **drill SQL** 上（**不是**聚合的 `selectSql`） |
| 审计 | 每次下钻写一条（含 `drillGrain` / `filters` / `returned` / `rowCountTotal`） |
| 路由门 | 新增 `/detail` **必须同提交改 manifest `api.internal`**（装载期双向核对） |

**实测（2026-10-21）**：无 `data:cost` 时两列被替换为 `cast(null as numeric)`；有该码时 SQL 逐字节不变。

⚠️ **两处实现细节**（不写会在实现时翻车）：
1. `effectiveMasks(catalog, metric)` 的在场判定是 `sqlMentionsColumn(metric.selectSql, …)` ⇒ 下钻必须拿 **drill SQL** 算掩码集
2. `masksOf` 的 presence 校验对着 `selectSql` ⇒ 只出现在 drill SQL 的列（价格列）**校验要扩到 drill SQL**，否则声明被拒

**语义不对称（显式记录）**：聚合路径的 `data:cost` 是**指标级**（指标不出现）；下钻是**列级**（列在、值为 NULL）。两者都拿不到值。

### 2.6 错误与新鲜度

| 情形 | 回包 |
|---|---|
| 指标无 `detail` 声明 | `NO_DETAIL_BINDING`（**能力陈述**，不是权限拒绝） |
| 缺 `bizday` | `BAD_PARAM` |
| 读湖撞 tick 重写 | `warehouse_transient` + **自动重试恰一次**（复用 #452/#464） |
| 空结果 | `ok` + `rowCountTotal: 0` |
| L2 派生指标下钻 | `NO_DETAIL_BINDING`（**Phase 1 不支持**：加法组合后口径无法唯一分解） |

**两读面时钟不同**：回包同时给 `data_as_of`（聚合面）与 `drill_as_of`（明细面）；不一致时**由平台**附一句声明（不靠模型自觉）。对账不变量**只在闭窗营业日**校验。

### 2.7 前置阻塞项

`duckdb.memory_limit = 4GB` 而容器 cgroup = **2048MB**（实测）⇒ 重查询会被 OOM kill。视图面会显著增加大查询。**实施前必须对齐到约 1536MB。**

---

## 3 验证结果（全部真机，2026-10-21）

| # | 验证 | 结果 |
|---|---|---|
| E1 | 组件覆盖度（43 条静态分类） | **40/43（93%）可分解**；例外：2×`count(distinct)`、1×`max(...)`（`consecutive_no_sales_days`） |
| E2 | 组件 vs 认证 marts（6,122 个店日，闭窗） | **mismatched = 0**（`sale_amount` / `return_amount` / `order_count` 逐分） |
| E3 | 视图性能（已有实测） | 单日 0.53s；全史 11.14s（`2026-10-20-lake-format-decision.md` §8） |
| E3' | 下钻形状 | 订单粒度 × 单日 × top50 = **110 ms**；`count(*)` = 62 ms |
| E3'' | 组件上卷（全史） | **1.9 s** —— 若将来聚合面改读组件，成本可接受 |
| E4 | 不变量**可测性**（变异） | 控制组 mismatched **0**；变异组（`/2`→`/4`）**6,122** ⇒ **真能变红** |
| E5 | 掩码作用于非聚合列 | 无码 ⇒ 两列变 NULL；有码 ⇒ SQL 不变 |
| E6 | OOM 风险 | **确认存在**：cgroup 2048MB vs 设置 4GB |

---

## 4 验收判据

### Phase 0（前置，不过不进 Phase 1）

| 判据 | 红的样子 |
|---|---|
| 视图建成且**无 `USER-DEFINED`** | 日期/金额列类型丢失 |
| 列清单来自生成器（`gen-data-projection --check`） | 三处手写列清单漂移 |
| 封版断言在位 | 混代 glob 整挂 |
| **gate 1 新鲜度**：tick 时段内等下一班落湖，随后查询必见新数据，记录延迟量级 | 看见旧数据 |
| **gate 3 读今天的竞态**：撞竞态必须 `warehouse_transient` + 重试恰一次 | 静默错数 / 裸 DuckDB ERROR |
| 内存对齐：`duckdb.memory_limit` ≤ cgroup（建议 1536MB） | 重查询 OOM kill |

### Phase 1（核心不变量，跑不过不许发）

| 不变量 | 判据 |
|---|---|
| **口径同源** | 逐维度值：`sum(compose)` == 聚合面值，`numeric(20,2)` 1 分容差，**仅闭窗日** |
| **掩码同源** | `sum(掩码后 compose)` == 掩码后聚合值 |
| **总数不骗人** | `rowCountTotal` == 直接 `count(*)` 套同一 `where` |
| **聚合面零变化** | 现有 43 条指标 + 46 条 audit 全绿 |
| **权限面不扩张** | 无 `data:cost` 者下钻回包里两列恒 NULL；有码者 SQL 不变 |

### 真机（渠道轮）

1. 「10-20 有多少行」→ 必须答 **15,222**（不是 219），且明说口径
2. 「哪几行贡献最大」→ 按 value 降序 + 可翻页
3. 聚合与明细都带时间戳，不一致时有平台声明
4. 审计表有记录

### 回滚

明细面**独立可关**：停用 `query_detail` + 不挂 `detail` 声明。聚合通路一字不动。

---

## 5 已知边界 / 非目标

- **不做租户内行级分权**（店长只看自己店）——整套体系本就没有，下钻不改变
- **`org` 是部署期常量**（`subject_org()` 注入）：单租户实例正确；**多租户共库需另议**（staging 既有性质，下钻继承）
- **L2 派生指标不支持下钻**（Phase 1）
- **不引入自由 SQL**（全局约束 12 不变）
- **不改 marts、不改物化节奏、不改 L2 声明面**

---

## 6 与既有文档的关系

- **修订** `2026-09-26-detail-read-view-design.md` §3.6：`tenant_<org>` 每租户 schema **作废**，改主体列
- **沿用** 该 spec 的 §3.2（契约生成器）与 §3.3（逐列 cast + 封版断言）
- **销账** 其 gate 2（分区裁剪）——已定论，见 `2026-10-20-lake-format-decision.md` §8.2
- **Phase 2（另立项）**：聚合面改读组件、`fct_*` 降为缓存、删除 `expression`。需重跑 `net_sales` 的逐分验证（`tier: certified`）
