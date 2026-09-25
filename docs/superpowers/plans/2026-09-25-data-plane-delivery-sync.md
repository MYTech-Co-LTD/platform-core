# 数据面工件投递机制：清单 + 就地核验同步 + 版本标记

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「手工投递一个文件」升成「一份声明式清单 + 一次可核验的同步 + 一个版本标记」，让
`merge main` 送不到的数据面工件有一条**显式、可核验、有守卫**的投放通路。

**Architecture:** 仓库侧（有 `.git`）生成清单与 lock 并提交；数据面机上（无 `.git`、无 node）只消费
lock，按全 SHA 经 smart-proxy 公网 EIP 逐文件取件、逐文件 sha256 断言、同目录临时文件 + 原子
`mv -f` 就地替换，最后写版本标记。`--check` 让漂移可见。守卫在 CI 里防「脚本新引一个路径、清单忘了
登记」这类窟窿复发。

**Tech Stack:** POSIX sh（机器侧）/ Node ESM + JSDoc（仓库侧）/ vitest（两侧的单测）。

**正典：** `deploy/data-plane-deploy-sop.md` §E（本文只记实施与读数，不复制条文）。

**承载 issue：** #199。

---

## Context：为什么做

`merge main` **不到达**数据面机。机器上 `/opt/platform-core-data/platform-core` 是 tarball 解包、
**没有 `.git`** ⇒ `git pull` 通路根本不存在（SOP §E.1）。

而 SOP 原先自述「消费面唯一一例是 `run-retail-day.sh`」——侦察实测推翻了它：机器实际消费
**7 个路径 / 4 个落地位置**（SOP §E.2 的表）。

**已经漂移了**（本机制落地前就在错）：`dbt/` 5 个文件停在 `d2de3b1` 两笔未投；`duckle/` 三个
README 还是 tarball 期；`deploy/data-compose.yml` 与 `deploy/duckle/entrypoint.sh` **从未投递过**。

**为什么不能照抄手工重复**：智能代理截断**间歇复现**（实测 9,324 / 9,502 / 11,341 B，同一次投递
可能连败 6 次、第 7 次才拿全）。单文件尚可人肉重试 7 次；乘上 20+ 个文件不可持续。**sha256 逐字节
断言是唯一能拦住半截文件的机制**——本次要做的正是把它从人肉执行收进程序。

## 裁决记录（本次）

投递单元取**「清单 + 就地核验同步 + 版本标记」**，**不取** `releases/<全SHA>/` + `current` 软链。
理由三条（全文见 SOP §E.6）：① 机器上有 **5 处目录内本地状态**（`deploy/.env`、`dbt/profiles.yml`、
`dbt/target/`、`dbt/logs/`、`dbt/.user.yml`），整目录换版会打断它们；② 软链方案要改
`deploy/data-compose.yml` 的两处 bind ⇒ 属**改架构**，须走「先经人同意 → 更新架构文档 → 再写代码」；
③ **本机无「docker 跟随软链 bind 源」的实测案例**，按「无案例不立标准」不立。

**R1a 触发条件**（满足其一即重议，届时按第 2 条的架构顺序走）：① 「整套半应用」**成为实际故障**；
② 清单条目增长到**手改清单不可行**。

## 架构先行

本次**不改** `docs/architecture.md`：服务拆分/拓扑/组件/存储/接口**一概不动**，compose 文件内容也
不变（变的只是「它怎么到机器上」）。变的是一条**投放程序**，其正典落点是 `deploy/data-plane-deploy-sop.md`
§E。⇒ 顺序：**先改 SOP §E 正文（冻结接口）→ 再落码**（同一 PR 内先出文档 commit，即 T0 = `e9229fb`）。

---

## 接口（T0 冻结）

**`deploy/data-plane-manifest.txt`** —— 静态，人维护，改消费面才动。三列，`#` 注释、空行忽略。
**目录条目 = 递归**（生成侧按 `git ls-files` 展开）。

**`deploy/data-plane.lock`** —— 派生，随 PR 提交。首行 `sha256-of-rest <hex>` = **其余部分**的 sha256
（自校验：lock 自身被截断时首行必对不上）；其后每行四列
`<文件 sha256> <仓内路径> <落地路径> <模式>`。

> **实现订正（对已批准计划的一处偏离，此处显式记下）**：计划原文写的是「`git ls-tree -r <SHA>`
> 展开目录、生成器带 `[SHA]` 参数」。**落成的是 `git ls-files --cached --others --exclude-standard`
> ——即锁「工作区」而非某个 commit，且不带 SHA 参数**（位置参数是 `rootDir`，仅供单测夹具用）。
> 理由：用法是「改动清单覆盖的任一文件 → 重跑生成器 → 提交」；若内容取自 `<commit>:<path>`，改完
> 文件后重跑取到的仍是**旧内容** ⇒ 守卫恒红、这条路永远追不上工作区，那个 SHA 参数**没有存在
> 意义**。顺带这也把 `dbt/target/`、`dbt/logs/` 这类**本地产物**挡在门外（它们在 `.gitignore` 里）。

**`scripts/lemeng/sync-data-plane.sh <全SHA> [--check]`**（机器上跑，POSIX sh）——四步：取 lock →
验 lock 自校验 → 逐条取件（同目录临时文件 → sha256 断言 → 补模式 → 原子 `mv -f`）→ **最后**写
`<检出>/.data-plane-revision`。

**输出契约**：每文件一行 `<状态> <落地路径> <期望 sha256> <实际 sha256>`（`OK`/`DRIFT`）；末尾
`SYNC_OK <n>/<n>` 或 `SYNC_DRIFT <n> mismatched`。失败字面量：`LOCK_FETCH_FAILED:` /
`LOCK_SELFTEST_FAILED:` / `FETCH_FAILED: <仓内路径>` / `REVISION_WRITE_FAILED:`。

## 波次

- **Wave 0（T0，文档先行）**：SOP §E 重写。落 `e9229fb`。
- **Wave 1（T1 ∥ T2，接口已在 T0 冻结、无共享文件）**：T1 = manifest + lock 生成器 + 守卫 + CI 接线
  + 守卫单测；T2 = 同步程序 + 其单测。
- **Wave 2（T3，真机，依赖全部）**：首次同步。

---

## T0 — SOP §E 重写（`e9229fb`）

`deploy/data-plane-deploy-sop.md`：§E 适用面从「唯一一例」改成 **7 条的完整消费面**并写清消费面
**怎么定的**（三条判据）；新增 §E.5 自举（`/opt/lemeng-sync.sh` 不在清单里，循环依赖，手工留档
三连 sha256）；§E.6 软链方案裁决 + R1a 触发条件；§E.7 openship cron 按 **UTC**；保留 §E.4 的截断
证据原文。

## T1 — 清单 + lock + 守卫

**文件：** `deploy/data-plane-manifest.txt`（新）、`deploy/data-plane.lock`（新）、
`scripts/lemeng/data-plane-lock.mjs`（新）、`scripts/check-data-plane-lock.mjs`（新）、
`scripts/check-data-plane-lock.test.ts`（新）、`.github/workflows/ci.yml`（`gates` 加一行）。

守卫三条判据：① lock 自校验；② lock ↔ 工作区一致（缺行/多行/sha256/落地路径+模式）；③ **消费面覆盖**
——提取脚本里每个 `$REPO/<路径>`，要求落在清单的落地路径集合里。失败信息**必须复述重生成命令**
（否则「有意的摩擦」会变成「无解的摩擦」）。

**判据 3 的边界（实测钉死，两条）**：

1. 只扫 `$REPO/<路径>` 形态。`$REPO/<路径>` 是脚本里**唯一**表达「我要读检出里那个文件」的形态
   （相对路径都锚在别处：容器内路径由 compose bind 喂，其**源**已被 `duckle/`/`dbt/` 条目覆盖）。
   宽口径扫描会把 `/pipelines/`、`/workspace/` 全误报。
2. **目录条目只做前缀命中，不做存在性检查**——这是**有意的边界**，不是漏判：判据问的是「这个引用
   有没有被清单覆盖」，不是「这个文件在不在」。加存在性检查反而误报，因为 `dbt/target/`、`dbt/logs/`
   这些**机器本地状态**正住在被 `dbt/` 覆盖的目录里，脚本合法引用它们是本机制要**保住**的行为。

**`REPO_REF_EXCLUSIONS`（三类机器本地物，各带理由）**：`deploy/.env`（运行时写入目标）、
`$REVISION_REL`、`.$REVISION_REL.tmp.$$`（后两条是同步程序**自己写出**的版本标记及其临时文件——
它们是投递的**产物**，不是投递物；仓里没有、也不该有对应文件）。

> ⚠️ **排除项匹配的是「从脚本正文里逐字剥出来的原文」，不是解析后的路径**。提取器是纯文本的
> （不解析变量赋值）：引用写成 `$REPO/$REVISION_REL` 时，`ref` 就是字符串 `'$REVISION_REL'`。
> 写「真路径」`.data-plane-revision` 在这里**匹配不上**——守卫失败信息里打印的那个串，才是要原样
> 抄进表里的那个串。这条已由一个夹具用例行为化钉住（删掉那两条排除项该用例必红）。

## T2 — 同步程序

**文件：** `scripts/lemeng/sync-data-plane.sh`（新）、`scripts/lemeng/sync-data-plane.test.sh`（新）。

- 沿用已证的落地法：**同目录**临时文件 → sha256 断言 → `chmod` → `mv -f`（跨目录 rename 不原子）。
  **禁止 truncate 原地写**。
- 取件失败重试至多 **10 次**（实测连败 6 次后第 7 次成功）。
- **断言必须在重试循环里面**——截断是「取到但内容不对」，不是「取不到」；放循环外就一次都不重试。
- **本脚本没有任何凭据**：raw.githubusercontent 按全 SHA **匿名可读**（2026-09-25 实测：匿名取回的
  文件与仓内那份 sha256 逐字节一致）⇒ 不持有、不读取、不回显任何 token。**别为了「万一要鉴权」
  加 token 参数**——那是把一个不需要的秘密引进数据面机。

### 本任务实测出的两个平台坑（都不是理论）

1. **bash 3.2 + UTF-8：`$VAR` 后面紧跟全角标点会被解析成更长的变量名。** macOS 的 `/bin/sh` 是
   bash 3.2.57，在 `LC_ALL=en_US.UTF-8` 下把 ≥0x80 的字节也当变量名字符 ⇒ `$SHA（` 被解析成变量
   `SHA（`（未定义，`set -u` 下当场死）。修法：**变量一律写 `${VAR}`**。本仓
   `.github/workflows/ci.yml` 的 main-guard 段已有同款留档；CI 跑 bash 5 所以只在本机咬人。
   检出探测器：`perl -ne 'print "$.: $_" if /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/' <file>`。
2. **`EXIT` trap 会吞掉致命退出码（bash 3.2 实测）。** 裸 `trap 'rm -rf "$_tmpdir"' EXIT` 的末条
   命令状态会成为 shell 的退出状态（`rm` 成功 = 0）⇒ 脚本里**每一处** `exit 1` 被悄悄改写成
   `exit 0`，「同步失败」在机器上表现为**报绿**——正是本机制要防的那类假绿，却被自己的清理动作
   制造出来。修法：`trap '_rc=$?; rm -rf "$_tmpdir"; exit "$_rc"' EXIT`，并给 INT/TERM 各一条固定码。

### 单测的设计要点

`sync-data-plane.test.sh`（54 例）**不打网络、不碰真机**：只换成假 `curl`，**哈希走真的**。
连 `sha256_of` 一起 stub 就把「取到的字节 → 断言」这条链整个短路了，测出来的只是「我调过一个假函数」。

**假 curl 的截断必须带 `exit 0`**（本文件最重要的一处设计）：真机上的假绿正是「HTTP 200 + curl
认为成功 + 内容是半截」。用例 I 钉这条——前 6 次给半截、第 7 次给全量，最终必须成功且落地的是
**全量**内容。

> ⚠️ **一处自伤过的陷阱**：`head -c N` 对**短于 N** 的文件是原样吐回 ⇒ 夹具若比截断长度还短，
> 「截断重试」用例就退化成「零次重试也过」的**空断言**。修法是夹具写长 + 一条 `assert_gt` 前置
> 断言兜住「夹具确实长于截断长度」。

---

## 验证

### 本地（波末全量，与 CI `gates` 同款）

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-data-models.mjs
pnpm exec tsx scripts/check-data-plane-lock.mjs
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm exec tsx scripts/check-tenant-isolation.mjs
bash scripts/check-dev-discipline.sh origin/main HEAD
```

**实测结果（本机 worktree，逐条如实记）**：

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` / `typecheck:scripts` | ✅ exit 0 |
| `pnpm run test:guard` | ✅ **10 files / 255 passed / 16 skipped**（含本次新增的 18 例） |
| 六个既有守卫 + `check-data-plane-lock` | ✅ 全 exit 0 |
| `check-tenant-isolation`（带 DATABASE_URL） | ✅ exit 0（3 模块 / 14 张表） |
| `check-dev-discipline.sh origin/main HEAD` | ✅ 通过 |
| `pnpm test` | ❌ **本 worktree 跑不绿**——原因见下，**与本次变更无关** |

**`pnpm test` 为何红（已定因，未被本次变更触及）**：

本 worktree 的检出路径含非 ASCII 段（`采集板块`）。`modules/aftersales/test-util.ts:59`（与
`modules/data/test-util.ts:53` 同款）把 `new URL('./migrations', import.meta.url).pathname` 交给
`runMigrations` ——**`.pathname` 保持百分号编码**（`%E9%87%87%E9%9B%86%E6%9D%BF%E5%9D%97`），
`readdir` 拿到的是一个**不存在的路径** ⇒ 命中 `apps/server/src/migrate.ts` 的
「目录不存在**静默跳过**」分支 ⇒ **迁移一个都没跑，却返回成功**。随后测试的第一条真实查询就报
`relation "aftersales.ticket_attachment" does not exist`。

实测证据（全新空库、只跑单个失败文件）：
`schema_migrations 行数=0`、`aftersales 表数=0` ——**迁移确实没跑**。
对照：`rawMigrationSqls()` 把 **URL 对象**交给 `readdir`/`readFile`，`fs` 会正确解码 ⇒ 同文件里
两种写法行为不同，正是这处不对称造成「有的用例过、有的用例炸」。

`apps/server` 的红是同一根因的另一形态（`pathToFileURL` 的百分号编码让 TS fixture 加载失败）。
CI 跑在 ASCII 路径上 ⇒ **这是潜伏缺陷，CI 一直是绿的**；只在非 ASCII 检出（含 Orca 的中文
worktree 目录）上现形。**已另开 issue 跟踪**（不在本次变更内修）。

### 真机（T3）

Step 2 → Step 4 的 `--check` 前/后对照 + 独立回读三连 sha256 相等 + `probe` 通过。**不跑 `windows`**
（写湖、约 18 分钟）。

---

## 交付纪律

- `feat` ⇒ 先开 issue（#199），PR body 用 `Closes #199`，**全篇不得出现第二条 `Closes/Fixes/Resolves`**。
- CHANGELOG 不手写；不删改 provenance trailer。

## 明写不做 / 另开 issue（不美化）

1. **`deploy/data-compose.yml:103` 的 `../dbt:/usr/app:ro` 与 SOP :168/:181「不带 `:ro`（dbt 要写
   target/logs）」自相矛盾**，且机器上 `dbt/target`、`dbt/logs` 已存在 ⇒ 生产挂载实际可写。
   **本次不解决**，另开 issue。
2. ~~`mytech-data-plane-prep` job 的 `serverId` 指向 WeKnora 机，不是数据面机；那台机的 checkout 像是
   游离物。**本次不动**，另开 issue。~~ —— **本条为假发现，已撤回（不开 issue；2026-09-25 复验）**。
   原判断错在**假设只有一台数据面机**。复验证据：`23a1091e` 机上跑着
   `openship-platform-core-data-metabase` / `-data-metabase-db` / `-data-pg_duckdb`
   ⇒ **它跑的是它自己的数据面**。该 job 指向的就是**与它名字相符的那台机**，那份 checkout 是该数据面的
   checkout、**不是游离物**。事实是**两台机各有一个数据面**（mytech 自己一台 + 山海交付一台）。
   ⚠️ 留此注记防复发：后来者别照抄本条去「找那个该开的 issue」——它不存在，且不该存在。
3. **自举例外**：`/opt/lemeng-sync.sh` 自身的更新仍需手工（循环依赖），SOP §E.5 已写明。
4. **命令长度上限**：同步经 MCP `exec` 传参，命令上限 10,000 字符。当前条目数充裕；增长到接近上限时
   的分批方案记**「待沉淀」**，不编。
5. **未验证即不声称**：本方案**没有** tarball/archive 通路（侦察实测 archive 经公网代理 1.84 MB /
   0.1 s 可用，但**本方案不用它**——它拿不到逐文件权威 sha256，且未验证整包截断行为）。
