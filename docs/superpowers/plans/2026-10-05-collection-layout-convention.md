# 采集管线的布局与命名约定（新账套 / 新客户 / 新源系统 怎么加）

> **性质**：这是**规划与约定**（先落盘，后面照此执行）。形态与选型的正典仍是
> `docs/data-platform-handbook.md` §1.1.7；投递程序是 `deploy/data-plane-deploy-sop.md` §E/§F.2；
> 逐文件的 seed 清单在 `deploy/duckle/console/DELIVERY.md` §0.2。**本文不复述那几份的正文。**
> **状态**：2026-10-05 定；**尚未执行任何结构改动**（下文标了触发条件的，到点再做）。

## 0. 一句话

**管线的命名空间写在「文件名前缀」里，不写在目录里；客户与账套的差异只活在 `env` + `connections/` + `schedules/<账套>.json`。**

## 1. 地基（先钉事实，避免照直觉规划）

两条实测/源码证据，决定「能不能分目录」：

| 证据 | 结论 |
|---|---|
| `crates/scheduler/src/lib.rs:209`：`workspace.join("pipelines").join(format!("{pipeline_id}.json"))` | 调度器**平铺**解析排班条目：`pipelines/<pipeline_id>.json`，**排班条目里没有路径字段** |
| `crates/duckdb-engine/src/plans.rs:257` `step_pipeline_id`：只剥前缀 `pipelines/` 与后缀 `.json`，**不塌目录** | id 可以含目录 ⇒ 嵌套**技术上可行** |
| console 实测：把管线放进 `pipelines/_layouttest/` 后用带目录的 `file` 跑 | `status=ok`，但 `pipelineId` 只剩 **stem**（目录被丢掉），运行记录落 `runs/<stem>.json` |

⇒ **`id ↔ pipelines/<id>.json` 是平铺双射**（这是今天能用、且所有引用点都依赖的形状）。
⇒ 若真要分目录，id 变 `lemeng/retail.tick.l1`，连带要改：`schedules` 的 `pipeline_id`、运行记录路径、运行锁键、
`owners.json` 的资产匹配、脚本里的 `file` 值、CI 守卫的扫描面；**而且手动跑（丢目录）与调度跑（带目录）会推导出两个不同的 id** ⇒ 运行记录/锁分裂。
**收益（目录好看）远小于风险 ⇒ 不做。**

## 2. 约定（定稿）

### 2.1 路径与命名

```
deploy/duckle/console/
├ pipelines/                     ← 平铺，永远只有一层
│   lemeng.dim.branch.l0.json
│   lemeng.dim.item.l0.json
│   lemeng.retail.windows.l1.json
│   lemeng.retail.tick.l1.json
│   lemeng.retail.close.l1.json
│   lemeng.retail_order_line.window.json     ← 子管线
│   lemeng.retail_order_line.tick.json
│   lemeng.retail.windows.backfill.json      ← 不进调度的变体
│   <下一个源系统>.*.json                    ← 新源系统就加新前缀
├ schedules/
│   3120.json  64188.json  <新账套>.json     ← 扁平：账套号在 provider 侧全局唯一
├ owners.json        ← 见 2.3（将来按源系统拆）
└ alerts.json        ← 同上
```

**管线文件名形状**：`<源系统>.<域>.<层>` + 可选 `.<变体>`，例：`lemeng.retail.tick.l1`、`lemeng.dim.item.l0`、`douyin.sku.daily.l0`。
**`id` = 文件名去 `.json`**（引擎就是这么推的）⇒ 命名即 id，**改名 = 换 id = 换运行记录名**，别随手改名。

### 2.2 三类差异各归谁

| 差异 | 归哪 | 例子 |
|---|---|---|
| **源系统**（端点 / 契约 / 方言 / 分页 / 窗口语义） | **文件名前缀** | 乐檬 = `lemeng.*`；抖音 = `douyin.*` |
| **客户 / 账套**（账户号、可见门店、桶、凭据） | **`env` + `connections/` + `schedules/<账套>.json`** | `SYSTEM_BOOK` / `BRANCH_NUMS` / `ZOS_*` 走容器 env；凭据走 `connectionRef` |
| **湖落点**（桶 / 前缀） | **`env`** | sink 的 `bucket`/`key` 里带 env 占位符 |

### 2.3 `owners` / `alerts` 按源系统分文件（✅ 已于 2026-10-05 提前拆掉，#419）

- **对「同源系统的新客户」不构成阻塞**：锚串里桶与 `system_book` 都是 env 参数化的 ⇒ 一份文件服务多个客户。
- **对「新源系统」构成阻塞**：锚串中间那段源系统路径前缀（`lemeng/dim_branch`）是写死的，新源系统匹配不到。
- ✅ **已拆（#419）**：`owners.<源系统>.json` / `alerts.<源系统>.json`（今天 = `*.lemeng.json`）；
  seed 时按「客户 → 源系统」选源文件，**落地名不变**（引擎只认 `owners.json` / `alerts.json`）—— 见 `DELIVERY.md §0.2`。
- **配套**：CI 守卫 `check-duckle-catalog` 会读源目录里**全部** `owners.<源系统>.json` 并**合并**成工作区的
  `owners.json`（同一 `match` 两条规则 ⇒ 响亮失败）；一个都没有 ⇒ 仍 exit 2（不许降级成只判命名）。

## 3. 四条扩展清单（照抄执行）

### ① 新账套（同客户 · 同源系统）——今天就支持，零管线改动

1. `deploy/data-compose.yml`：照 `lemeng-console-3120` 抄一个 service `lemeng-console-<book>`，
   挂新卷 `lemeng-console-<book>-ws`；env 换该账套的账户号/门店清单/桶/密钥（键名带账套后缀，如 `ADOPTED_SOURCES_<book>`）。
2. `deploy/duckle/console/schedules/<book>.json`：照 `3120.json` 抄，`pipeline_id` **照原样**（管线文件是共用的）。
3. 卷内 `connections/` 用**会加密的写入方**建该账套的连接（`scripts/duckle/connection-setup.py`），**禁用 MCP 的明文写入**。
4. 投递：sync → seed（`schedules/<book>.json` 改名落 `/workspace/schedules.json`）→ 重建 catalog → 重启 → 五点验收。
5. **不改**：任何 `pipelines/*.json`。

### ② 新客户（不同客户 · 同源系统）——管线共用，客户参数各自一套

同 ①，外加：客户的桶/前缀不同的话只改 env（锚是参数化的，`owners.json` 不用动）。

### ③ 新源系统（新渠道）——新前缀，不动老文件

1. 新增 `pipelines/<新源系统>.<域>.<层>.json`（形态照 §1.1.7 选 L0 / L1）。
2. 新源系统自己的**身份门、窗口表、定型、契约**（「必须自己写」那一栏）新写一遍。
3. 新增该源系统的连接（**新 `connectionRef`**，不与乐檬共用）。
4. **触发 2.3 的拆分**：`owners.<新源>.json` / `alerts.<新源>.json`，并写清 seed 的选取规则。
5. 新 console 服务 + 新卷 + 新 `schedules/<账套>.json`（同 ① 的投递与验收）。

### ④ 新落点（桶 / 前缀 / 湖根）

只改 env（sink 的 `bucket`/`key` 与 `owners.json` 的锚都吃 env）⇒ **不动管线文件**。若换了**存储类型**（非 S3 兼容），才需改 sink 组件。

## 4. 明确不做

| 不做 | 原因 |
|---|---|
| 在 `pipelines/` 下按源系统/客户分目录 | §1：`id ↔ pipelines/<id>.json` 平铺双射，分目录会改 id 并引发手动/调度两条推导分裂 |
| 按客户复制整套管线 | 8 条 × N 客户 = N 份要同步维护，与「降工作量」相反 |
| 改管线文件名以「整理命名」 | 改名 = 换 id = 换运行记录名与 owners 匹配面；只在新增时按 §2.1 起名 |

## 5. 生产影响与执行窗口（改结构时照此判）

- **不改就不影响**：本约定不动任何现有文件。
- 一旦真改结构（如 2.3 的拆分），影响面 = **数据面检出里的文件与引用点**，**不是湖里的数据、不是契约、不是批次语义**。
- 三条风险与对策：
  1. 旧路径找不到文件 ⇒ 该管线下一次点火**直接红**（可见、fail-fast）。对策：改完**当场**手动跑一条五点验收。
  2. seed 清单没同步改 ⇒ 卷里新旧路径**并存**，同一管线两条定义（**这条最阴**）。对策：seed 是**整文件覆盖**，清单与文件必须同批改。
  3. `pipeline_id` 若被改 ⇒ 运行记录文件名与 `owners.json` 匹配同时变（新鲜度锚短暂失配）。对策：**rename 绝不与结构改动同批做**。
- 执行窗口：避开场次 —— UTC 02:30 / 10:30（日批双点火）、16:00（close）与整点 tick。

## 6. 现在做什么 / 到点做什么

| 时点 | 动作 |
|---|---|
| **现在（本规划）** | 只落这份约定 + 在 `DELIVERY.md §0.2` 加一行指针；**不动目录、不动文件名** |
| 第一个新账套 | 按 §3① 走（零管线改动） |
| 第一个新客户（同源） | 按 §3② 走 |
| 第一条非乐檬源 | 按 §3③ 走，并**同批**做 2.3 的 `owners/alerts` 拆分 |
