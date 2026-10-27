// providers/in-app.ts — in-app 收件箱投递（自建表，不依赖 Novu Inbox）。
// 唯一键 (org,event_id,recipient) ⇒ 同事件同人只入一条；重复投递视为成功。
import type { Pool } from 'pg'

export async function sendInApp(a: {
  pool: Pool
  org: string
  recipient: string
  eventId: string
  eventKey: string
  templateKey: string
  revision: number
  rendered: { title: string; body: string; link?: string }
}): Promise<{ ok: true }> {
  await a.pool.query(
    `insert into notify.inbox
       (org,id,recipient,event_id,event_key,template_key,revision,title,body,link)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (org,event_id,recipient) do nothing`,
    [a.org, `${a.eventId}:${a.recipient}`, a.recipient, a.eventId, a.eventKey,
     a.templateKey, a.revision, a.rendered.title, a.rendered.body, a.rendered.link ?? null],
  )
  return { ok: true }
}
