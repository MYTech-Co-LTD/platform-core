import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from './test-util'
import { validateSubmission } from './domain/contract'

// 内核断言套件（issue #710）：explore/poc/lifecycle-unified 28 断言的多租户工程化对账。
// 口径（RESULTS.md §1/§2）：不经应用层，**直接 pool.query 调 SQL 函数与裸 SQL**——
// I 组与字典 key 不可变测试就是绕过层测试本身（防假绿：越过 API 也必须被 DB 拦）。
// 量具坑（PoC RESULTS §3.6）：同一语句内「写函数→立刻读表」读不到刚写的行——逐条分语句。
// 清理纪律：只删本测试 org 的行（org-scoped，不碰兄弟夹具）。

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// org 每 run 唯一：published/retired 行按 DB 契约**物理不可删**（触发器拦——这是被测行为本身），
// 共享库上固定 org 的清场会在第二轮撞触发器。afterAll 只做尽力而为的 draft 清理，其余行留在
// 唯一 org 下（惰性数据，不碰兄弟夹具）。
const ORG = `org-forms-kernel-${Math.random().toString(36).slice(2, 8)}`
const KIND = 'form_def'

// 各组独立 asset，避免链上前置失败滚雪球
const A_DRAFT = 'k-draft'
const A_PUB = 'k-pub'
const A_FLOW = 'k-flow'
const A_NOHEAD = 'k-nohead'

const bodyV1 = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
const bodyV2 = {
  type: 'object',
  properties: { name: { type: 'string' }, region: { type: 'string' } },
  required: ['name', 'region'],
}

describePg('forms 生命周期内核（PoC 28 断言对账）', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
  })

  afterAll(async () => {
    // 尽力而为：published/retired 行删不掉是**被测契约**（触发器拦），吞掉即可
    for (const t of ['submission', 'asset_head', 'asset_version']) {
      await pool.query(`delete from forms.${t} where org = $1`, [ORG]).catch(() => {})
    }
    await pool.end()
  })

  const md5 = async (asset: string, version: number): Promise<string> => {
    const { rows } = await pool.query(
      'select md5(body::text) h from forms.asset_version where org=$1 and asset_id=$2 and version=$3',
      [ORG, asset, version],
    )
    return rows[0]?.h ?? ''
  }
  const head = async (asset: string): Promise<number | null> => {
    const { rows } = await pool.query(
      'select active_version from forms.asset_head where org=$1 and asset_id=$2',
      [ORG, asset],
    )
    return rows[0]?.active_version ?? null
  }
  const statusOf = async (asset: string, version: number): Promise<string | null> => {
    const { rows } = await pool.query(
      'select status from forms.asset_version where org=$1 and asset_id=$2 and version=$3',
      [ORG, asset, version],
    )
    return rows[0]?.status ?? null
  }

  it('G0：迁移幂等（账本第二遍跳过 + 裸 SQL 重放全文件不抛）', async () => {
    const { rawMigrationSqls } = await import('./test-util')
    // beforeAll 已应用过 ⇒ 此处返回空列表即「账本第二遍跳过」的证据（不抛）
    const r1 = await applyMigrations(pool)
    expect(Array.isArray(r1)).toBe(true)
    // 真幂等：SQL 本体（if not exists / drop if exists / on conflict）在已迁移库上重放
    const sqls = await rawMigrationSqls()
    for (const sql of sqls) await pool.query(sql)
    const { rows } = await pool.query(
      "select table_name from information_schema.tables where table_schema='forms'",
    )
    expect(new Set(rows.map((r) => r.table_name))).toEqual(
      new Set(['kind', 'asset_version', 'asset_head', 'submission', 'dict_item', 'dict_global_item']),
    )
  })

  it('K0：kind 表策略驱动（form_def=human_gate；未知 kind 发布拒）', async () => {
    const { rows } = await pool.query("select publish_policy from forms.kind where kind='form_def'")
    expect(rows[0].publish_policy).toBe('human_gate')
    await expect(
      pool.query("select forms.publish($1,'nope','a',1,'u','human')", [ORG]),
    ).rejects.toThrow(/unknown kind/)
  })

  it('D1–D4：draft 建/改/删自由，独立回读不采信返回值', async () => {
    const v = await pool.query('select forms.new_draft($1,$2,$3,$4,$5) v', [
      ORG, KIND, A_DRAFT, JSON.stringify(bodyV1), 'drafter-1',
    ])
    expect(v.rows[0].v).toBe(1) // D1
    // D4：独立回读
    const row1 = await pool.query(
      'select body, status, created_by from forms.asset_version where org=$1 and asset_id=$2 and version=1',
      [ORG, A_DRAFT],
    )
    expect(row1.rows[0].status).toBe('draft')
    expect(row1.rows[0].created_by).toBe('drafter-1')
    await pool.query('select forms.update_draft($1,$2,$3,$4,$5)', [
      ORG, KIND, A_DRAFT, 1, JSON.stringify({ revised: true }),
    ]) // D2
    const row2 = await pool.query(
      'select body from forms.asset_version where org=$1 and asset_id=$2 and version=1',
      [ORG, A_DRAFT],
    )
    expect(row2.rows[0].body).toEqual({ revised: true }) // D4 回读改后 body
    await pool.query('select forms.drop_draft($1,$2,$3,$4)', [ORG, KIND, A_DRAFT, 1]) // D3
    const gone = await pool.query(
      'select count(*)::int n from forms.asset_version where org=$1 and asset_id=$2',
      [ORG, A_DRAFT],
    )
    expect(gone.rows[0].n).toBe(0) // D4 回读已删
  })

  it('update_draft/drop_draft 撞不存在的版本 → 可解释报错（fail-closed）', async () => {
    await expect(
      pool.query('select forms.update_draft($1,$2,$3,$4,$5)', [ORG, KIND, A_DRAFT, 99, '{}']),
    ).rejects.toThrow(/not found/)
    await expect(
      pool.query('select forms.drop_draft($1,$2,$3,$4)', [ORG, KIND, A_DRAFT, 99]),
    ).rejects.toThrow(/not found/)
  })

  it('P1：发布门拒的是角色——agent 撞 human_gate 策略被拒', async () => {
    await pool.query('select forms.new_draft($1,$2,$3,$4,$5)', [
      ORG, KIND, A_PUB, JSON.stringify(bodyV1), 'drafter-1',
    ])
    await expect(
      pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [ORG, KIND, A_PUB, 1, 'agent-1', 'agent']),
    ).rejects.toThrow(/requires human gate/)
  })

  it('P2：human 发布过——status/published_by/published_at/head 四件联查', async () => {
    await pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [ORG, KIND, A_PUB, 1, 'human-1', 'human'])
    const { rows } = await pool.query(
      `select v.status, v.published_by, v.published_at, h.active_version
         from forms.asset_version v
         join forms.asset_head h on h.org=v.org and h.asset_id=v.asset_id
        where v.org=$1 and v.asset_id=$2 and v.version=1`,
      [ORG, A_PUB],
    )
    expect(rows[0].status).toBe('published')
    expect(rows[0].published_by).toBe('human-1')
    expect(rows[0].published_at).not.toBeNull()
    expect(rows[0].active_version).toBe(1)
  })

  it('I1：裸 SQL 直改 published body → DB 触发器拦（绕过 API 也拦）', async () => {
    await expect(
      pool.query(
        "update forms.asset_version set body='{\"hacked\":true}' where org=$1 and asset_id=$2 and version=1",
        [ORG, A_PUB],
      ),
    ).rejects.toThrow(/immutable/)
  })

  it('I2：物理删 published → 拦（软删走 retire）', async () => {
    await expect(
      pool.query('delete from forms.asset_version where org=$1 and asset_id=$2 and version=1', [ORG, A_PUB]),
    ).rejects.toThrow(/not deletable/)
  })

  it('I3：伪造 internal 旗标改 body / 退回 draft → 只放行 published→retired', async () => {
    // ⚠️ set_config(local) 必须与 UPDATE 同一查询串才同事务；多语句查询不能带 $ 参数
    //（pg 扩展协议拒「multiple commands」）——org/asset 是本文件常量，字面量内联安全。
    await expect(
      pool.query(
        `select set_config('lifecycle.internal','on',true);
         update forms.asset_version set body='{"x":1}'
          where org='${ORG}' and asset_id='${A_PUB}' and version=1`,
      ),
    ).rejects.toThrow(/internal transition allows only/)
    await expect(
      pool.query(
        `select set_config('lifecycle.internal','on',true);
         update forms.asset_version set status='draft'
          where org='${ORG}' and asset_id='${A_PUB}' and version=1`,
      ),
    ).rejects.toThrow(/internal transition allows only/)
  })

  it('V1/V2：修改=新版本（v2 编号递增），旧版 body md5 原封', async () => {
    const h1Before = await md5(A_PUB, 1)
    const v = await pool.query('select forms.new_draft($1,$2,$3,$4,$5) v', [
      ORG, KIND, A_PUB, JSON.stringify(bodyV2), 'drafter-2',
    ])
    expect(v.rows[0].v).toBe(2) // V2
    await pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [ORG, KIND, A_PUB, 2, 'human-1', 'human'])
    expect(await md5(A_PUB, 1)).toBe(h1Before) // V1
    expect(await statusOf(A_PUB, 2)).toBe('published')
  })

  it('S1：提交钉住 head 版本，审计记人', async () => {
    await pool.query('select forms.new_draft($1,$2,$3,$4,$5)', [
      ORG, KIND, A_FLOW, JSON.stringify(bodyV1), 'drafter-1',
    ])
    await pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [ORG, KIND, A_FLOW, 1, 'human-1', 'human'])
    const r = await pool.query('select forms.submit($1,$2,$3,$4,$5) id', [
      ORG, KIND, A_FLOW, JSON.stringify({ name: '张三' }), 'submitter-1',
    ])
    const id = r.rows[0].id
    const { rows } = await pool.query(
      'select org, version, payload, submitted_by from forms.submission where id=$1',
      [id],
    )
    expect(rows[0].org).toBe(ORG)
    expect(rows[0].version).toBe(1)
    expect(rows[0].payload).toEqual({ name: '张三' })
    expect(rows[0].submitted_by).toBe('submitter-1')
  })

  it('S2：契约收紧（v2 加必填）对新提交立即生效——按 head 契约校验拒旧形状', async () => {
    await pool.query('select forms.new_draft($1,$2,$3,$4,$5)', [
      ORG, KIND, A_FLOW, JSON.stringify(bodyV2), 'drafter-2',
    ])
    await pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [ORG, KIND, A_FLOW, 2, 'human-1', 'human'])
    expect(await head(A_FLOW)).toBe(2)
    const { rows } = await pool.query('select forms.body_at($1,$2,$3,$4) body', [ORG, KIND, A_FLOW, 2])
    const r = validateSubmission({
      schema: rows[0].body,
      payload: { name: '张三' }, // 旧形状：缺 v2 新必填 region
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('SCHEMA_INVALID')
  })

  it('R1–R3：回滚只切指针零数据改写（双 md5 不变）；回 draft/无 head 拒', async () => {
    const h1 = await md5(A_FLOW, 1)
    const h2 = await md5(A_FLOW, 2)
    await pool.query('select forms.rollback_to($1,$2,$3,$4)', [ORG, KIND, A_FLOW, 1])
    expect(await head(A_FLOW)).toBe(1)
    expect(await md5(A_FLOW, 1)).toBe(h1) // R1：数据零改写
    expect(await md5(A_FLOW, 2)).toBe(h2)
    await pool.query('select forms.rollback_to($1,$2,$3,$4)', [ORG, KIND, A_FLOW, 2]) // 切回 v2 继续
    expect(await head(A_FLOW)).toBe(2)
    // R3：draft 不可回
    await pool.query('select forms.new_draft($1,$2,$3,$4,$5)', [
      ORG, KIND, A_FLOW, JSON.stringify({ rev: 3 }), 'drafter-3',
    ])
    await expect(
      pool.query('select forms.rollback_to($1,$2,$3,$4)', [ORG, KIND, A_FLOW, 3]),
    ).rejects.toThrow(/only published is rollback-able/)
    // 无 head 资产回滚拒——目标 v1 是 draft，先撞「target 必须 published」这一道（同 /no head/ 语义闭合）
    await pool.query('select forms.new_draft($1,$2,$3,$4,$5)', [
      ORG, KIND, A_NOHEAD, JSON.stringify(bodyV1), 'drafter-1',
    ])
    await expect(
      pool.query('select forms.rollback_to($1,$2,$3,$4)', [ORG, KIND, A_NOHEAD, 1]),
    ).rejects.toThrow(/only published is rollback-able/)
  })

  it('T0/T1：head 不可退；非 head 退役=软删（行在、body 原封、retired_at 落值）', async () => {
    await expect(
      pool.query('select forms.retire($1,$2,$3,$4)', [ORG, KIND, A_FLOW, 2]),
    ).rejects.toThrow(/cannot retire head/) // T0
    const h1 = await md5(A_FLOW, 1)
    await pool.query('select forms.retire($1,$2,$3,$4)', [ORG, KIND, A_FLOW, 1]) // T1
    expect(await statusOf(A_FLOW, 1)).toBe('retired')
    expect(await md5(A_FLOW, 1)).toBe(h1)
    const { rows } = await pool.query(
      'select retired_at from forms.asset_version where org=$1 and asset_id=$2 and version=1',
      [ORG, A_FLOW],
    )
    expect(rows[0].retired_at).not.toBeNull()
  })

  it('T2：退役后，v1 期间的历史提交仍按钉住版本契约校验通过', async () => {
    const { rows } = await pool.query('select forms.body_at($1,$2,$3,$4) body', [ORG, KIND, A_FLOW, 1])
    const r = validateSubmission({
      schema: rows[0].body,
      payload: { name: '张三' },
      dictLookup: () => new Set(),
    })
    expect(r.ok).toBe(true) // 与 S2 对照：校验器只认提交钉住的版本，不认 head
  })

  it('T4：回滚目标必须是 published——retired 不可回', async () => {
    await expect(
      pool.query('select forms.rollback_to($1,$2,$3,$4)', [ORG, KIND, A_FLOW, 1]),
    ).rejects.toThrow(/only published is rollback-able/)
  })

  it('T5：提交只许钉 head——直插非 head 版本被触发器拦；无 head 资产拒提交', async () => {
    await expect(
      pool.query(
        "insert into forms.submission (org, kind, asset_id, version, payload, submitted_by) values ($1,$2,$3,1,'{}','x')",
        [ORG, KIND, A_FLOW],
      ),
    ).rejects.toThrow(/submissions follow head only/)
    await expect(
      pool.query('select forms.submit($1,$2,$3,$4,$5)', [ORG, KIND, A_NOHEAD, '{}', 'x']),
    ).rejects.toThrow(/no published head/)
  })
})
