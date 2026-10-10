#!/bin/sh
# oo-notify-bridge —— OO 告警点火 → 企微 桥接通知（#538 过渡架构；分工正典 handbook §1.5.3）。
#
# 背景：现 openobserve 构建（floating latest，2026-09-02 拉）的「告警点火 → 目的地发送」环节
#   **静默死**（摄取/评估/点火全通、transitions 在位，但发送零尝试零日志——上游缺陷，
#   治本=钉版升级，另案）。升级前由本脚本搭桥：直接读本机 OO 元库
#   （openship-openobserve-postgres 的 alert_state_transitions），发现**数据面告警**
#   （destinations 含 data_alerts_wecom 的规则）新点火，即直发企微。
#
# 分工红线不受影响：本脚本只搬运「OO 已判定的点火结论」，判据本体仍在数据面/OO 规则里。
#
# 依赖：docker（exec 元库 psql）；env WECOM_WEBHOOK_URL（服务端副本 /etc/lemeng-alert-wecom.env，
#   由调用方 source 注入——密钥规矩：只写「在哪、怎么取」）。
# 状态：STATE_FILE 记录已处理 transitions 的最大 at(µs)；**发送成功才推进**，失败保持原位
#   下一轮重试（at-least-once）。首次运行只初始化水位（不补发历史，防群轰炸）。
# 退出码：0=无事/全部送达；1=发送失败（下一轮重试）；3=配置/环境坏（openship job notify@failed 兜底）。

set -u

[ -n "${WECOM_WEBHOOK_URL:-}" ] || { echo 'BR_FAIL:bad_args 缺 WECOM_WEBHOOK_URL'; exit 3; }
PG_CT=${OO_PG_CONTAINER:-openship-openobserve-postgres}

STATE_DIR=${STATE_DIR:-/var/lib/oo-notify-bridge}
STATE_FILE=$STATE_DIR/last_at
mkdir -p "$STATE_DIR" 2>/dev/null || { echo "BR_FAIL:state_dir $STATE_DIR 不可创建"; exit 3; }

# 首次运行：初始化水位到当前最大 at，不补发历史
if [ ! -f "$STATE_FILE" ]; then
  MAXAT=$(printf 'select coalesce(max(t.at), 0) from alert_state_transitions t join alerts a on a.id = t.alert_id where a.destinations::text like %s;\n' "'%data_alerts_wecom%'" | docker exec -i "$PG_CT" psql -U openobserve -d openobserve -tA) || {
    echo 'BR_FAIL:pg_query 首查失败（元库不可达？）'; exit 1
  }
  case "$MAXAT" in ''|*[!0-9]*) MAXAT=0 ;; esac
  echo "$MAXAT" > "$STATE_FILE"
  echo "BR_OK:initialized watermark=$MAXAT"
  exit 0
fi
LAST=$(cat "$STATE_FILE")
case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac

ROWS=$(printf 'select a.name, t.at from alert_state_transitions t join alerts a on a.id = t.alert_id where t.to_outcome = 1 and t.at > %s and a.destinations::text like %s order by t.at asc limit 20;\n' "$LAST" "'%data_alerts_wecom%'" | docker exec -i "$PG_CT" psql -U openobserve -d openobserve -tA -F "$(printf '\t')") || {
  echo 'BR_FAIL:pg_query 元库查询失败'; exit 1
}
[ -n "$ROWS" ] || { echo 'BR_OK:no_new_firings'; exit 0; }

TMPF=$STATE_DIR/pending.rows
printf '%s\n' "$ROWS" > "$TMPF"

SENT=0
while IFS="$(printf '\t')" read -r NAME AT; do
  [ -n "${NAME:-}" ] || continue
  case "$NAME" in
    *recovery*) EMOJI='✅'; LABEL='恢复' ;;
    *)          EMOJI='🔴'; LABEL='点火' ;;
  esac
  WHEN=$(date -u -d "@$((AT / 1000000))" '+%m-%d %H:%M:%SZ' 2>/dev/null || date -u -r $((AT / 1000000)) '+%m-%d %H:%M:%SZ' 2>/dev/null) || WHEN="$AT"
  # shellcheck disable=SC2016  # 花括号是企微 JSON 的字面组成，非 shell 变量
  BODY=$(printf '{"msgtype":"markdown","markdown":{"content":"%s **[OO 数据面] 告警%s：%s**\\n> 时间: %s (UTC)\\n> 明细: observe.hookflow.cn → Logs → data_alerts"}}' "$EMOJI" "$LABEL" "$NAME" "$WHEN")
  RESP=$(curl -sS -m 15 "$WECOM_WEBHOOK_URL" -H 'Content-Type: application/json' -d "$BODY") || {
    echo "BR_FAIL:send unreachable（$NAME）—— 状态不推进，下一轮重试"; exit 1
  }
  echo "$RESP" | grep -q '"errcode":0' || {
    echo "BR_FAIL:send rejected（$NAME）：$RESP —— 状态不推进，下一轮重试"; exit 1
  }
  echo "$AT" > "$STATE_FILE"
  SENT=$((SENT + 1))
done < "$TMPF"
rm -f "$TMPF"

echo "BR_OK:sent=$SENT watermark=$(cat "$STATE_FILE")"
