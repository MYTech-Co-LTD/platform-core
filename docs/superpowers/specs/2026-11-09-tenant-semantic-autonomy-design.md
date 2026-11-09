# 租户语义自治（新建声明 + 覆盖平台口径）——设计

> 状态：2026-11-09 用户拍板「租户可以写，每家租户情况不一样」。
> 结论先行：**租户写自己 org 的声明（新建 + 覆盖），即时生效，不走 PR、不部署**；平台 L1 仍是共享底座，
> 本轮**不改** L1 同步 job，也不做平台 L1 的运行时直写（那是另一条线，另案）。
> 前置实测：`docs/superpowers/notes/2026-11-09-tenant-write-feasibility.md`（读路径每请求查库、
> 同一套校验器可复用、`EXPLAIN` 可做写前 SQL 校验、现行 loader 会丢弃同 id 的 L2 行）。

## §1 目标与非目标

**目标**：每家租户能独立定义/调整自己的指标口径，**零等待生效**，且不同租户互不影响、可审计、可回滚。

**非目标**（本轮不做，避免返工）：
- 平台 L1（`org='platform'`）的运行时直写与「仓库回收」对账 job——租户行不需要它；
- 自由 SQL：租户只能提交**声明**，SQL 由唯一编译器生成；
- 跨租户共享租户指标（租户声明只在本 org 可见）；
- 租户声明的 repo 化（租户数据留在库与备份里，不进 git）。

## §2 数据模型

新增两列（迁移，幂等）：

| 列 | 类型 | 语义 |
|---|---|---|
| `declaration` | `jsonb NULL` | 声明原文（YAML 条目等价物）。L1 sync 行的该列为 NULL；租户声明必填。用于编辑回显、审计与重建 |
| `override_of` | `text NULL` | 非空 = 本行是该 org 对 `<id>` 的**口径覆盖**；值为被覆盖的平台 L1 id（与 `id` 相同） |

`basis` 新增取值 `'declared'`（租户全额声明，与 L1 同表达力）；既有 `l1_tree` / `column_agg` 不变。

行形状：`org = <租户 org>`、`source = 'l2'`、`basis = 'declared'`、`certified = 'draft'`。
**不写** `org='platform'`。

## §3 读侧优先级（唯一改动点）

`loadMergedCatalog`（消费面唯一加载器）现行规则「L2 撞 L1 的 id ⇒ 丢弃 L2」。改为：

1. 本 org 存在 `source='l2' and override_of = <l1 id>` 的行 ⇒ **该 org 用覆盖行，L1 行不出现在合并结果**；
2. 其余同 id 的 L2 行（`override_of IS NULL`）仍按现行规则丢弃（保留「普通 L2 不得顶掉 L1」的安全面）；
3. 覆盖行本身走 `visibleMetrics` 的 `required_scope` / 源裁剪，掩码与行域与普通指标同一条执法链。

四条消费通道（`GET /metrics`、`POST /query`、MCP `tools/list`、chat/agent-loop）**全部**经此加载器，
不新增第二份合并逻辑（`catalog-consumers.test.ts` 的来源守卫继续钉住）。

## §4 写侧

两条独立入口（管理面 `data:manage`，写总闸 `DATA_MCP_ALLOW_MUTATING`）：

| 入口 | 行为 | 生效 |
|---|---|---|
| `upsert_metric_declaration` | **新建**租户声明（id 不得与 L1 冲突；冲突仍 409 `ID_RESERVED_BY_L1`） | 即时（`certified='draft'`，与 D6「新建不撞现有数字」一致） |
| `override_metric_caliber` | 对**已存在** L1 id 建/改本 org 覆盖行（`override_of = id`） | **草稿 → 管理员确认 → 生效**（D6：修改已生效口径不得静默生效） |

### 4.1 写前校验（同步、fail-closed，任一不过即拒写）

1. **声明形状**：复用 `declarationsFromYaml` / `checkMetricDeclaration` 同一把尺（owner、tier、grain、
   definition、expression/ratio、source、freshness_sla_days 必填）。
2. **表达式**：`parseL1Select`（禁自由 SQL）；`deriveRelation` 得到的 relation ∈ **L1 已用 relation 集合**
   （B11，租户不得引用未纳管表）。
3. **列存在**：relation 的列必须在 `information_schema.columns`（运行时清单，不用契约列）。
4. **敏感面**：`reads`（契约列全名数组）**必填**；命中的契约列在 contracts 里 `sensitivity !== 'none'`
   且声明没有按列掩码 ⇒ 自动加默认整值掩码（`data:precise`，与 L1 sync `applyDefaultMaskTier` 同规则）。
   运行期列级掩码仍按「全词表按列传播」（`effectiveMasks`）兜底。
5. **可执行**：warehouse 可用时对 `select_sql` 跑 `EXPLAIN`（不扫数据）；失败即拒写。
6. **粒度**：`grain` 非空；`override` 的 grain 必须与平台 L1 行**同形**（否则覆盖后合计/下钻语义断裂）。
7. **不准降门**：覆盖的 `required_scope` 不得宽于/不同于 L1 行的 `required_scope`（L1 有码 ⇒ 覆盖必须同码）。

### 4.2 审计与回滚

- 每次写入与 `metric_audit` 同事务（`action = create/update`，快照含 `declaration`）。
- `version` 单调 + 更新带 `where version = $expected`（agent 并发写时乐观冲突，拒写而非后写者胜）。
- 回滚 = 用上一版快照重新写入（同一校验链），审计留痕。

## §5 回答面标注

查询结果新增 `override: true`（覆盖行）与既有 `caliber`/`basis`；`describe_metric`/`list_metrics` 同。
bot 的回答必须显式说「**本租户口径**（覆盖平台默认）」，不得把覆盖后的数字当作平台口径报。
SKILL 措辞与 toolface 序列化随实现更新。

## §6 分期

| 期 | 内容 | 出口判据 |
|---|---|---|
| P0 | 迁移两列 + loader 优先级 + 覆盖标记 + `catalog-consumers` 测试改判 | 同 id 覆盖行在本 org 胜出、他 org 不受影响；普通 L2 撞名仍丢 |
| P1 | 编译器抽取（`modules/data/domain/l1-declarations.ts`）+ `upsert_metric_declaration` + 六道校验 + EXPLAIN | 真机：新建声明即时出现在 `tools/list` 与 `/query`，坏声明全拒 |
| P2 | `override_metric_caliber` + 草稿/确认 + 回答标注 | 真机：覆盖 `retail:sales` 后本租户问数用新口径且标注；还原后恢复 |
| P3 | console 编辑面（可选）+ 双租户隔离验收 | 双 org 同 id 覆盖互不影响 |

## §7 验收（真机）

1. 租户 A 新建 `tenant:test:metric`（`sum(case…)`）⇒ `/query` 即时出数，无需部署；租户 B 不可见。
2. 租户 A 覆盖 `lemeng:retail:sales` 的 expression ⇒ A 的问数用新值且带「本租户口径」；B 仍用平台值。
3. 坏声明（缺 owner / 引用未纳管 relation / 敏感列无 mask / EXPLAIN 失败）逐条拒写并回原因。
4. 写入审计可查、回滚后数字还原。
5. `catalog-consumers` 四通道一致性仍绿；`check-tenant-isolation` 绿。

## §8 已知边界

- 租户声明不随仓库发版，灾难恢复依赖平台库备份（租户数据同等级）。
- 覆盖只作用于**本 org**；平台 L1 的全局口径仍由平台维护。
- `declared` 表达式受 L1 relation 白名单约束；需要新 mart 时仍走平台开发。
- 不提供跨租户共享/发布租户指标（发布到平台 = 另案）。
