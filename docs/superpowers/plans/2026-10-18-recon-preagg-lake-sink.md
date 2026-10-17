# recon 对账结果落仓（湖 sink）—— 实施计划

> 2026-10-18。上位：消费面 spec §12.4 缺口①「证据不落仓」。
> 流程：`collect-source` A→I；**A 段已完成并入库**（PR #842），本稿覆盖 **B→H**。

## 0. 现状（A 段结论，已验证）

| | |
|---|---|
| 源对账管线 | `deploy/duckle/console/pipelines/lemeng.recon.preagg.item.json` |
| 厂商接口 | `nhsoft.report.ai.itemsales.find`（`summary_types:["branch"]`，`branch_nums` 必传、单次 ≤100 家） |
| 鉴权 | 容器 env `LEMENG_TOKEN`（**不是** `connections/lemeng.json` 的 `authToken`——那个 401） |
| 产物 | console 卷 `/workspace/reports/recon-preagg/recon-<book>-<day>.csv` + `raw-<book>-<day>.json` |
| 驱动 | job `lemeng-recon-day-heal`（`17 4 * * *`，T-3 定线）：对账 → 不平自动回填 → 复验 |
| 实测（2026-10-16） | 64188 三店 `27,777.50` = `27,777.50`；3120 两店 `9,893.40` = `9,893.40`（**均差 0**） |
| **活口** | 净额侧过渡容差 `NET_ABS_TOL=200`（issue #814「退货晚到」未关） |

## 1. 目标与非目标

**目标**：把「平台 vs 源报表」的逐日差**变成仓内一等公民**——可查询、可趋势、可门禁。

**非目标**：
- 不改对账口径、不动 `NET_ABS_TOL` 的值（#814 关掉它是另一件事）。
- 不新建源、不改 `itemsales` 的取数窗口。
- 不替代 `recon-day-heal` 的自动回填（它继续按 CSV 干活）。

## 2. 关键裁决（三条，先立后写）

### 2.1 容差必须是**数据列**，不是脚本常量

现状：`NET_ABS_TOL=200` 写在 `recon-preagg.sh` 里。若落仓只落一个 `passed boolean`，
闸就**自带 200 元盲区**，而且这个盲区**不在任何数据里**——正是 §12.4 要消灭的「静默绿」。

⇒ 落仓列必须含：`abs_tol`（当次生效的容差）+ `verdict`（三态）。

### 2.2 三态判定，不是二值

```
verdict = 'zero'        -- |diff| = 0（理想态）
        | 'within_tol'  -- 0 < |diff| <= abs_tol（当前会被放过，但必须**可见**）
        | 'over_tol'    -- |diff| > abs_tol（真红）
```

**理由**：现状容差内一律当平，等于把「已知缺口」与「真的对上了」混成一档。分三态后，
`within_tol` 的量与趋势可以直接看出 #814 有没有恶化——这是本项目能给 #814 的唯一增量价值。

### 2.3 落**两侧**，不只落净额

销售侧容差是 `PREAGG_ABS_TOL=1.00`（恒逐分），净额侧才是 200。只落净额会把「销售侧本来是紧的」
这条信息丢掉。⇒ 落 `net_sale`（销售侧）与 `net`（净额侧）两行 side，各自带容差与 verdict。

## 3. 分段实施（每段验完再进下一段）

### B 选型定案 → 补 §1.7 决策行

- 形态：**既有管线加 sink**（duckle 原生 `snk.parquet`），不新建管线、不换通道。
- §1.7 加一行：源 / 落点前缀 / 分区键 / 节奏 / 调度归口 / 验收结论（验收列此刻**留空**）。
- ⚠️ §1.7 是「逐源」表，本资产是**派生资产**不是源 ⇒ 行内必须写明「派生自 `itemsales` 对账」。

### C 契约（**不能单独落仓**）

⚠️ `check-data-contract` 要求「生产者与 staging 均已对齐」⇒ **C 必须与 D 同批**。

新建 `contracts/common/lemeng.recon_preagg.json`，列集草案（与 D 的 `data.schema` 逐字一致）：

| 列 | 类型 | 说明 |
|---|---|---|
| `batch_id` | varchar | 批次标记（既有约定） |
| `system_book` | varchar | 账套（分区键） |
| `bizday` | date | 业务日（分区键） |
| `side` | varchar | `sale` / `net` |
| `branch_num` | bigint | 门店 |
| `platform_value` | decimal(20,2) | 平台侧（`net_lake`） |
| `source_value` | decimal(20,2) | 源报表侧（`net_pre`） |
| `diff` | decimal(20,2) | `source − platform` |
| `abs_tol` | decimal(20,2) | **当次生效容差**（2.1） |
| `verdict` | varchar | `zero` / `within_tol` / `over_tol`（2.2） |
| `computed_at` | timestamptz | 计算时刻 |

跑 `gen-data-projection.mjs` 更新生成物（**不手改投影**）。

### D 管线

- 从现有 `diff` 节点分叉：按 `side` 拆两行 + 计算 `abs_tol` / `verdict`。
- 新增 `snk.parquet` → `lemeng/recon_preagg/system_book=<账套>/bizday=<日期>/all.parquet`
  （分区键与契约 `layout` 逐段一致）。
- **保留**原 `snk.csv`（`recon-day-heal` 仍在读它）——两个 sink 并存，切换后才谈退役。
- `data.schema` 申报与契约列集**逐字一致**（只改投影不改申报 = 空页才炸）。
- 判停：**先单日真跑成功再谈调度**。

### E 调度

- 调度不变（跟随现有 recon 排班），但**三个登记面**：
  ① 排班种子无需改（管线已在）；② **重建 catalog**（`POST /api/catalog`）——漏了
  ⇒ 新资产 run record 不带 `assets` ⇒ 新鲜度锚静默失效；③ 跑一次成功 run 起算新鲜度时钟。
- 新鲜度锚：`owners.lemeng.json` 加该前缀（minio 锚，抓「没写」）。

### F 验收（四层）

| 层 | 判据 |
|---|---|
| 自证 | 写后回读：行数 = 门店数 × 2（两侧）；`sum(diff)` 与 **CSV 同日照**逐分一致 |
| 幂等 | 同日重跑覆盖写，行集不变 |
| 独立通道 | 本资产**就是**独立通道的产物 ⇒ 反向验：从仓里读出的 `diff` == 重算 CSV 的差 |
| 跨系统 | 待回填（同全仓口径） |

### G 运维

- 探活盯防：该资产的 minio 锚 + 下游接线判据（`wire-warehouse.sh`）成对。
- **判据必须用 `verdict`，不是「有没有行」**——有行但全是 `over_tol` 不是健康。

### H 回填

- 历史：按 T-3 线逐日回放（`itemsales` 支持单日查询），首批建议 **近 14 天**。
- 回填走**同一条管线**换时间窗，不写一次性脚本。

## 4. 风险与未验（写死在前面）

1. **`within_tol` 会掩盖真实缺口**：三态让它可见，但**不会让它消失**。#814 关闭前，
   该资产的「健康红」判据只能是 `over_tol = 0`，不能是 `all zero`。
2. **单次 ≤100 家**：3120 有 247 个门店号 ⇒ 管线需分批请求（现有管线已按 `BRANCH_NUMS` 一次传，
   实测 3 家可用；**超过 100 家时的行为未验**——D 段必须先用全量门店号跑一次）。
3. **`branch_nums` 必传**：拿不到清单 ⇒ 请求 10001 拒绝（fail-loud，不是静默）。
4. **未验**：`snk.parquet` 在 console 管线里对「每日一个分区」的写入形态——沿用既有
   `batch_id` 分区约定即可，但首次要实测覆盖写语义。

## 5. 不做

- 不动 `NET_ABS_TOL` 的值。
- 不停用 CSV sink。
- 不为该资产声明 L1 指标（它是**对账事实**，不是业务口径）。
