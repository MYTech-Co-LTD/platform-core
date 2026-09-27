# duckle-first 采集流程 P1 实施计划（正典改写 + 资产面 + W1 观测面）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「duckle first」判据与资产面口径写进采集正典，并让采集的观测面从「自建且从未接通」换成「引擎原生可读」。

**Architecture:** 三段推进。**Wave 1** 是纯仓内文档改写（三个任务**串行**——同一个文件）；**Wave 2** 是两项最小验证（真机，**按账套隔离可并行**）；**Wave 3** 是 W1 观测面（真机，**串行**——同一 console 资源）。文档改写**先于**真机工作：它定的是后面所有判断的口径。

**Tech Stack:** Markdown 正典（`docs/data-platform-handbook.md`）· duckle v0.7.3（`duckle-runner serve`）· openship MCP（唯一的运维通道）

**上位依据：** `docs/superpowers/specs/2026-09-27-duckle-first-collection-flow-design.md`（本计划的 spec；本节引用的 §N 均指该文件）· 源码级分析件 `~/Documents/mytechcode/source-analysis/ANALYSIS-duckle-capabilities.md`（**不在本仓**）

## Global Constraints

- **唯一通道**：一切运维操作（部署/重启/改配置/看日志/执行命令）**经 openship MCP**。**禁止裸 SSH**。
- **敏感值**：只写「**在哪、怎么取**」，**不写明文**（密钥在服务器 env / OpenShip env(isSecret) / GitHub Secrets / `/etc/openship/ssh-keys/`）。
- **一个 pipeline 只在一侧跑**：桌面**手动 Run 不取跨进程运行锁**，与服务器调度跑可并发 ⇒ 同时写同一 sink、推进同一水位。
- **duckle 机密一律 `${ENV:...}`**（**管线侧**）。⚠️ **ext 组件侧相反**：只传**引用名**，组件自己读 `std::env`。
- **正典只给指针、不枚举**：`duckle/README.md` §7.4 未验清单**不许抄进正典**（它已经在漂——同节写「四项」，§7.4 实列「五项」）。
- **未验项不许升级为既定**：源码级确认 ≠ 本环境验过。只有**本环境实测**才能把它从「未验」升为「首选」。
- **CHANGELOG 禁止手写**（由 `release.mjs` 生成）；**feat/fix 必须先有 issue**；**可见变更必须走 PR**（squash）。
- **同一波内「并行」的任务不得改同一文件**（**串行**任务不受此限——本文三个波次**全是串行**，故 Wave 1 三个任务同改 `handbook` 是允许的）；**波末**收齐产出 → 跑**全量**验证（该仓 CI 跑的全部命令）→ 再进下一波。
- **🔴 改了 `duckle/**` 或 `deploy/duckle/**` ⇒ 必须重跑 lock**：
  `pnpm exec tsx scripts/lemeng/data-plane-lock.mjs`，并把 `deploy/data-plane.lock` 一起提交。
  这两条路径**都在 `deploy/data-plane-manifest.txt` 的覆盖范围内**（仓根 `duckle/` 整目录、`deploy/duckle/console/` 整目录）
  ⇒ 漏这步 = **`gates` 红**。（本仓已因此返工过两次。）
- **本仓 gates 的真实命令**（**不存在 `pnpm run gates`**）：`pnpm typecheck` + `pnpm exec tsx scripts/check-manifests.mjs`
  + `scripts/lint-architecture.mjs` + `scripts/check-compose.mjs` + `scripts/check-env-example.mjs`
  + `scripts/check-data-models.mjs` + `scripts/check-data-plane-lock.mjs`（`check-tenant-isolation.mjs` 要 `DATABASE_URL`）。
- **不许伪造产出**：真机没跑过的，写「未验」，**不写「已验」**；MCP 调用失败就停，不改成猜测。

---

## 文件结构

| 文件 | 动作 | 负责什么 |
|---|---|---|
| `docs/data-platform-handbook.md` | 修改 | 正典正文：§1.1 加判据 · §1.1.4 补定语 · §1.1.6 扩写资产面 · §1.3 三段式 · §1.3.2 升格 · §7 待沉淀 |
| `duckle/README.md`（**仓根**） | 修改 | §7.4 未验清单**补条目 + 销账**（Wave 2/3 的验证结论写回这里） |
| `deploy/duckle/console/alerts.json` | 创建 | W1：告警规则（事件/冷却/恢复/receiver）——**与 `schedules/` 同目录**，随 seed 进 workspace 卷 |
| `deploy/duckle/console/owners.json` | 创建 | W1：`maximumAge`（SLA 新鲜度巡检的阈值来源） |
| `deploy/data-plane.lock` | **改（生成物）** | **凡改 `duckle/**` 或 `deploy/duckle/**` 都必须重跑它**——漏了就 `gates` 红 |

⚠️ **`deploy/duckle/README.md` §6 是另一份清单**（镜像/构建面），**本计划不动它**。

---

## Wave 1：正典改写（仓内，**串行**——三个任务都改 `docs/data-platform-handbook.md`）

> 波内硬约束：**不得改同一文件** ⇒ 这三个任务**只能串行**（内容上它们也互相引用：§1.3 的三段式要引 §1.1 的判据）。
> 波末：Task 3 Step 7 那组命令（`pnpm typecheck` + 六个 `check-*.mjs` + `test:guard`）+ 本波三条 grep 验收全绿。

### Task 1: 判据与三段式 A→I

**Files:**
- Modify: `docs/data-platform-handbook.md`（四处：§1.1 表后、§1.1.4 末、§1.3 表、§1.3.2 全节）
- Test: 三条 grep 断言（本任务的 Step 1 写、Step 4 跑）

**Interfaces:**
- Consumes: 无（本任务是本波的第一环）
- Produces: 正典里的**判据三档**称谓「①引擎有 ⇒ 首选 / ②引擎有但未验 ⇒ 先挂 gate / ③结构性没有 ⇒ 归我方」——Task 2 与 Task 3 引用它

- [ ] **Step 1: 先写验收断言（此时必然失败）**

```bash
cd "$(git rev-parse --show-toplevel)"
H=docs/data-platform-handbook.md
# 断言 1：判据三档存在
grep -q '引擎有但未验 ⇒ 先挂 gate' "$H" && echo "A1 OK" || echo "A1 FAIL"
# 断言 2：A→I 表带分档标记的段数 ≥8（改动前 = 0 次 ⇒ 不空转）
# ⚠️ 阈值经裁决 9→8：B 段是**选型决策**不是引擎能力，它的 ① 属定义域错配（评审 M6）⇒ 去掉后
#    「9 段各一标记」不再是正确的不变量。带分档的是 A③/C①/D①/E①/F②/G②/H②/I② = 8。
test "$(grep -c '①首选\|②首选（未验）\|③归我方' "$H")" -ge 8 && echo "A2 OK" || echo "A2 FAIL"
# 断言 3：三条「坑」已升格（旧措辞「三个实测坑」应消失）
grep -q '三个实测坑' "$H" && echo "A3 FAIL（旧措辞还在）" || echo "A3 OK"
# 断言 4：B 段分档格必须显式写「决策纪律」——不许留空、不许再写 ①（替代被去掉的计数直觉）
grep -q '决策纪律，见 §1.1' "$H" && echo "A4 OK" || echo "A4 FAIL"
```

Expected: `A1 FAIL` / `A2 FAIL` / `A3 FAIL（旧措辞还在）` / `A4 FAIL`

- [ ] **Step 2: 在 §1.1 的表后插入判据（宪法级）**

锚点：§1.1 的表格行 `| 验收 | 四层 | §1.4 |` 之后、`#### 1.1.1 通道选型` 之前，插入：

```markdown
> **判据：duckle first（每接一个能力先问这个）**
> 答案必须落在**三档之一，不许含糊**：
>
> | 档 | 判据 | 写法要求 |
> |---|---|---|
> | **①引擎有 ⇒ 首选** | 源码级确认存在，**且在本环境跑通过** | 写成「首选」，注明**怎么声明**与**哪次实测**定的案 |
> | **②引擎有但未验 ⇒ 先挂 gate** | 源码级确认存在，**本环境没跑过** | 写成「首选（**未验**）」，**同段给出最小验证动作**；验过才升 ① |
> | **③结构性没有 ⇒ 归我方** | 不是「不会用」，是**引擎结构里无处安放** | 必须给**结构性理由**（引源码或上游自述）——「嫌麻烦」不算 |
>
> **两条不放松**：**禁止把 ② 写成 ①**；**禁止把 ③ 写成 ②**（挂个 gate 拖着 = 永远不做）。
> **依据强度**：能力判断的出处**优先级 = 源码 > `capabilities --markdown` 产物 > 上游文档**
> （上游文档漂过：出现过不存在的组件 id）。出处与逐条论证见外部分析件（**不在本仓**）。
```

- [ ] **Step 3: 在 §1.1.4 的「一账套一个 console」一条上补「结构性」定语**

把该条**整行**替换为（其余不动）：

```markdown
- **一账套一个 console（结构性约束，不是选择）**：`Schedule` 结构体与控制台写入路径**都没有**
  env / 凭据 / 参数 字段（上游作者自己标注为未来项）⇒ 调度条目带不了自己的 env
  （实测塞 `env`/`args`/`params` 被**静默丢弃**）⇒ 共用必然有账套拿到错 token，**且静默采错数据**。
```

- [ ] **Step 4: 把 §1.3 的 A→I 表改成三段式**

把 §1.3 从表头 `| 阶段 | 动作 | 验收 | 回退 |` 起的**整张表**（9 行）替换为下面这张。
**保留原有的验收/回退语义**，只**增加**两栏——**但表结构经裁决改为五栏**（见下）：

> **⚠️ 裁决（2026-09-27，用户）**：① 表结构 = **五栏**（`阶段 | duckle 原生首选（分档） | 我方保留 / 兜底 | 验收锚 | 回退`）；
> ② **总则「不许丢」**：**原表出现过的文字，都必须在新的表里有落点**（原「动作」栏重分配进前两栏，加表下映射注）；
> ③ 执行时正是这条总则抓出了我这份草稿的两处自相矛盾（先丢 6 处回退 + 4 处验收短语，再丢整个「动作」栏）。
> ⇒ **下面这块是裁决后的定稿，照它写**：

```markdown
| 阶段 | duckle 原生首选（分档） | 我方保留 / 兜底 | 验收锚 | 回退 |
|---|---|---|---|---|
| **A 摸清源**（不写码） | — **③归我方**（引擎没有「**网关/接口语义探针**」这件事） | **A 阶段交付物**（字段清单（**每列的正确类型有人签字**）；主体维度有几个；**自然键（行粒度，含 `snapshot`）**；增量字段；抽样看**真实值**）；探针四条**全保留**（§1.3.1）；**新增**：产物**同时喂引擎**（字段/类型/键 → 节点的 `data.schema` 声明） | 能写出幂等采集策略；能说出分页风格、跨度上限、**有无 count**、时间过滤是否**真生效**；引擎侧声明与探针结论**一致** | — |
| **B 选型定案** | **①首选（新增一行）**：**组件选型**也是决策——分页策略 / 增量形态 / 校验组件 / 编排形态 | 按 §1.1 逐项定案，**命中例外须写证据**；例外红线（不变）；**新增**：还须写「引擎为什么不行」 | 产出**决策记录**并登记进 §1.7，**含组件选型一栏**；**不留在对话里** | — |
| **C 契约** | **①首选**：机器面在引擎（`data.schema` + `qa.contract` + `drift`）| **人写的意图源** `contracts/`（写 `contracts/<域>/<源>.<表>.json`；契约=意图，引擎声明=实现）；⚠️ `drift` 源未声明 schema 时**静默 exit 0** ⇒ **先断言声明存在** | 元 schema 校验过（§1.2 第二档：手动跑）；与 `layout.prefix` 一致；`drift` **有效**（不是 exit 0） | 改契约（改前先想清楚 `contractVersion`） |
| **D 管线** | **①首选**：`src.rest` **5 种分页** + `incrementalField`/`{incremental}` + `xf.incremental`/`xf.tumble` + `qa.*` | duckle 管线，**由真引擎产出**（MCP `create_pipeline` / `validate_pipeline`），**仓内不手编**；含 `data.schema` + `qa.contract` gate + `drift` 门禁 + 末页守卫（引擎 `maxPages` 撞上限**报错**，好过静默截断；288 窗/天必须显式调）；目标 API 适配 | 引擎 `validate` 过；`drift` 有效（**先断言声明存在**，防假绿——见 §1.5「漂移」一条与 `duckle/README.md` §7.3 坑 1）；**分页配置成对**（`cursor` 缺参**静默降级为不翻页**）| 回退到上一版管线 JSON |
| **E 调度** | **①首选**：**duckle 自带调度器**（cron 归一 / interval / IANA 时区且**未知区名报错不回落** / `Misfire` + 发生账本 / **跨进程排他锁** / 运行历史）| 按 §1.1.4 定归口；**薄 wrapper**（旧说「只做三件事（算窗口 env / 注入 / 调 runner）」**已被 §1.3.3 订正**——只做引擎做不到的）；**新纪律**：**一个 pipeline 只在一侧跑** | 排班触发一次且**如实入账**；改定义**两步都做了**（见 §1.3.2）| 停服务即回到「没有调度」 |
| **F 验收** | **②首选（未验）**：`qa.baseline`（**中位数**基线）/ `qa.reconcile` / `audit_*` | **四层**（§1.4）**全保留**——「独立通道 / 跨系统」两层是**业务口径** | 四层缺一层不算过；新增 gate 先跑过一轮真实周期 | 自证没过时**拒写湖是正确行为**，不是故障 |
| **G 运维** | **②首选（未验）**：`alerts.json`（事件 + 冷却 + **恢复不受压制** + 脱敏）/ `/metrics` / receipt / **`sla` 新鲜度巡检**（专抓没有失败的停更）| **凭据↔账套 whoami 自证**；**lake 对象清单 + ETag 核对**（引擎无「列 bucket」组件）；**外层兜底重试**（引擎**没有运行级自动重试**）| 告警可达、**能响、能恢复**；**容量有余量**；观测有数据（`/metrics` 有数）；**主动停更能被巡检抓到** | 按 §1.5 速查处置各条 |
| **H 变更与回填** | **②首选（未验）**：`/api/backfills` + `/api/watermarks`（set/clear）+ `retry` CLI（**会拒绝重放会重写 sink 的 run**——特性不是缺陷）| 改契约 / 改节奏 / 加域；**回填 = 同一管线换窗口参数**；**窗口分批策略**（跨度上限是 §1.3.1 的实测结论）| 回填期逐日对账全绿 + 总量 sanity；**回填不影响在线链路** | 回填不影响在线链路（同管线、同写出通道） |
| **I 退役** | **②首选（未验）**：`catalog diff <rev>`（抓「资产还在但**失去所有写入者**」）+ `affected` | 旧前缀下线**前**必须（三步）：① 已有替代且对账过；② 消费面已切；③ 观察期 | 三项齐备才下前缀 | 保留前缀至观察期结束（细节见 §7 #2） |

> **找旧版「动作」栏的哪去了**：原表的**「动作」栏已重分配**进「duckle 原生首选」与
```

- [ ] **Step 5: 把 §1.3.2 三条「坑」升格为设计规则**

把 §1.3.2 的标题与三条正文替换为（**保留原三条的技术内容与「改定义两步」那条**）：

```markdown
#### 1.3.2 阶段 E 的三条设计规则（**引擎的既定行为，不是偶发**）

> ⚠️ **别与 `duckle/README.md` §7.3 的「三个坑」搞混——那是另一组三坑**
> （引擎能力面：`drift` 假绿 / `qa.freshness` 时区 / `pipelineHash` 不是数据指纹）。
> 本节这三条是**薄管线与 console 的既有行为**，完整实测依据见 `deploy/duckle/console/README.md`。
> **措辞从「坑」改成「规则」是有意的**：坑是「可能踩」，规则是「照此设计」——
> 这三条**不会**因为小心而消失。

1. **凡 `code.shell`，其后必须跟一个 `qa.contract` 判 `exit_code`** —— 非零退出**不让管线失败**
   （整条仍 `status: ok`，退出码只是**一行数据**）⇒ 结构要求：`rules = { exit_code: "in_range:0,0" }`。
2. **薄管线必须以 sink 收尾** —— 引擎是**惰性**的，gate 当叶子时**判据根本不被求值** ⇒ 布局要求。
3. **console 启动必须显式给 `--duckdb`** —— 否则每次触发都记 `last_run_error: "DuckDB engine isn't installed yet."` ⇒ 启动口径。

**改调度定义后必须两步都做**（漏一步 = 改了没生效，**且不报错**）：
① 重新 **seed** 进该账套的 workspace 卷；② **重建 console 容器**——
文件 bind-mount 钉的是 inode，原子替换后运行中的容器**仍看到旧文件**。
（用 `serviceIds` **定向部署**；**别全量部署**——会重启 `pg_duckdb`。）
```

- [ ] **Step 6: 跑三条断言，必须全绿**

Run: 重跑 Step 1 的三条命令
Expected: `A1 OK` / `A2 OK` / `A3 OK`


> **⚠️ 裁决 + 提前插入的验证（2026-09-27，用户）**：Task 1 的评审（独立复跑全部硬约束）判定
> **D 行把 `src.rest` 分页/增量写成「①首选（已验级）」与同文件 §1.1.6⑦「未拍板前不动」自相矛盾**
> —— 违反判据里那条「**禁止把 ② 写成 ①**」；且该定级是 **spec → plan → 任务书** 一路抄下来的。
> **用户裁定：补实测把它升为 ①**（不是降级）。
> ⇒ 在 Task 1 的 fix 轮**之前插入 Task 1b：`src.rest` 分页 / 请求侧增量 / 水位的最小实测**
> （**本机 venv + duckle 0.7.3 + mock HTTP 源，零生产风险**；spec 见 `.superpowers/sdd/…/task-1b-spec.md`）。
> 实测记录回来后：**D 行按实测改级**——够得上「本环境跑通」的部分写 ① **并附出处**；
> **依赖"源是否支持游标"的那半仍留 ②未验**（那取决于 #260 的网关语义问题）；并同步订正 §1.1.6⑦。
> 该验证本属 **W3**（spec §5），此处**按裁决提前**；**不改变 W3 其余范围**。

- [ ] **Step 7: 提交**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(handbook): 正典加 duckle-first 判据（三档）+ A→I 改三段式 + 三条坑升格为设计规则"
```

---

### Task 2: 资产面写进 §1.1.6（自定义代码与扩展首次进正典）

**Files:**
- Modify: `docs/data-platform-handbook.md`（只改 §1.1.6 一节）
- Test: 三条 grep 断言

**Interfaces:**
- Consumes: Task 1 的三档称谓（本任务标「②档」项）
- Produces: §1.1.6 的四张表（三动作 / 资产矩阵 / 三条路线 / 五条硬纪律）——Task 3 的未验登记引用它

- [ ] **Step 1: 先写验收断言（此时必然失败）**

```bash
cd "$(git rev-parse --show-toplevel)"
H=docs/data-platform-handbook.md
grep -q '资产类 × 谁维护' "$H" && echo "B1 OK" || echo "B1 FAIL"          # 投递矩阵
grep -q 'ext\.\* 首选' "$H" && echo "B2 OK" || echo "B2 FAIL"            # 自定义代码/扩展判定
grep -q '打开它是一个独立的动作' "$H" && echo "B3 OK" || echo "B3 FAIL"  # deploy 强制 enabled:false
```

Expected: 三条全 `FAIL`

- [ ] **Step 2: 在 §1.1.6 的 ①—⑦ 之后追加五个小节**

锚点：§1.1.6 的 `**⑦ 待裁决（无案例不立标准）**` 那一段**之后**、`### 1.2 硬约束清单` **之前**，插入：

````markdown
**⑧ 资产面：桌面端管什么、怎么到服务器侧**（2026-09-27 追加；出处同上，分析件 §6/§7）

**总拓扑**：**桌面（+Git）= authoring 与唯一事实源；服务器 = runtime，只运行、不编辑**（**单向**）。
⚠️ 上游逐字：桌面与 runner **同时**打开一个 workspace 是「**从笔记本搬到服务器的中途形态**」，
**不是推荐的长期拓扑**。⇒「**桌面端永远保留资产**」成立的条件是「资产在桌面与 Git，**服务器不反向持有唯一副本**」，
**不是**「两端同时开着同一个 workspace」。

**三个动作别混**：

| 动作 | 产物 | 去向 | 我们用它做什么 |
|---|---|---|---|
| **Deploy** | **pipeline JSON 原文**（⚠️ 占位符**不解析**）| 服务器 workspace **根**（非 `pipelines/`；临时文件 + rename；**可覆盖**、盲覆盖）| **单份管线快速上线** |
| **Build** | 自包含单文件可执行（内嵌引擎 + DuckDB + 已用扩展 + **已解析**管线 + 密钥）| **本机磁盘**（**不是服务器**）| 无 duckle 环境的交付。⚠️ **不打包 `components/`** ⇒ `ext.*` 在别的机器上**直接失败** |
| **Release** | **控制面全量快照**（hash 寻址）+ 环境指针（`activate`/`rollback`，单次 rename）| 服务器 workspace 的 release store | **整份版本化 + 可回滚**（⚠️ **不含密钥**）——**未验** |

⚠️ **Deploy 与 release 在源码里没有任何调用关系**。**上线是两个动作**：
**Deploy = Admin**（理由逐字：部署就是**交出代码执行权**，因为管线会在这台机上跑 shell 与 SQL）；
**启用调度 = Operator**，且**随部署下发的调度一律被强制 `enabled:false`**
（逐字理由：「在笔记本上设的节奏不该一到生产就开始点火，**打开它是一个独立的动作**」）。

**资产类 × 谁维护 × 怎么投**：

| 资产类 | 进 Git？ | 谁维护 | 怎么到服务器 |
|---|---|---|---|
| 管线 `pipelines/*.json` | ✅ | 桌面（真引擎产出，**仓内不手编**）| Deploy **或** Git seed——**二选一，别混** |
| 调度 / 告警 / 所有者 / 编排（`schedules.json`、`alerts.json`、`owners.json`、`plans.json`）| ✅ | 仓内 | **seed 进 workspace 卷 + 重建容器**（§1.3.2 **两步都做**）|
| 契约 / 语义（`contracts/`、`dbt/`）| ✅ | 仓内 | 随仓（与 §1.3 的 A/C 段同源）|
| 连接 `connections/*.json`（**密文**）| ✅ | 桌面 | ⚠️ **换机 clone 后解不开**——解它的 `.duckle/keys/secret.key` **永不进 Git** ⇒ 密钥**另行分发** |
| 上下文 / 例程（`contexts/`、`routines/`）| ✅ | 桌面 | 与管线同路 |
| **自定义代码** | ⚠️ 分三种 | 桌面 + 仓 | **三种载体三种投法**（见下）|
| **扩展 `ext.*`** | ⚠️ 目录进仓 | 桌面 + 仓 | **`<workspace>/components/<name>/` 一个目录**（docker = **挂卷**）⇒ **seed 进每个账套各自的卷** |
| 运行态正确性状态（`state/`：**水位**、checkpoints、baselines）| ❌ **由运行产生** | 引擎 | ⚠️ **不是缓存，是正确性状态**——决定「下次采哪些」。跟着 workspace 卷走，**不进 Git、别手改**；回填用 `watermarks` |
| 历史与派生物（`runs/`、`receipts/`、`logs/`、`cache/`、`manifests/`）| ❌ | 引擎 | 不用投——引擎自产（§1.5 观测面吃它）|
| 机器本地 `.duckle/`（`keys/`、`secrets/`、`locks/`、`settings.json`、`deploy-targets.json`、`console.db`、`environments/`）| ❌ **绝不** | 各机自持 | **永不投递**。⚠️ 官方每次 commit 前重写 `.duckle/.gitignore`，但它走 `git add -A` ⇒ 那份 ignore 是**最后防线，不是建议** |

**自定义代码与扩展：三种载体**——

| 路线 | 形态 | 状态 | 分发单元 |
|---|---|---|---|
| **① `ext.*` 外部组件** | `<workspace>/components/<name>/duckle-component.json` + **任意语言可执行文件**（stdin JSON 请求 / stdout JSON 应答；数据走 Parquet）| **生产可用、官方文档化** | **workspace 里一个目录**（docker = 挂卷）|
| **② 管线内 `code.*` 节点** | `code.sql` / `sqltemplate` / `python` / `javascript` / `shell` / `wasm` **available**；⚠️ **`code.rust` 是 planned 且零实现** | 可用 | **随管线** |
| **③ 内建级组件**（`src.*` / `xf.*` 那种）| 改上游 Rust 5 处 + 重生成 catalog；`crates/plugin-sdk` 是**已废弃脚手架** | 只能 fork | 维护分叉——**不做** |

⇒ **判定：`ext.*` 首选 / `code.*` 兜底 / 内建级不做**。理由：`ext.*` 有**一等公民待遇**
（调色板 / catalog / MCP / capabilities / **policy 门禁** / run 回执 `Used`·`used_by`）
**外加 `components conform <id>` 的 10 用例行为验收套件**（initialize 不许干活 / 零行进零行出 /
20 万行大批 / 崩了要干净报错 / **secret 脱敏**（查实际发出的字节）/ 超时上界），**输出 json 能直接卡 CI 门禁**。
⇒ **凡「会长期存在的自建逻辑」优先做成 `ext.*`**；`code.*` 用在「一次性 / 只这一段用」。

⚠️ **两条安全空档（设计如此，不是疏漏）**：① **`allowed_paths` 与 `allowed_domains` 对 `code.*` 全部失效**
（子进程可连任意主机、读任意文件，policy 看不见——`code.*` 就是「跑任意程序」，**有意留着**）；
② **没有 per-execution 审计事件**（审计记的是**鉴权动作**，不记「某个 `code.*` 被执行了」）⇒ 留痕靠 run manifest + retry 回执。
⇒ **纪律**：能进 policy 的尽量进 policy（`ext.` 前缀 ⇒ `executes_process()=true`；`components.deny:["ext.*"]` 一票否决）。

**投递的五条硬纪律**（不守会**静默**坏数 / **静默**覆盖）：

1. **服务器只运行、不编辑** —— ⚠️ **没有回拉，也没有漂移检测**（源码里穷举 `reconcile`/`drift`/`desync`/
   `diverged`/`out_of_sync` **均无此语义**）⇒ 有人在服务器改了管线，下次 deploy **静默覆盖**它，而桌面**不会知道**。
   这是「桌面为源」模型**唯一的真实风险**，靠纪律规避（**回滚 = Git 里那一版重发**）。
2. **一个 pipeline 只在一侧跑** —— 桌面**手动 Run 不取运行锁**（引擎注释自认）⇒ 与服务器同管线的调度跑**可并发**、
   **同时写同一 sink、同时推进同一水位** ⇒ **静默丢数**。锁只覆盖「调度触发」那一条路径。
3. **管线里机密只用 `${ENV:...}`** ——「**已保存连接**」的解密值会被**复制进管线文件、随 deploy 传出去**
   （官方逐字：「Picking a saved connection does not, by itself, protect the credential」）。
   ⚠️ **组件侧方向相反**：`ext.*` 组件**继承宿主 env** ⇒ **只传引用名 + 组件自己读 `std::env`**；
   **别在组件属性里用 `${ENV:...}`**（宿主会把**真值**替换进属性再塞进 stdin 的 JSON）。**两条路别套用同一条纪律。**
4. **deploy 完不会跑** —— 见上「上线是两个动作」。
5. **两端外壳有缺口，别只在一端验**：🔴 **占位符替换是两份实现**（桌面 canvas = TypeScript、服务端 = Rust，
   **手工同步、无编译期约束**）⇒ 凡涉 `${date}` / context 优先级**必须在 CLI 或 `serve` 上再验一次**；
   **默认并发桌面 8 / 服务端 1** ⇒ 桌面跑得动 ≠ 服务器跑得动；**桌面 Settings 的三项服务端不读**
   （`spill_dir` / `allow_unsigned_extensions` / `https_proxy`）；**扩展预装两端不同**（桌面 11 / 服务端镜像 12，多 `inet`）。
````

- [ ] **Step 3: 修掉 §1.1.6 里那处引错的出处**

§1.1.6 的注里现写「`duckle/README.md:137`（§6）写「**四项**」」——**引错**：
「四项」实际在 **`deploy/duckle/README.md:249`**（那里写「`duckle/README.md` §7.4 的四项」），
而 §7.4 实列**五项**（缺的第 5 项是「跨组件 parquet 格式兼容（写方比读方新）」）。
把该句改为：

```markdown
> ② 那份清单**已经在漂**——`deploy/duckle/README.md:249` 写「§7.4 的**四项**」，
> 而 `duckle/README.md` §7.4 实列**五项**（漏的是第 5 项「跨组件 parquet 格式兼容」——本仓切官方镜像时新引入的面）。
> ⚠️ **本仓有两份同名前缀的 README，别混**：**仓根 `duckle/README.md` §7.4 = 引擎能力面**；
> **`deploy/duckle/README.md` §6 = 镜像/构建面**（`docker build --check`、容器内实跑…）。
```

- [ ] **Step 4: 跑断言，必须全绿**

Run: 重跑 Step 1 三条命令
Expected: `B1 OK` / `B2 OK` / `B3 OK`

- [ ] **Step 5: 查全节无残留旧指针**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -n 'duckle/README.md:137' docs/data-platform-handbook.md && echo "❌ 旧指针还在" || echo "✅ 旧指针已清"
```

Expected: `✅ 旧指针已清`

- [ ] **Step 6: 提交**

```bash
git add docs/data-platform-handbook.md
git commit -m "docs(handbook): §1.1.6 扩写资产面——投递矩阵 + 自定义代码与扩展 + 五条硬纪律，并修一处引错的出处"
```

---

### Task 3: 未验登记（补条目，**不抄进正典**）

**Files:**
- Modify: `duckle/README.md`（**仓根**）§7.4
- Modify: `docs/data-platform-handbook.md` §7 待沉淀（按需）
- Test: grep 断言

**Interfaces:**
- Consumes: Task 2 的资产面小节（本任务给它补 gate）
- Produces: §7.4 的**新条目编号**——Wave 2/3 的验证结论要销在这些条目上

- [ ] **Step 1: 先写断言（此时必然失败）**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -q 'duckle-runner release' duckle/README.md && echo "C1 OK" || echo "C1 FAIL"
grep -q '两端外壳保真度' duckle/README.md && echo "C2 OK" || echo "C2 FAIL"
```

⚠️ **C1 故意不用裸词 `release`**：那个词**改动前就已经出现 2 次**（README 里有「release 二进制」一节）⇒ 裸词断言**在改动前就会通过**，等于什么都没验。

- [ ] **Step 2: 在 §7.4 追加三条（编号接在现有第 5 项之后）**

锚点：§7.4 的第 5 项（`**跨组件 parquet 格式兼容（写方比读方新）**`）那一段**之后**，插入：

```markdown
6. **`release` CLI 在本项目 compose 上可用** —— 未验（`release build/verify/diff/activate/rollback/list`
   是「整份控制面版本化 + 环境指针」，⚠️ **不含密钥**）。最小验证：在一个账套 workspace 卷上
   `build` → `activate` → `rollback`，看指针与产物。销账归 **P1 Wave 2**（本仓 spec
   `docs/superpowers/specs/2026-09-27-duckle-first-collection-flow-design.md` §3.5）。
7. **两端外壳保真度（占位符替换 / 默认并发）** —— 未验：桌面 canvas 的占位符替换是 **TypeScript**、
   服务端是 **Rust**（**手工同步、无编译期约束**）；默认并发**桌面 8 / 服务端 1**。
   最小验证：同一份含 `${date}` 的管线在 CLI 与 `serve` 上各跑一次，比对取到的日期；
   并实测 `serve` 侧的并发默认值。销账归 **P1 Wave 2**。
8. **`ext.*` 能否在本项目 console 镜像里 spawn** —— 未验（能否 spawn / 能否读 `SYSTEM_BOOK` + `ZOS_*` /
   能否解析 `pg_duckdb`）。最小验证：一个只 `echo` 的 `ext.probe` 组件。
   销账归 **W4 前置 gate**（未排期）。
```

- [ ] **Step 3: 判定 §7 待沉淀是否需要加行**

读 `docs/data-platform-handbook.md` §7 现有四行，逐行问：**这次有产生新的「无案例」项吗？**
- 「退役流程（§1.3 阶段 I）」**已有**（旧湖未退役）⇒ **不加**（不要重复立行）。
- 其余三行与本轮无关 ⇒ **不加**。
⇒ **预期结论：本 Step 不改 §7**（若你发现确有新项，才加，并**在 PR 描述里写清理由**）。

Run: `sed -n '/^## 7 待沉淀/,/^## /p' docs/data-platform-handbook.md | head -20`
Expected: 仍是 4 行，**未被改动**

- [ ] **Step 4: 跑断言 + 查正典没抄条目**

```bash
cd "$(git rev-parse --show-toplevel)"
grep -q 'duckle-runner release' duckle/README.md && echo "C1 OK" || echo "C1 FAIL"
grep -q '两端外壳保真度' duckle/README.md && echo "C2 OK" || echo "C2 FAIL"
# 正典只给指针、不枚举：§1.1.6 里不许出现条目正文的标识串
grep -q 'ext.probe' docs/data-platform-handbook.md && echo "❌ 正典抄了条目" || echo "✅ 正典只给指针"
```

Expected: `C1 OK` / `C2 OK` / `✅ 正典只给指针`

- [ ] **Step 5: 🔴 重跑 lock（`duckle/**` 在数据面 manifest 覆盖范围内）**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs
git diff --stat deploy/data-plane.lock   # 应看到 duckle/README.md 那一行的 sha256 变了
```

Expected: lock 有变更（**这是本改动必须带上的**）。若 lock **没变** ⇒ 说明文件不在覆盖面内，**停下来核对 manifest**再继续。

- [ ] **Step 6: 提交**

```bash
git add duckle/README.md docs/data-platform-handbook.md deploy/data-plane.lock
git commit -m "docs(duckle): §7.4 补三条未验 gate（release / 两端保真度 / ext.probe）"
```

- [ ] **Step 7: 波末全量验证 + 推 PR（Wave 1 收口）**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
pnpm run test:guard
git push -u origin docs/duckle-first-flow-spec
```

Expected: 全部 exit 0（**若某个守卫失败，先看清是否本波引入，再决定改文还是改守卫**）。
⚠️ **只等 CI CLEAN 再合**（历史上 UNSTABLE 强合出过生产 502）。**不要用 `--no-verify`。**

---

## Wave 2：两项最小验证（真机，**串行**）

> **⚠️ 为什么降为串行（不是「偷懒」）**：两个任务的**机器侧资源是隔离的**（Task 4 用 **64188** 的 workspace 卷、
> Task 5 用 **3120** 的——一账套一个 console 天然是两个卷），**但交付物是共享的**：
> 它们都要写 `duckle/README.md` **§7.4 的同一张清单**，也要重跑**同一个** `deploy/data-plane.lock`
> ⇒ **违反「波内不得改同一文件」**。按本仓规则：**拿不准就降为串行**（宁可慢一波，不可在集成时互相践踏）。
> ⇒ 若要并行，正确做法是**把「验证」与「写回」拆开**：两个验证任务**只产证据**（不落文件，证据进报告），
> 再串一个写回任务统一改 §7.4 + 重跑 lock。**本计划选了更简单的串行。**
>
> ⚠️ **两个任务都只读/只写自己那一侧**，**都不碰在线采集链路**（不改 `schedules.json`、不改管线）。
> ⚠️ **先确认当前没有正在跑的采集**（Task 5 要调 `serve` 起管线；**同一个 pipeline 只在一侧跑**）。

### Task 4: `release` CLI 能否用在我们的 compose 上（64188 侧）

**Files:**
- Modify: `duckle/README.md` §7.4 第 6 项（**销账**：把「未验」改成实测结论）
- Test: 真机命令输出

**Interfaces:**
- Consumes: Task 3 建立的 §7.4 第 6 项
- Produces: 「release 能不能当我们的回滚面」这个结论——W2 的编排设计要用它

- [ ] **Step 1: 取资源 id（**不许手打/推断**）**

经 openship MCP：`get_projects` → 找数据面 project → 取 `id`；再 `get_projects_by_id_services` → 取 **64188 console** 的 `serviceId`。
**逐字抄回返回值**（绝不手工补写截断标识符——续错一位就是「对象不存在」）。

- [ ] **Step 2: 探 workspace 卷与 release store 是否存在**

```sh
# 经 MCP：post_projects_by_id_services_by_serviceId_exec（id=<projectId>, serviceId=<64188 console>）
ls -la /workspace && echo "--- environments:" && ls -la /workspace/.duckle/environments 2>&1 | head
```

Expected: `/workspace` 存在且有 `pipelines/`、`schedules.json`、`state/`；`environments` 可能不存在（**没跑过 release 就是这样**）。

- [ ] **Step 3: 跑 release 全链（build → activate → rollback）**

```sh
duckle-runner release build --workspace /workspace; echo "build exit=$?"
duckle-runner release list --workspace /workspace
duckle-runner release activate <上一步列出的 release_id> --workspace /workspace; echo "activate exit=$?"
duckle-runner release rollback --workspace /workspace; echo "rollback exit=$?"
```

Expected（判定标准）：
- `build` exit 0 且 `list` 里出现一个 hash 寻址的 release ⇒ **支持**；
- 报「unknown subcommand」或需要 docker/网络 ⇒ **不支持**（记进 §7.4 的销账结论）。
⚠️ **失败不是任务失败**——**如实记结论**（这两种都是有效产出；编一个「应该可以」才是失败）。

- [ ] **Step 4: 核「release 不含密钥」这条是否名副其实**

```sh
duckle-runner release diff --workspace /workspace 2>&1 | head -20
# 并在 release store 里 grep 连接密文/明文密钥标识（不回显值，只看有无）
```

Expected: 快照里**看不到**明文凭据（`release.rs` 自陈 `## No secrets`）。**只记「有/无」，不回显任何值。**

- [ ] **Step 5: 写回销账结论**

把 §7.4 第 6 项改写为实测结论（**逐字写清：哪台机、什么命令、看到什么**）：
支持 ⇒ 写「**已验：支持**（`build`/`activate`/`rollback` 实跑通过，× 台 × 卷）」；
不支持 ⇒ 写「**已验：不支持**（原因为 …）⇒ **回滚继续用 Git 重发**」。

- [ ] **Step 6: 重跑 lock + 提交**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs     # duckle/ 在 manifest 内，必须重跑
git add duckle/README.md deploy/data-plane.lock
git commit -m "docs(duckle): §7.4 第 6 项销账——release CLI 实测结论"
```

### Task 5: 两端外壳保真度（3120 侧）

**Files:**
- Modify: `duckle/README.md` §7.4 第 7 项（销账）
- Test: 真机命令输出

**Interfaces:**
- Consumes: Task 3 的 §7.4 第 7 项
- Produces: 「占位符与并发在服务端实际是什么」——W2 把编排改到 HTTP API 时要按它设参

- [ ] **Step 1: 取 3120 console 的 resource id**（同 Task 4 Step 1 的取法，**逐字抄回**）

- [ ] **Step 2: 制作一份含 `${date}` 的最小管线（**先取 schema，不凭记忆写属性名**）**

**先用 duckle MCP `get_component_schema {"componentId":"src.inline"}` 取真实属性名**，
再按返回的字段写管线；**禁止凭记忆写属性**（本仓已记录过「文档里出现不存在的组件 id」这类上游漂移）。
管线建在**仓内** `deploy/duckle/console/pipelines/_probe.date.json`（一次性、用完删），
属性里放 `${date}` 占位符；写好后 **`validate_pipeline` 过一遍**再上机。

- [ ] **Step 3: 两端各跑一次，比对取到的日期**

```sh
# ① CLI 侧（容器内，经 MCP exec）
duckle-runner validate --workspace /workspace /workspace/_probe.date.json; echo "validate exit=$?"
duckle-runner --pipeline /workspace/_probe.date.json --workspace /workspace --duckdb "$(command -v duckdb)" 2>&1 | tail -20
# ② serve 侧：用 HTTP 跑（不要用桌面手 Run——它不取运行锁）
curl -s -X POST http://127.0.0.1:<console端口>/api/run -H "Authorization: Bearer <token 从 env 取>" \
  -d '<请求体形状以引擎为准>' | head -20
```

⚠️ **请求体形状不许凭记忆编**：先看 `duckle-runner serve --help` 与上游 `docs/current/ci-and-orchestration.md`
（本仓 `deploy/duckle/README.md` §7 只记了「有哪些子命令」，**没记 HTTP 请求体**）。
⚠️ **`/api/run` 失败也返回 HTTP 200** ⇒ **必须读 body 的 `status`**（`ok|error|cancelled`），不能只看状态码。

Expected（判定标准）：两次**都把 `${date}` 解成同一天（UTC）** ⇒ 无缺口；
**若两侧不一致（含时区差）⇒ 记进 §7.4 并升格为 gate**。
⚠️ token **从容器 env 取**（`DUCKLE_CONSOLE_TOKEN`），**只回显「有/无」与 sha256 前 8 位，不回显值**。

- [ ] **Step 4: 实测服务端默认并发**

```sh
env | grep -E 'DUCKLE_MAX_CONCURRENT_RUNS' || echo "未设（默认应为 1）"
# 并发行为：同时发两个 /api/run/async，看第二个是排队还是并发（看 /api/run/status 的 queue_ms）
```

Expected: 未设时行为 = **串行**（源码默认 1）；**与桌面默认 8 的差异要写进销账结论**。

- [ ] **Step 5: 清理 + 写回销账**

```sh
rm -f deploy/duckle/console/pipelines/_probe.date.json
```

把 §7.4 第 7 项改写为实测结论（**逐字写：哪台机、什么命令、两侧各得什么**）。

- [ ] **Step 6: 核 lock 一致 + 重跑 lock + 提交**

```bash
cd "$(git rev-parse --show-toplevel)"
# probe 文件已删净 ⇒ 先确认 lock 仍然一致（若不一致说明有残留文件）
pnpm exec tsx scripts/check-data-plane-lock.mjs; echo "lock guard exit=$?"
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs   # duckle/README.md 改过，必须重跑
git add duckle/README.md deploy/data-plane.lock
git commit -m "docs(duckle): §7.4 第 7 项销账——两端占位符与默认并发实测"
```

Expected: guard exit 0（**非 0 ⇒ 有残留文件，先清干净**）。

---

## Wave 3：W1 观测面（真机，**串行**——同一 console 资源）

> **为什么串行**：三个任务都改**同一只 console** 的 workspace 卷（`alerts.json` / `owners.json` / 服务配置），
> 且每个都要**重建容器**（§1.3.2 两步）——并行会互相重启、观测面互相污染。
> **任务锚**：**#210**（`_ops` 观测通道从未接通）。
> ⚠️ **退役前不删任何现有管道**：`notify_fail` 与 `_ops` **与新的并行一段时间**，对得上再退。

### Task 6: 观测岔路裁决 —— 先做「引擎原生可读」

**Files:**
- Modify: `duckle/README.md` §7.4（若无新 gate 则不动）+ **#210 的评论**（写裁决与证据）
- Test: `/metrics`、`/api/runs` 能取到与本 run 对应的数

**Interfaces:**
- Consumes: Wave 2 的 console 访问方式（端口/token 取法）
- Produces: 「**本 run 的观测数从哪读**」这个结论——Task 7 的告警要挂在同一面上

- [ ] **Step 1: 起一条真实（或最小）run，记下 `runId`**

```sh
curl -s -X POST http://127.0.0.1:<port>/api/run/async -H "Authorization: Bearer <token>" \
  -d '{"pipeline":"lemeng.retail.windows.run.json"}' | head -5
```

Expected: `202` + `runId`。⚠️ **注意**：这条管线会跑采集 ⇒ **先确认 openship job 侧本轮没有在跑**（「一个 pipeline 只在一侧跑」）。
若不便跑真采集，**改用只读的最小管线**（如 Task 5 的 probe 形态）。

- [ ] **Step 2: 从引擎原生面把这次 run 的观测数读出来**

```sh
curl -s -H "Authorization: Bearer <token>" "http://127.0.0.1:<port>/api/run/status?runId=<runId>" | head -20
curl -s -H "Authorization: Bearer <token>" "http://127.0.0.1:<port>/api/runs" | head -20
curl -s -H "Authorization: Bearer <token>" "http://127.0.0.1:<port>/metrics" | head -20
```

Expected: 三处都能取到**可定位到这次 run** 的数据（状态 / 历史 / 指标）。
⚠️ **失败也要判**：`/api/run` 系列**失败也返回 HTTP 200** ⇒ **必须读 body 的 `status`**（`ok|error|cancelled`），**不能只看状态码**。

- [ ] **Step 3: 与现有 `_ops` 通道对账**

把这次 run 的**行数/耗时**与 `_ops` 口径（当前是 `OPS_SINK=DISABLED`，故实际来自 job stdout）比一次。
Expected: 两者**对得上**（对上 ⇒ 可以谈退役 `_ops`；对不上 ⇒ **先记差异，不退役**）。**这一步不删任何东西。**

- [ ] **Step 4: 把裁决写进 #210**

用 `gh issue comment 210` 写：① 本次实测到的是什么 ② 裁决（**本轮先做「引擎原生可读」**，`_ops` 是否补 env **推到对账之后**）③ 证据（命令 + 输出摘要，**不含任何 token**）。

- [ ] **Step 5: 提交（若有文档改动）**

```bash
git add -A && git commit -m "docs(duckle): W1 观测面——引擎原生面实测记录（#210）" || echo "无文档改动则跳过"
```

### Task 7: `alerts.json` 告警规则

**Files:**
- Create: `deploy/duckle/console/alerts.json`
- Test: 主动制造一次失败 → 告警响；再恢复 → **恢复通知不被冷却压制**

**Interfaces:**
- Consumes: Task 6 的「观测面在哪」
- Produces: 告警规则文件（W1 的验收物）

- [ ] **Step 1: 先读 console README 里「失败告警怎么接」现文**

Run: `sed -n '/失败告警怎么接/,/^## /p' deploy/duckle/console/README.md`
Expected: 读到**现有做法**（`notify_fail`）。**新规则要与它并存，不替换。**

- [ ] **Step 2: 先取 `alerts.json` 的**真实字段**（不许凭记忆写 schema）**

从**两个来源**取，二选一或互相印证：
- 源码：`~/Documents/mytechcode/source-analysis/duckle/crates/duckle-runner/src/alerts.rs`（**v0.7.3 = 我们跑的版本**）；
- 上游文档/`serve` 的接口（若有 `alerts` 相关子命令或端点）。

记下：规则字段（glob / owner / tags）、事件集（`Failure` / `Recovery` / `Success` / `Stale` / `Refreshed`）、
冷却的计法（**按「规则 × 管线 × 事件」**）、**恢复通知不受冷却压制**、以及 **URL 字段认不认 `${ENV:...}`**。
**这四件事都要从源码取证，写进文件头注释。**

- [ ] **Step 3: 写 `alerts.json` + 定「凭据怎么到 console」**

⚠️ **先查既有做法**：`deploy/duckle/console/README.md` §「失败告警怎么接」写着现有通道是
**企微机器人 webhook，URL 走 project env 的 `WECOM_WEBHOOK_URL`** ⇒ **新规则沿用同一套凭据来源**，
别另发明 vault / `secrets.env`（除非 Step 2 取到的源码证明 `alerts.json` 读不到 env）。

按 Step 2 取到的字段写规则文件，并在**文件头注释**里写清：
① 字段来源（哪份源码/文档）② 凭据怎么来的（env 键名，**不写值**）③ 与既有 `notify_fail` 的**并存关系**。
⚠️ **仓里绝不出现 webhook URL 明文**（URL 本身就是凭据）。

- [ ] **Step 4: seed 进 workspace 卷 + 重建容器（两步都做）**

```sh
# ① 确认文件已在数据面机上（投递后的 ${REPO}/deploy/duckle/console/alerts.json；本轮也可 docker cp 临时送一次）
#    经 MCP post_system_servers_by_id_exec（serverId = 数据面机）：
#    c=$(docker ps --format '{{.Names}}' | grep <该账套的 console 容器名> | head -1)
#    docker cp ${REPO}/deploy/duckle/console/alerts.json "$c":/workspace/alerts.json
# ② 重建 console 容器：post_projects_by_id_services_sync → 按 serviceIds **定向部署**
#    ⚠️ 禁止全量部署（会重启 pg_duckdb / Metabase）
```

Expected: 重建后容器内 `/workspace/alerts.json` 是**新内容**（`/workspace` 是**卷** ⇒ 重建不丢）。
⚠️ 漏第①步 = 改了没生效**且不报错**（§1.3.2 的「两步都做」）。
⚠️ **容器名/项目 id 逐字从 MCP 返回值抄回**，不手工补写截断标识符。

- [ ] **Step 5: 主动制造失败与恢复各一次**

制造一次真失败（如让管线指向一个不存在的源）→ 等告警；
再让它成功 → 看**恢复通知是否照发**（**不该被冷却压掉**）。
Expected: 两次都收到；若只收到第一次 ⇒ **冷却把恢复压了**，记进 §7.4 并报上游。

- [ ] **Step 6: 重跑 lock + 提交**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs     # deploy/duckle/console/ 在 manifest 内，必须重跑
git add deploy/duckle/console/alerts.json deploy/data-plane.lock
git commit -m "feat(duckle): console 告警规则入仓（alerts.json）+ 与既有 notify_fail 并存"
```

### Task 8: `sla` 新鲜度巡检（专抓「没有失败的停更」）

**Files:**
- Create: `deploy/duckle/console/owners.json`（`maximumAge` 阈值）
- Test: **主动停更一次，巡检要抓到**

**Interfaces:**
- Consumes: Task 7 的凭据与 seed 路径
- Produces: 「停更能被抓到」这条能力——**它是现有告警面完全看不见的那一面**

- [ ] **Step 1: 定 `maximumAge` 阈值（**由 SLA 倒推，不拍脑袋**）**

按 §1.1.3（节奏选型由消费侧 SLA 倒推）定：零售日更 ⇒ 阈值取「> 一个采集周期 + 余量」（如 `36h`）。
⚠️ **被禁用的调度会被直接判 stale** ⇒ 阈值要考虑 `enabled:false` 的条目（否则天天假告警）。

- [ ] **Step 2: 先取 `owners.json` 的**真实字段**，再写（不许凭记忆写 schema）**

从源码取：`~/Documents/mytechcode/source-analysis/duckle/crates/duckle-runner/src/sla.rs`（巡检实现）
与 `alerts.rs`（**`owners.json` 也被告警规则用**——两处共读一个文件，改之前先确认字段不冲突）。
确认：`maximumAge` 的**取值语法**（分析件记了 `36h` / `2d` 这类形态）、按什么维度挂 owner、
以及**被禁用的调度是否真被判 stale**。写进文件头注释。

- [ ] **Step 3: seed + 重建容器（两步都做，同 Task 7 Step 4）**

- [ ] **Step 4: 主动制造一次停更来验**（**这是本任务的核心验收，不能省**）

做法（择一）：① 把某个**非关键**调度条目设 `enabled:false` 一个巡检周期；② 或临时改 `maximumAge` 到极小值。
Expected: 巡检**报 `Stale`**（状态机 `Fresh/Stale/Recovered`，保留 `stale_since`）；恢复后再报 `Recovered`。
⚠️ **验证完必须恢复原状**（把 `enabled` 改回 / 阈值改回），并**再确认一次 `Fresh`**。

- [ ] **Step 5: 写回结论 + #210**

§7.4 若产生新 gate 则补条目；否则在 #210 评论里写实测结论（**含「主动停更被抓到」这条证据**）。

- [ ] **Step 6: 重跑 lock + 提交**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm exec tsx scripts/lemeng/data-plane-lock.mjs     # deploy/duckle/console/ 在 manifest 内，必须重跑
git add deploy/duckle/console/owners.json deploy/data-plane.lock
git commit -m "feat(duckle): console 新鲜度巡检入仓（owners.json 的 maximumAge）+ 停更抓取实测"
```

- [ ] **Step 7: Wave 3 收口（全量验证 + PR）**

```bash
cd "$(git rev-parse --show-toplevel)"
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
pnpm run test:guard
git push
```

Expected: 全绿；PR 里 `Closes #210`（**这是 feat，必须有 issue**——#210 就是）。

---

## 交接与后续（不在本计划内）

| 事项 | 归属 |
|---|---|
| **W2 调度/编排（含 3120 切 console、job 退役）** | 自己的 plan（前置：W1 完成 + 那条锁的疑点实测） |
| **W3 分页/增量/水位** | 自己的 plan（**硬前置：#260 的网关语义问题要有答案**） |
| **W4 物化/dbt 归口** | 先开 issue + `ext.probe`（本计划 §7.4 第 8 项已挂号） |
| **引擎升级 0.7.3 → 0.7.4** | 独立一件（含「写方比读方新」的 gate） |

## Self-Review

- **Spec 覆盖**：spec §10.2 的四项 → Task 1（判据 + 三段式 + 坑升格 = 正典改写）· Task 2（资产面进 §1.1.6）·
  Task 3（未验登记）· Task 4/5（§3.5 的两项最小验证）· Task 6/7/8（W1 三个子项）。**无遗漏**。
  spec §6.0 的「资产面验证必须与 W1 同波」→ Wave 2 与 Wave 3 在**同一 PR 序列内**推进（Wave 2 先落结论，Wave 3 用它的访问方式）。
- **占位符扫描**：无 TBD/TODO。「<projectId>」「<token>」「<port>」是**运行时取值**，每处都写了**怎么取**
  （取法在前一步），不是待填的空白。
- **类型一致**：三档称谓（①首选/②未验/③归我方）在 Task 1 定义、Task 2 引用，措辞一致；
  §7.4 条目的编号（6/7/8）在 Task 3 建立、Task 4/5 销账时**按编号引用**。
- **一处诚实边界**：Task 4/5/6 的**判定标准写在 Expected 里**，且**明确「失败也是有效产出」**——
  这符合 Global Constraints 的「不许伪造产出」。
- **⚠️ 写这份计划时证伪的四个假设**（都已改掉，记在这里免得下一个人重新踩）：
  1. **`pnpm run gates` 不存在** —— 真实是 `pnpm typecheck` + 六个 `scripts/check-*.mjs` + `test:guard`（见 Global Constraints）。
  2. **`deploy/duckle/seed-schedules.sh` 不存在** —— 它在调度下沉计划里被列为「新增」但**从未落仓**；
     实际 seed 走的是**服务器级 exec + `docker exec`**（形态取自该计划的 Task 1）。
  3. **改 `duckle/**` 或 `deploy/duckle/**` 必须重跑 lock** —— 两条路径都在 `deploy/data-plane-manifest.txt` 覆盖范围内。
     这条**上次咬过两次**，本计划已在五个任务的提交步里各加了一步。
  4. **Wave 2 不能并行** —— 两个任务的交付物是共享文件（§7.4 + lock），违反「波内不得改同一文件」⇒ 降串行。
- **信任但核实**：`alerts.json` 与 `owners.json` 的**字段 schema 本计划没有写死**（我手上没有它们的权威字段表），
  改为**要求先从 v0.7.3 源码取证**（`source-analysis/duckle/crates/duckle-runner/src/{alerts,sla}.rs`）——
  **宁可多一步取证，也不写一份「看着像」的 schema**（本仓已记录过上游文档漂移的案例）。
