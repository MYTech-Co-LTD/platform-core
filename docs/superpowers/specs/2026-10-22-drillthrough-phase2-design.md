# bot 问数下钻 Phase 2：明细读面并入 + 敏感列门（设计）

> **一句话**：把昨天那条透传 PoC `lemeng:retail:order_line` **并入下钻声明面**——行域收 `FINISHED`、
> grain 26→8、价格列改成 `data:cost` 门控的**条件列**（无码 ⇒ 列不在场）；聚合面与下钻面从此同一个域。
>
> **性质**：架构级（语义声明面 + 权限面）。**状态**：设计稿，评审后转实施计划。
> **前序**：`2026-10-21-bot-drillthrough-design.md`（Phase 1，已上线：平台 v469 / 数据面 v99→v101）。

---

## 0 结论与范围

| 项 | 决定 |
|---|---|
| 明细粒度问题 | 用**已在场**的 `lemeng:retail:order_line`（issue #965），**不新建指标** |
| 「折半公式摊到 item_num」 | **否决**——折半式是订单级算术，摊到行是设计选择且会与 fct 漂移。真实诉求是「看行」，行级明细 + `item_num` 进闭集已满足 |
| 行域 | `state = 'FINISHED'`（含退货行；REPAID / CANCELED 不在）——**两面同一域** |
| grain / 下钻闭集 | 26 列 → **8 列**（§2.2） |
| 价格列 | `order_detail_std_price` 作为**条件列**（`grantedBy: data:cost`）：无码 ⇒ **列不在场**（缺席，不是 NULL） |
| 掩码机制 | **不动** `mask.ts` / `mask_spec`——列门 ≠ 值级脱敏（§3.1） |
| 契约 `sensitivity` | **本批不标**（§3.2，与口头稿的偏差已写明理由） |
| 聚合面关系 | 保留读 `stg_lemeng_retail_order_line`（§3.3，与口头稿的偏差已写明理由） |
| 1000 行截断 | 聚合面保留（`MAX_QUERY_ROWS` 全局常量）；**行数权威改为下钻的 `rowCountTotal`** |

### 反转条件（出现则停，不硬做）

- 真机发现 `order_detail_num` 在单订单内不唯一（业务键 distinct ≠ 总行数）⇒ 行级近似不成立；
- 8 列闭集答不了「按商品看」且必须加列才能答 ⇒ 另起 spec，不在本批扩闭集；
- `data:cost` 在租户侧发不出去（Casdoor org 扇出问题）⇒ 退回「整指标 `required_scope`」重新评估。

---

## 1 现状与问题（全部带实证）

### 1.1 `order_line` 是 PoC 透传（限制逐条来自 YAML 原文）

`dbt/semantics/l1_metrics.yml:957-982`：

- **grain 放全 26 列** ⇒ 每个分组恒为一行（等价于明细透传）；
- **行数上限 1000**（`MAX_QUERY_ROWS`，`modules/data/domain/authz.ts:149`），按 `bizday` 降序截断；
- ⚠️ YAML 原文：「本轮**不挂**列级/值级权限（PoC，用户 2026-10-21 确认）——**已知的临时敞口，不是终态**」。
  26 列 grain ⇒ `order_detail_std_price` 对任何持 `data:query` 的人可见。

### 1.2 同一个源，两个域

- 该指标走 `stg` 全量（含 CANCELED / REPAID）；
- Phase 1 下钻的行域是 `state = 'FINISHED'`（`net_sales.detail.filter`）。
- ⇒ 「聚合合计」与「下钻行数」覆盖的行集不同，不可互证。用户裁决（Q3）是把行域收到
  FINISHED 的**全部行（含退货）**。

### 1.3 bot 找不到明细（2026-10-22 02:54 渠道轮实证）

问「10-20 的明细 / 多少行」，bot 答「当前指标库没有这个粒度」。`list_metrics` 里 `order_line`
**在场**——缺的是**路由路标**：它的 label/definition 讲的是「透传」，没讲「行数类问题用它」。
Phase 1 的 `query_detail` 工具层面已通，问题在**发现**不在**能力**。

### 1.4 前置核实已就绪（2026-10-21 真机，YAML 头注）

业务键（账套 × 日 × 单号 × 行号）distinct = 总行数 ⇒ 无重复；加 `batch_id` 后仍无重复（85 个批次
不拆行）；`hour` 无空值。⇒ **把 grain 缩到 8 列不会合并出重复行**（`batch_id`/`hour` 可安全移出）。

---

## 2 设计

### 2.1 总原则：一面一域

同一指标的两个面（聚合 `query_data` / 下钻 `query_detail`）**行域相同、关系不同**
（`stg_` 物化 vs `vw_` 直读）。差异只体现在**时钟**（Phase 1 §2.6 的双钟声明），
不体现在**行集**。

### 2.2 声明面改造（`dbt/semantics/l1_metrics.yml`）

```yaml
measures:
  # 行级原始金额度量：不承载口径（判别式/赠品排除全在 fct 族）。
  # 行域由 detail.filter 钉，组件体不再重复写 state 谓词。
  line_amount@line: >-
    sum(sale_money)

metrics:
  - name: 'lemeng:retail:order_line'
    # 聚合面表达式：同一行域（FINISHED）内嵌进表达式——聚合面没有 detail.filter 可用
    expression: >-
      sum(case when stg_lemeng_retail_order_line.state = 'FINISHED'
               then stg_lemeng_retail_order_line.sale_money else 0 end)
    grain: [system_book, bizday, branch_num, order_no,
            order_detail_num, item_num, item_code, order_transaction_type]
    compose: 'line_amount@line'
    dimensions: [system_book, bizday, branch_num, order_no,
                 order_detail_num, item_num, item_code, order_transaction_type]
    detail:
      relation: vw_lemeng_retail_order_line
      filter: "state = 'FINISHED'"
      columns:
        - { col: order_detail_std_price, grantedBy: data:cost }
```

硬约束（每条都有机器依据）：

1. **`expression` 必须仍以 `sum(` 开头**——`deriveTotalable` 判可加（`sync-data-semantics.mjs`
   的 `/^\s*sum\s*\(/`）；`sum(case …)` 仍满足。
2. **`expression` 必须带至少一个「关系.列」引用**——`deriveRelation` 从它反推 FROM
   （`sum(case when stg_….state …)` 满足；**裸 `count(*)` 会响亮失败**）。
3. **`detail.relation` 必须是 `vw_*` 且文件存在**——`check-data-models.mjs` 的门（§2.5）。
4. **`grain` = `dimensions`**（同为原子行键闭集）；`dimensions` 是闭集，请求只能取其子集。
5. **闭集排除全部金额/数量列**：`sale_money` / `discount_money` / `payment_money` /
   `order_detail_price` / `order_detail_online_qty` / `order_total_money` / `quantity`。
6. `item_code` 契约明文**恒为空串**（上游订单 API 无此字段），保留在闭集只因它在契约列集里；
   **definition 必须注明**，别让 bot 把它当有效商品码。
7. `batch_id` / `hour` / `org` / 门店名 / 各种时间列移出闭集——业务键唯一性已实证（§1.4）。
8. **账本注释同批改**：段首那条「⚠️ 本轮**不挂**列级/值级权限（PoC）……已知的临时敞口」必须改写
   （敞口由条件列收口）；「明细直读视图落地后本指标可退役」改成「**透传形状**退役，
   指标本体留下作下钻绑定的载体」——注释与声明不一致 = 下一伙人照旧账读新代码。

### 2.3 条件列（权限面）

- **声明**：`detail.columns[].grantedBy`；方向与 `mask.grantedBy` 一致——**持有 ⇒ 看原值**。
- **无码**：该列**不出现在回包的 `columns` / `rows`**，也不能作为维度请求。
  **缺席，不是 NULL**——NULL 会被读成「这行没值」，缺席才是「你没被授权看这一列」。
- **有码**：作为**原子粒度的投影属性**出现。缺省请求（全 8 维 = 行级）时逐行 = 该行原值；
  粗粒度分组下取组内 `max()`（确定性值，但**不是聚合语义**，§5 已知边界）。
- **审计**：`data.query_audit.drill` 增 `grantedColumns: string[]`（空数组 = 未展示）。
  审计是「暴露面」的账：必须能回答**哪次查询把价格列给出去了**。
- 条件列**不是掩码**：不进 `mask_spec`、不过 `maskedSelectSql`（理由 §3.1）。

### 2.4 执行面（`modules/data/domain/drill.ts`）

- **门序**：dims 校验之后、orderBy 之前插入一步——
  `granted = (drill.columns ?? []).filter(c => requester.hasScope(c.grantedBy))`。
- **内层投影**（value-first 不变，mask 头替换的安全区）：
  ```
  select (<expr>) as value, <dims>[, max(<col>) as <col> …] from <relation>
  ```
- **外层上卷**（与 `buildDrillSql` 共用同一形状）：
  ```
  select <requested>, sum(value) as value[, max(<col>) as <col> …] from ( <inner> ) t
  group by <requested> order by <orderBy> <desc> limit <n> offset <m>
  ```
- `rollupOver` 增一个可选「附加投影」尾参，两个调用点同形——**外层形状仍只有一份**
  （Phase 1 终审 C1 的纪律：掩码只许改内层投影）。
- 回包 `columns` 自然含被授予的列（位于 `value` 之后；维度标签装饰照旧追加）。

### 2.5 门禁与 sync（声明面是闭集，**先改门禁**）

| 位置 | 改动 |
|---|---|
| `scripts/check-data-models.mjs` | `detail.columns` 形状：数组；每项 `{col, grantedBy}`；`col` 蛇形且**不重复**、**∉ `dimensions`**、**≠ `value`**；`grantedBy` 非空字符串 |
| `scripts/check-column-scope-monotonicity.mjs` | 新增规则 **⑤**：`detail.columns[].grantedBy` 必须 ∈ `modules/data/manifest.yaml` 的 `permissions[].code`（同 mask 规则 ①：码发不出去 ⇒ 该列对所有人**静默缺席**） |
| `scripts/sync-data-semantics.mjs` | 形状校验（同门禁同判据）＋ 物化进 `drill_detail` jsonb、`columns` 缺省不写键 |
| `modules/data/domain/authz.ts` | `DrillBinding` += `columns?: DrillColumn[]`（`DrillColumn = { col: string; grantedBy: string }`） |
| `modules/data/domain/metric-store.ts` | `drillBindingOf` 一并解析（全有或全无，与现有三键同纪律） |

**无需数据迁移**：`drill_detail` 是 jsonb，多一个键不改表。

### 2.6 对账（`dbt/tests/lemeng/`）

- **改** `audit_lemeng__retail__order_line.sql`：冷/热两腿与物化腿**都**加 `state = 'FINISHED'`
  （recheck 腿要把 `state` 取出来再滤），与指标同域。
- **增** `assert_drill_order_line_matches_metric.sql`：闭窗日上按**账套 × 业务日**（`(system_book, bizday)`）对两条路径——
  - 下钻路径：`vw_lemeng_retail_order_line where state='FINISHED'` 的 `sum(sale_money)` 与 `count(*)`；
  - 聚合路径：`stg_lemeng_retail_order_line` 上复算表达式里的 CASE，同样 `sum` 与 FINISHED 行数；
  - `full join` + `coalesce(…, 0)`（单侧局部丢分区不许失明）+ 金额 `0.01` 容差 +
    **空转绿守卫**（两侧皆空 ⇒ 报一行）。
  - 它守的是**数据面同量**：`vw_` 直读湖的 FINISHED 行 vs `stg_` 按 CASE 物化的 FINISHED 行，
    按 `(system_book, bizday)` 对齐——两跳之间丢行 / 丢分区 / cast 错会红。
  - ⚠️ 它**读不到 YAML 声明**（两侧谓词都是测试文件里硬编码的独立参考实现），因此
    **声明漂移不会让它红**。声明漂移由 `scripts/sync-data-semantics.test.ts` 的真事实源用例
    `★ 真事实源：order_line 的下钻绑定（8 列闭集 + 条件列）` 钉死：`detail.filter` 走 `toEqual`、
    `expression` 折进 `selectSql` 后用正则钉——**只改一处必红，两处一起改必须同 commit 更新该用例**。

### 2.7 机器人可发现性（零代码）

- `order_line.definition` 重写：**行数的唯一权威 = `query_detail` 的 `rowCountTotal`**；
  讲清 8 维闭集、行域 FINISHED（退货行在、作废/已退款不在）、价格列需授权；
  `item_code` 恒空；
- `net_sales.definition` 末尾加路标：「行数 / 明细构成类问题**不要**用本指标——
  用 `lemeng:retail:order_line` 走 `query_detail`」；
- `deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` 的「明细下钻」小节加一行
  `metricId=lemeng:retail:order_line` 的例子。

---

## 3 关键裁决（含证据）

### 3.1 为什么是「条件列」而不是「值级掩码」

1. mask 的载体是 `data.metrics.mask_spec` + `maskedSelectSql` 的**列引用定点替换**，且声明期要求
   `column` **逐字出现在 selectSql 里**（`masksOf`，`sync-data-semantics.mjs:384`）。下钻投影是
   **运行时**拼的，条件列根本不进那条声明链——用 mask 等于给「占位符进 selectSql」再开一条路
   （Phase 1 §5.3 已订正过）。
2. 语义不同：这里要的是「**不授权就不给这列**」，不是「给了但看不清」。
3. **值级掩码在本域结构性不安全**：`order_detail_std_price` 在 `sale_amount@order` 的赠品判别式
   内部；对它 nullify ⇒ 判别式 NULL ⇒ 赠品行走 else ⇒ 掩码后下钻 ≠ 聚合（Phase 1 §7 订正 2
   的算术，仍然成立）。条件列不碰表达式，天然免疫。

### 3.2 契约 `sensitivity` 本批不标（**与口头稿 §4 的偏差**）

口头稿写了「契约 sensitivity 标记」。落地前核了两条既有链路，结论是**不能标**：

- 标 `sensitivity: cost` 会同时激活：
  ① `check-column-scope-monotonicity` 要求所有 `reads` 含该列的指标声明 `required_scope`；
  ② `applyDefaultMaskTier`（`sync-data-semantics.mjs:1028`）对这类指标合成一条**整值 nullify**
     —— `value` 会被一起藏掉；
- 而本批要的是**列级门**，整值门会让 `sale_money` 对无 `data:precise` 者一起消失。
- 今天没有指标声明 `reads`，② 暂时空转；**一旦有人给 `order_line` 加 `reads` 就会凭空生效**
  ——这是静默风险，所以本批明确不标，并在 YAML 注释里写死这个交互。
- 缺口登记（不编标准）：契约层仍无「这一列敏感」的机器声明；本批不留假声明，归 #780 血缘门后续。

### 3.3 聚合面保留读 `stg_`（**与口头稿 §4 的偏差**）

口头稿写「expression 换 vw 前缀」。改为保留：

1. `stg_` 是物化表，聚合查询不碰 S3；`vw_` 每次现读 parquet（Phase 1 实测全史 11s 级，
   下钻面已强制 `bizday` 必传就是为这个）；
2. 现有 `audit_lemeng__retail__order_line` 比的正是 **stg ↔ 湖**；切到 vw 等于让聚合面离开对账覆盖；
3. 两面同源由「**vw 正文与 stg 逐字同源**」保证（#980 Task 2 的判据），不需要同一个关系名。

代价：两面**时钟不同**（物化钟 vs 读湖钟）——这本来就是 Phase 1 §2.6 的双钟设计，不是本批引入。

### 3.4 为什么行域收 FINISHED 而不是保留全量

- 下钻面已经钉 FINISHED（Phase 1 `net_sales.detail.filter`）；`order_line` 若两面不同域，
  同一个源会答出两个「行数」；
- REPAID / CANCELED 行对「哪几行造成的」没有解释力；真要查作废单，另起指标（非目标）。

---

## 4 验收判据

**真机**（山海数据面 + 平台；部署链 merge → sync → 数据面部署 → materialize）：

1. `query_detail(lemeng:retail:order_line, bizday=2026-10-20)` ⇒ `rowCountTotal = 14935`；
   `bizday=2026-10-21` ⇒ `14395`（Phase 1 已测锚值；**行域未变则必须逐字复现**）。
2. **无** `data:cost`：回包 `columns` 不含 `order_detail_std_price`；审计
   `drill.grantedColumns = []`。
3. **授予** `data:cost` 后同一查询：`columns` 含该列；抽查若干行 = 该行 `std_price`；
   审计 `grantedColumns = ["order_detail_std_price"]`。
4. 聚合面：`query_data(lemeng:retail:order_line, bizday=2026-10-20)` 的 value 与
   `select sum(sale_money) from vw_lemeng_retail_order_line where state='FINISHED' and bizday='2026-10-20'`
   **逐分一致**。
5. 门禁：`npm run gates` 绿（含新增门禁用例）、`dbt test` 绿（改域后的 audit + 新不变量）。
6. 渠道轮（企微，真机轮）：问「10-20 有多少行」⇒ 14935；问「按商品看明细」⇒ rows 含 `item_num`；
   无码者问「标准价是多少」⇒ 如实答「该列需授权」，**不是**「没有数据」。

**反向判据（必须能红，实施时逐个变异确认）**：

| 变异 | 必须红的面 |
|---|---|
| `detail.filter` 去掉 / 换成 `state <> 'FINISHED'` | 行数锚值不再等于 14935（不预设新值，判据是「≠」） |
| `detail.columns[].grantedBy` 改成清单外的码 | 门禁 ⑤ |
| `grantedCols` 不过滤（对无码者也投影） | 单测：无码请求的 projection 不含该列 |
| 内层漏 `max()` | 编译错（列不在 GROUP BY 里）——单测钉形状 |
| 表达式 CASE 的 `state` 条件写错（**声明**变异） | `scripts/sync-data-semantics.test.ts` 真事实源用例红；若数据面随之漂移，新不变量 **也**可能红——但它**不是**声明守卫 |

---

## 5 已知边界 / 非目标

- **价格列只在下钻面可用**：聚合面（`query_data`）对任何人都不返回它（它已不在 grain 里）。
- **粗粒度下条件列取 `max()`**：是「组内某一行的值」，不是聚合语义；行级（缺省）才是本义。
- **契约无 `sensitivity`**（§3.2）：血缘门看不到这条暴露，是**已知缺口**，不是已解决。
- `order_detail_price`（明细售价）不在门内、也不在闭集——同法可加，本批不做。
- 行级 `limit` 默认 50 / 上限 500 不变；不把 1000 行截断语义搬到下钻面。
- 不做「按 item_num 摊口径」（§0）。
- 不改 `query_detail` 的 HTTP/MCP/agent/插件四通道形状（只多一个可选回包列）。

---

## 6 与既有文档 / issue 的关系

- Phase 1 spec §2.3 草图里的 `detail.columns[].granted_by` 在本批落地；
  §7 订正 2「Phase 1 不声明列级掩码」由此解开——但用的是**条件列**，不是值级掩码，
  订正 2 的算术结论（值级 nullify 会污染判别式）**仍然有效**（§3.1）。
- issue #965（`order_line` 透传 PoC）：本批收口其权限敞口；**退役目标从「指标退役」改为
  「透传形状退役」**——指标本体留下，作为下钻绑定的载体。
- #984 / #986（封窗双计）与本批正交：改域不改冷热合流。
- 骨架正典仍是 `docs/architecture.md` §4.1 B11（口径只在 dbt 定义一次）；
  本批没有在 dbt 之外实现任何口径。

## 7 回滚

- 声明面回滚 = revert YAML + 跑 sync ⇒ 下钻绑定消失（`query_detail` 回 `no_detail_binding`），
  聚合面回 26 列 / 无 FINISHED 约束；
- 回滚代码（`drill.ts` / `metric-store.ts` / 门禁）与之同批；
- 无数据迁移、无 DDL。

---

## 8 实施订正与实证（2026-10-22，实施期回填）

> 本节只记**已经发生**的事；没做的不写。

### 8.1 订正

1. **声明漂移的守卫归口**（§2.6 / §4 原文已同批订正）：新 dbt singular test
   `assert_drill_order_line_matches_metric.sql` 的两侧谓词都是文件内**硬编码的独立参考实现**，
   读不到 YAML ⇒ **声明**漂移不会让它红。现分工：它守**数据面同量**
   （`vw_` 直读湖 FINISHED vs `stg_` CASE 物化 FINISHED）；
   声明层守卫是 `scripts/sync-data-semantics.test.ts` 的
   `★ 真事实源：order_line 的下钻绑定（8 列闭集 + 条件列）`
   （`detail.filter` 走 `toEqual`、`expression` 折进 `selectSql` 走前缀正则）。
2. **`bizday` 参数形状不可省**：示例必须写 `{from,to}` 且为 `YYYY-MM-DD`
   （`authz.ts` 的 `rangeLiteral` 只认该形状；裸日期串被 `paramFilters` 判
   `invalid_value:bizday`，无归一化）。
3. **声明字段的三跳要同批改**（计划审查盲区）：写库（sync 物化 `drill_detail`）→
   catalog → 读回（`drillBindingOf`）。本次 Task 1 只改读侧，
   `upsertL1Metric` 的序列化漏 `columns`，靠任务评审抓出——后续加声明字段时三跳一起列进任务。

### 8.2 实证

- **部署**：platform-core（mytech 实例）`dep_FbAXOvthkuxU4oXl` → v477 ready；
  `platform-core-shanhai` `dep_pM3DUn_OkfHWvbXX` → ready。两者容器 pid1 启动时间均晚于镜像构建；
  容器内 `grantedColumns` 命中、YAML `grantedBy: data:cost` ×3。
- **检出同步**：`lemeng-sync.sh 981a8063` ⇒ `SYNC_OK 225/225`，revision 落地。
- **词表物化**：新增 0 / **更新 2** / 删除 0 / 未变 41（43 条）；
  `tsx scripts/sync-data-semantics.mjs --check` ⇒ 零漂移。
- **库内声明**：`drill_detail` = `{filter: "state = 'FINISHED'", columns: [{col: order_detail_std_price,
  grantedBy: data:cost}], relation: vw_lemeng_retail_order_line}`；`drill_dims` 与 `group_by` 均为 8 列；
  `select_sql` 以 `sum(case when stg_lemeng_retail_order_line.state = 'FINISHED'` 开头（§3.3 偏差仍在）。
- **materialize**：`PASS=312 WARN=0 ERROR=0 TOTAL=312`、`MATERIALIZE_OK`；
  `assert_drill_order_line_matches_metric` PASS、`audit_lemeng__retail__order_line` PASS。
- **锚值**：`vw_lemeng_retail_order_line` 的 FINISHED 行数
  2026-10-20 = **14935**、2026-10-21 = **14395**（逐字复现）。
- **行域对照**（变异 ①，只读 SQL）：同日全状态行数 15267 / 14714 ⇒ 去掉 `state='FINISHED'`
  谓词必然改变 `rowCountTotal`。
- **聚合面一致**：2026-10-20 聚合面（`stg_` CASE）与直查（`vw_` FINISHED）合计均为 **445417.24**
  （逐分一致）。
- **变异确认**（本机改后还原）：
  ② 声明 `expression` 改 `state <> 'FINISHED'` ⇒ 真事实源用例红（1 failed）；
  ③ `grantedBy` 改 manifest 外码 ⇒ `check-column-scope-monotonicity` 规则⑤ 红；
  ④ `granted` 去掉 scope 过滤 ⇒ `drill.test.ts`「无 data:cost ⇒ 缺席」红。

### 8.3 真机两轮（2026-10-22 晚补记）

- **无码侧**（`ZhangDuo`，账号无 `data:cost`）：`query_detail(lemeng:retail:order_line, 2026-10-20)`
  ⇒ 回包 `columns` **不含** `order_detail_std_price`、`rowCountTotal = 14935`；
  审计 `drill.grantedColumns = []`。
- **有码侧**（`yangwei`）：在 Casdoor org `shanhaiyiguo-org` 的 `data:cost` 权限记录里追加该用户后，
  同一日期、同一参数再查 ⇒ 该列出现在回包**最后一列**，首行值 `10.00` 与该行直查
  `std_price` **逐字一致**；审计 `grantedColumns = ["order_detail_std_price"]`。
  该身份**发码前**的同一条查询审计为 `[]` —— 同一人前后对照即权限开关的现场证据。
- **企微渠道轮**（§4 第 6 条）：问「多少行」⇒ 答 14,935；点名 order_line 问明细 ⇒ 审计两条
  order_line 钻取、`rowCountTotal` 均 14935；问「标准价」⇒ 答「需要单独授权（类似 `data:cost`
  这类权限）；在你的账号下目前不可见」——**话术合格**（不是「没有数据」）。
- **运维备注**：新版 Casdoor 登录回两个**同名** `casdoor_session_id`；调用 admin 接口
  （`get-permissions` 等）须用**最后一个** cookie，拿第一个恒 `Unauthorized operation`。

### 8.4 仍开放

- ~~`detail.columns[].col` 无静态存在性校验~~ → **已由 #1009 落地**（`check-data-models` 规则 ⑤-x3：
  按 relation 的契约列集校验；只看有契约的视图，`org` 豁免；拼错 = 门禁期红，不再等到运行时）。
- 列级掩码 × 条件列的语义缺口归 **#995**（今天结构性不可达；若落掩码必须「生效 ⇒ 整列缺席」）。
