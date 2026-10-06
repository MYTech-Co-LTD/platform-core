# 契约生成器（contracts → 生成物）设计

- 日期：2026-10-06
- 状态：**设计已获用户确认（2026-10-06），本文为实现前的设计稿**
- 关联：`docs/data-platform-handbook.md` §1.1.2 / §1.2（B10）/ §1.3 阶段 C、D；`docs/architecture.md` §4.1（B10）/ §5.1 / §5.2；`contracts/README.md`；`scripts/check-data-contract.mjs`
- **本文回答**：怎么把「湖的列集」从**四个手同步面 + 事后门禁**改成**一个事实源 + 生成物**，且**改造存量时不改生产行为**。
- **无案例不立标准**：本文形态以 **3 份现存契约**（`retail_order_line` / `branch` / `item`）为案例。实现须**先开 issue**（feat 类）。

---

## 0 现状：湖列集的四个手同步面

| # | 面 | 在哪 | 谁写 |
|---|---|---|---|
| ① | **契约**（意图源） | `contracts/<域>/<源>.<表>.json` 的 `columns[]` | 人 |
| ② | **声明面** | 管线 `src.rest` 节点的 `data.schema`（源侧字段，空响应按它构造） | 人（桌面 canvas 配） |
| ③ | **生产面** | 管线投影节点（`code.sql`）的 `SELECT … AS …` | 人（桌面 canvas 写 SQL） |
| ④ | **消费面** | dbt `stg_<域>_<表>.sql` 的投影（去注入列 `org`） | 人 |

一致性由 **B10 门禁**（`scripts/check-data-contract.mjs`，在 `gates` 跑）**事后**保证：③ 要求「唯一一个 `code.sql` 的输出别名序列 == 契约列序」；④ 要求「去 `org` 后是契约列的同序前缀，按 `consumerVersion` 判」；②是「投影里引用的 `<别名>.<字段>` 必须在喂它的 `src.rest` 的 `data.schema` 里声明」。

⇒ 病：**加一列要改四处**（手册 §1.1.2「加一列改 5 处」），B10 只事后抓。且 ② 有一类**静默面**——`data.schema` 漏改时**只有空响应会炸**（看着像偶发失败）。

---

## 1 目标与成功判据

**一个事实源 = `contracts/*.json`**。改契约一处 → 跑生成器 → **③ 生产面**与 **④ 消费面**自动重写；B10 从「查四面是否一致」**降级**为「生成物没被手改」。

可验收判据：

1. **确定性**：同输入同输出；`--check` 在「生成物 == committed」时 exit 0，否则非零。
2. **存量回填后，③ 逐字节等于今日 committed 版**（零 diff = 反抽没漏项）。
3. **不改生产行为**：③ 的列序（名 / 类型 / 次序）逐列不变。

---

## 2 设计

### 2.1 契约新增 `columns[].expr`

每个契约列加一个 `expr`：**从投影节点的输入关系到该列的完整 SQL 表达式**（逐字，含 cast）。`type` **不废**——它仍驱动 ④ 的 `::type` 与 lake 语义。

```jsonc
{ "name": "sale_money",  "type": "decimal", "precision": 14, "scale": 2, "nullable": true,
  "expr": "CAST(json_extract_string(u.d, '$.order_detail_money') AS DECIMAL(14,2))" }
{ "name": "batch_id",    "type": "varchar", "nullable": false,
  "expr": "'${ITER_ITEM_BATCH_ID}'" }
{ "name": "system_book", "type": "varchar", "nullable": false,
  "expr": "'${ITER_ITEM_SYSTEM_BOOK}'" }
```

- **注入列也是列**（`batch_id` / `system_book` / `bizday` / `hour` 等）⇒ 一视同仁，都有 `expr`。
- `expr` 里可以带 `${ITER_ITEM_*}` / `${ENV:*}`（现状就是这样——`flatten` 节点里这批列的字面表达式已是此形）。
- 契约因此从「意图」往「实现」靠一步：这是**用户拍板**的取舍（见用户确认记录：选「契约吸收『怎么来』」）。与 B10 既有口径（**湖的列集唯一事实源 = `contracts/*.json`**，`docs/architecture.md` §4.1）一致。

### 2.2 生成器 `scripts/gen-data-projection.mjs`

对齐既有范式 `scripts/gen-console-registry.mjs`（生成 → committed → CI 查「生成物 == committed」）。

**输入**：`contracts/**/*.json` + `deploy/duckle/console/pipelines/*.json` + `dbt/models/**`。

**对每个契约**：

1. **定位产出管线（producers）**：凡有一个 `snk.*` 节点的 `bucket`/`key` 里含本契约 `layout.prefix` 的管线，即产出管线。**复用 B10 规则② 的判据**——`snk.*` 限定**排除读者**（`lemeng.recon.preagg*` 只是读该前缀，不产它；该收窄见 #447）。
   - ⚠️ 一个契约**可能有多条产出管线**：`retail_order_line` 的产出面是 `lemeng.retail_order_line.window.json` **与** `.tick.json` 两个子管线（各自有自己的投影节点）。**两条都要重写。**
2. **定位投影节点**：该管线里**唯一一个 `code.sql` 节点，其当前 `SELECT` 别名序列等于契约列序**——**正是 B10 规则② 用的那条判据**。因为生成器**维持**的恰是这个不变式，所以定位在**生成前后都成立**（无需新标记属性）。
3. **重写投影节点的 SELECT 列表区**：只替换「开头 `SELECT` 关键字 … 顶层 `FROM` 之前」这一段，**`FROM` 及其后逐字保留**（那里是 `FROM input o CROSS JOIN UNNEST(…)` 之类的**管线结构**，不是契约能决定的）。
4. **重写 staging 的 SELECT 列表区**：文件 = `dbt/models/common/staging/stg_<域>_<表>.sql`（**路径推导复用 B10 规则③ 的既有解析，不新造映射**）；同样只替换「`select` … `from read_parquet(` 之前」这一段，**`from read_parquet(…) r, … sealed where …` 逐字保留**。注入列 `{{ subject_org() }} as org` 插在 **`system_book` 列之后**（本系统所有契约的分区键都含它；契约无 `system_book` 时插首列之后）。

**确定性**：列序 = 契约序；格式固定（2 空格缩进；③ 用 `AS`、④ 用 `as`——**照各自文件现状**）。

**fail loud（不猜）**：投影节点不是唯一、别名集与契约列序不等、或 SQL 无法语法界定出「`SELECT` … 顶层 `FROM`」⇒ **报错退出**，不产出半成品。

**CLI**：默认写文件；`--check` 若有任一文件将被改动则非零退出（CI 用）。

### 2.3 生成物形态

**③（投影节点 SQL）**——只重写列区：

```sql
SELECT
  '${ITER_ITEM_BATCH_ID}' AS batch_id,
  CAST(json_extract_string(u.d, '$.order_detail_money') AS DECIMAL(14,2)) AS sale_money
  -- … 按契约列序 …
FROM input o
CROSS JOIN UNNEST(from_json(CAST(o.pos_order_details AS JSON), '["JSON"]')) AS u(d)
```

**④（staging SELECT 列区）**：

```sql
select
  r['batch_id']::varchar    as batch_id,
  r['system_book']::varchar as system_book,
  {{ subject_org() }}       as org,
  r['sale_money']::numeric  as sale_money
  -- … 按契约列序（本文件与契约同序，仅 org 为注入列）…
from read_parquet( … ) r, read_parquet( … _SCHEMA/v3.parquet ) sealed
where sealed['schema_version'] = 3
```

**类型映射** `contract.type → SQL 文本`：`varchar→varchar`、`integer→int`、`date→date`、`timestamp→timestamp`、`decimal→numeric`（照今天 staging 的既有用法）。契约 `_schema.schema.json` 的 `type` 是**封闭枚举**，此映射与之同源。

### 2.4 诚实边界：③ 逐字节、④ **归一**

- **③ 目标 = 逐字节 == 今日 committed**（回填 `expr` 后跑生成器应**零 diff**）⇒ **管线 JSON 不变**。
- **④ 做不到逐字节**：今天的 staging cast 是**选择性的**（`batch_id` 无 cast、`system_book::varchar` 有、`order_no` 无、decimal `::numeric`）——**不是契约的确定函数**。生成器取**归一**形态（**每列显式 `::type`**）：语义等价（列序 / 类型不变）、且更稳（每列显式定型）。
  ⇒ 这是**一次性、需评审的 diff**。**诚实的说法是「行为零变更」，不是「零变更」。**

---

## 3 门禁变化

- **新增** `gates` 步：`node scripts/gen-data-projection.mjs --check`（生成物 == committed）。
- **B10（`check-data-contract.mjs`）**：保留 `schemaVersion` / `consumerVersion` / 前缀序判据（廉价保险丝，防手改），但 ②③ 在正常态**恒真**。
- **`check-data-models.mjs` 不变**：staging 仍含 `r['列名']`、仍无 `::double`。

---

## 4 存量回填与验收（3 份契约）

1. **反抽 `expr`**：从现存 ③ 的 `SELECT` 列表逐列抽出表达式，回填 3 份契约（**逐条人工复核**；来源＝今天的 `flatten`/`shape` SQL，**逐字**）。
2. 跑生成器 ⇒ **断言 ③ 与今日 committed 逐字节相同**。**任何 diff = 反抽漏项，停下查。**
3. **评审 ④ 的 diff**：应**只有** cast 归一 + `org` 定位，不该有列增删改序。
4. 全绿后，CI 打开 `--check`。
5. **落地影响**：③ 不变 ⇒ 管线 JSON 不变 ⇒ **投递 lock 不变 ⇒ 不 re-seed、不重部署**；④ 变 ⇒ lock 变 ⇒ 下一次 `lemeng-dbt-materialize` job 用新版（**无需重启**）。

---

## 5 α 分两步（契约格式一次到位）

| 步 | 内容 | 出口 |
|---|---|---|
| **步 1（本批）** | 契约加 `expr` → 生成 **③ + ④** + 3 源逐字节回填（§4） | CI 开 `--check`；③ 零变更 |
| **步 2** | 契约加 **`sourceFields`（名 + 类型）** → 生成 **②**（`data.schema`）+ 逐字节验收 | 四面 → **两面**（契约 + 生成物） |

- **步 1 就为 `sourceFields` 留位**：契约 schema **允许**该字段存在（暂不消费），免得步 2 再动格式。
- 步 2 的动机（长期最大杠杆）：`data.schema` 是**阶段 A「摸清源：字段清单 + 每列正确类型有人签字」**的落点（手册 §1.3.1 说这步最容易省、也最贵）⇒ 把它固化成契约的耐久工件。
- 步 2 若真别扭，**停在步 1 无浪费**。

---

## 6 非目标

- **不生成管线结构**（节点 / 边 / 源 / 汇 / 组件选型）——仍由桌面 app / 引擎产，凭据走 `connectionRef`。
- **不生成 `qa.contract` 规则**（它引用列名，可由契约派生，但本批不做）。
- **不动** `alerts` / `owners` / `schedules`。
- **不接新源**（存量优先）。

---

## 7 风险与未决

| # | 风险 / 未决 | 处置 |
|---|---|---|
| 1 | **`expr` 与 `type` 语义漂移**（`expr` 的 cast 目标 ≠ `type`）⇒ 湖与 staging 分叉 | 靠 §4 的 ③逐字节 + ④列序比对兜。**未决**：是否加一条「`expr` 的 cast 目标必须等于 `type`」静态检查（字符串比对脆，先不做，记待沉淀） |
| 2 | **桌面 authoring 回收覆盖 ③**（`scripts/lemeng/authoring-ws.sh` 收回编辑） | CI `--check` 抓；SOP 增一句「回收后跑生成器」。**未决**：`authoring-ws.sh` 是否内联调用生成器 |
| 3 | **④ 归一改变 dbt 文件** | 需一次 materialize 验证（列序 / 类型不变即等价） |
| 4 | **生成器需解析 SQL 的 SELECT 列表** | 仅支持「`SELECT … FROM`（选列里无子查询）」形态；越界即**报错**。**未决**：未来若出现不满足的管线，改用显式标记注释（届时一次性 re-seed） |

---

## 8 依据

- **契约形态**：`contracts/common/lemeng.retail_order_line.json`（`schemaVersion 3` / `consumerVersion 3` / 25 列）；`contracts/common/_schema.schema.json`（`type` 封闭枚举，`double` 故意排除）。
- **③ 实例**：`deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json` 的 `flatten` 节点（`SELECT … FROM input o CROSS JOIN UNNEST(…)`）；`.tick.json` 同形 ⇒ 本契约**两个生产者**。
- **④ 实例**：`dbt/models/common/staging/stg_lemeng_retail_order_line.sql`（含 `{{ subject_org() }}` 注入列与封版断言 `_SCHEMA/v3.parquet`）。
- **B10**：`scripts/check-data-contract.mjs` 四判据（①`schemaVersion` ②生产面 ③消费面 ④申报面）。
- **纪律**：`docs/data-platform-handbook.md` §1.1.2（落地形态）/ §1.2（第一档门禁）；`docs/architecture.md` §4.1（B10）/ §5.1（数据面工件演进）/ §5.2（湖 schema 演进：展开→迁移、`consumerVersion`）。
- **相邻范式**：`scripts/gen-console-registry.mjs`（生成 + committed + CI 查「生成物 == committed」）。
