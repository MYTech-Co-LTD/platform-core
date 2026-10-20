# 零售明细：小时分区 → 天分区（2026-10-20 设计稿 · 待评审）

> **一句话**：今天仍按小时写（tick 不动）；**关闭日一律按天写**——整天重采一次、落**一个天文件**。
> 读侧两条 glob 天然不重叠。历史一次性重采换布局。
>
> **收益**（步 0 实测推算）：明细湖文件数 **1,344 → ~102**；全史冷读 **11.14 s → ~0.8 s**；
> 典型 4 天查询 **2.09 s → ~0.06 s**。
>
> **本稿只到设计**。按本仓规矩（架构先行）与用户 2026-10-20 的裁决：
> **先评审本稿 → 改架构文档 → 再写码**。**尚未动任何生产件。**

---

## 0 决策与依据

| 项 | 内容 |
|---|---|
| 拍板 | 用户，2026-10-20：「按 B 做」+「从明天开始都是按天分区，等到明天重采前面的」 |
| 形态 | **今天按小时（tick 不变）；关闭日按天（整天重采 → 一个天文件）** |
| 不做 | 不引入表格式（见 `specs/2026-10-20-lake-format-decision.md`）；不做「小时文件合并」（不合并、只重采） |
| 承重前提 | **步 0 探针已实测通过**（§2）：整天取数可行、50 页扇出 39.8 s 出 8,850 行且逐行对得上 |

---

## 1 为什么要做（成本模型，2026-10-20 实测）

读湖成本 ≈ **8 ms × 文件数**，与行数无关、与线程数无关（`threads_for_postgres_scan` 2→16 无改善）。
文件数 = **2 账套 × 24 小时 × 天数 = 48/天**。

| 查询范围 | 现状文件数 | 现状耗时 | 改后文件数 | 改后耗时 |
|---|---|---|---|---|
| 1 天 | 48 | 0.53 s | 2 | ~0.02 s |
| 4 天（典型 bot 查询） | 192 | 2.09 s | 8 | ~0.06 s |
| 全史 28 天 | 1,344 | 11.14 s | ~102 | ~0.8 s |

**明细是全湖唯一的小时分区资产**（其余 17 份契约都是 `[system_book, bizday]` 或 `[…, snapshot]`），
也是唯一慢的。对照 `stg_lemeng_item`：行数多一倍（100 万），但按 `snapshot` 只有 56 个文件 ⇒ 24 s。

---

## 2 步 0 实测（承重事实，全部真机）

| 问题 | 答案 |
|---|---|
| 整天窗口取数（`time_from 00:00:00` → `23:59:59`） | ✅ 通 |
| 50 页并行扇出整天 | ✅ `status ok`，**39.8 s**，**8,850 行**（= 44×200 + 50，与分页探测逐行对上） |
| **96 页并行扇出整天**（设计目标值） | ✅ `status ok`，**66.5 s**，**8,850 行**，99 节点；容器 `OOMKilled=false Restarts=0`（2026-10-20 补测） |
| `page_size` 上限 | **200 硬顶**（250 → `code:40000`） |
| 深页上限 | ❌ 无（page 45 = 50 行自然结束，47+ 空） |
| 信封有 `total`？ | ❌ 只有 `{code, msg, trace_id, result}` |
| `src.rest` 原生 `paginationType: page` | ❌ **不可用**——它把页码放 **query string**，本 API 要求页码在 **JSON body**（缺了报 `不能为null->[pageNumber:null]`）；`{page}` 占位符**不替换进 body**（实测 body 里原样留着，API JSON 解析直接炸） |
| 空页/越界页 | 🔴 返回 `code:0` + 空数组，**不带错**（静默截断的形状） |
| 空页在管线里的后果 | 🔴 **硬错**：`query returned 0 records and no schema is declared to type an empty result` ⇒ **必须申报 `data.schema`** |
| N 路汇流 | ⚠️ **订正（2026-10-20 复核）**：初记「`ctl.merge` 会静默丢 49 路」**是错的**——那是**探针的边形状写错**（N 条边全挂 `targetHandle: main`，即挂到了**输出**端口）。`ctl.merge` 的入端口是 **`main_1`/`main_2`/`main_3`…（动态扩展）**，**逐路用 `main_N` 即可**，现有 12 路管线就是这么接的且出数正确。⇒ **本设计用 `ctl.merge` + `main_N`**：它同时也是 `check-data-contract.mjs` 规则 ④ 唯一认的汇流点（用别的汇流件会让「申报面」检查**静默逃检**） |

规模（3120 / 2026-10-17）：**8,850 行 = 45 页**，单页 **1.2–1.5 MB JSON** ⇒ 整天约 **60 MB**。
历史峰值：2026-10-18 两账套 19,405 行 ⇒ 单账套约 13.2k 行 = **66 页**。

---

## 3 设计

### 3.1 布局

```
lemeng/retail_order_line/
  system_book=<book>/bizday=<Y>/hour=<HH>/all.parquet   ← 热：**只有今天**（tick 写）
  system_book=<book>/bizday=<Y>/all.parquet             ← 冷：关闭日，每账套每天 1 个
  _DAILY/system_book=<book>/bizday=<Y>.parquet          ← 封版标记
  _SCHEMA/v3.parquet                                    ← 既有（表根，不在读 glob 射程内）
```

⚠️ **标记必须放表根**（`_DAILY/` 而不是 `bizday=<Y>/` 下面）：读 glob 是
`system_book=*/**/*.parquet`，标记落在 `bizday=` 下会被**当数据文件读进来**。`_SCHEMA/v3.parquet`
就是因为这个原因放表根的（既有模型头注有原文记录）。

**不重叠的性质**：天文件只有关闭日有；小时文件只有「今天 + 尚未重采的昨天」有。

### 3.2 写侧

| 谁 | 何时 | 写什么 | 变化 |
|---|---|---|---|
| `lemeng.retail.tick.l1` | `*/5 8-23`（上海） | `hour=<HH>` 当前+前一小时 | **不变** |
| `lemeng.retail.close.l1` | `0 0` | 昨日最后一小时（`hour=`） | **不变** |
| **新增** `lemeng.retail_order_line.day` | 排在 `windows.l1` 之后 | **整天重采 → `bizday=<Y>/all.parquet` + 封版标记** | **新增** |
| `lemeng.retail.windows.l1` | `30 10,18` | 现状：对昨日**逐小时**24 次写 `hour=` | **改为整天重采**（见下） |

**`windows.l1` 的改法**：它的窗口本来就是「昨日 00–23 时」（`generate_series(0,23)`），
只是拆成 24 次按小时取写。改成**一次整天取、写一个天文件**。

**关键优点**：整天重采**不依赖小时文件存在**（它重新调 API），所以
① 重采可无限次重跑；② **删小时目录与重采互不影响**；③ 重述/heal 复用同一条管线即可。

### 3.3 读侧

两条 glob + **排除已封版日子的小时行**：

```sql
-- 冷：已封版的天文件
select <生成器产的投影> from read_parquet('<prefix>/system_book=*/bizday=*/all.parquet') r, <封版断言> sealed
where sealed['schema_version'] = 3
union all
-- 热：未封版日子的小时文件
select <生成器产的投影> from read_parquet('<prefix>/system_book=*/bizday=*/hour=*/all.parquet') r, <封版断言> sealed
where sealed['schema_version'] = 3
  and not exists (select 1 from read_parquet('<prefix>/_DAILY/*.parquet') m
                  where m['system_book'] = r['system_book'] and m['bizday'] = r['bizday'])
```

**为什么必须带排除**：删小时目录（§3.4）与「写天文件」之间必然有一个**两者并存**的窗口。
没有排除 ⇒ **双算**；有排除 ⇒ 删除失败只是**变慢**，不会错数。**正确性与删除时机解耦。**

> **待裁决的取舍**（本稿唯一未定的设计点）：上面这个形状需要
> `gen-data-projection.mjs` 支持**一个模型里两处投影**（现在是单处）。
> 备选是**编译期算文件清单**（`run_query` 列 `_DAILY/` → `read_parquet([...])` 单个调用），
> 生成器零改动，但会让 `dbt parse` 依赖湖可达。**推荐前者**（生成器小改 vs 让 parse 联网）。

### 3.4 删小时目录（③档，需手搓）

- duckle **没有删除对象的能力**（`list_components` 查 delete/remove/cleanup/drop = **0 条**）。
- 时机：天文件**封版之后**，删该日 `bizday=<Y>/hour=*/`（24 个对象/账套）。
- **失败不影响正确性**（§3.3 的排除兜底），只影响速度 ⇒ **fail-soft**，但要有告警。
- 实现形态：纯标准库 SigV4（本仓有先例，2026-10-19 清旧湖资产那次）。
- **登记**：`duckle/README.md` §7.4.1 已有「纯 parquet 湖的 compaction / 事务目录」一行，
  本条并入该行（同一根因）。

### 3.5 重述 / heal 改按天

现状 `recon-day-heal.sh` / `recon-restate.sh` 是**按小时** heal（窗口 T-3..T-9）。
按天分区之后，按小时写会造出「天文件 + 小时文件并存」⇒ 靠 §3.3 的排除虽然不错数，
但**heal 的结果会被排除掉**（封版日子的小时行不读）⇒ **修数不可见**。

⇒ **heal/restate 改为「整天重采 + 重写天文件」**（复用 §3.2 的同一条管线）。

### 3.6 契约

- `contracts/common/lemeng.retail_order_line.json` 的 `layout.partitionBy`：`[system_book, bizday, hour]` → **`[system_book, bizday]`**。
- `hour` **已经是 `flatten` 产出的列**（`CAST(date_part('hour', …) AS INTEGER) AS hour`），
  去掉分区后它自然落回**文件体** ⇒ **列集不变、语义不变**。
- sink 的 `key` 模板去掉 `/hour=${ITER_ITEM_HOUR}`（**注意：分区路径写死在 sink key 里，不是从契约推导的**）。
- ⚠️ 契约的 `layout` 是**单数**——它表达不了「今天小时 + 关闭日天」的混合布局。
  **这是本设计对契约模型的一处压力**，见 §6 风险 1。

### 3.7 容量哨兵（必须有）

越界页 `code:0` + 空数组、**不带错** ⇒ 不设哨兵就是静默截断（本仓 D14/D17 那类）。

- 扇出 **96 页**（19,200 行，覆盖历史峰值 66 页的 1.5 倍）。
- 第 96 页单独走一路 `count(*)` → **`ctl.die` 若非 0**：说明第 96 页有数据 ⇒ 可能被截断 ⇒ 响亮失败。
- 每个取数节点**必须申报 `data.schema`**（否则第一个越界页就把 run 打红）。

---

## 4 迁移（历史一次性重采）

| 步 | 做什么 | 可回滚 |
|---|---|---|
| 0 | 本 spec 评审 → 改 `docs/architecture.md`（§5.1/§5.2 相应处 + 新节） | — |
| 1 | 契约 + sink key + 新增整天取数管线（96 页 + `data.schema` 申报 + `ctl.merge`(`main_N`) + 哨兵） | 可（改回按小时） |
| 2 | **读侧两条 glob + 排除**（此时历史仍小时分区，**性能未变**，但读侧已能同时吃两种布局） | 可 |
| 3 | **一次性重采历史**：逐日整天重采 → 写天文件 → 封版 → 删该日小时目录 | 天文件是新增；**删小时是唯一不可逆步** ⇒ 放最后、先 dry-run 比对 |
| 4 | `windows.l1` 改整天；heal/restate 改按天 | 可 |

**步 2 完成即可验证读侧正确性（新旧布局混读、逐行比对）**，步 3 才产生收益。

---

## 5 验收

**本机**：`pnpm exec tsx scripts/check-*.mjs` 全套 + `gen-data-projection --check` + `test:guard`
+ `data-plane-lock.mjs`（动 `dbt/`、`contracts/`、`deploy/duckle/` 必跑）。

**真机**（数据面机，经 openship MCP）：

1. 新管线真跑一次：整天 96 页 → 天文件落盘、**行数与湖侧当日行数逐行对等**。
2. 哨兵**变异验证**：故意把页数降到 20 ⇒ run 必须**红**（不是静默少数据）。
3. 读侧：同一天「天文件」与「小时文件」**逐行比对相等**（混读期）。
4. 冷读耗时：4 天查询 < 0.2 s、全史 < 2 s。
5. 重述链路：对一个已封版的日子跑一次 heal ⇒ 天文件被重写、值正确。
6. `recon_run`/`recon_break` 逐店值与改前一致（**硬不变式：值不能变**）。

---

## 6 风险 / 未验

1. **契约的 `layout` 表达不了混合布局**（§3.6）。要么扩契约（加「热/冷」两段），要么让契约只声明列集、布局交给读侧的两条 glob。
   ⚠️ **扩契约 = 动 §5.2 的四件套**，属架构变更，须单独裁决。**未验。**
2. **`gen-data-projection.mjs` 单投影假设**（§3.3 的待裁决点）。**未验。**
3. ~~**单次 run 的内存**：整天 ~60 MB JSON、96 路扇出。实测 50 页峰值跑通（39.8 s），96 页**未测**。~~
   ✅ **已测（2026-10-20）**：96 页扇出 `status ok`，**66.5 s**，行数正确，容器未 OOM、未重启。
   仍**未测**的是**双账套同时跑**（两个 console 各跑一次，数据面机 4 核）——排班上要错开。
4. **删小时目录是唯一不可逆步**。虽然读侧排除兜住正确性，但删错日子 = 源文件没了（天文件还在，可重采，所以**可恢复**——这一点比合并方案强）。
5. ~~**既有隐患**（与本次无关）：现有 tick 的 `p1..p12` **都没有申报 `data.schema`** ⇒ 若某小时**零订单**，第 1 页空 ⇒ 该小时子 run 报 `no schema is declared to type an empty result`。~~
   ✅ **撤回（2026-10-20 复核）**：现有 `p1..p12` **每一路都申报了 `data.schema`**（10 个字段：`order_no`/`state`/`order_time`/`order_operate_time`/`order_source`/`order_transaction_type`/`order_ref_billno`/`order_total_money`/`branch`/`pos_order_details`）。
   先前判「没申报」是**看漏了**——schema 在 `node.data.schema`，与 `node.data.properties` 是**兄弟**，我只打了后者。**空页在现有管线上本来就已被申报兜住，不是隐患。**
6. **`close.l1` 与 `windows.l1` 的职责重叠**未完全理清（前者补昨日 23 时，后者重采昨日全天）。本设计**不动 close**，但它写的小时文件会在 windows 整天重采后被排除 + 删除。**待确认无副作用。**

---

## 7 非目标

- 不引入表格式（已单独否决，见 `specs/2026-10-20-lake-format-decision.md`）。
- 不做小时文件「合并」（重采取代合并）。
- 不改其它 17 个资产的布局（它们本来就是天/快照分区）。
- 不改 tick 的取数窗口与频率。

---

## 8 关联

- 前序决策：`specs/2026-10-20-lake-format-decision.md`（湖保持纯 Parquet）
- 读侧形态的前序设计：`specs/2026-09-26-detail-read-view-design.md`（明细直读视图；其 gate 2 已销）
- 湖 schema 演进正典：`docs/architecture.md` §5.2（四件套 + 展开→迁移）
- 缺口登记：`duckle/README.md` §7.4.1
- 重述窗口：`docs/data-platform-handbook.md` §1.4.1
