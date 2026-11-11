# 平台开发地图（v2）：全系统体检 + 波次

> **本文件是当前开发主线的唯一导航面。** 开工前先读 §3 台账；AMD 指标路线见图
> `2026-11-04-auto-metric-derivation-roadmap.md`（W0–W8 已完成/观察中），不在此。
>
> v1（2026-11-11 上午）只按 Helix 借鉴清单排期；v2 基于**全系统四路盘点**
> （数据面 / 应用权限 / 信任治理 / 运行观测）重排：**按「上线风险 × 不可逆性」排序**，
> Helix 清单只是输入之一。

---

## §1 定位

- 我们当前的主要矛盾不是「缺新能力」，而是**「以为有的东西其实没有 / 有了但不安全」**：
  血缘生产恒 unknown、evidence 三字段写死 unknown、数据范围有绕过面、连接池无上限、缓存可能返回旧数。
- 所以 v2 的优先级：**先让系统「说的和做的一致」，再谈新能力。**

---

## §2 系统实况（2026-11-11 盘点，证据为文件:行号）

| 层 | 规模 | 关键事实 |
|---|---|---|
| 应用 | 5 模块 / 43 宿主路由 / 148 模块路由 / 20 权限码 | 「声明即授权」fail-closed 扎实；**路由集合双向核对只在启动时**（`loader.ts:289-333`），CI 不查 |
| 权限 | 部门门 + 数据范围 RBAC | 部门门只覆盖报表资产（`asset-auth.ts`）；`DATA_SCOPE_MODE` 默认 off（`scope.ts:39-45`）；**detail/explore 不裁**（`drill.ts:185-186`） |
| 数据面 | 62 模型（table18/inc18/view26）、131 测试、118 管线、66 排班、56 指标 | 仅 16 certified；12/26 staging 无键唯一测试；6/31 marts 无测试；forms 域 0 测试 0 指标 |
| 契约 | 27 份（24×v1） | `consumerVersion` CI 有；**元 schema 无人校验**；README 与门禁漂移 |
| 信任 | provenance/evidence/verified/candidates | detail provenance 可用；query_metric 无 provenance；explore/recipe 无 auditId；evidence 的 dataAsOf/freshness/reconcile **写死 unknown**（`recipes.ts:130-138`） |
| 血缘 | get_lineage / get_quality | **生产恒 unknown**：`DATA_DBT_MANIFEST_PATH` 未设、容器未挂载（实测） |
| 运行 | 3 池 / 18 探针 / 13 规则 | **池无 max**（默认 10 × 1.5GB vs 4g）；审计无 latency/path/cache；advisory 不翻 rc；桥 12h 冷却 |

---

## §3 台账（每完成一项更新：状态 / 证据 / PR / 实测）

### 已完成（含证据，别重做）

| 项 | 证据 |
|---|---|
| 明细执行层：封版 manifest / 监控 ⑯⑰ / 月文件 / 月感知视图 / 历史视图 / 结果缓存 | 30 天明细 7.8s→0.7s（热），重复查询 <10ms；两实例已上线 |
| 行级证据链 S0–S3（detail/explore/recipe provenance、detailAvailable、锚点语义、共享类型） | `provenance.ts`、`drill.ts`、`toolbox/*` |
| 数据范围 RBAC 表/端点/UI/预检 | `042/043` 迁移、`routes/scopes.ts`、`scripts/scope-preflight.mjs` |
| Helix 借鉴线 v1 地图 | PR #1949 |

### 待办（Wave 见 §4）

| 项 | 现状证据 | 波次 |
|---|---|---|
| 池无 max / 无并发闸 | `warehouse.ts:25,67`（无 max）；1.5GB×N vs 4g | **0.1** |
| 缓存无数据版本；TTL=0 关不掉 | `result-cache.ts:30,37-40`；`Number('0')\|\|60000` | **0.2** |
| 数据范围绕过 detail/explore | `drill.ts:185-186`；`explore-exec.ts` 无 scope | **0.3** |
| 双算告警不翻 rc + 桥 12h 冷却 | `wire-warehouse.sh:587`；`oo-notify-bridge.sh:135-159` | **0.4** |
| manifest 未投递（血缘/质量恒 unknown） | env 未设、无挂载（实测）；`.env.example:167` 空值 | **1.1** |
| evidence 三字段写死 unknown | `recipes.ts:130-138` | **1.2** |
| query_metric 无 provenance；explore/recipe 无 auditId | `toolbox/query.ts:107-144`；`explore.ts:49-54` | **1.3** |
| 回归/候选 job 未入仓；候选无 list/reject/调度 | `deploy/` 零命中；`private-measures.ts:190,227,297` | **1.4** |
| 测试覆盖不均（12 staging / 6 marts / schema.yml） | 见 §2 | 2.1 |
| 契约元 schema 未校验 + 文档漂移 + 版本门 | `contracts/README.md:101,112`；`contract.ts:33-36` 无校验 | 2.2 |
| OO registry 与文档不一致；forms 事件无模板 | `oo-alert-registry.txt:15-28`；`builtin.ts:10-57` | 2.3 |
| 列级血缘 | dbt core manifest 无列级边 | 2.4（触发式） |
| history view 双 config；materialize 未知档落 full；cron 文档冲突；14 脚本不在 lock；detail 走可写池 | 盘点发现 | 3 |

---

## §4 波次（按「上线风险 × 不可逆性」）

### Wave 0 · 上线前（必须）
- **0.1 资源与准入**：`pool.max` 按内存预算 + 明细并发闸/排队 + 超时可配；验收：3 并发明细 0 reset。
- **0.2 缓存正确性**：键含数据版本（`max(sealed_at)` + `month.built_at`）；`TTL=0` 真关闭；审计记 `cached`。
- **0.3 权限收口**：detail/explore 接 `scopePlan`；做不到就明确「enforce 只覆盖聚合」并在 UI/契约标注。
- **0.4 告警有效性**：⑯ 升 hard 或独立规则；取消 ⑯ 的 12h 冷却；OO registry 与文档对齐。

### Wave 1 · 信任链补真（不补就是「看起来有」）
- **1.1 manifest 投递** → lineage/quality/query_metric.lineage 可用。
- **1.2 evidence 真值**（接不上就删字段，不留假证据）。
- **1.3 provenance 补齐**（query_metric + auditId）。
- **1.4 回归/候选接线**（job 入仓、候选 list/reject、生成调度）。

### Wave 2 · 质量与治理
- 2.1 测试补齐；2.2 契约元 schema + 版本门 + 文档漂移；2.3 OO/forms 事件；2.4 列级血缘（触发式）。

### Wave 3 · 工程卫生
- history view 双 config、materialize 档位校验、cron 文档、lock 覆盖、detail 只读池。

---

## §5 防漂移规则

1. 开工前读 §3；台账说已完成的，回去看证据再决定要不要动。
2. 完成一项才更新台账（状态/证据/PR/实测）；**没证据不翻绿**。
3. 新想法进 §6 候选池；插队必须改本文件并说明理由。
4. 排序规则：**上线风险 × 不可逆性**，不按任何参考产品的清单顺序。
5. 不做：图数据库当主存储、LLM ontology 替代指标层、拆 8 服务、为多版本给每条明细打 load id、单写者模型。

---

## §6 候选池

- （空）

---

## §7 变更记录（append-only）

| 日期 | 变更 | 理由 |
|---|---|---|
| 2026-11-11 | v1：Helix 借鉴线地图（六项 P0/P1/P2） | 回顾 2026-11-06 方案 |
| 2026-11-11 | **v2：改为全系统开发地图**，Wave 0 新增资源准入/缓存正确性/权限收口/告警有效性；Helix 六项映射进 Wave 1–2 | 四路盘点发现「以为有其实没有 / 有了但不安全」，按上线风险重排 |
