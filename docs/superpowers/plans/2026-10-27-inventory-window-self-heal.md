# 库存快照采集窗口自愈（T-2 主取 + T-3 兜底 + BIZDAY 回填变体）

> 状态：待实施 · 日期 2026-10-27 · 账套 3120
> 触发：`lemeng.inventory.snapshot.l0.3120` 自 2026-10-20 起连续 7 天 35 轮全红（`SOURCE_NOT_PUBLISHED`），湖里 10-18..10-25 共 8 个分区缺席。

## 1. 事实（实测，不是推断）

| 项 | 证据 | 结论 |
|---|---|---|
| 源端发布时点 | console 内有效 `LEMENG_TOKEN` 探针于 2026-10-26T16:11Z（=10-27 00:11 CST）：10-24/10-25 有数，10-26 空 | 营业日 D 的数据在 **D+1 22:35 CST ~ D+2 00:11 CST** 之间发布 ⇒ 距 D 日结 **46.6–48.2h** |
| 现行采集时点 | `schedules/3120.json`：`35 14,16,18,20,22 * * *` Asia/Shanghai，窗口 `${date-1d}` | 采集时点距 D 日结 **14.6–22.6h** ⇒ 恒定早于发布 ⇒ 恒空 |
| 曾经的可用配置 | 卷内 `schedules.json.bak-pre-tz`（10-16）：`timezone: UTC` + `35 16 * * *` 单轮 = 00:35 CST | 距日结 **48.6h** ⇒ 只比发布晚 **24 分钟**，靠这 24 分钟绿了 7 天 |
| 回归来源 | `7c2bb9d1`（#932，10-20 排班改 CST + 5 轮） + `a96618ba`（#939，10-20 窗口 `${date-2d}`→`${date-1d}`） | 两个改动叠加把采集点推到发布之前，且删掉了 00:35 那一轮 |
| 受害面 | run 历史 47 条：10-13..10-19 全 ok（4208 行 / 16:35Z）；10-20..10-26 共 35 轮全红 | 7 天 8 个分区缺口 |

## 2. 方案（用户 2026-10-27 裁决：选项 3）

原则：**取最新的（T-2），每天顺手把更容易漏的前一天（T-3）再补一遍**。任一天最多只能晚一天到湖，不会永久缺。

| 管线 | 名 | 窗口 | 排班（Asia/Shanghai） | 角色 |
|---|---|---|---|---|
| 主 | `lemeng.inventory.snapshot.l0.3120` | `${date-2d}` | `35 14,16,18,20,22 * * *`（不变） | 命中 46.6h 之后的发布；最新数据 |
| 兜底 | `lemeng.inventory.snapshot.catchup.3120` | `${date-3d}` | `35 0 * * *`（每天一轮） | ≥72h 必然已发布；补前一日主轮没拿到的 |
| 回填 | `lemeng.inventory.snapshot.backfill.3120` | `${BIZDAY}` | 不排班（`EXEMPT_GLOBAL`） | 本次补 10-18..10-25 |

- **为什么是两条管线而不是一条 80 节点 DAG**：主支的 `ctl.die(no-rows)` 会在 D-2 未发布时中止整个 run，D-3 支就跑不到；且分属不同 run record / 新鲜度锚更清晰。
- **为什么兜底是 0:35 而不是跟着主轮跑**：0:35 是历史实测过能命中的时点；兜底的意义就是在主轮全部失败后还有一次机会。
- **兜底窗口取 T-3 而非 T-2**：与主轮错开一天，避免两条线抢同一天做重复功；T-3 距日结 ≥72h，远超 48.2h 上限。
- **湖布局不变**：仍是 `bizday=<D>/all.parquet`，三条线写同一分区路径 ⇒ 幂等（`mode: overwrite`），谁成功都以同一份内容落盘。

## 3. 改动清单

### 3.1 管线文件（`deploy/duckle/console/pipelines/`）

1. `lemeng.inventory.snapshot.l0.3120.json`：`${date-1d}` → `${date-2d}`（p1..p31 body、`gv`、`shape`、sink `key`、`die_empty` message）。
   - `die_empty` 文案重写：把错误的「实测滞后 16~40h」换成实测 46.6–48.2h，并说明窗口语义（T-2）与兜底管线。
2. 新增 `lemeng.inventory.snapshot.catchup.3120.json`（由生成器派生）。
3. 新增 `lemeng.inventory.snapshot.backfill.3120.json`（由生成器派生）。

### 3.2 生成器 `scripts/lemeng/gen-inventory-snapshot-variants.mjs`

- 输入：主管线文件（唯一事实源，手工维护）。
- 派生：`--variant catchup|backfill`，把窗口 token（`${date-2d}`）替换为目标 token（`${date-3d}` / `${BIZDAY}`），顶层 `name` 换成对应管线名，`die_empty` 文案按语义改写。
- `--check`：重新生成并与仓内文件逐字节比对，不一致 exit 1（CI 漂移闸）。
- 产出后必须 `duckle MCP validate_pipeline` 过才许提交。

### 3.3 排班 / 锚 / 门禁

4. `deploy/duckle/console/schedules/3120.json`：新增 catchup 一条（`35 0 * * *`，Asia/Shanghai，`misfire: all`，`maxCatchupRuns: 31`，`maxCatchupAgeDays: 45`，与主轮同款）。
5. `scripts/check-console-schedules.mjs`：`EXEMPT_GLOBAL` 新增 `lemeng.inventory.snapshot.backfill.3120`（回填专用，理由照同族先例）。
6. `deploy/duckle/console/owners.lemeng.json`：库存锚 description 改为「主 T-2 / 兜底 T-3」并注明两条管线；`maximumAge` 维持 `36h`（锚量的是对象写入时刻，5 轮/日 + 每日兜底，36h 仍宽裕）。
7. `deploy/data-plane.lock` 重生成：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`。

### 3.4 正典（`docs/data-platform-handbook.md`）

8. §1.7 登记行 + §2 数据源清单行：窗口 `date-1d` → `date-2d`（+兜底 T-3），删掉被证伪的「滞后 16~40h ⇒ 日内 5 轮重试」理由。
9. §1.6 案例库新增一条（只增不改）：**窗口比源端早 24h ⇒ 7 天 35 连红**——记载 46.6–48.2h 实测、48.6h 老配置的 24 分钟余量、以及「窗口语义必须晚于源端发布上限」的判据。
10. §5 验收记录行：本次回填 10-18..10-25 逐日对账结果。

## 4. 部署链（唯一通道：openship MCP）

E1 `sh /opt/lemeng-sync.sh <全 SHA>`（数据机，经 openship `service exec`）
→ E2 `sh seed-console.sh 3120 --seed all`（写入卷内 pipelines/schedules/owners）
→ E3 重启 console 容器（openship MCP `restart`；`/workspace` 是命名卷，重启即重载）
→ E4 `POST /api/catalog` 重建 catalog（否则新管线 run record 不带 assets ⇒ 新鲜度锚失效）

## 5. 验收（四层）

| 层 | 判据 |
|---|---|
| L0 湖 | 回填后 `bizday=2026-10-18..2026-10-25` 共 8 个分区，每分区 4208 行（与 10-11..10-17 同形） |
| L0 管线 | 主轮 + 兜底各至少一次 `ok`；run record 带 assets |
| 锚 | `owners.lemeng.json` 的库存锚恢复「匹配到」且年龄 < 36h |
| 下游 | 库存相关物化链跑绿（若该域已接入物化） |

## 6. 不做 / 边界

- 不动 `LEMENG_TOKEN`（console 内有效；本地 `LEMON_AGI_TOKEN` 失效是另一件事，本轮不碰）。
- 不动 `report.ai.*` 网关回归（会员全店回填阻塞，另案）。
- 不改湖布局、不改下游契约。
