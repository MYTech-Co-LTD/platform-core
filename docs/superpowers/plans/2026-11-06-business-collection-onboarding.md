# 营业收款三件套接源（T0-1）：businesscollection find / receive / coupon

> 状态：实施中（2026-11-06 起）。门禁口径见 `docs/data-platform-handbook.md` §1.3（A→I）。
> 能力清单来源：乐檬 AGI MCP `https://cloud.nhsoft.cn/agi/mcp` 的 `search_agi_abilities`（408 个能力），
> 文档取 `get_agi_ability_document`。**本计划的参数与行为全部来自这两条通道 + 真实取数，不靠猜。**

## 1. 为什么要接

现有 `branch_indicator` 只有一个汇总 `receipt_money`，回答不了「钱是怎么收的」。三件套补的是：

| 报表 | 能力码 | 补什么 |
|---|---|---|
| 门店汇总 | `report.ai.businesscollection.find` | 各收款方式金额、储值卡/兑换卡/提货卡、券、现金长短款、其他收支（~80 字段） |
| 门店收款构成 | `report.ai.businesscollection.receive.find` | **支付方式 × 业务类型**的收入金额、笔数、占比 |
| 卡券汇总 | `report.ai.businesscollection.coupon.find` | 券类型核销、券面额、兑换卡 |

## 2. 探针结论（A 段，2026-11-06 实测）

| 项 | 实测值 |
|---|---|
| 通道 | `POST https://cloud.nhsoft.cn/agi/api/<ability>`，`connectionRef=lemeng`（bearer 密文） |
| 鉴权主体 | `whoami` → `company_id` = 账套号；`branch_nums` 为可查门店全集（3120: **270** 家） |
| 必填 | `date_start` / `date_end`（`yyyy-MM-dd`，含首尾）、`branch_nums`、`summary_types` |
| `branch_nums` 上限 | **100 家/请求**（传 270 报 `10001 branch_nums 最多支持 100 家门店`）⇒ 必须分块 |
| 日期跨度上限 | 三件套均 **31 天**（.find 实测 `10002 date_start 到 date_end 的日期范围最多 31 天`） |
| 可查起始日 | ≤ 2024-11-01（实测该日有数据）⇒ 覆盖回填窗 |
| 分页 | **不分页**，一次返回全部；响应 `result = {total_count, rows[]}`，`responsePath=/result/rows` |
| 维度组合 | `summary_types` 1–2 个，去重；.find 支持 `branch/date/shift/terminal/cashier` |
| `date_type` | 可选，`bizday`（默认）/`receipt_date`；现金类三字段仅在 `bizday` 返回 |
| receive 额外必填 | `order_types`：`已结账单/卡存款/其他收支/会员换卡/会员续卡/付费会员/次卡` |
| 权限 | 需 `营业分析-营业收款-营业收款报表-查询`；本租户 PAT 已具备（实测有行） |

**实测行数**（3120，2026-11-01~03）：`.find` 门店维 5 行 / 日期维 3 行 / 班次 6 行 / 收银员 9 行；
`.receive.find`（branch×payment_type）12 行；`.coupon.find`（branch×coupon_type，10 月全店）2 行。

## 3. 选型（B 段）

**duckle 原生 `src.rest` + `ctl.foreach`**（三档判据：①引擎有 ⇒ 首选）。
沿用 `lemeng.branch_indicator.{day,l0}` 的既有形态**逐字复用其骨架**：

- 身份门：`whoami` → 账套/门店清单自证（`gf`+`di`），未过则**一个采集请求都不发**；
- 分块驱动：由 whoami 的 `branch_nums` 按 100 家切块（`drv`），`ctl.foreach` 逐块跑子管线；
- 子管线：单块请求 → 网关 code 闸 → `total_count == rows` 闸 → 逐门店左连接（含无数据门店占位）→ staging 分块；
- 父级汇总：分块到齐闸 → 每块落盘门店数 == 自报匹配数 → 全空闸 → 契约闸 → sink。

**不选**：静态页节点（`branch_nums` 需运行期按 whoami 切片，`${ENV:}` 无法表达切片）；
原生分页（接口不分页）。

## 4. 湖布局与契约（C/D 段）

```
s3://<bucket>/lemeng/business_collection/{system_book=<b>/bizday=<d>/all.parquet}
s3://<bucket>/lemeng/business_collection_receive/{system_book=<b>/bizday=<d>/all.parquet}
s3://<bucket>/lemeng/business_collection_coupon/{system_book=<b>/bizday=<d>/all.parquet}
```

- 粒度：`.find` = 一门店一日一行；`.receive` = 一门店×支付方式一日一行；`.coupon` = 一门店×券类型一日一行。
- 列集唯一事实源 = `contracts/common/lemeng.business_collection*.json` 的 `expr`；
  管线 `shape`/`s` 的 select 列表由 `gen-data-projection.mjs` 生成，**不手改**。
- 首版列集取「业务要用的子集」（不追 80 字段全量），后续扩列走正常迁移。

## 5. 文件清单（D/E 段）

| 文件 | 作用 |
|---|---|
| `deploy/duckle/console/pipelines/lemeng.business_collection.day.{3120,64188}.json` | 子管线（单块） |
| `deploy/duckle/console/pipelines/lemeng.business_collection.l0.{3120,64188}.json` | 父管线（身份门 + 分块 foreach + 汇总落湖） |
| `lemeng.business_collection_receive.*` / `..._coupon.*` | 同上两件套 ×2 |
| `contracts/common/lemeng.business_collection*.json` | 列集正典 |
| `deploy/duckle/console/schedules/{3120,64188}.json` | 加日更条目（T-1） |
| `scripts/lemeng/gen-backfill-variants.mjs` | `TARGETS` 加三条 ×2 账套 ⇒ 派生 `backfill` 变体 |
| `scripts/console-schedules-tz.test.ts` | 期望条目数同步 |

## 6. 验收（F 段）

1. `duckle validate_pipeline` 过（父 + 子 ×2 账套）；
2. 单日 run 绿 **且** 湖侧 `count(*) > 0`，与源端 `total_count` 对平；
3. 门店覆盖：落湖 `count(distinct branch_num)` == whoami 中有数据的门店数；
4. 回填 1 天（2026-11-05）两账套，与源端同日对数；
5. `check-data-contract` / `check-console-schedules` / `check-data-plane-lock` 全绿。

## 7. 排班与回填（E/H 段）

- 日更：T-1，与既有多数报表同批；
- 回填：走 `gen-backfill-variants.mjs` 派生 `${BIZDAY}` 变体，`backfill-history.py --dataset business_collection`；
- **先夜间预备役队列**，不抢白天物化窗口。

## 8. 回滚

管线停调度即可（湖里已有分区不动）；契约与 dbt staging 一并回退。
