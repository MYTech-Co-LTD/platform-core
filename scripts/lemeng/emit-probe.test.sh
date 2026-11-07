#!/bin/sh
# emit-probe.test.sh — emit-probe.py 的判别面（参数/env/投递失败三态；不连真 OO）。
set -u

SRC=$(dirname "$0")/emit-probe.py
[ -f "$SRC" ] || { echo "FATAL: 找不到 $SRC" >&2; exit 2; }
command -v python3 >/dev/null || { echo "FATAL: 需要 python3" >&2; exit 2; }

PASS=0; FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1" >&2; }
check() { d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf 'OO_BASE=http://127.0.0.1:1\nOO_ORG=o\nOO_AUTH=a\n' > "$TMP/env"
printf 'OO_ORG=o\n' > "$TMP/env-missing"

# ① dry-run：只打印 payload，不读 env、不发网络
OUT=$(PROBE_ENV_FILE="$TMP/env" python3 "$SRC" 'regression:shanhai' 'red' 'total=50 fail=2' --dry-run 2>&1); RC=$?
check "dry-run 退出 0" sh -c '[ "$1" = 0 ]' _ "$RC"
check "dry-run 输出合法 JSON 且字段齐" sh -c 'printf "%s" "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d[\"check\"]==\"regression:shanhai\" and d[\"verdict\"]==\"RED\" and d[\"mode\"]==\"advisory\" and d[\"probe\"]==\"regression\"; print(\"ok\")"' _ "$OUT"
check "dry-run 不读 env（env 缺失也给 payload）" sh -c 'printf "%s" "$1" | grep -q "\"check\""' _ "$OUT"

# ② 参数缺失 ⇒ 2
PROBE_ENV_FILE="$TMP/env" python3 "$SRC" '只有两个' 'OK' >/dev/null 2>&1; RC=$?
check "参数不足 ⇒ 退出 2" sh -c '[ "$1" = 2 ]' _ "$RC"

# ③ env 缺键 ⇒ 2（不静默成功）
PROBE_ENV_FILE="$TMP/env-missing" python3 "$SRC" 'c' 'OK' 'd' >/dev/null 2>&1; RC=$?
check "env 缺 OO_BASE/OO_AUTH ⇒ 退出 2" sh -c '[ "$1" = 2 ]' _ "$RC"

# ④ 投递失败（本机 1 端口拒绝）⇒ 1，观测面降级要显红
PROBE_ENV_FILE="$TMP/env" python3 "$SRC" 'c' 'OK' 'd' >/dev/null 2>&1; RC=$?
check "投递失败 ⇒ 退出 1（不把失败当成功）" sh -c '[ "$1" = 1 ]' _ "$RC"

echo
echo "emit-probe.test.sh: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ] || exit 1
