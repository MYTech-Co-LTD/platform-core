// registry.ts — 系统 job 目录（代码）与幂等 seed。
//
// 目录在代码：新增 job 必须发版、经评审；排班状态在库：改时间/开关不用发版。
// seed 三条语义：① 只补新增 key，**不覆盖**人改过的 cron/enabled；
// ② `params` 恒 `{}`（source='system' 时 params 不生效，见 spec §3.6）；
// ③ enabled 行缺 next_run_at 时补算（补算 ≠ 立即执行）。
import type { Pool } from 'pg'
import { isValidCron, nextRunAt } from './cron'

/** 作业所属部署单元（#2511 调度器拆分）：两个单元只 claim 自己这一组。 */
export type JobScope = 'platform' | 'data'

/** 全部合法的域；`SCHEDULER_JOB_GROUPS` 的取值必须落在这里（未知名一律抛错，不静默忽略）。 */
export const JOB_SCOPES: readonly JobScope[] = ['platform', 'data']

export interface JobDef {
  key: string
  script: string
  cron: string
  timezone: string
  timeoutMs: number
  maxAttempts: number
  expectedIntervalSecs: number
  description: string
  /**
   * 作业所在的部署单元。**必须显式声明**（护栏测试逼每条都写）：
   *   · `platform` —— 需要平台侧 env（Casdoor 管理员凭据、通知凭据 KEK…），跑在应用单元；
   *   · `data`     —— 需要数据面 env（pg_duckdb / ZOS）且要贴着实例跑的，跑在数据单元。
   * 两个单元用 `SCHEDULER_JOB_GROUPS` 各自 claim 自己这一组 ⇒ **天然不相交**，不存在双 claim。
   */
  scope: JobScope
  /**
   * 进程 env 里的**必需键**。启动时逐条校验：缺键的作业**不进入 claim 集合**，
   * 并在健康面显式报红（而不是等到它的 cron 时刻静默失败）。
   * 只列进程级 env；`def.env`（作业自带的常量）不在此列——它由代码保证。
   */
  requiresEnv?: string[]
  /**
   * handler-only：只登记 handler 供 runner 按 key 查找，**不建系统排班行**。
   * 用于「没有系统排班、只在被 agent/console 排班调用时才存在」的 job（如 `notify.emit`）。
   * 这类条目的 cron/timezone 只是 JobDef 的 schema 占位，seed 不用于排班（占位值仅满足 schema 必填；校验仍全量跑）。
   */
  noSystemSchedule?: boolean
  /** 子进程附加参数（如 org-sync 必须 `--apply`，否则它会走 dry-run 空跑）。 */
  args?: string[]
  /**
   * 子进程附加环境变量（如 `MATERIALIZE_SCOPE=tick`）。**只用于系统 job**——agent 排班的
   * `params` 不能覆盖它（registry 是系统 job 的唯一事实源，spec §3.6）。
   */
  env?: Record<string, string>
  /**
   * 实时车道（B2，2026-11-25）：标 true 的作业到期前 90 秒，调度器**在执行器里给它留一个槽**
   * ——这一拍批量车道最多只用 `空闲槽 − 1`。用字段而不是按 key 硬编码：换车道归属只改这里，
   * 调度器不需要认识具体 job 名。只标真正有分钟级 SLA 的作业（当前只有 `data.dbt_tick`）。
   */
  realtime?: boolean
}

/**
 * 1h 车道的 per-domain job（路线图 A3）：车道名由 `scripts/lemeng/data-lanes.json` 解析，
 * registry **只传车道名 + 错峰分钟**，不手抄模型清单（A4 门禁保证每个增量模型恰好归属一个车道）。
 * 分钟错峰（奇数分钟，避开 10m tick 的 `2-59/10`）⇒ 各域串行、不与 tick 撞分钟；
 * 单域单轮 ≤3 分钟，10 个域在 :05–:41 内跑完，审计 job 在 :45 收尾。
 */
function hourlyLaneJob(
  domain: string,
  minute: number,
  desc: string,
  opts: { select?: string; block?: string } = {},
): JobDef {
  const mm = String(minute).padStart(2, '0')
  const { select, block } = opts
  // 分块（B2，2026-11-25）：`select` 给定时同一域拆成多条 job，块内只跑该子集；
  // 车道声明照旧（MATERIALIZE_LANE）⇒ 排除集与语义不变，只是范围收窄。
  // `block` 是 key 后缀（块名），缺省则一个域一条 job（原形态）。
  return {
    key: `data.dbt_hourly_${domain}${block ? `_${block}` : ''}`,
    scope: 'data',
    requiresEnv: ['DATABASE_URL', 'DATA_WAREHOUSE_URL', 'LEMENG_ZOS_BUCKET', 'LEMENG_ZOS_REGION', 'LEMENG_ZOS_ENDPOINT'],
    script: 'scripts/lemeng/materialize-job.mjs',
    env: {
      MATERIALIZE_SCOPE: 'hourly',
      MATERIALIZE_LANE: `nonretail_1h.${domain}`,
      ...(select ? { MATERIALIZE_HOURLY_SELECT: select } : {}),
      DATA_PLANE_DOMAINS: 'lemeng',
      MATERIALIZE_MODE: 'container',
      LEMENG_ZOS_BUCKET: 'shanhai-data',
      LEMENG_ZOS_REGION: 'xinan1',
      LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn',
    },
    cron: `${minute} 1-15 * * *`,
    timezone: 'UTC',
    timeoutMs: 900000,
    // 3 次：`dispatch failed: executor 429 busy` 是**容量竞态**，不是业务失败。首轮实测
    //（2026-11-25）member 因 429 被 maxAttempts=1 判终态，整小时没建；+60s 重试即可自愈。
    maxAttempts: 3,
    expectedIntervalSecs: 3600,
    description: `乐檬 1h 车道 · ${desc}（CST 09:${mm}-23:${mm}；车道 nonretail_1h.${domain}）`,
  }
}

/** 1h 车道的「选择器类」job（窗口审计 / 门店维）：只传 select，模型清单不手抄。 */
function hourlySelectJob(key: string, select: string, minute: number, timeoutMs: number, desc: string, maxAttempts = 1): JobDef {
  const mm = String(minute).padStart(2, '0')
  return {
    key,
    scope: 'data',
    requiresEnv: ['DATABASE_URL', 'DATA_WAREHOUSE_URL', 'LEMENG_ZOS_BUCKET', 'LEMENG_ZOS_REGION', 'LEMENG_ZOS_ENDPOINT'],
    script: 'scripts/lemeng/materialize-job.mjs',
    env: {
      MATERIALIZE_SCOPE: 'hourly',
      MATERIALIZE_HOURLY_SELECT: select,
      DATA_PLANE_DOMAINS: 'lemeng',
      MATERIALIZE_MODE: 'container',
      LEMENG_ZOS_BUCKET: 'shanhai-data',
      LEMENG_ZOS_REGION: 'xinan1',
      LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn',
    },
    cron: `${minute} 1-15 * * *`,
    timezone: 'UTC',
    timeoutMs,
    maxAttempts,
    expectedIntervalSecs: 3600,
    description: `${desc}（CST 09:${mm}-23:${mm}）`,
  }
}

/** P1 首迁三个系统 job。时区一律 UTC——与 openship 上现有 cron 的 UTC 语义逐字一致。 */
export const JOB_REGISTRY: JobDef[] = [
  // 需求挖掘（原 openship `custom:4eM6UfhB2ANodSJ_`，靠 `docker exec` 进 server 容器跑）。
  // 为什么落在 **platform 域**（#2560 的落点裁决）：脚本要读 OO，而**只读凭据 `OO_READ_*`
  // 本来就在应用单元**；数据单元只有摄取凭据（读端点 401，2026-11-20 实测）。
  // ⇒ 由 `scheduler-platform` 在应用单元容器内执行，**不新增任何密钥**，也不扩大数据单元的爆炸半径。
  { key: 'demand.mining', scope: 'platform', requiresEnv: ['DATABASE_URL','OO_READ_URL','OO_READ_ORG','OO_READ_TOKEN'], script: 'scripts/demand-mining.mjs', cron: '10 21 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '需求挖掘（审计缺度量/无明细绑定 → data.demand_*；CST 05:10）' },
  { key: 'notify.reconcile', scope: 'platform', script: 'scripts/notify-reconcile.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 3600, description: '通知指派与催办对账' },
  { key: 'metric.candidates', scope: 'platform', script: 'scripts/metric-candidates-job.mjs', cron: '40 6 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '指标候选池生成' },
  { key: 'report.scope_scan', scope: 'platform', script: 'scripts/report-scope-scan.mjs', cron: '37 1 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '报表受众 × 指标可见性巡检' },
  // P4b：其余系统 job（cron 与 openship 现役排班逐字一致，时区一律 UTC）
  { key: 'notify.preflight', scope: 'platform', script: 'scripts/notify-preflight.mjs', cron: '43 3 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '通知规则全量可送达性体检' },
  { key: 'notify.retention', scope: 'platform', script: 'scripts/notify-retention.mjs', cron: '23 3 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '通知保留期清理' },
  { key: 'metric.retire', scope: 'platform', script: 'scripts/metric-retire-job.mjs', cron: '23 3 * * 1', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 604800, description: '零使用指标下线提案' },
  { key: 'org.sync', scope: 'platform', requiresEnv: ['DATABASE_URL','CASDOOR_URL','CASDOOR_ADMIN_USER','CASDOOR_ADMIN_PWD'], script: 'scripts/org-sync-all.mjs', args: ['--apply'], cron: '13 */6 * * *', timezone: 'UTC', timeoutMs: 600000, maxAttempts: 2, expectedIntervalSecs: 21600, description: '企微组织架构同步（--apply：默认 dry-run 不写库）' },
  { key: 'notify.seed_builtin', scope: 'platform', script: 'scripts/notify-seed-builtin.mjs', cron: '13 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 3600, description: '内置模板/规则幂等 seed' },
  { key: 'notify.health', scope: 'platform', script: 'scripts/notify-health.mjs', cron: '*/5 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 300, description: '通知投递健康检查' },
  // 目标达成日报（件② #2708 / 计划 C3）：读目标达成关系（数据面）→ 一条 `forms.goal.daily` 事件入队。
  // 落 **platform 域**：入队要平台库（DATABASE_URL）与数据面（DATA_WAREHOUSE_URL）都在应用单元；
  // 通道/收件人/模板全走 notify 规则面（收件人 = 持 data:query 的看数人），本 job 不新增密钥。
  // CST 08:30（= UTC 00:30）——经营晨会前送达；幂等键 = 每 goal×metric×日（同日重跑不重复）。
  { key: 'goal.daily_push', scope: 'platform', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL'], script: 'scripts/goal-daily-push.mjs', cron: '30 0 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '目标达成日报（当月 Σactual/Σtarget + 落后门店 → forms.goal.daily；CST 08:30）' },
  // OA 审批对账（#2363 P1 / #2385 P2 收口）：两个脚本此前只在仓内、**零调度登记**——配置齐全也不会
  // 运行。照 `notify.reconcile` 的既有形态登记（registry 调脚本；两个脚本把统计 JSON 打到 stdout，
  // 由 runner 收进 `platform.job_run.output_tail`，即「输出统计写入 job 日志」；失败告警走执行器的
  // `jobs.job.failed/timeout/dead` 事件通路，**不新增告警面**）。每小时错峰 :17/:47，避开
  // notify.reconcile(:07) / seed_builtin(:13) / askdata_loop 与 narrative_health(:23) / verify_ingest(:40)。
  // 时区沿用 registry 不变量 UTC：小时级 cron 在 UTC 与 Asia/Shanghai 的触发时刻逐点相同（上海无夏令时）。
  { key: 'oa.standard_approval_reconcile', scope: 'platform', requiresEnv: ['DATABASE_URL'], script: 'scripts/oa-standard-approval-reconcile.mjs', cron: '17 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 3600, description: '标准审批（企微）镜像对账：逐租户拉企微 → forms.external_approval（回调兜底；token 失败 exit 1）' },
  { key: 'oa.approval_reconcile', scope: 'platform', requiresEnv: ['DATABASE_URL'], script: 'scripts/oa-approval-reconcile.mjs', cron: '47 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 3600, description: '应用内审批终态对账：pending_approval 补终态（与回调同 SQL 幂等）' },
  // 孤儿附件 GC（spec §5 #12；#2728 判据=**业务动作**：删 `aftersales.ticket_attachment` 的孤儿行
  // + 租户桶里的对象 ⇒ 平台调度器，不是 openship job）。此前只有 manage 面端点
  // `POST /attachments/gc` 且从未被定时触发（audit 表 0 次 ⇒ 行与对象永存）。
  // 判据与删除顺序的唯一实现在 `modules/aftersales/domain/attachment-gc.ts`；脚本只做
  // 「逐租户解析配置 → 按行上 storage_ref 归桶 → 落审计」，默认 dry-run，排班显式 `--apply`。
  // 只要求 `DATABASE_URL`：租户存储配置在 `platform.tenant` 行上（平台默认 env 只是兜底），
  // 缺平台默认时脚本逐租户跳过并告警——绝不替租户删到别的桶里。
  // CST 04:20（UTC 20:20）夜间低峰；seed 恒 enabled=false，四步开闸时先无参手工跑一轮看 dry-run 报告。
  { key: 'aftersales.attachment_gc', scope: 'platform', requiresEnv: ['DATABASE_URL'], script: 'scripts/aftersales-attachment-gc.mjs', args: ['--apply'], cron: '20 20 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '孤儿附件 GC（未提交/提交失败的预签名附件行+对象，>7 天；CST 04:20；排班带 --apply）' },
  // 判据化（Wave 8 ④，#2606）：原 openship 靠宿主 `docker exec` 进 server 容器跑，判红只到退出码。
  // 落在 **platform 域**：`verify-ingest` 要 OO 只读凭据（应用单元本来就有），`verify-regression`
  // 只用 `DATABASE_URL`。水位默认路径 `/var/lib/askdata`（compose 里挂了命名卷 ⇒ 跨部署保留；
  // 旧 job 显式指到容器 `/tmp`，每次 server 重建就丢）。
  // askdata 演进回路 P1（#2624，Wave 8 ③）：原 openship 宿主 `sync-and-run.sh`（docker sock 找卷 +
  // source /etc/openobserve-ingest.env）。容器形态：openclaw 卷只读挂载 + 快照复制读 WAL 库，
  // OO 摄取凭据走 OO_READ_* 映射（不新增密钥），水位复用 askdata-state 卷。
  // **有意行为变更**：单 agent 失败不拖停其他 agent（旧 shell 是 set -eu fail-fast）。
  { key: 'platform.askdata_loop', scope: 'platform', requiresEnv: ['OO_READ_URL','OO_READ_ORG','OO_READ_TOKEN','PLATFORM_ORG'], script: 'scripts/askdata/loop.mjs', cron: '23 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 'askdata 演进回路（export/attribute/verify × 每 agent；水位在 askdata-state 卷）' },
  { key: 'platform.verify_ingest', scope: 'platform', requiresEnv: ['DATABASE_URL','OO_READ_URL','OO_READ_ORG','OO_READ_TOKEN'], script: 'scripts/verify-ingest.mjs', cron: '40 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 3600, description: '摄入验证（OO askdata_verified → 重放 → verified_questions）' },
  // 叙事质量判据（#2612，Wave 8 ④）：原 openship 每小时的宿主 python（`docker exec <postgres> psql`
  // + `/opt/lemeng-emit-probe.py`）。判据本体已容器化：DSN 直连 + 探针直投，跑在应用单元。
  // 调度器周度体检（#2602 的复评触发判据）：按 runner 数近 30 天的 `runner lost on worker restart`。
  // ≥1 ⇒ 判红探针 → 桥 → 企微 ⇒ 逼人回来复评「应用单元部署无栅栏 / 排空信号是否按域分键」。
  { key: 'platform.scheduler_audit', scope: 'platform', requiresEnv: ['DATABASE_URL','OO_READ_URL','OO_READ_ORG','OO_READ_TOKEN'], script: 'scripts/scheduler-audit.mjs', cron: '0 2 * * 1', timezone: 'UTC', timeoutMs: 120000, maxAttempts: 1, expectedIntervalSecs: 604800, description: '调度器周度体检（runner lost 计数 → OO probes；#2602 复评判据）' },
  { key: 'platform.narrative_health', scope: 'platform', requiresEnv: ['DATABASE_URL','OO_READ_URL','OO_READ_ORG','OO_READ_TOKEN'], script: 'scripts/lemeng/narrative-health.mjs', cron: '23 * * * *', timezone: 'UTC', timeoutMs: 120000, maxAttempts: 1, expectedIntervalSecs: 3600, description: '叙事质量判据（回退率/越界率/p95 → OO probes）' },
  { key: 'platform.verify_regression', scope: 'platform', requiresEnv: ['DATABASE_URL'], script: 'scripts/verify-regression.mjs', args: ['--org', 'shanhaiyiguo-org'], cron: '10 4 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '问数回归（逐指标判红 → OO probes）' },
  // Wave 7 V1：业务监控求值（每实例一条；seed 为 disabled，切流按 deploy/jobs.md 四步开闸）
  // Wave 8 P1：dbt 由平台 scheduler 在容器内执行（镜像已内置 dbt 1.9.1，issue #2343）。
  // env/timeout/retry 与原 openship `lemeng-dbt-tick` 一致；cron 已按平台采集窗口调整（#2801）。
  // 1h 车道（A3）：门店维 → 各域增量（:05–:41 奇数分钟错峰）→ 窗口审计（:45）。
  // 旧的 `data.dbt_hourly` 一条跑全部增量 + 审计（~20 分钟），审计一红整轮失败、load_log 不落账
  // （2026-11-25 实测：outbound 审计 600 行差异把 17 个增量全判失败）。
  hourlySelectJob('data.dbt_hourly_dims', 'stg_lemeng_branch', 4, 300000, '乐檬 1h 车道 · 门店维（stg_lemeng_branch，先于各域）', 2),
  // 分块（B2，2026-11-25 真机实测）：本域单轮 408s 里 **343s 全在 fct_order_event**
  // （item_sale 27.5s / quantity 37.5s）。拆成两条：
  //   · :05 order_event（343s，长尾；它占住一个槽时另一个槽仍可给 tick）
  //   · :07 item_sale + quantity（≈65s，快速放槽）
  // 注意 **3 分钟上限（D5）在这块达不到**：order_event 的窗口写死在模型里（max(bizday)−7d），
  // 再切必须改模型语义（回填边界/半窗失败即半陈旧），不做。真正的保护 = 调度器留槽（loop.ts）。
  //   · 保留原 key（不换名）⇒ 存量排班行/台账连续，enabled 状态与 cron 不被 seed 覆盖。
  hourlyLaneJob('retail_derived', 5, '零售派生 · order_event（长尾，343s）', { select: 'fct_order_event' }),
  hourlyLaneJob('retail_derived', 7, '零售派生 · item_sale + quantity（≈65s）', { block: 'item_sale_quantity', select: 'fct_retail_item_sale fct_retail_quantity' }),
  hourlyLaneJob('purchase', 9, '采购'),
  hourlyLaneJob('inventory', 13, '库存快照'),
  hourlyLaneJob('member', 17, '会员汇总'),
  hourlyLaneJob('client', 21, '客户费用'),
  hourlyLaneJob('branch', 25, '门店费用/指标'),
  hourlyLaneJob('transfer', 29, '调拨'),
  hourlyLaneJob('outbound', 33, '出库'),
  hourlyLaneJob('request', 37, '要货'),
  hourlyLaneJob('loss', 41, '报损'),
  hourlySelectJob('data.dbt_hourly', 'tag:audit_window', 45, 1800000, '乐檬 1h 车道 · 窗口审计（9 条窗口对账）'),
  // 日档车道（A3 拆域时漏掉的 job）：`daily_report` 的两个增量模型（fct_retail_item_profit /
  // fct_retail_profit）在拆域后不再被任何 job 覆盖 ⇒ 独立日 job，09:10 CST（错开 item_profit
  // 09:05 采集）。A4 门禁从此要求「每个车道必须有 job」。
  { key: 'data.dbt_daily_report', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'hourly', MATERIALIZE_LANE: 'daily_report', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '10 1 * * *', timezone: 'UTC', timeoutMs: 900000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '乐檬 日档 · 零售利润两件（车道 daily_report；CST 09:10，错开 item_profit 09:05 采集）' },
  // 数据新鲜度 SLA 测量（路线图 D1/D2）：**只读**（不写库、不发探针、恒 exit 0），seed disabled；
  // D3/D4 观测 2–3 天校准阈值后再接 OO 告警与开闸。指标定义在 scripts/lemeng/sla.json。
  { key: 'data.sla_check', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL'], script: 'scripts/lemeng/sla-check.mjs', cron: '*/5 * * * *', timezone: 'UTC', timeoutMs: 120000, maxAttempts: 1, expectedIntervalSecs: 300, description: '数据新鲜度 SLA 测量 + D4 告警（ERR 行投 OO probe=sla；OO 凭据用 worker 既有的 OO_BASE/ORG/AUTH 回落，不新增 requiresEnv——缺键会把 job 整条剔出 claim 集合）' },
  // #2674 拆档：全史 CTAS 模型（recon 家族 + swap_offset，单轮 ~11 分钟且必撞采集期 ETag）
  // 从主档拆出去，各自有超时与失败隔离。主档要跑几十个 table 模型 + 39 个测试，90 分钟曾被
  // 全史模型拖到必超时 ⇒ 未建成的表（#2655 的 swap_offset / 新列版 recon_break）整天进不了生产。
  // · 主档：table 模型 + seeds + views，**排除** recon 家族
  // · 对账档：只跑那几个全史模型
  // ⚠️ #2896：本档原在 **CST 11:45**——#2674 拆档时主档在 10:25，「错开 80 分钟」成立；
  //    但 #2792（0fef7e37）把主档与四条审计全挪进夜间时**漏了这一条**，于是「错峰」变成
  //    「孤零零落在采集窗口（09:00–01:59）正中」——每轮 ~500s 的全史 CTAS 正撞 ETag 竞态。
  //    ⇒ 挪到 **CST 03:30**：在 00:40 preagg（T-3 源快照）与主档（02:30，约 18 分钟）之后，
  //    且与 04:30 的 `data.recon_ledger_guard`、05:30 起的审计链互不重叠。
  // ⚠️ #2890：拆档时漏了 `recon_run`（台账）。它只是对 `recon_break` 做 `count(*) group by`
  //    （毫秒级、不碰湖），却因此留在**主档**里 ⇒ 主档一超时，台账就停在超时前一天
  //    （2026-11-26 实测：主档 90 分钟被杀 ⇒ `staging.recon_run` 缺 11-22/11-23，
  //    而 `data.dbt_tables_recon` 当天正常把 recon_fact/recon_break 刷到了 11-23）。
  //    台账的新鲜度必须由**建它上游的那个档**决定，不能跨档搭车。
  { key: 'data.dbt_tables', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'tables', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', MATERIALIZE_TABLES_EXCLUDE: 'recon_fact recon_break fct_retail_swap_offset recon_run', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '30 18 * * *', timezone: 'UTC', timeoutMs: 9000000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt tables 主档（table 模型 + seeds + views，排除对账族；CST 02:30）' },
  { key: 'data.dbt_tables_recon', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'tables', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', MATERIALIZE_TABLES_SELECT: 'recon_fact recon_break fct_retail_swap_offset recon_run', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '30 19 * * *', timezone: 'UTC', timeoutMs: 2700000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt tables 对账族（recon_fact/recon_break/swap_offset 全史 CTAS + recon_run 台账；CST 03:30，夜间空窗）' },
  // 对账台账**当夜自愈闸**（#2894）：断言 ⑪ 红了不会自己去重建台账 ⇒ 红满一整天。
  // 本 job 用与 ⑪ **同一条 SQL** 判「T-4 缺行」，缺了才重建 `recon_fact/recon_break/recon_run`
  // （≈35s，不碰 500s 的 swap_offset）。重建后仍缺 = 不是台账没建而是那天在 recon_break 里就没行
  // （源快照缺 / 平台侧无数据）⇒ exit 1 响铃，heal 归 `lemeng-recon-restate`（CST 23:25）。
  // 排班 CST 04:30：在 restate（23:25）之后、审计链（05:30）之前；且错开 tick（09:00–01:59 CST）。
  { key: 'data.recon_ledger_guard', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/recon-ledger-guard.mjs', env: { LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '30 20 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '对账台账当夜自愈（⑪同源判据：T-4 缺行⇒重建 recon_fact/recon_break/recon_run；仍缺⇒响铃；CST 04:30）' },
  { key: 'data.dbt_tick', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'tick', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '2-59/10 1-17 * * *', timezone: 'UTC', timeoutMs: 600000, maxAttempts: 1, expectedIntervalSecs: 600, realtime: true, description: '乐檬 dbt tick 档（销售明细 10 分钟；CST 9-23 + 次日 0-1；容器内 dbt 1.9.1；实时车道=调度器给留槽）' },
  // 对账按**被测 mart 的物化语义**分族（#2428 定案）：
  //   · 全史族（a1/a2a/a2b）：只含 **table/view** 支撑的审计 —— 紧跟 tables 重建之后跑，两侧同源；
  //   · 窗口族（data.dbt_audit_window）：只含 **增量 mart** 支撑的审计 —— 与增量 lookback 同窗
  //     （today−10），且必须紧跟一轮 hourly 重建之后跑。
  //   ⚠️ 全史段里混入增量 mart 审计 = 结构性假红（2026-11-09 / 11-17 两次实测）；registry 测试
  //     会按 refs→模型物化类型静态核对，抄错段即红。
  //   时间窗（CST）：tables 02:30（超时上限 150 分钟，见下）→ a2a 05:30 → a2b 06:00 → a1 06:30 → window 07:30
//   （采集空窗内，09:00 前收尾）。2026-11-26 实测：湖读单次全史 count 256s（1,508 个文件）⇒ 主档贴 90 分钟
//   上限、慢夜必超时；超时放宽到 150 分钟并整体后移审计链，避免与主档尾段相撞。
  { key: 'data.dbt_audit_a1', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__retail__order_line audit_lemeng__retail__recon_exchange_shape audit_lemeng__retail__recon_gift_hit audit_lemeng__retail__hour_row_count audit_lemeng__wholesale__order_line' }, cron: '30 22 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 全史对账 a1（视图面 5 条；CST 06:30）' },
  { key: 'data.dbt_audit_a2a', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__client_contribution__margin_rate audit_lemeng__client_contribution__net_amount audit_lemeng__contribution__margin_rate audit_lemeng__contribution__net_amount audit_lemeng__contribution__region_l1_net audit_lemeng__contribution__region_net audit_lemeng__expense__loss_rate audit_lemeng__expense__subsidy_rate' }, cron: '30 21 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 全史对账 a2a（贡献/费用 8 条，table/view 面；CST 05:30）' },
  { key: 'data.dbt_audit_a2b', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__retail__comparable_growth_rate audit_lemeng__retail__consecutive_no_sales_days audit_lemeng__transfer__batch_fill_rate audit_lemeng__transfer__cost_coverage_pct audit_lemeng__transfer__negative_order_count audit_lemeng__transfer__zero_cost_exposure_amount' }, cron: '0 22 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 全史对账 a2b（零售/调拨 6 条，table/view 面；CST 06:00）' },
  // 目标件物化（件② #2708）：**独立域 + 独立 job**——目标模型读 forms 提交湖，而 forms 湖在
  // 「首个文件落下前」会让 read_parquet 报 No files found（#751 实测：曾把整轮 lemeng 物化打红、
  // 水位冻结）⇒ 绝不能挂进 `path:models/lemeng` 的每日档。本 job 只建 `path:models/goals`，
  // 但 manifest 用 DATA_PLANE_DOMAINS=lemeng,goals 解析（段② 的 ref 才能解析到乐檬 marts）。
  // 开闸前置：本数据面的 forms 采集已有第一个湖文件（否则本 job 必红，属预期）。
  // seed 恒 enabled=false（四步开闸）；CST 09:40（UTC 01:40）——在 tables 档（02:30）之后，
  // 读的是当天刚重建的乐檬 marts 分区（段② 只按目标月份聚合历史，不依赖当天的 lemeng 采集）。
  { key: 'data.dbt_goals', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'tables', MATERIALIZE_TABLES_DOMAIN: 'lemeng,goals', MATERIALIZE_TABLES_SELECT: 'path:models/goals', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '40 1 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '目标件物化（goals 域：段① forms 摊平 + 段② PG 达成；CST 09:40；开闸前置=forms 湖已有首文件）' },
  // 目标件对账（件② #2708）：达成模型的 target 来自 forms 湖 parquet、actual 来自**增量** fct marts
  // ⇒ 两族都不合（全史族禁增量 ref；窗口族只比增量 mart）。自成一档，在 tables 档（CST 02:30）
  // 之后 CST 11:00 跑；四条 = 两指标 ×（达成率 / 时间进度）。达成率只比「已封版月份 + 收集日 T-3」，
  // 当月由 data_status/报表负责（口径与边界见 dbt/tests/lemeng/audit_lemeng__goal__*.sql 头注）。
  // seed 恒 enabled=false（四步开闸：先手动跑一轮确认判据输出，再 update … set enabled=true）。
  { key: 'data.dbt_audit_goal', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_TICK_DOMAIN: 'lemeng,goals', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__goal__monthly_store_sale_sale_rate audit_lemeng__goal__monthly_store_sale_sale_pace audit_lemeng__goal__monthly_store_sale_outbound_rate audit_lemeng__goal__monthly_store_sale_outbound_pace' }, cron: '0 3 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '目标件对账（4 条：达成率×2 + 时间进度×2；封版月 + T-3；CST 11:00）' },
  { key: 'data.dbt_audit_window', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', MATERIALIZE_AUDIT_WINDOW: '1', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__branch__transfer_money audit_lemeng__expense__branch_payable audit_lemeng__expense__branch_receivable audit_lemeng__expense__client_net audit_lemeng__expense__client_payable audit_lemeng__expense__client_receivable audit_lemeng__member__branch_vip_money audit_lemeng__outbound__gross_margin_rate audit_lemeng__outbound__gross_profit audit_lemeng__outbound__line_count audit_lemeng__outbound__order_count audit_lemeng__outbound__region_conservation audit_lemeng__outbound__region_net audit_lemeng__purchase__amount audit_lemeng__purchase__item_count audit_lemeng__purchase__present_amount audit_lemeng__purchase__return_amount audit_lemeng__purchase__return_rate audit_lemeng__purchase__supplier_count audit_lemeng__purchase__zero_amount_rows audit_lemeng__purchase__cr5 audit_order_event_ref_coverage_20261020 audit_order_event_type_counts_20261020 audit_lemeng__inventory__quantity' }, cron: '30 23 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 窗口对账（增量 mart 24 条；窗口=today−10；CST 07:30）⚠️ 待首跑验收后再启用（#2456）' },
  // Wave 8 ③（平台/运维类）：原 openship 用 docker exec 进 server 容器跑；worker 同镜像同 env，
  // 直接由平台 scheduler 在 worker 容器内执行（#2450）。容器内实测 2026-11-17 均 RC=0。
  { key: 'data.semantics_sync', scope: 'data', script: 'scripts/sync-data-semantics.mjs', cron: '33 4 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 86400, description: 'L1 词表物化（dbt 语义 → platform.data.metrics；CST 12:33）' },
  { key: 'data.archive_private_measures', scope: 'data', script: 'scripts/archive-private-measures.mjs', args: ['--org', 'shanhaiyiguo-org'], cron: '30 3 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '私有测度归档（org=shanhaiyiguo-org、30 天；CST 11:30）' },
  // 原 openship 用 `docker exec` 进 server 容器跑；worker 同镜像同 env（DATABASE_URL + DATA_WAREHOUSE_URL 均在手），
  // 直接由平台 scheduler 在 worker 容器内执行——不再借道宿主 docker（#476 / Wave 8 ③）。
  { key: 'data.publish_dims', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL'], script: 'scripts/lemeng/publish-dims.mjs', cron: '43 3 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '维表发布（staging 维表 → data.dim_* 租户视图；CST 11:43）' },
  // 日更件「静默 0 行」巡检（#2590，原 openship job `custom:GvCTMst1X6gBRPNh`，CST 10:30）。
  // 判据本体是 python（借 pg_duckdb 的 duckdb.query 读湖），已数据面化：走 DSN、不再 docker exec。
  // 判红行投 OO `data_plane_probes`（桥→企微）——这正是「告警单出口」要求的形态。
  { key: 'data.zero_row_check', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL'], script: 'scripts/lemeng/zero-row-check.mjs', cron: '30 2 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '日更件静默 0 行巡检（近 3 天连续 0 行×基线有数据 ⇒ 判红；CST 10:30）' },
  // 采集健康 scorecard（#2600，Wave 8 ④）：原为两条 openship job（按账套复制副本），
  // 且判红只体现在退出码 + job 通知（不进 deliveries feed ⇒ 事实上静默）。
  // 现在一条 job 循环两账套，判据本体（`pipeline-scorecard.py`）**一行不改**，只把结论逐管线投进
  // OO `data_plane_probes`。console workspace 以命名卷**只读**挂进容器（见 deploy/data-compose.yml）。
  { key: 'data.scorecard', scope: 'data', script: 'scripts/lemeng/pipeline-scorecard.mjs', cron: '37 2 * * *', timezone: 'UTC', timeoutMs: 600000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '采集健康 scorecard（3120+64188；非 GREEN 逐管线 → OO probes；CST 10:37）' },
  // 月度采集健康基线（#2610）：每日 scorecard 的快照写进命名卷 `scorecard-history`，这里读同一卷。
  // 旧 job 靠退出码 + notify 通道报「覆盖不足」；现在投 `scorecard_baseline:coverage` 探针（告警单出口）。
  { key: 'data.monthly_review', scope: 'data', script: 'scripts/lemeng/monthly-review.mjs', cron: '0 1 1 * *', timezone: 'UTC', timeoutMs: 600000, maxAttempts: 1, expectedIntervalSecs: 2678400, description: '月度采集健康基线（覆盖 <7 天判红；每月 1 号 01:00 UTC）' },
  // 月度口径对账（#2728）：现行只盯 T-3 一天（duckle `lemeng.recon.preagg`），T-4 及更早的源端改写
  // （退货/撤单/改原单）没有任何自动发现机制。每月 15 号对**上一自然月**逐日跑一遍。
  // 时点选 15 号：上月末已过去半个月，远超 T-1..T-3 重采窗口 ⇒ 差异即真实变更，不掺「还在变」。
  // **不实现对账口径**：逐日调两个 console 的现成管线 `lemeng.recon.preagg.backfill`（口径唯一实现在 dbt）。
  // 依赖：worker 已有 `DUCKLE_TOKEN`（三个容器同一份，实测）+ 服务名可达（lemeng-console-{3120,64188}）。
  { key: 'data.recon_monthly', scope: 'data', requiresEnv: ['DUCKLE_TOKEN'], script: 'scripts/lemeng/recon-monthly.mjs', cron: '0 4 15 * *', timezone: 'UTC', timeoutMs: 3600000, maxAttempts: 1, expectedIntervalSecs: 2678400, description: '月度口径对账：上一自然月逐日 × 两账套（每月 15 号 CST 12:00；有差异判红）' },
  { key: 'data.monitor_tick', scope: 'data', script: 'scripts/data-monitor-tick.mjs', cron: '* * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 60, description: '业务监控求值（到期规则）' },
  // 数据面断言面（#2628）：原 `scripts/lemeng/wire-warehouse.sh` 的 ①–⑱ 跑在数据面宿主上、
  // 靠 `docker exec` 进平台容器 ⇒ 2026-11-19 调度迁平台后**随旧 openship 探活 job 一起停发**，
  // 观测面黑了 45h+ 而无人知晓。本条把同一批判据搬进容器内执行（脚本 `warehouse-assertions.mjs`），
  // **判据/阈值/check 名逐字不变**（OO 规则、桥、⑯ 的免冷却豁免都按名字匹配）。
  // 两处机制替换（⑮ 崩溃读 OO 日志流、①②③ 直接打 pg_duckdb）见脚本头注。
  // ⚠️ seed 恒插 `enabled=false`（registry 的既有语义）⇒ 天然就是「四步开闸」的第一步：
  //    先手动跑一轮确认判据输出与旧面同形，再 `update … set enabled=true`
  //    （观测面切流判据，见 #2628 验收第 3 条 + deploy/jobs.md 第 3.5 步）。
  // **按凭据边界拆两条**（2026-11-21 真机首跑定案）：数据单元只有 OO **摄取**凭据
  // （`OO_AUTH`，读端点恒 401，实测），OO **读**凭据只在应用单元 ⇒ ⑭⑮ 必须在 `platform` 域，
  // 与 `demand.mining` / `verify_*` 同款处置（**不新增密钥**，见 Wave 8 计划 §凭据实测细节）。
  { key: 'data.warehouse_assertions', scope: 'data', requiresEnv: ['DATA_WAREHOUSE_URL','DATABASE_URL'], script: 'scripts/lemeng/warehouse-assertions.mjs', args: ['--group', 'core'], cron: '*/5 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 300, description: '数据面断言·5 分钟廉价档 ①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑯⑰⑱（可达性/新鲜度/对账台账/封版结构 → OO probes）' },
  { key: 'data.lake_compact_index', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL'], script: 'scripts/lemeng/lake-compact-index.mjs', cron: '40 19 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '湖压缩记账档（读 _MONTH 单文件 → 行数/边界 → 写 lake_compact_index；CST 03:40，排在搬运 03:10 之后）' },
  { key: 'data.warehouse_assertions_heavy', scope: 'data', requiresEnv: ['DATA_WAREHOUSE_URL','DATABASE_URL'], script: 'scripts/lemeng/warehouse-assertions.mjs', args: ['--group', 'heavy'], cron: '7,37 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 1800, description: '数据面断言·全量证明档（org 单值证明 / 下钻延迟探测；每 30 分钟，B2 第二阶段）' },
  // duckle console 的「运行态 vs 声明真相」对账（#2629）：duckle **没有回拉也没有漂移检测**
  // （源码穷举 reconcile/drift/desync 均无此语义）⇒「有人在服务器改了管线」「实验残留没清」
  // 永远不会自己暴露。2026-11-21 实测两卷各有 16/11 个仓内不存在的管线、~150 条实验 run，
  // 而排班表干净、湖写入正常 ⇒ 零红灯。
  // 三个方向：缺件/内容不一致 ⇒ ERR；卷里多出 ⇒ WARN（实验残留，清理走 #2629 的 _archive）；
  // 孤儿 run 只计数。**只读两卷**（data-compose 已把两卷只读挂进 data 单元）。
  { key: 'data.console_drift', scope: 'data', script: 'scripts/lemeng/console-drift.mjs', cron: '30 * * * *', timezone: 'UTC', timeoutMs: 120000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 'console 工作区漂移（缺件/内容不一致/多余管线/孤儿 run → OO probes）' },
  { key: 'platform.warehouse_assertions_oo', scope: 'platform', requiresEnv: ['OO_READ_URL','OO_READ_ORG','OO_READ_TOKEN'], script: 'scripts/lemeng/warehouse-assertions.mjs', args: ['--group', 'oo'], cron: '*/5 * * * *', timezone: 'UTC', timeoutMs: 120000, maxAttempts: 1, expectedIntervalSecs: 300, description: '数据面断言 ⑭⑮（配置漂移 / pg_duckdb 崩溃，读 OO 流 → OO probes）' },
  // 原 openship 是宿主 bash：`for B in 3120 64188; do docker exec <console> python3 - < repo 脚本; done`
  // ——依赖 console 容器在场。删对象只需 ZOS 凭据 + HEAD，调度器容器两样都有 ⇒ 直接在此执行（Wave 8 ③）。
  // 安全判据全在下游 python 里（dry-run 默认 / --before 必填 / 封版标记+天文件双证才删），本 job 只加 `--apply`。
  // 小时对象回收（#2588 合并为一条 → #2668 依新实测拆回两条）：
  // · 激进档（30 分钟）：删「封版标记 + 天文件双证」的已封版日 hour 对象。#2588 当年合并的
  //   依据是「多留 1–2 天 ≈ 96 个小文件 ≈ +0.8s 查询」；2026-11-22 生产实测单微文件 ~350ms
  //   （精确路径 56 行 = 364ms），热腿 66 文件 ≈ 24s/tick——前提失效 ~40 倍，翻转。
  //   前置安全条件：#2665 三腿化后读侧（含 drill）不再依赖已封版日的 hour 文件，删=纯性能行为。
  //   scanDays=4（非原 10）：steady state 只需覆盖封版滞后，HEAD 量 ~9.2k/天（比原激进档省 60%）。
  // · 保守档（每日）：保留不动——重述窗口护栏（T-1/T-2 的 hour 留 2 天），两条判据同一套、
  //   只是保守程度不同。
  { key: 'data.hour_partition_gc', scope: 'data', requiresEnv: ['ZOS_ACCESS_KEY','ZOS_SECRET_KEY','ZOS_ENDPOINT','ZOS_REGION','ZOS_BUCKET'], script: 'scripts/lemeng/hour-partition-gc.mjs', env: { GC_DAYS_BACK: '0', GC_TZ: 'UTC', GC_SCAN_DAYS: '4' }, cron: '5,35 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 1800, description: '小时对象激进回收（UTC 今天前、扫 4 天；封版+天文件双证才删；#2668）' },
  // 窗口：before=上海今天−2、扫 30 天（重述窗口护栏），CST 03:20。
  { key: 'data.hot_hours_gc', scope: 'data', requiresEnv: ['ZOS_ACCESS_KEY','ZOS_SECRET_KEY','ZOS_ENDPOINT','ZOS_REGION','ZOS_BUCKET'], script: 'scripts/lemeng/hour-partition-gc.mjs', env: { GC_DAYS_BACK: '2', GC_TZ: 'Asia/Shanghai', GC_SCAN_DAYS: '30' }, cron: '20 19 * * *', timezone: 'UTC', timeoutMs: 600000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '热小时对象保守回收（上海今天−2、扫 30 天；CST 03:20）' },

  // 热层 GC（#2761）：快照表 `staging.retail_hot` 只服务「上海今天」，昨天的批次是死数据
  // （明细已由 `_DAY_DATA` 天文件接管）。与小时对象 GC **分开调度**：判据不同（那边要
  // 「封版+天文件双证」走 ZOS 对象删除；这边是纯 pg DELETE）、失败域不同 ⇒ 互不连坐。
  // 只共享同一个清理窗口（CST 凌晨，错开 5 分钟）。
  { key: 'data.retail_hot_gc', scope: 'data', requiresEnv: ['DATA_WAREHOUSE_URL'], script: 'scripts/lemeng/retail-hot-gc.mjs', cron: '25 19 * * *', timezone: 'UTC', timeoutMs: 120000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '热层 GC：删 retail_hot 中上海今天以前的批次（CST 03:25；快照表只服务当天）' },  // handler-only：排班由 agent/console 经 SchedulerPort 建（source≠'system'），seed 不建行。
  // cron/timezone 是 JobDef 必填字段的占位值（不会被 seed 使用），真实时间以排班行为准。
  { key: 'notify.emit', scope: 'platform', script: 'scripts/notify-emit-job.mjs', cron: '0 0 1 1 *', timezone: 'UTC', timeoutMs: 60000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '周期消息：把一条事件入队（由 agent/console 建按其 cron 排班）', noSystemSchedule: true },
]

export async function seedSchedules(
  pool: Pool,
  registry: JobDef[] = JOB_REGISTRY,
  now: Date = new Date(),
): Promise<{ inserted: string[]; revived: string[]; filled: string[] }> {
  for (const d of registry) {
    if (!isValidCron(d.cron)) throw new Error(`registry: ${d.key} 的 cron 非法（${d.cron}）`)
    if (!d.script.startsWith('scripts/')) throw new Error(`registry: ${d.key} 的 script 必须在 scripts/ 下`)
  }
  const inserted: string[] = []
  const revived: string[] = []
  for (const d of registry) {
    // handler-only 条目只登记 handler（loop 按 key 查找用），不建系统排班行。
    if (d.noSystemSchedule) continue
    // on conflict 的两个动作都**刻意不碰 enabled / next_run_at / cron**（人工闸门与手改不覆盖）：
    //   · 无冲突 → 插入（enabled=false 登记）；
    //   · 行在且**被软删** → 复活（#2670）：「key 从 registry 移除→软删，之后又加回 registry」
    //     是回滚/恢复决策的正常路径（实例：#2588 移除 → #2668 恢复）。旧语义 do nothing 会让
    //     该行被 claim 的 `deleted_at is null` 门静默挡住——行在、enabled、到期，就是不跑。
    //     复活**只清 deleted_at**，enabled 仍 false ⇒ 四步开闸的人工步骤照旧。
    const { rows } = await pool.query<{ is_insert: boolean }>(
      `insert into platform.job_schedule
         (key, cron, timezone, params, source, enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs)
       values ($1,$2,$3,'{}'::jsonb,'system',false,null,$4,$5,$6)
       on conflict (key) where source = 'system'
       do update set deleted_at = null, updated_at = now()
         where platform.job_schedule.deleted_at is not null
       returning (xmax = 0) as is_insert`,
      [d.key, d.cron, d.timezone, d.timeoutMs, d.maxAttempts, d.expectedIntervalSecs],
    )
    // `xmax = 0` ⇒ 真 INSERT；否则是 DO UPDATE（复活）。DO UPDATE 带 WHERE ⇒ 只有真复活才返回行，
    // 已活的行不重报（revived 不会每拍刷一遍）。
    if (rows.length > 0) (rows[0].is_insert ? inserted : revived).push(d.key)
  }
  const filled = await fillNextRunAt(pool, now)
  return { inserted, revived, filled }
}

/**
 * 给「启用着但没有下一次到期时刻」的系统排班补算 `next_run_at`（#2598）。
 *
 * **必须在每一拍都跑，不能只在首拍**：seed 刻意以 `enabled=false, next_run_at=null` 插入，
 * 而切流最后一步是人工在 DB 里置 `enabled=true` —— 如果补算只发生在进程首拍，那条排班
 * 就永远不会到期（`claimDue` 只认 `next_run_at <= now`），且**没有任何红灯**：它不是
 * 「该跑没跑」，是「从来没排上」。唯一自愈路径会退化成「等下一次部署重启容器」。
 *
 * 代价：一条走 `idx_job_schedule_due` 局部索引的查询，正常 0 行。
 */
export async function fillNextRunAt(pool: Pool, now: Date = new Date()): Promise<string[]> {
  const filled: string[] = []
  const { rows } = await pool.query(
    `select id, key, cron, timezone from platform.job_schedule
      where source='system' and enabled and next_run_at is null`,
  )
  for (const r of rows) {
    const { rowCount } = await pool.query('update platform.job_schedule set next_run_at=$2, updated_at=now() where id=$1 and next_run_at is null',
      [r.id, nextRunAt(String(r.cron), String(r.timezone), now)])
    // 并发下另一个实例/那一拍可能已先补算 ⇒ rowCount=0，此时不算本进程“补过”。
    if ((rowCount ?? 0) > 0) filled.push(String(r.key))
  }
  return filled
}
