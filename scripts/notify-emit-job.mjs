#!/usr/bin/env node
// scripts/notify-emit-job.mjs — `notify.emit` job handler（platform.scheduler 的子进程）。
//
// 职责边界：只把 JOB_PARAMS 变成一条 notify.event；不投递、不重试 provider。
// 退出码（与业务调度器约定一致）：
//   0 = 已入队 / 重复（duplicate 视为成功）
//   2 = 参数、声明、namespace 不可用 ⇒ 不重试
//   1 = 其它错误（DB 等）⇒ 可重试
//
// 调度器注入：JOB_KEY / JOB_SCHEDULE_ID / JOB_OCCURRENCE / JOB_OWNER_ORG /
//             JOB_OWNER_NAMESPACE / JOB_TIMEZONE（可选）；JOB_PARAMS 走 **stdin**。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runScheduledEmitJob } from '../modules/notify/domain/scheduled-emit.ts'
import { enqueueEvent } from '../modules/notify/storage.ts'

/** 读 stdin 的一行 JSON；TTY（手动运行却忘了 pipe）返回空串，由调用方 exit 2。 */
async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  const jobKey = process.env.JOB_KEY
  const scheduleId = process.env.JOB_SCHEDULE_ID
  const occurrence = process.env.JOB_OCCURRENCE
  const org = process.env.JOB_OWNER_ORG
  const namespace = process.env.JOB_OWNER_NAMESPACE || undefined
  const timezone = process.env.JOB_TIMEZONE || 'Asia/Shanghai'

  /** @param {string} reason @returns {never} */
  const configError = (reason) => {
    console.error(`notify-emit-job: ${reason}`)
    process.exit(2)
  }

  if (!url) configError('缺 DATABASE_URL')
  if (jobKey !== undefined && jobKey !== 'notify.emit') {
    configError(`JOB_KEY 不是 notify.emit（${jobKey}）`)
  }
  if (!scheduleId) configError('缺 JOB_SCHEDULE_ID')
  if (!occurrence || Number.isNaN(new Date(occurrence).getTime())) {
    configError('JOB_OCCURRENCE 缺失或非法')
  }
  if (!org) configError('缺 JOB_OWNER_ORG')
  const rawParams = await readStdin()
  if (!rawParams) configError('缺 JOB_PARAMS（stdin）')

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })

  /**
   * 声明事实源：平台事件在 platform.event_catalog；租户/agent 事件在 notify.event_decl
   *（后者由 agent 自助面迁移引入；表不存在时跳过，不让脚本因未来表缺失而崩）。
   * @param {string} o
   * @param {string} key
   */
  const getEventDecl = async (o, key) => {
    const platform = await pool.query(
      `select payload_schema, recipients, scope_key
         from platform.event_catalog where key=$1 and active`, [key])
    let row = platform.rows[0]
    if (row === undefined) {
      const reg = await pool.query("select to_regclass('notify.event_decl') as t")
      if (reg.rows[0]?.t) {
        const tenant = await pool.query(
          `select payload_schema, recipients, scope_key
             from notify.event_decl where org=$1 and key=$2 and status='active'`, [o, key])
        row = tenant.rows[0]
      }
    }
    return row === undefined
      ? null
      : {
          key,
          title: '',
          payload: row.payload_schema,
          recipients: row.recipients,
          scope: row.scope_key ? { key: row.scope_key } : undefined,
        }
  }

  try {
    const r = await runScheduledEmitJob({
      getEventDecl,
      enqueue: (input) => enqueueEvent(pool, input),
      now: () => new Date(),
    }, {
      scheduleId: String(scheduleId),
      occurrence: String(occurrence),
      rawParams,
      org,
      namespace,
      timezone,
    })
    if (!r.ok) {
      console.error(`notify-emit-job: ${r.reason}`)
      process.exitCode = r.retryable ? 1 : 2
    } else {
      console.log(JSON.stringify({
        eventId: r.eventId,
        accepted: r.accepted,
        ...(r.reason ? { reason: r.reason } : {}),
      }))
      process.exitCode = 0
    }
  } catch (e) {
    console.error('notify-emit-job 失败:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}
