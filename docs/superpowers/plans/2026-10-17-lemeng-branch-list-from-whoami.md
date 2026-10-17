# 计划：#793 零售明细门店清单改 whoami 现算（新店静默漏采治本）

> 日期：2026-10-17 · issue：#793 · 源族：乐檬（既有源，台账 §2 两行在册，从 D/E 段续走，不重跑 A/B）
> 分支：`fix/793-lemeng-branch-list-from-whoami`（off origin/main @ f1e888b）

## 0. 背景与根因（实测，详见 issue）

- 3120 env `BRANCH_NUMS`=269（静态手抄），凭据可见 271；缺 271（真店，09-30 起每天漏采）与 99（管理中心，应排）。
- 驱动器 run 内本来就调 whoami（v0→g2），g3 只单向查「配置 ⊆ 可见」后即弃；w0 写死 `'${ENV:BRANCH_NUMS}'` 驱动 foreach。
- 门店档案（`lemeng.dim.branch.l0`，日更全量）从未漏——271 自 snapshot 09-30 天天在档。
- ⚠️ 271 在档案 `type` 也是 `SYSTEM`（与 99 同型）⇒ **豁免不能按 type 自动判**，必须显式清单。

## 1. 设计定案

### 1.1 数据流（改后）

```
whoami(v0) → g2(visible 清单) → g3′(对账底账, 漂移≠阻断) → w0′(现算: visible − BRANCH_EXCLUDE)
w0′ → fe(ctl.foreach) → 子管线(branch_nums = ${ITER_ITEM_BRANCH_NUMS})
```

### 1.2 逐节点改动（tick.l1 / windows.l1 / windows.backfill 三驱动器；close.l1 实施时核同构则同改）

| 节点 | 改动 |
|---|---|
| w0 | 上游改挂 g2 输出；`branch_nums` 列改为 `json_group_array`（visible − `${ENV:BRANCH_EXCLUDE}`）产 JSON 数组串；交叉 join 窗口序列不变 |
| 新 wf | 现算清单为空 ⇒ `ctl.die`（foreach 零 item = 静默空转，必须 fail-closed） |
| g3 | 保留 book 校验 + 「底账 ⊆ 可见」die；新增反向「可见−排除 vs 底账」差异行——**不进 dz**，以 `status='config_drift'` 流入 OO webhook（告警不阻断） |
| sr | 过滤从 `status <> 'ok'` 改为 `status NOT IN ('ok','config_drift')`（否则漂移行会误触 dz 判红） |
| gv | 增 `BRANCH_EXCLUDE` 形状闸：`[]` 或 `[int,...]`；缺席/非法 ⇒ die（沿用既有 fail-closed 模式） |

### 1.3 env 定案（openship 服务行，两 console）

| console | BRANCH_NUMS（底账） | BRANCH_EXCLUDE（新） | 现算=底账 |
|---|---|---|---|
| 3120 | 补 271 → **270** | `[99]` | 271−1=270 ✓ |
| 64188 | 129 不动 | `[]` | 129 ✓（行为不变；排 99 另议） |

### 1.4 范围与不动项

- 子管线（`retail_order_line.window/tick`）**不动**（消费 `ITER_ITEM_*`，形状不变）。
- 其余 17 条读 `BRANCH_NUMS` 的管线：本 PR 不动，同型审计另开 issue。
- dim.branch 档案管线不动（本就全量）。

## 2. 实施步骤

### Phase 1 止血（ops，先于 PR 合并；openship MCP 通路）

1. 3120 服务 env `BRANCH_NUMS` 补 271（openship env patch；先查服务行有没有 `***` 脱敏字面量，有则整体重写）→ refresh 服务。
2. **checkpoint 语义试采（关键风险前置）**：先只回填一天闭窗日（取 10-15）→ 查湖分区（pg_duckdb S3 直读 `lemeng/retail_order_line/system_book=3120/bizday=2026-10-15/**`）里 271 行数：
   - >0 ⇒ checkpoint 键含请求体，body 变更自然失效 ⇒ 批量回填 09-30→10-16（`backfill-retail-order-line.sh`，降序）；
   - =0 ⇒ 缓存重放盖过了 body 变更 ⇒ 走 `recon-day-heal.sh` HEAL_FORCE 旁路（#528 常设口子），逐日。
3. 物化（`materialize.sh`）→ `fct_retail_sale` 逐日含 271 → 抽日与乐檬 API `sale_money` 全店对平（含 271；3120 独立通道恒 10006 不可用，用 REST 直调）。
4. 验收：3120 10-16 平台口径 == 乐檬 `sale_money`（此前差额 486.10 = 271 缺口 2,825.70 − 退货口径差 2,339.60，应归零到 sale_money 面）。

### Phase 2 治本 PR（本分支）

1. 改 `deploy/duckle/console/pipelines/lemeng.retail.tick.l1.json`、`lemeng.retail.windows.l1.json`、`lemeng.retail.windows.backfill.json`（+`retail.close.l1.json` 若同构）。
2. **管线 JSON 由引擎产出**（authoring-ws / duckle run 验证后提交，不手编——D 段口径）；跑 `data-plane-lock.mjs` 更新 lock。
3. `.env.example` / console env 模板补 `BRANCH_EXCLUDE`（B9 门禁；「<键名>」占位）。
4. 本地门禁八条 check-* + 纪律脚本（本地「全量门禁」≠CI gates，推前必跑）。
5. PR → CI CLEAN → merge（合并即自动部署数据面主项目；console 卷 seed 走 `seed-console.sh` 停机写卷流程，防引擎回写覆盖——两 console 都 seed）。

### Phase 3 部署后验（deploy-verify 纪律）

- 等 tick 轮次 → 湖新分区含 271（强验证，不看流水线绿）；
- OO `data_alerts`/summary 无 config_drift 误报（两账套现算==底账）；
- 64188 当日数据与回填前形状一致（防回归）。

## 3. 验收清单（对应 F/G 段）

- [ ] 四层验收：自证（现算清单非空+形状）/ 幂等（同窗重跑）/ 独立通道（3120 不可用，记台账沿用户案）/ 跨系统（待回填照旧标注）
- [ ] 正典三处登记：§1.7 决策行、§2 台账行（3120/64188 行补「清单=whoami 现算」）、§5 验收记录
- [ ] §1.6 案例库新增（只增不改）：静态清单漏新店 17 天
- [ ] WeKnora 条目 `97ff3f78` 更新（修法已落地）
- [ ] 同型审计 issue（其余管线族）

## 4. 风险与已知边界

- **checkpoint 重放语义未验**（§2 Phase 1.2 前置试采）——首用即记录回填案例。
- 3120 独立通道恒 10006（乐檬侧改坏）⇒ 对平只能 REST 直调，沿用今日实测通路。
- 回填会整日覆写分区（mode=overwrite），必须用**全量现算清单**跑（Phase 1 先补 env 正是为此）。
- tick 的 `continueOnFailure:true` + dz 形收语义不变；drift 行新分流后 dz 判红面不变（只真失败才红）。
