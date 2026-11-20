#!/bin/sh
# drain.sh —— 手工部署前的「排空」操作入口（#2567 / #2569）。
#
# 为什么需要手工版：CI 的 deploy-data 会自己写排空信号，但**手工部署不走 CI**——
# 2026-11-20 我自己那次手工部署就把一条正在跑的 hourly 砍成了 0s timeout。
#
# 用法（在**调度器容器内**执行，DB 凭据在那里）：
#   sh /app/scripts/ops/drain.sh set 45     # 落信号：45 分钟内不再 claim 新作业
#   sh /app/scripts/ops/drain.sh status     # 看信号 + 当前在跑作业数
#   sh /app/scripts/ops/drain.sh wait 1800  # 轮询到 running=0（最长 1800 秒），成功退出 0
#   sh /app/scripts/ops/drain.sh clear      # 撤信号（部署没做成时**必须**撤，否则白等）
#   sh /app/scripts/ops/drain.sh lock 600 "backfill-64188"   # 维护锁：期间 CI **不部署**（#2585）
#   sh /app/scripts/ops/drain.sh unlock     # 解除维护锁
#
# 典型手工部署流程：
#   drain.sh set 45 && drain.sh wait 1800 && <触发部署> ;   # 部署落地后新容器会自己 clear
#
# 语义提醒：
#   · 排空只挡「新 claim」，**不打断**在跑的作业；`wait` 就是等它们自然结束。
#   · 部署没落地 ⇒ 信号要**手工 clear**；信号自带 `until_ms` 到期时间，最坏也会自己过期。
#   · 新容器启动即清除信号（见 scripts/notify-worker.mjs），所以部署成功后无需再 clear。
set -eu

need_db() {
  [ -n "${DATABASE_URL:-}" ] || { echo "DRAIN_FAILED: 缺 DATABASE_URL（本脚本要在调度器容器内跑）" >&2; exit 2; }
}

psql_q() { psql "$DATABASE_URL" -Atc "$1"; }

case "${1:-}" in
  set)
    need_db
    minutes="${2:-45}"
    case "$minutes" in
      ''|*[!0-9]*) echo "DRAIN_FAILED: 分钟数必须是非负整数，得到 '$minutes'" >&2; exit 2 ;;
    esac
    psql_q "insert into platform.scheduler_control(key,value)
            values ('drain', jsonb_build_object('until_ms', (extract(epoch from now() + make_interval(mins => $minutes)) * 1000)::bigint))
            on conflict (key) do update set value = excluded.value, updated_at = now()" >/dev/null
    echo "DRAIN_SET until=+${minutes}min"
    ;;
  clear)
    need_db
    n=$(psql_q "with d as (delete from platform.scheduler_control where key='drain' returning 1) select count(*) from d")
    echo "DRAIN_CLEARED rows=${n:-0}"
    ;;
  status)
    need_db
    until_ms=$(psql_q "select coalesce(value->>'until_ms','') from platform.scheduler_control where key='drain'" || true)
    running=$(psql_q "select coalesce(count(*),0) from platform.job_run where status='running'")
    if [ -z "${until_ms}" ]; then echo "DRAIN off"; else echo "DRAIN on until_ms=${until_ms}"; fi
    maint=$(psql_q "select coalesce(value->>'reason','-') || ' until_ms=' || coalesce(value->>'until_ms','-') from platform.scheduler_control where key='maintenance'" || true)
    if [ -z "${maint}" ]; then echo "MAINTENANCE off"; else echo "MAINTENANCE on ${maint}"; fi
    echo "RUNNING ${running}"
    ;;
  lock)
    # 维护锁（#2585）：**不停止 claim**（≠ 排空），只告诉 CI「这段时间别部署」——
    # 覆盖的是「长 exec 任务」（回填、迁移），它们不在 job_run 台账里，闸门看不见。
    need_db
    minutes="${2:-60}"
    reason="${3:-maintenance}"
    case "$minutes" in
      ''|*[!0-9]*) echo "DRAIN_FAILED: 分钟数必须是非负整数，得到 '$minutes'" >&2; exit 2 ;;
    esac
    # 原因只允许安全字符：它要拼进 SQL 单引号串（`$$` 在 sh 里会展开成 PID，不能用美元引用）。
    case "$reason" in
      ''|*[!A-Za-z0-9._-]*) echo "DRAIN_FAILED: 原因只允许 [A-Za-z0-9._-]，得到 '$reason'" >&2; exit 2 ;;
    esac
    psql_q "insert into platform.scheduler_control(key,value)
            values ('maintenance', jsonb_build_object(
              'until_ms', (extract(epoch from now() + make_interval(mins => $minutes)) * 1000)::bigint,
              'reason', '${reason}'))
            on conflict (key) do update set value = excluded.value, updated_at = now()" >/dev/null
    echo "MAINTENANCE_SET until=+${minutes}min reason=${reason}"
    ;;
  unlock)
    need_db
    n=$(psql_q "with d as (delete from platform.scheduler_control where key='maintenance' returning 1) select count(*) from d")
    echo "MAINTENANCE_CLEARED rows=${n:-0}"
    ;;
  wait)
    need_db
    budget="${2:-1800}"
    case "$budget" in
      ''|*[!0-9]*) echo "DRAIN_FAILED: 等待秒数必须是非负整数，得到 '$budget'" >&2; exit 2 ;;
    esac
    waited=0
    while :; do
      running=$(psql_q "select coalesce(count(*),0) from platform.job_run where status='running'")
      if [ "${running}" = "0" ]; then echo "DRAIN_IDLE waited=${waited}s"; exit 0; fi
      if [ "${waited}" -ge "${budget}" ]; then
        echo "DRAIN_TIMEOUT running=${running} waited=${waited}s（仍在跑 ⇒ 先别部署，或放宽预算）" >&2
        exit 1
      fi
      echo "DRAIN_WAIT running=${running} waited=${waited}s"
      sleep 15
      waited=$((waited + 15))
    done
    ;;
  *)
    echo "用法: drain.sh {set [分钟]|status|wait [秒]|clear|lock [分钟] [原因]|unlock}" >&2
    exit 2
    ;;
esac
