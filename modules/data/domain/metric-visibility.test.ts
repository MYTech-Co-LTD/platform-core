// metric-visibility.test.ts — 部门上下文与可见性纯谓词（P2 Task 2，spec 2026-11-12 §8）
//
// 结构：metricVisibleWithDept 是**纯谓词**——真值表全量单测，无库也全跑。计划钉死的语义：
//   owner_dept 空 ⇒ 恒真（平台通用，行为与今天逐字节相同）；ctx 缺 ⇒ 假（fail-closed）；
//   部门链（自身/祖先/后代）真；兄弟假；`visible_depts` 只认**直属**（命中祖先/后代也假）。
// loadDeptContext 的 SQL 吃 `platform.v_org_*` 只读视图——夹具写**底层真表**
//   `platform.org_node` / `platform.org_membership`（reports.test.ts 部门门块同款做法），
//   合成租户 + `org-p2-vis-*` 前缀隔离，afterAll 清场；有 DATABASE_URL 才跑。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyPlatformMigrations } from '../test-util'
import { loadDeptContext, metricVisibleWithDept } from './metric-visibility'
import type { DeptContext } from './metric-visibility'

// ── 纯谓词真值表（无库）──────────────────────────────────────────────
// 夹具树沿用 dept-gate 的注释树：49(共享中心) → 57(数字技术部) → 66(店)；80 是另一支（兄弟）。
// viewer 直属 57 ⇒ canOwn = {49, 57, 66}（自身∪祖先∪后代）、memberOf = {57}（直属）。
const VIEWER = (): DeptContext => ({
  canOwn: new Set(['49', '57', '66']),
  memberOf: new Set(['57']),
})

describe('metricVisibleWithDept（真值表）', () => {
  it('平台指标（owner_dept 空）恒真——ctx 缺也一样', () => {
    expect(metricVisibleWithDept({ ownerDept: null, visibleDepts: null }, undefined)).toBe(true)
    expect(metricVisibleWithDept({ ownerDept: null, visibleDepts: null }, VIEWER())).toBe(true)
    expect(metricVisibleWithDept({ ownerDept: null, visibleDepts: ['49'] }, VIEWER())).toBe(true)
  })

  it('字段缺席（Task 3 结构兼容面：行不带这两个字段）⇒ 视作平台指标', () => {
    // visibleMetrics 的泛型行（MetricDef 形状）可以两个都没有——缺席与 null 同义。
    expect(metricVisibleWithDept({}, undefined)).toBe(true)
    expect(metricVisibleWithDept({ visibleDepts: ['57'] }, undefined)).toBe(true)
  })

  it("ownerDept 空串归一成 null ⇒ 平台桶（P1 台账边界，Task 3 订正）", () => {
    // 同名互斥索引 coalesce(owner_dept,'') 早已把空串并进平台桶——可见性判定同口径。
    expect(metricVisibleWithDept({ ownerDept: '', visibleDepts: null }, undefined)).toBe(true)
    expect(metricVisibleWithDept({ ownerDept: '' }, VIEWER())).toBe(true)
  })

  it('owned + 无 ctx ⇒ 假（fail-closed；visible_depts 就算写了自己的部门也救不了）', () => {
    expect(metricVisibleWithDept({ ownerDept: '57', visibleDepts: null }, undefined)).toBe(false)
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: ['57'] }, undefined)).toBe(false)
  })

  it('owned + 部门链上（自身/祖先/后代三种）⇒ 真', () => {
    expect(metricVisibleWithDept({ ownerDept: '57', visibleDepts: null }, VIEWER())).toBe(true) // 自身
    expect(metricVisibleWithDept({ ownerDept: '49', visibleDepts: null }, VIEWER())).toBe(true) // 祖先
    expect(metricVisibleWithDept({ ownerDept: '66', visibleDepts: null }, VIEWER())).toBe(true) // 后代
  })

  it('owned + 兄弟（链外）⇒ 假', () => {
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: null }, VIEWER())).toBe(false)
  })

  it('visible_depts 命中**直属** ⇒ 真（兄弟开门的唯一途径）', () => {
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: ['57'] }, VIEWER())).toBe(true)
  })

  it('visible_depts 命中祖先 ⇒ 假（显式共享只认直属，钉死语义）', () => {
    // 49 在 canOwn 里（祖先可见），但它不是直属——共享给它不放行
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: ['49'] }, VIEWER())).toBe(false)
  })

  it('visible_depts 命中后代 ⇒ 假（同上，只认直属）', () => {
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: ['66'] }, VIEWER())).toBe(false)
  })

  it('空 visible_depts ⇒ 假；null 与 [] 同待遇', () => {
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: [] }, VIEWER())).toBe(false)
  })

  it('多部门归属取并集：任一直属命中共享即放行', () => {
    const two: DeptContext = {
      canOwn: new Set(['49', '57', '66', '80']),
      memberOf: new Set(['57', '80']),
    }
    expect(metricVisibleWithDept({ ownerDept: '80', visibleDepts: ['80'] }, two)).toBe(true)
    // 反向也不误伤：链外指标的共享部门不在 memberOf 照样假
    expect(metricVisibleWithDept({ ownerDept: '90', visibleDepts: ['66'] }, two)).toBe(false)
  })
})

// ── loadDeptContext（真库夹具）───────────────────────────────────────
const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const TENANT = 9207 // 合成租户（reports.test.ts 用 9107，错开）
const ROOT = 'org-p2-vis-root'
const CHILD = 'org-p2-vis-child'
const GRAND = 'org-p2-vis-grand'
const SIB = 'org-p2-vis-sib'
const DEAD = 'org-p2-vis-dead'
const U1 = 'org-p2-vis-u1' // 直属 child
const U2 = 'org-p2-vis-u2' // 直属 root

describePg('loadDeptContext（真库，platform.org_* 夹具）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  const insDept = async (extId: string, parent: string | null, path: string, status = 1) => {
    await pool.query(
      `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, ext_id) do update
         set parent_ext_id = excluded.parent_ext_id, path = excluded.path, status = excluded.status`,
      [TENANT, extId, extId, parent, path, status],
    )
  }
  const insMember = async (userName: string, extId: string) => {
    await pool.query(
      `insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary)
       values ($1, $2, $3, true) on conflict do nothing`,
      [TENANT, userName, extId],
    )
  }

  beforeAll(async () => {
    // 模块测试壳没有宿主：平台迁移自己拉一遍（org 视图/表 + platform.tenant），幂等。
    await applyPlatformMigrations(pool)
    await pool.query(
      `insert into platform.tenant(id, slug, casdoor_org) values ($1, $2, $3)
       on conflict (id) do nothing`,
      [TENANT, 'org-p2-vis-fixture', 'org-p2-vis'],
    )
    // 上一次跑挂残留也幂等：先清本租户再种（org-p2-vis-* 前缀 + 专用租户隔离，不碰别人）
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT])
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT])
    await insDept(ROOT, null, ROOT)
    await insDept(CHILD, ROOT, `${ROOT}.${CHILD}`)
    await insDept(GRAND, CHILD, `${ROOT}.${CHILD}.${GRAND}`)
    await insDept(SIB, null, SIB)
    await insDept(DEAD, CHILD, `${ROOT}.${CHILD}.${DEAD}`, 0) // 软删节点：不得进 canOwn
    await insMember(U1, CHILD)
    await insMember(U2, ROOT)
  })

  afterAll(async () => {
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT]).catch(() => {})
    await pool.query('delete from platform.tenant where id = $1', [TENANT]).catch(() => {})
    await pool.end()
  })

  it('直属 child：memberOf=直属；canOwn=自身∪祖先∪后代，不含兄弟、不含死节点', async () => {
    const c = await loadDeptContext(pool, TENANT, { userId: U1 })
    expect([...c.memberOf].sort()).toEqual([CHILD])
    expect(c.canOwn.has(CHILD)).toBe(true)
    expect(c.canOwn.has(ROOT)).toBe(true) // 祖先
    expect(c.canOwn.has(GRAND)).toBe(true) // 后代
    expect(c.canOwn.has(SIB)).toBe(false) // 兄弟分支
    expect(c.canOwn.has(DEAD)).toBe(false) // status=0 的后代（dept-gate 的 join 同样丢）
  })

  it('候选名走 deptNamesOf：userId 不认识、accountName 认识 ⇒ 按它取', async () => {
    const c = await loadDeptContext(pool, TENANT, { userId: 'org-p2-vis-nobody', accountName: U2 })
    expect([...c.memberOf].sort()).toEqual([ROOT])
  })

  it('org 表无此人 ⇒ 两集皆空（fail-closed 由谓词收口）', async () => {
    const c = await loadDeptContext(pool, TENANT, { userId: 'org-p2-vis-ghost' })
    expect(c.memberOf.size).toBe(0)
    expect(c.canOwn.size).toBe(0)
  })
})
