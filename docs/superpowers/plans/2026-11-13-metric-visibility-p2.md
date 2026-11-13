# 指标语义治理 P2（指标可见性）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 归属部门的指标只对「部门链 ∪ 显式共享」内的人可见——列表与按 id 查询共用同一判定，兄弟部门按 id 也拿不到（404-no-probe）。

**Architecture:** 取证结论（2026-11-13）：`visibleMetrics`（authz.ts:254）已是全系统唯一咽喉——query-service/drill/explore/discovery/search/MCP query_metric/recipes/health/agent-loop 全部「先过滤再 `catalog.find(id)`」，**按 id 拦截与不可见=未声明（no-probe）是既有契约**。P2 = 一个部门上下文加载器 + 一个纯谓词 + 咽喉扩一个可选参数 + 六处调用点接线。reveal 的**消费**（报表整表拒/面板降级）归 P5 渲染闸，本波只保证列已在（P1 已落）。

**Tech Stack:** TypeScript / pg / vitest。不新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §8（§8.1 可见规则 / §8.2 与既有权限 AND / §8.3 执法点）。
**前置（spec §17.1）：组织架构一致性检查不过检，本波只合检查项、不合法案。**

## Global Constraints

- **单一实现**：部门可见判定只进 `metric-visibility.ts` 的纯谓词；`visibleMetrics` 只调它，别处不得自写（静态断言钉住）。
- **fail-closed**：观看者无部门信息 ⇒ 只能看 `owner_dept` 为空的指标；`owner_dept` 为空 ⇒ 全租户（行为与今天逐字节相同——现网 57 行 owner_dept 全空，本波上线后生产行为必须零变化）。
- 与既有权限是 AND：`required_scope` ∧ 已接入源 ∧ 部门可见，三者都在 `visibleMetrics` 内判，顺序不变。
- `visible_depts`（P1 列）= 显式共享，命中 viewer 的**直属**部门即放行（兄弟开门的唯一途径）。
- 测试隔离 `org-p2-vis-*`；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。
- 装载期双向核对、Conventional Commits、feat/fix 挂 issue。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/domain/org-tree-check.ts`（新）+ `scripts/check-org-tree.mjs`（新） | 组织树一致性检查（前置门） |
| `modules/data/domain/metric-visibility.ts`（新） | `loadDeptContext` + 纯谓词 `metricVisibleWithDept` |
| `modules/data/domain/authz.ts` | `visibleMetrics` 扩可选参 `deptCtx` |
| 六个调用点 | 接线（一处一行式） |

---

### Task 1: 组织树一致性检查（spec 前置门）

**Files:** Create `domain/org-tree-check.ts` + `domain/org-tree-check.test.ts` + `scripts/check-org-tree.mjs`。

**判据（读 `platform.v_org_node` / `v_org_membership`，视图定义见 `apps/server/src/migrations/013_org_views.sql`）：**
- 环：node 的 path 不含自身 ext_id（`path.split('.').includes(ext_id)` ⇒ cycle）
- 悬挂父：path 首段在活节点集不存在
- 重复：同 tenant 内 ext_id 唯一（视图/PK 应保证；查出即报）
- 死节点挂人：membership 指向 status≠1 的节点（dept-gate 的 join 会静默丢——这里要点名）
- 深度/空支：depth>10 或「有节点无任何 membership」**仅告警不红**（空分支合法）

**Interfaces:** `checkOrgTree(pool, tenantId?: number): Promise<OrgTreeReport>`（不过 tenantId=全租户）；`OrgTreeReport = { tenantId, nodes, errors: OrgTreeIssue[], warnings: string[] }`；脚本 `--tenant <id|all>`，errors 非空 ⇒ exit 1。脚本形态照 `scripts/check-docker-mirror.sh` 之外的本仓 node 脚本惯例（参考 `scripts/check-semantics.mjs` 的入口/输出风格）。

- [ ] Step 1: 失败测试（fixture 造环/死挂/悬挂父/干净树四态；用真实 SQL 建临时表？——不行，视图只读。**用事务里 insert platform.org_node/org_membership 夹具**，参考 dept-gate.test 的做法；若 org 表可写性受限，退到「查询谓词纯函数化 + 注入行数组」的测法，SQL 只留薄壳）。
- [ ] Step 2: RED → 实现 → GREEN → Commit `feat(data): 组织树一致性检查（P2 Task 1，spec 前置门）`。
- [ ] Step 3: **生产取证**：openship exec（server 服务，NODE_PATH+pg）调 `checkOrgTree` 全租户 —— 或本地 `pnpm exec tsx scripts/check-org-tree.mjs --tenant all` 对准 shanhai prod DATABASE_URL 经 exec 跑；结果写进 task 报告与台账（errors=0 才允许后续任务合并；非 0 ⇒ 停波上报）。

---

### Task 2: 部门上下文与纯谓词（domain/metric-visibility.ts）

**Files:** Create `domain/metric-visibility.ts` + `.test.ts`。

**Interfaces（Produces，Task 3/4 按名消费）：**
- `interface DeptContext { canOwn: ReadonlySet<string>; memberOf: ReadonlySet<string> }` —— `canOwn` = viewer 直属部门的**自身∪祖先∪后代**（作「可见的归属部门 id 集」）；`memberOf` = 直属集（打 `visible_depts` 用）
- `loadDeptContext(pool, tenantId, requester): Promise<DeptContext>` —— **一条查询**：取 viewer 直属节点的 path 集；`canOwn` = 直属 ∪ ∪paths(直属) ∪ **后代**（`path like '直属段.%'` 的所有活节点 ext_id——用 `v_org_node.path @> ...` 或 `path like any(...)`，照 dept-gate.ts 的 SQL 风格）；无直属 ⇒ 两集皆空（fail-closed 由谓词保证）
- `metricVisibleWithDept(metric: { ownerDept: string | null; visibleDepts: string[] | null }, deptCtx: DeptContext | undefined): boolean` —— 纯函数：`ownerDept === null` ⇒ true；`deptCtx === undefined` ⇒ **false**（fail-closed）；否则 `canOwn.has(ownerDept) || visibleDepts?.some(d => memberOf.has(d)) === true`

**真值表测试（纯函数即可覆盖大半）：** 平台指标恒真；owned+无 ctx 假；owned+链上（自身/祖先/后代三种）真；owned+兄弟假；`visible_depts` 命中直属真、命中祖先**假**（显式共享只认直属，钉死语义）；空 visible_depts 假。

- [ ] 失败测试 → 实现 → 绿 → Commit `feat(data): 部门上下文与可见性纯谓词（P2 Task 2）`。

---

### Task 3: 咽喉扩参（authz.visibleMetrics）

**Files:** Modify `domain/authz.ts` + `authz.test.ts`。

- `visibleMetrics(catalog, requester, adoptedSources, deptCtx?: DeptContext)` —— 追加第四可选参；过滤器追加 `&& metricVisibleWithDept(m, deptCtx)`。**缺省 undefined ⇒ owned 行全部不可见（fail-closed）**——这是有意的：未接线的调用点宁可少给，不可多给。
- 回归锁：现有 authz.test 全绿本身就是「无 owned 行 ⇒ 输出逐字节不变」的证明；另加一条用例：catalog 全 owner_dept null + 传 ctx ⇒ 输出与不传完全一致。
- 调用点未接线前一切行为不变（部署安全：现网 57 行全 null，接线与否都零变化）。
- [ ] 失败测试（owned+undefined ctx 不可见；owned+ctx 链上可见）→ 实现 → 绿 → Commit `feat(data): visibleMetrics 扩部门上下文（P2 Task 3）`。

---

### Task 4: 六处调用点接线

**Files:** Modify（以 `grep -rn "visibleMetrics(" modules/data --include='*.ts' | grep -v test` 实数为准，取证时为）：`query-service.ts`、`drill.ts`、`toolbox/query.ts`、`toolbox/discovery.ts`、`toolbox/registry.ts`、`toolbox/health.ts`、`toolbox/recipes.ts`、`agent-loop.ts`、`report-root-cause.ts`。

接线模式（每处两行，懒加载防无谓查询）：

```ts
// catalog 里没有归属行 ⇒ ctx 不影响输出，跳过加载（行为零变化的第二道保险）
const deptCtx = allMetrics.some((m) => m.ownerDept !== null)
  ? await loadDeptContext(deps.pool, tenantIdOf(deps.org), requester)
  : undefined
const catalog = visibleMetrics(allMetrics, requester, deps.adoptedSources, deptCtx)
```

⚠️ `tenantId`：dept-gate 用的是**租户数字 id**（`platform.tenant.id`），不是 casdoor_org——接线处按 dept-gate.ts:158 注释的取法拿（看它现有调用方怎么从 ctx 拿 tenantId，照抄）。若某调用点拿不到 tenantId（无 ctx），**该点不接线并在代码注释说明**——fail-closed 已保证该面看不到 owned 行（宁少勿错），台账记缺口。

- [ ] 失败测试：挑两个代表面（query-service 按 id 404、discovery 列表过滤）各一条 owned 场景；其余点靠「同一函数」推理 + 现有全量回归。
- [ ] RED → 接线 → 全量 `modules/data` 绿 → Commit `feat(data): 六面接入部门上下文（P2 Task 4）`。

---

### Task 5: 终审 + 部署 + 台账

1. 终审（opus，整分支）：跨面接缝（懒加载条件与 fail-closed 的组合漏洞、tenantId 取法一致性、性能——每请求至多多一条索引查询）、真值表完备性、回归锁强度。
2. 全量本地 + CI 全绿 + PR（Closes issue）+ shanhai 部署。
3. 容器核验：产物含新逻辑；**生产行为零变化证明**——部署前后 `GET /metrics` 词表数一致（57）与 `select count(*) from data.metrics where owner_dept is not null` = 0。
4. 台账：P2 行入已完成；「P1 终审缓办」中 ③（override owner_dept 管道）可顺带评估是否本波已自然解决（visibleMetrics 消费 owner_dept——override 行恒 null ⇒ 恒可见，语义正确，销账）。

---

## Self-Review

- **Spec 覆盖**：§8.1（Task 2 真值表）、§8.2 AND（Task 3 过滤器顺序）、§8.3 执法点（Task 4——词表/查询/明细/MCP/移动全经 `visibleMetrics`；**报表渲染面归 P5**，spec §9）、§17.1 前置（Task 1）。
- **取舍**：`visible_depts` 只认直属（不展开祖先）——spec §8.1 写「观看者部门 ∈ visible_depts」，部门=直属语义，测试钉死；reveal 消费不在本波；agent-loop（已无一等消费方）同样接线防复活。
- **不做**：P3 的 tie 检测与 caliber 标注；P5 的发布门/渲染闸；按人（非部门）授权。
