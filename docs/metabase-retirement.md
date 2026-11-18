# Metabase 退役记录（2026-11-18）

> 结论：**Metabase 在自助报表里已无生产使用**，按「归档 → 停机 → 代码清理」三步退役。
> 本文是唯一台账：证据、归档校验和、各阶段状态。

## 1 证据（2026-11-18，两台实例实测）

| 证据 | 山海（platform-core-shanhai） | mytech（platform-core） |
|---|---|---|
| 平台报表表里的 metabase 行 | **1**（未发布，0 访问） | 无 |
| Metabase 内容 | 42 问题（**39 条是自带 Examples**）、2 看板（1 条 Examples） | 39 问题（**全部 Examples**）、1 看板 |
| 真实查询执行 | 35 次，最后一次 **2026-10-26**（23 天前） | **0 次** |
| 内容最后修改 | 2026-10-03 / 10-07 | — |
| 平台自绘报表（替代面） | 2 张（1 已发布） | — |

配合「退役三步门槛」：

1. **替代通道已建**：平台自绘已覆盖宽表（多度量）、交叉表（多指标）、条件格式、目标线、AI 叙事、
   模板、Excel 导出、权限/部门门、新鲜度、版本——即 `2026-11-17-spreadsheet-analysis-roadmap.md` 的 W1–W4；
2. **消费面已切走**：无已发布 metabase 报表、0 访问；
3. **观察期已过**：最后活动 2026-10-26，已超 3 周。

## 2 归档（先备份，后停机）

| 实例 | 归档路径（宿主） | 大小 | sha256 |
|---|---|---|---|
| 山海 | `/opt/openship-archive/metabase-shanhai-20261118.sql.gz` | 3.9M | `cfa172f092fef0558f797557ae4a94311c3954d0553532c5fb257ac589489d7d` |
| mytech | `/opt/openship-archive/metabase-mytech-20261118.sql.gz` | 1.5M | `9e8295b3ce2a95dd3144a9cc4c60cb943d46d90af2e08e09c4d40a9a8ebc8ba0` |

归档内容 = Metabase 应用库全量（`pg_dumpall`），包含看板/问题/用户/权限**定义**。
⚠️ 归档只解决「可回滚」，不替代业务数据的备份（业务数据在 `pg_duckdb` / 对象存储，与 Metabase 无关）。

## 3 阶段与状态

| 阶段 | 动作 | 状态 |
|---|---|---|
| **A 退配置** | `deploy/data-compose.yml` 移除 `metabase` / `metabase-db` 服务与 `mbdata` 卷声明；保留宿主卷（延后删除） | ✅ 2026-11-18（PR 见提交记录） |
| **B 停机** | 两台实例 `docker stop && docker rm` 两个容器；确认站点/报表不受影响 | 待 A 合并后执行 |
| **C 代码清理** | 移除 `domain/metabase.ts`、embed-url/edit-url/reconcile 路由与测试、移动端引用；`renderer` 枚举保留历史兼容，存量行另行迁移 | 待办（独立 PR，需回归全量门禁） |
| **D 删卷** | `docker volume rm` `mbdata` 卷（**不可逆**，需点名） | 待观察期后再议 |

## 4 影响面与不做的事

- 不影响：平台自绘报表、采集/物化、AI 叙事、凭证导出（CSV/xlsx）、权限与部门门。
- 失去的能力：任何会用 SQL 的人直接拖 Metabase 看板。经评估该路径已无人使用；数据团队的临时探索走
  `duckle` / askdata / MCP，且必须遵守「口径不重声明」的纪律。
- **不做**：不在本轮删除 `renderer='metabase'` 的数据库约束与历史行（避免大范围 schema 迁移）；
  历史行在代码清理阶段统一迁到自绘或回收，迁移前保持只读。

## 5 回滚

A/B 阶段均可回滚：恢复 compose 两个服务 + 用上表 dump 恢复 `metabase-db` 即回到退役前状态。
D 阶段（删卷）之后，回滚只能依赖归档 dump 重建（数据可恢复，但需人工）。
