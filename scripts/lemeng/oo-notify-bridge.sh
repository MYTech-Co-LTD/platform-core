#!/bin/sh
# oo-notify-bridge —— OO 告警 → 企微 桥接通知 v1.2（#538 过渡架构；分工正典 handbook §1.5.3）。
#
# 背景：现 openobserve 构建（floating latest，2026-09-02 拉）的「告警点火 → 目的地发送」环节
#   **静默死**（摄取/评估/点火全通，发送零尝试零日志——上游缺陷，治本=钉版升级 #542）。
#   升级前由本脚本搭桥，双通道：
#     ① data_alerts 流新行（event ∈ failure/recovery/stale）——管线 run 事件（引擎 POST 即信号）；
#     ② data_plane_probes 流判红行（verdict ≠ OK）——探活逐断言判红（wire-warehouse --check 吐行）。
#   v1.0 曾依赖 alert_state_transitions——被 OO 调度器 `skipped due to delay` 干扰，弃用。
#
# 分工红线不受影响：本脚本只搬运「OO 已落地的事实/判红」，判据本体仍在数据面。
#
# 依赖：本机 OO 容器（docker inspect 取 root 凭据，检索走 127.0.0.1:20002）、jq、curl。
#   env WECOM_WEBHOOK_URL（服务端副本 /etc/lemeng-alert-wecom.env，由调用方 source 注入）。
# 状态：$STATE_DIR/last_ts（通道①）与 last_ts_probes（通道②）= 已处理最大 _timestamp(µs)；
#   发送成功才推进（at-least-once）；各自首次运行只初始化水位（不补历史，防群轰炸）。
# 退出码：0=无事/全部送达；1=发送失败（下一轮重试）；3=配置/环境坏（openship job notify@failed 兜底）。

set -u
[ -n "${WECOM_WEBHOOK_URL:-}" ] || { echo 'BR_FAIL:bad_args 缺 WECOM_WEBHOOK_URL'; exit 3; }

STATE_DIR=${STATE_DIR:-/var/lib/oo-notify-bridge}
mkdir -p "$STATE_DIR" 2>/dev/null || { echo "BR_FAIL:state_dir $STATE_DIR 不可创建"; exit 3; }

ENVL=$(docker inspect openship-openobserve-openobserve --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^ZO_ROOT_USER_(EMAIL|PASSWORD)=')
UE=$(printf '%s\n' "$ENVL" | sed -n 's/^ZO_ROOT_USER_EMAIL=//p')
UP=$(printf '%s\n' "$ENVL" | sed -n 's/^ZO_ROOT_USER_PASSWORD=//p')
[ -n "$UE" ] && [ -n "$UP" ] || { echo 'BR_FAIL:bad_args 取不到 OO root 凭据'; exit 3; }
ORG=3IJ5tM4en3A06FzcJQhoHMTl4Xe
API=http://127.0.0.1:20002/api/$ORG

oo_search() { # $1=SQL $2=start_us $3=end_us → 响应体
  curl -sS -m 20 -u "$UE:$UP" -H 'Content-Type: application/json' \
    -d "{\"query\":{\"sql\":$1,\"start_time\":$2,\"end_time\":$3,\"from\":0,\"size\":20}}" \
    "$API/_search"
}

# ── 通道①：data_alerts（管线 run 事件）──────────────────────────────────────
DA_FILE=$STATE_DIR/last_ts
if [ ! -f "$DA_FILE" ]; then
  R=$(oo_search '"SELECT max(_timestamp) AS m FROM data_alerts"' 1700000000000000 1800000000000000) || { echo 'BR_FAIL:search 首查失败(da)'; exit 1; }
  M=$(printf '%s' "$R" | jq -r '.hits[0].m // 0' | cut -d. -f1)
  case "$M" in ''|*[!0-9]*) M=0 ;; esac
  echo "$M" > "$DA_FILE"
fi
LAST=$(cat "$DA_FILE"); case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
END=$(( $(date +%s) * 1000000 ))
R=$(oo_search "\"SELECT event, pipeline, text, _timestamp FROM data_alerts WHERE event IN ('failure','recovery','stale') AND _timestamp > $LAST ORDER BY _timestamp ASC LIMIT 20\"" $((LAST - 1000000)) $END) || { echo 'BR_FAIL:search 失败(da)'; exit 1; }
N=$(printf '%s' "$R" | jq '.hits | length')
case "$N" in ''|*[!0-9]*) echo "BR_FAIL:search 响应异常(da)：$(printf '%s' "$R" | head -c 160)"; exit 1 ;; esac
NEWLAST=$LAST
SENT=0
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
  echo "$NEWLAST" > "$DA_FILE"
  SENT=$((SENT + 1))
  i=$((i + 1))
done

# ── 通道②：data_plane_probes（探活判红行，#538 Phase 1）─────────────────────
PB_FILE=$STATE_DIR/last_ts_probes
if [ ! -f "$PB_FILE" ]; then
  R=$(oo_search '"SELECT max(_timestamp) AS m FROM data_plane_probes"' 1700000000000000 1800000000000000) || { echo 'BR_FAIL:search 首查失败(pb)'; exit 1; }
  M=$(printf '%s' "$R" | jq -r '.hits[0].m // 0' | cut -d. -f1)
  case "$M" in ''|*[!0-9]*) M=0 ;; esac
  echo "$M" > "$PB_FILE"
fi
PLAST=$(cat "$PB_FILE"); case "$PLAST" in ''|*[!0-9]*) PLAST=0 ;; esac
R=$(oo_search "\"SELECT check, verdict, detail, _timestamp FROM data_plane_probes WHERE verdict <> 'OK' AND _timestamp > $PLAST ORDER BY _timestamp ASC LIMIT 20\"" $((PLAST - 1000000)) $END) || { echo 'BR_FAIL:search 失败(pb)'; exit 1; }
PN=$(printf '%s' "$R" | jq '.hits | length')
case "$PN" in ''|*[!0-9]*) echo "BR_FAIL:search 响应异常(pb)：$(printf '%s' "$R" | head -c 160)"; exit 1 ;; esac
PNEW=$PLAST
PSENT=0
i=0
while [ "$i" -lt "$PN" ]; do
  CK=$(printf '%s' "$R" | jq -r ".hits[$i].check")
  DT=$(printf '%s' "$R" | jq -r ".hits[$i].detail // \"\"" | head -c 160)
  TS=$(printf '%s' "$R" | jq -r ".hits[$i]._timestamp" | cut -d. -f1)
  # shellcheck disable=SC2016
  BODY=$(printf '{"msgtype":"markdown","markdown":{"content":"🔴 **[OO 探活] 断言 %s 判红**\\n> %s\\n> 明细: observe.hookflow.cn → Logs → data_plane_probes"}}' "$CK" "$DT")
  RESP=$(curl -sS -m 15 "$WECOM_WEBHOOK_URL" -H 'Content-Type: application/json' -d "$BODY") || {
    echo "BR_FAIL:send unreachable（probe $CK）"; exit 1
  }
  echo "$RESP" | grep -q '"errcode":0' || { echo "BR_FAIL:send rejected（probe $CK）：$RESP"; exit 1; }
  PNEW=$TS
  echo "$PNEW" > "$PB_FILE"
  PSENT=$((PSENT + 1))
  i=$((i + 1))
done

# ── 通道③：alert_state_transitions（基建探活家族点火，#538 Phase 1）──────────
# 覆盖 = destinations 含 wecom-robot-p1 的规则（casdoor/novu/wecom/douyin/dy/host_*——
# openship 看不见的外部探活，OO 合法 lane）。数据面家族走①②，此处排除防双响；
# ndevice*（wecom_bot 群）不在本桥范围。调度器偶发 skip ⇒ 检测可能延迟数分钟，可接受。
TR_FILE=$STATE_DIR/last_tr_id
if [ ! -f "$TR_FILE" ]; then
  MT=$(printf 'select coalesce(max(t.id), 0) from alert_state_transitions t join alerts a on a.id = t.alert_id where a.destinations::text like %s;\n' "'%wecom-robot-p1%'" | docker exec -i openship-openobserve-postgres psql -U openobserve -d openobserve -tA) || { echo 'BR_FAIL:pg_query 首查失败(tr)'; exit 1; }
  case "$MT" in ''|*[!0-9]*) MT=0 ;; esac
  echo "$MT" > "$TR_FILE"
fi
TRLAST=$(cat "$TR_FILE"); case "$TRLAST" in ''|*[!0-9]*) TRLAST=0 ;; esac
TROWS=$(printf 'select t.id, a.name from alert_state_transitions t join alerts a on a.id = t.alert_id where t.to_outcome = 1 and t.id > %s and a.destinations::text like %s order by t.id asc limit 20;\n' "$TRLAST" "'%wecom-robot-p1%'" | docker exec -i openship-openobserve-postgres psql -U openobserve -d openobserve -tA -F "$(printf '\t')") || { echo 'BR_FAIL:pg_query 失败(tr)'; exit 1; }
TNEW=$TRLAST
TSENT=0
if [ -n "$TROWS" ]; then
  TTF=$STATE_DIR/pending.tr
  printf '%s\n' "$TROWS" > "$TTF"
  while IFS="$(printf '\t')" read -r TID TNAME; do
    [ -n "${TID:-}" ] || continue
    # shellcheck disable=SC2016
    TBODY=$(printf '{"msgtype":"markdown","markdown":{"content":"🔴 **[OO 基建] 探活告警：%s**\\n> 明细: observe.hookflow.cn → Alerts"}}' "$TNAME")
    TRESP=$(curl -sS -m 15 "$WECOM_WEBHOOK_URL" -H 'Content-Type: application/json' -d "$TBODY") || {
      echo "BR_FAIL:send unreachable（tr $TNAME）"; exit 1
    }
    echo "$TRESP" | grep -q '"errcode":0' || { echo "BR_FAIL:send rejected（tr $TNAME）：$TRESP"; exit 1; }
    TNEW=$TID
    echo "$TNEW" > "$TR_FILE"
    TSENT=$((TSENT + 1))
  done < "$TTF"
  rm -f "$TTF"
fi

echo "BR_OK:sent=$SENT probes=$PSENT infra=$TSENT wm=$NEWLAST/$PNEW/$TNEW"
