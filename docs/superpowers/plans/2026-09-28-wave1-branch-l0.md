# Wave 1 首航实施计划：branch 日频采集回迁 L0（一条管线，去掉 shell）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 或 executing-plans 逐任务执行。

**Goal:** 把 `lemeng.dim.branch`（当前 = 薄管线 + wrapper + 重管线三层）迁成 **L0：一条管线**，全程无 shell；凭据改走 `connectionRef`（即使 L0 并不需要，也为 Wave 2 提前生产验证）。

**Architecture:** 单管线 = 身份门 → `src.rest`×5（分页）→ `ctl.merge` → 末页哨兵 `ctl.die` → `code.sql` 成形 → `qa.contract` 闸 → `snk.minio`。**每部署恒定的非凭据运行参数**（`SYSTEM_BOOK`）保持 `${ENV:}`；**每次 run 变化的值**（`SNAPSHOT` 分区日、`BATCH_ID` run 号）改用**引擎内建**（`${date+8h}` / `${datetime}`）——理由：`${ENV:}` 由 console **进程环境**解析，而 console 是常驻进程、调度条目带不了 env ⇒ 不重建容器这两个值就**冻在容器创建那刻**（分区路径天天一样、`batch_id` 天天一样）；且 `${ENV:}` 在**调度路径**上无法被每 run 更新（`run_scheduled` 传空 params）。内建是**属性级替换**，能进 sink `key` / 文件路径 / `code.sql`。⚠️ `+8h` 是「Asia/Shanghai = UTC+8、自 1991 年起无 DST」的显式编码，**必须在管线 `_note` 里写死这条理由**；换时区/换区划要重估。**凭据**（`LEMENG_TOKEN` / `ZOS_*`）改走 `connectionRef`。

**Tech Stack:** duckle 0.7.4（产线已升）+ 现成的 `scripts/duckle/connection-setup.py` + openship MCP（运维面）。

## 依据

- 正典 `docs/data-platform-handbook.md` §1.1.7（L0/L1 定义与判定表）
- `docs/superpowers/specs/2026-09-28-duckle-child-value-paths.md`（`connectionRef` 五子路径全覆盖、零明文、加密写入方三路取舍）
- `docs/superpowers/specs/2026-09-28-duckle-connection-setup.md`（脚本已进仓，含容器内实跑待收口项）
- `docs/superpowers/specs/2026-09-28-duckle-l1-wave1-prep.md`（分页复核、sink 语义、方言坑、D2 身份门承载面）

## Global Constraints（逐字值，勿改写）

- **分页**：branch 真实配置 **5 页 × 200**（阈值 800 家）；末页哨兵（`ctl.die has-rows`）是**唯一**停止信号（网关无 total/hasNext，末页 = HTTP200 + code0 + 空数组）
- **sink 写法**：一对象覆盖、分区写进 key、**不开 `partitionBy`**（云 sink 上被静默忽略，同 run 两 sink 同 key 会静默丢数）
- **密钥红线**：绝不进 URL/query（失败会写进 logs/runs 三处）；绝不进返回行（进 checkpoints/死信）
- **子文档里绝不写 `${ENV:...}`**（顶层之外无人解析）——本计划是 L0（单文档），故 `${ENV:}` 合法；但**凭据仍走 `connectionRef`**（为 Wave 2 预验）
- **连接 id 账套无关**：`zos` / `lemeng`（连接文件按各 workspace 自己的钥匙加密）
- **投递铁律**：管线/调度改动必须先 push（机器 sync 按 SHA 取件）；seed 走 console HTTP API 或卷内落盘 + 定向重建
- **零明文**：脚本与提交里不出现任何凭据值；只写「在哪、怎么取」

---

### Task 1: D2 实验——身份门能否原生化（**决策前置，先做**）

**为什么先做**：现 wrapper 的「凭据↔账套自证」是**采集前闸**（身份不符就拒采）。它是 L0 形态里唯一没有天然位置的职责——真 `whoami` 是 SSE，`src.rest` 只认 JSON。这条不解决，L0 要么缺一道安全闸，要么得为它留个 shell。

**Files:**
- 新建：`/tmp/d2-lab/`（隔离 lab；管线与证据不入仓）
- 产出：报告 `/tmp/d2-lab/report-d2.md`（结论 + 证据 + 建议）

- [ ] **Step 1: 三个候选承载面各做一个最小实验**（mock 网关回 SSE 形状）
  1. `src.rest` + `rawResponseDestination` 落文件 → `code.sql` 抠 `^data: ` 行 → 能否断言 company/branch 集合
  2. 换一个**返回 JSON** 的身份端点（先在匿名 OpenAPI 目录里找：`agi.lemengcloud.com/ability/<code>/openapi.json`）——若有公司/账套维度的 JSON 端点，身份门可 1:1 原生
  3. 数据面自证：用 `branch.find` 返回的**门店集合**与预期集合比对（`code.sql` 出 mismatch 行 + `ctl.die has-rows`）——不需要 whoami，直接用业务数据证身份
- [ ] **Step 2: 判定并给建议**：① 可行 ⇒ 给出可直接抄的节点写法；③ 不可行 ⇒ 明确「L0 缺身份前闸」的后果与替代（结构性绑定：凭据住该 workspace 的 `connections/` 文件，绑定由文件存在性保证 + 独立诊断保留）
- [ ] **Step 3: 结论回写正典 §1.1.7**（身份门那一行）

### Task 2: 生产连接准备（3120 console）——**同时收口「脚本容器内实跑」未验项**

**Files:** 无仓内改动；动的是 3120 console 工作区卷（`lemeng-console-3120-ws`）

- [ ] **Step 1: 把脚本送进容器**：`docker cp scripts/duckle/connection-setup.py <container>:/tmp/`（openship MCP 的 server-exec；执行通道单条 10 KB 上限 ⇒ 必须用 `docker cp` 而非内联）
- [ ] **Step 2: 只读预检**：容器内确认 `python3 --version`、`/workspace` 可写、`.duckle/keys/` 现状（**不回显任何凭据值**）
- [ ] **Step 3: 跑 setup**：读容器 env 里的凭据 → 生成/复用钥匙 → 写 `connections/zos.json` 与 `connections/lemeng.json` → 自检（残留明文 ⇒ 非零退出）
- [ ] **Step 4: 验收**：① 脚本退出码 0；② `connections/*.json` 里敏感字段全是 `enc:v2:` 开头；③ 全 workspace grep 明文凭据 = 0 命中（键名/长度/指纹比对）；④ `.duckle/keys/secret.key` 权限 0600、32 字节
- [ ] **Step 5: 记录**：把「脚本在容器内实跑通过」的结论回填 #305 的收口留言

### Task 3: L0 管线编写（仓内）

**Files:**
- Create: `deploy/duckle/console/pipelines/lemeng.dim.branch.l0.json`（新形态；**不动**现有薄管线，并行期两份共存）
- Modify: `deploy/duckle/console/schedules/3120.json`（追加 L0 条目，`enabled:false`——并行期手动触发）
- Modify: `deploy/data-plane.lock`（deploy/** 变更按仓规矩重生成）

- [ ] **Step 1: 写管线**（对照 `duckle/common/lemeng.branch.json` 逐节点搬，差异如下）
  - `src.rest`×5：`headers.Authorization` 由 `${ENV:LEMENG_TOKEN}` 改为 `connectionRef:"lemeng"` 提供（**连接优先于内联值**）
  - `sink`：`connectionRef:"zos"` 提供 `accessKey/secretKey/endpoint`；`bucket`/`key` 保持（非敏感配置）
  - `shape`（`code.sql`）里的 `${ENV:SNAPSHOT}`/`${ENV:BATCH_ID}`，以及 `w0.rawResponseDestination` 与 `g0` 的 `read_text` 里那处 raw 原件路径（**同一路径两处，必须一起改**），改用**引擎内建**：分区日 `${date+8h}`、run 号 `'dim-' || '${ENV:SYSTEM_BOOK}' || '-branch-' || replace(replace('${datetime}','-',''),'_','T') || 'Z'`（形状与原 `${ENV:BATCH_ID}` 逐字节相同）；`${ENV:SYSTEM_BOOK}` / `${ENV:BRANCH_NUMS}` **保持原样**（L0 是顶层文档，env 对**每部署恒定**的键合法）
  - **身份门节点**：按 Task 1 的结论插入（或明确空缺，把理由写进 pipeline 的 `_note`）
  - ⚠️ 方言坑：`window`/`rows` 是 DuckDB 保留字必须引号；`code.sql` 开头不能写 `WITH`；`${ENV:}` 在 `code.sql` 里可替换
- [ ] **Step 2: 本地校验**：MCP `validate_pipeline`（**注意**：含 `ext.*` 才需走 CLI；本管线无 ext，MCP 可用）+ `node scripts/lint-architecture.mjs`
- [ ] **Step 3: lock 重生成与守卫**：`pnpm exec tsx scripts/lemeng/data-plane-lock.mjs` → `node scripts/check-data-plane-lock.mjs`
- [ ] **Step 4: Commit** — `feat(duckle): branch 采集 L0 形态管线（一条管线替代薄壳+shell 三层） (#276)`

### Task 4: 对照验证（**不切流**）

- [ ] **Step 1: 投递**：push → 机器 sync（按 SHA）→ 管线文件进卷 / seed 调度条目 → **定向重建 3120 console**（`serviceIds` 定向，别全量）
- [ ] **Step 2: 手动触发 L0**：console HTTP API 触发 L0 管线（不启用调度）；**判触发看 receipts 的 startedAt**
- [ ] **Step 3: 逐项对照**（与当日老路径产物比）
  - 行数：门店数逐日应一致（当日快照）
  - 内容：**逐行逐列 sha256**（除 `batch_id` 外应完全一致——`batch_id` 是载荷列，两边必然不同）
  - `snapshot`/`system_book` 分区值正确
  - `_ops` 观测行（若 L0 已含观测节点）与告警面
- [ ] **Step 4: 重复 ≥3 次**（不同日期或同日重跑，验证幂等：**同日重跑：除 `batch_id` 外逐列 sha256 一致 + 分区路径一致 + 行数一致**——`batch_id` 每次 run 必然不同，这正是改用内建后的正确行为；旧的「同 `batch_id` 重跑」口径在新形态下不可表达，它能成立恰恰因为当时 `batch_id` 被冻在容器创建那刻）
- [ ] **Step 5: 有差异就停**——报告差异面，不切流

### Task 5: 切流与收口

- [ ] **Step 1: 切流**：L0 调度条目 `enabled:true`；薄管线 `lemeng.dim.branch.run` 调度 `enabled:false`（保留文件，回滚位）
- [ ] **Step 2: 观察 ≥3 运行日**：调度 ok / 湖分区正确 / `_ops` 行 / 告警面静默
- [ ] **Step 3: 退役薄壳**：删薄管线文件与调度条目；`run-retail-day.sh` 的 `dim` 分支标废弃（**不动 retail 分支**——Wave 2 才动）
- [ ] **Step 4: 正典收口**：§1.1.7 的 L0 档从「①现行可用」补上本例为**首个生产案例**；Wave 表更新
- [ ] **Step 5: 沉淀**：WeKnora 查重后更新（L0 迁移实录 + connectionRef 生产首次落地 + 踩坑）

## 波次

- **Wave A**：Task 1（D2 实验）+ Task 2（连接准备）——互不相干，可并行
- **Wave B**：Task 3（管线编写）——依赖 Task 1 的结论（身份门）与 Task 2（连接就位）
- **Wave C**：Task 4（对照）→ Task 5（切流收口）——串行，人工判读

## 明确不做（YAGNI）

- **不动 retail 的任何东西**（日批/tick/close）——那是 Wave 2/3，且正在 W2 观察期
- **不动 `run-retail-day.sh` 的 retail 分支**——只把 `dim` 分支标废弃
- **不启用 L1/foreach**——branch 是单窗，不需要；foreach 留给 Wave 2 在零售上首验
- **不改 64188**——试点收口在 Wave 3

## 风险与回滚

| 风险 | 处置 |
|---|---|
| L0 与老路径产物有差异 | 对照期**不切流**；差异面报告后再定 |
| 连接文件写坏 / 钥匙丢失 | 老路径仍在跑（薄壳未删），直接不切流即可；`connections/` 可重生成 |
| L0 缺身份前闸（若 Task 1 判定不可行） | 切流前必须由人拍板接受，并保留独立诊断；**不默认接受** |
| 同 workspace 调度并发 | 并行期 L0 调度不 enabled（手动触发），避免与老路径撞 |
