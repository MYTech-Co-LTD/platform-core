# 湖封版分区压缩（closed-partition compaction）设计

> 状态：**已定案，待实施（P0）** ｜ 2026-11-26
> 决策来源：用户 2026-11-26 确认四条（月级 / 首批三源 / 删原始文件 / 新索引表）。
> 关联：路线图 `docs/superpowers/plans/2026-11-24-data-freshness-lanes-roadmap.md` §4 P1；issue #2862 的实测证据。

## 0. 一句话

**把「已封月」的成千上万个小 parquet 合并成「一源 × 一账套 × 一月 = 一个文件」**，读侧按月腿切分。
不是聚合，不改行列，不碰口径。

## 1. 为什么（实测，2026-11-26）

| 事实 | 数值 |
|---|---|
| `business_collection_receive` 原始文件数 | **1,508** 个 parquet / 654,154 行（≈434 行/文件） |
| 全史 `count(*)`（安静时段、无并发） | **255,999 ms**（≈170ms/文件，成本主要是对象存储 GET） |
| 同 schema 的 PG 本地表 `count(*)` | 4 ms |
| 源文件数更大的 | `member_summary` **6,684** / `inventory_movement` **6,030** / `retail_order_line` **3,213** |
| 日档 `dbt build` | 329 节点、约 200 条 schema 测试，每条一次全史扫描 ⇒ 2026-11-25 02:30 那轮 90 分钟只跑完 79/329 |

已有的止血（不替代本设计）：日档超时 150 分钟（#2860/PR #2861）、schema 测试限窗 30 天（#2862/PR #2863）。

## 2. 目标 / 非目标

**目标（可判定）**
- 单源全史 `count(*)`：256s → **≤3s**
- 日档主档：40–90+ 分钟 → **≤30 分钟**
- 所有读湖作业（tick / 1h 车道 / 问数 / 审计）**同时受益**，不只是 dbt
- 行数、金额、时间边界**逐月与压缩前完全相等**（四层断言，见 §7）

**非目标**
- 不改「湖 + PG」选型；不引入 Iceberg/Delta/流式
- 不做任何聚合、去重、排序、口径变换（B11：口径只在 dbt/）
- 不动当月（活跃月）的写入与读取方式
- 不迁走零售现役的 `lake_month_index`（本设计用新表；零售后续可迁）

## 3. 不变量（破一条即停）

1. **只压已封月**（`month < 当月`）——采集只写当月/当天，零交集。
2. **不聚合**——物理合并，行列不变。
3. **不双读**——任一逻辑月只由一个腿提供。
4. **缺口与重叠都不可接受**——由索引连续性（§7 断言①）与腿边界（§5）保证。
5. **仍是 `union_by_name` 禁用**——同一次 union 的所有文件必须同列同型 ⇒ 契约 sha 进 key。
6. **原始文件在「parity + 浸泡 7 天」之前不许删**。

## 4. 物理布局与索引

```
lemeng/<source>_month/_MONTH/
    v=<contract_sha8>/system_book=<book>/month=<YYYY-MM>/all.parquet
```

- 形态照搬零售已验证的 `lemeng/retail_order_line_month/_MONTH/system_book=<book>/month=<YM>/all.parquet`。
- 注册表 `data.lake_compact_source(source, start_ym, system_books, contract_sha, enabled)`：父管线要把「源清单」与索引 join，而 workspace JSON 与 PG 无法在同一个 SQL 节点里 join（2026-11-26 实测），故用一张小表。
- 新表（**不复用** `data.lake_month_index`：零售的 conflict key 是 `(system_book, ym)`，多源需要 `source`）：

```sql
create table if not exists data.lake_compact_index (
  source        text        not null,   -- 例如 business_collection_receive
  system_book   integer     not null,
  ym            text        not null,   -- 'YYYY-MM'
  rows          bigint      not null,
  bytes         bigint,
  min_bizday    date,
  max_bizday    date,
  contract_sha  text        not null,   -- contracts 的规范 sha8
  object_key    text        not null,
  built_at      timestamptz not null default now(),
  primary key (source, system_book, ym)
);
```

**边界（读侧与写侧共用的唯一事实）**：

```sql
select max(ym) from data.lake_compact_index
 where source = :source and contract_sha = :sha;
```

## 5. 读取侧：两腿视图（每源一个）

| 腿 | 范围 | 来源 |
|---|---|---|
| 冷腿 | `ym <= boundary`，`v=<sha>` 精确匹配 | `_MONTH/**/*.parquet` |
| 活跃腿 | `bizday >= boundary 的下一个月 1 号` | 原始 glob |

- **boundary 以字面量进视图**：在 dbt 编译期用 `run_query()` 取 `boundary`，渲染成 `date 'YYYY-MM-01'`。
  为什么不写成子查询：`read_parquet` 谓词里的子查询会让 pg_duckdb 放弃文件裁剪（同族实测 >120s），
  字面量才走得到 stats 裁剪。`tables` 档每日重建视图 ⇒ boundary 每月自动前进。
- **契约漂移的失效方向是「变慢不变错」**：契约变了 ⇒ `contract_sha` 不匹配 ⇒ 冷腿自动失效、
  退回原始腿；同时 §7 断言②报红，提示重压。
- **实现形态**：手写视图（生成器不认 `_month` 前缀，零售 `vw_lemeng_retail_order_line_month` 已有先例），
  列投影逐列照抄 staging；由 `assert_serving_view_columns_match_contract` 兜列漂移。
- **开关按源**：每个源一个 `lake_compact.enabled`（放 `deploy/duckle/console/compact-sources.json`），
  关掉即回落单腿读原始，可单源回退。

## 6. 写入侧：duckle 管线（一父一子）

**源清单**（workspace 文件，父管线 `read_json_auto` 读它，随 console seed 投递）：

```json
[
  { "source": "business_collection_receive", "time_col": "bizday", "start_ym": "2024-01" },
  { "source": "member_summary",              "time_col": "bizday", "start_ym": "2024-01" }
]
```

**父管线 `lake.compact`**：算待压月清单 → `ctl.foreach`（source × ym）
- 待压 = `boundary+1 月 … 上月`（含补漏），且该月原始 glob 命中 > 0。

**子管线 `lake.compact.month`**：逐月
```
read_parquet(原始 glob, 该月谓词) → select r.*（pg_duckdb 单列 struct 必须 r.* 展开，2026-11-26 实测）
  → qa.contract（列集/类型 == 契约；不符 ⇒ 拒写）
  → ctl.die（0 行 ⇒ 拒写，绝不写空文件）
  → snk.minio  _MONTH/v=<sha>/system_book=<book>/month=<YM>/all.parquet（overwrite，幂等）
  → 校验 parity（行数 / 金额合计 / min,max bizday）
  → snk.postgres lake_compact_index upsert（**最后写**；失败则边界不前进）
```

- **调度**：CST 03:10（采集停窗），每日；正常一天压 1 个月（上月）。
- **幂等**：key 不含 run_token，覆盖写；重跑天然收敛。
- **失败语义**：任一月失败 ⇒ 不写索引 ⇒ 边界不动 ⇒ 读侧继续读原始（fail-open），下一轮重试。
- **回填**：首次逐源把 `start_ym … 上月` 各跑一遍（每源约 24 个月，每月数秒）。

## 7. 正确性：四层断言（缺一不进下一层）

| 层 | 断言 | 形式 |
|---|---|---|
| ① 索引连续性 | 每源从最早月到 boundary **无空洞** | `dbt/tests/lemeng/assert_compact_index_contiguous.sql` |
| ② 索引不陈旧 | `built_at` ≤ 2 天；`contract_sha` == 当前契约 sha | `assert_compact_index_not_stale.sql` / `_contract_current.sql` |
| ③ 视图等价 | 两腿视图 vs 原始 glob：同一月**逐日行数 + 金额**相等 | `assert_serving_view_matches_raw.sql`（零售 `assert_serving_view_matches_main` 模板） |
| ④ 业务面 | 现有 `audit_lemeng__*` 全绿 + 日档耗时达标 | 既有对账 + `data.sla_measure` |

parity 的数值比较用**容差而非全精度**（既有纪律）；行数必须**精确相等**。

## 8. 回收原始文件

- 前提：①③ 全绿 + **浸泡 7 天**。
- **双证**：索引行存在 ∧ 杀前再跑一次逐分区 parity（不引用"上周验过"）。
- GC 独立 job（每日、可 dry-run、删前打印文件数）；逐月删，不整源一把删。
- ⚠️ 删后回滚 = 重新采集该月（代价高）⇒ 浸泡期与双证不可省。

## 9. 灰度与工期

| 阶段 | 内容 | 工期 |
|---|---|---|
| **P0** | 单源 E2E：`business_collection_receive`（1,508 文件 / 654k 行 / 256s 已实测）——管线 + 索引 + 两腿视图 + 四层断言 | 3–5 天 |
| **P1** | 再上 `member_summary`(6,684) / `inventory_movement`(6,030) / `retail_order_line`(3,213) | +1 天/源 |
| **P2** | 其余 fact 源（~12 个） | +2 天 |
| **P3** | GC + 浸泡 + 台账 | +1 天 |

**P0 即可验收**：单源全史 256s → ≤3s；30 天窗口 ~20s → ~2s。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 月边界缺口 / 重叠 | 索引连续性断言；两腿边界由索引推导（不按日期猜） |
| 契约加列后冷腿缺列 | 契约 sha 进 key；不匹配 ⇒ 冷腿失效退回原始（慢但正确）+ 测试报红 |
| 压缩与读取并发 | 只压已封月；单文件 sink 按 rename 发布（duckle 0.7.4 起） |
| 源端迟到补采上月 | 每轮幂等重压 boundary 月；parity 重验；索引 `built_at` 更新 |
| 压缩写坏但索引已写 | 顺序固定：写文件 → parity → **最后**写索引 |
| 视图编译期拿不到索引（表未建） | 视图渲染时 boundary 为空 ⇒ 输出"仅活跃腿"（全量原始），并让断言②报红——失效方向仍是"慢但正确" |

## 11. 已定案的四个决定

1. **月级**压缩（不做日级）。
2. 首批三源：`business_collection_receive` / `member_summary` / `inventory_movement`。
3. 原始文件**删**（7 天浸泡 + 双证）。
4. 新表 `data.lake_compact_index`（不动零售 `lake_month_index`）。

## 12. 回滚

| 场景 | 动作 | 影响 |
|---|---|---|
| 压缩结果可疑 | `compact-sources.json` 里该源 `enabled=false` → 重建视图 → 读原始 | 单源变慢，数据正确 |
| 索引写坏 | 删该月索引行（boundary 回退）→ 视图重建 | 该月回读原始 |
| 原始文件已删且需回滚 | 重新采集该月（console 子管线按窗重跑） | 小时级，需人工 |

## 13. 落地清单（P0）

- [ ] `data.lake_compact_index` 迁移（幂等 DDL）
- [ ] `deploy/duckle/console/pipelines/lake.compact.json` + `lake.compact.month.json`
- [ ] `deploy/duckle/console/schedules/3120.json` 加排班（03:10 CST）；`compact-sources.json` 随 seed 投递
- [ ] 单源两腿视图（`stg_lemeng_business_collection_receive` 的读面）
- [ ] 四条断言 SQL + 两个诊断脚本（boundary / parity）
- [ ] 回填该源全部历史月；四层断言全绿；记录前后 `count(*)` 与日档耗时

## 14. 实施中发现（2026-11-26，真机）

P0 做到「管线落地」时撞到四条引擎形状约束（详见记忆 `duckle-lazy-views-break-ctl-die`）：

1. **以远程 sink 结尾的管线里 `ctl.die` 恒报 0 行**（所有节点都是惰性 view，`materialize: true` 也不生效）；
   同源节点放到 `snk.csv` 结尾的探针里正常。⇒ 照抄零售 `month.compact` 的**形状**时必须保留它的源形态
   （`src.postgres` + pg_duckdb pushdown），不能换成 `src.s3/src.minio`。
2. **`ctl.die` 之后不能分叉**（第二次评估看到空流）。
3. **sink 不产出表**，统计节点不能接在 sink 后面。
4. **`src.minio` 在本环境未安装**；`src.s3` 可用（17,423 行 / 0.84s）。pg_duckdb 侧 `read_parquet` 只暴露
   单列 struct（`r['col']` 要逐列名单、`r.*` 报 missing FROM-clause）。

### 结论：P0 改为「按契约生成列清单」的零售同族形态（方案 B）

- 子管线：`src.postgres`（`select r['c1']::t as c1, … from read_parquet(<月 glob>) r`，**列清单由契约生成**）
- 结构：`源 → ctl.die → snk.minio` 单链；索引另起一条管线（03:40），同样单链
- 生成器：`scripts/lemeng/gen-compact-pipelines.mjs`（读 `contracts/` 产出每源子管线 JSON）
- 现状：`lake.compact` / `lake.compact.month` 已进 console（注册表 `enabled=false`，排班是 no-op），
  索引表与源注册表已建；无生产写入、无湖对象改动

## 15. 实测结果（2026-11-26，P0 单源端到端）

| 项 | 结果 |
|---|---|
| 搬运 | `business_collection_receive` 两账套 × 24 月 = **48 个 `_MONTH` 文件**，两轮共 93s |
| 记账 | 48 行索引全部 `status=ok`（24.6s） |
| 单月 parity | 3120/2024-11：16,360 = 16,360；64188/2024-11：8,614 = 8,614 |
| 全史 parity | 冷腿 635,632 + 当月原始 19,297 = **654,929 = 原始**（逐行精确） |
| 读速 | 原始单腿 **275.4s** → 两腿 **21.9s**（模型内实测），线上视图 `count(*)` **22.1s** |
| 视图 | `dbt run --select stg_lemeng_business_collection_receive` → CREATE VIEW 0.15s；viewdef 含 `_MONTH` 与 `bizday=2026-11-` 两条腿 |

**实施要点（都被实测推翻过一版）**：
1. 活跃腿必须**按月裁路径**（`bizday=<tail>-*/all.parquet`）；只加下界谓词 ⇒ DuckDB 仍打开全部 footer，无收益。
2. 边界在**编译期**（`compact_state` 的 `run_query`）渲染成字面量；子查询会废掉文件裁剪。
3. 边界次月由索引最大 `ok` 月推导（`tail_prefix`），索引不可用则整段冷腿不渲染（退化为慢但正确）。

**已做**：§7 ③ 的**常驻版**——断言 ㉓ `compact_parity`（`data.warehouse_assertions --group heavy`，每 30 分钟）：每源只核**边界月**（max(ym)）月文件 vs 原始行数**精确相等**，原始 glob 直接用索引里的 `input_pattern`（与产出该月时的输入逐字相同）；判不了给 `UNKNOWN` 而不是通过。

**尚未做**：§7 其余三条（索引连续 / 不陈旧+契约当前 / audit）、其余源的推广、原始文件 GC。

---

## 16. 推广清单（每源照做，2026-11-27 立）

> 管线与记账是**数据驱动**的（父管线只读 `data.lake_compact_source`），所以「加一个源」= 配置 + 读面 + 取证三步。
> **顺序不可颠倒**：先让文件产出并对上 parity，再翻读面。翻早了 = 读面静默少数据（#2666 的教训）。

| 步 | 动作 | 判据（缺失即停） |
|---|---|---|
| 0 | 选源并确认前缀：`dbt_project.yml` 的 `lemeng_<source>_prefix` 必须与契约 `layout.prefix` 一致 | `grep` 两处相等 |
| 1 | 算契约 sha8：`shasum -a 256 contracts/common/lemeng.<source>.json \| cut -c1-8` | 与 P0 行同法（`business_collection_receive` = `8b6b3529`） |
| 2 | 插 `data.lake_compact_source(source, start_ym, system_books, contract_sha, enabled=true, note)` | `start_ym` 取该源湖里**最早**有数据的月；`system_books` 取实际有数据的账套 |
| 3 | 跑 console 管线 `lemeng.lake.compact`（父管线按待办月派发，limit 120） | 输出逐月 `ok`；失败的月**不进索引** |
| 4 | 跑 `data.lake_compact_index`（或等 CST 03:40） | `data.lake_compact_index` 里该源 `status='ok'` 的月连续、`max(ym)` = 上一个自然月 |
| 5 | **parity**：逐 `(账套, 月)` 比「月文件行数」vs「原始日文件行数」 | **逐月必须完全相等**；不等即停（#2666 是「已并入但不完整」的反例） |
| 6 | 改 staging 视图为两腿（`compact_state('<source>')` + 冷腿 `_MONTH/v=<sha>` + 活跃腿 `bizday=<tail>-*/` + `>= boundary`） | 视图**未启用时**退化为单腿读原始（`cs.enabled=false` 分支必须存在） |
| 7 | `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` + `gen-data-projection --check` | 两个门禁绿 |
| 8 | 翻读面后复核：同一查询翻前/翻后行数与金额相等 | 差一行都不翻 |

**源顺序（按风险）**：
1. `member_summary`（日快照，无热层，最安全）；
2. `inventory_movement`（日增量明细）；
3. `retail_order_line`（**最后**：它同时有热层三腿与 10m 车道，压缩腿与热腿的边界要单独验）。
