# #683 第 2 步：sync-data-plane 加 prune/清点 — 设计

> 日期：2026-10-15 · issue：#683（第 2 步）· 状态：已评审（对话定案，姿态=「SOP 常规链路改用 --prune」）
>
> **订正 v2（2026-10-15，真机 `--check` 后）**：作用域由「整个 `${REPO}`」**收窄到 manifest
> 目录型条目的子树**——初版在真机上立刻被证伪（394 个多余件里只有 10 个是目标孤儿，另 384 个是
> 引导残留）。理由与证据见 ① 的订正块。用户裁决：收窄到目录型条目（不动根文件 / `deploy/dbt/`
> 等）。初版已随 PR #686 合并（`8da67715`）并部署，但**真机两步门未过、#683 未销账** ⇒ 本版为
> 收窄后的实施基线。

## 背景与问题

`scripts/lemeng/sync-data-plane.sh` 只拷贝 manifest/lock 条目、没有删除/清点步骤 ⇒ 仓内删除的
文件在数据面机检出里永生（#683 实证：`x01_branch_region.csv` 在 #651 已删，真机残留并被 dbt
每天当僵尸 seed 加载）。第 1 步（真机一次性清理）已完成；本设计治本：同步后比对「磁盘文件集
vs revision 应有集」，多出的即报/删。

**基准现成**：lock 的落地路径列就是「检出应有文件集」。lock 按 SHA 取、自校验（首行 =
其余部分 sha256），作为差集基准不需要任何新事实源。

## 目标 / 非目标

**目标**

1. 默认同步与 `--check` 末尾**报告**孤儿（`EXTRA` 行 + 计数摘要）——默认行为只增信息行，不删任何东西
2. `--prune` 显式删除**作用域内**孤儿（作用域定义见 ①）；SOP 常规链路（四步链第①步）改用 `--prune` ⇒ 每次投递自动清
3. 机器本地物、`${REPO}` 外文件、**作用域外文件**绝对不碰

**非目标**

- 不删空目录（dbt 按文件解析，空目录纯化妆品；有意留）
- 不给 `--check` 的退出码加 EXTRA 判定（见「输出契约」的理由）
- 不做 allowlist 配置面（写死脚本内 + 注释指回 manifest，YAGNI）
- 不动 `/opt` 侧的任何比对/清理（见「作用域」）

## 设计

### ① 判据与作用域

- **预期集**：主循环逐行**顺手收集** lock 落地路径（`${REPO}` 模板展开后的绝对路径），不二次
  解析 lock——主循环已经逐行在手。
- **枚举**：主循环与标记写完后，`find "$REPO" -type f` 全树枚举，路径剥掉 `$REPO/` 前缀成相对形。
- **作用域 = `${REPO}` 内、且落在 manifest「目录型条目」落地前缀下的路径**。两层收窄，各有其因：

  **(a) 只限 `${REPO}` 内**。`/opt` 不参与：`/opt` 是共享目录，「不该有什么」没有基准；
  且 `/opt/lemeng-sync.sh` 自己就不在 manifest（引导循环：在清单里就得先有它才能投它）——
  枚举它必把同步器自己判成孤儿。

  **(b) 只限 manifest 目录型条目的子树**（`PRUNE_ROOTS`，见下）。**订正（2026-10-15 真机实证）**：
  本设计初版把作用域定为「整个 `${REPO}`」，真机 `--check` 立刻证伪——它报 394 个 EXTRA，
  其中**只有 10 个**是本设计要治的孤儿，另 **384 个是「整仓引导残留」**：

  | 类别 | 数量 | 是什么 |
  |---|---|---|
  | 真孤儿 | 10 | `duckle/common/lemeng.{branch,item,retail_order_line}.json`、`deploy/duckle/console/{alerts,owners}.json`、`deploy/duckle/console/pipelines/lemeng.{dim.branch,dim.item,retail.close,retail.tick,retail.windows}.run.json` —— 旧名退役后在检出里永生 |
  | 整仓引导残留 | 384 | `modules/`170 `apps/`75 `docs/`45 `packages/`33 `scripts/`30 `deploy/`13 `.github/`4 `.githooks/`2 根文件 12 |

  残留的来源是**引导方式**，不是缺陷：数据面机的检出由 openship job（如 `mytech-data-plane-prep`）
  用**整仓 tarball** 解包而成（`rm -rf platform-core` + `curl … archive/<sha>.tar.gz` + `tar xzf`），
  再由本 sync 用 manifest 覆盖数据面子集。⇒ 检出按设计就是「整仓 tarball + manifest 覆盖」，
  「检出不等于 lock 集」是**常态**，不是漂移。全检出作用域的 prune 会把 384 个一起删——
  那是拿设计外文件赌命。

  收窄到目录型条目后：作用域内 = `duckle/**`、`dbt/**`、`contracts/**`、`deploy/duckle/console/**`
  ⇒ 10 个真孤儿全部命中（僵尸 seed 那类就在 `dbt/`），384 个残留与 `deploy/dbt/Dockerfile`
  一概不动。

  **消费者排查（收窄的依据，2026-10-15 真机实测）**：无容器 bind 检出（只有同名**命名卷**
  `platform-core-data_pgduckdata`）；全 48 个 openship job 无一从检出读件（两个 recurring 的
  「L1 词表物化」「维表发布」跑在 **server 容器自己的 `/app`**，那是 openship 的克隆）；
  所有 `/opt/lemeng-*.sh` 对检出的引用逐条落在 manifest/allowlist。唯一缺口
  `deploy/dbt/Dockerfile`（仓内有、`deploy/data-compose.yml:93` 拿它当 `build.dockerfile`、
  manifest 只登记了孪生件 `deploy/duckle/Dockerfile`）本就在作用域外 ⇒ 不被 prune 打到；
  缺口本身另开 issue 补。

- **`PRUNE_ROOTS`**（写死脚本内，与 allowlist 同惯例）：

  ```
  PRUNE_ROOTS='duckle/ dbt/ contracts/ deploy/duckle/console/'
  ```

  = manifest 中**源路径以 `/` 结尾**的条目的落地前缀（剥 `${REPO}/`）。
  **与 manifest 的一致性由 `scripts/check-prune-roots.mjs` 在 CI 机械比对**——两处漂移
  （manifest 加了新目录条目、表没跟）会让新树里的孤儿静默漏清，正是 #683 要治的病，所以不靠人记。

- **孤儿** = 在枚举里、**在作用域内**、不在预期集、不在 allowlist 的普通文件。
- **作用域外多余件（outside-scope）** = 在枚举里、**不在作用域内**、不在预期集、不在 allowlist
  的普通文件（= 真机那 384 个）。**只计数不删**，打一行 `# outside-scope M` 信息行——把
  「检出不等于 manifest 集」留在可见面上（它是体检指标：这个数突然跳说明有人往检出里塞了新东西），
  但不进 `# extra N`、不影响退出码。

### ② allowlist（机器本地物，写死脚本内）

| 相对 `${REPO}` 路径 | 为什么 |
|---|---|
| `.data-plane-revision` | 同步标记本体 |
| `deploy/.env` | 机器本地配置（manifest 注释列明） |
| `dbt/profiles.yml` | 机器本地（同上） |
| `dbt/.user.yml` | 机器本地（同上） |
| `dbt/target/*` | dbt 编译产物（每次运行重写） |
| `dbt/logs/*` | dbt 日志（每次运行重写） |

> **订正（2026-10-15，写计划时发现）**：本表曾有 `.data-plane-revision.tmp.*` 一行——错了。
> 脚本临时文件实际形态是 `..data-plane-revision.tmp.<pid>`（**双**首点：`_rev_tmp="$REPO/.$REVISION_REL.tmp.$$"`，
> 而 `REVISION_REL='.data-plane-revision'` 自带首点），单点 glob 永匹配不上，是一行死配置。
> 定案：allowlist 只留标记本体；两类崩溃残留（`..data-plane-revision.tmp.*`、`*.sync-tmp.*`）
> 本来就**不该**在检出里活着 ⇒ **不进 allowlist**（进了才是误伤）。
> 但清不清得掉取决于**落点**（① 收窄的连带后果）：目标件在作用域内（如 `duckle/`）⇒ 残留也
> 在作用域内、照清；而标记本体的临时件落在 `${REPO}` **根**（`_rev_tmp="$REPO/.$REVISION_REL.tmp.$$"`）
> ⇒ 根文件不在任何目录条目子树里 ⇒ **作用域外**，只进 `# outside-scope` 计数、不删。
> 这是**有意**的已知边界（见「风险」），不是漏项。

匹配用 POSIX sh `case` 前缀模式（脚本无数组依赖，与现有风格一致）。注释指回
`deploy/data-plane-manifest.txt` 头部的「机器本地物」清单——两处都在仓里，同 PR 可改。

### ③ 输出契约（现有字面量全部不动）

- **报告态**（默认同步与 `--check`）：每个孤儿一行 `EXTRA <绝对路径>`
- **`--prune` 态**：删掉的打 `PRUNED <绝对路径>`（不打 EXTRA）；删失败打
  `PRUNE_FAILED: <路径>` 并**非零退出**（fail loud，与现有 `FETCH_FAILED:` 等同族）
- **摘要行**：`# extra N` 三态都打（N = **作用域内** 清点/清理**后**的残余孤儿数；报告态 = 孤儿
  总数，prune 成功即 0）——位置在 `SYNC_OK`/`SYNC_DRIFT` 行之前
- **作用域外计数行**：`# outside-scope M`（M = 作用域外多余件数）三态都打，紧邻 `# extra N`
  ——纯信息行，不进 N、不影响退出码（口径见 ① 的收窄理由）
- **`--check` 退出码仍只看 DRIFT**：EXTRA 是信息行。`--check` 的原语义是「这套 lock 是否装齐」，
  EXTRA 不影响装齐；强制清理由链路里的 `--prune` 承担，不需要 `--check` 变红（变了会打断现有
  探活/审计调用方的退出码约定）
- **时点**：prune 在 revision 标记写完**之后**——「标记在 = 这套文件是全的」不变式不 prune 干扰；
  prune 失败时标记已写 ⇒ 这套是全的、只是没清干净，下次跑收敛（清理幂等、方向单一）
- 头注释的输出契约段落同步更新

### ④ 参数面

- 第二参数 ∈ {（空）, `--check`, `--prune`}；三者互斥，同传两个 = 用法错，exit 2
  （`--check` 只读原则 ⇒ 它与 `--prune` 天然不相容）
- `--prune` 隐含**完整同步**（先同步、后清点删除）——不是「只清点不取件」；只看报告用 `--check`

### ⑤ 上线三步（真机验证门）

1. **PR 合并**：脚本 + 测试 + SOP §E（常规链路命令改 `--prune`）+ 头注释契约。sync 脚本本身
   不在 manifest ⇒ 不触发 lock 重生成。
2. **真机核对门（过了才许 prune）**：手工更新 `/opt/lemeng-sync.sh`（SOP 已写明该件更新是手工）
   → 跑 `--check` 读 EXTRA 清单。收窄后预期 **`# extra 0`**（作用域内）+ `# outside-scope 384`
   （引导残留，只计数不删）；若作用域内冒出未知**合法**机器本地物 ⇒ 补 allowlist 发一版再来。
   这一步是「设计外文件」的唯一实证机会（例如 console 引擎若在检出树里写运行时文件）。
3. **`--prune` 首跑**：作用域内 EXTRA 清空（真机预期 `PRUNED` 10 行，与 ① 的表逐条对上）；
   验 `dbt Found seeds = 3` 与仓内一致（僵尸 seed 判据不再被骗）→ handbook 案例跟帖，#683 关闭。

## 测试（沿用 sync-data-plane.test.sh 的假 curl + 真 sha256 + tree_hash 骨架）

| 用例 | 断言 |
|---|---|
| L 默认报不删 | 检出有孤儿（作用域内）⇒ `EXTRA` 行 + `# extra 1`，**文件仍在** |
| M --prune | 作用域内孤儿删（`PRUNED` 行）；allowlist 件全存活；lock 件全存活；`SYNC_OK 4/4` |
| N --check 只读 | 有孤儿 ⇒ 报 EXTRA 但 tree_hash 不变、干净 lock 时退出码仍 0 |
| O 参数互斥 | `--check --prune` 同传 ⇒ exit 2，零 curl |
| P 作用域 | `${REPO}` 外（opt 旁放多余件）⇒ 不被动 |
| Q 子目录孤儿 | **作用域内**的嵌套目录孤儿可清；空父目录有意保留 |
| **R 作用域外多余件** | 作用域外（如 `modules/x.js`）⇒ **不打 EXTRA**、`# extra 0`、`# outside-scope 1`、退出码仍 0 |
| **S prune 不碰作用域外** | `--prune` 态：作用域内孤儿被删，作用域外件**存活**且只进 outside-scope 计数 |

## 风险

- **allowlist 漏项** ⇒ 合法机器本地物被 prune 掉。闸门 = 上线第 2 步真机 `--check` 核对，
  没过不 prune；且 prune 只删 `${REPO}` 内文件，破坏半径有界。
- **`PRUNE_ROOTS` 与 manifest 漂移** ⇒ 新增目录条目的树里孤儿静默漏清（正是 #683 要治的病）。
  闸门 = `scripts/check-prune-roots.mjs` CI 机械比对，不靠人记。
- **作用域外的孤儿不被清**（有意，已知边界），两类实例：① 某个**文件型**条目退役时，其旧件不在
  任何目录条目子树里；② 落在 `${REPO}` **根**的崩溃残留 `..data-plane-revision.tmp.*`（标记本体的
  临时件）。两类都只进 `# outside-scope` 计数、不删。真机 394 里没有 ① 的实例；② 由本脚本自己
  产生、窗口极窄（写标记与 `mv` 之间）且内容是几行文本，`# outside-scope` 跳变即是可见信号，
  需要时手工删，并在 manifest 头注记明。
- **与容器 bind 的并发**：prune 与运行中 job 竞态。与现状同构（sync 本来就 `mv -f` 原子替换
  正在 bind 的路径），不新增风险类别。
