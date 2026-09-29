# retail 子管线 sink 补 `bucket` + tick/close 薄壳声明置停（2026-09-29）

> Issue #334 · 依据 Wave C 报告 §6（`docs/superpowers/specs/2026-09-29-wavec-tick-close-l1.md`）——该节发现并给出全部实验证据，本批是其修复。
> 性质：**纯仓内声明态修复，零生产操作**（不 seed、不碰任何容器/调度/64188）。

## 改了什么（4 个文件 + 1 份报告）

| 文件 | 改动 |
|---|---|
| `deploy/duckle/console/pipelines/lemeng.retail_order_line.window.json` | sink 节点 `properties` 补 `"bucket": "${ENV:ZOS_BUCKET}"`（1 行，插在 `connectionRef` 与 `key` 之间） |
| `deploy/duckle/console/pipelines/lemeng.retail_order_line.tick.json` | 同上（1 行） |
| `deploy/duckle/console/schedules/3120.json` | `lemeng.retail.tick.run` / `lemeng.retail.close.run` 由 `enabled:true` → `false`（2 个布尔） |
| `deploy/data-plane.lock` | 重生成（恰 3 条 sha 变更 + 首行自校验） |

## 缺陷 1：`bucket` 缺失 ⇒ 新鲜度锚是死规则

`snk.minio` 的 schema 里 **`bucket` 是 `required: true`**（duckle MCP `get_component_schema` 复核）。
两条子管线的 sink 只有 `connectionRef` + `key` ⇒ **catalog 无法命名这两个 sink 节点** ⇒ `owners.json` 的 retail 资产规则匹配不到任何东西 ⇒ **零售 36h 陈旧不告警**。

**为什么写侧一直没暴露**：`connectionRef`（`zos`）里**带了 bucket**（`shanhai-data`），引擎合并连接字段后照常写入 ⇒ 采集一直正常；掉链子的只有「catalog 侧命名」这一层。这正是「声明即事实」的缺口：**能写 ≠ 能被观测面命名**。

### 实验证据（Wave C 报告 §6.1，逐字）

| 状态 | `catalog build` | `catalog lint` | `catalog owners` |
|---|---|---|---|
| 修前 | exit 0，`4 pipelines, 8 assets, 32 links` + stderr `2 source/sink node(s) could not be named` | **exit 1**：`asset rule 'minio://*/lemeng/retail_order_line/…' (data-eng) matches nothing in this workspace` | `0 of 8 assets have an owner` |
| 修后 | `4 pipelines, **9** assets, 34 links` | **exit 0**：`catalog lint: nothing to report.` | `1 of 9 assets have an owner.` |

**安全性（§6.3 F1 实测）**：加/删 sink 属性**不影响子管线 checkpoint**（指纹只覆盖 fetch/API 节点；同一场景跑三次 posorder 请求数 12 → **0** → **0**）⇒ 补 bucket 对 Wave B 已交付状态是**状态中性**的。

## 缺陷 2：投递陷阱——两条从未部署的薄壳是 `enabled: true`

实测对比（2026-09-29）：

| | repo `deploy/duckle/console/schedules/3120.json` | 生产 console `/workspace/schedules.json` |
|---|---|---|
| 条目数 | **10** | **5** |
| `lemeng.retail.tick.run` | **true** | **不存在** |
| `lemeng.retail.close.run` | **true** | **不存在** |
| `lemeng.retail.windows.run` | false（Wave B prep 置停） | true（待投递时停） |
| `lemeng.retail.windows.l1` | true | 不存在（待投递） |

投递铁律是 **seed 整个文件**（不是逐条目 patch）⇒ 按现状 seed 会把 `tick.run` / `close.run` 这两个**从未在生产运行过**的薄壳一并**激活**，而 Wave C 正是要用 L1 形态取代它们。⇒ 本批置停，与「从未投递的管线不应被一次 seed 激活」一致。

> 仍属**声明态**：`enabled:false` 只是让 seed 安全；两条薄壳是否要永久退役，属 Wave D 收口（删文件 + 删条目）。

## ⚠️ 诚实标注（沿用 Wave C §6.3，未因本次修复而消解）

asset id 里是 `${ENV:ZOS_BUCKET}` 这类**不展开的占位符模板串**（catalog 保留原样，`*` glob 吸收）。本次修复解决的是「**能否被命名**」，**没有证明「新鲜度探测能真的打到具体对象上**」。该验证只能在**投递批次**做：seed + **重建 catalog** + 成功跑一次 L1 后，`freshness.json` 里该资产必须**出现且非 unknown**（owners.json ⑤ 判据）。已列入投递清单。

## 本批的执行路径说明（透明披露）

本地仓的 `.git` 对**所有进程**都不可读（`Operation not permitted`，多 worktree 复现）⇒ Orca worker 无法启动（其 setup 需要 git），本批改用 **GitHub Git Data API** 建分支/提交。

因此 `deploy/data-plane.lock` **不是跑脚本生成的**，而是**按脚本算法复现**（`scripts/lemeng/data-plane-lock.mjs` 的 `buildLockText`）：

1. `rest = 逐行 "sha256 仓内路径 落地路径 模式"` 以 `\n` 连接 + 尾随 `\n`；首行 = `sha256-of-rest <sha256(rest)>`；
2. **文件集不变**（只改已在清单内的 3 个文件）⇒ 逐行沿用原 lock 的路径/落地/模式，仅替换 sha256；
3. **复现校验**：先用同算法对 main 原文重算，**首行与三文件 sha 全部与原 lock 逐字相符**；三份 JSON 的 `json.dumps(indent=2, ensure_ascii=False)` 往返**与原文件逐字节一致**（保证 diff 最小、无格式漂移）。

最终判据交给 CI 的 `check-data-plane-lock`（它会用真脚本重算并比对）——因为该守卫**不存在于本地复现路径**，这是本批唯一能独立验证 lock 正确性的机器判据。

## 验收

- 本地（复现路径）：lock 算法复现校验 OK；三文件 JSON 往返逐字节一致；diff 最小（2 行 + 2 布尔）。
- CI：`check-data-plane-lock` + 六条守卫 + typecheck + 全套 CI。
- 遗留（另立 issue）：CI 缺 `catalog lint` 守卫 ⇒ 这类「观测面命名失败」在 CI 里不可见。
