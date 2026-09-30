# 零售明细湖分批回填工具链（D1=B 的执行面）

> **状态**：**已交付，未执行回填**。本批只交付工具链 + lab 验证，**零生产写入**
> （不 exec 生产容器、不 seed、不调生产 API、不写湖）。
>
> **立题**：issue #387。**硬上游**：#374（读侧迁移 spec，D1=B 裁决 + D2 探针裁决）·
> #328（历史回填，本条是它的执行面）· #294（契约 v2 的 6 个新列）· #327（Lab B 的 B-3 实证）。
>
> **判据正典**：`docs/superpowers/specs/2026-09-29-read-side-migration.md` §4.0（不变量）与
> §4 Phase 0/1 —— 本文件与工具链**逐字实现**那两节，不发明新判据。

---

## 0 结论摘要（先读这个）

1. **回填不能用引擎自带 `POST /api/backfills`**：它要求管线声明 `partition` 块，本仓管线**没有**
   （`plan_for` 直接报「declares no partition」）。本工具链走的是**参数化 run**：
   回填变体父管线里的 `${BIZDAY}` 是**非内建占位符** ⇒ 等于声明了一个参数
   （源码 `context::discover_parameters` 会跳过 `workspace`/`projectroot`/日期时间族/`ENV:`/`VAULT:`），
   而 `POST /api/run` 与 `/api/run/async` 都收 `{"file":"…","params":{"BIZDAY":"…"}}`。
   **这条写在这里是为了免得后人再试一次 `backfills`。**
2. **交付物**：① 回填变体父管线（与现 L1 父管线**唯一差异 = 窗口来源**，见 §2）② 驱动脚本
   （两道闸 + 逐批判据 + 一次一批，见 §3）③ 本文件（含 §4 一页 runbook）④ 本机 lab（§5）。
3. **两道闸的分工，别混**：
   - **① Phase 0 守卫**（fail-closed）：最老分区 `parquet_schema` 行数必须 = **19**（18 列 + 根节点），
     否则**拒绝执行**、非零退出。它挡的是「不变量已经破了还往上写」。
   - **② 顺序闸**：要跑的那批必须是**当前第一个未完成批**，否则拒绝。它挡的是「跳批」与
     「先手动把最老分区补了」——**①挡不住这两类**：误序发生时最老分区**还是** 18 列，守卫照样放行。
4. **lab 41 条判据全绿**（本机回环 S3，零生产）：守卫放行/拒绝、顺序闸拒绝、批前判红、**误序 ⇒
   整湖混读真挂（`schema mismatch in glob`）**、五批依次通过、批次列数 25、整湖混读仍通、
   **后置分区缺列 ⇒ 判据仍能判红**（证明判据不是空转）。

---

## 1 交付物清单

| # | 仓内路径 | 是什么 |
|---|---|---|
| 1 | `deploy/duckle/console/pipelines/lemeng.retail.windows.backfill.json` | 回填变体**父**管线（**只回填用、不进调度**；子管线 `lemeng.retail_order_line.window.json` 复用不改） |
| 2 | `scripts/lemeng/backfill-retail-order-line.sh` | 驱动脚本（进清单 `/opt/lemeng-backfill.sh` 0755；可执行位已在仓内） |
| 3 | `scripts/lemeng/backfill-retail-order-line.test.sh` | 纯逻辑行为测试（90 条；**已进 CI gates**） |
| 4 | `scripts/lemeng/backfill-lab.sh` + `scripts/lemeng/backfill-lab/lab.py` | 本机 lab（回环 S3 混代小湖 + mock 网关 + mock console） |
| 5 | `deploy/data-plane-manifest.txt` / `deploy/data-plane.lock` | 清单登记 + lock 重生成（守卫 `check-data-plane-lock` 已绿） |
| 6 | `deploy/duckle/console/DELIVERY.md` §0.3 | 投递口径：进清单、**不进调度**、回填时才 seed |
| 7 | `.github/workflows/ci.yml` | gates 加一条：跑 ③ 的行为测试 |

---

## 2 回填变体父管线：与现 L1 父管线的**逐字差异**

`deploy/duckle/console/pipelines/lemeng.retail.windows.backfill.json` 由
`lemeng.retail.windows.l1.json` **机械改写**生成（生成后做过 JSON 往返比对：格式逐字节一致）。
**结构差异只有 3 处，全在「窗口来源」这一处之下**（脚本可复算，见 §5 的 lab 手法）：

| 处 | 现值（L1 父） | 回填变体 |
|---|---|---|
| **W1** `w0` 窗口表的 `bizday` 列 | `strftime((now() AT TIME ZONE 'Asia/Shanghai') - INTERVAL 1 DAY, '%Y-%m-%d')` | `'${BIZDAY}'`（**参数**，由驱动脚本按 bizday 降序逐日传入） |
| **W2** `gv` 的 BIZDAY 形状闸 | 断言上面那条 SQL 的现算值 | 断言同一个 `${BIZDAY}` 参数（形状 `YYYY-MM-DD`）；**仍只算常量、不读 input**（照抄 L1 的设计） |
| **W3** `dz` 的判红文案 | 「windows 形只采上海昨天、无回溯重放 ⇒ 尾窗必须当日补跑」 | 该句对回填形**不成立**（回填正是参数驱动的回溯重放）⇒ 改写成回填形的处置：可整批重跑（checkpoint 让已成功窗只补缺页），**但失败即停、不许跳批** |

**逐字照抄、一处未动的部分**（别以为改了）：`v0..dv` 身份门（whoami 探针 → 抠 SSE → 身份事实 →
d0 反向闸 → 账套/门店断言 → d1 → `gv` → `dv`）· `fe`（`ctl.foreach`，`retryAttempts=4` /
`retryBackoffMs=60000` / `continueOnFailure=true` / `itemKey=hour`）· `wm`+`wsink`（收据形状锚）·
`a1`/`a2`（定序）· `su`/`rep`/`sr`（汇总与判红输入）· `dz` 的 `condition=has-rows`。

- `_note` 头部新加了一段说明，随后**逐字保留**原 L1 的 ①..⑧（含那条「inline foreach 持续失败会
  截尾、被截的尾窗次日调度不补」的已知回退）——它对本形同样成立，是本形「失败即停 + 人复核」的理由之一。
- **不进调度**：`deploy/duckle/console/schedules/*.json` 里**不得**出现它（本批未改那两个文件）。
- 编译核验：`validate` 对**回填变体本体**通过（19 stages，与 L1 父同数）；`check-duckle-catalog`
  真跑引擎绿（工作区管线 8 个、15 资产、lint 无 finding）。

---

## 3 驱动脚本：接口、两道闸、判据字面量

```
sh backfill-retail-order-line.sh plan                     # 五批表 + 每批状态 + next（只读）
sh backfill-retail-order-line.sh guard                    # Phase 0 守卫（只读）
sh backfill-retail-order-line.sh verify [N]               # 批后判据（只读）
sh backfill-retail-order-line.sh run [--batch N] [--force] # 守卫 → 顺序闸 → 触发 → 等批 → 批后判据
```

**一次调用只做一批**（跑完即退出、**不自动续下一批**）：批次边界要人看得见。批次表（spec §4 Phase 1 逐字）：

| 批 | 重写 | 批前 | 批后 |
|---|---|---|---|
| 1 | 3120 09-27、64188 09-27 | 探针 = 19 | 该批分区 `parquet_schema` = 25；整湖混读仍通 |
| 2 | 3120 09-26、64188 09-26 | 同上 | 同上 |
| 3 | 3120 09-25、64188 09-25 | 同上 | 同上 |
| 4 | 3120 09-24 | 同上 | 同上 |
| **5（最后）** | **3120 09-23** | 同上 | 同上 + **探针变 25** = 全湖均一 |

**判据怎么实现（关键细节，别改）**：

- **Phase 0 探针**用 `parquet_schema(...)` 的**行数**（19 = 18 列 + 1 行根节点）。**不许**
  用「选新列能不能跑通」当探针 —— 实测「新形在前但不投影任何列」**不报错**（spec §2.3 末条）⇒ 那种探针给假绿。
- **批后「整湖混读仍通」**用 spec §4 的查询**逐字**：`from read_parquet(glob) r` + `r['order_no']` /
  `r['bizday']`，判据是 **`orders = n`** 且 **`mind = 2026-09-23`**。**绝不用 `count(*)` 当判据**（对列集不敏感）。
  形态留在 `r['列名']` 也是门禁规则① 守的形态（`dbt/README.md` §6）。
- **批后列数判据**一次查询拿全批读数：`parquet_schema` 只接受**字面量**、不支持 lateral join 的列参数
  ⇒ 24×N 个字面量调用 `UNION ALL` 展开（脚本 `batch_schema_sql` 生成）。
- **等批**看**尾窗**（`hour=23`）的列数是否变 25 —— 依赖 `ctl.foreach` 的 `concurrency=1` 按 00..23 顺序写窗。
  （若将来改并发，这条要先改，见 §6。）

**顺序闸的三种判决**（`order_guard`）：要跑的批 == 第一个未完成批 ⇒ 放行；**大于**它 ⇒ 拒（跳批）；
**小于**它 ⇒ 拒（回头补已完成批）。两种拒绝都可用 `--force` 显式越过（会打印告警）。
五批全完成后再 `run` ⇒ 拒（`回填已完成`），这是**设计**，见 §4 的「别当故障」。

**退出码契约**：`0` 通过 / `1` 判据不通过或拒绝 / `2` 用法错 / `3` 湖通道不可用。
可 grep 的字面量：`PHASE0_GUARD=PASS` · `PHASE0_PROBE … parquet_schema_rows=19` ·
`BATCH_SCHEMA_OK:` · `WHOLE_LAKE_OK:` · `BACKFILL_OK batch=N` ·
`BACKFILL_REFUSED:phase0` · `BACKFILL_REFUSED:out_of_order` · `BACKFILL_FAILED:…`。

---

## 4 Runbook（一页）：怎么跑、每批判据、出事怎么办

### 4.1 前置（只读，先做）

1. 🔴 **seed 管线（硬前置——2026-09-30 生产实例：漏了这步，触发即 `HTTP 400 not found: pipelines/lemeng.retail.windows.backfill.json`）**：
   把 `lemeng.retail.windows.backfill.json`（父）与 `lemeng.retail_order_line.window.json`（子，**回填复用**；若该账套已在跑 L1 则**卷内已有**，确认即可）`docker cp` 进**两个账套各自的**
   `/workspace/pipelines/`，随后**重建 catalog**（见 `deploy/duckle/console/DELIVERY.md` §0.3 与 §1④）。
   **别碰 `schedules.json`**：本管线不进调度。
   ⚠️ 注意 sync **不会 seed**（sync 只刷新检出；卷内要靠 `docker cp`），且**检出更新不等于卷内更新**——两件事分别确认。
2. **凭据**：`DUCKLE_TOKEN`（两个 console 的 Bearer）——值在 openship env(isSecret)，**不写明文**。
   🟢 2026-09-30 生产实例的**取法**（宿主上没有该 env）：`DUCKLE_TOKEN=$(docker exec <console容器> printenv DUCKLE_TOKEN)`——**在命令内现取**，值只活在当次进程内存，**不回显、不落日志**。
   `ZOS_BUCKET` 供湖侧寻址（pg_duckdb 通道本身免凭据）；🟢 同一实例：裸 exec 上**没有** `ZOS_BUCKET` ⇒ 不给就 `LAKE_CHANNEL_UNAVAILABLE`（fail-closed，正确行为），调用时带上即可。
3. **定位 console**：一账套一 console（3120 → `127.0.0.1:18080`，64188 → `127.0.0.1:18081`）；
   用 openship MCP 实测定位容器与所在机，**别凭记忆**（`DELIVERY.md` §0.1）。
4. **只读确认读数**：`sh /opt/lemeng-backfill.sh plan` —— 五批状态 + `next: batch 1`；
   `sh /opt/lemeng-backfill.sh guard` —— 期望 `parquet_schema_rows=19` + `PHASE0_GUARD=PASS`。
   **这两条任意一条不对就别往下走。**

### 4.2 逐批执行（每批一条命令，跑完看读数再决定下一条）

```sh
sh /opt/lemeng-backfill.sh run --batch 1     # 之后 2 / 3 / 4 / 5，逐条来
```

每批打印的判据（**缺一条即视为没验**）：

| 读数 | 含义 |
|---|---|
| `PHASE0_PROBE … parquet_schema_rows=19` + `PHASE0_GUARD=PASS` | 批前守卫过（最老分区仍 18 列） |
| `trigger ok: book=… bizday=… HTTP=2xx` | 两个账套各触发一次（一账套一 console） |
| `wait: 该批尾窗（hour=23）全部 25 行` | 该批 24 个窗都重写完了 |
| `BATCH_SCHEMA_OK: 48 个分区均 25 行（= 24 列）` | 该批**全部分区**列数对（批 1 两账套 = 48；批 4/5 = 24） |
| `WHOLE_LAKE_OK: n=… orders=n mind=2026-09-23 maxd=…` | 整湖混读仍通（**相对判据，不含绝对行数**） |
| `BACKFILL_OK batch=N` | 收尾；**下一批要另调一次** |

第 5 批额外打印 `PHASE0_PROBE 复读：最老分区 = 25 行 ⇒ 全湖均一`。
**回填完成后 `guard` 必然拒绝**（最老分区已 24 列）—— 这是 D2 的 fail-closed 设计，**不是故障**；
此后 `plan` 会打 `next: （全完成）`。

### 4.3 出事怎么办

| 现象 | 含义 | 处置 |
|---|---|---|
| `BACKFILL_REFUSED:phase0`（**批前**） | 最老分区已不是 18 列 | **停**。回填已完成 ⇒ 正常；否则不变量已破 ⇒ 别再写，按 §6 升级 |
| `BACKFILL_REFUSED:out_of_order` | 跳批或回头补 | 先跑脚本点名的那个批（或显式 `--batch N`）；确要幂等重跑已完成的批 ⇒ `--force` |
| `BACKFILL_FAILED:wait 超时` | 该批没跑完（失败/截尾/引擎没起） | **失败即停**：别跑下一批。看该 console 的 `runs/receipts/` 与 `alerts`；同一 bizday 重跑该批即可（checkpoint 让已成功窗只补缺页） |
| `BACKFILL_FAILED:batch_schema` | 该批有分区不是 24 列 | 同上（重跑该批）；若是**后置**分区缺列，先看是不是有人手工动过湖 |
| `BACKFILL_FAILED:whole_lake` | **不变量可能已破**（整湖混读挂或 `orders≠n`/`mind` 不对） | **最高优先停手**。这通常意味着「最老分区已被提前重写」或「某分区缺列」。**唯一读侧救援 = 切方案 A**（`duckdb.query` + `union_by_name`，spec §3.2 与 §4 回滚点，可行性已在 spec 里验通）——这是 B 的事故预案，不是可选优化 |
| `LAKE_CHANNEL_UNAVAILABLE` | 湖通道读不到（容器不在 / 权限） | 修通道再跑；**读不到 ≠ 通过**（脚本 fail-closed，不会静默放行） |

🔴 **回填本身不可逆**：它用新管线覆盖写，旧 18 列管线已退役 ⇒ **没有任何办法把分区改回 18 列**。
「不再继续回填」是可行的**暂停**（湖停在混代），**不是回滚**（spec §4 回滚点，逐字照搬）。

---

## 4.5 🟢 生产实跑记录与两处订正（2026-09-30，五批全部完成）

**结果**：五批全 `done`、`next:（全完成）`；终态 `n == orders == 146,743`、跨度 2026-09-23..09-30、最老分区 `parquet_schema = 25`（= 24 列）⇒ **全湖均一**。全程现行读法可读。逐批读数见 issue **#328** 评论。

**两处当场暴露、本 PR 已修的工具缺口**：

1. **整湖判据撞「当天分区」的写入竞态**：批 3 重写成功，但整湖判据报 `BACKFILL_FAILED:whole-lake 判据通道失败`——复现确认根因是**扫到正被 tick 每 5 分钟覆盖写的当天分区**（`ETag … file has changed` 原文在 #328）。**fail-closed 停住是对的**；人工判明性质后从批 4 续跑即通过（间歇竞态）。⇒ 修法：判据 SQL **排除「当天及以后」的 bizday**（当天恒 24 列、对不变量无信息量）+ 通道失败**重试一次**（输出留痕，非静默）。
2. **runbook 前置不完整**：首次触发报 `not found: pipelines/…backfill.json`（变体管线没进卷）⇒ seed 步骤升为**硬前置**并写明报错形状；`DUCKLE_TOKEN` 在宿主上**没有** env 来源 ⇒ 补「从 console 容器现取」的取法（值只在进程内存）。

---

## 5 lab 验证（本机，零生产）

`sh scripts/lemeng/backfill-lab.sh` —— 现场：`npx s3rver` 起一个**回环 S3**、
`scripts/lemeng/backfill-lab/lab.py` 造**混代小湖**并起 **mock 网关 + 两个 mock console**，
然后让**驱动脚本原样**（`LAKE_CHANNEL=duckdb`，本地 duckdb CLI + 回环 S3）跑它自己的 SQL。

**湖的形状照抄生产**（spec §1.2 的订正版）：`system_book=3120` 的 09-23..09-27、
`system_book=64188` 的 09-25..09-27 = **18 列**；两账套的 09-28 = **24 列**；
路径形状 `…/system_book=/bizday=/hour=/all.parquet` 与生产**逐字相同**（真 hive 三级分区）。

**结果：41 条判据全绿**，逐条对应任务要求的四类：

| 类 | 断言 | 结果 |
|---|---|---|
| ① 守卫 fail-closed | 最老仍 18 列 ⇒ 放行（`rc=0` + `PHASE0_GUARD=PASS`）；**回填完成后**最老已 24 列 ⇒ 拒绝（`rc≠0` + `BACKFILL_REFUSED:phase0`） | ✅ 两向都验 |
| ② 顺序约束 | `run --batch 5`（跳批）与 `run --batch 2`（跳批）都被拒（`BACKFILL_REFUSED:out_of_order`） | ✅ |
| ③ 批后判据不是空转 | 批没跑时 `verify 1` **判红**（`BACKFILL_FAILED:batch_schema`）；五批依次 `run` 后每批打 `BATCH_SCHEMA_OK:`（25 行 = 24 列）+ `WHOLE_LAKE_OK:` | ✅ |
| ④ 不变量被破的复现 | 在**负例湖**上先把最老分区（3120/09-23）重写成 24 列 ⇒ 整湖混读**真挂**，报错逐字含 `schema mismatch in glob`；**对照**：同一查询在未误序的主湖上仍通、`mind=2026-09-23` | ✅ |
| ④补 | 跑完全程后，把一个**后置**分区（3120/09-24/hour=05）改回 18 列 ⇒ `verify 5` 判红在**整湖混读**面 | ✅ |
| ⑦ 不是空壳 | mock 网关确实被取过新列（`order_rows=8`）；3120 的 mock console 确实收到 5 次回填触发 | ✅ |

**lab 里 `whole_lake_sql` 是「逐字抽出来」用的，不是复制一份**（`awk` 抽 `lake_root`/`lake_glob`/
`whole_lake_sql` 的函数体到临时文件 source 进来跑）——抽不到就判红，避免「测试自己漂移」。

**纯逻辑面**另有 `scripts/lemeng/backfill-retail-order-line.test.sh`（**90 条**，从脚本抽真函数测，
不复制实现）钉住：批次表逐字、`PROBE_EXPECT=19` / `UNIFORM_EXPECT=25` / `OLDEST_DAY=2026-09-23`、
湖侧 SQL 的形态（留 `r['列名']` 取列形态、**不许出现 `union_by_name`/`hive_partitioning`**、不许有尾分号）、
读数解析抗噪（psql NOTICE / 空输出）、顺序闸三判决 + `--force`、`console_url` 路由、
`batch_state` 的 done/pending/partial/unknown。**这条已进 CI `gates` job**（本仓其他 `.test.sh` 未进 CI，
理由写在 ci.yml 那一步的注释里：本工具的判据是**数字与顺序**，静态守卫看不见）。

**踩坑一条（已加测试兜住）**：判红消息里写了 `` `plan` ``（反引号），在**双引号**里被 sh 当
**命令替换**执行 ⇒ 消息里混进 `plan: command not found`。现在测试里有一条静态断言：
脚本正文（非注释）里**一个反引号都不许有**。

---

## 6 边界与未验面（诚实清单）

1. **回填本身未执行**：本任务零生产写入。所有「真机读数」都来自 spec §2 的既有只读实测，
   本文件不重复也不改动它们。
2. **lab 的块存储是本地 `s3rver`，不是天翼 ZOS**。判据的语义（glob 顺序、hive 分区、列数、
   `schema mismatch` 文案）是**引擎侧**行为，与端点无关；但**协议/鉴权面**（ZOS 的 S3 兼容细节、
   代理、签名）**未在本 lab 覆盖**。生产通道用的是 `pg_duckdb` 免凭据回读（与 diagnose.sh 同形）。
3. **`/api/run/async` 的端到端未在真机实跑**：`params` 契约来自源码级查证
   （`context::discover_parameters`）与仓内 `DELIVERY.md` 的 `/api/run` 形状；脚本只判 **HTTP 2xx**
   并把响应体前 300 字节打出来，**不解析 runId**（响应体形状未验 ⇒ 不依赖它）。
   `mock console` 用同形契约实现了 `/api/run/async`，但它证明的是**脚本这一侧**正确。
4. **等批判据依赖 `ctl.foreach` 的 `concurrency=1`**（按 00..23 顺序写窗）⇒ 尾窗 `hour=23`
   是「全部写完」的可靠信号。**若将来改并发，这条必须重验**。
5. **顺序闸是纪律，不是引擎强制**（spec §4.0 自己的诚实面）：不变量在「第一个文件仍是 18 列」时
   对**其它**分区是宽容的（18 列是任何列集的子集）⇒ 严格说只有「最老分区最后」是引擎硬要求，
   降序的其余部分是本仓加的纪律。D2 的处置就是把它做成闸。
6. **`--force` 是逃生舱**：它允许越过顺序闸（幂等重跑已完成的批）。它**不**绕过 Phase 0 守卫
   （守卫在顺序闸之前、无条件跑）——但仍要人判断「全湖是否已均一」。**别把它当常规路径。**
7. **`count(*)` 类的绝对行数一律不做判据**（当天数据在涨）；本工具全部用**相对**判据
   （`orders = n`、`mind`、分区数、列数）。
8. **lab 不进 CI**（需要 node/npx + duckdb CLI，且起本地服务）；进 CI 的是纯逻辑测试（§5 末）。
9. **未做的相邻项**（明确不在本批）：回填的实际执行与验收（#328）· 读侧 6 列（Phase 2，回填全绿后）·
   marts 是否暴露新列（D4）· 未来再漂移的策略（D6）。
