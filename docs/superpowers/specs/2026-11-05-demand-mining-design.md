# 需求挖掘（Phase 2）设计

> 对应路线图 `docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md` 的 **Phase 2**（§3/§4）。
> 入口条件（W1 有真实数据 / W2 候选池在跑）已满足，数据现实见 §0。本阶段前置：W0–W3 全部完成。
> 关联问题追踪：与 #741（撞墙回路）分工见 §0.3——**本阶段只回答「缺什么」，不负责「为什么问不出来」**。

## 0. 为什么这样定位

### 0.1 数据现实（2026-11-05 生产实测）

| 信号源 | 30 天实际数据 | 可用性判断 |
|---|---|---|
| `data.query_audit`（平台侧） | ok 5802；`bad_param` 68（14 指标）、`no_detail_binding` 14（11 指标）、`metric_not_declared` 10（9 指标）、`unknown_tool` 1 | **主信号**：直接给出「用户点了哪个指标/要拆什么」 |
| `askdata_conv`（OO 全对话） | 566 行 / **9 个会话** | 可挖 `metric_hunt`（口径寻路）；同一 `(session_id, seq)` 有重复行需去重 |
| `askdata_stuck`（OO 撞墙） | 23742 行但只来自约 9 个会话，单会话 11717 行；`rule_ver=4`（#963 修后）仅 61 行/3 会话 | **不可作独立挖掘输入**（旧版重复累积、rule_ver 2/3/4 混版）；只作**证据附注**，按 `(session_id, seq, rule_ver)` 去重取最新 |
| `data.verified_questions`（W1） | 16 verified / 26 rejected / 3 candidate | 答错=口径问题，不全是需求；本阶段**不接入**（接入留待样本增加后评估） |

**结论**：真实用量很小（9 个会话），任何「聚类 + 频次阈值」都会在没有案例可校准的情况下**编阈值**。因此本阶段只做**机判、零阈值、人审优先**的需求清单。

### 0.2 一条真实案例暴露的噪声

`metric_not_declared` 的 9 个指标里，有 4 条是**测试探针**（`verify-20261007:net_sales:by-bizday`、`verify-20261007:nope`、`mcp-probe-20261007:net_sales:by-bizday` 等）——不排除就会把测试当需求。另 `net_sales`（裸名）其实对应已声明的 `lemeng:retail:net_sales`，这是**别名缺口**而不是新指标。四类判定由此而来（§2）。

### 0.3 与 #741 的分工

| 谁回答 | 问题 | 数据源 |
|---|---|---|
| **本设计（Phase 2）** | 「用户**想要什么**而词表没有」 | `query_audit` 拒绝类 + `askdata_conv` 寻路 |
| #741 撞墙回路 | 「bot **为什么**问不出来」（工具面/指令面/回包面） | `askdata_stuck` / `askdata_trace` |

`bad_param`、`tool_error`、`warehouse_error`、`mutating_disabled` **不进需求清单**——它们指向工具面或基础设施，归 #741。

## 1. 定位与产出边界

**做**：一个**人审需求台账**。
- `data.demand_signals` 表（需求事实 + 计数 + 证据 + 人工否决位）
- 每日挖掘 job（读平台侧 + OO，幂等写入）
- manage 面两个 MCP 工具：`list_demand_signals`（只读，带 resolved 判定）、`dismiss_demand_signal`（写否决，受写总闸门控）

**不做**（本阶段明确边界）：

| 不做 | 理由 |
|---|---|
| 写入 `data.metric_candidates` 候选池 | 需求 ≠ 该建。候选池口径是「数据画像推导 + 采用」，混入需求会污染 W2 的统计与淘汰逻辑 |
| 自动建指标 / 自动改 synonyms | 建不建是人决；动作走既有链（见 §1.1） |
| 文本相似度聚类、频次阈值 | 9 个会话，无案例可校准（「无案例不立标准」） |
| console 页 | 小样本下 MCP 工具 + 对话呈现已够；量起来再加 UI |
| 改 W1/W2/W3 既有链路 | 本阶段是纯新增读面 + 一张表 |

### 1.1 需求被采纳后的动作链（不在本阶段实现，仅约定出口）

| 需求类型 | 人的动作 | 走哪条既有链 |
|---|---|---|
| `alias_gap` | 给已有指标补同义说法 | `dbt/semantics/l1_metrics.yml` 的 `synonyms:`（W0 字段） |
| `new_metric` | 建 L1 指标 | `propose_metric_declaration` → `apply_pipeline_proposal`（W3） |
| `drill_gap` | 给指标声明下钻绑定 | 指标 `drill` 声明（W3 后的指标声明面） |
| `metric_hunt` | 定口径或扩 L2 | D6 指标定义变更 / L2 树 |

## 2. 信号面与四类判定

全部**机判**，判据只用结构化字段，不引入任何数值阈值。

| kind | 判据 | 真实案例（生产） | 诉求 |
|---|---|---|---|
| `alias_gap` | `metric_not_declared`，**且请求名不足三段**（`split(':').length < 3`）+ 其**末段**与词表某指标末段相同（`net_sales` ↔ `lemeng:retail:net_sales`） | `net_sales` ×1、`retail:net_sales` ×2 | 补 synonyms |
| `new_metric` | `metric_not_declared`，其余情形——**含「三段齐全但无精确匹配」**（用户特意指定了域，末段撞名不算别名） | `lemeng:retail:target`、`lemeng:sales:target`、`lemeng:retail:line_count`（末段与 `lemeng:outbound:line_count` 相同，但域不同 ⇒ 真缺）、`lemeng:retail:sale_line_count` | 建 L1 |
| `drill_gap` | `no_detail_binding`（该指标未声明 `drill` 绑定——**能力边界，不是权限拒绝**） | `lemeng:outbound:net_amount` × `branch_num`（3 次）、`lemeng:branch:transfer_money` × `branch_num`/`system_book` | 声明下钻绑定 |
| `metric_hunt` | 同一 `session_id` + **同一 `args.bizday` 时间窗**内，`query_data` 出现 **≥2 个不同 `metricId`**（结构判据：≥2 即「没有唯一答案」，不是频次阈值） | conv 实测 `query_data` 行带 `metricId` + `args.bizday{from,to}` | 定口径 / 扩 L2 |

**target 的定义**（表的唯一键之一，必须跨轮稳定）：

| kind | target | detail |
|---|---|---|
| `alias_gap` | 请求的原始名字（如 `net_sales`） | `{ matchedMetricId }` |
| `new_metric` | 请求的原始指标 id | `{ }`（后续可手工补） |
| `drill_gap` | `<metric_id>`（维度进 detail，不进键——同一指标的多个维度诉求合并为一行） | `{ dimensions: [...] }` |
| `metric_hunt` | `session_id` + `bizday` 归一化串 | `{ question, metricIds: [...] }` |

**排除规则**（有案例，可扩白名单）：

| 排除 | 判据 | 理由 |
|---|---|---|
| 测试探针 | target 命中前缀 `verify-` / `mcp-probe-` / `w1:test` / `test-` | 实测 4 条假需求混在真数据里；真实探针 id 为 `w1:test:by_branch`（冒号） |
| 参数错 | `reason='bad_param'` | 工具面问题（归 #741） |
| 总闸/基础设施 | `mutating_disabled` / `tool_error` / `warehouse_error` | 不是需求 |
| unknown 工具 | `unknown_tool` | 工具面问题（归 #741） |

## 3. 数据模型（迁移 036）

```sql
-- 需求台账。唯一键 (org, kind, target)；重复挖掘只累加，不新建行。
create table if not exists data.demand_signals (
  id            bigserial primary key,
  org           text        not null,
  kind          text        not null,          -- alias_gap | new_metric | drill_gap | metric_hunt
  target        text        not null,
  detail        jsonb       not null default '{}'::jsonb,
  occurrences   integer     not null default 1,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  evidence      jsonb       not null default '[]'::jsonb,  -- 最近 ≤5 条样本
  dismissed_at  timestamptz,
  dismissed_by  text,
  dismiss_reason text
);
create unique index if not exists demand_signals_key
  on data.demand_signals (org, kind, target);

-- 挖掘水位。**必须入 DB**：occurrences 是累加量，水位放 /tmp 会在容器重建后回放重复计数
-- （W1 的 /tmp 水位之所以可接受，是因为那边 upsert 本身幂等、计数不敏感）。
create table if not exists data.demand_mining_state (
  org         text        not null,
  source      text        not null,            -- 'query_audit' | 'askdata_conv'
  last_cursor bigint      not null,            -- query_audit.id / conv._timestamp
  updated_at  timestamptz not null default now(),
  primary key (org, source)
);
```

## 4. 挖掘器

- **位置**：`scripts/demand-mining.mjs`（形态照 `scripts/verify-ingest.mjs`：纯 node、显式 summary 行、fail-fast）。
- **执行面**：openship 每日 job 经 `docker exec` 进 server 容器跑（复用容器内 `DATABASE_URL` 与 `OO_READ_*`，**无新 env、无新凭据**）。
- **读取面**（平台侧为主、OO 两流为辅）：

| 源 | 读法 | 水位 |
|---|---|---|
| `data.query_audit` | `where id > last_cursor order by id` | `demand_mining_state.source='query_audit'`，cursor = 最大 id |
| `askdata_conv` | OO **组织级** `/api/{org}/_search`（流级 `_search` 该版本没有），SQL 指定流名；**JSON 键全小写**（`session_id`/`tool_args`） | `source='askdata_conv'`，cursor = 本批最大 `_timestamp`（**排他**：下轮 SQL 用 `> cursor`，`== max` 的边界组不重读）。**不要写 `max+1`**：那会额外排除 `max` 与 `max+1` 两档、制造 1 微秒盲区，却不比写 `max` 多得任何收益 |
| `askdata_stuck` | 同上读法，按 `(session_id, seq, rule_ver)` 去重**取最新 rule_ver** | 不推进独立水位（按会话窗口查询即可） |

- **不去重 / 不归并**（2026-11-05 Task 2 Critical 订正，**旧文「先按 `(session_id, seq)` 归并」已作废**）：同一 `seq` 下有多条消息 part（thinking/text/tool_call），调用行与结果行分属不同 `seq`；按 `(session_id, seq)` 归并会把调用行整个吃掉（`metric_hunt` 结构性恒 0）。重复行无副作用——分组用的是 `Set<metricId>`，相同 `metricId` 自然只算一次。
- **幂等**：`insert ... on conflict (org, kind, target) do update set occurrences = demand_signals.occurrences + excluded.occurrences, last_seen = greatest(...)`；`evidence` 滚动保留最近 5 条（新在前）。
- **summary 行**（机检可 grep）：`demand-mining: scanned=N alias=N new_metric=N drill=N hunt=N skipped_probe=N cursor_audit=… cursor_conv=…`（**无 `skipped_reason`**：设计早期列过，但实现以 brief 为准——`skipped_probe` 只统计「本该成需求却被探针前缀挡掉」的行，`bad_param` 等本就不是需求、不计数）。

**失败语义（fail-fast，不吞）**：

| 情形 | 行为 |
|---|---|
| OO 不可达 / 鉴权失败 | 该源本轮失败 ⇒ 打印 `SOURCE_FAIL askdata_conv <原话>` 并 **exit 1**；已写入的平台侧结果保留（幂等，下轮续） |
| DB 不可达 | exit 1，零写入 |
| 无新数据 | exit 0，`scanned=0`（正常，不是失败） |
| 出现未登记的需求类型 | exit 1（`UNKNOWN_KIND`）——不许静默丢弃新形态 |

## 5. 工具面（manage 面）

| 工具 | 性质 | 签名 | 语义 |
|---|---|---|---|
| `list_demand_signals` | 只读 | `{ kind?, includeResolved?: false, includeDismissed?: false, limit?: 1..50 = 20 }` | 按 `occurrences` 降序；每条带 `resolved` 自动判定 + `resolvedBy` 说明 |
| `dismiss_demand_signal` | 写（受 `DATA_MCP_ALLOW_MUTATING` 总闸） | `{ id: number, reason: string }` | 写 `dismissed_at/by/reason`；已否决再调 ⇒ `ok` + 原否决信息（幂等） |

**resolved 自动判定**（读词表快照，不做写回）：

| kind | resolved 当且仅当 |
|---|---|
| `alias_gap` | 某指标的 `synonyms` 已包含该说法（大小写不敏感） |
| `new_metric` | 词表已存在该 `id`（精确匹配） |
| `drill_gap` | 该指标行已有 `drill` 绑定 |
| `metric_hunt` | **永不自动消解**（口径是人决），只能 `dismiss` |

**工具面预算**：新增 2 个工具 ⇒ manage 面 9 → 11。`PIPELINE_FACE_MAX_TOOLS` 改名 `MANAGE_FACE_MAX_TOOLS`（门禁 `scripts/check-mcp-toolface.mjs` 跟随）；工具元数据放**新文件** `modules/data/domain/demand/tools.ts`（保持纯：不 import pg/Hono/zod），与 proposal 工具合并成 manage 面清单——不把治理读面塞进提案文件。

## 6. 组织隔离

- 表按 `org` 分区；挖掘与读取都带 org 上下文（现状单租户 `shanhaiyiguo-org`，多租户到来时无需改表）。
- `askdata_conv` 的 org 归属：OO 侧按 `ASK_VERIFY_ORG` 同源约定（现状单租户；多租户时 conv 需带 org 维度，登记为已知边界）。

## 7. 验收判据

| 判据 | 怎么验 |
|---|---|
| 四类判定正确 | 单测用**生产真实案例**做 fixture：`net_sales`→`alias_gap`、`lemeng:retail:target`→`new_metric`、`outbound:net_amount`+`branch_num`→`drill_gap`、探针前缀被排除 |
| 幂等 | 同一批数据跑两次 ⇒ `occurrences` 只加一次（水位入 DB 生效）；同 audit id 不重复计 |
| 去重 | conv **不预去重**（同 `seq` 多 part；判定按 `Set<metricId>` 收敛重复，见 §4）；stuck 旧 rule_ver 被最新覆盖 |
| 工具面 | 写总闸关 ⇒ `dismiss` 回 `denied/mutating_disabled` 且零写入；`list` 不受影响；`check-mcp-toolface` 预算绿 |
| 真机 | job 跑一次 ⇒ 表有真实行（应有 `alias_gap`/`new_metric`/`drill_gap` 各≥1）⇒ `list_demand_signals` 返回可读清单且 resolved 判定正确 ⇒ 否决一条后再查不再出现 |
| 不破既有 | W1/W2/W3 的测试全绿；无新 env、无数据面投递 |

## 8. 已知边界（本阶段不解决，写进台账）

1. **样本量小**：30 天 9 个会话；`metric_hunt` 与四类计数都很薄，趋势判断需累积使用量后再看。
2. **conv 只覆盖 openclaw 会话**：MCP 直连其他 agent 的会话不进 `askdata_conv`（部分由 `query_audit` 覆盖）。
3. **探针前缀是白名单**：新命名的探针（如 `smoke-`）会混入，需随发现补充。
4. **resolved 基于词表快照**：L1 词表物化是日 job（`custom:tuQ06mlxBe_2TlTo`），新建指标当天可能仍显示未解决（与 W3 台账同款 #300 边界）。
5. **stuck 证据是附注不是判据**：旧堆重复率高，只取会话窗口内最新 rule_ver，不做全量统计。
6. **`unknown_tool` / `bad_param` 不进需求**：它们指向工具面，由 #741 处理；本清单不替它兜底。
