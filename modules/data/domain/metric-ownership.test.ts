import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import type { MetricDef } from './authz'
import { upsertMetric } from './metric-store'
import {
  OwnershipError,
  assertConcept,
  assertTitleFree,
  platformConcepts,
  tenantConcepts,
} from './metric-ownership'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text）——本文件专用 org，beforeAll 前后只按它清理（不打兄弟文件的夹具）。 */
const ORG = 'org-p1-mo'

/**
 * 平台概念夹具（注入 temp YAML 的小文件；前缀 `p1mo_` 与真实 `dbt/semantics/l1_metrics.yml`
 * 的 entities 键不可能重名——真实文件由别的用例按「动态取一个真实键」消费，两边互不依赖）。
 */
function makeSemanticsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'p1mo-semantics-'))
  mkdirSync(join(dir, 'dbt/semantics'), { recursive: true })
  writeFileSync(
    join(dir, 'dbt/semantics/l1_metrics.yml'),
    [
      'entities:',
      '  p1mo_alpha:',
      '    label: 甲',
      '  p1mo_beta:',
      '    label: 乙',
      '  p1mo_gamma:',
      '    label: 丙',
      'metrics: []',
      '',
    ].join('\n'),
    'utf8',
  )
  return dir
}

function def(over: Partial<MetricDef> = {}): MetricDef {
  const id = over.id ?? 'p1mo_metric'
  return {
    id,
    // 047 部门内同名互斥：夹具标题派生自 id（缺省不撞桶），要验互斥的用例显式给同名标题。
    title: `P1MO 夹具·${id}`,
    description: '',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
    groupBy: '',
    params: {},
    ...over,
  }
}

/** L2 夹具写路径（upsertMetric 落全部必填列）+ 显式补 owner_dept（归属列 Task 3 才进 upsert）。 */
async function putWithDept(
  pool: Pool, id: string, title: string, ownerDept: string | null,
): Promise<string> {
  await upsertMetric(pool, ORG, def({ id, title }), 'fixture')
  await pool.query('update data.metrics set owner_dept = $3 where org = $1 and id = $2', [ORG, id, ownerDept])
  return id
}

describePg('metric-ownership（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const tmpSemantics = makeSemanticsDir()

  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metric_concept where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
    rmSync(tmpSemantics, { recursive: true, force: true })
  })

  // ── platformConcepts ────────────────────────────────────────────────────────────────────
  it('platformConcepts：解析注入目录 YAML 的顶层 entities 键（夹具 3 个）', () => {
    const concepts = platformConcepts(tmpSemantics)
    expect([...concepts].sort()).toEqual(['p1mo_alpha', 'p1mo_beta', 'p1mo_gamma'])
  })

  it('platformConcepts：真实仓文件非空且含 branch（缺省 baseDir = 仓根）', () => {
    // 生产镜像内该文件在场 ⇒ 真集非空；只断言非空 + 抽查，不把用例钉死在具体键清单上。
    expect(platformConcepts().size).toBeGreaterThan(0)
    expect(platformConcepts().has('branch')).toBe(true)
  })

  it('platformConcepts：YAML 不可读 ⇒ 空集 + console.warn，不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const concepts = platformConcepts(join(tmpdir(), 'p1mo-does-not-exist'))
      expect(concepts.size).toBe(0)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  // ── tenantConcepts / assertConcept（并集） ──────────────────────────────────────────────
  it('概念并集 = 平台 ∪ 租户：平台键与租户新增键都放行，未知拒，null/空串放行', async () => {
    await applyMigrations(pool)
    await pool.query(
      'insert into data.metric_concept (org, name, label, created_by) values ($1, $2, $3, $4)',
      [ORG, 'p1mo_tenant_only', '租户自有概念', 'fixture'],
    )

    expect([...(await tenantConcepts(pool, ORG))]).toEqual(['p1mo_tenant_only'])

    // 平台键：从真实仓文件动态取一个（不把用例钉死在具体键清单上）。
    const known = [...platformConcepts()][0]
    expect(known).not.toBeUndefined()
    await expect(assertConcept(pool, ORG, known)).resolves.toBeUndefined()

    // 租户键放行。
    await expect(assertConcept(pool, ORG, 'p1mo_tenant_only')).resolves.toBeUndefined()

    // 未知拒。
    await expect(assertConcept(pool, ORG, 'p1mo_nope')).rejects.toMatchObject({
      name: 'OwnershipError',
      code: 'UNKNOWN_CONCEPT',
    })

    // 未声明（null / 空串）= 不校验，放行（L2 语义：解不出基底 ⇒ entity 留空）。
    await expect(assertConcept(pool, ORG, null)).resolves.toBeUndefined()
    await expect(assertConcept(pool, ORG, '')).resolves.toBeUndefined()
  })

  it('OwnershipError 是 Error 子类，extra 原样携带', async () => {
    const err = new OwnershipError('TITLE_EXISTS_IN_DEPT', { existingId: 'm1' })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('TITLE_EXISTS_IN_DEPT')
    expect(err.extra).toEqual({ existingId: 'm1' })
  })

  // ── assertTitleFree（与 metrics_title_per_dept_uq 同判据） ──────────────────────────────
  it('同名拒：同部门桶命中 ⇒ TITLE_EXISTS_IN_DEPT 并带回 existingId', async () => {
    await applyMigrations(pool)
    const id = await putWithDept(pool, 'p1mo_metric_dept', '销售概览·P1MO同名夹具', 'dept-a')
    await expect(assertTitleFree(pool, ORG, 'dept-a', '销售概览·P1MO同名夹具')).rejects.toMatchObject({
      name: 'OwnershipError',
      code: 'TITLE_EXISTS_IN_DEPT',
      extra: { existingId: id },
    })
  })

  it('同名拒：平台桶（owner_dept 为空）同样互斥（coalesce 判据）', async () => {
    await applyMigrations(pool)
    await putWithDept(pool, 'p1mo_metric_plain', '总览·P1MO同名夹具', null)
    await expect(assertTitleFree(pool, ORG, null, '总览·P1MO同名夹具')).rejects.toMatchObject({
      code: 'TITLE_EXISTS_IN_DEPT',
    })
    // 其他部门桶与空桶互不干扰：不同桶同名放行。
    await expect(assertTitleFree(pool, ORG, 'dept-b', '销售概览·P1MO同名夹具')).resolves.toBeUndefined()
    await expect(assertTitleFree(pool, ORG, 'dept-a', '总览·P1MO同名夹具')).resolves.toBeUndefined()
  })

  it('同名判据大小写不敏感（lower(title)，与唯一索引同尺）', async () => {
    await applyMigrations(pool)
    await putWithDept(pool, 'p1mo_metric_case', 'P1Mo Fixture', null)
    await expect(assertTitleFree(pool, ORG, null, 'p1mo fixture')).rejects.toMatchObject({
      code: 'TITLE_EXISTS_IN_DEPT',
    })
  })

  it('excludeMetricId 放行自身（改名场景：只挡别人，不挡自己）', async () => {
    await applyMigrations(pool)
    const id = await putWithDept(pool, 'p1mo_metric_self', '自改名·P1MO夹具', 'dept-a')
    await expect(
      assertTitleFree(pool, ORG, 'dept-a', '自改名·P1MO夹具', id),
    ).resolves.toBeUndefined()
    // 换成别人的 id 仍拒。
    await expect(
      assertTitleFree(pool, ORG, 'dept-a', '自改名·P1MO夹具', 'p1mo_metric_other'),
    ).rejects.toMatchObject({ code: 'TITLE_EXISTS_IN_DEPT' })
  })
})
