# 报表 AI 根因：有界分析（`ai_text` focus=`root_cause`）

> 2026-11-09。目标：报表 AI 组件**根据报表数据**分析根因并输出文本——**不做对话**、不接 openclaw。
> 关系：`2026-10-26-ai-narrative-component-design.md` 的 v1 非目标「自动下钻解释异常」在本篇落地；
> 语义/下钻/配方仍以既有正典为准（`2026-10-21-bot-drillthrough-design.md`、W6 `explore_query`/`explore_recipe`）。

## 1 一句话

`ai_text` 增加 `focus: 'root_cause'`：服务端先跑**有界、确定性的分析循环**（不调 LLM、不做工具对话），
把「哪个维度/哪几行造成异常」整理成 findings；再由 `narrative.ts` 的 LLM **一次成文**，数字受
`facts.numbers` 白名单约束。输出仍是报表里的一个文本面板。

## 2 有界循环

| 项 | 规则 | 常量 |
|---|---|---|
| 异常候选 | 报表 KPI（按相对变化排序）+ 最低日 | 最多 2 个 |
| 维度顺序 | 门店 → 商品 → 客户 → 日 | 最多 3 维 |
| 收口判据 | 主因解释度 = `|top delta| / Σ|delta|`；≥ 阈值收口，否则换下一维 | `CONCENTRATION_THRESHOLD = 0.5` |
| 探针预算 | 2 候选 × 3 维 | `MAX_PROBES = 6` |
| 每维行数 | Top 5 | `TOP_N = 5` |
| 下一层 | 胜出维度 → 订单/明细行 | 仅当 drill 闭集含 `order_no` |

实现：`modules/data/domain/report-root-cause.ts`。数据入口只有两个，且都复用既有唯一入口：

- `runDetailQuery`（指标声明的 `detail` 绑定）——复合口径/订单级根因；
- `compileRecipe` + `executeExplore`（variance / top_contributors）——单列聚合指标。

权限、掩码、审计、双钟全部由这两个入口负责；本模块不写 SQL、不写权限判定。
不可见/未接入源的指标先经 `visibleMetrics` 裁剪，不产出 findings。

## 3 接线

- `report-spec.ts`：`AiTextPanel.focus` 增加 `root_cause`（闭集，加值 = PR）。
- `report-facts.ts`：`FactBundle.analysis: RootCauseBundle | null`；只在 root_cause 时调用
  `buildRootCause`，数字并入 `facts.numbers`；`factsHash` 含 analysis，缓存内容寻址。
- `narrative.ts`：root_cause 追加「根因」段提示词（overview 提示词不变）；确定性模板也带根因行
  （优先 variance/top，再带 detail 明细行）。
- `routes/context.ts` + `routes/reports.ts`：`exploreExec` 测试缝（生产缺省 `analystPool`）。
- `mcp-report-tools.ts`：`propose_report`/`revise_report_spec` 描述补 `focus=root_cause`。
- `analysis/recipes.ts`：`recipeTargetOf` 接受关系限定列（`sum(fct_retail_sale.net_amount)`）——
  L1 声明的真实形态；否则 `explore_recipe` 在生产上全废。

## 4 验证

### 4.1 单测

- `report-root-cause.test.ts`（4 passed）：
  - 有对比 + 声明下钻 ⇒ 按 `branch_num` 做「本期 - 基期」分解；
  - **门店维解释度 10/27 ≈ 0.37 < 0.5 ⇒ 自动换商品维；商品维 100/120 ≈ 0.83 ⇒ 收口；再下钻订单行**；
  - 不可见/未接入源 ⇒ 不产出 findings。
- `narrative.test.ts`（25 passed）：root_cause 模板/白名单；overview 提示词不变。
- `report-facts.test.ts`（14 passed）、`report-spec.test.ts`（13 passed）、
  `mcp-report-tools.test.ts`（21 passed）、`reports.test.ts`（116 passed）。
- `tsc -p modules/data --noEmit` 干净。

### 4.2 真 LLM 端到端（合成数据）

模型：`deepseek-v4.1-flash`（Anthropic-compatible gateway）。真实 `buildRootCause` + 真实
`generateNarrative`，仓库数据用假执行器（根因预置在商品维/订单行）：

```text
tried: [ "...:branch_num", "...:item_num" ]   // 门店解释度不足 → 商品收口
findings:
  variance item_num: I1 100 (delta 100), I2 10, I3 10
  detail order_no:   O1 100（item_num=I1 的明细行）

根因：按商品维度 item_num 看，I1 值 100、变化量 100……按订单维度 order_no 看，O1 值 100……
      因此，期间净销售额（商品）的变化主要来自 I1 这一商品。
fallback: false
```

## 5 已知边界

1. **只走声明过的分解路径**：指标既无 `detail` 绑定、又不是单列聚合口径 ⇒ `unavailable`，不编。
2. **只下一层**：胜出维度 → 订单行；不链到供应商/采购/价格等跨对象路径。
3. **解释度阈值是常量**：0.5；真实数据上的阈值/维度顺序需用案例校准（「无案例不立标准」）。
4. **真 LLM 验证是合成数据**：证明有界循环 + 文本输出能跑通，不等于生产真实数据上必然发现未知根因。
5. **延迟/成本**：每个 root_cause 首次生成最多 6 次探针（明细两腿/配方 1-2 腿）+ 一次 LLM；
   结果按 `factsHash` 缓存，期间/门店/数据不变不重复跑。

## 6 Issue / PR 描述（可原样使用）

**Title:** feat(data): 报表 AI 根因有界分析（ai_text focus=root_cause）

**Body:**
- 目标：报表 `ai_text` 根据报表数据输出根因文本，不做对话、不接 openclaw。
- 做法：`focus=root_cause` + 有界确定性分析（2 候选 × 3 维 = 6 探针，解释度 ≥0.5 收口，
  胜出维度下一层订单明细）+ 一次 LLM 成文；数字并入 `facts.numbers`，缓存键含 analysis。
- 修 `recipeTargetOf` 不认关系限定列（`sum(fct_retail_sale.net_amount)`）的生产 blocker。
- 验证：单测 4 个文件全绿；真 LLM（deepseek-v4.1-flash）门店解释不足 → 自动换商品 → 下钻
  订单行，输出根因文本，`fallback:false`。
- 边界：只走声明下钻/单列聚合；只下一层；阈值 0.5 待真实案例校准。
