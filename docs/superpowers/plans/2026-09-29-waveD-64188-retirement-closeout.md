# Wave D —— 64188 跟进 + 全量收口（实施计划）

> **worker**: term_6548ebcb-ebfd-4cae-9753-286bc6ed096e ／ task `task_defc8af2e9a4` ／ dispatch `ctx_43ef7bd65e04`
> **worktree**: `/Users/duo/orca/workspaces/platform-core/waveDplan`（分支 `ylwzzs/waveDplan`，基线 `6d8660b`）
> **issue**: **#343**（`Refs #318 #330 #332 #334`）
> **上位计划**: `docs/superpowers/plans/2026-09-28-all-pipelines-migration.md`（本文件是它的 **Wave D 节**的展开）
> **性质**：**纯规划文档 + 只读实测**。写它的时候**零生产写入**——未 seed、未改任何生产、未激活任何调度、
> **未往 64188 的写入面写过一个字节**（全部经 openship MCP 的**服务内执行端点**只读读取）。
> **本文件不执行任何步骤**；执行归后续投递批次。

---

## 0. 一句话结论

Wave D = **两件事**：**①** 把 64188 的 dim 面（branch/item）与 retail 日批**同构迁到 L0/L1**（3120 的 Wave 1/A/B/C 已把路走通）；
**②** 两个账套**都切完之后**，一次性退役薄壳（薄管线文件 + 调度条目 + 死告警规则 + 内层重管线 + owners 的 CSV 锚）并做正典收口。

**本次只读实测颠覆了一个前提**：64188 的卷内状态**不是**「3120 的旧版」，而是**更旧一版**——
`owners.json` / `alerts.json` 都停在 **Wave A 之前**（文件锚 3 条 / 告警规则 5 条），
且**根本没有 `connections/`**（加密连接从未建过）。⇒ 64188 的迁移**不是**「照抄 3120 的当前仓内件」，
而是**从零建凭据面 + 一次跨三代 seed**（详见 §2.3 / §3）。

**第二件事**：3120 的上位现状**也**比仓内声明落后——Wave B/C 的投递（`DELIVERY.md`）**尚未执行**
（实测 3120 卷内无任何 `.l1` 管线文件、`retail.windows.run` 薄壳调度仍 `enabled`）。
⇒ **Wave D 的硬前置是「Wave B/C 投递并观察期满」**，本计划不得抢跑。

---

## 1. 依据与引用纪律

| 材料 | 用途 |
|---|---|
| `docs/superpowers/plans/2026-09-28-all-pipelines-migration.md` | **母计划**（Global Constraints、波次纪律「不许跨波并行改生产」、风险表） |
| `docs/superpowers/plans/2026-09-28-wave1-branch-l0.md` | **模板**：branch 的 L0 迁移全过程（Wave 1） |
| `docs/superpowers/specs/2026-09-29-duckle-l1-retail-waveB.md` + `-verify.md` | Wave B（retail.windows → L1） |
| `docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md` | Wave C（tick/close → L1 tick 形首飞）+ §9 未验清单 |
| `docs/superpowers/specs/2026-09-29-waveb-delivery-prep.md` | **#330/#331**：观测面同批换锚的裁量 1（薄壳规则为何保留） |
| `docs/superpowers/specs/2026-09-29-retail-child-sink-bucket-fix.md` | **#334/#335**：子管线 `bucket` 缺失 ⇒ 死规则判据 |
| `docs/superpowers/specs/2026-09-28-duckle-connection-setup.md` | **加密连接**一次性 setup（命令 / 护栏 / 未验项） |
| `deploy/duckle/console/DELIVERY.md` | **投递批次执行单**（硬步骤顺序 / 五点验收 / 回滚 / 陷阱） |
| `deploy/duckle/console/README.md` | 调度器实测事实、L0 观测面口径、一账套一 workspace 的理由 |
| `deploy/duckle/console/{owners,alerts}.json` 的 `_note` | **口径正本**（阈值 / 分组判据 / 覆盖边界，冲突时以它们为准） |
| `docs/data-platform-handbook.md` §1.1.4/§1.1.7/§1.3.2/§1.3.3/§1.4/§1.5/§1.6 | 正典（收口对象） |
| `deploy/data-plane-deploy-sop.md` §E/§F.1–§F.5 | 投递程序与调度运维（收口对象） |

**引用纪律**：本文件凡引用**既有值**（阈值、cron、glob、sha、路径、消息字面量）一律**逐字照抄不改写**；
凡**本次实测**得到的读数一律标注取证命令与时刻；**凡未验的**一律明写「未验」，不进结论。

---

## 2. 64188 现状盘点（2026-09-29 只读实测）

### 2.1 定位（全部经 openship MCP 实测，非记忆）

| 项 | 实测值 |
|---|---|
| 项目 | `platform-core-shanhai-data`（id `proj_AFbJvyb0onaX7LVr`） |
| 服务 | `lemeng-console-64188`（serviceId **`svc_u4pvEqZPfstnE5vI`**） |
| 宿主机 | serverId **`8281d598-af73-4d0b-99dd-bc8681fcc8bb`**（山海数据面机） |
| 工作区卷 | `lemeng-console-64188-ws` → 容器内 `/workspace` |
| 回环端口 | `127.0.0.1:18081:18081` |
| bind 挂载 | `../duckle:/pipelines:ro`、`/opt/lemeng-run.sh:/opt/lemeng-run.sh:ro` |
| 容器 TZ | **UTC**（实测 `date` = `Tue Sep 29 10:37:25 UTC 2026`） |

> ⚠️ **取证手法**：全部用 openship MCP 的**服务内执行端点**（`post_projects_by_id_services_by_serviceId_exec`
> 在容器里跑命令，等价于 `docker exec`，但**不经裸 SSH**，符合根本法则·唯一通道）。
> 未使用服务器级 exec，未写任何文件。

### 2.2 仓内 vs 卷内（逐项对照）

| 对象 | 仓内（`6d8660b`） | 64188 卷内（实测） | 差异 |
|---|---|---|---|
| `pipelines/` | **12** 个文件（5 薄壳 + 2 L0 + 2 L1 父 + 2 子 + …） | **3** 个：`lemeng.dim.branch.run.json` / `lemeng.dim.item.run.json` / `lemeng.retail.windows.run.json` | 无任何 L0/L1；tick/close 薄壳**在 64188 侧从未存在** |
| `schedules/64188.json` | **5** 条（3 条 `enabled:true` + `tick.run`/`close.run` `enabled:false`） | **3** 条，全部 `enabled:true`（仅 branch.run / item.run / retail.windows.run） | 仓内多出 tick/close 两条**从未在生产存在过**的声明 |
| `owners.json` | 24,963 字节（3 条 **kind=object 湖对象**锚，见 ⑧⑨⑩） | **8,034** 字节：3 条 **kind=file** 锚（`/workspace/logs/dim-branch-run.csv` / `dim-item-run.csv` / `retail-windows-run.csv`，`maximumAge:36h`） | **卷内停在 Wave A 之前**（文件锚版） |
| `alerts.json` | 21,384 字节，**9** 条规则 | **13,800** 字节，**5** 条规则：`*`(stale/refreshed,15) · `lemeng.dim.*.run`(15) · `lemeng.retail.windows.run`(15) · `lemeng.retail.tick.run`(60) · `lemeng.retail.close.run`(60) | **卷内停在 Wave 1 之前** |
| `connections/` | （仓内不该有，见 §1.1.7 红线） | **不存在** | 🔴 **加密连接从未建过** |
| `.duckle/keys/` | （同上） | **不存在** | 🔴 同上（钥匙会随首次 setup 生成） |
| `.duckle/catalog.json` | — | **存在**，1,355 字节（`buildFrom.files: 3`；3 条管线；**3 条 file 资产**；`unresolved: []`） | catalog 已建，但**只认薄壳的 CSV 产物** |
| `.duckle/freshness.json` | — | 3 条文件锚全 **`fresh`** | 薄壳锚在 64188 侧**活着**（与 3120 侧已换成湖对象锚不同） |
| `runs/` | — | `lemeng.branch.json` / `lemeng.item.json` / `lemeng.retail_order_line.json` + 3 个 `.run.json` + `receipts/` | 内层重管线的运行记录**落在本工作区**（同 3120，见 handbook §1.5 「`run-manual-*` ≠ 有人手点」条） |
| `logs/` | — | `dim-branch-run.csv` / `dim-item-run.csv` / `retail-windows-run.csv` + `dim-<日期>-{branch,item}/` + `00`…`23` | 同上 |

**卷内 sha256（逐字抄，供投递时对齐）**：

```
f6b8e06612f2b3dcb4c00949e9c9073a8011a56f6bcf6612d8fef56299179e3e  /workspace/schedules.json
c7e4a8883c7c6929333a1c30edcb10418cc8852ae3fa3d08fe853681689451a3  /workspace/owners.json
430f65468ef6a588c58504824ac17c1170cdc7ae09f7c56d3102212c65569855  /workspace/alerts.json
ee2b88c4099066c164bcb6cba5e765fe6ac08ee6ef4c1cc8f9d51aff52923348  /workspace/pipelines/lemeng.dim.branch.run.json
f735fee86b2daac945a25717a907b07d7e50fcfc0202c96f4b08a701f1ffb87f  /workspace/pipelines/lemeng.dim.item.run.json
63b6f17ad7a6c5290c748d209ef92f14d51207e270d7872dc89ab1087b7c574f  /workspace/pipelines/lemeng.retail.windows.run.json
```

> 📌 上列 3 个薄管线文件的 sha **与仓内 `deploy/data-plane.lock` 第 31/33/39 行逐字相同**
> ⇒ 64188 的薄壳**没有漂移**（是「同一份件、更早的状态」，不是「被手改过」）。
> `schedules.json` / `owners.json` / `alerts.json` 则与 lock 不同（lock 记的是仓内当前版）。

### 2.3 关键发现（本次实测新增，仓内文档**尚未记载**）

**F1 — 64188 完全没有凭据面（加密连接从未建过）。**
`connections/` 与 `.duckle/keys/` 都不存在。3120 侧两者都已在 **2026-09-28 12:04** 建好（实测）。

**F2 — 3120 的 kind=object 湖对象锚**在**生产上已是 `fresh`**（实测 `freshness.json`）：

```
minio://${ENV:ZOS_BUCKET}/lemeng/dim_branch/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date+8h}/all.parquet → fresh
minio://${ENV:ZOS_BUCKET}/lemeng/dim_item/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date+8h}/all.parquet  → fresh
```

⇒ `owners.json` ⑧⑨ 反复标注的未验项「**object 资产的时钟端到端没在生产验过**」**已被生产实测销账**（dim 两面）。
`⑩` 的 retail 湖对象锚**仍属未验**（3120 尚未投递 Wave B，卷内还是 CSV 锚 `retail-windows-run.csv → fresh`）。
此外实测 3120 两条薄壳 CSV 锚（`dim-branch-run.csv` / `dim-item-run.csv`）现为 **`unknown`**——
与 `⑨`「删 CSV 锚 + 挂湖对象锚一次做完」的设计一致（规则已删 ⇒ 资产回到「没声明」的 `unknown`，**预期读数**）。

**F3 — `BRANCH_NUMS` 在两个账套的 console 容器里都有，但仓内 `deploy/data-compose.yml` 与 `.env.example` 都没有它。**

| 容器 | `SYSTEM_BOOK` | `BRANCH_NUMS` |
|---|---|---|
| `lemeng-console-3120` | len=4（`3120`） | len=**970**，sha12 `004444a9b893` |
| `lemeng-console-64188` | len=5（`64188`） | len=**409**，sha12 `7a4824f36faa` |

- ⇒ 两者**不是同一份门店清单**（长度差 2.4 倍），**必须像 `LEMENG_TOKEN` 一样按键名分账套**。
- ⇒ 而 L0/L1 管线**逐字依赖** `${ENV:BRANCH_NUMS}`（如 `lemeng.dim.branch.l0.json` 的 g3 身份断言与
  `gv` 的 `regexp_full_match('${ENV:BRANCH_NUMS}', '\[[0-9]+([, ]+[0-9]+)*\]')`）——**取不到值即判红**（fail-closed）。
- ⇒ **风险**：仓内**没有这个键的事实源**，任何「按 compose 重建 console 服务」的动作都可能**丢掉它**，
  后果是 dim/retail 全批判红（响亮的，不是静默的，但仍是一次停摆）。
- ⇒ 64188 的实测读数：容器内 `BRANCH_NUMS` 已 `set`，且薄壳自证输出
  `IDENTITY_OK company_id=64188 visible=129 configured=129 (配置门店全部可见)` ⇒ **129 家门店，且全部可见**。

**F4 — Wave B/C 的投递尚未执行（3120 亦然）。**
3120 卷内 `pipelines/` 只有 5 个文件（**无任何 `.l1`**），`schedules.json` 里 `lemeng.retail.windows.run` 仍 `enabled:true`。
⇒ `DELIVERY.md` 是**待执行单**，不是「已执行记录」。

**F5 — 64188 的容量余量（逐窗实测，用于确认 L0/L1 现成阈值够不够）**

| 面 | L0/L1 的硬阈值（**算式逐字取自管线文件自身**） | 64188 实测 | 余量 |
|---|---|---|---|
| `dim.branch` | 真阈值 = 非哨兵页数 4 × page_size 200 = **800** 家（`lemeng.dim.branch.l0.json` 的 dv 节点 message 原句） | **129** 行 | 671 家 |
| `dim.item` | 「150 页是**硬编码**：商品数增长击穿 **149×200 = 29800** 条时由 guard 哨兵页判红」（`lemeng.dim.item.l0.json` `_note`） | **24,738** 行 | 5,062 条（17%） |
| `retail` 单窗 | 子管线 12 个 `src.rest`（末页哨兵）⇒ 11 × 200 = **2200** 行/窗 | 单窗最大 **544**（hour=20） | 1,656 行 |

> ⚠️ **不要由此反推 3120 的余量**（3120 的商品数不在本任务取证范围）。
> ⚠️ **`dim.item` 的余量只有 17%，是本计划里最窄的一条**——64188 商品数若增长逾 5,062 条会击穿哨兵页（判红，不丢数）。

**F6 — 64188 无 openship job 在跑零售。**
`gh`/MCP 实测：唯一的零售 runner job 是 `lemeng-retail-3120-runner`（`enabled: False`，cron `30 2 * * *`）；
**没有 64188 的同类 job**。⇒ 64188 的零售日批**已经**在 duckle console 上（`lemeng.retail.windows.run`，
cron `30 2 * * *`），本计划只换形态，不涉 job 退役。

### 2.4 64188 与 3120 的差异点（**逐条**，本节是迁移步骤的输入）

| # | 维度 | 3120 | 64188 | 对迁移的影响 |
|---|---|---|---|---|
| D1 | 令牌的 **project env 键名** | `LEMENG_TOKEN` | **`LEMENG_TOKEN_64188`** | 只是**项目 env 层**的键名不同；compose 里 64188 那行写的是 `LEMENG_TOKEN: ${LEMENG_TOKEN_64188:-}` ⇒ **容器内的键名两侧都是 `LEMENG_TOKEN`** |
| D2 | `connection-setup.py --token-env` 的取值 | `LEMENG_TOKEN` | **`LEMENG_TOKEN`（逐字相同）** | ⇒ **§3.1 的命令两侧逐字相同**，唯一区别是**在哪个容器里跑**（D6） |
| D3 | `SYSTEM_BOOK` | `3120` | `64188` | 管线文件里**全部**走 `${ENV:SYSTEM_BOOK}` ⇒ **L0/L1 管线文件账套无关、逐字复用**（无需任何 64188 特化文件） |
| D4 | `BRANCH_NUMS` | len=970 | len=409（129 家） | 见 F3：**必须按键名分账套**（仓内缺事实源，是收口项） |
| D5 | 门店数 / 商品数 / 单窗峰值 | 见 §F.6（不在此取证） | 129 / 24,738 / 544 | 见 F5：**现成阈值全部够用**，无 64188 特化改造 |
| D6 | console 服务的定位 | `svc_srQwfTvdkjxbCeoA`，端口 `127.0.0.1:18080` | `svc_u4pvEqZPfstnE5vI`，端口 **`127.0.0.1:18081`** | 每批投递前**按 §2.1 重新定位**（DELIVERY.md §0.1 已立此规矩） |
| D7 | 工作区卷 | `lemeng-console-3120-ws` | **`lemeng-console-64188-ws`**（**独立卷**） | 加密连接**每工作区各一份**（钥匙各一把）⇒ **必须各自跑一次 setup**（这是 D 节 bullet 1 的实质原因） |
| D8 | 卷内现状 | Wave 1+A 已切（L0 在跑） | **Wave A 之前**（3 薄壳 + 文件锚 + 5 条告警） | 64188 的首次 seed 是**跨三代**的（薄壳→L0/L1 + 文件锚→湖对象锚 + 5 条→9 条告警） |
| D9 | retail 是否已在本 console | 是（W2/#265 起） | 是（`lemeng.retail.windows.run`，cron `30 2 * * *`） | 同形，无额外约束 |
| D10 | tick / close 薄壳 | **仓内声明、生产不存在** | 仓内声明 `enabled:false`、**生产也不存在** | 64188 侧「退役 tick/close 薄壳」= **仓库记录清理**，无生产残留可删 |
| D11 | 是否有 openship 零售 job | 有（`lemeng-retail-3120-runner`，已 `enabled:False`，观察期后退役） | **无** | 64188 不涉 job 退役（F6） |
| D12 | 内层重管线 bind | 同一份 `../duckle:/pipelines:ro` | **同一份**（同一 compose） | ⇒ 退役 `duckle/common/lemeng.*.json` **必须两账套同时停用**才可删（§4.3） |

**结论（一句话）**：64188 的迁移**在管线件层面是零改造**（D3）；
真正的「64188 特有」只有三件——**独立工作区的凭据面（D1/D2/D6/D7）**、
**跨三代的首次 seed（D8）**、**`BRANCH_NUMS` 的仓内事实源缺失（D4/F3）**。

---

## 3. 64188 迁移步骤（同构复用 3120 的 Wave 1/A/B/C）

> **前置（缺一不做）**：
> 1. **Wave A 观察期满**（母计划：≥3 运行日）；
> 2. **Wave B/C 投递完成且观察期满**（`DELIVERY.md` §3 五点验收 + 观察期 ≥3 运行日）——**实测尚未执行（F4）**；
> 3. `owners.json` ⑩ 的 retail 湖对象锚**先在 3120 验过**（「先验再切」，见 F2）；
> 4. F3 的 `BRANCH_NUMS` 事实源补进仓（或书面确认它以别的方式被注入）——**待定夺，见 §7-U3**。
>
> **纪律**：本节的每一步**都要单独成批**（母计划：「不许跨波并行改生产」）；每批**只 seed 改动文件**。

### 3.0 定位（每批重做一次，别沿用上一批）

按 **§2.1** 的表定位服务/端口/卷；`CT=$(docker ps --format '{{.Names}}' | grep lemeng-console-64188)`。
判据：`docker exec "${CT}" hostname` 输出 `lemeng-console-64188`。

### 3.1 Step 1 —— 建 64188 的加密连接（**一次性 setup**，本迁移的第一件新事）

**为什么非做不可**：`connections/` 不存在（F1）。L0/L1 管线的凭据**一律 `connectionRef`**（母计划 Global Constraints：
「凭据一律 `connectionRef`（`lemeng` / `zos`），节点里零凭据值；**禁用** MCP `create_connection`（写明文）」）
⇒ 没有连接文件，L0/L1 **一行都跑不起来**（且是 **fail-open 静默**——见 `connection-setup` spec §3.3 case 2）。

**命令（逐字取自 `2026-09-28-duckle-connection-setup.md` §5.1–§5.2，两侧相同）**：

```sh
# ① 把脚本送进运行中的容器（不重建镜像）
docker cp scripts/duckle/connection-setup.py <container>:/opt/connection-setup.py

# ② 湖（S3 兼容：天翼云 ZOS）
docker exec <container> python3 /opt/connection-setup.py --workspace /workspace --id zos --profile zos-s3

# ③ 业务网关（REST bearer）
docker exec <container> python3 /opt/connection-setup.py --workspace /workspace --id lemeng \
    --profile rest-bearer --token-env LEMENG_TOKEN
```

- **`--token-env LEMENG_TOKEN`** 是对的（D1/D2）：容器内键名两侧都是 `LEMENG_TOKEN`。
- 先干跑：加 `--dry-run`（不建钥匙、不落盘）。
- **成功判据（逐字取自 spec §5.1 的真实样例）**：`self-check : clean（1 个敏感字段已封）` +
  `result     : wrote /workspace/connections/<id>.json`。
- **正交核对**（3120 是现成的参照物，实测形态）：

  | 文件 | 实测字段（值已封） |
  |---|---|
  | `connections/zos.json` | `kind: s3` / `endpoint` / `bucket: shanhai-data` / `region: xinan1` / `accessKey: enc:v2:…` / `secretKey: enc:v2:…` / `urlStyle: path` / `useSsl: "true"` |
  | `connections/lemeng.json` | `kind: rest` / `authType: bearer` / `authToken: enc:v2:…` |
  | `.duckle/keys/secret.key` | 32 字节、`-rw-------`（实测 3120 的形态） |

- **红线（spec §5.4）**：绝不回显凭据值；绝不覆盖已有钥匙；敏感字段不许 `literal:`；
  `.duckle/keys/` 必须与 `connections/` **分开管控**（备份/快照/镜像构建上下文一律排除钥匙目录）。
- ⚠️ **spec §6#1 的未验项沿用**：**脚本整支从未在容器内实跑过**（只验过它的密码学核）⇒
  **本步必须先在 64188 上 `--dry-run`，再真跑**，并保留输出（`self-check : clean` 是收口证据）。

### 3.2 Step 2 —— 落仓（改什么、不改什么）

| 改 | 内容 |
|---|---|
| **不改** 管线文件 | L0/L1 六个文件（`lemeng.dim.branch.l0` / `lemeng.dim.item.l0` / `lemeng.retail.windows.l1` / `lemeng.retail.tick.l1` / `lemeng.retail.close.l1` / `lemeng.retail_order_line.{window,tick}`）**逐字复用**（D3/D5：账套无关、阈值够用） |
| **改** `deploy/duckle/console/schedules/64188.json` | ① 三条薄壳 `enabled:false`；② 新增 `panel-lemeng.dim.branch.l0` / `-dim.item.l0` / `-retail.windows.l1`（**形态逐字照抄 `schedules/3120.json` 的对应条目**：`misfire` / `catchup` / `timezone` 三处别自创）；③ `panel-lemeng.retail.tick.l1` / `-close.l1` 以 `enabled:false` **声明就绪**（同 3120）；④ **删掉** `tick.run` / `close.run` 两条从未在生产存在过的薄壳声明（§4.2） |
| **不改** `owners.json` / `alerts.json` | 仓内已是**共用版**（seed 到两个 console，`alerts` ⑤）⇒ 64188 只需**首次 seed 同一份**（D8 的「跨三代」正是在这一步发生：卷内的旧版被一次替换成湖对象锚 + 9 条规则） |
| **必须重跑** lock | `deploy/duckle/console/` 在 `deploy/data-plane-manifest.txt` 里是**递归目录条目** ⇒ 改 `schedules/64188.json` 后：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`（否则 `check-data-plane-lock` 红） |

⚠️ **`schedules.json` 是「整文件覆盖」语义**（`DELIVERY.md` ③）：**任何进仓的条目都等于要生效的声明**
⇒ 64188 那两条 `tick.run`/`close.run` **在仓内就必须先消失或置停**，别指望 seed 时「跳过」。

### 3.3 Step 3 —— 投递（**逐字照 `DELIVERY.md` §1，只换 §0.2 的批次文件集与容器名**）

顺序**不可换**（`DELIVERY.md` §1 原话：**④ 重建 catalog 必须排在 ⑥ 首次 run 之前**）：

| 步 | 动作 | 判据 |
|---|---|---|
| ① | **push**（工件进 `origin/main`） | `git rev-parse origin/main` = 要投的 SHA |
| ② | **机器 sync**：`sh /opt/lemeng-sync.sh <全SHA>` | 末尾 `SYNC_OK <n>/<n>`，逐文件行全 `OK`；**全 SHA 从输出逐字复制，绝不手工补** |
| ③ | **只 seed 改动文件**（粒度 = **整文件**，范围 = **本批文件集**） | **唯一硬判据**：卷内 `sha256 == deploy/data-plane.lock` 里该路径那一行（「命令没报错」**不是**判据） |
| ④ | **重建 catalog**：`docker exec "${CT}" duckle catalog build --workspace /workspace`（或 Operator `POST /api/catalog`） | 三条全要：`catalog lint` **exit 0**；`catalog owners` 里**湖对象资产有 owner**（不是 `0 of N`）；build 的 stderr **没有** `… source/sink node(s) could not be named` |
| ⑤ | **重启 console**（openship MCP **服务级重启**） | 带凭据打 `/api/schedules`，**条目数 = `schedules/64188.json` 的条目数**（判据是**相等**，不是写死数字）；并核对**两条 tick/close 薄壳不存在或仍是 `false`** |
| ⑥ | **首次手动 run**（按 `DELIVERY.md` ⑥：body 的键是 **`file`**，值 = 工作区相对路径） | **看运行记录判触发**（最新一条的 `at` = **开始**时刻），**不是** `schedules.json` 的 `last_run_at`（那是**完成**时刻） |
| ⑦ | **五点验收**（`DELIVERY.md` §3） | 见 §3.4 |

📌 **64188 独有的 seed 注意**：**必须显式 `rm` 卷内那三条薄管线文件**吗？
**不一定**——调度置停后它们只是「在卷里躺着」。但 `alerts.json` 的 `lemeng.dim.*.run` 等规则**仍会匹配它们**
（手工触发即打进规则）。⇒ **要么删卷内文件、要么保留规则**，见 **§7-U2**（本计划不替人决定）。

### 3.4 Step 4 —— 切流前对照 / 切流 / 观察期

- **对照（切流前，不切流）**：64188 有**现成的对照臂**——薄壳的 24 窗产物已在卷内（实测 bizday `2026-09-28`
  的 24 窗逐窗行数：`0,0,0,0,0,0,0,3,49,134,118,221,249,220,224,230,303,435,393,470,544,520,234,1`，合计 **4,348** 行，
  末行 `WINDOWS_ALL_OK 24/24 windows`）⇒ **L1 首跑后逐窗逐列比**（排除 `batch_id`）。
  手法照 `wave1`/`waveB` 的既验做法：**先备份旧产物 → 跑新路径 → 逐列比 → 有差异即回写**。
- **切流**：`schedules/64188.json` 里 L0/L1 `enabled:true` + 三条薄壳 `enabled:false` → **同批** seed + 重启 + 重建 catalog。
- **观察期 ≥3 运行日**，判据 = `DELIVERY.md` §3 五点：
  1. run `ok`（⚠️ **`ok` 不等于求过值**）；
  2. 湖分区行数与 `batch_id`（日批兜底层：`count(DISTINCT batch_id) == 1` 且行数 > 0；tick 层：**快照等值**，不是去重计数）；
  3. **运行记录带 `assets`**（路径 **`/workspace/runs/<pipeline_id>.json`**，**数组**，保留最近 50 条；资产 id 与 catalog **逐字相同**）；
  4. `.duckle/freshness.json` 里**湖对象资产出现且 ≠ `unknown`**（`fresh` = 在写；`stale` 也是 seed 成功；**`unknown` 才是规则没挂**）；
  5. `data_alerts` 流里本批管线 id 的 **`event='failure'` 行数为 0** 且企微群无失败消息。
- **回滚**：照 `DELIVERY.md` §4（薄壳**没被删** ⇒ 两侧成对翻状态 + 恢复 `owners.json`/`alerts.json` 到投递前那份；
  ⚠️ **回滚必须成对**：同一窗不要并行两条路径）。

### 3.5 与 3120 的差异点（**逐条**，本节即 §2.4 的操作化）

1. **凭据面从零建**（D7/F1）：3120 的连接文件已在（`2026-09-28 12:04`）⇒ 只需**重建**；64188 **首次创建**，
   且**在同一台机、同一个 project 的两个服务上，各有一把钥匙**（`.duckle/keys/secret.key`）。
2. **令牌 env 的键名在项目层不同、在容器层相同**（D1/D2）：命令逐字相同，**不要**臆造 `--token-env LEMENG_TOKEN_64188`。
3. **`SYSTEM_BOOK` 不同但管线件零改造**（D3）：所有账套相关值都走 `${ENV:SYSTEM_BOOK}` / `${ENV:BRANCH_NUMS}`。
4. **门店清单不同（970 vs 409 字符）**（D4/F3）：这是**唯一必须分账套的「恒定值」**，且**仓内没有它的键**。
5. **首次 seed 跨三代**（D8）：3120 的演进是三次独立投递；64188 是**一次**把「L0/L1 件 + 湖对象锚 + 9 条告警」一起落。
6. **tick/close 薄壳对 64188 是「纯仓内记录」**（D10）：生产从来没出现过 ⇒ 退役没有卷内残留。
7. **无 openship 零售 job 可退役**（D11/F6）。
8. **`dim.item` 余量最窄（17%）**（F5）：64188 商品数 >29,800 即击穿哨兵；**这是 64188 比 3120 更值得盯的一条**（3120 未取证）。

---

## 4. 薄壳退役清单（逐项 + 「同批删」纪律 + 先例为何保留）

> **退役的触发条件**：**两个账套都切完 L0/L1 且观察期满**。任一侧还跑薄壳时，**共享件一个都不能删**（§4.3/§4.4）。
> **「同批删」纪律**（母计划 Global Constraints 原句）：「**切流同批**：`owners.json` 里被退役资产的规则要同批删
> （否则 36h 后永久 Stale）」；`alerts.json` ⑧ 的对应句：「**往本 console 加新管线必须同步在这里加它的
> failure/recovery 规则**，否则该管线失败静默」——**删与加都是同一个纪律的两面**。

### 4.1 薄管线文件（仓内 `deploy/duckle/console/pipelines/`，5 个）

| # | 文件 | 被谁取代 | 备注 |
|---|---|---|---|
| 1 | `lemeng.dim.branch.run.json` | `lemeng.dim.branch.l0.json` | Wave 1；3120 已切（`enabled:false`） |
| 2 | `lemeng.dim.item.run.json` | `lemeng.dim.item.l0.json` | Wave A |
| 3 | `lemeng.retail.windows.run.json` | `lemeng.retail.windows.l1.json` | Wave B |
| 4 | `lemeng.retail.tick.run.json` | `lemeng.retail.tick.l1.json` | Wave C；**从未在任何环境投递过** |
| 5 | `lemeng.retail.close.run.json` | `lemeng.retail.close.l1.json` | 同上 |

⚠️ **删仓内文件 ≠ 删卷内文件**：seed 是**复制**语义，**没有删除步骤**（`DELIVERY.md` §1③ 只讲怎么把文件**放进去**）。
⇒ 仓内删掉后，**卷内那份仍在**（实测 3120 卷内仍有 5 个文件）。要真删必须**显式 `docker exec … rm`**——
这是本节**唯一没有现成工具**的动作（见 **§7-U2**）。

### 4.2 调度条目（两个 `schedules/*.json`）

| 条目 | `3120.json`（仓内） | `64188.json`（仓内 / 卷内实测） | 退役动作 |
|---|---|---|---|
| `panel-lemeng.dim.branch.run` | `enabled:false` | `enabled:true` / **`true`** | 置停后**删除**（两账套都切完后） |
| `panel-lemeng.dim.item.run` | `enabled:false` | `enabled:true` / **`true`** | 同上 |
| `panel-lemeng.retail.windows.run` | `enabled:false` | `enabled:true` / **`true`** | 同上 |
| `panel-lemeng.retail.tick.run` | `enabled:false` | `enabled:false` / **生产不存在** | **仓内删除**（无卷内残留） |
| `panel-lemeng.retail.close.run` | `enabled:false` | `enabled:false` / **生产不存在** | 同上 |

### 4.3 内层重管线（仓内 `duckle/common/`，bind 到两个 console 的 `/pipelines:ro`）

| # | 文件 | 被谁取代 | **共享面**（为何必须两账套一起停） |
|---|---|---|---|
| 1 | `duckle/common/lemeng.branch.json` | `lemeng.dim.branch.l0` | **同一份 bind 同时挂进 3120 与 64188**（D12）⇒ 64188 仍在用它跑薄壳时删它 = 64188 立刻断链 |
| 2 | `duckle/common/lemeng.item.json` | `lemeng.dim.item.l0` | 同上 |
| 3 | `duckle/common/lemeng.retail_order_line.json` | `lemeng.retail_order_line.window` / `.tick` | 同上 |

⚠️ 删这三个文件会**同时**让 `run-retail-day.sh` 的 `dim` / `window(s)` / `tick` 形**立刻失效**（即便其调度已停，
**人工/诊断跑**也会断）⇒ 与 §4.5 的「分形态废弃」**必须同批决定**。
⚠️ 这三个文件在 `deploy/data-plane-manifest.txt` 的 `duckle/` 递归条目覆盖面内 ⇒ 删除后**必须重跑 lock**。

### 4.4 告警规则（`alerts.json`）与 owners 的 file 锚

**要删的 4 条规则**（判定基数是「**两个账套都不再有管线匹配它**」）：

| 规则 | 现在匹配谁 | 何时可删 |
|---|---|---|
| `lemeng.dim.*.run` | 3120（已停）/ 64188（**仍在跑**） | 64188 切完后 |
| `lemeng.retail.windows.run` | 3120（已停）/ 64188（**仍在跑**） | 同上 |
| `lemeng.retail.tick.run` | **两侧都无**（生产不存在） | 64188 切完（与上面同批，避免多批） |
| `lemeng.retail.close.run` | **两侧都无** | 同上 |

**要保留的 5 条**：`*`（stale/refreshed）· `lemeng.dim.*.l0` · `lemeng.retail.windows.l1` · `lemeng.retail.tick.l1` · `lemeng.retail.close.l1`。

> ### 🔴 「先例为何保留」——**逐字引用，不要重新论证**
> `alerts.json` ⑩ 原句：
> 「薄壳 `lemeng.retail.windows.run` 规则**保留**——「被退役资产同批删」在本批**不适用**：本文件
> seed 到两个 console（⑤），64188 侧薄壳 retail 调度仍 enabled（schedules/64188.json；Wave B
> 只切 3120）⇒ 现在删规则 = 64188 日批失败静默（⑧ 的「漏规则即静默」正是要避免的形状）。
> 先例：`lemeng.dim.*.run` 在 3120 侧薄壳已 disabled 后仍保留至今，同一个理由。待 64188 也切
> L1（独立决定，别顺手带）的那一批，再把薄壳规则连同 3120 侧残留一起删。」
>
> ⇒ **先例的结构**：`lemeng.dim.*.run` 在 **3120 薄壳已 disabled（2026-09-28）**后**仍保留至今**，
> 因为 `alerts.json` 是**双 console 共用件**，64188 侧薄壳还启用着。
> **这就是「观测面不能按单侧退役」的判据**：规则的生死由**两个账套的并集**决定，不由发起那一批的账套决定。

**owners 的 file 锚**：仓内 `owners.json` 已**没有** file 锚（Wave A/B 已换完，见 ⑧⑨⑩）；
64188 卷内那 3 条 file 锚**只存在于旧版文件里**，64188 首次 seed 时**随整文件替换消失**（同 ⑨ 的「观测面同批」口径）。
⇒ **不需要额外的删除动作**；但**必须**遵守 `DELIVERY.md` §4.2 的警告：**回滚时**若只回滚调度而不恢复 `owners.json`，
36h 后 64188 的 retail 新鲜度会报 `stale`（**锚的口径不对**，不是没在写）。

### 4.5 `run-retail-day.sh` 的分形态废弃边界

实测：该脚本 **67,879 字节**（`scripts/lemeng/run-retail-day.sh`），有 16 个 `case` 分支。**按形态分两类**：

| 类 | 分支 | 性质 | 退役判据 |
|---|---|---|---|
| **采集调用形**（可废弃） | `dim` · `window` · `windows` · `tick`（含 `tick close` 闭窗形） | 逐窗/快照**采集**的实际执行体 | 被 L0/L1 完全取代后废弃；**但删 `duckle/common/*.json`（§4.3）会先让它失效** ⇒ 两者必须**同批** |
| **只读诊断形**（**不废弃**） | `identity` · `probe` · `recon` · `listing` · `agg` · `branches` · `diag` · `rb` · `idem` · `idem3` · `drift` · `envfile` | 身份探针 / 对账 / 清单 / ETag / 幂等 / 漂移 | **保留**——正典 §1.1.7 原句：「**诊断 / 对账 / ETag 验收 / 身份探针工具** | **独立只读入口，永不进采集主链**（合并只增耦合）——这些验收的是引擎之外的世界（湖对象、网关），引擎无视角」 |

⚠️ **两个必须一起看的约束**：
1. `recon` **不**是「采集的附属」，它是 `DELIVERY.md` §3 判据 2 的**指定工具**（`sh /opt/lemeng-run.sh recon <H>`）⇒ 删它会**打断 L0/L1 的验收链**。
2. Wave C 的验签仍把 `run-retail-day.sh tick` 当**对照臂**（母计划 Wave C 第 3 条：「`run-retail-day.sh tick` 仍在，可作为对照臂」）
   ⇒ **`tick` 形的废弃时点必须晚于 Wave C 的对照完成**。

⇒ **边界建议（待定夺，见 §7-U3）**：**按「采集调用形」与「只读诊断形」两分**，
`recon`/`rb`/`listing`/`agg`/`branches`/`diag`/`idem*`/`drift`/`probe`/`envfile` 一律**留在脚本里**（哪怕脚本改名/瘦身）。
**本计划不替人决定**该边界落在哪一行代码。

### 4.6 退役批次的收口判据（**缺一不算过**）

1. `deploy/duckle/console/pipelines/` 只剩 L0/L1 六件 + 子管线两件；
2. 两个 `schedules/*.json` 无任何 `.run` 条目；
3. `alerts.json` 只剩 5 条（§4.4 保留清单）；
4. `owners.json` 无任何 file 锚；
5. 卷内**真的**没有薄管线文件（`docker exec … ls /workspace/pipelines`，**不是**看仓内）——**取决于 §7-U2 的裁决**；
6. `deploy/data-plane.lock` 重跑且 `check-data-plane-lock` / `check-duckle-catalog` 绿；
7. **`catalog owners` 覆盖率**：所有保留资产都有 owner（不是 `0 of N`），`lint` exit 0。

---

## 5. 文档收口清单 + 已知口径冲突

### 5.1 收口清单（逐条，含改哪儿/改什么/判据）

| # | 文件 / 位置 | 现状 | 收口动作 |
|---|---|---|---|
| 1 | `docs/data-platform-handbook.md` **§1.1.7** 波次表 | `Wave 0（进行中）` · `Wave 1 首航` · `Wave 2（L1 首验）` · `Wave 3 / 64188 跟进 + 试点收口`；L1 档状态写「**②实验室验证完毕（未上生产）**」 | Wave B/C 首飞后把 L1 档改 **①现行可用**；**补首个生产案例**（Wave 表加 64188 一行/一节）；**原文那句「（未上生产）」必须删掉**（否则与 §1.5 的排障口径自相矛盾） |
| 2 | 同上 **§1.5** 「跑了但失败」行 | 「该账套卷里 `logs/*.csv`（**薄管线的运行记录**，含 wrapper 完整 stdout）」 | 薄壳退役后**该路径不再被写** ⇒ 增补 **L0/L1 的排障入口**（回执 `runs/receipts/`，见 §5.2-② 的名词定义），并把旧行标为「**仅薄壳形态适用**」 |
| 3 | 同上 **§1.5** 「改定义后没生效」行 | 「检查**两步**是否都做了：re-seed 进 workspace 卷 + **重建容器**（§1.3.2）」 | 与 **§5.2-① 的冲突一并改**（卷内定义 ⇒ 重启足够；bind-mount ⇒ 定向重建） |
| 4 | 同上 **§1.5** 的「告警」段 | 只写 wrapper 的 `EXIT` trap（`LEMENG_NOTIFY=1` / `WECOM_WEBHOOK_URL` / `NOTIFY_SKIPPED`） | 薄壳退役后 wrapper 不再是告警面 ⇒ 增补**引擎原生 `alerts.json`**（经 OO 转投）为 L0/L1 的告警面；两条**并存关系**照 `alerts.json` ④ 写 |
| 5 | 同上 **§1.3.3**（薄 wrapper 的职责边界） | 已标「**过渡形态**」 | 收口时标 **已退役**（保留在册以便查历史），并把指向 `run-retail-day.sh` 的「逻辑在那个 shell 里」改成**指针 + 只在只读诊断形里找**（§4.5） |
| 6 | `deploy/data-plane-deploy-sop.md` **§F.4** | ①「跑了但失败」指向 `logs/dim-*-run.csv`；②「告警」段只写 wrapper 的 `EXIT` trap；③ 末行「已知未通项：`OPS_SINK=DISABLED reason=no_ingest_env`…（见 open issue #210）」 | ① 改为「**按形态分**：薄壳看 CSV、L0/L1 看 `runs/receipts/` 与 `runs/<pipeline_id>.json`」；② 增补 `alerts.json` 面；③ **实测 #210 的状态未在本次取证范围**（不得臆断已通/未通）⇒ 保留原句或另开一条核对 |
| 7 | 同上 **§F.2** 第 1 类 / 第 2 类 | 已正确分类（卷内 ⇒ 重启；bind ⇒ 定向重建） | **仅补一句指针**到 §5.2-① 的统一口径（SOP 是对的，不动正文） |
| 8 | `deploy/duckle/console/DELIVERY.md` | 已注明「本文件不覆盖排障口径…**其收口属 Wave D**」+ §1⑤ 记了两处措辞差异 | Wave D 收口后把 §1⑤ 的「**待 Wave D 收口统一**」**改成已统一的指针**；并把 §6 边界表里「**Wave D 收口**」「**排障口径**」两行的状态更新 |
| 9 | `deploy/duckle/console/README.md` **§L0 三问表** | 把「**引擎回执**（`runs/receipts/`）」称作「**运行记录 / 排障入口**」 | 按 §5.2-② 的名词定义**改名**（回执 ≠ 运行记录） |
| 10 | `docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md` **§9.9** | 「`catalog lint` 不在 CI 守卫里…建议作为独立 issue」 | **已过时**（**#337** 已由 `ci(guards): #337 catalog 观测面门禁进 CI` / **#341** 落地：`scripts/check-duckle-catalog.mjs`）⇒ 加一行**勘正指针**（报告可勘正，正典 §1.6 才是「只增不改」） |
| 11 | `.env.example` / `deploy/data-compose.yml` | **缺 `BRANCH_NUMS`**（F3） | **待定夺**（§7-U4）；若决定补，**同批**重跑 lock 并核对 B9 门禁的扫描面（正典 §1.2 已明写 `duckle/**` 的 env 键**不在 B9 扫描面内**） |
| 12 | `docs/data-platform-handbook.md` **§1.2** 第二档表 | 已列「`contracts/**` 与 `duckle/**` 的 env 键｜❌ **不在 B9 扫描面内**」 | **不动**（F3 正是这条的实例；收口时可在 §1.4 或案例库补一条 F3 的案例指针） |

### 5.2 已知口径冲突（**两处，逐条给证据**）

#### ① 「seed + 重启容器」 vs 「重新 seed + 重建容器」

| 出处 | 原文 |
|---|---|
| `handbook §1.3.2`（改调度定义后必须两步都做） | 「① 重新 **seed** 进该账套的 workspace 卷；② **重建 console 容器**——文件 bind-mount 钉的是 inode，原子替换后运行中的容器**仍看到旧文件**。（用 `serviceIds` **定向部署**；**别全量部署**——会重启 `pg_duckdb`。）」 |
| `SOP §F.2` 第 1 类 | 「**`schedules/` 或 `pipelines/` 的定义**｜**seed + 重启容器**｜定义 seed 进的是**命名卷** `/workspace`（`<project>-lemeng-console-<账套>-ws`）——**不是 bind-mount** ⇒ 卷内容·重启即重新读取。**不必定向部署。**」 |
| `SOP §F.2` 第 2 类 | bind-mount 进来的文件（仓内 `duckle/`、`/opt/lemeng-run.sh`）⇒ **定向重建容器** |
| `README §L0` 硬前置 1 | 「seed 管线 + seed `alerts.json` / `owners.json`（同路，进 `/workspace/`）+ **定向重建容器**」 |
| `DELIVERY.md §1⑤` | 「⚠️ **措辞差异（如实标注）**：handbook §1.3.2 把这个动作写成「重新 seed + **重建容器**」。本文件取 SOP §F.2 第 1 类（卷内定义 ⇒ 重启足够，且有实测背书）。两处措辞不一致已记入投递报告，**待 Wave D 收口统一**。」 |

**冲突的实质**：`§1.3.2` 把 `cases/` 的第 11 条（**bind-mount 钉 inode**）**当成卷内定义的规则**用了；
而卷内定义（`schedules/`、`pipelines/`、`alerts.json`、`owners.json`）**重启即重读**（SOP §F.2 第 1 类 +
2026-09-26 实测：seed + 只重启 ⇒ `/api/schedules` 即列出新条目）。

**建议口径（待协调者确认）**：**以 SOP §F.2 的分类为准**，`§1.3.2` 的「两步」段改成**按类分**：
> ① **卷内定义**（`schedules/` / `pipelines/` / `alerts.json` / `owners.json`）⇒ **seed + 重启容器**；
> ② **bind-mount 进来的文件**（仓内 `duckle/` → `/pipelines:ro`、`/opt/lemeng-run.sh`）⇒ **seed/同步 + 用 `serviceIds` 定向重建**。

理由三条：① SOP §F.2 有实测背书（2026-09-26）；② `README §L0` 与 `DELIVERY.md` 都与它一致；
③ `§1.3.2` 的「bind-mount 钉 inode」理由**只对第 2 类成立**，对卷内定义根本不适用（卷不是 bind）。
**副作用**：`README §L0` 硬前置 1 的「定向重建容器」也要按同一口径改成「重启」（它今天也没区分）。

#### ② 「运行记录（run record）」 vs 「回执（receipts）」的混用

| 出处 | 原文 | 是否与事实相符 |
|---|---|---|
| `DELIVERY.md §3 判据 3` | 「路径 = **`/workspace/runs/<pipeline_id>.json`**（**数组**，保留最近 50 条）」+「⚠️ **术语撞车（本仓踩过）**：`assets` 在**运行记录**（`runs/<pipeline_id>.json`，数组）里，**不在回执**（`runs/receipts/run-*.json`）里——**回执对任何管线都不带 `assets` 字段**。」 | ✅ 与实测一致（`runs/` 与 `runs/receipts/` 是**两个不同目录**） |
| `README §L0` 三问表 | 「**运行记录 / 排障入口** ｜ **引擎回执**（`runs/receipts/`）」 | ❌ 把**回执**叫成「运行记录」 |
| `#316` 正文 | 第 13 行「**运行记录**带写资产、id 与 catalog 逐字相同」／第 20 行「新**回执**带 assets」 | ❌ 同一属性（`assets`）被安在两个名词上；第 20 行错 |
| `README §L0` 三问表 | 「**几行** ｜ 同一份 receipt 的 `nodes.sink.rows`」 | ✅ 回执确实**逐节点**（`nodes.<id>.status/rows/durationMs`） |

**建议口径（待协调者确认）**：**定义两个词，各指一个文件，此后不再互换**：

| 词 | 文件 | 形状 / 上限 | 带 `assets`？ | 用途 |
|---|---|---|---|---|
| **运行记录**（run record） | `runs/<pipeline_id>.json` | **数组**，50 条/管线 | ✅ **带** | **新鲜度时钟**的输入（⑧②）+ 判「这次 run 写了哪些资产」 |
| **回执**（receipt） | `runs/receipts/run-*.json` | 200 条（正典 §1.6） | ❌ **不带** | **逐节点**排障（`nodes.sink.rows` / `status` / 每节点耗时） |

⇒ 收口动作：**改 `README §L0` 三问表的措辞**（把「运行记录 / 排障入口」改为「**回执**」），
并**勘正 `#316` 第 20 行**（`runs/<pipeline_id>.json` 才带 `assets`）。
**注意**：`#316` 是 **open issue** 的**正文**（不是已发布的正典条目）⇒ 勘正不受「只增不改」约束（该纪律只管 §1.6 案例库）。

### 5.3 冲突之外：本次实测**新出现**、仓内文档尚未记载的两条（建议进 WeKnora，见 §6）

- **F2**：object 湖对象锚在 3120 **生产实测 `fresh`** ⇒ `owners.json` ⑧⑨ 的未验项**已销账**；
  `⑩`（retail object 锚）仍待 Wave B 投递后验证。
- **F3**：`BRANCH_NUMS` 的**仓内事实源缺失**（两账套值不同，且 L0/L1 逐字依赖它）。

---

## 6. WeKnora 沉淀清单（**查重后**：更新哪条、新建哪条）

**查重手段**：`weknora` skill 的 hybrid-search（4 组查询：64188 迁移 / connectionRef 加密连接 / L0-L1 迁移与薄壳退役 / console 投递与 catalog 重建），
命中库 `研发运维经验库`（id `72dea466-2ae0-4a8c-8bbe-ae0019ce36c9`，109 条）。

### 6.1 命中（**更新，不新建**）

| 目标条目 | id | 为什么更新它 | 补什么 |
|---|---|---|---|
| 「duckle 管线原生化迁移：把 shell 包装层拆进管线（L0/L1 形态实战 + 全坑清单）」 | `1bb13931-26fb-4ee0-960e-3f4f7f2095db` | 它是本主题的**母条目**，当前只覆盖 **dim.branch / dim.item 两条已切流**（Wave 1/A） | ① Wave B/C 的**首飞**结论（foreach 首次上生产、子管线 checkpoint 开/关的语义差）；② **多账套复用**：管线件账套无关（`${ENV:SYSTEM_BOOK}`）、但**凭据面每工作区各一份**；③ 「退役 = 仓内删 + 卷内删 + 调度删 + 规则删」四件套；④ **薄壳规则不能按单侧退役**（先例 `lemeng.dim.*.run`） |
| 「duckle 运行记录与新鲜度的静默失效面：catalog 前置、sink 缺必需属性致节点无法命名、未解析占位符只警告、ok 不等于求过值」 | `0a336320-41a3-4bb2-bd09-ffa2c7f7add2` | 它的 §6 讲 `bucket` 缺失，但**收尾建议**（「catalog lint 不在 CI 守卫里」）已过时 | ① **#337/#341 已加守卫** `scripts/check-duckle-catalog.mjs`（PR 阶段即红）；② **kind=object 锚的生产实测**（3120 `fresh`）；③ **PII 无关但同类的一条**：`BRANCH_NUMS` 缺仓内事实源 ⇒ 环境值缺失**只体现在闸判红**，不在文件里 |
| 「duckle 生产落地与管线踩坑（乐檬补货案例）」 | `c9765bd6-8e32-449d-9d72-e06588ce40d4` | 其 §2.6/§2.7 讲自带调度的形状，缺**双账套 console 的差异面** | ① 「一账套一 console」的**操作化差异表**（env 键名映射 `LEMENG_TOKEN_64188` → 容器内 `LEMENG_TOKEN`）；② 卷内文件「重启即重读」vs bind-mount「必须定向重建」的分类口径（§5.2-①） |
| 「openship 数据面部署 SOP（两案例 21 坑）」 | `5972756e-0ec2-4ec6-a669-f1822cc89300` | 它覆盖「从零到验收」，缺**「已跑一段时间后接新账套」**这一步 | console 侧新增账套的**最小动作集**（connection-setup → seed → catalog → 重启 → 5 点验收） |

### 6.2 建议**新建**（查重无重复）

| 建议标题 | 内容（判据已在 §2/§5 落盘，此处只列骨架） | 标签建议 |
|---|---|---|
| 「多账套数据面迁移 checklist：凭据面 / 环境值 / 卷内现状三代差」 | ① **凭据面每工作区各一份**（钥匙 + connections），同名 id 不同密文是设计意图；② **env 键名的两层映射**（项目层带账套后缀 → 容器层同键名）；③ **环境值的仓内事实源审计**（本仓 `BRANCH_NUMS` 就是一例：容器里有、仓里没有）；④ **「卷内现状」必须实测**——「照抄姊妹账套的仓内件」是错的（64188 卷内停在 Wave A 之前） | `duckle` / `运维` |
| 「观测面退役的并集判据：共享 seed 件不能按单侧退役」 | ① `alerts.json`/`owners.json` **seed 到多个 console** ⇒ 规则的生死由**所有账套的并集**决定；② 先例 `lemeng.dim.*.run`（3120 已停仍保留）；③ 「删仓内文件 ≠ 删卷内文件」（seed 是复制语义，**没有删除步骤**） | `duckle` / `运维` |

**写前纪律**（`knowledge-capture` 规则 + `weknora` skill 注）：先 hybrid-search 查重；**命中则更新原条目、不新建**；
一篇文章 2–4 个标签；正文**别出现完整查询语句 / `${ENV:...}` 字面量 / 嵌套引号包整条 `su -c`**（WAF 501 已知触发形态）。

---

## 7. 待定夺的决定（**明列，本计划不替人决定**）

| # | 决定 | 选项 | 需要谁 / 依据 |
|---|---|---|---|
| **U1** | **64188 是否也上 `owners.json` / `alerts.json`？** | (a) 上（= 与 3120 同构，本计划 §3.2 的默认读法）；(b) 不上（64188 只要采集切换，不要观测面） | 拍板。**代价明写**：不上 (b) ⇒ 64188 的新鲜度与失败告警**全盲**（`owners.json` ⑦ 与 `alerts.json` ⑤ 今天都写着「64188 未 seed 本文件…**要不要切是独立决定**」）；且 `alerts.json` 是**同一个文件**seed 两个 console ⇒ 「只给 3120 上、不给 64188 上」**做得到**（seed 是每容器一次动作），但**文件内容公用**（规则一旦删，两侧同时删） |
| **U2** | **薄壳是「删文件」还是「仅置停」？** | (a) **仓内删文件 + 卷内 `docker exec rm` + 删调度条目**（彻底）；(b) **仓内删文件 + 保留卷内文件 + 删调度条目**（卷内留残骸）；(c) **仅置停**（`enabled:false`，最小动作，回滚位保留） | 拍板。**论据明写**：① 「**回滚位**」的理由随账套数**加倍**——母计划风险表原写「foreach 首飞出问题（Wave B/C）：独立波次、独立观察期；**薄壳不删（回滚位）**」；② 但**「卷内残留」会让告警规则继续匹配它们**（`alerts.json` ⑧ 的漏配代价是反过来的：规则在、管线不在 ⇒ 规则变**死规则**，而 `catalog lint` 只查 owners 的死规则、**不查 alerts**——⑨ 末句原话）；③ **本仓没有现成的「卷内删文件」工具**（`DELIVERY.md` §1③ 只有怎么放进去） |
| **U3** | **`run-retail-day.sh` 的分形态废弃边界落在哪？** | (a) 只废**采集调用形**（`dim`/`window`/`windows`/`tick`），保留**只读诊断形**（§4.5 的建议）；(b) 废更多（连 `recon`/`rb` 一起，改由新工具承担）；(c) 暂不废（脚本整体留着） | 拍板。**论据明写**：① 正典 §1.1.7 明令「诊断/对账工具**独立只读入口，永不进采集主链**」⇒ 它们**不随采集形态淘汰**；② `recon` 是 `DELIVERY.md` §3 判据 2 的**指定工具**；③ Wave C 把 `tick` 形当**对照臂**（母计划原文）⇒ **废弃时点必须晚于 Wave C 对照完成**；④ 删 `duckle/common/*.json`（§4.3）会**先**让采集形失效 ⇒ 两者**同批** |
| **U4** | **`BRANCH_NUMS`（F3）怎么补？** | (a) 补进 `deploy/data-compose.yml`，每服务一行（`BRANCH_NUMS: ${BRANCH_NUMS:-}` / `${BRANCH_NUMS_64188:-}`），并补 `.env.example`；(b) 不动 compose，书面记录它以服务级 env 注入（**但这条通路不在仓里**）；(c) 改成不用 env（不现实——L0/L1 已逐字依赖） | 拍板。**论据明写**：① 两账套值**不同**（len 970 vs 409）⇒ 必须**按键名分账套**；② 缺口会让任何「按 compose 重建 console」的动作**丢掉它** ⇒ dim/retail 全批判红（**响亮，但仍是停摆**）；③ B9 门禁**不扫** `duckle/**` 的 env 键（正典 §1.2 第二档原句）⇒ **没有门禁会替你发现**；④ 补 compose 需**同批重跑 lock**（`deploy/data-compose.yml` 在 manifest 里） |

---

## 8. 风险与回滚

| 风险 | 处置 |
|---|---|
| **凭据加载失败是静默的**（fail-open：`connection-setup` spec §3.3 case 2 实测复现） | 身份门会拦（凭据空 ⇒ 探针失败 ⇒ 红）；对照期**逐列比内容**，**不能只看退出码** |
| 忘记**重建 catalog** | `DELIVERY.md` §1④ 是硬步骤；验收判据 3 明确要看运行记录的 `assets`；**CI 已有守卫**（`check-duckle-catalog`，**#341**） |
| **64188 首次 seed 跨三代** ⇒ 一次投递同时改三件（管线件 + 湖对象锚 + 9 条规则） | 按 §3.4 先**对照不切流**；`DELIVERY.md` §4 的回滚位（投递前从卷里读三份留档，或 `git show <pre-331>:…`）**必须留** |
| `dim.item` 余量只有 **17%**（F5） | 64188 切流前把「商品数」列进对照期的观测项；击穿哨兵是**判红不丢数**（fail-loud） |
| **薄壳按单侧退役** ⇒ 另一账套静默失告警 | §4.4 的**并集判据**；先例 `lemeng.dim.*.run` 逐字引用 |
| **删仓内文件被误当「删卷内文件」** | §4.1 的 ⚠️；收口判据 §4.6 第 5 条要求**进容器看** |
| 回滚只回滚调度、不回滚观测面 | `DELIVERY.md` §4.2 原话：只回滚调度 ⇒ 36h 后零售新鲜度报 `Stale`（**锚的口径不对**，不是没在写） |
| `BRANCH_NUMS` 在服务重建时丢失 | §7-U4（**未决**）；这是本计划里**唯一没有仓内事实源**的运行参数 |
| **多波并行导致归因困难** | 母计划明令：**禁止跨波并行改生产**；64188 迁移**不得早于** Wave B/C 观察期满 |

**回滚位（本计划要求的）**：`schedules/64188.json`（投递前那份）、卷内 `alerts.json` / `owners.json` 的**投递前副本**、
以及 `git show <341 之前>:deploy/duckle/console/owners.json` 之类的仓内历史版本。

---

## 9. 明确不做（YAGNI）

- **不为 64188 新造管线文件**——L0/L1 六件账套无关（D3），造特化件 = 两个事实源。
- **不改任何 `src.rest` 分页配置**（母计划原句：「页数按各管线现状：branch 5 / item 150 / retail 12」）
  ——64188 的余量够（F5）。
- **不追上游缺口**（连败中止、`src.rest.maxRetries`——已决定不做）。
- **不动 Metabase / 物化层**；不碰 `#328`（历史回填，硬前置是先迁读侧）。
- **不在本 PR 里执行任何收口动作**（§5 只是清单）；**不在本 PR 里改 `deploy/duckle/console/` 下任何文件**
  （改了就得重跑 lock，且会让这批变成「工件批」而不是「规划批」）。

---

## 附 A：本次只读实测的命令与读数索引

| 取证点 | 手段 | 关键读数 |
|---|---|---|
| 项目 / 服务 / 端口 / 卷 | MCP `get_projects` → `get_projects_by_id_services`（`proj_AFbJvyb0onaX7LVr`） | `svc_u4pvEqZPfstnE5vI`；`127.0.0.1:18081:18081`；`lemeng-console-64188-ws` |
| 卷内清单 / 三份定义 / sha256 | MCP `post_projects_by_id_services_by_serviceId_exec`（容器内 `ls` / `cat` / `sha256sum`） | 3 管线；3 条调度；sha 见 §2.2 |
| freshness / catalog / connections | 同上（`cat .duckle/freshness.json` / `catalog.json`；`ls connections`） | 3 文件锚全 `fresh`；catalog 3 管线 3 file 资产 `unresolved: []`；**`connections/` 不存在** |
| 告警规则 / owners 锚（两侧） | 同上（容器内 `python3 -c` 读 JSON） | 64188：5 条规则 / 3 file 锚；3120：9 条规则 / 2 file(unknown) + 1 file(fresh) + 2 **object(fresh)** |
| 容器 env（**只打键名/长度/sha12，不回显值**） | 同上（`printenv` + `sha256sum`） | `BRANCH_NUMS` 3120 len=970 / 64188 len=409；`SYSTEM_BOOK` 3120=3120 / 64188=64188 |
| 64188 基线产物（对照臂） | 同上（`cat logs/*-run.csv`） | branch 129 行；item 24,738 行；retail 24/24 窗合计 4,348 行 |
| 项目 env 键清单（值掩码） | MCP `get_projects_by_id_env` | 见 `LEMENG_TOKEN` / `LEMENG_TOKEN_64188` / `ZOS_*` / `OO_*`；**无 `BRANCH_NUMS`** |
| openship job 全景 | MCP `get_jobs`（本地落盘 + 结构化筛选） | 唯一零售 runner = `lemeng-retail-3120-runner`（`enabled:False`）；**无 64188 同类 job** |
| 仓内对照 | `deploy/data-plane.lock` / `manifest.txt` / 管线文件节点统计 | 12 件 / 6 件（见 §2.2、§F5 算式出处） |

## 附 B：本文件**没有**做的事（诚实清单）

1. **零生产写入**：未 seed、未改卷内文件、未建连接、未重建容器、未重建 catalog、未激活任何调度。
2. **未执行** §3/§4 的任何一步（本文件是计划）。
3. **未验**：64188 的商品数/门店数之外的上游容量余量、Wave B/C 投递后的实际读数、
   `OPS_SINK=DISABLED reason=no_ingest_env`（#210）当前状态、`BRANCH_NUMS` 的实际注入通路（只证了「容器里有」）。
4. **未在 3120 上取证**的部分一律标注「不在此取证范围」，**没有**由 64188 读数反推 3120。
