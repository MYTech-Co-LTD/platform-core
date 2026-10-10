#!/bin/sh
# oo-watchdog —— OpenObserve 存活看门狗（#538 Phase 0；分工正典 handbook §1.5.3）。
#
# 为什么存在：数据面告警链路（管线 alerts.json → OO → 企微）整体压在 OO 上，OO 挂 =
# 预警静默消失。本脚本由 openship job（*/15，notify@failed）驱动，反向盯 OO：
#   ① GET  /healthz —— 服务活着（2026-10-09 实测 OO 有 unreachable→0s 闪断，短闪不报、
#      持续 >15 分钟才红）；
#   ② POST 1 行心跳进 oo_watchdog_heartbeat 流，响应必须 successful:1 —— 证明「网络 + 鉴权 +
#      摄取通路」全通（console 的 OO_AUTH 是摄取专用凭据，search 会 401——2026-10-10 实测，
#      故 v1 盯不到「OO 活着但规则/目的地腿断」，那半边留给 Phase 2 换 search 凭据后补）。
#
# 依赖 env：OO_BASE / OO_ORG / OO_AUTH（调用方注入，同 recon-day-heal 的手法；不落 argv/配置）。
# 任一判红 exit 1（openship job 侧发企微）；全绿 exit 0。判据红线：本脚本红 = 基础设施级告警，
# 走 openship 通知是分工内的正确通道，别把它挪去 OO。
set -u

# ── 参数三查（缺一拒跑；不把缺 env 当绿）─────────────────────────────────────
[ -n "${OO_BASE:-}" ] && [ -n "${OO_ORG:-}" ] && [ -n "${OO_AUTH:-}" ] || {
  echo 'WD_FAIL:bad_args 缺 OO_BASE/OO_ORG/OO_AUTH（注入器没配好——这是配置故障，不是 OO 故障）'
  exit 3
}

# ── ① 服务存活 ────────────────────────────────────────────────────────────────
_h1=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "${OO_BASE}/healthz" 2>&1) || {
  echo "WD_FAIL:healthz unreachable（${_h1}）—— OO 不可达"
  exit 1
}
[ "${_h1}" = "200" ] || {
  echo "WD_FAIL:healthz http=${_h1} —— OO 应答异常"
  exit 1
}

# ── ② 摄取通路（网络+鉴权+写路径）────────────────────────────────────────────
_ts=$(date +%s)
_hb="{\"event\":\"heartbeat\",\"pipeline\":\"oo-watchdog\",\"status\":\"ok\",\"durationMs\":0,\"text\":\"watchdog ${_ts}\"}"
_r=$(curl -sS -m 15 -X POST "${OO_BASE}/api/${OO_ORG}/oo_watchdog_heartbeat/_json" \
      -H "Authorization: Basic ${OO_AUTH}" -H 'Content-Type: application/json' -d "${_hb}") || {
  echo "WD_FAIL:ingest unreachable —— 心跳摄取失败"
  exit 1
}
echo "${_r}" | grep -q '"successful":1' || {
  echo "WD_FAIL:ingest rejected —— 摄取响应非 successful:1：${_r}"
  exit 1
}

echo 'WD_OK healthz=200 ingest=successful:1'
