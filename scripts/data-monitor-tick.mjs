#!/usr/bin/env node
// scripts/data-monitor-tick.mjs — 业务监控求值的**定时驱动**（Wave 7 V1，spec §8）。
//
// 调度器 registry 的一个 key（`data.monitor_tick`，每分钟）；本脚本只做编排：
//   枚举有启用规则的 org → 逐条到期规则求值（域层）→ 状态机 → 落台账 → 跃迁且非影子期时入队事件。
// 判据语义全在 `modules/data/domain/monitor-eval.ts`；本脚本不含任何判定逻辑。
//
// 退出码（照 metric-retire-job 惯例）：0 全部求值成功；1 有条目判不了（unknown）或投递失败；
// 2 查不成账（缺 DATABASE_URL / org 枚举失败 / 用法错误）——exit 2 调度器不重试。
//
// ⚠️ 影子期（dry_run=true）**不产生任何 notify 事件**：只写 monitor_run（spec §2/§7）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('monitor-tick: 缺 DATABASE_URL（从项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }

  const { monitorOrgs, dueMonitors, recordRun, applyOutcome } =
    await import('../modules/data/domain/monitor-store.ts')
  const { evaluateMonitor } = await import('../modules/data/domain/monitor-eval.ts')
  const { transitionOf } = await import('../modules/data/domain/monitor-state.ts')
  const { resolveMonitorRecipients } = await import('../modules/data/domain/monitor-recipients.ts')
  const { enqueueEvent } = await import('../modules/notify/storage.ts')
  const { loadMergedCatalog } = await import('../modules/data/domain/metric-store.ts')
  const { analystPool } = await import('../modules/data/domain/warehouse.ts')
  const { runWarehouseSql } = await import('../modules/data/domain/warehouse.ts')

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dbUrl })

  const hasWarehouse = Boolean(process.env.DATA_WAREHOUSE_URL?.trim())
  if (!hasWarehouse) {
    console.error('monitor-tick: 缺 DATA_WAREHOUSE_URL ⇒ 所有查询类判据将记为 unknown')
  }
  const wh = hasWarehouse
    ? (/** @type {string} */ sql) => runWarehouseSql(analystPool(), sql)
    : async () => { throw new Error('DATA_WAREHOUSE_URL unconfigured') }

  const now = new Date()
  const LIMIT_PER_ORG = 200
  const counts = { due: 0, ok: 0, firing: 0, unknown: 0, notified: 0, disabled: 0, failed: 0 }

  try {
    const orgs = await monitorOrgs(pool)
    for (const org of orgs) {
      // 词表每 org 一轮只加载一次（规则共享；spec §8 容量判据）。
      /** @type {Promise<any> | null} */
      let catalogPromise = null
      const loadCatalog = (/** @type {string} */ o) => {
        catalogPromise ??= loadMergedCatalog(pool, o)
        return catalogPromise
      }

      const monitors = await dueMonitors(pool, org, now, LIMIT_PER_ORG)
      counts.due += monitors.length

      for (const m of monitors) {
        const startedAt = Date.now()
        /** @type {import('../modules/data/domain/monitor-spec.ts').MonitorOutcome} */
        let outcome
        try {
          outcome = await evaluateMonitor({ wh, pool, loadCatalog, now: () => now }, m)
        } catch (e) {
          // 域层理论上是 fail-open 的；这里兜底，绝不让一条规则打断整轮。
          outcome = { verdict: 'unknown', error: (e instanceof Error ? e.message : String(e)).slice(0, 500), watermarkRef: null }
        }

        const tr = transitionOf({
          prev: m.state,
          outcome,
          prevStateSince: m.stateSince,
          notifiedAt: m.notifiedAt,
          cooldownSecs: m.cooldownSecs,
          consecutiveFail: m.consecutiveFail,
          now,
        })

        let notified = false
        let error = outcome.verdict === 'unknown' ? outcome.error : null
        if (tr.notify !== null && !m.dryRun) {
          try {
            const recipients = tr.notify === 'disabled'
              ? { to: [m.createdBy], excluded: [] }
              : await resolveMonitorRecipients(pool, org, m.recipients)
            if (recipients.to.length === 0) {
              error = error ?? 'no_recipients'
            } else {
              const eventKey = tr.notify === 'fired' ? 'data.monitor.fired'
                : tr.notify === 'resolved' ? 'data.monitor.resolved' : 'data.monitor.disabled'
              await enqueueEvent(pool, {
                org,
                // 「跃迁后的 state + state_since」= 一次跃迁的身份；重跑同一轮撞主键即幂等。
                eventId: `monitor:${m.id}:${tr.state}:${tr.stateSince.toISOString()}`,
                eventKey,
                scope: `monitor:${m.id}`,
                payload: {
                  to: recipients.to.join(','),
                  monitorId: m.id,
                  name: m.name,
                  verdict: outcome.verdict,
                  windowDays: m.windowDays,
                  watermarkRef: outcome.watermarkRef ?? null,
                  link: '/console/data/reports',
                },
                producer: 'data',
              })
              notified = true
              counts.notified += 1
            }
          } catch (e) {
            // fail-open：投递失败不改 run 终态（AGENTS.md #12）。
            error = error ?? `emit:${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`
          }
        }

        await applyOutcome(pool, { id: m.id, org }, {
          state: tr.state,
          stateSince: tr.stateSince,
          lastEvalAt: now,
          notified,
          consecutiveFail: tr.consecutiveFail,
          ...(tr.disable ? { enabled: false } : {}),
        })
        await recordRun(pool, {
          monitorId: m.id,
          org,
          verdict: outcome.verdict,
          value: outcome.verdict === 'missing' || outcome.verdict === 'stale' ? outcome.value ?? null : null,
          watermarkRef: outcome.watermarkRef ?? null,
          stateAfter: tr.state,
          notified,
          dryRun: m.dryRun,
          durationMs: Date.now() - startedAt,
          error,
        })

        if (outcome.verdict === 'unknown') counts.unknown += 1
        else if (outcome.verdict === 'ok') counts.ok += 1
        else counts.firing += 1
        if (tr.disable) counts.disabled += 1
      }
    }

    await pool.query(
      `insert into platform.job_heartbeat (id, beat_at) values ('data.monitor_tick', now())
       on conflict (id) do update set beat_at = excluded.beat_at`,
    )

    console.log(
      `monitor-tick: due=${counts.due} ok=${counts.ok} firing=${counts.firing} `
      + `unknown=${counts.unknown} notified=${counts.notified} disabled=${counts.disabled}`,
    )
    process.exit(counts.unknown === 0 ? 0 : 1)
  } catch (e) {
    console.error('monitor-tick 查不成账:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
