// index.ts — 演示模块后端：模块接入协议的首个真实用例（Task 19）。
//
// 接入姿势示范（后续业务模块照抄）：manifest.yaml 单一事实源——启动时读同目录 yaml
// 经 ManifestSchema 校验后交给 defineModule，不在 TS 里维护第二份副本（防漂移）。
// 路由只写业务：身份由宿主注入 c.get('identity')，权限门禁由宿主按 manifest.api.internal
// 声明施加（模块零认证代码），DB 连接从 createRouter 的 ctx.pool 拿——模块零连接代码。
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule } from '@platform/sdk'
import type { Identity } from '@platform/sdk'

const manifest = ManifestSchema.parse(
  parseYaml(readFileSync(new URL('./manifest.yaml', import.meta.url), 'utf8')),
)

/** 便签正文上限：有界写入，超长 400（与登录长度上限同一纪律） */
const MAX_NOTE_LEN = 2000

interface NoteRow {
  id: number
  body: string
  created_at: Date
}

export default defineModule({
  manifest,
  createRouter: ({ pool }) => {
    // 宿主契约的本地声明：session 中间件在 mount 之前注入 identity（I-1 硬契约）
    const r = new Hono<{ Variables: { identity: Identity } }>()

    // 门禁由宿主按 manifest 声明施加（M1 闭债 R2）——模块不再手写 requireScope：
    // 忘挂就匿名可读，那条路已经堵死。身份仍由宿主注入 c.get('identity')
    r.get('/ping', (c) => c.json({
      pong: true,
      identity: { userId: c.get('identity')!.userId, orgId: c.get('identity')!.orgId },
    }))

    r.get('/notes', async (c) => {
      // 租户隔离（spec-1 §2）：读写一律按 identity.orgId 过滤，见 docs/module-protocol.md
      const org = c.get('identity')!.orgId
      const { rows } = await pool.query<NoteRow>(
        'select id, body, created_at from demo.note where org = $1 order by id desc limit 50',
        [org],
      )
      return c.json({ notes: rows })
    })

    r.post('/notes', async (c) => {
      const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null
      const text = typeof body?.body === 'string' ? body.body.trim() : ''
      if (!text) return c.json({ error: 'BODY_REQUIRED' }, 400)
      if (text.length > MAX_NOTE_LEN) return c.json({ error: 'BODY_TOO_LONG' }, 400)
      const org = c.get('identity')!.orgId
      const { rows } = await pool.query<NoteRow>(
        'insert into demo.note(org, body) values ($1, $2) returning id, body, created_at',
        [org, text],
      )
      return c.json({ note: rows[0] }, 201)
    })

    return r
  },
})
