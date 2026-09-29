# 64188 L0/L1 声明态落仓（2026-09-29）

> Issue **#349** · PR **#351** · Refs **#343 #318** · 授权来源 = `docs/superpowers/plans/2026-09-29-waveD-64188-retirement-closeout.md`
> （Wave D 计划；§7.1 已含 **2026-09-29 四条裁决**，其中 **U1 拍板「64188 也上观测面」**）。
> 同构参照 = `deploy/duckle/console/DELIVERY.md`（3120 的 Wave B/C 投递单）与 #331 / #333 / #335 三个 prep 批。
>
> **性质**：**纯仓内声明态 + 只读实测**。本批**零生产写入**——未 seed、未改任何容器/调度/卷、
> 未建连接、未重建 catalog、**未激活任何条目**。投递与激活留 Wave D 执行批次。

---

## 0. 一句话结论

64188 的 L0/L1 **在管线件层面是零改造、零新文件**（账套相关值全走 `${ENV:SYSTEM_BOOK}` / `${ENV:BRANCH_NUMS}`），
所以「声明态落仓」实际只动**一个文件**：`schedules/64188.json` 补 5 条 L0/L1（**全部 `enabled:false`**，就绪不激活）。
观测面两件（`owners.json` / `alerts.json`）**内容已覆盖 64188**（规则/锚是账套无关的 glob 与管线 id）⇒ **无需改动、只差 seed 动作**，
但有一个**时序硬约束**（§3.3）：`owners.json` **不能单独 seed**。

---

## 1. 本批改了哪两个文件

| 文件 | 改动 | 判据 |
|---|---|---|
| `deploy/duckle/console/schedules/64188.json` | 追加 5 条 L0/L1 条目，**全部 `enabled:false`**；既有 5 条薄壳**一字未动**（含 `enabled`） | 与 `schedules/3120.json` 逐条比对：条目 id 集合**完全相同**（10 vs 10），字段**除 `enabled` 外全等**（§6 验证脚本） |
| `deploy/data-plane.lock` | 重跑 `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` | diff **恰好 2 行**：`sha256-of-rest` 首行 + `…/schedules/64188.json` 那一行（`1d554e8e…` → `d54b625e…`）；manifest 不动 |

**其余一律未动**：`deploy/duckle/console/` 下的 `owners.json` / `alerts.json` / `pipelines/*` / 两个 `README`/`DELIVERY`
**本批零字节改动**。

### 1.1 补进去的 5 条（cron / tz / misfire / catchup 逐字照抄 3120 的对应条目）

| 条目 | cron（UTC） | tz | misfire | catchup | 本批 `enabled` |
|---|---|---|---|---|---|
| `panel-lemeng.dim.branch.l0` | `0 2 * * *` | （未设，同 3120） | `skip` | `{31, 45}` | **false** |
| `panel-lemeng.dim.item.l0` | `0 11 * * *` | （未设，同 3120） | `skip` | `{31, 45}` | **false** |
| `panel-lemeng.retail.windows.l1` | `30 2,10 * * *` | `UTC` | `all` | `{31, 45}` | **false** |
| `panel-lemeng.retail.tick.l1` | `*/5 0-15 * * *` | `UTC` | `skip` | `{31, 45}` | **false** |
| `panel-lemeng.retail.close.l1` | `0 16 * * *` | `UTC` | `all` | `{31, 45}` | **false** |

> L0 两条按 3120 同形：**不设 `timezone`**（只有 L1 三条带 `timezone:"UTC"`）——这是 3120 的现成形状，
> 未自创；`misfire`/`catchup` 三处同样照抄。

---

## 2. 只读实测：64188 投递前现状（2026-09-29 11:34 UTC）

**手段**：openship MCP **服务内执行端点**（`post_projects_by_id_services_by_serviceId_exec`，
等价 `docker exec`，不经裸 SSH）；**只读**（`ls` / `cat` / `sha256sum` / `python3 -c` 读 JSON）。
**未**使用服务器级 exec，**未**写任何文件。

| 项 | 实测值 |
|---|---|
| 项目 | `platform-core-shanhai-data`（`proj_AFbJvyb0onaX7LVr`） |
| 服务 / 容器 | `lemeng-console-64188`（serviceId **`svc_u4pvEqZPfstnE5vI`**） |
| 宿主机 | serverId **`8281d598-af73-4d0b-99dd-bc8681fcc8bb`**（山海数据面机） |
| 容器 TZ | **UTC**（`date -u` = `Tue Sep 29 11:34:50 UTC 2026`） |
| 服务级 env（值打码） | 含 `SYSTEM_BOOK` / `BRANCH_NUMS` / `ZOS_*` / `LEMENG_TOKEN` / `DUCKLE_TOKEN` —— **确认 `BRANCH_NUMS` 在服务级 env 里**（计划 §7.1-U4(b) 的实测补正复现） |

**卷内读数（与计划 §2.2 逐字一致 ⇒ 卷内一字未动、无漂移）**：

| 对象 | 实测 | 与计划 §2.2 |
|---|---|---|
| `pipelines/` | **3** 个：`lemeng.dim.branch.run.json` / `lemeng.dim.item.run.json` / `lemeng.retail.windows.run.json` | ✅ 一致（**无任何 `.l0`/`.l1`**） |
| `schedules.json` | **3** 条，全部 `enabled:true`；三条 `last_run_status` 全 `ok`（当日 branch 02:00Z / item 11:05Z / windows 02:32Z） | ✅ 一致（计划写「3 条全 true」） |
| `owners.json` | **3** 条 **kind=file** 锚：`/workspace/logs/{dim-branch,dim-item,retail-windows}-run.csv`，`maximumAge:36h` | ✅ 一致（**卷内停在 Wave A 之前**） |
| `alerts.json` | **5** 条规则：`*`(stale/refreshed,15) · `lemeng.dim.*.run`(15) · `lemeng.retail.windows.run`(15) · `lemeng.retail.tick.run`(60) · `lemeng.retail.close.run`(60) | ✅ 一致（**卷内停在 Wave 1 之前**） |
| `connections/` | **不存在** | ✅ 一致（凭据面从未建过） |
| `.duckle/keys/` | **不存在** | ✅ 一致 |
| `.duckle/freshness.json` | 三条 file 锚全 **`fresh`** | ✅ 一致 |
| `/workspace/schedules.json` sha256 | `a02fecd8ab3f4c6a24c85d57881ed4f1a35971ac1323932c415f0ffc44e6d277` | ⚠️ 与计划 §2.2 的 `f6b8e066…` **不同**，见下 |
| `/workspace/owners.json` sha256 | `c7e4a8883c7c6929333a1c30edcb10418cc8852ae3fa3d08fe853681689451a3` | ✅ **逐字相同** |
| `/workspace/alerts.json` sha256 | `430f65468ef6a588c58504824ac17c1170cdc7ae09f7c56d3102212c65569855` | ✅ **逐字相同** |

### 🔎 那条 sha 差异不是漂移（实测解释，别当异常查）

卷内 `schedules.json` 的 sha 变了，**原因**：**引擎把运行状态回写进了这个文件**——现盘内容比计划取证时多了
三条各自的 `misfire:"skip"` / `catchup:{31,45}`（引擎补的默认值）与 `last_run_at` / `last_run_status:"ok"` /
`last_run_duration_ms`（当日三次点火的实际读数）。**条目集合与 `enabled` 一字未变**（仍是 3 条薄壳、全 `true`）。
⇒ `owners.json` / `alerts.json` 两个 sha 与计划**逐字相同**，正说明这两个文件**没有被任何进程写过**；
`schedules.json` 是**引擎自管**的文件，它的 sha 会随 run 状态变——**这不是漂移**。

---

## 3. 任务四项逐条落地

### 3.1 `schedules/64188.json` —— 5 条 L0/L1 已补，全部 `enabled:false` ✅

见 §1.1。**薄壳条目本批不置停**（按任务书：激活切换属 Wave D 执行批次）。

#### ⚠️ 投递时必须与 3120 同批「成对翻」

本批落仓后，两个 `schedules/*.json` 的差异**恰好只有 `enabled` 一列**，且这 6 条构成 **3 对**：

| 对 | `schedules/3120.json`（现） | `schedules/64188.json`（本批后） | 投递时 64188 要翻成 |
|---|---|---|---|
| dim.branch | l0=**true** / run=**false** | l0=**false** / run=**true** | l0=true / run=false |
| dim.item | l0=**true** / run=**false** | l0=**false** / run=**true** | l0=true / run=false |
| retail.windows | l1=**true** / run=**false** | l1=**false** / run=**true** | l1=true / run=false |

**纪律（照 `DELIVERY.md` §4.1）**：这三对**必须在同一个投递批次里成对翻**（L0/L1 起 + 薄壳停），
**不可只翻一半**——同一窗并行两条路径会互相覆盖且**看起来都成功**。
`tick.l1` / `close.l1`（两侧都 `false`）与 `tick.run` / `close.run`（两侧都 `false`）**保持不动**。

#### ⚠️ 第二个投递注意：seed 会「凭空造出」两条薄壳条目

`panel-lemeng.retail.tick.run` / `close.run` 在仓内是 `enabled:false`，而**64188 生产卷里从来不存在这两条**
（实测：卷内只有 3 条）。因为 `schedules.json` 是**整文件覆盖**语义（`DELIVERY.md` ③），
**seed 这个文件 = 把这两条从未在 64188 跑过的薄壳登记进去**（保持 `false` ⇒ 惰性，不点火）。
这正是 `DELIVERY.md` §5 陷阱 2 的形状（3120 侧同款），且是 **§7.1-U2(a)「彻底退役」**要一并删掉的对象。
⇒ 投递后按 `DELIVERY.md` §1⑤ 核对：**这两条必须仍是 `false`**。

### 3.2 L0/L1 管线文件是否账套无关 —— **核实结论：可直接复用，本批不动管线文件** ✅

**依据（两条，都实测）**：

1. **计划 §2.4 D3 的结论**：管线文件里**全部**账套相关值走 `${ENV:SYSTEM_BOOK}` ⇒ 账套无关、逐字复用，
   「无需任何 64188 特化文件」（§9「明确不做」第 1 条：不为 64188 新造管线文件，造特化件 = 两个事实源）。
2. **本次逐文件复核（5 个 L0/L1 文件）**：

   | 文件 | 引用的 env 键（去重） |
   |---|---|
   | `lemeng.dim.branch.l0.json` | `BRANCH_NUMS` `LEMENG_TOKEN` `SYSTEM_BOOK` `ZOS_BUCKET` `ZOS_REGION` |
   | `lemeng.dim.item.l0.json` | 同上 |
   | `lemeng.retail.windows.l1.json` | `BRANCH_NUMS` `SYSTEM_BOOK` |
   | `lemeng.retail.tick.l1.json` | `BRANCH_NUMS` `SYSTEM_BOOK` |
   | `lemeng.retail.close.l1.json` | `BRANCH_NUMS` `SYSTEM_BOOK` |

   **字面量扫描**（`grep -o '3120\|64188'`）：5 个文件里**只有 `lemeng.dim.item.l0.json` 命中**，共 5 处——
   - 3 处 `3120` / 2 处 `64188` **全在 `_note` 散文里**（一句实测基线：「3120=17,132（57.5%）、64188=24,736（83.0%）」）；
   - 其中一处 `3120` 是**画布坐标巧合**：节点 `p27` 的 `"position": {"x": 0, "y": 3120}`。
   ⇒ **行为面零账套字面量**；`_note` 里的账套名是文档、不是配置。

   另外一个**不是账套字面量、但必须知道**的依赖：5 个文件**全部引用 `${ENV:BRANCH_NUMS}`**——
   它是**唯一按账套取值不同**的输入（计划 F3/D4：3120 len=970 vs 64188 len=409），
   走 **openship 服务级 env** 注入（本批实测两侧服务 env 都**含**该键；§7.1-U4(b) 已裁「仓内书面记录在哪、怎么取」）。
   ⇒ 管线件账套无关 ≠ 运行参数无差异：**换账套要换的是 env，不是文件**。

**⇒ 本批对 `deploy/duckle/console/pipelines/**` 零改动**（管线文件的 sha 亦未被 lock 改动，见 §1 的 lock diff）。

### 3.3 观测面（U1 已拍板「上」）—— **已覆盖 64188，只差 seed 动作** ✅

**逐件核实（不看 `_note` 的口径句，只看**规则内容**能不能命中 64188）**：

#### `owners.json`（仓内 3 条锚，全是湖对象）

| `match` glob | 命中的资产（该资产的 id 里含 `${ENV:SYSTEM_BOOK}` 等不展开占位符） |
|---|---|
| `minio://*/lemeng/dim_branch/system_book=*/snapshot=*/all.parquet` | `lemeng.dim.branch.l0` 的 `snk.minio` |
| `minio://*/lemeng/dim_item/system_book=*/snapshot=*/all.parquet` | `lemeng.dim.item.l0` 的 `snk.minio` |
| `minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet` | `lemeng.retail_order_line.window`（父 `…windows.l1` foreach 逐窗写）的 `snk.minio` |

**结论**：三个 glob 的 `system_book=*` 段是 `*`，它**吸收账套值**（3120 与 64188 都在同一条规则下命中）
⇒ **同一份 `owners.json` 天然覆盖 64188**，无需改规则。锚的**成分**也账套无关（`${ENV:SYSTEM_BOOK}` 不展开是已知正常形态，
owners ⑧ 有 duckle 0.7.4 本机实测背书）。

#### `alerts.json`（仓内 9 条规则）

9 条规则全部 `match` **管线 id**：`*` · `lemeng.dim.*.run` · `lemeng.dim.*.l0` · `lemeng.retail.windows.run` ·
`lemeng.retail.windows.l1` · `lemeng.retail.tick.l1` · `lemeng.retail.close.l1` · `lemeng.retail.tick.run` ·
`lemeng.retail.close.run`。**管线 id 里没有账套** ⇒ 同一份文件在两个 console 上按同一组 id 命中。
⇒ **内容已覆盖 64188**，无需增删规则。

**⇒ 两个文件本批均零改动，结论 =「已覆盖，只差 seed 动作」。**

#### ⚠️ 但这里有一条**时序硬约束**（本批最重要的发现）

**`alerts.json` 可以单独 seed，`owners.json` 不能**——理由：

| 文件 | 单独 seed 会怎样 | 判断 |
|---|---|---|
| `alerts.json` | 新 9 条 **⊇** 卷内现 5 条（薄壳三条 `*.run` 规则**都还在**，⑩ 已明写保留正是为 64188）⇒ 薄壳告警**不丢**；新增的 4 条（`dim.*.l0` / 三个 `.l1`）当下**匹配不到任何在跑的管线** ⇒ 惰性、无害 | ✅ 可单独 seed |
| `owners.json` | 卷内是 **3 条 CSV file 锚**（盯着**正在跑**的薄壳产物，现全 `fresh`）；仓内版把它们**整份换成 3 条湖对象锚**。而 64188 此刻**卷内没有任何 L0/L1 管线、也没有重建过 catalog** ⇒ 新锚**指不到任何资产**、旧锚（薄壳的 CSV）**被一起删掉** ⇒ **dim×2 + retail 的新鲜度同时全盲** | 🔴 **必须与「seed L0/L1 管线 + 重建 catalog」同批** |

**这正是 `DELIVERY.md` §4.2 警告的同一条**（「只回滚调度不回滚观测面 ⇒ 36h 后报 Stale，锚的口径不对」的反向版本：
这里是**只 seed 观测面不 seed 管线**）。
⇒ 投递批次里 `owners.json` 的 seed **必须排在**「L0/L1 管线进卷 + `duckle catalog build`」**之后或同批**，
并按 `DELIVERY.md` §3 判据 4 验收（`freshness.json` 里湖对象资产**出现且 ≠ `unknown`**）。

#### 📌 两处 `_note` 口径句已过时（**本批不改**，列出供投递/收口批次处置）

规则内容无需改，但两处 `_note` 的**散文**在 U1 拍板后已与决定不符（它们写的是「要不要切是独立决定」）：

| 文件 | 行 | 现文（摘） | 建议 |
|---|---|---|---|
| `deploy/duckle/console/owners.json` | ⑦ 末（`"   （要不要切是独立决定）。"`）+ ⑩ 末（`"   · 64188 账套未 seed 本文件（⑦ 口径不变，要不要切是独立决定）⇒ 本锚只对 3120 生效。"`） | 「64188 未 seed …独立决定」 | 投递批次或 Wave D 收口时改成「64188 已按 §7.1-U1(a) 同批 seed；锚是账套无关 glob，一份文件覆盖两账套」 |
| `deploy/duckle/console/alerts.json` | ⑤ 末两段（`"   另：账套 64188 的 console 卷**尚未 seed 这版**…"` 与它的 `2026-09-28 再订正`） | 「尚未 seed / 已完成 seed（**指 2026-09-27 的 5 条版**）…要不要切是个独立决定」 | 同上；并点明「已完成 seed」那句指的是 **5 条旧版**，不是本 9 条版（本批实测卷内仍是 5 条） |

**为什么不本批改**：计划 §3.2 明列「**不改** `owners.json` / `alerts.json`——仓内已是共用版 ⇒ 64188 只需首次 seed 同一份」。
本批遵循该条；上面两处是**散文口径**、不改变任何规则行为，故列为**投递批次的随行项**而非本批改动。
（若协调者要求本批一并订正，改动面仅这两处 `_note` + 重跑 lock。）

### 3.4 lock 已重跑 ✅

```
$ pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
data-plane-lock: 写入 deploy/data-plane.lock（10 条清单条目 → 53 个文件）
$ pnpm exec tsx scripts/check-data-plane-lock.mjs
check-data-plane-lock: OK
```

---

## 4. 与任务书字面不同 / 需说明的裁量

1. **新条目的 JSON 排版照抄 3120 的展开式；既有 5 条薄壳的紧凑排版（`"kind": { … }` 单行）**未动**。**
   理由：本批是「声明批」，任务书要求「**薄壳条目本批不置停**」⇒ 不动它们；同时「字段风格与 3120 逐一对齐」
   要求新条目与 3120 的**对应条目块**可逐字对照（`diff` 只差 `enabled`）。代价：**一个文件内两种缩进风格并存**
   （内容无差别）。若协调者要求整文件统一排版，另开一条纯格式提交即可（零行为影响）。
2. **薄壳条目未置停**（任务书明确）：本批只**登记** L0/L1（`false`），`enabled` 的翻转连同 seed 留 Wave D 执行批次（§3.1 的成对翻表）。
3. **未改 `owners.json` / `alerts.json`**：见 §3.3 末（依据计划 §3.2）。

---

## 5. 本批**不做**、留 Wave D 执行批次的（诚实清单）

- **投递**：`sh /opt/lemeng-sync.sh <全SHA>` / seed / `catalog build` / 重启 console / 首次 run —— **一次都没做**。
- **激活**：5 条新条目全是 `enabled:false`；**没有任何调度被打开**。
- **凭据面**：`connections/` 与 `.duckle/keys/` **仍是「不存在」**（计划 §3.1 的 `connection-setup.py` 一次性 setup 未执行）。
- **薄壳退役**：`tick.run`/`close.run` 条目仍留在仓内（§7.1-U2(a) 的「卷内删文件」还缺工具——**计划 §7.1 已记为 Wave D 的新前置**）。
- **正典收口**：`handbook §1.1.7/§1.5`、`SOP §F.4`、`README §L0 三问表`、`DELIVERY.md §1⑤/§6` 等
  （计划 §5.1 的 12 条清单）**一条未动**。
- **`BRANCH_NUMS` 的仓内事实源**：按 §7.1-U4(b) 裁「书面记录在哪、怎么取」——本报告 §3.2 记录了实测（服务级 env、两侧都含、值打码），
  **未**改 `deploy/data-compose.yml` / `.env.example`（该选项已被裁掉）。
- **WeKnora 沉淀**：计划 §6 的查重/更新/新建清单**未执行**（不在本任务书范围）。

---

## 6. 验证命令与读数（可复现）

```sh
# ① 结构对齐：两个 schedules 的条目 id 集合相同、字段除 enabled 外全等
python3 - <<'PY'
import json
A={e['id']:e for e in json.load(open('deploy/duckle/console/schedules/3120.json'))}
B={e['id']:e for e in json.load(open('deploy/duckle/console/schedules/64188.json'))}
assert set(A)==set(B) and len(B)==10
for k in sorted(A):
    d={f for f in set(A[k])|set(B[k]) if A[k].get(f)!=B[k].get(f)}
    print(k, 'IDENTICAL' if not d else d)   # 只应出现 enabled
PY

# ② 静态守卫族（CI gates 的静态部分）
for g in check-manifests lint-architecture check-compose check-env-example check-data-models check-data-plane-lock; do
  pnpm exec tsx "scripts/${g}.mjs" || echo "FAIL ${g}"
done
```

**实测读数**：
- ① 输出：10 条 id 全对齐；**只有 6 条出现 `{'enabled': (…) }` 差异**（§3.1 的成对翻表），其余 4 条 `IDENTICAL`。
- ② 六个守卫**全 OK**。
- `git diff --stat`：`deploy/data-plane.lock` 2 行 + `deploy/duckle/console/schedules/64188.json` 103 行（+）。
- **前后 sha256**：`schedules/64188.json` `1d554e8ebbe5f2cb06a1e6b5ece98f5e27f44110f02e81fc244f48f1ad996a90` → `d54b625e82506e8c58d28a0cd6f6dedff2e6549fa9ddf268fd0933fbc14edfec`。

---

## 附：本文件**没有**做的事

1. **零生产写入**：未 sync、未 seed、未 `docker cp`/`rm`、未重启、未 `catalog build`、未跑任何管线、未改任何卷内文件。
2. **未在 3120 上取证**（除引用计划既有读数），**未由 64188 读数反推 3120**。
3. **未合并**：本 PR 开出即止。
4. 卷内实测的**全部**命令经 openship MCP 服务内执行端点，**未用裸 SSH**（根本法则·唯一通道）。
