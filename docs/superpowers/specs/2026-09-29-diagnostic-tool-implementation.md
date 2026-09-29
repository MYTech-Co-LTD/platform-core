# 诊断/对账工具替代：**实施批**（P1–P7 落地）

> **性质**：**实施记录**（与设计 spec `2026-09-29-diagnostic-tool-replacement.md` 配对——那份是设计/裁决正典，
> 这份是「裁决怎么落的、验到哪一步」）。
> **本批范围**：P1 / P2（只出 job 定义文档）/ P3 / P5（最小集）/ P7。**未做**：P4 的删除、8 处指针改向、
> 生产 job 的创建（理由见 §6）。
>
> **关联**：Closes #367 · Refs #343（Wave D 计划 §7 U3 裁决）· Refs #348（设计 spec）。
>
> **正典指针**（本文件不复述正文）：设计/裁决 = `docs/superpowers/specs/2026-09-29-diagnostic-tool-replacement.md` §5.1 ·
> 采集任务标准形态与四层验收 = `docs/data-platform-handbook.md` §1.1.7 / §1.4 ·
> 投递程序 = `deploy/data-plane-deploy-sop.md` §E · L0/L1 验收五点 = `deploy/duckle/console/DELIVERY.md` §3。

---

## 1. 交付物

| # | 工件 | 作用 |
|---|---|---|
| 1 | `scripts/lemeng/diagnose.sh` | **只读诊断工具本体**（P1）。子命令 `recon <H>` / `rb "<SQL>"` / `identity` |
| 2 | `scripts/lemeng/diagnose.test.sh` | 行为测试：**从脚本里抽真函数**测（不复制实现），58 条断言 |
| 3 | `scripts/diagnose.test.ts` | vitest 包装（让 CI 跑上面那份）+ 两条静态不变量 |
| 4 | `scripts/check-diagnostic-tool.mjs` | **P7 静态 CI 断言**（六条判据） |
| 5 | `scripts/check-diagnostic-tool.test.ts` | 上条的门禁单测：九个夹具，**每个判据各有一个只违反它的反例** |
| 6 | `deploy/data-plane-manifest.txt` | 落地映射新增一行 |
| 7 | `deploy/data-plane.lock` | 重新生成（11 条清单条目 → **49** 个文件；数字随清单覆盖的工作区文件数走） |
| 8 | `.github/workflows/ci.yml` | `gates` job 加一条 `check-diagnostic-tool.mjs` |

**落地映射**（P1 的硬要求：仓内 → 清单 → 机器可执行位）：

```
scripts/lemeng/diagnose.sh               /opt/lemeng-diagnose.sh                   0755
```

**工具 sha256**（本批测试与实际落地的是**同一份字节**，见 §2.1 的证据链）：

```
839d0e57a7c8890ba07b5942fcb74ece8102aae848f10c808a4f23ec98e2ac0f  scripts/lemeng/diagnose.sh
```

**命名与落点的选定**（P1 把这条留给实施批）：叫 `diagnose`（不是 `recon`）——因为最小集里除 `recon` 还搬了
`rb` / `identity`，叫 `recon` 会窄于工具的实际能力；落 `/opt/lemeng-diagnose.sh`，与 `/opt/lemeng-run.sh`
（被替代的旧工具）成对，人一眼分得清谁是谁。

**纪律自查**：`scripts/lemeng/run-retail-day.sh` **一行未动**（本批不删，P4 的删除在指针改向之后）；
无生产写入（湖只 `SELECT`、网关只 `POST` 查询端点；机器上只落了 `/tmp` 下的临时件，跑完即删）。

---

## 2. 等价性验收（设计 spec §4.3 的硬前置，缺一不算过）

### 2.1 证据链：被测的那份 == 提交的那份

| 环节 | 值 |
|---|---|
| 仓内 `scripts/lemeng/diagnose.sh` | `839d0e57a7c8…`（`deploy/data-plane.lock` 同值） |
| 机器上跑的 `/tmp/lemeng-diagnose.sh` | `839d0e57a7c8…`（**逐字相同**） |
| 被替代的 `/opt/lemeng-run.sh` | `7eb2a2edd214…` |
| 仓内 `scripts/lemeng/run-retail-day.sh` | `7eb2a2edd214…`（**逐字相同** ⇒ 机器上那份就是仓内这份，没漂） |

**被搬的六段函数逐段同 sha**（从两个文件里各抽一次，算 sha256 前 16 位）：

| 函数 | 旧（`/opt/lemeng-run.sh`） | 仓内 `run-retail-day.sh` | 新工具 |
|---|---|---|---|
| `recon_lake_sql` → 新名 `lake_read_sql` | `c4b9adee26b04b23` | `c4b9adee26b04b23` | 同（改名 + 复用给两条通道） |
| `recon_parse_lake_csv` | `b3f5a427170d0984` | `b3f5a427170d0984` | 同 |
| `recon_gw_page` | `d4347ad92c7bd66d` | `d4347ad92c7bd66d` | 同 |
| `recon_gateway_rows` | `d5c7b5c0945a2f24` | `d5c7b5c0945a2f24` | 同 |
| `recon_hour_open` | `6938d8affd3b60c1` | `6938d8affd3b60c1` | 同 |
| `recon_verdict` | `8e422e3e4769a314` | `8e422e3e4769a314` | 同 |

⇒ 「逐字搬运 = 零语义漂移」不是设计意图，是**实测事实**。`recon_lake_sql` 改名 `lake_read_sql` 的唯一原因：
**两条湖通道必须跑同一份 SQL**（换的是通道，不是问句），所以它成了两处共用。

### 2.2 实跑对表（2026-09-29，数据面机 `8281d598…` / 宿主 `ecm-7d66`）

参数两侧**完全相同**：`recon 17` + `BIZDAY=2026-09-28` + `SYSTEM_BOOK=3120`；
凭据从 console 容器（`…-lemeng-console-3120`）**逐键取用、全程不回显**。

```
=== OLD /opt/lemeng-run.sh  rc=0 ===
== identity assert（凭据↔账套 / 门店清单↔账套；#205） ==
IDENTITY_OK company_id=3120 visible=271 configured=269 (配置门店全部可见)
IDENTITY_ASSERT=PASS
RECON bizday=2026-09-28 hour=17 lake_rows=848 lake_batches=1 gateway_rows=848（闭窗小时，容差 0）
RECON_OK hour=17 rows=848 batches=1

=== NEW /tmp/lemeng-diagnose.sh  rc=0 ===
IDENTITY_OK company_id=3120 visible=271 configured=269 (配置门店全部可见)
RECON_CROSS channel_rb=rows:848,batches:1 channel_pg_duckdb=rows:848,batches:1（换通道复核：同一问句、两条互不依赖的通道）
RECON bizday=2026-09-28 hour=17 lake_rows=848 lake_batches=1 gateway_rows=848（闭窗小时，容差 0）
RECON_OK hour=17 rows=848 batches=1
```

**§4.3 五条逐条**：

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| 1 | 三个数**完全相等** | ✅ | 两侧 `lake_rows=848` / `lake_batches=1` / `gateway_rows=848`；`RECON_OK` 行**逐字相同** |
| 2 | **退出码相同** | ✅ | 均 `rc=0` |
| 3 | **拒比行为相同**（未闭窗小时） | ✅ | `BIZDAY=2026-09-29`（今天）+ `hour=21`（= 当刻上海钟点）⇒ **两侧都** `RECON_FAILED:hour_open …` + `rc=2`，文案逐字相同（不是一方红一方绿） |
| 4 | **容量闸相同** | ⚠️ **单测级**（见下） | 实跑构造不出「第 12 页仍满」（该 hour 只有 848 行明细）。两侧的容量闸逻辑由**同一份函数体**（同 sha）+ 各自的单测覆盖：旧 `run-retail-day.test.sh` N 段、新 `diagnose.test.sh` 同名段，都用 stub 断言「末页仍满 ⇒ `RECON_FAILED:gateway` + 非零」 |
| 5 | **凭据不外泄** | ✅ | 把 4 个真秘密（`ZOS_ACCESS_KEY`/`ZOS_SECRET_KEY`/`LEMENG_TOKEN`/`DUCKLE_TOKEN`）的**值**逐字拿去 `recon` / `identity` 的 stdout+stderr 里找子串 ⇒ **零命中** |

> ⚠️ 第 5 条的口径要说清楚：`SYSTEM_BOOK`(=`3120`) / `ZOS_BUCKET` **不算秘密**，且 `3120` 本身就是湖里的
> **数据列值**（`system_book` 列）与 `batch_id` 的一部分 ⇒ 它们在输出里出现是**正常数据**，不是泄漏。
> 只把真秘密拿去扫，才是能红也能绿的判据（把非秘密一起扫 = 该判据永远红 = 没人会看它）。

### 2.3 顺手销掉的两条**未取证项**（设计 spec §6.3）

| 设计 spec 的未取证项 | 本批实测结论 |
|---|---|
| ② 通道 A（`rb` 通路，`docker compose run`）今天是否仍跑通 | ✅ **跑通**。`recon` 的湖侧读数就是走它拿到的（`lake_rows=848`）。旧的 `recon` 与新的 `recon` 都成功起了 `platform-core-data-duckle-run-*` 一次性容器 |
| ③ `pg_duckdb` 的 S3 secret 可用性 | ✅ **可用**（免凭据，与 rb 通道逐字相等）。⚠️ 但「**由谁维护、换机后如何重建**」仍未取证（属平台层职责，本工具只消费不维护）——保持**待沉淀** |

### 2.4 `rb` 的护栏与行数上限（P5「`rb` 加护栏」）实跑

| 用例 | 结果 |
|---|---|
| `rb "SELECT count(*) … hour=17"` | `rc=0`，返回 `848`（只读 SQL 放行） |
| `rb "COPY (SELECT 1) TO 's3://x/y.parquet'"` | `rc=2` + `RB_REJECTED: … 'COPY'` |
| `rb "SET memory_limit='1GB'"` | `rc=2` + `RB_REJECTED: … 'SET'` |
| `rb` 全量（8534 行）+ `RB_MAX_ROWS=5` | `rc=3` + `RB_TRUNCATED: 输出超过 RB_MAX_ROWS=5 行…`（真红） |
| 同上 + `RB_MAX_ROWS=500` | `rc=0`，57 行（真绿） |

> 📌 **实测发现（写下来免得下一个人以为是 bug）**：这台机上的 duckdb CLI 默认渲染（duckbox）
> **自身**就把表体压到 40 行，并打印 `8534 rows (40 shown) … use .last to show entire result`。
> 所以默认形态下 `rb_emit` 的 200 行上限**不会先触发**；旧 `| tail -40` 因此是**双重**丢行。
> 显式上限仍有意义（换渲染模式、或把 `RB_MAX_ROWS` 调小、或将来给 `rb` 开 `-csv`），
> 且它的**真红/真绿**就是上表用 `RB_MAX_ROWS=5` 验的。

---

## 3. P7：静态 CI 断言 —— **红/绿双证据**

门禁：`scripts/check-diagnostic-tool.mjs`（六条判据：① 工具在场 + 可执行位 ② 清单落地条目 0755
③ E6 退出码契约字面量在场 ④ 湖侧 SQL 点名单文件 / 写 `s3://` / 不带 `hive_partitioning`
⑤ 容量闸同源 ⑥ 网关 body 键集合同源）。

**它盯的静默错**（P7 原始动机）：`recon` 的容量闸 `RECON_PAGES` 与网关调用形状的事实源
（`duckle/common/lemeng.retail_order_line.json` 的 12 个 `src.rest` 节点）**不是私有常量**。
管线分了 13 页、工具还按 12 页翻 ⇒ 末页守卫永不触发 ⇒ **网关侧悄悄少算一页**，
而 `RECON bizday=… lake_rows=… gateway_rows=…` 看着一切正常——退出码、字面量、人眼全绿，**只有数字错了**。

### 3.1 反例（把 `RECON_PAGES=12` 临时改成 `11`）

```
$ pnpm exec tsx scripts/check-diagnostic-tool.mjs          # 基线：绿
check-diagnostic-tool: OK（scripts/lemeng/diagnose.sh 与 duckle/common/lemeng.retail_order_line.json 的分页形状同源）
rc=0

$ sed -i '' 's/^RECON_PAGES=12/RECON_PAGES=11/' scripts/lemeng/diagnose.sh   # 反例
$ pnpm exec tsx scripts/check-diagnostic-tool.mjs
check-diagnostic-tool: 1 处违规
  scripts/lemeng/diagnose.sh: RECON_PAGES=11 与管线 src.rest 节点数=12 **不同源** ——改了管线分页形状却忘了同步常量
  ⇒ 末页容量守卫永不触发，网关侧悄悄少算；两侧一起改（管线 duckle/common/lemeng.retail_order_line.json ↔ 工具 scripts/lemeng/diagnose.sh）
rc=1

$ pnpm exec tsx scripts/check-data-plane-lock.mjs           # 顺带：另一条门禁也独立抓住了同一次改动
check-data-plane-lock: 1 处违规
  deploy/data-plane.lock: sha256 不符：scripts/lemeng/diagnose.sh（lock 写 839d0e57…，仓内实算 617dfde1…）
rc=1

$ cp /tmp/diag.orig.sh scripts/lemeng/diagnose.sh            # 改回 ⇒ 绿
$ pnpm exec tsx scripts/check-diagnostic-tool.mjs
check-diagnostic-tool: OK（…）
rc=0
$ pnpm exec tsx scripts/check-data-plane-lock.mjs
rc=0
```

⇒ **红**是真红（且判据打的就是那条耦合，不是别的什么碰巧红了），**绿**是真绿（还原后两条门禁同时回绿）。

### 3.2 单测里每个判据各有一个反例（防「守卫恒绿」）

`scripts/check-diagnostic-tool.test.ts` 九个夹具，逐一对应：

| 夹具 | 期望 | 打的是哪条判据 |
|---|---|---|
| 一致 | `rc=0` + `OK` | （基线） |
| 工具不存在 | `rc=1` | ① |
| 管线 11 节点 vs 工具 12 | `rc=1`，点名 `RECON_PAGES` | ⑤ |
| 管线 `page_size=100` | `rc=1`，点名 `RECON_PAGE_SIZE` | ⑤ |
| 缺 `RECON_FAILED:hour_open` 字面量 | `rc=1` | ③ |
| 湖侧 SQL 带 `hive_partitioning` | `rc=1` | ④ |
| 清单无落地条目 | `rc=1` | ② |
| 清单模式 `0644` | `rc=1` | ② |
| **真仓** | `rc=0` | 兜底：机制落码了、仓里却是坏的 = 最坏的一种绿 |

---

## 4. P2：专属 job 定义（**文档，本次未在生产创建**）

> 🔴 **本批只出定义，不在生产建 job**（任务书原文）。下面这份是**照抄即可**的落库形状；
> 触发前请先确认 `deploy/data-plane-manifest.txt` 那行已随投递生效（`ls -la /opt/lemeng-diagnose.sh` 应 `0755`）。

### 4.1 为什么要它（设计 spec §2.3 的缺口）

今天要跑 `recon`，**没有常规载体**：全机 39 个 job 里唯一调 `lemeng-run.sh` 的是
`lemeng-retail-3120-runner`（命令是 `windows`，且 `enabled:false`）；宿主裸 `exec` 跑不了
（宿主无 `ZOS_*`、无 `duckdb`）。⇒ 每次都只能「临时改 job 命令」或「临时建 job」，**必然漂**。

### 4.2 为什么**手动 trigger、不挂 cron**

1. 它是**诊断工具**，不是采集：没人要在凌晨 3 点收一条「对账红了」的告警——**噪声会让人开始忽略告警**；
2. 它的结论由**人**消费（补采 SOP 的一步、或缺口排障的取证），不是流水线的一环；
3. 它**故意没有** `OPS_*` 观测投递与 `notify_fail` 告警（设计 spec §3.4 明确不搬）⇒ 挂 cron 等于
   把红灯扔进一个没人看的日志；
4. 一个 job 一次只对**一个 hour**，cron 化需要「算当前该对哪个 hour」的逻辑——那正是采集面的职责，
   塞进只读工具就违背「独立只读入口，永不进采集主链」。

### 4.3 job 定义（**每个账套一个**：`BRANCH_NUMS` 是账套绑定的，F3 实测两套 len 970 / 409）

| 字段 | 值（3120 那份；64188 同理换 `SYSTEM_BOOK` 与 secrets） |
|---|---|
| `label` | `lemeng-retail-3120-diag` |
| `serverId` | `8281d598-af73-4d0b-99dd-bc8681fcc8bb`（乐檬 console 所在数据面机） |
| `scheduleType` | **`manual`**（不传 `cronExpression`） |
| `command` | `sh /opt/lemeng-diagnose.sh recon "${DIAG_HOUR:?DIAG_HOUR 未设：触发前先在 job env 里把它设成目标小时 HH}"` |
| `timeoutMs` | `300000`（一个 hour 的翻页最坏 12 页 × 25s 超时；实测一次约 10–20s，留足余量） |
| `retry` | `{ "maxAttempts": 1, "backoffSeconds": 0 }`——**判红是真发现，不是抖动**，不自动重试（重试只会重跑同一次读数） |
| `env`（非秘密） | `REPO=/opt/platform-core-data/platform-core`、`SYSTEM_BOOK=3120`、`DIAG_HOUR=17`（触发前改）、`BIZDAY=`（留空 = 自动取上海昨天；要回看某天就填 `YYYY-MM-DD`） |
| `secrets`（`isSecret`） | `LEMENG_TOKEN`、`ZOS_BUCKET`、`ZOS_ENDPOINT`、`ZOS_REGION`、`ZOS_ACCESS_KEY`、`ZOS_SECRET_KEY` |

**命令里为什么不得出现采集/写湖分支**（P2 的裁决原话）：这个 job 是**只读工具**的载体；
命令一旦变成 `window`/`windows`/`tick`/`dim`，这个 job 就从「诊断载体」变成了「绕过 L0/L1 的采集入口」。
工具本身也**没有**这些模式（`UNKNOWN_MODE` + `exit 2`），这是第二道锁。

**secrets 从哪来、怎么取**（不写值）：与 `lemeng-retail-3120-runner` / console 容器同一套
——openship project env（`isSecret`）⇒ 本 job 的 `actionConfig.secrets`。**值不进仓、不进报告、不进命令行**
（工具自己也遵守这条：`readback-helper.sh` 让**容器内**的 sh 在运行时展开，值只在容器进程内存里）。

**触发方式**：openship MCP `post_jobs_by_key_run {key}`（或 console 里点 Run）。
**判红怎么读**：stdout 里的 `RECON_FAILED:<面>` / `RECON_OK …`（E6 字面量逐字保留）。

---

## 5. 8 处指针改向的**待办清单**（P6 定的强制顺序：**指针先行**）

> 🔴 **本批一行指针都没改**。理由：P6 裁决是「Wave D 之后另开一批」删旧脚本，且要求
> **「指针改向」先于「删旧脚本」**（否则出现「正典叫一个不存在的工具」的**悬空指针期**）。
> 本批是**替代工具落地批**（新旧并存期）⇒ 指针改向是**下一批**的第一件事。下面就是那一批的清单。

新工具入口形状（供照抄）：**`sh /opt/lemeng-diagnose.sh recon <H>`**（判据本身一字不改，只换工具指针）。

| # | 出处（**文件:行**，行号为写作时实测） | 现在写着 | 改成 |
|---|---|---|---|
| 1 | `deploy/duckle/console/DELIVERY.md:260` | 「工具：既有的只读对账模式 `sh /opt/lemeng-run.sh recon <H>`…」 | 指向 `sh /opt/lemeng-diagnose.sh recon <H>`；**判据本身一字不改** |
| 2 | `deploy/duckle/console/DELIVERY.md:262` 起（「免凭据独立回读」段） | 「`pg_duckdb` 已配 S3 secret，可直读湖…必须 `duckdb.query($$…$$)` 包裹」 | 该句**保留**（它已是正典），补一句：新工具的 `recon` **已把这条落成判据的一部分**（`RECON_CROSS` / `RECON_FAILED:cross`），不再只是「可选复核」 |
| 3 | `deploy/duckle/console/DELIVERY.md:364`（§5 陷阱 4） | 「必须走补采 SOP（`run-retail-day.sh recon <H>` 对照 + 定点重跑）」 | 指向新工具 |
| 4 | `deploy/duckle/console/DELIVERY.md:378`（§6 边界表「Wave D 收口」行） | 「`run-retail-day.sh` 的 `dim`/零售分支标废弃」 | 收口时把「废弃」改成「**已由 `sh /opt/lemeng-diagnose.sh recon <H>` 承接**」（`recon`/`rb`/`identity` 三个只读形） |
| 5 | `docs/data-platform-handbook.md:506`（§1.4 F 验收行） | 「闭窗小时用 `run-retail-day.sh recon <H>` 对照（湖回读 vs 网关翻页累计，容差 0）」 | 指向新工具 |
| 6 | `docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md:229` 与 `:404`（§4.6 / §9.8） | 「定点补采工具未验，列为待定 SOP」/「闭窗小时后跑 `run-retail-day.sh recon <H>`」 | 指针改向；**§9.8 的待定项在替代工具落地后销账**（本批已真跑，见 §2） |
| 7 | `docs/superpowers/plans/2026-09-29-waveD-64188-retirement-closeout.md:382` 与 `:514`（§4.5 / §7-U3） | 裁决留档：`recon` 是判据 2 的指定工具、「无替代即废 = 自断手脚」 | **裁决留档不改**（那是历史）；在 §4.5 的「只读诊断形」表旁补一行「替代路径 = `scripts/lemeng/diagnose.sh`（本批已落地）」 |
| 8 | `docs/superpowers/specs/2026-09-28-duckle-orchestration-capability-survey.md:136`（§6 #14）与 `:165`（§7.3） | 「recon **可**管线化…但属独立只读流程」/「**永远不该下沉**」 | §7.3 的「不该下沉」结论**与本设计一致**（不改）；§6 #14 补指针：替代形态 = 独立只读 shell（非管线），落点 `scripts/lemeng/diagnose.sh` |

> ⚠️ **同一批还要带上的两件事**（否则改完指针仍是半截）：
> ① `README.md` / `deploy/duckle/console/README.md` 之类若也提到 `recon`，同上处理（本表按 grep `recon` 的
> 实测结果列 8 处，不含这两处 —— 改前再 grep 一次，别只照抄本表）；
> ② 删除批**必须晚于本批投递生效**（`/opt/lemeng-diagnose.sh` 在机器上 `0755` 就位）——反了就是**先拆桥后修桥**。

---

## 6. 本批**故意没做**的（边界，别读成遗漏）

| 没做 | 为什么 |
|---|---|
| **不删 `idem3` / `envfile`，不动 `run-retail-day.sh`** | P4/P6 裁决：`idem3`/`envfile` 随旧脚本**整体删**，删除批在**指针改向之后**。本批是「新旧并存期」，旧脚本一行不许动 |
| **不改 8 处指针** | 同上：指针改向是下一批的第一件事（P6「指针先行」）。本批只交**待办清单**（§5） |
| **不在生产创建 job** | 任务书明确「本次只出 job 定义文档」 |
| **不搬 `listing` / `agg` / `branches` / `probe` / `diag` / `drift`** | P5 裁决 = **最小集**（`rb` 加护栏 + `identity`）。`drift` 是否写盘仍未取证 ⇒ 不在本批 |
| **不加 `--json` 输出形** | 设计 spec §3.3 把它列为「A 之上要吸收的」之一，但 P1 的裁决文本只点名「逐字搬运 + `pg_duckdb` 免凭据子命令」。P5 又选了最小集 ⇒ **不在本批裁决范围内**，留给下一批（要加时形状参考运行记录字段口径） |
| **不做「定点补一个已过去的小时」的新工具** | 那是 `DELIVERY.md` §5 陷阱 4 与 Wave C §9 的**另一个**待定项（补采 SOP），不是本 spec 的替代面 |

---

## 7. 已知边界 / 未取证（**不臆断**）

1. **容量闸的实跑反例构造不出来**（§2.2 第 4 条）：该 hour 只有 848 行明细，翻不到第 12 页。
   两侧的容量闸是**同一份函数体**（同 sha）+ 各自的单测（stub 让每页恒回 200）⇒ **函数级等价已证，
   实跑级未证**，保持如实标注。
2. **`duckle drift` 是否写盘**仍未取证（设计 spec §6.3 遗留）⇒ `drift` 不在只读面内。
3. **`pg_duckdb` 的 S3 secret 由谁维护、换机后如何重建**仍未知（设计 spec §6.3 遗留）。
   本工具**消费**这条通道（通道 B 不可用即判红 `RECON_FAILED:cross_unavailable`），**不维护**它。
   换机时若不重建 ⇒ 新工具会红在 `cross_unavailable` 上（**这是有意的**：静默退回单通道 = 「换通道复核」落空）。
4. **本地跑不了 `check-duckle-catalog.mjs`**（它要真 duckle 引擎；本机没装 ⇒ `exit 2`，
   是**设计好的响亮失败**，不是回归）。该门禁由 CI 的 `gates` job 装引擎后跑。
5. **`duckbox` 渲染自身 40 行上限**（§2.4 实测发现）：`rb` 的默认输出形态下，`RB_MAX_ROWS`（200）
   不会先触发。这是**观测事实**，不是缺陷。
6. **本批未在 64188 账套上真跑**：等价性对表跑的是 3120（`SYSTEM_BOOK=3120`）。
   工具本身账套无关（`SYSTEM_BOOK` / `BRANCH_NUMS` 由 job env 给）⇒ 但「64188 上跑通」仍是**待运行验证**。

---

## 8. 速查

```sh
# 只读诊断（宿主，凭据来自 job env；值不回显）
sh /opt/lemeng-diagnose.sh recon 17        # 对账：湖双通道复核 vs 网关翻页累计，容差 0
sh /opt/lemeng-diagnose.sh rb "SELECT count(*) FROM read_parquet('s3://…')"
sh /opt/lemeng-diagnose.sh identity

# 退出码：0 全过 / 非 0 有失败面；字面量 grep：RECON_OK | RECON_FAILED:<面> | RB_REJECTED | RB_TRUNCATED | RB_FAILED | ASSERT_FAIL
```

```sh
# 仓内门禁（改工具或改管线分页形状后必跑）
pnpm exec tsx scripts/check-diagnostic-tool.mjs     # P7 静态断言（分页形状同源）
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs    # 改过清单覆盖的文件 ⇒ 重新生成 lock
pnpm exec tsx scripts/check-data-plane-lock.mjs     # 投递面自校验
sh scripts/lemeng/diagnose.test.sh                  # 行为测试（真函数，不复制实现）
```
