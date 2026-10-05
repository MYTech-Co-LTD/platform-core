#!/bin/sh
# recon-preagg.test.sh — 对账比较块（recon-preagg.sh 里那段 python）的**判别逻辑**测试。
#
# 手法与 recon-day-heal.test.sh 一致：**从脚本里抽真实现来测，不复制一份**——复制即漂移；
# 抽不到（脚本结构变了）⇒ 判红，不是跳过。
#
# 为什么只测比较块：湖侧 SQL 与端点调用**要真机 + 凭据**，不进 CI；
# 而「平 / 漏店 / 超阈值 / 未定稿 / 端点坏」这五条判别才是它**唯一会放行或判红**的地方。
set -u
SRC=$(dirname "$0")/recon-preagg.sh
[ -f "$SRC" ] || { echo "FAIL 找不到 ${SRC}"; exit 2; }

pass=0; fail=0
ok() { if [ "$1" = "$2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "  FAIL: 期望[$2] 实得[$1]"; fi; }

# 抽出比较块：`python3 - 参数 <<'PY'` 到 `PY` 之间
awk '/^python3 - /{f=1;next} /^PY$/{f=0} f' "$SRC" > /tmp/_rp_blk.py
[ -s /tmp/_rp_blk.py ] || { echo "  FAIL: 抽不到比较块（脚本结构变了？）"; echo "recon-preagg: pass=0 fail=1"; exit 1; }

# —— 夹具：湖侧 CSV（b,net）+ 端点响应 JSON ——
_w() { printf '%s' "$1" > "$2"; }
run() { # $1=湖CSV $2=响应JSON $3=是否定稿(1/0) -> 打印"输出|rc"
  _w "$1" /tmp/_preagg_lake.csv; _w "$2" /tmp/_preagg_resp.json
  out=$(python3 /tmp/_rp_blk.py t 2026-10-02 1.00 0.01 "$3" 2>&1); rc=$?
  printf '%s|%s' "$(printf '%s' "$out" | tail -1)" "$rc"
}
_resp() { printf '{"code":0,"result":{"rows":[%s]}}' "$1"; }

# 1) 平 ⇒ PREAGG_OK / rc 0
r=$(run '12,100.00
21,50.00
' "$(_resp '{"branch_num":12,"sale_money":100.00},{"branch_num":21,"sale_money":50.00}')" 1)
ok "$r" "PREAGG_OK book=t bizday=2026-10-02 branches=2|0"

# 2) 湖有源无 ⇒ branch_missing / rc 1
r=$(run '12,100.00
21,50.00
' "$(_resp '{"branch_num":12,"sale_money":100.00}')" 1)
case "$r" in PREAGG_FAILED:branch_missing*"|1") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 漏店未按 branch_missing 判：$r";; esac

# 3) 超阈值 ⇒ threshold / rc 1
r=$(run '12,100.00
' "$(_resp '{"branch_num":12,"sale_money":1.00}')" 1)
case "$r" in PREAGG_FAILED:threshold*"|1") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 超阈值未判：$r";; esac

# 4) 未定稿（第 5 参=0）⇒ PREAGG_UNSETTLED / rc 0（**即便差得很离谱也不判红**）
r=$(run '12,100.00
' "$(_resp '{"branch_num":12,"sale_money":1.00}')" 0)
case "$r" in PREAGG_UNSETTLED*"|0") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 未定稿应只报数：$r";; esac

# 5) 端点坏（code!=0）⇒ PREAGG_FAILED:pre_call / rc 3
r=$(run '12,100.00
' '{"code":10006,"msg":"用户上下文或权限读取失败"}' 1)
case "$r" in PREAGG_FAILED:pre_call*"|3") pass=$((pass+1));; *) fail=$((fail+1)); echo "  FAIL: 端点失败未按依赖处理：$r";; esac

rm -f /tmp/_rp_blk.py /tmp/_preagg_lake.csv /tmp/_preagg_resp.json
echo "recon-preagg: pass=$pass fail=$fail"
[ "$fail" -eq 0 ] || exit 1
echo "recon-preagg: OK"
