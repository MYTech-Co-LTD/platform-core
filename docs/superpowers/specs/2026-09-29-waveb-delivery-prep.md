# Wave B 投递准备：retail 切 L1 声明态落仓（2026-09-29）

> Issue #330 · PR #331 · 依据 #324 终评定案（seed 三件套：`cron "30 2,10 * * *"` + `timezone:"UTC"` + `misfire:"all"`）。
> 性质：**纯仓内声明态**——仓=声明，投递时只做 seed + 重建 catalog；本 PR 零生产操作。

## 改了什么

| 文件 | 改动 |
|---|---|
| `deploy/duckle/console/schedules/3120.json` | 薄壳 `panel-lemeng.retail.windows.run` → `enabled:false`；新增 `panel-lemeng.retail.windows.l1`（`30 2,10 * * *` / UTC / misfire all / catchup `{31,45}` 显式）。子管线 `lemeng.retail_order_line.window` 确认不加条目（foreach 被父调用，改前也无）。 |
| `deploy/duckle/console/owners.json` | retail 新鲜度锚 `/workspace/logs/retail-windows-run.csv` → 湖对象锚（见下）；_note ⑩ 记录换点，④ 加带日期订正指针。 |
| `deploy/duckle/console/alerts.json` | 新增 `lemeng.retail.windows.l1` 规则（failure/recovery、冷却 15）；_note ⑩。**薄壳 retail 规则保留**（见下）。 |
| `deploy/data-plane.lock` | 重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`；diff 恰好 3 条目 + sha-of-rest，manifest 不动（`deploy/duckle/console/` 递归覆盖）。 |

## 锚形状怎么定的

- **来源逐字抄形**：L1 子管线 `lemeng.retail_order_line.window` 的 `snk.minio` key =
  `lemeng/retail_order_line/system_book=${ITER_ITEM_SYSTEM_BOOK}/bizday=${ITER_ITEM_BIZDAY}/hour=${ITER_ITEM_HOUR}/all.parquet`
  （父管线 `lemeng.retail.windows.l1` foreach 逐窗写入）。
- **glob**：`minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet`——`*` 吸收
  不展开的占位符（owners ⑧ 的 duckle 0.7.4 本机实测口径：catalog 保留 `${…}` 原样）与桶名段，匹配不靠猜。
- **maximumAge 36h**：公式同 dim 两条湖锚（owners ③：日更 24h + 12h 余量）。**L1 双点火同日重写、锚按对象写时刻起算**——两轮点火写同一个「上海昨天」的 24 个 hour 分区对象（10:30 轮覆盖 02:30 轮），钟每天刷两次；36h 语义 = 一天半无一窗成功写湖才算事故。
- **tick/薄壳不污染**：它们经 wrapper 的 `/pipelines/common/` 重管线写湖，不在 console workspace catalog ⇒ 不进新鲜度钟；catalog 中唯一命中该 glob 的资产就是子管线 sink。
- **64188**：owners.json 未 seed 到 64188（⑦ 口径），无需同步。

## 两处与任务书字面不同、有依据的裁量

1. **alerts 薄壳 retail 规则保留未删**：任务书默认「被退役资产同批删」，但 alerts.json seed 到两个 console（⑤），64188 侧薄壳 retail 调度仍 enabled（`schedules/64188.json`，Wave B 只切 3120）⇒ 删规则 = 64188 日批失败静默。先例：`lemeng.dim.*.run` 在 3120 侧薄壳已 disabled 后仍保留至今，同一理由。待 64188 切 L1 的那批再一起删。
2. **新规则用精确 match 而非 `lemeng.retail.*.l1`**（L1 管线 _note ⑦ 的草稿是后者）：retail 各 face 节奏不同档（windows 日批 / tick 5 分钟 / close 日批），tick 迁 L1 时需冷却 60——宽 glob 表达不了节奏（alerts ⑨ 判据）。任务书本身也写的是精确 `lemeng.retail.windows.l1`。

## 投递时（本 PR 之外，Wave B 投递批次）

1. seed 三件套（schedules/3120.json + owners.json + alerts.json）进 3120 console 卷；
2. **重建 catalog**（Operator `POST /api/catalog`）——漏了 = 新锚「从未写入」永久 Stale（owners ②⑧）；
3. 成功跑一次 L1 后按 owners ⑤ 自检：`freshness.json` 该资产**出现且非 unknown**（object 资产 + foreach 子管线资产的时钟端到端未在生产验过，⑧⑨⑩ 的未验项——先验再切）。

## 验收

- 本地：check-data-plane-lock / lint-architecture / check-compose / check-env-example 全绿；`pnpm typecheck` 0 错；test:guard 276 passed。
- CI：https://github.com/MYTech-Co-LTD/platform-core/pull/331/checks
