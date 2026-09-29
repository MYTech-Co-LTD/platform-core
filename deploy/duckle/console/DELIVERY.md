# Wave B + C 投递 runbook（3120 零售 L1 切换）——可执行清单

> **这是投递批次的执行单，不是决策留档。** 决策与证据在四处，本文件把它们合成**一次跑完的步骤**：
> `#324` 终评评论（seed 三件套 / timezone 写入路径 / misfire 重放语义）·
> `#331` 报告 [`docs/superpowers/specs/2026-09-29-waveb-delivery-prep.md`](../../../docs/superpowers/specs/2026-09-29-waveb-delivery-prep.md) ·
> `#335` 报告 [`docs/superpowers/specs/2026-09-29-retail-child-sink-bucket-fix.md`](../../../docs/superpowers/specs/2026-09-29-retail-child-sink-bucket-fix.md) ·
> Wave C 报告 §8 [`docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md`](../../../docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md)。
>
> **正典指针（本文件不复述正文，有冲突以正典为准）**：
> 投递程序 = SOP §E（`deploy/data-plane-deploy-sop.md`）· 生效动作三类 = SOP §F.2 · 定义/排障口径 =
> `deploy/duckle/console/README.md` · 引擎调度实测事实 = 同 README §「调度器的实测事实」。
> ⚠️ **本文件不覆盖排障口径**——失败怎么看、从哪进，在 SOP §F.4 与 handbook §1.5，**其收口属 Wave D**，本文件不抢跑。
>
> **性质**：纯执行单。写它的时候零生产操作。

---

## 0. 前置：定位与批次文件集（先做，别照抄旧文）

### 0.1 定位 console（用 openship MCP 实测，别凭记忆）

```sh
# openship MCP：查项目/服务（不裸 SSH）
#   post_projects_by_id / post_projects_by_id_services …
```

| 项 | 值（**投递时以 MCP 实测为准**） |
|---|---|
| 项目 | `openship-platform-core-shanhai-data` |
| 服务 / 容器 | `lemeng-console-3120` |
| 工作区卷 | 项目前缀 + `lemeng-console-3120-ws` → 容器内挂载点 **`/workspace`**（卷名以 `docker volume ls` 实测为准） |
| 回环端口 | **`127.0.0.1:18080`**（只绑回环；调度靠进程内 tick，不需要对外开） |
| 检出根 `${REPO}` | `/opt/platform-core-data/platform-core` |

⚠️ **console 不在 mytech 数据面机上**。2026-09-29 只读实测：#324 的终评评论记明它在**山海数据机**
（`openship-platform-core-shanhai-data-lemeng-console-3120`），mytech 数据面机（`23a1091e`）上**没有任何 console 容器或卷**。
⇒ **每次投递先按 §0.1 定位一次**，别沿用上一批的机器。

### 0.2 本批要投的文件（**8 个，别多别少**）

| # | 仓内路径 | 卷内落点 | 角色 |
|---|---|---|---|
| 1 | `deploy/duckle/console/schedules/3120.json` | `/workspace/schedules.json`（**改名**） | 调度定义（3 条 L1 + 2 条 L0 启用/就绪；零售三条薄壳全部置停） |
| 2 | `deploy/duckle/console/owners.json` | `/workspace/owners.json` | 新鲜度 SLA（retail 锚 = 湖对象） |
| 3 | `deploy/duckle/console/alerts.json` | `/workspace/alerts.json` | 失败告警规则（引擎原生，经 OO） |
| 4 | `deploy/duckle/console/pipelines/lemeng.retail.windows.l1.json` | `/workspace/pipelines/…` | Wave B **父**（身份门 → 窗口表 → foreach → 汇总判红） |
| 5 | `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json` | 同上 | window 形**子**（父 4 与 8 共用；#335 补 `bucket`） |
| 6 | `deploy/duckle/console/pipelines/lemeng.retail.tick.l1.json` | 同上 | Wave C tick **父**（`enabled:false`，声明就绪） |
| 7 | `deploy/duckle/console/pipelines/lemeng.retail_order_line.tick.json` | 同上 | tick 形**子**（#335 补 `bucket`） |
| 8 | `deploy/duckle/console/pipelines/lemeng.retail.close.l1.json` | 同上 | Wave C close **父**（`enabled:false`） |

**不在本批**：`schedules/64188.json`（见 §6 边界）、`lemeng.dim.*`（前批已投）、
`lemeng.retail.*.run` 薄管线文件（退役待 Wave D；**其调度条目在仓内已 `enabled:false`**）。

> 📌 **「清单覆盖」≠「要 seed」**：`deploy/data-plane-manifest.txt` 里的目录条目 `deploy/duckle/console/` 是**递归**的，
> 覆盖本目录**全部**受版本控制的文件（含 `README.md`、本 `DELIVERY.md`）——那是给**机器检出**用的，
> **不是**给 console 卷用的。**seed 只投 §0.2 这 8 个**。两个面别混。

---

## 1. 硬步骤与顺序

> 顺序不可换：**④ 重建 catalog 必须排在 ⑥ 首次 run 之前**——历史运行记录**不追溯**补 `assets`（§3 判据 3）。

### ① push（把工件送进 main）

- `feat`/`fix` 工件走 PR 合并；**不 push 机器取不到件**（sync 按全 SHA 向 GitHub 取，未 push ⇒ 404）。
- 判据：目标 commit 在 `origin/main` 上，`git rev-parse origin/main` 就是你要投的那个 SHA。

### ② 机器 sync（按**全 SHA**）

```sh
sh /opt/lemeng-sync.sh <全SHA>            # 同步
sh /opt/lemeng-sync.sh <全SHA> --check    # 可选：只比不写
```

- 经 openship MCP **服务器级 exec** 在 console 所在机执行。
- **全 SHA 从命令输出逐字复制，绝不手工补**（sync 按**全 SHA** 取件——短 SHA / 分支名取不到；补错一位 = `FETCH_FAILED`）。
- 判据：末尾 `SYNC_OK <n>/<n>`，逐文件行全 `OK`；版本标记 `<检出>/.data-plane-revision` 写入成功。
- 失败处置：`LOCK_FETCH_FAILED:` / `LOCK_SELFTEST_FAILED:` / `FETCH_FAILED: <path>` ⇒ **停**，
  按 SOP §E.4 判是 ① 元数据说谎（确定性，重试无用）还是 ② 跨境断流（间歇，可重试）。
  这套机制**整套不是原子的**；失败停在半应用态时，**标记缺失本身就是信号**，别硬着头皮往下走。

### ③ 只 seed 改动的文件（**铁律：范围 = 本批文件集，粒度 = 整文件**）

**为什么不能「整目录搬运」**（三条实测理由，缺一条就是静默错）：

1. **整目录会把未投递的东西灌进 live console**——`64188.json` 会落错账套、仍在改的管线会被一并带上去；
2. **目录搬运破坏映射**：`schedules/3120.json` → `/workspace/schedules.json` 是**改名**；
   整目录搬会落成 `/workspace/schedules/3120.json`，console **读不到、也不报错**；
3. **整文件 seed 会把没投递的条目一并激活**（#335 缺陷 2 实测）：生产线只有 5 条目、
   `tick.run`/`close.run` **根本不存在**；按现状 seed 会把这两个**从未在生产运行过**的薄壳**启用**。
   ⇒ 这正是本批把两条薄壳在**仓内**先置 `enabled:false` 的原因。

**seed 粒度是整文件，不是逐条目 patch**（`schedules.json` 是「整文件覆盖」语义）——所以**任何进仓的条目都等于要生效的声明**。

```sh
# 形态（本仓【没有】专用 seed 脚本：计划里的 seed-schedules.sh 从未落仓 ⇒ 走服务器级 exec + docker exec）
# 经 openship MCP 的服务器级 exec 执行；CT = 按 §0.1 定位到的容器名
CT=$(docker ps --format '{{.Names}}' | grep lemeng-console-3120)

docker exec "${CT}" mkdir -p /workspace/pipelines
docker cp "${REPO}/deploy/duckle/console/schedules/3120.json" "${CT}:/workspace/schedules.json"
docker cp "${REPO}/deploy/duckle/console/owners.json"        "${CT}:/workspace/owners.json"
docker cp "${REPO}/deploy/duckle/console/alerts.json"        "${CT}:/workspace/alerts.json"
for f in lemeng.retail.windows.l1 lemeng.retail_order_line.window \
         lemeng.retail.tick.l1 lemeng.retail_order_line.tick lemeng.retail.close.l1 ; do
  docker cp "${REPO}/deploy/duckle/console/pipelines/${f}.json" "${CT}:/workspace/pipelines/${f}.json"
done
```

- **判据（唯一硬判据）**：逐文件比「卷内 sha256 == `deploy/data-plane.lock` 里该路径那一行」。
  「命令没报错」**不是**判据。
  ```sh
  docker exec "${CT}" sha256sum /workspace/schedules.json /workspace/owners.json /workspace/alerts.json \
    /workspace/pipelines/lemeng.retail.windows.l1.json /workspace/pipelines/lemeng.retail_order_line.window.json \
    /workspace/pipelines/lemeng.retail.tick.l1.json /workspace/pipelines/lemeng.retail_order_line.tick.json \
    /workspace/pipelines/lemeng.retail.close.l1.json
  ```
- 失败处置：sha 不符 ⇒ 重做该文件的 `docker cp`（**别整目录重来**）；反复不符 ⇒ 查检出那份是不是本批 SHA（回 ②）。

### ④ 重建 catalog（**漏了 = 新锚永久 Stale**）

```sh
# 二选一（都在 console 所在机执行）
docker exec "${CT}" duckle catalog build --workspace /workspace   # CLI 面
curl -s -X POST http://127.0.0.1:18080/api/catalog \
     -H "Authorization: Bearer ${DUCKLE_TOKEN}"                   # Operator API 面（**要凭据**）
```

> ⚠️ 本 console 的 `/api/*` 除公开路由外**一律先认证再派发**（`guard_local` 只挡跨源/非本机）。
> `POST /api/catalog` 是 **Operator 级** ⇒ 不带凭据收 **401**，不是「跑过了」。凭据取法见 SOP §F.2。

- 为什么必须有这一步：**catalog 是静态扫描 `pipelines/` 的产物，不是每次 run 现推**。
  管线文件进卷后不重建 ⇒ 它的运行记录**整条不带 `assets`** ⇒ 指向它的 owners 规则**永远匹配不到**，
  判成「从未写入」的**永久 Stale**，而**运行状态照旧 ok**。
- **必须在首次 run 之前**：`from_result_in` 从**已保存**的 catalog 取名，**历史运行记录不会追溯补上**。
- 判据（三条，全要）：
  1. `docker exec "${CT}" duckle catalog lint --workspace /workspace` → **exit 0**；
  2. `… duckle catalog owners --workspace /workspace` → retail 湖对象资产**有 owner**（不是 `0 of N`）；
  3. build 的 stderr **没有** `… source/sink node(s) could not be named` 这一行。
- ⚠️ **「重建没报错」≠「规则活了」**：缺失必需属性（如 `bucket`）时 build **照样 exit 0**，
  只有 lint 与 owner 覆盖率看得见（#335 / Wave C §6 实测）。
- 失败处置：命中第 3 条 ⇒ 按 §5 陷阱 3 查 sink 节点自身属性。

### ⑤ 重启 console（卷内定义重新加载）

- 经 openship MCP `post_projects_by_id_services_by_serviceId_restart`（服务级重启）。
- **为什么是「重启」而不是「定向重建」**：本批 seed 的全是**命名卷 `/workspace` 内**的定义
  （`schedules/`、`pipelines/`、`alerts.json`、`owners.json`）——卷内容**重启即重新读取**（SOP §F.2 第 1 类，
  2026-09-26 实测：seed + 只重启，`/api/schedules` 即列出新条目）。**bind-mount 类**（`duckle/`、`/opt/lemeng-run.sh`）
  才需要按 `serviceIds` **定向重建**；本批不碰它们。
  > ⚠️ **措辞差异（如实标注）**：handbook §1.3.2 把这个动作写成「重新 seed + **重建容器**」。
  > 本文件取 SOP §F.2 第 1 类（卷内定义 ⇒ 重启足够，且有实测背书）。两处措辞不一致已记入投递报告，**待 Wave D 收口统一**。
- 判据：「定义加载了没」——带凭据打 console 自己的调度 API，**条目数必须等于 `schedules/3120.json` 里的条目数**
  （本批投递时仓内 = 10 条；**判据是「相等」，不是写死某个数字**）：

  ```sh
  curl -s -H "Authorization: Bearer ${DUCKLE_TOKEN}" http://127.0.0.1:18080/api/schedules
  ```

  ⚠️ 该端点返回**以 `pipeline_id` 为键的字典**（不是数组），且**只回定义、不回运行状态**——
  **别拿它判运行**。它对「带上了 console 补的 `misfire`/`catchup`」这一现象，正是「真的解析过该条目」的证据。
- ⚠️ **同时核对**：`tick.run` / `close.run` 两条薄壳重启后**必须仍是 `enabled:false`**（§5 陷阱 2）。
- 失败处置：条目数不符 ⇒ 回 ③ 比 sha；条目在但状态不对 ⇒ 查仓内那份是不是被改回 `true` 了。

### ⑥ 首次 run

- **先手动触发**（把「管线本身能不能跑」与「调度对不对」两件事分开），别等自然点火：

  ```sh
  curl -s -X POST http://127.0.0.1:18080/api/run \
       -H "Authorization: Bearer ${DUCKLE_TOKEN}" -H 'Content-Type: application/json' \
       -d '{"file":"pipelines/lemeng.retail.windows.l1.json"}'
  ```

  ⚠️ body 的键是 **`file`**（值 = **工作区相对路径**，引擎按 `${workspace}/<file>` 解析），**不是** `pipeline`。
  载入会等整条跑完；长跑用 `/api/run/async`。
  同法逐个触发 `lemeng.retail.tick.l1` / `lemeng.retail.close.l1`（后两条调度仍是 `enabled:false`，
  手动触发**不会**让它们产生 run 事件告警，见 alerts `_note` ⑪）。
- 判据：**看运行记录判触发**（最新一条的 `at` = **开始**时刻），**不是** `schedules.json` 的 `last_run_at`（那是**完成**时刻）。
  （同一时刻在**回执**里叫 `startedAt`——两处字段名不同，别互相找。）
- 失败处置：失败先看 run 记录的 `error` 与 `logs/<pipeline_id>/runtime.log`；
  **排障口径在 SOP §F.4 / handbook §1.5，本文件不复制**（Wave D 收口）。

### ⑦ 按 §3 走五点验收 → 再进观察期（≥3 运行日）

- 观察期通过后才是 Wave D 收口（退役薄壳、删死规则、正典统一）——**不在本批**（§6）。

---

## 2. 调度面：本批投递后的目标状态（投递时核对）

| 条目 | 形态 | cron（UTC） | tz | misfire | 本批后 enabled |
|---|---|---|---|---|---|
| `panel-lemeng.retail.windows.l1` | L1 父（foreach） | `30 2,10 * * *` | UTC | `all` | **true** |
| `panel-lemeng.retail.tick.l1` | L1 父（foreach） | `*/5 0-15 * * *` | UTC | `skip` | **false**（本批不激活） |
| `panel-lemeng.retail.close.l1` | L1 父（foreach） | `0 16 * * *` | UTC | `all` | **false**（本批不激活） |
| `panel-lemeng.retail.windows.run` | 薄壳 | `30 2 * * *` | — | — | **false**（本批置停） |
| `panel-lemeng.retail.tick.run` | 薄壳 | `*/5 0-15 * * *` | — | — | **false**（从未投递，勿激活） |
| `panel-lemeng.retail.close.run` | 薄壳 | `0 16 * * *` | — | — | **false**（从未投递，勿激活） |

- 双点火（`windows.l1`）为何是 `all` 而非 `skip`：见 #324 终评——「同日任意时刻恢复」是超集场景。
- tick 为何是 `skip`：见 Wave C §4——catchup 用**执行时刻**重算窗口 ⇒ `all` 只造重复、补不回正确的窗。

---

## 3. 验收判据五点（照观察期口径）

> 五点**缺一不算过**。前三点判「这次跑没跑对」，后两点判「观测面接上了没」。

### 判据 1 — run `ok`

- 读**运行记录**（见判据 3 的路径），最新一条 `status == "ok"`。
- ⚠️ **`ok` 不等于求过值**：SQL 节点视图体延迟绑定、取行数的环节会把错误吞成空值 ⇒「没有行数的 ok」当**可疑**。
  必须配合判据 2 / 3 一起看。

### 判据 2 — 湖分区行数与 `batch_id`

按**层**分两种口径（**别混用**，handbook §1.4 已定案）：

| 层 | 管线 | 判据 |
|---|---|---|
| **日批兜底层** | `windows.l1` / `close.l1` | 该 `hour` 分区文件内 **`count(DISTINCT batch_id) == 1`** 且行数 > 0 |
| **tick 层** | `tick.l1` | **快照等值**：文件内容 = 网关**当刻**累计（每 5 分钟换 `batch_id` 覆盖写）⇒ **不是**去重计数 |

- 工具：既有的只读对账模式 `sh /opt/lemeng-run.sh recon <H>`（该 hour 湖回读 vs 网关翻页累计，**容差 0**）。
- 免凭据独立回读（换一条通道复核，**别复用被测方的通路**）：`pg_duckdb` 已配 S3 secret，可直读湖。
  ⚠️ **DuckDB SQL 必须用 `duckdb.query($$…$$)` 包裹**，否则报误导性的
  `column "hive_partitioning" does not exist`。
- ⚠️ **数行数别用 CSV 行数**（字段含内嵌换行会多算）——用引擎计数或规范 CSV 解析。

### 判据 3 — 运行记录**带 `assets`** ← **本批第一次真验的锚**

```sh
docker exec "${CT}" python3 -c "
import json
r=json.load(open('/workspace/runs/lemeng.retail.windows.l1.json'))[-1]
print(r['status'], r.get('at'), 'assets=', [a['id'] for a in r.get('assets',[])])
"
```

- 路径 = **`/workspace/runs/<pipeline_id>.json`**（**数组**，保留最近 50 条）。
- 判据：最新一条的 `assets` **非空**，且资产 id 与 `catalog` 里的**逐字相同**。
- 🔴 **本批的显式检查点（#335 的未验项）**：retail 锚**第一次**被真正验证。此前只证明了
  「**能否被命名**」（补 `bucket` 后 catalog 能命名了），**没有证明「新鲜度探测能真的打到具体对象上」**——
  asset id 里是 `${ENV:ZOS_BUCKET}` 这类**不展开的占位符模板串**。
  ⇒ 判据 3 **通过**但判据 4 仍是 `stale` ⇒ 是「探测命中」这一层出问题，**不是**「规则没挂」。
- ⚠️ **术语撞车（本仓踩过）**：`assets` 在**运行记录**（`runs/<pipeline_id>.json`，数组）里，
  **不在回执**（`runs/receipts/run-*.json`）里——**回执对任何管线都不带 `assets` 字段**。
  本仓曾拿回执比对，得出「薄管线有、新管线没有」的**错误结论**（实际两边都没有）。
  `deploy/duckle/console/README.md` §L0 与 #316 的观察期口径里把这两个词混用了，**以本节为准**。

### 判据 4 — `freshness.json` **非 `unknown`**

- 位置：`<workspace>/.duckle/freshness.json`（巡检节奏 `FRESHNESS_EVERY = 60s`，现读盘）。
- 判据（owners.json `_note` ⑤）：seed + 重建 catalog + 成功跑一次 L1 之后，
  该文件里 **retail 湖对象资产出现且状态 ≠ `unknown`**。
  - `fresh` = 正常在写；**`stale` 也是 seed 成功**（声明了但尚未写入）；**`unknown` 才说明规则没挂上**。
- 失败处置（按序查）：① 卷内 `owners.json` 的 sha 对不对（回 ③）；② 解析失败被静默吞
  （`load_owners` 失败是 `unwrap_or_default`，**不报错**）；③ **catalog 没建**（回 ④）。
- ⚠️ object 资产（含 foreach 子管线的资产）的时钟**端到端没在生产验过**——这就是「先验再切」的那一项。

### 判据 5 — 无失败告警

- 引擎原生规则经 OpenObserve 转投：引擎 POST → OO 流 `data_alerts`（org `miyuan`）→ OO 告警 → 企微群。
- 判据：观察窗口内，`data_alerts` 流里本批三条管线 id 的 **`event='failure'` 行数为 0**，且企微群无失败消息。
- 覆盖边界：**只有打进这个 console 的 run**（`/workspace/pipelines/` 下的管线）。
  **别把它读成「采集全链路的告警」**；64188 的卷未 seed 这版 alerts（§6）。
- ⚠️ `refreshed`/`recovery` 是 all-clear，**跳过冷却**、永远发出——见 `alerts.json` `_note`。

---

## 4. 回滚

### 4.1 一键回滚（调度层，薄壳仍在仓内 ⇒ 翻回来即可）

薄壳条目**没有被删**（Wave B 只置停、#335 只置停）⇒ 回滚 = **两侧成对翻状态**：

1. 仓内（或临时改卷内那份）：`panel-lemeng.retail.windows.l1` → `enabled:false`；
   `panel-lemeng.retail.windows.run` → `enabled:true`。（tick/close 同理成对。）
2. **③ seed**（整文件覆盖 `schedules.json`）→ **⑤ 重启** → 核对 `/api/schedules` 的 enabled 状态。
3. **判据**：薄壳下一次 cron 点火 → run `ok`；湖分区被老路径重写；**告警面静默**（薄壳 retail 规则仍在
   `alerts.json` 里、未删，正是为 64188 与本回滚留的——见 #331 裁量 1）。

⚠️ **回滚必须成对**：同一窗**不要并行两条路径**（会互相覆盖、看起来都成功）。

### 4.2 回滚的**观测面**代价（真话，别只回滚调度）

- `owners.json` 的 retail 锚已随 Wave B 换成**湖对象**，旧的 `/workspace/logs/retail-windows-run.csv` 锚
  **已从仓内删除**（#331）。而薄壳的湖写入**不在本 console 的 catalog 里** ⇒ **薄壳跑起来也刷不动这个新锚**。
  ⇒ 只回滚调度，**36h 后 retail 新鲜度会报 Stale**（数据其实在写，是**锚的口径不对**）。
- ⇒ **完整回滚 = 调度成对翻 + 恢复 owners.json（与 alerts.json）到投递前那份**。
  回滚点怎么留：**投递前**先从卷里把三份读出来留档（`schedules.json` / `alerts.json` / `owners.json`），
  或从 git 取 #331 之前的版本（`git show <pre-331>:deploy/duckle/console/owners.json`）。
- **回滚判据**：① 薄壳 cron 点火 ok；② 湖分区被重写且行数正确；③
  `/api/schedules` 的 enabled 状态与仓内（或留档那份）逐条一致；④ **无失败告警**；
  ⑤ 若观测面**未**回滚，`freshness.json` 出现 retail 锚 `stale` 属**预期读数**（记进报告，别当新故障查）。

---

## 5. 已知陷阱清单（投递前逐条对号）

1. **misfire 双点火边界：UTC < 16:00**
   双点火形态（`windows.l1` 的 `30 2,10`、`tick.l1` 的 `*/5 0-15`）的**小时列表在 UTC 下必须全部 < 16**——
   16:00 整点上海日翻转，跨过它两次点火就落到**不同 `bizday`** ⇒ checkpoint **零复用**（实测 289/289 全采）、
   且写错营业日。**硬规矩**：新加双点火条目先算这条。
   推论（#324 终评）：`misfire:all` 也**救不回**「跨 UTC 16:00 边界的整日宕机」跳过的那个营业日
   （补跑按**恢复时刻**推 `bizday`）——这是设计使然，不是缺陷，已在截尾决策的接受范围内。

2. **tick / close 薄壳已置停——勿因 seed 重新激活**
   `panel-lemeng.retail.tick.run` / `close.run` 在**生产上根本不存在**（#335 实测：生产卷 5 条目），
   在仓内是 `enabled:false`。**seed 是整文件覆盖** ⇒ 一旦仓内那份被改回 `true`（或另从旧分支投递），
   会把这两个**从未在生产运行过**的薄壳**激活**，与刚切的 L1 同窗双跑、互相覆盖。
   ⇒ 投递后**必查** `/api/schedules` 里这两条仍是 `false`（§1 ⑤ 的核对项）。

3. **catalog 命名依赖「节点自身属性」而非连接**
   `snk.minio` 的 `bucket` 是 schema **必需**。只写 `connectionRef` + `key` ⇒ 写侧照常（连接里带了 bucket），
   但 catalog **命名不了这个节点** ⇒ 指向它的 owners 规则**匹配不到任何东西** ⇒ **零售 36h 陈旧不告警**。
   这正是「**能写 ≠ 能被观测面命名**」；且**任何地方都不报错**。
   判据只能是 `catalog lint` exit 0 + `catalog owners` 覆盖 ≥1（**不是**「重建没报错」）。
   ⚠️ **CI 里没有 catalog lint 这道守卫**（跟踪 #337）⇒ 只有手工跑一次才看得见。

4. **≥2 tick 缺口的真补法不是 misfire，是补采 SOP**
   catchup **结构上补不回**错过的窗（窗口由执行时刻算，§2）。tick 漏 **1** 次由下一次 tick 的 `prev` **自愈**；
   **≥2 个 tick（≥10 分钟）**的缺口，任何 misfire 取值都无能为力 ⇒ 必须走**投递批次的补采 SOP**
   （`run-retail-day.sh recon <H>` 对照 + 定点重跑）。
   ⚠️ 「**怎么定点补一个已过去的小时**」目前**没有现成工具**（Wave C §9 待定项）——缺口出现时先挂号，别指望 misfire。

5. **`assets` 在运行记录，不在回执**（见判据 3 的 ⚠️）——术语撞车，本仓已经踩过一次。

6. **`ok` 不等于求过值**（见判据 1 的 ⚠️）：延迟绑定 + 行数被吞 ⇒ 闸会**静默放行**。

---

## 6. 边界声明（本 runbook 不覆盖什么）

| 不覆盖 | 归谁 |
|---|---|
| **账套 64188** 的 L1 切换 | 独立决定（其卷未 seed 本版 `owners.json` / `alerts.json`；要不要切另议） |
| **Wave D 收口** | 薄壳退役（删条目 + 删管线文件 + 删 `alerts.json` 里的死规则）、`run-retail-day.sh` 的 `dim`/零售分支标废弃、**正典统一**（handbook §1.5 与 SOP §F.4 的排障口径、§1.1.7 Wave 表 + L0/L1 档补首个生产案例） |
| **历史回填** | **#328**（`retail_order_line` 回填；硬前置是先迁读侧） |
| **投递程序本体** | SOP §E（本文件只引用命令，不复述机制） |
| **排障口径** | SOP §F.4 / handbook §1.5（**Wave D 收口，本文件不抢跑**） |
| **排班与观测的正典正文** | `deploy/duckle/console/README.md`、`owners.json` / `alerts.json` 的 `_note`（本文件只放指针） |

**观察期**：投递后 ≥3 运行日（调度 ok / 湖分区正确 / 运行记录带 `assets` / 告警面静默 /
`freshness.json` 里湖对象资产不再 Stale）——通过后才进 Wave D 收口。

---

## 附：改本目录任一家族文件后的硬前置

`deploy/duckle/console/` 在 `deploy/data-plane-manifest.txt` 里是**递归目录条目** ⇒ **本文件自己**也在覆盖范围内
（`README.md` 先例：同类位置、同样被覆盖）。⇒ **改本目录任一文件（含本文件）后必须重跑**：

```sh
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
```

否则 CI 的 `check-data-plane-lock` 会红（守卫会在失败信息里复述这条命令）。
