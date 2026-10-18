# 战区维物化：`dim_region` 权威 + 门店维带战区标签

> 2026-10-18。上位：#883（本文是它的计划稿）。由来：#867（回包贴战区名/一级战区，#869 已上线）
> 上线后暴露「战区属性只活在回包层 + 一级是推的 + 没有哨兵」三件事。

## 0. 现状（实测，不是推的）

| 事实 | 出处 |
|---|---|
| 湖上「门店档案」`lemeng/dim_branch` 是**采集快照**，列由契约 `contracts/common/lemeng.branch.json` 的 `expr` 生成（`scripts/…/gen-data-projection.mjs` 出投影）；**只有 `region_id`，无名称** | 契约 + `stg_lemeng_branch.sql` 头注 |
| 乐檬 `branch.find` **只回 `region_id`**，**不回** `region_name` ⇒ 名称不是源生字段 | 2026-10-17 实测（#883 正文） |
| 战区名/一级只活在 `x01_region_names` seed（27 行），**唯一消费方 = 回包层** `modules/data/domain/dimension-labels.ts` | grep 全仓 |
| `region_l1` 现为**「去序号推导」**（东部三区 → `东部`），与 UI 树（`东部战区`）不一致；广西大区 / 贵州宣威大区 / 其余门店1 被当「无一级」 | `dbt/seeds/x01_region_names.csv` + `schema.yml` |
| 仓里已有同类先例 `dim_brand` seed：**小受控维走 seed、消费方 join**，且明确「事实表只存键，名称在展示层解析」 | `dbt/seeds/schema.yml:108`；`dim_brand` 在 dbt 里**零引用** |
| marts 层的 `dim_*` 是**门禁预期形态**（「含 `fct_*` 与将来的 `dim_*`——主数据维度表同样按租户物化」） | `scripts/check-data-models.mjs:149` |

## 1. 裁决（2026-10-18，用户）

**物化进「门店维」（dbt 侧），供所有数据源消费** —— 不是塞进湖上的采集快照。

| 落点 | 裁决 | 理由 |
|---|---|---|
| 湖 `lemeng/dim_branch` | **不加列** | raw 层是**契约驱动的采集快照**；`region_name` 不是源给的 ⇒ 塞进去 = 混 git 受控配置进不可变快照 + 要重生成 data-plane lock + 采集管线得在 dbt 之前读 seed；且每天 ×400 行重复，收益只是省一次 27 行维的 join。 |
| `dim_region`（seed） | **权威** | 战区名/一级是**战区的属性**，不是门店的属性。与 `dim_brand` 同形（git 受控 CSV）。 |
| `dim_lemeng_branch`（marts） | **带标签** | 每个源本来就靠门店档案解析 `region_id`；标签跟着一起给 ⇒ **所有源免 join 即得**，且一级战区可作 group by 键。 |

**为什么不只建 `dim_region`**：「按一级战区汇总」必须发生在**聚合处**——回包层贴标签是**行级展示**，
汇不出来。标签落到维上，消费方才能 `group by region_l1`。

**为什么不叫 `dim_branch`**：`dim_branch` 在本仓**已专指湖上快照路径**（`lemeng/dim_branch`，
文档里出现十余处）。marts 模型复用这个名字会让「dim_branch 最新快照」这类句子失去所指
⇒ 取名 `dim_lemeng_branch`（对齐它的父模型 `stg_lemeng_branch`）。

## 2. 改动清单

| # | 动什么 | 为什么 / 守卫 |
|---|---|---|
| 1 | `dbt/seeds/x01_region_names.csv` → **`dbt/seeds/dim_region.csv`** | 升格为维（`x01_` 前缀 = 客户输入台账，战区名是**自力枚举**所得，名不副实）。`region_l1` 改**受控真值**；加 `level`（0 根 / 1 一级本身 / 2 二级，由 `region_l1` 完全决定，见 §3）。 |
| 2 | 新增 `dbt/models/lemeng/marts/dim_lemeng_branch.sql` | `stg_lemeng_branch` ⨝ `dim_region`；粒度不变 `(system_book, snapshot, branch_num)`；含 `{{ subject_org() }} as org`（门禁规则 ⑩）。 |
| 3 | `dbt/models/lemeng/marts/schema.yml` 加 `dim_lemeng_branch` 条目 | 列描述 + 粒度测试 + **未登记 region_id 的 warn 哨兵**。 |
| 4 | 新增 `dbt/tests/lemeng/assert_dim_lemeng_branch_key_unique.sql` | 覆盖写幂等的护栏（同 `assert_stg_lemeng_branch_key_unique.sql`，键含两个分区键）。 |
| 5 | `dbt/seeds/schema.yml` 更新 | seed 改名 + 描述 + 头注里「27 行」那段的落点。 |
| 6 | `modules/data/domain/dimension-labels.ts` | `x01_region_names` → `dim_region`；`decorateWithLabels` **跳过已存在的标签列**（防与物化列重名 ⇒ 结果集出现两个 `region_name`）。 |
| 7 | `modules/data/domain/dimension-labels.test.ts` | 跟随改名 + 新增「已存在标签列不重复插入」用例。 |
| 8 | `deploy/data-plane.lock` | 重生成：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（seed 改名 = 清单树变了）。 |
| 9 | 文档登记 | `dbt/README.md`（seed 小节）、`deploy/data-plane-deploy-sop.md`（三 seed 行数那句）。 |

## 3. `region_l1` 的真值（**待用户眼校**，见 §5）

现状 = 去序号推导；真值按 UI 树 + 客户文档「四向独立归属，排除其他门店/贵州宣威大区/广西大区」：

| 二级（`region_name`） | `region_l1` | `level` |
|---|---|---|
| 东部一区 / 二区 / 三区 / 四区 | `东部战区` | 2 |
| 中部一区 / 二区 / 三区 | `中部战区` | 2 |
| 南部一区 / 二区 / 三区 / 四区 | `南部战区` | 2 |
| 西部一区 / 二区 | `西部战区` | 2 |
| 广西大区 / 贵州宣威大区 / 其余门店1 / 其他门店 | **自成一档**（同名） | 1 |
| 所有区域 | 空（**根**，非一级） | 0 |

`level` 由 `region_l1` **完全决定**（`null→0` / `=region_name→1` / 否则 `→2`），不是独立事实；
加它只为让消费方不必重推这条规则（推错了会静默把大区当二级）。一致性由
`dbt/tests/lemeng/assert_dim_region_level_matches_l1.sql` 钉住（已做**变异确认**：
两个方向各改一行，断言都真的变红）。

> 这条是**业务数据**：取值来自用户截图那棵树（2026-10-17 会话读取）与客户文档的排除声明。
> 不进浏览器抓取（会话态不可作维度源），按「受控配置」维护；改值走 PR。

## 4. 验收

1. **对得上**：门店维 `region_name` / `region_l1` 的**非空率 ≥ `region_id` 非空率**（不是「行数涨了、值全空」）。
2. **能汇总**：`region_l1` 可作 group by 键 ⇒ 「按东部战区汇总」成立。
3. **哨兵活**：人为塞一个假 `region_id` 进去 ⇒ **当日** dbt warn 触发，且**物化照常成功**（warn 不阻断）。

## 5. 真机验收结果（2026-10-18，山海四步链）

合并 `c5007686`（PR #886）后按 SOP 四步链执行，**四步全过**：

| 步 | 结果 |
|---|---|
| ① 同步检出台 | `SYNC_OK 209/209`、**无 DRIFT**；**带 `--prune`** ⇒ 改名后的旧 `x01_region_names.csv` 已从检出清掉（不带它就是 #683 那种「僵尸 seed 永生」） |
| ② 物化 | `PASS=303 WARN=0 ERROR=0 SKIP=0 TOTAL=303` → **`MATERIALIZE_OK`**（5 seeds / 33 models / 265 tests） |
| ③ 主项目部署 | `dep_9HxT5JhVmpT0b7G-` → **ready**（build 254s）；`server`/`postgres`/`openclaw` 全 healthy；**无 open incident** |
| ④ 产物 | 容器内 `dimension-labels.ts` 的 sha256 **逐字节等于**仓内 `c5007686` 那份（`ad05a1f6…`）——不靠 HTTP 探活 |

**仓库侧判据**：

- 门店维最新快照 400 行：`region_id` / `region_name` **各 400 非空**（100%），`region_l1` 398
  （缺的 2 行 = 根「所有区域」，`level=0`，**按设计为空**）。
- 未登记 `region_id`：**空** ⇒ 哨兵**零命中**。
- 运行时通路：用 app 自己的连接串、**不带 schema** 查 `dim_region` / `dim_lemeng_branch` 均通
  （`search_path=staging, public`）；`dim_lemeng_branch` 9196 行全部有 `region_name`。
- 哨兵**变异确认**（真数据、非侵入：把某店 `region_id` 抬成 `921278`）⇒ 查询**立刻吐出该 id**。

> ⚠️ **本条被真机证伪，文档已订正**：立项时按「枚举接口实测有门店无行」外推的
> 「`dim_region` 覆盖可能不全 ⇒ 首次真机跑大概率报未登记战区」**不成立**——那些无行的门店，
> 其 `region_id` 仍在已枚举集合里。已同步订正 `dbt/README` §8、`warn_region_unregistered.sql`
> 头注、`handbook §1.5.3` 三处。

## 6. 待办 / 边界

- **`region_l1` 真值需人眼校**（§3）——业务可见值，错了要改 CSV。
- **哨兵是 warn 不是 error**：按裁决「新区不影响存量指标的正确性」⇒ 只告警。dbt warn 不进
  `ERROR=` 计数，`materialize.sh` 的域成败判定不受影响（本仓**首次**引入 `severity: warn`）。
- **哨兵的告警面仍未接线**（登记在 `handbook §1.5.3` Phase 1 + #538）：dbt 的 `WARN=` 在本仓
  没有任何消费方，现在只进物化 job 日志。
- **后续（另行立项）**：向乐檬申请 `nhsoft.user.ai.branch.region.find` 加 PAT 白名单 ⇒
  建 `dim.region.l0` 日更（`parent_id` 给层级、含**空战区**）；一级 rollup 的 mart 列。
  ~~山海侧同步~~ **已于 2026-10-18 完成**（见 §5）。
