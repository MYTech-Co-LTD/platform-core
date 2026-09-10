// index.ts — 演示模块后端：模块接入协议的首个真实用例（Task 19）。
//
// 接入姿势示范（后续业务模块照抄）：manifest.yaml 单一事实源——启动时读同目录 yaml
// 经 ManifestSchema 校验后交给 defineModule，不在 TS 里维护第二份副本（防漂移）。
// 路由只写业务：身份由宿主注入 c.get('identity')，权限门禁一行 requireScope，
// DB 连接从 createRouter 的 ctx.pool 拿——模块零认证/零连接代码。
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { parse as parseYaml } from 'yaml'
import { ManifestSchema, defineModule, requireScope } from '@platform/sdk'
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

    r.get('/ping', requireScope('demo:view'), (c) => c.json({
      pong: true,
      identity: { userId: c.get('identity')!.userId, orgId: c.get('identity')!.orgId },
    }))

    r.get('/notes', requireScope('demo:note'), async (c) => {
      const { rows } = await pool.query<NoteRow>(
        'select id, body, created_at from demo.note order by id desc limit 50',
      )
      return c.json({ notes: rows })
    })

    r.post('/notes', requireScope('demo:note'), async (c) => {
      const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null
      const text = typeof body?.body === 'string' ? body.body.trim() : ''
      if (!text) return c.json({ error: 'BODY_REQUIRED' }, 400)
      if (text.length > MAX_NOTE_LEN) return c.json({ error: 'BODY_TOO_LONG' }, 400)
      const { rows } = await pool.query<NoteRow>(
        'insert into demo.note(body) values ($1) returning id, body, created_at',
        [text],
      )
      return c.json({ note: rows[0] }, 201)
    })

    return r
  },
})
