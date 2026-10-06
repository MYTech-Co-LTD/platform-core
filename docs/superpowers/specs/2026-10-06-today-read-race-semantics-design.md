# 「读今天」的竞态语义定案（#452 · spec ③ 实现的硬前置）

> **一句话**：读湖撞 tick 重写的 ETag 竞态，定案为「**咽喉单点自动重试（恰一次）+ 物化 job 错峰几分钟**」——
> 不改写侧、不改新鲜度语义、不造第二通路。
> **裁决：2026-10-06，用户确认（方案 A + E1）。**

上位依据：spec ③（`2026-09-26-detail-read-view-design.md`）§5 gate 3 写明「解法（重试包装 / 读侧快照 /
#452 定案的形态）**实现前必须先有定论**」——**本 spec 就是那个定论**；#452 是现象与根因的记录。

---

## 1 事实面（定案依据，2026-10-06 读码/实测）

1. **竞态面很小**：tick 每 run 只重写**当前小时 + 尾随小时**两个分区文件
   （`deploy/duckle/console/pipelines/lemeng.retail_order_line.tick.json` 内层 sink 实证：
   单对象 `all.parquet` overwrite；外层 `w0` 的窗口集只有 cur/prev 两窗）——不是全天。
   上海时段（08:00–24:00）内每 5 分钟 × 2 账套 × ≤2 文件，单次写入秒级。
2. **物化 job 是确定性撞，不是运气差**：`lemeng-dbt-materialize` cron `20 3 * * *` UTC
   （= 上海 11:20）与 tick 的 `*/5` **同分钟点火** ⇒ 天天撞同形状（#452 连续两天实测）。
   job 已配 retry 2×/300s 兜底；代价 = 每天白烧 ~6 分钟 + retry 窗理论上也能撞。
3. **视图消费通路只有一个咽喉**：全部问数经 `modules/data/domain/query-service.ts` 的
   `runWarehouseSql` 调用点（读侧唯一入口，statement_timeout 30s 已设）。现状撞了直接回
   `status=error, reason='warehouse_error'` + 裸 DuckDB 消息——消费方无从知道可重试。
   重试收在**一处**，所有消费方受益。
4. **audit 已由 #463 消**（只比已闭窗营业日）；**视图不能滤**（spec ③ gate 3 已写死，滤了就失去存在意义）。
   本 spec 只解这两个残余面：视图（任意时刻查询）+ 物化 job（同分钟点火）。

## 2 方案对比与判决

| 方案 | 一句话 | 判决 |
|---|---|---|
| **A. 咽喉单点自动重试** | query-service 识别 ETag 错误自动重试一次；再撞才回错且单独归因 | ✅ **定案** |
| B. 视图读已闭窗小时 | 排除正在写的小时 | ✗ prev 小时也在被重写（闭窗尾款），竞态只砍一半；且新鲜度 5 分钟劣化到小时级——违背 spec ③ 存在意义（就是 #463 式滤今天，已被 gate 3 否决） |
| C. 写侧蓝绿 / 指针翻转 | 影子写 + 指针切 | ✗ S3 PUT 本就原子，救不了多 range 读的 ETag 保护；纯 SQL 拿不到版本化文件列表（`read_parquet` 表函数参数须常量）⇒ 视图侧**不可表达** |
| D. 5 分钟微快照表 | 当日快照写 PG，视图读 PG | ✗ YAGNI——第二通路 + 快照自身的新鲜度判据一串新问题，收益与 A 等价。**登记为退路**（§3.5） |
| E1. 物化 cron 错开几分钟 | `20 3` → 避开 `*/5` 边界 | ✅ **定案**（配套） |
| E2. 物化挪到闭市后 | `30 16 * * *` | 不选——竞态归零但下游当天上午看不到当天部分数据，**需先确认有无消费方依赖**（未确认前不动语义） |

## 3 定案形态

### 3.1 A：query-service 咽喉重试

- **位置**：query-service `runQuery` 的执行 try/catch 处（包住 `deps.execute` / `runWarehouseSql`
  两个分支）——`deps.execute` 是既有测试缝，重试放这一层单测可直接驱动。
- **识别判据**：错误 message 含 `ETag`（真机形态：「HTTP Error: ETag on reading file … was initially
  … and now it returned …」）。**实现时真机固定一次判据**：若 pg_duckdb 给出稳定 SQLSTATE/error code
  则优先按 code 匹配，文本匹配兜底——判据落实现 PR，此处只定「窄匹配，宁可漏判也不误判」：
  只认 ETag 形状，**不扩大**到一般 5xx/超时（那类由既有 statement_timeout / job retry 语义管）。
- **动作**：退避 ~1s → **重试恰一次**。写入是原子 PUT，撞上时新文件多半已就绪，一次重试足够；
  整条查询重扫一遍（秒级），代价可接受。
- **适用面**：本通路全部是只读查询（问数面，plan.sql 均为 SELECT）⇒ 重试天然幂等，全量适用。

### 3.2 错误归因：`warehouse_transient`

重试仍撞时，不再裸回 `warehouse_error` + DuckDB 原文，而是单独归因
`reason='warehouse_transient'`（detail 保留原文供排障）——语义 =「活跃写入窗内的暂时性读冲突，
**等几秒重试大概率成功**」。这就是 spec ③ gate 3 验收的「可重试/语义明确的错误」：
正常情况消费方**无感**（第一次重试成功），极端情况拿到**可判读**的错误而不是裸 DuckDB ERROR。

### 3.3 E1：物化 job 错峰

- `lemeng-dbt-materialize` cron `20 3 * * *` → **`27 3 * * *`**（经 openship MCP 改 job，唯一通道）。
- 选 27 的理由：staging（首个模型）读湖发生在 job 起跑后 ~1 分钟内（上海 11:27–11:28），
  距两侧 tick 边界（11:25 / 11:30）各 ≥2 分钟；cur/prev 文件的被写时刻钉在边界后几秒 ⇒ 撞面消除。
- 「当日上午有当天数据」的语义**不变**（只挪 7 分钟）；已有 retry 2×/300s 保留为兜底。
- E2（闭市后跑）**不选**且**不预支**：哪天真有「当天上午不需要 staging 当天行」的确认，再议不迟。

### 3.4 验收

| gate | 判据 | 手段 |
|---|---|---|
| 单测（A） | `deps.execute` 抛 ETag 形状错误恰一次 → 查询成功、无感；连抛两次 → `status=error, reason='warehouse_transient'`；非 ETag 错误 → 不重试、原样 `warehouse_error` | query-service 单测 |
| 真机（E1） | 改 cron 后**连续 3 个自然日**首跑不再撞 ETag（销 #452 的销账条件） | openship job 运行历史 |
| 真机（A，随 spec ③ gate 3） | tick 时段内多次查视图（含 5 分钟边界后 ~30s 窗口）零裸错误；即便命中，消费方拿到的是 `warehouse_transient` 而非 DuckDB 原文 | spec ③ §5 的真机项，实现后一并跑 |

### 3.5 退路登记

若真机长期数据显示「重试一次后仍撞」的比率不可忽略（比如写入时长随分区变大而超过重试窗），
退路是 **D（微快照表）**：当日快照按 tick 节拍写 PG、视图读 PG——形态到时再设计，
**不许先按「重试一定够」做容量承诺**。本 spec 不实施 D。

## 4 非目标 / 边界

- **不改写侧**：tick 的覆盖写口径是 #260 定案，本 spec 不碰。
- **不碰 audit**：#463 的 settled-day 过滤已闭环，保持。
- **其它读湖通路不在此列**：recon-preagg / recon-day 在闭市窗跑（不在 tick 活跃窗）；
  探活断言读 PG 不读湖。若未来出现新的「读今天」消费方，按本 spec 的 A 形态接入（咽喉已收口）。
- spec ③ 的实现本身（视图/生成器扩展/门禁）仍排本定案之后——本 spec 解除的是 §7 的硬前置，
  不是替代实现计划。

## 5 对 spec ③ 的回写（随本 PR 一并落）

- §5 gate 3 行：「解法…实现前必须先有定论」→ 定论 = 本 spec（A：咽喉重试 + `warehouse_transient`）。
- §7 依赖链：`#452 定案` 前置解除（定案已落，剩实现本身）。
