# L1 问数参数面（等值 + 日期区间）设计——openclaw 问数前置

> 2026-10-15。上位计划：`docs/superpowers/plans/2026-10-10-shanhai-openclaw-wecom.md` Task 6（端到端验收）；
> 词表阻塞（#573，词表 2 条）已随 W1/W2/W3 交付解除（shanhai `data.metrics` = 27 条 L1，10-14 真机验证）。
> 用户裁决链：2026-10-15 选「先补等值参数，再端到端」→ 架构重审后 date 参数升级区间形态（见 §2.1）→ 同意 F′。

## 1. 背景与证据（2026-10-15 shanhai 生产实测）

通道 C（openclaw bot → data-query-plugin → 平台 `/api/modules/data/query` → `data.query_audit`）**已端到端通**：
审计 94 条，其中 wecom 69 条（10-12~10-13 真人问答）。但问数回答能力只有「空参全量」一种：

| 证据 | 值 | 含义 |
|---|---|---|
| `verdict=ok` | 24 条，**全部空参 `{}`**，最后一次 `row_count=1000` | 模型只能裸查全量，1000 行直接进企微不可读 |
| `verdict=denied / bad_param` | 44 条，参数键 `biz_date` / `start_date`+`end_date` | **唯一真实的用户问法就是日期区间**（「近7天销售额」），全部被拒 |

根因三层（代码实证）：

1. `scripts/sync-data-semantics.mjs:254` 硬编码 `params: {}`（注释自述「L1 声明没有查询参数」）⇒ 27 条 L1 **零参数声明**，`authz.ts:167` 对任何参数键判 `unknown_param` → `bad_param`；
2. `MetricParamType` 只有 `date/number/string` 等值形态——日期区间的区间语义无处安放；
3. `list_metrics` 不返回参数名 ⇒ 模型不知道合法键，只能臆造（`biz_date` 即臆造产物）。

## 2. 定案（F′）

### 2.1 裁决记录

- 用户先选「先补等值参数，再端到端」（等值-only，T2 取舍不动）；
- 架构重审推翻等值-only 对日期维度的适用性：**审计里唯一真实问法是区间**；等值日期迫使 agent 逐日 N 查
  （O(N) 查询 + N×38 行灌进模型上下文，「近30天」不可行）；且 T2 的原始顾虑「同列双参拼恒空集且不报错」
  **恰被区间形态结构性修复**（`from>to` 显式报错，不再靠提示词告诫）。⇒ date 参数直接落区间形态。
- L2/refine 面作为候选已对照并**否决**（见 §8）。

### 2.2 参数推导规则（sync 编译期，单一实现点）

`scripts/sync-data-semantics.mjs` 把 254 行的硬编码 `params: {}` 替换为**从 `grain` 推导**：

```
params = grain ∩ 白名单，白名单与类型固定：
  bizday      → { column: 'bizday',      type: 'date_range' }
  system_book → { column: 'system_book', type: 'string' }
  domain      → { column: 'domain',      type: 'string' }
其余维度一律不暴露；subject 列防御性排除（现行 L1 grain 不含，规则仍在）。
参数名 = 列名（模型在 group_by 看到的名字，一致性防错）；required 一律缺省（不带参 = 全量）。
```

**白名单判定原则**：值域「模型或用户说得出」的维度才可作问数参数。27 条 grain 维度清点
（2026-10-15 实测）：`system_book`×27、`bizday`×27、`branch_num`×14、`item_num`×8、`domain`×5、
`supplier_num`×4、`storehouse_num`/`client_fid`/`expense_type`/`other_inout_kind`/`region_id` 各 2~3——
后八种是业务编码或冗余枚举（如 `expense:branch_{payable,receivable}` 已按方向拆成独立指标），
模型与用户都产不出合法值，暴露即死参数 + 参数面噪声化。

### 2.3 日期区间参数规格（authz 扩展）

- `MetricParamType` 增加 `'date_range'`；`MetricParamDef` 形状不变（`{column, type, required?}`）。
- 值形状：`{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }`（对象；两键都必填）。
- 校验（`authz.ts literal()` 的 `date_range` 分支，fail-closed）：
  - 非对象 / 缺键 / 任一键不过 `DATE_RE` → `null`（调用方转 `bad_param`，detail `invalid_value:<名>`）；
  - `from > to`（字符串比较即字典序 = 日历序）→ 显式 `bad_param`，**新增 detail `range_invalid:<名>`**——
    把 T2 防的「恒空集且不报错」升级为结构化报错；
  - 合法 → `` `<col> BETWEEN '<from>'::date AND '<to>'::date` ``。
- 既有 `date` 类型与等值路径**一字不动**（L2 若将来用参数仍走等值）。

### 2.4 词表暴露（routes/metrics.ts）

`GET /metrics` 响应按指标追加 `params`，**只投影 `{<参数名>: {type, required}}`**——`column` 是 SQL 内部面，
不出词表响应（与现行「`selectSql`/`subjectColumn`/`groupBy` 出现在**请求** body 即 400」同口径的防泄漏方向：
响应侧也不外泄 SQL 形状）。`list_metrics`（agent 工具）与 HTTP 词表共用该投影。

### 2.5 工具面描述（agent-loop.ts）

`query_metric` description 更新为：

> 按指标 id 查询数据。参数键**只能**取 list_metrics 返回的该指标 params 键名；`type=date_range` 的参数
> 传 `{from,to}`（闭区间，某天则 from=to）；未声明 params 的指标只能空参查全量（可能行数很大，尽量带参）。

（等值告诫句保留给 string/number 类参数；`MAX_AGENT_TURNS=6` 不动。）

## 3. 兼容性

- **空参 = 全量**行为不变（`required` 全缺省）——历史 24 条 ok 的调用形态不破坏；
- `data.query_audit.params`（jsonb）原样落区间值，审计可读；
- `data.metrics.params` 列与 upsert 通路已存在（`metric-store.ts:183`），**存储层零改动**；
- 词表 job（吃平台镜像快照）在 shanhai 主项目部署后重跑即生效（既有四步链，无新机制）。

## 4. 验收

**单测**（本轮门禁内）：
1. sync 推导：27 条 L1 编译产物 params 逐条断言（bizday/system_book 必在；5 条出库族含 domain；其余维度不在）；
2. authz：`date_range` 合法值 → BETWEEN SQL；缺键/非日期/from>to → 各自 detail；既有 date/number/string 路径回归不变；
3. routes：`/metrics` 响应含 `params` 投影且**不含** `column`/`selectSql`/`groupBy`。

**真机（Task 6 Step 3–6 照走，另加参数用例）**：
- 「10-12 的净销售额」（区间 from=to=单日）；「近7天净销售额」（区间）；「3120 账套 10 月净销售额」（system_book + 跨月区间）；
- 「调出和批发各多少」（domain 等值）；
- 未关联企微账号 → 扫码指引；群聊按权限可见性；`query_audit` 落库含 channel=wecom；流式硬指标（占位 ≤2s / 首块文本 / DeepSeek stream）。

## 5. 不做与回流条件

- **区间以外的比较符**（`>`/`<`/模糊）不开放——问数第一性问法是「哪段时间、哪个主体」，其余属探索分析，归 Metabase；
- **编码维度**（branch_num/item_num/supplier_num/storehouse_num/client_fid/region_id/expense_type/other_inout_kind）：
  回流条件 = 设计「维度值解析」工具（店名→编号这类 dim lookup）后按需放开，届时仍走本白名单机制的扩集；
- **L2 参数面**不开放（维持 sync 注释的自述边界）；
- 1000 行帽、行数告警、表格渲染优化不动（区间参数落地后全量裸查自然退化为主路径外的兜底）。

## 6. 架构对照（`docs/architecture.md` 不变量逐条）

| 不变量 | 本设计 | 判定 |
|---|---|---|
| 声明即授权 fail-closed | params 是**编译产物**（grain 白名单推导、持久化进 `data.metrics`），非运行时猜测；参数只能过滤已可见行，不扩可见性 | 合 |
| 词表防泄漏 | 响应只投影 type/required；column/selectSql/groupBy 不出词表面 | 合 |
| L1/L2 分工 | L1=编译参数面；L2=治理性持久切片（refine），问数会话内过滤不走 L2 | 合（维持既有边界） |
| 唯一事实源 | 参数→SQL 只在 `authz.literal` 一处；推导只在 sync 一处；不新增事实源 | 合 |
| 审计必落 | 区间值原样进 `query_audit.params` | 合 |

## 7. 涉及文件

- `scripts/sync-data-semantics.mjs`（推导替换硬编码）
- `modules/data/domain/authz.ts`（`date_range` 类型 + literal 分支 + `range_invalid` detail）
- `modules/data/routes/metrics.ts`（响应投影）
- `modules/data/domain/agent-loop.ts`（工具描述）
- 测试：上述各文件的 `*.test.ts` + sync 产物断言

## 8. 修订：合计形态（2026-10-15 真机验收 Q2 卡死后增补）

> 真机五问 Q2（近7天净销售额）实测：区间查询参数形状逐字正确、`verdict=ok`，但「区间 × 细 grain」返回
> **1000+506 行工具结果**灌进模型上下文 → 生成极慢、企微流 2 分钟+ 不闭合（用户观感 = 卡死）。
> `truncated` 信号存在（`query-service.ts:144`）且模型确实自纠改发单日查询，但 SKILL 指引的
> 「改用聚合口径」**在平台上不存在可改的形态**——区间合计这一问法没有合法答法。本节补上它。

### 8.1 形状

- `args` 增加保留键 **`total`**：**仅当 `args.total === true`（布尔真）**时进入合计模式；
  其余任何值（含字符串 `"true"`）不消费、走既有参数校验（`unknown_param:total`，fail-closed）。
- 合计模式响应：`{ subject, columns: ['total'], rows: [[<合计值>]], truncated: false, total: true }`
  ——恒单行，**不返回明细**（明细与合计互斥；`truncated` 恒 false：合计无截断面）。
- SQL 形状：`SELECT sum(value) AS total FROM ( <selectSql> WHERE <subject> … <filters> GROUP BY <grain> ) t`
  ——**去掉外层 LIMIT**（合计必须作用于全量匹配行；截断求和 = 错数）。

### 8.2 纪律

- `total` 是**查询面保留键**：指标参数不得命名 `total`（L1 白名单天然不含；L2 参数面本就未开放）；
- 模型不可借 total 伪造主体——subject 钉死逻辑不变，total 只是聚合形态开关；
- 合计语义 = 对该指标 `expression` 在过滤后全量匹配行上再聚合（数学上 = 明细 `value` 列之和）。

### 8.3 问数 SKILL v2（方法论层，`deploy/openclaw/data-query-plugin/skills/data-query/SKILL.md` 重写）

| 问法 | 策略 |
|---|---|
| 单点（某天/某店某天） | 直接查明细（行数 ~74–220/天/账套，安全） |
| 区间合计（近N天/本月共多少） | **先 `total:true` 拿总数**；需要分布再按天拆单日查 |
| 区间分布（按天/按店走势） | 说清分组；**先窄后宽**（先单账套、先 2~3 天探行量） |
| 行数预算 | net_sales ≈147 行/天（3120）/74 行/天（64188）；区间×双账套 ≈ 天数×220，**>4 天必 total** |
| `truncated:true` | 只能答「数据不全」，不得当全量下结论；收窄重查 |
| `bad_param` + detail | 读 detail 自纠，同一错误调用不重试 |

（平台侧工作：authz 合计分支 + query-service 执行 + 响应字段 + agent-loop/插件工具描述同步 + SKILL v2 + 测试。）

### 8.4 修订二：total 自动伴随（2026-10-16 部署后复测：模型不走 total 开关）

> SKILL v2 部署后复测同一问法：**模型没有用 `total:true`**——退回「逐日 × 分账套」10 查 ~1100 行，
> 上下文再次爆、企微流再次长时间不闭合。教训：**SKILL 正文对 flash 级模型是弱引导**；方法论可以教，
> 但「对的路」必须由平台自动发生。且旧 `total:true` 布尔标记与新语义冲突，本节统一。

- **`total` 字段 = 合计值**（数值/numeric 字符串），不再是布尔标记：
  - **自动伴随**：`totalable` 指标（见下）的任何查询，响应自动附 `total: <该过滤范围合计>`——模型无论如何问，答案里都有那个数；
  - **显式 `args.total === true`** 保留：只返回合计单行（`columns:['total']`），不返回明细——「只要总数」的快捷形态；响应同样带 `total` 值字段。
- **`totalable` 判定 = 表达式形状**：`expression` 以 `sum(` 开头 ⇒ 可加 ⇒ true；比率（毛利率/达成率）、
  去重计数（supplier_count——跨天求和 = 供应商·天数，错）一律 false，**不给自动合计**（模型也不得跨行求和，工具文案明示）。
- **物化**：`data.metrics` 加列 `totalable boolean NOT NULL DEFAULT false`（幂等迁移）；sync 从 expression 推导写入；
  `MetricDef`/`MetricRow` 贯穿到 query-service。`comparableOf` 纳入 ⇒ 词表 job 首跑 diff = **更新 27**（预期）。
- **SQL**：authz 对 totalable 指标在 plan 上附 `totalSql = SELECT sum(value) AS total FROM ( <whereAndGroup> ) t`
  （无 LIMIT，与显式合计共用同一形状）；query-service 执行后把值放响应 `total` 字段。
- **指引层级调整**：关键规则（「响应 total 字段直接引用，不要自己求和」「非可加指标勿跨行求和」）下沉到
  **工具描述**（保证在模型上下文），SKILL v2 方法论保留为策略层。

## 9. 已否决候选（留档）


- **L2/refine 做问数切片**：L2 是治理面（metric-write 落库 + 生命周期 + 「base 必须是已存在 L1、L2 不能以 L2 为 base」闸门），
  为持久切片设计；问数是会话内临时过滤，重量错配。两层面分工：L2=治理性持久切片，params=问数会话内过滤。
- **grain 全维推导**（重审前的 B 方案）：对编码维度暴露死参数，参数面噪声化——收窄为白名单后保留推导机制。
- **逐日等值查询顶区间**：O(N) 查询 + 上下文膨胀 + 「近30天」不可行；T2 顾虑反被区间形态修复（§2.1）。
