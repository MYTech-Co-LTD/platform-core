# 租户语义写入可行性实测（2026-11-09）

> 配套设计：`docs/superpowers/specs/2026-11-09-tenant-semantic-autonomy-design.md`。
> 目的：在动手前证明「租户写库即时生效、不部署」成立，并找出必须改的点。

## 已证（本地真库 `ma_dev` + 真代码路径）

| # | 判据 | 证据 |
|---|---|---|
| 1 | 读路径每请求查库、无进程缓存 | `loadMergedCatalog` 调用点：`query-service.ts:405`、`agent-loop.ts:136`、`drill.ts:103`、`report-version.ts:224/368`、`metric-usage.ts:45`、`analysis/explore-exec.ts`、`routes/mcp.ts:63`（`tools/list` 每请求从库生成 legacy 工具） |
| 2 | 运行时写 DB 后立即可见 | 探针插入 L1 行后 `loadMergedCatalog('acme')` 与 `loadPlatformCatalog` 均命中 |
| 3 | 校验器可复用 | `semanticsYamlPieceIssues`：合法单条修改 = 0 issues；缺 `owner` = 拦下 |
| 4 | 编译器可复用 | `declarationsFromYaml` 编译 53 条；server 容器存在 `/app/scripts/sync-data-semantics.mjs` 与 `yaml@2.9.0` |
| 5 | 写前 SQL 校验可行 | pg_duckdb `EXPLAIN` 实测返回计划（不扫数据） |
| 6 | 审计/权限/总闸现成 | `data.metric_audit` + 同事务 `writeMetricAudit`；`/mcp-manage` 门=`data:manage`；`DATA_MCP_ALLOW_MUTATING` |

## 现行结构对租户的两道挡板（必须改）

1. **写侧**：`metric-write.ts:100/460` 同 id 建 L2 回 `409 ID_RESERVED_BY_L1`。
2. **读侧**：`loadMergedCatalog`（`metric-store.ts:345-350`）同 id 的 L2 行被丢弃（L1 赢）。
   `catalog-consumers.test.ts` 有对应断言，改优先级时必须同步改判。

## 不阻塞租户自治的事实

- 租户行写 `org=<租户>`，L1 同步 job 只碰 `org='platform' and source='l1'` ⇒ **不会被 job 冲掉**，
  无需改 `deleteStaleL1Metrics` / `upsertL1Metric`。
- 同 id 覆盖行与 L1 行按 `(org,id)` 主键共存，天然按 org 隔离。

## 仍待实现时验证

- 覆盖后 `required_scope` / 掩码 / 行域是否与普通指标同链（预期是，`authorizeCore` 唯一执法点）。
- `EXPLAIN` 对 `read_parquet` 湖视图的覆盖程度（能挡语法/列名，挡不住湖文件缺失——写后首查再兜）。
