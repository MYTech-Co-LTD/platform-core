# 售后 M2b 数据迁移整期 + 孤儿附件 GC（issue #151）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 wuji 托管库的 13.2 万行售后域数据一次性、幂等地迁入 `aftersales.*`（拉取→清洗→入库→计数/金额对账），并补上孤儿附件的 GC 全链（`deleteObject` + manage 面端点 + openship job 触发）。

**Architecture:** 两件相互独立的事。**GC** 是模块内新增一条 manage 面端点（`POST /attachments/gc`，manifest 声明 + 装载期双向核对），核心是「行锁先行的单行事务」：`SELECT … FOR UPDATE`（谓词含 `ticket_id is null`）→ 删对象 → 删行；崩溃后重跑安全（S3 delete 对不存在 key 幂等 204）。**迁移**是「CLI 薄壳 + 纯核可测」范式（照 `scripts/migrate-tenant-module-to-subs.mjs`）：纯核（拉取/清洗/导入/对账）落在 `modules/aftersales/migration/`（真 TS + 模块 vitest），CLI 落在 `scripts/migrate-aftersales-wuji.mjs`（默认 dry-run，`--apply` 才写库）；幂等位是各表既有的 `(org, source_id)` 部分唯一索引。

**Tech Stack:** TypeScript / PostgreSQL（`pg`）/ zod / Hono（GC 端点）/ `@aws-sdk/client-s3`（`DeleteObjectCommand`）/ vitest；迁移 CLI 跑 tsx。

**Spec:** `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`（已含 2026-09-22 四条拍板注记：§2.1 历史附件不迁行、§2.1 department 移出、§5 #12 GC 触发机制、§3.1 M-T8-3 移出→#155）

**编排侧材料（未进仓，派发 spec 里随附）**：范围摸底 `issue-151-scope.md`（数据源/目标表/GC/依赖/体量，2026-09-22）；裁决全文 `ledger-fixes.md`「#150/#151 启动前裁决」节（2026-09-22 全部人已拍）。两者在编排者的 worktree 本地（`.superpowers/sdd/` 不受 git 跟踪）——worker 看不到时找编排者要，别按本计划的转述二次脑补。

---

## Global Constraints

每条都是**项目级**要求，隐含在**每一个**任务里。

1. **历史附件不迁行**（2026-09-22 拍板，spec §2.1 注记）：`ticket_attachment` **只装新 ZOS 附件**——源 `damage_images`（无极 COS URL）在清洗层**整字段丢弃**，不进任何表。COS URL 进 `object_key` 会被 ZOS presign 签错桶；历史附件在无极系统查看，外链展示另立题。
2. **`department` 不建不迁**（2026-09-22 拍板）：14 张源表里没有部门表，无源可迁。本计划**任何迁移文件里都不出现 department**。
3. **GC 触发 = openship job 定时打 manage 面端点**（2026-09-22 拍板，spec §5 #12 注记）：端点须 manifest 声明 + 门卫双核对（AGENTS 硬约束 1/2）⇒ **manifest 与路由必须同一提交对齐**（装载期双向核对，差一个方向就是起不来，不是告警）。N 天值/宽限/dry-run 由本计划定（见 T1：`olderThanDays` 缺省 7、`dryRun` 缺省 **true**、批量上限 1000；**不设软删阶段**——孤儿行只可能被 `client_request_id`（sessionStorage 生命周期）认领，7 天阈值本身就是宽限）。
4. **M-T8-3 不在本计划**（2026-09-22 拍板）：`/rules` `/employees` `/stores` 回 total 已拆独立 issue **#155**（API 扩面，非数据迁移）。本计划**不改任何既有端点的响应形状**。
5. **金额整数分 + 单位解释唯一处**：目标表金额一律 `_minor` 整数分（spec §2.1）。工单域源值是「元带分精度」（§2.4 源码实证）⇒ 换算**只**在 `clean.ts` 的 `yuanToMinor` 一处；**接龙域单位未经数据自证禁猜**（§5 #7②）⇒ `groupbuyToMinor` 在 `setGroupbuyUnit` 之前一律抛错（T3 拉样自证/客户答复后才许设）。
6. **org 隔离键**：模块每张租户数据表带 `org text not null`（值 = `identity.orgId`），读写一律 `where org = $1`；唯一索引一律含 org（`scripts/check-tenant-isolation.mjs` 门禁 + 正典 `docs/module-protocol.md`）。迁移脚本导入的所有行 org = CLI `--org` 参数（单租户交付：一个源客户 → 一个租户）。
7. **迁移幂等**（团队规则 `db-migration`）：新迁移文件全 `if not exists` / `add column if not exists`；DML 用 `on conflict (org, source_id) where source_id <> '' do update`（部分唯一索引的 conflict target 必须带 WHERE 谓词）；部署脚本每次全量重跑全部迁移，`modules/aftersales/module.test.ts` 的 rawMigrationSqls 直跑两遍用例自动覆盖新文件。
8. **B1 三同纪律**：`modules/aftersales/` 只许引用 `aftersales.*` schema（`scripts/lint-architecture.mjs` 在 CI `gates` job、**PR 事件也跑**）。迁移纯核放在模块内正是为了这条；CLI 薄壳在 `scripts/`（不在 B1/B8 扫描根 `apps/ packages/ modules/` 内），但同样只碰 `aftersales.*`。
9. **export 值/类型分行**（#44 生产事故）：桶文件（`export { X }`）里绝不混 `interface`/`type`；模块内新文件引类型一律 `import type`。
10. **提交纪律**：本计划的实施 PR 一律 `Closes #151`（issue 已在，feat/fix 必须先有 issue）；一切可见变更走 PR、只等 CI **CLEAN**；CHANGELOG 禁手写；**B7 不动 `deploy/docker-compose.yml`**；wuji/ZOS/机器人账号等敏感值只落 openship env(isSecret)，**绝不进仓库/文档/日志/提交信息**（`.env.example` 只写键名与取法）；运维操作（备份/env 物化/job 注册/生产验证）一律走 openship MCP。

---

## 开工前置——外部输入四项（编排者管，不是 worker 的步骤）

> ⚠️ **这四项不是任务正文里的"待办"**——它们是**人给的输入**。哪项没到位，对应任务就**派不得**（派了也会停在第一个 gate 步）。计划正文里每个 gate 步都会回指这里的编号。

| # | 外部输入 | 谁给 | 给了之后解锁什么 | 没给卡住什么 |
|---|---|---|---|---|
| ① | **wuji `appid` + 9 张表的 `schemakey`**（表清单见 §常用命令的 env 键） | 人从 wuji 后台「数据源管理」逐表取，落 **openship env(isSecret)**（本地临跑则临时 export，绝不落盘） | T3 拉样（进而 T4 的 DDL 定形、T5 的全量拉取） | T3/T4/T5 全部；T1/T2 不受影响 |
| ② | **业务空闲窗口排期**（一次性快照策略，spec §3.3 已拍板） | 人与客户定 | T5 的 `--apply` 真跑 | 只卡 T5 的写库步；T5 的 dry-run 预跑不需它 |
| ③ | **archive_* 的实测样本** | 不是直接给——是 **①到位后 T3 拉出来的** | T4 的 `005_archive.sql` 字段定形与接龙清洗 | T4（DDL 照猜写是当初把 archive_* 推到 M2b 的原因，别倒退） |
| ④ | **接龙金额单位自证结论**（`group_buying_order.total_amount`/`price` 是分是元） | 首选**数据自证**（T3 拉样看量级/非整百值）；证不出 → 人问客户 | T4 的接龙清洗、T5 的 archive 导入 | 同上；**禁猜**是裁决，`groupbuyToMinor` 未设单位直接抛错 |

派发前另两件事（团队记忆）：**先 `git fetch origin main`**（Orca `--base-branch main` 取本地 ref，长期 worktree 会脱节）；**worktree 路径必须 ASCII**（中文路径打挂 vitest 的 TS fixture 加载）。

---

## 文件结构与派发表

### 新建 / 修改的文件（全量）

| 文件 | 职责 | 任务 |
|---|---|---|
| `modules/aftersales/storage.ts` | `ZosStorage.deleteObject` + 构造器可注入 client（仅测试） | T1 |
| `modules/aftersales/domain/attachment-gc.ts` | GC 纯核（扫描 / 单行事务 / 编排聚合） | T1 |
| `modules/aftersales/routes/attachment.ts` | `registerAttachmentGc`：`POST /attachments/gc` | T1 |
| `modules/aftersales/manifest.yaml` | 加 1 条声明（与路由同一提交） | T1 |
| `modules/aftersales/index.ts` | 注册 GC 路由 | T1 |
| `modules/aftersales/storage.test.ts` | deleteObject 命令形状断言 | T1 |
| `modules/aftersales/domain/attachment-gc.test.ts` | GC 纯核（真库 + 桩 resolver/deleter） | T1 |
| `modules/aftersales/routes/attachment-gc.test.ts` | 端点行为（400 / 503 / dry-run 缺省） | T1 |
| `modules/aftersales/migration/wuji-source.ts` | 拉取层（分页/count/maxMtime，fetch 可注入） | T2 |
| `modules/aftersales/migration/clean.ts` | 清洗层（单位/词表/拼写归一唯一处 + 各表映射） | T2（T3/T4 扩） |
| `modules/aftersales/migration/import.ts` | 导入层（幂等 upsert + FK 解析 + 二义洗清） | T2（T4 扩 archive） |
| `modules/aftersales/migration/reconcile.ts` | 对账（计数 + 金额和） | T2 |
| `modules/aftersales/migration/fixtures.ts` | 测试夹具（W1 按 spec 实证表编造；T3 脱敏真样本替换） | T2（T3 替换） |
| `modules/aftersales/migrations/004_employee_approval_source_id.sql` | employee_approval 补幂等位 | T2 |
| `modules/aftersales/migration/wuji-source.test.ts` / `clean.test.ts` / `import.test.ts` / `reconcile.test.ts` | 纯核单测 | T2 |
| `modules/aftersales/vitest.config.ts` | backend include 加 `migration/**` | T2 |
| `scripts/migrate-aftersales-wuji.mjs` | CLI 薄壳（默认 dry-run + `--apply` + 拉样模式） | T2 |
| `.env.example` | wuji 11 个键（文档化键面） | T2 |
| `.gitignore` | `modules/aftersales/migration/samples-local/`（原始样本永不进 git） | T2 |
| `modules/aftersales/migration/samples-local/`（gitignored） | 拉样落盘目录（含客户 PII，仅本地） | T3 |
| `modules/aftersales/migration/SAMPLE-NOTES.md` | 拉样核对清单结论 + 接龙单位自证结论（脱敏） | T3 |
| `modules/aftersales/migrations/005_archive.sql` | `archive_order(_item)`（字段按 T3 样本定形） | T4 |
| `modules/aftersales/module.test.ts` | 表清单断言扩到 archive 两张 | T4 |
| `docs/superpowers/specs/2026-09-15-aftersales-module-design.md` | §5 #12 / §3.4 落地状态注记 + §7 修订记录一行 | T5 |

### 波次与依赖

| 波 | 任务 | 并行度 | 依据 |
|---|---|---|---|
| **W1** | **T1（GC 全链）∥ T2（迁移脚本骨架）** | 两路并行 | 文件面零交集（T1: storage/routes/manifest/index；T2: migration/ + scripts + env/gitignore/vitest.config） |
| **W1g**（gate：外部输入①） | **T3（拉样+自证）→ T4（archive DDL+接龙清洗）** | 串行 | T3 用 T2 的 `wuji-source.ts` + CLI 拉样模式；T4 的 DDL 依赖 T3 样本（外部输入③④同源解锁） |
| **W2**（gate：外部输入②） | **T5（真跑+对账+幂等重跑+收尾）** | 单独 | 依赖 T2+T4 全合并、窗口排期、openship env 物化、备份先行 |

Orca 派发（W1 两路连发；W1g/W2 用 `--deps` + gate 说明）：

```bash
# W1：两个独立任务，一次连发
orca orchestration task-create --spec "<T1 spec：GC 全链，见计划 Task 1>" --json
orca orchestration task-create --spec "<T2 spec：迁移脚本骨架，见计划 Task 2>" --json
# 记 task_id 后一次连发两个 worker-start（= 并行）；--name 用 ASCII 短名
orca orchestration worker-start --task <t1> --worktree new-top-level --name m2b-gc      --agent claude --setup run --json
orca orchestration worker-start --task <t2> --worktree new-top-level --name m2b-migcore --agent claude --setup run --json

# W1g：T3 等 T2 合并 + 外部输入①到位才派；T4 等 T3
orca orchestration task-create --spec "<T3 spec：拉样，gate=外部输入①>" --deps '["<t2 task_id>"]' --json
orca orchestration task-create --spec "<T4 spec：archive DDL>" --deps '["<t3 task_id>"]' --json

# W2：T5 等 T4 合并 + 外部输入②（窗口）才派
orca orchestration task-create --spec "<T5 spec：真跑迁移，gate=外部输入②>" --deps '["<t2 task_id>","<t4 task_id>"]' --json
```

> ⚠️ 派发前 `git fetch origin main`（本地 ref 脱节会给 worker 旧基线）；每波末跑**全量**验证（见下），不只跑本任务那几条。

---

## 常用命令（全计划通用，照抄 CI）

```bash
# 模块
pnpm --filter aftersales test
pnpm --filter aftersales typecheck

# 全仓门禁（每波末必跑；CI gates job 同款）
pnpm typecheck
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm test
```

> 带库用例：`DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（本地 compose pg；**不带时相关 describe 静默 skip**——skip 不等于通过，收尾前必须带 env 跑一次）。T2/T4 的 import/reconcile 用例是**写库型**测试，建议在全新空库上先跑一轮（`dropdb platform && createdb platform`，团队记忆：迁移/并发类问题只在空库暴露）。
>
> 迁移 CLI（T2 产物）：`npx tsx scripts/migrate-aftersales-wuji.mjs --org <casdoor_org> [选项]`；wuji env 键 = `WUJI_APPID` / `WUJI_DATA_ORIGIN`（默认 `https://data.wujisite.com`）/ `WUJI_KEY_<大写表名>`（9 张表，清单在 `.env.example`）。

---

# W1 — 两路并行

### Task 1: 孤儿附件 GC 全链（deleteObject + manage 端点 + manifest + 测试）

**为什么先做且可立即做**：GC 与源数据零依赖（生产基线 `ticket_attachment` 0 行，spec §5 #12 实测），是 issue #151 里唯一不等人给输入就能落地的半边。触发机制已拍板为「openship job 打 manage 端点」⇒ 本任务交付端点；job 的注册在 T1 合并部署后做（Step 9）。

**Files:**
- Modify: `modules/aftersales/storage.ts`（import `DeleteObjectCommand`；`ZosStorage` 构造器加可选 `client` 注入位；新增 `deleteObject`）
- Create: `modules/aftersales/domain/attachment-gc.ts`
- Modify: `modules/aftersales/routes/attachment.ts`（新增 `registerAttachmentGc`，既有两段不动）
- Modify: `modules/aftersales/manifest.yaml`（api.internal 加 **1 条**）
- Modify: `modules/aftersales/index.ts`（import + 注册）
- Test: `modules/aftersales/storage.test.ts`（追加 describe）
- Test: `modules/aftersales/domain/attachment-gc.test.ts`
- Test: `modules/aftersales/routes/attachment-gc.test.ts`

**Interfaces:**
- Consumes: 既有 `storageFor` / `storageCandidatesFor` / `storageResolverFor` / `ZosStorage`（`storage.ts`）；`TENANT_STORAGE`（`@platform/sdk`）；`buildTestApp` / `makeIdentity` / `applyMigrations`（`test-util.ts`，第 4 参注入存储配置）
- Produces:
  - `ZosStorage.deleteObject(key: string): Promise<void>`（S3 delete 对不存在 key 幂等 204 ⇒ GC 重跑安全）
  - `domain/attachment-gc.ts`：

```ts
export const GC_DEFAULT_OLDER_THAN_DAYS = 7
export const GC_DEFAULT_LIMIT = 200
export const GC_MAX_LIMIT = 1000

export interface GcCandidate { id: string; objectKey: string; storageRef: string; createdAt: Date }
export interface GcReport {
  dryRun: boolean
  scanned: number
  eligible: number            // 过了「未认领 + 超 N 天」筛的行数（dry-run 的 would-delete）
  deletedObjects: number
  deletedRows: number
  skippedUnresolved: { id: number; storageRef: string }[]   // storage_ref 解析不出桶（配置换过）⇒ 行保留
  errors: { id: number; error: string }[]                    // 删对象失败 ⇒ 行保留，下一轮重试
}
export interface GcDeps {
  pool: Pool
  org: string
  resolver: (ref: string) => ZosStorage | null
  deleter: (s: ZosStorage, key: string) => Promise<void>    // 注入位：路由传真实现，测试传记录桩
}
export interface GcOptions { olderThanDays: number; dryRun: boolean; limit: number }

export async function selectGcCandidates(pool: Pool, org: string, olderThanDays: number, limit: number): Promise<GcCandidate[]>
export type GcSingleResult =
  | { outcome: 'deleted' } | { outcome: 'claimed' } | { outcome: 'unresolved' }
  | { outcome: 'error'; message: string }
export async function gcSingleAttachment(
  client: PoolClient, org: string, cand: GcCandidate,
  resolver: GcDeps['resolver'], deleter: GcDeps['deleter'],
): Promise<GcSingleResult>
export async function runAttachmentGc(deps: GcDeps, opts: GcOptions): Promise<GcReport>
```

  - 端点：`POST /attachments/gc`（`aftersales:manage`），body `{ olderThanDays?: 1..3650, dryRun?: boolean, limit?: 1..1000 }`，缺省 `{ 7, true, 200 }`——**破坏性操作安全缺省是 dry-run**，生产 job 显式传 `dryRun:false`。回包 = `GcReport`。

**删除顺序的裁决（写死在实现里，别"优化"）**——两个方向的安全性都要看：
- ① **行锁先行**：`SELECT … FOR UPDATE` 且谓词含 `ticket_id is null`。若此刻行已被认领（提交工单挂上了 ticket_id）⇒ 放弃，**绝不能删已挂在活工单上的附件的对象**。
- ② **对象删除夹在 BEGIN/COMMIT 之间**：对象删失败 ⇒ ROLLBACK 行保留，下一轮重试；删完对象进程崩 ⇒ 事务回滚行保留，下一轮「再删一次对象」（幂等 204）再删行 ⇒ **重跑安全**。代价是 FOR UPDATE 行锁横跨一次 S3 网络调用（批量上限 1000、每行 ~100ms ⇒ 最坏 ~2min）——维护型端点可接受。
- **不设软删阶段**（全局约束 3）：孤儿行只可能被 `client_request_id`（sessionStorage 生命周期）认领，`olderThanDays` 阈值本身就是宽限。

- [ ] **Step 1: 写失败的测试（domain 纯核，断言级红）**

`modules/aftersales/domain/attachment-gc.test.ts`：

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import { ZosStorage } from '../storage'
import { gcSingleAttachment, runAttachmentGc, selectGcCandidates } from './attachment-gc'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-aftersales-gc'

const TENANT_CFG: TenantStorageConfig = {
  kind: 's3', endpoint: 'https://zos.tenant.test', region: 'xinan1',
  bucket: 'tenant-b1', accessKeyId: 'AKIATENANT', secretAccessKey: 'sk-tenant',
}
const PLATFORM_CFG: TenantStorageConfig = {
  kind: 's3', endpoint: 'https://zos.platform.test', region: 'xinan1',
  bucket: 'platform-b0', accessKeyId: 'AKIAPLAT', secretAccessKey: 'sk-plat',
}
const TENANT_REF = storageRefOf(TENANT_CFG)

/** 造一颗附件行。ageDays 回拨 created_at（GC 判龄靠它）；ticketId 非 null = 已认领。 */
async function seed(pool: Pool, key: string, ref: string, ageDays: number, ticketId: number | null = null): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `insert into aftersales.ticket_attachment(
       org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid, storage_ref, created_at)
     values ($1, $2, $3, $4, 'image/jpeg', 1, 'openid-x', $5, now() - ($6::int * interval '1 day'))
     returning id`,
    [ORG, ticketId, `cr-${key}`, `aftersales/${ORG}/${key}/u`, ref, ageDays],
  )
  return Number(r.rows[0].id)
}

/** 认领一颗附件（挂到 ticket 上）——需要一张真 ticket 行（FK）。 */
async function claim(pool: Pool, attachmentId: number): Promise<void> {
  const t = await pool.query<{ id: string }>(
    `insert into aftersales.ticket(org, source_id, code) values ($1, $2, 'AS-T') returning id`,
    [ORG, `src-${attachmentId}`],
  )
  await pool.query(`update aftersales.ticket_attachment set ticket_id = $2 where org = $1 and id = $3`,
    [ORG, Number(t.rows[0].id), attachmentId])
}

describePg('孤儿附件 GC（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  /** 记录桩：每颗被"删"的对象 (bucket, key)。 */
  const deleted: string[] = []
  const deleter = async (s: ZosStorage, key: string) => { deleted.push(`${(s as unknown as { config: { bucket: string } }).config.bucket}|${key}`) }
  /** resolver 按行上的 storage_ref 归桶（'' = 平台桶时代旧行，与读侧同语义）。 */
  const resolver = (ref: string): ZosStorage | null =>
    ref === '' ? new ZosStorage(PLATFORM_CFG) : ref === TENANT_REF ? new ZosStorage(TENANT_CFG) : null

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
    await pool.query('delete from aftersales.ticket where org = $1', [ORG])
    deleted.length = 0
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from aftersales.ticket where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('selectGcCandidates：只挑「未认领 + 超 N 天」，按 created_at 升序', async () => {
    await seed(pool, 'old-a', TENANT_REF, 8)
    await seed(pool, 'old-b', '', 30)
    await seed(pool, 'young', TENANT_REF, 6)          // 未超 7 天
    const claimedId = await seed(pool, 'claimed', TENANT_REF, 8)
    await claim(pool, claimedId)                       // 已认领 ⇒ 不算孤儿
    const cands = await selectGcCandidates(pool, ORG, 7, 100)
    expect(cands.map((c) => c.objectKey)).toEqual([
      `aftersales/${ORG}/old-b/u`,                     // 30 天 < 8 天 ⇒ 升序在前
      `aftersales/${ORG}/old-a/u`,
    ])
  })

  it('dryRun：只报告不动手——行全在、deleter 零调用', async () => {
    await seed(pool, 'old-a', TENANT_REF, 8)
    await seed(pool, 'old-b', '', 30)
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter }, { olderThanDays: 7, dryRun: true, limit: 100 })
    expect(report).toMatchObject({ dryRun: true, scanned: 2, eligible: 2, deletedObjects: 0, deletedRows: 0 })
    expect(report.skippedUnresolved).toEqual([])
    expect(deleted).toEqual([])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(2)
  })

  it('apply：删对象+删行；resolver 按行上的 ref 归桶（空串=平台桶）', async () => {
    await seed(pool, 'old-a', TENANT_REF, 8)
    await seed(pool, 'old-b', '', 30)
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter }, { olderThanDays: 7, dryRun: false, limit: 100 })
    expect(report).toMatchObject({ dryRun: false, deletedObjects: 2, deletedRows: 2 })
    expect(deleted.sort()).toEqual([
      `platform-b0|aftersales/${ORG}/old-b/u`,
      `tenant-b1|aftersales/${ORG}/old-a/u`,
    ].sort())
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(0)
  })

  it('ref 解析不出桶 ⇒ skippedUnresolved、行保留（删错桶=白删，宁可不动）', async () => {
    await seed(pool, 'ghost', 's3|https://zos.gone.test|gone-b', 8)
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter }, { olderThanDays: 7, dryRun: false, limit: 100 })
    expect(report.deletedObjects).toBe(0)
    expect(report.skippedUnresolved).toEqual([{ id: expect.any(Number), storageRef: 's3|https://zos.gone.test|gone-b' }])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })

  it('gcSingleAttachment：行已被认领 ⇒ claimed，对象零动作', async () => {
    const id = await seed(pool, 'late', TENANT_REF, 8)
    await claim(pool, id)   // 扫描之后、单行处理之前被认领——正是行锁重查要挡的竞态
    const client = await pool.connect()
    try {
      const r = await gcSingleAttachment(client, ORG,
        { id: String(id), objectKey: `aftersales/${ORG}/late/u`, storageRef: TENANT_REF, createdAt: new Date() },
        resolver, deleter)
      expect(r).toEqual({ outcome: 'claimed' })
    } finally { client.release() }
    expect(deleted).toEqual([])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })

  it('deleter 抛错 ⇒ error、行保留（回滚，下一轮重试）', async () => {
    await seed(pool, 'bad', TENANT_REF, 8)
    const boom = async () => { throw new Error('S3 down') }
    const report = await runAttachmentGc({ pool, org: ORG, resolver, deleter: boom }, { olderThanDays: 7, dryRun: false, limit: 100 })
    expect(report.errors).toEqual([{ id: expect.any(Number), error: 'S3 down' }])
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })
})
```

> 测试桩里 `(s as unknown as { config: { bucket: string } }).config.bucket` 是**桩的内省**，不是产品代码反射——`ZosStorage.config` 是 `private readonly`，测试要 bucket 名只有这一条路（或换成把 bucket 并进 deleter 记录；两种都可，别为此把 config 改成 public）。

- [ ] **Step 2: 跑测试，确认失败**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test domain/attachment-gc.test.ts`
Expected: FAIL —— `Cannot find module './attachment-gc'`

- [ ] **Step 3: 写实现（domain 纯核）**

`modules/aftersales/domain/attachment-gc.ts`：

```ts
// attachment-gc.ts — 孤儿附件 GC（spec §5 #12；拍板：openship job 定时打 manage 面端点触发）。
//
// 孤儿 = ticket_attachment.ticket_id is null 的行：预签名先于工单落库，行先落在 client_request_id
// 上（spec §2.3）；访客传图未提交/提交失败放弃 ⇒ 行与桶对象永存。2026-09-16 上线后验证实测：
// 此前模块无任何删除路径。GC 由 DB 行驱动（对象 key 不含工单信息，只能由行的 object_key 反查，
// spec §5 #12）——不做桶侧 ListObjects 对账。
//
// 删除顺序（见计划 Task 1 的裁决，勿"优化"）：行锁先行（FOR UPDATE + ticket_id is null 谓词）
// → 删对象（夹在事务里，失败即回滚）→ 删行 → COMMIT。崩溃后重跑安全（S3 delete 幂等 204）。
import type { Pool, PoolClient } from 'pg'
import type { ZosStorage } from '../storage'

export const GC_DEFAULT_OLDER_THAN_DAYS = 7
export const GC_DEFAULT_LIMIT = 200
export const GC_MAX_LIMIT = 1000

export interface GcCandidate { id: string; objectKey: string; storageRef: string; createdAt: Date }
export interface GcReport {
  dryRun: boolean
  scanned: number
  eligible: number
  deletedObjects: number
  deletedRows: number
  skippedUnresolved: { id: number; storageRef: string }[]
  errors: { id: number; error: string }[]
}
export interface GcDeps {
  pool: Pool
  org: string
  resolver: (ref: string) => ZosStorage | null
  deleter: (s: ZosStorage, key: string) => Promise<void>
}
export interface GcOptions { olderThanDays: number; dryRun: boolean; limit: number }

export async function selectGcCandidates(
  pool: Pool, org: string, olderThanDays: number, limit: number,
): Promise<GcCandidate[]> {
  const r = await pool.query<{ id: string; object_key: string; storage_ref: string; created_at: Date }>(
    `select id, object_key, storage_ref, created_at
       from aftersales.ticket_attachment
      where org = $1 and ticket_id is null
        and created_at < now() - ($2::int * interval '1 day')
      order by created_at asc
      limit $3`,
    [org, olderThanDays, limit],
  )
  return r.rows.map((row) => ({
    id: row.id, objectKey: row.object_key, storageRef: row.storage_ref, createdAt: row.created_at,
  }))
}

export type GcSingleResult =
  | { outcome: 'deleted' } | { outcome: 'claimed' } | { outcome: 'unresolved' }
  | { outcome: 'error'; message: string }

/**
 * 单行 GC（事务级行锁先行）。四种结局：
 *  deleted=行+对象都已删；claimed=行锁重查发现已被认领（什么都不动）；
 *  unresolved=storage_ref 解析不出桶（行保留——删错桶=白删）；error=删对象失败（行保留，重试）。
 */
export async function gcSingleAttachment(
  client: PoolClient, org: string, cand: GcCandidate,
  resolver: GcDeps['resolver'], deleter: GcDeps['deleter'],
): Promise<GcSingleResult> {
  await client.query('begin')
  try {
    // 行锁 + 认领重查（一查两得）：锁到本行处理完为止；谓词与扫描同源（ticket_id is null）
    const lock = await client.query(
      `select id from aftersales.ticket_attachment
        where org = $1 and id = $2 and ticket_id is null
        for update`,
      [org, cand.id],
    )
    if ((lock.rowCount ?? 0) === 0) { await client.query('commit'); return { outcome: 'claimed' } }

    const storage = resolver(cand.storageRef)
    if (!storage) { await client.query('commit'); return { outcome: 'unresolved' } }

    try {
      await deleter(storage, cand.objectKey)
    } catch (err) {
      await client.query('rollback')
      return { outcome: 'error', message: err instanceof Error ? err.message : String(err) }
    }

    await client.query(
      `delete from aftersales.ticket_attachment where org = $1 and id = $2 and ticket_id is null`,
      [org, cand.id],
    )
    await client.query('commit')
    return { outcome: 'deleted' }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    return { outcome: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

export async function runAttachmentGc(deps: GcDeps, opts: GcOptions): Promise<GcReport> {
  const cands = await selectGcCandidates(deps.pool, deps.org, opts.olderThanDays, opts.limit)
  const report: GcReport = {
    dryRun: opts.dryRun, scanned: cands.length, eligible: cands.length,
    deletedObjects: 0, deletedRows: 0, skippedUnresolved: [], errors: [],
  }
  if (opts.dryRun) return report   // 只报告不动手（端点的安全缺省）

  const client = await deps.pool.connect()
  try {
    for (const cand of cands) {
      const r = await gcSingleAttachment(client, deps.org, cand, deps.resolver, deps.deleter)
      if (r.outcome === 'deleted') { report.deletedObjects += 1; report.deletedRows += 1 }
      else if (r.outcome === 'unresolved') report.skippedUnresolved.push({ id: Number(cand.id), storageRef: cand.storageRef })
      else if (r.outcome === 'error') report.errors.push({ id: Number(cand.id), error: r.message })
      // claimed：行已被认领，不是异常，不记账
    }
  } finally {
    client.release()
  }
  return report
}
```

- [ ] **Step 4: storage.ts 加 deleteObject（先补它的失败测试）**

`modules/aftersales/storage.test.ts` 追加（文件里 `FULL_ENV` / `platformStorageFromEnv` 已有）：

```ts
import type { S3Client } from '@aws-sdk/client-s3'

describe('deleteObject —— GC 的对象删除（spec §5 #12）', () => {
  it('对配置的桶发 DeleteObjectCommand（命令形状断言，不发网络）', async () => {
    const sends: unknown[] = []
    const fakeClient = {
      send: async (cmd: unknown) => { sends.push(cmd); return { $metadata: { httpStatusCode: 204 } } },
    } as unknown as S3Client
    const cfg = platformStorageFromEnv(FULL_ENV)!
    const s = new ZosStorage(cfg, fakeClient)
    await s.deleteObject('aftersales/acme/req-1/u')
    expect(sends).toHaveLength(1)
    const cmd = sends[0] as { input: { Bucket: string; Key: string } }
    expect(cmd.input.Bucket).toBe('aftersales-test')
    expect(cmd.input.Key).toBe('aftersales/acme/req-1/u')
  })
})
```

Run: `pnpm --filter aftersales test storage.test.ts`
Expected: FAIL —— `s.deleteObject is not a function`（TS 层在 typecheck 红：`Property 'deleteObject' does not exist`）

改 `modules/aftersales/storage.ts`——两处：

```ts
// import 行：加 DeleteObjectCommand
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
```

`ZosStorage` 构造器与新增方法（`presignPut` / `presignGet` 保持不动）：

```ts
export class ZosStorage {
  private readonly client: S3Client

  /** client 可注入【仅供测试】（storage.test.ts 断言 DeleteObjectCommand 的形状，不发网络）；
   *  生产路径恒走缺省值——storageFor 构造的池化实例从不传第二参。 */
  constructor(private readonly config: TenantStorageConfig, client?: S3Client) {
    this.client = client ?? new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // 见文件头 ②：ZOS 实测必须 path-style，否则 bucket 会被当成 DNS 子域拼进 host。
      forcePathStyle: true,
    })
  }

  /** GC（spec §5 #12）删对象。S3 语义：key 不存在也成功（204）⇒ GC 崩溃后重跑天然幂等。 */
  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
  }

  // presignPut / presignGet 原样保留（见上）
}
```

- [ ] **Step 5: 跑 domain + storage 测试，确认通过**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test domain/attachment-gc.test.ts storage.test.ts`
Expected: PASS

- [ ] **Step 6: 写端点失败的测试**

`modules/aftersales/routes/attachment-gc.test.ts`：

```ts
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { TenantStorageConfig } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-aftersales-gc-route'
const TENANT_CFG: TenantStorageConfig = {
  kind: 's3', endpoint: 'https://zos.tenant.test', region: 'xinan1',
  bucket: 'tenant-b1', accessKeyId: 'AKIATENANT', secretAccessKey: 'sk-tenant',
}
const post = (body: unknown) => ({
  method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

describePg('POST /attachments/gc（manage 面）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ctx = { pool }
  const app = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }), ctx, TENANT_CFG)

  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('body 非法（olderThanDays=0）→ 400 INVALID_BODY', async () => {
    const res = await app.request('/attachments/gc', post({ olderThanDays: 0 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })

  it('缺省即 dry-run：POST {} → 200 且 dryRun=true，一行都不动', async () => {
    await pool.query(
      `insert into aftersales.ticket_attachment(org, client_request_id, object_key, storage_ref, created_at)
       values ($1, 'cr-1', 'aftersales/x/1/u', '', now() - interval '30 day')`, [ORG])
    const res = await app.request('/attachments/gc', post({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ dryRun: true, scanned: 1, eligible: 1, deletedRows: 0 })
    const left = await pool.query('select count(*)::int as n from aftersales.ticket_attachment where org = $1', [ORG])
    expect(left.rows[0].n).toBe(1)
  })

  it('一个存储候选都没有 → 503 ZOS_NOT_CONFIGURED（与读侧同形）', async () => {
    // 不注入存储配置（第 4 参缺省）且把平台 env 五键 stub 成空串 ⇒ platformStorageFromEnv 为
    // null ⇒ storageCandidatesFor().all 为空。stub 成空串是为了在「本机恰好 export 过真值」时也确定。
    for (const k of ['AFTERSALES_ZOS_ENDPOINT', 'AFTERSALES_ZOS_REGION', 'AFTERSALES_ZOS_BUCKET',
                     'AFTERSALES_ZOS_ACCESS_KEY', 'AFTERSALES_ZOS_SECRET']) vi.stubEnv(k, '')
    const bare = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }), ctx)
    const res = await bare.request('/attachments/gc', post({}))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('ZOS_NOT_CONFIGURED')
    vi.unstubAllEnvs()
  })
})
```

- [ ] **Step 7: 写端点实现 + manifest + index（同一提交！）**

`modules/aftersales/routes/attachment.ts` 追加（既有 `registerAttachmentGuest` / `registerAttachmentManage` 不动；文件顶部 import 补 `GC_*` 常量、`runAttachmentGc`、`GcBody` 用的 zod 已有）：

```ts
import {
  GC_DEFAULT_LIMIT, GC_DEFAULT_OLDER_THAN_DAYS, GC_MAX_LIMIT, runAttachmentGc,
} from '../domain/attachment-gc'

/** GC 请求体：全可选、缺省安全（dry-run）。olderThanDays 上界 10 年防误输。 */
const GcBody = z.object({
  olderThanDays: z.number().int().min(1).max(3650).optional(),
  dryRun: z.boolean().optional(),
  limit: z.number().int().min(1).max(GC_MAX_LIMIT).optional(),
})

/** 孤儿附件 GC（spec §5 #12；拍板：openship job 定时打本端点触发）。manage 面。 */
export function registerAttachmentGc(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/attachments/gc', async (c) => {
    const org = c.get('identity').orgId
    const parsed = GcBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const opts = {
      olderThanDays: parsed.data.olderThanDays ?? GC_DEFAULT_OLDER_THAN_DAYS,
      // 破坏性操作安全缺省：dry-run。生产 openship job 显式传 dryRun:false。
      dryRun: parsed.data.dryRun ?? true,
      limit: parsed.data.limit ?? GC_DEFAULT_LIMIT,
    }
    // 候选集合与读侧同源（storageCandidatesFor 含平台默认）：孤儿行大多写在平台桶时代；
    // 删对象必须按行上的 storage_ref 归桶（删错桶=白删）。
    const cands = storageCandidatesFor(c.get(TENANT_STORAGE))
    if (cands.all.length === 0) return c.json({ error: 'ZOS_NOT_CONFIGURED' }, 503)
    const report = await runAttachmentGc(
      { pool: ctx.pool, org, resolver: storageResolverFor(cands), deleter: (s, key) => s.deleteObject(key) },
      opts,
    )
    return c.json(report)
  })
}
```

`modules/aftersales/manifest.yaml` 的 `api.internal` 末尾（`GET /attachments/:id` 那行之后）加：

```yaml
    # ── 孤儿附件 GC（spec §5 #12；openship job 定时打，body 缺省 dry-run）──
    - { method: POST, path: /attachments/gc, scope: aftersales:manage }
```

`modules/aftersales/index.ts`：import 行补 `registerAttachmentGc`，`createRouter` 里 `registerAttachmentManage(r, ctx)` 之后加一行 `registerAttachmentGc(r, ctx)`。

> ⚠️ **manifest 与路由必须同一提交**（全局约束 3）：`module.test.ts` 的双向核对用例会在漏一边时红——它数的是声明集合 ≡ 注册集合，加一条路由不加声明（或反之）= 该用例 FAIL。

- [ ] **Step 8: 全量验证**

Run:
```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test
pnpm --filter aftersales typecheck
pnpm typecheck && pnpm test
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
```
Expected: 全绿。`module.test.ts` 的双向核对随新路由自动扩面（无需改它）。

- [ ] **Step 9: 提交 + PR**

```bash
git add modules/aftersales
git commit -m "feat(aftersales): 孤儿附件 GC——deleteObject + manage 端点 + 行锁先行单行事务"
gh pr create --title "feat(aftersales): 孤儿附件 GC 全链" --body "Closes #151"
```

- [ ] **Step 10: 合并部署后注册 openship job（运维步，走 openship MCP，不进仓）**

前置（一次性，人在 Casdoor/openship 做）：
1. Casdoor 建机器人用户（如 `gc-bot`）挂在目标租户 org 下、给 `aftersales:manage` 权限；密码落 openship env(isSecret)。
2. 经 openship MCP 建定时 job（建议每周一次、避开业务时段；`ORIGIN` / `GC_USER` / `GC_PWD` 走 job 的 secrets/env）：

```sh
# job command（照抄；openship job 的 secrets 注入成环境变量）
curl -sS -c /tmp/gc.jar -X POST "$ORIGIN/api/platform/auth/login" \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$GC_USER\",\"password\":\"$GC_PWD\"}"
curl -sS -b /tmp/gc.jar -X POST "$ORIGIN/api/modules/aftersales/attachments/gc" \
  -H 'content-type: application/json' \
  -d '{"dryRun":false,"olderThanDays":14,"limit":500}'
```

3. 注册后手动触发一次 **dry-run 形态**（`-d '{"olderThanDays":14}'`）验证链路：200 + `dryRun:true` 报告即通。
> 鉴权链为什么这样走：模块 API 门卫在 identity 层（无 session ⇒ 401 `UNAUTHENTICATED`），平台**没有**模块面的机器 token 基建（PAT 在问数计划里、尚未合入）⇒ job 用「密码登录换 session cookie」是**唯一不动鉴权面**的通道；登录限速按 租户+用户名 计数，周频 job 摸不到上限。`$ORIGIN` 等值在 openship 侧，**不写进本仓任何文件**。

---

### Task 2: 迁移脚本骨架（拉取/清洗/导入/对账纯核 + CLI 薄壳 + 单测）

**骨架的含义（诚实边界）**：本任务交付**完整可跑的管线**——拉取分页、清洗归一、幂等导入、对账——并用**按 spec §3.3 实证表编造的夹具**跑单测（那些坑——类型漂移、`openId` 两拼写、三套审批词表、`store_info` 逗号串、`refund_ratio` 实存小数、金额元带分——全部在夹具里编码）。**源表逐字段的真实字段名只能由 T3 拉样钉死**，因此 `clean.ts` 的字段名候选（`*_KEYS`）标注「暂定」，T3 有一步**逐表核对**负责删错项、定真名。这不是占位符——是「无样本阶段可交付的最大真值」+ 显式gate。

**Files:**
- Create: `modules/aftersales/migration/wuji-source.ts`
- Create: `modules/aftersales/migration/clean.ts`
- Create: `modules/aftersales/migration/import.ts`
- Create: `modules/aftersales/migration/reconcile.ts`
- Create: `modules/aftersales/migration/fixtures.ts`
- Create: `modules/aftersales/migrations/004_employee_approval_source_id.sql`
- Test: `modules/aftersales/migration/wuji-source.test.ts` / `clean.test.ts` / `import.test.ts` / `reconcile.test.ts`
- Modify: `modules/aftersales/vitest.config.ts`（backend include 加 `'migration/**/*.test.ts'`）
- Create: `scripts/migrate-aftersales-wuji.mjs`
- Modify: `.env.example`（追加 wuji 键段）
- Modify: `.gitignore`（追加 samples-local 目录）

**Interfaces:**
- Consumes: `runMigrations`（`apps/server/src/migrate.ts`，经 `test-util.ts` 的 `applyMigrations`）；各表既有的 `(org, source_id)` 部分唯一索引（幂等位）；`Pool`（pg）
- Produces（T3/T4/T5 消费）：

```ts
// wuji-source.ts
export interface WujiTableCfg { origin: string; appid: string; schemaid: string; schemakey: string }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export class WujiApiError extends Error { constructor(public readonly status: number, message: string) }
export async function wujiCount(fetcher: FetchLike, cfg: WujiTableCfg): Promise<number>
export async function wujiFetchAll(
  fetcher: FetchLike, cfg: WujiTableCfg, opts?: { pageSize?: number; maxRows?: number },
): Promise<Record<string, unknown>[]>
export function maxMtimeOf(rows: Record<string, unknown>[]): string | null

// clean.ts（节选——完整清单见 Steps）
export function yuanToMinor(v: unknown): bigint | null
export type GroupbuyUnit = 'fen' | 'yuan'
export const GROUPBUY_UNIT_UNPROVEN: string
export function setGroupbuyUnit(u: GroupbuyUnit): void
export function groupbuyUnitProven(): boolean
export function groupbuyToMinor(v: unknown): bigint        // 未证即抛
export function openIdOf(row: Record<string, unknown>): string
export function splitStoreRefs(v: unknown): string[]
export function ratioOf(v: unknown): string | null
export function cleanRegion(row: Record<string, unknown>): CleanRegion
export function cleanStore(row: Record<string, unknown>): CleanStore
export function cleanProduct(row: Record<string, unknown>): CleanProduct
export function cleanEmployee(row: Record<string, unknown>): CleanEmployee
export function cleanEmployeeApproval(row: Record<string, unknown>): CleanEmployeeApproval
export function cleanRule(row: Record<string, unknown>): CleanRule
export function cleanTicket(row: Record<string, unknown>): CleanTicket

// import.ts
export interface ImportStat { table: string; fetched: number; imported: number; skipped: number; reasons: Record<string, number> }
export async function importRegion(pool: Pool, org: string, rows: CleanRegion[]): Promise<ImportStat>
export async function importStore(pool: Pool, org: string, rows: CleanStore[]): Promise<ImportStat>
export async function importProduct(pool: Pool, org: string, rows: CleanProduct[]): Promise<ImportStat>
export async function importEmployee(pool: Pool, org: string, rows: CleanEmployee[]): Promise<ImportStat>   // 含 employee_store 拆分
export async function importEmployeeApproval(pool: Pool, org: string, rows: CleanEmployeeApproval[]): Promise<ImportStat>
export async function importRule(pool: Pool, org: string, rows: CleanRule[]): Promise<ImportStat>
export async function importTicket(pool: Pool, org: string, rows: CleanTicket[]): Promise<ImportStat>       // 含二义洗清 + FK

// reconcile.ts
export interface CountCheck { table: string; source: number; target: number; ok: boolean }
export interface SumCheck { label: string; expected: string; actual: string; ok: boolean }
export async function reconcileCounts(pool: Pool, org: string, expected: { table: string; source: number }[]): Promise<CountCheck[]>
export async function reconcileTicketSums(pool: Pool, org: string, expected: { amountMinor: bigint; basicUnitPriceMinor: bigint }): Promise<SumCheck[]>
```

- [ ] **Step 1: vitest include 扩目录 + 004 迁移（employee_approval 幂等位）**

`modules/aftersales/vitest.config.ts` 的 backend project：

```ts
        test: {
          name: 'backend',
          environment: 'node',
          include: ['domain/**/*.test.ts', 'routes/**/*.test.ts', 'migration/**/*.test.ts', '*.test.ts'],
        },
```

> 与既有的「写精确目录、不写 exclude」纪律同一条理由（显式 exclude 会覆盖默认排除项，把 node_modules 里的测试扫进来）。

`modules/aftersales/migrations/004_employee_approval_source_id.sql`：

```sql
-- 004_employee_approval_source_id.sql — M2b：employee_approval 补 source_id 幂等位。
--
-- 002 建 employee_approval 时没带 source_id（M3b-1 只服务线上新申请，没有重跑导入的需求）。
-- M2b 要把源 employee_info_approve（214 行）迁进来并要求「--apply 可重跑」⇒ 照 001 的幂等模式补：
--   source_id text not null default '' + (org, source_id) 部分唯一索引（空串互撞被 WHERE 排除）。
-- 线上新申请行 source_id 保持 ''，不受影响。
alter table aftersales.employee_approval
  add column if not exists source_id text not null default '';

create unique index if not exists aftersales_employee_approval_org_source_idx
  on aftersales.employee_approval(org, source_id) where source_id <> '';
```

> 记账语义提醒：`module.test.ts` 的 `applyMigrations 幂等` 与 `rawMigrationSqls 直跑两遍` 两条用例**自动**覆盖新文件（它们按文件名 glob 全部 `*.sql`），不用改测试。

- [ ] **Step 2: 写 wuji-source 失败的测试**

`modules/aftersales/migration/wuji-source.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { maxMtimeOf, wujiCount, wujiFetchAll, type FetchLike } from './wuji-source'

const CFG = { origin: 'https://data.wujisite.com', appid: 'app', schemaid: 'store_info', schemakey: 'k' }

/** 用真 Response 造桩（Node 22 自带）——形状与真 fetch 完全一致，不留「桩比真机松」的口子。 */
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('wuji-source（通道口径全部来自 2026-09-15 真机实测，spec §3.3）', () => {
  it('wujiCount：count=任意值 → {"data":{"total":N}}', async () => {
    const fetcher: FetchLike = async (url) => {
      expect(url).toContain('count=')
      expect(url).toContain('appid=app')
      expect(url).toContain('schemaid=store_info')
      expect(url).toContain('schemakey=k')
      return jsonResponse(200, { data: { total: 322 }, code: 200 })
    }
    expect(await wujiCount(fetcher, CFG)).toBe(322)
  })

  it('403 ⇒ WujiApiError 且报文指向双因子（错一即 403，不可枚举）', async () => {
    const fetcher: FetchLike = async () => jsonResponse(403, { })
    await expect(wujiCount(fetcher, CFG)).rejects.toThrow(/403/)
  })

  it('分页：整页继续、末页（不足 pageSize）停；page 从 1 起、size 默认 15000', async () => {
    let calls = 0
    const fetcher: FetchLike = async (url) => {
      calls += 1
      const u = new URL(url)
      expect(u.searchParams.get('page')).toBe(String(calls))
      expect(u.searchParams.get('size')).toBe('3')
      return jsonResponse(200, { data: calls === 1 ? [{ a: 1 }, { a: 2 }, { a: 3 }] : [{ a: 4 }] })
    }
    const rows = await wujiFetchAll(fetcher, CFG, { pageSize: 3 })
    expect(rows.map((r) => r.a)).toEqual([1, 2, 3, 4])
    expect(calls).toBe(2)
  })

  it('maxRows 截断（拉样模式只拉第一页）', async () => {
    const fetcher: FetchLike = async () => jsonResponse(200, { data: [{ a: 1 }, { a: 2 }, { a: 3 }] })
    const rows = await wujiFetchAll(fetcher, CFG, { pageSize: 3, maxRows: 2 })
    expect(rows).toHaveLength(2)
  })

  it('maxMtimeOf：取全部行的最大 _mtime（对账基线）', () => {
    expect(maxMtimeOf([{ _mtime: '2026-09-12 10:00:00' }, { _mtime: '2026-09-12 09:00:00' }])).toBe('2026-09-12 10:00:00')
    expect(maxMtimeOf([{}, { _mtime: '' }])).toBeNull()
  })
})
```

- [ ] **Step 3: 写 wuji-source 实现**

`modules/aftersales/migration/wuji-source.ts`：

```ts
// wuji-source.ts — 无极托管库只读 HTTP API 客户端（M2b 拉取层）。
//
// 通道口径（2026-09-15 真机实测，spec §3.3；勿凭猜改）：
//   GET {origin}/api/private/object?appid=&schemaid=&schemakey=
//   分页 page（1 起）+ size（上限 15000）；limit/skip/offset/pagesize 全部【静默忽略】——所以这里
//   只发 page/size，别画蛇添足（写了也不报错，但会让人误以为它生效）。
//   count=<任意值> → {"data":{"total":N}}；返回 {"data":[行字段平铺]}。
//   schemaid+schemakey 严格双因子，错一即 403 forbidden。
// 键值一律不落仓/不落日志（.env.example 只写键名与取法）。
export interface WujiTableCfg { origin: string; appid: string; schemaid: string; schemakey: string }
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class WujiApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}

function buildUrl(cfg: WujiTableCfg, params: Record<string, string>): string {
  const u = new URL('/api/private/object', cfg.origin)
  u.searchParams.set('appid', cfg.appid)
  u.searchParams.set('schemaid', cfg.schemaid)
  u.searchParams.set('schemakey', cfg.schemakey)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u.toString()
}

function forbidden(cfg: WujiTableCfg): WujiApiError {
  return new WujiApiError(403, `wuji 403：schemaid/schemakey 双因子错一即拒（${cfg.schemaid}）——核对两键`)
}

export async function wujiCount(fetcher: FetchLike, cfg: WujiTableCfg): Promise<number> {
  const res = await fetcher(buildUrl(cfg, { count: '1' }))
  if (res.status === 403) throw forbidden(cfg)
  if (!res.ok) throw new WujiApiError(res.status, `wuji HTTP ${res.status}（${cfg.schemaid}）`)
  const body = (await res.json().catch(() => null)) as { data?: { total?: unknown } } | null
  const total = Number(body?.data?.total)
  if (!Number.isFinite(total)) {
    throw new WujiApiError(0, `wuji count 返回形状不对（${cfg.schemaid}）：${JSON.stringify(body).slice(0, 200)}`)
  }
  return total
}

/** 全量分页拉取。opts.maxRows 供拉样截断（T3 的 --sample：拉到即停）。 */
export async function wujiFetchAll(
  fetcher: FetchLike, cfg: WujiTableCfg, opts: { pageSize?: number; maxRows?: number } = {},
): Promise<Record<string, unknown>[]> {
  const pageSize = Math.min(opts.pageSize ?? 15000, 15000)   // 实测上限
  const maxRows = opts.maxRows ?? Number.MAX_SAFE_INTEGER
  const out: Record<string, unknown>[] = []
  for (let page = 1; ; page++) {
    const res = await fetcher(buildUrl(cfg, { page: String(page), size: String(pageSize) }))
    if (res.status === 403) throw forbidden(cfg)
    if (!res.ok) throw new WujiApiError(res.status, `wuji HTTP ${res.status}（${cfg.schemaid} page=${page}）`)
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null
    const rows = Array.isArray(body?.data) ? (body!.data as Record<string, unknown>[]) : []
    out.push(...rows.slice(0, Math.max(0, maxRows - out.length)))
    if (out.length >= maxRows) break
    if (rows.length < pageSize) break   // 末页
  }
  return out
}

/** 对账基线（spec §3.3「窗口首尾各取一次最大 _mtime」）：对已拉取行算 max(_mtime)。
 *  字符串字典序比较——T3 拉样时核对 _mtime 形态确属可字典序比较（若非，改为 Date 解析再比）。 */
export function maxMtimeOf(rows: Record<string, unknown>[]): string | null {
  let max: string | null = null
  for (const r of rows) {
    const v = r._mtime
    if (typeof v === 'string' && v !== '' && (max === null || v > max)) max = v
  }
  return max
}
```

- [ ] **Step 4: 写 clean 失败的测试（实证坑逐条编码）**

`modules/aftersales/migration/clean.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  GROUPBUY_UNIT_UNPROVEN, cleanEmployee, cleanEmployeeApproval, cleanRule, cleanTicket,
  groupbuyToMinor, groupbuyUnitProven, openIdOf, ratioOf, setGroupbuyUnit, splitStoreRefs,
  yuanToMinor,
} from './clean'
import {
  FIXTURE_EMPLOYEE, FIXTURE_EMPLOYEE_APPROVE, FIXTURE_RULE, FIXTURE_TICKET,
} from './fixtures'

describe('单位与归一（裁决 5：唯一处）', () => {
  it('yuanToMinor：元(带分精度)→整数分；字符串数字可；空/非法→null', () => {
    expect(yuanToMinor(7549.99)).toBe(754999n)          // 7549.99*100=754998.999…，round 兜住
    expect(yuanToMinor('12.5')).toBe(1250n)
    expect(yuanToMinor(0)).toBe(0n)
    expect(yuanToMinor(null)).toBeNull()
    expect(yuanToMinor('')).toBeNull()
    expect(yuanToMinor('abc')).toBeNull()
  })

  it('groupbuyToMinor：未自证即抛（禁猜是裁决，不是提示）；setGroupbuyUnit 后按域换算', () => {
    expect(groupbuyUnitProven()).toBe(false)
    expect(() => groupbuyToMinor(5000)).toThrow(GROUPBUY_UNIT_UNPROVEN)
    setGroupbuyUnit('fen')
    expect(groupbuyToMinor(5000)).toBe(5000n)
    setGroupbuyUnit('yuan')
    expect(groupbuyToMinor(50)).toBe(5000n)
  })

  it('ratioOf：refund_ratio 源存小数——原样定 4 位小数，绝不 ×100（§2.4 实证）', () => {
    expect(ratioOf(0.05)).toBe('0.0500')
    expect(ratioOf('0.1234')).toBe('0.1234')
    expect(ratioOf(null)).toBeNull()
  })
})

describe('拼写与词表归一（§3.3 实证表）', () => {
  it('openIdOf：openId/openid 两拼写归一', () => {
    expect(openIdOf({ openId: 'oABC' })).toBe('oABC')
    expect(openIdOf({ openid: 'oDEF' })).toBe('oDEF')
    expect(openIdOf({})).toBe('')
  })

  it('splitStoreRefs：中英文逗号都拆、空段滤掉', () => {
    expect(splitStoreRefs('S001，S002, ,S003')).toEqual(['S001', 'S002', 'S003'])
    expect(splitStoreRefs(123)).toEqual([])   // 源字段类型漂移：非串一律空
  })
})

describe('各表清洗（fixtures 按 spec §3.3 实证表编造；T3 拉样后以脱敏真样本替换）', () => {
  it('employee：审批词表三套归一英文；store_info 逗号串拆行；openId 归一', () => {
    const e = cleanEmployee(FIXTURE_EMPLOYEE)
    expect(e).toMatchObject({
      sourceId: '591-001', name: '张三', openId: 'oEMP001',
      approveStatus: 'approved', storeSourceIds: ['S001', 'S002'],
    })
  })

  it('employeeApproval：中文词表归一 + approveinfo 展平两列', () => {
    const a = cleanEmployeeApproval(FIXTURE_EMPLOYEE_APPROVE)
    expect(a).toMatchObject({
      // 源 _id 是 int（§3.3 实证：employee_info_approve 的 _id 与 employee_info 的 str 不同型）——
      // pickStr 把它字符串化，别在断言里写带横线的「看起来像 id」的串
      sourceId: '214001', openId: 'oAPP001', approveType: 'change', status: 'approved',
      oldInfo: { name: '旧名' }, newInfo: { name: '新名' },
    })
  })

  it('rule：refund_ratio 原样（小数，不是百分数）', () => {
    const r = cleanRule(FIXTURE_RULE)
    expect(r.refundRatio).toBe('0.0500')
  })

  it('ticket：金额 ×100 落整数分；状态三态映射；【历史附件整字段丢弃】（裁决 1）', () => {
    const t = cleanTicket(FIXTURE_TICKET)
    expect(t).toMatchObject({
      sourceId: 'wo-001', status: 'completed', amountType: 'ratio',
      amountMinor: 20000n,              // 200 元 → 20000 分
      basicUnitPriceMinor: 1250n,       // 12.5 元 → 1250 分
    })
    // damage_images（COS URL 数组/字符串混用）不进任何产物字段——历史附件不迁行
    expect(JSON.stringify(t)).not.toContain('cos.example')
  })
})
```

- [ ] **Step 5: 写 fixtures + clean 实现**

`modules/aftersales/migration/fixtures.ts`（**W1 编造版**——每行都编码一条实证坑；文件头注明 T3 要替换）：

```ts
// fixtures.ts — 迁移单测夹具。
// ⚠️ W1 版按 spec §3.3 实证表【编造】（编码已实证的字段行为，非真实数据）；
//    T3 拉样后以【脱敏真样本】替换/扩充（姓名/手机号/openid 换合成值，保字段名/类型/形状）。
//    编造依据逐条注明，替换时对照 SAMPLE-NOTES.md。

/** employee_info：openId 驼峰拼写 + store_info 逗号多门店串 + 审批态英文词表（§3.3：同一概念两种拼写） */
export const FIXTURE_EMPLOYEE = {
  _id: '591-001', name: '张三', phone: '13800000000', openId: 'oEMP001',
  approve_status: 'approved', store_info: 'S001，S002',
}
/** employee_info_approve：openid 全小写拼写 + 中文词表「通过」 + approveinfo 嵌套（全区唯一，展平） */
export const FIXTURE_EMPLOYEE_APPROVE = {
  _id: 214001, openid: 'oAPP001', approve_type: 'change', status: '通过',
  approveinfo: { old: { name: '旧名' }, new: { name: '新名' } },
  ctime: '2026-08-01 10:00:00', _ctime: '2026-08-01 10:00:01',
}
/** after_sales_rule：refund_ratio 实存小数（注释谎称 %）+ 类型漂移 int/num */
export const FIXTURE_RULE = { _id: 'rule-001', name: '默认规则', refund_ratio: 0.05, remark: '' }
/** after_sales_work_order：金额元带分精度（×100）+ 状态三态 + damage_images 数组/串混用（丢弃） */
export const FIXTURE_TICKET = {
  _id: 'wo-001', order_number: 'AS20260801001', openId: 'oSUB001',
  product_name: 'P001', store_selection: 'S001',
  damage_quantity: 20, basic_quantity: 10, basic_unit_price: 12.5,
  status: 'completed', after_sales_type: 'ratio', after_sales_amount: 200, after_sales_rate: 0.05,
  operator: '审批员A', remark: '历史工单', related_order: 'GB20260731001',
  damage_images: ['https://cos.example/p1.jpg', 'https://cos.example/p2.jpg'],
  create_time: '2026-08-01 11:00:00',
}
```

`modules/aftersales/migration/clean.ts`：

```ts
// clean.ts — wuji 源行 → 目标行的清洗（纯函数；M2b 的单位/词表/拼写归一**唯一处**）。
//
// 裁决落点（2026-09-22 拍板，见计划全局约束）：
//   · 历史附件不迁行：damage_images 在 cleanTicket 里整字段丢弃（ticket_attachment 只装新 ZOS 附件）。
//   · 金额整数分：工单域源值「元带分精度」（§2.4 源码实证）⇒ 换算只在 yuanToMinor 一处；
//     接龙域单位未证 ⇒ groupbuyToMinor 在 setGroupbuyUnit 之前一律抛（T3 自证后才许设）。
//   · openId/openid 两拼写归一（§3.3）；审批/工单状态词表归一英文枚举（§5 #9）。
//   · refund_ratio 源存小数（注释谎称 %）⇒ 原样 4 位小数，绝不 ×100。
//
// ⚠️ *_KEYS 的字段名候选是 W1 按 spec §3.3 实证表 + 源仓调用面写的【暂定】清单——
//    T3 拉样后逐表核对：删掉不存在的候选、钉死真实字段名，fixtures 同步替换为脱敏真样本。
//    候选顺序即优先级（先命中先用）。
type SrcRow = Record<string, unknown>

function pick(row: SrcRow, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}
function pickStr(row: SrcRow, keys: readonly string[], fallback = ''): string {
  const v = pick(row, keys)
  if (v === undefined) return fallback
  return (typeof v === 'string' ? v : String(v)).trim()
}
function pickInt(row: SrcRow, keys: readonly string[], fallback = 0): number {
  const v = pick(row, keys)
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}
/** 时间字段五套并存（§3.3）：按候选顺序取第一个可解析的。 */
const TIME_KEYS = ['create_time', 'created_at', '_ctime', 'ctime', 'timestamp_with_watermark'] as const
function pickTime(row: SrcRow, keys: readonly string[] = TIME_KEYS): Date | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v !== 'string' || v === '') continue
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

// ── 单位（裁决 5 的唯一处）──────────────────────────────────────────────
/** 工单域：元(带分精度) → 整数分。round 兜 7549.99*100=754998.999… 的浮点尾。 */
export function yuanToMinor(v: unknown): bigint | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return BigInt(Math.round(n * 100))
}

export type GroupbuyUnit = 'fen' | 'yuan'
export const GROUPBUY_UNIT_UNPROVEN = 'GROUPBUY_UNIT_UNPROVEN'
let groupbuyUnit: GroupbuyUnit | null = null
/** 只允许 T3 的样本自证结论（或客户答复）把单位设进来——「数据自证禁猜」的落点。 */
export function setGroupbuyUnit(u: GroupbuyUnit): void { groupbuyUnit = u }
export function groupbuyUnitProven(): boolean { return groupbuyUnit !== null }
export function groupbuyToMinor(v: unknown): bigint {
  if (groupbuyUnit === null) {
    throw new Error(`${GROUPBUY_UNIT_UNPROVEN}：接龙金额单位未经数据自证/客户确认，禁止按猜测换算（spec §5 #7②）`)
  }
  if (groupbuyUnit === 'fen') {
    if (v === undefined || v === null || v === '') return 0n
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n
  }
  return yuanToMinor(v) ?? 0n
}

// ── 词表与拼写归一 ─────────────────────────────────────────────────────
export const APPROVE_STATUS_MAP: Record<string, string> = {
  pending: 'pending', approved: 'approved', rejected: 'rejected',
  '待审批': 'pending', '通过': 'approved', '驳回': 'rejected',
}
export const TICKET_STATUS_MAP: Record<string, string> = {
  pending: 'pending', completed: 'completed', cancelled: 'cancelled',
  '待处理': 'pending', '已处理': 'completed', '已驳回': 'cancelled',
}
export const AMOUNT_TYPE_MAP: Record<string, 'ratio' | 'fixed' | 'reject'> = {
  ratio: 'ratio', fixed: 'fixed', reject: 'reject',
  '按比例': 'ratio', '固定金额': 'fixed', '驳回': 'reject',
}
function mapValue<T>(map: Record<string, T>, v: unknown, fallback: T): T {
  const key = typeof v === 'string' ? v.trim() : String(v ?? '')
  return map[key] ?? fallback
}
/** 同概念两拼写（§3.3：employee_info.openId vs employee_info_approve.openid）。 */
export function openIdOf(row: SrcRow): string {
  return pickStr(row, ['openId', 'openid', 'open_id'])
}
/** 源 employee_info.store_info 逗号多门店串（中英文逗号都见过）→ source_id 列表。 */
export function splitStoreRefs(v: unknown): string[] {
  if (typeof v !== 'string') return []
  return v.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '')
}
/** refund_ratio 源存【小数比例】（注释谎称 %，§2.4 实证）——原样 4 位小数，绝不 ×100。 */
export function ratioOf(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n.toFixed(4) : null
}

// ── 各表字段候选（暂定；T3 拉样逐表核对）──────────────────────────────
export const KEYS = {
  region: { id: ['_id'], name: ['name', 'region_name'] },
  store: { id: ['_id'], name: ['name', 'store_name'], region: ['region_id', 'region'], address: ['address'], phone: ['phone', 'contact'] },
  product: { id: ['_id'], name: ['name', 'product_name'], spec: ['spec', 'specification'],
             basicQuantity: ['basic_quantity'], basicUnitPrice: ['basic_unit_price', 'price'] },
  employee: { id: ['_id'], name: ['name'], phone: ['phone', 'mobile'], approveStatus: ['approve_status', 'status'] },
  approval: { id: ['_id'], type: ['approve_type', 'type'], status: ['status', 'approve_status'],
              info: ['approveinfo'], decidedBy: ['decided_by', 'approver'] },
  rule: { id: ['_id'], name: ['name', 'rule_name'], ratio: ['refund_ratio', 'after_sales_rate'], remark: ['remark'] },
  ticket: {
    id: ['_id'], code: ['order_number', 'work_order_number', 'code'],
    productRef: ['product_name'], storeRef: ['store_selection', 'store_info'],
    damageQuantity: ['damage_quantity'], basicQuantity: ['basic_quantity'],
    basicUnitPrice: ['basic_unit_price'], status: ['status'],
    amountType: ['after_sales_type'], amount: ['after_sales_amount'], ratio: ['after_sales_rate'],
    operator: ['operator', 'handler'], remark: ['remark', 'remarks'],
    relatedOrder: ['related_order', 'order_id'],
  },
} as const

// ── 清洗产物（import.ts 的入参形状）───────────────────────────────────
export interface CleanRegion { sourceId: string; name: string }
export interface CleanStore { sourceId: string; name: string; regionSourceId: string | null; address: string; phone: string }
export interface CleanProduct { sourceId: string; name: string; spec: string; basicQuantity: number; basicUnitPriceMinor: bigint | null }
export interface CleanEmployee { sourceId: string; name: string; phone: string; openId: string; approveStatus: string; storeSourceIds: string[] }
export interface CleanEmployeeApproval {
  sourceId: string; openId: string; approveType: 'register' | 'change'; status: string
  oldInfo: Record<string, unknown>; newInfo: Record<string, unknown>
  createdAt: Date | null; decidedAt: Date | null; decidedBy: string
}
export interface CleanRule { sourceId: string; name: string; refundRatio: string | null; remark: string }
export interface CleanTicket {
  sourceId: string; code: string; submitterOpenid: string
  productRefRaw: string; storeRefRaw: string        // 二义（ID 或名称）——import 侧带档案映射洗清
  damageQuantity: number; basicQuantity: number; basicUnitPriceMinor: bigint | null
  status: string; amountType: 'ratio' | 'fixed' | 'reject' | null
  amountMinor: bigint | null; refundRatio: string | null
  operator: string; remark: string; relatedOrder: string
  createdAt: Date | null; processedAt: Date | null
}

export function cleanRegion(row: SrcRow): CleanRegion {
  return { sourceId: pickStr(row, KEYS.region.id), name: pickStr(row, KEYS.region.name) }
}
export function cleanStore(row: SrcRow): CleanStore {
  return {
    sourceId: pickStr(row, KEYS.store.id), name: pickStr(row, KEYS.store.name),
    regionSourceId: pickStr(row, KEYS.store.region) || null,
    address: pickStr(row, KEYS.store.address), phone: pickStr(row, KEYS.store.phone),
  }
}
export function cleanProduct(row: SrcRow): CleanProduct {
  return {
    sourceId: pickStr(row, KEYS.product.id), name: pickStr(row, KEYS.product.name),
    spec: pickStr(row, KEYS.product.spec),
    basicQuantity: pickInt(row, KEYS.product.basicQuantity),
    // 单位跟随工单域实证（§2.4：公式把它当元用）——T3 拉样核对量级（若显分数量级则此处是唯一改点）
    basicUnitPriceMinor: yuanToMinor(pick(row, KEYS.product.basicUnitPrice)),
  }
}
export function cleanEmployee(row: SrcRow): CleanEmployee {
  return {
    sourceId: pickStr(row, KEYS.employee.id), name: pickStr(row, KEYS.employee.name),
    phone: pickStr(row, KEYS.employee.phone), openId: openIdOf(row),
    approveStatus: mapValue(APPROVE_STATUS_MAP, pick(row, KEYS.employee.approveStatus), 'pending'),
    storeSourceIds: splitStoreRefs(row.store_info),
  }
}
export function cleanEmployeeApproval(row: SrcRow): CleanEmployeeApproval {
  // approveinfo：全区唯一嵌套字段（§3.3）——形状 { old: {...}, new: {...} }（T3 核对，形状不符就地修）
  const info = row.approveinfo
  const oldInfo = info && typeof info === 'object' && 'old' in (info as object)
    ? ((info as { old: Record<string, unknown> }).old ?? {}) : {}
  const newInfo = info && typeof info === 'object' && 'new' in (info as object)
    ? ((info as { new: Record<string, unknown> }).new ?? {}) : {}
  const typeRaw = pickStr(row, KEYS.approval.type)
  return {
    sourceId: pickStr(row, KEYS.approval.id), openId: openIdOf(row),
    approveType: typeRaw === 'change' || typeRaw === '变更' ? 'change' : 'register',
    status: mapValue(APPROVE_STATUS_MAP, pick(row, KEYS.approval.status), 'pending'),
    oldInfo, newInfo,
    createdAt: pickTime(row), decidedAt: pickTime(row, ['decided_at', 'decided_time']),
    decidedBy: pickStr(row, KEYS.approval.decidedBy),
  }
}
export function cleanRule(row: SrcRow): CleanRule {
  return {
    sourceId: pickStr(row, KEYS.rule.id), name: pickStr(row, KEYS.rule.name),
    refundRatio: ratioOf(pick(row, KEYS.rule.ratio)), remark: pickStr(row, KEYS.rule.remark),
  }
}
export function cleanTicket(row: SrcRow): CleanTicket {
  // 裁决 1：damage_images（无极 COS URL）整字段丢弃——历史附件不迁行，ticket_attachment 只装新 ZOS 附件。
  return {
    sourceId: pickStr(row, KEYS.ticket.id), code: pickStr(row, KEYS.ticket.code),
    submitterOpenid: openIdOf(row),
    productRefRaw: pickStr(row, KEYS.ticket.productRef), storeRefRaw: pickStr(row, KEYS.ticket.storeRef),
    damageQuantity: pickInt(row, KEYS.ticket.damageQuantity),
    basicQuantity: pickInt(row, KEYS.ticket.basicQuantity),
    basicUnitPriceMinor: yuanToMinor(pick(row, KEYS.ticket.basicUnitPrice)),
    status: mapValue(TICKET_STATUS_MAP, pick(row, KEYS.ticket.status), 'pending'),
    amountType: ((): 'ratio' | 'fixed' | 'reject' | null => {
      const raw = pick(row, KEYS.ticket.amountType)
      if (raw === undefined || raw === null || raw === '') return null
      return mapValue(AMOUNT_TYPE_MAP, raw, 'ratio')
    })(),
    amountMinor: yuanToMinor(pick(row, KEYS.ticket.amount)),
    refundRatio: ratioOf(pick(row, KEYS.ticket.ratio)),
    operator: pickStr(row, KEYS.ticket.operator), remark: pickStr(row, KEYS.ticket.remark),
    relatedOrder: pickStr(row, KEYS.ticket.relatedOrder),
    createdAt: pickTime(row), processedAt: pickTime(row, ['update_time', 'processed_at', '_mtime']),
  }
}
```

- [ ] **Step 6: 写 import 失败的测试（真库，幂等是主断言）**

`modules/aftersales/migration/import.test.ts`：

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import {
  importEmployee, importEmployeeApproval, importProduct, importRegion, importRule, importStore, importTicket,
} from './import'
import {
  FIXTURE_EMPLOYEE, FIXTURE_EMPLOYEE_APPROVE, FIXTURE_RULE, FIXTURE_TICKET,
} from './fixtures'
import { cleanEmployee, cleanEmployeeApproval, cleanRule, cleanStore, cleanTicket } from './clean'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-m2b-import'

describePg('导入层（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeEach(async () => {
    await applyMigrations(pool)
    // 清序：先子后父（FK）
    await pool.query(`delete from aftersales.ticket_attachment where org = $1`, [ORG])
    await pool.query(`delete from aftersales.ticket where org = $1`, [ORG])
    await pool.query(`delete from aftersales.employee_store where org = $1`, [ORG])
    await pool.query(`delete from aftersales.employee where org = $1`, [ORG])
    await pool.query(`delete from aftersales.employee_approval where org = $1`, [ORG])
    await pool.query(`delete from aftersales.ticket_rule where org = $1`, [ORG])
    await pool.query(`delete from aftersales.product where org = $1`, [ORG])
    await pool.query(`delete from aftersales.store where org = $1`, [ORG])
    await pool.query(`delete from aftersales.region where org = $1`, [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('链路：region→store（FK 解析）→product→employee（store_info 拆行+主门店）→ticket（二义洗清+快照）', async () => {
    await importRegion(pool, ORG, [
      { sourceId: 'R001', name: '华东' },
      { sourceId: 'R002', name: '华北' },
    ])
    await importStore(pool, ORG, [cleanStore({ _id: 'S001', name: '一号店', region_id: 'R001' })])
    await importProduct(pool, ORG, [{ sourceId: 'P001', name: '商品甲', spec: '500ml', basicQuantity: 10, basicUnitPriceMinor: 1250n }])

    const empStat = await importEmployee(pool, ORG, [cleanEmployee(FIXTURE_EMPLOYEE)])
    expect(empStat).toMatchObject({ table: 'employee', fetched: 1, imported: 1 })

    const tStat = await importTicket(pool, ORG, [cleanTicket(FIXTURE_TICKET)])   // product_name='P001' 命中档案
    expect(tStat.imported).toBe(1)

    // FK 与二义洗清
    const t = await pool.query<{
      product_id: string | null; product_name: string; store_id: string | null; store_name: string;
      basic_unit_price_minor: string; amount_minor: string; code: string; related_order: string; client_request_id: string;
    }>(`select product_id, product_name, store_id, store_name, basic_unit_price_minor, amount_minor, code, related_order, client_request_id
          from aftersales.ticket where org = $1`, [ORG])
    expect(t.rows[0].product_id).not.toBeNull()                 // 'P001' 命中 source_id ⇒ 挂 FK
    expect(t.rows[0].product_name).toBe('商品甲')               // 快照名取档案名，不信源串
    expect(t.rows[0].store_id).not.toBeNull()
    expect(t.rows[0].basic_unit_price_minor).toBe('1250')
    expect(t.rows[0].amount_minor).toBe('20000')
    expect(t.rows[0].client_request_id).toBe('')                // 迁移行不占幂等键位
    // employee_store 拆行 + 主门店 = 串里第一个可解析的
    const links = await pool.query<{ store_id: string }>(
      `select es.store_id from aftersales.employee_store es
        join aftersales.employee e on e.id = es.employee_id
       where es.org = $1 order by es.id`, [ORG])
    expect(links.rows).toHaveLength(2)
    const emp = await pool.query<{ store_id: string | null }>(
      `select store_id from aftersales.employee where org = $1`, [ORG])
    expect(Number(emp.rows[0].store_id)).toBe(Number(links.rows[0].store_id))
  })

  it('幂等重跑：同批再导一遍 = 行数不变、字段被覆盖更新（source_id 是幂等位）', async () => {
    await importRegion(pool, ORG, [{ sourceId: 'R001', name: '华东' }])
    await importRegion(pool, ORG, [{ sourceId: 'R001', name: '华东新区' }])   // 重跑带 drifted 值
    const rows = await pool.query<{ n: number; name: string }>(
      `select count(*)::int as n, max(name) as name from aftersales.region where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0]).toEqual({ n: 1, name: '华东新区' })
  })

  it('缺 source_id 的行跳过并记原因（不打断整批）', async () => {
    const stat = await importRule(pool, ORG, [cleanRule({ ...FIXTURE_RULE, _id: '' }), cleanRule(FIXTURE_RULE)])
    expect(stat).toMatchObject({ fetched: 2, imported: 1, skipped: 1 })
    expect(stat.reasons['no_source_id']).toBe(1)
  })

  it('employee_approval 走 004 的 source_id 幂等位', async () => {
    await importEmployeeApproval(pool, ORG, [cleanEmployeeApproval(FIXTURE_EMPLOYEE_APPROVE)])
    await importEmployeeApproval(pool, ORG, [cleanEmployeeApproval(FIXTURE_EMPLOYEE_APPROVE)])
    const rows = await pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.employee_approval where org = $1 and source_id <> ''`, [ORG])
    expect(rows.rows[0].n).toBe(1)
  })
})
```

- [ ] **Step 7: 写 import + reconcile 实现**

`modules/aftersales/migration/import.ts`：

```ts
// import.ts — 清洗行 → 目标库（幂等 upsert；source_id 是幂等位，重跑收敛）。
// 导入顺序约束（FK）：region → store → product → employee(含 employee_store) → rule →
// employee_approval → ticket。archive_* 在 T4 并入（同一顺序原则）。
import type { Pool } from 'pg'
import type {
  CleanEmployee, CleanEmployeeApproval, CleanProduct, CleanRegion, CleanRule, CleanStore, CleanTicket,
} from './clean'

export interface ImportStat {
  table: string
  fetched: number
  imported: number
  skipped: number
  reasons: Record<string, number>
}

function newStat(table: string, fetched: number): ImportStat {
  return { table, fetched, imported: 0, skipped: 0, reasons: {} }
}
function skip(stat: ImportStat, reason: string): void {
  stat.skipped += 1
  stat.reasons[reason] = (stat.reasons[reason] ?? 0) + 1
}

/** 档案 source_id → 库内 id 的映射（FK 解析用）。 */
async function sourceIdMap(pool: Pool, org: string, table: 'region' | 'store' | 'product'): Promise<Map<string, number>> {
  const r = await pool.query<{ source_id: string; id: string }>(
    `select source_id, id from aftersales.${table} where org = $1 and source_id <> ''`, [org])
  return new Map(r.rows.map((row) => [row.source_id, Number(row.id)]))
}

export async function importRegion(pool: Pool, org: string, rows: CleanRegion[]): Promise<ImportStat> {
  const stat = newStat('region', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    await pool.query(
      `insert into aftersales.region (org, source_id, name) values ($1, $2, $3)
       on conflict (org, source_id) where source_id <> '' do update set name = excluded.name`,
      [org, r.sourceId, r.name],
    )
    stat.imported += 1
  }
  return stat
}

export async function importStore(pool: Pool, org: string, rows: CleanStore[]): Promise<ImportStat> {
  const stat = newStat('store', rows.length)
  const regions = await sourceIdMap(pool, org, 'region')
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    const regionId = r.regionSourceId ? regions.get(r.regionSourceId) ?? null : null
    await pool.query(
      `insert into aftersales.store (org, source_id, name, region_id, address, phone)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, region_id = excluded.region_id,
                     address = excluded.address, phone = excluded.phone`,
      [org, r.sourceId, r.name, regionId, r.address, r.phone],
    )
    stat.imported += 1
  }
  return stat
}

export async function importProduct(pool: Pool, org: string, rows: CleanProduct[]): Promise<ImportStat> {
  const stat = newStat('product', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    await pool.query(
      `insert into aftersales.product (org, source_id, name, spec, basic_quantity, basic_unit_price_minor)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, spec = excluded.spec,
                     basic_quantity = excluded.basic_quantity,
                     basic_unit_price_minor = excluded.basic_unit_price_minor`,
      [org, r.sourceId, r.name, r.spec, r.basicQuantity, r.basicUnitPriceMinor ?? 0n],
    )
    stat.imported += 1
  }
  return stat
}

export async function importEmployee(pool: Pool, org: string, rows: CleanEmployee[]): Promise<ImportStat> {
  const stat = newStat('employee', rows.length)
  const stores = await sourceIdMap(pool, org, 'store')
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    // 主门店 = 串里第一个能解析到档案的（§2.5：employee.store_id 保留「主门店」语义，可空）
    const resolved = r.storeSourceIds.map((sid) => stores.get(sid) ?? null)
    const primaryStore = resolved.find((id): id is number => id !== null) ?? null
    const ins = await pool.query<{ id: string }>(
      `insert into aftersales.employee (org, source_id, name, phone, open_id, approve_status, store_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, phone = excluded.phone, open_id = excluded.open_id,
                     approve_status = excluded.approve_status, store_id = excluded.store_id
       returning id`,
      [org, r.sourceId, r.name, r.phone, r.openId, r.approveStatus, primaryStore],
    )
    const employeeId = Number(ins.rows[0].id)
    // 多门店拆行（§2.5 规范化）：先清后插——重跑收敛（快照式导入，源是全量）
    await pool.query(`delete from aftersales.employee_store where org = $1 and employee_id = $2`, [org, employeeId])
    for (const storeId of resolved) {
      if (storeId === null) continue
      await pool.query(
        `insert into aftersales.employee_store (org, employee_id, store_id) values ($1, $2, $3)
         on conflict (org, employee_id, store_id) do nothing`,
        [org, employeeId, storeId],
      )
    }
    stat.imported += 1
  }
  return stat
}

export async function importEmployeeApproval(pool: Pool, org: string, rows: CleanEmployeeApproval[]): Promise<ImportStat> {
  const stat = newStat('employee_approval', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    await pool.query(
      `insert into aftersales.employee_approval
         (org, source_id, open_id, approve_type, status, old_info, new_info, created_at, decided_at, decided_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       on conflict (org, source_id) where source_id <> ''
       do update set status = excluded.status, old_info = excluded.old_info, new_info = excluded.new_info,
                     decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
      [org, r.sourceId, r.openId, r.approveType, r.status,
       JSON.stringify(r.oldInfo), JSON.stringify(r.newInfo),
       r.createdAt, r.decidedAt, r.decidedBy || null],
    )
    stat.imported += 1
  }
  return stat
}

export async function importRule(pool: Pool, org: string, rows: CleanRule[]): Promise<ImportStat> {
  const stat = newStat('ticket_rule', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    await pool.query(
      `insert into aftersales.ticket_rule (org, source_id, name, refund_ratio, remark)
       values ($1, $2, $3, $4, $5)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, refund_ratio = excluded.refund_ratio, remark = excluded.remark`,
      [org, r.sourceId, r.name, r.refundRatio, r.remark],
    )
    stat.imported += 1
  }
  return stat
}

export async function importTicket(pool: Pool, org: string, rows: CleanTicket[]): Promise<ImportStat> {
  const stat = newStat('ticket', rows.length)
  const products = await sourceIdMap(pool, org, 'product')
  const productNames = new Map<string, string>(
    (await pool.query<{ source_id: string; name: string }>(
      `select source_id, name from aftersales.product where org = $1 and source_id <> ''`, [org]),
    ).rows.map((row) => [row.source_id, row.name]),
  )
  const stores = await sourceIdMap(pool, org, 'store')
  const storeNames = new Map<string, string>(
    (await pool.query<{ source_id: string; name: string }>(
      `select source_id, name from aftersales.store where org = $1 and source_id <> ''`, [org]),
    ).rows.map((row) => [row.source_id, row.name]),
  )
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    // 二义洗清（§3.3：product_name 存 ID 或名称）：值命中档案 source_id ⇒ 挂 FK + 以档案名为快照；
    // 否则视为名称快照、不挂 FK。store 同理。
    const productId = products.get(r.productRefRaw) ?? null
    const productName = productId !== null ? productNames.get(r.productRefRaw) ?? '' : r.productRefRaw
    const storeId = stores.get(r.storeRefRaw) ?? null
    const storeName = storeId !== null ? storeNames.get(r.storeRefRaw) ?? '' : r.storeRefRaw
    await pool.query(
      `insert into aftersales.ticket
         (org, source_id, code, submitter_openid, product_id, product_name, store_id, store_name,
          damage_quantity, basic_quantity, basic_unit_price_minor, status, amount_type, amount_minor,
          refund_ratio, operator, remark, related_order, created_at, processed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (org, source_id) where source_id <> ''
       do update set code = excluded.code, submitter_openid = excluded.submitter_openid,
                     product_id = excluded.product_id, product_name = excluded.product_name,
                     store_id = excluded.store_id, store_name = excluded.store_name,
                     damage_quantity = excluded.damage_quantity, basic_quantity = excluded.basic_quantity,
                     basic_unit_price_minor = excluded.basic_unit_price_minor, status = excluded.status,
                     amount_type = excluded.amount_type, amount_minor = excluded.amount_minor,
                     refund_ratio = excluded.refund_ratio, operator = excluded.operator,
                     remark = excluded.remark, related_order = excluded.related_order,
                     processed_at = excluded.processed_at`,
      [org, r.sourceId, r.code, r.submitterOpenid, productId, productName, storeId, storeName,
       r.damageQuantity, r.basicQuantity, r.basicUnitPriceMinor ?? 0n, r.status,
       r.amountType, r.amountMinor ?? 0n, r.refundRatio, r.operator, r.remark, r.relatedOrder,
       r.createdAt, r.processedAt],
    )
    stat.imported += 1
  }
  return stat
}
```

> ⚠️ `on conflict (org, source_id) where source_id <> ''` 的 WHERE 子句不是可省的注释——**部分唯一索引的 conflict target 必须原样带上索引谓词**，缺了 PG 报 `no unique or exclusion constraint matching the ON CONFLICT specification`。`001_init.sql` 的七张表全是这样建索引的，故七处 upsert 同形。
> `client_request_id` **不在** insert 列里（落列缺省 `''`）：迁移行不占 `(org, client_request_id)` 幂等键位（唯一索引 `where client_request_id <> ''` 排除空串），线上新提交与迁移行互不干扰。

`modules/aftersales/migration/reconcile.ts`：

```ts
// reconcile.ts — 对账（spec §3.3：计数 + 金额汇总；一次性快照的验收面）。
// 期望值全部由【同一份 clean 产物】计算（自洽口径）；target 侧只数 source_id <> '' 的迁移行，
// 不混入线上新写行（迁移后业务马上会用，混入会让对账永远红）。
import type { Pool } from 'pg'
import type { CleanTicket } from './clean'

export interface CountCheck { table: string; source: number; target: number; ok: boolean }
export interface SumCheck { label: string; expected: string; actual: string; ok: boolean }

/** targetTable 是 aftersales.<table>；expected.source = 源侧行数（count API 或拉取行数）。 */
export async function reconcileCounts(
  pool: Pool, org: string, expected: { table: string; source: number }[],
): Promise<CountCheck[]> {
  const out: CountCheck[] = []
  for (const e of expected) {
    const r = await pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.${e.table} where org = $1 and source_id <> ''`, [org])
    const target = r.rows[0].n
    out.push({ table: e.table, source: e.source, target, ok: source_eq(e.source, target) })
  }
  return out
}
function source_eq(source: number, target: number): boolean {
  // target ≤ source：源侧被 clean 跳过的行（no_source_id 等）不落库——差额必须能在 ImportStat.reasons 对上。
  // 相等是最优结局；本函数不吞差额（差额核对是人工步，见 CLI 输出）。
  return source === target
}

/** 金额和（bigint 展示为字符串——JS number 装不下分单位总额）。期望值由 CLI 对 clean 产物求和。 */
export async function reconcileTicketSums(
  pool: Pool, org: string, expected: { amountMinor: bigint; basicUnitPriceMinor: bigint },
): Promise<SumCheck[]> {
  const r = await pool.query<{ amount: string; price: string }>(
    `select coalesce(sum(amount_minor), 0)::text as amount,
            coalesce(sum(basic_unit_price_minor), 0)::text as price
       from aftersales.ticket where org = $1 and source_id <> ''`, [org])
  return [
    { label: 'ticket.amount_minor', expected: expected.amountMinor.toString(), actual: r.rows[0].amount,
      ok: expected.amountMinor.toString() === r.rows[0].amount },
    { label: 'ticket.basic_unit_price_minor', expected: expected.basicUnitPriceMinor.toString(), actual: r.rows[0].price,
      ok: expected.basicUnitPriceMinor.toString() === r.rows[0].price },
  ]
}

/** 期望和的计算口径（CLI 用）：对 clean 产物求和（null 视 0）。 */
export function expectedTicketSums(tickets: CleanTicket[]): { amountMinor: bigint; basicUnitPriceMinor: bigint } {
  let amount = 0n
  let price = 0n
  for (const t of tickets) {
    amount += t.amountMinor ?? 0n
    price += t.basicUnitPriceMinor ?? 0n
  }
  return { amountMinor: amount, basicUnitPriceMinor: price }
}
```

`modules/aftersales/migration/reconcile.test.ts`（真库）：

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { expectedTicketSums, reconcileCounts, reconcileTicketSums } from './reconcile'
import { cleanTicket } from './clean'
import { importRegion, importTicket } from './import'
import { FIXTURE_TICKET } from './fixtures'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-m2b-reconcile'

describePg('对账（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query(`delete from aftersales.ticket where org = $1`, [ORG])
    await pool.query(`delete from aftersales.region where org = $1`, [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('计数：相等 ok=true；少一行 ok=false（差额留人工核对，不吞）', async () => {
    await importRegion(pool, ORG, [{ sourceId: 'R001', name: '华东' }])
    const checks = await reconcileCounts(pool, ORG, [{ table: 'region', source: 1 }])
    expect(checks[0].ok).toBe(true)
    const bad = await reconcileCounts(pool, ORG, [{ table: 'region', source: 2 }])
    expect(bad[0]).toMatchObject({ source: 2, target: 1, ok: false })
  })

  it('金额和：同一份 clean 产物的期望 vs 库内实sum，bigint 全程字符串比较', async () => {
    const cleaned = [cleanTicket(FIXTURE_TICKET), cleanTicket({ ...FIXTURE_TICKET, _id: 'wo-002', after_sales_amount: 100 })]
    await importTicket(pool, ORG, cleaned)
    const sums = await reconcileTicketSums(pool, ORG, expectedTicketSums(cleaned))
    expect(sums).toHaveLength(2)
    for (const s of sums) expect(s.ok, `${s.label}: expected=${s.expected} actual=${s.actual}`).toBe(true)
  })
})
```

- [ ] **Step 8: 跑全部纯核测试（红→绿）**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test migration/`
Expected: 先红（模块不存在），实现齐后全 PASS。建议先在**全新空库**（`dropdb platform && createdb platform`）上跑一轮。

- [ ] **Step 9: 写 CLI 薄壳 + env 键 + gitignore**

`scripts/migrate-aftersales-wuji.mjs`：

```js
// @ts-nocheck —— CLI 薄壳：纯核（wuji-source/clean/import/reconcile）在 modules/aftersales/migration/
// 有 vitest 兜底；scripts/ 不在 B1/B8/B9 扫描根内（apps/packages/modules 才是），故 env 键靠
// .env.example 的文档化条目自觉维护。
// migrate-aftersales-wuji.mjs — 售后 M2b：wuji 托管库 → aftersales.*（spec §3.3；issue #151）
// 用法：npx tsx scripts/migrate-aftersales-wuji.mjs --org <casdoor_org> [--tables t1,t2] [--apply]
//         [--sample N] [--sample-out DIR] [--groupbuy-unit fen|yuan]
// 默认 dry-run：拉取 + 清洗 + 打印报告，不写库（--apply 才写）。
// env：WUJI_APPID / WUJI_DATA_ORIGIN（默认 https://data.wujisite.com）/ WUJI_KEY_<大写表名>；
//      DATABASE_URL（--apply 必填）。键值只在 env，绝不进仓/日志/提交。
// 必须用 tsx：纯核是 .ts；pg 经 createRequire 锚到 apps/server 解析（scripts/ 不属于 workspace
// 包——与 migrate-tenant-module-to-subs.mjs 同一坑，D6 切换时实测踩过）。
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { wujiCount, wujiFetchAll, maxMtimeOf } from '../modules/aftersales/migration/wuji-source.ts'
import * as clean from '../modules/aftersales/migration/clean.ts'
import * as imp from '../modules/aftersales/migration/import.ts'
import { expectedTicketSums, reconcileCounts, reconcileTicketSums } from '../modules/aftersales/migration/reconcile.ts'

const ALL_TABLES = [
  'region_info', 'store_info', 'product_archive', 'employee_info', 'employee_info_approve',
  'after_sales_rule', 'after_sales_work_order', 'group_buying_order', 'group_buying_order_item',
]

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const ORG = arg('org')
const APPLY = process.argv.includes('--apply')
const TABLES = (arg('tables') ?? ALL_TABLES.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const SAMPLE = arg('sample') ? Number(arg('sample')) : undefined
const SAMPLE_OUT = arg('sample-out')
const GROUPBUY_UNIT = arg('groupbuy-unit')

async function main() {
  if (!ORG) throw new Error('需要 --org <casdoor_org>（迁移目标租户）')
  const appid = process.env.WUJI_APPID
  const origin = process.env.WUJI_DATA_ORIGIN ?? 'https://data.wujisite.com'
  if (!appid) throw new Error('需要 WUJI_APPID（取法见 .env.example；本地临跑用 export，不落盘）')

  if (SAMPLE_OUT) await mkdir(SAMPLE_OUT, { recursive: true })
  const raw = {}
  for (const t of TABLES) {
    const schemakey = process.env[`WUJI_KEY_${t.toUpperCase()}`]
    if (!schemakey) throw new Error(`缺 WUJI_KEY_${t.toUpperCase()}（wuji 后台「数据源管理」逐表可见）`)
    const cfg = { origin, appid, schemaid: t, schemakey }
    const count = await wujiCount(fetch, cfg)
    const rows = await wujiFetchAll(fetch, cfg, SAMPLE ? { maxRows: SAMPLE } : {})
    raw[t] = rows
    console.log(`[wuji] ${t}: count=${count} pulled=${rows.length} maxMtime=${maxMtimeOf(rows) ?? '-'}`)
    if (SAMPLE_OUT) {
      await writeFile(`${SAMPLE_OUT.replace(/\/$/, '')}/${t}.json`, JSON.stringify(rows, null, 2))
      console.log(`[sample] ${t} → ${SAMPLE_OUT}/${t}.json`)
    }
  }

  // 清洗（groupbuy 守门：接龙表在导入面出现但单位未证 ⇒ --apply 直接拒）
  if (APPLY) {
    if (TABLES.some((t) => t.startsWith('group_buying_'))) {
      if (GROUPBUY_UNIT !== 'fen' && GROUPBUY_UNIT !== 'yuan') {
        throw new Error('接龙表在导入面但 --groupbuy-unit 未给（fen|yuan）。单位只能来自 T3 拉样自证结论（SAMPLE-NOTES.md）或客户答复——禁猜。')
      }
      clean.setGroupbuyUnit(GROUPBUY_UNIT)
    }
    if (!process.env.DATABASE_URL) throw new Error('--apply 需要 DATABASE_URL')
  }

  const cleaned = {
    region: (raw.region_info ?? []).map(clean.cleanRegion),
    store: (raw.store_info ?? []).map(clean.cleanStore),
    product: (raw.product_archive ?? []).map(clean.cleanProduct),
    employee: (raw.employee_info ?? []).map(clean.cleanEmployee),
    approval: (raw.employee_info_approve ?? []).map(clean.cleanEmployeeApproval),
    rule: (raw.after_sales_rule ?? []).map(clean.cleanRule),
    ticket: (raw.after_sales_work_order ?? []).map(clean.cleanTicket),
  }

  if (!APPLY) {
    console.log(`[dry-run] 清洗完成（不写库）：${Object.entries(cleaned).map(([k, v]) => `${k}=${v.length}`).join(' ')}`)
    console.log('[dry-run] 工单金额和（对账期望，单位分）：', expectedTicketSums(cleaned.ticket))
    return
  }

  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    // 导入顺序 = FK 依赖序（T4 的 archive_* 接在 ticket 之后）
    const stats = []
    if (TABLES.includes('region_info')) stats.push(await imp.importRegion(pool, ORG, cleaned.region))
    if (TABLES.includes('store_info')) stats.push(await imp.importStore(pool, ORG, cleaned.store))
    if (TABLES.includes('product_archive')) stats.push(await imp.importProduct(pool, ORG, cleaned.product))
    if (TABLES.includes('employee_info')) stats.push(await imp.importEmployee(pool, ORG, cleaned.employee))
    if (TABLES.includes('after_sales_rule')) stats.push(await imp.importRule(pool, ORG, cleaned.rule))
    if (TABLES.includes('employee_info_approve')) stats.push(await imp.importEmployeeApproval(pool, ORG, cleaned.approval))
    if (TABLES.includes('after_sales_work_order')) stats.push(await imp.importTicket(pool, ORG, cleaned.ticket))
    for (const s of stats) {
      console.log(`[import] ${s.table}: fetched=${s.fetched} imported=${s.imported} skipped=${s.skipped} reasons=${JSON.stringify(s.reasons)}`)
    }
    const counts = await reconcileCounts(pool, ORG, [
      ...(TABLES.includes('region_info') ? [{ table: 'region', source: cleaned.region.length }] : []),
      ...(TABLES.includes('store_info') ? [{ table: 'store', source: cleaned.store.length }] : []),
      ...(TABLES.includes('product_archive') ? [{ table: 'product', source: cleaned.product.length }] : []),
      ...(TABLES.includes('employee_info') ? [{ table: 'employee', source: cleaned.employee.length }] : []),
      ...(TABLES.includes('after_sales_rule') ? [{ table: 'ticket_rule', source: cleaned.rule.length }] : []),
      ...(TABLES.includes('employee_info_approve') ? [{ table: 'employee_approval', source: cleaned.approval.length }] : []),
      ...(TABLES.includes('after_sales_work_order') ? [{ table: 'ticket', source: cleaned.ticket.length }] : []),
    ])
    for (const c of counts) console.log(`[reconcile] ${c.table}: source=${c.source} target=${c.target} ${c.ok ? 'OK' : '❌ DIFF'}`)
    if (TABLES.includes('after_sales_work_order')) {
      for (const s of await reconcileTicketSums(pool, ORG, expectedTicketSums(cleaned.ticket))) {
        console.log(`[reconcile] ${s.label}: expected=${s.expected} actual=${s.actual} ${s.ok ? 'OK' : '❌ DIFF'}`)
      }
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('migrate-aftersales-wuji.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
```

> 接龙守门在 `--apply` 处（单位未证即拒），拉样/dry-run 不拦——T3 正是要靠拉样去自证单位，拦了就自相矛盾。

`.env.example` 末尾追加：

```
# ── 售后 M2b 数据迁移（wuji 托管库只读 API；scripts/migrate-aftersales-wuji.mjs）──
# 真值只落 openship env(isSecret) 或本地临时 export，绝不进仓库/文档/提交信息。
# 取法：wuji 后台「数据源管理」逐表可见 schemaid+schemakey；appid 同页可见。
WUJI_APPID=
# API 起点（spec §3.3 实测口径）；缺省 https://data.wujisite.com
WUJI_DATA_ORIGIN=
WUJI_KEY_REGION_INFO=
WUJI_KEY_STORE_INFO=
WUJI_KEY_PRODUCT_ARCHIVE=
WUJI_KEY_EMPLOYEE_INFO=
WUJI_KEY_EMPLOYEE_INFO_APPROVE=
WUJI_KEY_AFTER_SALES_RULE=
WUJI_KEY_AFTER_SALES_WORK_ORDER=
WUJI_KEY_GROUP_BUYING_ORDER=
WUJI_KEY_GROUP_BUYING_ORDER_ITEM=
```

> B9 门禁只扫 `apps/ packages/ modules/`，`scripts/` 的键不在强制面——**故这段是文档化键面**（B9 不会因缺它红，但键面事实源必须齐：谁能跑迁移、要哪些键，只看这一个文件）。

`.gitignore` 追加一行：

```
modules/aftersales/migration/samples-local/
```

- [ ] **Step 10: CLI 冒烟（无键也能验的薄壳行为）**

Run: `npx tsx scripts/migrate-aftersales-wuji.mjs`
Expected: exit 1 + `需要 --org <casdoor_org>`（薄壳参数校验在工作）
Run: `WUJI_APPID=x npx tsx scripts/migrate-aftersales-wuji.mjs --org test`
Expected: exit 1 + `缺 WUJI_KEY_REGION_INFO …`（键校验在工作；真跑见 T3/T5）

- [ ] **Step 11: 全量验证 + 提交**

Run:
```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test
pnpm --filter aftersales typecheck
pnpm typecheck && pnpm test
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/lint-architecture.mjs
```
Expected: 全绿（`typecheck:scripts` 覆盖 scripts/ 的 .mjs——@ts-nocheck 头让它只查语法形状）。

```bash
git add modules/aftersales scripts/migrate-aftersales-wuji.mjs .env.example .gitignore
git commit -m "feat(aftersales): M2b 迁移脚本骨架——wuji 拉取/清洗/导入/对账纯核 + CLI 薄壳"
gh pr create --title "feat(aftersales): M2b 迁移脚本骨架（纯核可测 + 默认 dry-run）" --body "Closes #151"
```

---

# W1g — 拉样与 archive 定形（gate：外部输入①）

### Task 3: 拉样 + 接龙单位自证 + 脱敏 fixtures（等外部输入）

- [ ] **Step 1: GATE——等外部输入①（wuji appid + schemakey）**

> 键没到位就停在这里：**不要**用猜测的键试探（403 之外什么都证不了），也不要把键写进任何文件。到位形态：openship env(isSecret) 已配（生产跑法），或本会话临时 `export WUJI_APPID=… WUJI_KEY_…=…`（本地临跑，**绝不落盘**）。阻塞时用 `orca orchestration ask` 向编排者要，不要自己绕。

- [ ] **Step 2: 每表拉样 20 行，落本地目录（不进 git）**

```bash
mkdir -p modules/aftersales/migration/samples-local
WUJI_APPID=… WUJI_KEY_REGION_INFO=… （九张表逐个 export） \
npx tsx scripts/migrate-aftersales-wuji.mjs --org <目标租户org> \
  --sample 20 --sample-out modules/aftersales/migration/samples-local
```

Expected: 每表一行 `[wuji] <表>: count=<实测行数> pulled≤20 maxMtime=…` + 九个 JSON 文件。**count 与 spec §3.3 的 2026-09-15 实测行数对一遍**（region 13 / store 322 / employee 591 / approval 214 / product 13,767 / rule 12 / work_order ~25,661——工单仍在涨是预期，其余表大幅偏离要停下报告）。

- [ ] **Step 3: 逐表核对（SAMPLE-NOTES.md 落结论）**

对每张表，把样本与 `clean.ts` 的 `KEYS` 候选**逐字段**对，结论写进 `modules/aftersales/migration/SAMPLE-NOTES.md`（新建；只写字段名/类型/形状结论，**不写任何真实姓名/手机号/openid/金额可定位到个人的值**）：

| 核对项 | 要钉死的 |
|---|---|
| 主键 | `_id` 的实际类型（str/int 漂移是实证过的）与形态 |
| 工单编号 | `TICKET_KEYS.code` 哪个候选是真名（`order_number`…）；`related_order` 引用的接龙单号字段名 |
| 提交人 | work_order 的提交人字段名与拼写（openId/openid/open_id？） |
| 状态/词表 | status / after_sales_type / approve_status 实际值集（英文？中文？还有第四种值？）——补全 `*_MAP`，遇未知值**加跳过原因而不是硬映射** |
| 时间 | 每表实际存在的时间字段名；`_mtime` 形态是否可字典序比较（不可则改 `maxMtimeOf`） |
| `store_info` | 确系逗号串？分隔符形态？有无空段/空格 |
| `approveinfo` | 嵌套形状确系 `{old,new}`？不是则改 `cleanEmployeeApproval` 的展平 |
| `damage_images` | 确认是 COS URL（https://…）；**确认丢弃策略无副作用**（目标侧无任何消费者） |
| 金额量级 | `basic_unit_price` / `after_sales_amount` 的量级是否与「元」自洽（商品单价若显分数量级——比如上万——则 §2.4 实证不覆盖 product_archive，**升级 ask 裁决**，别自行改 `yuanToMinor` 的适用面） |

- [ ] **Step 4: 接龙单位自证（外部输入④的首选来源）**

对 `samples-local/group_buying_order.json` 与 `group_buying_order_item.json`：

1. **量级**：`total_amount` / `price` 的分布——客单价落在几十元级 ⇒ `5000` 是分、`50` 是元（spec §5 #7② 的原判据）；
2. **非整百值**：有无非整百/非整十的值——有 `123.45` 形态 ⇒ 是元带分；全是整百 ⇒ 倾向分；
3. **交叉**：order 与 item 的 `price × quantity ≈ total`（自洽即锁定单位）。

结论（`fen` / `yuan` / **证不出**）写进 SAMPLE-NOTES.md。**证不出 ⇒ `orca orchestration ask` 升级问客户——禁猜是裁决**（`groupbuyToMinor` 未设单位即抛就是为这一步兜底）。

- [ ] **Step 5: 脱敏 fixtures 替换 + KEYS 定稿**

- `fixtures.ts`：用真样本的**结构**替换 W1 编造版——姓名→合成（张三/李四）、手机号→`138****0000` 形态、openid→`oTESTxxx`、可定位金额→保留量级改尾数；**字段名/类型/值形状逐字保留**（clean 的输入面就是它们）。
- `clean.ts` 的 `KEYS`：删掉核对中确认不存在的候选；真名不在候选里则补上。
- 若词表/形状与实现冲突：改实现 + 改测试期望（期望值按替换后的 fixtures 重算），**不留「测试还测着编造样本」的旧稿**。

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test migration/`
Expected: PASS（fixtures 换血后全绿）

- [ ] **Step 6: 提交 + PR**

```bash
git add modules/aftersales/migration/SAMPLE-NOTES.md modules/aftersales/migration/fixtures.ts \
        modules/aftersales/migration/clean.ts modules/aftersales/migration/*.test.ts
git status   # 确认 samples-local/ 不在暂存区（.gitignore 生效）
git commit -m "feat(aftersales): M2b 拉样核对——KEYS 定稿/词表补全/接龙单位自证 + 脱敏 fixtures"
gh pr create --title "feat(aftersales): M2b 拉样核对与接龙单位自证" --body "Closes #151"
```

---

### Task 4: 005_archive.sql（archive_order / archive_order_item）+ 接龙导入

**Files:**
- Create: `modules/aftersales/migrations/005_archive.sql`
- Modify: `modules/aftersales/migration/clean.ts`（`cleanArchiveOrder` / `cleanArchiveOrderItem`）
- Modify: `modules/aftersales/migration/import.ts`（`importArchiveOrder` / `importArchiveOrderItem`）
- Modify: `modules/aftersales/migration/fixtures.ts`（两张接龙表的脱敏样本）
- Modify: `modules/aftersales/migration/clean.test.ts` / `import.test.ts`（扩用例）
- Modify: `modules/aftersales/migration/reconcile.ts` + CLI（archive 计数入对账面）
- Modify: `modules/aftersales/module.test.ts`（表清单断言 7→9 张）

**Interfaces:**
- Consumes: T3 的样本定形（外部输入③）+ 接龙单位结论（④）；`groupbuyToMinor`（设过 `setGroupbuyUnit` 才可用）
- Produces: `aftersales.archive_order` / `archive_order_item`（只读档案表，无业务 API——spec §2.1）；`cleanArchiveOrder(row): CleanArchiveOrder`、`cleanArchiveOrderItem(row): CleanArchiveOrderItem`、`importArchiveOrder(pool, org, rows)`、`importArchiveOrderItem(pool, org, rows)`；`ticket.related_order` 的回填已由 T2 的 `cleanTicket`/`importTicket` 覆盖（值就是源工单行的接龙单号字段）

- [ ] **Step 1: 写 005 迁移（骨架如下——业务列以 T3 样本逐列定形，每列注释标来源字段）**

`modules/aftersales/migrations/005_archive.sql`：

```sql
-- 005_archive.sql — M2b 只读档案表（spec §2.1：group_buying_order(_item) 存量；无业务 API）。
-- 字段按 T3 拉样【实测定形】——下面给出骨架：id/org/source_id/created_at 与两条索引是固定纪律，
-- 「…业务列…」处按样本逐列写，每列注释标来源字段名；金额一律 *_minor 整数分（导入走 groupbuyToMinor）。
-- 外部系统字段一律 text（团队规则 db-migration §2）；FK 类型不匹配（源 batch_id:str→int 漂移）
-- 不在档案层修——档案保真，不做 join 面。
create table if not exists aftersales.archive_order (
  id         bigserial primary key,
  org        text not null,
  source_id  text not null default '',
  -- …业务列（按 group_buying_order 样本逐列：单号/批次/总金额_minor/状态/时间…每列注明来源字段）…
  created_at timestamptz not null default now()
);
create unique index if not exists aftersales_archive_order_org_source_idx
  on aftersales.archive_order(org, source_id) where source_id <> '';

create table if not exists aftersales.archive_order_item (
  id         bigserial primary key,
  org        text not null,
  source_id  text not null default '',
  order_source_id text not null default '',      -- 父单的 source_id（不设 FK：档案保真）
  -- …业务列（按 group_buying_order_item 样本逐列：商品/数量/单价_minor/小计_minor…）…
  created_at timestamptz not null default now()
);
create unique index if not exists aftersales_archive_order_item_org_source_idx
  on aftersales.archive_order_item(org, source_id) where source_id <> '';
create index if not exists aftersales_archive_order_item_org_order_idx
  on aftersales.archive_order_item(org, order_source_id);
```

> 「…业务列…」不是占位符的托词——**它就是本任务的 gate**：DDL 只许在 T3 样本在手后落笔（照猜写 DDL 正是当初把 archive_* 推迟到 M2b 的原因，spec §2.1）。落笔规则：样本里每个业务字段一列、列名 snake_case、来源字段名写进列注释、金额列经 `groupbuyToMinor` 换算。

- [ ] **Step 2: clean/import 扩接龙两表（金额一律 groupbuyToMinor）**

`clean.ts` 追加（形状；业务字段同 Step 1 规则按样本定）：

```ts
export interface CleanArchiveOrder {
  sourceId: string
  /* 业务字段按样本定；金额字段类型 bigint（groupbuyToMinor 产物） */
  totalAmountMinor: bigint
  createdAt: Date | null
}
export interface CleanArchiveOrderItem {
  sourceId: string
  orderSourceId: string
  priceMinor: bigint
  createdAt: Date | null
}
export function cleanArchiveOrder(row: SrcRow): CleanArchiveOrder        // 金额走 groupbuyToMinor（未证即抛）
export function cleanArchiveOrderItem(row: SrcRow): CleanArchiveOrderItem
```

`import.ts` 追加两个 upsert（与既有七表同形：`on conflict (org, source_id) where source_id <> '' do update`）；item 的 `order_source_id` 只存文本引用（不做 FK 查找——档案保真）。

`clean.test.ts` 追加：**未 `setGroupbuyUnit` 时 `cleanArchiveOrder` 抛 `GROUPBUY_UNIT_UNPROVEN`**（接龙禁猜的测试钉）；设 `'fen'`/`'yuan'` 后换算正确。`import.test.ts` 追加两表幂等重跑用例。

`module.test.ts` 的表清单用例（`'7 张表全部落库…'`）改为 9 张：

```ts
  const tables = ['region', 'store', 'product', 'employee', 'ticket_rule', 'ticket', 'ticket_attachment',
                  'archive_order', 'archive_order_item']
```

`reconcile.ts` / CLI：archive 两表入 `reconcileCounts` 面（CLI 的 counts 数组补两条，`--tables` 含接龙表时才对）。

- [ ] **Step 3: 跑全量 + 提交**

Run:
```bash
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter aftersales test
pnpm typecheck && pnpm test
pnpm exec tsx scripts/lint-architecture.mjs
```
Expected: 全绿（rawMigrationSqls 幂等用例自动覆盖 005；表清单断言 9 张过）。

```bash
git add modules/aftersales
git commit -m "feat(aftersales): M2b 档案表 archive_order(_item)——DDL 按拉样定形 + 接龙导入对账"
gh pr create --title "feat(aftersales): M2b 档案表与接龙导入" --body "Closes #151"
```

---

# W2 — 真跑迁移（gate：外部输入②业务空闲窗口）

### Task 5: 一次性全量迁移 + 对账 + 幂等重跑 + 收尾

**执行者是「拿着 openship 权限的操作者」（人或被授权的 agent），不是普通 worktree worker**——本任务每一步都在生产面（openship MCP / 生产容器 / 生产库），遵循「唯一通道」法则（AGENTS/根本法则：运维一律 openship MCP，禁止裸 SSH 手敲）。

- [ ] **Step 1: GATE——三项前置全绿才许动**

1. **窗口已排期**（外部输入②）：客户业务空闲段已确认（一次性快照策略，spec §3.3）。
2. **openship env 已物化**：wuji 11 键 + `DATABASE_URL` 在目标部署的 env(isSecret)（经 openship MCP 核对，**不打印值**）。
3. **备份先行**：经 openship MCP 对目标部署触发一次原生备份（pg-dump producer → OOS）。**没有备份不进 Step 3**——13.2 万行 upsert 前的最后保险。

- [ ] **Step 2: 预跑 dry-run（窗口开始前，记基线）**

生产容器内有完整仓源码 + node_modules（`deploy/Dockerfile.server` 的 runtime 阶段 COPY 了 `scripts/` 与 `modules/`），经 openship server exec 在容器内跑：

```sh
docker exec <platform-core容器> npx tsx scripts/migrate-aftersales-wuji.mjs \
  --org <目标租户org> [--tables region_info,store_info,product_archive,employee_info,employee_info_approve,after_sales_rule,after_sales_work_order,group_buying_order,group_buying_order_item] \
  --groupbuy-unit <T3结论>
```

（容器名经 openship MCP 的项目服务面查；env 已物化在容器 env 里则 `docker exec` 直接可见，缺的键用 `-e` 临时注入、**不写进任何文件**。）

Expected: 每表 `[wuji] … count=N pulled=N maxMtime=…` + `[dry-run] 清洗完成…金额和`。**把这份输出存档**（openship job 的 output 或终端留痕）——它就是**窗口首基线**（count + max `_mtime`）。

- [ ] **Step 3: 窗口内 `--apply`（一次性）**

同 Step 2 命令 + ` --apply`。Expected: 逐表 `[import] …` + `[reconcile] … OK`。**任何 `❌ DIFF` ⇒ 停**：diff 的差额去 `ImportStat.reasons` 对（skipped 行的原因面）；对不上就带着两份输出报告人，**不删数据不重跑掩盖**（迁移只 upsert，重跑是修正手段不是遮羞布）。

- [ ] **Step 4: 幂等重跑验证（裁决的可重跑承诺）**

**紧接着再跑一次 Step 3 的完整命令**。Expected: `[import]` 行数与第一次一致（upsert 覆盖，无重复行）；`[reconcile]` 全 OK 且数值不变。窗口内的源增量（若有）体现在第二次 pulled 数上——把两次 `maxMtime` 与 count 差额记进报告。

- [ ] **Step 5: 线上新行为验证（deploy-verify：流水线绿 ≠ 部署成功）**

- **容器/代码面无关**（本任务不动代码，但迁移是数据面部署）：直接验**新行为在线上可观测**——
  - console 打开 `/console/aftersales`：工单页有数据、翻页可用（≈25,661 条源工单）；员工/商品/门店页有迁移数据（**UI 自验：自己开界面走一遍**，团队纪律）；
  - 抽查一条源工单：金额显示与源侧一致（×100 后的分值 ÷100 回显）；处理弹窗对**已完结**的历史工单不可再处理（409 `ALREADY_PROCESSED` 是正确行为——迁移行 status 不是 pending）。
- **GC job 若 T1 后尚未注册**：补 T1 Step 10（openship job + 机器人账号 + 手动 dry-run 验证）。

- [ ] **Step 6: 收尾落档**

- spec（`docs/superpowers/specs/2026-09-15-aftersales-module-design.md`）：§5 #12 加一行落地注记（GC 已上线：端点/job/参数）、§3.4 M2b 行标「已完成（2026-09-xx，对账结论）」、§7 修订记录加一行。docs PR 免 issue。
- **WeKnora 沉淀**（团队规则 knowledge-capture：先 hybrid-search 查重，命中更新不新建）：
  - wuji 托管库 HTTP API 的实操口径（分页静默忽略参数、403 双因子、count 形状）——已有条目则**更新**实测补充；
  - 「CLI 薄壳 + 纯核可测 + 默认 dry-run + --apply」的迁移范式第 N 次复用的经验增量（若有）；
  - S3 兼容端点 DeleteObject 幂等性在 GC 重跑设计里的用法。
- `samples-local/` 本地目录在收尾后**删除**（PII 不留长尾）；`.gitignore` 条目保留（下次拉样还要用）。

---

## 附：与本计划相关的已知坑（执行时别重踩）

| 坑 | 出处 | 对本计划的影响 |
|---|---|---|
| node-pg 把 bigint 读成 string | 本仓多处注释 | GC/导入的断言比对一律 `Number()`/字符串两侧归一；金额和用字符串比 |
| 部分唯一索引的 conflict target 必须带 WHERE 谓词 | PG 语义（T2 七处 upsert） | `on conflict (org, source_id) where source_id <> ''`——漏 WHERE ⇒ `no unique or exclusion constraint` 报错 |
| 迁移幂等是部署脚本全量重跑的前提 | 团队规则 db-migration §1 | 004/005 全 `if not exists`；rawMigrationSqls 直跑两遍用例自动覆盖 |
| 并发/迁移类测试红只在全新空库上复现 | 团队记忆 test-concurrency-races-need-fresh-empty-db | T2/T4 的 import/reconcile 用例先 `dropdb/createdb` 跑一轮 |
| Orca 工作树中文路径打挂 vitest | 团队记忆 non-ascii-worktree-path-breaks-vitest | 派发块 `--name` 全 ASCII |
| `--base-branch main` 取本地 ref | 团队记忆 orca-base-branch-uses-stale-local-main | 派发前 `git fetch origin main` |
| 桶文件 export 混 type 运行时崩 | #44；AGENTS 硬约束 10 | migration/ 新文件引类型一律 `import type`（fixtures/clean 的 interface 都是被 `import type` 的对象） |
| scripts/ 是 checkJs、JSDoc 字面量类型加宽 | 团队记忆 scripts-checkjs-jsdoc-literal-types-widen | CLI 薄壳 `@ts-nocheck`（同 migrate-tenant-module-to-subs.mjs）；逻辑全在模块 TS 里 |
| wuji 分页参数写错静默忽略 | spec §3.3 实测 | `wuji-source.ts` 只发 page/size；排障先怀疑参数名而不是网络 |
| 改部署配置≠生效（openship env 四层物化） | 团队记忆 openship-env-layering-inline-overrides-project | T5 Step 1 的 env 核对经 openship MCP 看**物化结果**，不是看配置面 |
| 合并只等 CI CLEAN | 团队记忆 merge-only-on-clean-ci | 每个 PR 等 CLEAN；UNSTABLE 不强合 |

---

## 自检记录（作者填，reviewer 可复核）

- **spec 覆盖**：§3.3「全量拉取→清洗→入库→计数/金额对账」→ T2（管线）+ T3（核对定形）+ T5（真跑与对账）；§3.3 源表清单 9 张实搬表 → T2 的 `ALL_TABLES` 与 `.env.example` 键面一一对应，**不迁清单**（`wechat_openid`、接龙活表、`outbound_detail`）未出现在任何导入面；§5 #12 GC → T1（端点+job 触发+行锁设计）；§2.1 四条拍板注记 → 全局约束 1/2/3/4 逐条对应；§5 #7② 接龙单位 → `groupbuyToMinor` 未证即抛 + T3 Step 4 自证步 + T5 `--groupbuy-unit` 守门；§2.4 金额实证 → `yuanToMinor` 唯一换算点 + `ratioOf` 不 ×100；**M-T8-3 无任何任务触及**（约束 4）。
- **占位扫描**：无 TBD/TODO/「适当处理」。两处**有意的 gate 形态**（不是占位）：① `clean.ts` 的 `*_KEYS` 字段名候选标「暂定」——由 T3 拉样核对步钉死，gate 归属明确；② `005_archive.sql` 的业务列「按 T3 样本逐列定」——照猜写 DDL 正是把 archive_* 推迟到 M2b 的原因（spec §2.1），gate 本身就是设计。
- **类型一致性**：`Clean*` 七型在 `clean.ts` 定义、`import.ts`/`reconcile.ts`/CLI 消费，签名逐处核对一致；`bigint` 金额全链（clean 产物 → import 参数 → reconcile 字符串比较）；GC 的 `GcDeps`/`GcOptions`/`GcReport` 在 domain 与 route 两侧一致；`ZosStorage.deleteObject(key: string): Promise<void>` 在 storage/路由/测试三处一致。
- **期望值验算**（node 实测）：`Math.round(7549.99*100)=754999`、`'12.5'→1250n`、`(0.05).toFixed(4)='0.0500'`、`'S001，S002, ,S003'` 拆三段、fixture 工单 `200元→20000n`/`12.5元→1250n`——全部与计划断言一致。

### 自检发现并**就地修正**的缺陷

| # | 缺陷 | 修正 |
|---|---|---|
| 1 | **头部引用悬空**：`issue-151-scope.md` / `ledger-fixes.md` 写成仓内路径，实测 `git ls-files .superpowers` **零输出**——两文件是编排 worktree 的本地材料，worker 在自己 worktree 里按路径找不到 | 头部改为「编排侧材料（未进仓，派发 spec 里随附）」并注明看不到时找编排者要 |
| 2 | **测试断言与实证类型打架**：`employee_info_approve._id` 实证是 **int**（§3.3），fixture 正确写了 `214001`，但断言写了 `'214-001'`——`pickStr` 字符串化产物是 `'214001'`，照抄必红 | 断言改 `'214001'`，并加注「源 _id 与 employee_info 的 str 不同型，别写带横线的假 id」 |
| 3 | **范文块留死代码**（问数计划 #35 同类）：`wuji-source.test` 草稿里留了整段 `expectUrlContaining` 死函数 + 「落盘时删掉」注记；CLI 草稿里留了空 `if` 与重复的 `createRequire` 动态导入 | 三处全部直接清干净（死函数删、空 if 删、动态导入改用顶部静态导入）；注记只保留仍然成立的那句（接龙守门位置的理由） |
| 4 | **GC 竞态方向想反了**（写作中发现，未流入正文）：先删对象后删行的写法在「删对象后、删行前被认领」窗口会把**已挂活工单的附件**对象删掉；先删行后删对象则在崩溃时泄漏对象 | 定稿为**行锁先行**：`SELECT … FOR UPDATE`（谓词含 `ticket_id is null`）→ 删对象（事务内）→ 删行 → COMMIT；两种崩溃方向都收敛到「行保留、下轮重试」，代价（行锁跨一次 S3 调用）已在 T1 注明 |
| 5 | **`employee_approval` 无幂等位**（002 建表没有 `source_id`）：T2 若直接导入，`--apply` 重跑会让 214 行翻倍 | 补 `004_employee_approval_source_id.sql`（`add column if not exists` + 部分唯一索引，与 001 同模式），导入 upsert 与 `module.test.ts` 幂等用例自动覆盖 |

### 有意的取舍（reviewer 请过目）

- **GC 走「机器人账号密码登录换 session」而非新鉴权面**：模块 API 门卫在 identity 层，平台当前没有模块面机器 token（PAT 属问数计划、未合入）；为一条 GC 端点扩鉴权协议是越权改动。密码登录链（`POST /api/platform/auth/login`）是既有能力，凭据走 openship job secrets。
- **对账期望值由同一份 clean 产物计算**（而非独立第二实现）：自洽口径，验的是「导入没丢没重」；「清洗本身对不对」由 T3 的人工核对清单 + fixtures 单测把另一道关。两份独立实现的期望值对 13.2 万行是纯成本。
- **`reconcileCounts` 的 `target ≤ source` 差额不自动判绿**：skipped 行（`no_source_id` 等）的差额要人对 `ImportStat.reasons`——静默吞差额等于把丢数据染绿。
