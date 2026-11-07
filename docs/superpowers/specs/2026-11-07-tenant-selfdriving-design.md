# 租户级自转（W7 Task 3）设计

> 状态：**设计已确认（2026-11-07，用户逐项选定）**。
> 对应路线图 §3 的 **W7**：`docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`。
> 实施计划：`docs/superpowers/plans/2026-11-07-amd-w7-cross-object.md` 的 Task 3（本设计落地后重写）。

## 1. 为什么改范围（验证驱动的四条事实）

开工前在**真机**核过以下事实，它们把「多 org 参数化」这件小事与「环路不可用」这件大事区分开了：

| # | 事实 | 取证 |
|---|---|---|
| V1 | `askdata_trace` / `askdata_stuck` **没有租户字段**（16 / 8 个字段，无 org/tenant） | OO `StreamSchema`（shanhai，org `3IJ5tM4en3A06FzcJQhoHMTl4Xe`） |
| V2 | 两个部署都是 `TENANT_MODE=single`，各只有 **1 个租户** | `platform.tenant`；容器 env |
| V3 | 数据层已按 org 隔离：audit / signals / state / candidates / verified 全部 `where org = $1` | `modules/data/domain/demand/*`、`metric-candidates.ts`；shanhai 库实数 audit 7,875 / candidates 278 / signals 45 / verified 104 / state 2，全 `shanhaiyiguo-org` |
| V4 | **回归腿连续 3 天红**（11-05/06/07），且原因不是口径变化 | job runs 实测 |
| V5 | 红的两类原因：① `#3`「近 7 天」`params={}` —— 摄入时未钉窗口，基线是滚动快照；② `#1723` 业务 `value` 未变，仅 `branch_num`（**标识列**）sum 118197→118356 漂移 | `data.verified_questions` 原行 + job 输出 |
| V6 | `rowCount` 恒被截到 1000 ⇒ **不能**用它替代行集组成信号 | 基线原文 `rowCount: 1000` |
| V7 | job failed 通知**不进站内 deliveries feed**；数据面的既定单出口是 OO `data_plane_probes` → `oo-notify-bridge.sh` → 企微 | `deploy/duckle/console/scorecard-alert.py` 头注；100 条 deliveries 中 `job.* = 0` |
| V8 | 基线刷新**已有 CLI**（`scripts/refresh-baseline.mjs`，#1494），但它的 dry-run **仍然写库**（CLI 只改了报告里的 `wrote`，`refreshBaseline` 恒执行 UPDATE） | 通读 CLI + domain：`refreshBaseline` 无 `write` 开关 |

**结论**：多 org 迭代本身是小改动；真正让 W7 出口判据「单租户 30 天自转、平台零介入」不成立的是**判据不可执行 + 红不可见**。因此 Task 3 必须先把环路做成「可信、可执行、可见」，再谈多租户。

## 2. 范围

### 2.1 纳入（四件）

1. **多 org 挖掘**：`demand-mining` 支持 `--org` / `--all-tenants`；conv/stuck 侧加单租户归因护栏。
2. **评估集卫生 + 刷新修缺**：禁止无窗口的 `default` 条目；修 `refresh-baseline` 的 dry-run（现为「号称 dry-run 仍写库」）。
3. **判定分级**：`value`/结构漂移判红；维度（标识）列漂移降为 `warn`。
4. **verdict 可见性**：回归结果投 OO `data_plane_probes`，复用既有企微桥。

### 2.2 非目标

- 不给 OO 流补租户字段（需改 openclaw 插件/导出器，历史不可回填）——多租户时 conv 侧**跳过**，不造假归属。
- 不新增应用侧密钥；不把宿主 `/etc/openobserve-ingest.env` 复制进容器。
- 不改 openship job 通知本身（平台缺陷另开 issue）。
- 不做候选生成定时化（候选仍由租户在 console 触发；本轮只保证其按 org 正确）。

## 3. 契约

### 3.1 `demand-mining.mjs`

```
node scripts/demand-mining.mjs [--org <casdoor_org> | --all-tenants]
```

- 都不传 ⇒ `PLATFORM_ORG`（向后兼容）。
- `--all-tenants`：`select casdoor_org from platform.tenant order by id`；**空列表 ⇒ exit 1**。
- 逐 org 串行；单 org 失败只点名（`demand-mining: org=<org> FAIL <reason>`），其余继续；任一失败 ⇒ 最终 exit 1。
- 每个 org 一行摘要：`demand-mining: org=<org> scanned=… alias=… new_metric=… drill=… hunt=… conv=ok|skipped(multi-tenant)`。
- **conv 归因护栏**：仅当 `platform.tenant` 行数 = 1 时挖 conv/stuck；否则 `mineOnce` 以 `skipConv` 跳过（不读 `askdata_trace`/`askdata_stuck`、不推进 conv 水位），摘要显式 `conv=skipped(multi-tenant)`。租户列表查询失败 ⇒ 按多租户处理（fail-closed 跳过 conv）。

### 3.2 评估集卫生

- `apply-eval-set`：条目的 `window` 必须是 `fixed`（带已封板 `from`/`to`）或 `yesterday` / `last7` / `mtd`（摄入时解析成**绝对区间**）。**`default`（无参、用指标自身缺省参数面）一律拒收**，原因码 `window_required`。
  - 理由：`yesterday/last7/mtd` 在摄入时已钉成绝对日期；只有 `default` 会把「指标自己的相对缺省」固化进基线。
- 存量 `#3`：置 `status='stale'`（移出 `listVerified` 默认集），并在 `decided_by` / 备注里写明「滚动窗口，不可作基线」。规则成文：**评估集只收已封板的绝对窗口**。
- 修 `scripts/refresh-baseline.mjs`（已存在，#1494）：`refreshBaseline` 增 `write?: boolean`（缺省 true），CLI dry-run 透传 `write:false`。用法：
  ```
  node scripts/refresh-baseline.mjs --org <org> --id <N> --by <人> --reason <文本> [--write]
  ```
  缺省 dry-run（只重放并打印 before/after/drift，**不写库**）；`--write` 才落库。守卫与漂移计算两种模式同源（都在 `refreshBaseline`）。
- 存量 `#1723`：用该 CLI 刷新一次（reason 记「10 月门店行集变化，业务 value 未变」）。

### 3.3 判定分级（`compare`）

返回 `{ ok, diffs, warns }`：

- **fail（`diffs`）**：`columns` 集合/顺序、`rowCount`、`summary` 多出未声明列、null 数变化、数值性（`numeric`）翻转、非有限值、以及 **`value` 列**的 sum/min/max 漂移。
- **warn（`warns`）**：非 `value` 数值列的 sum/min/max 漂移（标识列/维度列的**行集指纹**）。
- **fail-closed**：基线没有 `value` 列 ⇒ 所有数值列漂移按 fail 处理（不放宽）。
- `runRegression`：`diffs` 非空 ⇒ `fail`；否则 `pass`，并把 `warns` 透传。`last_check_result` 仍只写 `pass|fail|error`（warn = pass）。
- CLI：逐条打印 `warn` 行；汇总 `total/pass/fail/error/warn`；退出码只看 fail/error（0 = 无 fail）。

> **不改 fail 级语义**。基线仍表达「答案稳定」；维度列只是「物理行集变了」的信号，交给人判断是否刷新基线。

### 3.4 可见性

- 新增 `scripts/lemeng/emit-probe.sh`（data-plane 清单 → `/opt/lemeng-emit-probe.sh`）：
  ```
  sh /opt/lemeng-emit-probe.sh <check> <verdict> <detail>
  ```
  读宿主 `/etc/openobserve-ingest.env` 的 `OO_BASE/OO_ORG/OO_AUTH`，向 `data_plane_probes` POST 一行
  `{probe:"regression", check, verdict, mode:"advisory", detail}`（形状与 `scorecard-alert.py` 同）。
- job `verify-regression-shanhai` 命令改为：跑回归 → 按退出码发 `OK`/`RED`（detail = 末行摘要 + 失败 id）→ **保留回归自身退出码**。投递失败只打 `PROBE_EMIT_FAILED` 告警，不改变 verdict。
- `oo-notify-bridge.sh` 通道②只看 `verdict <> 'OK'` ⇒ OK 行落库不打扰，RED 行 ≤2 分钟进企微。

## 4. 验收判据

1. **多 org**：单测覆盖参数互斥/空租户/单 org 失败隔离；真机 `--all-tenants` 跑一轮，摘要含真实 org 行。
2. **conv 护栏**：单测覆盖 `skipConv`（不读 conv/stuck、不推 conv 水位、摘要标记）；真机单租户下 `conv=ok`。
3. **评估集卫生**：`apply-eval-set` 拒 `default` 的用例；`refresh-baseline` dry-run 打印漂移、`--write` 落库且清 `last_check_result`；#3 已 stale、#1723 已刷新。
4. **判定分级**：单测覆盖 value 漂移=红、维度漂移=warn、无 value 列 fail-closed；真机回归从「每日红」变为「pass + warn」（或真实 fail 若口径真的变了）。
5. **可见性**：真机回归 job 跑完后 `data_plane_probes` 有本租户一行；人为把一条基线改坏 ⇒ RED 行进企微（或至少 OO 可查）。
6. **观察**：`2026-11-07-tenant-loop.md` 记录首日基线与 7/30 天观察 SQL；30 天判据标「观察中」。

## 5. 风险与回滚

- **warn 级可能掩盖真实口径漂移**：只降级非 `value` 列，且 `value` 缺席时 fail-closed；`warns` 逐行打印并进 OO detail。
- **多 org 单点失败**：失败隔离 + 最终 exit 1；游标按 org 独立，重跑幂等。
- **可见性通道**：`data_plane_probes` 是既有单出口，桥/pipeline 已在跑；回滚只需把 job 命令改回原样。
- **凭据**：不新增应用侧密钥；宿主 env 文件不复制、不落日志。
