# Wave 7 V2a · 业务监控 threshold 判据 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让「某指标达到阈值」成为一条可挂的监控：窗口聚合值按 `operator ∈ {gt,gte,lt,lte,eq}` 与阈值比较，命中时走 V1 的状态机与影子期投递。

**Architecture:** 不新增执行路径。阈值求值复用 `authorize(...)` 给出的 `plan.totalSql`（与查询面同一编译/合并语义），在仓库只读执行器上跑一次；拿不到合计（比率/去重类不可加指标）⇒ `unknown:not_additive`，**不猜口径、不用明细行求和**。状态机、冷却、`dry_run`、事件与收件人全部沿用 V1。

**Tech Stack:** TypeScript / pg_duckdb / vitest；零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-business-monitor-design.md` §6/§15。**issue #2291**。V1：issue #2278 / PR #2283。

## Global Constraints

- **不引入表达式 DSL**：`operator` 与 `threshold` 是列（V1 迁移已建），闭集校验，拒绝任意 SQL。
- **判不了 ≠ 没问题**：无 `totalSql`、合计为 null、非有限数值 ⇒ `unknown`（不是 firing、不是 missing）。
- **影子期仍然默认开**：创建恒 `dry_run=true`；`dry_run` 下不产生任何 notify 事件。
- **可加性前置**：创建期用词表 `totalable` 拒绝非可加指标（400 `MONITOR_METRIC_NOT_ADDITIVE`）；求值期再兜一次 unknown。
- 迁移：**无新增**（`operator`/`threshold` 在 053 已建）。
- 测试夹具沿用 `montest-*` / `org-mon*`；空库可绿。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/domain/monitor-spec.ts` | 放行 `threshold`，校验 operator/threshold |
| `modules/data/domain/monitor-store.ts` | 落 `operator`/`threshold` 两列、读出到 `MonitorRow` |
| `modules/data/domain/monitor-eval.ts` | threshold 求值（totalSql → 数值 → 比较） |
| `modules/data/routes/monitors.ts` | 创建期可加性校验 + 透传两列 |
| `modules/data/console/reports/MonitorModal.tsx` | 判据多一个「阈值」+ 算子/阈值输入 |
| `modules/data/domain/monitor-eval.test.ts` | 五算子真值表 + unknown 分支 |

---

### Task 1: 闭集校验与存储列

**Files:** Modify `monitor-spec.ts`、`monitor-store.ts`；Test `monitor-store.test.ts`。

- `NewMonitorInput` 增 `operator?: 'gt'|'gte'|'lt'|'lte'|'eq'`、`threshold?: number`。
- `validateNewMonitor`：
  - `verdict='threshold'` ⇒ `operator` 必选且属闭集、`threshold` 必须是有限数（`Number.isFinite`），否则 `MONITOR_VERDICT_UNSUPPORTED`（沿用既有码，detail 说明缺什么）。
  - `missing`/`stale` 忽略两个字段（归一成 `null`）。
- `createMonitor` 的 INSERT 补 `operator, threshold`；`MONITOR_COLUMNS` 与 `MonitorRow` 增 `operator`/`threshold`。

- [ ] 失败测试：threshold 缺 operator / 缺 threshold / NaN ⇒ 拒绝；缺 missing 正常；建行后读回两列值。
- [ ] RED → GREEN → 提交 `feat(data): 监控 threshold 校验与存储（W7-V2a）`。

---

### Task 2: 求值与路由

**Files:** Modify `monitor-eval.ts`、`routes/monitors.ts`；Test `monitor-eval.test.ts`、`routes/monitors.test.ts`。

**求值（`evaluateMonitor` 的 threshold 分支）：**

1. 目标解析与词表加载同 V1；目标 metric 必须存在。
2. `authorize(catalog, monitorRequester(org, createdBy), metricId, args, catalog)`；
   - `auth.ok === false` ⇒ `unknown:authz:<reason>`；
   - `auth.plan.totalSql` 缺席 ⇒ `unknown:not_additive`（可加性由词表 `totalable` 决定，plan 是唯一事实）。
3. 执行 `totalSql`（仓库只读执行器），取第一行第一列：
   - null / 非有限数 ⇒ `unknown:threshold_value_unavailable`；
   - `compare(value, operator, threshold)` 为真 ⇒ `{ verdict: 'threshold', value }`，否则 `{ verdict: 'ok' }`。
4. 比较用**数值**（pg numeric 常回字符串）；`eq` 用严格相等（阈值是十进制字面量，不做容差——容差属于对账面，不属于告警面）。

**路由：** 透传 `operator`/`threshold`；创建期若 `verdict='threshold'` 且词表行 `totalable !== true` ⇒ `400 MONITOR_METRIC_NOT_ADDITIVE`。

- [ ] 失败测试：五算子真值表（含边界相等）；无 totalSql ⇒ unknown；合计 null ⇒ unknown；非可加指标创建 ⇒ 400。
- [ ] RED → GREEN → 提交 `feat(data): threshold 求值与创建闸门（W7-V2a）`。

---

### Task 3: 「挂监控」入口放开阈值

**Files:** Modify `MonitorModal.tsx`。

- 判据下拉增加「阈值越界」；选中后出现算子（`>` `>=` `<` `<=` `=`）与阈值输入（数值）。
- 提交 body 带 `operator`/`threshold`；错误码 `MONITOR_METRIC_NOT_ADDITIVE` 用人话提示「该指标不可加，暂不支持阈值」。
- 仍标注「默认影子期」。

- [ ] 前端自验：本地 dev-stack 报表页建一条阈值监控（可加指标），确认 201 与影子期提示。
- [ ] 提交 `feat(data): 挂监控入口支持阈值（W7-V2a）`。

---

### Task 4: 全量验证 + 部署核验

- [ ] `pnpm --filter data test`、`pnpm --filter notify test`、`pnpm run test:guard`、`pnpm run typecheck`、三个 check 脚本全绿。
- [ ] PR `Closes #2291`；CI CLEAN 后合并、两实例部署（mytech 自动 / 山海手动）。
- [ ] 容器核验：`data.monitor` 两列在位；建一条**影子阈值**监控（山海可加指标），等一个 tick，确认 `monitor_run.value` 非空、`notified=false`、`notify.event` 无新增。
- [ ] 台账：路线图 §7 追加行（阈值已开放、影子期）。

## Self-Review

- **spec 覆盖**：§6 threshold 判定与 V1 §13 的「判不了」原则；§15 V2 的 threshold 项。
- **不做**：`no_flap`、组织级限流、外发通道（V2b）；比率类指标的阈值（需要分子/分母设计）。
- **风险**：`totalSql` 对可加指标有自动伴随逻辑（`args.total` 显式模式不附）——求值不传 `total:true`，让 `plan.totalSql` 在场；若未来查询面调整该字段语义，本处测试会先红。
