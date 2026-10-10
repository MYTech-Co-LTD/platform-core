#!/bin/sh
# oo-config-audit —— OO 预警配置漂移对账（#531 哲学平移；#538 门禁硬层）。
#
# 只读对账三件事：
#   ① 在位告警规则 vs 登记清单（deploy/oo-alert-registry.txt）：未登记 = 自作主张嫌疑；
#      已登记但缺失/停用态不符/目的地不符 = 误删或漂移；
#   ② 目的地表 vs 清单 DEST 行；
#   ③ 桥/看门狗脚本在位且可执行（SCRIPT 行）。
# 任一漂移 ⇒ 逐条 AUD_DRIFT: + exit 1（openship job notify@failed → 群点名）。
#
# 定位：runs on OO 机（3d5ed127）；登记清单随 lemeng-sync 落地（本仓唯一事实源）。
# 依赖：docker（exec 元库 psql）。env REGISTRY/PG_CT 可覆盖（默认同生产）。
# ⚠️ 实现注意：所有 while 循环用临时文件重定向（管道 while 是子 shell，DRIFT 计数会丢失）。

set -u
REG=${REGISTRY:-/opt/platform-core-data/platform-core/deploy/oo-alert-registry.txt}
PG_CT=${OO_PG_CONTAINER:-openship-openobserve-postgres}
[ -r "$REG" ] || { echo "AUD_FAIL:bad_args 登记清单不可读：$REG"; exit 3; }

TMPD=$(mktemp -d ${TMPDIR:-/tmp}/oo-audit.XXXXXX)
trap 'rm -rf "$TMPD"' EXIT

DRIFT=0
note() { echo "AUD_DRIFT: $1"; DRIFT=$((DRIFT + 1)); }

# ── 取在位事实 ────────────────────────────────────────────────────────────────
docker exec -i "$PG_CT" psql -U openobserve -d openobserve -tA -F "$(printf '\t')" \
  -c "select a.name, coalesce(a.destinations::text,''), a.enabled from alerts a order by a.name" \
  > "$TMPD/db_alerts" || { echo 'AUD_FAIL:pg 元库查询失败'; exit 1; }
docker exec -i "$PG_CT" psql -U openobserve -d openobserve -tA \
  -c "select name from destinations order by name" > "$TMPD/db_dests" || {
  echo 'AUD_FAIL:pg 目的地查询失败'; exit 1
}
grep -E '^ALERT[[:space:]]' "$REG" > "$TMPD/reg_alerts"
grep -E '^DEST[[:space:]]' "$REG" | awk '{print $2}' > "$TMPD/reg_dests"
grep -E '^SCRIPT[[:space:]]' "$REG" > "$TMPD/reg_scripts"

# ── ① 在位告警 → 清单核对（未登记 / 目的地漂移 / 启用态漂移）─────────────────
while IFS="$(printf '\t')" read -r NAME DESTS EN; do
  [ -n "${NAME:-}" ] || continue
  LINE=$(grep -E "^ALERT[[:space:]]+${NAME}[[:space:]]" "$REG") || {
    note "未登记的告警规则：${NAME}（dest=${DESTS} enabled=${EN}）——自作主张嫌疑，登记或删除"
    continue
  }
  R_DEST=$(printf '%s' "$LINE" | awk '{print $3}')
  R_EN=$(printf '%s' "$LINE" | awk '{print $4}')
  case "$DESTS" in
    *"$R_DEST"*) ;;
    *) note "告警 ${NAME} 目的地漂移：在位 ${DESTS}，登记含 ${R_DEST}" ;;
  esac
  case "$EN" in
    "$R_EN") ;;
    *) note "告警 ${NAME} 启用态漂移：在位 ${EN}，登记 ${R_EN}" ;;
  esac
done < "$TMPD/db_alerts"

# ── ② 清单 → 在位核对（误删）─────────────────────────────────────────────────
while read -r _ NAME R_DEST R_EN; do
  [ -n "${NAME:-}" ] || continue
  grep -q "^${NAME}$(printf '\t')" "$TMPD/db_alerts" || note "已登记告警在元库缺失：${NAME}（误删？）"
done < "$TMPD/reg_alerts"

# ── ③ 目的地表 vs 清单 ────────────────────────────────────────────────────────
while read -r _ DNAME; do
  [ -n "${DNAME:-}" ] || continue
  grep -qx "$DNAME" "$TMPD/db_dests" || note "已登记目的地在元库缺失：${DNAME}"
done < "$TMPD/reg_dests"
while read -r DNAME; do
  [ -n "${DNAME:-}" ] || continue
  grep -qx "$DNAME" "$TMPD/reg_dests" || note "未登记的目的地：${DNAME}"
done < "$TMPD/db_dests"

# ── ④ 桥/看门狗脚本在位 ──────────────────────────────────────────────────────
while read -r _ SPATH; do
  [ -n "${SPATH:-}" ] || continue
  [ -x "$SPATH" ] || note "登记脚本不在位/不可执行：${SPATH}"
done < "$TMPD/reg_scripts"

if [ "$DRIFT" -gt 0 ]; then
  echo "AUD_FAIL:drift=$DRIFT —— 见上逐条；治理：issue（data-monitor 判停）→ 登记清单/在位二选一对齐"
  exit 1
fi
echo 'AUD_OK:在位配置与登记清单一致'
