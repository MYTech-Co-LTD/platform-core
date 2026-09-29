# 读侧迁移 spec：staging 消费 `retail_order_line` 6 个新列 + 拆掉「混代列集」地雷

> **状态**：**待人拍板**（§5 明列 6 项决定）。本 spec **只出方案**——不改任何 dbt 模型 / duckle 管线 / 静态门禁。
>
> **立题**：issue #374。**硬上游**：#328（历史回填，本 spec 是它的硬前置）、#294（契约 v2 的 6 个新列）、#327（Lab B 的 B-3 实证）。
>
> **实测**：2026-09-29 当日（UTC 约 14:0x），数据面真机 shanhai（serverId `8281d598`，容器
> `openship-platform-core-shanhai-data-pg_duckdb`）。**全部只读**（`SELECT` / `glob` / `parquet_schema`），**零写入**；
> 凭据按既有只读通路取用（pg_duckdb 实例内已配 S3 secret，无需 job 的 7 个 secret），**不进本文件**。

---

## 0 结论摘要（先读这个）

**推荐方案 B：读侧**先不动**，回填按「最老最后」的降序做，回填完成后在现行形态下加 6 列。**

三条支撑（都在 §2 有逐字实测）：

1. **B 零门禁改动、零新形态**：继续用 `from read_parquet(glob) r` + `r['列名']` —— 正是仓内已实证、已被门禁规则①
   守住的形态。新列只是在这份 select 清单尾部加 6 行。
2. **「回填完成前读不到新列」这件事的实际代价是 0**：#294 的 6 个新列是为**对账归零**采的（退货部分），
   而对账要的正是**历史覆盖** —— 那必须靠回填。#328 的验收本来就写着「回填后湖里对账期分区带 6 新列；
   staging 读侧在新形态下全绿」。**读侧加列与回填本来就是同一笔交付。**
3. **回填顺序对了，窗口期物化不中断** —— 这条**订正 #328 的 b 方案**：原文说「历史回填 + 全量重物化一次性切换
   （窗口期物化不可用）」。实测表明**不必有窗口期**（§2.3 的不变量 + §4 的顺序）：只要「全局字典序最老的旧形分区」
   留到最后重写，glob 的第一个文件始终是 18 列，其后文件多出来的列被忽略（B-1）⇒ **全程可读、可直接 `dbt run`**。

**但 B 把一处风险从「机制」挪到了「纪律」**：读得出与否取决于**回填顺序**。本 spec 给出**不变量 + 前置探针**
（§4 Phase 0/1），要求把它写进回填 runbook，别让它停在「大家都知道要降序」。

**备选 A：`duckdb.query(...)` 包住 `read_parquet`，带 `union_by_name=true`。**
唯一「**不依赖顺序**」的读侧解，能**同时**解掉 B-3 并让新列**立即**可用。代价：必须动**门禁规则③**（禁 `union_by_name`），
而那条规则正是仓内为「列集漂移不许引擎替我们猜」立的（`dbt/README.md` §6）。**本 spec 不擅自放宽** —— 见 §5 D1/D5。

**备选 C：按列集分组 `union all` + 缺失列显式补 `NULL`（`dbt/README.md` §6 的目标形态）。**
机制上跑得通（§2.7 E15），但本案的**新侧是开放的**（`bizday ≥ 边界` 无法用 glob 表达）⇒ 需要一个 manifest 或
逐日维护的边界清单。适合当作「有界窗口的一次性读法」，不适合当长期形态。

**顺带两条必须知道的事**：

- **`duckdb.raw_query` 这条路走不通**（不是「要改门禁」那种不通，是**结构上不可用**）：它的返回类型是 `void`，
  不能 `r['列名']` 取列（逐字见 §2.4 E8）。brief 里「迁 `duckdb.raw_query`」的字面形态**在真机上不成立**；
  可用的入口是 **`duckdb.query`**。
- **湖的代际边界不是 2026-09-29，是 2026-09-28**，且 **09-28 已经被一次 replay 重写过了**（§2.2 E13）。
  也就是说**回填实际上已经开始**，只是恰好走在安全序上（09-28 不是最老分区）。

---

## 1 逐字背景与两处订正

### 1.1 brief 与上游给的逐字事实（未变的部分）

| 事实 | 出处 | 本 spec 复核 |
|---|---|---|
| 契约 v2 = **24 列** | `contracts/common/lemeng.retail_order_line.json`（列清单）+ `contractVersion` 仍为 1 | ✅ 24 列在湖上逐字可见（§2.1 E4） |
| 历史分区仍是 **18 列** | #327 / #328 | ✅ 但**范围要订正**（§1.2） |
| pg_duckdb 的 `read_parquet` **只收位置参数**，`union_by_name` 递不进去 | `stg_lemeng_retail_order_line.sql` 头注（2026-09-24 真机） | ✅ **2026-09-29 复现**（§2.5 E14，逐字不同但同义） |
| 门禁规则① 要的是 `r['列名']` 构造 | `scripts/check-data-models.mjs` | ✅ `R_COLUMN_RE = /r\s*\[\s*['"]/`（第 152 行） |
| 门禁规则③ **禁 `union_by_name`** | 同上 | ✅ `UNION_BY_NAME_RE = /union_by_name/gi`（第 156 行） |
| B-3：新形文件排 glob 第一 ⇒ 连旧 18 列都读不出（`schema mismatch in glob`） | #327 报告 §4（**本地 DuckDB 1.5.5**） | ✅ **在生产引擎 DuckDB 1.4.3 上复现**（§2.3 E7） |

### 1.2 订正一：代际边界是 **2026-09-28**，不是 2026-09-29

brief 写「湖自 2026-09-29 起进入混代状态」。真机逐分区扫描（§2.1 E2）的实际边界是：

| 账套 | 18 列（旧形） | 24 列（新形） |
|---|---|---|
| 3120 | bizday 09-23 ~ **09-27** | **09-28**、09-29 |
| 64188 | bizday 09-25、09-26、**09-27** | **09-28**、09-29 |

**⇒ 混代区间比 brief 说的多一天（09-28 整天）。** 这个订正有实际后果：回填要重写的旧形范围是
**3120 的 09-23~09-27** + **64188 的 09-25~09-27**，不是「09-29 之前按 09-28 切开」那么简单。

### 1.3 订正二：**09-28 已经被重写过一次了**

`batch_id` 是「采集 run id」（契约 `batch.mark.col`），逐日比对（§2.2 E13）：

- **09-27（18 列）** 的 24 个分区带 **24 个不同的 run 时间戳**，全落在 `retail-3120-20260928T0230xxZ-hh`
  —— 即 09-28 凌晨的**逐小时正常采集**。
- **09-28（24 列）** 的 24 个分区带 **同一个** run 时间戳：
  `retail-3120-20260929T121249Z-hh`（64188 同形：`retail-64188-20260929T124244Z-hh`）
  —— 即 **2026-09-29T12:12:49Z 的一次单跑，把 09-28 整天 24 个小时全部重写**。

**⇒ 这是一次 replay / 回填，且它写的是新形 24 列。** 它**没有**打红现行物化，原因只有一个：
**09-28 不是最老分区**（最老是 3120/09-23，仍是 18 列）⇒ glob 第一个文件仍是旧形 ⇒ 落在 B-1。

**这条对本案的意义**：回填不是「将来时」，是**进行时**；而它今天安全纯属**排序巧合**。把顺序变成硬约束 = 本案的核心交付之一。

---

## 2 只读实测（数据面真机，零写入）

### 2.1 环境与数据集

**E0 引擎自证**（`18-v1.1.1` 对应关系核实）：

```
==PG==
PostgreSQL 18.1 (Debian 18.1-1.pgdg12+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 12.2.0-14+deb12u1) 12.2.0, 64-bit
==DUCKDB==
v1.4.3
```

**E1 湖清单**（`glob`，246 个对象）：

```
3120|2026-09-23|24     3120|2026-09-28|24
3120|2026-09-24|24     3120|2026-09-29|3
3120|2026-09-25|24     64188|2026-09-25|24
3120|2026-09-26|24     64188|2026-09-26|24
3120|2026-09-27|24     64188|2026-09-27|24
                       64188|2026-09-28|24
                       64188|2026-09-29|3
```

路径形态：`s3://<bucket>/lemeng/retail_order_line/system_book=<账套>/bizday=<YYYY-MM-DD>/hour=<HH>/all.parquet`
（hive 三级分区，与契约 `layout` 一致）。

**E2 逐分区列数**（`parquet_schema` 行数：**19 = 18 列**，**25 = 24 列**，含 1 行根节点）：

```
3120/0923h00|19   3120/0928h00|25
3120/0924h00|19   3120/0928h23|25      ← 同日首尾同形 ⇒ 09-28 整天都是新形
3120/0925h00|19   3120/0929h20|25
3120/0926h00|19   64188/0925h00|19
3120/0927h00|19   64188/0926h00|19
                  64188/0927h00|19
                  64188/0928h00|25
                  64188/0929h20|25
```

**E3/E4 两侧列名逐字**（`parquet_schema(...).name`）：

- 旧形（`3120/bizday=2026-09-23/hour=00`）18 列：
  `batch_id, system_book, bizday, hour, order_no, order_detail_num, branch_num, branch_name, order_time,
  order_operate_time, state, order_source, item_num, item_code, sale_money, discount_money, payment_money, quantity`
- 新形（`3120/bizday=2026-09-29/hour=22`）在上面 18 列之后**追加 6 列**：
  `order_transaction_type, order_ref_billno, order_detail_share_discount, order_detail_std_price,
  order_detail_price, order_detail_online_qty`

⇒ 与契约 v2 的 24 列**逐字吻合**，且**新列是尾部追加**（不是插入）—— 这一点是 B 方案的前提（见 §2.3）。

### 2.2 现行读法在**今天的混代湖**上是活的（最重要的一条）

**E12 现行 staging 形态（`from read_parquet(全 glob) r` + `r['列名']`）直接读整个混代湖**：

```sql
SELECT count(*) AS n, count(r['order_no']) AS orders, min(r['bizday']::date) AS mind,
       max(r['bizday']::date) AS maxd, count(DISTINCT r['system_book']::varchar) AS books
FROM read_parquet('s3://<bucket>/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet') r;
```
```
135670|135670|2026-09-23|2026-09-29|2
```

⇒ **两账套、09-23~09-29、18 列与 24 列分区共处一个 glob，现行读法读出 135670 行、`order_no` 全非空。**
**物化现在是绿的，这条不是假绿**（它读的就是真湖真数据）。

**同一批实测里 count 在动**：同一条 `count(*)` 在几分钟内从 **103477 → 103531**（3120 单账套），
新列非空数 11152 → 11206 —— 因为 09-29 是**当天**、采集在跑（09-29 的 `batch_id` 带 `-t` 后缀、
逐小时各自一个 run：`retail-64188-20260929T135514Z-20-t` 等）。
**⇒ 本 spec 里所有计数都是「2026-09-29 约 14:0x UTC」的时间锚定值；任何验收判据都不许写成绝对行数**（要写成
「两个投影行数相等」这类**相对**判据）。

**E13 回填已发生**（`batch_id` 逐日）：

```
==3120 bizday=2026-09-27（旧形 18 列）==
retail-3120-20260928T023009Z-00
retail-3120-20260928T023017Z-01
...（共 24 个不同时间戳，均为 20260928T0230xxZ）
retail-3120-20260928T023305Z-23

==3120 bizday=2026-09-28（新形 24 列）==
retail-3120-20260929T121249Z-00
retail-3120-20260929T121249Z-09
...（共 24 个分区、**同一个时间戳 20260929T121249Z**）
retail-3120-20260929T121249Z-23
```

### 2.3 B-1 / B-2 / B-3 在生产引擎上的复现

**E5 B-1（旧形在前，选旧列）：通。** 混代 glob（`system_book=3120/bizday=2026-09-2*`）`count(*)` = `103477`。
⇒ 新形文件多出来的列被**忽略**，不报错。

**E6 B-2（选新列，无 `union_by_name`）：响亮报错。** 逐字（`duckdb.query` 形态，同 glob）：

```
ERROR:  (PGDuckDB/CreatePlan) Prepared query returned an error: Binder Error: Referenced column
"order_transaction_type" not found in FROM clause!
Candidate bindings: "order_no", "order_operate_time", "order_source", "order_time", "order_detail_num"
```

⇒ **这是「先给 staging 加 6 列」的直接后果**（也再次证明：**读侧加列绝不能先于回填**）。

**E7 B-3（新形在前，选新列）：在生产引擎 DuckDB 1.4.3 上复现。** 逐字：

```
ERROR:  (PGDuckDB/Duckdb_ExecCustomScan_Cpp) Invalid Input Error: Failed to read file
"s3://<bucket>/lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=00/all.parquet":
schema mismatch in glob: column "order_transaction_type" was read from the original file
"s3://<bucket>/lemeng/retail_order_line/system_book=3120/bizday=2026-09-29/hour=22/all.parquet",
but could not be found in file
"s3://<bucket>/lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=00/all.parquet".
Candidate names: batch_id, system_book, bizday, hour, order_no, order_detail_num, branch_num, branch_name,
order_time, order_operate_time, state, order_source, item_num, item_code, sale_money, discount_money,
payment_money, quantity
If you are trying to read files with different schemas, try setting union_by_name=True
```

**⚠️ 这条复现的取证方式要说清（否则后来者会误读它的强度）**：

- 真湖里**无法**用 glob 构造出「新形在前」——分区路径含 `bizday=YYYY-MM-DD`（字典序 = 时间序），
  而漂移是**单向、随时间向前**的 ⇒ **自然顺序只能是旧在前**。B-3 的触发源是**回填**（用新管线重写老分区）。
- 故本条用**显式文件列表**（`read_parquet([新形文件, 旧形文件])`，DuckDB 侧解析）复现，列表顺序可控，
  且报错原文自己就写着 **`schema mismatch in glob`** —— 与 #327 Lab B 的报错**同一支代码路径、同一句文案**。
- 补一条**关键的强度限制**：#327 Lab B 跑的是**本地 DuckDB 1.5.5**，生产读侧是 **1.4.3**（E0）。
  本次实测把 B-3 **拉到了生产引擎版本上**（上面这条就是 1.4.3 的输出）⇒ B-3 不再是「只在更新版上见过」。
  但**「新形在前 + 只 `count(*)`、不引用任何列」时不报错**（实测：同一文件列表 `count(*)` 返回 645，
  正反两种顺序都一样）—— 即**这条检查是被「投影到那个列」触发的**，不是被文件列表本身触发的。
  这条细节在写前置探针时要小心（探针必须**真的引用**新列，见 §4 Phase 0）。

### 2.4 `duckdb.raw_query` 通路：**结构上不可用**（订正 brief 的选项①字面形态）

**E8 逐字**：

```sql
SELECT r['n'] AS n FROM duckdb.raw_query($$ SELECT count(*) AS n FROM read_parquet('...', union_by_name=true) $$) r;
```
```
ERROR:  cannot subscript type void because it does not support subscripting
```

`duckdb.raw_query(...)` 的**返回类型是 `void`** ⇒ 它在 PG 里**不是**一个可 `FROM` 的关系，**不能** `r['列名']` 取列。
它的结果只能以 NOTICE 形式被看到（`NOTICE: result: n BIGINT [ Rows: 1]` 跟着一行值）。
这与计划 `2026-09-22-data-stack.md` 第三轮自查第 5 条的口径一致：**`raw_query` 是「会话内建表/视图」的副作用入口，
不是可 FROM 的表函数**。

**⇒ brief 里「① 迁 `duckdb.raw_query`（整段交给 DuckDB 的入口 ⇒ 只有那里能带 `union_by_name`）」这半个判断
（「只有那里」）不成立**：能带 `union_by_name` 且**能 `r['列名']` 取列**的入口是 **`duckdb.query`**。

### 2.5 `duckdb.query` 通路：**可用，且能满足现行 staging 的两条硬要求**

**E14 先复核「裸 PG 递不进命名形参」**（2026-09-24 头注结论，本次复现）：

```sql
SELECT count(*) FROM read_parquet('.../all.parquet', union_by_name=true) r;
-- ERROR:  column "union_by_name" does not exist
SELECT count(*) FROM read_parquet('.../all.parquet', hive_partitioning=1) r;
-- ERROR:  column "hive_partitioning" does not exist
```

⇒ 命名形参**只能**在「整段交给 DuckDB」的入口里出现 ⇒ 方案 A 的**入口唯一性**成立（包 `duckdb.query`）。

**E9 `duckdb.query` + `union_by_name=true` 在真湖上**（逐字）：

```sql
-- (1) 总行数
SELECT q['n'] AS n FROM duckdb.query($$ SELECT count(*) AS n FROM read_parquet('...system_book=3120/bizday=2026-09-2*/hour=*/all.parquet', union_by_name=true) $$) q;
-- 103531
-- (2) 新列非空数（union_by_name 下新列真的读得出来）
SELECT q['n'] AS n FROM duckdb.query($$ SELECT count(order_transaction_type) AS n FROM read_parquet('...', union_by_name=true) $$) q;
-- 11206
-- (3) hive 分区 + union_by_name 同时用，两账套
SELECT q['n'] AS n, q['sb'] AS sb, q['mind'] AS mind, q['maxd'] AS maxd FROM duckdb.query($$
  SELECT count(*) AS n, min(system_book) AS sb, min(bizday) AS mind, max(bizday) AS maxd
  FROM read_parquet('...system_book=*/bizday=2026-09-2*/hour=*/all.parquet', hive_partitioning=true, union_by_name=true) $$) q;
-- 135670|3120|2026-09-23|2026-09-29
```

**E10 别名取 `r` 时，门禁规则① 仍然满足**（这条**订正 brief 的假设**）：

brief 说「staging 门禁规则 ① 的 `r['列名']` 函数别名形态要豁免/改门禁」。实测**不必**：

```sql
SELECT r['n'] AS n FROM duckdb.query($$ SELECT count(*) AS n FROM read_parquet('...', union_by_name=true) $$) r;
-- 103531
SELECT r['order_transaction_type'] AS tt, r['sale_money']::numeric AS m FROM duckdb.query($$ ... $$) r LIMIT 3;
-- SALE_ORDER|9.900
-- SALE_ORDER|2.900
-- SALE_ORDER|29.370
```

规则① 的正则是 `/r\s*\[\s*['"]/`（只认**前缀字母 `r`**，不认它是不是 `read_parquet` 的别名）。
**别名叫 `r` 就过门**，且 `r['新列']::numeric` 显式 cast 也照常工作。
**⇒ 方案 A 真正撞的只有门禁规则③（`union_by_name`），不是规则①。**

**E11 类型面：cast 仍然必需，但**不是**因为 `USER-DEFINED`**（逐字）：

```sql
-- duckdb.query 取列（未 cast，单个旧形文件）
SELECT pg_typeof(r['system_book']), pg_typeof(r['hour']), pg_typeof(r['bizday']) FROM duckdb.query($$ ... $$) r;
-- bigint|varchar|date
-- 现行 staging 形态（裸 read_parquet r）取同样三列
SELECT pg_typeof(r['system_book']), pg_typeof(r['hour']), pg_typeof(r['bizday']) FROM read_parquet('.../all.parquet') r;
-- bigint|varchar|date
-- 逐列 pg_typeof（duckdb.query，新形文件未 cast）
-- batch_id=varchar  system_book=bigint  bizday=date  hour=varchar
-- order_no=varchar  sale_money=decimal(14,2)  order_transaction_type=varchar
```

**⇒ 结论（订正 brief 的说法）**：

1. 未 cast 的列**没有**出现 `USER-DEFINED` —— 采样到的 24 列都是**正经 PG 类型**（`varchar` / `bigint` /
   `date` / `decimal(14,2)`）。**「否则消费层见 `USER-DEFINED`」这条在本栈上未复现**（如实记：采样面不是全列，
   但覆盖了三个分区键 + 金额 + 新列 VARCHAR）。
2. **cast 仍然必须留**，但真实理由是**类型不合契约**：`system_book` 推成 **`bigint`**（契约要 `varchar`）、
   `hour` 推成 **`varchar`**（契约要 `integer`）、`bizday` 是 `date`（合契约，`::date` 是幂等保险）。
   —— 与 `stg_lemeng_retail_order_line.sql` 头注【一】的三条逐字吻合，且 **`duckdb.query` 与裸 `read_parquet`
   两种形态的推断结果完全一致** ⇒ **换入口不改变类型面，现有三条 cast 照抄即可。**

### 2.6 备选 C 的机制可行性（顺带验掉的）

**E15 按列集分组 + `union all` + 缺失列显式补 `NULL`（`dbt/README.md` §6 的目标形态）：通。**

```sql
SELECT count(*) AS n FROM (
  SELECT r['order_no'] AS order_no FROM read_parquet('...system_book=3120/bizday=2026-09-2[3-8]/hour=*/all.parquet') r
  UNION ALL
  SELECT r['order_no'] AS order_no FROM read_parquet('...system_book=3120/bizday=2026-09-29/hour=*/all.parquet') r
) t;
-- 103477（= 同一时刻整体混读的行数，两路分读之和精确相等）
```

补 `NULL` 版本（新列只在新区间非空）：

```sql
SELECT count(*) AS n, count(order_transaction_type) AS with_new FROM (
  SELECT r['order_no'] AS order_no, NULL::varchar AS order_transaction_type
    FROM read_parquet('...bizday=2026-09-2[3-8]/hour=*/all.parquet') r
  UNION ALL
  SELECT r['order_no'] AS order_no, r['order_transaction_type']::varchar AS order_transaction_type
    FROM read_parquet('...bizday=2026-09-29/hour=*/all.parquet') r
) t;
-- 103477|2618
```

⇒ **机制上跑得通、且不碰 `union_by_name`**。**但它要求「分组边界」可表达**：旧侧是有界的（一次性钉死），
新侧是**开放**的（`bizday ≥ 边界`）—— **glob 表达不了 `>=`**，上面这个 `2026-09-29` 是**写死的单日**，
明天就得改成两日、后天三日…… ⇒ 见 §3 方案 C 的判定。

---

## 3 方案对比

三个方案的判据维度：可维护性 / 对既有门禁（规则①、③）的影响 / 回滚代价 / **是否同时解掉 B-3**。

| | **A：`duckdb.query` + `union_by_name`** | **B：不迁读侧 + 回填按序（推荐）** | **C：按列集分组 `union all`** |
|---|---|---|---|
| **机制** | 把 `read_parquet(...)` 整段包进 `duckdb.query($$ … $$)`，别名取 `r`，带 `union_by_name=true` | 读侧一字不动；回填**降序**（全局最老分区最后），回填完成后在现行 select 尾部加 6 列 | 旧/新两代各自 `read_parquet` + `union all`，缺失列显式补 `NULL::<type>` |
| **新列何时可用** | **立即**（不需回填） | 回填**完成后** | 立即（但需维护分组清单） |
| **可维护性** | 中：模型主体变成 DuckDB SQL 字符串（`$$ … $$`），dbt 侧的阅读/评审面下降；但**不再依赖排序巧合** | **高**：形态与今天逐字一致，只是 select 多 6 行；代价是**顺序纪律**必须编码进 runbook | **低**：新侧开放 ⇒ 需 manifest 或逐日维护边界清单；`dbt/README.md` §6 自己也把它标为「目标形态（待钉死）」 |
| **门禁规则①（`r['列名']`）** | ✅ **不用改**（别名取 `r` 即过门，E10） | ✅ 不用改 | ✅ 不用改 |
| **门禁规则③（禁 `union_by_name`）** | ❌ **必须改**（窄豁免 or 改述） ⇒ **架构决定** | ✅ 不用改 | ✅ 不用改 |
| **与 `dbt/README.md` §6 的关系** | **正面冲突**：§6 原文「禁 `union_by_name` 兜（规则③ 静态拦）：它会让引擎替我们**猜**列集…比响亮失败危险得多」 | 一致（§6 第 1 条「当前形态」：列集一致窗口内成立，混进不同列集会**响亮报错**——这是要的行为） | **正是 §6 第 2 条的目标形态** |
| **回滚代价** | 低：回滚 = 还原 1 个模型文件（读侧可逆） | **不可逆**：回填用新管线覆盖写，旧 18 列管线已退役 ⇒ **改不回 18 列**。可回滚的只有「读侧」与「是否继续回填」 | 低：还原模型文件 |
| **是否解掉 B-3** | ✅ **机制上解掉**（顺序不再影响可读性） | ⚠️ **不解除，而是回避**：靠「最老分区最后」使 B-3 不发生；回填完成后湖变均一、隐患自然消失 | ⚠️ 同上（分组读天然免疫，但代价是可维护性） |
| **适用前提** | 愿意为「列集过渡」放宽一次 §6 的禁令 | 接受「新列在回填完成前不可用」 | 接受分组清单/ manifest 的维护成本 |

### 3.1 为什么推荐 B

1. **B 的「代价」在本案里不成立**：见 §0 第 2 条 —— 新列的唯一用途（对账归零）**本来就要求回填完成**。
   换句话说，A 相比 B 多买到的能力是「**回填还在跑的时候就能读新列**」，而这恰好是没人需要的能力。
2. **B 不碰任何门禁**，而 A 碰的规则③ 是仓内**有理由**立的（列集漂移必须显式，不许引擎猜）。
   在「过渡期只有 5 天旧分区、且必然收敛」的场景下，为 A 放宽一条通用禁令，**收益/风险比不划算**。
3. **B 的隐患是可机械判据化的**：不变量 + 前置探针（§4）能把它从「靠人记得」变成「跑之前会红」。
   而 A 引入的是**新的**常驻复杂度（整段 DuckDB 字符串 + 一处门禁豁免），换来的是一个**窗口期能力**。

### 3.2 什么情况下应改选 A

- 若**回填无法覆盖全部旧形分区**（例如对账期只需要 09-28 之后、09-23~09-27 长期不重写）⇒ 湖**长期**停在混代，
  此时 B 的「等回填完成」永远不到 ⇒ **必须**走 A（或 C + 边界机制）。
- 若将来**列集还会再变**（25 列、26 列）且变化无界 ⇒ 那时该讨论的不是 A，而是**采集侧列的稳定性**（§5 D6）。

> ⚠️ **若走 A，有一条注释纪律必须写进门禁豁免处**：本案里 `union_by_name` 补的 NULL 是**语义正确**的
> （旧分区**本来就没有**那 6 列的数据，不是「列集猜错」）。这条理由必须逐字写清，否则后来者会把
> 「规则③ 已被豁免过一次」读成「规则③ 不可信」，那才是真正的损失。

---

## 4 迁移路径（谁先谁后 + 每步判据 + 回滚点）

> 本节按**推荐方案 B** 写。若拍板走 A/C，Phase 1 的顺序约束可放松（A 完全不依赖顺序），但 Phase 1 本身（回填）
> 仍然是交付的一部分（新列要覆盖历史）。

### 4.0 贯穿全程的**不变量**（B 之所以安全的唯一理由）

> **glob 展开后第一个文件的列集，必须是其后每一个文件列集的子集。**

- 今天成立：第一个文件 = `system_book=3120/bizday=2026-09-23/hour=00/all.parquet` = **18 列**；
  其后各文件 = 18 或 24 列，**都 ⊇ 18 列** ⇒ 旧列可读、多出来的列被忽略（E5/E12）。
- B-3 的触发 = **第一个文件变成 24 列**（或任何后置文件缺它的列）⇒ 不变量破 ⇒ 整挂（E7）。

**⇒ 由不变量直接得出回填的硬约束**：**「全局字典序最老的旧形分区」必须最后重写。**
今天的它是 **3120/`bizday=2026-09-23`**（3120 排序在 64188 前，且 3120 的旧形起点 09-23 比 64188 的 09-25 更早）。

### Phase 0 —— 前置探针（开工前跑，只读）

**判据（唯一）**：最老分区仍是 18 列 ⇒ **探针行数 = 19**（含 1 行根节点）。

```sh
docker exec -i openship-platform-core-shanhai-data-pg_duckdb \
  sh -c 'PGPASSWORD=$POSTGRES_PASSWORD psql -U platform -d warehouse -tA' <<'EOSQL'
SELECT * FROM duckdb.query($$ SELECT count(*) AS rows FROM parquet_schema(
  's3://<bucket>/lemeng/retail_order_line/system_book=3120/bizday=2026-09-23/hour=00/all.parquet') $$);
EOSQL
```

- `19` ⇒ 不变量成立，**可继续**。
- `25`（或别的值）⇒ **不变量已破**：要么最老分区已被重写（那就**不能再按 B 做**——读侧此刻可能已经红），
  要么边界日期判断错了 ⇒ **停，升级到 §5 D2**。

> ⚠️ **探针必须用 `parquet_schema`（看真实列数），不要用「选新列能不能跑通」当探针**：实测表明
> 「新形在前但不投影任何列」是**不报错**的（`count(*)` 正反顺序都返回 645）⇒ 那种探针会给**假绿**（§2.3 末条）。

### Phase 1 —— 回填（写侧；**本 spec 只定顺序与判据，不由本任务执行**）

顺序：**按 bizday 降序**重写旧形分区，**3120/2026-09-23 最后**。

| 批 | 重写 | 批前判据 | 批后判据 |
|---|---|---|---|
| 1 | 3120 09-27、64188 09-27 | 探针 = 19 | 该批分区 `parquet_schema` 行数 = 25；**整湖混读仍通**（§4.0 不变量查询） |
| 2 | 3120 09-26、64188 09-26 | 探针 = 19 | 同上 |
| 3 | 3120 09-25、64188 09-25 | 探针 = 19 | 同上 |
| 4 | 3120 09-24 | 探针 = 19 | 同上 |
| **5（最后）** | **3120 09-23** | 探针 = 19 | **探针变 25** = 全湖均一 |

**批后「整湖混读仍通」的判据**（现行 staging 的形态，别用 `count(*)` 当判据 —— 它对列集不敏感）：

```sql
SELECT count(*) AS n, count(r['order_no']) AS orders, min(r['bizday']::date) AS mind, max(r['bizday']::date) AS maxd
FROM read_parquet('s3://<bucket>/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet') r;
```
期望：跑得通、`orders = n`、`mind = 2026-09-23`。（**不要**断言 `n` 的绝对值 —— 当天数据在涨，见 §2.2。）

**建议加的机械守卫（可选，属新交付物，本 spec 只建议）**：把 Phase 0 探针挂进回填脚本的**前置步**，
非 19 就**拒绝执行回填**（fail-closed）。理由：这个约束一旦只停在文档里，就一定会有一次「先手动把最老分区补了」。

**回滚点（要诚实说清）**：

- **回填本身不可逆**：它用新管线**覆盖写**，而旧 18 列管线**已退役** ⇒ 没有任何办法把分区改回 18 列。
- ⇒ 出事后**唯一的读侧救援**是**切方案 A**（`union_by_name` 立即让任意顺序可读）。
  **这也是建议「A 的可行性已被本 spec 验通」要一起留档的原因** —— 它是 B 的事故预案。
- 「不再继续回填」是可行的**暂停**（湖停在混代），但**不是回滚**。

### Phase 2 —— 读侧加列（全部旧形分区清零之后）

改 `dbt/models/common/staging/stg_lemeng_retail_order_line.sql`：在现有 18 个 `r['列名'] as 列名` 之后**追加 6 行**，
形态与 cast 照抄契约（VARCHAR 三列 + `::numeric` 三列；见 `contracts/common/lemeng.retail_order_line.json` v2）。
头注同步更新（把「18 列」的口径改成 24 列、并记下本轮迁移）。

**判据（必须成对，单条不够）**：

1. **双向行数相等**（相对判据，抗数据增长）：
   全 glob 的 18 列投影 `count(*)` **==** 全 glob 的 24 列投影 `count(*)`。
   （18 列投影现在就该通；24 列投影在 Phase 1 全绿前会报 E6 的 Binder Error。）
2. **每分区列数 = 25**（`parquet_schema`，抽最老 + 最新各一个）。
3. `dbt run --select stg_lemeng_retail_order_line` ok；落表后 `information_schema` 里能看到
   **25 列**（24 契约列 + dbt 注入的 `org`）。
4. 静态门禁绿：`tsx scripts/check-data-models.mjs`（规则①/④/⑩ 都要过）。

**回滚点**：Phase 2 完全可逆 —— 还原这**一个**文件即可。

### 之后（不在本 spec 范围）

④ marts 是否暴露新列、以及向后兼容口径 ⇒ §5 D4。

---

## 5 待人拍板的决定（本 spec **不替人决定**）

| # | 决定 | 选项 | 为什么要人拍 |
|---|---|---|---|
| **D1** | 读侧走 **A 还是 B** | A（`duckdb.query` + `union_by_name`，新列立即可用）/ **B（推荐）** / C | A 要动门禁规则③；B 要背顺序纪律。两者是**不同的风险口味**，不是技术对错 |
| **D2** | B 的**顺序约束**怎么落 | ① 只写进 runbook / ② 回填脚本前置探针 fail-closed（建议）/ ③ 都不做 | 关系到「一次误序就把物化打红」的概率 |
| **D3** | **回填范围** | 只补对账期所需 / 全量补 09-23~09-27 两账套 | 决定 Phase 1 有几批；也决定「新列何时可用」 |
| **D4** | ④ marts 是否暴露 6 新列 | 暴露 / 暂不暴露 | 涉及 marts 的列契约与消费方（Metabase/下游）向后兼容口径 |
| **D5** | 门禁**规则③**的处置 | 保持无条件禁（B 的前提）/ 窄豁免（只许 designated 读入口 + 写明「本案补 NULL 语义正确」）/ 改述为「禁**无界**漂移兜底」 | **架构决定**，`dbt/README.md` §6 是正典 |
| **D6** | **未来再漂移**的策略 | 要求采集侧列集冻结 / 引入 manifest / 接受每次漂移都走一次读侧迁移 | 本案的根因是「湖里可以并存两种列集而读侧无法表达并集」 |

---

## 6 边界与未验面（诚实清单）

**本 spec 的边界**：**不改**任何 dbt 模型 / duckle 管线 / 静态门禁 / 契约；**零生产写入**；只出方案与判据。

**已验**（数据面真机，逐字见 §2）：代际边界与列清单；现行读法在混代湖上可读；B-2；**B-3 在生产引擎 1.4.3 上复现**；
`raw_query` 不可用；`duckdb.query` + `union_by_name` 可用；别名 `r` 满足规则①；三种入口的类型推断一致；
分组 `union all` 可行；回填已发生（09-28 被单跑重写）。

**未验 / 需注意**：

1. **`count(*)` 不是列集探针**：新形在前但不投影任何列时**不报错**（§2.3 末条）。任何自动化探针必须
   **投影到具体列**或改看 `parquet_schema` 列数。
2. **`duckdb.query` 与 PG 表混用未验**：`duckdb.query()` 跑在 DuckDB 原生上下文、**看不到 Postgres 表**
   （spec `2026-09-20-data-stack-module-design.md` §11.5）。本 spec 只涉及**纯湖读**，故不触发；但若将来要在
   同一模型里 join PG 关系，A 方案会撞上这条（B 不会）。
3. **本次采样未覆盖全部 24 列**的类型面（§2.5 E11 已覆盖分区键 3 列 + 金额 + 新列 VARCHAR）；
   `USER-DEFINED` 的说法**未复现**，但也**未被证伪到全列**。Phase 2 的判据③（`information_schema` 看列）会兜住它。
4. **`hive_partitioning` 与 glob 的一个抖动**：本次有两次「`system_book=*/` 的列表请求被拼成 `system_book=`」
   的 HTTP 404（同一形态的查询在别的批次里是通的）。**未定因**，不影响任何结论（相关结论都另有单文件读法的
   旁证），但下游若做自动化探针，**建议用单文件读法或加一次重试**，别把一次 404 读成「湖没了」。
5. **回填的执行者与工具不在本 spec 范围**：本 spec 只定**顺序与判据**。
6. **09-28 已被重写成新形，但当时有没有走同样的顺序判据 —— 无从考证**（`batch_id` 只能证明「单跑重写」，
   不能证明动机）。本 spec 的建议是**此后**把它编码化。
