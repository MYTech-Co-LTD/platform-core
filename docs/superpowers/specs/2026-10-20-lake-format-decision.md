# 湖存储格式决策：保持纯 Parquet，不引入 lakehouse 表格式（2026-10-20 拍板）

> **一句话**：**不换。** 湖继续是 hive 分区的**纯 Parquet**（`snk.minio` 写、`read_parquet` 读），
> **不引入 DuckLake**，也不引入 Iceberg / Delta。
>
> **理由不是工作量**（用户明确要求「抛开工作量不谈」）。是这条：
> **换表格式会把「系统记录」从对象存储搬到数据库**，并**关掉**引擎与工具选项——
> 而它治的病，我们今天**每一条都有更小的解法且已在跑**。
>
> 本文件是**决策记录**：结论 / 证据 / 被否决的收益 / 弊端 / 反转条件。不是待办清单。

**拍板**：用户，2026-10-20。**性质**：架构级决定（湖的存储方案），已同步进
`docs/architecture.md` §2.7（决策正文）与 §6.1（订正指针）。

---

## 0 结论与范围

| 项 | 决定 |
|---|---|
| 湖的存储格式 | **保持纯 Parquet + hive 分区**（现状不变） |
| DuckLake | **否** |
| Iceberg / Delta | **否**（本轮判断对它们同样成立，且它们的收益我们更用不上——见 §4.B） |
| 会不会再议 | **会**，但只在 §6 的反转条件出现时。**不是「永不」**，是「现在没有证据支持」 |

**不是「DuckLake 不好」。** 它是本仓「duckle 原生优先」正典下**档①**的原生件（§2 实测），
设计上也确实对位我们的痛点（§3）。否决它是因为**代价的性质**，不是能力。

---

## 1 为什么会问这个问题

明细侧要能「翻」到行粒度定位根因，而现况逼出一串**手搓脚手架**——它们的存在理由**只有一条**：
**纯 Parquet 没有事务目录**。这一串是：

| 手搓件 | 它在模拟什么 |
|---|---|
| `_SCHEMA/v<N>.parquet` 封版标记（「标记在 = 齐」） | 原子提交 / 「整表写全」 |
| `.data-plane-revision` | 湖的整体版本 |
| `contracts/*.json`（18 份）+ `gen-data-projection.mjs` + 三个 `check-data-*` 门禁 | schema 演进与列集一致性 |
| 混代 glob 的「四件套 + 展开→迁移」（`docs/architecture.md` §5.2） | 加列不破坏在读的读者 |
| 回填 = 重放（`backfill-lab.sh` / `backfill-retail-order-line.sh`） | 行级改 / 时间旅行 |
| `recon-day-heal.sh` / `recon-restate.sh`（重述窗口） | 晚到数据的 upsert |
| `deploy/data-plane.lock` | 湖布局的版本锁定 |

**DuckLake 是这一串的原生形态。** 所以「要不要换」是个**真问题**，不是技术时髦。

本轮触发点是明细读路径的性能与形态调查（§8），顺带把这个问题问到了底。

---

## 2 本环境可用性（逐条实测，2026-10-20）

| 检查 | 结果 | 怎么测的 |
|---|---|---|
| duckle 原生支持 | ✅ **全套**：`src.ducklake`（读）/ `snk.ducklake`（写）/ `src.ducklake.maintain`（compact / rewrite / expireSnapshots / cleanupFiles / deleteOrphans / flushInlined / stats）/ `src.ducklake.changes`（CDC）/ `src.ducklake.diff`（快照间行级 diff） | `list_components` + `get_component_schema` ⇒ 按正典属**档①** |
| catalog 放哪 | ✅ **可以是 `postgres:` DSN**（组件字段原文：`.ducklake` 文件，或 postgres/mysql/sqlite DSN） | `get_component_schema('src.ducklake.maintain')` |
| **pg_duckdb 能读吗** | ✅ **能**。`duckdb.install_extension('ducklake')` 成功（扩展目录出现 `v1.4.3/`）；`load_extension` 成功（错误提示露出 `ducklake_retry_backoff` ⇒ 设置已注册） | 生产 pg_duckdb 容器内实测 |
| 读方引擎版本 | pg_duckdb **1.1.0**，内嵌 **DuckDB v1.4.3** | `duckdb.query($$ select version() $$)` |
| 写方引擎版本 | duckle **0.7.4**，**DuckDB v1.5.5**（扩展目录 `/root/.duckdb/extensions/v1.5.5/`） | duckle console 容器内实测 |
| 仓内先例 | ❌ **零处**（全仓 grep `ducklake` 为空）⇒ 实现层面仍属**档②：引擎有、本环境未验** | — |

> ⚠️ 为了让「pg_duckdb 能不能读 DuckLake」这个承重问题有答案，在生产 pg_duckdb 容器执行了
> `duckdb.install_extension('ducklake')`。**追加式**（扩展目录多一个 `v1.4.3/` 子目录），
> **无任何东西自动加载它**，现有行为不变。清理方式 = 删该目录。

**结论**：技术上**可行**。否决是**取舍**，不是**不可行**。

---

## 3 收益：它治的正好是我们手搓出来的那批病

| 现状的痛（都有实测/案例） | DuckLake 原生解 |
|---|---|
| 原子提交靠手搓：`_SCHEMA/v<N>.parquet`、`.data-plane-revision` | **快照**：读者看的是某个快照，天生一致 |
| 混代 glob 整挂（#328：glob schema 取第一个文件，旧代缺列 ⇒ 整挂） | 目录管 schema；`ADD COLUMN` 是**元数据操作**，不重写旧文件 |
| 小文件（实测 **8 ms/文件**，明细 1344 个、均 30 KB，§8） | **`compact` 原生**，带 `minFileSize` / `maxFileSize` / `maxCompactedFiles` |
| 回填 = 重放，修不了缺口（#528：checkpoint key 不含 run_token） | **行级 delete/update + 快照**：按谓词改，不必整分区重放 |
| 晚到退货靠「重述窗口」+ `recon-day-heal.sh` 旁路 | 行级 upsert 取代「整天重写」 |
| ETag 竞态（§8.3 实测：读时 tick 正在写） | 快照隔离，读者撞不上「文件正在被改」 |
| 契约 + 生成器 + 3 个门禁维持列集一致 | 列集由目录管，契约可瘦身为**语义/口径**而非物理列集 |
| 「湖有源无」单次 run 判不出 | `table_changes()` 行级 CDC，缺口 = 行级 diff |

**这个对位是真的，不该淡化。** 下面是它为什么仍然不值得。

---

## 4 弊端（**结构性**，与工作量无关）

### A. 「系统记录」的位置被反转 —— 最根本的一条

| | 今天 | 换成 DuckLake 之后 |
|---|---|---|
| 谁是真相 | **对象存储**。桶里是自描述的 Parquet | **catalog 数据库**。对象存储退化成「一堆 blob」 |
| 谁能读 | 任何有 S3 凭据的引擎/人 | 必须能连 catalog + 装 ducklake 扩展 |
| 状态怎么看 | `_SCHEMA/v3.parquet` —— **人能直接看懂**的标记 | 必须查 catalog |

三条长尾后果都是**永久**的：

1. **备份/恢复从「一个系统」变成「两个系统且必须一致」**。今天备份 = 备份桶。之后 = 桶 + catalog。
   恢复到「catalog T-1 + 文件 T」⇒ 目录指向不存在的文件；「catalog T + 文件 T-1」⇒ 文件变孤儿。
   **这是新增的一整类故障，且恢复演练要重做。**
2. **catalog 挂 = 全湖不可读**。数据文件都在，但没有目录就不知道谁属于哪个快照。
3. **取证生命线断了**。今天「裸读湖」**只需要 S3 凭据**（经验库明确记着的一条生命线；
   本轮全部性能探针都靠它，见 §8）。之后取证也要 catalog 在线 + 有凭据。

### B. 格式锁定到**单一引擎家族**（这条对 Iceberg/Delta 不成立，但它们收益更小）

- **Parquet 是通用交换格式**：Metabase / psql / DuckDB CLI / Spark / Trino / Polars / pandas 都能读。
- **DuckLake 目前基本只有 DuckDB 家族能读**；Iceberg/Delta 有 Spark/Trino/Flink/Athena/Snowflake/BigQuery 生态。
- **退出成本高**：数据文件还是 Parquet，但**没有 catalog 就是「一袋无语义的文件」**，要走必须用 DuckDB 导出。

⇒ **留在纯 Parquet 是「保留最多选项」的选择**——任何 lakehouse 格式都能读 Parquet。
**换 DuckLake 是关掉选项，不是打开选项。**

### C. 本栈独有的结构性障碍：**读写两端 DuckDB 版本永远不同步**（实测，§2）

```
写方  duckle 0.7.4     →  DuckDB v1.5.5   （扩展目录 .../extensions/v1.5.5/）
读方  pg_duckdb 1.1.0  →  DuckDB v1.4.3   （扩展目录 .../pg_duckdb/extensions/v1.4.3/）
```

ducklake 扩展**按 DuckDB 版本分目录** ⇒ **写方产出的 catalog，读方要拿自己那份扩展去开**。
跨版本能否开，**本轮未验**（档②）；但**「两条线独立演进」这个结构事实是实测的**：

- duckle 按正典「**永远用最新版**」（经验库条目：duckle 永远用最新版）；
- pg_duckdb 内嵌的 DuckDB 由 **pg_duckdb 的发版**决定。

**duckle 会永远在前。** DuckLake 会把这条从「理论风险」变成**每天都要面对的事**。

### D. 快照给的是「事务一致性」，**不是**我们真正要的「完整性」

- `_SCHEMA/v<N>.parquet` 编码的是**业务断言**：「整表写齐、schema 版本 = vN」。
- **快照只说明「这些写发生了」**。我们的采集是**渐进式**的（逐小时落、逐日补、回填在后）
  ⇒ 「bizday = D 已完整」**不是一个快照边界**。
- ⇒ **封版标记不会因 DuckLake 而退役**，它会变成「记录一个 sealed snapshot id」——**换个地方继续存在**。
- 更麻烦：快照引入**第二条时间轴**（技术版本 vs 业务日）。我们的对账/口径体系假设
  「每个 (账套, 业务日) 有唯一当前真相」；有了钉版本的能力 ⇒ **同一个问题不同时间问，可能得到不同答案**。
  得新增一条政策：「报表口径以哪个快照为准」。**这是治理成本，不是技术成本。**

### E. compaction 与 retention 变成**永久运维税**

- 快照**不设 retention 就什么都不删**（`src.ducklake.maintain` 的 `olderThan` 字段描述原文：
  「DuckLake expires NOTHING without one」）⇒ 必须有删除策略。
- 删除是**破坏性**的（组件专门做 dry-run 且「在不能 dry-run 的操作上勾选会被拒绝而非忽略」）
  ⇒ 新增「删多了 / 删少了」一整类风险。
- 我们的采集是**大量小事务**（18 表 × 2 账套 × 24 小时 ≈ **864 事务/天**）⇒ 小文件**持续产生**，
  compaction 要**永远排班**（还要配告警 + 台账，三个登记面）。
- **今天这两件事都不存在**：小文件问题可以靠**布局**一次解决（§7 动作 1），不需要长期维护。

### F. 其余（真实但次要）

| 弊端 | 说明 |
|---|---|
| **单机天花板** | DuckLake 不提供分布式，扩容 = 换更大的机器。对今天的量无所谓（16k 行/天，十年 ~6000 万行），但**形状变了**（多客户 / 多源 / 事件流）它没有出路，还得再迁 |
| **CI 不再 hermetic** | 今天的守卫是**纯文本、确定性、无需实例**；DuckLake 的「真」在 catalog 里 ⇒ 测试要起实例或 mock |
| **脚手架是「换一批」不是「删掉」** | 目录管**物理列集**；**业务语义、口径、跨系统断言**目录不管。净减少没想象中多 |
| **成熟度** | Iceberg/Delta 有多年生产打磨 + 多厂商治理；DuckLake 很年轻，格式/catalog schema 演进可能带来重写 |

---

## 5 决定性的三条

1. **系统记录反转**（§4.A）——一条决定就把「桶即真相」这条今天**贯穿全部运维纪律**的性质推翻。
2. **选项关闭**（§4.B）——留在纯 Parquet 是选项最多的位置；换表格式是**关**选项。
3. **版本不同步**（§4.C）——本栈独有的结构性障碍，且**无法靠一次升级解决**（两条线独立演进）。

**而它不可替代的收益（行级改 / 时间旅行 / 多写方并发）我们今天都用不满**：
源是**外部 API 拉取、append-only**，修数是**偶发**而非常态。

---

## 6 反转条件（出现任一，重新评估；**不是「永不」**）

| 信号 | 为什么它翻转结论 |
|---|---|
| **湖被多个写入方并发写** | 封版标记**挡不住并发写**；这是 DuckLake 唯一给不了替代品的能力 |
| **行级修数成为常态**（不再靠 `recon-day-heal.sh` 旁路 + 整分区重写） | 行级 upsert 从「锦上添花」变成「刚需」 |
| **出现多源 upsert / 合并**需求 | 现在全是 append，DuckLake 的增量能力用不上 |
| **布局改造后小文件仍解不掉**（比如小时分区是硬需求） | 说明「靠布局解决」这条路走不通 |
| **出现 DuckDB 之外的计算引擎需求**（Spark/Flink/Snowflake…） | 那时该选的是 **Iceberg**，不是 DuckLake（§4.B） |

---

## 7 两件「无悔动作」（无论走哪条路都该做）

1. **修 `partitionBy`：小时 → 天**。明细是**全湖唯一的小时分区资产**（其余 17 个契约都是
   `[system_book, bizday]` 或 `[…, snapshot]`），也是唯一慢的。详见 §8.1。
   ⚠️ 这一步**动湖布局**，属架构变更 ⇒ 按 `docs/architecture.md` §5.1 / §5.2 走，**本记录不授权**。
2. **把「读湖」抽象成一层**。现在 `read_parquet(...) r` 散落在 18 个 staging 模型里。
   收到一处（或至少定一条约定）⇒ 将来无论换 DuckLake 还是 Iceberg，**改的是这一层而不是全仓**。
   **这才是真正「保留选项」的动作**——用很小的代价买下这个决定的时间。

> 第 2 条比「换不换 DuckLake」更值得现在做。它把「换格式」从全仓改写降级成局部改写。

---

## 8 附：本轮实测数据（明细读路径，2026-10-20）

> 全部在生产数据面机实测：pg_duckdb 容器内直连；湖经 pg_duckdb 的持久 S3 secret 读
> （**免凭据通路**，即 §4.A.3 说的那条生命线）。探针建的 view / table 均已 drop。

### 8.1 成本模型：**≈ 8 ms × 文件数**

冷连接（每次新建 psql = 新 PG backend = 冷缓存）：

| 查询范围 | 文件数 | 行数 | 耗时 |
|---|---|---|---|
| 1 小时 × 1 账套 | 2 | 7,947 | **0.53 s** |
| 1 天 × 2 账套 | 48 | 22,358 | **0.53 s** |
| 4 天 × 2 账套（≈ 一次真实翻明细） | 192 | 72,995 | **2.09 s** |
| 全史 28 天 × 2 账套 | 1,344 | 490,604 | **11.14 s** |
| 全史，**同一连接第二次** | 1,344 | 490,604 | **0.70 s** |

三条反直觉的实测：

1. **加线程没用**：`duckdb.threads_for_postgres_scan` 2 → 16，全史扫描 10.32 s → **10.78 s**（没变）。
   瓶颈是 ZOS **每文件 HTTP 往返**，不是并发。
2. **缓存是「连接级」的**：三条**不同**连接 9.87 / 9.49 / 9.69 s（全冷）；**同一条**连接第二次 **0.70 s**（15×）。
3. **字节不是瓶颈**：30 KB × 8 ms ⇒ 有效吞吐仅 **3.75 MB/s**。瓶颈是**开文件**。

⇒ 小文件问题的量化：文件数 = 2 账套 × 24 小时 × 天数 = **48/天**。

### 8.2 视图形态：**能读，且能下推**（**订正 2026-09-26 的一次误判**）

| 形态 | 结果 |
|---|---|
| `CREATE VIEW v AS SELECT * FROM duckdb.query($$…$$)` | ✗ 只有一列不透明 `duckdb."row"` |
| **`CREATE VIEW v AS SELECT r['列']::type AS 列 FROM read_parquet(…) r`** | ✅ **真列、真类型、谓词下推、分区剪枝全有效** |

第二种（**就是 dbt 一直在用的那种**）建出的 view，`information_schema` 里是
`order_no varchar / sale_money numeric / bizday date`，且 `where bizday = '2026-10-17'`
把扫描从 **11.14 s 剪到 0.53 s**。

> **销账**：`docs/superpowers/specs/2026-09-26-detail-read-view-design.md` §5 的 **gate 2「分区裁剪」**
> 原文记「3 天数据下 207 ms vs 249 ms，分不出差别 ⇒ 未定论」。**现已定论：裁剪成立。**
> 该 spec 是历史快照（`docs/architecture.md` §6.1 纪律：正文一律不改）⇒ 销账记在本文件 +
> `docs/architecture.md` §6.1 的订正指针。

### 8.3 顺带发现

| 发现 | 说明 |
|---|---|
| **ETag 竞态实测复现** | CTAS 中途报 `HTTP Error: ETag on reading file "…/bizday=2026-10-20/hour=15/all.parquet" was initially "…" and now it returned "…"` ⇒ **读湖时 tick 正在写今天的分区**。这是 #452 那条竞态的直接观测 |
| **内存配置不一致（真实风险）** | `duckdb.memory_limit = 4096` MB，而容器 cgroup `Memory = 2147483648`（**2048 MB**）⇒ DuckDB 以为自己有 4 GB，会一直用到 4 GB 才 spill，重查询下会被 **cgroup OOM kill**。应对齐到 ~1536 MB。**待办，不在本决策范围** |
| **`duckdb.force_execution = off`** | pg_duckdb 的既有缺省；视图面可用性已由 §8.2 实测确认，无需改 |
| 物化侧分解 | 明细模型 dbt 内 **28–92 s**（中位 ~36 s，随排班波动）；单跑冷态 **27.8 s** = 开文件 11 s + 读列/写 PG 堆表 ~17 s。写 PG 堆表那一段是 **Postgres 的成本**，不是 DuckDB 的 |

---

## 9 边界 / 未验（**不许当结论用**）

1. **跨 DuckDB 版本开 DuckLake catalog**（§4.C）：**未验**。实测的是「两个版本并存」这个事实，
   不是「1.4.3 打不开 1.5.5 写的 catalog」这个行为。
2. **DuckLake 在本环境的端到端**：未做。只验到「扩展能装能载」（§2）。
3. **「合并小文件」在纯 Parquet 下的替代**：duckle **没有**通用的 compaction 组件
   （`src.ducklake.maintain` 只对 DuckLake 生效）⇒ 属**③档**，已登记进
   `duckle/README.md` §7.4.1。
4. **本决策要不要升格成 `docs/architecture.md` §4 的不变量**：**另一个决定**。
   按本仓规矩（无案例不立标准），现在只有这一次决策案例 ⇒ 先落在 §2.7，**不升格**。
5. **§7 的两件无悔动作**都**未开工**；动作 1 属架构变更，需单独走流程。

---

## 10 关联

- 决策正文：`docs/architecture.md` §2.7；订正指针：§6.1
- 缺口登记：`duckle/README.md` §7.4.1
- 明细读视图（已拍板、未实现）：`docs/superpowers/specs/2026-09-26-detail-read-view-design.md`
  —— 本轮**销掉它的 gate 2**（§8.2）；gate 1（新鲜度）/ gate 3（竞态）**仍待**
- 湖的 schema 演进正典：`docs/architecture.md` §5.2（四件套 + 展开→迁移）
- duckle 原生优先正典：`docs/data-platform-handbook.md` §1.1（三档）/ §1.1.1（E3 证成方法学）
