# 诊断/对账工具替代设计（Wave D §7-U3 的硬前置）

> **性质**：**设计 spec，零实现代码**。本文件只回答「替代面长什么样、凭据走哪条、什么时候换」，
> 不写脚本、不碰生产（本次全程只读：无 seed、无写入、无调度变更）。
>
> **正典指针（本文件不复述正文，冲突以正典为准）**：
> 采集任务标准形态 = `docs/data-platform-handbook.md` §1.1.7 · 四层验收 = 同 §1.4 ·
> 投递程序 = `deploy/data-plane-deploy-sop.md` §E / 生效动作三类 = §F.2 / 排障入口 = §F.4 ·
> L0/L1 验收五点 = `deploy/duckle/console/DELIVERY.md` §3 · 引擎能力与方言坑 =
> `docs/superpowers/specs/2026-09-28-duckle-orchestration-capability-survey.md`。
>
> **关联**：Closes #348 · Refs #343（Wave D 计划 §7 U3 裁决）· Refs #318（全量管线改造母计划）。

---

## 0. 本文件要解决的问题

### 0.1 触发它的裁决

Wave D 计划（#343）§7 拍板 **U3 = (b)：连 `recon` / `rb` 一起废**（**人选，非该计划的推荐项**——
计划推荐 (a) 只废采集形）。该裁决自带硬前置，原句：

> 🔴 **硬前置**：先造**替代的只读对账工具**。`recon` 是 `DELIVERY.md` §3 **判据 2 的指定工具**，
> 也是缺口排障的现成手段；无替代即废 = 自断手脚。

⇒ 本 spec 就是那个「替代面」的设计。**它是删除动作的前置，不是删除动作本身。**

### 0.2 术语消歧：本仓有两个「recon」，别混

| 所指 | 是什么 | 在哪 | 本文覆盖？ |
|---|---|---|---|
| **`run-retail-day.sh recon <H>`** | **机械对账**：某 `hour` 的**湖分区单文件** vs **网关当刻累计**，两侧**明细行数**逐分对照，容差 0 | `scripts/lemeng/run-retail-day.sh`（`recon` 分支） | ✅ **本文就是为它** |
| **独立通道对账** | **业务口径对账**：明细聚合 vs 预聚合端点（`branchindicator` / `itemsales`），逐店逐日 diff | `docs/superpowers/specs/2026-09-28-lemeng-recon-attribution.md`（issue #287）；落 `recon/` 前缀的 duckle 管线（设计稿，见采集链路设计 §对账源） | ❌ **不是**。那是 handbook §1.4 四层验收的**第三层（独立通道）** |

> ⚠️ 两者**都叫 recon、都属「对账」、但验的不是同一件事**。前者验的是「**同一上游的两侧自洽**」
> （湖快照 == 网关实时累计），属四层里的**第一层（自证 / 写后回读）**；
> 后者用的是**另一个数据源**，才是「独立通道」。**替代设计只承接前者**——把后者一起塞进来
> 会把「离线业务对账」与「实时采集自检」两种生命周期截然不同的东西合进一个工具（正典明令禁止合并）。

### 0.3 本文件的边界

- **只出设计**：能力盘点 / 方案对比 / 迁移路径 / 待拍板项。**不写实现代码。**
- **不替人决定**：所有需要拍的板集中在 §5，正文只给推荐与代价，不给既成事实。

---

## 1. 能力盘点

> 盘点方式：**读源码**（`scripts/lemeng/run-retail-day.sh` 1021 行，16 个 `case` 分支）+
> **只读实测**（2026-09-29，对数据面机 `8281d598…`，见 §6 证据）。

### 1.1 `recon`（核心：要被替代的那一个）

| 项 | 事实 |
|---|---|
| **入口形状** | `sh /opt/lemeng-run.sh recon <H>`（`H` = 两位小时；`bizday` 缺省 = 上海日历日**昨天**，`SYSTEM_BOOK` 缺省 3120） |
| **输入** | `bizday` / `hour` / `system_book`（env） |
| **湖侧** | 精读**单文件** `s3://${ZOS_BUCKET}/lemeng/retail_order_line/system_book=<SB>/bizday=<D>/hour=<H>/all.parquet` → `count(*)` = `lake_rows`、`count(DISTINCT batch_id)` = `lake_batches`。<br>**不带 `hive_partitioning`、点名单文件**——理由是路径里的 `hour=NN` 与载荷列 `hour` 同名，hive 列会引入遮蔽歧义（源码注释逐字） |
| **网关侧** | `POST https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.pos.posorder.find`，body 与管线 `src.rest` **同一形状**（`branch_nums` / `date_from|to` / `time_from|to` / `page_number` / `page_size=200`），`responsePath=/result`；**翻页到空页为止**，把每单的 `pos_order_details` 数组**长度求和**（= 明细行数，与管线 `UNNEST` 的行粒度对齐） |
| **判据（三条，全要）** | ① `lake_batches == 1`（分区内恰一个 `batch_id` = 最新完整快照）；<br>② `lake_rows == gateway_rows`（**容差 0**）；<br>③ **未闭窗小时拒比**：`bizday` 为今天且 `hour ≥ 当前上海钟点` ⇒ 直接拒绝（湖=最近 tick 快照、网关=当刻累计，**合法不等**，比了必假红） |
| **容量闸** | `RECON_PAGES = 12`——与管线**同数**（12 节点 × 200）；第 12 页仍满 ⇒ 判红（「取不全，对账无从谈起」）。**这是与采集面的一处硬耦合**：管线的分页形状一改，这里必须同步 |
| **退出码契约** | `0` = 全等；非 0 = 有失败面；失败字面量可 grep：`RECON_FAILED:lake\|gateway\|rows\|batches\|hour\|hour_open`，通过时打 `RECON_OK hour=<H> rows=<N> batches=<N>` |
| **凭据面** | 湖侧：`ZOS_*` 五键（经 `rb` 通路）；网关侧：`LEMENG_TOKEN` + `BRANCH_NUMS` + `SYSTEM_BOOK`。**无免凭据通路**（见 §2） |
| **副作用** | 对湖/网关**只读**；但 ① 落 `/tmp/recon_gw.json`、`/tmp/recon_lake.err`；② 脚本级 `EXIT` trap 在**非零退出**时会走 `notify_fail`（企微通知，受 `LEMENG_NOTIFY` 门控）⇒ **判红会发通知**，这是「只读工具」里唯一的外向动作 |
| **事实源耦合** | 网关调用形状的**唯一事实源**是 `duckle/common/lemeng.retail_order_line.json`（`src.rest` 的 body/`responsePath`/`page_size`）。源码注释明写：「改那边要同步这里」 |

### 1.2 同族只读形（同一脚本里的其余分支）

| 分支 | 做什么 | 读写 | 凭据 | 是否被正典指定为工具 |
|---|---|---|---|---|
| `rb <SQL>` | **通用只读 SQL 执行口**：把任意 SQL 塞进 duckle 容器内的 duckdb（`readback-helper.sh` 运行时拼 `CREATE SECRET`，值不进命令行/日志） | 只读（但无护栏） | `ZOS_*` | 无（是内部/逃生舱） |
| `agg` | 日批湖回读汇总：逐 `hour` 行数/金额、总计、`state` 分布 | 只读 | `ZOS_*` | 无 |
| `branches` | 逐门店 `FINISHED` 金额/行数 | 只读 | `ZOS_*` | 无 |
| `listing` | S3 列**当日前缀**对象清单 + 断言（非空 / 未截断 / key 无 `${ENV` 字面量残留）；另做「裸 `=` vs pct 编码」前缀探针 | 只读 | `ZOS_*` | 无（S1/Task 验收工具） |
| `probe` | 环境体检：打印 10 个环节变量的**长度**（不回显值）、桶探针、容器探针、`duckle --help` 片段 | 只读 | 需 `ZOS_*`（容器探针） | 无 |
| `diag` | 桶根列举 + 容器内变量长度 + `/workspace` 本地落盘回退检查 | 只读 | `ZOS_*` | 无 |
| `identity` | 启动自证：`whoami` 探针（SSE，重试 3 次）断凭据↔账套、门店清单↔账套 | 只读 | `LEMENG_TOKEN` + `BRANCH_NUMS` | 无（已由 L1 管线内身份门原生化，见正典 §1.1.7） |
| `drift [H]` | 契约漂移门禁：先断言 `data.schema` 声明存在（防假绿），再跑 `duckle drift --pipeline`，断言 `checked > 0` | **待核**（`duckle drift` 是否写盘，本 spec 未取证） | `DUCKLE_TOKEN` + `ZOS_*` + `LEMENG_TOKEN` | 无（CI 侧相邻守卫 = `scripts/check-duckle-catalog.mjs`） |

### 1.3 🔎 「只读诊断形」名单的审计订正（**本次盘点的实质发现**）

Wave D 计划 §4.5 把 12 个分支整体归为「**只读诊断形（不废弃）**」。**逐分支读源码后，其中两条不是只读：**

| 分支 | 计划里的归类 | 实际 | 证据 |
|---|---|---|---|
| **`idem3`** | 只读诊断形 | ❌ **写湖**。它调 `sh "$0" window "$H" …` **三次**（同 `batch_id` 两跑 + 换 `batch_id` 一跑）= **写三次湖分区** | `idem3` 分支 L962-977；`run_window_window` L505-538 跑的是真管线 `duckle --pipeline …`（有 `snk.minio` 落盘） |
| **`envfile`** | 只读诊断形 | ❌ **写宿主机文件**。把 `DUCKLE_TOKEN` 物化成 `${REPO}/deploy/.env`（0600） | `envfile` 分支 L1008-1013 |
| **`window` / `windows` / `tick` / `dim`** | 采集调用形（可废弃） | ✅ 写湖（归类正确） | `run_window_window` 同上；`dim` 分支跑维度管线 |

**为什么这条重要**：U3 要造的是「**只读**对账/诊断工具」。按那张表整体照搬 ⇒
会把**两个写模式**（写湖三次 / 写宿主 `.env`）搬进一个宣称只读的工具里，
且它俩的写面**没有任何前置自证**（`idem3` 不做 `identity_assert`，`envfile` 更不做）。
⇒ **替代面必须显式排除它们**（§3.4），其去处是 §5 的待拍板项。

> 另注：`idem3` 验的「字节级幂等」在 **Wave B/C 起已有更强的原生承载体**——L0/L1 的 run 回执 +
  `runs/<pipeline_id>.json` 的 `assets` + `count(DISTINCT batch_id)==1` 锚（`DELIVERY.md` §3 判据 3、
  Wave B 报告）。是否仍需要「三跑 ETag 对照」这一动作本身，属另一议题。

### 1.4 「被指定为工具」的出处（**替代时必须逐处改指针**）

| # | 出处 | 原文口径 | 替代后怎么改 |
|---|---|---|---|
| 1 | `deploy/duckle/console/DELIVERY.md` §3 判据 2 | 「工具：既有的只读对账模式 `sh /opt/lemeng-run.sh recon <H>`（…**容差 0**）」 | 指向新工具；**判据本身一字不改** |
| 2 | 同上 §3 判据 2 的「免凭据独立回读」段 | 「`pg_duckdb` 已配 S3 secret，可直读湖…`duckdb.query($$…$$)` 包裹」 | **已在正典里**——新工具的湖侧通道应与它对齐（§3.3） |
| 3 | 同上 §5 陷阱 4 | 「≥2 tick 缺口…必须走补采 SOP（`run-retail-day.sh recon <H>` 对照 + 定点重跑）」 | 指向新工具 |
| 4 | 同上 §6 边界表 | 把 `run-retail-day.sh` 的废弃列为 Wave D 收口项 | 收口时把「废弃」改成「已由 `<新工具>` 承接」 |
| 5 | `docs/data-platform-handbook.md` §1.4（F 验收行） | 「闭窗小时用 `run-retail-day.sh recon <H>` 对照（湖回读 vs 网关翻页累计，容差 0）」 | 指向新工具 |
| 6 | `docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md` §4.6 / §9.8 | 「定点补采工具未验，列为待定 SOP」 | §9.8 的待定项在替代工具落地后**销账** |
| 7 | `docs/superpowers/plans/2026-09-29-waveD-64188-retirement-closeout.md` §4.5 / §7-U3 | 形态边界与裁决 | Wave D 收口时按裁决更新 |
| 8 | 能力调查 `2026-09-28-duckle-orchestration-capability-survey.md` §6 #14 / §7.3 | 「recon **可管线化**（duckdb s3 回读+翻页比对+die）但**属独立只读流程**」；§7.3「**永远不该下沉**」行 | §7.3 的「不该下沉」结论**与本设计一致**（§3.2 方案 B 的取舍依据） |

> ⇒ **指针有 8 处**（4 处正典/执行单 + 4 处报告/计划）。替代动作必须**成批改指针**，
> 否则「删了工具、正典还在叫它」——这正是 U3 裁决说的「自断手脚」。

---

## 2. 凭据面与执行面（**只读实测**，本节结论决定方案取舍）

### 2.1 三条湖回读通道

| 通道 | 形状 | 凭据需求 | 2026-09-29 实测 |
|---|---|---|---|
| **A. `rb` 通路**（今天 `recon` 用的） | 宿主 `docker compose run --rm -e ZOS_*… duckle -c 'sh /rb.sh'`，`/rb.sh` = `scripts/lemeng/readback-helper.sh` | **`ZOS_*` 五键**（来自 job env） | 未单独跑；形状与 B 同源 |
| **B. console 容器内** | `docker exec <console> sh -c 'CREATE SECRET…; duckdb'` | **容器自带 `ZOS_*`**（另有 `duckdb` 二进制 + python3） | ✅ `count(*)` = **100823** |
| **C. `pg_duckdb`** | `docker exec <pg_duckdb> psql -c "SELECT * FROM duckdb.query($$ read_parquet('s3://…') $$)"` | **无**（实例内已配 S3 secret） | ✅ `count(*)=100823`（与 B **逐字相等**） |

**实测的环境事实**（同机 `8281d598…`）：

- console 容器 `…-lemeng-console-3120` 内 9 个键**全在**：`ZOS_BUCKET` / `ZOS_ENDPOINT` / `ZOS_REGION` /
  `ZOS_ACCESS_KEY` / `ZOS_SECRET_KEY` / `LEMENG_TOKEN` / `DUCKLE_TOKEN` / `BRANCH_NUMS` / `SYSTEM_BOOK`。
- **宿主 env 里 `ZOS_*` / `LEMENG_TOKEN` 全 `UNSET`**；宿主上**没有** `duckdb` 二进制。
- ⇒ 全部凭据的**唯一注入面是 openship job 的 `actionConfig.env`**（实测：唯一调 `lemeng-run.sh` 的 job
  `lemeng-retail-3120-runner`（`custom:NchVfw7_7ffc_WJT`）目前 **`enabled:false`**，其 env 里带 `BRANCH_NUMS` 等）。
- ⚠️ **`minio://` 是本仓最容易踩的一脚**：freshness/owners 里的资产 id 是引擎**标签前缀**，
  不是 DuckDB 认的 scheme；照抄进 SQL 会被静默当路径模式（报 `No files found`，无 scheme 报错）。
  **SQL 里一律写 `s3://`**。

### 2.2 结论：**网关侧不可免凭据**

- 湖侧：**可以**免凭据（通道 C，实测）。
- 网关侧：**必须** `LEMENG_TOKEN`（+ `BRANCH_NUMS`，且该值**两个账套不同**：
  F3 实测 len 970 / 409），**没有任何免凭据替代**。
- ⇒ 「**做一个完全免凭据的 recon**」是**做不到的**。这正是正典 §1.1.7 把「身份探针/对账工具」
  与「采集」**并列保留、不合并**的结构性理由之一：它们**共用同一份凭据治理面**。

### 2.3 一个现存缺口：`recon` 没有「常规执行载体」

`DELIVERY.md` / `handbook` 都把 `recon` 当**指定工具**，但：

- **没有专属 job**（该机 job 共 **39** 个，唯一调 `lemeng-run.sh` 的是 `…-runner`，命令是 `windows`，且已 `enabled:false`）；
- **宿主裸 exec 跑不了**（无 `ZOS_*` / 无 `duckdb`，实测）；
- ⇒ 今天要跑 `recon`，实际得走**带 secrets 的通道**（改 runner job 的命令、或临时建 job）。

**这是 U3 裁决下必须一并回答的问题**：替代工具**由谁触发、在哪儿触发**（§5-P2）。
不回答它，新工具会继承同一个缺口——「有工具但没人能跑」。

---

## 3. 替代面设计

### 3.1 必须保留的能力（等价性契约，**缺一不算替代**）

| # | 能力 | 判据 |
|---|---|---|
| E1 | 湖分区**单文件精读**：`count(*)` + `count(DISTINCT batch_id)`，**不用 hive 列**（避免 `hour` 遮蔽） | 与今天同 SQL 同结果 |
| E2 | 网关**翻页累计**明细行数，形状与 `duckle/common/lemeng.retail_order_line.json` 的 `src.rest` 同源 | 页数与 body 与管线一致 |
| E3 | **容差 0** 全等判定 + `batch_id == 1` 判定 | 同 `recon_verdict` |
| E4 | **未闭窗小时拒比**（今天是今天且 `hour ≥` 当前上海钟点 ⇒ 拒） | 同 `recon_hour_open` |
| E5 | **容量闸**：12 页 × 200，末页仍满即判红 | 与管线容量闸同数 |
| E6 | **退出码 + 可 grep 字面量**契约（`RECON_OK` / `RECON_FAILED:<面>`） | 逐字保留（执行单/巡检靠它） |
| E7 | **凭据不入命令行、不入日志**（值只在容器进程内存展开） | 同 `readback-helper.sh` 的存在理由 |
| E8 | `bizday` 缺省 = **上海日历日昨天**（显式钉 TZ，不继承系统 TZ） | 同脚本既有的 `TZ=Asia/Shanghai` 钉法 |

**不要求的**（可丢）：`OPS_*` 观测投递（那是采集面的指标，只读工具不需要）、`_ops` 行、
逐窗重试、以及**采集侧的一切**（`window`/`windows`/`tick`/`dim`）。

### 3.2 方案对比

| | **方案 A：独立只读 shell 工具**（`scripts/lemeng/recon.sh`） | **方案 B：独立只读 duckle 管线**（`deploy/duckle/console/pipelines/lemeng.retail.recon.json`） | **方案 C：独立只读 Node 工具**（`scripts/lemeng/recon.mjs`） |
|---|---|---|---|
| **形态** | 从 `run-retail-day.sh` **整段抽出** `recon` + `rb_run` + 判据函数（E1–E8 逐字搬） | 顶层管线：湖读节点 + 12 个 `src.rest`（或改 `paginationType: page`）+ `code.sql` 比对 + `ctl.die` 判红 | 重写：湖侧走 **`pg_duckdb` 免凭据**，网关侧 `fetch` 翻页；判据实现同 E3/E4/E5 |
| **执行面** | 数据面机（openship job / server exec），**与今天同机** | **必须**在 console 容器内（引擎在那儿）；要 seed + rebuild catalog + 重启才生效 | 任何能 `docker exec` 到 `pg_duckdb` 的机器（含控制面侧？见 §5-P2） |
| **凭据面** | `ZOS_*`（湖）+ `LEMENG_TOKEN`/`BRANCH_NUMS`（网关），**与今天逐字相同** | 湖侧走**已有的 `zos` 连接**（`connectionRef`，密文，由 `scripts/duckle/connection-setup.py` 一次性建立；L1 子管线已在用）⇒ **湖侧不必 `ZOS_*`**；网关侧仍需 token（同样可走 `connectionRef`） | **湖侧免凭据**（通道 C）；网关侧仍需 `LEMENG_TOKEN` |
| **复用度** | ★★★ **最高**：`rb_run` / `recon_lake_sql` / `recon_gw_page` / `recon_gateway_rows` / `recon_hour_open` / `recon_verdict` 六段**整段搬走**；`readback-helper.sh` **只读不改**（它已是独立 manifest 条目） | ★ **低**：网关翻页要重画 12 个节点（`src.rest` 现为 `paginationType:none` + 12 节点硬扇出）；判据要重标定 | ★★ 中：判据可照抄逻辑，但要重新落凭据取法与退出码 |
| **与采集主链的耦合** | **无**（独立文件、独立生命周期）——正典 §1.1.7「独立只读入口，永不进采集主链」✅ | ⚠️ **有**：跑在**同一个 console**、同一套 catalog/调度/`runs/` 状态面；console 挂了工具也没了 | **无** ✅ |
| **可维护性** | 脚本从 1021 行 → **约 200–250 行**（只留只读形）；仍无容器外的语言面 | 与采集同栈、结果自动进 `runs/receipts`（可观测）；但**改判据 = 改管线 + seed + 重启** | 可 `--json` 输出、可进 CI 静态测（仓内已有 `scripts/**/*.mjs` + `typecheck:scripts` 先例） |
| **已知坑** | 仍依赖 `docker compose run` 起一次性容器（宿主无 `duckdb`） | ⚠️ **「duckle 报 ok ≠ 求过值」**（本仓有档：code.sql 视图体延迟绑定 + 行数查询错误被吞 ⇒ 闸静默放行）；且 `RECON_PAGES` 与管线分页形状一改就要同步 | 新语言面；`LEMENG_TOKEN` 的取法要重新落地（今天只在 job secrets 里） |
| **与 U3 动机的关系** | ✅ 直接达成「脚本不再背采集形」 | ❌ 与 U3 的动机**反向**：把只读入口**移进** console 这个采集执行面 | ✅ 达成 |

### 3.3 推荐：**方案 A**（近期落点），并吸收方案 C 的湖侧通道

**推荐理由（按权重）**：

1. **等价性风险最低**：`recon` 的**字面量 + 退出码**契约（E6）是 `DELIVERY.md` §3 判据 2 与巡检的
   实际依赖——**逐字搬运 = 零语义漂移**；重写（B/C）都要**重新标定**这套契约。U3 是「先造替代再删」，
   不是「顺手重构」；**先把替代钉死，再谈演进**。
2. **复用量最大**：六段函数 + `readback-helper.sh` 全部现成。且 `readback-helper.sh` **本就是独立文件**
   （manifest 条目 `scripts/lemeng/readback-helper.sh → ${REPO}/lemeng-readback.sh 0755`）⇒ 抽出的脚本**沿用**即可。
3. **正典一致性**：正典 §1.1.7 的那句「**独立只读入口，永不进采集主链**」——方案 A 与 C 满足，**方案 B 不满足**
   （它把工具绑进 console 这个采集执行面）。方案 B 的能力调查结论也只说「**可**管线化」，未说「**应**管线化」。
4. **凭据面不动**：与今天逐字相同（`ZOS_*` + `LEMENG_TOKEN` + `BRANCH_NUMS` + `SYSTEM_BOOK`），
   **不需要新造凭据通路**——这是把风险压在「替代」而不是「顺带改造」上的关键。

**在 A 之上要吸收的（来自 C 与正典）**：

- **加一条湖侧免凭据子命令**（走通道 C `pg_duckdb`），落实 `DELIVERY.md` §3 判据 2 已有的那句
  「免凭据独立回读（换一条通道复核，**别复用被测方的通路**）」。
  ⚠️ 今天 `recon` 的湖侧走的是 `ZOS_*`（与采集侧**同源凭据**）⇒ **它不是独立通道**。
  加这条之后，「换通道复核」才落地。**实测证明这条通路可用**（§2.1 通道 C，与 B 逐字相等）。
- **加 `--json` 输出形**（机器可读），供 CI / 巡检消费；形状参考**运行记录**的字段口径。

**什么会让我改推方案 C**：① 需要一个**能进 CI**（无数据面机访问权）的静态对账门禁；
② 需要把工具**并入控制面侧的巡检**（不在数据面机上跑）。**这两条今天都不成立** ⇒ 不为它们现在付新语言面的代价。

### 3.4 故意**不搬**的能力（逐条给理由）

| 不搬 | 为什么 |
|---|---|
| `window` / `windows` / `tick` / `dim` | **采集形**，归 L0/L1（正典 §1.1.7）。U3 的动机正是把它们连同脚本一起废 |
| **`idem3`** | **它是写形**（三次 `window` = 写湖三次，§1.3），与「只读工具」的定义直接冲突；且它**不做前置自证**。其真命题（同 `batch_id` 字节一致 / 换 `batch_id` 因果）在 L0/L1 下已有更强的原生承载体（run 回执 + `assets` + `batch_id` 锚）⇒ **另立议题，不进只读工具** |
| **`envfile`** | **它是写形**（写 `${REPO}/deploy/.env`，§1.3）。密钥物化按正典 §7.3 属**平台层职责**（openship/env 注入面），不进只读工具 |
| `drift` | 与「湖 vs 网关对账」**不同域**（它验的是管线声明与源 schema 漂移）；**本 spec 未取证 `duckle drift` 是否写盘** ⇒ 不臆断。已由 CI 侧 `check-duckle-catalog.mjs` 相邻守卫覆盖一部分。**待拍板**（§5-P4） |
| `identity` | 已由 **L1 管线内身份门原生化**（正典 §1.1.7「可原生化，不必留 shell」）⇒ 不搬;但 ⚠️ **L1 生产首航未验**，在首航过之前**建议留一份**（或并入新工具的 `--identity` 子命令） |
| `OPS_*` / `_ops` 行 / `notify_fail` EXIT trap | 观测与告警面归**采集/引擎**（`alerts.json` → OO）。只读工具判红由**触发它的人**看到即可；不搬可**顺带消掉**一个「只读工具会发企微通知」的意外面（§1.1 副作用②） |
| `listing` / `agg` / `branches` / `probe` / `diag` | **可搬**（都是只读），但**建议按需搬**：`listing` 的「key 残留 `${ENV` 字面量」断言属 **S1 验收**、已被 L1 的 catalog 守卫部分取代；`probe`/`diag` 是环境体检。**逐条表态见 §5-P5** |

### 3.5 `rb` 的定位（说清楚，否则替代设计无根）

`rb` **不是**「回读」的别名，它是**通用只读 SQL 执行口**。三层定位：

1. **内部底座**：`rb_run` 是 `agg` / `branches` / `rb` / `recon` **四处共用的单一调用形状**
   （源码注释：「别再抄第五份」）⇒ 在替代工具里，它应保留为**内部函数**。
2. **人的逃生舱**：湖上一旦出现没有现成模式可查的形状，`rb "<SQL>"` 是**唯一的表达面**。
   ⇒ **建议保留为公开子命令**。
3. **但要加护栏**（今天**没有**）：今天的 `rb` 接受任意 SQL，**无法阻止** `COPY … TO`、`INSTALL`、
   写路径等**写操作**——一个自称「只读入口」的工具不该有这条无护栏的口子。
   ⇒ 替代面必须加：**只读白名单/黑名单**（禁 `COPY`/`ATTACH`/`INSTALL`/`SET` 写面）+ **输出行数上限**
   （今天是 `tail -40`，隐式但会**静默丢行**，对「对账」是危险的）。

---

## 4. 迁移路径

### 4.1 批次与顺序（**替换前旧工具必须留着**）

```
① 本 spec 落盘（#348）                       ← 现在
      ↓  （旧 recon 原地不动；DELIVERY.md 判据 2 继续可用）
② Wave D 批内：造替代工具（新文件 + manifest 条目 + lock 重跑 + 测试）
      ↓  （**新旧并存期**：两条都能跑）
③ 等价性验收：新工具 vs 旧 recon **对表**（§4.3）  ← 不通过不许进 ④
      ↓
④ 同批：改 8 处指针（§1.4）+ 删旧只读形
      ↓
⑤ 同批（或稍后，取决于 U2/U3 的采集形裁决）：删整个 `run-retail-day.sh` 采集形 + `duckle/common/*.json`
```

### 4.2 「同批」约束（来自 U3 裁决，逐条重申）

- **删 `duckle/common/*.json` 会让采集形先失效** ⇒ 「采集形删除」与「删该 JSON」**必须同批**。
- **只读形的删除必须紧跟替代工具的等价性验收**（③ 不过 ⇒ 不许进 ④）。
- **时点必须晚于 Wave C 的对照完成**：`run-retail-day.sh tick` 曾是 Wave C 的**对照臂**。
  按 `DELIVERY.md` §6，观察期 ≥3 运行日通过后才进 Wave D ⇒ **本替代动作落在 Wave D 批内**
  （**不早于** Wave C 观察期结束）。
- ⚠️ **观察期未满之前，旧 `recon` 一行都不许动**——它是观察期五点验收里**判据 2 的唯一工具**。

### 4.3 等价性验收（替换的**硬前置**，缺一不算过）

在**同一天同一个闭窗小时**上，新旧工具各跑一次，断言：

1. **逐字相同**：`lake_rows` / `lake_batches` / `gateway_rows` 三个数**完全相等**；
2. **退出码相同**（0 对 0）；
3. **拒比行为相同**：对一个**未闭窗**小时，两侧都以「拒比」非零退出（不是一方报红、一方报绿）；
4. **容量闸相同**：对一个「第 12 页仍满」的构造场景，两侧都判红；
5. **凭据不外泄**：新工具的 stdout/stderr **无任何凭据子串**（照 `readback-helper.sh` 的纪律自测）。

> 建议把 1–3 条固化成**脚本化对表**（一次性，不必进 CI），并把结果贴进 Wave D 的收口报告。

### 4.4 文档收口点（**8 处指针，别漏**）

见 §1.4 表。**顺序**：先改指针（④）再删工具——反了就会出现「正典叫一个不存在的工具」。

---

## 5. 待人拍板的决定（**本 spec 不替人决定**）

| # | 决定 | 选项 | 代价 / 论据 |
|---|---|---|---|
| **P1** | **替代工具的形态** | **(a) 方案 A**（独立只读 shell，逐字搬运 + `pg_duckdb` 免凭据子命令）— **本 spec 推荐**<br>(b) 方案 B（独立只读 duckle 管线）<br>(c) 方案 C（独立只读 Node 工具） | A：等价性风险最低、复用量最大、凭据面不动；代价 = 仍是 shell、仍依赖 `docker compose run`。<br>B：与 U3 动机反向（绑进 console 执行面）+ 「报 ok ≠ 求过值」的既有坑；但不背离「与采集同栈」的偏好。<br>C：结构最好、可进 CI；代价 = 重写 + 重新标定退出码契约 + 新语言面。 |
| **P2** | **工具由谁触发、在哪儿触发**（§2.3 的现存缺口） | (a) 新建**专属 openship job**（`…-recon`，带 secrets，手动 trigger，不挂 cron）<br>(b) 继续「改 runner job 命令 / 临时 job」的现状<br>(c) 让工具**免凭据化到能裸 exec**（**做不到，见 §2.2**） | (a) 补上今天缺的「常规执行载体」，与人手动一致性最好；(b) 零成本但每次都是**临时动作**，易漂；(c) 网关侧**不可免凭据** ⇒ 此项应作废，列在此处只为**关闭**它。 |
| **P3** | **湖侧通道** | (a) 只保留 `rb`（`ZOS_*`，与今天同）<br>(b) `rb` + **并列** `pg_duckdb` 免凭据复核<br>(c) 改用 `pg_duckdb` 单通道 | (a) 最省，但**「换通道复核」这条正典要求落不了地**（同源凭据）；(b) **本 spec 推荐**，实测两通道结果逐字相等；(c) 省一处依赖但**丢掉 `rb` 逃生舱**，且把工具绑死在一台机的 `pg_duckdb` 上。 |
| **P4** | **非只读分支 `idem3` / `envfile` 的去处** | (a) 随脚本整体删除（幂等面已由 L0/L1 承接）<br>(b) 保留在旧脚本里不动（与 U3「整体废弃」冲突）<br>(c) 另立一个**明确标注**「会写」的维护工具 | (a) 最干净，但需确认「三跑 ETag 对照」确无后续用途；(b) 与 U3 裁决直接冲突；(c) 诚实但新增一个文件面。 |
| **P5** | **同族只读形搬哪些** | 多选：`rb`（**建议留**，加护栏）/ `listing` / `agg` / `branches` / `probe` / `diag` / `identity`（L1 首航前**建议留**）/ `drift`（**待核是否写盘**） | 逐条理由见 §3.4。**要拍的是「最小集」还是「全搬」**。 |
| **P6** | **删除批次与时点** | (a) **Wave D 批内**，与「删 `duckle/common/*.json`」同批（U3 论据③④）<br>(b) Wave D 之后另开一批 | (a) 与裁决一致、少一批；但 Wave D 批已经很大（64188 跟进 + 卷内删文件 + 正典统一）。(b) 更安全，但**指针会有一段悬空期**（正典叫旧工具、旧工具已删）——**除非 ④ 先做**。 |
| **P7** | **是否给替代工具加 CI 门禁** | (a) 加**静态**断言（脚本存在 + E6 字面量在场 + 与 `duckle/common/lemeng.retail_order_line.json` 的页数/容量闸一致）<br>(b) 不加（靠人） | (a) 能拦住「改了管线分页形状、忘了同步 `RECON_PAGES`」这类**静默错**——今天**没有任何门禁**盯这条耦合；(b) 零成本，风险照旧。 |

---

## 6. 附：本次只读取证的证据

### 6.1 源码

| 项 | 位置 |
|---|---|
| `recon` 全族（六段函数） | `scripts/lemeng/run-retail-day.sh` L577-681；调用点 L781-814 |
| `rb_run`（四处共用调用形状） | 同上 L246-253 |
| 回读 helper（凭据只在容器内存展开） | `scripts/lemeng/readback-helper.sh`（全 13 行） |
| `idem3` 写湖 / `envfile` 写宿主 | 同上 L962-977 / L1008-1013 |
| 网关调用形状的事实源 | `duckle/common/lemeng.retail_order_line.json`（`p1`…`p12` `src.rest` + `sink` 节点） |
| 落地映射 | `deploy/data-plane-manifest.txt`：`scripts/lemeng/run-retail-day.sh → /opt/lemeng-run.sh 0755`、`scripts/lemeng/readback-helper.sh → ${REPO}/lemeng-readback.sh 0755` |

### 6.2 只读实测（2026-09-29，serverId `8281d598-af73-4d0b-99dd-bc8681fcc8bb`）

| 实测项 | 命令形状（只读） | 结果 |
|---|---|---|
| console 容器存在 | `docker ps --format '{{.Names}}' \| grep -i lemeng` | `…-lemeng-console-64188`、`…-lemeng-console-3120` |
| console 内有 `duckdb` | `docker exec <3120> sh -c 'command -v duckdb'` | `/usr/local/bin/duckdb`（另有 Python 3.12.14） |
| console 内 9 键**在场**（只打印键名，不回显值） | `docker exec <3120> sh -c 'for k in …; do [ -n "$(printenv $k)" ] && echo $k=SET \|\| echo $k=UNSET; done'` | `ZOS_*`×5 / `LEMENG_TOKEN` / `DUCKLE_TOKEN` / `BRANCH_NUMS` / `SYSTEM_BOOK` **全 SET** |
| **宿主无凭据** | `printenv ZOS_BUCKET` 等 | `UNSET`；`command -v duckdb` → 无 |
| 湖回读通道 B（console） | 容器内 `CREATE SECRET` + `read_parquet('s3://…')`，`bizday=*` 全分区 `SELECT count(*)` | **100823** |
| 湖回读通道 C（`pg_duckdb`，**免凭据**） | `psql -c "SELECT * FROM duckdb.query($$ count(*) … $$)"` | **100823**（与 B 逐字相等） |
| `lemeng-run.sh` 落点 | `ls -la /opt/lemeng-run.sh` | `-rwxr-xr-x root root 67879`（与 Wave D §4.5 记的 67,879 字节一致） |
| 唯一调用它的 job | openship `get_jobs` + `get_jobs_by_key custom:NchVfw7_7ffc_WJT` | `lemeng-retail-3120-runner`，命令 `sh /opt/lemeng-run.sh windows`，**`enabled:false`** |
| **全机没有 recon 专属 job** | 遍历全部 job 的 `command` 字段 | 含 `lemeng` 的命令仅 3 条（`windows` / `wire-warehouse --check` / 一条数据面自检），**无 `recon`** |

> 全程**零写操作**：无 seed、无 `docker cp`、无调度变更；`pg_duckdb` 侧只发 `SELECT`。

### 6.3 本次未取证、需在实施前补的（**不臆断**）

1. `duckle drift` 是否写盘（决定 `drift` 能否进只读面，§5-P5）；
2. 通道 A（`rb` 通路，`docker compose run`）在今天的生产环境**是否仍可跑通**（本次只验了 B/C）；
3. `pg_duckdb` 的 S3 secret **由谁维护、换机后如何重建**（通道 C 的可用性前提）。
