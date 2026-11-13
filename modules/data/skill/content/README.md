# skill content 源文件说明（不参与渲染）

本目录是平台数据 skill 指令正文的唯一事实源。`render.ts`（平台侧）与
`scripts/gen-openclaw-skill.mjs`（openclaw 构建期）只读取 `shared.md`、`<channel>.md`
以及它们 `{{include:...}}` 的 partial；**本 README 不参与渲染**。

## 逻辑 id → 通道工具名

正文只写 `{{tool:<id>}}`，渲染器按通道替换为真实工具名；未声明的 id 或未解析的占位符
直接渲染失败（不静默保留）。

| 逻辑 id | mcp 通道 | openclaw 通道 |
|---|---|---|
| `guide` | `data_agent_guide` | — |
| `harness_catalog` | `data_harness_catalog` | — |
| `search` | `search_catalog` | `search_catalog` |
| `describe_metric` | `describe_metric` | `describe_metric` |
| `describe_dataset` | `describe_dataset` | — |
| `sample_dimension_values` | `sample_dimension_values` | `sample_dimension_values` |
| `preview_query` | `preview_query` | — |
| `query` | `query_metric` | `query_data` |
| `explore_query` | `explore_query` | — |
| `explore_recipe` | `explore_recipe` | — |
| `freshness` | `get_freshness` | `get_freshness` |
| `quality` | `get_quality` | — |
| `lineage` | `get_lineage` | — |
| `query_detail` | `query_detail` | `query_detail` |
| `list_metrics` | — | `list_metrics` |

## 文件角色

| 文件 | 角色 |
|---|---|
| `shared.md` | 通道中性内容（五行硬约束），`mcp.md` / `openclaw.md` 用 `{{include:shared.md}}` 引用 |
| `mcp.md` | 平台 MCP 通道正文（含 `{{today}}`、七步工作流） |
| `openclaw.md` | openclaw 通道正文；frontmatter 由 Task 4 的 `openclaw.frontmatter.md` 提供，不写在这里 |
| `local/tenant-*.md` | 租户/部署专属内容，**只在 openclaw 渲染时**由 `openclaw.md` 的 `{{include:...}}` 拼接，不进入平台 MCP 指令面 |

`local/` 内容在原 SKILL.md 中**不连续**，因此按插入点拆成多个 partial
（`tenant-shanhai-budget.md`、`-metrics.md`、`-coverage.md`、`-topn.md`、`-columns.md`、
`-params.md`、`-drill.md`、`-ops.md` 等），每个 partial 是该位置的原文。遇到
「通用规则 + 租户示例」混在同一条 bullet 的情况，通用句留在 `openclaw.md`，租户示例
用 include 移走（允许行内 include），以保证迁移前后渲染逐字等价。

## 为什么渲染正文里不能写注释

`openclaw.md` 与 `local/*.md` 的全文都会渲染进 agent 可见的 SKILL 正文——
HTML/Markdown 注释对模型也是可见文本，会污染指令，并破坏与旧版 SKILL.md 的逐字 parity。
源文件角色、迁移说明一律写在本 README 或设计文档里，不写进被渲染的文件。
