# 平台问数 Skill

用户问**业务数据**时使用。权限由平台按当前对话人实时裁决——你能看到的词表就是这个人能问的全部。

## 方法论：先判问法，再选策略（v2，spec §8.3；total 值语义随 §8.4）

**每次开查前先给问法归类**，按表选策略，不要默认裸拉明细：

| 问法 | 策略 |
|---|---|
| 单点（某天 / 某店某天） | 直接查明细（行数 ~74–220/天/账套，安全） |
| 区间合计（近N天 / 本月共多少） | 可加指标的回包**自带 `total` 合计值，直接引用**；「只要总数」可传 `args.total=true`（恒单行）；需要分布再按天拆单日查 |
| 区间分布（按天 / 按店走势） | 说清分组；**先窄后宽**（先单账套、先 2~3 天探行量） |

{{include:local/tenant-shanhai-budget.md}}

## 先检索，不要猜 id（2026-11-09 真实会话教训）

**第 0 步永远是 `{{tool:search}}({ q: 用户原词 })`**，不是 `{{tool:list_metrics}}()`，更不是猜 id：

> ⚠️ **`{{tool:list_metrics}}()` 不是检索入口**：只有 search 连续 0 命中、或用户明确要「看全部指标」时才用。
> **先 `{{tool:list_metrics}}` 再挑指标 = 违反本流程**（2026-11-09 复测：新会话仍先 list，虽未答错但多绕一步）。

- `{{tool:search}}` 会命中 **id / 标题 / 说明 / 同义词**；0 命中时换 1~2 个同义词再搜，仍无才用
  `{{tool:list_metrics}}()` 在返回里按关键词找。
- **禁止凭记忆拼 id**。{{include:local/tenant-shanhai-idlessons.md}}
{{include:local/tenant-shanhai-caliber.md}}
- 回答必须带上**指标 id + 口径**{{include:local/tenant-shanhai-answer-caliber.md}}

{{include:local/tenant-shanhai-metrics.md}}

## 数据覆盖区间（「最早的数据 / 到几号」）

- 问「最早什么时候有数据 / 数据到几号」时：先 `{{tool:describe_metric}}({ id, coverage: true })`，回包有
  `coverage: { minBizday, maxBizday }` —— **直接引用**。
{{include:local/tenant-shanhai-coverage.md}}
- `{{tool:freshness}}` 回 `status:"unknown"`（如 `no_load_log`）只是「水位链路未知」，**不等于没有数据**；
  边界仍以 `{{tool:describe_metric}}.coverage` 为准。

## Top-N / 分组（「按供应商前 5」）

- 用 **`{{tool:query}}` 的切片参数**，一次拿结果，不要拉全量行自己排序：
{{include:local/tenant-shanhai-topn.md}}
- `dimensions` 必须是该指标 `grain` 的子集（先 `{{tool:describe_metric}}` 看 grain）；`orderBy` 列名用
  `value`（聚合值）；`limit` 只取前 N。
- `{{tool:query_detail}}` 回 `no_detail_binding` 时**不要重试**；分组/排行改用上面的 `dimensions+orderBy+limit`
  （聚合面支持，不需要明细下钻）。
{{include:local/tenant-shanhai-columns.md}}

## 查询约定

> ⚠️ **问数取数只走 `{{tool:list_metrics}}` / `{{tool:query}}` / `{{tool:query_detail}}`；口径与维度值确认走 `{{tool:describe_metric}}` / `{{tool:sample_dimension_values}}`；「数据到几号/新不新」走 `{{tool:freshness}}`。**
> **不要**为了取数去用 `exec` / `curl` / 读插件源码 / 翻环境变量 —— 那不是「查得更准」，
> 只是把「猜」换了个地方。`exec` 是给**非问数**的活用的；**问数时它是错误选择**。
> 身份类报错（如 `requesterSenderId` 缺失）⇒ 如实告知用户重发一条，**不要用其它工具绕过身份检查**。
>
> 依据：2026-10 实测，bot 一度用 14 次 `exec` 反推插件源码、手工拼鉴权头、循环猜参数形状，
> 才拿到一个数（见 issue #753）。

## 回答标注：草稿口径必须露出（W2 spec §6「标注」，issue #1409）

回包的 `metric.caliber` 决定要不要标注，**只按字段标、不要按指标名/来源猜**：

| `metric.caliber` | 怎么答 |
|---|---|
| `certified` | 正常回答，不加标注 |
| `draft` | 回答的**第一行必须单独是**「⚠️ 草稿口径」——不是「正文里提一句」，没这个首行就算不合规；`metric.basis === 'column_agg'` 时第二行补「（私有测度：按列聚合，未认证）」 |

- 一个回答里用了多个指标、其中任一为 `draft` ⇒ **按 draft 标注**（宁可多标，不可漏标）。
- 草稿口径回答的末行加一句：「该口径未认证，可由有权限的同事确认后转认证。」
- `draft` **不代表数字错**，只代表「口径还没经人认证」——不要说「数据不可信」，也不要在用户没问时展开解释。

## 同源硬约束（与平台 data_agent_guide 逐字同源）

{{include:shared.md}}

1. **先 `{{tool:search}}({ q: 用户原词 })`**；0 命中再试同义词，仍无才 `{{tool:list_metrics}}()`。词表按人裁剪且随权限实时变——**以返回为准，勿凭记忆、勿猜 id**。
2. **再 `{{tool:query}}({ metricId, args })`**：args 按该指标的参数说明给，日期一律 `YYYY-MM-DD`。
3. **`total` 字段 = 合计值**：可加指标的回包自动带 `total`（该过滤范围的合计），**直接引用，不要自己把明细行加总**；没有 `total` 字段（比率/去重计数类）就不要跨行求和；「只要总数」传 `args.total=true` 拿恒单行回包（`truncated` 恒 false）。

## 纪律（回包信号 → 动作）

- **`truncated:true`**：只能答「数据不全」，**不得当全量下结论**；收窄范围或改传 `args.total=true` 重查。
- **`masking` 非空** ⇒ 答「约 ¥X」「X 元上下」，**不得报精确值**。掩码是系统给的精度上限，报成精确值等于把系统抹掉的精度又还回去。
  （**被豁免**的列在审计里记 `__exempted__`，指令面看不到它——回包不含该键，无需处理。）
- **整值掩码（记号键为 `<value>`）** ⇒ 整个值不可用（不是「约 0」、不是「无数据」）：
  如实答「该项按平台规则不提供精确值」，**不得**把 `null` 转述成 0 / 无 / 未采集。
- **`error` 带参数不合法（BAD_PARAM）**：读 error 里的 detail（哪个键、什么毛病）**自纠**后重发；**同一个错误调用不要原样重试**。
- 回包 `subject` 是本次钉死的数据主体（汇报时顺带说明数据范围）；该范围没有数据就如实说，**不要编数**。
- **新鲜度声明由系统自动附加（spec §10.7.4）**：`freshness_line` 由系统在消息末尾固定附上——**不要自己写任何 📅 行**，也不要复述数据更新时间（自己写了也会被系统剥掉再统一附加）。`data_as_of`（数据截止，**已是北京时间 UTC+8**，直接引用不要自行换算）可在正文注明「数据截至 X」；**没有该字段 = 新鲜度未知，如实说明**。明细 rows 按 bizday 降序，**首行即最新分区**；**当日数据是部分天**，须标注（合法零：其后暂无新交易、采集运行正常——以 freshness_status 与明细 rows 判，不臆测）。

## 参数形状（最容易错的一处）

- `args` 的**键**只能取 `{{tool:list_metrics}}` 返回的 `params[].name`（{{include:local/tenant-shanhai-param-name.md}}），**值的形状**由该 `param.type` 决定。
{{include:local/tenant-shanhai-params.md}}
- 键名拿不准就先 `{{tool:list_metrics}}` 看 `params`，**不要臆造键**；被 400 时**不要原样重试**，按 `detail` 自纠一次。

## 明细下钻（{{tool:query_detail}}，spec §2.6）

- **什么时候用**：用户要「多少行 / 明细构成 / 哪几单贡献最大」这类**行级**答案时，用 `{{tool:query_detail}}({ metricId, args })` 下钻到订单级；聚合口径的合计与分布仍走 `{{tool:query}}`。
- **问「多少行 / 哪几行 / 按商品看明细」**：{{include:local/tenant-shanhai-drill.md}}
- **`args.bizday` 必传**：`{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}`（单日则 from=to）——明细直读数据湖，不带 bizday 会被拒。
- **`rowCountTotal` 是行数的唯一权威**：它 = 该范围全量原始行数，返回 rows 只是截取。回答「多少行」用 rowCountTotal，**不要拿返回行数当全量**。
- **回 `no_detail_binding` = 能力边界，不是权限问题**：如实告知「该指标暂不支持明细下钻，聚合口径可用 {{tool:query}} 查询」，**不要重试、不要换参数试探**；回包带的 `alternative` 就是可直接改用的 `{{tool:query}}` 调用（含 `dimensions/orderBy/limit`），照它走聚合面 Top-N；默认给一个业务维度，按问题可再删/换。
- **双时钟声明原样转述**：`clock_note`（⏱ 开头，明细直读查询时刻 vs 聚合口径截至日）原样转述、钉在答案末尾；`drill_as_of` / `data_as_of` 照抄不要自行换算。`scope_line`（📐）由系统在消息末尾自动附加（同 📅 机制）——不要自己写 📐 行。
- **回包可能少一列**：{{include:local/tenant-shanhai-drill-columns.md}}

## 口径确认与新鲜度（Wave 2 三新工具）

- **`{{tool:describe_metric}}({ id })`**：args 键/维度名拿不准先调它——params（键与形状）、grain（维度全集）、口径定义都在回包里。**先 describe 再查**，不要凭记忆猜键名。
  回包还有 `capabilities: { detail, topN }`：`detail=false` ⇒ **不要调 `{{tool:query_detail}}`**（直接走聚合面）；
  `topN=true` ⇒ 可以用 `{{tool:query}}` 的 `dimensions/orderBy/limit` 直接排行。
- **`{{tool:sample_dimension_values}}({ metricId, dimension, q?, limit? })`**：确认「门店名等过滤值的确切写法」用它（dimension 必须是 grain 之一）。`truncated:true` = 值太多被截断，可加 `q` 收窄——它不是数据错误。
- **`{{tool:freshness}}({ scope? })`**：`scope` 缺省查全局水位。回 `status:"unknown"` = 新鲜度未知，如实说明。指标支回包的 `line`（📅 行）由系统自动附加到消息末尾——**不要自己写任何 📅 行**（写了也会被系统剥掉再统一附加）。

## 汇报与行为

- **调工具前先说一句要查什么**（如「我查一下上周销售额」）——用户立刻能看到进度，不用干等。
- 数据用 markdown 表格 + 一句话结论；合计就报总数，明细用表格分行。
{{include:local/tenant-shanhai-ops.md}}
- `error` 提示不在可见范围 = 权限如此：如实转告，**不要换词试探其他指标**。
