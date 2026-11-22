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
  // env/cron/timeout/retry 与 openship 现役 `lemeng-dbt-tick` 逐字一致。
  { key: 'data.dbt_hourly', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'hourly', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '5 1-15 * * *', timezone: 'UTC', timeoutMs: 1800000, maxAttempts: 1, expectedIntervalSecs: 3600, description: '乐檬 dbt hourly（增量模型 + 9 条窗口对账；容器内 dbt 1.9.1）' },
  { key: 'data.dbt_tables', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'tables', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '25 2 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt tables（table 模型重建；CST 10:25）' },
  { key: 'data.dbt_tick', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'tick', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn' }, cron: '2-59/10 1-15 * * *', timezone: 'UTC', timeoutMs: 600000, maxAttempts: 1, expectedIntervalSecs: 600, description: '乐檬 dbt tick 档（销售明细 10 分钟；容器内 dbt 1.9.1）' },
  // 对账按**被测 mart 的物化语义**分族（#2428 定案）：
  //   · 全史族（a1/a2a/a2b）：只含 **table/view** 支撑的审计 —— 紧跟 tables 重建之后跑，两侧同源；
  //   · 窗口族（data.dbt_audit_window）：只含 **增量 mart** 支撑的审计 —— 与增量 lookback 同窗
  //     （today−10），且必须紧跟一轮 hourly 重建之后跑。
  //   ⚠️ 全史段里混入增量 mart 审计 = 结构性假红（2026-11-09 / 11-17 两次实测）；registry 测试
  //     会按 refs→模型物化类型静态核对，抄错段即红。
  //   时间窗（CST）：tables 10:25 → a2a 11:30 → a2b 12:45 → a1 14:00 → window 15:30（hourly 15:05 后）。
  { key: 'data.dbt_audit_a1', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__retail__order_line audit_lemeng__retail__recon_exchange_shape audit_lemeng__retail__recon_gift_hit audit_lemeng__retail__hour_row_count audit_lemeng__wholesale__order_line' }, cron: '0 6 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 全史对账 a1（视图面 5 条；CST 14:00）' },
  { key: 'data.dbt_audit_a2a', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__client_contribution__margin_rate audit_lemeng__client_contribution__net_amount audit_lemeng__contribution__margin_rate audit_lemeng__contribution__net_amount audit_lemeng__contribution__region_l1_net audit_lemeng__contribution__region_net audit_lemeng__expense__loss_rate audit_lemeng__expense__subsidy_rate' }, cron: '30 3 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 全史对账 a2a（贡献/费用 8 条，table/view 面；CST 11:30）' },
  { key: 'data.dbt_audit_a2b', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__retail__comparable_growth_rate audit_lemeng__retail__consecutive_no_sales_days audit_lemeng__transfer__batch_fill_rate audit_lemeng__transfer__cost_coverage_pct audit_lemeng__transfer__negative_order_count audit_lemeng__transfer__zero_cost_exposure_amount' }, cron: '45 4 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 全史对账 a2b（零售/调拨 6 条，table/view 面；CST 12:45）' },
  { key: 'data.dbt_audit_window', scope: 'data', requiresEnv: ['DATABASE_URL','DATA_WAREHOUSE_URL','LEMENG_ZOS_BUCKET','LEMENG_ZOS_REGION','LEMENG_ZOS_ENDPOINT'], script: 'scripts/lemeng/materialize-job.mjs', env: { MATERIALIZE_SCOPE: 'audit', MATERIALIZE_AUDIT_WINDOW: '1', DATA_PLANE_DOMAINS: 'lemeng', MATERIALIZE_MODE: 'container', LEMENG_ZOS_BUCKET: 'shanhai-data', LEMENG_ZOS_REGION: 'xinan1', LEMENG_ZOS_ENDPOINT: 'xinan-1-internal.zos.ctyun.cn', MATERIALIZE_AUDIT_SELECT: 'audit_lemeng__branch__transfer_money audit_lemeng__expense__branch_payable audit_lemeng__expense__branch_receivable audit_lemeng__expense__client_net audit_lemeng__expense__client_payable audit_lemeng__expense__client_receivable audit_lemeng__member__branch_vip_money audit_lemeng__outbound__gross_margin_rate audit_lemeng__outbound__gross_profit audit_lemeng__outbound__line_count audit_lemeng__outbound__order_count audit_lemeng__outbound__region_conservation audit_lemeng__outbound__region_net audit_lemeng__purchase__amount audit_lemeng__purchase__item_count audit_lemeng__purchase__present_amount audit_lemeng__purchase__return_amount audit_lemeng__purchase__return_rate audit_lemeng__purchase__supplier_count audit_lemeng__purchase__zero_amount_rows audit_lemeng__purchase__cr5 audit_order_event_ref_coverage_20261020 audit_order_event_type_counts_20261020 audit_lemeng__inventory__quantity' }, cron: '30 7 * * *', timezone: 'UTC', timeoutMs: 5400000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '乐檬 dbt 窗口对账（增量 mart 24 条；窗口=today−10；CST 15:30）⚠️ 待首跑验收后再启用（#2456）' },
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
  { key: 'data.warehouse_assertions', scope: 'data', requiresEnv: ['DATA_WAREHOUSE_URL','DATABASE_URL'], script: 'scripts/lemeng/warehouse-assertions.mjs', args: ['--group', 'core'], cron: '*/5 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 300, description: '数据面断言 ①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑯⑰⑱（可达性/新鲜度/对账台账/封版双算 → OO probes）' },
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
  // handler-only：排班由 agent/console 经 SchedulerPort 建（source≠'system'），seed 不建行。
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
