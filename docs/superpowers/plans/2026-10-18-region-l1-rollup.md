# 一级战区汇总（L1 rollup）：把 `region_l1` 落到聚合处

> 2026-10-18。上位：#883（战区维物化）+ 消费面 spec §3 的 01-04「战区贡献与占比」。
> 本文只解决**一件事**：让「按一级战区汇总」从「具备条件」变成「真出数」。

## 0. 现状（实测）

| 事实 | 出处 |
|---|---|
| `region_l1` **只在 `dim_lemeng_branch`**（marts 维）上，**没有任何 mart 带它** | grep `dbt/models` |
| `fct_contribution` 粒度 = `(system_book, bizday, domain, branch_num, region_id)` | 模型头注 |
| `lemeng:contribution:region_net` 粒度 = `(system_book, bizday, region_id)`，`expression = sum(n_net_store)` | `l1_metrics.yml:707` |
| 战区维权威 = `dim_region`（`region_id → region_name + region_l1 + level`），27 行，真机已物化 | `dbt/seeds/schema.yml` |

⇒ **缺口是「聚合处没有 `region_l1`」**，不是数据缺。维上已经有它，事实表没有。

## 1. 落点判据（按消费面 spec §1 三问）

**问 1（形状）**：`from` 一个关系、`GROUP BY region_l1` ⇒ 需要那张关系上**真的有** `region_l1`。
L1 声明面不能跨关系 join（门禁规则⑤：单条声明只有一个 FROM）⇒ **必须把它落到 mart 上**。

**问 0（可推导吗）**：能 —— `region_l1` 是 `region_id` 的函数（`dim_region` 给定），属**纯派生属性**，
不影响粒度、不引入新事实。

⇒ 结论：**加到事实表上**，不是新建第二张 mart。

## 2. 方案对比

| | **A. `fct_contribution` 加 `region_l1`（推荐）** | B. 单独 rollup mart | C. 不落，消费方 join |
|---|---|---|---|
| 粒度 | **不变**（`region_l1` 函数依赖于 `region_id`） | 新表，与源表必须同步重建 | — |
| L1 声明 | 新指标直接 `from fct_contribution` | 可以，但多一张表要维护 | ❌ **写不出**（单关系约束） |
| 可加性 | 上卷正确（`region_l1` 是 `region_id` 的**分区**） | 同 A | — |
| 代价 | 一列 + 一条 join + 一条断言 | 一张表 + 一套同步 | 不可行 |

**推荐 A。** 与 `dim_lemeng_branch` 同源（都 join `dim_region`），不引入第二事实源。

## 3. 语义边界（**必须写进指标 definition，不许省略**）

1. **`region_l1` 为空的两类行**：
   - `region_id = 0` —— 费用侧「无出库可归属」的孤儿行（`fct_contribution` 头注）；
   - `region_id = 9046` —— 批发行的**幻影战区**（真机实测：全部批发落进这一个 id，与 12 个真战区不重叠；`所有区域` 的 `region_l1` 为空）。
   ⇒ join 后这些行 `region_l1 = null`。
2. **null 不许静默丢**：`GROUP BY region_l1` 会把它们归到一个 `null` 组。**要显式命名**（如 `未归属`），
   否则「各一级之和」看着等于总量，其实是**恰好把不该算的排除了**。
3. **恒等式**：`Σ(各一级) + Σ(未归属) = Σ(全量)`（逐账套逐日）。这是本改动的**硬验收**，
   要落一条 `audit_*` 断言，而不是靠人眼。
4. **射程**：`n_net_store` 是 **transfer-only**（`region_net` 的既存射程），所以这条一级汇总
   **只覆盖配送出库到门店的部分**；批发按战区归仍需 X01a 的 `client_fid → region_id` 映射（消费面 spec §11.2，未就位）。

## 4. 改动清单

| # | 动什么 | 为什么 |
|---|---|---|
| 1 | `fct_contribution.sql`：left join `dim_region`（键 `(system_book, region_id)`）+ 输出 `region_l1` | 聚合处需要它；`left` 保未登记/幻影行不被丢 |
| 2 | `marts/schema.yml`：`fct_contribution` 加 `region_l1` 列描述（含 §3 的两类空值） | 列语义单点 |
| 3 | `l1_metrics.yml`：新增 `lemeng:contribution:region_l1_net`，`grain: [system_book, bizday, region_l1]`，definition 写 §3 | 兑现「按一级战区汇总」 |
| 4 | `dbt/tests/lemeng/audit_lemeng__contribution__region_l1_net.sql`：§3.3 的恒等断言 | 门禁规则⑦ 要求每个声明指标一条对账 |
| 5 | `deploy/data-plane.lock` 重生成 | 清单树变了 |

**命名**：指标 id 用 `region_l1_net`（与 `region_net` 同族、粒度后缀不同），**不要**改 `region_net`
的粒度——那会让存量消费方（含缓存/词表）语义漂移。

## 5. 验收

1. **出数**：真机 `GROUP BY region_l1` 能得到 `东部战区 / 中部战区 / 南部战区 / 西部战区 / 广西大区 /
   贵州宣威大区 / 其余门店1 / 其他门店 / 未归属`。
2. **恒等**：§3.3 逐账套逐日成立（audit 绿）。
3. **不改存量**：`region_net` 的数值与改动前**逐分相同**（加列不改行）。
4. **词表**：`data.metrics` 出现新指标；**主项目部署后**重跑词表 job（`l1_metrics.yml` 变了 ⇒ 走上线四步链的第 3 步）。

## 6. 待决（要人拍）

1. **`未归属` 桶要不要显式命名**？（建议要 —— 否则「各一级之和」会误导；备选：指标按 `region_l1 is not null`
   过滤并在 definition 里声明「本指标不含未归属」）
2. **是否同时给 `fct_hq_outbound` 也加 `region_l1`**？（若未来批发按战区归就位，那条链也要它；当前不建议预加 —— 无消费方。）
3. 一级汇总要不要**同时出占比**（`region_l1_net / 全量净额`）？按消费面 spec 01-04，占比是 **L1 ratio**
   （同表两列），需要再落一列分母。
