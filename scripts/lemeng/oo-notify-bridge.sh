#!/bin/sh
# oo-notify-bridge —— OO 告警 → 企微 桥接通知 v1.1（#538 过渡架构；正典 §1.5.3）。
# 信号源 = data_alerts 流新行（event ∈ failure/recovery/stale，引擎 POST 即信号；
# v1.0 依赖的 alert_state_transitions 被 OO 调度器 skip 干扰，弃用——见 #542/#538）。
# 只搬运 OO 已落地的事实行，判据本体仍在数据面/规则（分工红线不变）。
# 依赖：docker inspect 取 root 凭据（本机 OO 容器）、jq、curl。
# 状态：STATE_FILE=已处理最大 _timestamp(µs)；发送成功才推进（at-least-once）；
#   首次运行初始化为当前 max（不补历史）。退出：0 送达/无事；1 发送失败重试；3 配置坏。

set -u
[ -n "${WECOM_WEBHOOK_URL:-}" ] || { echo 'BR_FAIL:bad_args 缺 WECOM_WEBHOOK_URL'; exit 3; }

STATE_DIR=${STATE_DIR:-/var/lib/oo-notify-bridge}
STATE_FILE=$STATE_DIR/last_ts
mkdir -p "$STATE_DIR" 2>/dev/null || { echo "BR_FAIL:state_dir $STATE_DIR 不可创建"; exit 3; }

ENVL=$(docker inspect openship-openobserve-openobserve --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^ZO_ROOT_USER_(EMAIL|PASSWORD)=')
UE=$(printf '%s\n' "$ENVL" | sed -n 's/^ZO_ROOT_USER_EMAIL=//p')
UP=$(printf '%s\n' "$ENVL" | sed -n 's/^ZO_ROOT_USER_PASSWORD=//p')
[ -n "$UE" ] && [ -n "$UP" ] || { echo 'BR_FAIL:bad_args 取不到 OO root 凭据'; exit 3; }
ORG=3IJ5tM4en3A06FzcJQhoHMTl4Xe
API=http://127.0.0.1:20002/api/$ORG

# 首次运行：初始化水位=当前 max(_timestamp)，不补历史
if [ ! -f "$STATE_FILE" ]; then
  R=$(curl -sS -m 20 -u "$UE:$UP" -H 'Content-Type: application/json' \
    -d '{"query":{"sql":"SELECT max(_timestamp) AS m FROM data_alerts","start_time":1700000000000000,"end_time":1800000000000000,"from":0,"size":1}}' \
    "$API/_search") || { echo 'BR_FAIL:search 首查失败'; exit 1; }
  M=$(printf '%s' "$R" | jq -r '.hits[0].m // 0' | cut -d. -f1)
  case "$M" in ''|*[!0-9]*) M=0 ;; esac
  echo "$M" > "$STATE_FILE"
  echo "BR_OK:initialized watermark=$M"
  exit 0
fi
LAST=$(cat "$STATE_FILE"); case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac

END=$(( $(date +%s) * 1000000 ))
R=$(curl -sS -m 20 -u "$UE:$UP" -H 'Content-Type: application/json' \
  -d "{\"query\":{\"sql\":\"SELECT event, pipeline, text, _timestamp FROM data_alerts WHERE event IN ('failure','recovery','stale') AND _timestamp > $LAST ORDER BY _timestamp ASC LIMIT 20\",\"start_time\":$((LAST - 1000000)),\"end_time\":$END,\"from\":0,\"size\":20}}" \
  "$API/_search") || { echo 'BR_FAIL:search 失败'; exit 1; }

N=$(printf '%s' "$R" | jq '.hits | length')
case "$N" in ''|*[!0-9]*) echo "BR_FAIL:search 响应异常：$(printf '%s' "$R" | head -c 160)"; exit 1 ;; esac
[ "$N" -gt 0 ] || { echo 'BR_OK:no_new_rows'; exit 0; }

NEWLAST=$LAST
i=0
while [ "$i" -lt "$N" ]; do
  EV=$(printf '%s' "$R" | jq -r ".hits[$i].event")
  PL=$(printf '%s' "$R" | jq -r ".hits[$i].pipeline")
  TX=$(printf '%s' "$R" | jq -r ".hits[$i].text // \"\"" | head -c 120)
  TS=$(printf '%s' "$R" | jq -r ".hits[$i]._timestamp" | cut -d. -f1)
  case "$EV" in
    recovery) E='✅'; L='恢复' ;;
    stale)    E='🟠'; L='停滞' ;;
    *)        E='🔴'; L='失败' ;;
  esac
  # shellcheck disable=SC2016
  BODY=$(printf '{"msgtype":"markdown","markdown":{"content":"%s **[OO 数据面] %s：%s**\\n> %s\\n> 明细: observe.hookflow.cn → Logs → data_alerts"}}' "$E" "$L" "$PL" "$TX")
  RESP=$(curl -sS -m 15 "$WECOM_WEBHOOK_URL" -H 'Content-Type: application/json' -d "$BODY") || {
    echo "BR_FAIL:send unreachable（$PL）"; exit 1
  }
  echo "$RESP" | grep -q '"errcode":0' || { echo "BR_FAIL:send rejected（$PL）：$RESP"; exit 1; }
  NEWLAST=$TS
  echo "$NEWLAST" > "$STATE_FILE"
  i=$((i + 1))
done
echo "BR_OK:sent=$N watermark=$NEWLAST"
