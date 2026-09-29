# `loader.test.ts` 间歇 5s 超时：真因与修复（issue #310）

> 状态：已修，待合。分支 `fix/310-loader-test-flake`。
> 本文是**案例**（真因 / 判定实验 / 修复 / 耗时表 / 残留），不是标准。
> 复现配方见 §6，可原样重跑核对。

## 0. TL;DR

- `apps/server/src/loader.test.ts` 间歇 5s 超时的真因**不在测试里**，在 `migrate.ts`：
  每次 `runMigrations()` 都在**取全局 advisory lock + 跑建表 DDL 之后**才去看「这个模块到底有没有迁移文件」。
  于是**无事可做**的调用（模块没有 `migrations/`）也要排一次全库唯一的锁。
- 放大它的是 CI 的测试拓扑：`pnpm -r --if-present test` 让最多 **4 个 workspace 包并发**跑同一台 PG，
  而 `modules/{data,aftersales}/test-util` **直接 import** `apps/server/src/migrate` —— 四个包共用**同一把锁键**。
- 抢不到锁的一方按 `MIGRATION_LOCK_RETRY_INTERVAL_MS = 2000` **整量子**地睡，
  单用例耗时从 ~50ms 变成 2~4s（实测量子：2053 / 2139 / 4106ms），撞穿 vitest 的 5s 单测默认值。
- 修复三段：①**根因**——把列目录挪到取锁之前（`loader.test.ts` 35/37 个用例从此完全不碰锁）；
  ②**余量**——`loader.test.ts` 两个集成 suite 级 `timeout`/`hookTimeout` 15s；
  ③**同族兄弟包** `modules/data`、`modules/aftersales` 的 backend project 加同一条
  `testTimeout`/`hookTimeout` 15s（两包都有**实测失败案例**，不是预防性放宽）。
- 本机按 CI 拓扑复现：`loader.test.ts` 单用例 max **4106ms → 99ms**；连续 14 次有效跑全部通过（§4.1）。
- **这不是 `loader.test.ts` 独有的**——`modules/data` 的 vitest 配置里**早就自述过同一根因**
  （issue #169，2026-09-24，当时用「本包内串行」缓解）；本 PR 修的是那条缓解够不到的**跨包**那半。

## 1. 现象与硬证据（CI 侧）

issue 报的三次都在 2026-09-28，症状一致：`Error: Test timed out in 5000ms.`，**重跑即过**。

失败跑拿到的原文（run `36442845122`，job `unit`，15:21:25Z）：

```
apps/server test:  ❯ src/loader.test.ts (37 tests | 1 failed) 9045ms
apps/server test:      → Test timed out in 5000ms.
apps/server test:  FAIL  src/loader.test.ts > loadModules > happy path：装载 1 模块 + 迁移记账 + 权限 upsert + mount 后 /ping 通
apps/server test:  Error: Test timed out in 5000ms.
```

同一文件在**通过**的跑里也不便宜（run `36551459812`）：`✓ src/loader.test.ts (37 tests) 7429ms`。

关键对照——**本机隔离跑同一文件**：

| 场景 | 整文件 | 单用例 max |
|---|---|---|
| 本机 · 已迁移的库 | 430ms | 52ms |
| 本机 · 全新空库 | 470ms | 61ms |

**CI 比本机慢 16~19 倍**，而单用例本机只有 50ms。这个差距不是「机器慢」能解释的量级，
说明 CI 上有一个**本机隔离跑不存在的**开销。

## 2. 真因

### 2.1 机制

`loadModules()` 的步骤 ③ 无条件调用 `runMigrations(pool, manifest.id, dir)`（`loader.ts:330`）。
而 `runMigrations`（`apps/server/src/migrate.ts`）的**修改前**顺序是：

1. `pool.connect()`
2. **取 advisory lock**（`pg_try_advisory_lock(hashtext('platform.schema_migrations'))`）
3. **跑幂等 DDL**：`create schema if not exists platform; create table if not exists platform.schema_migrations(…)`
4. `readdir(dir)` —— **这里才发现目录不存在 / 没有 `.sql`** → `return []`
5. 读账本、逐个应用、记账
6. 放锁、归还连接

问题出在 2、3 与 4 的**顺序**：

- 锁键是**全库唯一**的（文件头明确写了「刻意**不**按 module 分键，一个键串行化所有模块的迁移」），
  目的是挡住「两个模块并发在全新库上建表」的 pg 系统目录竞态。
- 但「没有迁移文件」是**纯文件系统事实**，跟 DB 竞态毫无关系，却被排在取锁**之后** ——
  于是**每个无迁移模块都要排一次全库唯一的锁**。

抢不到锁的代价不是一个 RTT，而是**一个整量子**：`acquireMigrationLockBounded` 拿不到就
`await sleep(min(2000, remaining))` 再试（`MIGRATION_LOCK_RETRY_INTERVAL_MS = 2_000`）。
**所以等待时长天然落在 2000 / 4000 / 6000ms 这几档上**——这正是后文观测到的量子。

放大它的是 CI 的测试拓扑：

- `pnpm test` = `pnpm -r --if-present test`，pnpm 递归跑 workspace 包是**并发**的；
- `modules/data`（22 个测试文件）与 `modules/aftersales`（29 个文件，且**没有** `fileParallelism: false`）
  的 `test-util.ts` 都**直接 import** `../../apps/server/src/migrate` —— 同一份代码、**同一把锁**；
- 三方都在 `beforeAll`/用例里跑 `runMigrations`，于是同一台 PG 上互相排队。

`loader.test.ts` 有 37 个用例，几乎每个都调 `loadModules` —— 等于 37 次抢锁，
**每一次都可能撞上别包持锁的窗口**。

### 2.2 判定实验（一次只动一个变量）

| # | 变量 | 整文件 | 单用例 max | 结论 |
|---|---|---|---|---|
| B | 4 包并发 · **同一个**库（CI 拓扑） | **9696ms** | **4106ms** | 复现 |
| E1 | 4 包并发 · **各自不同的**库（CPU 负载不变） | 1287ms | 154ms | **不是 CPU 争抢** |
| E6 | 同文件**两份并发**（同一个库） | 414 / 436ms | 45 / 73ms | 迁移早已应用 ⇒ 持锁极短，自争用不显著 |

E1 是关键：**CPU 负载一模一样，只是把库分开**，整文件从 9696ms 掉到 1287ms（7.5×）。
⇒ 代价来自**共用的那台 PG**，不来自「4 个 vitest 进程抢 CPU」。

再把量子钉死。慢下来的耗时**反复落在 2000 的整数倍附近**：2053 / 2139 / 4106 / 2063 / 2020ms。
代码里唯一的 2000 常量就是 `MIGRATION_LOCK_RETRY_INTERVAL_MS`（已全仓 grep 排除其他候选）。

最后是**直接证据**——用 default reporter 跑（`--reporter=json` 会把 `console.warn` 吞掉，
第一轮排查就栽在这上面，见 §5）：

```
apps/server test: [migrate] 等待 migration advisory lock（platform.schema_migrations）…已被占 10ms；每 2000ms 重试，上限 60000ms
apps/server test: [migrate] 等待 migration advisory lock（platform.schema_migrations）…已被占 2ms；每 2000ms 重试，上限 60000ms
```

**`apps/server` 自己确实在等这把锁。** 机制闭合。

## 3. 修复

### 3.1 根因修复：`migrate.ts` 把「列目录」挪到取锁之前

`apps/server/src/migrate.ts`：先 `readdir` + 过滤 `.sql`，**没有文件就直接 `return []`**，
后面的 `pool.connect` / 取锁 / DDL / 查账本一概不跑。

- 语义不变：原本这条路也是「什么都不做、返回 `[]`」，只是白排了一次锁、白跑了一遍 DDL。
- 记账表由**确实有文件**的那次调用负责创建（platform 迁移与各模块的第一批迁移都算），
  不存在「跳过之后某次真迁移失去账本」。
- 对生产也是净收益：启动期为 N 个无迁移模块各排一次全库锁的开销直接归零
  （文件头那句「对无 `migrations/` 的模块零负担」原本只在「不报错」这一维成立，这次补成真的负担为零）。

**不动 `migrate.test.ts` 的语义**：`空目录：跑过且零 applied` 与 `目录不存在：静默跳过不抛`
断言的都是返回值 `[]`（仍然成立）；两条取锁用例（`取锁超时` / `取锁重试`）用的目录**都带
`001_*.sql`**，照常取锁。

效果（本机 CI 拓扑，同一套 4 包并发 + 全新库）：

| | 整文件 | 单用例 max |
|---|---|---|
| 修前 | 9696ms | 4106ms |
| 修后（3 轮） | 967 / 705 / 455ms | **99 / 78 / 66ms** |

### 3.2 余量：本文件级 15s（**不是**替代根因）

根因修完后仍有一个**合法**的取锁方：`happy path` 用例的 fixture **确实声明了迁移**
（`loader.test.ts:223`），它必须真的建表记账。在跨包并发下它仍可能吃到一个 2000ms 量子——
实测 runs 11/15 就分别出现 2133ms / 2096ms（且**仍在 5s 内通过**）。

而 CI 上这个数字要再乘上一个「CI 慢一档」的系数（整文件 16~19×）：
50ms 的自身开销 → ~0.8s，叠加 1~2 个量子（2~4s）就能摸到 5s。
**CI 上实际超时的那个用例，正是 `happy path`** —— 和这条推理完全对得上。

所以给这两个集成级 `describe` 显式写死 `timeout` / `hookTimeout = 15_000`：

- **作用域**：写在 `describe.skipIf(...)(name, options, fn)` 的 options 里，
  只覆盖本文件这两个 suite，**不动** `apps/server/vitest.config.ts`（那会波及同包其他文件）。
- **不是掩盖**：根因另有专门修复；15s 只兜「CI 慢一档 + 恰好撞上一个锁量子」，
  真卡死（例如锁被占满 `MIGRATION_LOCK_TIMEOUT_MS` 的 60s）**照样会红**。
- **该选项确实生效**（不靠类型定义猜）：临时把常量改成 `30` 再跑，
  失败信息逐字变成 `Test timed out in 30ms`（**3 处**），而不是默认的 5000ms；随后改回 `15_000`。

### 3.3 同族的兄弟包：`modules/data`、`modules/aftersales`

排查过程中发现**这不是 `loader.test.ts` 独有的**，而是「凡真的取迁移锁的集成套件」共有的暴露面。
两处都**不是本次改动引入的**（有对照证据），但都会被 CI 咬：

**`modules/data`** —— 该包 `vitest.config.ts` 里**早就自述过同一根因**（issue #169，2026-09-24）：

> 「迁移 advisory lock（固定 2s 重试）在 CI 4 核争用下单测偶发超 vitest 5s 默认超时
> （实测命中 agent-loop/mcp/query 等，重跑即绿——竞态签名）」

当时拍板的是**方案 A：本包内串行**（`fileParallelism: false`）——缓解了**包内**并行，
挡不住**跨包**那半（该注释自己也承认「会被本包的并行打库拖累（实测 loader.test.ts 超时与
mcp.test.ts 同期）」）。本 PR 的 #345 首轮 CI 就红在
`domain/report-store.test.ts > upsert 不带 renderer`（`Test timed out in 5000ms`）。

**这不是本 PR 引入的**——同一拓扑在本机跑 `origin/main` 的 `migrate.ts`（修前）对 `modules/data`：

| `modules/data` · 同一 4 包并发拓扑 · 全新库 | max | 失败 |
|---|---|---|
| 修前（origin/main，5 轮） | 10013 / 6141 / 4132 / 2162 / 2085ms | **1 次失败** |
| 修后（本分支，5 轮） | 4166 / 4014 / 2082 / 343 / 339ms | 0 |

⇒ 修前就红、修后**明显缓解但消不掉**（它的 `applyMigrations` 目录**真有** `.sql`，必须真取锁）。

**`modules/aftersales`** —— 本机全量 `pnpm test` 直接复现了它：
`module.test.ts > applyMigrations 幂等：连跑两次，第二次不新应用任何版本`（**连抢两次锁**）
⇒ `Error: Test timed out in 5000ms.`。它**没有** `fileParallelism: false`，
29 个文件并行打同一台 PG，是全仓三个包里最容易撞上的。

**处置**：对这两个包的 backend project 施加与 `loader.test.ts` **同一条**、同样写明理由的
`testTimeout` / `hookTimeout = 15_000`。范围止步于此——其余包（`packages/*`、`modules/demo`）
**没有**任何失败案例，按「无案例不立标准」不动。

> ⚠️ **配置坑（实测，值得记）**：在 `vitest.config.ts` 里这份超时**只有一种写法真的生效**——
> 写在 **project 的 `test` 块内**、键名 **`testTimeout`**。逐项设成 `1ms` 验证过：
> project 级写 `timeout`（错键名）⇒ 用例照样全绿（被静默忽略）；
> 根级写 `testTimeout`（用 `projects` 时**不下传**）⇒ 用例照样全绿；
> 只有 project 级 `testTimeout` 才会让失败信息变成 `Test timed out in 1ms`。
> 与 #169 那条「`fileParallelism` 必须写根级」恰好相反 —— **两类选项的层不一样**，别互相类推。

### 3.4 为什么没走「`beforeAll` 收敛共享初始化」

issue 的建议 (2) 是「若每用例重建 DB / 重跑迁移 ⇒ 用 `beforeAll` 收敛」。
实测后**没有采纳**，理由：

- `loader.test.ts` 的共享初始化（platform 迁移 + `seedDemo` + `MockCasdoor.start()`）
  **本来就在 `beforeAll` 里**，不在用例里；
- 剩下的 DB 动作是**每个用例各自要的**：每个用例写自己那套 fixture 模块目录，
  `loadModules` 必须为目标模块跑迁移——这是**被测行为本身**，不是可收敛的重复初始化；
- 真正「可避免的重复」是 §3.1 那条路径（无迁移模块也取锁），已在**源头**修掉，
  比在测试里绕开更彻底（生产同样受益）。

## 4. 验收

### 4.1 连续 15 轮（每轮：全新空库 + 4 包并发 = CI 拓扑）

每轮：`dropdb/createdb` → 同时起 `apps/server`(loader) + `modules/data` + `modules/aftersales` + `apps/web`。

| 轮 | 整文件 | 单用例 max | 失败 | 备注 |
|---|---|---|---|---|
| 1 | 560ms | 53ms | 0 | |
| 2 | 3002ms | 111ms | 0 | |
| 3 | 765ms | 87ms | 0 | |
| 4 | 848ms | 87ms | 0 | |
| 5 | 885ms | 70ms | 0 | |
| 6 | 830ms | 88ms | 0 | |
| 7 | 962ms | 68ms | 0 | |
| 8 | 574ms | 65ms | 0 | |
| 9 | — | — | — | **无效轮**，见 §5 |
| 10 | 411ms | 53ms | 0 | |
| 11 | 3274ms | 2133ms | 0 | 残留量子（`happy path` 真迁移） |
| 12 | 1178ms | 106ms | 0 | |
| 13 | 433ms | 67ms | 0 | |
| 14 | 409ms | 47ms | 0 | |
| 15 | 5145ms | 2096ms | 0 | 残留量子（同上） |

**14 次有效轮，0 失败，0 超时**；单用例最坏 2133ms，距 5000ms 默认值尚有 2.3× 余量，
距本文件写死的 15s 有 7× 余量。

> ⚠️ 本机是 M 系列 Mac，比 GHA `ubuntu-latest` 快得多。本表证明的是「**同一拓扑下的相对改善**
> 与「不再撞穿 5s」」，**不能**当作 CI 的绝对耗时承诺；绝对口径见 §4.3 的 CI 实测。

### 4.2 「为什么 5s 不够」——量化

```
5s 的来历      ：vitest 的**单测**默认值，假定用例是「纯 CPU、无外部依赖、毫秒级」。
本文件实际形态 ：集成级——真 PG（连接池 + 迁移 + 全库 advisory lock）
                + 真 HTTP MockCasdoor + 动态 import TS fixture。
自身开销       ：本机 50ms / 命中 2 个量子时 4106ms。
等待的量子粒度 ：2000ms（MIGRATION_LOCK_RETRY_INTERVAL_MS）——**一次抢不到就是 +2s**。
⇒ 5s 只够 2 个量子 + 一点点自身开销；第 3 次重试必然越界。
   在 CI（比本机慢 16~19×）上，自身开销就吃掉 ~0.8s，**1~2 个量子即触顶**。
⇒ 上限必须按「集成开销 + 至少 3 个锁量子」定，而不是按单测定。15s ≈ 自身开销 + 6 个量子。
```

### 4.3 CI 全绿

本机按 CI 的 unit job 口径全量跑通（全新库 `pr_ci`）：

- `pnpm test`：platform-sdk 69 / auth-core 117 / aftersales-mobile 67 / apps-web 55 /
  demo 3 / aftersales 220 / data 270 / **apps/server 221（17 文件）** / test:guard 299 —— 全通过；
- `pnpm typecheck`：EXIT=0；
- gates：`check-manifests` / `lint-architecture` / `check-compose` / `check-env-example` /
  `check-data-models` / `check-tenant-isolation` 全部 EXIT=0。

**远端 CI（PR #345，run `36560174447`）：unit / gates / web / smoke / discipline 全 pass。**
（main-guard 与 deploy 在 PR 上按设计 skip。）unit job 各包：

| 包 | Test Files | Tests | Duration |
|---|---|---|---|
| apps/server（含 `loader.test.ts`） | 17 passed | 221 passed | 42.56s |
| modules/aftersales | 29 passed | 220 passed | 35.45s |
| modules/data | 22 passed | 270 passed | 44.61s |
| test:guard（仓根 `scripts/`） | 13 passed | 299 passed | 8.58s |

> 首轮（`bc03044`，只有 `loader.test.ts` 那两处改动）unit **红**在 `modules/data`，
> 即 §3.3 那族兄弟 flake —— 那是既有问题、不是本 PR 引入的（对照见 §3.3）。
> 本表是补上 §3.3 两处配置后的复跑结果。

## 5. 残留与未决（**不隐藏**）

1. **残留量子仍在**：凡**真的**取锁的用例（`happy path`、`modules/data` 的 `applyMigrations`、
   `modules/aftersales` 的 `applyMigrations 幂等`）在并发下仍可能吃 1~2 个 2000ms 量子
   （实测 2133 / 2096 / 4166 / 10013ms）。这是**合法**取锁，本 PR 不消除它，只给三个包各留 15s 余量。
   两条**独立**的根治方向，都需要单独拍板（本 PR 不做）：
   - **锁粒度**：`platform.schema_migrations` 现在全库一个键。按 module 分键能消掉跨模块排队，
     但会动到「挡住全新库上**并发建表**竞态」的既定设计（`migrate.ts` 文件头有专门论证为什么
     「刻意不按 module 分键」）——那是**设计决定**，不是顺手能改的。
   - **重试量子**：`MIGRATION_LOCK_RETRY_INTERVAL_MS = 2000` 是固定间隔，所以等待天然量化成
     2s 的整数倍。改成「50ms 起、指数退避、封顶 2000ms」能让等待者在锁释放后 ~50ms 内拿到锁
     （把量子从 2000ms 压到 ~50ms），60s 上限与告警节流都不变（重试更密但告警按
     `LOCK_WARN_EVERY_N_ATTEMPTS` 节流，实测告警条数反而更少）。代价是**改生产常量与部署期取锁行为**，
     故留给协调者定夺。
2. **第 9 轮无效**：该轮 `apps/server` 的 `beforeAll` 失败（文件 status `failed`、
   35 个用例 skipped、D9 suite 2 个通过），**失败原文丢失**——当时只挂了 `--reporter=json`，
   而它不落 `console.warn`/错误正文（§2.2 末尾那条坑）。随后按同一脚本重跑该轮**通过**，
   再补跑的 5 轮（11–15）也全部通过；所有轮次的输出里**没有**连接/认证类报错
   （`too many clients` / `ECONNREFUSED` 等，已 grep 全轮输出），PG `max_connections=100`、
   空闲期占用 6。**结论：观察到 1 次未复现的 `beforeAll` 失败，机制未查明**，按「无案例不立标准」
   如实登记，不编解释。下一轮若再现，**第一件事是加 default reporter 留下原文**。
3. **`migrate.test.ts` 自身**有两条并发用例**按设计**各花 ~2000ms（等一个重试量子）。
   它们不在本 issue 的报障范围内，本 PR 未动；但同属「量子粒度」的暴露面，登记在此。

## 6. 复现配方（可原样重跑）

```sh
# ① 全新空库（不带 DATABASE_URL 时本文件整体 skip，别拿旧库冒充「全新」）
PGPASSWORD=platform psql -h 127.0.0.1 -U platform -d platform \
  -c 'drop database if exists pr_repro' -c 'create database pr_repro'

# ② 摆出 CI 的拓扑：4 个包并发打**同一个**库
export DSN='postgres://platform:platform@127.0.0.1:5432/pr_repro'
( cd apps/server && DATABASE_URL="${DSN}" npx vitest run src/loader.test.ts \
    --reporter=default --reporter=json --outputFile=/tmp/s.json >/tmp/s.out 2>&1 ) &
( cd modules/data       && DATABASE_URL="${DSN}" npx vitest run --passWithNoTests >/tmp/d.out 2>&1 ) &
( cd modules/aftersales && DATABASE_URL="${DSN}" npx vitest run --passWithNoTests >/tmp/a.out 2>&1 ) &
( cd apps/web           && npx vitest run >/tmp/w.out 2>&1 ) &
wait

# ③ 看量子 + 看锁告警（**必须带 default reporter**，json 会吞掉 console 输出）
grep -a 'migration advisory lock' /tmp/s.out
node -e "const f=require('/tmp/s.json').testResults[0];console.log('wall',Math.round(f.endTime-f.startTime))"

# ④ 对照组：把三个 DB 包的 DSN 换成**另一个**库，CPU 负载不变 ⇒ 应回落到 ~1.3s
```

对照「修前」可 `git stash` 掉本 PR 的 `migrate.ts` 改动后重跑 ②。
