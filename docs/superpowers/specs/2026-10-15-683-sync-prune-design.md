# #683 第 2 步：sync-data-plane 加 prune/清点 — 设计

> 日期：2026-10-15 · issue：#683（第 2 步）· 状态：已评审（对话定案，姿态=「SOP 常规链路改用 --prune」）

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
2. `--prune` 显式删除 `${REPO}` 内孤儿；SOP 常规链路（四步链第①步）改用 `--prune` ⇒ 每次投递自动清
3. 机器本地物与 `${REPO}` 外文件绝对不碰

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
- **作用域 = 只限 `${REPO}` 内**。`/opt` 不参与：`/opt` 是共享目录，「不该有什么」没有基准；
  且 `/opt/lemeng-sync.sh` 自己就不在 manifest（引导循环：在清单里就得先有它才能投它）——
  枚举它必把同步器自己判成孤儿。
- **孤儿** = 在枚举里、不在预期集、不在 allowlist 的普通文件。

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
> 本来就**不该**在检出里活着 ⇒ 视作孤儿，报告/清理它们是更优行为，不是误伤。

匹配用 POSIX sh `case` 前缀模式（脚本无数组依赖，与现有风格一致）。注释指回
`deploy/data-plane-manifest.txt` 头部的「机器本地物」清单——两处都在仓里，同 PR 可改。

### ③ 输出契约（现有字面量全部不动）

- **报告态**（默认同步与 `--check`）：每个孤儿一行 `EXTRA <绝对路径>`
- **`--prune` 态**：删掉的打 `PRUNED <绝对路径>`（不打 EXTRA）；删失败打
  `PRUNE_FAILED: <路径>` 并**非零退出**（fail loud，与现有 `FETCH_FAILED:` 等同族）
- **摘要行**：`# extra N` 三态都打（N = 清点/清理**后**的残余孤儿数；报告态 = 孤儿总数，
  prune 成功即 0）——位置在 `SYNC_OK`/`SYNC_DRIFT` 行之前
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
   → 跑 `--check` 读 EXTRA 清单。预期 0 或暴露未知**合法**机器本地物 ⇒ 有则补 allowlist 发一版。
   这一步是「设计外文件」的唯一实证机会（例如 console 引擎若在检出树里写运行时文件）。
3. **`--prune` 首跑**：EXTRA 清空；验 `dbt Found seeds = 3` 与仓内一致（僵尸 seed 判据不再被骗）
   → handbook 案例跟帖，#683 关闭。

## 测试（沿用 sync-data-plane.test.sh 的假 curl + 真 sha256 + tree_hash 骨架）

| 用例 | 断言 |
|---|---|
| L 默认报不删 | 检出有孤儿 ⇒ `EXTRA` 行 + `# extra 1`，**文件仍在** |
| M --prune | 孤儿删（`PRUNED` 行）；allowlist 件全存活；lock 件全存活；`SYNC_OK 4/4` |
| N --check 只读 | 有孤儿 ⇒ 报 EXTRA 但 tree_hash 不变、干净 lock 时退出码仍 0 |
| O 参数互斥 | `--check --prune` 同传 ⇒ exit 2，零 curl |
| P 作用域 | `${REPO}` 外（opt 旁放多余件）⇒ 不被动 |
| Q 子目录孤儿 | 嵌套目录里的孤儿可清 |

## 风险

- **allowlist 漏项** ⇒ 合法机器本地物被 prune 掉。闸门 = 上线第 2 步真机 `--check` 核对，
  没过不 prune；且 prune 只删 `${REPO}` 内文件，破坏半径有界。
- **与容器 bind 的并发**：prune 与运行中 job 竞态。与现状同构（sync 本来就 `mv -f` 原子替换
  正在 bind 的路径），不新增风险类别。
