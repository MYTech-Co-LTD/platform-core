# 全量管线改造计划：五条管线全部迁到 L0/L1（用户 2026-09-28 指令）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 executing-plans。

**Goal:** 把乐檬全部采集管线迁到正典 §1.1.7 的**统一形态**（L0 单管线 / L1 foreach 两层），**彻底退役 shell 包装层**。

**Architecture:** 已有一条成功先例（`dim.branch` → L0，已切流并在生产稳定）；本计划按**同构复用 + 波次隔离**推进，不一次全上。

**Tech Stack:** duckle 0.7.4 + `connectionRef`（凭据）+ 引擎内建（`${date+8h}`/`${datetime}`）+ 已验的 gv/dv 期望值形状闸。

## 依据（全部已入仓）

| 材料 | 用途 |
|---|---|
| `docs/superpowers/plans/2026-09-28-wave1-branch-l0.md` | **模板**：branch 的 L0 迁移全过程 |
| `docs/superpowers/specs/2026-09-28-duckle-l0-identity-gate-d2.md` | 身份门 7 节点写法 + 四条护栏 |
| `docs/superpowers/specs/2026-09-28-duckle-child-value-paths.md` | `connectionRef` 五子路径 + 零明文边界 |
| `docs/superpowers/specs/2026-09-28-duckle-l1-wave1-prep.md` | L1 骨架、分页复核、sink 语义、方言坑 |
| `docs/superpowers/specs/2026-09-28-duckle-connection-setup.md` | 加密连接 setup（各 console 各跑一次） |
| issue #316 评论 | **catalog 重建是硬前置**（否则 run record 无 assets ⇒ 新鲜度永久 Stale） |

## 改造地图

| 管线 | 现状 | 目标 | 关键差异 |
|---|---|---|---|
| `lemeng.dim.branch` | 薄壳三层 | ✅ **L0 已切流** | —— |
| `lemeng.dim.item` | 薄壳三层 | **L0** | 同构；**150 个 `src.rest` 页节点**（非 5） |
| `lemeng.retail.windows` | 薄壳三层 | **L1**（foreach 24 窗） | **foreach 首次生产使用**；子管线 checkpoint 开 |
| `lemeng.retail.tick` | 仓内有定义、**从未投递** | **L1（tick 形）** | 窗口表 = `[cur, prev]`（setvar 推导）；**子管线 checkpoint 必须关**（累积窗会冻结首快照） |
| `lemeng.retail.close` | 同上 | **L1（tick 形）** | 仅 prev 窗（闭窗尾款） |

> ⚠️ **tick/close 从未上生产**（Task 6 一直等 W2 收口）⇒ **直接以 L1 首飞，省掉一整次迁移**。
> 代价说明：首次运行即新形态、无旧形态基线——但**旧形态也从未运行过**，两边都没有基线 ⇒ 净省一次迁移，不是风险增加。

## Global Constraints（逐字值，勿改写；全部来自 branch 的实测结论）

- **凭据**一律 `connectionRef`（`lemeng` / `zos`），节点里**零凭据值**；**禁用** MCP `create_connection`（写明文）
- **每次 run 变化的值**用引擎内建：`SNAPSHOT = ${date+8h}`（上海日）；`BATCH_ID` 由 `${datetime}` 重格式化，**形状与被替代的 wrapper 逐字节一致**
- **每部署恒定值**（`SYSTEM_BOOK` / `BRANCH_NUMS`）保持 `${ENV:}`
- **每次切流后必须重建 catalog**（`POST /api/catalog`），否则 run record 无 `assets` ⇒ 新鲜度永久 Stale
- **sink 写法**：一对象覆盖、分区写进 key、**不开 `partitionBy`**（云 sink 静默忽略，同 run 两 sink 同 key 静默丢数）
- **密钥红线**：绝不进 URL/query（失败写进 logs/runs 三处）；绝不进返回行
- **子文档里绝不写 `${ENV:...}`**（顶层之外无人解析）——L1 适用；L0 是顶层文档故合法
- **期望值形状闸 gv/dv 一条不许少**（只算常量不读 input；置 `d1` 之后、触发边之前）
- **投递**：管线/调度变更必须先 push → 机器 sync（按全 SHA）→ **只 seed 改动的文件**（整目录 seed 会把未投递的东西灌进 live console）→ 重建 catalog → 重启 console
- **切流同批**：`owners.json` 里被退役资产的规则要同批删（否则 36h 后永久 Stale）

## 波次（**不许跨波并行改生产**）

### Wave A —— `dim.item` → L0（现在可做，与 branch 观察期无冲突）

1. 按 branch 模板写 `lemeng.dim.item.l0.json`（身份门 7 节点 + **150 页** + merge + guard + shape + gate + sink）
2. 观测面同批：`alerts.json` 加该管线规则、`owners.json` 锚改指其湖对象、**删旧 CSV 规则**
3. 投递 → 重建 catalog → **手动触发对照**（与当日老路径产物逐行逐列比，排除 `batch_id`）≥3 次
4. 切流（L0 起、薄壳停）→ 观察 ≥3 运行日

### Wave B —— `retail.windows` → L1（**foreach 首次上生产**）

前置：Wave A 收口（避免多线同时出问题）+ branch 观察期满。
1. 按 L1 骨架（wave1-prep §8 形态）写父管线（窗口表 + foreach + 汇总判红）+ 子管线（现重管线加 checkpoint）
2. **并行对照**要特别小心：两条路径写**同一个湖分区** ⇒ 用「先备份旧产物 → 跑 L1 → 逐列比 → 有差异即回写」的方式（branch 已验证此手法）
3. 切流 + 观察 ≥3 运行日

### Wave C —— `tick` / `close` → L1（tick 形）**直接首飞**

1. 窗口表 = setvar 推导 `[cur, prev]` / 仅 prev（wave1-prep 已原型化）
2. 子管线 **checkpoint=false**（硬约束）
3. 因是首飞，验证只能靠**并行对照**（与手动跑的 shell 形态比一次）——`run-retail-day.sh tick` 仍在，可作为对照臂
4. 投递 + 重建 catalog + 启用调度 + 观察一个完整营业日（192 tick）

### Wave D —— 64188 跟进 + 全量收口

1. 64188 的同类迁移（各 console 需各自跑一次 `connection-setup.py` 建本地加密连接）
2. 退役全部薄壳：删薄管线文件 + 调度条目 + 死告警规则；`run-retail-day.sh` 整体标废弃（**分形态**：dim 分支先废、retail 分支随 Wave B/C）
3. 文档收口：handbook §1.5 / SOP §F.4 的排障口径、§1.1.7 Wave 表 + L0/L1 档补生产案例
4. WeKnora 沉淀（查重后更新）

> **展开稿（本节的执行计划）**：[`2026-09-29-waveD-64188-retirement-closeout.md`](2026-09-29-waveD-64188-retirement-closeout.md)（issue **#343**，`Refs #318 #330 #332 #334`）——
> 64188 现状**只读实测** + 迁移步骤（含与 3120 的**逐条差异**）+ 薄壳退役清单（含「同批删」纪律与先例）
> + 文档收口清单（含两处**已知口径冲突**）+ WeKnora 沉淀清单 + **4 条待定夺的决定**。
> 一个实测前提需在此记明：**64188 的卷内状态比 3120 落后三代**（无 `connections/`、`owners.json`/`alerts.json` 停在 Wave A 之前），
> 且 **Wave B/C 的投递（`DELIVERY.md`）尚未执行** ⇒ Wave D 不得抢跑。

## 风险与回滚

| 风险 | 处置 |
|---|---|
| L0/L1 产物与老路径有差异 | 对照期**不切流**；备份在手可回写 |
| 连接加载失败**静默**（fail-open） | 身份门会拦（凭据空 ⇒ 探针失败 ⇒ 红）；对照期逐列比内容，**不能只看退出码** |
| 忘记重建 catalog | 切流清单里作为**硬步骤**，且验收① 明确要看 run record 的 `assets` |
| foreach 首飞出问题（Wave B/C） | 独立波次、独立观察期；薄壳不删（回滚位） |
| 多波并行导致归因困难 | **本计划明令禁止跨波并行改生产** |

## 明确不做（YAGNI）

- 不改 `src.rest` 分页配置（页数按各管线现状：branch 5 / item 150 / retail 12）
- 不追上游缺口（连败中止、`src.rest.maxRetries`——已决定不做）
- 不动 Metabase/物化层
