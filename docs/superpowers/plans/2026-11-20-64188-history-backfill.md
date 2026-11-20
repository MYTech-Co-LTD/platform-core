# 64188 历史有界回填 Implementation Plan（#2493）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 64188 在 `max(bizday)` 前进之后才补采进湖的 2026-01 历史回填进增量 mart 链（`fct_hq_outbound` → `fct_outbound_region` / `fct_branch_indicator`），让 a2a 贡献类审计（475/2324/4280 行）转绿。

**Architecture:** 不做全史 full-refresh（全史聚合会打崩 pg_duckdb，publish-dims/全史 CTAS 两次实证）。给 `incremental_cutoff` 加**编译期窗口覆写**（`--vars` 传入 `bf_from`/`bf_to`），按月块驱动 `dbt run`，delete+insert 按 `unique_key` 精确替换该块。默认不传 vars 时宏渲染为空，**行为与现在逐字节一致**。

**Tech Stack:** dbt 1.9.1（数据单元 scheduler 容器内）、psql（取数核对）、openship service exec。

## Global Constraints

- **口径只在 dbt**：回填必须经模型本体（`dbt run`），禁止手写模型 SQL 的复制版直接 insert（#917 教训）。
- **默认零行为变化**：不传 `bf_from`/`bf_to` 时，所有宏输出为空/原值；护栏测试盯住这一点。
- **每块验收行数**：块的 mart 行数 vs 湖侧独立计数（audit 复算同口径）必须对上，不是「没报错」。
- **窗口选择**：目标月份是**封存分区**（不在 T-1/T-2 重采范围），白天跑无 ETag 竞态；但要避开
  hourly/audit 的整点窗（在每小时的 :50–:00 之间驱动，或等上轮 hourly 收口）。
- **fct_contribution 是 table**：不用手动回填，回填完上游后等次日 10:25 tables 档自动重建。

## 已确证的事实（2026-11-20 取证）

- `fct_hq_outbound` 64188 按月行数：2026-01 = **0**（2 月起 314+）。湖里有 1 月数据
  （单日样本 `2026-01-15` 复算 r=316,636.54 / n=43,843.75，mart 只有费用孤儿行 n=−356.83）。
- 根因：增量 `where bizday >= max(bizday)−10`，1 月历史在 max 前进后才进湖 ⇒ 永不进窗。
- `fct_hq_outbound` 有 4 处 `is_incremental()` 门（transfer_lines/wholesale_lines 内层、
  wholesale_dom/return_dom 子查询各一），全部要用同一对覆写。
- 下游 `fct_outbound_region`、`fct_branch_indicator` 也是 incremental cutoff(10)，读 mart 不读湖
  ⇒ 上游补完它们自己也要补同一窗。

## Task 1: 缺口清单（先量化，别假设只有 1 月）

**Files:** 无仓内改动（只读取证）。

- [ ] 在数据单元 pg_duckdb 上跑缺口清单：每个增量 mart，按 system_book 取 `min(bizday)`、
      `count(*) filter (where bizday < '2026-03-01')`，与湖侧同名 stg 视图的同窗计数对照
      （stg 视图可直接 `select system_book, min(bizday), count(*) ... group by 1`）。
- [ ] 产出 `(model, book, 缺失月)` 清单贴进 issue #2493。**只回填清单里真缺的**——
      retail 族审计是绿的，预计不缺；别顺手多补。

## Task 2: 窗口覆写宏 + 接线（默认零行为变化）

**Files:**
- Create: `dbt/macros/backfill_bounds.sql`
- Modify: `dbt/models/lemeng/marts/fct_hq_outbound.sql`（4 处门）
- Modify: `dbt/models/lemeng/marts/fct_outbound_region.sql`、`fct_branch_indicator.sql`（各 1 处门）
- Test: `apps/server/src/scheduler/registry.test.ts`（追加护栏，见下）

- [ ] **宏**（单个宏同时管下界覆写与上界注入，避免调用点写内联条件）：

```jinja
{#- cutoff_or_backfill(days) —— 增量下界：默认走 incremental_cutoff(days)；
     传了 bf_from（--vars）则压成回填下界。bf_to 由 backfill_to() 单独注入不含上界。
     不传 vars 时两宏输出与现状逐字节一致（护栏测试盯住）。-#}
{% macro cutoff_or_backfill(days) %}
  {%- set f = var('bf_from', '') -%}
  {{- ("date '" ~ f ~ "'") if f != '' else incremental_cutoff(days) -}}
{% endmacro %}
{% macro backfill_to() %}
  {%- set t = var('bf_to', '') -%}
  {{- ("and bizday < date '" ~ t ~ "'") if t != '' else '' -}}
{% endmacro %}
```

- [ ] **接线**：`fct_hq_outbound` 的 4 处门改为（transfer_lines 一处示例，其余 3 处同构）：

```jinja
    {% if is_incremental() %}
      and bizday >= {{ cutoff_or_backfill(10) }}
      {{ backfill_to() }}
    {% endif %}
```

  外层 wholesale_dom/return_dom 的 `where bizday >= {{ incremental_cutoff(10) }}` 同样换成
  `where bizday >= {{ cutoff_or_backfill(10) }} {{ backfill_to() }}`。
  `fct_outbound_region` / `fct_branch_indicator` 各自 1 处同构。
- [ ] **materialize.sh 传参口**：`mat_dbt` 调用处追加——env `MATERIALIZE_DBT_VARS` 非空时
      多传 `--vars "$MATERIALIZE_DBT_VARS"`（profiles/目标路径处理保持在 materialize.sh 一处，
      不要在容器里手工拼 dbt 命令绕开它）。默认不设该 env ⇒ 命令行与现状一致。
- [ ] **护栏测试**（registry.test.ts 里加一条纯文本断言，参照现有 audit 宏护栏的写法）：
      对上述 3 个模型文件，断言「`backfill_to()` 出现次数 == `cutoff_or_backfill(` 出现次数，
      且都 > 0」——防止只压下界不封上界（那等于全史重跑，就是崩溃路径）。
- [ ] 门禁：`check-data-plane-lock` 重生成、`dbt parse`（容器内）通过。

## Task 3: 首块回填 + 单日核对（fct_hq_outbound，2026-01）

- [ ] 在 scheduler 容器（openship service exec）驱动（经 materialize.sh 的传参口，别绕开）：

```sh
MATERIALIZE_DBT_VARS='{"bf_from":"2026-01-01","bf_to":"2026-02-01"}' \
MATERIALIZE_SCOPE=run MATERIALIZE_SELECT=fct_hq_outbound sh scripts/lemeng/materialize.sh
```

  （`MATERIALIZE_SELECT` 若 materialize.sh 无此口，就临时用 `MATERIALIZE_AUDIT_SELECT` 同型的
  机制加一个；不要为此新开裸 dbt 通道。）

- [ ] 验收（psql，对 audit 复算同口径）：`select system_book, sum(r_net), sum(n_net)`…
      重点是复算单日样本 `2026-01-15 / 64188`：回填后该日 mart 侧 r_net 应≈316,636.54、
      n_net≈43,843.75（此前是 0 / −356.83）。差 1 分以内才算过。
- [ ] 幂等复跑一次同块，行数不变（delete+insert 替换语义）。

## Task 4: 剩余块 + 下游两模型

- [ ] 按 Task 1 清单把 `fct_hq_outbound` 其余缺失月逐月跑（若 2 月上旬也有缺口，补
      `bf_from=2026-02-01, bf_to=2026-03-01` 与现有增量数据拼接核对边界日）。
- [ ] `fct_outbound_region`、`fct_branch_indicator` 用同窗口逐月跑（它们读 mart，上游已就位）。
- [ ] 每块行数验收同 Task 3。

## Task 5: 收口

- [ ] 等次日 10:25 tables 档重建 `fct_contribution`（table 物化，自动含 1 月）。
- [ ] 手动跑一轮 `data.dbt_audit_a2a`：`contribution__margin_rate/net_amount` 的 475、
      `region_l1_net/region_net` 的 2324/4280 应转绿或大幅收敛；
      `expense__loss_rate/subsidy_rate` 24,216 是 #2458 存量红，**不指望本轮转绿**，别误判。
- [ ] issue #2493 关闭条件贴验收数字；台账（helix roadmap）入账一行。

## Self-Review 检查单

- 默认零行为变化：不传 vars 时 `dbt compile` 的产物与改动前 diff 为空（抽一个模型比对）。
- 上界缺失 = 全史重跑路径：护栏测试已断言成对出现。
- 回填块与现有增量数据的边界日（块末日 vs max−10 窗口的最早日）无重叠/无缝隙：
  若缺口延伸到近 60 天内，与 lookback 窗重叠部分由正常增量自愈，块只补到重叠前。
